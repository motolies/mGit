//! 커밋 상세·검색 (GRAPH-04·06)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{DiffChange, SearchFields};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn commit_detail_has_meta_refs_files_parents_children() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let d = core.commit_detail(opened.session, &head).await.unwrap();
    assert_eq!(d.oid, head);
    assert_eq!(d.parents.len(), 2);
    assert!(d.children.is_empty());
    assert_eq!(d.row, Some(0));
    assert_eq!(d.author_name, "mGit Test");
    assert_eq!(d.committer_email, "test@mgit.invalid");
    assert_eq!(d.message, "merge feature");
    let names: Vec<&str> = d.refs.iter().map(|l| l.short_name.as_str()).collect();
    assert_eq!(names, vec!["main", "v1.0"]);
    // 머지 커밋은 첫 부모 기준: feature 쪽 파일이 추가로 보인다
    assert!(
        d.files.iter().any(|f| f.change == DiffChange::Added),
        "{:?}",
        d.files
    );

    // 부모의 자식에는 머지 커밋이 들어 있다
    let first_parent = d.parents[0];
    let p = core
        .commit_detail(opened.session, &first_parent)
        .await
        .unwrap();
    assert_eq!(p.children, vec![head]);
    assert_eq!(p.message, "c2 main");

    // 루트 커밋: 부모 없음, 파일은 전부 추가
    let w = core.graph_window(opened.session, 0, 10).unwrap();
    let root = w.rows.iter().find(|r| r.parents.is_empty()).unwrap();
    let r = core.commit_detail(opened.session, &root.oid).await.unwrap();
    assert!(r.parents.is_empty());
    assert!(r.files.iter().all(|f| f.change == DiffChange::Added));
    assert_eq!(
        r.children.len(),
        2,
        "c1 base 의 자식은 c2 main 과 c3 feature"
    );
}

#[tokio::test]
async fn search_matches_subject_author_and_hash_prefix() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(5));
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let r = core
        .search_commits(opened.session, "COMMIT 3", SearchFields::default(), 10)
        .unwrap();
    assert_eq!(r.rows, vec![2]);
    assert_eq!(r.total, 1);

    let r = core
        .search_commits(opened.session, "mgit test", SearchFields::default(), 2)
        .unwrap();
    assert_eq!(r.total, 5);
    assert_eq!(r.rows.len(), 2);
    assert!(r.truncated);

    let prefix = &head.to_hex()[..7];
    let r = core
        .search_commits(opened.session, prefix, SearchFields::default(), 10)
        .unwrap();
    assert_eq!(r.rows, vec![0]);

    let r = core
        .search_commits(
            opened.session,
            "commit",
            SearchFields {
                subject: false,
                author: false,
                hash: true,
            },
            10,
        )
        .unwrap();
    assert_eq!(r.total, 0);
    assert!(
        core.search_commits(opened.session, "  ", SearchFields::default(), 10)
            .unwrap()
            .rows
            .is_empty()
    );
}
