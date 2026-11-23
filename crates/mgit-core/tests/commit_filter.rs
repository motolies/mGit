//! 커밋 필터 (LG-06) — 단일 저장소 그래프: 걸러내기·목록 모드·해시·재로드 유지·오류 구분·작성자 후보.
//! git 인자와 git 자체의 동작(정규식·대소문자·작성자·날짜)은 `mgit-git/tests/log_filter.rs` 가 맡는다
#![allow(clippy::unwrap_used)]

mod common;

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{
    CommitFilter, Core, CoreError, CoreEvent, GraphQuery, GraphRevs, Oid, SearchFields, SessionId,
    TextFilter,
};
use mgit_testkit::TestRepo;
use tokio::sync::mpsc::UnboundedReceiver;

/// 작성자를 지정해 파일 하나를 바꾸는 커밋을 만든다 (커밋 시각은 저장소 시계 +60초)
fn commit_as(repo: &mut TestRepo, msg: &str, author: &str) -> Oid {
    commit_file_as(repo, msg, author, &format!("f-{msg}.txt"))
}

/// `path` 를 바꾸는 커밋 (경로 범위 조합용)
fn commit_file_as(repo: &mut TestRepo, msg: &str, author: &str, path: &str) -> Oid {
    repo.write_file(path, msg);
    repo.stage(&[path]);
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

/// 텍스트 필터
fn text(pattern: &str, regex: bool) -> CommitFilter {
    CommitFilter {
        text: TextFilter {
            pattern: pattern.into(),
            regex,
            match_case: false,
        },
        ..CommitFilter::default()
    }
}

/// 필터만 바꾼 기본 질의
fn filtered(filter: CommitFilter) -> GraphQuery {
    GraphQuery {
        filter,
        ..GraphQuery::default()
    }
}

/// 저장소를 열고 첫 로드를 기다린다
async fn open(core: &Core, path: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(path, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    (opened.session, rx)
}

/// 질의를 바꾸고 재로드가 끝날 때까지 기다린다. 받은 이벤트를 돌려준다
async fn requery(
    core: &Core,
    rx: &mut UnboundedReceiver<CoreEvent>,
    session: SessionId,
    query: GraphQuery,
) -> Vec<CoreEvent> {
    core.set_graph_query(session, query).await.unwrap();
    wait_reloaded(rx).await
}

/// 재로드(성공 또는 실패) 이벤트까지 기다린다
async fn wait_reloaded(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    wait_for(rx, Duration::from_secs(10), |e| {
        matches!(
            e,
            CoreEvent::GraphReloaded { .. } | CoreEvent::GraphReloadFailed { .. }
        )
    })
    .await
}

/// 지금 그래프의 제목 목록
fn subjects(core: &Core, session: SessionId) -> Vec<String> {
    core.graph_window(session, 0, 1000)
        .unwrap()
        .rows
        .into_iter()
        .map(|r| r.subject)
        .collect()
}

/// 정렬한 제목 목록 (순서와 무관한 비교)
fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// main: init → fix: a → (feature: fix: b) → Merge → docs. 작성자는 Kim·Lee 가 섞인다
struct Fixture {
    repo: TestRepo,
    init: Oid,
    fix_a: Oid,
    fix_b: Oid,
    merge: Oid,
}

/// 머지가 든 저장소
fn fixture() -> Fixture {
    let mut repo = TestRepo::init();
    let init = commit_as(&mut repo, "init", "Kim <kim@x.com>");
    let fix_a = commit_as(&mut repo, "fix: a", "Kim <kim@x.com>");
    repo.checkout_new("feature");
    let fix_b = commit_as(&mut repo, "fix: b", "Lee <lee@x.com>");
    repo.checkout("main");
    commit_as(&mut repo, "feat: c", "Lee <lee@x.com>");
    let merge = repo.merge(&["feature"], "Merge feature");
    commit_as(&mut repo, "docs: d", "Kimberly <kimberly@x.com>");
    Fixture {
        repo,
        init,
        fix_a,
        fix_b,
        merge,
    }
}

/// 텍스트 필터: 맞는 커밋만, 선 없는 목록 모드(레인 0, 엣지 없음, 흐림 없음). 걸러진 커밋은 행 찾기·커밋
/// 상세가 그대로 되고, 부모가 결과에 없어도 상세의 부모는 실제 부모, 자식은 결과 안의 자식이다
#[tokio::test]
async fn text_filter_lists_scattered_commits() {
    let fx = fixture();
    let core = core().await;
    let (s, mut rx) = open(&core, fx.repo.path()).await;
    let before = core.graph_window(s, 0, 1000).unwrap();
    assert!(!before.edges.is_empty(), "머지가 있어 그래프에 엣지가 있다");

    requery(&core, &mut rx, s, filtered(text("fix", false))).await;
    let w = core.graph_window(s, 0, 1000).unwrap();
    assert_eq!(
        sorted(w.rows.iter().map(|r| r.subject.clone()).collect()),
        ["fix: a", "fix: b"]
    );
    assert_eq!(w.lane_count, 1);
    assert!(w.rows.iter().all(|r| r.lane == 0));
    // 색은 머지 제외의 목록 모드와 같다: ref 가 없는 행은 0, 브랜치 끝(feature)은 브랜치 이름 색
    let fix_a = w.rows.iter().find(|r| r.oid == fx.fix_a).unwrap();
    assert_eq!(fix_a.color, 0);
    assert!(w.edges.is_empty() && w.stubs.is_empty());
    assert!(
        w.rows.iter().all(|r| r.in_head),
        "목록 모드는 흐리지 않는다"
    );

    assert!(core.find_row(s, &fx.fix_a).unwrap().is_some());
    assert_eq!(core.find_row(s, &fx.init).unwrap(), None);
    let d = core.commit_detail(s, &fx.fix_a).await.unwrap();
    assert_eq!(d.parents, vec![fx.init], "부모는 걸러졌어도 실제 부모다");
    assert!(d.row.is_some());
    // 자식 중 feat: c 는 결과에 없고 fix: b(feature)만 있다
    assert_eq!(d.children, vec![fx.fix_b]);
    // 걸러져 빠진 커밋의 상세도 읽힌다 (행·자식만 빈다)
    let d = core.commit_detail(s, &fx.merge).await.unwrap();
    assert_eq!(d.row, None);
    assert_eq!(d.parents.len(), 2);
}

/// 결과 0개는 오류가 아니라 0행 그래프. 잘못된 정규식·줄바꿈은 `InvalidFilter` 이고 질의를 바꾸지 않는다
#[tokio::test]
async fn empty_result_and_invalid_filters_are_distinct() {
    let fx = fixture();
    let core = core().await;
    let (s, mut rx) = open(&core, fx.repo.path()).await;

    let events = requery(&core, &mut rx, s, filtered(text("no such words", false))).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::GraphReloaded { rows: 0, .. })),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, CoreEvent::GraphReloadFailed { .. }))
    );
    assert_eq!(core.graph_window(s, 0, 10).unwrap().total_rows, 0);

    let kept = core.graph_query(s).unwrap();
    for bad in [
        filtered(text("(", true)),
        filtered(text("fix\nfeat", false)),
        filtered(CommitFilter {
            authors: vec!["a@b\0".into()],
            ..CommitFilter::default()
        }),
    ] {
        match core.set_graph_query(s, bad.clone()).await {
            Err(CoreError::InvalidFilter(msg)) => assert!(!msg.is_empty()),
            other => panic!("InvalidFilter 이어야 한다: {other:?} ({bad:?})"),
        }
        assert_eq!(core.graph_query(s).unwrap(), kept, "질의는 그대로다");
    }
    match core.set_graph_query(s, filtered(text("(", true))).await {
        Err(CoreError::InvalidFilter(msg)) => {
            assert!(msg.contains("parentheses not balanced"), "{msg}");
        }
        other => panic!("{other:?}"),
    }
    // 글자 그대로의 `(` 는 정규식이 아니라 받는다
    requery(&core, &mut rx, s, filtered(text("(", false))).await;
    assert_eq!(core.graph_window(s, 0, 10).unwrap().total_rows, 0);
}

/// 검색어가 해시 접두(7자 이상 hex)로 보이면 그 해시의 커밋도 든다 (메시지 일치와 함께, 커밋 시각 차례).
/// 해시 커밋도 다른 조건(작성자·범위)을 지켜야 하고, 6자 이하면 해시로 보지 않는다
#[tokio::test]
async fn hash_prefix_adds_the_commit_with_its_conditions() {
    let mut repo = TestRepo::init();
    let alpha = commit_as(&mut repo, "alpha", "Kim <kim@x.com>");
    let prefix = alpha.to_hex()[..8].to_string();
    commit_as(&mut repo, &format!("revert {prefix}"), "Lee <lee@x.com>");
    commit_as(&mut repo, "unrelated", "Lee <lee@x.com>");
    repo.checkout_new("side");
    let side = commit_as(&mut repo, "side only", "Kim <kim@x.com>");
    repo.checkout("main");
    let core = core().await;
    let (s, mut rx) = open(&core, repo.path()).await;

    requery(&core, &mut rx, s, filtered(text(&prefix, false))).await;
    assert_eq!(
        subjects(&core, s),
        [format!("revert {prefix}"), "alpha".to_string()]
    );
    // 대문자·앞뒤 공백도 해시로 본다
    requery(
        &core,
        &mut rx,
        s,
        filtered(text(&format!("  {}  ", prefix.to_uppercase()), false)),
    )
    .await;
    assert_eq!(
        subjects(&core, s).len(),
        1,
        "메시지는 공백까지 글자 그대로라 해시만 맞는다"
    );
    assert_eq!(core.find_row(s, &alpha).unwrap(), Some(0));

    // 작성자 조건을 함께 걸면 해시 커밋도 그 조건을 지킨다
    let lee_only = CommitFilter {
        authors: vec!["lee@x.com".into()],
        ..text(&prefix, false)
    };
    requery(&core, &mut rx, s, filtered(lee_only)).await;
    assert_eq!(subjects(&core, s), [format!("revert {prefix}")]);

    // 범위 밖(main 만)의 커밋은 해시가 맞아도 들지 않는다
    let side_prefix = side.to_hex()[..10].to_string();
    requery(
        &core,
        &mut rx,
        s,
        GraphQuery {
            revs: GraphRevs::Solo {
                name: "main".into(),
            },
            ..filtered(text(&side_prefix, false))
        },
    )
    .await;
    assert!(subjects(&core, s).is_empty());
    requery(&core, &mut rx, s, filtered(text(&side_prefix, false))).await;
    assert_eq!(subjects(&core, s), ["side only"]);

    // 6자는 해시로 보지 않는다: 메시지에 그 글자가 든 커밋만
    requery(&core, &mut rx, s, filtered(text(&prefix[..6], false))).await;
    assert_eq!(subjects(&core, s), [format!("revert {prefix}")]);
}

/// ref 가 바뀌어 다시 읽어도 필터가 유지된다
#[tokio::test]
async fn filter_survives_reload_after_ref_change() {
    let mut fx = fixture();
    let core = core().await;
    let (s, mut rx) = open(&core, fx.repo.path()).await;
    let kim = CommitFilter {
        authors: vec!["kim@x.com".into()],
        ..CommitFilter::default()
    };
    requery(&core, &mut rx, s, filtered(kim.clone())).await;
    assert_eq!(sorted(subjects(&core, s)), ["fix: a", "init"]);

    commit_as(&mut fx.repo, "new by kim", "Kim <kim@x.com>");
    commit_as(&mut fx.repo, "new by lee", "Lee <lee@x.com>");
    core.reload_graph(s).unwrap();
    wait_reloaded(&mut rx).await;
    assert_eq!(subjects(&core, s)[0], "new by kim");
    assert!(!subjects(&core, s).contains(&"new by lee".to_string()));
    assert_eq!(core.graph_query(s).unwrap().filter, kim);
}

/// 기존 옵션과의 조합: 경로 범위·첫 부모·머지 제외·ref 범위·원격 숨기기, 날짜만이면 그래프를 그린다
#[tokio::test]
async fn filter_combines_with_existing_options() {
    let mut fx = fixture();
    commit_file_as(&mut fx.repo, "fix: in src", "Kim <kim@x.com>", "src/a.rs");
    // 원격 추적 ref 에만 있는 커밋
    fx.repo.checkout_new("tmp");
    let remote_only = commit_as(&mut fx.repo, "fix: remote only", "Kim <kim@x.com>");
    fx.repo.checkout("main");
    fx.repo
        .git_ok(["update-ref", "refs/remotes/origin/x", &remote_only.to_hex()]);
    fx.repo.git_ok(["branch", "-D", "tmp"]);
    let core = core().await;
    let (s, mut rx) = open(&core, fx.repo.path()).await;
    let fix = || text("fix", false);

    let q = GraphQuery {
        path_scope: vec!["src".into()],
        ..filtered(fix())
    };
    requery(&core, &mut rx, s, q).await;
    assert_eq!(subjects(&core, s), ["fix: in src"]);

    let q = GraphQuery {
        first_parent: true,
        revs: GraphRevs::Head,
        ..filtered(fix())
    };
    requery(&core, &mut rx, s, q).await;
    assert_eq!(sorted(subjects(&core, s)), ["fix: a", "fix: in src"]);

    let q = GraphQuery {
        hide_remotes: true,
        ..filtered(fix())
    };
    requery(&core, &mut rx, s, q).await;
    assert!(!subjects(&core, s).contains(&"fix: remote only".to_string()));
    requery(&core, &mut rx, s, filtered(fix())).await;
    assert!(subjects(&core, s).contains(&"fix: remote only".to_string()));

    let q = GraphQuery {
        revs: GraphRevs::Solo {
            name: "feature".into(),
        },
        ..filtered(fix())
    };
    requery(&core, &mut rx, s, q).await;
    assert_eq!(sorted(subjects(&core, s)), ["fix: a", "fix: b"]);

    requery(&core, &mut rx, s, filtered(text("Merge", false))).await;
    assert_eq!(subjects(&core, s), ["Merge feature"]);
    let q = GraphQuery {
        no_merges: true,
        ..filtered(text("Merge", false))
    };
    requery(&core, &mut rx, s, q).await;
    assert!(subjects(&core, s).is_empty());

    // 날짜만: 그 기간의 이력은 이어져 있어 그래프(엣지)를 그린다. 처음부터 머지까지의 구간
    let merge_time = core
        .commit_detail(s, &fx.merge)
        .await
        .unwrap()
        .committer_time;
    let q = filtered(CommitFilter {
        since: Some(merge_time - 300),
        until: Some(merge_time),
        ..CommitFilter::default()
    });
    requery(&core, &mut rx, s, q).await;
    let w = core.graph_window(s, 0, 1000).unwrap();
    assert!(!w.edges.is_empty(), "날짜만 걸면 목록 모드가 아니다");
    let got: HashSet<String> = w.rows.into_iter().map(|r| r.subject).collect();
    assert!(got.contains("Merge feature") && got.contains("fix: b"));
    assert!(!got.contains("docs: d"), "상한 뒤의 커밋은 빠진다");
    assert!(core.find_row(s, &fx.fix_b).unwrap().is_some());
}

/// 작성자 후보: 이력 전체를 담은 그래프면 테이블에서(git 0회), 필터가 걸려 있으면 git 으로 — 어느 쪽이든
/// 필터와 무관한 전체 후보다. .mailmap 으로 묶이고 커밋 수 내림차순
#[tokio::test]
async fn author_candidates_ignore_the_filter() {
    let mut fx = fixture();
    commit_as(&mut fx.repo, "alias", "Kim <kim@old.com>");
    fx.repo
        .write_file(".mailmap", "Kim <kim@x.com> <kim@old.com>\n");
    let core = core().await;
    let (s, mut rx) = open(&core, fx.repo.path()).await;
    let brief = |l: &mgit_core::AuthorList| {
        l.authors
            .iter()
            .map(|a| (a.email.clone(), a.commits))
            .collect::<Vec<_>>()
    };
    let expected = vec![
        ("kim@x.com".to_string(), 3),
        ("lee@x.com".to_string(), 2),
        ("kimberly@x.com".to_string(), 1),
    ];
    let before = core.command_log_recent(usize::MAX).len();
    let from_table = core.graph_authors(s).await.unwrap();
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        before,
        "git 을 돌리지 않는다"
    );
    // 머지 커밋은 testkit 의 기본 작성자다
    let mut table = brief(&from_table);
    table.retain(|(e, _)| e != "test@mgit.invalid");
    assert_eq!(table, expected);

    let kim = CommitFilter {
        authors: vec!["kim@x.com".into()],
        ..CommitFilter::default()
    };
    requery(&core, &mut rx, s, filtered(kim)).await;
    let before = core.command_log_recent(usize::MAX).len();
    let from_git = core.graph_authors(s).await.unwrap();
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        before + 1,
        "git log 한 번"
    );
    assert_eq!(brief(&from_git), brief(&from_table), "필터와 무관하다");
    assert!(!from_git.truncated && !from_git.timed_out);
}

/// 하이라이트 검색은 필터로 걸러진 행 안에서만 찾는다 (걸러진 결과의 행 번호를 돌려준다)
#[tokio::test]
async fn highlight_search_looks_inside_the_filtered_rows() {
    let fx = fixture();
    let core = core().await;
    let (s, mut rx) = open(&core, fx.repo.path()).await;
    requery(&core, &mut rx, s, filtered(text("fix", false))).await;
    let hit = core
        .search_commits(s, "Lee", SearchFields::default(), 10)
        .unwrap();
    assert_eq!(hit.total, 1, "Lee 의 커밋 중 fix 인 것만");
    let none = core
        .search_commits(s, "docs", SearchFields::default(), 10)
        .unwrap();
    assert_eq!(none.total, 0);
    let adv = core
        .search_advanced(
            s,
            &mgit_core::AdvancedSearch {
                author: Some("Kimberly".into()),
                ..mgit_core::AdvancedSearch::default()
            },
            10,
        )
        .await
        .unwrap();
    assert_eq!(
        adv.total, 0,
        "git 이 찾아도 걸러진 그래프에 없는 커밋은 빠진다"
    );
}
