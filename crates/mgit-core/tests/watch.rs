//! 파일 감시 → 자동 재조회 (PoC-1 "외부 커밋 2초 안 반영")
#![allow(clippy::unwrap_used)]

mod common;

use std::time::{Duration, Instant};

use common::{collector, core_watching, wait_finished, wait_for, wait_quiet};
use mgit_core::CoreEvent;
use mgit_testkit::{Scenario, TestRepo, build};

#[tokio::test]
async fn external_commit_reloads_graph_within_two_seconds() {
    let core = core_watching().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    // 감시가 자리 잡을 시간
    tokio::time::sleep(Duration::from_millis(300)).await;

    let t0 = Instant::now();
    repo.write_file("ext.txt", "x");
    let new_head = repo.commit("외부 커밋");
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphReloaded { rows: 3, .. })
    })
    .await;
    assert!(
        t0.elapsed() < Duration::from_secs(2),
        "반영까지 {:?}",
        t0.elapsed()
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::RefsChanged { .. }))
    );
    let w = core.graph_window(opened.session, 0, 10).unwrap();
    assert_eq!(w.rows[0].oid, new_head);
    assert!(w.rows[0].is_head);
    core.close_repo(opened.session).unwrap();
}

#[tokio::test]
async fn work_tree_edit_emits_status_changed() {
    let core = core_watching().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    repo.write_file("f1.txt", "edited");
    let events = wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::StatusChanged { status, .. } if status.summary().unstaged == 1),
    )
    .await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, CoreEvent::GraphReloaded { .. })),
        "작업 트리 편집만으로는 그래프를 다시 로드하지 않는다"
    );

    repo.stage(&["f1.txt"]);
    wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::StatusChanged { status, .. } if status.summary().staged == 1),
    )
    .await;
}

#[tokio::test]
async fn ignored_directories_do_not_trigger_status() {
    let core = core_watching().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    // 여는 동안 생긴 감시 이벤트(예: status 가 고친 .git/index)가 다 올 때까지 비운다
    wait_quiet(&mut rx, Duration::from_millis(500), Duration::from_secs(10)).await;

    repo.write_file("node_modules/x/y.js", "ignored");
    repo.write_file("target/debug/out", "ignored");
    if let Ok(e) = tokio::time::timeout(Duration::from_millis(700), rx.recv()).await {
        panic!("제외 디렉터리 변경은 이벤트를 내지 않아야 한다. 받은 이벤트: {e:#?}");
    }
}

/// 경로에 커밋 하나짜리 저장소를 만든다
fn repo_at(path: &std::path::Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.commit("first");
    r
}

/// 폴더 감시 이벤트는 어느 저장소가 바뀌었는지 싣는다 (PF-02). 그 저장소만 다시 읽으면
/// 다른 저장소에서는 `status` 가 돌지 않는다
#[tokio::test]
async fn folder_changed_names_the_changed_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (path_a, path_b) = (root.join("a"), root.join("b"));
    let _a = repo_at(&path_a);
    let mut b = repo_at(&path_b);
    let core = core_watching().await;
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    // 감시가 자리 잡을 시간. 그사이 온 이벤트는 버린다
    tokio::time::sleep(Duration::from_millis(500)).await;
    while rx.try_recv().is_ok() {}

    b.commit("second");
    let mut events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(
            e,
            CoreEvent::FolderChanged { session, refs: true, repo: Some(repo) }
                if *session == fid && repo == &path_b
        )
    })
    .await;
    // 뒤따라 오는 이벤트까지 모아, 건드리지 않은 저장소 이름으로는 오지 않았는지 본다
    tokio::time::sleep(Duration::from_millis(400)).await;
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    let changed: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::FolderChanged { repo, .. } => Some(repo.clone()),
            _ => None,
        })
        .collect();
    assert!(
        changed
            .iter()
            .all(|repo| repo.as_deref() == Some(path_b.as_path())),
        "{changed:?}"
    );

    // 프런트가 하는 일: 이벤트의 저장소만 다시 읽는다 → 명령 로그상 그 저장소에서만 status 가 돈다
    let before = core.command_log_recent(usize::MAX).len();
    let summaries = core
        .folder_summaries(fid, std::slice::from_ref(&path_b))
        .await
        .unwrap();
    assert_eq!(summaries.len(), 1);
    let log = core.command_log_recent(usize::MAX);
    let ran = &log[..log.len() - before];
    let status_dirs: Vec<_> = ran
        .iter()
        .filter(|r| r.args.iter().any(|a| a == "status"))
        .map(|r| r.cwd.clone())
        .collect();
    assert_eq!(status_dirs, vec![path_b.clone()]);
    assert!(ran.iter().all(|r| r.cwd.starts_with(&path_b)), "{ran:?}");
    core.close_folder(fid).unwrap();
}
