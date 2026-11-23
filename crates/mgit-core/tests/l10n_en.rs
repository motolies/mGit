//! 화면 문구 영어 (다국어 L4): 프로세스 전역 언어를 영어로 두면 코어가 만드는 문구(일괄 작업 라벨·건너뜀
//! 사유·요약, 오류, 충돌 편집기 열 제목, stash 메시지)가 영어다.
//!
//! 통합 테스트는 파일마다 별도 프로세스라 전역 언어를 바꿔도 다른 테스트와 겹치지 않는다. 이 파일의 테스트는
//! 모두 영어로만 두고 한국어로 되돌리지 않는다 (같은 바이너리의 테스트가 병렬로 돌아도 언어가 같다)
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{BatchOp, CheckoutTarget, CoreError, CoreEvent, GitError, gitignore_templates};
use mgit_l10n::Lang;
use mgit_testkit::{Scenario, TestRepo, build};

/// 이 바이너리의 전역 언어를 영어로 둔다. 테스트마다 맨 앞에서 부른다 (여러 번 불러도 같다)
fn english() {
    mgit_l10n::set(Lang::En);
}

/// 경로에 빈 저장소를 만든다 (`TestRepo::at` 은 init 하지 않는다)
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 임시 루트 폴더 아래에 저장소 두 개: a 는 bare 원격 + 업스트림, b 는 원격 없음
fn two_repos(tag: &str) -> (PathBuf, TestRepo, TestRepo) {
    let root = std::env::temp_dir().join(format!("mgit-l10n-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut a = init_at(&root.join("a"));
    a.commit("a first");
    a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    let mut b = init_at(&root.join("b"));
    b.commit("b first");
    (root, a, b)
}

/// 일괄 fetch 의 라벨·완료 요약과 일괄 pull 의 건너뜀 사유(업스트림 없음)가 영어다
#[tokio::test]
async fn batch_label_summary_and_skip_reason_are_english() {
    english();
    let core = core().await;
    let (root, mut a, _b) = two_repos("batch");
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core
        .folder_batch(fid, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(r.label, "Batch fetch");
    assert!(r.results.iter().all(|x| x.ok), "{r:?}");
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::OperationFinished { .. })
    })
    .await;
    let summary = events.iter().find_map(|e| match e {
        CoreEvent::OperationFinished { message, .. } => Some(message.clone()),
        _ => None,
    });
    assert_eq!(
        summary.as_deref(),
        Some("2 succeeded · 0 skipped · 0 failed")
    );

    let r = core.folder_batch(fid, BatchOp::Pull, &[]).await.unwrap();
    assert_eq!(r.label, "Batch pull");
    let rb = r.results.iter().find(|x| x.name == "b").unwrap();
    assert_eq!(rb.skipped.as_deref(), Some("No upstream"));

    // branch 업데이트 (BR-09): 라벨과 건너뜀 사유
    let r = core
        .folder_batch(fid, BatchOp::UpdateBranch { name: "dev".into() }, &[])
        .await
        .unwrap();
    assert_eq!(r.label, "Batch update: dev");
    assert!(
        r.results
            .iter()
            .all(|x| x.skipped.as_deref() == Some("No such branch")),
        "{r:?}"
    );

    // 일괄 이름 바꾸기: 라벨과 건너뜀 사유 (branch 없음 · 새 이름이 이미 있음)
    let r = core
        .folder_batch(
            fid,
            BatchOp::RenameBranch {
                from: "dev".into(),
                to: "main".into(),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(r.label, "Batch rename: dev → main");
    assert!(
        r.results
            .iter()
            .all(|x| x.skipped.as_deref() == Some("No such branch")),
        "{r:?}"
    );
    a.git_ok(["branch", "dev"]);
    let r = core
        .folder_batch(
            fid,
            BatchOp::RenameBranch {
                from: "dev".into(),
                to: "main".into(),
            },
            &[root.join("a")],
        )
        .await
        .unwrap();
    assert_eq!(
        r.results[0].skipped.as_deref(),
        Some("New name already exists: main"),
        "{r:?}"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// 입력 검증 오류(`CoreError::Invalid`)와 다른 크레이트가 만든 오류(`GitError`)의 문구가 영어다
#[tokio::test]
async fn errors_are_english() {
    english();
    let core = core().await;
    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let err = core
        .checkout(opened.session, CheckoutTarget::Branch("-x".into()), false)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert_eq!(err.to_string(), "Invalid name: \"-x\"");

    let dir = tempfile::tempdir().unwrap();
    let (sink, _rx) = collector();
    let err = core.open_repo(dir.path(), sink).await.unwrap_err();
    assert!(
        matches!(err, CoreError::Git(GitError::NotARepository(_))),
        "{err:?}"
    );
    assert!(
        err.to_string().starts_with("Not a git repository: "),
        "{err}"
    );
    assert_eq!(CoreError::Cancelled.to_string(), "Canceled");
}

/// rebase 충돌의 편집기 열 제목(SideLabels)이 영어다
#[tokio::test]
async fn rebase_side_labels_are_english() {
    english();
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_rebase_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let labels = core.side_labels(opened.session).await.unwrap();
    assert!(
        labels.ours.ends_with(" (rebase target, current result)"),
        "{labels:?}"
    );
    assert!(
        labels.theirs.starts_with("other (my commit being applied"),
        "{labels:?}"
    );
}

/// 변경을 치우고 브랜치를 바꿀 때 만드는 stash 메시지가 영어다 (git 에 넘긴 인자를 명령 로그로 본다)
#[tokio::test]
async fn checkout_stash_message_is_english() {
    english();
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.git_ok(["branch", "other"]);
    repo.write_file("dirty.txt", "not committed\n");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.checkout(opened.session, CheckoutTarget::Branch("other".into()), true)
        .await
        .unwrap();
    // 러너가 앞에 붙이는 전역 인자(`-c …`)와 무관하게 `stash push` 명령을 찾는다
    let stash = core
        .command_log_recent(usize::MAX)
        .into_iter()
        .find(|rec| rec.args.iter().any(|a| a == "stash") && rec.args.iter().any(|a| a == "push"))
        .expect("stash push 명령이 로그에 있어야 한다");
    assert_eq!(
        stash.args.last().map(String::as_str),
        Some("mGit: switch branch"),
        "{:?}",
        stash.args
    );
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "other"
    );
}

/// 화면에 그대로 쓰이는 데이터(.gitignore 템플릿 표시 이름)가 영어다
#[test]
fn gitignore_template_label_is_english() {
    english();
    let empty = gitignore_templates()
        .into_iter()
        .find(|t| t.id == "empty")
        .unwrap();
    assert_eq!(empty.label, "Empty file");
}

/// tag push 의 검사 오류와 op 끝 요약이 영어다 (등록되지 않은 원격, 잘못된 tag 이름, 일부 거부)
#[tokio::test]
async fn tag_push_errors_and_summary_are_english() {
    english();
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main"]);
    repo.tag("v1", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1"]);
    repo.commit("moved");
    repo.git_ok(["tag", "-f", "v1"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let session = opened.session;

    let err = core
        .push_tags(session, "nope", &["v1".into()], None)
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "No such remote: nope");
    let err = core
        .push_tags(session, "origin", &["v*".into()], None)
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "Invalid tag name: \"v*\"");

    let err = core
        .delete_local_tags(session, &["nope".into()])
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "No such tag: nope");

    // 확인한 뒤 원격이 또 바뀐 원격 삭제 (expected_remote 불일치)
    let head = repo.head();
    let stale = core
        .delete_remote_tags(
            session,
            "origin",
            &[mgit_core::TagDeleteItem {
                name: "v1".into(),
                expected_remote: Some(head),
            }],
            None,
        )
        .await
        .unwrap();
    assert_eq!(stale[0].status, mgit_core::TagRefStatus::RejectedStale);
    assert_eq!(
        stale[0].message.as_deref(),
        Some("The remote tag changed after it was checked. Check again")
    );

    let op = core.begin_operation(session, "push", "push tags").unwrap();
    let op_id = op.id;
    let results = core
        .push_tags(session, "origin", &["v1".into()], Some(op))
        .await
        .unwrap();
    assert_eq!(results[0].status, mgit_core::TagRefStatus::RejectedExists);
    let events = wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, .. } if *id == op_id),
    )
    .await;
    let message = events
        .iter()
        .find_map(|e| match e {
            CoreEvent::OperationFinished {
                op_id: id, message, ..
            } if *id == op_id => Some(message.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(message, "Tags not processed: 1 of 1");
}
