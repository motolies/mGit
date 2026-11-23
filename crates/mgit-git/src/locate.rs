use std::path::{Path, PathBuf};

use mgit_model::GitError;

/// git 실행 파일 탐색 설정
#[derive(Clone, Debug, Default)]
pub struct LocateConfig {
    /// 사용자가 설정에서 직접 지정한 경로. 있으면 최우선
    pub configured_path: Option<PathBuf>,
}

/// git 실행 파일을 찾는다: 설정 경로 → PATH → 잘 알려진 경로.
/// 셸을 거치지 않고 디렉터리를 직접 훑는다 (`which` crate 불필요)
pub fn locate_git(cfg: &LocateConfig) -> Result<PathBuf, GitError> {
    if let Some(p) = &cfg.configured_path {
        return if is_executable(p) {
            Ok(p.clone())
        } else {
            Err(GitError::NotFound)
        };
    }
    if let Some(p) = search_path() {
        return Ok(p);
    }
    well_known()
        .into_iter()
        .find(|p| is_executable(p))
        .ok_or(GitError::NotFound)
}

/// `PATH` 의 각 디렉터리에서 `git`(Windows 는 `git.exe`)을 찾는다
fn search_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary_name()))
        .find(|p| is_executable(p))
}

/// OS 별 실행 파일 이름
fn binary_name() -> &'static str {
    if cfg!(windows) { "git.exe" } else { "git" }
}

/// PATH 에 없을 때 시도하는 설치 경로
fn well_known() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin/git"),
            PathBuf::from("/usr/local/bin/git"),
            PathBuf::from("/usr/bin/git"),
        ]
    } else if cfg!(windows) {
        let mut v = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                v.push(PathBuf::from(base).join("Git").join("cmd").join("git.exe"));
            }
        }
        v
    } else {
        vec![
            PathBuf::from("/usr/bin/git"),
            PathBuf::from("/usr/local/bin/git"),
        ]
    }
}

/// 파일이 존재하고 실행 가능한지 (Windows 는 존재 여부만)
fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// macOS 의 `/usr/bin/git` 은 xcrun 셔임이라 실행 비용이 약 2배다.
/// `xcrun --find git` 으로 실경로를 얻어 치환한다. 실패하면 원래 경로를 돌려준다
pub fn resolve_xcrun_shim(path: PathBuf) -> PathBuf {
    if !cfg!(target_os = "macos") || path != Path::new("/usr/bin/git") {
        return path;
    }
    let out = std::process::Command::new("/usr/bin/xcrun")
        .args(["--find", "git"])
        .stdin(std::process::Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let real = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
            if is_executable(&real) { real } else { path }
        }
        _ => path,
    }
}
