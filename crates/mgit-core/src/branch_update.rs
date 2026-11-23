//! branch 업데이트 (BR-09): checkout 하지 않은 로컬 branch 도 업스트림으로 fast-forward 한다.
//!
//! 판정(읽기)·업스트림 fetch 인자·ref 이동 인자를 여기 두고 두 실행 경로가 함께 쓴다.
//! - 저장소 탭: [`Core::update_branch`] — 세션의 `run_write` 로 돌고, ref 이동은 Undo 대상(`update <b>`)이다
//! - 폴더 탭 일괄: `BatchOp::UpdateBranch` — 세션 없이 저장소마다 돈다 (`folder_batch.rs`)
//!
//! 규칙: 다른 워크트리에서 checkout 된 branch 는 건드리지 않는다. 이 작업 트리에서 checkout 중이면
//! `merge --ff-only`(작업 트리도 함께 갱신), 아니면 `branch -f` 로 옮긴다. fast-forward 가 아니면 옮기지 않는다

use std::path::Path;

use mgit_git::cmd::in_progress_op;
use mgit_l10n::tr;
use mgit_model::{EnvProfile, GitRequest, GitRunner};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::ops::OpHandle;
use crate::refname::check_ref_name;
use crate::write::WriteSpec;

/// branch 업데이트 결과
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BranchUpdate {
    /// 갱신함: `from` → `to` (받은 commit 수 `commits`)
    Updated {
        from: String,
        to: String,
        commits: u32,
    },
    /// 이미 최신
    UpToDate,
    /// 로컬이 앞섬. 받을 것이 없다
    Ahead { commits: u32 },
    /// 갈라짐. 갱신하지 않는다
    Diverged { ahead: u32, behind: u32 },
}

/// 업데이트할 로컬 branch (`for-each-ref` 한 번으로 읽은 값)
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BranchTarget {
    /// 짧은 이름 (`development`)
    pub name: String,
    /// 지금 가리키는 commit
    pub oid: String,
    /// 업스트림 ref 전체 이름 (`refs/remotes/origin/development`, 원격이 `.` 이면 로컬 branch)
    pub upstream: String,
    /// 업스트림의 원격 이름 (`origin`, 로컬 branch 를 추적하면 `.`)
    pub remote: String,
    /// 원격 쪽 ref 전체 이름 (`refs/heads/development`)
    pub remote_ref: String,
    /// 이 작업 트리에서 checkout 중인지
    pub current: bool,
}

/// 업데이트하지 못하는 이유
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum NotUpdatable {
    /// 그 이름의 로컬 branch 가 없다
    NoBranch,
    /// 업스트림이 없다
    NoUpstream,
    /// 다른 워크트리에서 checkout 중이다 (그 워크트리 경로)
    OtherWorktree(String),
    /// git 읽기가 실패했다 (메시지)
    Failed(String),
}

impl NotUpdatable {
    /// 화면에 보일 사유 (지금 언어). 일괄 결과의 건너뜀 사유와 저장소 탭 오류 문구로 쓴다
    pub(crate) fn message(&self) -> String {
        match self {
            NotUpdatable::NoBranch => crate::folder_batch::reason::no_branch().into(),
            NotUpdatable::NoUpstream => crate::folder_batch::reason::no_upstream().into(),
            NotUpdatable::OtherWorktree(path) => tr!(
                "다른 워크트리에서 checkout 중 ({path})",
                "Checked out in another worktree ({path})"
            ),
            NotUpdatable::Failed(e) => e.clone(),
        }
    }
}

/// 로컬이 앞선 결과의 사유 (일괄 건너뜀·저장소 탭 알림 공용)
pub(crate) fn ahead_reason(commits: u32) -> String {
    tr!(
        "로컬이 앞섬 (⇡{commits}), 받을 것 없음",
        "Local is ahead (⇡{commits}), nothing to update"
    )
}

/// 갈라진 결과의 사유 (일괄 건너뜀·저장소 탭 알림 공용)
pub(crate) fn diverged_reason(ahead: u32, behind: u32) -> String {
    tr!(
        "갈라져 갱신하지 않음 (⇡{ahead} ⇣{behind})",
        "Diverged, not updated (⇡{ahead} ⇣{behind})"
    )
}

/// Undo 목록에 보일 ref 이동 라벨 (PR checkout 흐름과 같은 이름)
pub(crate) fn update_label(branch: &str) -> String {
    format!("update {branch}")
}

/// 읽기 git 하나를 돌려 성공하면 stdout(앞뒤 공백 제거), 실패하면 가린 stderr
async fn read(runner: &dyn GitRunner, work_tree: &Path, args: &[&str]) -> Result<String, String> {
    let req = GitRequest::new(work_tree, args.iter().map(|a| (*a).to_string()))
        .with_env(EnvProfile::ReadInteractive);
    let out = runner.run(req).await.map_err(|e| e.to_string())?;
    if out.exit.success() {
        Ok(out.stdout_lossy().trim().to_string())
    } else {
        Err(mgit_model::redact_text(out.exit.stderr.trim()))
    }
}

/// 로컬 branch 하나의 업스트림·checkout 위치를 읽는다. `for-each-ref` 의 패턴은 하위 ref 도 맞추므로 이름이 정확히
/// 같은 줄만 쓴다. 다른 워크트리에서 checkout 중이면(`%(worktreepath)` 가 있고 `%(HEAD)` 가 아니면) 건드리지 않게 거부한다
pub(crate) async fn inspect(
    runner: &dyn GitRunner,
    work_tree: &Path,
    name: &str,
) -> Result<BranchTarget, NotUpdatable> {
    let full = format!("refs/heads/{name}");
    let out = read(
        runner,
        work_tree,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(worktreepath)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
            &full,
        ],
    )
    .await
    .map_err(NotUpdatable::Failed)?;
    let line = out
        .lines()
        .find(|l| l.split('\0').next() == Some(full.as_str()))
        .ok_or(NotUpdatable::NoBranch)?;
    let fields: Vec<&str> = line.split('\0').collect();
    let [_, oid, head, worktree, upstream, remote, remote_ref] = fields[..] else {
        return Err(NotUpdatable::Failed(format!("for-each-ref: {line}")));
    };
    let current = head == "*";
    if !current && !worktree.is_empty() {
        return Err(NotUpdatable::OtherWorktree(worktree.to_string()));
    }
    if upstream.is_empty() || remote.is_empty() || remote_ref.is_empty() {
        return Err(NotUpdatable::NoUpstream);
    }
    Ok(BranchTarget {
        name: name.to_string(),
        oid: oid.to_string(),
        upstream: upstream.to_string(),
        remote: remote.to_string(),
        remote_ref: remote_ref.to_string(),
        current,
    })
}

/// 업스트림 ref 하나만 정확히 갱신하는 fetch 인자 (`+<원격 ref>:<업스트림 ref>`). 다른 branch·원격 추적 ref 는
/// 건드리지 않는다. 업스트림이 로컬 branch(원격 `.`)면 받을 것이 없으므로 None
pub(crate) fn fetch_args(target: &BranchTarget, progress: bool) -> Option<Vec<String>> {
    if target.remote == "." {
        return None;
    }
    let mut args = vec!["fetch".to_string()];
    if progress {
        args.push("--progress".into());
    }
    args.extend([
        "--end-of-options".into(),
        target.remote.clone(),
        format!("+{}:{}", target.remote_ref, target.upstream),
    ]);
    Some(args)
}

/// 로컬 branch 와 업스트림을 비교해 결과를 정한다 (ref 는 아직 옮기지 않는다). `rev-list --left-right --count` 의
/// 왼쪽(로컬에만)·오른쪽(업스트림에만) 수로 가른다: 왼쪽이 0 이면 로컬이 업스트림의 조상이라 fast-forward 할 수 있다
pub(crate) async fn compare(
    runner: &dyn GitRunner,
    work_tree: &Path,
    target: &BranchTarget,
) -> Result<BranchUpdate, String> {
    let to = read(
        runner,
        work_tree,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{}^{{commit}}", target.upstream),
        ],
    )
    .await
    .map_err(|e| {
        if e.is_empty() {
            tr!(
                "업스트림 ref 가 없습니다: {}",
                "Upstream ref not found: {}",
                target.upstream
            )
        } else {
            e
        }
    })?;
    if to == target.oid {
        return Ok(BranchUpdate::UpToDate);
    }
    let counts = read(
        runner,
        work_tree,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{}...{to}", target.oid),
            "--",
        ],
    )
    .await?;
    let mut parts = counts.split_whitespace().map(str::parse::<u32>);
    let (Some(Ok(ahead)), Some(Ok(behind))) = (parts.next(), parts.next()) else {
        return Err(format!("rev-list: {counts}"));
    };
    Ok(match (ahead, behind) {
        (0, 0) => BranchUpdate::UpToDate,
        (0, behind) => BranchUpdate::Updated {
            from: target.oid.clone(),
            to,
            commits: behind,
        },
        (ahead, 0) => BranchUpdate::Ahead { commits: ahead },
        (ahead, behind) => BranchUpdate::Diverged { ahead, behind },
    })
}

/// fast-forward 로 ref 를 옮기는 명령 인자: 이 작업 트리에서 checkout 중이면 `merge --ff-only`(작업 트리도 갱신),
/// 아니면 `branch -f` (git 이 다른 워크트리에서 checkout·rebase 중인 branch 는 거부한다)
pub(crate) fn ff_args(branch: &str, on_branch: bool, to: &str) -> Vec<String> {
    if on_branch {
        vec!["merge".into(), "--ff-only".into(), to.into()]
    } else {
        vec![
            "branch".into(),
            "-f".into(),
            "--end-of-options".into(),
            branch.into(),
            to.into(),
        ]
    }
}

impl Core {
    /// 세션에서 로컬 branch 를 `to` 로 fast-forward 한다 (PR checkout 흐름과 branch 업데이트 공용). `from` 이 `to` 의
    /// 조상이 아니면 아무것도 하지 않고 `false`. 옮기면 Undo 대상(`update <b>`)으로 남는다
    pub(crate) async fn fast_forward_branch(
        &self,
        session: SessionId,
        branch: &str,
        on_branch: bool,
        from: &str,
        to: &str,
    ) -> Result<bool, CoreError> {
        let s = self.inner().get(session)?;
        let is_ff = read(
            self.inner().runner(),
            &s.info.work_tree,
            &["merge-base", "--is-ancestor", from, to],
        )
        .await
        .is_ok();
        if !is_ff {
            return Ok(false);
        }
        self.run_write(
            session,
            WriteSpec::new(ff_args(branch, on_branch, to)).label(update_label(branch)),
        )
        .await?;
        Ok(true)
    }

    /// 로컬 branch 하나를 업스트림으로 fast-forward 한다 (BR-09, 저장소 탭). checkout 하지 않은 branch 도 갱신한다.
    /// 업스트림 ref 만 정확히 fetch 한 뒤 비교하고, fast-forward 일 때만 옮긴다(Undo 대상). 갈라졌거나 로컬이 앞서면
    /// 옮기지 않고 그 결과를 돌려준다. branch 가 없거나, 업스트림이 없거나, 다른 워크트리에서 checkout 중이거나,
    /// 이 작업 트리의 branch 인데 진행 중인 작업이 있으면 `Invalid`. 진행률은 `op` 로(fetch 단계) 흘린다
    pub async fn update_branch(
        &self,
        session: SessionId,
        name: &str,
        op: Option<OpHandle>,
    ) -> Result<BranchUpdate, CoreError> {
        let target = match self.update_target(session, name).await {
            Ok(target) => target,
            Err(e) => {
                self.abandon_operation(session, op.as_ref(), &e.to_string());
                return Err(e);
            }
        };
        let s = self.inner().get(session)?;
        match fetch_args(&target, op.is_some()) {
            Some(args) => {
                let mut spec = WriteSpec::new(args).network();
                if let Some(op) = op {
                    spec = spec.with_op(op).progress();
                }
                self.run_write_tracking_tags(session, spec).await?;
            }
            // 받을 것이 없다: 진행 표시만 닫는다
            None => {
                if let Some(op) = &op {
                    self.inner().end_op(&s, op, true, false, "");
                }
            }
        }
        let result = compare(self.inner().runner(), &s.info.work_tree, &target)
            .await
            .map_err(CoreError::Invalid)?;
        if let BranchUpdate::Updated { from, to, .. } = &result
            && !self
                .fast_forward_branch(session, name, target.current, from, to)
                .await?
        {
            // 비교와 이동 사이에 다른 곳에서 branch 가 움직였다 (쓰기 잠금 밖의 외부 git)
            return Err(CoreError::Invalid(tr!(
                "{name} 이(가) 그 사이 바뀌어 갱신하지 않았습니다. 다시 시도하세요",
                "{name} changed in the meantime, so it was not updated. Try again"
            )));
        }
        Ok(result)
    }

    /// 저장소 탭 업데이트의 대상 판정: 이름 검사, branch·업스트림·워크트리 위치, 이 작업 트리의 branch 면 진행 중 작업
    async fn update_target(
        &self,
        session: SessionId,
        name: &str,
    ) -> Result<BranchTarget, CoreError> {
        check_ref_name(name)?;
        let s = self.inner().get(session)?;
        let runner = self.inner().runner();
        let target = inspect(runner, &s.info.work_tree, name)
            .await
            .map_err(|why| CoreError::Invalid(why.message()))?;
        if target.current
            && in_progress_op(
                runner,
                &s.info.git_dir,
                &s.info.common_dir,
                &s.info.work_tree,
            )
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return Err(CoreError::Invalid(
                crate::folder_batch::reason::in_progress().into(),
            ));
        }
        Ok(target)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 판정에 쓰는 대상
    fn target(remote: &str) -> BranchTarget {
        BranchTarget {
            name: "dev".into(),
            oid: "a".repeat(40),
            upstream: if remote == "." {
                "refs/heads/main".into()
            } else {
                format!("refs/remotes/{remote}/dev")
            },
            remote: remote.into(),
            remote_ref: "refs/heads/dev".into(),
            current: false,
        }
    }

    #[test]
    fn fetch_args_update_only_the_upstream_ref() {
        assert_eq!(
            fetch_args(&target("origin"), false).unwrap(),
            [
                "fetch",
                "--end-of-options",
                "origin",
                "+refs/heads/dev:refs/remotes/origin/dev"
            ]
        );
        assert_eq!(
            fetch_args(&target("origin"), true).unwrap()[1],
            "--progress"
        );
        // 로컬 branch 를 추적하면 받을 것이 없다
        assert_eq!(fetch_args(&target("."), false), None);
    }

    #[test]
    fn ff_args_merge_when_checked_out_here_else_branch_force() {
        assert_eq!(ff_args("dev", true, "b1"), ["merge", "--ff-only", "b1"]);
        assert_eq!(
            ff_args("dev", false, "b1"),
            ["branch", "-f", "--end-of-options", "dev", "b1"]
        );
    }
}
