//! 충돌 해결 보조 커맨드 (Phase 2 D2)

use mgit_core::{
    AutoSuggestion, BlockClass, ConflictOrigins, ConflictRule, KeptResolution, Oid, OriginCommit,
    RenameConflict, RerereStatus, ResolutionReview, RuleAction, RuleResult, SessionId,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_conflict::ConflictSideDto;
use crate::error::IpcError;
use crate::state::AppState;

/// 이름 변경 충돌 묶음
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameConflictDto {
    pub base_path: String,
    pub ours_path: String,
    pub theirs_path: String,
}

impl From<RenameConflict> for RenameConflictDto {
    /// 코어 → wire
    fn from(r: RenameConflict) -> Self {
        RenameConflictDto {
            base_path: r.base_path,
            ours_path: r.ours_path,
            theirs_path: r.theirs_path,
        }
    }
}

/// 출처 commit
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OriginCommitDto {
    pub oid: String,
    pub subject: String,
    pub author: String,
    #[specta(type = f64)]
    pub time: i64,
}

impl From<OriginCommit> for OriginCommitDto {
    /// 코어 → wire
    fn from(c: OriginCommit) -> Self {
        OriginCommitDto {
            oid: c.oid.to_hex(),
            subject: c.subject,
            author: c.author,
            time: c.time,
        }
    }
}

/// 충돌 출처
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictOriginsDto {
    pub ours: Vec<OriginCommitDto>,
    pub theirs: Vec<OriginCommitDto>,
    pub current: Option<OriginCommitDto>,
}

impl From<ConflictOrigins> for ConflictOriginsDto {
    /// 코어 → wire
    fn from(o: ConflictOrigins) -> Self {
        ConflictOriginsDto {
            ours: o.ours.into_iter().map(Into::into).collect(),
            theirs: o.theirs.into_iter().map(Into::into).collect(),
            current: o.current.map(Into::into),
        }
    }
}

/// 규칙 동작
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuleActionDto {
    Ours,
    Theirs,
    Union,
    Command { cmd: String },
}

/// 경로별 규칙
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRuleDto {
    pub glob: String,
    pub action: RuleActionDto,
}

impl From<ConflictRule> for ConflictRuleDto {
    /// 코어 → wire
    fn from(r: ConflictRule) -> Self {
        ConflictRuleDto {
            glob: r.glob,
            action: match r.action {
                RuleAction::Ours => RuleActionDto::Ours,
                RuleAction::Theirs => RuleActionDto::Theirs,
                RuleAction::Union => RuleActionDto::Union,
                RuleAction::Command { cmd } => RuleActionDto::Command { cmd },
            },
        }
    }
}

impl From<ConflictRuleDto> for ConflictRule {
    /// wire → 코어
    fn from(r: ConflictRuleDto) -> Self {
        ConflictRule {
            glob: r.glob,
            action: match r.action {
                RuleActionDto::Ours => RuleAction::Ours,
                RuleActionDto::Theirs => RuleAction::Theirs,
                RuleActionDto::Union => RuleAction::Union,
                RuleActionDto::Command { cmd } => RuleAction::Command { cmd },
            },
        }
    }
}

/// 규칙 적용 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuleResultDto {
    pub path: String,
    pub glob: String,
    pub ok: bool,
    pub message: String,
}

impl From<RuleResult> for RuleResultDto {
    /// 코어 → wire
    fn from(r: RuleResult) -> Self {
        RuleResultDto {
            path: r.path,
            glob: r.glob,
            ok: r.ok,
            message: r.message,
        }
    }
}

/// 해결 리뷰
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionReviewDto {
    pub path: String,
    pub auto: String,
    pub resolved: String,
    pub diff: String,
    pub auto_had_conflicts: bool,
}

impl From<ResolutionReview> for ResolutionReviewDto {
    /// 코어 → wire
    fn from(r: ResolutionReview) -> Self {
        ResolutionReviewDto {
            path: r.path,
            auto: r.auto,
            resolved: r.resolved,
            diff: r.diff,
            auto_had_conflicts: r.auto_had_conflicts,
        }
    }
}

/// 보관된 해결
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeptResolutionDto {
    pub path: String,
    pub op_key: String,
    pub resolved: String,
    #[specta(type = f64)]
    pub time: i64,
    pub matches_current: bool,
}

impl From<KeptResolution> for KeptResolutionDto {
    /// 코어 → wire
    fn from(k: KeptResolution) -> Self {
        KeptResolutionDto {
            path: k.path,
            op_key: k.op_key,
            resolved: k.resolved.to_hex(),
            time: k.time,
            matches_current: k.matches_current,
        }
    }
}

/// rerere 상태
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RerereStatusDto {
    pub enabled: bool,
    pub autoupdate: bool,
    pub resolved_paths: Vec<String>,
}

impl From<RerereStatus> for RerereStatusDto {
    /// 코어 → wire
    fn from(r: RerereStatus) -> Self {
        RerereStatusDto {
            enabled: r.enabled,
            autoupdate: r.autoupdate,
            resolved_paths: r.resolved_paths,
        }
    }
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 이름 변경 충돌 묶음 (CF-16)
#[tauri::command]
#[specta::specta]
pub async fn rename_conflicts(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<RenameConflictDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .rename_conflicts(SessionId(session))
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 이름 변경 충돌 해결. 남긴 경로
#[tauri::command]
#[specta::specta]
pub async fn resolve_rename(
    state: State<'_, AppState>,
    session: u32,
    conflict: RenameConflictDto,
    keep: ConflictSideDto,
) -> Result<String, IpcError> {
    let rc = RenameConflict {
        base_path: conflict.base_path,
        ours_path: conflict.ours_path,
        theirs_path: conflict.theirs_path,
    };
    Ok(state
        .core()?
        .core
        .resolve_rename(SessionId(session), &rc, keep.into())
        .await?)
}

/// 충돌 출처 (CF-17)
#[tauri::command]
#[specta::specta]
pub async fn conflict_origins(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<ConflictOriginsDto, IpcError> {
    Ok(state
        .core()?
        .core
        .conflict_origins(SessionId(session), &path)
        .await?
        .into())
}

/// 경로별 규칙 (CF-18)
#[tauri::command]
#[specta::specta]
pub async fn conflict_rules(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<ConflictRuleDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .conflict_rules(SessionId(session))?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 규칙 저장
#[tauri::command]
#[specta::specta]
pub async fn conflict_rules_set(
    state: State<'_, AppState>,
    session: u32,
    rules: Vec<ConflictRuleDto>,
) -> Result<(), IpcError> {
    let rules: Vec<ConflictRule> = rules.into_iter().map(Into::into).collect();
    state
        .core()?
        .core
        .set_conflict_rules(SessionId(session), &rules)?;
    Ok(())
}

/// 규칙 적용
#[tauri::command]
#[specta::specta]
pub async fn conflict_rules_apply(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<RuleResultDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .apply_conflict_rules(SessionId(session))
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 설정된 외부 병합 도구 이름
#[tauri::command]
#[specta::specta]
pub async fn merge_tool_name(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<String>, IpcError> {
    Ok(state
        .core()?
        .core
        .merge_tool_name(SessionId(session))
        .await?)
}

/// 외부 병합 도구 열기 (CF-19)
#[tauri::command]
#[specta::specta]
pub async fn open_mergetool(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .open_mergetool(SessionId(session), &path)
        .await?;
    Ok(())
}

/// 해결 내역 리뷰 (CF-27)
#[tauri::command]
#[specta::specta]
pub async fn resolution_review(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<ResolutionReviewDto, IpcError> {
    Ok(state
        .core()?
        .core
        .resolution_review(SessionId(session), &path)
        .await?
        .into())
}

/// 머지 commit 의 remerge-diff
#[tauri::command]
#[specta::specta]
pub async fn remerge_diff(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<String, IpcError> {
    Ok(state
        .core()?
        .core
        .remerge_diff(SessionId(session), &parse_oid(&oid)?)
        .await?)
}

/// 보관된 해결 목록 (CF-28)
#[tauri::command]
#[specta::specta]
pub async fn kept_resolutions(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<KeptResolutionDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .kept_resolutions(SessionId(session))
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 보관된 해결 재적용. 적용한 수
#[tauri::command]
#[specta::specta]
pub async fn reapply_resolutions(
    state: State<'_, AppState>,
    session: u32,
) -> Result<u32, IpcError> {
    Ok(state
        .core()?
        .core
        .reapply_resolutions(SessionId(session))
        .await?)
}

/// 보관된 해결 모두 지우기
#[tauri::command]
#[specta::specta]
pub async fn kept_clear(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.kept_clear(SessionId(session)).await?;
    Ok(())
}

/// rerere 상태 (CF-29)
#[tauri::command]
#[specta::specta]
pub async fn rerere_status(
    state: State<'_, AppState>,
    session: u32,
) -> Result<RerereStatusDto, IpcError> {
    Ok(state
        .core()?
        .core
        .rerere_status(SessionId(session))
        .await?
        .into())
}

/// rerere 설정
#[tauri::command]
#[specta::specta]
pub async fn rerere_set(
    state: State<'_, AppState>,
    session: u32,
    enabled: bool,
    autoupdate: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .rerere_set(SessionId(session), enabled, autoupdate)
        .await?;
    Ok(())
}

/// rerere 기록 잊기
#[tauri::command]
#[specta::specta]
pub async fn rerere_forget(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .rerere_forget(SessionId(session), &path)
        .await?;
    Ok(())
}

/// 블록 분류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BlockClassDto {
    Identical,
    OursOnly,
    TheirsOnly,
    WhitespaceOnly,
    Adjacent,
    Real,
}

/// 자동 결합 제안의 해결
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutoResolutionDto {
    Ours,
    Theirs,
    Custom { lines: Vec<String> },
}

/// 블록 분류 + 제안
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoSuggestionDto {
    pub index: u32,
    pub class: BlockClassDto,
    pub resolution: Option<AutoResolutionDto>,
}

impl From<AutoSuggestion> for AutoSuggestionDto {
    /// 코어 → wire. Ours/Theirs/Custom 이외의 해결은 제안하지 않는다
    fn from(a: AutoSuggestion) -> Self {
        use mgit_core::Resolution;
        AutoSuggestionDto {
            index: a.index as u32,
            class: match a.class {
                BlockClass::Identical => BlockClassDto::Identical,
                BlockClass::OursOnly => BlockClassDto::OursOnly,
                BlockClass::TheirsOnly => BlockClassDto::TheirsOnly,
                BlockClass::WhitespaceOnly => BlockClassDto::WhitespaceOnly,
                BlockClass::Adjacent => BlockClassDto::Adjacent,
                BlockClass::Real => BlockClassDto::Real,
            },
            resolution: a.resolution.and_then(|r| match r {
                Resolution::Ours => Some(AutoResolutionDto::Ours),
                Resolution::Theirs => Some(AutoResolutionDto::Theirs),
                Resolution::Custom { lines } => Some(AutoResolutionDto::Custom { lines }),
                _ => None,
            }),
        }
    }
}
