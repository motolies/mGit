//! `graph_window` 내용 검증
#![allow(clippy::unwrap_used)]

mod common;

use std::collections::HashMap;

use common::{collector, core, core_with, wait_finished};
use mgit_core::{CoreConfig, RefKind};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn window_rows_match_rev_list_and_layout_is_valid() {
    let core = core().await;
    for scenario in [
        Scenario::Linear(7),
        Scenario::BranchMerge,
        Scenario::Octopus,
        Scenario::Orphan,
        Scenario::Korean,
        Scenario::EmptyMessage,
    ] {
        let mut repo = build(scenario);
        let expected = repo.rev_list_count();
        let (sink, mut rx) = collector();
        let opened = core.open_repo(repo.path(), sink).await.unwrap();
        wait_finished(&mut rx, opened.session).await;

        let w = core.graph_window(opened.session, 0, 100).unwrap();
        assert_eq!(w.total_rows, expected, "{scenario:?}");
        assert_eq!(w.rows.len() as u32, expected);
        assert!(w.finished);
        assert_eq!(w.generation, 1);

        // 부모는 항상 뒤 행에 있다 (topo-order)
        let index: HashMap<_, _> = w.rows.iter().map(|r| (r.oid, r.row)).collect();
        for r in &w.rows {
            for p in &r.parents {
                assert!(index[p] > r.row, "{scenario:?}: 부모가 앞 행");
            }
        }
        core.verify_layout(opened.session).unwrap();
        core.close_repo(opened.session).unwrap();
    }
}

#[tokio::test]
async fn refs_and_head_are_attached_to_rows() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();

    let top = &w.rows[0];
    assert_eq!(top.oid, head);
    assert!(top.is_head);
    assert_eq!(top.parents.len(), 2);
    let names: Vec<&str> = top.refs.iter().map(|l| l.short_name.as_str()).collect();
    assert_eq!(names, vec!["main", "v1.0"]); // 현재 브랜치 먼저, 태그 나중
    assert!(top.refs[0].is_current);
    assert_eq!(top.refs[1].kind, RefKind::Tag { annotated: true });
    assert_eq!(w.rows.iter().filter(|r| r.is_head).count(), 1);

    let feature = w.rows.iter().find(|r| r.subject == "c3 feature").unwrap();
    assert_eq!(feature.refs[0].short_name, "feature");
    let base = w.rows.iter().find(|r| r.subject == "c1 base").unwrap();
    assert_eq!(base.refs[0].short_name, "v0.1");
    assert!(base.parents.is_empty());
}

#[tokio::test]
async fn window_range_and_clamp() {
    let core = core_with(CoreConfig {
        max_window_rows: 3,
        ..CoreConfig::default()
    })
    .await;
    let repo = build(Scenario::Linear(10));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let w = core.graph_window(opened.session, 2, 100).unwrap();
    assert_eq!(w.start, 2);
    assert_eq!(w.rows.len(), 3); // clamp
    assert_eq!(w.rows[0].row, 2);
    assert_eq!(w.total_rows, 10);
    assert_eq!(w.segments.len(), 1);
    assert!(w.segments[0].continues_up && w.segments[0].continues_down);

    let past_end = core.graph_window(opened.session, 50, 3).unwrap();
    assert!(past_end.rows.is_empty());
    assert_eq!(past_end.total_rows, 10);
}

#[tokio::test]
async fn author_and_times_are_filled() {
    let core = core().await;
    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let w = core.graph_window(opened.session, 0, 1).unwrap();
    let r = &w.rows[0];
    assert_eq!(r.author_name, "mGit Test");
    assert_eq!(r.author_email, "test@mgit.invalid");
    assert_eq!(r.commit_time, 1_700_000_060);
    assert_eq!(r.subject, "commit 1");
    let json = serde_json::to_value(&w).unwrap();
    assert_eq!(json["rows"][0]["authorName"], "mGit Test");
    assert_eq!(json["rows"][0]["oid"], r.oid.to_hex());
    assert!(json["totalRows"].is_number());
}

// ───────────── Phase 3 G1: 레이아웃 옵션·배지·도달성 ─────────────

/// 저장소: main c1..c{n}, 그 뒤 feature 브랜치를 `from` 에서 갈라 f1 하나. HEAD 는 main
fn repo_with_feature(n: u32, from_first: bool) -> mgit_testkit::TestRepo {
    let mut repo = build(Scenario::Linear(n));
    let base = if from_first {
        repo.git_ok(["rev-list", "--max-parents=0", "HEAD"])
            .trim()
            .to_string()
    } else {
        "HEAD".to_string()
    };
    repo.git_ok(["checkout", "-q", "-b", "feature", &base]);
    repo.commit("f1");
    repo.checkout("main");
    repo
}

#[tokio::test]
async fn pinned_head_stays_on_lane0_and_feature_is_colored() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.checkout_new("feature");
    repo.commit("f1");
    repo.commit("f2");
    repo.checkout("main");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let row = |subject: &str| w.rows.iter().find(|r| r.subject == subject).unwrap();
    // feature 커밋은 레인 1, main 체인은 레인 0 (최신 팁이 feature 라도 고정이 유지된다)
    assert_eq!(row("f2").lane, 1);
    assert_eq!(row("f1").lane, 1);
    assert_eq!(row("commit 2").lane, 0);
    assert_eq!(row("commit 1").lane, 0);
    assert_eq!(row("f2").color, mgit_core::branch_color("feature"));
    assert_eq!(row("commit 2").color, 0);
    assert!(w.stubs.is_empty());
    assert!(
        w.edges
            .iter()
            .any(|e| e.top_lane == 1 && e.bottom_lane == 0)
    );
    core.verify_layout(opened.session).unwrap();
}

#[tokio::test]
async fn long_edges_collapse_to_stubs() {
    let core = core_with(CoreConfig {
        graph_long_edge_rows: 2,
        ..CoreConfig::default()
    })
    .await;
    let repo = repo_with_feature(5, true);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert_eq!(w.total_rows, 6);
    assert_eq!(w.rows.len(), 6);
    // f1 이 가장 새 커밋이라 첫 행. 부모 c1 은 5행 아래 → 레인 대신 스텁
    assert_eq!(w.rows[0].subject, "f1");
    let down = w
        .stubs
        .iter()
        .find(|s| s.dir == mgit_core::StubDir::Down)
        .unwrap();
    assert_eq!((down.row, down.other_row), (0, Some(5)));
    let up = w
        .stubs
        .iter()
        .find(|s| s.dir == mgit_core::StubDir::Up)
        .unwrap();
    assert_eq!((up.row, up.other_row), (5, Some(0)));
    assert!(w.rows[1..].iter().all(|r| r.lane == 0));
    core.verify_layout(opened.session).unwrap();
}

#[tokio::test]
async fn relayout_without_git_bumps_generation() {
    let core = core().await;
    let repo = repo_with_feature(2, false);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let before = core.graph_window(opened.session, 0, 100).unwrap();
    assert_eq!(before.generation, 1);
    assert_eq!(
        core.graph_layout_prefs(opened.session).unwrap(),
        mgit_core::GraphLayoutPrefs::default()
    );
    core.set_graph_layout_prefs(
        opened.session,
        mgit_core::GraphLayoutPrefs {
            pin_head: false,
            ref_colors: false,
            collapse_long_edges: false,
        },
    )
    .unwrap();
    let events = common::wait_for(&mut rx, std::time::Duration::from_secs(5), |e| {
        matches!(e, mgit_core::CoreEvent::GraphReloaded { .. })
    })
    .await;
    assert!(events.iter().any(|e| matches!(
        e,
        mgit_core::CoreEvent::GraphReloaded {
            generation: 2,
            rows: 3,
            ..
        }
    )));
    let after = core.graph_window(opened.session, 0, 100).unwrap();
    assert_eq!(after.generation, 2);
    assert_eq!(after.total_rows, before.total_rows);
    // 고정을 끄면 최신 팁(f1)이 레인 0 을 가져간다
    assert_eq!(after.rows[0].subject, "f1");
    assert_eq!(after.rows[0].lane, 0);
    core.verify_layout(opened.session).unwrap();
}

#[tokio::test]
async fn hide_remotes_filters_row_badges() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let has_remote = |w: &mgit_core::GraphWindow| {
        w.rows
            .iter()
            .flat_map(|r| r.refs.iter())
            .any(|l| matches!(l.kind, RefKind::RemoteBranch { .. }))
    };
    assert!(has_remote(
        &core.graph_window(opened.session, 0, 100).unwrap()
    ));

    core.set_graph_query(
        opened.session,
        mgit_core::GraphQuery {
            revs: mgit_core::GraphRevs::Solo {
                name: "main".into(),
            },
            hide_remotes: true,
            ..mgit_core::GraphQuery::default()
        },
    )
    .await
    .unwrap();
    common::wait_for(&mut rx, std::time::Duration::from_secs(5), |e| {
        matches!(e, mgit_core::CoreEvent::GraphReloaded { .. })
    })
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert!(!has_remote(&w));
    assert!(
        w.rows
            .iter()
            .any(|r| r.refs.iter().any(|l| l.short_name == "main"))
    );
}

#[tokio::test]
async fn first_parent_and_no_merges_shapes() {
    let core = core().await;
    let repo = build(Scenario::BranchMerge);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.set_graph_query(
        opened.session,
        mgit_core::GraphQuery {
            first_parent: true,
            ..mgit_core::GraphQuery::default()
        },
    )
    .await
    .unwrap();
    common::wait_for(&mut rx, std::time::Duration::from_secs(5), |e| {
        matches!(e, mgit_core::CoreEvent::GraphReloaded { .. })
    })
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    // feature 팁은 `--all` 에 들어 있지만, 머지 행에서 둘째 부모로 가는 분기 엣지는 없다
    assert_eq!(w.rows[0].subject, "merge feature");
    assert_eq!(w.rows[0].parents.len(), 2); // 머지 고리는 유지
    assert!(w.edges.iter().all(|e| e.top_row != 0));
    core.verify_layout(opened.session).unwrap();

    core.set_graph_query(
        opened.session,
        mgit_core::GraphQuery {
            no_merges: true,
            ..mgit_core::GraphQuery::default()
        },
    )
    .await
    .unwrap();
    common::wait_for(&mut rx, std::time::Duration::from_secs(5), |e| {
        matches!(e, mgit_core::CoreEvent::GraphReloaded { .. })
    })
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert!(w.rows.iter().all(|r| r.subject != "merge feature"));
    assert!(w.rows.iter().all(|r| {
        r.lane == 0 && r.color == 0
            || r.refs
                .iter()
                .any(|l| l.short_name == "main" || l.short_name == "feature")
    }));
    assert!(w.edges.is_empty() && w.stubs.is_empty());
    core.verify_layout(opened.session).unwrap();
}

#[tokio::test]
async fn in_head_marks_reachable_rows() {
    let core = core().await;
    let repo = repo_with_feature(2, false);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let row = |subject: &str| w.rows.iter().find(|r| r.subject == subject).unwrap();
    assert!(!row("f1").in_head);
    assert!(row("commit 2").in_head);
    assert!(row("commit 1").in_head);
    assert!(w.rows.iter().all(|r| r.repo.is_none()));
}

/// 재로드가 끝날 때까지(성공·실패) 이벤트를 모은다
async fn wait_reload(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<mgit_core::CoreEvent>,
) -> Vec<mgit_core::CoreEvent> {
    common::wait_for(rx, std::time::Duration::from_secs(10), |e| {
        matches!(
            e,
            mgit_core::CoreEvent::GraphReloaded { .. }
                | mgit_core::CoreEvent::GraphReloadFailed { .. }
        )
    })
    .await
}

/// 질의를 바꾸고 재로드 성공까지 기다린다
async fn apply_query(
    core: &mgit_core::Core,
    session: mgit_core::SessionId,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<mgit_core::CoreEvent>,
    query: mgit_core::GraphQuery,
) {
    core.set_graph_query(session, query).await.unwrap();
    let events = wait_reload(rx).await;
    assert!(
        matches!(
            events.last(),
            Some(mgit_core::CoreEvent::GraphReloaded { .. })
        ),
        "{events:?}"
    );
}

/// 범위에 HEAD 가 없으면 도달성을 알 수 없으므로 전 행을 흐리지 않는다
#[tokio::test]
async fn rows_stay_bright_when_head_is_outside_path_scope() {
    let core = core().await;
    let mut repo = mgit_testkit::TestRepo::init();
    repo.write_file("m/a.txt", "1\n");
    repo.commit("in scope");
    repo.commit("outside");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    apply_query(
        &core,
        opened.session,
        &mut rx,
        mgit_core::GraphQuery {
            path_scope: vec!["m".into()],
            ..mgit_core::GraphQuery::default()
        },
    )
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert_eq!(w.rows.len(), 1);
    assert_eq!(w.rows[0].subject, "in scope");
    assert!(w.rows[0].in_head, "HEAD 가 로그에 없으면 흐리지 않는다");
}

/// HEAD 브랜치를 뺀 Solo 질의도 전 행을 흐리지 않는다
#[tokio::test]
async fn rows_stay_bright_when_head_branch_is_filtered_out() {
    let core = core().await;
    // 첫 커밋에서 갈라져 feature 쪽 로그에 HEAD(commit 2)가 없다
    let repo = repo_with_feature(2, true);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    apply_query(
        &core,
        opened.session,
        &mut rx,
        mgit_core::GraphQuery {
            revs: mgit_core::GraphRevs::Solo {
                name: "feature".into(),
            },
            ..mgit_core::GraphQuery::default()
        },
    )
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert!(w.rows.iter().any(|r| r.subject == "f1"));
    assert!(w.rows.iter().all(|r| r.subject != "commit 2"));
    assert!(w.rows.iter().all(|r| r.in_head));
}

/// 머지 제외는 HEAD 체인이 끊기므로 도달성을 알 수 없다. HEAD 가 머지 커밋이어도 전 행을 흐리지 않는다
#[tokio::test]
async fn rows_stay_bright_with_no_merges() {
    let core = core().await;
    let repo = build(Scenario::BranchMerge);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    apply_query(
        &core,
        opened.session,
        &mut rx,
        mgit_core::GraphQuery {
            no_merges: true,
            ..mgit_core::GraphQuery::default()
        },
    )
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert!(!w.rows.is_empty());
    assert!(w.rows.iter().all(|r| r.in_head));
}

/// 날짜가 비정상인 커밋이 있어도 그래프가 로드되고 그 값은 0 이다
#[tokio::test]
async fn commit_with_broken_dates_does_not_fail_load() {
    let core = core().await;
    let mut repo = mgit_testkit::TestRepo::init();
    repo.commit("root");
    let tree = repo.git_ok(["rev-parse", "HEAD^{tree}"]);
    let parent = repo.git_ok(["rev-parse", "HEAD"]);
    let body = format!(
        "tree {}\nparent {}\nauthor Foo <foo@x>\ncommitter Foo <foo@x> 99999999999999999999 +0000\n\nbroken\n",
        tree.trim(),
        parent.trim()
    );
    let out = repo.git_with_stdin(
        [
            "hash-object",
            "-t",
            "commit",
            "-w",
            "--stdin",
            "--literally",
        ],
        Some(body.as_bytes()),
    );
    assert!(out.status.success());
    let oid = String::from_utf8(out.stdout).unwrap();
    repo.git_ok(["update-ref", "refs/heads/main", oid.trim()]);

    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert_eq!(
        core.load_state(opened.session).unwrap(),
        mgit_core::LoadState::Finished
    );
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let broken = w.rows.iter().find(|r| r.subject == "broken").unwrap();
    assert_eq!((broken.author_time, broken.commit_time), (0, 0));
    assert_eq!(w.rows.len(), 2);
}

/// Solo 로 고른 ref 가 사라지면 재로드가 실패하지 않고 전체 범위로 돌아간다
#[tokio::test]
async fn solo_filter_falls_back_to_all_when_ref_disappears() {
    let core = core().await;
    let mut repo = repo_with_feature(2, false);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    apply_query(
        &core,
        opened.session,
        &mut rx,
        mgit_core::GraphQuery {
            revs: mgit_core::GraphRevs::Solo {
                name: "feature".into(),
            },
            ..mgit_core::GraphQuery::default()
        },
    )
    .await;

    repo.git_ok(["branch", "-D", "feature"]);
    core.refresh(opened.session).await.unwrap();
    let events = wait_reload(&mut rx).await;
    assert!(
        matches!(
            events.last(),
            Some(mgit_core::CoreEvent::GraphReloaded { .. })
        ),
        "{events:?}"
    );
    assert_eq!(
        core.graph_query(opened.session).unwrap().revs,
        mgit_core::GraphRevs::All
    );
    assert!(events.iter().any(|e| matches!(
        e,
        mgit_core::CoreEvent::GraphQueryAdjusted { query, dropped, .. }
            if query.revs == mgit_core::GraphRevs::All && dropped == &["feature".to_string()]
    )));
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert!(w.rows.iter().any(|r| r.subject == "commit 2"));
    assert!(w.rows.iter().all(|r| r.subject != "f1"));
}

/// 여러 ref 중 하나만 사라지면 그 ref 만 뺀다
#[tokio::test]
async fn branches_filter_drops_only_missing_ref() {
    let core = core().await;
    let mut repo = repo_with_feature(2, false);
    repo.git_ok(["branch", "gone", "HEAD~1"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    apply_query(
        &core,
        opened.session,
        &mut rx,
        mgit_core::GraphQuery {
            revs: mgit_core::GraphRevs::Branches {
                names: vec!["feature".into(), "gone".into()],
            },
            ..mgit_core::GraphQuery::default()
        },
    )
    .await;

    repo.git_ok(["branch", "-D", "gone"]);
    core.refresh(opened.session).await.unwrap();
    let events = wait_reload(&mut rx).await;
    assert!(
        matches!(
            events.last(),
            Some(mgit_core::CoreEvent::GraphReloaded { .. })
        ),
        "{events:?}"
    );
    assert_eq!(
        core.graph_query(opened.session).unwrap().revs,
        mgit_core::GraphRevs::Branches {
            names: vec!["feature".into()]
        }
    );
}

/// 입력한 ref 가 처음부터 없으면 질의를 바꾸지 않고 오류를 돌려준다
#[tokio::test]
async fn unknown_ref_in_query_is_rejected() {
    let core = core().await;
    let repo = repo_with_feature(2, false);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let err = core
        .set_graph_query(
            opened.session,
            mgit_core::GraphQuery {
                revs: mgit_core::GraphRevs::Solo {
                    name: "nonexistent".into(),
                },
                ..mgit_core::GraphQuery::default()
            },
        )
        .await;
    assert!(
        matches!(err, Err(mgit_core::CoreError::Invalid(_))),
        "{err:?}"
    );
    assert_eq!(
        core.graph_query(opened.session).unwrap().revs,
        mgit_core::GraphRevs::All
    );
}

/// `refs/replace` 의 대체 객체가 ref 없는 유령 행으로 나오지 않는다
#[tokio::test]
async fn replace_refs_do_not_add_phantom_rows() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(3));
    repo.git_ok(["replace", "--graft", "HEAD", "HEAD~2"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let subjects: Vec<&str> = w.rows.iter().map(|r| r.subject.as_str()).collect();
    assert_eq!(subjects, vec!["commit 3", "commit 1"]);
    core.verify_layout(opened.session).unwrap();
}

/// 작업 트리 폴더와 이름이 같은 브랜치도 필터할 수 있다 (`--` 가 없으면 git 이 모호하다고 거부한다)
#[tokio::test]
async fn filter_on_branch_named_like_a_directory() {
    let core = core().await;
    let mut repo = mgit_testkit::TestRepo::init();
    repo.write_file("docs/a.txt", "1\n");
    repo.commit("base");
    repo.git_ok(["branch", "docs"]);
    repo.commit("main only");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    apply_query(
        &core,
        opened.session,
        &mut rx,
        mgit_core::GraphQuery {
            revs: mgit_core::GraphRevs::Solo {
                name: "docs".into(),
            },
            ..mgit_core::GraphQuery::default()
        },
    )
    .await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let subjects: Vec<&str> = w.rows.iter().map(|r| r.subject.as_str()).collect();
    assert_eq!(subjects, vec!["base"]);
}

/// 필터 검사는 브랜치 이름만이 아니라 git 이 받는 rev 표현(태그·해시·범위)을 그대로 통과시킨다
#[tokio::test]
async fn filter_keeps_revision_expressions() {
    let core = core().await;
    let mut repo = repo_with_feature(2, false);
    repo.tag("v1", false);
    let head = repo.head().to_hex();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    for name in ["v1", "HEAD~1", "main..feature", head.as_str()] {
        apply_query(
            &core,
            opened.session,
            &mut rx,
            mgit_core::GraphQuery {
                revs: mgit_core::GraphRevs::Solo { name: name.into() },
                ..mgit_core::GraphQuery::default()
            },
        )
        .await;
        assert_eq!(
            core.graph_query(opened.session).unwrap().revs,
            mgit_core::GraphRevs::Solo { name: name.into() },
            "{name}"
        );
    }
}

/// HEAD 범위 질의 (BT-03)
fn head_query() -> mgit_core::GraphQuery {
    mgit_core::GraphQuery {
        revs: mgit_core::GraphRevs::Head,
        ..mgit_core::GraphQuery::default()
    }
}

/// HEAD 범위는 HEAD 에서 닿는 커밋만 보이고 HEAD 레인 고정이 유지된다. detached 여도 된다
#[tokio::test]
async fn head_revs_show_only_head_history_even_when_detached() {
    let core = core().await;
    let mut repo = repo_with_feature(3, false);
    repo.commit("main 4");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert_eq!(
        core.graph_window(opened.session, 0, 100)
            .unwrap()
            .total_rows,
        5
    );

    apply_query(&core, opened.session, &mut rx, head_query()).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let subjects: Vec<&str> = w.rows.iter().map(|r| r.subject.as_str()).collect();
    assert_eq!(subjects, vec!["main 4", "commit 3", "commit 2", "commit 1"]);
    assert!(w.rows.iter().all(|r| r.in_head && r.lane == 0));
    assert_eq!(
        core.graph_query(opened.session).unwrap().revs,
        mgit_core::GraphRevs::Head,
        "HEAD 범위는 없는 ref 로 취급돼 전체로 되돌아가지 않는다"
    );

    // detached: 그 커밋에서 닿는 것만
    repo.git_ok(["checkout", "-q", "--detach", "HEAD~2"]);
    core.refresh(opened.session).await.unwrap();
    let events = wait_reload(&mut rx).await;
    assert!(
        matches!(
            events.last(),
            Some(mgit_core::CoreEvent::GraphReloaded { .. })
        ),
        "{events:?}"
    );
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    let subjects: Vec<&str> = w.rows.iter().map(|r| r.subject.as_str()).collect();
    assert_eq!(subjects, vec!["commit 2", "commit 1"]);
    assert!(w.rows[0].is_head);
}

/// 커밋이 없는 저장소(unborn)에서 HEAD 범위는 실패하지 않고 빈 그래프다. 첫 커밋 뒤에는 그 커밋이 보인다
#[tokio::test]
async fn head_revs_on_unborn_repo_is_empty_not_an_error() {
    let core = core().await;
    let mut repo = build(Scenario::Empty);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    apply_query(&core, opened.session, &mut rx, head_query()).await;
    let w = core.graph_window(opened.session, 0, 100).unwrap();
    assert_eq!(w.total_rows, 0);
    assert!(w.finished);

    repo.commit("first");
    core.refresh(opened.session).await.unwrap();
    let events = wait_reload(&mut rx).await;
    assert!(
        matches!(
            events.last(),
            Some(mgit_core::CoreEvent::GraphReloaded { rows: 1, .. })
        ),
        "{events:?}"
    );
}
