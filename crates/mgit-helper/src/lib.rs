//! askpass 헬퍼 (AU-01). git·ssh 가 `GIT_ASKPASS`/`SSH_ASKPASS` 로 **본체 실행 파일**을 다시 띄우면,
//! 그 프로세스는 Tauri 를 초기화하지 않고 여기 `askpass_main` 으로 들어와 로컬 소켓으로 앱에 프롬프트를
//! 보내고 답을 stdout 에 쓴다. 별도 실행 파일(sidecar)이 아니라 빌드·배포가 단순하다 (계획 7절)

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use interprocess::local_socket::tokio::{Listener, Stream, prelude::*};
use interprocess::local_socket::{GenericFilePath, GenericNamespaced, ListenerOptions, Name};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// 소켓 이름을 담는 환경 변수
pub const ENV_SOCKET: &str = "MGIT_HELPER_SOCKET";
/// 세션 토큰 환경 변수 (다른 프로세스가 앱에 프롬프트를 흉내 내지 못하게)
pub const ENV_TOKEN: &str = "MGIT_HELPER_TOKEN";
/// 명령 태그 환경 변수. 어떤 명령이 어떤 저장된 비밀을 썼는지 잇는다
pub const ENV_TAG: &str = "MGIT_HELPER_TAG";
/// 사용자가 대화상자에 답할 때까지 기다리는 최대 시간
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// 프롬프트 종류 (git·OpenSSH 문구에서 추출)
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    Username,
    Password,
    Passphrase,
    Other,
}

/// 앱에 보내는 요청
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub token: String,
    pub kind: PromptKind,
    /// `https://github.com` · `user@host` · 키 경로 등
    pub target: String,
    /// 원문 프롬프트
    pub prompt: String,
    /// 요청을 보낸 명령의 태그 (`MGIT_HELPER_TAG`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// 앱의 답
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskReply {
    /// `None` 이면 취소 (헬퍼가 1 로 종료 → git 이 중단)
    pub secret: Option<String>,
}

/// 프롬프트 문구를 종류·대상으로 나눈다
pub fn parse_prompt(prompt: &str) -> (PromptKind, String) {
    let p = prompt.trim();
    let quoted = |s: &str| s.split('\'').nth(1).unwrap_or("").to_string();
    if let Some(rest) = p.strip_prefix("Username for ") {
        return (PromptKind::Username, quoted(rest));
    }
    if let Some(rest) = p.strip_prefix("Password for ") {
        return (PromptKind::Password, quoted(rest));
    }
    if let Some(rest) = p.strip_prefix("Enter passphrase for key ") {
        return (PromptKind::Passphrase, quoted(rest));
    }
    if p.starts_with("Enter passphrase") {
        return (PromptKind::Passphrase, String::new());
    }
    (
        PromptKind::Other,
        p.trim_end_matches(':').trim().to_string(),
    )
}

/// 프로세스 안에서 소켓 이름이 겹치지 않게 하는 일련번호
static NEXT_SOCKET: AtomicU32 = AtomicU32::new(0);

/// 이 프로세스용 소켓 이름. 네임스페이스 소켓을 지원하면 그것, 아니면 임시 디렉터리의 파일.
/// 호출할 때마다 다른 이름을 준다
pub fn socket_name(pid: u32) -> String {
    let seq = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
    if GenericNamespaced::is_supported() {
        format!("mgit-{pid}-{seq}.sock")
    } else {
        std::env::temp_dir()
            .join(format!("mgit-{pid}-{seq}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// 문자열 이름을 interprocess `Name` 으로
fn to_name(name: &str) -> std::io::Result<Name<'_>> {
    if GenericNamespaced::is_supported() {
        name.to_ns_name::<GenericNamespaced>()
    } else {
        name.to_fs_name::<GenericFilePath>()
    }
}

/// 요청 처리기: 요청을 받아 답을 돌려준다 (앱 쪽 대화상자)
pub type Handler = Arc<
    dyn Fn(AskRequest) -> Pin<Box<dyn Future<Output = AskReply> + Send>> + Send + Sync + 'static,
>;

/// 서버 핸들. 드롭되면 리스너 태스크가 끝난다
pub struct AskpassServer {
    pub socket: String,
    pub token: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for AskpassServer {
    /// 리스너를 멈춘다
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl AskpassServer {
    /// 소켓 서버를 연다. 토큰이 틀린 요청은 조용히 끊는다
    pub fn start(handler: Handler) -> std::io::Result<Self> {
        let socket = socket_name(std::process::id());
        let token = format!("{:032x}", random_u128());
        let name = to_name(&socket)?;
        let listener: Listener = ListenerOptions::new().name(name).create_tokio()?;
        let expected = token.clone();
        let task = tokio::spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(error = %e, "askpass 연결 수락 실패");
                        continue;
                    }
                };
                let handler = Arc::clone(&handler);
                let expected = expected.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve_one(stream, &expected, handler).await {
                        tracing::debug!(error = %e, "askpass 요청 처리 실패");
                    }
                });
            }
        });
        Ok(AskpassServer {
            socket,
            token,
            task,
        })
    }

    /// git·ssh 자식 프로세스에 붙일 환경 변수. `exe` 는 본체 실행 파일 경로
    pub fn env_vars(&self, exe: &std::path::Path) -> Vec<(String, String)> {
        let exe = exe.to_string_lossy().into_owned();
        vec![
            ("GIT_ASKPASS".into(), exe.clone()),
            ("SSH_ASKPASS".into(), exe),
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (ENV_SOCKET.into(), self.socket.clone()),
            (ENV_TOKEN.into(), self.token.clone()),
        ]
    }
}

/// 연결 하나: JSON 한 줄 읽고 → 처리 → JSON 한 줄 쓰기
async fn serve_one(stream: Stream, expected: &str, handler: Handler) -> std::io::Result<()> {
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let req: AskRequest = serde_json::from_str(line.trim())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if req.token != expected {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "토큰 불일치",
        ));
    }
    let reply = match tokio::time::timeout(PROMPT_TIMEOUT, handler(req)).await {
        Ok(r) => r,
        Err(_) => AskReply { secret: None },
    };
    let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".into());
    out.push('\n');
    let mut writer = &stream;
    writer.write_all(out.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

/// 클라이언트: 소켓에 프롬프트를 보내고 답을 받는다. 실패·취소면 `None`
pub async fn request(socket: &str, token: &str, prompt: &str) -> Option<String> {
    request_tagged(socket, token, prompt, None).await
}

/// 명령 태그를 붙여 프롬프트를 보낸다
pub async fn request_tagged(
    socket: &str,
    token: &str,
    prompt: &str,
    tag: Option<String>,
) -> Option<String> {
    let name = to_name(socket).ok()?;
    let stream = Stream::connect(name).await.ok()?;
    let mut writer = &stream;
    let (kind, target) = parse_prompt(prompt);
    let req = AskRequest {
        token: token.to_string(),
        kind,
        target,
        prompt: prompt.to_string(),
        tag,
    };
    let mut line = serde_json::to_string(&req).ok()?;
    line.push('\n');
    writer.write_all(line.as_bytes()).await.ok()?;
    writer.flush().await.ok()?;
    let mut reader = BufReader::new(&stream);
    let mut resp = String::new();
    tokio::time::timeout(
        PROMPT_TIMEOUT + Duration::from_secs(5),
        reader.read_line(&mut resp),
    )
    .await
    .ok()?
    .ok()?;
    let reply: AskReply = serde_json::from_str(resp.trim()).ok()?;
    reply.secret
}

/// `--askpass` 모드 진입점. 환경 변수로 앱을 찾아 답을 stdout 에 한 줄 쓴다. 종료 코드 0 = 성공
pub fn askpass_main(prompt: &str) -> i32 {
    let (Some(socket), Some(token)) = (
        std::env::var(ENV_SOCKET).ok(),
        std::env::var(ENV_TOKEN).ok(),
    ) else {
        eprintln!("mgit askpass: {ENV_SOCKET}/{ENV_TOKEN} 이 없습니다");
        return 1;
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return 1,
    };
    let tag = std::env::var(ENV_TAG).ok();
    match rt.block_on(request_tagged(&socket, &token, prompt, tag)) {
        Some(secret) => {
            println!("{secret}");
            0
        }
        None => 1,
    }
}

/// 토큰용 난수 (OS 엔트로피 대신 시간·주소 섞기; 로컬 소켓 접근 제한이 1차 방어)
fn random_u128() -> u128 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    let a = h.finish() as u128;
    let mut h2 = RandomState::new().build_hasher();
    h2.write_u64(a as u64);
    (a << 64) | h2.finish() as u128
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_and_ssh_prompts() {
        assert_eq!(
            parse_prompt("Username for 'https://github.com': "),
            (PromptKind::Username, "https://github.com".into())
        );
        assert_eq!(
            parse_prompt("Password for 'https://user@github.com': "),
            (PromptKind::Password, "https://user@github.com".into())
        );
        assert_eq!(
            parse_prompt("Enter passphrase for key '/Users/x/.ssh/id_ed25519': "),
            (PromptKind::Passphrase, "/Users/x/.ssh/id_ed25519".into())
        );
        assert_eq!(
            parse_prompt("Something else:"),
            (PromptKind::Other, "Something else".into())
        );
    }

    #[tokio::test]
    async fn round_trip_and_token_check() {
        let handler: Handler = Arc::new(|req: AskRequest| {
            Box::pin(async move {
                AskReply {
                    secret: (req.kind == PromptKind::Password)
                        .then(|| format!("pw-for-{}", req.target)),
                }
            })
        });
        let server = AskpassServer::start(handler).unwrap();
        let got = request(&server.socket, &server.token, "Password for 'https://h': ").await;
        assert_eq!(got.as_deref(), Some("pw-for-https://h"));
        let cancelled = request(&server.socket, &server.token, "Username for 'https://h': ").await;
        assert_eq!(cancelled, None);
        let bad = request(&server.socket, "wrong", "Password for 'https://h': ").await;
        assert_eq!(bad, None);
        let vars = server.env_vars(std::path::Path::new("/app/mgit"));
        assert!(
            vars.iter()
                .any(|(k, v)| k == "GIT_ASKPASS" && v == "/app/mgit")
        );
        assert!(
            vars.iter()
                .any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v == "force")
        );
    }
}
