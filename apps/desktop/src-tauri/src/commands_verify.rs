//! 해결 검증·검증 명령·워크트리 초기화 명령 커맨드 (Phase 2 D3)

use std::path::PathBuf;

use mgit_core::{CommandRun, SessionId, SyntaxCompare};
use serde::Serialize;
use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// 구문 비교
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCompareDto {
    pub language: String,
    pub result_errors: u32,
    pub ours_errors: Option<u32>,
    pub theirs_errors: Option<u32>,
    pub first_error_line: Option<u32>,
    pub new_errors: bool,
}

impl From<SyntaxCompare> for SyntaxCompareDto {
    /// 코어 → wire
    fn from(c: SyntaxCompare) -> Self {
        SyntaxCompareDto {
            language: c.language,
            result_errors: c.result_errors,
            ours_errors: c.ours_errors,
            theirs_errors: c.theirs_errors,
            first_error_line: c.first_error_line,
            new_errors: c.new_errors,
        }
    }
}

/// 명령 실행 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunDto {
    pub command: String,
    pub ok: bool,
    pub status: Option<i32>,
    pub output: String,
    #[specta(type = f64)]
    pub elapsed_ms: u64,
    pub timed_out: bool,
}

impl From<CommandRun> for CommandRunDto {
    /// 코어 → wire
    fn from(r: CommandRun) -> Self {
        CommandRunDto {
            command: r.command,
            ok: r.ok,
            status: r.status,
            output: r.output,
            elapsed_ms: r.elapsed_ms,
            timed_out: r.timed_out,
        }
    }
}

/// 구문 검사 비교 (CF-25). 지원하지 않는 확장자면 null
#[tauri::command]
#[specta::specta]
pub async fn syntax_compare(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    content: String,
) -> Result<Option<SyntaxCompareDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .syntax_compare(SessionId(session), &path, content.as_bytes())
        .await?
        .map(Into::into))
}

/// 검증 명령
#[tauri::command]
#[specta::specta]
pub async fn verify_command(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<String>, IpcError> {
    Ok(state.core()?.core.verify_command(SessionId(session))?)
}

/// 검증 명령 저장
#[tauri::command]
#[specta::specta]
pub async fn verify_command_set(
    state: State<'_, AppState>,
    session: u32,
    cmd: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_verify_command(SessionId(session), cmd.as_deref())?;
    Ok(())
}

/// 검증 명령 실행
#[tauri::command]
#[specta::specta]
pub async fn run_verify(
    state: State<'_, AppState>,
    session: u32,
) -> Result<CommandRunDto, IpcError> {
    Ok(state
        .core()?
        .core
        .run_verify(SessionId(session))
        .await?
        .into())
}

/// 워크트리 초기화 명령 (WT-07)
#[tauri::command]
#[specta::specta]
pub async fn worktree_init_command(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<String>, IpcError> {
    Ok(state
        .core()?
        .core
        .worktree_init_command(SessionId(session))?)
}

/// 워크트리 초기화 명령 저장
#[tauri::command]
#[specta::specta]
pub async fn worktree_init_command_set(
    state: State<'_, AppState>,
    session: u32,
    cmd: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_worktree_init_command(SessionId(session), cmd.as_deref())?;
    Ok(())
}

/// 새 워크트리에서 초기화 명령 실행. 명령이 없으면 null
#[tauri::command]
#[specta::specta]
pub async fn run_worktree_init(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<Option<CommandRunDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .run_worktree_init(SessionId(session), &PathBuf::from(path))
        .await?
        .map(Into::into))
}
