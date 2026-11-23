//! 충돌 예방 커맨드 (Phase 2 D1)

use mgit_core::{MergePreview, Oid, RadarEntry, RadarKind, RebaseStepPreview, SessionId};
use serde::Serialize;
use tauri::State;

use crate::commands_refs::{MergeModeDto, OpOutcome};
use crate::error::IpcError;
use crate::state::AppState;

/// 병합 미리보기
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewDto {
    pub ours: String,
    pub theirs: String,
    pub clean: bool,
    pub conflicts: Vec<String>,
    pub tree: String,
    pub messages: Vec<String>,
    pub strategy: Vec<String>,
    pub wip_included: bool,
}

impl From<MergePreview> for MergePreviewDto {
    /// 코어 → wire
    fn from(p: MergePreview) -> Self {
        MergePreviewDto {
            ours: p.ours,
            theirs: p.theirs,
            clean: p.clean,
            conflicts: p.conflicts,
            tree: p.tree.to_hex(),
            messages: p.messages,
            strategy: p.strategy,
            wip_included: p.wip_included,
        }
    }
}

/// 레이더 종류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RadarKindDto {
    Upstream,
    Default,
    Local,
    Worktree,
}

/// 레이더 한 줄
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RadarEntryDto {
    pub reference: String,
    pub kind: RadarKindDto,
    pub clean: bool,
    pub conflicts: Vec<String>,
    pub behind: u32,
    pub ahead: u32,
}

impl From<RadarEntry> for RadarEntryDto {
    /// 코어 → wire
    fn from(r: RadarEntry) -> Self {
        RadarEntryDto {
            reference: r.reference,
            kind: match r.kind {
                RadarKind::Upstream => RadarKindDto::Upstream,
                RadarKind::Default => RadarKindDto::Default,
                RadarKind::Local => RadarKindDto::Local,
                RadarKind::Worktree => RadarKindDto::Worktree,
            },
            clean: r.clean,
            conflicts: r.conflicts,
            behind: r.behind,
            ahead: r.ahead,
        }
    }
}

/// rebase 예측 단계
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStepPreviewDto {
    pub oid: String,
    pub subject: String,
    pub clean: bool,
    pub conflicts: Vec<String>,
    pub approximate: bool,
}

impl From<RebaseStepPreview> for RebaseStepPreviewDto {
    /// 코어 → wire
    fn from(s: RebaseStepPreview) -> Self {
        RebaseStepPreviewDto {
            oid: s.oid.to_hex(),
            subject: s.subject,
            clean: s.clean,
            conflicts: s.conflicts,
            approximate: s.approximate,
        }
    }
}

/// 격리 병합 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedMergeDto {
    pub worktree: String,
    pub branch: String,
    pub outcome: OpOutcome,
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 병합 미리보기 (CF-01·04)
#[tauri::command]
#[specta::specta]
pub async fn merge_preview(
    state: State<'_, AppState>,
    session: u32,
    reference: String,
    strategy: Vec<String>,
    include_wip: bool,
) -> Result<MergePreviewDto, IpcError> {
    Ok(state
        .core()?
        .core
        .merge_preview(SessionId(session), &reference, &strategy, include_wip)
        .await?
        .into())
}

/// 옵션 시뮬레이터 (CF-04)
#[tauri::command]
#[specta::specta]
pub async fn merge_simulate(
    state: State<'_, AppState>,
    session: u32,
    reference: String,
    include_wip: bool,
) -> Result<Vec<MergePreviewDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .merge_simulate(SessionId(session), &reference, include_wip)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 미리보기 tree 의 파일 내용
#[tauri::command]
#[specta::specta]
pub async fn preview_file(
    state: State<'_, AppState>,
    session: u32,
    tree: String,
    path: String,
) -> Result<String, IpcError> {
    Ok(state
        .core()?
        .core
        .preview_file(SessionId(session), &parse_oid(&tree)?, &path)
        .await?)
}

/// 충돌 레이더 (CF-02)
#[tauri::command]
#[specta::specta]
pub async fn conflict_radar(
    state: State<'_, AppState>,
    session: u32,
    max: u32,
    include_wip: bool,
) -> Result<Vec<RadarEntryDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .conflict_radar(SessionId(session), max as usize, include_wip)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// rebase 예측 (CF-03)
#[tauri::command]
#[specta::specta]
pub async fn rebase_preview(
    state: State<'_, AppState>,
    session: u32,
    onto: String,
) -> Result<Vec<RebaseStepPreviewDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .rebase_preview(SessionId(session), &onto)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 격리 병합 (CF-05)
#[tauri::command]
#[specta::specta]
pub async fn isolated_merge(
    state: State<'_, AppState>,
    session: u32,
    reference: String,
    mode: MergeModeDto,
) -> Result<IsolatedMergeDto, IpcError> {
    let r = state
        .core()?
        .core
        .isolated_merge(SessionId(session), &reference, mode.into())
        .await?;
    Ok(IsolatedMergeDto {
        worktree: r.worktree.display().to_string(),
        branch: r.branch,
        outcome: r.outcome.into(),
    })
}

/// 이 세션이 격리 병합 워크트리면 branch 이름
#[tauri::command]
#[specta::specta]
pub async fn isolated_info(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<String>, IpcError> {
    Ok(state
        .core()?
        .core
        .isolated_info(SessionId(session))?
        .map(|(branch, _)| branch))
}

/// 격리 병합 반영. 메인 워크트리 경로
#[tauri::command]
#[specta::specta]
pub async fn isolated_apply(state: State<'_, AppState>, session: u32) -> Result<String, IpcError> {
    Ok(state
        .core()?
        .core
        .isolated_apply(SessionId(session))
        .await?
        .display()
        .to_string())
}

/// 격리 병합 버리기. 메인 워크트리 경로
#[tauri::command]
#[specta::specta]
pub async fn isolated_discard(
    state: State<'_, AppState>,
    session: u32,
) -> Result<String, IpcError> {
    Ok(state
        .core()?
        .core
        .isolated_discard(SessionId(session))
        .await?
        .display()
        .to_string())
}

/// `-X` 옵션 merge (CF-04)
#[tauri::command]
#[specta::specta]
pub async fn merge_with_options(
    state: State<'_, AppState>,
    session: u32,
    reference: String,
    mode: MergeModeDto,
    strategy: Vec<String>,
) -> Result<OpOutcome, IpcError> {
    Ok(state
        .core()?
        .core
        .merge_with(SessionId(session), &reference, mode.into(), &strategy)
        .await?
        .into())
}
