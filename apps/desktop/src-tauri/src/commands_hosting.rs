//! 호스팅 계정·프로필·SSH 키·원격 저장소 목록 커맨드 (Phase 2 B1)

use mgit_core::{DeviceCodes, HostKind, HostingAccount, OauthConfig, Profile, RepoPage, SessionId};
use mgit_l10n::tr;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// 호스팅 종류
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum HostKindDto {
    Github,
    Gitlab,
}

impl From<HostKindDto> for HostKind {
    /// wire → 코어
    fn from(k: HostKindDto) -> Self {
        match k {
            HostKindDto::Github => HostKind::GitHub,
            HostKindDto::Gitlab => HostKind::GitLab,
        }
    }
}

impl From<HostKind> for HostKindDto {
    /// 코어 → wire
    fn from(k: HostKind) -> Self {
        match k {
            HostKind::GitHub => HostKindDto::Github,
            HostKind::GitLab => HostKindDto::Gitlab,
        }
    }
}

/// 연결된 계정
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingAccountDto {
    pub id: String,
    pub kind: HostKindDto,
    pub host: String,
    pub user: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub web_url: Option<String>,
}

impl From<HostingAccount> for HostingAccountDto {
    /// 코어 → wire
    fn from(a: HostingAccount) -> Self {
        HostingAccountDto {
            id: a.id,
            kind: a.kind.into(),
            host: a.host,
            user: a.user,
            name: a.name,
            avatar_url: a.avatar_url,
            web_url: a.web_url,
        }
    }
}

/// OAuth App 설정
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OauthConfigDto {
    pub github_client_id: Option<String>,
    pub gitlab_client_id: Option<String>,
}

/// 프로필
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDto {
    pub id: String,
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    pub signing_key: Option<String>,
    pub hosting_account: Option<String>,
}

impl From<Profile> for ProfileDto {
    /// 코어 → wire
    fn from(p: Profile) -> Self {
        ProfileDto {
            id: p.id,
            name: p.name,
            user_name: p.user_name,
            user_email: p.user_email,
            signing_key: p.signing_key,
            hosting_account: p.hosting_account,
        }
    }
}

impl From<ProfileDto> for Profile {
    /// wire → 코어
    fn from(p: ProfileDto) -> Self {
        Profile {
            id: p.id,
            name: p.name,
            user_name: p.user_name,
            user_email: p.user_email,
            signing_key: p.signing_key,
            hosting_account: p.hosting_account,
        }
    }
}

/// SSH 키
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfoDto {
    pub path: String,
    pub public_key: String,
    pub kind: String,
    pub comment: String,
}

/// 저장소 요약
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummaryDto {
    pub full_name: String,
    pub name: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub clone_url: String,
    pub ssh_url: String,
    pub web_url: String,
    pub default_branch: Option<String>,
    pub updated_at: Option<String>,
    pub stars: u32,
}

/// 저장소 목록 한 쪽
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoPageDto {
    pub repos: Vec<RepoSummaryDto>,
    pub next_page: Option<u32>,
}

impl From<RepoPage> for RepoPageDto {
    /// 코어 → wire
    fn from(p: RepoPage) -> Self {
        RepoPageDto {
            repos: p
                .repos
                .into_iter()
                .map(|r| RepoSummaryDto {
                    full_name: r.full_name,
                    name: r.name,
                    description: r.description,
                    private: r.private,
                    fork: r.fork,
                    clone_url: r.clone_url,
                    ssh_url: r.ssh_url,
                    web_url: r.web_url,
                    default_branch: r.default_branch,
                    updated_at: r.updated_at,
                    stars: r.stars,
                })
                .collect(),
            next_page: p.next_page,
        }
    }
}

/// 디바이스 플로우 코드 (시작 → 사용자 입력 → 완료에 다시 넘긴다)
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodesDto {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    #[specta(type = f64)]
    pub expires_in: u64,
    #[specta(type = f64)]
    pub interval: u64,
}

impl From<DeviceCodes> for DeviceCodesDto {
    /// 코어 → wire
    fn from(c: DeviceCodes) -> Self {
        DeviceCodesDto {
            device_code: c.device_code,
            user_code: c.user_code,
            verification_uri: c.verification_uri,
            verification_uri_complete: c.verification_uri_complete,
            expires_in: c.expires_in,
            interval: c.interval,
        }
    }
}

impl From<DeviceCodesDto> for DeviceCodes {
    /// wire → 코어
    fn from(c: DeviceCodesDto) -> Self {
        DeviceCodes {
            device_code: c.device_code,
            user_code: c.user_code,
            verification_uri: c.verification_uri,
            verification_uri_complete: c.verification_uri_complete,
            expires_in: c.expires_in,
            interval: c.interval,
        }
    }
}

/// 호스팅 설정 페이지 URL
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingUrls {
    pub ssh_keys_url: String,
    pub token_url: String,
    pub default_host: String,
}

/// 연결된 계정 목록
#[tauri::command]
#[specta::specta]
pub async fn hosting_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<HostingAccountDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .hosting_accounts()
        .into_iter()
        .map(Into::into)
        .collect())
}

/// OAuth App 설정
#[tauri::command]
#[specta::specta]
pub async fn hosting_oauth(state: State<'_, AppState>) -> Result<OauthConfigDto, IpcError> {
    let c = state.core()?.core.hosting_oauth();
    Ok(OauthConfigDto {
        github_client_id: c.github_client_id,
        gitlab_client_id: c.gitlab_client_id,
    })
}

/// OAuth App 설정 저장
#[tauri::command]
#[specta::specta]
pub async fn hosting_oauth_set(
    state: State<'_, AppState>,
    config: OauthConfigDto,
) -> Result<(), IpcError> {
    state.core()?.core.set_hosting_oauth(&OauthConfig {
        github_client_id: config.github_client_id.filter(|s| !s.trim().is_empty()),
        gitlab_client_id: config.gitlab_client_id.filter(|s| !s.trim().is_empty()),
    })?;
    Ok(())
}

/// PAT 로 계정 추가 (AU-05)
#[tauri::command]
#[specta::specta]
pub async fn hosting_add_pat(
    state: State<'_, AppState>,
    kind: HostKindDto,
    host: String,
    token: String,
) -> Result<HostingAccountDto, IpcError> {
    Ok(state
        .core()?
        .core
        .hosting_add_pat(kind.into(), &host, &token)
        .await?
        .into())
}

/// 디바이스 플로우 시작
#[tauri::command]
#[specta::specta]
pub async fn hosting_device_start(
    state: State<'_, AppState>,
    kind: HostKindDto,
    host: String,
) -> Result<DeviceCodesDto, IpcError> {
    Ok(state
        .core()?
        .core
        .hosting_device_start(kind.into(), &host)
        .await?
        .into())
}

/// 디바이스 플로우 완료 (사용자가 코드를 넣을 때까지 기다린다)
#[tauri::command]
#[specta::specta]
pub async fn hosting_device_finish(
    state: State<'_, AppState>,
    kind: HostKindDto,
    host: String,
    codes: DeviceCodesDto,
) -> Result<HostingAccountDto, IpcError> {
    Ok(state
        .core()?
        .core
        .hosting_device_finish(kind.into(), &host, &codes.into())
        .await?
        .into())
}

/// 계정 제거
#[tauri::command]
#[specta::specta]
pub async fn hosting_remove(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.core.hosting_remove(&id)?;
    Ok(())
}

/// 계정의 저장소 목록 (HO-01)
#[tauri::command]
#[specta::specta]
pub async fn hosting_repos(
    state: State<'_, AppState>,
    account_id: String,
    page: u32,
    search: String,
) -> Result<RepoPageDto, IpcError> {
    Ok(state
        .core()?
        .core
        .hosting_repos(&account_id, page, &search)
        .await?
        .into())
}

/// 호스팅 설정 페이지 URL
#[tauri::command]
#[specta::specta]
pub fn hosting_urls(kind: HostKindDto, host: String) -> HostingUrls {
    let k: HostKind = kind.into();
    let h = if host.trim().is_empty() {
        k.default_host().to_string()
    } else {
        host
    };
    HostingUrls {
        ssh_keys_url: k.ssh_keys_url(&h),
        token_url: k.token_url(&h),
        default_host: k.default_host().to_string(),
    }
}

/// 프로필 목록 (AU-06)
#[tauri::command]
#[specta::specta]
pub async fn profiles(state: State<'_, AppState>) -> Result<Vec<ProfileDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .profiles()
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 프로필 목록 저장
#[tauri::command]
#[specta::specta]
pub async fn profiles_set(
    state: State<'_, AppState>,
    list: Vec<ProfileDto>,
) -> Result<Vec<ProfileDto>, IpcError> {
    let core = &state.core()?.core;
    let list: Vec<Profile> = list.into_iter().map(Into::into).collect();
    core.set_profiles(&list)?;
    Ok(core.profiles().into_iter().map(Into::into).collect())
}

/// 프로필을 저장소에 적용
#[tauri::command]
#[specta::specta]
pub async fn apply_profile(
    state: State<'_, AppState>,
    session: u32,
    profile_id: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .apply_profile(SessionId(session), &profile_id)
        .await?;
    Ok(())
}

/// SSH 키 목록 (AU-04)
#[tauri::command]
#[specta::specta]
pub async fn ssh_keys(state: State<'_, AppState>) -> Result<Vec<SshKeyInfoDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .ssh_keys()
        .into_iter()
        .map(|k| SshKeyInfoDto {
            path: k.path.display().to_string(),
            public_key: k.public_key,
            kind: k.kind,
            comment: k.comment,
        })
        .collect())
}

/// SSH 키 생성 (AU-04)
#[tauri::command]
#[specta::specta]
pub async fn ssh_keygen(
    state: State<'_, AppState>,
    name: String,
    comment: String,
    passphrase: String,
) -> Result<SshKeyInfoDto, IpcError> {
    let k = state
        .core()?
        .core
        .ssh_keygen(&name, &comment, &passphrase)
        .await?;
    Ok(SshKeyInfoDto {
        path: k.path.display().to_string(),
        public_key: k.public_key,
        kind: k.kind,
        comment: k.comment,
    })
}

/// 기본 브라우저로 URL 열기 (http/https 만)
#[tauri::command]
#[specta::specta]
pub fn open_url(url: String) -> Result<(), IpcError> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(IpcError::Internal {
            message: tr!("열 수 없는 URL: {url}", "Cannot open URL: {url}"),
        });
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}
