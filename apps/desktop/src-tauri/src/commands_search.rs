//! 취소 가능한 워크스페이스 검색 IPC.
use crate::{error::IpcError, state::AppState};
use mgit_core::{SessionId, WorkspaceSearchQuery, WorkspaceSearchResult};
use mgit_model::CancelToken;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::State;
static REQUESTS: OnceLock<Mutex<HashMap<(u32, String), CancelToken>>> = OnceLock::new();
/// 요청 식별자로 진행 중 검색을 취소한다.
#[tauri::command]
#[specta::specta]
pub fn workspace_search_cancel(session: u32, request: String) {
    if let Some(token) = REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(session, request))
    {
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
    let token = CancelToken::new();
    let key = (session, request);
    if let Some(old) = REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(key.clone(), token.clone())
    {
        old.cancel();
    }
    let result = core
        .core
        .workspace_search(SessionId(session), query, token)
        .await;
    REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&key);
    Ok(result?)
}
