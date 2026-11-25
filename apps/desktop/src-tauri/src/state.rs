//! Tauri 관리 상태: 조립된 `mgit_core::Core` 와 셸이 따로 기억하는 정보.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use mgit_core::{
    AskpassService, Core, CoreConfig, CredentialPrompt, CredentialReply, CredentialRequest,
    KeyringVault, MemoryVault, PromptKind, SecretVault,
};
use mgit_git::{RunnerConfig, TokioGitRunner, login_shell_path};
use mgit_model::{MemoryStore, Store};
use mgit_store::SqliteStore;
use mgit_watch::NotifyWatcher;
use tokio::sync::oneshot;

use crate::app_events::{AppEvent, AppEvents};
use crate::error::IpcError;
use crate::runtime_profile::{RuntimeKind, RuntimeProfile};

/// 조립된 코어 핸들. `git_path` 는 코어가 노출하지 않으므로 셸이 보관한다
pub struct CoreHandle {
    pub core: Arc<Core>,
    pub git_path: String,
    /// askpass 환경 변수를 나중에 붙이기 위해 러너를 따로 잡아 둔다
    pub runner: Arc<TokioGitRunner>,
}

/// 자격 증명 대화상자 응답 허브: 코어의 `CredentialPrompt` 요청을 앱 이벤트로 보내고,
/// `credential_reply` 커맨드가 oneshot 으로 답한다
#[derive(Default)]
pub struct CredentialHub {
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<CredentialReply>>>>,
}

impl CredentialHub {
    /// 응답을 전달한다. 모르는 id 면 무시 (시간 초과로 이미 닫힘)
    pub fn reply(&self, id: u64, secret: Option<String>, remember: bool) {
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
        if let Some(tx) = tx {
            let _ = tx.send(Some(CredentialReply { secret, remember }));
        }
    }
}

/// 코어 → 앱 이벤트 → 프런트 대화상자 → `credential_reply`
struct TauriPrompt {
    events: Arc<AppEvents>,
    hub: Arc<CredentialHub>,
}

impl CredentialPrompt for TauriPrompt {
    fn ask(
        &self,
        request: CredentialRequest,
    ) -> Pin<Box<dyn Future<Output = Option<CredentialReply>> + Send>> {
        let (tx, rx) = oneshot::channel();
        self.hub
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(request.id, tx);
        let kind = match request.kind {
            PromptKind::Username => "username",
            PromptKind::Password => "password",
            PromptKind::Passphrase => "passphrase",
            PromptKind::Other => "other",
        };
        self.events.emit(AppEvent::CredentialRequested {
            req_id: u32::try_from(request.id).unwrap_or(u32::MAX),
            kind: kind.to_string(),
            target: request.target,
            prompt: request.prompt,
        });
        let hub = Arc::clone(&self.hub);
        let id = request.id;
        Box::pin(async move {
            let r = rx.await.ok().flatten();
            hub.pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
            r
        })
    }
}

/// 앱 전역 상태. 시작 시 git 탐색에 실패해도 앱은 뜨고, 커맨드가 그 오류를 돌려준다
pub struct AppState {
    core: Result<CoreHandle, IpcError>,
    /// 세션과 무관한 앱 이벤트 허브
    pub app_events: Arc<AppEvents>,
    /// 자격 증명 응답 허브
    pub credentials: Arc<CredentialHub>,
    /// askpass 소켓 서버 (git 탐색에 실패하면 없음)
    askpass: Option<AskpassService>,
    /// 로그인 셸에서 합친 PATH (macOS). 외부 앱 실행에도 쓴다
    login_path: Option<String>,
    /// 시작 인자로 받은 경로 (프런트가 한 번 가져간다)
    startup_paths: Mutex<Vec<String>>,
}

impl AppState {
    /// 시스템 git 을 찾아 버전을 검사하고 코어를 조립한다.
    /// `data_dir` 가 있으면 그 안에 SQLite DB(`mgit.db`)와 백업 디렉터리를 둔다.
    /// macOS 는 로그인 셸 PATH 를 합치고, askpass 서버를 띄워 네트워크 명령 환경에 붙인다
    #[cfg(test)]
    pub async fn build(_data_dir: Option<PathBuf>) -> Self {
        let profile = RuntimeProfile::isolated(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."),
            RuntimeKind::Test,
            &uuid::Uuid::new_v4().simple().to_string(),
        )
        .expect("테스트 환경 생성 실패");
        let data_dir = profile.root.clone().expect("테스트 경로 없음");
        std::fs::create_dir_all(&data_dir).expect("테스트 경로 생성 실패");
        Self::build_profile(Some(data_dir), &profile).await
    }

    /// 결정된 환경의 저장소·vault만 사용해 네이티브 의존성을 조립한다.
    pub async fn build_profile(data_dir: Option<PathBuf>, profile: &RuntimeProfile) -> Self {
        let app_events = Arc::new(AppEvents::default());
        let credentials = Arc::new(CredentialHub::default());
        let login_path = login_shell_path().await;
        let core = build_core(data_dir, login_path.clone(), profile).await;
        let vault = runtime_vault(profile);
        let askpass = match &core {
            Ok(handle) => {
                // 호스팅 토큰도 키체인에 둔다 (B1)
                handle.core.set_secret_vault(Arc::clone(&vault));
                let prompt = Arc::new(TauriPrompt {
                    events: Arc::clone(&app_events),
                    hub: Arc::clone(&credentials),
                });
                match AskpassService::start(vault, prompt) {
                    Ok(service) => {
                        if let Ok(exe) = std::env::current_exe() {
                            handle.runner.set_network_env(service.env_vars(&exe));
                        }
                        // 서버가 거부한 저장 비밀을 지워 다음에 다시 묻게 한다
                        handle.core.set_credential_outcome(service.outcome());
                        Some(service)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "askpass 서버를 띄우지 못했다 (터미널 프롬프트 비활성 상태로 진행)");
                        None
                    }
                }
            }
            Err(_) => None,
        };
        Self {
            core,
            app_events,
            credentials,
            askpass,
            login_path,
            startup_paths: Mutex::new(Vec::new()),
        }
    }

    /// 시작 인자 경로를 보관한다
    pub fn set_startup_paths(&self, paths: Vec<String>) {
        *self
            .startup_paths
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = paths;
    }

    /// 시작 인자 경로를 꺼내고 비운다
    pub fn take_startup_paths(&self) -> Vec<String> {
        std::mem::take(
            &mut *self
                .startup_paths
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// 코어 핸들. 시작 시 실패했으면 그 오류를 복제해 돌려준다
    pub fn core(&self) -> Result<&CoreHandle, IpcError> {
        self.core.as_ref().map_err(Clone::clone)
    }

    /// askpass 서비스
    pub fn askpass(&self) -> Option<&AskpassService> {
        self.askpass.as_ref()
    }

    /// 로그인 셸 PATH
    pub fn login_path(&self) -> Option<String> {
        self.login_path.clone()
    }
}

/// 로컬 저장소를 연다. 배포만 기존 메모리 대체를 유지하고 격리 환경의 파일 오류는 전달한다.
fn open_store(data_dir: Option<&PathBuf>, strict: bool) -> Result<Arc<dyn Store>, IpcError> {
    let Some(dir) = data_dir else {
        return Ok(Arc::new(MemoryStore::new()));
    };
    match SqliteStore::open(&dir.join("mgit.db")) {
        Ok(store) => Ok(Arc::new(store)),
        Err(e) if strict => Err(IpcError::Internal {
            message: e.to_string(),
        }),
        Err(e) => {
            tracing::warn!(error = %e, "SQLite 저장소를 열 수 없어 메모리 저장소를 쓴다");
            Ok(Arc::new(MemoryStore::new()))
        }
    }
}

/// `TokioGitRunner`·`NotifyWatcher`·`SqliteStore` 를 만들어 `Core` 에 주입한다
async fn build_core(
    data_dir: Option<PathBuf>,
    login_path: Option<String>,
    profile: &RuntimeProfile,
) -> Result<CoreHandle, IpcError> {
    let runner_cfg = RunnerConfig {
        extra_env: login_path
            .clone()
            .map(|p| vec![("PATH".to_string(), p)])
            .unwrap_or_default(),
        ..RunnerConfig::default()
    };
    let runner = Arc::new(TokioGitRunner::new(runner_cfg).await?);
    let git_path = runner.git_path().display().to_string();
    let store = open_store(
        data_dir.as_ref(),
        profile.info.kind != RuntimeKind::Production,
    )?;
    // 자동 fetch 간격은 저장된 설정을 우선하고 첫 실행만 배포 5분·개발/테스트 끔을 적용한다.
    let auto_fetch_minutes =
        crate::commands_app::saved_auto_fetch_minutes(store.as_ref(), profile.auto_fetch_default());
    let cfg = CoreConfig {
        backup_dir: data_dir.map(|d| d.join("backups")),
        temp_dir: profile.root.as_ref().map(|d| d.join("temp")),
        auto_fetch_interval: crate::commands_app::auto_fetch_interval(auto_fetch_minutes),
        command_path: login_path,
        ..CoreConfig::default()
    };
    let core = Arc::new(Core::with_deps(
        Arc::clone(&runner) as Arc<dyn mgit_model::GitRunner>,
        Arc::new(NotifyWatcher::default()),
        store,
        cfg,
    ));
    Ok(CoreHandle {
        core,
        git_path,
        runner,
    })
}

/// 테스트는 항상 메모리 금고를 만들며 개발·배포만 해당 환경의 키체인 service를 사용한다.
fn runtime_vault(profile: &RuntimeProfile) -> Arc<dyn SecretVault> {
    if profile.info.kind == RuntimeKind::Test {
        Arc::new(MemoryVault::default())
    } else {
        Arc::new(KeyringVault::new(&profile.keyring_service))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 테스트 실행의 DB·최근 저장소·계정·자동 fetch·백업 경로가 다른 실행과 섞이지 않는다.
    #[test]
    fn test_app_state_uses_independent_stores_and_defaults() {
        tauri::async_runtime::block_on(async {
            let a = AppState::build(None).await;
            let b = AppState::build(None).await;
            let a = &a.core().unwrap().core;
            let b = &b.core().unwrap().core;
            assert_eq!(a.auto_fetch_interval(), None);
            assert_eq!(b.auto_fetch_interval(), None);
            assert_ne!(a.config().backup_dir, b.config().backup_dir);
            assert_ne!(a.config().temp_dir, b.config().temp_dir);
            let recent = a.config().temp_dir.as_ref().unwrap().join("test-repo");
            a.store()
                .recent_touch(&recent, mgit_model::RecentKind::Repo, "test-repo")
                .unwrap();
            assert_eq!(a.store().recent_list().unwrap().len(), 1);
            assert!(b.store().recent_list().unwrap().is_empty());
            a.store().open_tabs_set(&[recent]).unwrap();
            assert!(b.store().open_tabs_get().unwrap().is_empty());
            a.store().setting_set("hosting.accounts", r#"[{"id":"github:github.com:test","kind":"github","host":"github.com","user":"test"}]"#).unwrap();
            assert_eq!(a.hosting_accounts().len(), 1);
            assert!(b.hosting_accounts().is_empty());
            a.store()
                .setting_set("autoFetch", r#"{"minutes":15}"#)
                .unwrap();
            assert_eq!(
                crate::commands_app::saved_auto_fetch_minutes(a.store().as_ref(), 0),
                15
            );
            assert_eq!(
                crate::commands_app::saved_auto_fetch_minutes(b.store().as_ref(), 0),
                0
            );
        });
    }

    /// 테스트 금고는 키체인에 접근하지 않고 Askpass와 공유하며 다른 실행에는 비밀이 없다.
    #[test]
    fn test_vault_is_memory_only_and_shared_with_askpass() {
        tauri::async_runtime::block_on(async {
            let profile = RuntimeProfile::isolated(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."),
                RuntimeKind::Test,
                "vault-test",
            )
            .unwrap();
            let a = runtime_vault(&profile);
            let b = runtime_vault(&profile);
            let key = mgit_core::vault_key(PromptKind::Password, "https://example.invalid");
            a.set(&key, "test-only-secret").unwrap();
            a.set("hosting:github:github.com:test", "test-only-token")
                .unwrap();
            assert_eq!(b.get(&key), None);
            assert_eq!(b.get("hosting:github:github.com:test"), None);
            let prompt = Arc::new(TauriPrompt {
                events: Arc::new(AppEvents::default()),
                hub: Arc::new(CredentialHub::default()),
            });
            let service = AskpassService::start(Arc::clone(&a), prompt).unwrap();
            let answer = mgit_helper::request_with(
                service.socket(),
                service.token(),
                "Password for 'https://example.invalid': ",
                None,
                true,
            )
            .await;
            assert_eq!(answer.as_deref(), Some("test-only-secret"));
            service.forget("https://example.invalid");
            assert_eq!(a.get(&key), None);
        });
    }
}
