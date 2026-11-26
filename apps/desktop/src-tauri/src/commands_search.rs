//! 취소 가능한 워크스페이스 검색 IPC.
use crate::{error::IpcError, state::AppState};
use mgit_core::{
    ReplaceOutcome, ReplacePlan, ReplacePreview, ReplaceQuery, ReplaceUndo, ReplaceUndoOutcome,
    SessionId, WorkspaceFileList, WorkspaceSearchQuery, WorkspaceSearchResult,
};
use mgit_model::CancelToken;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::State;
static REQUESTS: OnceLock<Mutex<HashMap<(u32, String), CancelToken>>> = OnceLock::new();

/// 진행 중 요청 표. 잠금이 독으로 남아도 취소 기록은 계속 쓴다.
fn requests() -> MutexGuard<'static, HashMap<(u32, String), CancelToken>> {
    REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 요청 식별자에 새 취소 토큰을 건다. 같은 식별자의 이전 요청은 취소한다.
fn register(key: &(u32, String)) -> CancelToken {
    let token = CancelToken::new();
    if let Some(old) = requests().insert(key.clone(), token.clone()) {
        old.cancel();
    }
    token
}

/// 요청 식별자로 진행 중 검색·파일 목록 읽기를 취소한다.
#[tauri::command]
#[specta::specta]
pub fn workspace_search_cancel(session: u32, request: String) {
    if let Some(token) = requests().remove(&(session, request)) {
        token.cancel();
    }
}
/// 코어 검색 종료 후 토큰을 정리한다.
#[tauri::command]
#[specta::specta]
pub async fn workspace_search(
    state: State<'_, AppState>,
    session: u32,
    request: String,
    query: WorkspaceSearchQuery,
) -> Result<WorkspaceSearchResult, IpcError> {
    let core = state.core()?;
    let key = (session, request);
    let token = register(&key);
    let result = core
        .core
        .workspace_search(SessionId(session), query, token)
        .await;
    requests().remove(&key);
    Ok(result?)
}
/// 빠른 열기용 파일 목록을 읽는다. 취소는 검색과 같은 `workspace_search_cancel` 로 한다.
#[tauri::command]
#[specta::specta]
pub async fn workspace_files(
    state: State<'_, AppState>,
    session: u32,
    request: String,
) -> Result<WorkspaceFileList, IpcError> {
    let core = state.core()?;
    let key = (session, request);
    let token = register(&key);
    let result = core.core.workspace_files(SessionId(session), token).await;
    requests().remove(&key);
    Ok(result?)
}
/// 여러 파일 바꾸기 미리보기. 취소는 검색과 같은 `workspace_search_cancel` 로 한다.
#[tauri::command]
#[specta::specta]
pub async fn workspace_replace_preview(
    state: State<'_, AppState>,
    session: u32,
    request: String,
    query: ReplaceQuery,
) -> Result<ReplacePreview, IpcError> {
    let core = state.core()?;
    let key = (session, request);
    let token = register(&key);
    let result = core
        .core
        .workspace_replace_preview(SessionId(session), query, token)
        .await;
    requests().remove(&key);
    Ok(result?)
}
/// 미리보기에서 고른 파일을 바꾼다. 파일마다 결과(바꿈·건너뜀·실패)를 돌려준다.
#[tauri::command]
#[specta::specta]
pub async fn workspace_replace_apply(
    state: State<'_, AppState>,
    session: u32,
    plan: ReplacePlan,
) -> Result<Vec<ReplaceOutcome>, IpcError> {
    Ok(state
        .core()?
        .core
        .workspace_replace_apply(SessionId(session), plan)
        .await?)
}
/// 바꾼 파일을 폐기 백업 사본으로 되돌린다. 바꾼 뒤 또 바뀐 파일은 건너뛴다.
#[tauri::command]
#[specta::specta]
pub async fn workspace_replace_undo(
    state: State<'_, AppState>,
    session: u32,
    items: Vec<ReplaceUndo>,
) -> Result<Vec<ReplaceUndoOutcome>, IpcError> {
    Ok(state
        .core()?
        .core
        .workspace_replace_undo(SessionId(session), items)
        .await?)
}
