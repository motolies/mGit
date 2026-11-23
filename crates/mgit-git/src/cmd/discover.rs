use std::path::{Path, PathBuf};

use mgit_model::{
    CommitGraphStatus, FoundRepo, GitError, GitRequest, GitRunner, ObjectFormat, RepoKind,
};

/// `rev-parse` 로 알아낸 저장소 위치
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Discovered {
    pub work_tree: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub object_format: ObjectFormat,
}

/// 경로가 속한 저장소를 판별한다. 저장소 안의 하위 폴더를 줘도 최상위를 찾는다.
/// bare 저장소와 SHA-256 저장소는 `Unsupported`
pub async fn discover(runner: &dyn GitRunner, path: &Path) -> Result<Discovered, GitError> {
    let req = GitRequest::new(
        path,
        [
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
            "--show-object-format",
        ],
    );
    let args = req.display_args();
    let out = runner.run(req).await?;
    if !out.exit.success() {
        let stderr = out.exit.stderr.to_ascii_lowercase();
        if stderr.contains("not a git repository") {
            return Err(GitError::NotARepository(path.to_path_buf()));
        }
        if stderr.contains("must be run in a work tree")
            || stderr.contains("this operation must be run in a work tree")
        {
            return Err(GitError::Unsupported(bare_repository()));
        }
        return Err(GitError::Exit {
            status: out.exit.status,
            stderr: out.exit.stderr,
            args,
        });
    }
    let text = out.stdout_lossy();
    let mut lines = text.lines();
    let work_tree = PathBuf::from(lines.next().unwrap_or_default());
    let git_dir = PathBuf::from(lines.next().unwrap_or_default());
    let common_dir = PathBuf::from(lines.next().unwrap_or_default());
    let object_format = match lines.next().unwrap_or_default().trim() {
        "sha1" => ObjectFormat::Sha1,
        "sha256" => return Err(GitError::Unsupported("sha256 object format".into())),
        other => return Err(GitError::Unsupported(format!("object format {other}"))),
    };
    if work_tree.as_os_str().is_empty() {
        return Err(GitError::Unsupported(bare_repository()));
    }
    Ok(Discovered {
        work_tree,
        git_dir,
        common_dir,
        object_format,
    })
}

/// bare 저장소를 지원하지 않는다는 사유 (`GitError::Unsupported` 에 싣는 대상 설명, 지금 언어)
fn bare_repository() -> String {
    mgit_l10n::pick("bare 저장소", "bare repository").into()
}

/// 폴더 바로 아래(깊이 1)의 하위 저장소를 찾는다. `.git` 이 디렉터리든 파일(워크트리·서브모듈)이든
/// 저장소로 본다. 멀티 저장소 폴더 판별(REPO-01)에 쓰며, 정렬된 경로를 돌려준다
pub fn find_child_repos(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut repos: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|child| child.is_dir() && child.join(".git").exists())
        .collect();
    repos.sort();
    repos
}

/// commit-graph 파일이 있는지 (`objects/info/commit-graph` 또는 chain 파일)
pub fn detect_commit_graph(common_dir: &Path) -> CommitGraphStatus {
    let info = common_dir.join("objects").join("info");
    let present = info.join("commit-graph").is_file()
        || info
            .join("commit-graphs")
            .join("commit-graph-chain")
            .is_file();
    CommitGraphStatus { present }
}

/// 스캔에서 들어가지 않는 디렉터리 이름 (빌드 산출물·의존성)
pub const SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    "out",
    ".gradle",
    ".idea",
    ".vscode",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    "Pods",
    "DerivedData",
];

/// 디렉터리가 저장소면 종류를 돌려준다. `.git` 파일의 `gitdir:` 경로로 워크트리·서브모듈을 가른다
pub fn classify_repo_dir(dir: &Path) -> Option<RepoKind> {
    let dot = dir.join(".git");
    if dot.is_dir() {
        return Some(RepoKind::Standalone);
    }
    if !dot.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let target = text
        .trim()
        .strip_prefix("gitdir:")?
        .trim()
        .replace('\\', "/");
    if target.contains("/worktrees/") {
        Some(RepoKind::Worktree)
    } else if target.contains("/modules/") {
        Some(RepoKind::Submodule)
    } else {
        Some(RepoKind::Standalone)
    }
}

/// `root` 아래 `max_depth` 까지 저장소를 찾는다 (REPO-06, MR-01). 저장소 안으로는 들어가지 않고
/// `SCAN_SKIP_DIRS`·숨김 폴더는 건너뛴다. 경로 순으로 정렬
pub fn scan_repos(root: &Path, max_depth: u32) -> Vec<FoundRepo> {
    // 최근 목록·세션 경로와 맞추기 위해 정규화한다 (macOS /var → /private/var)
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut out = Vec::new();
    let mut frontier: Vec<(PathBuf, u32)> = vec![(root, 0)];
    while let Some((dir, depth)) = frontier.pop() {
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SCAN_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            match classify_repo_dir(&path) {
                Some(kind) => out.push(FoundRepo { path, kind }),
                None => frontier.push((path, depth + 1)),
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}
