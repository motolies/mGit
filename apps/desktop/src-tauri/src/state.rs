//! Tauri 관리 상태: 조립된 `mgit_core::Core` 와 셸이 따로 기억하는 정보.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use mgit_core::{
    AskpassService, Core, CoreConfig, CredentialPrompt, CredentialReply, CredentialRequest,
    KeyringVault, PromptKind,
};
use mgit_git::{RunnerConfig, TokioGitRunner, login_shell_path};
use mgit_model::{MemoryStore, Store};
use mgit_store::SqliteStore;
use mgit_watch::NotifyWatcher;
use tokio::sync::oneshot;

use crate::app_events::{AppEvent, AppEvents};
use crate::error::IpcError;

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
    pub async fn build(data_dir: Option<PathBuf>) -> Self {
        let app_events = Arc::new(AppEvents::default());
        let credentials = Arc::new(CredentialHub::default());
        let login_path = login_shell_path().await;
        let core = build_core(data_dir, login_path.clone()).await;
        let askpass = match &core {
            Ok(handle) => {
                // 호스팅 토큰도 키체인에 둔다 (B1)
                handle.core.set_secret_vault(Arc::new(KeyringVault));
                let prompt = Arc::new(TauriPrompt {
                    events: Arc::clone(&app_events),
                    hub: Arc::clone(&credentials),
                });
                match AskpassService::start(Arc::new(KeyringVault), prompt) {
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

/// 로컬 저장소를 연다. 파일 DB 를 못 열면 메모리 저장소로 대체한다 (앱은 떠야 한다)
fn open_store(data_dir: Option<&PathBuf>) -> Arc<dyn Store> {
    let Some(dir) = data_dir else {
        return Arc::new(MemoryStore::new());
    };
    match SqliteStore::open(&dir.join("mgit.db")) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            tracing::warn!(error = %e, "SQLite 저장소를 열 수 없어 메모리 저장소를 쓴다");
            Arc::new(MemoryStore::new())
        }
    }
}

/// `TokioGitRunner`·`NotifyWatcher`·`SqliteStore` 를 만들어 `Core` 에 주입한다
async fn build_core(
    data_dir: Option<PathBuf>,
    login_path: Option<String>,
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
    let store = open_store(data_dir.as_ref());
    // 자동 fetch 간격은 설정(⌘,)에 저장된 값이다 (없으면 5분). 실행 중 변경은 `auto_fetch_set` 이 코어에 바로 건다
    let auto_fetch_minutes = crate::commands_app::saved_auto_fetch_minutes(store.as_ref());
    let cfg = CoreConfig {
        backup_dir: data_dir.map(|d| d.join("backups")),
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
