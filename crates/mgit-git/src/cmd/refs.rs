use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, HeadState, RefKind, RefLabel};

use crate::parse::{assign_remotes, parse_refs};

/// `for-each-ref` 포맷. 필드 구분은 NUL, 레코드는 개행.
/// `upstream:track,nobracket` 은 동기 상태면 빈 문자열, `gone`, 아니면 `ahead N, behind M`
pub const REFS_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(upstream)%00%(symref)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(HEAD)";

/// 로컬·원격 브랜치와 태그 라벨을 읽는다
pub async fn list_refs(
    runner: &dyn GitRunner,
    work_tree: &Path,
    head: &HeadState,
) -> Result<Vec<RefLabel>, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "for-each-ref",
            REFS_FORMAT,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
        ],
    );
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    let mut labels = parse_refs(&out, head);
    if labels
        .iter()
        .any(|l| matches!(l.kind, RefKind::RemoteBranch { .. }))
    {
        assign_remotes(&mut labels, &remote_names(runner, work_tree).await);
    }
    Ok(labels)
}

/// 등록된 원격 이름 (`git remote`). 실패하면 빈 목록
async fn remote_names(runner: &dyn GitRunner, work_tree: &Path) -> Vec<String> {
    match runner.run(GitRequest::new(work_tree, ["remote"])).await {
        Ok(out) if out.exit.success() => out.stdout_lossy().lines().map(str::to_string).collect(),
        _ => Vec::new(),
    }
}
