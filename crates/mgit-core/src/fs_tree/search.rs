//! 워크스페이스 검색. 기존 파일 읽기 경계를 사용하고 취소·결과 상한을 적용한다.
use super::{FsFile, read_file_at, run_blocking};
use crate::{Core, CoreError, SessionId};
use mgit_model::CancelToken;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchDraft {
    pub path: String,
    pub text: String,
}
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchQuery {
    pub text: String,
    pub content: bool,
    pub regex: bool,
    pub case_sensitive: bool,
    pub path_filter: String,
    pub scope: String,
    pub drafts: Vec<SearchDraft>,
}
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchHit {
    pub path: String,
    pub repo: Option<String>,
    pub line: u32,
    pub column: u32,
    pub text: String,
}
#[derive(Default, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub hits: Vec<WorkspaceSearchHit>,
    pub skipped: u32,
    pub truncated: bool,
    pub cancelled: bool,
}
impl Core {
    /// 검색 요청은 루트 안에서만 실행하며 초안 역시 실제 파일 후보에만 덮어쓴다.
    pub async fn workspace_search(
        &self,
        session: SessionId,
        query: WorkspaceSearchQuery,
        cancel: CancelToken,
    ) -> Result<WorkspaceSearchResult, CoreError> {
        let root = self.fs_root(session)?;
        let scan_root = root.clone();
        let scan_cancel = cancel.clone();
        let repos = run_blocking(move || {
            let mut repos = Vec::new();
            for entry in walk(&scan_root).take(100_000) {
                if scan_cancel.is_cancelled() {
                    break;
                }
                if let Ok(entry) = entry
                    && entry.file_type().is_some_and(|t| t.is_dir())
                    && entry.path().join(".git").exists()
                {
                    repos.push(entry.path().to_owned());
                }
            }
            Ok(repos)
        })
        .await?;
        let mut tracked = Vec::new();
        for repo in repos {
            if cancel.is_cancelled() {
                break;
            }
            let mut request = mgit_model::GitRequest::new(&repo, ["ls-files", "--cached", "-z"]);
            request.cancel = Some(cancel.clone());
            if let Ok(output) = self.inner_arc().runner().run(request).await
                && output.exit.success()
            {
                for bytes in output.stdout.split(|b| *b == 0) {
                    if cancel.is_cancelled() {
                        break;
                    }
                    if let Ok(path) = std::str::from_utf8(bytes)
                        && !path.is_empty()
                    {
                        tracked.push(repo.join(path));
                    }
                }
            }
        }
        run_blocking(move || search(&root, query, cancel, tracked)).await
    }
}
/// Git 메타데이터는 디렉터리 진입 전 제외한다.
fn walk(root: &std::path::Path) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .filter_entry(|entry| {
            !entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
        })
        .build()
}
/// 파일 후보를 모으고 정규식 또는 글자 그대로의 패턴으로 검색한다.
fn search(
    root: &std::path::Path,
    query: WorkspaceSearchQuery,
    cancel: CancelToken,
    tracked: Vec<std::path::PathBuf>,
) -> Result<WorkspaceSearchResult, CoreError> {
    if !query.scope.is_empty() {
        mgit_model::RelPath::parse(&query.scope).map_err(|e| CoreError::Invalid(e.to_string()))?;
    }
    let pattern = if query.regex && query.content {
        query.text.clone()
    } else {
        regex::escape(&query.text)
    };
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .size_limit(1024 * 1024)
        .build()
        .map_err(|e| CoreError::Invalid(e.to_string()))?;
    let drafts: HashMap<_, _> = query.drafts.into_iter().map(|d| (d.path, d.text)).collect();
    let mut out = WorkspaceSearchResult::default();
    let mut visited = 0;
    let mut seen = HashSet::new();
    let walker = walk(root).map(|e| e.map(|e| e.into_path()));
    for entry in tracked.into_iter().map(Ok).chain(walker) {
        if cancel.is_cancelled() {
            out.cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(v) => v,
            Err(_) => {
                out.skipped += 1;
                continue;
            }
        };
        if !seen.insert(entry.clone()) || !entry.symlink_metadata().is_ok_and(|m| m.is_file()) {
            continue;
        }
        visited += 1;
        if visited > 100_000 {
            out.truncated = true;
            break;
        }
        let Some(path) = entry.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
            out.skipped += 1;
            continue;
        };
        if path.split('/').any(|p| p.eq_ignore_ascii_case(".git")) {
            continue;
        }
        if !query.scope.is_empty()
            && path != query.scope
            && !path.starts_with(&format!("{}/", query.scope))
        {
            continue;
        }
        if !query.path_filter.is_empty()
            && !path
                .to_lowercase()
                .contains(&query.path_filter.to_lowercase())
        {
            continue;
        }
        let repo = entry
            .ancestors()
            .skip(1)
            .take_while(|p| p.starts_with(root))
            .find(|p| p.join(".git").exists())
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned()
            });
        if !query.content {
            if matcher.is_match(path) {
                out.hits.push(WorkspaceSearchHit {
                    path: path.into(),
                    repo,
                    line: 1,
                    column: 1,
                    text: String::new(),
                });
            }
        } else {
            if query.text.is_empty() {
                break;
            }
            let text = match read_file_at(root, path) {
                Ok(FsFile::Text { text, .. }) => drafts.get(path).cloned().unwrap_or(text),
                _ => {
                    out.skipped += 1;
                    continue;
                }
            };
            for (index, line) in text.lines().enumerate() {
                if cancel.is_cancelled() {
                    out.cancelled = true;
                    break;
                }
                if let Some(m) = matcher.find(line) {
                    out.hits.push(WorkspaceSearchHit {
                        path: path.into(),
                        repo: repo.clone(),
                        line: index as u32 + 1,
                        column: line[..m.start()].encode_utf16().count() as u32 + 1,
                        text: line.chars().take(500).collect(),
                    });
                }
                if out.hits.len() >= 2000 {
                    out.truncated = true;
                    break;
                }
            }
        }
        if out.hits.len() >= 2000 {
            out.truncated = true;
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    /// 초안·정규식·무시 파일·심볼릭 링크·취소를 실제 파일에서 검사한다.
    #[test]
    fn searches_drafts_without_following_links() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::write(r.join("a.txt"), "old\nhello").unwrap();
        std::fs::write(r.join(".gitignore"), "hidden.txt\n").unwrap();
        std::fs::write(r.join("hidden.txt"), "new").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", r.join("link")).unwrap();
        let q = WorkspaceSearchQuery {
            text: "new".into(),
            content: true,
            regex: false,
            case_sensitive: false,
            path_filter: String::new(),
            scope: String::new(),
            drafts: vec![SearchDraft {
                path: "a.txt".into(),
                text: "new".into(),
            }],
        };
        let found = search(r, q.clone(), CancelToken::new(), vec![]).unwrap();
        assert_eq!(found.hits.len(), 1);
        let tracked = search(r, q.clone(), CancelToken::new(), vec![r.join("hidden.txt")]).unwrap();
        assert_eq!(tracked.hits.len(), 2);
        assert_eq!(found.hits[0].path, "a.txt");
        let c = CancelToken::new();
        c.cancel();
        assert!(search(r, q, c, vec![]).unwrap().cancelled);
    }
}
