//! 멀티 저장소 일괄 작업 커맨드 (Phase 2 C1)

use std::path::{Path, PathBuf};

use mgit_core::{
    BatchMergeMode, BatchOp, BatchPullMode, FolderSettings, IndexTarget, IndexWriteResult,
    IntegrationOutcome, IntegrationPreview, IntegrationTarget, SessionId, SkipReason,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_branch_delete::{BranchDeleteTarget, BranchDeletionResult};
use crate::commands_history::{AuthorListDto, DiffOptionsDto, GraphLayoutPrefsDto, GraphQueryDto};
use crate::commands_refs::{CommitDetail, ContainingRefsDto, parse_oid};
use crate::dto::{GraphWindow, HeadState, StatusEntry, StatusSummary};
use crate::dto_diff::FileDiff;
use crate::error::IpcError;
use crate::state::AppState;

/// 일괄 pull 방식
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BatchPullModeDto {
    FfOnly,
    Rebase,
    Merge,
}

/// 폴더 설정
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderSettingsDto {
    pub exclude: Vec<String>,
    pub pull_mode: BatchPullModeDto,
    pub concurrency: u32,
    pub auto_refresh_secs: u32,
    pub worktree_root: Option<String>,
}

impl From<FolderSettings> for FolderSettingsDto {
    /// 코어 → wire
    fn from(s: FolderSettings) -> Self {
        FolderSettingsDto {
            exclude: s.exclude,
            pull_mode: match s.pull_mode {
                BatchPullMode::FfOnly => BatchPullModeDto::FfOnly,
                BatchPullMode::Rebase => BatchPullModeDto::Rebase,
                BatchPullMode::Merge => BatchPullModeDto::Merge,
            },
            concurrency: s.concurrency,
            auto_refresh_secs: s.auto_refresh_secs,
            worktree_root: s.worktree_root.map(|p| p.display().to_string()),
        }
    }
}

impl From<FolderSettingsDto> for FolderSettings {
    /// wire → 코어
    fn from(s: FolderSettingsDto) -> Self {
        FolderSettings {
            exclude: s.exclude,
            pull_mode: match s.pull_mode {
                BatchPullModeDto::FfOnly => BatchPullMode::FfOnly,
                BatchPullModeDto::Rebase => BatchPullMode::Rebase,
                BatchPullModeDto::Merge => BatchPullMode::Merge,
            },
            concurrency: s.concurrency,
            auto_refresh_secs: s.auto_refresh_secs,
            worktree_root: s
                .worktree_root
                .filter(|p| !p.trim().is_empty())
                .map(PathBuf::from),
        }
    }
}

/// 일괄 작업
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BatchOpDto {
    Merge {
        reference: String,
        mode: BatchMergeMode,
        targets: Vec<IntegrationTarget>,
    },
    Rebase {
        reference: String,
        targets: Vec<IntegrationTarget>,
    },
    DeleteRemoteBranch {
        targets: Vec<BranchDeleteTarget>,
        delete_local: bool,
    },
    DeleteLocalBranches {
        targets: Vec<BranchDeleteTarget>,
    },
    DeleteBranch {
        name: String,
    },
    Fetch {
        prune: bool,
    },
    Pull,
    /// 업스트림으로 push. `newUpstream` 이 있으면 업스트림이 없는 branch 를 새 업스트림으로 게시한다 (없으면 건너뜀)
    Push {
        #[serde(default)]
        new_upstream: Option<NewUpstreamDto>,
    },
    CreateBranch {
        name: String,
        checkout: bool,
        /// 시작점 ref. 없으면 저장소마다 자기 HEAD. 이 ref 가 없는 저장소는 건너뛴다
        #[serde(default)]
        start_point: Option<String>,
    },
    Checkout {
        name: String,
    },
    /// 원격 브랜치 `<remote>/<branch>` 를 로컬 추적 브랜치로 checkout
    CheckoutRemote {
        remote: String,
        branch: String,
    },
    Worktree {
        branch: String,
        dest_root: String,
        create_branch: bool,
    },
    /// 로컬 branch 를 업스트림으로 fast-forward (BR-09). checkout 하지 않은 branch 도 갱신한다
    UpdateBranch {
        name: String,
    },
    /// 로컬 branch `from` 의 이름을 `to` 로 (`git branch -m`). branch 가 없거나 새 이름이 이미 있는 저장소는 건너뛴다
    RenameBranch {
        from: String,
        to: String,
    },
    /// 변경이 있는 저장소마다 stash 저장. 메시지 끝에 묶음 표시 `[mgit-batch:<batch>]` 를 붙인다. 미추적 파일은
    /// `includeUntracked` 일 때만
    StashPush {
        batch: String,
        #[serde(default)]
        message: Option<String>,
        include_untracked: bool,
    },
    /// 묶음 `batch` 의 stash 항목을 저장소마다 찾아 적용 후 지운다. 충돌이면 항목을 남긴다
    StashPop {
        batch: String,
    },
    /// 저장소마다 그 작업 트리에서 git 명령 하나를 실행한다 (MR-14). `args` 는 `git` 뒤의 인자 배열이고 셸을 거치지
    /// 않는다. 종료 코드가 0 이 아니면 실패다
    RunCommand {
        args: Vec<String>,
    },
}

/// 일괄 push 의 새 업스트림 게시 규칙. 고르지 않은 저장소는 `origin` 이 있으면 그것으로 보낸다
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewUpstreamDto {
    /// 저장소별로 고른 원격 (`origin` 이 없는 저장소의 예외 선택)
    #[serde(default)]
    pub remotes: Vec<PushRemoteDto>,
}

/// 저장소 하나에 새 업스트림으로 쓸 원격
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PushRemoteDto {
    pub path: String,
    pub remote: String,
}

impl From<NewUpstreamDto> for mgit_core::NewUpstream {
    /// wire → 코어 (경로 문자열을 경로로)
    fn from(plan: NewUpstreamDto) -> Self {
        mgit_core::NewUpstream {
            remotes: plan
                .remotes
                .into_iter()
                .map(|choice| mgit_core::PushRemote {
                    path: PathBuf::from(choice.path),
                    remote: choice.remote,
                })
                .collect(),
        }
    }
}

impl From<BatchOpDto> for BatchOp {
    /// wire → 코어
    fn from(op: BatchOpDto) -> Self {
        match op {
            BatchOpDto::Merge {
                reference,
                mode,
                targets,
            } => BatchOp::Merge {
                reference,
                mode,
                targets,
            },
            BatchOpDto::Rebase { reference, targets } => BatchOp::Rebase { reference, targets },
            BatchOpDto::DeleteRemoteBranch {
                targets,
                delete_local,
            } => BatchOp::DeleteRemoteBranch {
                targets: targets.into_iter().map(Into::into).collect(),
                delete_local,
            },
            BatchOpDto::DeleteLocalBranches { targets } => BatchOp::DeleteLocalBranches {
                targets: targets.into_iter().map(Into::into).collect(),
            },
            BatchOpDto::DeleteBranch { name } => BatchOp::DeleteBranch { name },
            BatchOpDto::Fetch { prune } => BatchOp::Fetch { prune },
            BatchOpDto::Pull => BatchOp::Pull,
            BatchOpDto::Push { new_upstream } => BatchOp::Push {
                new_upstream: new_upstream.map(Into::into),
            },
            BatchOpDto::CreateBranch {
                name,
                checkout,
                start_point,
            } => BatchOp::CreateBranch {
                name,
                checkout,
                start_point,
            },
            BatchOpDto::Checkout { name } => BatchOp::Checkout { name },
            BatchOpDto::CheckoutRemote { remote, branch } => {
                BatchOp::CheckoutRemote { remote, branch }
            }
            BatchOpDto::Worktree {
                branch,
                dest_root,
                create_branch,
            } => BatchOp::Worktree {
                branch,
                dest_root: PathBuf::from(dest_root),
                create_branch,
            },
            BatchOpDto::UpdateBranch { name } => BatchOp::UpdateBranch { name },
            BatchOpDto::RenameBranch { from, to } => BatchOp::RenameBranch { from, to },
            BatchOpDto::StashPush {
                batch,
                message,
                include_untracked,
            } => BatchOp::StashPush {
                batch,
                message,
                include_untracked,
            },
            BatchOpDto::StashPop { batch } => BatchOp::StashPop { batch },
            BatchOpDto::RunCommand { args } => BatchOp::RunCommand { args },
        }
    }
}

/// 일괄 명령(MR-14)을 실행한 저장소 하나의 종료 코드·소요 시간·출력
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutputDto {
    /// 종료 코드. 시그널로 끝났거나 취소했으면 null
    pub status: Option<i32>,
    pub elapsed_ms: u32,
    /// stdout 앞부분 (저장소마다 1 MiB 까지, URL 자격 증명 가림)
    pub stdout: String,
    /// stdout 이 상한을 넘어 뒷부분을 버렸다
    pub stdout_truncated: bool,
    /// stderr 끝부분 (64 KiB 까지, URL 자격 증명 가림)
    pub stderr: String,
    /// stderr 앞부분이 잘렸을 수 있다
    pub stderr_truncated: bool,
}

impl From<mgit_core::CommandOutput> for CommandOutputDto {
    /// 코어 → wire (소요 시간은 u32 밀리초로 자른다)
    fn from(c: mgit_core::CommandOutput) -> Self {
        CommandOutputDto {
            status: c.status,
            elapsed_ms: c.elapsed_ms.min(u64::from(u32::MAX)) as u32,
            stdout: c.stdout,
            stdout_truncated: c.stdout_truncated,
            stderr: c.stderr,
            stderr_truncated: c.stderr_truncated,
        }
    }
}

/// 일괄 작업이 옮긴 branch (pull·branch 업데이트). `commits` 0 이면 이미 최신
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefMove {
    pub branch: String,
    pub from: String,
    pub to: String,
    pub commits: u32,
}

impl From<mgit_core::RefMove> for RefMove {
    /// 코어 구조체와 1:1
    fn from(m: mgit_core::RefMove) -> Self {
        RefMove {
            branch: m.branch,
            from: m.from,
            to: m.to,
            commits: m.commits,
        }
    }
}

/// 저장소 하나의 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoResult {
    pub path: String,
    pub name: String,
    pub ok: bool,
    pub skipped: Option<String>,
    pub message: String,
    /// 옮긴 branch (pull·branch 업데이트가 성공했을 때만). TS 선택 필드인 것은 기존 프런트 코드·목이 이 필드 없이
    /// `RepoResult` 를 만들기 때문이다
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub moved: Option<RefMove>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub branch_deletion: Option<BranchDeletionResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub integration: Option<IntegrationOutcome>,
    /// 일괄 push 가 새로 지정한 업스트림 (`<원격>/<branch>`). 업스트림이 없던 branch 를 게시했을 때만
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub upstream_set: Option<String>,
    /// 일괄 작업을 취소해 끝내지 못한 저장소 (시작 전 취소, 또는 실행 중 멈춤)면 true. 건너뜀·실패와 따로 센다
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub cancelled: Option<bool>,
    /// 커밋하지 않은 변경이 있어 건너뛰었으면 true (pull·checkout·branch 업데이트). 결과 알림이 stash 후 다시 실행을 안내한다
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub skipped_dirty: Option<bool>,
    /// 일괄 명령(MR-14)의 종료 코드·소요 시간·출력. 명령을 실행했을 때만
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub command: Option<CommandOutputDto>,
}

/// 일괄 작업 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub label: String,
    pub results: Vec<RepoResult>,
    pub succeeded: u32,
    /// 건너뛴 저장소 (취소된 것은 빼고 `cancelled` 로 센다)
    pub skipped: u32,
    pub failed: u32,
    /// 취소돼 끝내지 못한 저장소 수 (0 이면 빠진다). TS 선택 필드인 것은 기존 프런트 코드·목이 이 필드 없이 만들기 때문이다
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub cancelled: Option<u32>,
}

impl From<mgit_core::BatchResult> for BatchResult {
    /// 코어 → wire
    fn from(b: mgit_core::BatchResult) -> Self {
        BatchResult {
            label: b.label,
            results: b
                .results
                .into_iter()
                .map(|r| RepoResult {
                    path: r.path.display().to_string(),
                    name: r.name,
                    ok: r.ok,
                    skipped: r.skipped,
                    message: r.message,
                    moved: r.moved.map(Into::into),
                    branch_deletion: r.branch_deletion.map(Into::into),
                    integration: r.integration,
                    upstream_set: r.upstream_set,
                    cancelled: r.cancelled.then_some(true),
                    skipped_dirty: r.skipped_dirty.then_some(true),
                    command: r.command.map(Into::into),
                })
                .collect(),
            succeeded: b.succeeded,
            skipped: b.skipped,
            failed: b.failed,
            cancelled: (b.cancelled > 0).then_some(b.cancelled),
        }
    }
}

/// 저장소 하나의 변경
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanges {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub entries: Vec<StatusEntry>,
    pub summary: StatusSummary,
}

/// 폴더 설정 (MR-11)
#[tauri::command]
#[specta::specta]
pub async fn folder_settings(
    state: State<'_, AppState>,
    session: u32,
) -> Result<FolderSettingsDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_settings(SessionId(session))?
        .into())
}

/// 폴더 설정 저장
#[tauri::command]
#[specta::specta]
pub async fn folder_settings_set(
    state: State<'_, AppState>,
    session: u32,
    settings: FolderSettingsDto,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_folder_settings(SessionId(session), &settings.into())?;
    Ok(())
}

/// 일괄 작업 (MR-05·06·07). `repos` 가 비어 있으면 전부
#[tauri::command]
#[specta::specta]
pub async fn folder_batch(
    state: State<'_, AppState>,
    session: u32,
    op: BatchOpDto,
    repos: Vec<String>,
) -> Result<BatchResult, IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    Ok(state
        .core()?
        .core
        .folder_batch(SessionId(session), op.into(), &paths)
        .await?
        .into())
}

/// 폴더 하위 저장소마다 하루 한 번 백업 정리 (#18·#26). 저장소 세션 없이 낮은 동시성으로 돈다
#[tauri::command]
#[specta::specta]
pub async fn folder_prune_backups_daily(
    state: State<'_, AppState>,
    session: u32,
) -> Result<crate::commands_changes::BackupPruneDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_prune_backups_daily(SessionId(session))
        .await?
        .into())
}

/// 일괄 stash 묶음에서 저장소 하나의 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashBatchRepoDto {
    pub path: String,
    pub name: String,
    /// 지금 `stash@{n}` 의 n (꺼낼 때는 묶음 표시로 다시 찾는다)
    pub index: u32,
    /// 저장할 때의 branch (분리 HEAD 면 null)
    pub branch: Option<String>,
    /// 만든 시각 (epoch 초)
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
}

/// 저장소들의 stash 목록에서 모은 일괄 stash 묶음
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashBatchDto {
    pub id: String,
    /// 사용자 메시지 (묶음 표시를 뺀 것, 없으면 빈 문자열)
    pub message: String,
    /// 가장 최근 항목의 시각 (epoch 초)
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    pub repos: Vec<StashBatchRepoDto>,
}

impl From<mgit_core::StashBatch> for StashBatchDto {
    /// 코어 → wire (경로를 문자열로)
    fn from(b: mgit_core::StashBatch) -> Self {
        StashBatchDto {
            id: b.id,
            message: b.message,
            time: b.time,
            repos: b
                .repos
                .into_iter()
                .map(|r| StashBatchRepoDto {
                    path: r.path.display().to_string(),
                    name: r.name,
                    index: r.index,
                    branch: r.branch,
                    time: r.time,
                })
                .collect(),
        }
    }
}

/// 일괄 stash 묶음 목록 (최근 묶음부터). 저장소마다 stash 목록에서 묶음 표시를 모은다. `repos` 가 비어 있으면 전부
#[tauri::command]
#[specta::specta]
pub async fn folder_stash_batches(
    state: State<'_, AppState>,
    session: u32,
    repos: Vec<String>,
) -> Result<Vec<StashBatchDto>, IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    Ok(state
        .core()?
        .core
        .folder_stash_batches(SessionId(session), &paths)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 변경이 있는 저장소의 상태 (MR-08). `repos` 가 비어 있으면 전부, 아니면 그 저장소만 읽는다 (PF-02)
#[tauri::command]
#[specta::specta]
pub async fn folder_changes(
    state: State<'_, AppState>,
    session: u32,
    repos: Vec<String>,
) -> Result<Vec<RepoChanges>, IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    Ok(state
        .core()?
        .core
        .folder_changes(SessionId(session), &paths)
        .await?
        .into_iter()
        .map(|c| RepoChanges {
            path: c.path.display().to_string(),
            name: c.name,
            branch: c.branch,
            entries: c.entries.into_iter().map(Into::into).collect(),
            summary: c.summary.into(),
        })
        .collect())
}

// ───────────── 폴더 stage·unstage (W14) ─────────────

/// 폴더 stage·unstage 의 대상. "이 경로들" 과 "이 저장소의 전부" 는 다른 모양이다 — 빈 경로 목록은 전부가
/// 아니라 아무것도 하지 않는다
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IndexTargetDto {
    /// 작업 트리 기준 상대 경로들 (파일이나 디렉터리 — 디렉터리면 그 아래 전부). 글자 그대로 해석된다
    Paths { paths: Vec<String> },
    /// 이 저장소의 전부
    All,
}

impl From<IndexTargetDto> for IndexTarget {
    /// wire → 코어
    fn from(t: IndexTargetDto) -> Self {
        match t {
            IndexTargetDto::Paths { paths } => IndexTarget::Paths(paths),
            IndexTargetDto::All => IndexTarget::All,
        }
    }
}

/// 건너뛴 이유
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SkipReasonDto {
    /// 충돌 중인 경로 (충돌 편집기에서 해결한다)
    Unmerged,
}

/// 건너뛴 경로 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPathDto {
    pub path: String,
    pub reason: SkipReasonDto,
}

/// 폴더 stage·unstage 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexWriteResultDto {
    /// git 쓰기를 돌렸는지. 거짓(빈 대상·충돌 경로뿐)이면 `folderChanged` 도 오지 않는다
    pub ran: bool,
    /// 대상 안에서 건드리지 않은 경로
    pub skipped: Vec<SkippedPathDto>,
}

impl From<IndexWriteResult> for IndexWriteResultDto {
    /// 코어 → wire
    fn from(r: IndexWriteResult) -> Self {
        IndexWriteResultDto {
            ran: r.ran,
            skipped: r
                .skipped
                .into_iter()
                .map(|s| SkippedPathDto {
                    path: s.path,
                    reason: match s.reason {
                        SkipReason::Unmerged => SkipReasonDto::Unmerged,
                    },
                })
                .collect(),
        }
    }
}

/// 폴더 저장소의 경로들(또는 전부)을 stage 한다 (`git add -A`). 저장소 세션을 만들지 않는다. `repo` 는 이 폴더의
/// 저장소 경로(워크트리면 그 워크트리 자신의 index)이고 목록 밖 경로·작업 트리 밖 경로는 git 전에 거부한다.
/// 충돌 경로는 건드리지 않고 `skipped` 로 알린다
#[tauri::command]
#[specta::specta]
pub async fn folder_stage(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    target: IndexTargetDto,
) -> Result<IndexWriteResultDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_stage(SessionId(session), Path::new(&repo), &target.into())
        .await?
        .into())
}

/// 폴더 저장소의 경로들(또는 전부)을 unstage 한다 (`folder_stage` 와 같은 규칙)
#[tauri::command]
#[specta::specta]
pub async fn folder_unstage(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    target: IndexTargetDto,
) -> Result<IndexWriteResultDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_unstage(SessionId(session), Path::new(&repo), &target.into())
        .await?
        .into())
}

/// 일괄 commit 에서 공통 메시지 대신 쓸 저장소 하나의 메시지. 비었거나 공백뿐이면 공통 메시지를 쓴다
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoCommitMessageDto {
    pub path: String,
    pub message: String,
}

impl From<RepoCommitMessageDto> for mgit_core::RepoCommitMessage {
    /// wire → 코어 (경로 문자열을 경로로)
    fn from(m: RepoCommitMessageDto) -> Self {
        mgit_core::RepoCommitMessage {
            path: PathBuf::from(m.path),
            message: m.message,
        }
    }
}

/// 일괄 commit (MR-08). `repoMessages` 의 저장소는 자기 메시지로, 나머지는 공통 `message` 로 커밋한다. 빠뜨리면
/// (옛 호출) 모두 공통 메시지다
#[tauri::command]
#[specta::specta]
pub async fn folder_commit(
    state: State<'_, AppState>,
    session: u32,
    repos: Vec<String>,
    message: String,
    stage_all: bool,
    repo_messages: Option<Vec<RepoCommitMessageDto>>,
) -> Result<BatchResult, IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    let per_repo: Vec<mgit_core::RepoCommitMessage> = repo_messages
        .unwrap_or_default()
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(state
        .core()?
        .core
        .folder_commit_each(SessionId(session), &paths, &message, &per_repo, stage_all)
        .await?
        .into())
}

// ───────────── 브랜치 목록 (PF-03) ─────────────

/// 브랜치 목록을 읽은 저장소 하나 (워크트리는 원 저장소에 흡수된다)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranchRepoDto {
    pub path: String,
    pub name: String,
    /// 저장소 색 번호 (요약·타임라인과 같은 값)
    pub color: u16,
    /// HEAD: 현재 브랜치, 분리 HEAD(커밋), 또는 커밋 없음. 읽지 못했으면 없다
    pub head: Option<HeadState>,
    /// ref 를 읽지 못한 이유
    pub error: Option<String>,
}

/// 브랜치를 가진 저장소 하나와 그 저장소에서의 상태
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranchInDto {
    pub path: String,
    pub color: u16,
    /// 이 저장소에서 현재 브랜치인지
    pub current: bool,
    /// 업스트림의 짧은 이름 (`origin/main`). 로컬 브랜치에만 있다
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// 업스트림 ref 가 사라졌는지
    pub gone: bool,
}

/// 저장소들을 이름으로 합친 브랜치 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranchDto {
    pub name: String,
    pub remote: bool,
    /// 원격 브랜치면 그 원격의 이름 (`origin`)
    pub remote_name: Option<String>,
    /// 이 브랜치를 가진 저장소 (순번순)
    pub repos: Vec<FolderBranchInDto>,
}

/// 폴더의 브랜치 목록. 부분집합을 요청했으면 그 저장소만 들어 있다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranchesDto {
    /// 읽은 저장소 (순번순). 읽기에 실패한 저장소도 `error` 와 함께 남는다
    pub repos: Vec<FolderBranchRepoDto>,
    /// 이름으로 합친 브랜치 (로컬 먼저, 이름순)
    pub branches: Vec<FolderBranchDto>,
}

impl From<mgit_core::FolderBranches> for FolderBranchesDto {
    /// 코어 → wire (경로는 문자열로, HEAD 의 브랜치는 짧은 이름으로)
    fn from(b: mgit_core::FolderBranches) -> Self {
        FolderBranchesDto {
            repos: b
                .repos
                .into_iter()
                .map(|r| FolderBranchRepoDto {
                    path: r.path.display().to_string(),
                    name: r.name,
                    color: r.color,
                    head: r.head.map(Into::into),
                    error: r.error,
                })
                .collect(),
            branches: b
                .branches
                .into_iter()
                .map(|br| FolderBranchDto {
                    name: br.name,
                    remote: br.remote,
                    remote_name: br.remote_name,
                    repos: br
                        .repos
                        .into_iter()
                        .map(|r| FolderBranchInDto {
                            path: r.path.display().to_string(),
                            color: r.color,
                            current: r.current,
                            upstream: r.upstream,
                            ahead: r.ahead,
                            behind: r.behind,
                            gone: r.gone,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// 폴더의 브랜치 목록 (PF-03). 타임라인을 열지 않아도 답한다 (저장소마다 ref 만 읽는다).
/// `repos` 가 비어 있으면 전부, 아니면 그 저장소(워크트리면 원 저장소)만 읽는다
#[tauri::command]
#[specta::specta]
pub async fn folder_branches(
    state: State<'_, AppState>,
    session: u32,
    repos: Vec<String>,
) -> Result<FolderBranchesDto, IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    Ok(state
        .core()?
        .core
        .folder_branches(SessionId(session), &paths)
        .await?
        .into())
}

// ───────────── 통합 타임라인 (MR-12) ─────────────

/// 타임라인에 든 저장소
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRepoDto {
    pub index: u16,
    pub name: String,
    pub path: String,
    pub color: u16,
    pub head_branch: Option<String>,
    /// 저장소당 상한에 걸려 오래된 커밋이 잘렸는지. 필터가 있으면 걸러진 결과가 상한을 넘었다는 뜻이다
    pub truncated: bool,
    /// 이 저장소의 로드 실패 사유 (나머지 저장소의 타임라인은 그대로 나온다)
    pub error: Option<String>,
    /// 저장소 범위에 들었는지. 범위 밖이면 git 을 돌리지 않아 행이 없고 `headBranch` 가 비지만 번호·색은 그대로다
    pub in_scope: bool,
}

/// 타임라인 정보. 브랜치 목록은 `folder_branches` 가 따로 준다 (PF-03)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineInfoDto {
    pub generation: u32,
    pub rows: u32,
    pub finished: bool,
    pub max_per_repo: u32,
    /// 폴더의 모든 저장소 (범위 밖 포함, 순번순)
    pub repos: Vec<TimelineRepoDto>,
    /// 범위 밖 저장소가 하나라도 있는지 (거짓이면 "전부")
    pub scoped: bool,
}

impl From<mgit_core::TimelineInfo> for TimelineInfoDto {
    /// 코어 → wire (generation 은 u32 로 좁힌다)
    fn from(i: mgit_core::TimelineInfo) -> Self {
        TimelineInfoDto {
            generation: u32::try_from(i.generation).unwrap_or(u32::MAX),
            rows: i.rows,
            finished: i.finished,
            max_per_repo: i.max_per_repo,
            repos: i
                .repos
                .into_iter()
                .map(|r| TimelineRepoDto {
                    index: r.index,
                    name: r.name,
                    path: r.path.display().to_string(),
                    color: r.color,
                    head_branch: r.head_branch,
                    truncated: r.truncated,
                    error: r.error,
                    in_scope: r.in_scope,
                })
                .collect(),
            scoped: i.scoped,
        }
    }
}

/// 타임라인을 연다 (처음이면 로드 시작). 이벤트는 폴더 세션 id 로 `graph*` 가 온다
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_open(
    state: State<'_, AppState>,
    session: u32,
) -> Result<TimelineInfoDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_timeline_open(SessionId(session))?
        .into())
}

/// 타임라인 정보 (저장소 목록, 행 수)
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_info(
    state: State<'_, AppState>,
    session: u32,
) -> Result<TimelineInfoDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_timeline_info(SessionId(session))?
        .into())
}

/// 타임라인 다시 읽기
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_reload(
    state: State<'_, AppState>,
    session: u32,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .folder_timeline_reload(SessionId(session))?;
    Ok(())
}

/// 타임라인 질의 변경 (모든 저장소에 같은 범위·필터, 다시 읽기). 잘못된 정규식이면 질의를 바꾸지 않고
/// `invalidFilter`
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_query_set(
    state: State<'_, AppState>,
    session: u32,
    query: GraphQueryDto,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .folder_timeline_query_set(SessionId(session), query.into())
        .await?;
    Ok(())
}

/// 타임라인 저장소 범위 ("이 저장소들만 보기", 다시 읽기). 빈 목록 = 전부. 범위 밖 저장소는 번호·색을 둔 채
/// 행만 빠진다. 이 폴더의 저장소가 아닌 경로가 있으면 거부(`internal`)하고 범위를 바꾸지 않는다
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_scope_set(
    state: State<'_, AppState>,
    session: u32,
    repos: Vec<String>,
) -> Result<(), IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    state
        .core()?
        .core
        .folder_timeline_scope_set(SessionId(session), &paths)?;
    Ok(())
}

/// 폴더 타임라인의 작성자 후보: 범위에 든 저장소마다 필터 없는 타임라인의 커밋(최신 `maxPerRepo` 개) 작성자
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_authors(
    state: State<'_, AppState>,
    session: u32,
) -> Result<AuthorListDto, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_timeline_authors(SessionId(session))
        .await?
        .into())
}

/// 타임라인 레이아웃 설정 변경 (다시 배치)
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_prefs_set(
    state: State<'_, AppState>,
    session: u32,
    prefs: GraphLayoutPrefsDto,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .folder_timeline_prefs_set(SessionId(session), prefs.into())?;
    Ok(())
}

/// 타임라인 그래프 범위 (`graph_window` 와 같은 모양, 행에 `repo` 가 있다)
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_window(
    state: State<'_, AppState>,
    session: u32,
    start: u32,
    count: u32,
) -> Result<GraphWindow, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_timeline_window(SessionId(session), start, count)?
        .into())
}

/// 타임라인에서 (저장소, 커밋) 의 행 번호
#[tauri::command]
#[specta::specta]
pub async fn folder_timeline_find_row(
    state: State<'_, AppState>,
    session: u32,
    repo: u16,
    oid: String,
) -> Result<Option<u32>, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .folder_timeline_find_row(SessionId(session), repo, &oid)?)
}

// ───────────── 폴더 커밋 상세·diff (CD-05) ─────────────

/// 폴더 저장소의 커밋 상세. 저장소 세션을 만들지 않는다. `repo` 는 이 폴더의 저장소 경로(워크트리면
/// 원 저장소로 읽는다)이고, 목록에 없는 경로는 거부한다. `row`·`children`·`refs` 는 통합 타임라인 기준 —
/// 타임라인에 그 저장소가 없으면 셋 다 비고, 지금 질의에 그 커밋이 없으면 행·자식만 빈다
#[tauri::command]
#[specta::specta]
pub async fn folder_commit_detail(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    oid: String,
) -> Result<CommitDetail, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .folder_commit_detail(SessionId(session), Path::new(&repo), &oid)
        .await?
        .into())
}

/// 폴더 저장소의 커밋을 포함하는 브랜치 (`commit_containing_refs` 와 같은 결과·시간 상한). 저장소 세션을
/// 만들지 않는다. 워크트리 경로는 원 저장소로 읽고(HEAD 도 원 저장소의 것), 목록에 없는 경로는 거부한다
#[tauri::command]
#[specta::specta]
pub async fn folder_commit_containing_refs(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    oid: String,
) -> Result<ContainingRefsDto, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .folder_commit_containing_refs(SessionId(session), Path::new(&repo), &oid)
        .await?
        .into())
}

/// 폴더 저장소의 커밋 하나에서 파일 하나의 diff (`commit_file_diff` 와 같은 결과, `old_path` 도 같다).
/// 변경이 없으면 `None`
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub async fn folder_commit_file_diff(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    oid: String,
    path: String,
    old_path: Option<String>,
    full: bool,
    options: Option<DiffOptionsDto>,
) -> Result<Option<FileDiff>, IpcError> {
    let oid = parse_oid(&oid)?;
    let diff = state
        .core()?
        .core
        .folder_commit_file_diff(
            SessionId(session),
            Path::new(&repo),
            &oid,
            &path,
            old_path.as_deref(),
            full,
            options.map(Into::into).unwrap_or_default(),
        )
        .await?;
    Ok(diff.map(Into::into))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 폴더 커밋 상세·diff 의 oid 는 코어로 넘기기 전에 40자 hex 만 받는다 (잘못된 문자열은 git 을 돌리지 않고 거부)
    #[test]
    fn folder_commit_oid_must_be_full_hex() {
        for bad in ["", "abc", "zz".repeat(20).as_str(), &"a".repeat(41)] {
            assert!(
                matches!(parse_oid(bad), Err(IpcError::Internal { .. })),
                "{bad:?}"
            );
        }
        let hex = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            parse_oid(hex).map(|o| o.to_hex()).ok().as_deref(),
            Some(hex)
        );
    }

    /// 대상의 두 모양은 `kind` 로 갈린다: `{kind:'paths', paths}` 와 `{kind:'all'}`. 빈 `paths` 도 경로 목록이다
    /// (전부로 바뀌지 않는다). `paths` 가 빠진 경로 목록·모르는 `kind` 는 받지 않는다
    #[test]
    fn index_target_wire_shapes() {
        let parse = |v: serde_json::Value| {
            serde_json::from_value::<IndexTargetDto>(v).map(IndexTarget::from)
        };
        assert_eq!(
            parse(serde_json::json!({"kind": "paths", "paths": ["a b.txt", "dir"]})).unwrap(),
            IndexTarget::Paths(vec!["a b.txt".into(), "dir".into()])
        );
        assert_eq!(
            parse(serde_json::json!({"kind": "paths", "paths": []})).unwrap(),
            IndexTarget::Paths(vec![])
        );
        assert_eq!(
            parse(serde_json::json!({"kind": "all"})).unwrap(),
            IndexTarget::All
        );
        assert!(parse(serde_json::json!({"kind": "paths"})).is_err());
        assert!(parse(serde_json::json!({"kind": "everything"})).is_err());
        assert!(parse(serde_json::json!(["a.txt"])).is_err());
    }

    /// 결과는 `{ran, skipped: [{path, reason: 'unmerged'}]}` 로 나간다
    #[test]
    fn index_write_result_wire_shape() {
        let dto = IndexWriteResultDto::from(IndexWriteResult {
            ran: true,
            skipped: vec![mgit_core::SkippedPath {
                path: "dir/c.txt".into(),
                reason: SkipReason::Unmerged,
            }],
        });
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            serde_json::json!({
                "ran": true,
                "skipped": [{"path": "dir/c.txt", "reason": "unmerged"}]
            })
        );
    }
}

/// 전체 원문과 확정된 비교 기준을 함께 조회한다.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn folder_commit_file_diff_document(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    oid: String,
    path: String,
    old_path: Option<String>,
    full: bool,
    options: Option<DiffOptionsDto>,
) -> Result<crate::dto_diff::DiffDocument, IpcError> {
    let oid = parse_oid(&oid)?;
    let diff = state
        .core()?
        .core
        .folder_commit_file_diff_document(
            SessionId(session),
            Path::new(&repo),
            &oid,
            &path,
            old_path.as_deref(),
            full,
            options.map(Into::into).unwrap_or_default(),
        )
        .await?;
    Ok(diff.into())
}

/// 쓰기 전 현재 브랜치와 대상 커밋 및 실행 불가 사유를 읽는다.
#[tauri::command]
#[specta::specta]
pub async fn folder_integration_preview(
    state: State<'_, AppState>,
    session: u32,
    reference: String,
    repos: Vec<String>,
) -> Result<Vec<IntegrationPreview>, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_integration_preview(
            SessionId(session),
            &reference,
            &repos.into_iter().map(PathBuf::from).collect::<Vec<_>>(),
        )
        .await?)
}
