use std::path::{Component, Path};

use mgit_model::{ChangeKind, WatchSpec};

/// 경로를 변경 종류로 분류한다. `*.lock` 과 로그·객체 파일은 무시(`None`)
pub fn classify_path(path: &Path, spec: &WatchSpec) -> Option<ChangeKind> {
    let name = path.file_name()?.to_string_lossy();
    if name.ends_with(".lock") {
        return None;
    }
    if let Ok(rel) = path.strip_prefix(&spec.git_dir) {
        return classify_git_dir(rel);
    }
    if let Ok(rel) = path.strip_prefix(&spec.common_dir) {
        return classify_git_dir(rel);
    }
    if let Some(wt) = &spec.work_tree
        && let Ok(rel) = path.strip_prefix(wt)
    {
        // 작업 트리 안의 .git(디렉터리나 파일)과 제외 디렉터리는 무시
        for comp in rel.components() {
            if let Component::Normal(c) = comp {
                let c = c.to_string_lossy();
                if spec.ignore_dirs.iter().any(|d| d == c.as_ref()) {
                    return None;
                }
            }
        }
        return Some(ChangeKind::WorkTree);
    }
    None
}

/// `$GIT_DIR`·`$GIT_COMMON_DIR` 기준 상대 경로를 분류한다
fn classify_git_dir(rel: &Path) -> Option<ChangeKind> {
    let mut comps = rel.components();
    let first = match comps.next()? {
        Component::Normal(c) => c.to_string_lossy().into_owned(),
        _ => return None,
    };
    let nested = comps.next().is_some();
    Some(match first.as_str() {
        "index" => ChangeKind::Index,
        "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" => ChangeKind::Head,
        "packed-refs" => ChangeKind::PackedRefs,
        "refs" | "reftable" => ChangeKind::Refs,
        "config" => ChangeKind::Config,
        "MERGE_HEAD" | "MERGE_MSG" | "MERGE_MODE" | "CHERRY_PICK_HEAD" | "REVERT_HEAD"
        | "BISECT_LOG" | "BISECT_START" | "AUTO_MERGE" => ChangeKind::Op,
        "rebase-merge" | "rebase-apply" | "sequencer" => ChangeKind::Op,
        "logs" | "objects" | "info" | "hooks" | "lfs" | "modules" | "worktrees" => return None,
        _ if nested => return None,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// 테스트용 spec
    fn spec() -> WatchSpec {
        WatchSpec::new(
            PathBuf::from("/r/.git"),
            PathBuf::from("/r/.git"),
            Some(PathBuf::from("/r")),
        )
    }

    #[test]
    fn git_dir_paths_are_classified() {
        let s = spec();
        assert_eq!(
            classify_path(Path::new("/r/.git/index"), &s),
            Some(ChangeKind::Index)
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/HEAD"), &s),
            Some(ChangeKind::Head)
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/refs/heads/main"), &s),
            Some(ChangeKind::Refs)
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/packed-refs"), &s),
            Some(ChangeKind::PackedRefs)
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/rebase-merge/done"), &s),
            Some(ChangeKind::Op)
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/MERGE_HEAD"), &s),
            Some(ChangeKind::Op)
        );
        assert_eq!(classify_path(Path::new("/r/.git/index.lock"), &s), None);
        assert_eq!(classify_path(Path::new("/r/.git/objects/ab/cd"), &s), None);
        assert_eq!(classify_path(Path::new("/r/.git/logs/HEAD"), &s), None);
    }

    #[test]
    fn work_tree_paths_respect_ignore_list() {
        let s = spec();
        assert_eq!(
            classify_path(Path::new("/r/src/main.rs"), &s),
            Some(ChangeKind::WorkTree)
        );
        assert_eq!(classify_path(Path::new("/r/node_modules/x/y.js"), &s), None);
        assert_eq!(classify_path(Path::new("/r/target/debug/a"), &s), None);
        assert_eq!(classify_path(Path::new("/elsewhere/x"), &s), None);
    }

    #[test]
    fn linked_worktree_has_separate_git_dir() {
        let s = WatchSpec::new(
            PathBuf::from("/r/.git/worktrees/wt"),
            PathBuf::from("/r/.git"),
            Some(PathBuf::from("/wt")),
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/worktrees/wt/HEAD"), &s),
            Some(ChangeKind::Head)
        );
        assert_eq!(
            classify_path(Path::new("/r/.git/refs/heads/x"), &s),
            Some(ChangeKind::Refs)
        );
        assert_eq!(
            classify_path(Path::new("/wt/a.txt"), &s),
            Some(ChangeKind::WorkTree)
        );
    }
}
