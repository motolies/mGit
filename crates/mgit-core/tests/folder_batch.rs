//! 멀티 저장소 일괄 작업 (MR-05~11)
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::PathBuf;
use std::time::Duration;

use common::{collector, core, core_watching, wait_for};
use mgit_core::{BatchOp, BatchPullMode, CoreEvent, FolderSettings};
use mgit_testkit::TestRepo;

/// 경로에 빈 저장소를 만든다 (`TestRepo::at` 은 init 하지 않는다)
fn init_at(path: &std::path::Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 임시 루트 폴더 아래에 저장소 두 개 (a 는 bare 원격 + 업스트림, b 는 원격 없음)
fn two_repos(tag: &str) -> (PathBuf, TestRepo, TestRepo) {
    let root = std::env::temp_dir().join(format!("mgit-batch-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut a = init_at(&root.join("a"));
    a.commit("a first");
    a.commit("a second");
    a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    let mut b = init_at(&root.join("b"));
    b.commit("b first");
    (root, a, b)
}

#[tokio::test]
async fn batch_fetch_pull_push_branch_checkout_and_exclude() {
    let core = core().await;
    let (root, mut a, mut b) = two_repos("ops");
    let (sink, mut rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();
    let fid = opened.session;
    assert_eq!(opened.repos.len(), 2);

    // fetch: 원격이 없어도 성공, 진행 이벤트가 온다
    let r = core
        .folder_batch(fid, BatchOp::Fetch { prune: true }, &[])
        .await
        .unwrap();
    assert_eq!(r.results.len(), 2);
    assert!(r.results.iter().all(|x| x.ok), "{r:?}");
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::OperationFinished { .. })
    })
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationStarted { kind, .. } if kind == "batch"))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationProgress { .. }))
    );

    // pull: a 는 업스트림이 있어 ff-only, b 는 업스트림 없음 → 건너뜀
    let r = core.folder_batch(fid, BatchOp::Pull, &[]).await.unwrap();
    let ra = r.results.iter().find(|x| x.name == "a").unwrap();
    let rb = r.results.iter().find(|x| x.name == "b").unwrap();
    assert!(ra.ok && ra.skipped.is_none(), "{ra:?}");
    assert_eq!(rb.skipped.as_deref(), Some("업스트림이 없습니다"));
    assert_eq!(r.succeeded, 1);
    assert_eq!(r.skipped, 1);

    // push: a 에 새 commit → 보냄, b 는 업스트림 없음
    a.commit("a third");
    let r = core.folder_batch(fid, BatchOp::Push, &[]).await.unwrap();
    let ra = r.results.iter().find(|x| x.name == "a").unwrap();
    assert!(ra.ok && ra.skipped.is_none(), "{ra:?}");
    let r = core.folder_batch(fid, BatchOp::Push, &[]).await.unwrap();
    assert_eq!(
        r.results
            .iter()
            .find(|x| x.name == "a")
            .unwrap()
            .skipped
            .as_deref(),
        Some("푸시할 커밋이 없습니다")
    );

    // branch 만들기 + checkout, 대상 지정
    let r = core
        .folder_batch(
            fid,
            BatchOp::CreateBranch {
                name: "batch-x".into(),
                checkout: true,
                start_point: None,
            },
            &[root.join("a"), root.join("b")],
        )
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), "batch-x");
    assert_eq!(b.git_ok(["branch", "--show-current"]).trim(), "batch-x");

    // checkout main: b 는 더티라 건너뜀
    b.write_file("dirty.txt", "x");
    b.stage(&["dirty.txt"]);
    let r = core
        .folder_batch(
            fid,
            BatchOp::Checkout {
                name: "main".into(),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        r.results
            .iter()
            .find(|x| x.name == "b")
            .unwrap()
            .skipped
            .as_deref(),
        Some("커밋하지 않은 변경이 있습니다")
    );

    // 폴더 설정: b 제외, concurrency 1
    core.set_folder_settings(
        fid,
        &FolderSettings {
            exclude: vec!["b".into()],
            pull_mode: BatchPullMode::Rebase,
            concurrency: 1,
            auto_refresh_secs: 0,
            worktree_root: None,
        },
    )
    .unwrap();
    assert_eq!(core.folder_settings(fid).unwrap().concurrency, 1);
    let r = core
        .folder_batch(fid, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(
        r.results
            .iter()
            .find(|x| x.name == "b")
            .unwrap()
            .skipped
            .as_deref(),
        Some("제외됨 (폴더 설정)")
    );
    // 잘못된 이름·빈 대상 거부
    assert!(
        core.folder_batch(
            fid,
            BatchOp::Checkout {
                name: "-bad".into()
            },
            &[]
        )
        .await
        .is_err()
    );
    assert!(
        core.folder_batch(fid, BatchOp::Pull, &[root.join("nope")])
            .await
            .is_err()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 일괄 pull 결과의 `moved` 는 checkout 된 branch 가 받은 commit 수다. 이미 최신이면 0(전후 같은 commit),
/// 건너뛴 저장소에는 없다
#[tokio::test]
async fn batch_pull_reports_moved_commits() {
    let core = core().await;
    let (root, mut a, _b) = two_repos("moved");
    let before = a.git_ok(["rev-parse", "HEAD"]).trim().to_string();
    // 같은 원격의 다른 clone 이 commit 둘을 올린다
    let remote = a.git_ok(["remote", "get-url", "origin"]).trim().to_string();
    let mut c = TestRepo::init();
    c.git_ok(["remote", "add", "origin", &remote]);
    c.git_ok(["fetch", "-q", "origin"]);
    c.git_ok(["checkout", "-q", "-b", "main", "--track", "origin/main"]);
    c.commit("c one");
    let tip = c.commit("c two").to_hex();
    c.git_ok(["push", "-q", "origin", "main"]);
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core.folder_batch(fid, BatchOp::Pull, &[]).await.unwrap();
    let ra = r.results.iter().find(|x| x.name == "a").unwrap();
    assert!(ra.ok && ra.skipped.is_none(), "{ra:?}");
    let moved = ra.moved.clone().unwrap();
    assert_eq!(moved.branch, "main");
    assert_eq!(
        (moved.from.as_str(), moved.to.as_str()),
        (before.as_str(), tip.as_str())
    );
    assert_eq!(moved.commits, 2);
    let rb = r.results.iter().find(|x| x.name == "b").unwrap();
    assert!(rb.skipped.is_some() && rb.moved.is_none(), "{rb:?}");

    let r = core.folder_batch(fid, BatchOp::Pull, &[]).await.unwrap();
    let ra = r.results.iter().find(|x| x.name == "a").unwrap();
    let moved = ra.moved.clone().unwrap();
    assert_eq!((moved.commits, moved.from == moved.to), (0, true), "{ra:?}");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn batch_worktree_changes_and_commit() {
    let core = core().await;
    let (root, _a, mut b) = two_repos("wt");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    // 일괄 워크트리
    let dest = root.join("worktrees");
    let r = core
        .folder_batch(
            fid,
            BatchOp::Worktree {
                branch: "wt-branch".into(),
                dest_root: dest.clone(),
                create_branch: true,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    assert!(dest.join("a").join(".git").exists());
    assert!(dest.join("b").join(".git").exists());
    let again = core
        .folder_batch(
            fid,
            BatchOp::Worktree {
                branch: "wt-branch".into(),
                dest_root: dest.clone(),
                create_branch: false,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(again.skipped, 2);

    // 통합 변경 보기: b 에만 변경
    b.write_file("new.txt", "n");
    b.stage(&["new.txt"]);
    b.write_file("loose.txt", "l");
    let changes = core.folder_changes(fid, &[]).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].name, "b");
    assert_eq!(changes[0].summary.staged, 1);
    assert_eq!(changes[0].summary.untracked, 1);
    assert_eq!(changes[0].entries.len(), 2);

    // 일괄 commit: a 는 stage 된 것 없음 → 건너뜀, b 는 커밋
    let r = core
        .folder_commit(fid, &[], "일괄 commit\n\n본문", false)
        .await
        .unwrap();
    assert_eq!(r.succeeded, 1);
    assert_eq!(r.skipped, 1);
    assert!(b.git_ok(["log", "-1", "--format=%s"]).trim() == "일괄 commit");
    assert!(core.folder_commit(fid, &[], "  ", false).await.is_err());
    // stage_all 로 untracked 까지
    let r = core
        .folder_commit(fid, &[root.join("b")], "all", true)
        .await
        .unwrap();
    assert_eq!(r.succeeded, 1);
    assert!(core.folder_changes(fid, &[]).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn root_watch_rescans_when_repo_added() {
    let core = core_watching().await;
    let (root, _a, _b) = two_repos("watch");
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut c = init_at(&root.join("c"));
    c.commit("c first");
    let events = wait_for(&mut rx, Duration::from_secs(8), |e| {
        matches!(e, CoreEvent::FolderRescanned { session, repos } if *session == fid && repos.len() == 3)
    })
    .await;
    assert!(!events.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

/// 재스캔 뒤에도 폴더 루트 감시가 살아 있어 두 번째 추가도 감지한다 (MR-10)
#[tokio::test]
async fn root_watch_survives_rescan() {
    let core = core_watching().await;
    let (root, _a, _b) = two_repos("watch-again");
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut c = init_at(&root.join("c"));
    c.commit("c first");
    wait_for(&mut rx, Duration::from_secs(8), |e| {
        matches!(e, CoreEvent::FolderRescanned { session, repos } if *session == fid && repos.len() == 3)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut d = init_at(&root.join("d"));
    d.commit("d first");
    wait_for(&mut rx, Duration::from_secs(8), |e| {
        matches!(e, CoreEvent::FolderRescanned { session, repos } if *session == fid && repos.len() == 4)
    })
    .await;
    let _ = std::fs::remove_dir_all(&root);
}

/// 충돌이 남은 저장소는 일괄 커밋이 건드리지 않는다 (`add -A` 로 merge 를 끝내 버리면 안 된다)
#[tokio::test]
async fn folder_commit_skips_repo_with_unresolved_conflicts() {
    let core = core().await;
    let (root, mut a, mut b) = two_repos("conflict");
    a.prepare_conflict();
    a.begin_merge_conflict();
    let head = a.head();
    b.write_file("n.txt", "n");
    let (sink, _rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();

    let r = core
        .folder_commit(opened.session, &[], "batch", true)
        .await
        .unwrap();

    let ra = r.results.iter().find(|x| x.name == "a").unwrap();
    assert!(ra.skipped.is_some(), "{ra:?}");
    assert_eq!(a.head(), head, "merge 커밋이 만들어지면 안 된다");
    assert!(!a.git_ok(["ls-files", "-u"]).is_empty(), "충돌 상태 유지");
    let rb = r.results.iter().find(|x| x.name == "b").unwrap();
    assert!(rb.ok && rb.skipped.is_none(), "{rb:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// 진짜 충돌 마커가 든 파일은 일괄 커밋이 막고, 저장소별 실패로 알린다
#[tokio::test]
async fn folder_commit_refuses_conflict_markers() {
    let core = core().await;
    let (root, mut a, _b) = two_repos("markers");
    let head = a.head();
    a.write_file("m.txt", "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n");
    let (sink, _rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();

    let r = core
        .folder_commit(opened.session, &[], "batch", true)
        .await
        .unwrap();

    let ra = r.results.iter().find(|x| x.name == "a").unwrap();
    assert!(!ra.ok, "{ra:?}");
    assert!(ra.message.contains("m.txt"), "{ra:?}");
    assert_eq!(a.head(), head);
    let _ = std::fs::remove_dir_all(&root);
}

/// 스크립트가 돌면 표식 파일을 남긴다
#[cfg(unix)]
fn marker_script(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("evil.sh");
    let marker = dir.join("ran");
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, marker)
}

/// 폴더 대시보드는 사용자가 고르지 않은 저장소까지 훑으므로 그 저장소의 fsmonitor 를 실행하지 않는다
#[cfg(unix)]
#[tokio::test]
async fn folder_scan_does_not_run_repo_fsmonitor() {
    let dir = tempfile::tempdir().unwrap();
    let (script, marker) = marker_script(dir.path());
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let mut repo = mgit_testkit::TestRepo::at(&root.join("a"));
    std::fs::create_dir(repo.path()).unwrap();
    repo.git_ok(["init", "-q", "-b", "main"]);
    repo.write_file("a.txt", "a");
    repo.stage(&["a.txt"]);
    repo.commit_staged("a");
    repo.git_ok(["config", "core.fsmonitor", &script.to_string_lossy()]);
    // 사전 조건: 일반 git status 라면 이 설정이 실행된다
    repo.git_ok(["status", "--porcelain"]);
    assert!(
        marker.exists(),
        "fsmonitor 설정이 실제로 동작해야 시험이 된다"
    );
    std::fs::remove_file(&marker).unwrap();

    let core = core().await;
    let (sink, _rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();
    let list = core.folder_summaries(opened.session, &[]).await.unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].error.is_none(), "{list:?}");
    assert!(!marker.exists(), "대시보드 요약이 fsmonitor 를 실행했다");
    core.folder_changes(opened.session, &[]).await.unwrap();
    assert!(!marker.exists(), "변경 목록이 fsmonitor 를 실행했다");
}

/// 시작점을 주면 그 ref 에서 만들고, 그 ref 가 없는 저장소는 사유와 함께 건너뛴다
#[tokio::test]
async fn batch_create_branch_from_start_point() {
    let core = core().await;
    let (root, mut a, mut b) = two_repos("start");
    // base 는 a 에만 있고 main 보다 하나 앞선다
    a.checkout_new("base");
    let base = a.commit("a on base");
    a.checkout("main");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    // checkout 없이: a 는 base 의 커밋에서 만들어지고 HEAD 는 그대로, b 는 건너뜀
    let r = core
        .folder_batch(
            fid,
            BatchOp::CreateBranch {
                name: "topic".into(),
                checkout: false,
                start_point: Some("refs/heads/base".into()),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!((r.succeeded, r.skipped, r.failed), (1, 1, 0), "{r:?}");
    assert_eq!(a.git_ok(["rev-parse", "topic"]).trim(), base.to_hex());
    assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), "main");
    let rb = r.results.iter().find(|x| x.name == "b").unwrap();
    assert_eq!(
        rb.skipped.as_deref(),
        Some("시작점을 찾을 수 없습니다: base")
    );
    assert!(
        b.git(["rev-parse", "--verify", "-q", "topic"])
            .stdout
            .is_empty()
    );
    assert!(
        r.label.contains("topic") && r.label.contains("base"),
        "{}",
        r.label
    );

    // checkout 과 함께: a 는 새 branch 로 전환된다
    let r = core
        .folder_batch(
            fid,
            BatchOp::CreateBranch {
                name: "topic2".into(),
                checkout: true,
                start_point: Some("refs/heads/base".into()),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!((r.succeeded, r.skipped, r.failed), (1, 1, 0), "{r:?}");
    assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), "topic2");
    assert_eq!(a.head(), base);
    assert_eq!(b.git_ok(["branch", "--show-current"]).trim(), "main");

    // 원격 브랜치를 시작점으로 만들어도 그 원격을 추적하지 않는다. 추적하면 이 앱의 push 가
    // 이름이 다른 그 원격 브랜치(origin/main)를 갱신하게 된다. b 는 원격이 없어 건너뛴다
    a.git_ok(["branch", "-q", "probe", "refs/remotes/origin/main"]);
    assert_eq!(
        upstream_ref(&mut a, "probe"),
        "refs/remotes/origin/main",
        "사전 조건: git 기본값은 원격 브랜치에서 만든 브랜치에 추적을 건다"
    );
    let origin_main = a.git_ok(["rev-parse", "refs/remotes/origin/main"]);
    for (name, checkout) in [("from-remote", false), ("from-remote-co", true)] {
        let r = core
            .folder_batch(
                fid,
                BatchOp::CreateBranch {
                    name: name.into(),
                    checkout,
                    start_point: Some("refs/remotes/origin/main".into()),
                },
                &[],
            )
            .await
            .unwrap();
        assert_eq!((r.succeeded, r.skipped, r.failed), (1, 1, 0), "{r:?}");
        let rb = r.results.iter().find(|x| x.name == "b").unwrap();
        assert_eq!(
            rb.skipped.as_deref(),
            Some("시작점을 찾을 수 없습니다: origin/main")
        );
        assert_eq!(a.git_ok(["rev-parse", name]).trim(), origin_main.trim());
        assert_eq!(upstream_ref(&mut a, name), "", "{name}: 추적을 걸지 않는다");
        if checkout {
            assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), name);
        }
    }
    // 로컬 ref 를 시작점으로 만든 브랜치에도 업스트림이 없다 (위에서 만든 topic·topic2)
    assert_eq!(upstream_ref(&mut a, "topic"), "");
    assert_eq!(upstream_ref(&mut a, "topic2"), "");

    // 옵션처럼 보이는 값·범위 표기·NUL·공백은 git 을 돌리기 전에 거부한다
    for bad in ["-x", "--orphan", "a..b", "a\0b", "a b", ""] {
        let res = core
            .folder_batch(
                fid,
                BatchOp::CreateBranch {
                    name: "never".into(),
                    checkout: false,
                    start_point: Some(bad.into()),
                },
                &[],
            )
            .await;
        assert!(res.is_err(), "{bad:?}");
    }
    assert!(
        a.git(["rev-parse", "--verify", "-q", "never"])
            .stdout
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 로컬 브랜치의 업스트림 전체 이름 (`refs/remotes/origin/main`). 없으면 빈 문자열
fn upstream_ref(repo: &mut TestRepo, branch: &str) -> String {
    repo.git_ok([
        "for-each-ref",
        "--format=%(upstream)",
        &format!("refs/heads/{branch}"),
    ])
    .trim()
    .to_string()
}

/// 저장소에 `origin` 원격을 달고 main 을 `feat` 로도 올린다 (원격 브랜치 `origin/feat` 만 생긴다)
fn with_remote_feat(repo: &mut TestRepo) {
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "-u", "origin", "main"]);
    repo.git_ok(["push", "-q", "origin", "main:feat"]);
}

/// 저장소의 `branch` 가 추적하는 업스트림 (`origin/feat` 꼴)
fn upstream_of(repo: &mut TestRepo, branch: &str) -> String {
    repo.git_ok([
        "rev-parse",
        "--abbrev-ref",
        &format!("{branch}@{{upstream}}"),
    ])
    .trim()
    .to_string()
}

/// 원격 브랜치의 일괄 checkout 은 분리 HEAD 가 아니라 로컬 추적 브랜치로 간다.
/// 로컬이 없으면 추적 브랜치를 만들고, 그 원격을 추적하는 로컬이 있으면 그것으로 전환한다.
/// 같은 이름의 로컬이 업스트림이 없거나 다른 곳을 추적하면 건너뛴다
#[tokio::test]
async fn batch_checkout_remote_uses_local_tracking_branches() {
    let core = core().await;
    let root = std::env::temp_dir().join(format!("mgit-batch-remote-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    // create: 로컬 feat 없음 → 추적 브랜치를 만든다
    let mut create = init_at(&root.join("create"));
    create.commit("c1");
    with_remote_feat(&mut create);
    // existing: 로컬 feat 가 이미 origin/feat 를 추적한다 → 그 브랜치로 전환
    let mut existing = init_at(&root.join("existing"));
    existing.commit("e1");
    with_remote_feat(&mut existing);
    existing.git_ok(["branch", "-q", "--track", "feat", "origin/feat"]);
    // plain: 로컬 feat 가 있지만 업스트림이 없다 → 건너뜀 (origin/feat 와 무관한 커밋에 세우지 않는다)
    let mut plain = init_at(&root.join("plain"));
    plain.commit("p1");
    with_remote_feat(&mut plain);
    plain.git_ok(["branch", "-q", "--no-track", "feat", "main"]);
    // other: 로컬 feat 가 다른 원격(fork/feat)을 추적한다 → 건너뜀
    let mut other = init_at(&root.join("other"));
    other.commit("o1");
    with_remote_feat(&mut other);
    other.add_bare_remote_named("fork");
    other.git_ok(["push", "-q", "fork", "main:feat"]);
    other.git_ok(["branch", "-q", "--track", "feat", "fork/feat"]);
    // none: origin/feat 가 없다 → 건너뜀
    let mut none = init_at(&root.join("none"));
    none.commit("n1");
    // dirty: 커밋하지 않은 변경 → 건너뜀
    let mut dirty = init_at(&root.join("dirty"));
    dirty.commit("d1");
    with_remote_feat(&mut dirty);
    dirty.write_file("x.txt", "x");
    dirty.stage(&["x.txt"]);

    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    let r = core
        .folder_batch(
            fid,
            BatchOp::CheckoutRemote {
                remote: "origin".into(),
                branch: "feat".into(),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(r.label, "브랜치 일괄 전환: origin/feat");
    let of = |name: &str| r.results.iter().find(|x| x.name == name).unwrap();
    assert_eq!((r.succeeded, r.skipped, r.failed), (2, 4, 0), "{r:#?}");

    for (repo, name) in [(&mut create, "create"), (&mut existing, "existing")] {
        assert!(of(name).ok && of(name).skipped.is_none(), "{:?}", of(name));
        assert_eq!(
            repo.git_ok(["branch", "--show-current"]).trim(),
            "feat",
            "{name}"
        );
        assert_eq!(upstream_of(repo, "feat"), "origin/feat", "{name}");
    }
    // 업스트림 없는 같은 이름의 로컬: 전환하지 않고, 추적도 걸지 않고, 사유를 남긴다
    assert_eq!(
        of("plain").skipped.as_deref(),
        Some("로컬 브랜치 feat은(는) origin/feat을(를) 추적하지 않습니다")
    );
    assert_eq!(plain.git_ok(["branch", "--show-current"]).trim(), "main");
    assert_eq!(upstream_ref(&mut plain, "feat"), "");

    assert_eq!(
        of("other").skipped.as_deref(),
        Some("로컬 브랜치 feat은(는) fork/feat을(를) 추적 중입니다")
    );
    assert_eq!(other.git_ok(["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        of("none").skipped.as_deref(),
        Some("원격 브랜치가 없습니다: origin/feat")
    );
    assert_eq!(none.git_ok(["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        of("dirty").skipped.as_deref(),
        Some("커밋하지 않은 변경이 있습니다")
    );

    // 다시 실행하면 이미 그 branch 인 저장소는 건너뛴다
    let again = core
        .folder_batch(
            fid,
            BatchOp::CheckoutRemote {
                remote: "origin".into(),
                branch: "feat".into(),
            },
            &[root.join("create")],
        )
        .await
        .unwrap();
    assert_eq!(again.results.len(), 1);
    assert_eq!(
        again.results[0].skipped.as_deref(),
        Some("이미 해당 브랜치입니다")
    );

    // 잘못된 원격·branch 이름은 거부한다
    for (remote, branch) in [
        ("-x", "feat"),
        ("origin", "--detach"),
        ("origin", "a..b"),
        ("", "feat"),
    ] {
        let res = core
            .folder_batch(
                fid,
                BatchOp::CheckoutRemote {
                    remote: remote.into(),
                    branch: branch.into(),
                },
                &[],
            )
            .await;
        assert!(res.is_err(), "{remote:?} {branch:?}");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// 일괄 작업 뒤에는 대상 저장소마다 `FolderChanged` 가 그 저장소 경로와 함께 온다 (PF-02)
#[tokio::test]
async fn batch_reports_each_target_repo_as_changed() {
    let core = core().await;
    let (root, _a, _b) = two_repos("changed");
    let root = root.canonicalize().unwrap();
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    core.folder_batch(
        fid,
        BatchOp::CreateBranch {
            name: "only-b".into(),
            checkout: false,
            start_point: None,
        },
        &[root.join("b")],
    )
    .await
    .unwrap();
    let mut changed = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let CoreEvent::FolderChanged { repo, refs, .. } = e {
            changed.push((repo, refs));
        }
    }
    assert_eq!(changed, vec![(Some(root.join("b")), true)]);
    let _ = std::fs::remove_dir_all(&root);
}

/// 현재 branch 이름 (분리 HEAD 면 빈 문자열)
fn current_branch(repo: &mut TestRepo) -> String {
    repo.git_ok(["branch", "--show-current"]).trim().to_string()
}

/// 로컬 branch 가 있는지
fn has_branch(repo: &mut TestRepo, name: &str) -> bool {
    !repo
        .git_ok(["branch", "--list", "--format=%(refname)", name])
        .trim()
        .is_empty()
}

/// 일괄 이름 바꾸기 (BR-04 폴더): 저장소마다 `git branch -m` — 현재 branch 도 바꾸고(HEAD 가 따라간다), 업스트림
/// 설정도 새 이름으로 옮겨진다. branch 가 없는 저장소·새 이름이 이미 있는 저장소는 건너뛰고 아무것도 바꾸지 않는다.
/// 같은 이름으로 바꾸기는 실행 전에 거부한다
#[tokio::test]
async fn batch_rename_branch_renames_and_skips_missing_or_taken() {
    let core = core().await;
    let root = std::env::temp_dir().join(format!("mgit-batch-rename-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    // cur: feature/x 가 현재 branch
    let mut cur = init_at(&root.join("cur"));
    cur.commit("cur first");
    cur.git_ok(["checkout", "-q", "-b", "feature/x"]);
    // plain: feature/x 가 있고 업스트림이 있다 (현재는 main)
    let mut plain = init_at(&root.join("plain"));
    plain.commit("plain first");
    plain.add_bare_remote();
    plain.git_ok(["branch", "feature/x"]);
    plain.git_ok(["push", "-q", "-u", "origin", "feature/x"]);
    // taken: feature/x 와 새 이름 feature-x 가 모두 있다
    let mut taken = init_at(&root.join("taken"));
    taken.commit("taken first");
    taken.git_ok(["branch", "feature/x"]);
    taken.git_ok(["branch", "feature-x"]);
    // none: feature/x 가 없다
    let mut none = init_at(&root.join("none"));
    none.commit("none first");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let op = BatchOp::RenameBranch {
        from: "feature/x".into(),
        to: "feature-x".into(),
    };
    assert_eq!(op.label(), "브랜치 이름 일괄 변경: feature/x → feature-x");
    let r = core.folder_batch(fid, op, &[]).await.unwrap();
    assert_eq!((r.succeeded, r.skipped, r.failed), (2, 2, 0), "{r:?}");
    let get = |name: &str| r.results.iter().find(|x| x.name == name).unwrap();
    for name in ["cur", "plain"] {
        let x = get(name);
        assert!(x.ok && x.skipped.is_none(), "{x:?}");
    }
    assert_eq!(
        get("taken").skipped.as_deref(),
        Some("이미 사용 중인 이름입니다: feature-x")
    );
    assert_eq!(
        get("none").skipped.as_deref(),
        Some("해당 브랜치가 없습니다")
    );

    // 현재 branch: HEAD 가 새 이름을 따라간다
    assert_eq!(current_branch(&mut cur), "feature-x");
    assert!(!has_branch(&mut cur, "feature/x"));
    // 업스트림 설정이 새 이름으로 옮겨진다 (단일 저장소 rename 과 같은 `branch -m`)
    assert!(has_branch(&mut plain, "feature-x") && !has_branch(&mut plain, "feature/x"));
    assert_eq!(
        plain
            .git_ok(["rev-parse", "--abbrev-ref", "feature-x@{upstream}"])
            .trim(),
        "origin/feature/x"
    );
    assert_eq!(current_branch(&mut plain), "main");
    // 건너뛴 저장소는 그대로다
    assert!(has_branch(&mut taken, "feature/x") && has_branch(&mut taken, "feature-x"));
    assert!(!has_branch(&mut none, "feature-x"));

    // 같은 이름으로 바꾸기는 저장소를 돌기 전에 거부한다
    let same = core
        .folder_batch(
            fid,
            BatchOp::RenameBranch {
                from: "main".into(),
                to: "main".into(),
            },
            &[],
        )
        .await;
    assert!(same.is_err(), "{same:?}");
    // 잘못된 새 이름도 실행 전에 거부한다 (코어 이름 검사)
    let bad = core
        .folder_batch(
            fid,
            BatchOp::RenameBranch {
                from: "main".into(),
                to: "-x".into(),
            },
            &[],
        )
        .await;
    assert!(bad.is_err(), "{bad:?}");

    let _ = std::fs::remove_dir_all(&root);
}

/// 다른 워크트리에서 checkout 된 branch 의 일괄 이름 바꾸기: git 이 그대로 바꾸고 그 워크트리의 HEAD 도 새 이름으로
/// 옮긴다 (워크트리는 계속 그 branch 에 있다). 화면은 이 경우를 건너뛰지 않는다
#[tokio::test]
async fn batch_rename_branch_checked_out_in_other_worktree() {
    let core = core().await;
    let root = std::env::temp_dir().join(format!("mgit-batch-rename-wt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut up = init_at(&root.join("up"));
    up.commit("up first");
    up.git_ok(["branch", "dev"]);
    // dev 를 루트 밖 워크트리에서 checkout 한다
    let wt_dir = tempfile::tempdir().unwrap();
    let wt_path = wt_dir.path().join("up-dev");
    let wt_str = wt_path.to_string_lossy().into_owned();
    up.git_ok(["worktree", "add", "-q", &wt_str, "dev"]);
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core
        .folder_batch(
            fid,
            BatchOp::RenameBranch {
                from: "dev".into(),
                to: "dev-renamed".into(),
            },
            &[root.join("up")],
        )
        .await
        .unwrap();
    let x = r.results.iter().find(|x| x.name == "up").unwrap();
    assert!(x.ok && x.skipped.is_none(), "{x:?}");
    assert!(has_branch(&mut up, "dev-renamed") && !has_branch(&mut up, "dev"));
    assert_eq!(current_branch(&mut up), "main");
    let mut wt = TestRepo::at(&wt_path);
    assert_eq!(current_branch(&mut wt), "dev-renamed");
    assert!(
        up.git_ok(["worktree", "list", "--porcelain"])
            .contains("branch refs/heads/dev-renamed"),
    );

    let _ = std::fs::remove_dir_all(&root);
}
