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

/// 앱 밖에서 stash 를 만들거나 지워도 감시가 `folderChanged`(refs)를 낸다 (셋째 묶음 K). `refs/stash` 는 공용 `refs/`
/// 아래라 목록을 함께 쓰는 연결된 워크트리 줄도 함께 알린다 — 프런트가 그 저장소들만 다시 읽으면 stash 수가 바뀐다
#[tokio::test]
async fn stash_changes_reload_main_tree_and_linked_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path_m = root.join("m");
    let path_w = root.join("w");
    let mut m = repo_at(&path_m);
    m.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt",
        path_w.to_str().unwrap(),
    ]);
    let core = core_watching().await;
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    tokio::time::sleep(Duration::from_millis(500)).await;
    while rx.try_recv().is_ok() {}

    // 주 작업 트리에서 stash 를 만들면 두 줄 모두 알린다
    m.write_file("f1.txt", "edited\n");
    m.stash_push("밖에서", false);
    let mut seen = std::collections::HashSet::new();
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        if let CoreEvent::FolderChanged {
            session,
            refs: true,
            repo: Some(repo),
        } = e
            && *session == fid
        {
            seen.insert(repo.clone());
        }
        seen.contains(&path_m) && seen.contains(&path_w)
    })
    .await;
    let counts = |list: &[mgit_core::RepoSummary]| {
        let mut v: Vec<(String, u32)> = list
            .iter()
            .map(|s| (s.name.clone(), s.stash_count))
            .collect();
        v.sort();
        v
    };
    let list = core
        .folder_summaries(fid, &[path_m.clone(), path_w.clone()])
        .await
        .unwrap();
    assert_eq!(counts(&list), [("m".into(), 1), ("w".into(), 1)]);

    // 지워도(drop) 다시 알린다
    tokio::time::sleep(Duration::from_millis(400)).await;
    while rx.try_recv().is_ok() {}
    m.git_ok(["stash", "drop", "-q"]);
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(
            e,
            CoreEvent::FolderChanged { session, refs: true, repo: Some(repo) }
                if *session == fid && repo == &path_w
        )
    })
    .await;
    let list = core
        .folder_summaries(fid, &[path_m.clone(), path_w.clone()])
        .await
        .unwrap();
    assert_eq!(counts(&list), [("m".into(), 0), ("w".into(), 0)]);
    core.close_folder(fid).unwrap();
}
