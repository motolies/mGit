//! 상태 스냅샷, 진행 중 작업 판별, 쓰기 큐, 명령 로그, 취소
#![allow(clippy::unwrap_used)]

mod common;

use std::time::Duration;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{CoreError, CoreEvent, FileState, GitHint, InProgressOp, WriteSpec};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn open_repo_returns_status_refs_and_no_op() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    repo.write_file("dirty.txt", "x");
    repo.write_file("f1.txt", "changed");
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    let st = &opened.state;
    assert_eq!(st.refs.head.branch(), Some("refs/heads/main"));
    assert_eq!(st.refs.labels.len(), 4);
    assert_eq!(st.refs.worktrees.len(), 1);
    assert!(st.refs.worktrees[0].is_main);
    assert!(st.refs.stashes.is_empty());
    assert!(st.op.is_none());
    let summary = st.status.summary();
    assert_eq!(summary.untracked, 1);
    assert_eq!(summary.unstaged, 1);
    assert_eq!(st.status.branch.head.as_deref(), Some("main"));
    let dirty = st
        .status
        .entries
        .iter()
        .find(|e| e.path == "dirty.txt")
        .unwrap();
    assert_eq!(dirty.worktree, FileState::Untracked);
}

#[tokio::test]
async fn in_progress_operations_are_detected() {
    let core = core().await;

    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    assert!(matches!(opened.state.op, Some(InProgressOp::Merge { .. })));
    let conflicted = opened
        .state
        .status
        .entries
        .iter()
        .filter(|e| e.conflict.is_some())
        .count();
    assert_eq!(conflicted, 1);

    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_rebase_conflict();
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    match opened.state.op {
        Some(InProgressOp::Rebase {
            head_name,
            step,
            total,
            onto,
            ..
        }) => {
            assert_eq!(head_name.as_deref(), Some("refs/heads/other"));
            assert_eq!((step, total), (1, 1));
            assert!(onto.is_some());
        }
        other => panic!("{other:?}"),
    }

    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_cherry_pick_conflict();
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    assert!(matches!(
        opened.state.op,
        Some(InProgressOp::CherryPick { .. })
    ));
}

#[tokio::test]
async fn run_write_commits_and_refreshes_state() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("new.txt", "hello");
    core.run_write(opened.session, WriteSpec::new(["add", "--", "new.txt"]))
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.status.summary().staged, 1);

    let result = core
        .run_write(
            opened.session,
            WriteSpec::new(["commit", "-q", "-F", "-"]).with_stdin("한글 커밋".as_bytes().to_vec()),
        )
        .await
        .unwrap();
    assert!(result.stderr.is_empty() || !result.stderr.contains("fatal"));
    let new_head = repo.head();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.head.oid(), Some(new_head));
    assert!(!st.status.summary().has_changes());

    // 쓰기 뒤 재조회: RefsChanged → GraphReloaded, StatusChanged, 명령 로그
    let events = wait_for(&mut rx, Duration::from_secs(10), |e| {
        matches!(e, CoreEvent::GraphReloaded { .. })
    })
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::RefsChanged { .. }))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::StatusChanged { .. }))
    );
    let logged: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::CommandLogged { record, .. } => Some(record.clone()),
            _ => None,
        })
        .collect();
    assert!(logged.iter().any(|r| r.args[0] == "commit" && r.is_write));
    assert!(logged.iter().any(|r| r.args[0] == "status" && !r.is_write));

    let w = core.graph_window(opened.session, 0, 10).unwrap();
    assert_eq!(w.total_rows, 3);
    assert_eq!(w.rows[0].oid, new_head);
    assert_eq!(w.rows[0].subject, "한글 커밋");
    assert!(w.rows[0].is_head);
    assert_eq!(w.generation, 2);
    assert_eq!(core.find_row(opened.session, &new_head).unwrap(), Some(0));

    // 쓰기 명령은 저장소에 영속화된다
    let persisted = core.store().command_log_recent(10).unwrap();
    assert!(persisted.iter().all(|r| r.is_write));
    assert!(persisted.iter().any(|r| r.args[0] == "commit"));
    assert!(core.command_log_recent(100).len() >= persisted.len());
}

#[tokio::test]
async fn run_write_failure_carries_hint() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let err = core
        .run_write(
            opened.session,
            WriteSpec::new(["merge", "--no-edit", "other"]),
        )
        .await
        .unwrap_err();
    match &err {
        CoreError::CommandFailed { status, hint, .. } => {
            assert_eq!(*status, Some(1));
            assert_eq!(*hint, Some(GitHint::Conflicts));
        }
        other => panic!("{other:?}"),
    }
    let st = core.repo_state(opened.session).unwrap();
    assert!(matches!(st.op, Some(InProgressOp::Merge { .. })));
    assert_eq!(st.status.summary().conflicted, 1);

    core.run_write(opened.session, WriteSpec::new(["merge", "--abort"]))
        .await
        .unwrap();
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
}

#[tokio::test]
async fn dirty_checkout_hint_lists_files() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.write_file("conflict.txt", "local edit\n");
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    let err = core
        .run_write(opened.session, WriteSpec::new(["checkout", "other", "--"]))
        .await
        .unwrap_err();
    assert_eq!(
        err.hint(),
        Some(&GitHint::DirtyWorkTree {
            files: vec!["conflict.txt".into()]
        })
    );
}

#[tokio::test]
async fn writes_on_same_common_dir_are_serialized() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let wt = repo.add_worktree("wt", Some("side"));
    let (sink, _rx) = collector();
    let a = core.open_repo(repo.path(), sink.clone()).await.unwrap();
    let b = core.open_repo(&wt, sink).await.unwrap();
    assert_ne!(a.session, b.session);
    assert_eq!(a.info.common_dir, b.info.common_dir);

    // 두 세션이 동시에 태그를 만들어도 큐가 직렬화해 둘 다 성공한다
    let (ra, rb) = tokio::join!(
        core.run_write(a.session, WriteSpec::new(["tag", "ta"])),
        core.run_write(b.session, WriteSpec::new(["tag", "tb"])),
    );
    ra.unwrap();
    rb.unwrap();
    let st = core.repo_state(a.session).unwrap();
    let tags: Vec<&str> = st
        .refs
        .labels
        .iter()
        .filter(|l| matches!(l.kind, mgit_core::RefKind::Tag { .. }))
        .map(|l| l.short_name.as_str())
        .collect();
    assert_eq!(tags, vec!["ta", "tb"]);
    assert_eq!(st.refs.worktrees.len(), 2);
    let side = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "side")
        .unwrap();
    assert!(side.worktree_path.is_some());
}

#[tokio::test]
async fn operation_output_is_streamed_and_can_be_cancelled() {
    let core = core().await;
    let repo = build(Scenario::Linear(3));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // hook 출력 스트리밍: `git log` 의 stdout 이 OperationOutput 으로 온다
    let op = core.begin_operation(opened.session, "test", "log").unwrap();
    let op_id = op.id;
    core.run_write(
        opened.session,
        WriteSpec::new(["log", "--format=%s", "-n", "2"]).with_op(op),
    )
    .await
    .unwrap();
    let events = wait_for(&mut rx, Duration::from_secs(10), |e| {
        matches!(e, CoreEvent::OperationFinished { ok: true, .. })
    })
    .await;
    let lines: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::OperationOutput {
                op_id: id, text, ..
            } if *id == op_id => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(lines, vec!["commit 3", "commit 2"]);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationStarted { op_id: id, .. } if *id == op_id))
    );

    // 취소: 오래 자는 pre-commit hook 으로 commit 을 붙들어 두고 취소한다.
    // git 은 SIGTERM 을 받으면 index.lock 을 지우므로 잠금 파일이 남지 않아야 한다 (명세 2.3)
    let mut repo = repo;
    repo.install_hook("pre-commit", "#!/bin/sh\nsleep 10\n");
    repo.write_file("slow.txt", "x");
    core.stage(opened.session, &["slow.txt".into()])
        .await
        .unwrap();
    let op = core
        .begin_operation(opened.session, "test", "slow commit")
        .unwrap();
    let op_id = op.id;
    let spec = WriteSpec::new(["commit", "-q", "-F", "-"])
        .with_stdin(b"slow".to_vec())
        .with_op(op);
    let started = std::time::Instant::now();
    let fut = core.run_write(opened.session, spec);
    tokio::pin!(fut);
    let res = tokio::select! {
        res = &mut fut => res,
        _ = tokio::time::sleep(Duration::from_millis(300)) => {
            assert!(core.cancel_operation(op_id));
            fut.await
        }
    };
    assert!(matches!(res, Err(CoreError::Cancelled)), "{res:?}");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "취소가 hook 종료를 기다리지 않아야 한다"
    );
    let events = wait_for(&mut rx, Duration::from_secs(10), |e| {
        matches!(e, CoreEvent::OperationFinished { op_id: id, cancelled: true, .. } if *id == op_id)
    })
    .await;
    assert!(events.iter().any(
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, lock_left: false, .. } if *id == op_id)
    ));
    assert!(!core.cancel_operation(op_id), "끝난 작업은 취소할 수 없다");
    assert!(!repo.path().join(".git/index.lock").exists());
    // 커밋은 만들어지지 않았다
    assert_eq!(repo.git_ok(["rev-list", "--count", "HEAD"]).trim(), "3");
}

#[tokio::test]
async fn refresh_picks_up_external_changes_without_watcher() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("ext.txt", "x");
    repo.commit("external");
    core.refresh(opened.session).await.unwrap();
    let events = wait_for(&mut rx, Duration::from_secs(10), |e| {
        matches!(e, CoreEvent::GraphReloaded { rows: 2, .. })
    })
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::RefsChanged { .. }))
    );
    let w = core.graph_window(opened.session, 0, 10).unwrap();
    assert_eq!(w.rows[0].subject, "external");
    // 첫 refresh 의 StatusChanged 가 GraphReloaded 뒤에 올 수 있으므로 잠시 비운다
    tokio::time::sleep(Duration::from_millis(200)).await;
    while rx.try_recv().is_ok() {}
    // 두 번째 refresh 는 바뀐 게 없어 명령 로그 외 이벤트가 없다
    core.refresh(opened.session).await.unwrap();
    let quiet = tokio::time::timeout(Duration::from_millis(300), async {
        while let Some(e) = rx.recv().await {
            if !matches!(e, CoreEvent::CommandLogged { .. }) {
                return e;
            }
        }
        panic!("채널 닫힘")
    })
    .await;
    assert!(quiet.is_err(), "불필요한 이벤트: {quiet:?}");
}
