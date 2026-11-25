//! 변경 사항·스테이징·커밋 커맨드 (S2)

use mgit_core::{Oid, SessionId};
use tauri::State;

use crate::commands_history::DiffOptionsDto;
use crate::dto_diff::{BackupRecord, CommitSpec, FileDiff, LineSelection, MarkerHit};
use crate::error::IpcError;
use crate::state::AppState;

/// 경로들을 stage 한다
#[tauri::command]
#[specta::specta]
pub async fn stage_paths(
    state: State<'_, AppState>,
    session: u32,
    paths: Vec<String>,
) -> Result<(), IpcError> {
    state.core()?.core.stage(SessionId(session), &paths).await?;
    Ok(())
}

/// 경로들을 unstage 한다
#[tauri::command]
#[specta::specta]
pub async fn unstage_paths(
    state: State<'_, AppState>,
    session: u32,
    paths: Vec<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .unstage(SessionId(session), &paths)
        .await?;
    Ok(())
}

/// 전부 stage
#[tauri::command]
#[specta::specta]
pub async fn stage_all(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.stage_all(SessionId(session)).await?;
    Ok(())
}

/// 전부 unstage
#[tauri::command]
#[specta::specta]
pub async fn unstage_all(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.unstage_all(SessionId(session)).await?;
    Ok(())
}

/// 작업 트리 diff. 변경이 없으면 `None`
#[tauri::command]
#[specta::specta]
pub async fn work_tree_diff(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    staged: bool,
    full: bool,
    options: Option<DiffOptionsDto>,
) -> Result<Option<FileDiff>, IpcError> {
    let diff = state
        .core()?
        .core
        .work_tree_diff_opts(
            SessionId(session),
            &path,
            staged,
            full,
            options.map(Into::into).unwrap_or_default(),
        )
        .await?;
    Ok(diff.map(Into::into))
}

/// 커밋 하나에서 파일 하나의 diff. 머지 커밋은 첫 부모 기준. `old_path` 는 이름이 바뀐 파일의 옛 경로
/// (상세의 `oldPath`)로, 주면 rename 으로 짝지어 실제 변경분만 나온다
#[tauri::command]
#[specta::specta]
pub async fn commit_file_diff(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
    path: String,
    old_path: Option<String>,
    full: bool,
    options: Option<DiffOptionsDto>,
) -> Result<Option<FileDiff>, IpcError> {
    let oid = Oid::from_hex(oid.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })?;
    let diff = state
        .core()?
        .core
        .commit_file_diff_opts(
            SessionId(session),
            &oid,
            &path,
            old_path.as_deref(),
            full,
            options.map(Into::into).unwrap_or_default(),
        )
        .await?;
    Ok(diff.map(Into::into))
}

/// 고른 hunk·줄만 stage(`unstage=false`) 또는 unstage. `options` 는 화면의 diff 와 같아야 한다
#[tauri::command]
#[specta::specta]
pub async fn stage_lines(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    selection: Vec<LineSelection>,
    unstage: bool,
    options: Option<DiffOptionsDto>,
    expected_revision: Option<String>,
) -> Result<(), IpcError> {
    let selection: Vec<mgit_core::LineSelection> = selection.into_iter().map(Into::into).collect();
    state
        .core()?
        .core
        .stage_lines_checked(
            SessionId(session),
            &path,
            &selection,
            unstage,
            options.map(Into::into).unwrap_or_default(),
            expected_revision.as_deref(),
        )
        .await?;
    Ok(())
}

/// 작업 트리 변경을 버린다 (백업 뒤). 백업 id 목록을 돌려준다
#[tauri::command]
#[specta::specta]
pub async fn discard_paths(
    state: State<'_, AppState>,
    session: u32,
    paths: Vec<String>,
) -> Result<Vec<u32>, IpcError> {
    let ids = state
        .core()?
        .core
        .discard(SessionId(session), &paths)
        .await?;
    Ok(ids.into_iter().map(crate::dto::narrow_u64).collect())
}

/// 경로(파일·폴더)의 변경을 HEAD 기준으로 되돌린다 (stage 된 변경 포함, 백업 뒤). 백업 id 목록을 돌려준다
#[tauri::command]
#[specta::specta]
pub async fn rollback_paths(
    state: State<'_, AppState>,
    session: u32,
    paths: Vec<String>,
) -> Result<Vec<u32>, IpcError> {
    let ids = state
        .core()?
        .core
        .rollback(SessionId(session), &paths)
        .await?;
    Ok(ids.into_iter().map(crate::dto::narrow_u64).collect())
}

/// 고른 hunk·줄만 작업 트리에서 되돌린다 (백업 뒤). `options` 는 화면의 diff 와 같아야 한다
#[tauri::command]
#[specta::specta]
pub async fn discard_lines(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    selection: Vec<LineSelection>,
    options: Option<DiffOptionsDto>,
    expected_revision: Option<String>,
) -> Result<Option<u32>, IpcError> {
    let selection: Vec<mgit_core::LineSelection> = selection.into_iter().map(Into::into).collect();
    let id = state
        .core()?
        .core
        .discard_lines_checked(
            SessionId(session),
            &path,
            &selection,
            options.map(Into::into).unwrap_or_default(),
            expected_revision.as_deref(),
        )
        .await?;
    Ok(id.map(crate::dto::narrow_u64))
}

/// discard 백업 목록 (최신 순)
#[tauri::command]
#[specta::specta]
pub async fn list_backups(
    state: State<'_, AppState>,
    session: u32,
    limit: u32,
) -> Result<Vec<BackupRecord>, IpcError> {
    let list = state.core()?.core.backups(SessionId(session), limit)?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 백업 사본을 작업 트리로 되돌린다
#[tauri::command]
#[specta::specta]
pub async fn restore_backup(
    state: State<'_, AppState>,
    session: u32,
    id: u32,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .restore_backup(SessionId(session), id as u64)
        .await?;
    Ok(())
}

/// stage 된 내용의 충돌 마커 (CF-24)
#[tauri::command]
#[specta::specta]
pub async fn verify_staged(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<MarkerHit>, IpcError> {
    let hits = state.core()?.core.verify_staged(SessionId(session)).await?;
    Ok(hits.into_iter().map(Into::into).collect())
}

/// 커밋한다. hook 출력은 `operationOutput` 이벤트로 온다. 새 HEAD 해시를 돌려준다
#[tauri::command]
#[specta::specta]
pub async fn commit(
    state: State<'_, AppState>,
    session: u32,
    spec: CommitSpec,
) -> Result<String, IpcError> {
    let core = &state.core()?.core;
    let op = core.begin_operation(SessionId(session), "commit", "commit")?;
    let head = core
        .commit(SessionId(session), spec.into(), Some(op))
        .await?;
    Ok(head.to_hex())
}

/// HEAD 커밋 메시지 (amend 입력란 채우기용)
#[tauri::command]
#[specta::specta]
pub async fn last_commit_message(
    state: State<'_, AppState>,
    session: u32,
) -> Result<String, IpcError> {
    Ok(state
        .core()?
        .core
        .last_commit_message(SessionId(session))
        .await?)
}

/// 커밋 하나의 전체 메시지 (reword 입력란 채우기용)
#[tauri::command]
#[specta::specta]
pub async fn commit_message(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<String, IpcError> {
    let oid = Oid::from_hex(oid.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })?;
    Ok(state
        .core()?
        .core
        .commit_message(SessionId(session), &oid)
        .await?)
}

/// 전체 원문과 확정된 비교 기준을 함께 조회한다.
#[tauri::command]
#[specta::specta]
pub async fn work_tree_diff_document(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    staged: bool,
    full: bool,
    options: Option<DiffOptionsDto>,
) -> Result<crate::dto_diff::DiffDocument, IpcError> {
    let diff = state
        .core()?
        .core
        .work_tree_diff_document(
            SessionId(session),
            &path,
            staged,
            full,
            options.map(Into::into).unwrap_or_default(),
        )
        .await?;
    Ok(diff.into())
}

/// 전체 원문과 확정된 비교 기준을 함께 조회한다.
#[tauri::command]
#[specta::specta]
pub async fn commit_file_diff_document(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
    path: String,
    old_path: Option<String>,
    full: bool,
    options: Option<DiffOptionsDto>,
) -> Result<crate::dto_diff::DiffDocument, IpcError> {
    let oid = Oid::from_hex(oid.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })?;
    let diff = state
        .core()?
        .core
        .commit_file_diff_document(
            SessionId(session),
            &oid,
            &path,
            old_path.as_deref(),
            full,
            options.map(Into::into).unwrap_or_default(),
        )
        .await?;
    Ok(diff.into())
}
