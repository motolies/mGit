use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, WorktreeInfo};

use crate::parse::parse_worktree_list;

/// 워크트리 목록을 읽는다 (`git worktree list --porcelain -z`)
pub async fn list_worktrees(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<WorktreeInfo>, GitError> {
    let req = GitRequest::new(work_tree, ["worktree", "list", "--porcelain", "-z"]);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_worktree_list(&out))
}
