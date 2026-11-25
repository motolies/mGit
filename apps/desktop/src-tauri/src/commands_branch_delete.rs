//! 원격 브랜치 삭제의 확인 스냅샷과 단계별 결과 IPC.
use crate::error::IpcError;
use crate::state::AppState;
use mgit_core::SessionId;
use serde::{Deserialize, Serialize};
use tauri::State;

/// 확인창에서 고정한 로컬 브랜치와 조회 당시 상태.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteLocalTarget {
    pub name: String,
    pub oid: String,
    pub upstream: String,
    pub checked_out: Option<String>,
}

/// 저장소별 삭제 범위. 실행 때 경로·설정·ref를 다시 검사한다.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteTarget {
    pub path: String,
    pub remote: String,
    pub name: String,
    pub remote_oid: Option<String>,
    pub remote_url: String,
    pub locals: Vec<BranchDeleteLocalTarget>,
    pub error: Option<String>,
    pub excluded: bool,
}

/// 단계별 결과. 미병합만 명시적 강제 재시도 대상이다.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BranchDeletionStatus {
    Deleted,
    AlreadyAbsent,
    Failed,
    Unknown,
    NotRun,
    NotMerged,
    CheckedOut,
    Stale,
}

/// 원격 삭제 단계 결과.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeletionStep {
    pub status: BranchDeletionStatus,
    pub message: String,
}

/// 로컬별 결과와 강제 확인에서 재검증할 OID.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchDeletionResult {
    pub name: String,
    pub oid: String,
    pub status: BranchDeletionStatus,
    pub message: String,
}

/// 원격과 로컬 결과를 별도로 보존한다. 로컬 재시도는 원격을 다시 삭제하지 않는다.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeletionResult {
    pub remote: BranchDeletionStep,
    pub locals: Vec<LocalBranchDeletionResult>,
}

impl From<mgit_core::BranchDeleteLocalTarget> for BranchDeleteLocalTarget {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: mgit_core::BranchDeleteLocalTarget) -> Self {
        Self {
            name: v.name,
            oid: v.oid,
            upstream: v.upstream,
            checked_out: v.checked_out,
        }
    }
}
impl From<BranchDeleteLocalTarget> for mgit_core::BranchDeleteLocalTarget {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: BranchDeleteLocalTarget) -> Self {
        Self {
            name: v.name,
            oid: v.oid,
            upstream: v.upstream,
            checked_out: v.checked_out,
        }
    }
}
impl From<mgit_core::BranchDeleteTarget> for BranchDeleteTarget {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: mgit_core::BranchDeleteTarget) -> Self {
        Self {
            path: v.path.display().to_string(),
            remote: v.remote,
            name: v.name,
            remote_oid: v.remote_oid,
            remote_url: v.remote_url,
            locals: v.locals.into_iter().map(Into::into).collect(),
            error: v.error,
            excluded: v.excluded,
        }
    }
}
impl From<BranchDeleteTarget> for mgit_core::BranchDeleteTarget {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: BranchDeleteTarget) -> Self {
        Self {
            path: v.path.into(),
            remote: v.remote,
            name: v.name,
            remote_oid: v.remote_oid,
            remote_url: v.remote_url,
            locals: v.locals.into_iter().map(Into::into).collect(),
            error: v.error,
            excluded: v.excluded,
        }
    }
}
impl From<mgit_core::BranchDeletionStep> for BranchDeletionStep {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: mgit_core::BranchDeletionStep) -> Self {
        Self {
            status: v.status.into(),
            message: v.message,
        }
    }
}
impl From<BranchDeletionStep> for mgit_core::BranchDeletionStep {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: BranchDeletionStep) -> Self {
        Self {
            status: v.status.into(),
            message: v.message,
        }
    }
}
impl From<mgit_core::LocalBranchDeletionResult> for LocalBranchDeletionResult {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: mgit_core::LocalBranchDeletionResult) -> Self {
        Self {
            name: v.name,
            oid: v.oid,
            status: v.status.into(),
            message: v.message,
        }
    }
}
impl From<LocalBranchDeletionResult> for mgit_core::LocalBranchDeletionResult {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: LocalBranchDeletionResult) -> Self {
        Self {
            name: v.name,
            oid: v.oid,
            status: v.status.into(),
            message: v.message,
        }
    }
}
impl From<mgit_core::BranchDeletionResult> for BranchDeletionResult {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: mgit_core::BranchDeletionResult) -> Self {
        Self {
            remote: v.remote.into(),
            locals: v.locals.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<BranchDeletionResult> for mgit_core::BranchDeletionResult {
    /// 코어와 IPC 구조를 같은 의미로 변환한다.
    fn from(v: BranchDeletionResult) -> Self {
        Self {
            remote: v.remote.into(),
            locals: v.locals.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<mgit_core::BranchDeletionStatus> for BranchDeletionStatus {
    /// 단계 상태를 1:1로 변환한다.
    fn from(v: mgit_core::BranchDeletionStatus) -> Self {
        match v {
            mgit_core::BranchDeletionStatus::Deleted => Self::Deleted,
            mgit_core::BranchDeletionStatus::AlreadyAbsent => Self::AlreadyAbsent,
            mgit_core::BranchDeletionStatus::Failed => Self::Failed,
            mgit_core::BranchDeletionStatus::Unknown => Self::Unknown,
            mgit_core::BranchDeletionStatus::NotRun => Self::NotRun,
            mgit_core::BranchDeletionStatus::NotMerged => Self::NotMerged,
            mgit_core::BranchDeletionStatus::CheckedOut => Self::CheckedOut,
            mgit_core::BranchDeletionStatus::Stale => Self::Stale,
        }
    }
}
impl From<BranchDeletionStatus> for mgit_core::BranchDeletionStatus {
    /// 단계 상태를 1:1로 변환한다.
    fn from(v: BranchDeletionStatus) -> Self {
        match v {
            BranchDeletionStatus::Deleted => Self::Deleted,
            BranchDeletionStatus::AlreadyAbsent => Self::AlreadyAbsent,
            BranchDeletionStatus::Failed => Self::Failed,
            BranchDeletionStatus::Unknown => Self::Unknown,
            BranchDeletionStatus::NotRun => Self::NotRun,
            BranchDeletionStatus::NotMerged => Self::NotMerged,
            BranchDeletionStatus::CheckedOut => Self::CheckedOut,
            BranchDeletionStatus::Stale => Self::Stale,
        }
    }
}

/// 브랜치 삭제 대상·결과를 코어에 위임한다.
#[tauri::command]
#[specta::specta]
pub async fn inspect_remote_branch_deletion(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    name: String,
) -> Result<BranchDeleteTarget, IpcError> {
    Ok(state
        .core()?
        .core
        .inspect_remote_branch_deletion(SessionId(session), &remote, &name)
        .await?
        .into())
}

/// 브랜치 삭제 대상·결과를 코어에 위임한다.
#[tauri::command]
#[specta::specta]
pub async fn inspect_folder_remote_branch_deletion(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    name: String,
) -> Result<Vec<BranchDeleteTarget>, IpcError> {
    Ok(state
        .core()?
        .core
        .inspect_folder_remote_branch_deletion(SessionId(session), &remote, &name)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 브랜치 삭제 대상·결과를 코어에 위임한다.
#[tauri::command]
#[specta::specta]
pub async fn delete_remote_branch_with_locals(
    state: State<'_, AppState>,
    session: u32,
    target: BranchDeleteTarget,
    delete_local: bool,
) -> Result<BranchDeletionResult, IpcError> {
    Ok(state
        .core()?
        .core
        .delete_remote_branch_with_locals(SessionId(session), &target.into(), delete_local)
        .await?
        .into())
}

/// 브랜치 삭제 대상·결과를 코어에 위임한다.
#[tauri::command]
#[specta::specta]
pub async fn force_delete_local_branches(
    state: State<'_, AppState>,
    session: u32,
    target: BranchDeleteTarget,
) -> Result<BranchDeletionResult, IpcError> {
    Ok(state
        .core()?
        .core
        .force_delete_local_branches(SessionId(session), &target.into())
        .await?
        .into())
}
