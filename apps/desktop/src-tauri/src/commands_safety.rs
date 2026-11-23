//! 안전장치 커맨드 (Phase 2 A1): undo/redo, 백업 ref, reflog, 워크트리 잠금, ignore, 커밋 템플릿

use std::path::Path;

use mgit_core::{Oid, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// undo 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoEntry {
    #[specta(type = f64)]
    pub id: u64,
    pub label: String,
    #[specta(type = f64)]
    pub at: i64,
    pub changed: u32,
}

/// undo 스택 상태
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    /// 최근 순
    pub entries: Vec<UndoEntry>,
    pub redo_count: u32,
}

/// undo·redo 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub entry: UndoEntry,
    /// 작업 뒤에 외부에서 바뀌어 건드리지 않은 ref 전체 이름 (HEAD 는 `HEAD`)
    pub skipped: Vec<String>,
}

impl From<mgit_core::UndoResult> for UndoOutcome {
    /// 코어 → wire
    fn from(r: mgit_core::UndoResult) -> Self {
        Self {
            entry: r.entry.into(),
            skipped: r.skipped,
        }
    }
}

impl From<mgit_core::UndoEntryInfo> for UndoEntry {
    /// 코어 구조체와 1:1
    fn from(e: mgit_core::UndoEntryInfo) -> Self {
        Self {
            id: e.id,
            label: e.label,
            at: e.at,
            changed: e.changed,
        }
    }
}

/// 백업 ref
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupRef {
    pub name: String,
    pub branch: String,
    pub oid: String,
    #[specta(type = f64)]
    pub created_at: i64,
}

/// reflog 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub selector: String,
    pub oid: String,
    pub subject: String,
    #[specta(type = f64)]
    pub time: i64,
}

/// 커밋 템플릿
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitTemplate {
    pub name: String,
    pub body: String,
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// undo 스택 (SF-03)
#[tauri::command]
#[specta::specta]
pub async fn undo_state(state: State<'_, AppState>, session: u32) -> Result<UndoState, IpcError> {
    let (entries, redo) = state.core()?.core.undo_entries(SessionId(session))?;
    Ok(UndoState {
        entries: entries.into_iter().map(Into::into).collect(),
        redo_count: redo as u32,
    })
}

/// 직전 작업 되돌리기. 되돌린 항목과 건너뛴 ref (없으면 None)
#[tauri::command]
#[specta::specta]
pub async fn undo(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<UndoOutcome>, IpcError> {
    Ok(state
        .core()?
        .core
        .undo(SessionId(session))
        .await?
        .map(Into::into))
}

/// 다시 실행
#[tauri::command]
#[specta::specta]
pub async fn redo(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<UndoOutcome>, IpcError> {
    Ok(state
        .core()?
        .core
        .redo(SessionId(session))
        .await?
        .map(Into::into))
}

/// 백업 ref 목록 (SF-04)
#[tauri::command]
#[specta::specta]
pub async fn backups(state: State<'_, AppState>, session: u32) -> Result<Vec<BackupRef>, IpcError> {
    let list = state.core()?.core.backup_refs(SessionId(session)).await?;
    Ok(list
        .into_iter()
        .map(|b| BackupRef {
            name: b.name,
            branch: b.branch,
            oid: b.oid.to_hex(),
            created_at: b.created_at,
        })
        .collect())
}

/// 백업 복원: `new_branch` 가 있으면 그 이름의 브랜치로, 없으면 원래 브랜치를 되돌린다
#[tauri::command]
#[specta::specta]
pub async fn backup_restore(
    state: State<'_, AppState>,
    session: u32,
    backup: String,
    new_branch: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .backup_restore(SessionId(session), &backup, new_branch.as_deref())
        .await?;
    Ok(())
}

/// 백업 삭제
#[tauri::command]
#[specta::specta]
pub async fn backup_delete(
    state: State<'_, AppState>,
    session: u32,
    backup: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .backup_delete(SessionId(session), &backup)
        .await?;
    Ok(())
}

/// reflog (AD-02)
#[tauri::command]
#[specta::specta]
pub async fn reflog(
    state: State<'_, AppState>,
    session: u32,
    reference: Option<String>,
    limit: u32,
) -> Result<Vec<ReflogEntry>, IpcError> {
    let list = state
        .core()?
        .core
        .reflog(SessionId(session), reference.as_deref(), limit)
        .await?;
    Ok(list
        .into_iter()
        .map(|e| ReflogEntry {
            selector: e.selector,
            oid: e.oid.to_hex(),
            subject: e.subject,
            time: e.time,
        })
        .collect())
}

/// reflog 항목에서 브랜치 복원
#[tauri::command]
#[specta::specta]
pub async fn reflog_restore(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
    new_branch: String,
) -> Result<(), IpcError> {
    let oid = parse_oid(&oid)?;
    state
        .core()?
        .core
        .reflog_restore(SessionId(session), &oid, &new_branch)
        .await?;
    Ok(())
}

/// 워크트리 잠금 (WT-08)
#[tauri::command]
#[specta::specta]
pub async fn worktree_lock(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    reason: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .worktree_lock(SessionId(session), Path::new(&path), reason.as_deref())
        .await?;
    Ok(())
}

/// 워크트리 잠금 해제
#[tauri::command]
#[specta::specta]
pub async fn worktree_unlock(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .worktree_unlock(SessionId(session), Path::new(&path))
        .await?;
    Ok(())
}

/// `.gitignore` 에 패턴 추가 (CHG-10)
#[tauri::command]
#[specta::specta]
pub async fn ignore_add(
    state: State<'_, AppState>,
    session: u32,
    patterns: Vec<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .ignore_add(SessionId(session), &patterns)
        .await?;
    Ok(())
}

/// 커밋 템플릿 목록 (git commit.template + 앱 템플릿)
#[tauri::command]
#[specta::specta]
pub async fn commit_templates(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<CommitTemplate>, IpcError> {
    let list = state
        .core()?
        .core
        .commit_templates(SessionId(session))
        .await?;
    Ok(list
        .into_iter()
        .map(|t| CommitTemplate {
            name: t.name,
            body: t.body,
        })
        .collect())
}

/// 앱 커밋 템플릿 저장
#[tauri::command]
#[specta::specta]
pub async fn commit_templates_set(
    state: State<'_, AppState>,
    templates: Vec<CommitTemplate>,
) -> Result<(), IpcError> {
    let list: Vec<mgit_core::CommitTemplate> = templates
        .into_iter()
        .map(|t| mgit_core::CommitTemplate {
            name: t.name,
            body: t.body,
        })
        .collect();
    state.core()?.core.set_app_commit_templates(&list)?;
    Ok(())
}

/// 앱 커밋 템플릿만 (설정 대화상자용)
#[tauri::command]
#[specta::specta]
pub async fn app_commit_templates(
    state: State<'_, AppState>,
) -> Result<Vec<CommitTemplate>, IpcError> {
    Ok(state
        .core()?
        .core
        .app_commit_templates()
        .into_iter()
        .map(|t| CommitTemplate {
            name: t.name,
            body: t.body,
        })
        .collect())
}

/// 남은 `index.lock` 삭제 (SF-05). 지웠으면 true
#[tauri::command]
#[specta::specta]
pub async fn remove_index_lock(state: State<'_, AppState>, session: u32) -> Result<bool, IpcError> {
    Ok(state.core()?.core.remove_index_lock(SessionId(session))?)
}
