use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, StashInfo};

use crate::parse::parse_stash_list;

/// 스태시 목록 조회 인자. `git stash list` 는 인자를 `git log -g refs/stash` 에 그대로 넘긴다
pub const STASH_LIST_ARGS: &[&str] = &[
    "stash",
    "list",
    "-z",
    "--format=%gd%x00%H%x00%P%x00%gs%x00%s%x00%ct",
];

/// 스태시 목록을 읽는다. 스태시가 없으면 빈 목록
pub async fn list_stashes(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<StashInfo>, GitError> {
    let req = GitRequest::new(work_tree, STASH_LIST_ARGS);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_stash_list(&out))
}
