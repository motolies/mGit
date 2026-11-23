use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, InProgressOp, Oid};

/// `$GIT_DIR` 의 상태 파일로 진행 중 작업을 판별한다 (git `wt-status.c` 와 같은 규칙).
/// 우선순위: rebase/am → merge → cherry-pick → revert → bisect
pub async fn in_progress_op(
    runner: &dyn GitRunner,
    git_dir: &Path,
    common_dir: &Path,
    work_tree: &Path,
) -> Result<Option<InProgressOp>, GitError> {
    if let Some(op) = rebase_state(git_dir) {
        return Ok(Some(op));
    }
    if let Some(head) = read_oid_file(&git_dir.join("MERGE_HEAD")) {
        return Ok(Some(InProgressOp::Merge { head }));
    }
    let reftable = common_dir.join("reftable").is_dir();
    let sequencer = git_dir.join("sequencer").is_dir();
    if let Some(head) = pseudo_ref(runner, git_dir, work_tree, "CHERRY_PICK_HEAD", reftable).await?
    {
        return Ok(Some(InProgressOp::CherryPick { head, sequencer }));
    }
    if let Some(head) = pseudo_ref(runner, git_dir, work_tree, "REVERT_HEAD", reftable).await? {
        return Ok(Some(InProgressOp::Revert { head, sequencer }));
    }
    if git_dir.join("BISECT_LOG").is_file() {
        return Ok(Some(InProgressOp::Bisect));
    }
    Ok(None)
}

/// `rebase-merge/`(기본 merge 백엔드) 또는 `rebase-apply/`(apply 백엔드·am)
fn rebase_state(git_dir: &Path) -> Option<InProgressOp> {
    let merge = git_dir.join("rebase-merge");
    if merge.is_dir() {
        let done = count_lines(&merge.join("done"));
        let todo = count_todo(&merge.join("git-rebase-todo"));
        return Some(InProgressOp::Rebase {
            interactive: merge.join("interactive").exists(),
            head_name: read_trimmed(&merge.join("head-name")).filter(|s| s != "detached HEAD"),
            onto: read_oid_file(&merge.join("onto")),
            step: done,
            total: done + todo,
        });
    }
    let apply = git_dir.join("rebase-apply");
    if apply.is_dir() {
        if apply.join("applying").exists() {
            return Some(InProgressOp::Am);
        }
        let next: u32 = read_trimmed(&apply.join("next"))
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let last: u32 = read_trimmed(&apply.join("last"))
            .and_then(|s| s.parse().ok())
            .unwrap_or(next);
        return Some(InProgressOp::Rebase {
            interactive: false,
            head_name: read_trimmed(&apply.join("head-name")),
            onto: read_oid_file(&apply.join("onto")),
            step: next.saturating_sub(1),
            total: last,
        });
    }
    None
}

/// pseudo-ref 를 읽는다. files 백엔드면 파일을 직접 읽고, reftable 이면 `rev-parse` 로 묻는다
async fn pseudo_ref(
    runner: &dyn GitRunner,
    git_dir: &Path,
    work_tree: &Path,
    name: &str,
    reftable: bool,
) -> Result<Option<Oid>, GitError> {
    if !reftable {
        return Ok(read_oid_file(&git_dir.join(name)));
    }
    let out = runner
        .run(GitRequest::new(
            work_tree,
            ["rev-parse", "-q", "--verify", name],
        ))
        .await?;
    if !out.exit.success() {
        return Ok(None);
    }
    Ok(Oid::from_hex(out.stdout_lossy().trim().as_bytes()).ok())
}

/// 파일 첫 줄을 trim 해 읽는다
fn read_trimmed(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// 파일 첫 줄을 Oid 로 읽는다
fn read_oid_file(path: &Path) -> Option<Oid> {
    read_trimmed(path).and_then(|s| Oid::from_hex(s.as_bytes()).ok())
}

/// 줄 수 (파일 없으면 0)
fn count_lines(path: &Path) -> u32 {
    std::fs::read_to_string(path)
        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0)
}

/// todo 파일의 명령 줄 수 (주석·빈 줄 제외)
fn count_todo(path: &Path) -> u32 {
    std::fs::read_to_string(path)
        .map(|t| {
            t.lines()
                .filter(|l| {
                    let l = l.trim();
                    !l.is_empty() && !l.starts_with('#')
                })
                .count() as u32
        })
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn rebase_merge_counts_done_and_todo() {
        let dir = tempfile::tempdir().unwrap();
        let rm = dir.path().join("rebase-merge");
        std::fs::create_dir(&rm).unwrap();
        std::fs::write(rm.join("head-name"), "refs/heads/feature\n").unwrap();
        std::fs::write(rm.join("onto"), format!("{}\n", "a".repeat(40))).unwrap();
        std::fs::write(rm.join("done"), "pick 1 a\npick 2 b\n").unwrap();
        std::fs::write(rm.join("git-rebase-todo"), "pick 3 c\n\n# comment\n").unwrap();
        match rebase_state(dir.path()).unwrap() {
            InProgressOp::Rebase {
                interactive,
                head_name,
                step,
                total,
                ..
            } => {
                assert!(!interactive);
                assert_eq!(head_name.as_deref(), Some("refs/heads/feature"));
                assert_eq!((step, total), (2, 3));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rebase_apply_uses_next_last() {
        let dir = tempfile::tempdir().unwrap();
        let ra = dir.path().join("rebase-apply");
        std::fs::create_dir(&ra).unwrap();
        std::fs::write(ra.join("next"), "2\n").unwrap();
        std::fs::write(ra.join("last"), "5\n").unwrap();
        match rebase_state(dir.path()).unwrap() {
            InProgressOp::Rebase { step, total, .. } => assert_eq!((step, total), (1, 5)),
            other => panic!("{other:?}"),
        }
        std::fs::write(ra.join("applying"), "").unwrap();
        assert_eq!(rebase_state(dir.path()), Some(InProgressOp::Am));
    }
}
