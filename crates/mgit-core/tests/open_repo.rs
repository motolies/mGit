//! `open_repo` 와 이벤트 순서
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{CoreError, CoreEvent, GitError, HeadState, LoadState};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn events_are_started_first_chunk_finished() {
    let core = core().await;
    let repo = build(Scenario::Linear(5));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    assert!(!opened.already_open);
    let events = wait_finished(&mut rx, opened.session).await;
    let kinds: Vec<&str> = events
        .iter()
        .filter(|e| !matches!(e, CoreEvent::CommandLogged { .. }))
        .map(|e| match e {
            CoreEvent::GraphLoadStarted { .. } => "started",
            CoreEvent::GraphFirstChunk { .. } => "first",
            CoreEvent::GraphProgress { .. } => "progress",
            CoreEvent::GraphLoadFinished { .. } => "finished",
            CoreEvent::GraphLoadFailed { .. } => "failed",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["started", "first", "finished"]);
    match events.last().unwrap() {
        CoreEvent::GraphLoadFinished {
            rows,
            lane_count,
            commit_graph_suggested,
            ..
        } => {
            assert_eq!(*rows, 5);
            assert_eq!(*lane_count, 1);
            assert!(!commit_graph_suggested);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        core.load_state(opened.session).unwrap(),
        LoadState::Finished
    );
}

#[tokio::test]
async fn repo_info_has_head_and_commit_graph_status() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    let head = repo.head();
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    assert_eq!(
        opened.info.head,
        HeadState::Attached {
            branch: "refs/heads/main".into(),
            oid: head
        }
    );
    assert!(!opened.info.commit_graph.present);
    assert!(opened.info.common_dir.is_absolute());
}

#[tokio::test]
async fn unborn_repo_finishes_with_zero_rows() {
    let core = core().await;
    let repo = build(Scenario::Empty);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    assert!(matches!(opened.info.head, HeadState::Unborn { .. }));
    let events = wait_finished(&mut rx, opened.session).await;
    assert!(matches!(
        events.last(),
        Some(CoreEvent::GraphLoadFinished { rows: 0, .. })
    ));
    let w = core.graph_window(opened.session, 0, 10).unwrap();
    assert_eq!(w.total_rows, 0);
    assert!(w.finished);
}

#[tokio::test]
async fn reopening_same_work_tree_returns_existing_session() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.write_file("sub/x.txt", "x");
    let (sink, _rx) = collector();
    let a = core.open_repo(repo.path(), sink.clone()).await.unwrap();
    let b = core
        .open_repo(&repo.path().join("sub"), sink)
        .await
        .unwrap();
    assert_eq!(a.session, b.session);
    assert!(b.already_open);
    assert_eq!(core.sessions(), vec![a.session]);
}

/// 완료된 저장소를 새 채널로 다시 열면 상태를 즉시 복구하고 이후 갱신도 새 채널에 보냅니다.
#[tokio::test]
async fn reopening_finished_repo_replays_state_and_moves_future_events() {
    for (scenario, expected_rows) in [(Scenario::Linear(2), 2), (Scenario::Empty, 0)] {
        let core = std::sync::Arc::new(core().await);
        let repo = build(scenario);
        let (sink, mut old_rx) = collector();
        let first = core.open_repo(repo.path(), sink).await.unwrap();
        wait_finished(&mut old_rx, first.session).await;
        let (sink, mut rx) = collector();
        let reader = core.clone();
        let session = first.session;
        // 재전송 콜백이 같은 세션을 조회해도 life·graph 잠금에 막히지 않아야 합니다.
        let sink = std::sync::Arc::new(move |event: CoreEvent| {
            assert_eq!(
                reader.graph_window(session, 0, 1).unwrap().total_rows,
                expected_rows
            );
            sink.emit(event);
        });
        let again = core.open_repo(repo.path(), sink).await.unwrap();
        assert_eq!(again.session, first.session);
        assert!(again.already_open && !again.promoted);
        let events = wait_finished(&mut rx, first.session).await;
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, CoreEvent::GraphLoadStarted { .. }))
        );
        assert!(
            matches!(events.last(), Some(CoreEvent::GraphLoadFinished { rows, .. }) if *rows == expected_rows)
        );

        core.reload_graph(first.session).unwrap();
        wait_for(
            &mut rx,
            std::time::Duration::from_secs(5),
            |e| matches!(e, CoreEvent::GraphReloaded { rows, .. } if *rows == expected_rows),
        )
        .await;
        while let Ok(event) = old_rx.try_recv() {
            assert!(!matches!(event, CoreEvent::GraphReloaded { .. }));
        }
        core.close_repo(first.session).unwrap();
    }
}

#[tokio::test]
async fn not_a_repository_is_reported() {
    let core = core().await;
    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = collector();
    let err = core.open_repo(dir.path(), sink).await.unwrap_err();
    assert!(
        matches!(err, CoreError::Git(GitError::NotARepository(_))),
        "{err}"
    );
}

#[tokio::test]
async fn close_repo_removes_session_and_stops_load() {
    let core = core().await;
    let repo = build(Scenario::Linear(20));
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    core.close_repo(opened.session).unwrap();
    assert!(core.sessions().is_empty());
    assert!(matches!(
        core.graph_window(opened.session, 0, 1),
        Err(CoreError::SessionNotFound(_))
    ));
    assert!(matches!(
        core.close_repo(opened.session),
        Err(CoreError::SessionNotFound(_))
    ));
}
