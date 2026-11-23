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
    let (root, _a, _b) = two_repos("batch");
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
