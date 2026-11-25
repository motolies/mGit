//! 파일 작업 IPC. OS에서 받은 파일 경로를 토큰으로 바꾸고 코어의 상대 경로 경계를 유지한다.
use crate::{error::IpcError, native_files, state::AppState};
use mgit_core::{
    FsOperationDecision, FsOperationPlan, FsOperationRequest, FsOperationResult, FsOperations,
    FsSource,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use tauri::State;

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsClipboard {
    pub token: String,
    pub count: u32,
    pub cut: bool,
    pub paths: Vec<String>,
}
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsExternalInput {
    pub token: String,
    pub count: u32,
}

pub struct FileOperationsState {
    pub operations: Arc<FsOperations>,
    drop_paths: Mutex<Vec<PathBuf>>,
    clipboard: Mutex<Option<(i64, FsClipboard)>>,
    warnings: Mutex<Vec<String>>,
}
impl FileOperationsState {
    /// 시작 시 중단된 파일 작업을 복구하고 남은 복구본은 알림으로 전달한다.
    pub fn new(data_dir: PathBuf) -> Self {
        let operations = Arc::new(FsOperations::new(
            data_dir.join("file-operations"),
            Arc::new(native_files::NativeTrash),
        ));
        let warnings = operations.recover();
        Self {
            operations,
            drop_paths: Mutex::new(vec![]),
            clipboard: Mutex::new(None),
            warnings: Mutex::new(warnings),
        }
    }
    /// WebView의 JS 이벤트보다 먼저 받은 OS drop 경로를 기억한다.
    pub fn register_drop(&self, paths: &[PathBuf]) {
        *self
            .drop_paths
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = paths.to_vec();
    }
}
/// 안전한 계획을 생성하며 파일을 변경하지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn fs_prepare_operation(
    state: State<'_, AppState>,
    files: State<'_, FileOperationsState>,
    request: FsOperationRequest,
) -> Result<FsOperationPlan, IpcError> {
    Ok(files
        .operations
        .prepare(&state.core()?.core, request)
        .await?)
}
/// 준비 계획의 변경 여부를 검사하고 항목별 결과를 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn fs_execute_operation(
    state: State<'_, AppState>,
    files: State<'_, FileOperationsState>,
    id: String,
    decisions: Vec<FsOperationDecision>,
) -> Result<FsOperationResult, IpcError> {
    Ok(files
        .operations
        .execute(state.core()?.core.clone(), &id, decisions)
        .await?)
}
/// 진행 중 파일 작업을 안전한 항목 경계에서 중단한다.
#[tauri::command]
#[specta::specta]
pub fn fs_cancel_operation(files: State<'_, FileOperationsState>, id: String) {
    files.operations.cancel(&id);
}
/// 임의 절대 경로는 받지 않고 실제 OS drop과 일치한 입력만 등록한다.
#[tauri::command]
#[specta::specta]
pub fn fs_register_drop(
    files: State<'_, FileOperationsState>,
    paths: Vec<String>,
) -> Result<FsExternalInput, IpcError> {
    let actual: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let mut dropped = files
        .drop_paths
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if actual != *dropped || actual.is_empty() {
        return Err(IpcError::Internal {
            message: "실제 드롭한 파일만 가져올 수 있습니다".into(),
        });
    }
    let count = actual.len() as u32;
    let token = files.operations.grant(actual, false)?;
    dropped.clear();
    Ok(FsExternalInput { token, count })
}
/// 선택 파일을 시스템 clipboard에 기록한다. 빈 목록은 cut 표시와 clipboard를 해제한다.
#[tauri::command]
#[specta::specta]
pub fn fs_clipboard_write(
    state: State<'_, AppState>,
    files: State<'_, FileOperationsState>,
    sources: Vec<FsSource>,
    cut: bool,
) -> Result<(), IpcError> {
    let paths = sources
        .iter()
        .map(|s| {
            files
                .operations
                .source_path(&state.core()?.core, s, cut)
                .map_err(IpcError::from)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if paths.is_empty() {
        native_files::write(&[], "").map_err(|message| IpcError::Internal { message })?;
        *files
            .clipboard
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        return Ok(());
    }
    let token = files.operations.grant(paths.clone(), cut)?;
    let paths: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let count =
        native_files::write(&paths, &token).map_err(|message| IpcError::Internal { message })?;
    *files
        .clipboard
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some((
        count,
        FsClipboard {
            count: paths.len() as u32,
            paths,
            token,
            cut,
        },
    ));
    Ok(())
}
/// Finder clipboard는 항상 복사이며 자체 marker와 changeCount가 일치할 때만 cut을 유지한다.
#[tauri::command]
#[specta::specta]
pub fn fs_clipboard_read(
    files: State<'_, FileOperationsState>,
) -> Result<Option<FsClipboard>, IpcError> {
    let (paths, marker, count) =
        native_files::read().map_err(|message| IpcError::Internal { message })?;
    let mut own = files
        .clipboard
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some((saved_count, clipboard)) = own.as_ref()
        && *saved_count == count
        && (marker.as_deref() == Some(&clipboard.token)
            || (!clipboard.cut && paths == clipboard.paths))
    {
        return Ok(Some(clipboard.clone()));
    }
    *own = None;
    if paths.is_empty() {
        return Ok(None);
    }
    let token = files
        .operations
        .grant(paths.iter().map(PathBuf::from).collect(), false)?;
    let clipboard = FsClipboard {
        count: paths.len() as u32,
        paths,
        token,
        cut: false,
    };
    // 외부 토큰도 같은 clipboard를 반복 읽을 때 재사용한다.
    *own = Some((count, clipboard.clone()));
    Ok(Some(clipboard))
}
/// 자동으로 복구하지 못한 이전 작업의 경로를 한 번 전달한다.
#[tauri::command]
#[specta::specta]
pub fn fs_recovery_warnings(files: State<'_, FileOperationsState>) -> Vec<String> {
    std::mem::take(
        &mut *files
            .warnings
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
    )
}

/// 파일·디렉터리 단위 완료 수와 현재 처리 경로를 조회한다.
#[tauri::command]
#[specta::specta]
pub fn fs_operation_progress(
    files: State<'_, FileOperationsState>,
    id: String,
) -> mgit_core::FsOperationProgress {
    files.operations.progress(&id)
}
