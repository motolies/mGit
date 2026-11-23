//! 충돌 예방 (CF-01~05, MRG-08): 병합 미리보기·옵션 시뮬레이터·충돌 레이더·rebase 예측·격리 병합

use std::path::{Path, PathBuf};

use mgit_git::cmd::{config_get, head_state, merge_tree};
use mgit_l10n::{pick, tr};
use mgit_model::{EnvProfile, GitRequest, Oid};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::merge_ops::{MergeMode, OpOutcome};
use crate::messages;
use crate::worktree::WorktreeSource;
use crate::write::WriteSpec;

/// 허용하는 `-X` 옵션 (CF-04)
pub const STRATEGY_OPTIONS: &[&str] = &[
    "ours",
    "theirs",
    "ignore-space-change",
    "ignore-all-space",
    "ignore-space-at-eol",
    "patience",
    "histogram",
    "renormalize",
    "find-renames",
    "no-renames",
];

/// 시뮬레이터가 비교하는 옵션 조합
const SIMULATE_SETS: &[&[&str]] = &[
    &[],
    &["ignore-space-change"],
    &["ignore-all-space"],
    &["patience"],
    &["ours"],
    &["theirs"],
];

/// 격리 병합 branch 접두
pub const ISOLATED_PREFIX: &str = "mgit/isolated-";

/// 병합 미리보기 (CF-01·04)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub ours: String,
    pub theirs: String,
    pub clean: bool,
    pub conflicts: Vec<String>,
    pub tree: Oid,
    pub messages: Vec<String>,
    pub strategy: Vec<String>,
    /// 커밋하지 않은 변경을 `stash create` 로 포함했는지
    pub wip_included: bool,
}

/// 레이더 대상 종류
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RadarKind {
    Upstream,
    Default,
    Local,
    Worktree,
}

/// 충돌 레이더 한 줄 (CF-02)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RadarEntry {
    pub reference: String,
    pub kind: RadarKind,
    pub clean: bool,
    pub conflicts: Vec<String>,
    /// 그 ref 에만 있는 commit 수 (받아야 할 것)
    pub behind: u32,
    /// HEAD 에만 있는 commit 수
    pub ahead: u32,
}

/// rebase 예측 한 단계 (CF-03)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStepPreview {
    pub oid: Oid,
    pub subject: String,
    pub clean: bool,
    pub conflicts: Vec<String>,
    /// 앞 단계가 충돌한 뒤라 근사치
    pub approximate: bool,
}

/// 격리 병합 결과 (CF-05)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedMerge {
    pub worktree: PathBuf,
    pub branch: String,
    pub outcome: OpOutcome,
}

/// 격리 브랜치를 시작한 브랜치(짧은 이름)를 담는 설정 키. 브랜치 설정이라 브랜치와 함께 지워진다
fn isolated_base_key(branch: &str) -> String {
    format!("branch.{branch}.mgitIsolatedBase")
}

/// `refs/heads/x` → `x`
fn short_branch(full: &str) -> &str {
    full.strip_prefix("refs/heads/").unwrap_or(full)
}

/// 옵션으로 오해될 수 없는 ref 인지
fn check_ref(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_ref(name)));
    }
    Ok(())
}

/// `-X` 옵션 검증 (CF-04)
fn check_strategy(opts: &[String]) -> Result<(), CoreError> {
    for o in opts {
        let ok = STRATEGY_OPTIONS.contains(&o.as_str())
            || matches!(
                o.as_str(),
                "diff-algorithm=patience"
                    | "diff-algorithm=histogram"
                    | "diff-algorithm=minimal"
                    | "diff-algorithm=myers"
            );
        if !ok {
            return Err(CoreError::Invalid(tr!(
                "지원하지 않는 병합 옵션: {o}",
                "Unsupported merge option: {o}"
            )));
        }
    }
    Ok(())
}

impl Core {
    /// 커밋하지 않은 변경(untracked 포함)을 commit 객체로 만든다. 변경이 없으면 None.
    /// 임시 인덱스(`GIT_INDEX_FILE`)에 `add -A` 하므로 실제 인덱스·ref 는 건드리지 않는다
    pub async fn wip_commit(&self, session: SessionId) -> Result<Option<Oid>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let Some(head) = s.state().refs.head.oid() else {
            return Ok(None);
        };
        if s.state().status.entries.is_empty() {
            return Ok(None);
        }
        let wt = s.info.work_tree.clone();
        let tmp = std::env::temp_dir().join(format!(
            "mgit-wip-index-{}-{}",
            std::process::id(),
            mgit_model::now_millis()
        ));
        let idx = tmp.to_string_lossy().into_owned();
        let req = |args: &[&str]| {
            GitRequest::new(&wt, args.iter().map(|a| (*a).to_string()))
                .with_env(EnvProfile::Write)
                .with_env_var("GIT_INDEX_FILE", &idx)
        };
        let runner = inner.runner();
        let result: Result<Option<Oid>, CoreError> = async {
            let r = req(&["read-tree", &head.to_hex()]);
            let d = r.display_args();
            runner.run(r).await?.ok(&d)?;
            let r = req(&["add", "-A", "--", "."]);
            let d = r.display_args();
            runner.run(r).await?.ok(&d)?;
            let r = req(&["write-tree"]);
            let d = r.display_args();
            let tree = String::from_utf8_lossy(&runner.run(r).await?.ok(&d)?)
                .trim()
                .to_string();
            let r = req(&["rev-parse", "HEAD^{tree}"]);
            let d = r.display_args();
            let head_tree = String::from_utf8_lossy(&runner.run(r).await?.ok(&d)?)
                .trim()
                .to_string();
            if tree == head_tree {
                return Ok(None);
            }
            let r = req(&["commit-tree", &tree, "-p", &head.to_hex(), "-m", "mgit wip"]);
            let d = r.display_args();
            let out = runner.run(r).await?.ok(&d)?;
            Ok(Oid::from_hex(String::from_utf8_lossy(&out).trim().as_bytes()).ok())
        }
        .await;
        let _ = std::fs::remove_file(&tmp);
        result
    }

    /// 두 ref 의 병합을 미리 본다 (CF-01). `ours` 가 None 이면 HEAD(또는 WIP)
    async fn preview_between(
        &self,
        session: SessionId,
        ours: Option<&str>,
        theirs: &str,
        strategy: &[String],
        include_wip: bool,
    ) -> Result<MergePreview, CoreError> {
        check_ref(theirs)?;
        check_strategy(strategy)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let mut wip_included = false;
        let ours_ref: String = match ours {
            Some(o) => {
                check_ref(o)?;
                o.to_string()
            }
            None => {
                if include_wip && let Some(w) = self.wip_commit(session).await? {
                    wip_included = true;
                    w.to_hex()
                } else {
                    "HEAD".into()
                }
            }
        };
        let r = merge_tree(
            inner.runner(),
            &s.info.work_tree,
            None,
            &ours_ref,
            theirs,
            strategy,
        )
        .await?;
        Ok(MergePreview {
            ours: ours.map(str::to_string).unwrap_or_else(|| "HEAD".into()),
            theirs: theirs.to_string(),
            clean: r.clean,
            conflicts: r.conflicts,
            tree: r.tree,
            messages: r.messages,
            strategy: strategy.to_vec(),
            wip_included,
        })
    }

    /// 현재 branch 에 `reference` 를 merge 하면 어떻게 되는지 (CF-01)
    pub async fn merge_preview(
        &self,
        session: SessionId,
        reference: &str,
        strategy: &[String],
        include_wip: bool,
    ) -> Result<MergePreview, CoreError> {
        self.preview_between(session, None, reference, strategy, include_wip)
            .await
    }

    /// 옵션 조합별 충돌 수 비교 (CF-04)
    pub async fn merge_simulate(
        &self,
        session: SessionId,
        reference: &str,
        include_wip: bool,
    ) -> Result<Vec<MergePreview>, CoreError> {
        let mut out = Vec::with_capacity(SIMULATE_SETS.len());
        for set in SIMULATE_SETS {
            let strategy: Vec<String> = set.iter().map(|s| (*s).to_string()).collect();
            out.push(
                self.preview_between(session, None, reference, &strategy, include_wip)
                    .await?,
            );
        }
        Ok(out)
    }

    /// 미리보기 tree 안의 파일 내용 (충돌이면 마커 포함)
    pub async fn preview_file(
        &self,
        session: SessionId,
        tree: &Oid,
        path: &str,
    ) -> Result<String, CoreError> {
        if path.is_empty() || path.starts_with('-') {
            return Err(CoreError::Invalid(messages::bad_path(path)));
        }
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            ["show", &format!("{}:{path}", tree.to_hex())],
        )
        .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = inner.runner().run(req).await?.ok(&display)?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// HEAD 와 ref 사이의 (HEAD 에만, ref 에만) commit 수
    async fn ahead_behind(&self, session: SessionId, ours: &str, theirs: &str) -> (u32, u32) {
        let Ok(s) = self.inner_arc().get(session) else {
            return (0, 0);
        };
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "rev-list",
                "--left-right",
                "--count",
                "--end-of-options",
                &format!("{ours}...{theirs}"),
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let Ok(out) = self.inner_arc().runner().run(req).await else {
            return (0, 0);
        };
        if !out.exit.success() {
            return (0, 0);
        }
        let text = out.stdout_lossy();
        let mut f = text.split_whitespace();
        let a = f.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let b = f.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        (a, b)
    }

    /// 충돌 레이더 (CF-02): 업스트림·기본 branch·다른 로컬 branch·다른 워크트리 branch 와의 병합을 미리 본다
    pub async fn conflict_radar(
        &self,
        session: SessionId,
        max: usize,
        include_wip: bool,
    ) -> Result<Vec<RadarEntry>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let (current, upstream, locals, worktree_branches, remotes) = {
            let st = s.state();
            let current = st
                .refs
                .head
                .branch()
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            let upstream = current.as_ref().and_then(|c| {
                st.refs
                    .labels
                    .iter()
                    .find(|l| l.full_name == format!("refs/heads/{c}"))
                    .and_then(|l| l.upstream.clone())
                    .map(|u| u.strip_prefix("refs/remotes/").unwrap_or(&u).to_string())
            });
            let locals: Vec<String> = st
                .refs
                .labels
                .iter()
                .filter(|l| matches!(l.kind, mgit_model::RefKind::LocalBranch) && !l.is_current)
                .map(|l| l.short_name.clone())
                .collect();
            let wts: Vec<String> = st
                .refs
                .worktrees
                .iter()
                .filter_map(|w| w.branch.clone())
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(&b).to_string())
                .filter(|b| Some(b) != current.as_ref())
                .collect();
            let remotes: Vec<String> = st.refs.remotes.iter().map(|r| r.name.clone()).collect();
            (current, upstream, locals, wts, remotes)
        };
        if current.is_none() {
            return Ok(Vec::new());
        }
        let mut candidates: Vec<(String, RadarKind)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut push = |name: String, kind: RadarKind| {
            if seen.insert(name.clone()) {
                candidates.push((name, kind));
            }
        };
        if let Some(u) = upstream {
            push(u, RadarKind::Upstream);
        }
        // 기본 branch: origin/HEAD 가 가리키는 것, 없으면 main·master
        for remote in remotes.iter().take(1) {
            let req = GitRequest::new(
                &s.info.work_tree,
                [
                    "symbolic-ref",
                    "-q",
                    "--short",
                    &format!("refs/remotes/{remote}/HEAD"),
                ],
            )
            .with_env(EnvProfile::ReadInteractive);
            if let Ok(out) = inner.runner().run(req).await
                && out.exit.success()
            {
                let name = out.stdout_lossy().trim().to_string();
                if !name.is_empty() {
                    push(name, RadarKind::Default);
                }
            }
        }
        for b in ["main", "master", "develop"] {
            if locals.iter().any(|l| l == b) {
                push(b.to_string(), RadarKind::Default);
            }
        }
        for b in worktree_branches {
            push(b, RadarKind::Worktree);
        }
        for b in locals {
            push(b, RadarKind::Local);
        }
        candidates.truncate(max.max(1));
        let ours = if include_wip {
            self.wip_commit(session).await?.map(|o| o.to_hex())
        } else {
            None
        };
        let ours_ref = ours.as_deref().unwrap_or("HEAD");
        let mut out = Vec::new();
        for (reference, kind) in candidates {
            let (ahead, behind) = self.ahead_behind(session, "HEAD", &reference).await;
            let r = merge_tree(
                inner.runner(),
                &s.info.work_tree,
                None,
                ours_ref,
                &reference,
                &[],
            )
            .await;
            let (clean, conflicts) = match r {
                Ok(r) => (r.clean, r.conflicts),
                Err(_) => continue,
            };
            out.push(RadarEntry {
                reference,
                kind,
                clean,
                conflicts,
                behind,
                ahead,
            });
        }
        Ok(out)
    }

    /// rebase 예측 (CF-03): HEAD 의 commit 을 `onto` 위에 하나씩 얹어 본다. 충돌이 난 뒤는 근사치
    pub async fn rebase_preview(
        &self,
        session: SessionId,
        onto: &str,
    ) -> Result<Vec<RebaseStepPreview>, CoreError> {
        check_ref(onto)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let wt = s.info.work_tree.clone();
        let runner = inner.runner();
        let req = GitRequest::new(
            &wt,
            [
                "log",
                "--reverse",
                "--no-merges",
                "--format=%H%x00%s",
                "--end-of-options",
                &format!("{onto}..HEAD"),
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = runner.run(req).await?.ok(&display)?;
        let commits: Vec<(Oid, String)> = String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| {
                let (h, subject) = l.split_once('\0')?;
                Some((
                    Oid::from_hex(h.trim().as_bytes()).ok()?,
                    subject.to_string(),
                ))
            })
            .collect();
        let mut base = onto.to_string();
        let mut approximate = false;
        let mut steps = Vec::with_capacity(commits.len());
        for (oid, subject) in commits {
            let parent = format!("{}^", oid.to_hex());
            let r = merge_tree(runner, &wt, Some(&parent), &base, &oid.to_hex(), &[]).await?;
            steps.push(RebaseStepPreview {
                oid,
                subject,
                clean: r.clean,
                conflicts: r.conflicts.clone(),
                approximate,
            });
            if !r.clean {
                approximate = true;
            }
            // 결과 tree 로 임시 commit 을 만들어 다음 단계의 base 로 쓴다 (ref 는 안 만든다)
            let req = GitRequest::new(
                &wt,
                [
                    "commit-tree",
                    &r.tree.to_hex(),
                    "-p",
                    &base,
                    "-m",
                    "mgit rebase preview",
                ],
            )
            .with_env(EnvProfile::Write);
            match runner.run(req).await {
                Ok(o) if o.exit.success() => base = o.stdout_lossy().trim().to_string(),
                _ => break,
            }
        }
        Ok(steps)
    }

    /// 격리 병합 (CF-05): 임시 branch + 워크트리에서 merge 한다. 작업 트리는 건드리지 않는다
    pub async fn isolated_merge(
        &self,
        session: SessionId,
        reference: &str,
        mode: MergeMode,
    ) -> Result<IsolatedMerge, CoreError> {
        check_ref(reference)?;
        let Some(base) = self.head_branch_name(session) else {
            return Err(CoreError::Invalid(
                pick(
                    "detached HEAD 에서는 격리 병합을 시작할 수 없습니다",
                    "Cannot start an isolated merge on a detached HEAD",
                )
                .into(),
            ));
        };
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let ts = mgit_model::now_millis();
        let branch = format!("{ISOLATED_PREFIX}{ts}");
        let name = s
            .info
            .work_tree
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".into());
        let parent = s
            .info
            .work_tree
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| s.info.work_tree.clone());
        let wt = parent
            .join(format!("{name}.worktrees"))
            .join(format!("_merge-{ts}"));
        std::fs::create_dir_all(wt.parent().unwrap_or(&parent))?;
        self.run_write(
            session,
            WriteSpec::new(["branch", "--", &branch, "HEAD"])
                .no_undo()
                .skip_refresh(),
        )
        .await?;
        // 반영할 때 확인할 수 있게 시작한 브랜치를 남긴다. `branch -D` 가 함께 지운다
        self.run_write(
            session,
            WriteSpec::new(["config", &isolated_base_key(&branch), &base])
                .no_undo()
                .skip_refresh(),
        )
        .await?;
        self.worktree_add(session, &wt, WorktreeSource::Branch(branch.clone()))
            .await?;
        let mut args: Vec<String> = vec!["merge".into(), "--no-edit".into()];
        match mode {
            MergeMode::Default => {}
            MergeMode::NoFf => args.push("--no-ff".into()),
            MergeMode::FfOnly => args.push("--ff-only".into()),
            MergeMode::Squash => args.push("--squash".into()),
        }
        args.push("--end-of-options".into());
        args.push(reference.into());
        let req = GitRequest::new(&wt, args).with_env(EnvProfile::Write);
        let out = inner.runner().run(req).await?;
        let outcome = if out.exit.success() {
            OpOutcome::Clean
        } else if out.exit.status == Some(1) || out.exit.stderr.contains("CONFLICT") {
            OpOutcome::Conflicts
        } else {
            // 시작도 못 했으면 정리
            let _ = self.worktree_remove(session, &wt, true, false).await;
            let _ = self.delete_branch(session, &branch, true).await;
            return Err(CoreError::Invalid(tr!(
                "격리 병합 실패: {}",
                "Isolated merge failed: {}",
                out.exit.stderr.trim()
            )));
        };
        self.refresh(session).await?;
        Ok(IsolatedMerge {
            worktree: wt,
            branch,
            outcome,
        })
    }

    /// 이 세션이 격리 병합 워크트리면 (branch, 메인 워크트리 경로)
    pub fn isolated_info(
        &self,
        session: SessionId,
    ) -> Result<Option<(String, PathBuf)>, CoreError> {
        let s = self.inner_arc().get(session)?;
        let st = s.state();
        let Some(branch) = st
            .refs
            .head
            .branch()
            .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
            .filter(|b| b.starts_with(ISOLATED_PREFIX))
        else {
            return Ok(None);
        };
        let main = st
            .refs
            .worktrees
            .iter()
            .find(|w| w.is_main)
            .map(|w| w.path.clone())
            .ok_or_else(|| {
                CoreError::Invalid(
                    pick(
                        "메인 워크트리를 찾을 수 없습니다",
                        "Cannot find the main worktree",
                    )
                    .into(),
                )
            })?;
        Ok(Some((branch, main)))
    }

    /// 격리 병합 결과를 메인 branch 에 반영 (`merge --ff-only`) 하고 워크트리·branch 를 치운다.
    /// merge 가 끝나지 않았거나, 미커밋 변경이 있거나, 메인 워크트리가 시작한 브랜치에 있지 않으면
    /// 거부한다. `session` 은 격리 워크트리 세션
    pub async fn isolated_apply(&self, session: SessionId) -> Result<PathBuf, CoreError> {
        let (branch, main) = self
            .isolated_info(session)?
            .ok_or_else(|| CoreError::Invalid(messages::not_isolated_worktree().into()))?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        // 아래에서 워크트리를 --force 로 지우므로 끝나지 않은 merge·미커밋 변경이 있으면 멈춘다
        if inner.read_op(&s).await?.is_some() {
            return Err(CoreError::Invalid(pick("격리 merge 가 끝나지 않았습니다. 충돌을 해결하고 commit 한 뒤 반영하세요", "The isolated merge is not finished. Resolve the conflicts and commit, then apply").into()));
        }
        if inner.read_status(&s, true).await?.summary().has_changes() {
            return Err(CoreError::Invalid(pick("격리 워크트리에 커밋하지 않은 변경이 있습니다. commit 하거나 지운 뒤 반영하세요", "The isolated worktree has uncommitted changes. Commit or discard them, then apply").into()));
        }
        // 메인 워크트리가 시작한 브랜치에 있어야 한다. 아니면 엉뚱한 브랜치가 fast-forward 된다
        let started = config_get(inner.runner(), &main, &isolated_base_key(&branch)).await;
        let current = head_state(inner.runner(), &main).await?;
        let current = current.branch().map(short_branch);
        if started.is_none() || started.as_deref() != current {
            return Err(CoreError::Invalid(tr!(
                "격리 병합은 {} 에서 시작했는데 메인 워크트리는 {} 입니다. 메인 워크트리를 시작한 브랜치로 옮긴 뒤 반영하세요",
                "The isolated merge started from {} but the main worktree is on {}. Switch the main worktree to the starting branch, then apply",
                started
                    .as_deref()
                    .unwrap_or(pick("알 수 없는 브랜치", "an unknown branch")),
                current.unwrap_or("detached HEAD"),
            )));
        }
        let this = s.info.work_tree.clone();
        let req = GitRequest::new(
            &main,
            [
                "merge",
                "--ff-only",
                "--no-edit",
                "--end-of-options",
                &branch,
            ],
        )
        .with_env(EnvProfile::Write);
        let out = inner.runner().run(req).await?;
        if !out.exit.success() {
            return Err(CoreError::Invalid(tr!(
                "메인 branch 에 반영하지 못했습니다 (ff-only): {}",
                "Could not apply to the main branch (ff-only): {}",
                out.exit.stderr.trim()
            )));
        }
        self.isolated_cleanup(&main, &this, &branch).await;
        Ok(main)
    }

    /// 격리 병합을 버린다 (워크트리·branch 삭제). 메인 워크트리 경로를 돌려준다
    pub async fn isolated_discard(&self, session: SessionId) -> Result<PathBuf, CoreError> {
        let (branch, main) = self
            .isolated_info(session)?
            .ok_or_else(|| CoreError::Invalid(messages::not_isolated_worktree().into()))?;
        let this = self.inner_arc().get(session)?.info.work_tree.clone();
        self.isolated_cleanup(&main, &this, &branch).await;
        Ok(main)
    }

    /// 메인에서 워크트리 제거 + branch 삭제 (실패는 로그만)
    async fn isolated_cleanup(&self, main: &Path, worktree: &Path, branch: &str) {
        let runner = self.inner_arc();
        let runner = runner.runner();
        let req = GitRequest::new(
            main,
            [
                "worktree",
                "remove",
                "--force",
                "--",
                &worktree.to_string_lossy(),
            ],
        )
        .with_env(EnvProfile::Write);
        if let Err(e) = runner.run(req).await {
            tracing::warn!(error = %e, "격리 워크트리 제거 실패");
        }
        let req = GitRequest::new(main, ["branch", "-D", "--", branch]).with_env(EnvProfile::Write);
        if let Err(e) = runner.run(req).await {
            tracing::warn!(error = %e, "격리 branch 삭제 실패");
        }
    }
}

impl Core {
    /// `-X` 옵션을 붙인 merge (CF-04: 시뮬레이터에서 고른 옵션으로 실행)
    pub async fn merge_with(
        &self,
        session: SessionId,
        reference: &str,
        mode: MergeMode,
        strategy: &[String],
    ) -> Result<OpOutcome, CoreError> {
        check_ref(reference)?;
        check_strategy(strategy)?;
        let mut args: Vec<String> = vec!["merge".into(), "--no-edit".into()];
        match mode {
            MergeMode::Default => {}
            MergeMode::NoFf => args.push("--no-ff".into()),
            MergeMode::FfOnly => args.push("--ff-only".into()),
            MergeMode::Squash => args.push("--squash".into()),
        }
        for s in strategy {
            args.push(format!("-X{s}"));
        }
        args.push("--end-of-options".into());
        args.push(reference.into());
        let r = self.run_write(session, WriteSpec::new(args)).await;
        self.outcome(r)
    }
}
