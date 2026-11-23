//! 자격 증명 (AU-01·03). askpass 서버가 받은 프롬프트를 OS 키체인에서 먼저 찾고, 없으면 앱 대화상자
//! (`CredentialPrompt`)에 묻는다. "기억" 이면 키체인에만 저장한다 (평문 파일 금지)

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

pub use mgit_helper::PromptKind;
use mgit_helper::{AskReply, AskRequest, AskpassServer, Handler};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;

/// 키체인 service 이름
const SERVICE: &str = "mGit";

/// 비밀 보관소 포트. 테스트는 메모리 구현을 쓴다
pub trait SecretVault: Send + Sync + 'static {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, key: &str);
}

/// OS 키체인 (macOS Keychain, Windows Credential Manager). 블로킹 API 라 `spawn_blocking` 안에서 부른다
#[derive(Debug, Default)]
pub struct KeyringVault;

impl SecretVault for KeyringVault {
    /// 저장된 비밀
    fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    /// 저장 (덮어쓰기)
    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| e.to_string())
    }

    /// 삭제 (없어도 무시)
    fn delete(&self, key: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
}

/// 메모리 보관소 (테스트·키체인 없는 환경)
#[derive(Debug, Default)]
pub struct MemoryVault {
    map: Mutex<HashMap<String, String>>,
}

impl SecretVault for MemoryVault {
    /// 조회
    fn get(&self, key: &str) -> Option<String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .cloned()
    }

    /// 저장
    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.to_string(), secret.to_string());
        Ok(())
    }

    /// 삭제
    fn delete(&self, key: &str) {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(key);
    }
}

/// 앱에 보내는 질문
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequest {
    pub id: u64,
    pub kind: PromptKind,
    pub target: String,
    pub prompt: String,
}

/// 앱의 답
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReply {
    /// `None` 이면 취소
    pub secret: Option<String>,
    /// 키체인에 저장
    pub remember: bool,
}

/// 대화상자 포트. 셸은 앱 이벤트 + `credential_reply` 로 구현한다
pub trait CredentialPrompt: Send + Sync + 'static {
    fn ask(
        &self,
        request: CredentialRequest,
    ) -> Pin<Box<dyn Future<Output = Option<CredentialReply>> + Send>>;
}

/// 네트워크 명령의 인증 결과를 받는 포트. 코어가 명령이 끝날 때 태그로 알린다
pub trait CredentialOutcome: Send + Sync + 'static {
    /// 서버가 자격 증명을 거부했다: 이 명령이 쓴 저장된 비밀을 지운다
    fn rejected(&self, tag: &str);
    /// 거부가 아니다: 이 명령의 기록만 지운다
    fn finished(&self, tag: &str);
}

/// 명령 태그별로 쓴 키체인 키를 기억한다
struct ServedSecrets {
    vault: Arc<dyn SecretVault>,
    by_tag: Mutex<HashMap<String, Vec<String>>>,
}

impl ServedSecrets {
    /// 태그가 있는 명령이 이 키를 썼다고 적는다
    fn record(&self, tag: Option<&str>, key: &str) {
        let Some(tag) = tag else {
            return;
        };
        self.by_tag
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(tag.to_string())
            .or_default()
            .push(key.to_string());
    }

    /// 태그의 기록을 꺼낸다
    fn take(&self, tag: &str) -> Vec<String> {
        self.by_tag
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(tag)
            .unwrap_or_default()
    }
}

impl CredentialOutcome for ServedSecrets {
    /// 거부된 명령이 쓴 비밀을 지운다
    fn rejected(&self, tag: &str) {
        for key in self.take(tag) {
            self.vault.delete(&key);
        }
    }

    /// 기록을 지운다
    fn finished(&self, tag: &str) {
        self.take(tag);
    }
}

/// 키체인 키: 종류와 대상을 합친다
pub fn vault_key(kind: PromptKind, target: &str) -> String {
    let k = match kind {
        PromptKind::Username => "username",
        PromptKind::Password => "password",
        PromptKind::Passphrase => "passphrase",
        PromptKind::Other => "other",
    };
    format!("{k}:{target}")
}

/// git 이 프롬프트의 사용자 이름에 쓰는 퍼센트 인코딩 (RFC 3986 비예약 문자만 그대로)
fn encode_userinfo(user: &str) -> String {
    let mut out = String::with_capacity(user.len());
    for b in user.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 같은 계정을 가리키는 대상들. git 은 사용자 이름은 `scheme://host`,
/// 비밀번호는 `scheme://user@host` 로 물으므로 어느 쪽으로 지워도 둘 다 지워지게 한다
fn related_targets(vault: &dyn SecretVault, target: &str) -> Vec<String> {
    let mut out = vec![target.to_string()];
    let Some((scheme, rest)) = target.split_once("://") else {
        return out;
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    match authority.rsplit_once('@') {
        Some((user, _)) => out.push(format!("{scheme}://{}", &rest[user.len() + 1..])),
        None => {
            if let Some(user) = vault.get(&vault_key(PromptKind::Username, target)) {
                out.push(format!("{scheme}://{}@{rest}", encode_userinfo(&user)));
            }
        }
    }
    out
}

/// askpass 서비스: 소켓 서버 + 키체인 + 대화상자
pub struct AskpassService {
    server: AskpassServer,
    vault: Arc<dyn SecretVault>,
    served: Arc<ServedSecrets>,
}

impl AskpassService {
    /// 서버를 띄운다 (앱 시작 시 1개)
    pub fn start(
        vault: Arc<dyn SecretVault>,
        prompt: Arc<dyn CredentialPrompt>,
    ) -> Result<Self, CoreError> {
        let next_id = Arc::new(AtomicU64::new(1));
        let vault_for_handler = Arc::clone(&vault);
        let served = Arc::new(ServedSecrets {
            vault: Arc::clone(&vault),
            by_tag: Mutex::new(HashMap::new()),
        });
        let served_for_handler = Arc::clone(&served);
        let handler: Handler = Arc::new(move |req: AskRequest| {
            let vault = Arc::clone(&vault_for_handler);
            let served = Arc::clone(&served_for_handler);
            let prompt = Arc::clone(&prompt);
            let id = next_id.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move {
                let key = vault_key(req.kind, &req.target);
                // 1. 키체인 (블로킹 API)
                let cached = {
                    let vault = Arc::clone(&vault);
                    let key = key.clone();
                    tokio::task::spawn_blocking(move || vault.get(&key))
                        .await
                        .ok()
                        .flatten()
                };
                if let Some(secret) = cached {
                    served.record(req.tag.as_deref(), &key);
                    return AskReply {
                        secret: Some(secret),
                    };
                }
                // 2. 대화상자
                let reply = prompt
                    .ask(CredentialRequest {
                        id,
                        kind: req.kind,
                        target: req.target.clone(),
                        prompt: req.prompt.clone(),
                    })
                    .await;
                let Some(reply) = reply else {
                    return AskReply { secret: None };
                };
                if reply.remember
                    && let Some(secret) = &reply.secret
                {
                    let vault = Arc::clone(&vault);
                    let secret = secret.clone();
                    let stored_key = key.clone();
                    let _ =
                        tokio::task::spawn_blocking(move || vault.set(&stored_key, &secret)).await;
                    // 오타가 저장돼 굳지 않게, 이 명령이 거부되면 함께 지운다
                    served.record(req.tag.as_deref(), &key);
                }
                AskReply {
                    secret: reply.secret,
                }
            })
        });
        let server = AskpassServer::start(handler)?;
        Ok(AskpassService {
            server,
            vault,
            served,
        })
    }

    /// git·ssh 에 붙일 환경 변수
    pub fn env_vars(&self, exe: &Path) -> Vec<(String, String)> {
        self.server.env_vars(exe)
    }

    /// 코어에 넘길 인증 결과 포트
    pub fn outcome(&self) -> Arc<dyn CredentialOutcome> {
        Arc::clone(&self.served) as Arc<dyn CredentialOutcome>
    }

    /// 소켓 이름 (테스트용)
    pub fn socket(&self) -> &str {
        &self.server.socket
    }

    /// 토큰 (테스트용)
    pub fn token(&self) -> &str {
        &self.server.token
    }

    /// 대상의 저장된 비밀을 모두 지운다 (잘못 저장했을 때). 짝이 되는 사용자 이름·비밀번호도 지운다
    pub fn forget(&self, target: &str) {
        for t in related_targets(self.vault.as_ref(), target) {
            for kind in [
                PromptKind::Username,
                PromptKind::Password,
                PromptKind::Passphrase,
                PromptKind::Other,
            ] {
                self.vault.delete(&vault_key(kind, &t));
            }
        }
    }
}
