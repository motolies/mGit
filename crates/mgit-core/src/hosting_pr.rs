//! PR/MR (HO-02·03·04) 과 아바타 캐시 (GRAPH-11)

use std::path::{Path, PathBuf};

use mgit_hosting::{CreatePr, HostKind, HostingClient, PullRequest};
use mgit_l10n::{pick, tr};
use mgit_model::{EnvProfile, GitRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::branch::CheckoutTarget;
use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::worktree::WorktreeSource;
use crate::write::WriteSpec;

/// 원격 ref 를 잠시 받아 두는 네임스페이스. `FETCH_HEAD` 는 자동 fetch 가 사이에 덮을 수 있다
const FETCH_NS: &str = "refs/mgit/fetch/";

/// 세션의 원격이 가리키는 호스팅 프로젝트
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    /// 같은 호스트에 연결된 계정 (없으면 PR 기능 비활성)
    pub account_id: Option<String>,
    pub kind: HostKind,
    pub host: String,
    /// `owner/repo`
    pub project: String,
    /// 원격 이름 (`origin`)
    pub remote: String,
}

/// PR 본문 템플릿
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrTemplate {
    pub name: String,
    pub body: String,
}

/// 웹 주소의 포트만 남긴다. ssh·git 포트는 API 주소가 아니고 기본 포트는 적지 않는다
fn host_with_web_port(scheme: &str, authority: &str) -> String {
    let (name, port) = authority.split_once(':').unwrap_or((authority, ""));
    let default = match scheme {
        "https" => "443",
        "http" => "80",
        _ => return name.to_string(),
    };
    if port.is_empty() || port == default {
        name.to_string()
    } else {
        format!("{name}:{port}")
    }
}

/// 원격 URL 에서 (호스트[:웹 포트], 저장소 전체 경로) 를 뽑는다.
/// `git@host:o/r.git`, `ssh://git@host[:port]/o/r.git`, `https://host[:port]/grp/sub/r(.git)` 를 지원한다.
/// userinfo 의 `@` 는 authority 안에서만 본다 (경로·쿼리의 `@` 로 호스트를 속이지 못하게)
pub fn parse_remote_url(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let scheme = ["ssh", "https", "http", "git"]
        .into_iter()
        .find(|s| url.strip_prefix(s).is_some_and(|r| r.starts_with("://")));
    let (host, path): (String, &str) = if let Some(scheme) = scheme {
        let rest = &url[scheme.len() + 3..];
        let end = rest.find(['/', '?', '#'])?;
        if !rest[end..].starts_with('/') {
            return None;
        }
        let authority = &rest[..end];
        let path = &rest[end + 1..];
        let host_port = authority.rsplit('@').next().unwrap_or(authority);
        (host_with_web_port(scheme, host_port), path)
    } else if let Some((user_host, path)) = url.split_once(':') {
        // scp 꼴: [user@]host:path (경로에 / 가 오기 전에 : 가 있어야 한다)
        if user_host.contains('/') {
            return None;
        }
        let host = user_host.rsplit('@').next().unwrap_or(user_host);
        (host.to_string(), path)
    } else {
        return None;
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let name = host.split(':').next().unwrap_or(&host);
    if name.is_empty() || !name.contains('.') && name != "localhost" {
        return None;
    }
    Some((host.to_lowercase(), parts.join("/")))
}

/// 저장소 경로를 호스팅 종류의 프로젝트 경로로. GitLab 은 하위 그룹까지 전체, GitHub 는 `owner/repo`
fn project_path(kind: HostKind, path: &str) -> String {
    match kind {
        HostKind::GitLab => path.to_string(),
        HostKind::GitHub => path.split('/').take(2).collect::<Vec<_>>().join("/"),
    }
}

/// 호스트 이름으로 종류를 짐작한다 (계정이 없을 때)
fn guess_kind(host: &str) -> HostKind {
    if host.contains("gitlab") {
        HostKind::GitLab
    } else {
        HostKind::GitHub
    }
}

/// 이메일 → 아바타 URL. GitHub noreply 는 API 없이 id 로, 그 외는 Gravatar(sha256)
pub fn avatar_url_for(email: &str) -> Option<String> {
    let e = email.trim().to_lowercase();
    if e.is_empty() {
        return None;
    }
    if let Some(local) = e.strip_suffix("@users.noreply.github.com") {
        let id = local.split('+').next().unwrap_or(local);
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("https://avatars.githubusercontent.com/u/{id}?s=64"));
        }
    }
    let hash = format!("{:x}", Sha256::digest(e.as_bytes()));
    Some(format!("https://gravatar.com/avatar/{hash}?s=64&d=404"))
}

/// base64 (표준 알파벳, 패딩). 외부 crate 없이 data URI 를 만든다
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 템플릿 후보 (종류별)
fn template_candidates(kind: HostKind) -> &'static [&'static str] {
    match kind {
        HostKind::GitHub => &[
            ".github/PULL_REQUEST_TEMPLATE.md",
            ".github/pull_request_template.md",
            "PULL_REQUEST_TEMPLATE.md",
            "pull_request_template.md",
            "docs/PULL_REQUEST_TEMPLATE.md",
            "docs/pull_request_template.md",
        ],
        HostKind::GitLab => &[".gitlab/merge_request_templates/Default.md"],
    }
}

/// 템플릿 디렉터리 (복수 템플릿)
fn template_dirs(kind: HostKind) -> &'static [&'static str] {
    match kind {
        HostKind::GitHub => &[
            ".github/PULL_REQUEST_TEMPLATE",
            "docs/PULL_REQUEST_TEMPLATE",
        ],
        HostKind::GitLab => &[".gitlab/merge_request_templates"],
    }
}

/// 작업 트리 안의 상대 경로가 심볼릭 링크를 지나지 않는지. 저장소가 심은 링크로 저장소 밖 파일을
/// PR 본문에 끌어오지 못하게 경로의 모든 단계를 본다
fn free_of_symlinks(work_tree: &Path, rel: &str) -> bool {
    let mut cur = work_tree.to_path_buf();
    rel.split('/').all(|part| {
        cur.push(part);
        std::fs::symlink_metadata(&cur).is_ok_and(|m| !m.file_type().is_symlink())
    })
}

/// 작업 트리에서 템플릿을 읽는다. 심볼릭 링크는 따라가지 않는다
pub fn read_pr_templates(work_tree: &Path, kind: HostKind) -> Vec<PrTemplate> {
    let mut out = Vec::new();
    for rel in template_candidates(kind) {
        if !free_of_symlinks(work_tree, rel) {
            continue;
        }
        if let Ok(body) = std::fs::read_to_string(work_tree.join(rel)) {
            out.push(PrTemplate {
                name: "default".into(),
                body,
            });
            break;
        }
    }
    for dir in template_dirs(kind) {
        if !free_of_symlinks(work_tree, dir) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(work_tree.join(dir)) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "md"))
            .collect();
        files.sort();
        for f in files {
            let name = f
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if out.iter().any(|t| t.name == name) {
                continue;
            }
            if let Ok(body) = std::fs::read_to_string(&f) {
                out.push(PrTemplate { name, body });
            }
        }
    }
    out
}

impl Core {
    /// 세션의 원격(`origin` 우선)이 가리키는 호스팅 프로젝트와 연결 계정
    pub fn remote_project(&self, session: SessionId) -> Result<Option<RemoteProject>, CoreError> {
        let s = self.inner_arc().get(session)?;
        let remotes = s.state().refs.remotes.clone();
        let remote = remotes
            .iter()
            .find(|r| r.name == "origin")
            .or_else(|| remotes.first())
            .cloned();
        let Some(remote) = remote else {
            return Ok(None);
        };
        let Some((host, path)) = parse_remote_url(&remote.fetch_url) else {
            return Ok(None);
        };
        let accounts = self.hosting_accounts();
        // SSH URL 에는 웹 포트가 없으므로 호스트 이름이 같은 계정을 쓴다. 토큰은 계정의 호스트로만 간다
        let account = accounts.iter().find(|a| a.host == host).or_else(|| {
            accounts
                .iter()
                .find(|a| !host.contains(':') && a.host.split(':').next() == Some(host.as_str()))
        });
        let kind = account.map(|a| a.kind).unwrap_or_else(|| guess_kind(&host));
        Ok(Some(RemoteProject {
            kind,
            account_id: account.map(|a| a.id.clone()),
            project: project_path(kind, &path),
            host,
            remote: remote.name,
        }))
    }

    /// 프로젝트 + 계정 클라이언트 (계정이 없으면 안내 오류)
    fn project_client(
        &self,
        session: SessionId,
    ) -> Result<(RemoteProject, HostingClient), CoreError> {
        let project = self
            .remote_project(session)?
            .ok_or_else(|| CoreError::Invalid(messages::not_hosted_project().into()))?;
        let account_id = project.account_id.clone().ok_or_else(|| {
            CoreError::Invalid(tr!(
                "{}에 연결된 계정이 없습니다. 호스팅 계정을 추가하세요.",
                "No account is connected to {}. Add a hosting account",
                project.host
            ))
        })?;
        let client = self.hosting_client(&account_id)?;
        Ok((project, client))
    }

    /// 열린 PR/MR 목록 (HO-02)
    pub async fn pull_requests(&self, session: SessionId) -> Result<Vec<PullRequest>, CoreError> {
        let (project, client) = self.project_client(session)?;
        Ok(client.list_prs(&project.project).await?)
    }

    /// PR 본문 템플릿 (HO-03)
    pub fn pr_templates(&self, session: SessionId) -> Result<Vec<PrTemplate>, CoreError> {
        let s = self.inner_arc().get(session)?;
        let kind = self
            .remote_project(session)?
            .map(|p| p.kind)
            .unwrap_or(HostKind::GitHub);
        Ok(read_pr_templates(&s.info.work_tree, kind))
    }

    /// PR/MR 만들기 (HO-03)
    pub async fn create_pull_request(
        &self,
        session: SessionId,
        spec: CreatePr,
    ) -> Result<PullRequest, CoreError> {
        if spec.title.trim().is_empty() {
            return Err(CoreError::Invalid(
                pick("제목을 입력하세요.", "Enter a title").into(),
            ));
        }
        if spec.head.trim().is_empty() || spec.base.trim().is_empty() {
            return Err(CoreError::Invalid(
                pick(
                    "소스(head) 브랜치와 대상(base) 브랜치를 지정하세요.",
                    "Specify the head and base branches",
                )
                .into(),
            ));
        }
        let (project, client) = self.project_client(session)?;
        Ok(client.create_pr(&project.project, &spec).await?)
    }

    /// PR/MR head 를 로컬 브랜치로 받아 체크아웃한다 (HO-04).
    /// `worktree` 가 있으면 그 경로에 새 워크트리로. 만든 브랜치 이름을 돌려준다
    pub async fn checkout_pull_request(
        &self,
        session: SessionId,
        number: u64,
        worktree: Option<&Path>,
    ) -> Result<String, CoreError> {
        let project = self
            .remote_project(session)?
            .ok_or_else(|| CoreError::Invalid(messages::not_hosted_project().into()))?;
        let (refspec, branch) = match project.kind {
            HostKind::GitHub => (format!("pull/{number}/head"), format!("pr/{number}")),
            HostKind::GitLab => (
                format!("merge-requests/{number}/head"),
                format!("mr/{number}"),
            ),
        };
        self.checkout_remote_ref(session, &project.remote, &refspec, &branch, worktree)
            .await?;
        Ok(branch)
    }

    /// git 을 읽기로 돌려 성공하면 stdout 을 돌려준다
    async fn read_git(&self, session: SessionId, args: &[&str]) -> Option<String> {
        let inner = self.inner_arc();
        let s = inner.get(session).ok()?;
        let req = GitRequest::new(&s.info.work_tree, args.iter().map(|a| (*a).to_string()))
            .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await.ok()?;
        out.exit
            .success()
            .then(|| out.stdout_lossy().trim().to_string())
    }

    /// 원격 ref 를 로컬 브랜치로 받아 체크아웃한다. 임시 ref 로 받은 뒤 fast-forward 만 한다:
    /// 로컬 브랜치에 받은 쪽에 없는 커밋이 있으면 덮지 않고 오류를 돌려준다
    pub async fn checkout_remote_ref(
        &self,
        session: SessionId,
        remote: &str,
        refspec: &str,
        branch: &str,
        worktree: Option<&Path>,
    ) -> Result<(), CoreError> {
        if remote.starts_with('-') || refspec.starts_with('-') || branch.starts_with('-') {
            return Err(CoreError::Invalid(
                pick("올바르지 않은 인자입니다", "Invalid argument").into(),
            ));
        }
        let op = self.begin_operation(session, "fetch", &format!("fetch {remote} {refspec}"))?;
        let fetched = format!("{FETCH_NS}{branch}");
        self.run_write(
            session,
            WriteSpec::new([
                "fetch",
                "--progress",
                "--end-of-options",
                remote,
                &format!("+{refspec}:{fetched}"),
            ])
            .network()
            .with_op(op)
            .progress()
            .no_undo(),
        )
        .await?;
        let new = self
            .read_git(
                session,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{fetched}^{{commit}}"),
                ],
            )
            .await;
        self.run_write(
            session,
            WriteSpec::new(["update-ref", "-d", &fetched])
                .no_undo()
                .skip_refresh(),
        )
        .await?;
        let new = new.ok_or_else(|| {
            CoreError::Invalid(tr!(
                "가져온 참조를 찾을 수 없습니다: {refspec}",
                "Fetched ref not found: {refspec}"
            ))
        })?;

        let full = format!("refs/heads/{branch}");
        let on_branch = self
            .read_git(session, &["symbolic-ref", "-q", "HEAD"])
            .await
            .is_some_and(|h| h == full);
        let old = self
            .read_git(session, &["rev-parse", "--verify", "--quiet", &full])
            .await;
        match old {
            None => {
                self.run_write(
                    session,
                    WriteSpec::new(["branch", "--no-track", "--end-of-options", branch, &new]),
                )
                .await?;
            }
            Some(old) if old == new => {}
            // branch 업데이트(BR-09)와 같은 fast-forward 이동 (조상 검사 → merge --ff-only 또는 branch -f)
            Some(old) => {
                if !self
                    .fast_forward_branch(session, branch, on_branch, &old, &new)
                    .await?
                {
                    return Err(CoreError::Invalid(tr!(
                        "로컬 브랜치 {branch}에 가져온 이력에 없는 커밋이 있어 덮어쓰지 않았습니다. \
                         브랜치 이름을 변경하거나 삭제한 뒤 다시 시도하세요.",
                        "Local branch {branch} has commits that are not in the fetched commits, so it was not overwritten. \
                         Rename or delete the branch and try again"
                    )));
                }
            }
        }
        match worktree {
            Some(path) => {
                self.worktree_add(session, path, WorktreeSource::Branch(branch.to_string()))
                    .await?;
            }
            None if on_branch => {}
            None => {
                self.checkout(session, CheckoutTarget::Branch(branch.to_string()), false)
                    .await?;
            }
        }
        Ok(())
    }

    /// 아바타 캐시 디렉터리 (`<data>/avatars`). 백업 디렉터리와 같은 부모
    fn avatar_dir(&self) -> Option<PathBuf> {
        self.config()
            .backup_dir
            .as_ref()
            .and_then(|b| b.parent().map(|p| p.join("avatars")))
    }

    /// 이메일의 아바타를 `data:` URI 로 (GRAPH-11). 없으면 None 을 캐시한다
    pub async fn avatar(&self, email: &str) -> Result<Option<String>, CoreError> {
        let Some(url) = avatar_url_for(email) else {
            return Ok(None);
        };
        let key = format!(
            "{:x}",
            Sha256::digest(email.trim().to_lowercase().as_bytes())
        );
        let dir = self.avatar_dir();
        if let Some(dir) = &dir {
            if dir.join(format!("{key}.none")).exists() {
                return Ok(None);
            }
            if let Ok(uri) = std::fs::read_to_string(dir.join(format!("{key}.uri"))) {
                return Ok(Some(uri));
            }
        }
        let fetched = HostingClient::fetch_bytes(&url).await?;
        let Some((bytes, ctype)) = fetched else {
            if let Some(dir) = &dir {
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(dir.join(format!("{key}.none")), b"");
            }
            return Ok(None);
        };
        let uri = format!("data:{ctype};base64,{}", base64_encode(&bytes));
        if let Some(dir) = &dir {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(dir.join(format!("{key}.uri")), &uri);
        }
        Ok(Some(uri))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_urls() {
        assert_eq!(
            parse_remote_url("git@github.com:Kim/App.git"),
            Some(("github.com".into(), "Kim/App".into()))
        );
        // GitLab 하위 그룹은 전체 경로가 프로젝트다
        assert_eq!(
            parse_remote_url("https://gitlab.example.com/grp/sub/app.git"),
            Some(("gitlab.example.com".into(), "grp/sub/app".into()))
        );
        assert_eq!(
            parse_remote_url("ssh://git@ghe.corp:2222/o/r/"),
            Some(("ghe.corp".into(), "o/r".into()))
        );
        assert_eq!(
            parse_remote_url("https://user@github.com/o/r"),
            Some(("github.com".into(), "o/r".into()))
        );
        // 웹 주소의 포트는 API 주소이기도 하므로 남기고, 기본 포트는 뗀다
        assert_eq!(
            parse_remote_url("https://gitlab.corp:8443/grp/app.git"),
            Some(("gitlab.corp:8443".into(), "grp/app".into()))
        );
        assert_eq!(
            parse_remote_url("https://gitlab.corp:443/grp/app.git"),
            Some(("gitlab.corp".into(), "grp/app".into()))
        );
        assert_eq!(
            parse_remote_url("http://localhost:3000/o/r"),
            Some(("localhost:3000".into(), "o/r".into()))
        );
        // 경로의 @ 나 쿼리·프래그먼트 뒤의 @ 로 호스트를 속일 수 없다
        assert_eq!(
            parse_remote_url("https://evil.example/x@github.com/o/r.git"),
            Some(("evil.example".into(), "x@github.com/o/r".into()))
        );
        assert!(parse_remote_url("https://evil.example#@github.com/o/r").is_none());
        assert!(parse_remote_url("https://evil.example?@github.com/o/r").is_none());
        assert!(parse_remote_url("/tmp/local/repo.git").is_none());
        assert!(parse_remote_url("file:///tmp/x").is_none());
        assert!(parse_remote_url("github.com/o").is_none());
    }

    #[test]
    fn avatar_urls_and_base64() {
        assert_eq!(
            avatar_url_for("123+kim@users.noreply.github.com").as_deref(),
            Some("https://avatars.githubusercontent.com/u/123?s=64")
        );
        let g = avatar_url_for(" Kim@Example.com ").unwrap_or_default();
        assert!(g.starts_with("https://gravatar.com/avatar/") && g.ends_with("?s=64&d=404"));
        assert!(avatar_url_for("  ").is_none());
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
