//! 서브모듈 관리 커맨드 (Phase 2 C2)

use mgit_core::{Oid, SessionId, SubmoduleCommit, SubmodulePointerLog, SubmoduleUnpushed};
use serde::Serialize;
use tauri::State;

use crate::commands_folder::{BatchOpDto, BatchResult};
use crate::error::IpcError;
use crate::state::AppState;

/// 서브모듈 commit 요약
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleCommitDto {
    pub oid: String,
    pub subject: String,
    pub author: String,
    #[specta(type = f64)]
    pub time: i64,
}

impl From<SubmoduleCommit> for SubmoduleCommitDto {
    /// 코어 → wire
    fn from(c: SubmoduleCommit) -> Self {
        SubmoduleCommitDto {
            oid: c.oid.to_hex(),
            subject: c.subject,
            author: c.author,
            time: c.time,
        }
    }
}

/// 포인터 변경 로그
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePointerLogDto {
    pub commits: Vec<SubmoduleCommitDto>,
    pub reversed: bool,
    pub missing: bool,
}

impl From<SubmodulePointerLog> for SubmodulePointerLogDto {
    /// 코어 → wire
    fn from(l: SubmodulePointerLog) -> Self {
        SubmodulePointerLogDto {
            commits: l.commits.into_iter().map(Into::into).collect(),
            reversed: l.reversed,
            missing: l.missing,
        }
    }
}

/// push 안 된 서브모듈
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleUnpushedDto {
    pub path: String,
    pub count: u32,
}

impl From<SubmoduleUnpushed> for SubmoduleUnpushedDto {
    /// 코어 → wire
    fn from(u: SubmoduleUnpushed) -> Self {
        SubmoduleUnpushedDto {
            path: u.path,
            count: u.count,
        }
    }
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 포인터 변경 사이의 commit (SUB-04)
#[tauri::command]
#[specta::specta]
pub async fn submodule_pointer_log(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    old: Option<String>,
    new_oid: String,
) -> Result<SubmodulePointerLogDto, IpcError> {
    let old = match old {
        Some(h) => Some(parse_oid(&h)?),
        None => None,
    };
    Ok(state
        .core()?
        .core
        .submodule_pointer_log(SessionId(session), &path, old, parse_oid(&new_oid)?)
        .await?
        .into())
}

/// 서브모듈 추가 (SUB-05)
#[tauri::command]
#[specta::specta]
pub async fn submodule_add(
    state: State<'_, AppState>,
    session: u32,
    url: String,
    path: String,
    branch: Option<String>,
) -> Result<(), IpcError> {
    let core = &state.core()?.core;
    let op = core.begin_operation(
        SessionId(session),
        "submodule",
        &format!("submodule add {path}"),
    )?;
    core.submodule_add(SessionId(session), &url, &path, branch.as_deref(), Some(op))
        .await?;
    Ok(())
}

/// 이미 clone 된 하위 저장소를 서브모듈로 (SUB-11)
#[tauri::command]
#[specta::specta]
pub async fn submodule_adopt(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .submodule_adopt(SessionId(session), &path)
        .await?;
    Ok(())
}

/// 서브모듈 제거 (SUB-05)
#[tauri::command]
#[specta::specta]
pub async fn submodule_remove(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .submodule_remove(SessionId(session), &path)
        .await?;
    Ok(())
}

/// 추적 branch 지정·해제 (SUB-06)
#[tauri::command]
#[specta::specta]
pub async fn submodule_set_branch(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    branch: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .submodule_set_branch(SessionId(session), &path, branch.as_deref())
        .await?;
    Ok(())
}

/// 추적 branch 최신으로 (SUB-06)
#[tauri::command]
#[specta::specta]
pub async fn submodule_update_remote(
    state: State<'_, AppState>,
    session: u32,
    path: Option<String>,
    mode: Option<String>,
) -> Result<(), IpcError> {
    let core = &state.core()?.core;
    let op = core.begin_operation(
        SessionId(session),
        "submodule",
        &format!(
            "submodule update --remote {}",
            path.as_deref().unwrap_or("")
        ),
    )?;
    core.submodule_update_remote(
        SessionId(session),
        path.as_deref(),
        mode.as_deref(),
        Some(op),
    )
    .await?;
    Ok(())
}

/// URL 동기화 (SUB-07)
#[tauri::command]
#[specta::specta]
pub async fn submodule_sync(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .submodule_sync(SessionId(session))
        .await?;
    Ok(())
}

/// 서브모듈 일괄 작업 (SUB-08)
#[tauri::command]
#[specta::specta]
pub async fn submodule_batch(
    state: State<'_, AppState>,
    session: u32,
    op: BatchOpDto,
    paths: Vec<String>,
) -> Result<BatchResult, IpcError> {
    Ok(state
        .core()?
        .core
        .submodule_batch(SessionId(session), op.into(), &paths)
        .await?
        .into())
}

/// push 안 된 commit 이 있는 서브모듈 (SUB-09)
#[tauri::command]
#[specta::specta]
pub async fn submodule_unpushed(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<SubmoduleUnpushedDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .submodule_unpushed(SessionId(session))
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}
