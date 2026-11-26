//! 워크스페이스 검색. 기존 파일 읽기 경계를 사용하고 취소·결과 상한을 적용한다. 세션 공간의 순회 루트(`FsSpace::roots`
//! — 저장소·폴더는 접두 없는 루트 하나, 가상 그룹은 있는 멤버마다 별칭 접두)를 차례로 훑고, 결과 경로는 공간 경로다.
//! 여러 파일 바꾸기 미리보기(`replace`)도 같은 루트·같은 후보 순회(`walk_roots`)를 쓴다.
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
/// 빠른 열기(⌘P)가 프런트에서 거르고 순위를 매길 파일 목록. 후보는 내용 검색과 같은 순회로 고른다
#[derive(Default, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileList {
    /// 루트 기준 상대 경로(`/` 구분, 그룹은 `별칭/…`). 바이트 순으로 정렬돼 있다
    pub files: Vec<String>,
    /// `.git` 이 있는 디렉터리의 루트 기준 상대 경로(루트 자신은 `""`, 그룹 멤버 루트는 별칭). 파일의 저장소는 그
    /// 파일을 품은 가장 긴 디렉터리다 (내용 검색 결과의 `repo` 와 같은 규칙)
    pub repos: Vec<String>,
    pub skipped: u32,
    pub truncated: bool,
    pub cancelled: bool,
}
/// 검색·빠른 열기·바꾸기 미리보기가 훑는 후보 파일 수 상한 (세션 전체 — 그룹은 멤버들이 나눠 쓴다)
const CANDIDATE_LIMIT: u32 = 100_000;
/// 내용 검색 결과 줄 수 상한 (세션 전체)
const HIT_LIMIT: usize = 2000;

/// 검색·빠른 열기·바꾸기 미리보기가 훑을 루트 하나: 결과 경로 접두(디렉터리 공간은 "", 그룹은 멤버 별칭), 실제 루트,
/// 그 아래 저장소 디렉터리와 Git 이 추적하는 파일
pub(super) struct SearchRoot {
    pub(super) prefix: String,
    pub(super) root: std::path::PathBuf,
    pub(super) repos: Vec<std::path::PathBuf>,
    pub(super) tracked: Vec<std::path::PathBuf>,
}

impl Core {
    /// 검색 요청은 루트 안에서만 실행하며 초안 역시 실제 파일 후보에만 덮어쓴다. 그룹은 있는 멤버마다 그 루트를 훑고
    /// 결과 경로를 `별칭/…` 로 돌려준다 — 범위(scope)가 별칭이면 그 멤버만 훑는다
    pub async fn workspace_search(
        &self,
        session: SessionId,
        query: WorkspaceSearchQuery,
        cancel: CancelToken,
    ) -> Result<WorkspaceSearchResult, CoreError> {
        let roots = self.search_roots(session, &query.scope, &cancel).await?;
        run_blocking(move || search_all(roots, query, cancel)).await
    }

    /// 빠른 열기용으로 루트 아래 파일 전체(최대 10만 개)와 저장소 디렉터리를 돌려준다. 그룹은 있는 멤버들의 것을
    /// `별칭/…` 로 합친다
    pub async fn workspace_files(
        &self,
        session: SessionId,
        cancel: CancelToken,
    ) -> Result<WorkspaceFileList, CoreError> {
        let roots = self.search_roots(session, "", &cancel).await?;
        run_blocking(move || list_all(roots, &cancel)).await
    }

    /// 세션 공간의 순회 루트(`FsSpace::roots` — 그룹은 있는 멤버만) 가운데 공간 경로 범위 `scope` 에 드는 것마다
    /// 저장소·추적 파일을 모은다. 범위가 다른 멤버를 가리키면 그 멤버의 `git ls-files` 는 돌리지 않는다 (빈 범위는 전부)
    pub(super) async fn search_roots(
        &self,
        session: SessionId,
        scope: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<SearchRoot>, CoreError> {
        let mut out = Vec::new();
        for (prefix, root) in self.fs_space(session)?.roots() {
            if cancel.is_cancelled() {
                break;
            }
            if member_scope(&prefix, scope).is_none() {
                continue;
            }
            let (repos, tracked) = self.search_sources(&root, cancel).await?;
            out.push(SearchRoot {
                prefix,
                root,
                repos,
                tracked,
            });
        }
        Ok(out)
    }

    /// 루트 아래 저장소 디렉터리를 찾고, 무시 규칙에 걸려도 Git 이 추적하는 파일을 모은다 (순회가 놓치는 파일).
    pub(super) async fn search_sources(
        &self,
        root: &std::path::Path,
        cancel: &CancelToken,
    ) -> Result<(Vec<std::path::PathBuf>, Vec<std::path::PathBuf>), CoreError> {
        let scan_root = root.to_owned();
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
        for repo in &repos {
            if cancel.is_cancelled() {
                break;
            }
            let mut request = mgit_model::GitRequest::new(repo, ["ls-files", "--cached", "-z"]);
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
        Ok((repos, tracked))
    }
}
/// 공간 경로 범위(scope)를 루트 하나의 범위로 바꾼다. 접두 없는 루트(디렉터리 공간)는 그대로, 그룹 멤버는 범위가 비었거나
/// 그 별칭이면 '', `별칭/나머지` 면 나머지, 다른 멤버를 가리키면 None(그 멤버는 훑지 않는다)
fn member_scope(prefix: &str, scope: &str) -> Option<String> {
    if prefix.is_empty() || scope.is_empty() || scope == prefix {
        return Some(if prefix.is_empty() {
            scope.to_owned()
        } else {
            String::new()
        });
    }
    scope
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(str::to_owned)
}

/// 루트 기준 경로를 공간 경로로: 접두가 없으면 그대로, 있으면 `접두/경로` (경로가 비면 접두 자신)
fn shown<'a>(prefix: &str, path: &'a str) -> std::borrow::Cow<'a, str> {
    match (prefix.is_empty(), path.is_empty()) {
        (true, _) => std::borrow::Cow::Borrowed(path),
        (false, true) => std::borrow::Cow::Owned(prefix.to_owned()),
        (false, false) => std::borrow::Cow::Owned(format!("{prefix}/{path}")),
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
/// 범위가 있으면 루트 기준 상대 경로로 맞는지 확인한다 (내용 검색·바꾸기 공용)
pub(super) fn check_scope(scope: &str) -> Result<(), CoreError> {
    if !scope.is_empty() {
        mgit_model::RelPath::parse(scope).map_err(|e| CoreError::Invalid(e.to_string()))?;
    }
    Ok(())
}

/// 검색어를 Rust 정규식으로 만든다. 정규식이 아니면 글자 그대로 찾도록 이스케이프한다 (내용 검색·바꾸기가 같은
/// 엔진을 써서 미리보기와 적용이 어긋나지 않게 한다)
pub(super) fn build_matcher(
    text: &str,
    regex: bool,
    case_sensitive: bool,
) -> Result<regex::Regex, CoreError> {
    let pattern = if regex {
        text.to_owned()
    } else {
        regex::escape(text)
    };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(1024 * 1024)
        .build()
        .map_err(|e| CoreError::Invalid(e.to_string()))
}

/// 범위·경로 필터를 지난 후보 하나 (내용 검색·바꾸기 미리보기 공용). 파일 읽기는 실제 루트와 루트 기준 경로로, 결과·
/// 초안·이름 맞추기는 공간 경로(그룹은 `별칭/…`)로 한다
pub(super) struct Candidate<'a> {
    /// 이 후보를 품은 실제 루트 (그룹은 멤버 루트)
    pub(super) root: &'a std::path::Path,
    /// 후보의 절대 경로
    pub(super) entry: &'a std::path::Path,
    /// 루트 기준 경로 (`read_file_at` 등 기존 읽기 경계에 넘긴다)
    pub(super) path: &'a str,
    /// 공간 경로 (결과 `path`, 초안 키, 경로 필터·이름 맞추기 대상)
    pub(super) shown: &'a str,
    /// 공간 경로 접두 (디렉터리 공간은 "", 그룹은 멤버 별칭)
    prefix: &'a str,
}

impl Candidate<'_> {
    /// 파일을 품은 가장 가까운 저장소 디렉터리(`.git` 이 있는 조상, 루트 포함)의 공간 경로 (그룹 멤버 루트 자신은 별칭).
    /// 없으면 None
    pub(super) fn repo(&self) -> Option<String> {
        self.entry
            .ancestors()
            .skip(1)
            .take_while(|p| p.starts_with(self.root))
            .find(|p| p.join(".git").exists())
            .map(|p| {
                let rel = p.strip_prefix(self.root).unwrap_or(p).to_string_lossy();
                shown(self.prefix, &rel).into_owned()
            })
    }
}

/// 루트마다 차례로 후보를 훑는다 (내용 검색·바꾸기 미리보기 공용). 범위 `scope`(공간 경로)가 다른 멤버를 가리키는 루트는
/// 건너뛰고, 범위(그 경로 자신 또는 그 아래)와 경로 필터(공간 경로에 대소문자 무시 포함)에 드는 후보만 `visit` 에 넘긴다.
/// 후보 수 상한(10만)은 모든 루트가 나눠 쓰고, 상한·취소에 걸리거나 `visit` 이 false 를 돌려주면 남은 루트도 훑지 않는다
pub(super) fn walk_roots(
    roots: Vec<SearchRoot>,
    scope: &str,
    path_filter: &str,
    cancel: &CancelToken,
    mut visit: impl FnMut(&Candidate<'_>) -> bool,
) -> Walked {
    let filter = path_filter.to_lowercase();
    let mut total = Walked::default();
    let mut budget = CANDIDATE_LIMIT;
    let mut stopped = false;
    for SearchRoot {
        prefix,
        root,
        tracked,
        ..
    } in roots
    {
        let Some(scope) = member_scope(&prefix, scope) else {
            continue;
        };
        let walked = for_each_candidate(&root, tracked, cancel, &mut budget, |entry, path| {
            if !scope.is_empty() && path != scope && !path.starts_with(&format!("{scope}/")) {
                return true;
            }
            let shown_path = shown(&prefix, path);
            if !filter.is_empty() && !shown_path.to_lowercase().contains(&filter) {
                return true;
            }
            let go_on = visit(&Candidate {
                root: &root,
                entry,
                path,
                shown: &shown_path,
                prefix: &prefix,
            });
            stopped = !go_on;
            go_on
        });
        total.skipped += walked.skipped;
        total.truncated |= walked.truncated;
        total.cancelled |= walked.cancelled;
        if stopped || total.truncated || total.cancelled || cancel.is_cancelled() {
            break;
        }
    }
    total
}

/// 루트 하나(접두 없음)를 검색한다. 단위 테스트가 쓰는 한 루트 판이고, 실제 검색은 `search_all` 이 같은 길로 돈다
#[cfg(test)]
fn search(
    root: &std::path::Path,
    query: WorkspaceSearchQuery,
    cancel: CancelToken,
    tracked: Vec<std::path::PathBuf>,
) -> Result<WorkspaceSearchResult, CoreError> {
    let only = SearchRoot {
        prefix: String::new(),
        root: root.to_path_buf(),
        repos: Vec::new(),
        tracked,
    };
    search_all(vec![only], query, cancel)
}

/// 파일 후보를 모으고 정규식 또는 글자 그대로의 패턴으로 검색한다. 루트마다 차례로 훑고 후보 수(10만)·결과 줄
/// 수(2,000) 상한은 모든 루트가 나눠 쓴다. 범위·경로 거르기·초안·이름 맞추기·결과 `path`/`repo` 는 공간 경로(그룹은
/// `별칭/…`)로 보고, 파일 읽기는 그 루트 기준 경로로 기존 경계(`read_file_at`)를 거친다. 접두 없는 루트 하나(저장소·
/// 폴더 세션)는 공간 경로가 루트 기준 경로와 같아 결과가 루트를 나누기 전과 같다
fn search_all(
    roots: Vec<SearchRoot>,
    query: WorkspaceSearchQuery,
    cancel: CancelToken,
) -> Result<WorkspaceSearchResult, CoreError> {
    check_scope(&query.scope)?;
    let matcher = build_matcher(
        &query.text,
        query.regex && query.content,
        query.case_sensitive,
    )?;
    let drafts: HashMap<_, _> = query.drafts.into_iter().map(|d| (d.path, d.text)).collect();
    let mut out = WorkspaceSearchResult::default();
    // 결과 줄 상한·후보 상한·취소는 세션 전체에 걸린다 (`visit` 이 false 면 남은 루트도 훑지 않는다). 내용 검색어가 비면
    // 어느 루트에서도 결과가 없다
    let walked = walk_roots(roots, &query.scope, &query.path_filter, &cancel, |c| {
        let repo = c.repo();
        if !query.content {
            if matcher.is_match(c.shown) {
                out.hits.push(WorkspaceSearchHit {
                    path: c.shown.to_owned(),
                    repo,
                    line: 1,
                    column: 1,
                    text: String::new(),
                });
            }
        } else {
            if query.text.is_empty() {
                return false;
            }
            let text = match read_file_at(c.root, c.path) {
                Ok(FsFile::Text { text, .. }) => drafts.get(c.shown).cloned().unwrap_or(text),
                _ => {
                    out.skipped += 1;
                    return true;
                }
            };
            for (index, line) in text.lines().enumerate() {
                if cancel.is_cancelled() {
                    out.cancelled = true;
                    break;
                }
                if let Some(m) = matcher.find(line) {
                    out.hits.push(WorkspaceSearchHit {
                        path: c.shown.to_owned(),
                        repo: repo.clone(),
                        line: index as u32 + 1,
                        column: line[..m.start()].encode_utf16().count() as u32 + 1,
                        text: line.chars().take(500).collect(),
                    });
                }
                if out.hits.len() >= HIT_LIMIT {
                    out.truncated = true;
                    break;
                }
            }
        }
        if out.hits.len() >= HIT_LIMIT {
            out.truncated = true;
            return false;
        }
        true
    });
    out.skipped += walked.skipped;
    out.truncated |= walked.truncated;
    out.cancelled |= walked.cancelled;
    Ok(out)
}

/// 후보 순회에서 센 것: 읽지 못한 항목 수, 상한(10만 개)에 걸렸는지, 취소됐는지
#[derive(Default)]
pub(super) struct Walked {
    pub(super) skipped: u32,
    pub(super) truncated: bool,
    pub(super) cancelled: bool,
}

/// 추적 파일과 무시 규칙을 따르는 순회를 합쳐 한 번씩만, 링크가 아닌 일반 파일만 `visit(절대 경로, 루트 기준
/// 경로)` 에 넘긴다. `.git` 아래와 UTF-8 이 아닌 경로는 빠진다. 남은 후보 수 `budget` 을 다 쓰거나(그 다음 후보에서
/// 상한) `visit` 이 false 를 돌려주면 멈춘다. `budget` 은 여러 루트가 나눠 쓴다. 내용 검색·빠른 열기 목록·바꾸기
/// 미리보기가 같은 후보를 보도록 모두 이것을 쓴다 (검색·바꾸기는 `walk_roots` 를 거친다)
fn for_each_candidate(
    root: &std::path::Path,
    tracked: Vec<std::path::PathBuf>,
    cancel: &CancelToken,
    budget: &mut u32,
    mut visit: impl FnMut(&std::path::Path, &str) -> bool,
) -> Walked {
    let mut walked = Walked::default();
    let mut seen = HashSet::new();
    let walker = walk(root).map(|e| e.map(|e| e.into_path()));
    for entry in tracked.into_iter().map(Ok).chain(walker) {
        if cancel.is_cancelled() {
            walked.cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(v) => v,
            Err(_) => {
                walked.skipped += 1;
                continue;
            }
        };
        if !seen.insert(entry.clone()) || !entry.symlink_metadata().is_ok_and(|m| m.is_file()) {
            continue;
        }
        if *budget == 0 {
            walked.truncated = true;
            break;
        }
        *budget -= 1;
        let Some(path) = entry.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
            walked.skipped += 1;
            continue;
        };
        if path.split('/').any(|p| p.eq_ignore_ascii_case(".git")) {
            continue;
        }
        if !visit(&entry, path) {
            break;
        }
    }
    walked
}

/// 루트 하나(접두 없음)의 후보 목록. 단위 테스트가 쓰는 한 루트 판이고, 실제 목록은 `list_all` 이 같은 길로 만든다
#[cfg(test)]
fn list_files(
    root: &std::path::Path,
    repos: &[std::path::PathBuf],
    tracked: Vec<std::path::PathBuf>,
    cancel: &CancelToken,
) -> Result<WorkspaceFileList, CoreError> {
    let only = SearchRoot {
        prefix: String::new(),
        root: root.to_path_buf(),
        repos: repos.to_vec(),
        tracked,
    };
    list_all(vec![only], cancel)
}

/// 후보 파일을 모두 모아 정렬하고, 저장소 디렉터리를 공간 경로로 바꿔 함께 돌려준다. 루트마다 차례로 모으고 후보 수
/// 상한(10만)은 모든 루트가 나눠 쓴다. 그룹은 파일·저장소 경로가 `별칭/…`(멤버 루트 자신은 별칭)이다
fn list_all(roots: Vec<SearchRoot>, cancel: &CancelToken) -> Result<WorkspaceFileList, CoreError> {
    let mut files = Vec::new();
    let mut repos: Vec<String> = Vec::new();
    let mut walked = Walked::default();
    let mut budget = CANDIDATE_LIMIT;
    for SearchRoot {
        prefix,
        root,
        repos: root_repos,
        tracked,
    } in roots
    {
        let part = for_each_candidate(&root, tracked, cancel, &mut budget, |_, path| {
            files.push(shown(&prefix, path).into_owned());
            true
        });
        repos.extend(root_repos.iter().filter_map(|repo| {
            let rel = repo.strip_prefix(&root).ok()?.to_str()?;
            Some(shown(&prefix, rel).into_owned())
        }));
        walked.skipped += part.skipped;
        walked.truncated |= part.truncated;
        walked.cancelled |= part.cancelled;
        if walked.truncated || walked.cancelled {
            break;
        }
    }
    files.sort_unstable();
    repos.sort_unstable();
    repos.dedup();
    Ok(WorkspaceFileList {
        files,
        repos,
        skipped: walked.skipped,
        truncated: walked.truncated,
        cancelled: walked.cancelled,
    })
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

    /// 빠른 열기 목록은 내용 검색과 같은 후보(무시 규칙·추적 파일·`.git` 제외)를 정렬해 돌려주고 저장소 디렉터리를
    /// 루트 기준으로 바꾼다.
    #[test]
    fn lists_candidate_files_with_repo_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join(".git")).unwrap();
        std::fs::write(r.join(".git/config"), "").unwrap();
        std::fs::create_dir_all(r.join("sub/.git")).unwrap();
        std::fs::write(r.join("sub/b.rs"), "").unwrap();
        std::fs::write(r.join("a.txt"), "").unwrap();
        std::fs::write(r.join(".gitignore"), "hidden.txt\n").unwrap();
        std::fs::write(r.join("hidden.txt"), "").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", r.join("link")).unwrap();
        let repos = [r.to_path_buf(), r.join("sub"), r.join("sub")];
        let listed = list_files(r, &repos, vec![], &CancelToken::new()).unwrap();
        assert_eq!(listed.files, [".gitignore", "a.txt", "sub/b.rs"]);
        assert_eq!(listed.repos, ["", "sub"]);
        assert!(!listed.truncated && !listed.cancelled);
        let tracked = list_files(r, &repos, vec![r.join("hidden.txt")], &CancelToken::new());
        assert_eq!(
            tracked.unwrap().files,
            [".gitignore", "a.txt", "hidden.txt", "sub/b.rs"]
        );
        let c = CancelToken::new();
        c.cancel();
        let cancelled = list_files(r, &repos, vec![], &c).unwrap();
        assert!(cancelled.cancelled && cancelled.files.is_empty());
    }

    /// 후보 수 상한은 여러 루트가 나눠 쓴다: 남은 수를 다 쓴 다음 후보에서 잘렸다고 알리고, 다음 루트는 남은 수만큼만 본다
    #[test]
    fn candidate_budget_is_shared_across_roots() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for name in ["1.txt", "2.txt"] {
            std::fs::write(a.path().join(name), "").unwrap();
            std::fs::write(b.path().join(name), "").unwrap();
        }
        let mut budget = 3;
        let mut seen = 0;
        let first = for_each_candidate(
            a.path(),
            vec![],
            &CancelToken::new(),
            &mut budget,
            |_, _| {
                seen += 1;
                true
            },
        );
        assert_eq!((seen, budget, first.truncated), (2, 1, false));
        let second = for_each_candidate(
            b.path(),
            vec![],
            &CancelToken::new(),
            &mut budget,
            |_, _| {
                seen += 1;
                true
            },
        );
        assert_eq!((seen, budget, second.truncated), (3, 0, true));
    }

    /// 범위 나누기와 공간 경로: 접두 없는 루트는 범위·경로 그대로, 멤버는 별칭으로 고르고 별칭을 붙인다
    #[test]
    fn member_scope_and_shown_paths() {
        assert_eq!(member_scope("", "src/a"), Some("src/a".into()));
        assert_eq!(member_scope("", ""), Some(String::new()));
        assert_eq!(member_scope("api", ""), Some(String::new()));
        assert_eq!(member_scope("api", "api"), Some(String::new()));
        assert_eq!(member_scope("api", "api/src"), Some("src".into()));
        assert_eq!(member_scope("api", "apix/src"), None);
        assert_eq!(member_scope("api", "web"), None);
        assert_eq!(shown("", "a/b"), "a/b");
        assert_eq!(shown("api", "a/b"), "api/a/b");
        assert_eq!(shown("api", ""), "api");
    }
}
