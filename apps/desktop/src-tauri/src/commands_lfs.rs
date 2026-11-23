//! Git LFS 커맨드 (Phase 2 D3, AD-01)

use mgit_core::{LfsFile, LfsLock, LfsStatus, SessionId};
use serde::Serialize;
use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// LFS 파일
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsFileDto {
    pub oid: String,
    pub path: String,
    pub full: bool,
}

/// LFS 잠금
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsLockDto {
    pub id: String,
    pub path: String,
    pub owner: String,
    pub locked_at: String,
}

/// LFS 상태
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatusDto {
    pub installed: bool,
    pub version: Option<String>,
    pub configured: bool,
    pub patterns: Vec<String>,
    pub files: Vec<LfsFileDto>,
    pub locks: Vec<LfsLockDto>,
    pub locks_error: Option<String>,
}

impl From<LfsStatus> for LfsStatusDto {
    /// 코어 → wire
    fn from(s: LfsStatus) -> Self {
        LfsStatusDto {
            installed: s.installed,
            version: s.version,
            configured: s.configured,
            patterns: s.patterns,
            files: s
                .files
                .into_iter()
                .map(|f: LfsFile| LfsFileDto {
                    oid: f.oid,
                    path: f.path,
                    full: f.full,
                })
                .collect(),
            locks: s
                .locks
                .into_iter()
                .map(|l: LfsLock| LfsLockDto {
                    id: l.id,
                    path: l.path,
                    owner: l.owner,
                    locked_at: l.locked_at,
                })
                .collect(),
            locks_error: s.locks_error,
        }
    }
}

/// LFS 상태
#[tauri::command]
#[specta::specta]
pub async fn lfs_status(
    state: State<'_, AppState>,
    session: u32,
) -> Result<LfsStatusDto, IpcError> {
    Ok(state
        .core()?
        .core
        .lfs_status(SessionId(session))
        .await?
        .into())
}

/// `git lfs install --local`
#[tauri::command]
#[specta::specta]
pub async fn lfs_install(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.lfs_install(SessionId(session)).await?;
    Ok(())
}

/// 패턴 추적
#[tauri::command]
#[specta::specta]
pub async fn lfs_track(
    state: State<'_, AppState>,
    session: u32,
    pattern: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .lfs_track(SessionId(session), &pattern)
        .await?;
    Ok(())
}

/// 추적 해제
#[tauri::command]
#[specta::specta]
pub async fn lfs_untrack(
    state: State<'_, AppState>,
    session: u32,
    pattern: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .lfs_untrack(SessionId(session), &pattern)
        .await?;
    Ok(())
}

/// 잠금
#[tauri::command]
#[specta::specta]
pub async fn lfs_lock(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .lfs_lock(SessionId(session), &path)
        .await?;
    Ok(())
}

/// 잠금 해제
#[tauri::command]
#[specta::specta]
pub async fn lfs_unlock(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    force: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .lfs_unlock(SessionId(session), &path, force)
        .await?;
    Ok(())
}
