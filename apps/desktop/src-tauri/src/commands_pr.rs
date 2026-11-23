//! PR/MR·아바타 커맨드 (Phase 2 B2)

use std::path::PathBuf;

use mgit_core::{CreatePr, PrTemplate, PullRequest, RemoteProject, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_hosting::HostKindDto;
use crate::error::IpcError;
use crate::state::AppState;

/// 원격 프로젝트
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectDto {
    pub account_id: Option<String>,
    pub kind: HostKindDto,
    pub host: String,
    pub project: String,
    pub remote: String,
}

impl From<RemoteProject> for RemoteProjectDto {
    /// 코어 → wire
    fn from(p: RemoteProject) -> Self {
        RemoteProjectDto {
            account_id: p.account_id,
            kind: p.kind.into(),
            host: p.host,
            project: p.project,
            remote: p.remote,
        }
    }
}

/// PR/MR
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDto {
    #[specta(type = f64)]
    pub number: u64,
    pub title: String,
    pub draft: bool,
    pub author: String,
    pub author_avatar: Option<String>,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub head_repo: Option<String>,
    pub cross_repo: bool,
    pub web_url: String,
    pub updated_at: Option<String>,
    pub review: Option<String>,
    pub checks: Option<String>,
    pub mergeable: Option<bool>,
    pub labels: Vec<String>,
}

impl From<PullRequest> for PullRequestDto {
    /// 코어 → wire
    fn from(p: PullRequest) -> Self {
        PullRequestDto {
            number: p.number,
            title: p.title,
            draft: p.draft,
            author: p.author,
            author_avatar: p.author_avatar,
            head_ref: p.head_ref,
            head_sha: p.head_sha,
            base_ref: p.base_ref,
            head_repo: p.head_repo,
            cross_repo: p.cross_repo,
            web_url: p.web_url,
            updated_at: p.updated_at,
            review: p.review,
            checks: p.checks,
            mergeable: p.mergeable,
            labels: p.labels,
        }
    }
}

/// 템플릿
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PrTemplateDto {
    pub name: String,
    pub body: String,
}

/// PR 만들기 입력
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrDto {
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

/// 세션 원격의 호스팅 프로젝트 (없으면 null)
#[tauri::command]
#[specta::specta]
pub async fn hosting_remote_project(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<RemoteProjectDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .remote_project(SessionId(session))?
        .map(Into::into))
}

/// 열린 PR/MR (HO-02)
#[tauri::command]
#[specta::specta]
pub async fn pull_requests(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<PullRequestDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .pull_requests(SessionId(session))
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// PR 본문 템플릿 (HO-03)
#[tauri::command]
#[specta::specta]
pub async fn pr_templates(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<PrTemplateDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .pr_templates(SessionId(session))?
        .into_iter()
        .map(|t: PrTemplate| PrTemplateDto {
            name: t.name,
            body: t.body,
        })
        .collect())
}

/// PR/MR 만들기 (HO-03)
#[tauri::command]
#[specta::specta]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    session: u32,
    spec: CreatePrDto,
) -> Result<PullRequestDto, IpcError> {
    Ok(state
        .core()?
        .core
        .create_pull_request(
            SessionId(session),
            CreatePr {
                head: spec.head,
                base: spec.base,
                title: spec.title,
                body: spec.body,
                draft: spec.draft,
            },
        )
        .await?
        .into())
}

/// PR/MR 체크아웃 (HO-04). 만든 브랜치 이름
#[tauri::command]
#[specta::specta]
pub async fn checkout_pull_request(
    state: State<'_, AppState>,
    session: u32,
    number: u32,
    worktree: Option<String>,
) -> Result<String, IpcError> {
    let path = worktree.map(PathBuf::from);
    Ok(state
        .core()?
        .core
        .checkout_pull_request(SessionId(session), u64::from(number), path.as_deref())
        .await?)
}

/// 이메일의 아바타 data URI (GRAPH-11). 없으면 null
#[tauri::command]
#[specta::specta]
pub async fn avatar(state: State<'_, AppState>, email: String) -> Result<Option<String>, IpcError> {
    Ok(state.core()?.core.avatar(&email).await?)
}
