//! 멀티 저장소 일괄 작업 (MR-05~09·11). 폴더 세션의 하위 저장소에 같은 명령을 돌린다.
//! 저장소 탭을 열지 않고 git 을 직접 부르며, pull·checkout 은 더티·진행 중 작업이면 건너뛴다

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::cmd::{
    discover, in_progress_op, list_unmerged, rev_resolves, scanned_repo_status,
    staged_conflict_markers,
};
use mgit_l10n::{pick, tr};
use mgit_model::{
    CancelToken, EnvProfile, FoundRepo, GitRequest, GitRunner, StatusEntry, StatusSummary,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::{CoreEvent, EventSink, SessionId};
use crate::folder::{FolderSession, canonical_paths, repo_name};
use crate::messages;

/// 변경 보기의 동시 저장소 수
const READ_CONCURRENCY: usize = 8;

/// 일괄 pull 방식 (MR-11)
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BatchPullMode {
    #[default]
    FfOnly,
    Rebase,
    Merge,
}

/// 폴더별 설정 (MR-11). 설정 키 `folder:<경로>`
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderSettings {
    /// 일괄 작업에서 뺄 저장소 이름
    pub exclude: Vec<String>,
    pub pull_mode: BatchPullMode,
    /// 동시 실행 수 (1~16)
    pub concurrency: u32,
    /// 대시보드 자동 갱신 간격 (초, 0 이면 끔)
    pub auto_refresh_secs: u32,
    /// 일괄 워크트리를 만들 기본 폴더
    pub worktree_root: Option<PathBuf>,
}

impl Default for FolderSettings {
    /// 기본값
    fn default() -> Self {
        FolderSettings {
            exclude: Vec::new(),
            pull_mode: BatchPullMode::FfOnly,
            concurrency: 4,
            auto_refresh_secs: 60,
            worktree_root: None,
        }
    }
}

/// 일괄 작업 종류 (MR-05·06·07)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BatchOp {
    Fetch {
        prune: bool,
    },
    Pull,
    Push,
    CreateBranch {
        name: String,
        checkout: bool,
        /// 시작점 ref. 없으면 저장소마다 자기 HEAD 에서 만든다. 이 ref 가 없는 저장소는 건너뛴다.
        /// 시작점이 원격 브랜치여도 새 브랜치는 그것을 추적하지 않는다 (`--no-track`)
        #[serde(default)]
        start_point: Option<String>,
    },
    Checkout {
        name: String,
    },
    /// 원격 브랜치 `<remote>/<branch>` 를 로컬 추적 브랜치로 checkout 한다 (분리 HEAD 로 두지 않는다).
    /// 저장소마다 같은 이름의 로컬 브랜치가 그 원격 브랜치를 추적하고 있으면 그것으로 전환하고,
    /// 로컬 브랜치가 없으면 그 원격을 추적하는 브랜치를 만들어 전환한다. 같은 이름의 로컬 브랜치가
    /// 업스트림이 없거나 다른 곳을 추적하는 저장소, 원격 브랜치가 없는 저장소는 건너뛴다
    /// (단일 저장소의 `CheckoutTarget::RemoteBranch` 와 같은 규칙)
    CheckoutRemote {
        remote: String,
        branch: String,
    },
    /// `<dest_root>/<저장소 이름>` 에 워크트리. `create_branch` 면 `-b`
    Worktree {
        branch: String,
        dest_root: PathBuf,
        create_branch: bool,
    },
}

impl BatchOp {
    /// 진행 표시용 라벨
    pub fn label(&self) -> String {
        match self {
            BatchOp::Fetch { .. } => pick("일괄 fetch", "Batch fetch").into(),
            BatchOp::Pull => pick("일괄 pull", "Batch pull").into(),
            BatchOp::Push => pick("일괄 push", "Batch push").into(),
            BatchOp::CreateBranch {
                name,
                start_point: Some(start),
                ..
            } => tr!(
                "일괄 branch 만들기: {name} ({} 에서)",
                "Batch create branch: {name} (from {})",
                short_ref(start)
            ),
            BatchOp::CreateBranch { name, .. } => {
                tr!("일괄 branch 만들기: {name}", "Batch create branch: {name}")
            }
            BatchOp::Checkout { name } => tr!("일괄 checkout: {name}", "Batch checkout: {name}"),
            BatchOp::CheckoutRemote { remote, branch } => {
                tr!(
                    "일괄 checkout: {remote}/{branch}",
                    "Batch checkout: {remote}/{branch}"
                )
            }
            BatchOp::Worktree { branch, .. } => {
                tr!("일괄 워크트리: {branch}", "Batch worktree: {branch}")
            }
        }
    }

    /// 사용자 입력 검증 (브랜치 이름·시작점·경로)
    fn validate(&self) -> Result<(), CoreError> {
        match self {
            BatchOp::CreateBranch {
                name, start_point, ..
            } => {
                check_ref_name(name)?;
                start_point.as_deref().map_or(Ok(()), check_ref_name)
            }
            BatchOp::Checkout { name } => check_ref_name(name),
            BatchOp::CheckoutRemote { remote, branch } => {
                check_ref_name(remote)?;
                check_ref_name(branch)
            }
            BatchOp::Worktree {
                branch, dest_root, ..
            } => {
                check_ref_name(branch)?;
                if dest_root.as_os_str().is_empty() {
                    return Err(CoreError::Invalid(
                        pick("워크트리 폴더를 지정하세요", "Choose a worktree folder").into(),
                    ));
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// 브랜치·ref 이름 검사 (옵션 오인·공백·제어 문자(NUL 포함)·`..` 방지)
fn check_ref_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(CoreError::Invalid(tr!(
            "잘못된 branch 이름: {name:?}",
            "Invalid branch name: {name:?}"
        )));
    }
    Ok(())
}

/// ref 전체 이름을 화면용 짧은 이름으로 (`refs/remotes/origin/x` → `origin/x`)
fn short_ref(name: &str) -> &str {
    name.strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/remotes/"))
        .unwrap_or(name)
}

/// 여러 작업이 함께 쓰는 건너뜀 사유 (지금 언어)
mod reason {
    use mgit_l10n::pick;

    /// 진행 중인 작업(merge·rebase 등)이나 해결하지 않은 충돌이 있다
    pub(super) fn in_progress() -> &'static str {
        pick("진행 중인 작업이 있음", "Operation in progress")
    }

    /// 커밋하지 않은 변경이 있다
    pub(super) fn dirty() -> &'static str {
        pick("커밋하지 않은 변경이 있음", "Uncommitted changes")
    }

    /// 업스트림이 없다
    pub(super) fn no_upstream() -> &'static str {
        pick("업스트림 없음", "No upstream")
    }

    /// 이미 그 브랜치에 있다
    pub(super) fn already_on_branch() -> &'static str {
        pick("이미 그 branch", "Already on that branch")
    }
}

/// 저장소 하나의 결과
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoResult {
    pub path: PathBuf,
    pub name: String,
    /// 성공 또는 건너뜀
    pub ok: bool,
    /// 건너뛴 이유 (있으면 실행하지 않았다)
    pub skipped: Option<String>,
    /// 출력 또는 오류 메시지
    pub message: String,
}

/// 일괄 작업 결과
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub label: String,
    pub results: Vec<RepoResult>,
    pub succeeded: u32,
    pub skipped: u32,
    pub failed: u32,
}

/// 저장소 하나의 변경 (MR-08)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanges {
    pub path: PathBuf,
    pub name: String,
    pub branch: Option<String>,
    pub entries: Vec<StatusEntry>,
    pub summary: StatusSummary,
}

/// 일괄 작업이 끝난 저장소마다 `FolderChanged` 를 보낸다. 감시가 없거나 놓쳐도 프런트가
/// 대상 저장소만 다시 읽는다 (PF-02)
fn notify_changed(folder: &FolderSession, results: &[RepoResult]) {
    for r in results {
        folder.sink.emit(CoreEvent::FolderChanged {
            session: folder.id,
            refs: true,
            repo: Some(r.path.clone()),
        });
    }
}

/// 전체 이름으로 준 ref 들의 업스트림을 읽는다 (ref 전체 이름 → 업스트림 전체 이름).
/// 없는 ref 는 결과에 없다. `for-each-ref` 의 패턴은 하위 ref 도 맞추므로 이름이 정확히 같은 것만 남긴다
async fn ref_upstreams(
    runner: &dyn GitRunner,
    work_tree: &Path,
    names: &[&str],
) -> Result<HashMap<String, Option<String>>, String> {
    let mut args = vec!["for-each-ref", "--format=%(refname)%00%(upstream)"];
    args.extend(names);
    let req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadInteractive);
    let out = runner.run(req).await.map_err(|e| e.to_string())?;
    if !out.exit.success() {
        return Err(mgit_model::redact_text(out.exit.stderr.trim()));
    }
    Ok(out
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let (name, upstream) = line.split_once('\0')?;
            names.contains(&name).then(|| {
                (
                    name.to_string(),
                    (!upstream.is_empty()).then(|| upstream.to_string()),
                )
            })
        })
        .collect())
}

/// 폴더 설정 키
fn settings_key(path: &Path) -> String {
    format!("folder:{}", path.display())
}

/// git 하나를 돌리고 (성공, 메시지) 로
async fn run_git(
    inner: &CoreInner,
    work_tree: &Path,
    args: &[String],
    network: bool,
) -> (bool, String) {
    let mut req = GitRequest::new(work_tree, args.iter().cloned()).with_env(if network {
        EnvProfile::Network
    } else {
        EnvProfile::Write
    });
    let auth_tag = network.then(|| inner.auth_tag());
    if let Some(tag) = &auth_tag {
        req = req.with_env_var(mgit_helper::ENV_TAG, tag);
    }
    let result = inner.runner().run(req).await;
    if let Some(tag) = &auth_tag {
        let stderr = match &result {
            Ok(out) if !out.exit.success() => out.exit.stderr.as_str(),
            _ => "",
        };
        inner.report_auth(tag, stderr).await;
    }
    match result {
        Ok(out) => {
            let ok = out.exit.success();
            let msg = if ok {
                out.stdout_lossy().trim().to_string()
            } else {
                mgit_model::redact_text(out.exit.stderr.trim())
            };
            (ok, msg)
        }
        Err(e) => (false, mgit_model::redact_text(&e.to_string())),
    }
}

/// 문자열 슬라이스 → Vec<String>
fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

/// 저장소 하나에 작업을 적용한다. 실패해도 결과 한 줄로 남긴다.
/// 판별 직후부터 git 쓰기가 끝날 때까지 그 저장소의 쓰기 잠금(`write_lock_for(common_dir)`)을 쥔다 — 같은
/// 저장소에 열린 세션(탭·가벼운 세션)의 쓰기 큐와 같은 잠금이라 일괄 pull 과 세션의 commit 이 겹치지 않고,
/// 더티·진행 중 검사가 실행 시점까지 유효하다. 태스크 하나가 쥐는 쓰기 잠금은 하나뿐이고(중첩 없음),
/// 세션이 없는 저장소에서는 아무도 기다리지 않는 잠금이라 동작이 전과 같다. 잠금을 기다리는 동안에도 취소를 본다
async fn run_batch_one(
    inner: Arc<CoreInner>,
    found: FoundRepo,
    op: Arc<BatchOp>,
    settings: Arc<FolderSettings>,
    cancel: CancelToken,
) -> RepoResult {
    let name = repo_name(&found.path);
    let mut r = RepoResult {
        path: found.path.clone(),
        name: name.clone(),
        ok: false,
        skipped: None,
        message: String::new(),
    };
    /// 건너뛰기 (성공으로 센다)
    fn skip(r: &mut RepoResult, why: &str) {
        r.skipped = Some(why.into());
        r.ok = true;
    }
    if settings.exclude.iter().any(|x| x == &name) {
        skip(
            &mut r,
            pick("제외됨 (폴더 설정)", "Excluded (folder settings)"),
        );
        return r;
    }
    let runner = inner.runner();
    let d = match discover(runner, &found.path).await {
        Ok(d) => d,
        Err(e) => {
            r.message = e.to_string();
            return r;
        }
    };
    let lock = inner.write_lock_for(&d.common_dir);
    let _queued = tokio::select! {
        guard = lock.lock() => guard,
        () = cancel.cancelled() => {
            skip(&mut r, messages::cancelled());
            return r;
        }
    };
    if cancel.is_cancelled() {
        skip(&mut r, messages::cancelled());
        return r;
    }
    let status = match scanned_repo_status(runner, &d.work_tree).await {
        Ok(s) => s,
        Err(e) => {
            r.message = e.to_string();
            return r;
        }
    };
    let sum = status.summary();
    let dirty = sum.staged + sum.unstaged + sum.conflicted > 0;
    let in_op = in_progress_op(runner, &d.git_dir, &d.common_dir, &d.work_tree)
        .await
        .ok()
        .flatten()
        .is_some();
    let (args, network): (Vec<String>, bool) = match &*op {
        BatchOp::Fetch { prune } => {
            let mut a = strs(&["fetch", "--all"]);
            if *prune {
                a.push("--prune".into());
            }
            (a, true)
        }
        BatchOp::Pull => {
            if in_op {
                skip(&mut r, reason::in_progress());
                return r;
            }
            if dirty {
                skip(&mut r, reason::dirty());
                return r;
            }
            if status.branch.upstream.is_none() {
                skip(&mut r, reason::no_upstream());
                return r;
            }
            let mode = match settings.pull_mode {
                BatchPullMode::FfOnly => "--ff-only",
                BatchPullMode::Rebase => "--rebase",
                BatchPullMode::Merge => "--no-rebase",
            };
            (strs(&["pull", mode]), true)
        }
        BatchOp::Push => {
            if status.branch.upstream.is_none() {
                skip(&mut r, reason::no_upstream());
                return r;
            }
            if status.branch.ahead == 0 {
                skip(&mut r, pick("보낼 commit 없음", "No commits to push"));
                return r;
            }
            (strs(&["push"]), true)
        }
        BatchOp::CreateBranch {
            name,
            checkout,
            start_point,
        } => {
            if *checkout && in_op {
                skip(&mut r, reason::in_progress());
                return r;
            }
            if let Some(start) = start_point
                && !rev_resolves(runner, &d.work_tree, start).await
            {
                skip(
                    &mut r,
                    &tr!(
                        "시작점이 없음: {}",
                        "Start point not found: {}",
                        short_ref(start)
                    ),
                );
                return r;
            }
            // 시작점이 원격 브랜치면 git 은 기본으로 새 브랜치가 그것을 추적하게 한다
            // (`branch.autoSetupMerge`). 그러면 push 가 이름이 다른 그 원격 브랜치를 갱신하게 되므로
            // 추적을 걸지 않는다. 시작점은 이름 뒤에 두고, checkout 은 `--` 로 경로와 헷갈리지 않게 한다
            let a = match (start_point, *checkout) {
                (Some(start), true) => {
                    strs(&["checkout", "-q", "--no-track", "-b", name, start, "--"])
                }
                (Some(start), false) => strs(&["branch", "--no-track", "--", name, start]),
                (None, true) => strs(&["checkout", "-q", "-b", name]),
                (None, false) => strs(&["branch", "--", name]),
            };
            (a, false)
        }
        BatchOp::Checkout { name } => {
            if in_op {
                skip(&mut r, reason::in_progress());
                return r;
            }
            if dirty {
                skip(&mut r, reason::dirty());
                return r;
            }
            if status.branch.head.as_deref() == Some(name.as_str()) {
                skip(&mut r, reason::already_on_branch());
                return r;
            }
            (strs(&["checkout", "-q", name, "--"]), false)
        }
        BatchOp::CheckoutRemote { remote, branch } => {
            if in_op {
                skip(&mut r, reason::in_progress());
                return r;
            }
            if dirty {
                skip(&mut r, reason::dirty());
                return r;
            }
            let tracking = format!("refs/remotes/{remote}/{branch}");
            let local = format!("refs/heads/{branch}");
            let upstreams =
                match ref_upstreams(runner, &d.work_tree, &[local.as_str(), tracking.as_str()])
                    .await
                {
                    Ok(map) => map,
                    Err(e) => {
                        r.message = e;
                        return r;
                    }
                };
            if !upstreams.contains_key(&tracking) {
                skip(
                    &mut r,
                    &tr!(
                        "원격 branch 가 없음: {remote}/{branch}",
                        "Remote branch not found: {remote}/{branch}"
                    ),
                );
                return r;
            }
            match upstreams.get(&local) {
                // 같은 이름의 로컬이 정확히 그 원격 브랜치를 추적한다: 그 로컬로 전환한다
                Some(Some(upstream)) if upstream == &tracking => {
                    if status.branch.head.as_deref() == Some(branch.as_str()) {
                        skip(&mut r, reason::already_on_branch());
                        return r;
                    }
                    (strs(&["switch", "-q", "--end-of-options", branch]), false)
                }
                // 같은 이름의 로컬이 다른 곳을 추적하거나 업스트림이 없다. 그 로컬로 전환하면 고른 원격
                // 브랜치와 무관한 커밋에 서게 되므로 건드리지 않는다 (단일 저장소의
                // `LocalBranchTracksOther` 와 같은 상황. 일괄에서는 묻지 않고 건너뛴다)
                Some(Some(upstream)) => {
                    skip(
                        &mut r,
                        &tr!(
                            "로컬 {branch} 이(가) {} 을(를) 추적 중",
                            "Local {branch} tracks {}",
                            short_ref(upstream)
                        ),
                    );
                    return r;
                }
                Some(None) => {
                    skip(
                        &mut r,
                        &tr!(
                            "로컬 {branch} 이(가) {remote}/{branch} 을(를) 추적하지 않음",
                            "Local {branch} does not track {remote}/{branch}"
                        ),
                    );
                    return r;
                }
                // 전체 ref 로 가리켜 `origin/x` 라는 로컬 브랜치가 있어도 모호하지 않게 한다
                None => (
                    strs(&[
                        "switch",
                        "-q",
                        "--track",
                        "-c",
                        branch,
                        "--end-of-options",
                        &tracking,
                    ]),
                    false,
                ),
            }
        }
        BatchOp::Worktree {
            branch,
            dest_root,
            create_branch,
        } => {
            let dest = dest_root.join(&name);
            if dest.exists() {
                skip(&mut r, pick("경로가 이미 있음", "Path already exists"));
                return r;
            }
            let dest_s = dest.to_string_lossy().into_owned();
            let a = if *create_branch {
                vec![
                    "worktree".to_string(),
                    "add".into(),
                    "-b".into(),
                    branch.clone(),
                    dest_s,
                ]
            } else {
                vec!["worktree".to_string(), "add".into(), dest_s, branch.clone()]
            };
            (a, false)
        }
    };
    let (ok, msg) = run_git(&inner, &d.work_tree, &args, network).await;
    r.ok = ok;
    r.message = msg;
    r
}

impl Core {
    /// 폴더 설정 (MR-11)
    pub fn folder_settings(&self, session: SessionId) -> Result<FolderSettings, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        Ok(self
            .store()
            .setting_get(&settings_key(&folder.path))
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default())
    }

    /// 폴더 설정 저장
    pub fn set_folder_settings(
        &self,
        session: SessionId,
        settings: &FolderSettings,
    ) -> Result<(), CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let json = serde_json::to_string(settings)
            .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
        self.store()
            .setting_set(&settings_key(&folder.path), &json)?;
        Ok(())
    }

    /// 일괄 작업 (MR-05·06·07). `repos` 가 비어 있으면 전부. 진행률은 폴더 세션의 Operation 이벤트로
    pub async fn folder_batch(
        &self,
        session: SessionId,
        op: BatchOp,
        repos: &[PathBuf],
    ) -> Result<BatchResult, CoreError> {
        op.validate()?;
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let settings = Arc::new(self.folder_settings(session)?);
        let all = folder.repos();
        let wanted = canonical_paths(repos);
        let targets: Vec<FoundRepo> = if wanted.is_empty() {
            all
        } else {
            all.into_iter()
                .filter(|r| wanted.iter().any(|p| p == &r.path))
                .collect()
        };
        if targets.is_empty() {
            return Err(CoreError::Invalid(
                pick("대상 저장소가 없습니다", "No target repositories").into(),
            ));
        }
        let result = self
            .batch_run(
                session,
                Arc::clone(&folder.sink),
                targets,
                op,
                (*settings).clone(),
            )
            .await?;
        notify_changed(&folder, &result.results);
        Ok(result)
    }

    /// 저장소 목록에 작업을 돌린다 (폴더·서브모듈 공용). 진행률은 `sink` 로 Operation 이벤트
    pub(crate) async fn batch_run(
        &self,
        session: SessionId,
        sink: Arc<dyn EventSink>,
        targets: Vec<FoundRepo>,
        op: BatchOp,
        settings: FolderSettings,
    ) -> Result<BatchResult, CoreError> {
        // 두 진입점(폴더·서브모듈)이 모두 여기를 지나므로 인자 검증을 여기서도 한다
        op.validate()?;
        let inner = self.inner_arc();
        let settings = Arc::new(settings);
        let label = op.label();
        let op = Arc::new(op);
        let handle = inner.ops.begin(session);
        let op_id = handle.id;
        sink.emit(CoreEvent::OperationStarted {
            session,
            op_id,
            kind: "batch".into(),
            label: label.clone(),
        });
        let total = targets.len();
        let sem = Arc::new(Semaphore::new(settings.concurrency.clamp(1, 16) as usize));
        let mut set = JoinSet::new();
        for found in targets {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            let op = Arc::clone(&op);
            let settings = Arc::clone(&settings);
            let cancel = handle.cancel.clone();
            set.spawn(async move {
                let _permit = sem.acquire().await;
                if cancel.is_cancelled() {
                    return RepoResult {
                        name: repo_name(&found.path),
                        path: found.path,
                        ok: true,
                        skipped: Some(messages::cancelled().into()),
                        message: String::new(),
                    };
                }
                run_batch_one(inner, found, op, settings, cancel).await
            });
        }
        let mut results = Vec::with_capacity(total);
        while let Some(joined) = set.join_next().await {
            if let Ok(res) = joined {
                sink.emit(CoreEvent::OperationProgress {
                    session,
                    op_id,
                    phase: res.name.clone(),
                    percent: Some(((results.len() + 1) * 100 / total) as u8),
                    message: if res.ok {
                        String::new()
                    } else {
                        res.message.clone()
                    },
                });
                results.push(res);
            }
        }
        results.sort_by(|a, b| a.path.cmp(&b.path));
        let skipped = results.iter().filter(|r| r.skipped.is_some()).count() as u32;
        let failed = results.iter().filter(|r| !r.ok).count() as u32;
        let succeeded = results.len() as u32 - skipped - failed;
        sink.emit(CoreEvent::OperationFinished {
            session,
            op_id,
            ok: failed == 0,
            cancelled: handle.cancel.is_cancelled(),
            message: tr!(
                "성공 {succeeded} · 건너뜀 {skipped} · 실패 {failed}",
                "{succeeded} succeeded · {skipped} skipped · {failed} failed"
            ),
            lock_left: false,
        });
        inner.ops.end(op_id);
        Ok(BatchResult {
            label,
            results,
            succeeded,
            skipped,
            failed,
        })
    }

    /// 변경이 있는 저장소의 상태 (MR-08). `repos` 가 비어 있으면 전부, 아니면 그 저장소만 읽는다
    /// (PF-02). 변경이 없는 저장소는 결과에 없다. 목록에 없는 경로는 거부한다
    pub async fn folder_changes(
        &self,
        session: SessionId,
        repos: &[PathBuf],
    ) -> Result<Vec<RepoChanges>, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let sem = Arc::new(Semaphore::new(READ_CONCURRENCY));
        let mut set = JoinSet::new();
        for found in folder.select(repos)?.into_iter().map(|r| r.found) {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            set.spawn(async move {
                let _permit = sem.acquire().await;
                let runner = inner.runner();
                let d = discover(runner, &found.path).await.ok()?;
                let status = scanned_repo_status(runner, &d.work_tree).await.ok()?;
                if status.entries.is_empty() {
                    return None;
                }
                Some(RepoChanges {
                    name: repo_name(&found.path),
                    path: found.path,
                    branch: status.branch.head.clone(),
                    summary: status.summary(),
                    entries: status.entries,
                })
            });
        }
        let mut out = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok(Some(c)) = r {
                out.push(c);
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// 같은 메시지로 여러 저장소에 커밋 (MR-08). `stage_all` 이면 `add -A` 먼저.
    /// stage 된 변경이 없는 저장소는 건너뛴다
    pub async fn folder_commit(
        &self,
        session: SessionId,
        repos: &[PathBuf],
        message: &str,
        stage_all: bool,
    ) -> Result<BatchResult, CoreError> {
        if message.trim().is_empty() {
            return Err(CoreError::Invalid(
                pick("커밋 메시지를 입력하세요", "Enter a commit message").into(),
            ));
        }
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let wanted = canonical_paths(repos);
        let targets: Vec<FoundRepo> = folder
            .repos()
            .into_iter()
            .filter(|r| wanted.is_empty() || wanted.iter().any(|p| p == &r.path))
            .collect();
        let mut results = Vec::new();
        for found in targets {
            let name = repo_name(&found.path);
            let mut r = RepoResult {
                path: found.path.clone(),
                name,
                ok: false,
                skipped: None,
                message: String::new(),
            };
            let d = match discover(inner.runner(), &found.path).await {
                Ok(d) => d,
                Err(e) => {
                    r.message = e.to_string();
                    results.push(r);
                    continue;
                }
            };
            // 검사부터 commit 까지 그 저장소의 쓰기 잠금을 쥔다 (세션 쓰기 큐와 같은 잠금, 반복마다 풀림)
            let lock = inner.write_lock_for(&d.common_dir);
            let _queued = lock.lock().await;
            // 충돌이 남았거나 작업이 진행 중이면 건드리지 않는다. `add -A` 가 충돌 파일을 해결된 것으로
            // 만들고 commit 이 그 작업을 끝내 버린다
            let unmerged = list_unmerged(inner.runner(), &d.work_tree)
                .await
                .map_or(true, |entries| !entries.is_empty());
            let in_op = in_progress_op(inner.runner(), &d.git_dir, &d.common_dir, &d.work_tree)
                .await
                .ok()
                .flatten()
                .is_some();
            if unmerged || in_op {
                r.ok = true;
                r.skipped = Some(reason::in_progress().into());
                results.push(r);
                continue;
            }
            if stage_all {
                let (ok, msg) = run_git(&inner, &d.work_tree, &strs(&["add", "-A"]), false).await;
                if !ok {
                    r.message = msg;
                    results.push(r);
                    continue;
                }
            }
            // stage 된 변경이 있는지 (`diff --cached --name-only` 출력 유무)
            let req = GitRequest::new(&d.work_tree, ["diff", "--cached", "--name-only"])
                .with_env(EnvProfile::ReadInteractive);
            let staged = match inner.runner().run(req).await {
                Ok(out) => out.exit.success() && !out.stdout_lossy().trim().is_empty(),
                Err(_) => false,
            };
            if !staged {
                r.ok = true;
                r.skipped = Some(pick("stage 된 변경 없음", "No staged changes").into());
                results.push(r);
                continue;
            }
            // 단일 저장소 커밋과 같은 검사 (CF-24)
            if let Ok(markers) = staged_conflict_markers(inner.runner(), &d.work_tree).await
                && !markers.is_empty()
            {
                let mut files: Vec<String> = markers.into_iter().map(|m| m.path).collect();
                files.dedup();
                r.message = messages::conflict_markers(&files);
                results.push(r);
                continue;
            }
            let req = GitRequest::new(&d.work_tree, ["commit", "-q", "-F", "-"])
                .with_env(EnvProfile::Write)
                .with_stdin(message.as_bytes().to_vec());
            match inner.runner().run(req).await {
                Ok(out) if out.exit.success() => {
                    r.ok = true;
                    r.message = out.stdout_lossy().trim().to_string();
                }
                Ok(out) => r.message = out.exit.stderr.trim().to_string(),
                Err(e) => r.message = e.to_string(),
            }
            results.push(r);
        }
        let skipped = results.iter().filter(|r| r.skipped.is_some()).count() as u32;
        let failed = results.iter().filter(|r| !r.ok).count() as u32;
        let succeeded = results.len() as u32 - skipped - failed;
        notify_changed(&folder, &results);
        Ok(BatchResult {
            label: pick("일괄 commit", "Batch commit").into(),
            results,
            succeeded,
            skipped,
            failed,
        })
    }
}
