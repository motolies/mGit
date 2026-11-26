//! 인터랙티브 리베이스 (MRG-07) 와 빠른 이력 수정 (MRG-09).
//!
//! 편집기를 띄우지 않는다: todo 는 미리 만들어 `GIT_SEQUENCE_EDITOR="cp <todo>"` 로 주입하고,
//! reword 는 `pick` 뒤 `exec git commit --amend -F <msg>` 로, autosquash 는 `GIT_SEQUENCE_EDITOR=true` 로 돈다

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use mgit_l10n::{pick, tr};
use mgit_model::{EnvProfile, GitRequest, Oid, StatusSummary};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::merge_ops::OpOutcome;
use crate::messages;
use crate::write::WriteSpec;

/// todo 한 줄의 동작
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RebaseAction {
    Pick,
    /// 메시지를 바꾼다 (편집기 없이 `exec git commit --amend -F`)
    Reword {
        message: String,
    },
    /// 이 커밋에서 멈춘다 (사용자가 수정 후 Continue)
    Edit,
    /// 앞 커밋에 합치고 메시지는 둘 다 남긴다
    Squash,
    /// 앞 커밋에 합치고 이 커밋의 메시지는 버린다
    Fixup,
    Drop,
}

/// 플랜의 한 줄 (todo 순서 = 적용 순서, 오래된 커밋이 먼저)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub oid: Oid,
    pub action: RebaseAction,
}

/// 인터랙티브 리베이스 플랜
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    /// 기준 커밋·브랜치. `None` 이면 `--root`
    pub onto: Option<String>,
    pub steps: Vec<RebaseStep>,
    pub autostash: bool,
    /// `--update-refs`
    pub update_refs: bool,
    /// commit 을 만드는 단계마다 뒤에 `exec <cmd>` (검증 명령, CF-25). 실패하면 rebase 가 멈춘다
    #[serde(default)]
    pub exec: Option<String>,
}

/// 플랜 편집기에 보여 줄 커밋 (todo 순서)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub oid: Oid,
    pub subject: String,
    pub author_name: String,
}

/// 플랜 편집기에 넘기는 조회 결과
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanInfo {
    pub commits: Vec<PlanCommit>,
    /// 구간에 머지 커밋이 있다. 실행하면 머지가 평탄화되므로 프런트가 경고한다
    pub has_merges: bool,
}

/// 다른 워크트리의 작업 중 변경 (WT-06)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeWip {
    pub path: PathBuf,
    /// 짧은 브랜치명. detached 면 None
    pub branch: Option<String>,
    pub head: Oid,
    pub summary: StatusSummary,
}

/// 셸 명령 인자를 작은따옴표로 감싼다 (`'` 는 `'\''`)
fn shell_quote(path: &Path) -> String {
    let s = path.to_string_lossy();
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 플랜용 임시 디렉터리 (`<tmp>/mgit-rebase/<pid>-<nanos>/`). 플랜마다 고유해 동시 rebase 가 서로 지우지
/// 않고, 하루 지난 디렉터리만 정리한다 (edit·충돌로 멈춘 rebase 의 exec 줄이 메시지 파일을 나중에 읽는다)
fn plan_dir(temp_dir: Option<&Path>) -> Result<PathBuf, CoreError> {
    let root = temp_dir
        .map(|p| p.join("rebase"))
        .unwrap_or_else(|| std::env::temp_dir().join("mgit-rebase"));
    std::fs::create_dir_all(&root)?;
    let day_ago = SystemTime::now() - std::time::Duration::from_secs(86_400);
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.filter_map(Result::ok) {
            if e.metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|m| m < day_ago)
            {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = root.join(format!("{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 옵션으로 오해될 수 없는 값인지
fn check_ref(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_ref(name)));
    }
    Ok(())
}

impl RebasePlan {
    /// todo 본문과 함께 쓸 메시지 파일들을 만든다. 돌려주는 값은 (todo 텍스트, 만든 파일 수).
    /// `stacked` 는 `--update-refs` 로 함께 옮길 (커밋, 브랜치 full ref) 들이다. git 이 넣는 `update-ref`
    /// 줄은 todo 를 덮어쓰면 사라지고 그러면 옵션이 조용히 무시되므로 여기서 직접 넣는다
    pub fn build_todo(
        &self,
        dir: &Path,
        stacked: &[(Oid, String)],
    ) -> Result<(String, usize), CoreError> {
        let mut out = String::new();
        let mut files = 0;
        let mut pending: Vec<&str> = Vec::new();
        for (i, step) in self.steps.iter().enumerate() {
            let hex = step.oid.to_hex();
            match &step.action {
                RebaseAction::Pick => out.push_str(&format!("pick {hex}\n")),
                RebaseAction::Edit => out.push_str(&format!("edit {hex}\n")),
                RebaseAction::Squash => out.push_str(&format!("squash {hex}\n")),
                RebaseAction::Fixup => out.push_str(&format!("fixup {hex}\n")),
                RebaseAction::Drop => out.push_str(&format!("drop {hex}\n")),
                RebaseAction::Reword { message } => {
                    let file = dir.join(format!("msg-{i}.txt"));
                    std::fs::write(&file, message)?;
                    files += 1;
                    out.push_str(&format!(
                        "pick {hex}\nexec git commit --amend -q --no-edit -F {}\n",
                        shell_quote(&file)
                    ));
                }
            }
            pending.extend(
                stacked
                    .iter()
                    .filter(|(oid, _)| *oid == step.oid)
                    .map(|(_, name)| name.as_str()),
            );
            // 뒤에 합쳐질 커밋이 있으면 묶음이 끝날 때까지 미룬다
            let chain_continues = matches!(
                self.steps.get(i + 1).map(|s| &s.action),
                Some(RebaseAction::Squash | RebaseAction::Fixup)
            );
            if chain_continues {
                continue;
            }
            // 검증 exec: commit 이 만들어지는 단계 뒤에 (squash/fixup 은 묶음이 끝날 때)
            if let Some(cmd) = &self.exec
                && step.action != RebaseAction::Drop
            {
                out.push_str(&format!("exec {cmd}\n"));
            }
            for name in pending.drain(..) {
                out.push_str(&format!("update-ref {name}\n"));
            }
        }
        Ok((out, files))
    }
}

impl Core {
    /// `onto..HEAD` 커밋을 todo 순서(오래된 것 먼저)로. `onto` 가 없으면 루트부터
    pub async fn rebase_plan_commits(
        &self,
        session: SessionId,
        onto: Option<&str>,
    ) -> Result<Vec<PlanCommit>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let range = match onto {
            Some(o) => {
                check_ref(o)?;
                format!("{o}..HEAD")
            }
            None => "HEAD".to_string(),
        };
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "log",
                "--reverse",
                "--no-merges",
                "--format=%H%x00%s%x00%aN",
                "--end-of-options",
                &range,
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let args = req.display_args();
        let out = inner.runner().run(req).await?.ok(&args)?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| {
                let mut f = l.split('\0');
                let oid = Oid::from_hex(f.next()?.as_bytes()).ok()?;
                Some(PlanCommit {
                    oid,
                    subject: f.next().unwrap_or_default().to_string(),
                    author_name: f.next().unwrap_or_default().to_string(),
                })
            })
            .collect())
    }

    /// 플랜 편집기용 조회: 커밋 목록과 구간의 머지 여부
    pub async fn rebase_plan_info(
        &self,
        session: SessionId,
        onto: Option<&str>,
    ) -> Result<RebasePlanInfo, CoreError> {
        let commits = self.rebase_plan_commits(session, onto).await?;
        let has_merges = self.has_merges(session, onto).await?;
        Ok(RebasePlanInfo {
            commits,
            has_merges,
        })
    }

    /// 인터랙티브 리베이스 실행 (MRG-07). 플랜의 커밋 집합은 `onto..HEAD` 와 같아야 한다(순서는 자유).
    /// 충돌이나 `edit` 에서 멈추면 `Conflicts`/진행 중 작업으로 남고 Continue/Abort 는 기존 op_* 를 쓴다
    pub async fn rebase_interactive(
        &self,
        session: SessionId,
        plan: &RebasePlan,
    ) -> Result<OpOutcome, CoreError> {
        self.rebase_interactive_guarded(session, plan, None).await
    }

    /// 빠른 메시지 수정에서만 백업과 rebase 쓰기에 원격 게시 검사를 전달한다.
    async fn rebase_interactive_guarded(
        &self,
        session: SessionId,
        plan: &RebasePlan,
        unpublished_commit: Option<Oid>,
    ) -> Result<OpOutcome, CoreError> {
        let expected = self
            .rebase_plan_commits(session, plan.onto.as_deref())
            .await?;
        let mut want: Vec<Oid> = expected.iter().map(|c| c.oid).collect();
        let mut got: Vec<Oid> = plan.steps.iter().map(|s| s.oid).collect();
        want.sort();
        got.sort();
        if want != got {
            return Err(CoreError::Invalid(
                pick(
                    "리베이스 계획의 커밋이 현재 이력과 다릅니다. 다시 불러오세요.",
                    "The plan's commits differ from the current history. Reload it",
                )
                .into(),
            ));
        }
        if plan.steps.iter().all(|s| s.action == RebaseAction::Drop) {
            return Err(CoreError::Invalid(
                pick(
                    "모든 커밋을 삭제할 수는 없습니다",
                    "Cannot drop all commits",
                )
                .into(),
            ));
        }
        // drop 은 커밋을 남기지 않으므로 앞쪽의 drop 을 빼고 첫 단계를 본다
        if matches!(
            plan.steps
                .iter()
                .find(|s| s.action != RebaseAction::Drop)
                .map(|s| &s.action),
            Some(RebaseAction::Squash | RebaseAction::Fixup)
        ) {
            return Err(CoreError::Invalid(
                pick(
                    "남겨 둘 첫 번째 커밋은 이전 커밋에 합칠 수 없습니다",
                    "The first remaining commit cannot be squashed into a previous commit",
                )
                .into(),
            ));
        }
        let dir = plan_dir(self.config().temp_dir.as_deref())?;
        let stacked = if plan.update_refs {
            self.stacked_branches(session).await?
        } else {
            Vec::new()
        };
        let (todo, _) = plan.build_todo(&dir, &stacked)?;
        let todo_path = dir.join("git-rebase-todo");
        std::fs::write(&todo_path, todo)?;

        if let Some(b) = self.head_branch_name(session) {
            if unpublished_commit.is_some() {
                self.backup_ref_guarded(session, &b, "rebase -i", unpublished_commit)
                    .await?;
            } else {
                let _ = self.backup_ref(session, &b, "rebase -i").await;
            }
        }
        let mut args: Vec<String> = vec!["rebase".into(), "-i".into(), "--empty=drop".into()];
        if plan.autostash {
            args.push("--autostash".into());
        }
        if plan.update_refs {
            args.push("--update-refs".into());
        }
        match &plan.onto {
            Some(onto) => {
                args.push("--end-of-options".into());
                args.push(onto.clone());
            }
            None => args.push("--root".into()),
        }
        let spec = WriteSpec::new(args).label("rebase -i".to_string()).env(
            "GIT_SEQUENCE_EDITOR",
            &format!("cp {}", shell_quote(&todo_path)),
        );
        let r = self
            .run_write(session, spec.guard_unpublished(unpublished_commit))
            .await;
        self.outcome(r)
    }

    /// 커밋 메시지만 바꾼다 (MRG-09). HEAD 면 `--amend`, 아니면 플랜(pick + exec amend -F).
    /// HEAD 밖 커밋이나 머지가 낀 구간은 거부한다
    pub async fn reword_commit(
        &self,
        session: SessionId,
        oid: &Oid,
        message: &str,
    ) -> Result<OpOutcome, CoreError> {
        if message.trim().is_empty() {
            return Err(CoreError::Invalid(
                pick("메시지가 비어 있습니다", "The message is empty").into(),
            ));
        }
        let hex = oid.to_hex();
        let head = {
            let s = self.inner_arc().get(session)?;
            let st = s.state();
            st.refs.head.oid()
        };
        if head == Some(*oid) {
            if let Some(b) = self.head_branch_name(session) {
                self.backup_ref_guarded(session, &b, "reword", Some(*oid))
                    .await?;
            }
            self.run_write(
                session,
                WriteSpec::new([
                    "commit",
                    "--amend",
                    "-q",
                    "--only",
                    "--allow-empty",
                    "-F",
                    "-",
                ])
                .with_stdin(message.as_bytes().to_vec())
                .guard_unpublished(Some(*oid))
                .label(format!("reword {}", &hex[..7])),
            )
            .await?;
            return Ok(OpOutcome::Clean);
        }
        // 가운데 커밋: `--fixup` 은 메시지 옵션과 함께 못 쓰므로 플랜(pick + exec amend -F)으로 처리
        let parent = self.parent_of(session, oid).await?;
        self.ensure_linear_rewrite(session, oid, parent.as_deref())
            .await?;
        let commits = self.rebase_plan_commits(session, parent.as_deref()).await?;
        let steps = commits
            .iter()
            .map(|c| RebaseStep {
                oid: c.oid,
                action: if c.oid == *oid {
                    RebaseAction::Reword {
                        message: message.to_string(),
                    }
                } else {
                    RebaseAction::Pick
                },
            })
            .collect();
        self.rebase_interactive_guarded(
            session,
            &RebasePlan {
                onto: parent,
                steps,
                autostash: true,
                update_refs: false,
                exec: None,
            },
            Some(*oid),
        )
        .await
    }

    /// 커밋을 바로 앞(부모) 커밋에 합친다 (MRG-09). 메시지는 부모 것을 남긴다.
    /// HEAD 밖 커밋이나 머지가 낀 구간은 거부한다
    pub async fn squash_into_parent(
        &self,
        session: SessionId,
        oid: &Oid,
    ) -> Result<OpOutcome, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let hex = oid.to_hex();
        let req = GitRequest::new(
            &s.info.work_tree,
            ["rev-list", "--parents", "-n", "1", "--end-of-options", &hex],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        let text = out.stdout_lossy();
        let mut parts = text.split_whitespace();
        let _me = parts.next();
        let parent = parts
            .next()
            .ok_or_else(|| {
                CoreError::Invalid(
                    pick(
                        "루트 커밋은 합칠 부모가 없습니다",
                        "The root commit has no parent to squash into",
                    )
                    .into(),
                )
            })?
            .to_string();
        if parts.next().is_some() {
            return Err(CoreError::Invalid(
                pick(
                    "병합 커밋은 합칠 수 없습니다",
                    "Merge commits cannot be squashed",
                )
                .into(),
            ));
        }
        // 부모부터 HEAD 까지의 플랜: 부모 pick, 이 커밋 fixup, 나머지 pick
        let parent_oid = Oid::from_hex(parent.as_bytes()).map_err(|e| {
            CoreError::Invalid(tr!(
                "부모 커밋 해시를 해석하지 못했습니다: {e}",
                "Failed to parse parent hash: {e}"
            ))
        })?;
        let grand = self.parent_of(session, &parent_oid).await?;
        self.ensure_linear_rewrite(session, oid, grand.as_deref())
            .await?;
        let commits = self.rebase_plan_commits(session, grand.as_deref()).await?;
        let steps = commits
            .iter()
            .map(|c| RebaseStep {
                oid: c.oid,
                action: if c.oid == *oid {
                    RebaseAction::Fixup
                } else {
                    RebaseAction::Pick
                },
            })
            .collect();
        self.rebase_interactive(
            session,
            &RebasePlan {
                onto: grand,
                steps,
                autostash: true,
                update_refs: false,
                exec: None,
            },
        )
        .await
    }

    /// 빠른 이력 수정의 전제를 확인한다: 커밋이 현재 브랜치에 있고, `base..HEAD` 에 머지가 없다.
    /// 어기면 rebase 가 현재 브랜치를 다른 곳으로 옮기거나 머지를 평탄화해 머지 커밋의 내용을 잃는다
    async fn ensure_linear_rewrite(
        &self,
        session: SessionId,
        oid: &Oid,
        base: Option<&str>,
    ) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let hex = oid.to_hex();
        let req = GitRequest::new(
            &s.info.work_tree,
            ["merge-base", "--is-ancestor", hex.as_str(), "HEAD"],
        )
        .with_env(EnvProfile::ReadInteractive);
        if !inner.runner().run(req).await?.exit.success() {
            return Err(CoreError::Invalid(pick("현재 브랜치에 없는 커밋은 수정할 수 없습니다. 해당 브랜치로 전환한 뒤 다시 시도하세요.", "Cannot edit a commit that is not on the current branch. Switch to that branch and try again").into()));
        }
        if self.has_merges(session, base).await? {
            return Err(CoreError::Invalid(pick("병합 커밋이 포함된 구간은 병합 구조를 유지한 채 수정할 수 없습니다. 병합 이후의 커밋만 수정하거나 터미널에서 git rebase --rebase-merges를 사용하세요.", "A range containing merge commits cannot be edited without flattening history. Edit only commits above the merge, or use git rebase --rebase-merges in a terminal").into()));
        }
        Ok(())
    }

    /// `base..HEAD` (`base` 가 없으면 HEAD 전체)에 머지 커밋이 있는지
    async fn has_merges(&self, session: SessionId, base: Option<&str>) -> Result<bool, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let range = base.map_or_else(|| "HEAD".to_string(), |b| format!("{b}..HEAD"));
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "rev-list",
                "--merges",
                "--count",
                "--end-of-options",
                &range,
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let args = req.display_args();
        let out = inner.runner().run(req).await?.ok(&args)?;
        Ok(String::from_utf8_lossy(&out).trim() != "0")
    }

    /// `--update-refs` 로 옮길 수 있는 로컬 브랜치 (커밋, full ref). 어느 워크트리에든 체크아웃된
    /// 브랜치는 뺀다 (git 도 옮기지 않는다)
    async fn stacked_branches(&self, session: SessionId) -> Result<Vec<(Oid, String)>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "for-each-ref",
                "--format=%(objectname)%00%(refname)%00%(worktreepath)",
                "refs/heads",
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let args = req.display_args();
        let out = inner.runner().run(req).await?.ok(&args)?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| {
                let mut f = l.split('\0');
                let oid = Oid::from_hex(f.next()?.as_bytes()).ok()?;
                let name = f.next()?.to_string();
                f.next()?.is_empty().then_some((oid, name))
            })
            .collect())
    }

    /// 커밋의 첫 부모 (루트면 None)
    async fn parent_of(&self, session: SessionId, oid: &Oid) -> Result<Option<String>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            ["rev-parse", "--verify", "-q", &format!("{}^", oid.to_hex())],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        Ok(if out.exit.success() {
            Some(out.stdout_lossy().trim().to_string())
        } else {
            None
        })
    }

    /// 다른 워크트리들의 작업 중 변경 (WT-06). 변경이 없는 워크트리는 뺀다
    pub async fn worktree_wips(&self, session: SessionId) -> Result<Vec<WorktreeWip>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let worktrees = s.state().refs.worktrees.clone();
        let mut out = Vec::new();
        for wt in worktrees {
            if wt.path == s.info.work_tree || wt.prunable.is_some() || !wt.path.is_dir() {
                continue;
            }
            let Some(head) = wt.head else {
                continue;
            };
            let status =
                match mgit_git::cmd::work_tree_status(inner.runner(), &wt.path, false).await {
                    Ok(st) => st,
                    Err(_) => continue,
                };
            let summary = status.summary();
            if !summary.has_changes() {
                continue;
            }
            out.push(WorktreeWip {
                path: wt.path.clone(),
                branch: wt
                    .branch
                    .as_deref()
                    .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string()),
                head,
                summary,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {

    /// 개발 A의 오래된 자료 정리가 형제 환경 B의 자료에는 접근하지 않는다.
    #[test]
    fn plan_cleanup_stays_within_its_runtime_root() {
        let parent = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/rebase-isolation-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        let a = parent.join("a");
        let b = parent.join("b");
        let a_plan = super::plan_dir(Some(&a)).unwrap();
        let b_plan = super::plan_dir(Some(&b)).unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(172_800);
        std::fs::File::open(&a_plan)
            .unwrap()
            .set_modified(past)
            .unwrap();
        std::fs::File::open(&b_plan)
            .unwrap()
            .set_modified(past)
            .unwrap();
        let next = super::plan_dir(Some(&a)).unwrap();
        assert!(!a_plan.exists());
        assert!(b_plan.exists());
        assert!(next.starts_with(a.join("rebase")));
        std::fs::remove_dir_all(parent).unwrap();
    }
    use super::*;

    #[test]
    fn builds_todo_with_reword_exec() {
        let dir = std::env::temp_dir().join(format!("mgit-todo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = Oid::from_hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let b = Oid::from_hex(b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
        let plan = RebasePlan {
            onto: Some("main".into()),
            steps: vec![
                RebaseStep {
                    oid: b,
                    action: RebaseAction::Reword {
                        message: "new msg".into(),
                    },
                },
                RebaseStep {
                    oid: a,
                    action: RebaseAction::Fixup,
                },
            ],
            autostash: false,
            update_refs: false,
            exec: None,
        };
        let (todo, files) = plan.build_todo(&dir, &[]).unwrap();
        assert_eq!(files, 1);
        let lines: Vec<&str> = todo.lines().collect();
        assert_eq!(lines[0], format!("pick {}", b.to_hex()));
        assert!(lines[1].starts_with("exec git commit --amend -q --no-edit -F '"));
        assert_eq!(lines[2], format!("fixup {}", a.to_hex()));
        assert_eq!(
            std::fs::read_to_string(dir.join("msg-0.txt")).unwrap(),
            "new msg"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote(Path::new("/a b/it's")), "'/a b/it'\\''s'");
    }
}
