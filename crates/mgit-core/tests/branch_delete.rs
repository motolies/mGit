//! 원격 삭제의 부분 성공·추적 로컬·강제 재시도 보호를 실제 bare 원격으로 검증한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, wait_finished};
use mgit_core::{BatchOp, BranchDeletionStatus as Status, FolderSettings};
use mgit_testkit::TestRepo;

/// 다른 이름의 추적 로컬과 추적하지 않는 동명 로컬을 함께 만든다.
fn fixture() -> TestRepo {
    let mut repo = TestRepo::init();
    repo.commit("base");
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "HEAD:refs/heads/topic"]);
    repo.git_ok(["fetch", "-q", "origin"]);
    repo.git_ok(["branch", "--track", "tracking", "origin/topic"]);
    repo.git_ok(["branch", "topic"]);
    repo
}

#[tokio::test]
async fn remote_first_deletes_tracking_local_only_and_keeps_backup() {
    let core = core().await;
    let mut repo = fixture();
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let target = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    assert!(target.error.is_none(), "{target:?}");
    assert_eq!(target.locals.len(), 1);
    assert_eq!(target.locals[0].name, "tracking");
    let result = core
        .delete_remote_branch_with_locals(session, &target, true)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::Deleted, "{result:?}");
    assert_eq!(result.locals[0].status, Status::Deleted, "{result:?}");
    assert!(
        repo.git_ok(["ls-remote", "origin", "refs/heads/topic"])
            .is_empty()
    );
    assert!(
        repo.git(["show-ref", "--verify", "refs/heads/topic"])
            .status
            .success()
    );
    assert!(
        !repo
            .git(["show-ref", "--verify", "refs/heads/tracking"])
            .status
            .success()
    );
    assert!(
        !repo
            .git_ok(["for-each-ref", "refs/mgit/backup/tracking/"])
            .is_empty()
    );
}

#[tokio::test]
async fn unmerged_retry_is_local_only_and_rejects_changed_oid() {
    let core = core().await;
    let mut repo = fixture();
    repo.git_ok(["switch", "tracking"]);
    repo.commit("unmerged");
    repo.git_ok(["switch", "main"]);
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let target = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    let result = core
        .delete_remote_branch_with_locals(session, &target, true)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::Deleted);
    assert_eq!(result.locals[0].status, Status::NotMerged, "{result:?}");
    // 원격을 다시 만들더라도 강제 재시도는 그 원격을 삭제하지 않는다.
    repo.git_ok(["push", "-q", "origin", "HEAD:refs/heads/topic"]);
    let result = core
        .force_delete_local_branches(session, &target)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::NotRun);
    assert_eq!(result.locals[0].status, Status::Deleted, "{result:?}");
    assert!(
        !repo
            .git_ok(["ls-remote", "origin", "refs/heads/topic"])
            .is_empty()
    );
    repo.git_ok(["branch", "--track", "tracking", "origin/topic"]);
    let result = core
        .force_delete_local_branches(session, &target)
        .await
        .unwrap();
    assert_eq!(result.locals[0].status, Status::Stale);
    assert!(
        repo.git(["show-ref", "--verify", "refs/heads/tracking"])
            .status
            .success()
    );
}

#[tokio::test]
async fn stale_remote_and_checked_out_local_are_preserved() {
    let core = core().await;
    let mut repo = fixture();
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let old = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    repo.commit("remote moved");
    repo.git_ok(["push", "origin", "HEAD:refs/heads/topic"]);
    let result = core
        .delete_remote_branch_with_locals(session, &old, true)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::Stale);
    assert!(
        result
            .locals
            .iter()
            .all(|local| local.status == Status::NotRun)
    );
    let fresh = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    repo.git_ok(["switch", "tracking"]);
    let result = core
        .delete_remote_branch_with_locals(session, &fresh, true)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::Deleted);
    assert_eq!(result.locals[0].status, Status::CheckedOut);
    let forced = core
        .force_delete_local_branches(session, &fresh)
        .await
        .unwrap();
    assert_eq!(forced.locals[0].status, Status::CheckedOut);
}

#[tokio::test]
async fn remote_failure_retains_local_and_invalid_names_are_rejected() {
    let core = core().await;
    let mut repo = fixture();
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let target = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    repo.git_ok(["remote", "set-url", "--push", "origin", "/missing-remote"]);
    let result = core
        .delete_remote_branch_with_locals(session, &target, true)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::Stale);
    assert!(
        result
            .locals
            .iter()
            .all(|local| local.status == Status::NotRun)
    );
    assert!(
        repo.git(["show-ref", "--verify", "refs/heads/tracking"])
            .status
            .success()
    );
    for (remote, name) in [
        ("origin", "topic:other"),
        ("origin", "*"),
        ("/tmp/url", "topic"),
    ] {
        assert!(
            core.inspect_remote_branch_deletion(session, remote, name)
                .await
                .unwrap()
                .error
                .is_some()
        );
    }
}

#[tokio::test]
async fn folder_all_groups_are_deduplicated_and_excluded_repos_are_not_written() {
    let core = core().await;
    let mut repo = fixture();
    let root = repo.path().parent().unwrap().to_path_buf();
    let worktree = root.join("linked");
    repo.git_ok([
        "worktree",
        "add",
        "-b",
        "linked",
        worktree.to_str().unwrap(),
    ]);
    let (sink, _rx) = collector();
    let session = core.open_folder(&root, sink).await.unwrap().session;
    let targets = core
        .inspect_folder_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    assert_eq!(targets.len(), 1, "{targets:?}");
    let name = targets[0]
        .path
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    core.set_folder_settings(
        session,
        &FolderSettings {
            exclude: vec![name],
            ..Default::default()
        },
    )
    .unwrap();
    let excluded = core
        .inspect_folder_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    assert!(excluded[0].excluded);
    assert!(excluded[0].remote_url.is_empty());
    let result = core
        .folder_batch(
            session,
            BatchOp::DeleteRemoteBranch {
                targets: targets.clone(),
                delete_local: true,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.skipped, 1);
    assert!(
        !repo
            .git_ok(["ls-remote", "origin", "refs/heads/topic"])
            .is_empty()
    );
    core.set_folder_settings(session, &FolderSettings::default())
        .unwrap();
    let result = core
        .folder_batch(
            session,
            BatchOp::DeleteRemoteBranch {
                targets,
                delete_local: true,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.succeeded, 1, "{result:?}");
}

#[tokio::test]
async fn remote_rejection_keeps_all_locals_and_tag_with_same_name_survives() {
    let core = core().await;
    let mut repo = fixture();
    repo.git_ok(["tag", "topic"]);
    repo.git_ok(["push", "origin", "refs/tags/topic"]);
    let bare_path = repo.git_ok(["remote", "get-url", "origin"]);
    let mut bare = TestRepo::at(std::path::Path::new(bare_path.trim()));
    bare.git_ok(["config", "receive.denyDeletes", "true"]);
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let target = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    let rejected = core
        .delete_remote_branch_with_locals(session, &target, true)
        .await
        .unwrap();
    assert_eq!(rejected.remote.status, Status::Failed, "{rejected:?}");
    assert_eq!(rejected.locals[0].status, Status::NotRun);
    assert!(
        repo.git(["show-ref", "--verify", "refs/heads/tracking"])
            .status
            .success()
    );
    bare.git_ok(["config", "receive.denyDeletes", "false"]);
    let deleted = core
        .delete_remote_branch_with_locals(session, &target, false)
        .await
        .unwrap();
    assert_eq!(deleted.remote.status, Status::Deleted);
    assert!(deleted.locals.is_empty());
    assert!(
        !repo
            .git_ok(["ls-remote", "origin", "refs/tags/topic"])
            .is_empty()
    );
}

#[tokio::test]
async fn push_url_is_used_for_inspection_and_other_worktree_checkout_is_protected() {
    let core = core().await;
    let mut repo = fixture();
    let push_path = repo.add_bare_remote_named("destination");
    repo.git_ok(["push", "destination", "HEAD:refs/heads/topic"]);
    repo.git_ok([
        "remote",
        "set-url",
        "--push",
        "origin",
        push_path.to_str().unwrap(),
    ]);
    let linked = repo.path().parent().unwrap().join("tracking-worktree");
    repo.git_ok(["worktree", "add", linked.to_str().unwrap(), "tracking"]);
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let target = core
        .inspect_remote_branch_deletion(session, "origin", "topic")
        .await
        .unwrap();
    assert_eq!(target.remote_url, push_path.to_str().unwrap());
    assert_eq!(
        target.locals[0].checked_out.as_deref(),
        linked.canonicalize().unwrap().to_str()
    );
    let result = core
        .delete_remote_branch_with_locals(session, &target, true)
        .await
        .unwrap();
    assert_eq!(result.remote.status, Status::Deleted);
    assert_eq!(result.locals[0].status, Status::CheckedOut);
    assert!(
        repo.git_ok(["ls-remote", "destination", "refs/heads/topic"])
            .is_empty()
    );
    assert!(
        !repo
            .git_ok(["ls-remote", "origin", "refs/heads/topic"])
            .is_empty()
    );
}
