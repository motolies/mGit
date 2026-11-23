//! 원격·동기화·스태시·워크트리 커맨드 (S4)

use std::path::Path;

use mgit_core::{Oid, PullMode, PushSpec, SessionId, WorktreeSource};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_refs::ChangedFile;
use crate::dto::StashInfo;
use crate::error::IpcError;
use crate::state::AppState;

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 원격 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
}

impl From<mgit_core::RemoteInfo> for RemoteInfo {
    /// 코어 구조체와 1:1
    fn from(r: mgit_core::RemoteInfo) -> Self {
        Self {
            name: r.name,
            fetch_url: r.fetch_url,
            push_url: r.push_url,
        }
    }
}

/// pull 방식
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PullModeDto {
    Default,
    Merge,
    Rebase,
    FfOnly,
}

impl From<PullModeDto> for PullMode {
    /// wire → 코어
    fn from(m: PullModeDto) -> Self {
        match m {
            PullModeDto::Default => PullMode::Default,
            PullModeDto::Merge => PullMode::Merge,
            PullModeDto::Rebase => PullMode::Rebase,
            PullModeDto::FfOnly => PullMode::FfOnly,
        }
    }
}

/// push 옵션
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PushSpecDto {
    pub remote: Option<String>,
    pub set_upstream: bool,
    pub tags: bool,
    pub force_with_lease: bool,
    /// 이름이 다른 업스트림으로 보내도 좋다고 사용자가 확인했다 (`pushUpstreamMismatch` 뒤 재시도)
    pub confirm_upstream_mismatch: bool,
    /// 확인을 이 브랜치·업스트림 조합에 기억한다
    pub remember_upstream_mismatch: bool,
}

/// 스태시 + 출처 워크트리
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub info: StashInfo,
    /// mGit 이 만든 스태시면 그 워크트리 경로
    pub origin: Option<String>,
}

/// 워크트리 생성 방식
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorktreeSourceDto {
    NewBranch { name: String, start: Option<String> },
    Branch { name: String },
    Detached { oid: String },
}

/// 워크트리 삭제 전 검사
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveCheck {
    pub path: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub unpushed: Option<u32>,
    pub is_main: bool,
}

/// 원격 추가
#[tauri::command]
#[specta::specta]
pub async fn remote_add(
    state: State<'_, AppState>,
    session: u32,
    name: String,
    url: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .remote_add(SessionId(session), &name, &url)
        .await?;
    Ok(())
}

/// 원격 이름 변경
#[tauri::command]
#[specta::specta]
pub async fn remote_rename(
    state: State<'_, AppState>,
    session: u32,
    old_name: String,
    new_name: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .remote_rename(SessionId(session), &old_name, &new_name)
        .await?;
    Ok(())
}

/// 원격 제거
#[tauri::command]
#[specta::specta]
pub async fn remote_remove(
    state: State<'_, AppState>,
    session: u32,
    name: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .remote_remove(SessionId(session), &name)
        .await?;
    Ok(())
}

/// 원격 URL 변경
#[tauri::command]
#[specta::specta]
pub async fn remote_set_url(
    state: State<'_, AppState>,
    session: u32,
    name: String,
    url: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .remote_set_url(SessionId(session), &name, &url)
        .await?;
    Ok(())
}

/// fetch (RM-02). 진행률·출력은 operation 이벤트로 온다
#[tauri::command]
#[specta::specta]
pub async fn fetch(
    state: State<'_, AppState>,
    session: u32,
    remote: Option<String>,
    prune: bool,
) -> Result<(), IpcError> {
    let core = &state.core()?.core;
    let label = remote.clone().unwrap_or_else(|| "--all".into());
    let op = core.begin_operation(SessionId(session), "fetch", &format!("fetch {label}"))?;
    core.fetch(SessionId(session), remote.as_deref(), prune, Some(op))
        .await?;
    Ok(())
}

/// pull (RM-03)
#[tauri::command]
#[specta::specta]
pub async fn pull(
    state: State<'_, AppState>,
    session: u32,
    mode: PullModeDto,
) -> Result<(), IpcError> {
    let core = &state.core()?.core;
    let op = core.begin_operation(SessionId(session), "pull", "pull")?;
    core.pull(SessionId(session), mode.into(), Some(op)).await?;
    Ok(())
}

/// push (RM-04)
#[tauri::command]
#[specta::specta]
pub async fn push(
    state: State<'_, AppState>,
    session: u32,
    spec: PushSpecDto,
) -> Result<(), IpcError> {
    let core = &state.core()?.core;
    let op = core.begin_operation(SessionId(session), "push", "push")?;
    core.push(
        SessionId(session),
        PushSpec {
            remote: spec.remote,
            set_upstream: spec.set_upstream,
            tags: spec.tags,
            force_with_lease: spec.force_with_lease,
            confirm_upstream_mismatch: spec.confirm_upstream_mismatch,
            remember_upstream_mismatch: spec.remember_upstream_mismatch,
        },
        Some(op),
    )
    .await?;
    Ok(())
}

/// 스태시 목록 (출처 워크트리 포함)
#[tauri::command]
#[specta::specta]
pub async fn list_stashes(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<StashEntry>, IpcError> {
    let list = state.core()?.core.stashes(SessionId(session))?;
    Ok(list
        .into_iter()
        .map(|(info, origin)| StashEntry {
            info: info.into(),
            origin,
        })
        .collect())
}

/// 스태시 저장 (ST-01). `paths` 가 비어 있지 않으면 그 경로만
#[tauri::command]
#[specta::specta]
pub async fn stash_push(
    state: State<'_, AppState>,
    session: u32,
    message: Option<String>,
    include_untracked: bool,
    staged_only: bool,
    paths: Vec<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .stash_push(
            SessionId(session),
            message.as_deref(),
            include_untracked,
            staged_only,
            &paths,
        )
        .await?;
    Ok(())
}

/// 스태시 적용
#[tauri::command]
#[specta::specta]
pub async fn stash_apply(
    state: State<'_, AppState>,
    session: u32,
    index: u32,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .stash_apply(SessionId(session), index)
        .await?;
    Ok(())
}

/// 스태시 꺼내기
#[tauri::command]
#[specta::specta]
pub async fn stash_pop(
    state: State<'_, AppState>,
    session: u32,
    index: u32,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .stash_pop(SessionId(session), index)
        .await?;
    Ok(())
}

/// 스태시 삭제
#[tauri::command]
#[specta::specta]
pub async fn stash_drop(
    state: State<'_, AppState>,
    session: u32,
    index: u32,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .stash_drop(SessionId(session), index)
        .await?;
    Ok(())
}

/// 스태시가 바꾼 파일 (ST-04)
#[tauri::command]
#[specta::specta]
pub async fn stash_files(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<Vec<ChangedFile>, IpcError> {
    let oid = parse_oid(&oid)?;
    let files = state
        .core()?
        .core
        .stash_files(SessionId(session), &oid)
        .await?;
    Ok(files.into_iter().map(Into::into).collect())
}

/// 워크트리 기본 경로 제안 (WT-02)
#[tauri::command]
#[specta::specta]
pub async fn suggest_worktree_path(
    state: State<'_, AppState>,
    session: u32,
    branch: String,
) -> Result<String, IpcError> {
    Ok(state
        .core()?
        .core
        .suggest_worktree_path(SessionId(session), &branch)?
        .display()
        .to_string())
}

/// 워크트리 생성. 만든 경로를 돌려준다
#[tauri::command]
#[specta::specta]
pub async fn worktree_add(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    source: WorktreeSourceDto,
) -> Result<String, IpcError> {
    let source = match source {
        WorktreeSourceDto::NewBranch { name, start } => WorktreeSource::NewBranch { name, start },
        WorktreeSourceDto::Branch { name } => WorktreeSource::Branch(name),
        WorktreeSourceDto::Detached { oid } => WorktreeSource::Detached(parse_oid(&oid)?),
    };
    let created = state
        .core()?
        .core
        .worktree_add(SessionId(session), Path::new(&path), source)
        .await?;
    Ok(created.display().to_string())
}

/// 워크트리 삭제 전 검사 (WT-04)
#[tauri::command]
#[specta::specta]
pub async fn worktree_remove_check(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<WorktreeRemoveCheck, IpcError> {
    let c = state
        .core()?
        .core
        .worktree_remove_check(SessionId(session), Path::new(&path))
        .await?;
    Ok(WorktreeRemoveCheck {
        path: c.path.display().to_string(),
        branch: c.branch,
        dirty: c.dirty,
        unpushed: c.unpushed,
        is_main: c.is_main,
    })
}

/// 워크트리 삭제
#[tauri::command]
#[specta::specta]
pub async fn worktree_remove(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .worktree_remove(SessionId(session), Path::new(&path), force, delete_branch)
        .await?;
    Ok(())
}

/// 사라진 워크트리 정리
#[tauri::command]
#[specta::specta]
pub async fn worktree_prune(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .worktree_prune(SessionId(session))
        .await?;
    Ok(())
}
