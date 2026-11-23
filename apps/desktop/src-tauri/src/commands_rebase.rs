//! 인터랙티브 리베이스·빠른 이력 수정·워크트리 WIP 커맨드 (Phase 2 A2)

use mgit_core::{Oid, RebaseAction, RebasePlan, RebaseStep, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_refs::OpOutcome;
use crate::dto::StatusSummary;
use crate::error::IpcError;
use crate::state::AppState;

/// 플랜 편집기용 커밋
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub oid: String,
    pub subject: String,
    pub author_name: String,
}

/// todo 동작
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RebaseActionDto {
    Pick,
    Reword { message: String },
    Edit,
    Squash,
    Fixup,
    Drop,
}

/// 플랜 한 줄
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStepDto {
    pub oid: String,
    pub action: RebaseActionDto,
}

/// 플랜
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanDto {
    pub onto: Option<String>,
    pub steps: Vec<RebaseStepDto>,
    pub autostash: bool,
    pub update_refs: bool,
    pub exec: Option<String>,
}

/// 플랜 편집기 조회 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanInfo {
    pub commits: Vec<PlanCommit>,
    /// 구간에 머지 커밋이 있다. 실행하면 평탄화된다
    pub has_merges: bool,
}

/// 다른 워크트리의 WIP
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeWip {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub summary: StatusSummary,
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// `onto..HEAD` 커밋 (todo 순서)과 구간의 머지 여부
#[tauri::command]
#[specta::specta]
pub async fn rebase_plan_commits(
    state: State<'_, AppState>,
    session: u32,
    onto: Option<String>,
) -> Result<RebasePlanInfo, IpcError> {
    let info = state
        .core()?
        .core
        .rebase_plan_info(SessionId(session), onto.as_deref())
        .await?;
    Ok(RebasePlanInfo {
        commits: info
            .commits
            .into_iter()
            .map(|c| PlanCommit {
                oid: c.oid.to_hex(),
                subject: c.subject,
                author_name: c.author_name,
            })
            .collect(),
        has_merges: info.has_merges,
    })
}

/// 인터랙티브 리베이스 실행 (MRG-07)
#[tauri::command]
#[specta::specta]
pub async fn rebase_interactive(
    state: State<'_, AppState>,
    session: u32,
    plan: RebasePlanDto,
) -> Result<OpOutcome, IpcError> {
    let mut steps = Vec::with_capacity(plan.steps.len());
    for s in plan.steps {
        steps.push(RebaseStep {
            oid: parse_oid(&s.oid)?,
            action: match s.action {
                RebaseActionDto::Pick => RebaseAction::Pick,
                RebaseActionDto::Reword { message } => RebaseAction::Reword { message },
                RebaseActionDto::Edit => RebaseAction::Edit,
                RebaseActionDto::Squash => RebaseAction::Squash,
                RebaseActionDto::Fixup => RebaseAction::Fixup,
                RebaseActionDto::Drop => RebaseAction::Drop,
            },
        });
    }
    let core_plan = RebasePlan {
        onto: plan.onto,
        steps,
        autostash: plan.autostash,
        update_refs: plan.update_refs,
        exec: plan.exec.filter(|c| !c.trim().is_empty()),
    };
    Ok(state
        .core()?
        .core
        .rebase_interactive(SessionId(session), &core_plan)
        .await?
        .into())
}

/// 커밋 메시지만 바꾸기 (MRG-09)
#[tauri::command]
#[specta::specta]
pub async fn reword_commit(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
    message: String,
) -> Result<OpOutcome, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .reword_commit(SessionId(session), &oid, &message)
        .await?
        .into())
}

/// 부모 커밋에 합치기 (MRG-09)
#[tauri::command]
#[specta::specta]
pub async fn squash_into_parent(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<OpOutcome, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .squash_into_parent(SessionId(session), &oid)
        .await?
        .into())
}

/// 다른 워크트리의 WIP (WT-06)
#[tauri::command]
#[specta::specta]
pub async fn worktree_wips(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<WorktreeWip>, IpcError> {
    let list = state.core()?.core.worktree_wips(SessionId(session)).await?;
    Ok(list
        .into_iter()
        .map(|w| WorktreeWip {
            path: w.path.display().to_string(),
            branch: w.branch,
            head: w.head.to_hex(),
            summary: w.summary.into(),
        })
        .collect())
}
