//! GitHub·GitLab 호스팅 API 클라이언트 (Phase 2 B1·B2).
//!
//! - 인증: PAT, 또는 OAuth App `client_id` 가 있을 때 디바이스 플로우
//! - HTTP 는 reqwest 직접. 응답 JSON 은 필요한 필드만 읽는다
//! - 기본 URL 을 바꿀 수 있어(`with_bases`) 테스트는 가짜 서버(httpmock)로 돈다

use std::time::Duration;

mod messages;
mod pr;
pub use pr::{CreatePr, PullRequest};

use mgit_l10n::pick;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, header};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// 호스팅 종류
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    GitHub,
    GitLab,
}

impl HostKind {
    /// 기본 호스트
    pub fn default_host(self) -> &'static str {
        match self {
            HostKind::GitHub => "github.com",
            HostKind::GitLab => "gitlab.com",
        }
    }

    /// REST API 기본 URL (GHES 는 `/api/v3`, GitLab 은 `/api/v4`)
    pub fn api_base(self, host: &str) -> String {
        match self {
            HostKind::GitHub if host == "github.com" => "https://api.github.com".into(),
            HostKind::GitHub => format!("https://{host}/api/v3"),
            HostKind::GitLab => format!("https://{host}/api/v4"),
        }
    }

    /// OAuth(디바이스 플로우) 기본 URL
    pub fn oauth_base(self, host: &str) -> String {
        format!("https://{host}")
    }

    /// 디바이스 플로우 스코프
    fn device_scope(self) -> &'static str {
        match self {
            HostKind::GitHub => "repo read:org read:user user:email",
            HostKind::GitLab => "api",
        }
    }

    /// SSH 키 등록 페이지
    pub fn ssh_keys_url(self, host: &str) -> String {
        match self {
            HostKind::GitHub => format!("https://{host}/settings/ssh/new"),
            HostKind::GitLab => format!("https://{host}/-/user_settings/ssh_keys"),
        }
    }

    /// PAT 만들기 페이지
    pub fn token_url(self, host: &str) -> String {
        match self {
            HostKind::GitHub => format!(
                "https://{host}/settings/tokens/new?scopes=repo,read:org,read:user,user:email&description=mGit"
            ),
            HostKind::GitLab => {
                format!(
                    "https://{host}/-/user_settings/personal_access_tokens?name=mGit&scopes=api"
                )
            }
        }
    }
}

/// 호스팅 API 오류
#[derive(Debug, thiserror::Error)]
pub enum HostingError {
    #[error("{}", messages::http(.0))]
    Http(#[from] reqwest::Error),
    #[error(
        "{}",
        pick(
            "인증 실패 (토큰이 틀리거나 만료됨)",
            "Authentication failed (token is wrong or expired)"
        )
    )]
    Unauthorized,
    #[error("{}", messages::forbidden(.0))]
    Forbidden(String),
    #[error("{}", messages::not_found(.0))]
    NotFound(String),
    #[error("{}", messages::rate_limited(.retry_after))]
    RateLimited { retry_after: u64 },
    #[error("{}", messages::status(.status, .body))]
    Status { status: u16, body: String },
    #[error("{}", messages::parse(.0))]
    Parse(String),
    #[error(
        "{}",
        pick("디바이스 인증이 거부됐습니다", "Device authorization was denied")
    )]
    DeviceDenied,
    #[error(
        "{}",
        pick("디바이스 인증 시간이 지났습니다", "Device authorization expired")
    )]
    DeviceExpired,
    #[error("{0}")]
    Other(String),
}

/// 토큰 주인
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub login: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub web_url: Option<String>,
}

/// 저장소 요약 (HO-01)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    /// `owner/name`
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
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoPage {
    pub repos: Vec<RepoSummary>,
    pub next_page: Option<u32>,
}

/// 디바이스 플로우 시작 응답
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodes {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

/// 디바이스 플로우 폴링 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DevicePoll {
    Pending,
    SlowDown,
    Token(String),
}

/// 한 쪽에 받는 저장소 수
const PER_PAGE: usize = 50;

/// 호스팅 클라이언트 (계정 하나)
#[derive(Clone)]
pub struct HostingClient {
    kind: HostKind,
    api_base: String,
    oauth_base: String,
    token: Option<String>,
    http: Client,
}

impl std::fmt::Debug for HostingClient {
    /// 토큰은 찍지 않는다
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostingClient")
            .field("kind", &self.kind)
            .field("api_base", &self.api_base)
            .field("token", &self.token.as_ref().map(|_| "***"))
            .finish()
    }
}

impl HostingClient {
    /// 호스트 이름으로 (`github.com`, `gitlab.example.com`)
    pub fn new(kind: HostKind, host: &str, token: Option<String>) -> Result<Self, HostingError> {
        Self::with_bases(kind, kind.api_base(host), kind.oauth_base(host), token)
    }

    /// 기본 URL 을 직접 준다 (테스트·GHES)
    pub fn with_bases(
        kind: HostKind,
        api_base: impl Into<String>,
        oauth_base: impl Into<String>,
        token: Option<String>,
    ) -> Result<Self, HostingError> {
        let http = Client::builder()
            .user_agent("mGit")
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(HostingClient {
            kind,
            api_base: api_base.into().trim_end_matches('/').to_string(),
            oauth_base: oauth_base.into().trim_end_matches('/').to_string(),
            token,
            http,
        })
    }

    /// 종류
    pub fn kind(&self) -> HostKind {
        self.kind
    }

    /// 토큰을 바꾼 복사본
    pub fn with_token(mut self, token: Option<String>) -> Self {
        self.token = token;
        self
    }

    /// API 요청 (인증 헤더·Accept 포함)
    fn api(&self, method: Method, path: &str) -> RequestBuilder {
        self.authed(method, format!("{}{}", self.api_base, path))
    }

    /// 주소를 그대로 쓰는 요청 (인증 헤더·Accept 포함). 토큰은 `Authorization: Bearer` 로만 보낸다.
    /// reqwest 는 이 헤더를 교차 호스트 리다이렉트에서 지우지만 `PRIVATE-TOKEN` 은 지우지 않는다
    fn authed(&self, method: Method, url: String) -> RequestBuilder {
        let mut rb = self.http.request(method, url);
        rb = match self.kind {
            HostKind::GitHub => rb
                .header(header::ACCEPT, "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28"),
            HostKind::GitLab => rb.header(header::ACCEPT, "application/json"),
        };
        if let Some(t) = &self.token {
            rb = rb.bearer_auth(t);
        }
        rb
    }

    /// 상태 코드를 오류로 바꾸고 JSON 을 읽는다
    async fn json<T: DeserializeOwned>(resp: Response) -> Result<T, HostingError> {
        let resp = Self::check(resp).await?;
        let text = resp.text().await?;
        serde_json::from_str(&text)
            .map_err(|e| HostingError::Parse(format!("{e}: {}", snippet(&text))))
    }

    /// 2xx 가 아니면 오류로
    async fn check(resp: Response) -> Result<Response, HostingError> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let retry_after = resp
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let remaining = resp
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let reset = resp
            .headers()
            .get("x-ratelimit-reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let body = resp.text().await.unwrap_or_default();
        Err(match status {
            StatusCode::UNAUTHORIZED => HostingError::Unauthorized,
            StatusCode::TOO_MANY_REQUESTS => HostingError::RateLimited {
                retry_after: retry_after.unwrap_or(60),
            },
            StatusCode::FORBIDDEN if remaining == Some(0) || retry_after.is_some() => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                HostingError::RateLimited {
                    retry_after: retry_after
                        .or_else(|| reset.map(|r| r.saturating_sub(now)))
                        .unwrap_or(60),
                }
            }
            StatusCode::FORBIDDEN => HostingError::Forbidden(snippet(&body)),
            StatusCode::NOT_FOUND => HostingError::NotFound(snippet(&body)),
            _ => HostingError::Status {
                status: status.as_u16(),
                body: snippet(&body),
            },
        })
    }

    /// 토큰 주인 (`GET /user`). 토큰 검증에도 쓴다
    pub async fn verify(&self) -> Result<UserInfo, HostingError> {
        let resp = self.api(Method::GET, "/user").send().await?;
        match self.kind {
            HostKind::GitHub => {
                #[derive(Deserialize)]
                struct U {
                    login: String,
                    name: Option<String>,
                    email: Option<String>,
                    avatar_url: Option<String>,
                    html_url: Option<String>,
                }
                let u: U = Self::json(resp).await?;
                Ok(UserInfo {
                    login: u.login,
                    name: u.name,
                    email: u.email,
                    avatar_url: u.avatar_url,
                    web_url: u.html_url,
                })
            }
            HostKind::GitLab => {
                #[derive(Deserialize)]
                struct U {
                    username: String,
                    name: Option<String>,
                    email: Option<String>,
                    public_email: Option<String>,
                    avatar_url: Option<String>,
                    web_url: Option<String>,
                }
                let u: U = Self::json(resp).await?;
                Ok(UserInfo {
                    login: u.username,
                    name: u.name,
                    email: u.email.or(u.public_email).filter(|e| !e.is_empty()),
                    avatar_url: u.avatar_url,
                    web_url: u.web_url,
                })
            }
        }
    }

    /// 계정이 접근할 수 있는 저장소 (HO-01). `search` 가 비어 있지 않으면 검색 API
    pub async fn list_repos(&self, page: u32, search: &str) -> Result<RepoPage, HostingError> {
        let page = page.max(1);
        let search = search.trim();
        let per_page = PER_PAGE.to_string();
        let page_s = page.to_string();
        let repos = match self.kind {
            HostKind::GitHub => {
                #[derive(Deserialize)]
                struct R {
                    full_name: String,
                    name: String,
                    description: Option<String>,
                    private: bool,
                    fork: bool,
                    clone_url: String,
                    ssh_url: String,
                    html_url: String,
                    default_branch: Option<String>,
                    updated_at: Option<String>,
                    stargazers_count: Option<u32>,
                }
                let items: Vec<R> = if search.is_empty() {
                    let resp = self
                        .api(Method::GET, "/user/repos")
                        .query(&[
                            ("per_page", per_page.as_str()),
                            ("page", page_s.as_str()),
                            ("sort", "updated"),
                            ("affiliation", "owner,collaborator,organization_member"),
                        ])
                        .send()
                        .await?;
                    Self::json(resp).await?
                } else {
                    #[derive(Deserialize)]
                    struct S {
                        items: Vec<R>,
                    }
                    let resp = self
                        .api(Method::GET, "/search/repositories")
                        .query(&[
                            ("q", search),
                            ("per_page", per_page.as_str()),
                            ("page", page_s.as_str()),
                        ])
                        .send()
                        .await?;
                    let s: S = Self::json(resp).await?;
                    s.items
                };
                items
                    .into_iter()
                    .map(|r| RepoSummary {
                        full_name: r.full_name,
                        name: r.name,
                        description: r.description,
                        private: r.private,
                        fork: r.fork,
                        clone_url: r.clone_url,
                        ssh_url: r.ssh_url,
                        web_url: r.html_url,
                        default_branch: r.default_branch,
                        updated_at: r.updated_at,
                        stars: r.stargazers_count.unwrap_or(0),
                    })
                    .collect::<Vec<_>>()
            }
            HostKind::GitLab => {
                #[derive(Deserialize)]
                struct P {
                    path_with_namespace: String,
                    path: String,
                    description: Option<String>,
                    visibility: Option<String>,
                    forked_from_project: Option<serde_json::Value>,
                    http_url_to_repo: String,
                    ssh_url_to_repo: String,
                    web_url: String,
                    default_branch: Option<String>,
                    last_activity_at: Option<String>,
                    star_count: Option<u32>,
                }
                let mut q: Vec<(&str, &str)> = vec![
                    ("membership", "true"),
                    ("per_page", per_page.as_str()),
                    ("page", page_s.as_str()),
                    ("order_by", "last_activity_at"),
                ];
                if !search.is_empty() {
                    q.push(("search", search));
                }
                let resp = self.api(Method::GET, "/projects").query(&q).send().await?;
                let items: Vec<P> = Self::json(resp).await?;
                items
                    .into_iter()
                    .map(|p| RepoSummary {
                        full_name: p.path_with_namespace,
                        name: p.path,
                        description: p.description,
                        private: p.visibility.as_deref() != Some("public"),
                        fork: p.forked_from_project.is_some(),
                        clone_url: p.http_url_to_repo,
                        ssh_url: p.ssh_url_to_repo,
                        web_url: p.web_url,
                        default_branch: p.default_branch,
                        updated_at: p.last_activity_at,
                        stars: p.star_count.unwrap_or(0),
                    })
                    .collect::<Vec<_>>()
            }
        };
        let next_page = (repos.len() >= PER_PAGE).then_some(page + 1);
        Ok(RepoPage { repos, next_page })
    }

    /// 디바이스 플로우 시작 (AU-05). 사용자는 `verification_uri` 에서 `user_code` 를 입력한다
    pub async fn device_start(&self, client_id: &str) -> Result<DeviceCodes, HostingError> {
        let (url, form): (String, Vec<(&str, &str)>) = match self.kind {
            HostKind::GitHub => (
                format!("{}/login/device/code", self.oauth_base),
                vec![
                    ("client_id", client_id),
                    ("scope", self.kind.device_scope()),
                ],
            ),
            HostKind::GitLab => (
                format!("{}/oauth/authorize_device", self.oauth_base),
                vec![
                    ("client_id", client_id),
                    ("scope", self.kind.device_scope()),
                ],
            ),
        };
        let resp = self
            .http
            .post(url)
            .header(header::ACCEPT, "application/json")
            .form(&form)
            .send()
            .await?;
        let codes: DeviceCodesWire = Self::json(resp).await?;
        Ok(DeviceCodes {
            device_code: codes.device_code,
            user_code: codes.user_code,
            verification_uri: codes.verification_uri,
            verification_uri_complete: codes.verification_uri_complete,
            expires_in: codes.expires_in.unwrap_or(900),
            interval: codes.interval.unwrap_or(5),
        })
    }

    /// 디바이스 플로우 폴링 한 번
    pub async fn device_poll(
        &self,
        client_id: &str,
        device_code: &str,
    ) -> Result<DevicePoll, HostingError> {
        let url = match self.kind {
            HostKind::GitHub => format!("{}/login/oauth/access_token", self.oauth_base),
            HostKind::GitLab => format!("{}/oauth/token", self.oauth_base),
        };
        let resp = self
            .http
            .post(url)
            .header(header::ACCEPT, "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?;
        // GitLab 은 보류 중을 400 으로 주므로 상태 코드와 무관하게 본문을 본다
        let text = resp.text().await?;
        let wire: TokenWire = serde_json::from_str(&text)
            .map_err(|e| HostingError::Parse(format!("{e}: {}", snippet(&text))))?;
        if let Some(t) = wire.access_token {
            return Ok(DevicePoll::Token(t));
        }
        match wire.error.as_deref() {
            Some("authorization_pending") => Ok(DevicePoll::Pending),
            Some("slow_down") => Ok(DevicePoll::SlowDown),
            Some("expired_token") => Err(HostingError::DeviceExpired),
            Some("access_denied") => Err(HostingError::DeviceDenied),
            Some(other) => Err(HostingError::Other(format!(
                "{other}: {}",
                wire.error_description.unwrap_or_default()
            ))),
            None => Err(HostingError::Parse(snippet(&text))),
        }
    }

    /// 토큰이 나올 때까지 폴링한다 (`interval` 초마다, `expires_in` 안에서)
    pub async fn device_wait(
        &self,
        client_id: &str,
        codes: &DeviceCodes,
    ) -> Result<String, HostingError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(codes.expires_in.max(1));
        let mut interval = codes.interval;
        loop {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            if tokio::time::Instant::now() >= deadline {
                return Err(HostingError::DeviceExpired);
            }
            match self.device_poll(client_id, &codes.device_code).await? {
                DevicePoll::Token(t) => return Ok(t),
                DevicePoll::Pending => {}
                DevicePoll::SlowDown => interval += 5,
            }
        }
    }
}

/// 디바이스 코드 응답 (GitHub·GitLab 공통 필드)
#[derive(Deserialize)]
struct DeviceCodesWire {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
}

/// 토큰 응답
#[derive(Deserialize)]
struct TokenWire {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// 오류 메시지에 넣을 본문 앞부분
fn snippet(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() > 200 {
        format!("{}…", t.chars().take(200).collect::<String>())
    } else {
        t.to_string()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    /// 가짜 서버를 가리키는 클라이언트
    fn client(server: &MockServer, kind: HostKind, token: Option<&str>) -> HostingClient {
        HostingClient::with_bases(
            kind,
            server.base_url(),
            server.base_url(),
            token.map(String::from),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn github_verify_and_list() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/user").header("authorization", "Bearer t1");
                then.status(200)
                    .json_body(serde_json::json!({"login": "kim", "name": "Kim", "html_url": "https://github.com/kim"}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/user/repos").query_param("page", "1");
                then.status(200).json_body(serde_json::json!([{
                    "full_name": "kim/a", "name": "a", "private": true, "fork": false,
                    "clone_url": "https://github.com/kim/a.git", "ssh_url": "git@github.com:kim/a.git",
                    "html_url": "https://github.com/kim/a", "default_branch": "main", "stargazers_count": 3
                }]));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/search/repositories")
                    .query_param("q", "needle");
                then.status(200).json_body(serde_json::json!({"items": [{
                    "full_name": "x/needle", "name": "needle", "private": false, "fork": true,
                    "clone_url": "c", "ssh_url": "s", "html_url": "h"
                }]}));
            })
            .await;
        let c = client(&server, HostKind::GitHub, Some("t1"));
        let u = c.verify().await.unwrap();
        assert_eq!(u.login, "kim");
        assert_eq!(u.web_url.as_deref(), Some("https://github.com/kim"));
        let page = c.list_repos(1, "").await.unwrap();
        assert_eq!(page.repos.len(), 1);
        assert_eq!(page.repos[0].full_name, "kim/a");
        assert!(page.repos[0].private);
        assert_eq!(page.repos[0].stars, 3);
        assert!(page.next_page.is_none(), "50개 미만이면 다음 쪽 없음");
        let found = c.list_repos(1, "needle").await.unwrap();
        assert_eq!(found.repos[0].full_name, "x/needle");
        assert!(found.repos[0].fork);
    }

    #[tokio::test]
    async fn gitlab_verify_list_and_errors() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/user").header("authorization", "Bearer glpat");
                then.status(200)
                    .json_body(serde_json::json!({"username": "lee", "public_email": "l@x.io", "web_url": "https://gitlab.com/lee"}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/projects").query_param("search", "app");
                then.status(200).json_body(serde_json::json!([{
                    "path_with_namespace": "grp/app", "path": "app", "visibility": "private",
                    "forked_from_project": {"id": 1}, "http_url_to_repo": "https://gitlab.com/grp/app.git",
                    "ssh_url_to_repo": "git@gitlab.com:grp/app.git", "web_url": "https://gitlab.com/grp/app",
                    "default_branch": "main", "star_count": 1
                }]));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/user")
                    .header("authorization", "Bearer bad");
                then.status(401).body("{}");
            })
            .await;
        let c = client(&server, HostKind::GitLab, Some("glpat"));
        let u = c.verify().await.unwrap();
        assert_eq!(u.login, "lee");
        assert_eq!(u.email.as_deref(), Some("l@x.io"));
        let page = c.list_repos(1, "app").await.unwrap();
        assert_eq!(page.repos[0].full_name, "grp/app");
        assert!(page.repos[0].private && page.repos[0].fork);
        let bad = client(&server, HostKind::GitLab, Some("bad"));
        assert!(matches!(
            bad.verify().await,
            Err(HostingError::Unauthorized)
        ));
    }

    /// 교차 호스트 리다이렉트로 토큰을 넘기지 않는다 (GitLab 도 reqwest 가 지우는 헤더를 쓴다)
    #[tokio::test]
    async fn token_does_not_follow_cross_host_redirect() {
        for kind in [HostKind::GitHub, HostKind::GitLab] {
            let origin = MockServer::start_async().await;
            let other = MockServer::start_async().await;
            let target = format!("{}/user", other.base_url());
            origin
                .mock_async(move |when, then| {
                    when.method(GET).path("/user");
                    then.status(302).header("location", target.as_str());
                })
                .await;
            let leaked_private = other
                .mock_async(|when, then| {
                    when.method(GET)
                        .path("/user")
                        .header_exists("private-token");
                    then.status(418);
                })
                .await;
            let leaked_bearer = other
                .mock_async(|when, then| {
                    when.method(GET)
                        .path("/user")
                        .header_exists("authorization");
                    then.status(418);
                })
                .await;
            other
                .mock_async(|when, then| {
                    when.method(GET).path("/user");
                    then.status(200).json_body(serde_json::json!({
                        "login": "kim", "username": "kim"
                    }));
                })
                .await;
            let c = HostingClient::with_bases(
                kind,
                origin.base_url(),
                origin.base_url(),
                Some("secret".into()),
            )
            .unwrap();
            let got = c.verify().await;
            leaked_private.assert_calls_async(0).await;
            leaked_bearer.assert_calls_async(0).await;
            assert_eq!(got.unwrap().login, "kim");
        }
    }

    #[tokio::test]
    async fn rate_limit_and_not_found() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/user/repos");
                then.status(403)
                    .header("x-ratelimit-remaining", "0")
                    .header("retry-after", "7")
                    .body("rate limited");
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/user");
                then.status(404).body("nope");
            })
            .await;
        let c = client(&server, HostKind::GitHub, None);
        assert!(matches!(
            c.list_repos(1, "").await,
            Err(HostingError::RateLimited { retry_after: 7 })
        ));
        assert!(matches!(c.verify().await, Err(HostingError::NotFound(_))));
    }

    #[tokio::test]
    async fn device_flow_github() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/login/device/code")
                    .body_includes("client_id=app1")
                    .body_includes("scope=repo");
                then.status(200).json_body(serde_json::json!({
                    "device_code": "dc", "user_code": "ABCD-1234",
                    "verification_uri": "https://github.com/login/device", "expires_in": 5, "interval": 0
                }));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/login/oauth/access_token")
                    .body_includes("device_code=dc")
                    .body_includes(
                        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
                    );
                then.status(200).json_body(
                    serde_json::json!({"access_token": "gho_x", "token_type": "bearer"}),
                );
            })
            .await;
        let c = client(&server, HostKind::GitHub, None);
        let codes = c.device_start("app1").await.unwrap();
        assert_eq!(codes.user_code, "ABCD-1234");
        assert_eq!(codes.interval, 0);
        assert_eq!(c.device_wait("app1", &codes).await.unwrap(), "gho_x");
    }

    #[tokio::test]
    async fn device_poll_states() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/oauth/token")
                    .body_includes("device_code=pending");
                then.status(400)
                    .json_body(serde_json::json!({"error": "authorization_pending"}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/oauth/token")
                    .body_includes("device_code=slow");
                then.status(400)
                    .json_body(serde_json::json!({"error": "slow_down"}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/oauth/token")
                    .body_includes("device_code=denied");
                then.status(400)
                    .json_body(serde_json::json!({"error": "access_denied"}));
            })
            .await;
        let c = client(&server, HostKind::GitLab, None);
        assert_eq!(
            c.device_poll("id", "pending").await.unwrap(),
            DevicePoll::Pending
        );
        assert_eq!(
            c.device_poll("id", "slow").await.unwrap(),
            DevicePoll::SlowDown
        );
        assert!(matches!(
            c.device_poll("id", "denied").await,
            Err(HostingError::DeviceDenied)
        ));
        let expired = DeviceCodes {
            device_code: "pending".into(),
            user_code: "u".into(),
            verification_uri: "v".into(),
            verification_uri_complete: None,
            expires_in: 1,
            interval: 1,
        };
        assert!(matches!(
            c.device_wait("id", &expired).await,
            Err(HostingError::DeviceExpired)
        ));
    }

    #[test]
    fn urls() {
        assert_eq!(
            HostKind::GitHub.api_base("github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            HostKind::GitHub.api_base("ghe.corp"),
            "https://ghe.corp/api/v3"
        );
        assert_eq!(
            HostKind::GitLab.api_base("gitlab.com"),
            "https://gitlab.com/api/v4"
        );
        assert!(
            HostKind::GitLab
                .ssh_keys_url("gitlab.com")
                .contains("ssh_keys")
        );
    }
}
