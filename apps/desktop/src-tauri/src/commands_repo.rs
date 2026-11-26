//! 저장소 관리·멀티 저장소 폴더·서브모듈 커맨드 (S5)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_core::{CloneSpec, EventSink, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::app_events::AppEvent;
use crate::dto::{RepoOpened, RepoSessionRelease};
use crate::error::IpcError;
use crate::events::{ChannelSink, SessionEvent};
use crate::state::AppState;

/// 저장소 종류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RepoKind {
    Standalone,
    Worktree,
    Submodule,
}

impl From<mgit_core::RepoKind> for RepoKind {
    /// 코어 enum 과 1:1
    fn from(k: mgit_core::RepoKind) -> Self {
        match k {
            mgit_core::RepoKind::Standalone => RepoKind::Standalone,
            mgit_core::RepoKind::Worktree => RepoKind::Worktree,
            mgit_core::RepoKind::Submodule => RepoKind::Submodule,
        }
    }
}

/// 진행 중 작업 종류 (대시보드 표시용)
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
    Am,
}

impl From<mgit_core::OpKind> for OpKind {
    /// 코어 enum 과 1:1
    fn from(k: mgit_core::OpKind) -> Self {
        match k {
            mgit_core::OpKind::Merge => OpKind::Merge,
            mgit_core::OpKind::Rebase => OpKind::Rebase,
            mgit_core::OpKind::CherryPick => OpKind::CherryPick,
            mgit_core::OpKind::Revert => OpKind::Revert,
            mgit_core::OpKind::Bisect => OpKind::Bisect,
            mgit_core::OpKind::Am => OpKind::Am,
        }
    }
}

/// 스캔으로 찾은 저장소
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    pub path: String,
    pub kind: RepoKind,
}

impl From<mgit_core::FoundRepo> for FoundRepo {
    /// 경로를 문자열로
    fn from(r: mgit_core::FoundRepo) -> Self {
        Self {
            path: r.path.display().to_string(),
            kind: r.kind.into(),
        }
    }
}

/// 폴더 세션 열기 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderOpened {
    pub session: u32,
    pub path: String,
    pub repos: Vec<FoundRepo>,
}

/// 대시보드 한 줄
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub name: String,
    pub kind: RepoKind,
    /// 저장소 색 번호 (`--graph-lane-N`). 브랜치 목록·타임라인과 같은 값이다 (LF-09)
    pub color: u16,
    pub branch: Option<String>,
    pub detached: bool,
    pub changed: u32,
    pub conflicted: u32,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub op: Option<OpKind>,
    #[specta(type = f64)]
    pub last_fetch: Option<i64>,
    pub error: Option<String>,
}

impl From<mgit_core::RepoSummary> for RepoSummary {
    /// 경로를 문자열로
    fn from(s: mgit_core::RepoSummary) -> Self {
        Self {
            path: s.path.display().to_string(),
            name: s.name,
            kind: s.kind.into(),
            color: s.color,
            branch: s.branch,
            detached: s.detached,
            changed: s.changed,
            conflicted: s.conflicted,
            ahead: s.ahead,
            behind: s.behind,
            op: s.op.map(Into::into),
            last_fetch: s.last_fetch,
            error: s.error,
        }
    }
}

/// 최근 항목 종류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RecentKind {
    Repo,
    Folder,
}

/// 최근 저장소·폴더
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub kind: RecentKind,
    pub name: String,
    pub pinned: bool,
    #[specta(type = f64)]
    pub last_opened_at: i64,
}

impl From<mgit_core::RecentEntry> for RecentEntry {
    /// 경로를 문자열로
    fn from(e: mgit_core::RecentEntry) -> Self {
        Self {
            path: e.path.display().to_string(),
            kind: match e.kind {
                mgit_core::RecentKind::Repo => RecentKind::Repo,
                mgit_core::RecentKind::Folder => RecentKind::Folder,
            },
            name: e.name,
            pinned: e.pinned,
            last_opened_at: e.last_opened_at,
        }
    }
}

/// `.gitignore` 템플릿
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreTemplate {
    pub id: String,
    pub label: String,
}

/// clone 요청
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    pub url: String,
    pub dest: String,
    pub branch: Option<String>,
    pub recurse_submodules: bool,
    /// 경량 복제 (REPO-03)
    pub depth: Option<u32>,
    pub blobless: bool,
    pub single_branch: bool,
}

/// 서브모듈 상태
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleStatus {
    NotInitialized,
    Clean,
    Mismatch,
    Dirty,
    Conflict,
}

/// 서브모듈 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub path: String,
    pub oid: String,
    pub status: SubmoduleStatus,
    pub describe: Option<String>,
}

impl From<mgit_core::SubmoduleInfo> for SubmoduleInfo {
    /// Oid 를 hex 로
    fn from(s: mgit_core::SubmoduleInfo) -> Self {
        Self {
            path: s.path,
            oid: s.oid.to_hex(),
            status: match s.status {
                mgit_core::SubmoduleStatus::NotInitialized => SubmoduleStatus::NotInitialized,
                mgit_core::SubmoduleStatus::Clean => SubmoduleStatus::Clean,
                mgit_core::SubmoduleStatus::Mismatch => SubmoduleStatus::Mismatch,
                mgit_core::SubmoduleStatus::Dirty => SubmoduleStatus::Dirty,
                mgit_core::SubmoduleStatus::Conflict => SubmoduleStatus::Conflict,
            },
            describe: s.describe,
        }
    }
}

/// 멀티 저장소 폴더를 연다 (MR-01). 이벤트는 `FolderChanged` 만 온다
#[tauri::command]
#[specta::specta]
pub async fn open_folder(
    state: State<'_, AppState>,
    path: String,
    on_event: Channel<SessionEvent>,
) -> Result<FolderOpened, IpcError> {
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink(on_event));
    let opened = state
        .core()?
        .core
        .open_folder(Path::new(&path), sink)
        .await?;
    Ok(FolderOpened {
        session: opened.session.0,
        path: opened.path.display().to_string(),
        repos: opened.repos.into_iter().map(Into::into).collect(),
    })
}

/// 대시보드 요약 (MR-02). `repos` 가 비어 있으면 전부, 아니면 그 저장소만 읽는다 (PF-02)
#[tauri::command]
#[specta::specta]
pub async fn folder_summaries(
    state: State<'_, AppState>,
    session: u32,
    repos: Vec<String>,
) -> Result<Vec<RepoSummary>, IpcError> {
    let paths: Vec<PathBuf> = repos.into_iter().map(PathBuf::from).collect();
    let list = state
        .core()?
        .core
        .folder_summaries(SessionId(session), &paths)
        .await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 하위 저장소 재스캔
#[tauri::command]
#[specta::specta]
pub async fn folder_rescan(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<FoundRepo>, IpcError> {
    let list = state.core()?.core.folder_rescan(SessionId(session)).await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 폴더 세션 닫기. 그 폴더만 잡고 있던 가벼운 세션도 함께 닫힌다 (승격된 탭의 세션은 남는다)
#[tauri::command]
#[specta::specta]
pub async fn close_folder(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.close_folder(SessionId(session))?;
    Ok(())
}

/// 폴더 저장소의 가벼운 세션을 연다 (계획 5.1절). 응답 모양은 `open_repo` 와 같고 `profile` 이 `light`
/// (그 작업 트리가 이미 탭으로 열려 있으면 그 탭의 `full` 세션). 세션 이벤트는 `on_event` 로 온다 —
/// 이미 있던 세션이면(`alreadyOpen`) 처음 연 쪽의 채널이 그대로라 이 채널로는 오지 않는다.
/// 상한이면 `lightSessionLimit`, 폴더의 저장소가 아닌 경로는 git 을 돌리기 전에 거부한다
#[tauri::command]
#[specta::specta]
pub async fn folder_open_repo_session(
    state: State<'_, AppState>,
    session: u32,
    repo: String,
    on_event: Channel<SessionEvent>,
) -> Result<RepoOpened, IpcError> {
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink(on_event));
    let opened = state
        .core()?
        .core
        .folder_open_repo_session(SessionId(session), Path::new(&repo), sink)
        .await?;
    Ok(opened.into())
}

/// 폴더가 가벼운 세션의 잡음을 푼다. 마지막 잡음이면 그 세션을 닫는다. 이미 닫힘·안 잡음·승격된 세션은
/// 아무것도 하지 않고 같은 모양으로 답한다 (오류 아님)
#[tauri::command]
#[specta::specta]
pub async fn folder_release_repo_session(
    state: State<'_, AppState>,
    session: u32,
    repo_session: u32,
) -> Result<RepoSessionRelease, IpcError> {
    Ok(state
        .core()?
        .core
        .folder_release_repo_session(SessionId(session), SessionId(repo_session))
        .into())
}

/// 폴더를 스캔해 최근 목록에 넣는다 (REPO-06)
#[tauri::command]
#[specta::specta]
pub async fn scan_repos(
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<FoundRepo>, IpcError> {
    let list = state.core()?.core.scan_and_register(Path::new(&root))?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// clone (REPO-02). 진행률은 세션 0 의 operation 이벤트로 온다
#[tauri::command]
#[specta::specta]
pub async fn clone_repo(
    state: State<'_, AppState>,
    request: CloneRequest,
    on_event: Channel<SessionEvent>,
) -> Result<String, IpcError> {
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink(on_event));
    let dest = state
        .core()?
        .core
        .clone_repo(
            CloneSpec {
                url: request.url,
                dest: PathBuf::from(request.dest),
                branch: request.branch,
                recurse_submodules: request.recurse_submodules,
                depth: request.depth,
                blobless: request.blobless,
                single_branch: request.single_branch,
            },
            sink,
        )
        .await?;
    Ok(dest.display().to_string())
}

/// 새 저장소 초기화 (REPO-04)
#[tauri::command]
#[specta::specta]
pub async fn init_repo(
    state: State<'_, AppState>,
    path: String,
    default_branch: String,
    template: Option<String>,
) -> Result<String, IpcError> {
    let created = state
        .core()?
        .core
        .init_repo(Path::new(&path), &default_branch, template.as_deref())
        .await?;
    Ok(created.display().to_string())
}

/// `.gitignore` 템플릿 목록
#[tauri::command]
#[specta::specta]
pub async fn gitignore_templates() -> Result<Vec<GitignoreTemplate>, IpcError> {
    Ok(mgit_core::gitignore_templates()
        .into_iter()
        .map(|t| GitignoreTemplate {
            id: t.id,
            label: t.label,
        })
        .collect())
}

/// 최근 저장소·폴더 (REPO-05)
#[tauri::command]
#[specta::specta]
pub async fn recent_list(state: State<'_, AppState>) -> Result<Vec<RecentEntry>, IpcError> {
    let list = state.core()?.core.recent_list()?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 최근 항목 고정
#[tauri::command]
#[specta::specta]
pub async fn recent_pin(
    state: State<'_, AppState>,
    path: String,
    pinned: bool,
) -> Result<(), IpcError> {
    state.core()?.core.recent_pin(Path::new(&path), pinned)?;
    Ok(())
}

/// 최근 항목 제거
#[tauri::command]
#[specta::specta]
pub async fn recent_remove(state: State<'_, AppState>, path: String) -> Result<(), IpcError> {
    state.core()?.core.recent_remove(Path::new(&path))?;
    Ok(())
}

/// 마지막으로 열려 있던 탭
#[tauri::command]
#[specta::specta]
pub async fn open_tabs_get(state: State<'_, AppState>) -> Result<Vec<String>, IpcError> {
    let list = state.core()?.core.open_tabs_get()?;
    Ok(list.into_iter().map(|p| p.display().to_string()).collect())
}

/// 열린 탭 저장
#[tauri::command]
#[specta::specta]
pub async fn open_tabs_set(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), IpcError> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    state.core()?.core.open_tabs_set(&paths)?;
    Ok(())
}

/// 서브모듈 목록 (SUB-01)
#[tauri::command]
#[specta::specta]
pub async fn submodules(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<SubmoduleInfo>, IpcError> {
    let list = state.core()?.core.submodules(SessionId(session)).await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 서브모듈 초기화·업데이트 (SUB-02)
#[tauri::command]
#[specta::specta]
pub async fn submodule_update(
    state: State<'_, AppState>,
    session: u32,
    recursive: bool,
) -> Result<(), IpcError> {
    let core = &state.core()?.core;
    let op = core.begin_operation(SessionId(session), "submodule", "submodule update")?;
    core.submodule_update(SessionId(session), recursive, Some(op))
        .await?;
    Ok(())
}

/// 시작 인자로 받은 경로 (한 번만 돌려준다)
#[tauri::command]
#[specta::specta]
pub async fn take_startup_paths(state: State<'_, AppState>) -> Result<Vec<String>, IpcError> {
    Ok(state.take_startup_paths())
}

/// 세션과 무관한 앱 이벤트 구독 (두 번째 실행의 열기 요청 등). 구독 전 발생분은 즉시 전달된다
#[tauri::command]
#[specta::specta]
pub async fn subscribe_app_events(
    state: State<'_, AppState>,
    on_event: Channel<AppEvent>,
) -> Result<(), IpcError> {
    state.app_events.subscribe(on_event);
    Ok(())
}
