use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, HeadState, Oid};

/// HEAD 상태를 판별한다.
/// `symbolic-ref -q HEAD` (0 = 브랜치, 1 = detached) + `rev-parse --verify -q HEAD^{commit}` (1 = unborn)
pub async fn head_state(runner: &dyn GitRunner, work_tree: &Path) -> Result<HeadState, GitError> {
    let sym = runner
        .run(GitRequest::new(work_tree, ["symbolic-ref", "-q", "HEAD"]))
        .await?;
    let branch = sym
        .exit
        .success()
        .then(|| sym.stdout_lossy().trim().to_string());

    let req = GitRequest::new(work_tree, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    let args = req.display_args();
    let head = runner.run(req).await?;
    let oid = if head.exit.success() {
        Some(Oid::from_hex(head.stdout_lossy().trim().as_bytes())?)
    } else if head.exit.status == Some(1) {
        None
    } else {
        return Err(GitError::Exit {
            status: head.exit.status,
            stderr: head.exit.stderr,
            args,
        });
    };

    Ok(match (branch, oid) {
        (Some(branch), Some(oid)) => HeadState::Attached { branch, oid },
        (None, Some(oid)) => HeadState::Detached { oid },
        (Some(branch), None) => HeadState::Unborn { branch },
        (None, None) => HeadState::Unborn {
            branch: "HEAD".into(),
        },
    })
}
