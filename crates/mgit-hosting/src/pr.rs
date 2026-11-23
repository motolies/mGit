//! PR/MR 목록·생성 (HO-02·03) 과 이미지 받기 (GRAPH-11)

use reqwest::{Method, RequestBuilder, header};
use serde::{Deserialize, Serialize};

use crate::{HostKind, HostingClient, HostingError};

/// PR (GitHub) / MR (GitLab) 요약
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// GitHub number / GitLab iid
    pub number: u64,
    pub title: String,
    pub draft: bool,
    pub author: String,
    pub author_avatar: Option<String>,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    /// 포크에서 온 PR 이면 그 저장소 (`owner/name`)
    pub head_repo: Option<String>,
    pub cross_repo: bool,
    pub web_url: String,
    pub updated_at: Option<String>,
    /// approved · changes_requested · review_required
    pub review: Option<String>,
    /// success · failure · pending
    pub checks: Option<String>,
    pub mergeable: Option<bool>,
    pub labels: Vec<String>,
}

/// PR/MR 만들기 입력
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePr {
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

/// GitLab 프로젝트 경로 인코딩 (`owner/repo` → `owner%2Frepo`)
fn encode_project(project: &str) -> String {
    project.replace('/', "%2F")
}

/// GitHub GraphQL: 열린 PR 50개 + 리뷰·체크 상태
const GH_PR_QUERY: &str = r#"query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:50,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title isDraft author{login avatarUrl} headRefName headRefOid baseRefName isCrossRepository headRepository{nameWithOwner} url updatedAt reviewDecision mergeable labels(first:10){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}"#;

/// GraphQL 응답 조각
#[derive(Deserialize)]
struct GqlResp {
    data: Option<GqlData>,
    errors: Option<Vec<GqlError>>,
}
#[derive(Deserialize)]
struct GqlError {
    message: String,
}
#[derive(Deserialize)]
struct GqlData {
    repository: Option<GqlRepo>,
}
#[derive(Deserialize)]
struct GqlRepo {
    #[serde(rename = "pullRequests")]
    pull_requests: GqlPrs,
}
#[derive(Deserialize)]
struct GqlPrs {
    nodes: Vec<GqlPr>,
}
#[derive(Deserialize)]
struct GqlActor {
    login: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
struct GqlNamed {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}
#[derive(Deserialize)]
struct GqlLabel {
    name: String,
}
#[derive(Deserialize)]
struct GqlLabels {
    nodes: Vec<GqlLabel>,
}
#[derive(Deserialize)]
struct GqlRollup {
    state: Option<String>,
}
#[derive(Deserialize)]
struct GqlCommit {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<GqlRollup>,
}
#[derive(Deserialize)]
struct GqlCommitNode {
    commit: GqlCommit,
}
#[derive(Deserialize)]
struct GqlCommits {
    nodes: Vec<GqlCommitNode>,
}
#[derive(Deserialize)]
struct GqlPr {
    number: u64,
    title: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    author: Option<GqlActor>,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "headRefOid")]
    head_ref_oid: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    #[serde(rename = "isCrossRepository")]
    is_cross_repository: bool,
    #[serde(rename = "headRepository")]
    head_repository: Option<GqlNamed>,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    mergeable: Option<String>,
    labels: Option<GqlLabels>,
    commits: Option<GqlCommits>,
}

/// GitHub REST 의 PR (만들기 응답)
#[derive(Deserialize)]
struct GhRestPr {
    number: u64,
    title: String,
    draft: Option<bool>,
    user: Option<GhUser>,
    head: GhSide,
    base: GhBase,
    html_url: String,
    updated_at: Option<String>,
    labels: Option<Vec<GqlLabel>>,
}
#[derive(Deserialize)]
struct GhUser {
    login: String,
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
struct GhSide {
    #[serde(rename = "ref")]
    reference: String,
    sha: String,
    repo: Option<GhRepoRef>,
}
#[derive(Deserialize)]
struct GhBase {
    #[serde(rename = "ref")]
    reference: String,
    repo: Option<GhRepoRef>,
}
#[derive(Deserialize)]
struct GhRepoRef {
    full_name: String,
}

/// GitLab MR
#[derive(Deserialize)]
struct GlMr {
    iid: u64,
    title: String,
    draft: Option<bool>,
    author: Option<GlUser>,
    source_branch: String,
    sha: Option<String>,
    target_branch: String,
    source_project_id: Option<u64>,
    project_id: Option<u64>,
    web_url: String,
    updated_at: Option<String>,
    detailed_merge_status: Option<String>,
    has_conflicts: Option<bool>,
    labels: Option<Vec<String>>,
    head_pipeline: Option<GlPipeline>,
}
#[derive(Deserialize)]
struct GlUser {
    username: String,
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
struct GlPipeline {
    status: Option<String>,
}

/// GitHub 체크 상태 → success/failure/pending
fn gh_checks(state: Option<&str>) -> Option<String> {
    match state? {
        "SUCCESS" => Some("success".into()),
        "FAILURE" | "ERROR" => Some("failure".into()),
        "PENDING" | "EXPECTED" => Some("pending".into()),
        _ => None,
    }
}

/// GitLab 파이프라인 상태 → success/failure/pending
fn gl_checks(status: Option<&str>) -> Option<String> {
    match status? {
        "success" => Some("success".into()),
        "failed" | "canceled" => Some("failure".into()),
        "running" | "pending" | "created" | "waiting_for_resource" | "preparing" => {
            Some("pending".into())
        }
        _ => None,
    }
}

impl From<GlMr> for PullRequest {
    /// GitLab MR → 공통 모델
    fn from(m: GlMr) -> Self {
        let cross = matches!((m.source_project_id, m.project_id), (Some(a), Some(b)) if a != b);
        PullRequest {
            number: m.iid,
            title: m.title,
            draft: m.draft.unwrap_or(false),
            author: m
                .author
                .as_ref()
                .map(|a| a.username.clone())
                .unwrap_or_default(),
            author_avatar: m.author.and_then(|a| a.avatar_url),
            head_ref: m.source_branch,
            head_sha: m.sha.unwrap_or_default(),
            base_ref: m.target_branch,
            head_repo: None,
            cross_repo: cross,
            web_url: m.web_url,
            updated_at: m.updated_at,
            review: None,
            checks: gl_checks(m.head_pipeline.and_then(|p| p.status).as_deref()),
            mergeable: match (m.detailed_merge_status.as_deref(), m.has_conflicts) {
                (Some("mergeable"), _) => Some(true),
                (Some("conflict"), _) | (_, Some(true)) => Some(false),
                _ => None,
            },
            labels: m.labels.unwrap_or_default(),
        }
    }
}

impl HostingClient {
    /// GraphQL 요청. GitHub.com 은 `https://api.github.com/graphql`, GHES 는 REST 의 `/api/v3` 와
    /// 달리 `https://<host>/api/graphql` 이다
    fn graphql(&self) -> RequestBuilder {
        let url = match self.api_base.strip_suffix("/api/v3") {
            Some(host) => format!("{host}/api/graphql"),
            None => format!("{}/graphql", self.api_base),
        };
        self.authed(Method::POST, url)
    }

    /// 열린 PR/MR (HO-02). `project` 는 `owner/repo`
    pub async fn list_prs(&self, project: &str) -> Result<Vec<PullRequest>, HostingError> {
        match self.kind() {
            HostKind::GitHub => {
                let (owner, name) = project
                    .split_once('/')
                    .ok_or_else(|| HostingError::Other(crate::messages::bad_project(project)))?;
                let resp = self
                    .graphql()
                    .json(&serde_json::json!({
                        "query": GH_PR_QUERY,
                        "variables": { "owner": owner, "name": name },
                    }))
                    .send()
                    .await?;
                let r: GqlResp = Self::json(resp).await?;
                if let Some(errs) = r.errors.filter(|e| !e.is_empty()) {
                    return Err(HostingError::Other(
                        errs.into_iter()
                            .map(|e| e.message)
                            .collect::<Vec<_>>()
                            .join("; "),
                    ));
                }
                let nodes = r
                    .data
                    .and_then(|d| d.repository)
                    .map(|r| r.pull_requests.nodes)
                    .unwrap_or_default();
                Ok(nodes
                    .into_iter()
                    .map(|p| PullRequest {
                        number: p.number,
                        title: p.title,
                        draft: p.is_draft,
                        author: p
                            .author
                            .as_ref()
                            .map(|a| a.login.clone())
                            .unwrap_or_default(),
                        author_avatar: p.author.and_then(|a| a.avatar_url),
                        head_ref: p.head_ref_name,
                        head_sha: p.head_ref_oid,
                        base_ref: p.base_ref_name,
                        head_repo: p.head_repository.map(|h| h.name_with_owner),
                        cross_repo: p.is_cross_repository,
                        web_url: p.url,
                        updated_at: p.updated_at,
                        review: p.review_decision.map(|d| d.to_lowercase()),
                        checks: gh_checks(
                            p.commits
                                .and_then(|c| c.nodes.into_iter().next())
                                .and_then(|n| n.commit.status_check_rollup)
                                .and_then(|r| r.state)
                                .as_deref(),
                        ),
                        mergeable: match p.mergeable.as_deref() {
                            Some("MERGEABLE") => Some(true),
                            Some("CONFLICTING") => Some(false),
                            _ => None,
                        },
                        labels: p
                            .labels
                            .map(|l| l.nodes.into_iter().map(|n| n.name).collect())
                            .unwrap_or_default(),
                    })
                    .collect())
            }
            HostKind::GitLab => {
                let path = format!("/projects/{}/merge_requests", encode_project(project));
                let resp = self
                    .api(Method::GET, &path)
                    .query(&[
                        ("state", "opened"),
                        ("per_page", "50"),
                        ("order_by", "updated_at"),
                    ])
                    .send()
                    .await?;
                let list: Vec<GlMr> = Self::json(resp).await?;
                Ok(list.into_iter().map(Into::into).collect())
            }
        }
    }

    /// PR/MR 만들기 (HO-03)
    pub async fn create_pr(
        &self,
        project: &str,
        spec: &CreatePr,
    ) -> Result<PullRequest, HostingError> {
        match self.kind() {
            HostKind::GitHub => {
                let path = format!("/repos/{project}/pulls");
                let resp = self
                    .api(Method::POST, &path)
                    .json(&serde_json::json!({
                        "title": spec.title,
                        "head": spec.head,
                        "base": spec.base,
                        "body": spec.body,
                        "draft": spec.draft,
                    }))
                    .send()
                    .await?;
                let p: GhRestPr = Self::json(resp).await?;
                let base_repo = p.base.repo.as_ref().map(|r| r.full_name.clone());
                let head_repo = p.head.repo.map(|r| r.full_name);
                Ok(PullRequest {
                    number: p.number,
                    title: p.title,
                    draft: p.draft.unwrap_or(false),
                    author: p.user.as_ref().map(|u| u.login.clone()).unwrap_or_default(),
                    author_avatar: p.user.and_then(|u| u.avatar_url),
                    head_ref: p.head.reference,
                    head_sha: p.head.sha,
                    base_ref: p.base.reference,
                    cross_repo: head_repo.is_some() && head_repo != base_repo,
                    head_repo,
                    web_url: p.html_url,
                    updated_at: p.updated_at,
                    review: None,
                    checks: None,
                    mergeable: None,
                    labels: p
                        .labels
                        .map(|l| l.into_iter().map(|x| x.name).collect())
                        .unwrap_or_default(),
                })
            }
            HostKind::GitLab => {
                let path = format!("/projects/{}/merge_requests", encode_project(project));
                let title = if spec.draft && !spec.title.starts_with("Draft:") {
                    format!("Draft: {}", spec.title)
                } else {
                    spec.title.clone()
                };
                let resp = self
                    .api(Method::POST, &path)
                    .json(&serde_json::json!({
                        "source_branch": spec.head,
                        "target_branch": spec.base,
                        "title": title,
                        "description": spec.body,
                    }))
                    .send()
                    .await?;
                let m: GlMr = Self::json(resp).await?;
                Ok(m.into())
            }
        }
    }

    /// 이미지 등 바이트 받기 (GRAPH-11 아바타). 인증 없이, 10초 안에
    pub async fn fetch_bytes(url: &str) -> Result<Option<(Vec<u8>, String)>, HostingError> {
        let http = reqwest::Client::builder()
            .user_agent("mGit")
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        let resp = http.get(url).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = Self::check(resp).await?;
        let ctype = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string();
        let bytes = resp.bytes().await?.to_vec();
        Ok(Some((bytes, ctype)))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    /// 가짜 서버 클라이언트
    fn client(server: &MockServer, kind: HostKind) -> HostingClient {
        HostingClient::with_bases(kind, server.base_url(), server.base_url(), Some("t".into()))
            .unwrap()
    }

    #[tokio::test]
    async fn github_prs_via_graphql_and_create() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(POST).path("/graphql").body_includes("\"owner\":\"kim\"");
                then.status(200).json_body(serde_json::json!({"data": {"repository": {"pullRequests": {"nodes": [{
                    "number": 7, "title": "feat", "isDraft": false,
                    "author": {"login": "lee", "avatarUrl": "https://a/lee.png"},
                    "headRefName": "feat", "headRefOid": "abc", "baseRefName": "main",
                    "isCrossRepository": true, "headRepository": {"nameWithOwner": "lee/app"},
                    "url": "https://github.com/kim/app/pull/7", "updatedAt": "2026-01-01T00:00:00Z",
                    "reviewDecision": "APPROVED", "mergeable": "MERGEABLE",
                    "labels": {"nodes": [{"name": "bug"}]},
                    "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE"}}}]}
                }]}}}}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/repos/kim/app/pulls")
                    .body_includes("\"head\":\"feat2\"");
                then.status(201).json_body(serde_json::json!({
                    "number": 8, "title": "new", "draft": true, "user": {"login": "kim"},
                    "head": {"ref": "feat2", "sha": "def", "repo": {"full_name": "kim/app"}},
                    "base": {"ref": "main", "repo": {"full_name": "kim/app"}},
                    "html_url": "https://github.com/kim/app/pull/8", "labels": []
                }));
            })
            .await;
        let c = client(&server, HostKind::GitHub);
        let prs = c.list_prs("kim/app").await.unwrap();
        assert_eq!(prs.len(), 1);
        let p = &prs[0];
        assert_eq!(p.number, 7);
        assert_eq!(p.review.as_deref(), Some("approved"));
        assert_eq!(p.checks.as_deref(), Some("failure"));
        assert_eq!(p.mergeable, Some(true));
        assert_eq!(p.head_repo.as_deref(), Some("lee/app"));
        assert!(p.cross_repo);
        assert_eq!(p.labels, vec!["bug"]);
        let created = c
            .create_pr(
                "kim/app",
                &CreatePr {
                    head: "feat2".into(),
                    base: "main".into(),
                    title: "new".into(),
                    body: String::new(),
                    draft: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(created.number, 8);
        assert!(created.draft && !created.cross_repo);
    }

    /// GHES 의 GraphQL 은 REST 의 `/api/v3` 아래가 아니라 `/api/graphql` 이다
    #[tokio::test]
    async fn ghes_graphql_uses_api_graphql_path() {
        let server = MockServer::start_async().await;
        let graphql = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/graphql");
                then.status(200).json_body(serde_json::json!({
                    "data": {"repository": {"pullRequests": {"nodes": []}}}
                }));
            })
            .await;
        let c = HostingClient::with_bases(
            HostKind::GitHub,
            format!("{}/api/v3", server.base_url()),
            server.base_url(),
            Some("t".into()),
        )
        .unwrap();
        assert_eq!(c.list_prs("kim/app").await.unwrap(), Vec::new());
        graphql.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn gitlab_mrs_and_create_draft() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/projects/grp%2Fapp/merge_requests")
                    .query_param("state", "opened");
                then.status(200).json_body(serde_json::json!([{
                    "iid": 3, "title": "fix", "draft": false, "author": {"username": "park"},
                    "source_branch": "fix", "sha": "aaa", "target_branch": "main",
                    "source_project_id": 2, "project_id": 1, "web_url": "https://gitlab.com/grp/app/-/merge_requests/3",
                    "detailed_merge_status": "conflict", "labels": ["x"], "head_pipeline": {"status": "running"}
                }]));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/projects/grp%2Fapp/merge_requests")
                    .body_includes("\"title\":\"Draft: wip\"");
                then.status(201).json_body(serde_json::json!({
                    "iid": 4, "title": "Draft: wip", "draft": true, "source_branch": "wip",
                    "target_branch": "main", "web_url": "u"
                }));
            })
            .await;
        let c = client(&server, HostKind::GitLab);
        let mrs = c.list_prs("grp/app").await.unwrap();
        assert_eq!(mrs[0].number, 3);
        assert!(mrs[0].cross_repo);
        assert_eq!(mrs[0].mergeable, Some(false));
        assert_eq!(mrs[0].checks.as_deref(), Some("pending"));
        let created = c
            .create_pr(
                "grp/app",
                &CreatePr {
                    head: "wip".into(),
                    base: "main".into(),
                    title: "wip".into(),
                    body: "b".into(),
                    draft: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(created.number, 4);
        assert!(created.draft);
    }

    #[tokio::test]
    async fn graphql_errors_and_fetch_bytes() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(POST).path("/graphql");
                then.status(200)
                    .json_body(serde_json::json!({"errors": [{"message": "Could not resolve"}]}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/img.png");
                then.status(200)
                    .header("content-type", "image/png")
                    .body("PNG!");
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/missing.png");
                then.status(404);
            })
            .await;
        let c = client(&server, HostKind::GitHub);
        assert!(matches!(
            c.list_prs("a/b").await,
            Err(HostingError::Other(_))
        ));
        let (bytes, ctype) = HostingClient::fetch_bytes(&format!("{}/img.png", server.base_url()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bytes, b"PNG!");
        assert_eq!(ctype, "image/png");
        assert!(
            HostingClient::fetch_bytes(&format!("{}/missing.png", server.base_url()))
                .await
                .unwrap()
                .is_none()
        );
    }
}
