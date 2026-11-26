//! 폴더 일괄 stash 저장·꺼내기 (셋째 묶음 G). 묶음 표시로 항목을 찾고, 충돌이면 항목을 남기며, 워크트리끼리 섞지 않는다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};

use common::{collector, core};
use mgit_core::{BatchOp, BatchResult, CoreError, RepoResult};
use mgit_testkit::TestRepo;

/// 경로에 빈 저장소를 만든다 (`TestRepo::at` 은 init 하지 않는다)
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 테스트마다 비운 임시 루트 폴더
fn fresh_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mgit-stash-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// 결과에서 이름으로 저장소 한 줄
fn row<'a>(r: &'a BatchResult, name: &str) -> &'a RepoResult {
    r.results.iter().find(|x| x.name == name).unwrap()
}

/// 일괄 stash 저장 작업
fn push(batch: &str, message: Option<&str>, include_untracked: bool) -> BatchOp {
    BatchOp::StashPush {
        batch: batch.into(),
        message: message.map(Into::into),
        include_untracked,
    }
}

/// 일괄 stash 꺼내기 작업
fn pop(batch: &str) -> BatchOp {
    BatchOp::StashPop {
        batch: batch.into(),
    }
}

/// `git stash list` 의 제목들 (최근 것부터)
fn stash_subjects(repo: &mut TestRepo) -> Vec<String> {
    repo.git_ok(["stash", "list", "--format=%gs"])
        .lines()
        .map(str::to_string)
        .collect()
}

/// 저장하면 변경이 있던 저장소만 stash 되고(미추적 파일만 있으면 기본으로 건너뜀) 그 저장소는 checkout 대상이 된다.
/// 위에 다른 stash 가 쌓여도 묶음 표시로 그 항목만 꺼낸다
#[tokio::test]
async fn batch_stash_save_tags_entries_and_pop_finds_them_under_other_stashes() {
    let core = core().await;
    let root = fresh_root("save");
    // a: 추적 파일 수정, b: 미추적 파일만, c: 변경 없음, d: merge 충돌 중
    let mut a = init_at(&root.join("a"));
    a.commit("a first");
    a.branch("other");
    let mut b = init_at(&root.join("b"));
    b.commit("b first");
    b.branch("other");
    let mut c = init_at(&root.join("c"));
    c.commit("c first");
    let mut d = init_at(&root.join("d"));
    d.prepare_conflict();
    d.begin_merge_conflict();
    a.write_file("f1.txt", "a edited\n");
    b.write_file("new.txt", "b untracked\n");

    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    // 저장 전: a 는 커밋하지 않은 변경으로 checkout 을 건너뛰고(알림 안내용 표시가 붙는다), 미추적 파일만 있는 b 는
    // 건너뛰지 않는다 — 그래서 미추적 파일 포함의 기본값은 꺼짐이다
    let r = core
        .folder_batch(
            fid,
            BatchOp::Checkout {
                name: "other".into(),
            },
            &[root.join("a"), root.join("b")],
        )
        .await
        .unwrap();
    assert_eq!(
        row(&r, "a").skipped.as_deref(),
        Some("커밋하지 않은 변경이 있습니다")
    );
    assert!(row(&r, "a").skipped_dirty);
    assert!(row(&r, "b").ok && row(&r, "b").skipped.is_none(), "{r:?}");
    assert!(!row(&r, "b").skipped_dirty);
    b.checkout("main");

    let r = core
        .folder_batch(fid, push("t1", Some(" 작업\n정리 "), false), &[])
        .await
        .unwrap();
    assert_eq!(r.label, "스태시 일괄 저장: 작업 정리");
    assert!(row(&r, "a").ok && row(&r, "a").skipped.is_none(), "{r:?}");
    assert_eq!(
        row(&r, "b").skipped.as_deref(),
        Some("미추적 파일만 있습니다 (미추적 파일 포함을 켜면 저장합니다)")
    );
    assert_eq!(
        row(&r, "c").skipped.as_deref(),
        Some("스태시할 변경이 없습니다")
    );
    assert_eq!(
        row(&r, "d").skipped.as_deref(),
        Some("진행 중인 작업이 있습니다")
    );
    assert_eq!((r.succeeded, r.skipped, r.failed), (1, 3, 0));
    assert_eq!(
        stash_subjects(&mut a),
        ["On main: 작업 정리 [mgit-batch:t1]"]
    );
    assert!(stash_subjects(&mut b).is_empty());
    assert_eq!(a.read_file("f1.txt"), "a first");
    assert_eq!(b.read_file("new.txt"), "b untracked\n");

    // 저장 뒤 a 는 일괄 checkout 대상이 된다
    let r = core
        .folder_batch(
            fid,
            BatchOp::Checkout {
                name: "other".into(),
            },
            &[root.join("a")],
        )
        .await
        .unwrap();
    assert!(row(&r, "a").ok && row(&r, "a").skipped.is_none(), "{r:?}");
    a.checkout("main");

    // 손으로 만든 stash 가 위에 쌓여 묶음 항목이 stash@{1} 로 밀린다
    a.write_file("f1.txt", "manual\n");
    a.stash_push("손으로", false);
    let batches = core.folder_stash_batches(fid, &[]).await.unwrap();
    assert_eq!(batches.len(), 1, "{batches:?}");
    assert_eq!(batches[0].id, "t1");
    assert_eq!(batches[0].message, "작업 정리");
    assert_eq!(batches[0].repos.len(), 1);
    assert_eq!(batches[0].repos[0].name, "a");
    assert_eq!(batches[0].repos[0].index, 1);
    assert_eq!(batches[0].repos[0].branch.as_deref(), Some("main"));
    // 저장소를 좁혀 읽을 수 있고, 목록에 없는 경로는 거부한다
    assert!(
        core.folder_stash_batches(fid, &[root.join("b")])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        core.folder_stash_batches(fid, &[root.join("nope")])
            .await
            .is_err()
    );

    // 대상에 그 묶음의 항목이 없으면 이름은 묶음 id 다 (b 는 stash 가 없어 건너뛴다)
    let r = core
        .folder_batch(fid, pop("t1"), &[root.join("b")])
        .await
        .unwrap();
    assert_eq!(r.label, "스태시 일괄 꺼내기 (t1)");
    assert_eq!(
        row(&r, "b").skipped.as_deref(),
        Some("이 묶음의 스태시가 없습니다")
    );

    // 이름은 저장할 때의 메시지다 (다른 stash 가 위에 쌓여도 묶음 표시로 찾는다)
    let r = core.folder_batch(fid, pop("t1"), &[]).await.unwrap();
    assert_eq!(r.label, "스태시 일괄 꺼내기: 작업 정리");
    assert!(row(&r, "a").ok && row(&r, "a").skipped.is_none(), "{r:?}");
    assert_eq!(row(&r, "a").message, "On main: 작업 정리 [mgit-batch:t1]");
    assert_eq!(a.read_file("f1.txt"), "a edited\n");
    // 손으로 만든 것만 남는다
    assert_eq!(stash_subjects(&mut a), ["On main: 손으로"]);
    assert_eq!(
        row(&r, "b").skipped.as_deref(),
        Some("이 묶음의 스태시가 없습니다")
    );
    assert_eq!(
        row(&r, "c").skipped.as_deref(),
        Some("이 묶음의 스태시가 없습니다")
    );
    assert_eq!(
        row(&r, "d").skipped.as_deref(),
        Some("진행 중인 작업이 있습니다")
    );
    assert!(
        core.folder_stash_batches(fid, &[])
            .await
            .unwrap()
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 꺼낼 때 충돌하면 그 저장소는 실패이고 stash 항목은 남는다 (git 의 pop 과 같다). 다른 저장소는 그대로 꺼낸다
#[tokio::test]
async fn batch_stash_pop_conflict_keeps_entry() {
    let core = core().await;
    let root = fresh_root("conflict");
    let mut e = init_at(&root.join("e"));
    e.commit("base");
    let mut f = init_at(&root.join("f"));
    f.commit("f base");
    e.write_file("f1.txt", "stashed\n");
    f.write_file("f1.txt", "f stashed\n");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core
        .folder_batch(fid, push("t2", None, false), &[])
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    assert_eq!(r.label, "스태시 일괄 저장");
    assert_eq!(stash_subjects(&mut e), ["On main: [mgit-batch:t2]"]);
    // e 는 같은 줄을 다르게 commit 해 둔다
    e.write_file("f1.txt", "committed\n");
    e.stage(&["f1.txt"]);
    e.commit_staged("conflicting");

    let r = core.folder_batch(fid, pop("t2"), &[]).await.unwrap();
    // 메시지 없이 저장한 묶음은 묶음 id 로 이름을 짓는다
    assert_eq!(r.label, "스태시 일괄 꺼내기 (t2)");
    let re = row(&r, "e");
    assert!(!re.ok && re.skipped.is_none(), "{re:?}");
    assert!(re.message.starts_with("충돌이 났습니다: f1.txt."), "{re:?}");
    assert!(re.message.contains("남겼습니다"), "{re:?}");
    assert!(row(&r, "f").ok, "{r:?}");
    assert_eq!((r.succeeded, r.skipped, r.failed), (1, 0, 1));
    // 항목은 남고, 충돌 파일이 남아 있다
    assert_eq!(stash_subjects(&mut e), ["On main: [mgit-batch:t2]"]);
    assert!(!e.git_ok(["ls-files", "-u"]).trim().is_empty());
    assert_eq!(f.read_file("f1.txt"), "f stashed\n");
    assert!(stash_subjects(&mut f).is_empty());
    // 충돌이 남은 저장소는 다시 꺼내지 않고 건너뛴다
    let r = core.folder_batch(fid, pop("t2"), &[]).await.unwrap();
    assert_eq!(
        row(&r, "e").skipped.as_deref(),
        Some("진행 중인 작업이 있습니다")
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 미추적 파일 포함을 켜면 미추적 파일만 있는 저장소도 저장하고, 꺼내면 돌아온다
#[tokio::test]
async fn batch_stash_with_untracked_files() {
    let core = core().await;
    let root = fresh_root("untracked");
    let mut b = init_at(&root.join("b"));
    b.commit("b first");
    b.write_file("new.txt", "untracked\n");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core
        .folder_batch(fid, push("t3", Some("새 파일"), true), &[])
        .await
        .unwrap();
    assert!(row(&r, "b").ok && row(&r, "b").skipped.is_none(), "{r:?}");
    assert!(!root.join("b/new.txt").exists());
    let r = core.folder_batch(fid, pop("t3"), &[]).await.unwrap();
    assert!(row(&r, "b").ok, "{r:?}");
    assert_eq!(b.read_file("new.txt"), "untracked\n");
    assert!(stash_subjects(&mut b).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

/// 연결된 워크트리는 stash 목록을 함께 쓴다. 같은 묶음에서 만든 다른 작업 트리의 항목을 꺼내지 않는다
#[tokio::test]
async fn batch_stash_keeps_worktrees_apart() {
    let core = core().await;
    let root = fresh_root("worktree");
    let mut m = init_at(&root.join("m"));
    m.commit("m base");
    let wt_path = root.join("w");
    m.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt-branch",
        wt_path.to_str().unwrap(),
    ]);
    let mut w = TestRepo::at(&wt_path);
    m.write_file("f1.txt", "from main tree\n");
    w.write_file("f1.txt", "from worktree\n");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core
        .folder_batch(fid, push("t4", Some("둘 다"), false), &[])
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    let mut subjects = stash_subjects(&mut m);
    subjects.sort();
    assert_eq!(
        subjects,
        [
            "On main: 둘 다 [mgit-batch:t4]",
            "On wt-branch: 둘 다 [mgit-batch:t4@w]",
        ]
    );
    let batches = core.folder_stash_batches(fid, &[]).await.unwrap();
    assert_eq!(batches.len(), 1);
    let names: Vec<&str> = batches[0].repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["m", "w"]);

    // 워크트리만 꺼내면 워크트리의 것만 돌아오고, 주 작업 트리의 항목은 남는다
    let r = core
        .folder_batch(fid, pop("t4"), std::slice::from_ref(&wt_path))
        .await
        .unwrap();
    assert!(row(&r, "w").ok, "{r:?}");
    assert_eq!(w.read_file("f1.txt"), "from worktree\n");
    assert_eq!(m.read_file("f1.txt"), "m base");
    assert_eq!(stash_subjects(&mut m), ["On main: 둘 다 [mgit-batch:t4]"]);
    let r = core
        .folder_batch(fid, pop("t4"), &[root.join("m")])
        .await
        .unwrap();
    assert!(row(&r, "m").ok, "{r:?}");
    assert_eq!(m.read_file("f1.txt"), "from main tree\n");
    let _ = std::fs::remove_dir_all(&root);
}

/// 대시보드 요약의 stash 수 (셋째 묶음 K). 요약이 이미 돌리는 `status --show-stash` 의 머리에서 읽어 git 명령이 늘지
/// 않는다. 0·여러 개, 워크트리는 주 저장소와 같은 수(목록을 함께 쓴다), `core.logAllRefUpdates=false` 여도 stash 는
/// reflog 를 남겨 센다. reflog 를 지우거나 만료하면 `git stash list` 와 같이 줄어든다
#[tokio::test]
async fn summary_counts_stashes_from_status_header() {
    let core = core().await;
    let root = fresh_root("count");
    let mut a = init_at(&root.join("a"));
    a.commit("a");
    a.write_file("f1.txt", "one\n");
    a.stash_push("하나", false);
    a.write_file("f1.txt", "two\n");
    a.stash_push("둘", false);
    let mut c = init_at(&root.join("c"));
    c.commit("c");
    // 주 작업 트리 m 과 연결된 워크트리 w: w 에서 만든 stash 하나를 함께 본다
    let mut m = init_at(&root.join("m"));
    m.commit("m");
    let wt_path = root.join("w");
    m.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt-branch",
        wt_path.to_str().unwrap(),
    ]);
    let mut w = TestRepo::at(&wt_path);
    w.write_file("f1.txt", "from worktree\n");
    w.stash_push("워크트리", false);
    // ref 의 reflog 를 끈 저장소에서도 stash 는 reflog 에 남는다
    let mut r = init_at(&root.join("r"));
    r.commit("r");
    r.git_ok(["config", "core.logAllRefUpdates", "false"]);
    r.write_file("f1.txt", "r\n");
    r.stash_push("reflog 끔", false);
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let before = core.command_log_recent(usize::MAX).len();
    let list = core.folder_summaries(fid, &[]).await.unwrap();
    let count = |list: &[mgit_core::RepoSummary], name: &str| {
        list.iter().find(|s| s.name == name).unwrap().stash_count
    };
    assert_eq!(
        ["a", "c", "m", "w", "r"].map(|name| count(&list, name)),
        [2, 0, 1, 1, 1]
    );
    // 요약은 stash 를 따로 읽지 않는다 (저장소마다 돈 git 명령에 stash 가 없다)
    let log = core.command_log_recent(usize::MAX);
    let ran = &log[before..];
    assert!(
        ran.iter().all(|rec| !rec.args.iter().any(|x| x == "stash")),
        "{ran:?}"
    );
    assert!(
        ran.iter()
            .any(|rec| rec.args.iter().any(|x| x == "--show-stash"))
    );

    // reflog 파일이 없으면 `git stash list` 도 비고 수도 0, 만료하면 남은 항목만 센다
    std::fs::remove_file(root.join("a/.git/logs/refs/stash")).unwrap();
    r.git_ok(["reflog", "expire", "--expire=now", "refs/stash"]);
    let list = core.folder_summaries(fid, &[]).await.unwrap();
    for (name, repo) in [("a", &mut a), ("r", &mut r), ("m", &mut m)] {
        let listed = stash_subjects(repo).len() as u32;
        assert_eq!(count(&list, name), listed, "{name}");
    }
    assert_eq!(count(&list, "a"), 0);
    assert_eq!(count(&list, "r"), 0);
    let _ = std::fs::remove_dir_all(&root);
}

/// reftable 저장소에는 `logs/refs/stash` 파일이 없지만 요약의 stash 수는 같게 나온다 (파일을 세지 않는 이유)
#[tokio::test]
async fn summary_counts_stashes_in_reftable_repo() {
    let core = core().await;
    let root = fresh_root("reftable");
    let path = root.join("t");
    std::fs::create_dir_all(&path).unwrap();
    let mut t = TestRepo::at(&path);
    t.git_ok(["init", "-q", "-b", "main", "--ref-format=reftable"]);
    t.commit("t");
    t.write_file("f1.txt", "edited\n");
    t.stash_push("reftable", false);
    assert!(!path.join(".git/logs/refs/stash").exists());
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    let list = core.folder_summaries(fid, &[]).await.unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].error.is_none(), "{list:?}");
    assert_eq!(list[0].stash_count, 1);
    let _ = std::fs::remove_dir_all(&root);
}

/// 묶음 id 는 메시지에서 다시 읽을 수 있는 글자만 받는다
#[tokio::test]
async fn batch_stash_rejects_bad_batch_id() {
    let core = core().await;
    let root = fresh_root("badid");
    let mut a = init_at(&root.join("a"));
    a.commit("a");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    for op in [push("a b", None, false), pop("x]y"), pop("")] {
        assert!(matches!(
            core.folder_batch(fid, op, &[]).await,
            Err(CoreError::Invalid(_))
        ));
    }
    let _ = std::fs::remove_dir_all(&root);
}
