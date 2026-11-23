//! 충돌 해결 커맨드 (S6)

use mgit_core::{ConflictSide, SessionId, UnresolveMode};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::dto::ConflictKind;
use crate::error::IpcError;
use crate::state::AppState;

/// 충돌 파일
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
    pub binary: bool,
    pub submodule: bool,
    /// [base, ours, theirs] blob
    pub stages: Vec<Option<String>>,
}

impl From<mgit_core::ConflictFile> for ConflictFile {
    /// Oid 를 hex 로
    fn from(f: mgit_core::ConflictFile) -> Self {
        Self {
            path: f.path,
            kind: f.kind.into(),
            binary: f.binary,
            submodule: f.submodule,
            stages: f.stages.iter().map(|s| s.map(|o| o.to_hex())).collect(),
        }
    }
}

/// 열 제목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SideLabels {
    pub ours: String,
    pub base: String,
    pub theirs: String,
}

/// 줄 끝
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Eol {
    Lf,
    CrLf,
}

/// 블록
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Block {
    Clean {
        lines: Vec<String>,
    },
    Conflict {
        ours: Vec<String>,
        base: Vec<String>,
        theirs: Vec<String>,
        labels: Vec<String>,
    },
}

/// 블록 문서
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDoc {
    pub blocks: Vec<Block>,
    pub eol: Eol,
    pub trailing_newline: bool,
}

impl From<mgit_core::ConflictDoc> for ConflictDoc {
    /// 라벨 배열을 Vec 으로
    fn from(d: mgit_core::ConflictDoc) -> Self {
        Self {
            blocks: d
                .blocks
                .into_iter()
                .map(|b| match b {
                    mgit_core::Block::Clean { lines } => Block::Clean { lines },
                    mgit_core::Block::Conflict {
                        ours,
                        base,
                        theirs,
                        labels,
                    } => Block::Conflict {
                        ours,
                        base,
                        theirs,
                        labels: labels.to_vec(),
                    },
                })
                .collect(),
            eol: match d.eol {
                mgit_core::Eol::Lf => Eol::Lf,
                mgit_core::Eol::CrLf => Eol::CrLf,
            },
            trailing_newline: d.trailing_newline,
        }
    }
}

/// 3-way 편집기 자료
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPayload {
    pub file: ConflictFile,
    pub labels: SideLabels,
    pub ours: Option<String>,
    pub base: Option<String>,
    pub theirs: Option<String>,
    pub doc: Option<ConflictDoc>,
    pub worktree_modified: bool,
    pub worktree: Option<String>,
    /// 서브모듈 포인터 충돌의 양쪽 commit (SUB-10)
    pub submodule_sides: Option<SubmoduleSidesDto>,
    /// 블록 분류·자동 결합 제안 (CF-15)
    pub auto: Vec<crate::commands_assist::AutoSuggestionDto>,
}

/// 서브모듈 포인터 충돌 양쪽
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleSidesDto {
    pub base: Option<crate::commands_submodule::SubmoduleCommitDto>,
    pub ours: Option<crate::commands_submodule::SubmoduleCommitDto>,
    pub theirs: Option<crate::commands_submodule::SubmoduleCommitDto>,
}

/// 충돌 쪽
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSideDto {
    Ours,
    Theirs,
}

impl From<ConflictSideDto> for ConflictSide {
    /// wire → 코어
    fn from(s: ConflictSideDto) -> Self {
        match s {
            ConflictSideDto::Ours => ConflictSide::Ours,
            ConflictSideDto::Theirs => ConflictSide::Theirs,
        }
    }
}

/// 되돌리기 방식
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum UnresolveModeDto {
    Remake,
    KeepWorktree,
}

/// 충돌 파일 목록 (CF-06)
#[tauri::command]
#[specta::specta]
pub async fn conflicts(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<ConflictFile>, IpcError> {
    let list = state.core()?.core.conflicts(SessionId(session)).await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 한 파일의 3-way 자료 (CF-06·07·13)
#[tauri::command]
#[specta::specta]
pub async fn conflict_file(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<ConflictPayload, IpcError> {
    let p = state
        .core()?
        .core
        .conflict_file(SessionId(session), &path)
        .await?;
    Ok(ConflictPayload {
        file: p.file.into(),
        labels: SideLabels {
            ours: p.labels.ours,
            base: p.labels.base,
            theirs: p.labels.theirs,
        },
        ours: p.ours,
        base: p.base,
        theirs: p.theirs,
        doc: p.doc.map(Into::into),
        worktree_modified: p.worktree_modified,
        worktree: p.worktree,
        auto: p.auto.into_iter().map(Into::into).collect(),
        submodule_sides: p.submodule_sides.map(|x| SubmoduleSidesDto {
            base: x.base.map(Into::into),
            ours: x.ours.map(Into::into),
            theirs: x.theirs.map(Into::into),
        }),
    })
}

/// 편집 결과 저장 + stage (CF-10·23). 마커가 남아 있으면 `allow_conflict_markers` 가 아닌 한
/// `ConflictMarkers` 오류
#[tauri::command]
#[specta::specta]
pub async fn resolve_file(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    content: String,
    allow_conflict_markers: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .resolve_file(
            SessionId(session),
            &path,
            content.as_bytes(),
            allow_conflict_markers,
        )
        .await?;
    Ok(())
}

/// 한쪽 선택 (CF-11·12)
#[tauri::command]
#[specta::specta]
pub async fn resolve_side(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    side: ConflictSideDto,
) -> Result<(), IpcError> {
    let side = match side {
        ConflictSideDto::Ours => ConflictSide::Ours,
        ConflictSideDto::Theirs => ConflictSide::Theirs,
    };
    state
        .core()?
        .core
        .resolve_side(SessionId(session), &path, side)
        .await?;
    Ok(())
}

/// 삭제 충돌: 남기기/지우기 (CF-11)
#[tauri::command]
#[specta::specta]
pub async fn resolve_delete(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    keep: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .resolve_delete(SessionId(session), &path, keep)
        .await?;
    Ok(())
}

/// 다시 충돌 상태로 (CF-26)
#[tauri::command]
#[specta::specta]
pub async fn unresolve(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    mode: UnresolveModeDto,
) -> Result<(), IpcError> {
    let mode = match mode {
        UnresolveModeDto::Remake => UnresolveMode::Remake,
        UnresolveModeDto::KeepWorktree => UnresolveMode::KeepWorktree,
    };
    state
        .core()?
        .core
        .unresolve(SessionId(session), &path, mode)
        .await?;
    Ok(())
}
