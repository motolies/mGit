//! 통합 터미널 커맨드 (Phase 2 D3, UX-08)

use tauri::State;
use tauri::ipc::Channel;

use crate::error::IpcError;
use crate::pty::{PtyEvent, PtyState};
use crate::state::AppState;

/// 터미널 열기. 돌려준 id 로 입력·크기·닫기
#[tauri::command]
#[specta::specta]
pub async fn pty_open(
    state: State<'_, AppState>,
    ptys: State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, IpcError> {
    let login = state.login_path();
    ptys.open(&cwd, cols, rows, login.as_deref(), on_event)
}

/// 입력
#[tauri::command]
#[specta::specta]
pub async fn pty_write(ptys: State<'_, PtyState>, id: u32, data: String) -> Result<(), IpcError> {
    ptys.write(id, &data)
}

/// 크기 변경
#[tauri::command]
#[specta::specta]
pub async fn pty_resize(
    ptys: State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    ptys.resize(id, cols, rows)
}

/// 닫기
#[tauri::command]
#[specta::specta]
pub async fn pty_close(ptys: State<'_, PtyState>, id: u32) -> Result<(), IpcError> {
    ptys.close(id);
    Ok(())
}
