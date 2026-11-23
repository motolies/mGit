use std::path::{Path, PathBuf};

use mgit_model::{GitError, GitRequest, GitRunner, Oid, SubmoduleInfo, SubmoduleStatus};

/// 서브모듈 목록 (`git submodule status`; `-z` 가 없으므로 줄 단위)
pub async fn list_submodules(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<SubmoduleInfo>, GitError> {
    if !work_tree.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let req = GitRequest::new(work_tree, ["submodule", "status"]);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_submodule_status(&String::from_utf8_lossy(&out)))
}

/// `<prefix><sha> <path>[ (<describe>)]` 줄을 파싱한다. prefix ∈ {` `, `-`, `+`, `U`}
pub fn parse_submodule_status(text: &str) -> Vec<SubmoduleInfo> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.len() < 42 {
            continue;
        }
        let (prefix, rest) = line.split_at(1);
        let (sha, rest) = match rest.split_once(' ') {
            Some(p) => p,
            None => continue,
        };
        let Ok(oid) = Oid::from_hex(sha.as_bytes()) else {
            continue;
        };
        let (path, describe) = match rest.rsplit_once(" (") {
            Some((p, d)) if d.ends_with(')') => (p, Some(d.trim_end_matches(')').to_string())),
            _ => (rest, None),
        };
        let status = match prefix {
            "-" => SubmoduleStatus::NotInitialized,
            "+" => SubmoduleStatus::Mismatch,
            "U" => SubmoduleStatus::Conflict,
            _ => SubmoduleStatus::Clean,
        };
        out.push(SubmoduleInfo {
            path: path.to_string(),
            oid,
            status,
            describe,
        });
    }
    out
}

/// 이 저장소가 서브모듈이면 상위 저장소 작업 트리 (SUB-03)
pub async fn superproject(runner: &dyn GitRunner, work_tree: &Path) -> Option<PathBuf> {
    let req = GitRequest::new(work_tree, ["rev-parse", "--show-superproject-working-tree"]);
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    let text = out.stdout_lossy();
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(PathBuf::from(line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prefixes_and_describe() {
        let sha = "a".repeat(40);
        let text = format!(
            " {sha} libs/a (v1.0-3-gabc)\n-{sha} libs/b\n+{sha} libs/c (heads/main)\nU{sha} libs/d\n"
        );
        let r = parse_submodule_status(&text);
        assert_eq!(r.len(), 4);
        assert_eq!(r[0].status, SubmoduleStatus::Clean);
        assert_eq!(r[0].describe.as_deref(), Some("v1.0-3-gabc"));
        assert_eq!(r[1].status, SubmoduleStatus::NotInitialized);
        assert_eq!(r[1].path, "libs/b");
        assert_eq!(r[2].status, SubmoduleStatus::Mismatch);
        assert_eq!(r[3].status, SubmoduleStatus::Conflict);
    }
}
