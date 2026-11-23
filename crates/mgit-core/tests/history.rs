//! diff·히스토리·그래프 질의 (DIFF-03·04·05·06, GRAPH-07·08·10)
#![allow(clippy::unwrap_used)]

mod common;

use std::time::Duration;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{
    AdvancedSearch, CoreEvent, DiffOptions, EMPTY_TREE, GraphQuery, GraphRevs, Pickaxe,
};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn blame_and_file_history_follow_renames() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("a.txt", "one\ntwo\n");
    repo.stage(&["a.txt"]);
    let c1 = repo.commit_staged("add a");
    repo.write_file("a.txt", "one\ntwo changed\n");
    repo.stage(&["a.txt"]);
    let c2 = repo.commit_staged("edit a");
    repo.git_ok(["mv", "a.txt", "b.txt"]);
    let c3 = repo.commit_staged("rename a to b");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let lines = core
        .blame(opened.session, "b.txt", None, false)
        .await
        .unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].oid, c1, "첫 줄은 최초 커밋");
    assert_eq!(lines[1].oid, c2, "둘째 줄은 수정 커밋");
    assert_eq!(lines[1].line, 2);
    assert_eq!(lines[0].author, "mGit Test");
    assert!(lines[1].previous.is_some());
    // 특정 rev 기준
    let at_c1 = core
        .blame(opened.session, "a.txt", Some(&c1.to_hex()), false)
        .await
        .unwrap();
    assert!(at_c1.iter().all(|l| l.oid == c1));

    let history = core
        .file_history(opened.session, "b.txt", 50)
        .await
        .unwrap();
    assert_eq!(
        history.iter().map(|h| h.oid).collect::<Vec<_>>(),
        vec![c3, c2, c1]
    );
    assert_eq!(history[0].path, "b.txt");
    assert_eq!(history[2].path, "a.txt", "--follow 로 옛 경로를 따라간다");
}

#[tokio::test]
async fn compare_refs_two_and_three_dot_and_range() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("base.txt", "b\n");
    repo.stage(&["base.txt"]);
    repo.commit_staged("base");
    repo.checkout_new("feat");
    repo.write_file("feat.txt", "f\n");
    repo.stage(&["feat.txt"]);
    let feat_tip = repo.commit_staged("feat 1");
    repo.checkout("main");
    repo.write_file("main.txt", "m\n");
    repo.stage(&["main.txt"]);
    repo.commit_staged("main 1");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // main..feat: feat 쪽 변경만 (feat.txt 추가, main.txt 는 없음)
    let two = core
        .compare_refs(opened.session, "main", "feat", false)
        .await
        .unwrap();
    let names: Vec<&str> = two.iter().map(|f| f.path.as_str()).collect();
    assert!(names.contains(&"feat.txt"), "{names:?}");
    assert!(
        names.contains(&"main.txt"),
        "A..B 는 A 에만 있는 파일을 삭제로 본다: {names:?}"
    );
    let three = core
        .compare_refs(opened.session, "main", "feat", true)
        .await
        .unwrap();
    let names3: Vec<&str> = three.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(names3, vec!["feat.txt"], "A...B 는 merge-base 기준");
    let d = core
        .compare_file_diff(
            opened.session,
            "main",
            "feat",
            true,
            "feat.txt",
            DiffOptions::default(),
            true,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d.hunks.len(), 1);

    // 범위 diff: feat_tip 하나 → base 는 그 부모, 루트면 빈 트리
    let (base, files) = core
        .range_files(opened.session, &feat_tip, &feat_tip)
        .await
        .unwrap();
    assert_ne!(base, EMPTY_TREE);
    assert_eq!(
        files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["feat.txt"]
    );
    let root = mgit_core::Oid::from_hex(
        repo.git_ok(["rev-list", "--max-parents=0", "HEAD"])
            .trim()
            .as_bytes(),
    )
    .unwrap();
    let (base, files) = core
        .range_files(opened.session, &root, &root)
        .await
        .unwrap();
    assert_eq!(base, EMPTY_TREE);
    assert!(!files.is_empty());

    // diff 옵션: 공백 무시 → 공백만 바뀐 파일은 hunk 없음
    repo.write_file("base.txt", "b   \n");
    core.refresh(opened.session).await.unwrap();
    let ws = core
        .work_tree_diff_opts(
            opened.session,
            "base.txt",
            false,
            true,
            DiffOptions {
                ignore_whitespace: true,
                context: 1,
            },
        )
        .await
        .unwrap();
    assert!(ws.is_none() || ws.unwrap().hunks.is_empty());
}

#[tokio::test]
async fn advanced_search_maps_to_rows() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.write_file("src/needle.rs", "fn needle() {}\n");
    repo.stage(&["src/needle.rs"]);
    let hit = repo.commit_staged("add needle fn");
    repo.write_file("other.txt", "x");
    repo.stage(&["other.txt"]);
    repo.commit_staged("unrelated");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let row = core.find_row(opened.session, &hit).unwrap().unwrap();

    let by_path = core
        .search_advanced(
            opened.session,
            &AdvancedSearch {
                path: Some("src/".into()),
                ..AdvancedSearch::default()
            },
            100,
        )
        .await
        .unwrap();
    assert_eq!(by_path.rows, vec![row]);
    let by_pickaxe = core
        .search_advanced(
            opened.session,
            &AdvancedSearch {
                pickaxe: Some(Pickaxe {
                    pattern: "needle".into(),
                    regex: false,
                }),
                ..AdvancedSearch::default()
            },
            100,
        )
        .await
        .unwrap();
    assert_eq!(by_pickaxe.rows, vec![row]);
    let by_text_author = core
        .search_advanced(
            opened.session,
            &AdvancedSearch {
                text: Some("NEEDLE".into()),
                author: Some("test".into()),
                ..AdvancedSearch::default()
            },
            100,
        )
        .await
        .unwrap();
    assert_eq!(by_text_author.rows, vec![row]);
    let none = core
        .search_advanced(
            opened.session,
            &AdvancedSearch {
                until: Some("1990-01-01".into()),
                ..AdvancedSearch::default()
            },
            100,
        )
        .await
        .unwrap();
    assert!(none.rows.is_empty());
}

#[tokio::test]
async fn graph_query_filters_and_path_scope_reload() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main"]);
    repo.checkout_new("alone");
    repo.write_file("only/here.txt", "h");
    repo.stage(&["only/here.txt"]);
    let alone_tip = repo.commit_staged("alone commit");
    repo.checkout("main");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(core.find_row(opened.session, &alone_tip).unwrap().is_some());
    let total_before = core.graph_window(opened.session, 0, 1).unwrap().total_rows;

    // solo main: alone 브랜치 커밋이 사라진다
    core.set_graph_query(
        opened.session,
        GraphQuery {
            revs: GraphRevs::Solo {
                name: "main".into(),
            },
            hide_remotes: false,
            path_scope: vec![],
            ..GraphQuery::default()
        },
    )
    .await
    .unwrap();
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphReloaded { .. })
    })
    .await;
    assert!(core.find_row(opened.session, &alone_tip).unwrap().is_none());
    assert_eq!(
        core.graph_query(opened.session).unwrap().revs,
        GraphRevs::Solo {
            name: "main".into()
        }
    );

    // 경로 범위: only/ 를 건드린 커밋만 (alone 브랜치 포함)
    core.set_graph_query(
        opened.session,
        GraphQuery {
            revs: GraphRevs::All,
            hide_remotes: true,
            path_scope: vec!["only/".into()],
            ..GraphQuery::default()
        },
    )
    .await
    .unwrap();
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphReloaded { .. })
    })
    .await;
    let rows = events
        .iter()
        .find_map(|e| match e {
            CoreEvent::GraphReloaded { rows, .. } => Some(*rows),
            _ => None,
        })
        .unwrap();
    // `--full-history --parents` 는 경로를 건드린 커밋 + 머지 커밋(부모 재작성)만 남긴다
    let root = mgit_core::Oid::from_hex(
        repo.git_ok(["rev-list", "--max-parents=0", "main"])
            .trim()
            .as_bytes(),
    )
    .unwrap();
    assert!(
        rows < total_before,
        "범위 밖 커밋이 빠진다: {rows} < {total_before}"
    );
    assert_eq!(core.find_row(opened.session, &alone_tip).unwrap(), Some(0));
    assert!(
        core.find_row(opened.session, &root).unwrap().is_none(),
        "루트는 경로를 건드리지 않았다"
    );

    // 잘못된 질의는 거부
    assert!(
        core.set_graph_query(
            opened.session,
            GraphQuery {
                revs: GraphRevs::Branches { names: vec![] },
                hide_remotes: false,
                path_scope: vec![],
                ..GraphQuery::default()
            },
        )
        .await
        .is_err()
    );
}
