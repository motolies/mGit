//! branch 업데이트 (BR-09): checkout 하지 않은 로컬 branch 를 업스트림으로 fast-forward — 로컬 bare 원격으로 왕복한다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::PathBuf;

use common::{collector, core, wait_finished};
use mgit_core::{BatchOp, BranchUpdate, Core, CoreError, SessionId};
use mgit_testkit::{Scenario, TestRepo, build};

/// 원격 bare 저장소와 두 clone: a 는 `main`(checkout)·`dev`(checkout 안 함) 둘 다 업스트림을 갖고,
/// b 는 같은 원격의 `dev` 를 checkout 한 두 번째 clone 이다 (원격을 앞서게 만들 때 쓴다)
fn two_clones() -> (TestRepo, PathBuf, TestRepo) {
    let mut a = build(Scenario::Linear(2));
    let remote = a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    a.branch("dev");
    a.git_ok(["push", "-q", "-u", "origin", "dev"]);
    let mut b = TestRepo::init();
    let remote_str = remote.to_string_lossy().into_owned();
    b.git_ok(["remote", "add", "origin", &remote_str]);
    b.git_ok(["fetch", "-q", "origin"]);
    b.git_ok(["checkout", "-q", "-b", "dev", "--track", "origin/dev"]);
    (a, remote, b)
}

/// b 에서 `branch` 에 commit `n` 개를 만들어 원격에 올린다. 마지막 commit 을 돌려준다
fn push_commits(b: &mut TestRepo, branch: &str, n: usize) -> String {
    b.checkout(branch);
    for i in 0..n {
        b.write_file(&format!("{branch}-remote-{i}.txt"), "remote");
        b.stage(&[&format!("{branch}-remote-{i}.txt")]);
        b.commit_staged(&format!("remote {branch} {i}"));
    }
    b.git_ok(["push", "-q", "origin", branch]);
    b.git_ok(["rev-parse", "HEAD"]).trim().to_string()
}

/// 저장소를 탭으로 연다
async fn open(core: &Core, repo: &TestRepo) -> SessionId {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    opened.session
}

/// ref 가 가리키는 commit
fn rev(repo: &mut TestRepo, name: &str) -> String {
    repo.git_ok(["rev-parse", name]).trim().to_string()
}

/// checkout 안 한 behind branch 는 업스트림으로 fast-forward 되고(업스트림 설정은 그대로), Undo 로 돌아온다.
/// 다시 하면 이미 최신이다
#[tokio::test]
async fn behind_branch_fast_forwards_and_undo_restores() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    let old = rev(&mut a, "dev");
    let tip = push_commits(&mut b, "dev", 2);
    let id = open(&core, &a).await;

    let res = core.update_branch(id, "dev", None).await.unwrap();
    assert_eq!(
        res,
        BranchUpdate::Updated {
            from: old.clone(),
            to: tip.clone(),
            commits: 2
        }
    );
    assert_eq!(rev(&mut a, "dev"), tip);
    assert_eq!(
        a.git_ok(["rev-parse", "--abbrev-ref", "dev@{u}"]).trim(),
        "origin/dev"
    );
    // 현재 branch 와 작업 트리는 그대로다
    assert_eq!(
        a.git_ok(["branch", "--show-current"]).trim(),
        "main",
        "checkout 은 바뀌지 않는다"
    );
    assert!(!a.path().join("dev-remote-0.txt").exists());

    let (entries, _) = core.undo_entries(id).unwrap();
    assert_eq!(entries[0].label, "update dev");
    core.undo(id).await.unwrap().unwrap();
    assert_eq!(rev(&mut a, "dev"), old, "Undo 로 돌아온다");

    core.redo(id).await.unwrap().unwrap();
    assert_eq!(rev(&mut a, "dev"), tip);
    let res = core.update_branch(id, "dev", None).await.unwrap();
    assert_eq!(res, BranchUpdate::UpToDate);
}

/// 갈라진 branch 는 그대로이고 `Diverged`, 로컬이 앞선 branch 는 `Ahead`, 같으면 `UpToDate`
#[tokio::test]
async fn diverged_ahead_and_up_to_date_do_not_move() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    let id = open(&core, &a).await;

    assert_eq!(
        core.update_branch(id, "dev", None).await.unwrap(),
        BranchUpdate::UpToDate
    );

    // 로컬에만 commit 하나 → 앞섬
    a.checkout("dev");
    a.write_file("local.txt", "local");
    a.stage(&["local.txt"]);
    let local = a.commit_staged("local dev");
    a.checkout("main");
    core.refresh(id).await.unwrap();
    assert_eq!(
        core.update_branch(id, "dev", None).await.unwrap(),
        BranchUpdate::Ahead { commits: 1 }
    );
    assert_eq!(rev(&mut a, "dev"), local.to_hex());

    // 원격에도 commit 둘 → 갈라짐, 로컬 branch 는 그대로
    push_commits(&mut b, "dev", 2);
    assert_eq!(
        core.update_branch(id, "dev", None).await.unwrap(),
        BranchUpdate::Diverged {
            ahead: 1,
            behind: 2
        }
    );
    assert_eq!(rev(&mut a, "dev"), local.to_hex());
    // 비교를 위해 받은 원격 추적 ref 는 원격과 같다
    assert_eq!(rev(&mut a, "origin/dev"), rev(&mut b, "dev"));
}

/// 다른 워크트리에서 checkout 된 branch 는 건너뛰고 그 워크트리의 HEAD·파일은 그대로다
#[tokio::test]
async fn branch_checked_out_in_other_worktree_is_left_alone() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    let old = rev(&mut a, "dev");
    let wt_path = a.path().parent().unwrap().join("dev-wt");
    let wt_str = wt_path.to_string_lossy().into_owned();
    a.git_ok(["worktree", "add", "-q", &wt_str, "dev"]);
    std::fs::write(wt_path.join("wip.txt"), "작업 중").unwrap();
    push_commits(&mut b, "dev", 1);
    let id = open(&core, &a).await;

    let err = core.update_branch(id, "dev", None).await.unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(err.to_string().contains("dev-wt"), "{err}");
    assert_eq!(rev(&mut a, "dev"), old);
    let mut wt = TestRepo::at(&wt_path);
    assert_eq!(rev(&mut wt, "HEAD"), old, "워크트리 HEAD 그대로");
    assert_eq!(
        std::fs::read_to_string(wt_path.join("wip.txt")).unwrap(),
        "작업 중"
    );
    assert!(!wt_path.join("dev-remote-0.txt").exists());
}

/// 이 작업 트리에서 checkout 중인 branch 는 `merge --ff-only` 로 작업 트리까지 갱신한다.
/// branch·업스트림이 없으면 `Invalid`
#[tokio::test]
async fn current_branch_fast_forwards_work_tree() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    a.checkout("dev");
    let tip = push_commits(&mut b, "dev", 1);
    let id = open(&core, &a).await;

    let res = core.update_branch(id, "dev", None).await.unwrap();
    assert!(
        matches!(&res, BranchUpdate::Updated { to, commits: 1, .. } if *to == tip),
        "{res:?}"
    );
    assert_eq!(rev(&mut a, "HEAD"), tip);
    assert!(
        a.path().join("dev-remote-0.txt").exists(),
        "작업 트리도 갱신"
    );

    let err = core.update_branch(id, "nope", None).await.unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    a.branch("solo");
    core.refresh(id).await.unwrap();
    let err = core.update_branch(id, "solo", None).await.unwrap_err();
    assert_eq!(err.to_string(), "업스트림이 없습니다");
    assert!(matches!(
        core.update_branch(id, "-x", None).await,
        Err(CoreError::Invalid(_))
    ));
}

/// 임시 루트 아래 저장소 넷: up(dev 가 뒤처짐), same(dev 가 최신), cur(dev 를 checkout 중이고 뒤처짐),
/// none(dev 없음). 원격은 저장소마다 따로다. (루트, [up, same, cur, none], [up, cur] 원격 clone)
fn folder_of_four(tag: &str) -> (PathBuf, Vec<TestRepo>, Vec<TestRepo>) {
    let root = std::env::temp_dir().join(format!("mgit-bu-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut repos = Vec::new();
    let mut clones = Vec::new();
    for name in ["up", "same", "cur", "none"] {
        let path = root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        let mut r = TestRepo::at(&path);
        r.git_ok(["init", "-q", "-b", "main"]);
        r.commit(&format!("{name} first"));
        let remote = r.add_bare_remote();
        r.git_ok(["push", "-q", "-u", "origin", "main"]);
        if name != "none" {
            r.branch("dev");
            r.git_ok(["push", "-q", "-u", "origin", "dev"]);
        }
        if name == "cur" {
            r.checkout("dev");
        }
        if name == "up" || name == "cur" {
            let mut c = TestRepo::init();
            let remote_str = remote.to_string_lossy().into_owned();
            c.git_ok(["remote", "add", "origin", &remote_str]);
            c.git_ok(["fetch", "-q", "origin"]);
            c.git_ok(["checkout", "-q", "-b", "dev", "--track", "origin/dev"]);
            clones.push(c);
        }
        repos.push(r);
    }
    (root, repos, clones)
}

/// 일괄 UpdateBranch 는 저장소별로 결과를 낸다: 갱신(`moved.commits`), 이미 최신(0), 더티인 현재 branch·branch
/// 없음은 건너뜀. 깨끗해지면 현재 branch 도 작업 트리까지 갱신한다
#[tokio::test]
async fn batch_update_branch_reports_per_repo() {
    let core = core().await;
    let (root, mut repos, mut clones) = folder_of_four("batch");
    let up_tip = push_commits(&mut clones[0], "dev", 3);
    let cur_tip = push_commits(&mut clones[1], "dev", 1);
    // cur 는 현재 branch 가 dev 이고 커밋하지 않은 변경이 있다
    repos[2].write_file("f1.txt", "dirty");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let op = BatchOp::UpdateBranch { name: "dev".into() };
    assert_eq!(op.label(), "일괄 업데이트: dev");
    let r = core.folder_batch(fid, op.clone(), &[]).await.unwrap();
    let by = |n: &str| r.results.iter().find(|x| x.name == n).unwrap().clone();
    let up = by("up");
    assert!(up.ok && up.skipped.is_none(), "{up:?}");
    let moved = up.moved.clone().unwrap();
    assert_eq!((moved.branch.as_str(), moved.commits), ("dev", 3));
    assert_eq!(moved.to, up_tip);
    assert_eq!(rev(&mut repos[0], "dev"), up_tip);
    let same = by("same");
    assert!(same.ok && same.skipped.is_none(), "{same:?}");
    assert_eq!(same.moved.as_ref().unwrap().commits, 0);
    let cur = by("cur");
    assert_eq!(
        cur.skipped.as_deref(),
        Some("커밋하지 않은 변경이 있습니다"),
        "{cur:?}"
    );
    assert!(cur.moved.is_none());
    let none = by("none");
    assert_eq!(
        none.skipped.as_deref(),
        Some("해당 브랜치가 없습니다"),
        "{none:?}"
    );
    assert_eq!((r.succeeded, r.skipped, r.failed), (2, 2, 0));

    // 깨끗해지면 현재 branch 는 merge --ff-only 로 작업 트리까지
    repos[2].git_ok(["checkout", "-q", "--", "f1.txt"]);
    let r = core
        .folder_batch(fid, op, &[root.join("cur")])
        .await
        .unwrap();
    assert_eq!(r.results.len(), 1);
    let cur = &r.results[0];
    assert!(cur.ok && cur.skipped.is_none(), "{cur:?}");
    assert_eq!(cur.moved.as_ref().unwrap().commits, 1);
    assert_eq!(rev(&mut repos[2], "HEAD"), cur_tip);
    assert!(repos[2].path().join("dev-remote-0.txt").exists());

    let _ = std::fs::remove_dir_all(&root);
}

/// 일괄 UpdateBranch 는 다른 워크트리에서 checkout 된 branch 를 건너뛰고 그 워크트리를 건드리지 않는다.
/// 갈라진 branch 는 건너뜀(사유에 수)으로 남는다
#[tokio::test]
async fn batch_update_branch_skips_other_worktree_and_diverged() {
    let core = core().await;
    let (root, mut repos, mut clones) = folder_of_four("wt");
    // up: dev 를 루트 밖 워크트리에서 checkout
    let wt_dir = tempfile::tempdir().unwrap();
    let wt_path = wt_dir.path().join("up-dev");
    let wt_str = wt_path.to_string_lossy().into_owned();
    let old = rev(&mut repos[0], "dev");
    repos[0].git_ok(["worktree", "add", "-q", &wt_str, "dev"]);
    push_commits(&mut clones[0], "dev", 1);
    // cur: 로컬 commit 하나 + 원격 commit 둘 → 갈라짐
    repos[2].write_file("mine.txt", "mine");
    repos[2].stage(&["mine.txt"]);
    let mine = repos[2].commit_staged("mine");
    push_commits(&mut clones[1], "dev", 2);
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core
        .folder_batch(
            fid,
            BatchOp::UpdateBranch { name: "dev".into() },
            &[root.join("up"), root.join("cur")],
        )
        .await
        .unwrap();
    let up = r.results.iter().find(|x| x.name == "up").unwrap();
    assert!(
        up.skipped
            .as_deref()
            .is_some_and(|s| s.starts_with("다른 워크트리에서 사용 중인 브랜치입니다")),
        "{up:?}"
    );
    assert_eq!(rev(&mut repos[0], "dev"), old);
    let mut wt = TestRepo::at(&wt_path);
    assert_eq!(rev(&mut wt, "HEAD"), old);
    let cur = r.results.iter().find(|x| x.name == "cur").unwrap();
    assert_eq!(
        cur.skipped.as_deref(),
        Some("로컬과 원격 이력이 갈라져 업데이트하지 않았습니다 (⇡1 ⇣2)"),
        "{cur:?}"
    );
    assert_eq!(rev(&mut repos[2], "dev"), mine.to_hex());

    let _ = std::fs::remove_dir_all(&root);
}
