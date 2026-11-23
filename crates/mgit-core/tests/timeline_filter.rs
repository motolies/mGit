//! 커밋 필터·저장소 범위 (LG-06) — 통합 타임라인: 저장소마다 같은 필터, 범위(번호·색 유지, 범위 밖 git 0회,
//! 빈 범위 = 전부, 목록 밖 경로 거부, 재스캔), 잘림, 위치 유지, 작성자 후보, 가벼운 세션
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, core_with, wait_for};
use mgit_core::{
    CommitFilter, Core, CoreConfig, CoreError, CoreEvent, GraphQuery, GraphSort, Oid, SessionId,
    TextFilter,
};
use mgit_testkit::TestRepo;
use tokio::sync::mpsc::UnboundedReceiver;

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 작성자를 지정한 커밋 (커밋 시각은 저장소 시계 +60초)
fn commit_as(repo: &mut TestRepo, msg: &str, author: &str) -> Oid {
    repo.write_file(&format!("f-{msg}.txt"), msg);
    repo.stage(&["."]);
    repo.advance_clock(60);
    let out = repo.git_with_stdin(
        ["commit", "-q", "-F", "-", &format!("--author={author}")],
        Some(msg.as_bytes()),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    repo.head()
}

/// 저장소 셋을 담은 폴더. a: Kim·Lee, b: Park 혼자, c: Kim·Lee. 커밋 시각이 저장소 사이에 섞인다
struct Folder {
    _dir: tempfile::TempDir,
    root: PathBuf,
    a: TestRepo,
    b: TestRepo,
    c: TestRepo,
    a1: Oid,
}

/// 폴더를 만든다
fn folder() -> Folder {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut a = init_at(&root.join("a"));
    let a1 = commit_as(&mut a, "fix: a1", "Kim <kim@x.com>");
    commit_as(&mut a, "feat: a2", "Lee <lee@x.com>");
    commit_as(&mut a, "fix: a3", "Kim <kim@x.com>");
    let mut b = init_at(&root.join("b"));
    b.advance_clock(20);
    commit_as(&mut b, "fix: b1", "Park <park@x.com>");
    commit_as(&mut b, "docs: b2", "Park <park@x.com>");
    let mut c = init_at(&root.join("c"));
    c.advance_clock(40);
    commit_as(&mut c, "chore: c1", "Kim <kim@x.com>");
    commit_as(&mut c, "fix: c2", "Lee <lee@x.com>");
    Folder {
        _dir: dir,
        root,
        a,
        b,
        c,
        a1,
    }
}

/// 폴더를 열고 타임라인 첫 로드를 기다린다
async fn open_timeline(core: &Core, root: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, mut rx) = collector();
    let fid = core.open_folder(root, sink).await.unwrap().session;
    core.folder_timeline_open(fid).unwrap();
    wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphLoadFinished { session, .. } if *session == fid),
    )
    .await;
    (fid, rx)
}

/// 타임라인 재로드가 끝날 때까지 기다린다
async fn reloaded(rx: &mut UnboundedReceiver<CoreEvent>, fid: SessionId) {
    wait_for(
        rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphReloaded { session, .. } if *session == fid),
    )
    .await;
}

/// 날짜순 + 필터 질의 (타임라인 기본 정렬)
fn query(filter: CommitFilter) -> GraphQuery {
    GraphQuery {
        sort: GraphSort::Date,
        filter,
        ..GraphQuery::default()
    }
}

/// 텍스트 필터
fn text(pattern: &str) -> CommitFilter {
    CommitFilter {
        text: TextFilter {
            pattern: pattern.into(),
            regex: false,
            match_case: false,
        },
        ..CommitFilter::default()
    }
}

/// (제목, 저장소 번호, 레인, 색) 목록 (행 순서)
fn rows(core: &Core, fid: SessionId) -> Vec<(String, u16, u16, u8)> {
    core.folder_timeline_window(fid, 0, 1000)
        .unwrap()
        .rows
        .into_iter()
        .map(|r| (r.subject, r.repo.unwrap(), r.lane, r.color))
        .collect()
}

/// 제목만 정렬해서
fn subjects(core: &Core, fid: SessionId) -> Vec<String> {
    let mut v: Vec<String> = rows(core, fid).into_iter().map(|r| r.0).collect();
    v.sort();
    v
}

/// 저장소마다 같은 필터로 걸러 합친다. 텍스트·작성자면 목록 모드(레인 0)이고 색은 저장소 색 그대로다.
/// 보던 커밋의 위치는 경로로 다시 찾는다
#[tokio::test]
async fn every_repo_gets_the_same_filter() {
    let mut fx = folder();
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &fx.root).await;
    // a1 은 가장 오래된 커밋: 전체에서는 마지막(6), 걸러진 뒤에는 3번 행
    let before = core
        .folder_timeline_find_row_at(fid, fx.a.path(), &fx.a1)
        .unwrap();
    assert_eq!(before, Some(6));

    core.folder_timeline_query_set(fid, query(text("fix")))
        .await
        .unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(
        subjects(&core, fid),
        ["fix: a1", "fix: a3", "fix: b1", "fix: c2"]
    );
    for (subject, repo, lane, color) in rows(&core, fid) {
        assert_eq!(lane, 0, "{subject}");
        assert_eq!(
            u16::from(color),
            repo,
            "색은 저장소 색 (순번 % 10): {subject}"
        );
        let expected = match subject.chars().nth(5) {
            Some('a') => 0,
            Some('b') => 1,
            _ => 2,
        };
        assert_eq!(repo, expected, "{subject}");
    }
    assert_eq!(
        core.folder_timeline_find_row_at(fid, fx.a.path(), &fx.a1)
            .unwrap(),
        Some(3)
    );
    let w = core.folder_timeline_window(fid, 0, 1000).unwrap();
    assert!(w.rows.iter().all(|r| r.in_head));

    // 작성자 (여럿 OR) + 텍스트 (AND)
    let lee_or_park = CommitFilter {
        authors: vec!["LEE@x.com".into(), "park@x.com".into()],
        ..text("fix")
    };
    core.folder_timeline_query_set(fid, query(lee_or_park))
        .await
        .unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(subjects(&core, fid), ["fix: b1", "fix: c2"]);

    // 해시 접두: 그 저장소의 그 커밋이 든다
    let b2 = fx.b.head();
    core.folder_timeline_query_set(fid, query(text(&b2.to_hex()[..9])))
        .await
        .unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(rows(&core, fid), [("docs: b2".to_string(), 1, 0, 1)]);

    // 날짜만: 목록 모드가 아니다 (저장소마다 레인이 따로)
    let c2 = fx.c.head();
    let c2_time = core
        .folder_commit_detail(fid, fx.c.path(), &c2)
        .await
        .unwrap()
        .committer_time;
    core.folder_timeline_query_set(
        fid,
        query(CommitFilter {
            until: Some(c2_time),
            ..CommitFilter::default()
        }),
    )
    .await
    .unwrap();
    reloaded(&mut rx, fid).await;
    let lanes: std::collections::HashSet<u16> = rows(&core, fid).iter().map(|r| r.2).collect();
    assert!(
        lanes.len() > 1,
        "날짜만 걸면 저장소마다 레인이 있다: {lanes:?}"
    );
    let _ = (&mut fx.b, &mut fx.c);
}

/// 저장소 범위: 범위 밖 저장소는 번호·색을 둔 채 행만 빠지고 git 을 하나도 돌리지 않는다. 정보에는 전체
/// 저장소가 `in_scope` 와 함께 남는다. 빈 범위 = 전부, 목록 밖 경로는 거부, 워크트리 경로는 원 저장소
#[tokio::test]
async fn scope_keeps_numbers_and_colors_and_skips_git() {
    let mut fx = folder();
    let wt = fx.root.join("a-wt");
    fx.a.git_ok([
        "worktree",
        "add",
        "-q",
        &wt.display().to_string(),
        "-b",
        "wt",
    ]);
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &fx.root).await;
    let c_head = fx.c.head();
    let a_head = fx.a.head();

    let log_len = core.command_log_recent(usize::MAX).len();
    core.folder_timeline_scope_set(fid, &[fx.c.path().to_path_buf()])
        .unwrap();
    reloaded(&mut rx, fid).await;
    let new_logs = core.command_log_recent(usize::MAX);
    let new_logs = &new_logs[..new_logs.len() - log_len];
    assert!(!new_logs.is_empty());
    for r in new_logs {
        assert!(
            r.cwd.starts_with(fx.c.path()),
            "범위 밖 저장소에서 git 이 돌았다: {:?} {:?}",
            r.cwd,
            r.args
        );
    }
    assert_eq!(
        rows(&core, fid)
            .into_iter()
            .map(|r| (r.0, r.1, r.3))
            .collect::<Vec<_>>(),
        [
            ("fix: c2".to_string(), 2, 2),
            ("chore: c1".to_string(), 2, 2)
        ]
    );
    let info = core.folder_timeline_info(fid).unwrap();
    assert!(info.scoped);
    let brief: Vec<(&str, u16, u8, bool, Option<&str>)> = info
        .repos
        .iter()
        .map(|r| {
            (
                r.name.as_str(),
                r.index,
                r.color,
                r.in_scope,
                r.head_branch.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        brief,
        [
            ("a", 0, 0, false, None),
            ("b", 1, 1, false, None),
            ("c", 2, 2, true, Some("main"))
        ]
    );
    assert_eq!(
        core.folder_timeline_find_row_at(fid, fx.a.path(), &a_head)
            .unwrap(),
        None
    );
    assert_eq!(
        core.folder_timeline_find_row_at(fid, fx.c.path(), &c_head)
            .unwrap(),
        Some(0)
    );
    // 범위 밖 저장소의 커밋 상세도 읽힌다 (그래프 필드만 빈다)
    let d = core
        .folder_commit_detail(fid, fx.a.path(), &a_head)
        .await
        .unwrap();
    assert_eq!(d.row, None);

    // 목록 밖 경로는 거부하고 범위를 바꾸지 않는다
    let stranger = fx.root.join("nope");
    std::fs::create_dir_all(&stranger).unwrap();
    assert!(matches!(
        core.folder_timeline_scope_set(fid, &[stranger]),
        Err(CoreError::Invalid(_))
    ));
    assert!(core.folder_timeline_info(fid).unwrap().scoped);

    // 워크트리 경로는 원 저장소(a)로 바뀐다. 필터와 함께 걸린다
    core.folder_timeline_scope_set(fid, &[wt, fx.b.path().to_path_buf()])
        .unwrap();
    reloaded(&mut rx, fid).await;
    core.folder_timeline_query_set(fid, query(text("fix")))
        .await
        .unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(subjects(&core, fid), ["fix: a1", "fix: a3", "fix: b1"]);
    let info = core.folder_timeline_info(fid).unwrap();
    assert_eq!(
        info.repos.iter().map(|r| r.in_scope).collect::<Vec<_>>(),
        [true, true, false]
    );

    // 빈 범위 = 전부
    core.folder_timeline_scope_set(fid, &[]).unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(
        subjects(&core, fid),
        ["fix: a1", "fix: a3", "fix: b1", "fix: c2"]
    );
    let info = core.folder_timeline_info(fid).unwrap();
    assert!(!info.scoped && info.repos.iter().all(|r| r.in_scope));
    let _ = &mut fx.b;
}

/// 재스캔으로 범위의 저장소가 사라지면 범위에서 빠지고, 모두 사라지면 전부로 돌아간다
#[tokio::test]
async fn scope_follows_rescans() {
    let fx = folder();
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &fx.root).await;
    core.folder_timeline_scope_set(fid, &[fx.b.path().to_path_buf()])
        .unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(subjects(&core, fid), ["docs: b2", "fix: b1"]);

    std::fs::remove_dir_all(fx.b.path()).unwrap();
    core.folder_rescan(fid).await.unwrap();
    reloaded(&mut rx, fid).await;
    let info = core.folder_timeline_info(fid).unwrap();
    assert_eq!(
        info.repos
            .iter()
            .map(|r| (r.name.as_str(), r.index, r.in_scope))
            .collect::<Vec<_>>(),
        [("a", 0, true), ("c", 1, true)]
    );
    assert!(!info.scoped);
    assert_eq!(subjects(&core, fid).len(), 5);
}

/// 필터가 있으면 저장소당 상한은 걸러진 커밋을 센다: 잘림 = 걸러진 결과가 상한을 넘었다
#[tokio::test]
async fn truncation_counts_filtered_commits() {
    let mut fx = folder();
    commit_as(&mut fx.a, "fix: a4", "Kim <kim@x.com>");
    let core = core_with(CoreConfig {
        timeline_max_per_repo: 2,
        ..CoreConfig::default()
    })
    .await;
    let (fid, mut rx) = open_timeline(&core, &fx.root).await;
    core.folder_timeline_query_set(fid, query(text("fix")))
        .await
        .unwrap();
    reloaded(&mut rx, fid).await;
    let info = core.folder_timeline_info(fid).unwrap();
    let truncated: Vec<(&str, bool)> = info
        .repos
        .iter()
        .map(|r| (r.name.as_str(), r.truncated))
        .collect();
    // a: fix 3개 > 2, b: 1개, c: 1개
    assert_eq!(truncated, [("a", true), ("b", false), ("c", false)]);
    assert_eq!(
        subjects(&core, fid),
        ["fix: a3", "fix: a4", "fix: b1", "fix: c2"]
    );
}

/// 잘못된 정규식은 `InvalidFilter` 이고 질의를 바꾸지 않는다 (다시 읽어도 이전 질의 그대로)
#[tokio::test]
async fn bad_regex_is_rejected_and_query_kept() {
    let fx = folder();
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &fx.root).await;
    core.folder_timeline_query_set(fid, query(text("docs")))
        .await
        .unwrap();
    reloaded(&mut rx, fid).await;
    let bad = CommitFilter {
        text: TextFilter {
            pattern: "([".into(),
            regex: true,
            match_case: false,
        },
        ..CommitFilter::default()
    };
    assert!(matches!(
        core.folder_timeline_query_set(fid, query(bad)).await,
        Err(CoreError::InvalidFilter(_))
    ));
    core.folder_timeline_reload(fid).unwrap();
    reloaded(&mut rx, fid).await;
    assert_eq!(subjects(&core, fid), ["docs: b2"]);
}

/// 작성자 후보: 범위에 든 저장소의, 필터 없는 타임라인 범위의 작성자. 타임라인이 그 범위를 다 담고 있으면
/// git 을 돌리지 않고, 필터가 걸려 있으면 범위의 저장소마다 git 한 번 — 결과는 필터와 무관하다
#[tokio::test]
async fn timeline_authors_follow_scope_and_ignore_filter() {
    let fx = folder();
    let core = core().await;
    let (fid, mut rx) = open_timeline(&core, &fx.root).await;
    let brief = |l: &mgit_core::AuthorList| {
        l.authors
            .iter()
            .map(|a| (a.email.clone(), a.commits))
            .collect::<Vec<_>>()
    };
    let all = vec![
        ("kim@x.com".to_string(), 3),
        ("lee@x.com".to_string(), 2),
        ("park@x.com".to_string(), 2),
    ];
    let n = core.command_log_recent(usize::MAX).len();
    let list = core.folder_timeline_authors(fid).await.unwrap();
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        n,
        "테이블에서 센다"
    );
    assert_eq!(brief(&list), all);

    core.folder_timeline_query_set(
        fid,
        query(CommitFilter {
            authors: vec!["park@x.com".into()],
            ..CommitFilter::default()
        }),
    )
    .await
    .unwrap();
    reloaded(&mut rx, fid).await;
    let n = core.command_log_recent(usize::MAX).len();
    let list = core.folder_timeline_authors(fid).await.unwrap();
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        n + 3,
        "저장소마다 git log 한 번"
    );
    assert_eq!(brief(&list), all, "필터와 무관하다");

    core.folder_timeline_scope_set(fid, &[fx.b.path().to_path_buf()])
        .unwrap();
    reloaded(&mut rx, fid).await;
    let list = core.folder_timeline_authors(fid).await.unwrap();
    assert_eq!(brief(&list), [("park@x.com".to_string(), 2)]);
}

/// 가벼운 세션(W13)에는 그래프가 없으므로 필터 질의·작성자 후보 모두 `GraphUnavailable`
#[tokio::test]
async fn light_sessions_have_no_filter_api() {
    let fx = folder();
    let core = core().await;
    let (sink, _rx) = collector();
    let fid = core.open_folder(&fx.root, sink).await.unwrap().session;
    let (sink, _rx2) = collector();
    let light = core
        .folder_open_repo_session(fid, fx.a.path(), sink)
        .await
        .unwrap();
    assert!(matches!(
        core.graph_authors(light.session).await,
        Err(CoreError::GraphUnavailable(_))
    ));
    assert!(matches!(
        core.set_graph_query(light.session, query(text("fix")))
            .await,
        Err(CoreError::GraphUnavailable(_))
    ));
}
