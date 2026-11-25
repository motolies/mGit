//! 호스팅 계정(AU-05)·프로필(AU-06)·SSH 키(AU-04)·원격 저장소 목록(HO-01)
//!
//! 계정 목록·OAuth 설정·프로필은 앱 설정(JSON)에, 토큰은 `SecretVault`(키체인)에만 둔다

use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError};

use mgit_hosting::{DeviceCodes, HostKind, HostingClient, RepoPage};
use mgit_l10n::{pick, tr};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::credentials::SecretVault;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::write::WriteSpec;

const ACCOUNTS_KEY: &str = "hosting.accounts";
const OAUTH_KEY: &str = "hosting.oauth";
const PROFILES_KEY: &str = "profiles";

/// 연결된 호스팅 계정 (토큰 제외)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingAccount {
    /// `github:github.com:kim`
    pub id: String,
    pub kind: HostKind,
    pub host: String,
    pub user: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub web_url: Option<String>,
}

/// 디바이스 플로우용 OAuth App id (없으면 PAT 만)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OauthConfig {
    pub github_client_id: Option<String>,
    pub gitlab_client_id: Option<String>,
}

/// 작성자 프로필 (AU-06)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    pub signing_key: Option<String>,
    /// 연결된 호스팅 계정 id
    pub hosting_account: Option<String>,
}

/// SSH 키 (AU-04)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    /// 개인 키 경로
    pub path: PathBuf,
    /// 공개 키 한 줄 전체
    pub public_key: String,
    pub kind: String,
    pub comment: String,
}

/// 계정 id (`github:github.com:kim`)
pub fn account_id(kind: HostKind, host: &str, user: &str) -> String {
    let k = match kind {
        HostKind::GitHub => "github",
        HostKind::GitLab => "gitlab",
    };
    format!("{k}:{}:{}", host.to_lowercase(), user.to_lowercase())
}

/// 금고 키
fn token_key(id: &str) -> String {
    format!("hosting:{id}")
}

/// 호스트 이름 정리 (`https://` 제거, 소문자). `이름[:포트]` 만 받는다: userinfo·쿼리·프래그먼트가
/// 섞이면 토큰이 겉보기와 다른 서버로 가므로 거부한다
fn check_host(host: &str) -> Result<String, CoreError> {
    let h = host
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let (name, port) = match h.rsplit_once(':') {
        Some((name, port)) if !h.ends_with(']') => (name, Some(port)),
        _ => (h, None),
    };
    let name_ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'))
        && (name.starts_with('[') || !name.contains(':'));
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !name_ok || !port_ok {
        return Err(CoreError::Invalid(tr!(
            "잘못된 호스트: {host:?}",
            "Invalid host: {host:?}"
        )));
    }
    Ok(h.to_lowercase())
}

/// 키 파일 이름 검사 (경로 조작 방지)
fn check_key_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty()
        || name.starts_with('.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(CoreError::Invalid(tr!(
            "키 이름은 영문·숫자·._- 만 쓸 수 있습니다: {name:?}",
            "Key names can only contain letters, digits, and ._-: {name:?}"
        )));
    }
    Ok(())
}

/// 키 암호를 넘기는 환경 변수
const KEYGEN_PASS_ENV: &str = "MGIT_KEYGEN_PASSPHRASE";

/// 키 암호를 프로세스 인자에 올리지 않고 `ssh-keygen` 에 넘기는 임시 askpass 스크립트.
/// 암호는 환경 변수로 주고 파일에는 담지 않는다. 드롭되면 지운다
#[cfg(unix)]
struct KeygenAskpass(PathBuf);

#[cfg(unix)]
impl KeygenAskpass {
    /// 임시 디렉터리에 새 파일(0700, 기존 파일 재사용 금지)로 만든다
    fn create(root: Option<&Path>) -> std::io::Result<Self> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        let name = format!("mgit-keygen-{}-{seq}.sh", std::process::id());
        let root = root
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&root)?;
        let path = root.join(name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&path)?;
        let guard = KeygenAskpass(path);
        file.write_all(format!("#!/bin/sh\nprintf '%s\\n' \"${KEYGEN_PASS_ENV}\"\n").as_bytes())?;
        Ok(guard)
    }
}

#[cfg(unix)]
impl Drop for KeygenAskpass {
    /// 임시 스크립트를 지운다
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `ssh-keygen` 명령을 조립한다. `askpass` 가 있으면 암호를 환경 변수와 askpass 로 넘긴다:
/// stdin 이 tty 가 아니면 `ssh-keygen` 이 askpass 로 묻는다. 없으면 `-N` (빈 암호, 비 Unix)
fn keygen_command(
    path: &Path,
    comment: &str,
    passphrase: &str,
    askpass: Option<&Path>,
) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("ssh-keygen");
    c.arg("-q")
        .arg("-t")
        .arg("ed25519")
        .arg("-C")
        .arg(comment)
        .arg("-f")
        .arg(path)
        .stdin(std::process::Stdio::null());
    match askpass {
        Some(script) => {
            c.env("SSH_ASKPASS", script)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env(KEYGEN_PASS_ENV, passphrase);
        }
        None => {
            c.arg("-N").arg(passphrase);
        }
    }
    c
}

impl Core {
    /// 토큰 금고를 바꾼다 (셸은 키체인, 기본은 메모리)
    pub fn set_secret_vault(&self, vault: Arc<dyn SecretVault>) {
        *self
            .inner()
            .vault
            .write()
            .unwrap_or_else(PoisonError::into_inner) = vault;
    }

    /// 네트워크 명령의 인증 결과를 받을 포트를 단다 (셸이 askpass 서비스를 연결)
    pub fn set_credential_outcome(&self, outcome: Arc<dyn crate::credentials::CredentialOutcome>) {
        *self
            .inner()
            .credential_outcome
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(outcome);
    }

    /// 현재 금고
    pub(crate) fn vault(&self) -> Arc<dyn SecretVault> {
        Arc::clone(
            &self
                .inner()
                .vault
                .read()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// 설정 JSON 읽기 (없거나 깨졌으면 기본값)
    fn setting_json<T: DeserializeOwned + Default>(&self, key: &str) -> T {
        self.store()
            .setting_get(key)
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default()
    }

    /// 설정 JSON 쓰기
    fn set_setting_json<T: Serialize>(&self, key: &str, value: &T) -> Result<(), CoreError> {
        let json = serde_json::to_string(value)
            .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
        self.store().setting_set(key, &json)?;
        Ok(())
    }

    /// 연결된 계정 목록
    pub fn hosting_accounts(&self) -> Vec<HostingAccount> {
        self.setting_json(ACCOUNTS_KEY)
    }

    /// OAuth App 설정
    pub fn hosting_oauth(&self) -> OauthConfig {
        self.setting_json(OAUTH_KEY)
    }

    /// OAuth App 설정 저장
    pub fn set_hosting_oauth(&self, cfg: &OauthConfig) -> Result<(), CoreError> {
        self.set_setting_json(OAUTH_KEY, cfg)
    }

    /// 계정의 API 클라이언트 (토큰은 금고에서)
    pub fn hosting_client(&self, account_id: &str) -> Result<HostingClient, CoreError> {
        let acc = self
            .hosting_accounts()
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| {
                CoreError::Invalid(tr!(
                    "계정을 찾을 수 없습니다: {account_id}",
                    "Account not found: {account_id}"
                ))
            })?;
        let token = self.vault().get(&token_key(account_id)).ok_or_else(|| {
            CoreError::Invalid(
                pick(
                    "토큰이 키체인에 없습니다. 계정을 다시 추가하세요",
                    "The token is not in the Keychain. Add the account again",
                )
                .into(),
            )
        })?;
        Ok(HostingClient::new(acc.kind, &acc.host, Some(token))?)
    }

    /// 토큰을 검증해 계정을 저장한다 (클라이언트는 호출자가 만든다 → 테스트에서 가짜 서버 주입)
    pub async fn hosting_add_with_client(
        &self,
        kind: HostKind,
        host: &str,
        token: &str,
        client: &HostingClient,
    ) -> Result<HostingAccount, CoreError> {
        let host = check_host(host)?;
        let token = token.trim();
        if token.is_empty() {
            return Err(CoreError::Invalid(
                pick("토큰을 입력하세요", "Enter a token").into(),
            ));
        }
        let user = client.verify().await?;
        let id = account_id(kind, &host, &user.login);
        self.vault().set(&token_key(&id), token).map_err(|e| {
            CoreError::Invalid(tr!(
                "키체인 저장 실패: {e}",
                "Failed to save to the Keychain: {e}"
            ))
        })?;
        let account = HostingAccount {
            id: id.clone(),
            kind,
            host,
            user: user.login,
            name: user.name,
            avatar_url: user.avatar_url,
            web_url: user.web_url,
        };
        let mut list = self.hosting_accounts();
        list.retain(|a| a.id != id);
        list.push(account.clone());
        list.sort_by(|a, b| a.id.cmp(&b.id));
        self.set_setting_json(ACCOUNTS_KEY, &list)?;
        Ok(account)
    }

    /// PAT 로 계정 추가 (AU-05)
    pub async fn hosting_add_pat(
        &self,
        kind: HostKind,
        host: &str,
        token: &str,
    ) -> Result<HostingAccount, CoreError> {
        let host = check_host(host)?;
        let client = HostingClient::new(kind, &host, Some(token.trim().to_string()))?;
        self.hosting_add_with_client(kind, &host, token, &client)
            .await
    }

    /// 종류별 OAuth App client_id
    fn client_id_for(&self, kind: HostKind) -> Result<String, CoreError> {
        let cfg = self.hosting_oauth();
        let id = match kind {
            HostKind::GitHub => cfg.github_client_id,
            HostKind::GitLab => cfg.gitlab_client_id,
        };
        id.filter(|s| !s.trim().is_empty()).ok_or_else(|| {
            CoreError::Invalid(pick("OAuth App client_id 가 설정돼 있지 않습니다. PAT 로 추가하거나 설정에 client_id 를 넣으세요", "OAuth App client_id is not set. Add the account with a PAT or set client_id in settings").into())
        })
    }

    /// 디바이스 플로우 시작 (AU-05): 코드와 URL 을 돌려준다
    pub async fn hosting_device_start(
        &self,
        kind: HostKind,
        host: &str,
    ) -> Result<DeviceCodes, CoreError> {
        let host = check_host(host)?;
        let client_id = self.client_id_for(kind)?;
        let client = HostingClient::new(kind, &host, None)?;
        Ok(client.device_start(&client_id).await?)
    }

    /// 디바이스 플로우 완료: 사용자가 코드를 입력할 때까지 기다렸다가 계정을 저장한다
    pub async fn hosting_device_finish(
        &self,
        kind: HostKind,
        host: &str,
        codes: &DeviceCodes,
    ) -> Result<HostingAccount, CoreError> {
        let host = check_host(host)?;
        let client_id = self.client_id_for(kind)?;
        let client = HostingClient::new(kind, &host, None)?;
        let token = client.device_wait(&client_id, codes).await?;
        let authed = client.with_token(Some(token.clone()));
        self.hosting_add_with_client(kind, &host, &token, &authed)
            .await
    }

    /// 계정 제거 (토큰도 지운다)
    pub fn hosting_remove(&self, account_id: &str) -> Result<(), CoreError> {
        self.vault().delete(&token_key(account_id));
        let mut list = self.hosting_accounts();
        list.retain(|a| a.id != account_id);
        self.set_setting_json(ACCOUNTS_KEY, &list)
    }

    /// 계정이 접근할 수 있는 저장소 (HO-01)
    pub async fn hosting_repos(
        &self,
        account_id: &str,
        page: u32,
        search: &str,
    ) -> Result<RepoPage, CoreError> {
        let client = self.hosting_client(account_id)?;
        Ok(client.list_repos(page, search).await?)
    }

    // ---------- 프로필 (AU-06) ----------

    /// 프로필 목록
    pub fn profiles(&self) -> Vec<Profile> {
        self.setting_json(PROFILES_KEY)
    }

    /// 프로필 목록 저장 (빈 id 는 채운다)
    pub fn set_profiles(&self, list: &[Profile]) -> Result<(), CoreError> {
        let mut out = Vec::with_capacity(list.len());
        for (i, p) in list.iter().enumerate() {
            let mut p = p.clone();
            if p.id.trim().is_empty() {
                p.id = format!("p{}-{i}", mgit_model::now_millis());
            }
            if p.name.trim().is_empty() {
                return Err(CoreError::Invalid(
                    pick("프로필 이름을 입력하세요", "Enter a profile name").into(),
                ));
            }
            out.push(p);
        }
        self.set_setting_json(PROFILES_KEY, &out)
    }

    /// 프로필을 저장소에 적용: user.name/email + user.signingKey (local)
    pub async fn apply_profile(
        &self,
        session: SessionId,
        profile_id: &str,
    ) -> Result<(), CoreError> {
        let p = self
            .profiles()
            .into_iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| {
                CoreError::Invalid(tr!(
                    "프로필을 찾을 수 없습니다: {profile_id}",
                    "Profile not found: {profile_id}"
                ))
            })?;
        self.set_user(session, &p.user_name, &p.user_email).await?;
        match p
            .signing_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
        {
            Some(key) => {
                self.run_write(
                    session,
                    WriteSpec::new(["config", "--local", "user.signingKey", key])
                        .no_undo()
                        .skip_refresh(),
                )
                .await?;
            }
            None => self.config_unset_local(session, "user.signingKey").await?,
        }
        Ok(())
    }

    // ---------- SSH 키 (AU-04) ----------

    /// `~/.ssh`
    pub fn ssh_dir() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|h| PathBuf::from(h).join(".ssh"))
    }

    /// `~/.ssh/*.pub` 의 키 목록
    pub fn ssh_keys(&self) -> Vec<SshKeyInfo> {
        Self::ssh_dir()
            .map(|d| Self::ssh_keys_in(&d))
            .unwrap_or_default()
    }

    /// 디렉터리의 `*.pub` 파싱 (`종류 키 주석`)
    pub fn ssh_keys_in(dir: &Path) -> Vec<SshKeyInfo> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut keys: Vec<SshKeyInfo> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "pub"))
            .filter_map(|pub_path| {
                let line = std::fs::read_to_string(&pub_path).ok()?;
                let line = line.lines().next()?.trim().to_string();
                let mut parts = line.splitn(3, ' ');
                let kind = parts.next()?.to_string();
                parts.next()?;
                let comment = parts.next().unwrap_or("").to_string();
                Some(SshKeyInfo {
                    path: pub_path.with_extension(""),
                    public_key: line,
                    kind,
                    comment,
                })
            })
            .collect();
        keys.sort_by(|a, b| a.path.cmp(&b.path));
        keys
    }

    /// `~/.ssh/<name>` 에 ed25519 키를 만든다 (AU-04)
    pub async fn ssh_keygen(
        &self,
        name: &str,
        comment: &str,
        passphrase: &str,
    ) -> Result<SshKeyInfo, CoreError> {
        let dir = Self::ssh_dir().ok_or_else(|| {
            CoreError::Invalid(
                pick(
                    "홈 디렉터리를 찾을 수 없습니다",
                    "Cannot find the home directory",
                )
                .into(),
            )
        })?;
        if !dir.exists() {
            std::fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        Self::ssh_keygen_with_temp(
            &dir,
            name,
            comment,
            passphrase,
            self.config().temp_dir.as_deref(),
        )
        .await
    }

    /// 지정 디렉터리에 키 생성 (`ssh-keygen -t ed25519 -C <comment> -f <path>`)
    pub async fn ssh_keygen_in(
        dir: &Path,
        name: &str,
        comment: &str,
        passphrase: &str,
    ) -> Result<SshKeyInfo, CoreError> {
        Self::ssh_keygen_with_temp(dir, name, comment, passphrase, None).await
    }

    /// 앱에서 생성한 askpass 스크립트는 해당 실행 환경의 임시 루트에 둔다.
    async fn ssh_keygen_with_temp(
        dir: &Path,
        name: &str,
        comment: &str,
        passphrase: &str,
        temp_root: Option<&Path>,
    ) -> Result<SshKeyInfo, CoreError> {
        check_key_name(name)?;
        let path = dir.join(name);
        if path.exists() || path.with_extension("pub").exists() {
            return Err(CoreError::Invalid(tr!(
                "이미 있는 키입니다: {}",
                "Key already exists: {}",
                path.display()
            )));
        }
        #[cfg(unix)]
        let askpass = (!passphrase.is_empty())
            .then(|| KeygenAskpass::create(temp_root))
            .transpose()?;
        #[cfg(unix)]
        let script = askpass.as_ref().map(|a| a.0.as_path());
        #[cfg(not(unix))]
        let script = None;
        let out = keygen_command(&path, comment, passphrase, script)
            .output()
            .await
            .map_err(|e| {
                CoreError::Invalid(tr!(
                    "ssh-keygen 실행 실패: {e}",
                    "Failed to run ssh-keygen: {e}"
                ))
            })?;
        if !out.status.success() {
            return Err(CoreError::Invalid(tr!(
                "ssh-keygen 실패: {}",
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Self::ssh_keys_in(dir)
            .into_iter()
            .find(|k| k.path == path)
            .ok_or_else(|| {
                CoreError::Invalid(
                    pick("만든 키를 읽을 수 없습니다", "Cannot read the created key").into(),
                )
            })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 키 암호는 프로세스 인자로 보이지 않아야 한다
    #[test]
    fn keygen_keeps_passphrase_out_of_argv() {
        let cmd = keygen_command(
            Path::new("/k"),
            "c",
            "dummy-secret",
            Some(Path::new("/tmp/ask.sh")),
        );
        let args: Vec<_> = cmd.as_std().get_args().collect();
        assert!(args.iter().all(|a| *a != "dummy-secret"), "{args:?}");
    }

    /// 호스트는 `이름[:포트]` 만 받는다. userinfo·쿼리·프래그먼트로 다른 서버를 가리킬 수 없다
    #[test]
    fn check_host_accepts_only_host_and_port() {
        assert_eq!(check_host("https://GitHub.com/").unwrap(), "github.com");
        assert_eq!(check_host("gitlab.corp:8443").unwrap(), "gitlab.corp:8443");
        for bad in [
            "",
            "bad host",
            "a/b",
            "github.com@evil.example",
            "user:pw@evil.example",
            "evil.example#",
            "evil.example?x=1",
            "evil.example\\x",
            "evil%2eexample",
            "host:abc",
            "host:",
            ":8443",
        ] {
            assert!(check_host(bad).is_err(), "{bad:?}");
        }
    }
}
