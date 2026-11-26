//! merge·rebase·cherry-pick·revert·reset 과 진행 중 작업 제어 (MRG-01~05), commit-graph (AD-03)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{CheckoutTarget, CoreError, InProgressOp, MergeMode, OpOutcome, ResetMode};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn merge_modes_without_conflict() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    repo.commit("topic 1");
    repo.checkout("main");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // ff-only: main 이 topic 으로 전진
    assert_eq!(
        core.merge(opened.session, "topic", MergeMode::FfOnly)
            .await
            .unwrap(),
        OpOutcome::Clean
    );
    assert_eq!(
        repo.git_ok(["rev-parse", "main"]),
        repo.git_ok(["rev-parse", "topic"])
    );

    // no-ff: 머지 커밋이 생긴다
    repo.checkout("topic");
    repo.commit("topic 2");
    repo.checkout("main");
    core.refresh(opened.session).await.unwrap();
    core.merge(opened.session, "topic", MergeMode::NoFf)
        .await
        .unwrap();
    assert_eq!(
        repo.git_ok(["rev-list", "--parents", "-1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );

    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%s"]).trim(),
        "Merge branch 'topic' into main"
    );

    // squash: 커밋 없이 stage 만
    repo.checkout("topic");
    repo.commit("topic 3");
    repo.checkout("main");
    core.refresh(opened.session).await.unwrap();
    core.merge(opened.session, "topic", MergeMode::Squash)
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(st.status.summary().staged >= 1);
    assert!(st.op.is_none());
}

#[tokio::test]
async fn merge_conflict_then_resolve_and_continue_or_abort() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    assert_eq!(
        core.merge(opened.session, "other", MergeMode::Default)
            .await
            .unwrap(),
        OpOutcome::Conflicts
    );
    let st = core.repo_state(opened.session).unwrap();
    assert!(matches!(st.op, Some(InProgressOp::Merge { .. })));
    assert_eq!(st.status.summary().conflicted, 1);

    // 충돌 파일이 남은 채로 continue 는 거부
    assert!(matches!(
        core.op_continue(opened.session, false).await,
        Err(CoreError::Invalid(_))
    ));
    // 마커가 남은 채로 stage 하면 continue 는 ConflictMarkers
    core.stage(opened.session, &["conflict.txt".into()])
        .await
        .unwrap();
    assert!(matches!(
        core.op_continue(opened.session, false).await,
        Err(CoreError::ConflictMarkers { .. })
    ));
    assert!(
        std::fs::read_to_string(repo.path().join(".git/MERGE_MSG"))
            .unwrap()
            .starts_with("Merge branch 'other' into main")
    );
    // 충돌 해결 중 사용자가 바꾼 메시지는 continue에서 덮어쓰지 않는다.
    std::fs::write(
        repo.path().join(".git/MERGE_MSG"),
        "Merge reviewed change into main\n",
    )
    .unwrap();
    // 해결 후 continue
    repo.write_file("conflict.txt", "line1\nRESOLVED\nline3\n");
    core.stage(opened.session, &["conflict.txt".into()])
        .await
        .unwrap();
    assert_eq!(
        core.op_continue(opened.session, false).await.unwrap(),
        OpOutcome::Clean
    );
    let st = core.repo_state(opened.session).unwrap();
    assert!(st.op.is_none());
    assert_eq!(
        repo.git_ok(["rev-list", "--parents", "-1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );

    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%s"]).trim(),
        "Merge reviewed change into main"
    );

    // abort 경로
    repo.git_ok(["reset", "-q", "--hard", "HEAD~1"]);
    core.refresh(opened.session).await.unwrap();
    assert_eq!(
        core.merge(opened.session, "other", MergeMode::Default)
            .await
            .unwrap(),
        OpOutcome::Conflicts
    );
    core.op_abort(opened.session).await.unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(st.op.is_none());
    assert!(!st.status.summary().has_changes());
}

#[tokio::test]
async fn rebase_conflict_skip_and_autostash() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.checkout("other");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    assert_eq!(
        core.rebase(opened.session, "main", false).await.unwrap(),
        OpOutcome::Conflicts
    );
    match core.repo_state(opened.session).unwrap().op {
        Some(InProgressOp::Rebase { step, total, .. }) => assert_eq!((step, total), (1, 1)),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        core.op_skip(opened.session).await.unwrap(),
        OpOutcome::Clean
    );
    let st = core.repo_state(opened.session).unwrap();
    assert!(st.op.is_none());
    assert_eq!(st.refs.head.branch(), Some("refs/heads/other"));
    // 건너뛰었으니 other 는 main 과 같은 커밋
    assert_eq!(
        repo.git_ok(["rev-parse", "other"]),
        repo.git_ok(["rev-parse", "main"])
    );

    // autostash: 더티 상태에서 rebase 해도 변경이 보존된다
    repo.git_ok(["reset", "-q", "--hard", "HEAD~1"]);
    repo.write_file("extra.txt", "keep me\n");
    repo.stage(&["extra.txt"]);
    repo.commit_staged("extra");
    repo.write_file("extra.txt", "dirty\n");
    core.refresh(opened.session).await.unwrap();
    assert_eq!(
        core.rebase(opened.session, "main", true).await.unwrap(),
        OpOutcome::Clean
    );
    assert_eq!(repo.read_file("extra.txt"), "dirty\n");
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
}

#[tokio::test]
async fn cherry_pick_revert_and_reset() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("src");
    repo.write_file("pick.txt", "picked\n");
    repo.stage(&["pick.txt"]);
    let picked = repo.commit_staged("to pick");
    repo.checkout("main");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    assert_eq!(
        core.cherry_pick(opened.session, &[picked]).await.unwrap(),
        OpOutcome::Clean
    );
    assert_eq!(repo.read_file("pick.txt"), "picked\n");
    let after_pick = repo.head();
    assert_eq!(repo.git_ok(["log", "-1", "--format=%s"]).trim(), "to pick");

    assert_eq!(
        core.revert(opened.session, &[after_pick]).await.unwrap(),
        OpOutcome::Clean
    );
    assert!(!repo.path().join("pick.txt").exists());
    assert!(
        repo.git_ok(["log", "-1", "--format=%s"])
            .starts_with("Revert")
    );

    let before = repo.head();
    repo.write_file("f1.txt", "soft\n");
    core.refresh(opened.session).await.unwrap();
    core.reset(opened.session, "HEAD~1", ResetMode::Soft)
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.head.oid(), Some(after_pick));
    assert!(
        st.status.summary().staged >= 1,
        "soft 는 변경을 stage 에 남긴다"
    );

    core.reset(opened.session, &before.to_hex(), ResetMode::Mixed)
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.head.oid(), Some(before));
    assert_eq!(st.status.summary().staged, 0);
    assert_eq!(st.status.summary().unstaged, 1);

    core.reset(opened.session, "HEAD", ResetMode::Hard)
        .await
        .unwrap();
    assert!(
        !core
            .repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .has_changes()
    );
    assert_eq!(repo.read_file("f1.txt"), "commit 1");

    assert!(matches!(
        core.cherry_pick(opened.session, &[]).await,
        Err(CoreError::Invalid(_))
    ));
    assert!(matches!(
        core.op_abort(opened.session).await,
        Err(CoreError::Invalid(_))
    ));
}

#[tokio::test]
async fn commit_graph_write_creates_file() {
    let core = core().await;
    let repo = build(Scenario::Linear(3));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(!opened.info.commit_graph.present);
    core.commit_graph_write(opened.session).await.unwrap();
    assert!(mgit_git::cmd::detect_commit_graph(&opened.info.common_dir).present);
}

#[tokio::test]
async fn checkout_branch_used_by_other_worktree_gives_hint() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.add_worktree("wt", Some("side"));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let err = core
        .checkout(opened.session, CheckoutTarget::Branch("side".into()), false)
        .await
        .unwrap_err();
    match err.hint() {
        Some(mgit_core::GitHint::BranchCheckedOutElsewhere { path }) => {
            assert!(path.ends_with("wt"), "{path}");
        }
        other => panic!("{other:?}: {err}"),
    }
}

/// 원격 추적 이름은 전체 ref와 짧은 ref 모두 해시 대신 메시지에 남긴다.
#[tokio::test]
async fn remote_merge_messages_keep_branch_names_and_strategy() {
    for strategy in [false, true] {
        let core = core().await;
        let mut repo = build(Scenario::Linear(1));
        repo.checkout_new("feature/PD-2638-outbound-issue-status");
        repo.commit("feature");
        repo.git_ok([
            "update-ref",
            "refs/remotes/origin/feature/PD-2638-outbound-issue-status",
            "HEAD",
        ]);
        repo.checkout("main");
        repo.checkout_new("staging");
        let (sink, mut rx) = collector();
        let opened = core.open_repo(repo.path(), sink).await.unwrap();
        wait_finished(&mut rx, opened.session).await;
        if strategy {
            core.merge_with(
                opened.session,
                "origin/feature/PD-2638-outbound-issue-status",
                MergeMode::NoFf,
                &[],
            )
            .await
            .unwrap();
        } else {
            core.merge(
                opened.session,
                "refs/remotes/origin/feature/PD-2638-outbound-issue-status",
                MergeMode::NoFf,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            repo.git_ok(["log", "-1", "--format=%s"]).trim(),
            "Merge remote-tracking branch 'origin/feature/PD-2638-outbound-issue-status' into staging"
        );
    }
}
