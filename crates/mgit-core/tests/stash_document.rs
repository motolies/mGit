//! 스태시 원문은 추적 변경과 세 번째 부모의 미추적 파일을 구분한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, wait_finished};
use mgit_core::{DiffOptions, Oid};
use mgit_testkit::{Scenario, build};

/// 이름 변경·미추적 원문을 읽어도 디스크와 인덱스는 그대로이며 스태시 번호 이동에 영향받지 않는다.
#[tokio::test]
async fn stash_documents_keep_oid_and_read_untracked_parent() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("old.txt", "original\n");
    repo.commit("base");
    repo.git_ok(["mv", "old.txt", "renamed.txt"]);
    repo.write_file("new[1].txt", "미추적 원문\n");
    repo.write_file("f1.txt", "tracked edited\n");
    repo.git_ok(["stash", "push", "-u", "-m", "first"]);
    let first = Oid::from_hex(repo.git_ok(["rev-parse", "stash@{0}"]).trim().as_bytes()).unwrap();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let status = repo.git_bytes(["status", "--porcelain=v1", "-z"]);
    let index = repo.git_bytes(["ls-files", "--stage", "-z"]);
    let untracked = core
        .stash_file_diff_document(
            opened.session,
            &first,
            "new[1].txt",
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(untracked.old.content.as_deref(), Some(""));
    assert_eq!(untracked.new.content.as_deref(), Some("미추적 원문\n"));
    assert!(untracked.old.path.is_none());
    assert!(!untracked.diff.hunks.is_empty());
    let tracked = core
        .stash_file_diff_document(
            opened.session,
            &first,
            "f1.txt",
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(tracked.new.content.as_deref(), Some("tracked edited\n"));
    assert_ne!(tracked.old.content, tracked.new.content);
    let rename = core
        .stash_file_diff_document(
            opened.session,
            &first,
            "renamed.txt",
            true,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(rename.old.path.as_deref(), Some("old.txt"));
    assert_eq!(rename.old.content.as_deref(), Some("original\n"));
    assert_eq!(rename.new.content.as_deref(), Some("original\n"));
    assert_eq!(repo.git_bytes(["status", "--porcelain=v1", "-z"]), status);
    assert_eq!(repo.git_bytes(["ls-files", "--stage", "-z"]), index);
    assert!(!repo.path().join("new[1].txt").exists());
    repo.write_file("old.txt", "second stash\n");
    repo.git_ok(["stash", "push", "-m", "second"]);
    let again = core
        .stash_file_diff_document(
            opened.session,
            &first,
            "new[1].txt",
            true,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(again.new.content, untracked.new.content);
    assert!(
        core.stash_file_diff_document(
            opened.session,
            &first,
            "absent.txt",
            false,
            DiffOptions::default()
        )
        .await
        .is_err()
    );
}

/// 일반 커밋을 스태시로 오인하거나 존재하지 않는 OID를 빈 결과로 취급하지 않는다.
#[tokio::test]
async fn stash_document_rejects_non_stash_and_missing_object() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let head = Oid::from_hex(repo.git_ok(["rev-parse", "HEAD"]).trim().as_bytes()).unwrap();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(
        core.stash_file_diff_document(
            opened.session,
            &head,
            "f1.txt",
            false,
            DiffOptions::default()
        )
        .await
        .is_err()
    );
    let missing = Oid::from_hex("1".repeat(40).as_bytes()).unwrap();
    assert!(
        core.stash_file_diff_document(
            opened.session,
            &missing,
            "f1.txt",
            false,
            DiffOptions::default()
        )
        .await
        .is_err()
    );
}
