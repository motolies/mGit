//! 설정·서명·비밀 스캔·알림 커맨드 (Phase 2 A4)

use mgit_core::{Oid, SecretIgnore, SessionId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

use crate::error::IpcError;
use crate::state::AppState;

/// 서명 설정
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    pub format: String,
    pub signing_key: Option<String>,
    pub commit_sign: bool,
    pub tag_sign: bool,
}

impl From<mgit_core::SigningInfo> for SigningInfo {
    /// 코어 → wire
    fn from(s: mgit_core::SigningInfo) -> Self {
        SigningInfo {
            format: s.format,
            signing_key: s.signing_key,
            commit_sign: s.commit_sign,
            tag_sign: s.tag_sign,
        }
    }
}

/// 서명 검증 결과 (`%G?`)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SignatureStatus {
    pub code: String,
    pub signer: String,
    pub key: String,
}

/// 비밀 정보 적중
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretHit {
    pub path: String,
    pub line: u32,
    pub rule: String,
    pub snippet: String,
}

/// 비밀 스캔 무시 규칙
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretIgnoreDto {
    pub rule: Option<String>,
    pub path: Option<String>,
}

/// hook 파일
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub name: String,
    pub path: String,
    pub executable: bool,
}

/// 상태 조회 최적화
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PerfStatus {
    pub fsmonitor: bool,
    pub untracked_cache: bool,
    pub tracked_files: u32,
    pub suggested: bool,
}

impl From<mgit_core::PerfStatus> for PerfStatus {
    /// 코어 → wire
    fn from(p: mgit_core::PerfStatus) -> Self {
        PerfStatus {
            fsmonitor: p.fsmonitor,
            untracked_cache: p.untracked_cache,
            tracked_files: p.tracked_files,
            suggested: p.suggested,
        }
    }
}

/// 저장소 설정
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSettings {
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub local_user_name: Option<String>,
    pub local_user_email: Option<String>,
    pub hooks_path: Option<String>,
    pub hooks: Vec<HookInfo>,
    pub gitignore: Option<String>,
    pub perf: PerfStatus,
    pub shallow: bool,
    pub signing: SigningInfo,
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 서명 설정 (CHG-08)
#[tauri::command]
#[specta::specta]
pub async fn signing_info(
    state: State<'_, AppState>,
    session: u32,
) -> Result<SigningInfo, IpcError> {
    Ok(state
        .core()?
        .core
        .signing_info(SessionId(session))
        .await?
        .into())
}

/// 커밋 서명 검증 (CHG-08)
#[tauri::command]
#[specta::specta]
pub async fn commit_signature(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<SignatureStatus, IpcError> {
    let s = state
        .core()?
        .core
        .commit_signature(SessionId(session), &parse_oid(&oid)?)
        .await?;
    Ok(SignatureStatus {
        code: s.code,
        signer: s.signer,
        key: s.key,
    })
}

/// staged 변경의 비밀 정보 스캔 (CHG-09)
#[tauri::command]
#[specta::specta]
pub async fn scan_staged_secrets(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<SecretHit>, IpcError> {
    let hits = state
        .core()?
        .core
        .scan_staged_secrets(SessionId(session))
        .await?;
    Ok(hits
        .into_iter()
        .map(|h| SecretHit {
            path: h.path,
            line: h.line,
            rule: h.rule,
            snippet: h.snippet,
        })
        .collect())
}

/// 비밀 스캔 무시 규칙 (앱 설정)
#[tauri::command]
#[specta::specta]
pub async fn secret_ignores(state: State<'_, AppState>) -> Result<Vec<SecretIgnoreDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .secret_ignores()
        .into_iter()
        .map(|i| SecretIgnoreDto {
            rule: i.rule,
            path: i.path,
        })
        .collect())
}

/// 비밀 스캔 무시 규칙 저장
#[tauri::command]
#[specta::specta]
pub async fn secret_ignores_set(
    state: State<'_, AppState>,
    list: Vec<SecretIgnoreDto>,
) -> Result<(), IpcError> {
    let list: Vec<SecretIgnore> = list
        .into_iter()
        .map(|i| SecretIgnore {
            rule: i.rule,
            path: i.path,
        })
        .collect();
    state.core()?.core.set_secret_ignores(&list)?;
    Ok(())
}

/// 저장소 설정 묶음 (REPO-07)
#[tauri::command]
#[specta::specta]
pub async fn repo_settings(
    state: State<'_, AppState>,
    session: u32,
) -> Result<RepoSettings, IpcError> {
    let r = state.core()?.core.repo_settings(SessionId(session)).await?;
    Ok(RepoSettings {
        user_name: r.user_name,
        user_email: r.user_email,
        local_user_name: r.local_user_name,
        local_user_email: r.local_user_email,
        hooks_path: r.hooks_path,
        hooks: r
            .hooks
            .into_iter()
            .map(|h| HookInfo {
                name: h.name,
                path: h.path.display().to_string(),
                executable: h.executable,
            })
            .collect(),
        gitignore: r.gitignore,
        perf: r.perf.into(),
        shallow: r.shallow,
        signing: r.signing.into(),
    })
}

/// 저장소 사용자 이름·이메일 (local)
#[tauri::command]
#[specta::specta]
pub async fn set_user(
    state: State<'_, AppState>,
    session: u32,
    name: String,
    email: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_user(SessionId(session), &name, &email)
        .await?;
    Ok(())
}

/// `.gitignore` 쓰기
#[tauri::command]
#[specta::specta]
pub async fn write_gitignore(
    state: State<'_, AppState>,
    session: u32,
    text: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .write_gitignore(SessionId(session), &text)
        .await?;
    Ok(())
}

/// 상태 조회 최적화 상태 (AD-07)
#[tauri::command]
#[specta::specta]
pub async fn perf_status(state: State<'_, AppState>, session: u32) -> Result<PerfStatus, IpcError> {
    Ok(state
        .core()?
        .core
        .perf_status(SessionId(session))
        .await?
        .into())
}

/// fsmonitor·untrackedCache 켜기 (AD-07)
#[tauri::command]
#[specta::specta]
pub async fn enable_perf(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.enable_perf(SessionId(session)).await?;
    Ok(())
}

/// 얕은 복제 → 전체 이력 (REPO-03). 끝난 뒤 얕은지 여부
#[tauri::command]
#[specta::specta]
pub async fn unshallow(state: State<'_, AppState>, session: u32) -> Result<bool, IpcError> {
    Ok(state.core()?.core.unshallow(SessionId(session)).await?)
}

/// OS 알림 (UX-09)
#[tauri::command]
#[specta::specta]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), IpcError> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| IpcError::Internal {
            message: e.to_string(),
        })?;
    Ok(())
}
