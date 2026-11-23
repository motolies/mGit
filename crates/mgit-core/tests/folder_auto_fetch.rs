//! 폴더 자동 fetch (RM-02 의 폴더 탭): 간격마다 하위 저장소를 fetch 해 바뀐 원격 추적 ref·실패를 `FolderAutoFetched` 로
//! 알리고, 제외한 저장소·저장소 탭으로 열린 저장소는 건너뛰며, 간격을 실행 중에 바꾸고, 인증을 묻지 않는다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::{collector, core, core_with, wait_finished, wait_for};
use mgit_core::{AutoFetchedRepo, BatchOp, Core, CoreConfig, CoreEvent, FolderSettings, SessionId};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_testkit::{Scenario, TestRepo, build};
use tokio::sync::mpsc::UnboundedReceiver;

/// 짧은 간격 (테스트용)
const TICK: Duration = Duration::from_millis(150);
/// 이벤트를 기다리는 상한
const WAIT: Duration = Duration::from_secs(10);

/// 정규화한 폴더 루트 (macOS 의 `/var` → `/private/var` 를 흡수해 이벤트의 경로와 비교할 수 있게)
fn root_of(dir: &tempfile::TempDir) -> PathBuf {
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    root.canonicalize().unwrap()
}

/// 폴더 안 `name` 에 커밋 하나짜리 저장소를 만든다 (원격 없음)
fn repo_in(root: &Path, name: &str) -> TestRepo {
    let path = root.join(name);
    std::fs::create_dir_all(&path).unwrap();
    let mut r = TestRepo::at(&path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.write_file("a.txt", "a\n");
    r.stage(&["a.txt"]);
    r.commit_staged("first");
    r
}

/// 폴더 안 `name` 에 bare 원격을 둔 저장소와, 같은 원격의 두 번째 clone(폴더 밖, push 하는 쪽)
fn repo_with_pusher(root: &Path, name: &str) -> (TestRepo, TestRepo) {
    let mut repo = repo_in(root, name);
    let remote = repo.add_bare_remote();
    repo.git_ok(["push", "-q", "-u", "origin", "main"]);
    let mut pusher = TestRepo::init();
    pusher.git_ok(["remote", "add", "origin", &remote.to_string_lossy()]);
    pusher.git_ok(["fetch", "-q", "origin"]);
    pusher.git_ok(["checkout", "-q", "-b", "main", "--track", "origin/main"]);
    (repo, pusher)
}

/// 폴더 안 `name` 에 fetch 가 늘 실패하는 원격(없는 경로)을 둔 저장소. 자동 fetch 가 돌면 바퀴마다 실패로 알려진다
fn broken_repo(root: &Path, name: &str) -> TestRepo {
    let mut repo = repo_in(root, name);
    let missing = root.join("no-such-remote.git");
    repo.git_ok(["remote", "add", "origin", &missing.to_string_lossy()]);
    repo
}

/// 지금까지 받은 이벤트를 비운다
fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// `FolderAutoFetched` 의 저장소 목록 (다른 이벤트는 None)
fn fetched_repos(e: &CoreEvent) -> Option<&[AutoFetchedRepo]> {
    match e {
        CoreEvent::FolderAutoFetched { repos, .. } => Some(repos),
        _ => None,
    }
}

/// 폴더를 연다 (이벤트 수신기 포함)
async fn open_folder(core: &Core, root: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, rx) = collector();
    (core.open_folder(root, sink).await.unwrap().session, rx)
}

/// 원격이 바뀌면 다음 바퀴에 받아 오고, 그 저장소의 `FolderChanged { refs: true }` 를 먼저 보낸 뒤 바뀐 ref 를
/// `FolderAutoFetched` 로 알린다. undo·Operation 이벤트는 없다
#[tokio::test]
async fn folder_auto_fetch_reports_changed_remote_refs() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let (mut a, mut pusher) = repo_with_pusher(&root, "a");
    let _quiet = repo_in(&root, "no-remote");
    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(TICK),
        ..CoreConfig::default()
    })
    .await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    let pushed = pusher.commit("from pusher");
    pusher.git_ok(["push", "-q", "origin", "main"]);
    let path_a = root.join("a");
    let events = wait_for(&mut rx, WAIT, |e| {
        fetched_repos(e).is_some_and(|repos| {
            repos
                .iter()
                .any(|r| r.path == path_a && r.refs.iter().any(|x| x == "origin/main"))
        })
    })
    .await;

    let last = events.last().unwrap();
    assert_eq!(last.session(), fid);
    let repos = fetched_repos(last).unwrap();
    assert_eq!(repos.len(), 1, "바뀐 저장소만 싣는다: {repos:?}");
    assert_eq!(repos[0].name, "a");
    assert_eq!(repos[0].error, None);
    assert!(
        events.iter().any(|e| matches!(
            e,
            CoreEvent::FolderChanged { refs: true, repo: Some(p), .. } if *p == path_a
        )),
        "{events:#?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationStarted { .. })),
        "자동 fetch 는 Operation 이벤트를 만들지 않는다"
    );
    assert_eq!(
        a.git_ok(["rev-parse", "refs/remotes/origin/main"]).trim(),
        pushed.to_hex()
    );
}

/// 폴더 설정에서 뺀 저장소와 저장소 탭으로 열린 저장소(그 탭의 루프가 돈다)는 폴더 루프가 건너뛴다. 셋 다 fetch 가
/// 늘 실패하는 원격이라 폴더 루프가 돌았다면 바퀴마다 실패로 실렸을 것이다 (`d` 가 그 대조군)
#[tokio::test]
async fn folder_auto_fetch_skips_excluded_and_tab_repos() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let _b = broken_repo(&root, "b");
    let c = broken_repo(&root, "c");
    let _d = broken_repo(&root, "d");
    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(TICK),
        ..CoreConfig::default()
    })
    .await;
    let (tab_sink, mut tab_rx) = collector();
    let tab = core.open_repo(c.path(), tab_sink).await.unwrap();
    wait_finished(&mut tab_rx, tab.session).await;
    let (fid, mut rx) = open_folder(&core, &root).await;
    core.set_folder_settings(
        fid,
        &FolderSettings {
            exclude: vec!["b".into()],
            ..FolderSettings::default()
        },
    )
    .unwrap();

    // 세 바퀴 동안 실패로 실린 것은 `d` 뿐이다
    let mut rounds = Vec::new();
    for _ in 0..3 {
        let events = wait_for(&mut rx, WAIT, |e| fetched_repos(e).is_some()).await;
        rounds.push(fetched_repos(events.last().unwrap()).unwrap().to_vec());
    }
    for repos in &rounds {
        let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["d"], "{repos:?}");
        assert!(repos[0].refs.is_empty());
        assert!(repos[0].error.as_deref().is_some_and(|e| !e.is_empty()));
    }
    // 뺀 저장소에서는 fetch 가 한 번도 돌지 않았다
    let path_b = root.join("b");
    assert!(
        !core
            .command_log_recent(usize::MAX)
            .iter()
            .any(|r| r.cwd == path_b && r.args.first().is_some_and(|a| a == "fetch")),
        "제외한 저장소를 fetch 했다"
    );
    // 탭을 닫으면 그 저장소도 폴더 루프가 맡는다
    core.close_repo(tab.session).unwrap();
    drain(&mut rx);
    wait_for(&mut rx, WAIT, |e| {
        fetched_repos(e).is_some_and(|repos| repos.iter().any(|r| r.name == "c"))
    })
    .await;
}

/// 간격은 실행 중에 바꾼다: 꺼져 있던 폴더도 켜면 곧바로 돌고, 끄면 멈추고, 긴 간격에서 짧은 간격으로 바꾸면 이전
/// 타이머를 기다리지 않는다. 폴더를 닫으면 루프도 끝난다
#[tokio::test]
async fn folder_auto_fetch_follows_interval_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let _d = broken_repo(&root, "d");
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;
    let round = |e: &CoreEvent| fetched_repos(e).is_some();

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!drain(&mut rx).iter().any(round), "꺼져 있는데 돌았다");

    core.set_auto_fetch_interval(Some(TICK));
    wait_for(&mut rx, WAIT, round).await;

    core.set_auto_fetch_interval(None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    drain(&mut rx);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!drain(&mut rx).iter().any(round), "끈 뒤에 돌았다");

    core.set_auto_fetch_interval(Some(Duration::from_secs(3600)));
    core.set_auto_fetch_interval(Some(TICK));
    wait_for(&mut rx, WAIT, round).await;

    core.close_folder(fid).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    drain(&mut rx);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!drain(&mut rx).iter().any(round), "닫은 폴더에서 돌았다");
}

/// 인자로 받은 파일에 `MGIT_HELPER_SILENT` 값을 남기고 실패하는 가짜 원격 도우미 `git-remote-mgitfake` 를 `bin` 에 둔다.
/// 원격 URL `mgitfake::<파일>` 의 fetch 가 이것을 부른다
#[cfg(unix)]
fn fake_remote_helper(bin: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin).unwrap();
    let script = bin.join("git-remote-mgitfake");
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf '%s' \"${MGIT_HELPER_SILENT:-unset}\" > \"$2\"\necho 'fake remote down' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// 파일이 생길 때까지 기다린다 (시간 초과면 panic)
async fn wait_file(path: &Path) -> String {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && !text.is_empty()
        {
            return text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{} 이 생기지 않았다",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 자동 fetch(폴더·저장소 탭)는 git 에 묻지 않음 표시(`MGIT_HELPER_SILENT=1`)를 붙여 askpass 가 대화상자를 띄우지 않게
/// 한다. 사용자가 누른 fetch(폴더 일괄·탭)는 붙이지 않는다
#[cfg(unix)]
#[tokio::test]
async fn auto_fetch_runs_git_silently_but_manual_fetch_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fake_remote_helper(&bin);
    let root = root_of(&dir);
    let folder_mark = dir.path().join("folder.txt");
    let tab_mark = dir.path().join("tab.txt");
    let mut f = repo_in(&root, "f");
    f.git_ok([
        "remote",
        "add",
        "origin",
        &format!("mgitfake::{}", folder_mark.display()),
    ]);
    let mut t = build(Scenario::Linear(1));
    t.git_ok([
        "remote",
        "add",
        "origin",
        &format!("mgitfake::{}", tab_mark.display()),
    ]);
    // 네트워크 명령만 가짜 도우미를 찾게 한다
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let runner = TokioGitRunner::new(RunnerConfig {
        network_env: vec![("PATH".into(), path)],
        ..RunnerConfig::default()
    })
    .await
    .unwrap();
    let core = Core::new(
        Arc::new(runner),
        CoreConfig {
            auto_fetch_interval: Some(TICK),
            ..CoreConfig::default()
        },
    );
    let (sink, mut tab_rx) = collector();
    let tab = core.open_repo(t.path(), sink).await.unwrap();
    wait_finished(&mut tab_rx, tab.session).await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    let events = wait_for(&mut rx, WAIT, |e| fetched_repos(e).is_some()).await;
    let repos = fetched_repos(events.last().unwrap()).unwrap();
    assert_eq!(repos.len(), 1);
    assert!(
        repos[0]
            .error
            .as_deref()
            .is_some_and(|e| e.contains("fake remote down")),
        "{repos:?}"
    );
    assert_eq!(wait_file(&folder_mark).await, "1");
    assert_eq!(wait_file(&tab_mark).await, "1");

    // 사용자가 누른 fetch 는 묻는다
    core.set_auto_fetch_interval(None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::remove_file(&folder_mark).unwrap();
    std::fs::remove_file(&tab_mark).unwrap();
    let r = core
        .folder_batch(fid, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(r.failed, 1, "{r:?}");
    assert_eq!(wait_file(&folder_mark).await, "unset");
    assert!(
        core.fetch(tab.session, Some("origin"), false, None)
            .await
            .is_err()
    );
    assert_eq!(wait_file(&tab_mark).await, "unset");
}
