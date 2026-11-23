//! 통합 타임라인 (MR-12)
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, core_watching, core_with, wait_for};
use mgit_core::{CoreConfig, CoreEvent, GraphQuery, GraphRevs, RefKind, SessionId};
use mgit_testkit::TestRepo;

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 임시 루트 아래 저장소 a(커밋 3개)·b(커밋 2개, 시각이 a 사이에 끼도록 시계를 옮김)
fn two_repos(tag: &str) -> (PathBuf, TestRepo, TestRepo) {
    let root = std::env::temp_dir().join(format!("mgit-timeline-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut a = init_at(&root.join("a"));
    a.commit("a1");
    a.commit("a2");
    a.commit("a3");
    let mut b = init_at(&root.join("b"));
    b.advance_clock(90);
    b.commit("b1");
    b.commit("b2");
    (root, a, b)
}

/// 타임라인 로드 완료까지 기다린다
async fn open_timeline(
    core: &mgit_core::Core,
    root: &Path,
) -> (SessionId, tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) {
    let (sink, mut rx) = collector();
    let fid = core.open_folder(root, sink).await.unwrap().session;
    let info = core.folder_timeline_open(fid).unwrap();
    assert!(!info.finished);
    wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphLoadFinished { session, .. } if *session == fid),
    )
    .await;
    (fid, rx)
}

#[tokio::test]
async fn timeline_merges_repos_by_time_with_repo_index() {
    let (root, mut a, mut b) = two_repos("merge");
    let core = core().await;
    let (fid, _rx) = open_timeline(&core, &root).await;

    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    let subjects: Vec<&str> = w.rows.iter().map(|r| r.subject.as_str()).collect();
    // a: 60·120·180, b: 150·210 → 시각 내림차순으로 섞인다
    assert_eq!(subjects, vec!["b2", "a3", "b1", "a2", "a1"]);
    assert_eq!(w.total_rows, 5);
    assert!(w.finished);
    // 저장소 번호는 경로순 (a=0, b=1), 레인 색 = 저장소 번호
    let row = |s: &str| w.rows.iter().find(|r| r.subject == s).unwrap();
    assert_eq!(row("a1").repo, Some(0));
    assert_eq!(row("b1").repo, Some(1));
    assert_eq!(row("a2").color, 0);
    assert_eq!(row("b2").color, 1);
    assert_ne!(row("a3").lane, row("b2").lane);
    // 저장소별 HEAD·배지·도달성
    assert!(row("a3").is_head && row("b2").is_head);
    assert!(!row("a2").is_head);
    assert!(w.rows.iter().all(|r| r.in_head));
    assert!(
        row("a3")
            .refs
            .iter()
            .any(|l| l.short_name == "main" && l.kind == RefKind::LocalBranch)
    );
    assert!(row("b1").refs.is_empty());
    assert_eq!(
        core.folder_timeline_find_row(fid, 0, &a.head()).unwrap(),
        Some(1)
    );
    assert_eq!(
        core.folder_timeline_find_row(fid, 1, &b.head()).unwrap(),
        Some(0)
    );
    assert_eq!(
        core.folder_timeline_find_row(fid, 1, &a.head()).unwrap(),
        None
    );

    let info = core.folder_timeline_info(fid).unwrap();
    assert_eq!(info.rows, 5);
    assert!(info.finished);
    let names: Vec<&str> = info.repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["a", "b"]);
    // 저장소들을 합친 브랜치 목록은 `folder_branches` 가 준다 (tests/folder_branches.rs)
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn timeline_keeps_shared_commits_per_repo_and_skips_missing_branch() {
    let root = std::env::temp_dir().join(format!("mgit-timeline-clone-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut a = init_at(&root.join("a"));
    a.commit("a1");
    a.commit("a2");
    let a_path = root.join("a").display().to_string();
    let b_path = root.join("b").display().to_string();
    a.git_ok(["clone", "-q", &a_path, &b_path]);
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &root).await;
    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    // 같은 커밋이 두 저장소에 있으면 행이 둘, 레인은 따로
    assert_eq!(w.total_rows, 4);
    let a2: Vec<_> = w.rows.iter().filter(|r| r.subject == "a2").collect();
    assert_eq!(a2.len(), 2);
    assert_ne!(a2[0].repo, a2[1].repo);
    assert_ne!(a2[0].lane, a2[1].lane);

    // feature 는 a 에만 있다 → solo 질의에서 b 는 건너뛴다
    a.checkout_new("feature");
    a.commit("f1");
    core.folder_timeline_query_set(
        fid,
        GraphQuery {
            revs: GraphRevs::Solo {
                name: "feature".into(),
            },
            ..GraphQuery::default()
        },
    )
    .await
    .unwrap();
    wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphReloaded { session, .. } if *session == fid),
    )
    .await;
    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    assert_eq!(w.total_rows, 3);
    assert!(w.rows.iter().all(|r| r.repo == Some(0)));
    assert_eq!(w.rows[0].subject, "f1");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn timeline_reload_and_worktree_dedupe() {
    let (root, mut a, _b) = two_repos("reload");
    let wt = root.join("a-wt");
    a.git_ok([
        "worktree",
        "add",
        "-q",
        &wt.display().to_string(),
        "-b",
        "wt",
    ]);
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &root).await;
    let info = core.folder_timeline_info(fid).unwrap();
    // 워크트리는 원 저장소에 흡수된다
    assert_eq!(info.repos.len(), 2);
    let before = core.folder_timeline_window(fid, 0, 100).unwrap().total_rows;

    a.commit("a4");
    core.folder_timeline_reload(fid).unwrap();
    let events = wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphReloaded { session, .. } if *session == fid),
    )
    .await;
    assert!(events.iter().any(|e| matches!(
        e,
        CoreEvent::GraphReloaded { generation: 2, rows, .. } if *rows == before + 1
    )));
    let w = core.folder_timeline_window(fid, 0, 1).unwrap();
    assert_eq!(w.rows[0].subject, "a4");
    assert_eq!(w.generation, 2);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn folder_changed_reports_ref_changes() {
    let (root, mut a, _b) = two_repos("watch");
    let core = core_watching().await;
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.commit("a4");
    let events = wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::FolderChanged { session, refs: true, .. } if *session == fid),
    )
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::FolderChanged { refs: true, .. }))
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 타임라인 재로드가 끝날 때까지 기다린다
async fn wait_timeline_reloaded(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
    fid: SessionId,
) {
    wait_for(
        rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphReloaded { session, .. } if *session == fid),
    )
    .await;
}

/// HEAD 브랜치를 뺀 범위면 그 저장소의 행을 흐리지 않는다
#[tokio::test]
async fn timeline_stays_bright_when_head_is_filtered_out() {
    let (root, mut a, _b) = two_repos("dim-solo");
    a.git_ok(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    a.commit("a-feature");
    a.checkout("main");
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &root).await;
    core.folder_timeline_query_set(
        fid,
        GraphQuery {
            revs: GraphRevs::Solo {
                name: "feature".into(),
            },
            ..GraphQuery::default()
        },
    )
    .await
    .unwrap();
    wait_timeline_reloaded(&mut rx, fid).await;
    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    assert!(w.rows.iter().any(|r| r.subject == "a-feature"));
    assert!(w.rows.iter().all(|r| r.in_head));
    let _ = std::fs::remove_dir_all(&root);
}

/// 머지 제외는 HEAD 체인이 머지에서 끊기므로 머지 뒤 행도 흐리지 않는다
#[tokio::test]
async fn timeline_stays_bright_past_merges_with_no_merges() {
    let (root, mut a, _b) = two_repos("dim-merge");
    a.git_ok(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    a.commit("a-feature");
    a.checkout("main");
    a.merge(&["feature"], "a-merge");
    a.commit("a-top");
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &root).await;
    core.folder_timeline_query_set(
        fid,
        GraphQuery {
            no_merges: true,
            ..GraphQuery::default()
        },
    )
    .await
    .unwrap();
    wait_timeline_reloaded(&mut rx, fid).await;
    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    assert!(w.rows.iter().any(|r| r.subject == "a1"));
    assert!(w.rows.iter().all(|r| r.in_head));
    let _ = std::fs::remove_dir_all(&root);
}

/// HEAD 범위 (BT-03): 저장소마다 자기 HEAD 에서 닿는 커밋만. detached 저장소는 그 커밋부터,
/// 커밋이 없는 저장소(unborn)는 오류 없이 빠진다
#[tokio::test]
async fn timeline_head_revs_follow_each_repo_head() {
    let (root, mut a, mut b) = two_repos("head-revs");
    // a: HEAD 는 main, feature 에만 있는 커밋이 하나 더 있다
    a.checkout_new("feature");
    a.commit("a-feature");
    a.checkout("main");
    // b: detached (b1). b2 는 HEAD 에서 닿지 않는다
    b.git_ok(["checkout", "-q", "--detach", "HEAD~1"]);
    // c: 커밋 없음
    init_at(&root.join("c"));
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &root).await;
    let all = core.folder_timeline_window(fid, 0, 100).unwrap();
    assert_eq!(all.total_rows, 6);

    core.folder_timeline_query_set(
        fid,
        GraphQuery {
            revs: GraphRevs::Head,
            ..core_query_date()
        },
    )
    .await
    .unwrap();
    wait_timeline_reloaded(&mut rx, fid).await;
    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    let mut subjects: Vec<&str> = w.rows.iter().map(|r| r.subject.as_str()).collect();
    subjects.sort_unstable();
    assert_eq!(subjects, vec!["a1", "a2", "a3", "b1"]);
    assert!(w.rows.iter().all(|r| r.in_head));
    let row = |s: &str| w.rows.iter().find(|r| r.subject == s).unwrap();
    assert!(row("a3").is_head && row("b1").is_head);

    let info = core.folder_timeline_info(fid).unwrap();
    let names: Vec<&str> = info.repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["a", "b", "c"]);
    assert!(info.repos.iter().all(|r| r.error.is_none()), "{info:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// 타임라인 기본 질의와 같은 정렬(날짜순)의 질의
fn core_query_date() -> GraphQuery {
    GraphQuery {
        sort: mgit_core::GraphSort::Date,
        ..GraphQuery::default()
    }
}

/// 잘림 표시는 상한을 넘칠 때만 켜진다. 커밋 수가 상한과 정확히 같으면 잘린 것이 없다
#[tokio::test]
async fn timeline_truncated_only_when_over_the_cap() {
    // a 는 커밋 3개(상한과 같음), b 는 2개
    let (root, mut a, _b) = two_repos("cap");
    let core = core_with(CoreConfig {
        timeline_max_per_repo: 3,
        ..CoreConfig::default()
    })
    .await;
    let (fid, mut rx) = open_timeline(&core, &root).await;
    let info = core.folder_timeline_info(fid).unwrap();
    assert_eq!(info.rows, 5);
    assert!(
        info.repos.iter().all(|r| !r.truncated),
        "상한과 같은 수는 잘림이 아니다: {info:?}"
    );

    // 하나 더 쌓이면 넘친다: 최근 3개만 남고 잘림으로 표시된다
    a.commit("a4");
    core.folder_timeline_reload(fid).unwrap();
    wait_timeline_reloaded(&mut rx, fid).await;
    let info = core.folder_timeline_info(fid).unwrap();
    let repo = |n: &str| info.repos.iter().find(|r| r.name == n).unwrap();
    assert!(repo("a").truncated);
    assert!(!repo("b").truncated);
    let w = core.folder_timeline_window(fid, 0, 100).unwrap();
    let mut from_a: Vec<&str> = w
        .rows
        .iter()
        .filter(|r| r.repo == Some(repo("a").index))
        .map(|r| r.subject.as_str())
        .collect();
    from_a.sort_unstable();
    assert_eq!(from_a, vec!["a2", "a3", "a4"]);
    let _ = std::fs::remove_dir_all(&root);
}
