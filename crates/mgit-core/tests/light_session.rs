//! 폴더 화면의 가벼운(Light) 저장소 세션 (W13, 계획 5.1절·결정 13번, FS-11·12).
//! 프로필(그래프·자동 fetch 없음), 폴더에서 열기·소속 확인, 작업 트리당 세션 하나, 승격, 상한, 해제·닫기,
//! 일괄 작업과 세션 쓰기의 잠금, 저장소 설정이 실행시키는 명령을 본다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::{collector, core_with, wait_finished, wait_for};
use mgit_core::{
    BatchOp, CommandLogRecord, CommitSpec, Core, CoreConfig, CoreError, CoreEvent, FolderSettings,
    GitError, GraphLayoutPrefs, GraphQuery, LIGHT_SESSIONS_PER_FOLDER, SearchFields, SessionId,
    SessionProfile,
};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::MemoryStore;
use mgit_testkit::TestRepo;
use mgit_watch::NotifyWatcher;
use tokio::sync::mpsc::UnboundedReceiver;

/// 폴더 안 경로에 커밋 하나짜리 저장소를 만든다
fn repo_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.write_file("a.txt", "a\n");
    r.stage(&["a.txt"]);
    r.commit_staged("first");
    r
}

/// 정규화한 임시 폴더 루트 (macOS 의 `/var` → `/private/var` 를 흡수해 세션 경로와 비교할 수 있게)
fn root_of(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().unwrap()
}

/// notify 감시자를 단 코어 (설정 지정)
async fn core_watching_with(cfg: CoreConfig) -> Core {
    let runner = TokioGitRunner::new(RunnerConfig::default()).await.unwrap();
    Core::with_deps(
        Arc::new(runner),
        Arc::new(NotifyWatcher {
            debounce: Duration::from_millis(100),
            ..NotifyWatcher::default()
        }),
        Arc::new(MemoryStore::new()),
        cfg,
    )
}

/// 폴더를 연다 (이벤트는 버린다)
async fn open_folder(core: &Core, root: &Path) -> SessionId {
    let (sink, _rx) = collector();
    core.open_folder(root, sink).await.unwrap().session
}

/// 가벼운 세션을 연다 (이벤트 수신기 포함)
async fn open_light(
    core: &Core,
    folder: SessionId,
    repo: &Path,
) -> (mgit_core::OpenedRepo, UnboundedReceiver<CoreEvent>) {
    let (sink, rx) = collector();
    let opened = core
        .folder_open_repo_session(folder, repo, sink)
        .await
        .unwrap();
    (opened, rx)
}

/// 지금까지 쌓인 명령 로그 (시간순)
fn command_log(core: &Core) -> Vec<CommandLogRecord> {
    let mut log = core.command_log_recent(usize::MAX);
    log.reverse();
    log
}

/// 그 작업 트리에서 돈 명령 중 첫 인자가 아니라도 `sub` 를 인자로 가진 것
fn commands_in(core: &Core, cwd: &Path, sub: &str) -> Vec<CommandLogRecord> {
    command_log(core)
        .into_iter()
        .filter(|r| r.cwd == cwd && r.args.iter().any(|a| a == sub))
        .collect()
}

/// 그래프 로드 이벤트인지
fn is_graph_event(e: &CoreEvent) -> bool {
    matches!(
        e,
        CoreEvent::GraphLoadStarted { .. }
            | CoreEvent::GraphFirstChunk { .. }
            | CoreEvent::GraphProgress { .. }
            | CoreEvent::GraphLoadFinished { .. }
            | CoreEvent::GraphLoadFailed { .. }
            | CoreEvent::GraphReloaded { .. }
    )
}

/// 받은 이벤트를 다 꺼낸다
fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// 지금 epoch 밀리초
fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// 파일이 생길 때까지 기다린다 (시간 상한)
async fn wait_file(path: &Path, limit: Duration) {
    let deadline = tokio::time::Instant::now() + limit;
    while !path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{} 이(가) 생기지 않았다",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 커밋 명세
fn commit_spec(message: &str) -> CommitSpec {
    CommitSpec {
        message: message.into(),
        amend: false,
        no_verify: false,
        allow_empty: false,
        sign: None,
        allow_conflict_markers: false,
    }
}

/// 실행하면 표식 파일을 만드는 스크립트 (stdin 은 그대로 stdout 으로 넘긴다 — clean 필터로도 쓸 수 있게)
#[cfg(unix)]
fn marker_script(dir: &Path, name: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("{name}.sh"));
    let marker = dir.join(format!("{name}.ran"));
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, marker)
}

// ── 프로필 ─────────────────────────────────────────────────────────────────────

/// 가벼운 세션은 그래프를 읽지 않고(그래프 이벤트·`log` 명령 없음) 자동 fetch 도 돌리지 않는다.
/// 탭으로 승격하면 같은 id 로 둘 다 시작한다 (같은 설정에서 fetch 가 실제로 도는 대조군)
#[tokio::test]
async fn light_profile_skips_graph_load_and_auto_fetch_until_promoted() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.add_bare_remote();
    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(Duration::from_millis(100)),
        ..CoreConfig::default()
    })
    .await;
    let fid = open_folder(&core, &root).await;
    // 폴더 자동 fetch 도 같은 간격으로 이 저장소를 돈다. 가벼운 세션 자체가 fetch 하지 않는지 보려고 폴더 루프에서 뺀다
    core.set_folder_settings(
        fid,
        &FolderSettings {
            exclude: vec!["a".into()],
            ..FolderSettings::default()
        },
    )
    .unwrap();

    let (opened, mut rx) = open_light(&core, fid, &path_a).await;
    assert_eq!(opened.profile, SessionProfile::Light);
    assert!(!opened.already_open && !opened.promoted);
    assert_eq!(opened.info.work_tree, path_a);
    // 자동 fetch 간격의 여러 배를 기다려도 fetch·log 가 돌지 않고 그래프 이벤트가 없다
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(commands_in(&core, &path_a, "fetch").is_empty());
    assert!(commands_in(&core, &path_a, "log").is_empty());
    assert!(!drain(&mut rx).iter().any(is_graph_event));
    assert_eq!(
        core.session_profile(opened.session).unwrap(),
        SessionProfile::Light
    );

    // 승격: 같은 id, 새 sink 로 로드 완료, 옛 sink 에는 그래프 이벤트가 없다, 자동 fetch 가 돈다
    let (sink2, mut rx2) = collector();
    let promoted = core.open_repo(&path_a, sink2).await.unwrap();
    assert_eq!(promoted.session, opened.session);
    assert!(promoted.already_open && promoted.promoted);
    assert_eq!(promoted.profile, SessionProfile::Full);
    let events = wait_finished(&mut rx2, opened.session).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::GraphLoadFinished { .. }))
    );
    assert!(!drain(&mut rx).iter().any(is_graph_event));
    assert!(!commands_in(&core, &path_a, "log").is_empty());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while commands_in(&core, &path_a, "fetch").is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "승격 뒤 자동 fetch 가 돌지 않았다"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 다시 탭으로 열어도 승격은 한 번뿐이다
    let (sink3, _rx3) = collector();
    let again = core.open_repo(&path_a, sink3).await.unwrap();
    assert!(again.already_open && !again.promoted);
    core.close_repo(opened.session).unwrap();
}

/// 그래프 API 는 로드를 시작하지 않고 바로 `GraphUnavailable` 이다. 커밋 상세는 그래프 없이 동작한다
/// (행·자식은 비고 라벨은 채움)
#[tokio::test]
async fn graph_apis_refuse_light_sessions_and_commit_detail_works_without_graph() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let head = a.head();
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, mut rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    let unavailable = |r: Result<(), CoreError>| {
        assert!(
            matches!(r, Err(CoreError::GraphUnavailable(id)) if id == s),
            "{r:?}"
        );
    };
    unavailable(core.graph_window(s, 0, 10).map(|_| ()));
    unavailable(core.find_row(s, &head).map(|_| ()));
    unavailable(core.load_state(s).map(|_| ()));
    unavailable(core.reload_graph(s));
    unavailable(core.relayout_graph(s));
    unavailable(core.set_graph_layout_prefs(s, GraphLayoutPrefs::default()));
    unavailable(core.set_graph_query(s, GraphQuery::default()).await);
    unavailable(
        core.search_commits(s, "first", SearchFields::default(), 10)
            .map(|_| ()),
    );
    unavailable(
        core.search_advanced(s, &mgit_core::AdvancedSearch::default(), 10)
            .await
            .map(|_| ()),
    );
    // 질의 읽기는 그래프와 무관해 그대로다
    assert_eq!(core.graph_query(s).unwrap(), GraphQuery::default());

    let detail = core.commit_detail(s, &head).await.unwrap();
    assert_eq!(detail.oid, head);
    assert_eq!(detail.row, None);
    assert!(detail.children.is_empty());
    assert!(
        detail.refs.iter().any(|l| l.short_name == "main"),
        "{detail:?}"
    );
    assert!(!drain(&mut rx).iter().any(is_graph_event));
    assert!(commands_in(&core, &path_a, "log").iter().all(|r| {
        !r.args
            .iter()
            .any(|a| a.starts_with("--date-order") || a == "--topo-order")
    }));
}

/// 가벼운 세션에서 기존 세션 API 가 그대로 돈다: 변경 목록, 작업 트리 diff, stage → commit, 파일 히스토리, blame
#[tokio::test]
async fn existing_session_apis_work_on_light_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.write_file("a.txt", "a\nchanged\n");
    a.write_file("new.txt", "new\n");
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;

    // 변경 목록 (열 때의 상태와 다시 읽은 상태가 같다)
    let paths: Vec<String> = opened
        .state
        .status
        .entries
        .iter()
        .map(|e| e.path.clone())
        .collect();
    assert_eq!(paths, vec!["a.txt".to_string(), "new.txt".to_string()]);
    core.refresh(s).await.unwrap();
    assert_eq!(core.repo_state(s).unwrap().status.entries.len(), 2);

    let diff = core.work_tree_diff(s, "a.txt", false, false).await.unwrap();
    assert!(diff.is_some(), "작업 트리 diff");

    core.stage(s, &["a.txt".into(), "new.txt".into()])
        .await
        .unwrap();
    assert_eq!(core.repo_state(s).unwrap().status.summary().staged, 2);
    let oid = core
        .commit(s, commit_spec("light commit"), None)
        .await
        .unwrap();
    assert_eq!(a.head(), oid);
    let st = core.repo_state(s).unwrap();
    assert!(st.status.entries.is_empty());
    assert_eq!(st.refs.head.oid(), Some(oid));

    let history = core.file_history(s, "a.txt", 10).await.unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].oid, oid);
    let blame = core.blame(s, "a.txt", None, false).await.unwrap();
    assert_eq!(blame.len(), 2);
    assert_eq!(blame[1].oid, oid);
    core.close_repo(s).unwrap();
}

/// 충돌 목록 → 해결 저장이 가벼운 세션에서 된다 (rebase 중 충돌)
#[tokio::test]
async fn conflicts_resolve_on_light_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.prepare_conflict();
    a.begin_rebase_conflict();
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    assert!(opened.state.op.is_some(), "rebase 중이어야 한다");

    let conflicts = core.conflicts(s).await.unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].path, "conflict.txt");
    core.resolve_file(s, "conflict.txt", b"line1\nMERGED\nline3\n", false)
        .await
        .unwrap();
    assert!(core.conflicts(s).await.unwrap().is_empty());
    assert_eq!(a.read_file("conflict.txt"), "line1\nMERGED\nline3\n");
    core.close_repo(s).unwrap();
}

/// 작업 트리 감시: 가벼운 세션도 파일을 바꾸면 상태 이벤트가 온다. 그 세션의 stage·commit 은 폴더
/// 감시(`FolderChanged`)도 알린다. 작업 트리만 바꾸는 쓰기(untracked 버리기)는 `.git` 을 건드리지 않아
/// 폴더 감시가 모른다 — 세션의 `StatusChanged` 만 온다 (알려진 빈틈, 프런트가 이어 줘야 한다)
#[tokio::test]
async fn light_sessions_watch_the_work_tree_and_folder_sees_their_writes() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let core = core_watching_with(CoreConfig::default()).await;
    let (fsink, mut frx) = collector();
    let fid = core.open_folder(&root, fsink).await.unwrap().session;
    let (opened, mut rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    tokio::time::sleep(Duration::from_millis(400)).await;
    drain(&mut rx);
    drain(&mut frx);

    a.write_file("w.txt", "w\n");
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::StatusChanged { session, status, .. }
            if *session == s && status.entries.iter().any(|x| x.path == "w.txt"))
    })
    .await;

    core.stage(s, &["w.txt".into()]).await.unwrap();
    wait_for(
        &mut frx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::FolderChanged { repo: Some(r), .. } if r == &path_a),
    )
    .await;
    core.commit(s, commit_spec("watched"), None).await.unwrap();
    wait_for(
        &mut frx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::FolderChanged { refs: true, repo: Some(r), .. } if r == &path_a),
    )
    .await;

    // untracked 파일을 버린다: 세션은 알지만 폴더 감시는 모른다
    a.write_file("tmp.txt", "t\n");
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::StatusChanged { status, .. }
            if status.entries.iter().any(|x| x.path == "tmp.txt"))
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    drain(&mut frx);
    core.discard(s, &["tmp.txt".into()]).await.unwrap();
    assert!(core.repo_state(s).unwrap().status.entries.is_empty());
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        !drain(&mut frx)
            .iter()
            .any(|e| matches!(e, CoreEvent::FolderChanged { .. })),
        "작업 트리만 바뀐 쓰기는 폴더 감시에 걸리지 않는다"
    );
    core.close_folder(fid).unwrap();
}

// ── 폴더에서 열기 ──────────────────────────────────────────────────────────────

/// 폴더의 저장소 목록에 없는 경로는 git 을 돌리기 전에 거부한다 (FS-11): 폴더 밖, 없는 경로, 폴더 자신,
/// 저장소 안의 하위 폴더. 모르는 폴더 id 는 `SessionNotFound`
#[tokio::test]
async fn paths_outside_the_folder_roster_are_refused_before_git() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let _a = repo_at(&path_a);
    std::fs::create_dir(path_a.join("src")).unwrap();
    let outside_dir = tempfile::tempdir().unwrap();
    let outside = root_of(&outside_dir).join("x");
    let _x = repo_at(&outside);
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;

    let before = core.command_log_recent(usize::MAX).len();
    for bad in [
        outside.clone(),
        root.join("nope"),
        root.clone(),
        path_a.join("src"),
    ] {
        let (sink, _rx) = collector();
        let err = core
            .folder_open_repo_session(fid, &bad, sink)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad:?}: {err:?}");
    }
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        before,
        "거부는 git 을 돌리기 전이어야 한다"
    );
    assert!(core.sessions().is_empty());
    let (sink, _rx) = collector();
    assert!(matches!(
        core.folder_open_repo_session(SessionId(9999), &path_a, sink)
            .await,
        Err(CoreError::SessionNotFound(SessionId(9999)))
    ));
}

/// 워크트리 저장소는 원 저장소가 아니라 그 워크트리 자신의 작업 트리로 열린다 (status 가 다르다).
/// 원 저장소와는 다른 세션이다
#[tokio::test]
async fn worktree_opens_its_own_work_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let path_wt = root.join("a-wt");
    a.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt",
        &path_wt.to_string_lossy(),
    ]);
    std::fs::write(path_wt.join("only-in-wt.txt"), "x\n").unwrap();
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;

    let (wt, _rx) = open_light(&core, fid, &path_wt).await;
    assert_eq!(wt.info.work_tree, path_wt);
    assert!(
        wt.info.git_dir.ends_with(".git/worktrees/a-wt"),
        "{:?}",
        wt.info.git_dir
    );
    assert_eq!(
        wt.info.common_dir.canonicalize().unwrap(),
        path_a.join(".git")
    );
    assert!(
        wt.state
            .refs
            .head
            .branch()
            .is_some_and(|b| b.ends_with("wt"))
    );
    let paths: Vec<&str> = wt
        .state
        .status
        .entries
        .iter()
        .map(|e| e.path.as_str())
        .collect();
    assert_eq!(paths, vec!["only-in-wt.txt"]);

    let (main, _rx) = open_light(&core, fid, &path_a).await;
    assert_ne!(main.session, wt.session);
    assert!(main.state.status.entries.is_empty());
}

/// 작업 트리당 세션 하나: 같은 저장소를 두 번 열면 같은 세션, 이미 탭으로 열린 저장소를 폴더에서 열면 그
/// 탭의 전체 세션(잡지 않음 — 상한에 세지 않는다)
#[tokio::test]
async fn one_session_per_work_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let paths: Vec<PathBuf> = ["a", "b", "c", "d"].iter().map(|n| root.join(n)).collect();
    let _repos: Vec<TestRepo> = paths.iter().map(|p| repo_at(p)).collect();
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;

    let (first, _rx) = open_light(&core, fid, &paths[0]).await;
    let (again, _rx2) = open_light(&core, fid, &paths[0]).await;
    assert_eq!(again.session, first.session);
    assert!(again.already_open);
    assert_eq!(again.profile, SessionProfile::Light);
    assert_eq!(core.sessions(), vec![first.session]);

    let (sink, mut rx) = collector();
    let tab = core.open_repo(&paths[1], sink).await.unwrap();
    wait_finished(&mut rx, tab.session).await;
    let (borrowed, mut rx3) = open_light(&core, fid, &paths[1]).await;
    assert_eq!(borrowed.session, tab.session);
    assert!(borrowed.already_open && !borrowed.promoted);
    assert_eq!(borrowed.profile, SessionProfile::Full);
    // 폴더의 빌리기는 탭의 이벤트 채널을 가져가지 않습니다.
    core.reload_graph(tab.session).unwrap();
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphReloaded { .. })
    })
    .await;
    assert!(!drain(&mut rx3).iter().any(is_graph_event));
    // 탭의 세션은 세지 않으므로 a 에 더해 둘을 더 열 수 있다
    open_light(&core, fid, &paths[2]).await;
    open_light(&core, fid, &paths[3]).await;
    assert_eq!(core.sessions().len(), 4);
}

/// 같은 작업 트리를 폴더 열기와 탭 열기가 동시에 열어도 세션은 하나다 (확인과 등록 사이의 경합)
#[tokio::test]
async fn concurrent_light_and_tab_opens_make_one_session() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let _a = repo_at(&path_a);
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    for _ in 0..5 {
        let (s1, _r1) = collector();
        let (s2, _r2) = collector();
        let (light, tab) = tokio::join!(
            core.folder_open_repo_session(fid, &path_a, s1),
            core.open_repo(&path_a, s2),
        );
        let (light, tab) = (light.unwrap(), tab.unwrap());
        assert_eq!(light.session, tab.session);
        assert_eq!(core.sessions(), vec![tab.session]);
        assert_eq!(
            core.session_profile(tab.session).unwrap(),
            SessionProfile::Full
        );
        core.close_repo(tab.session).unwrap();
    }
}

// ── 승격 ───────────────────────────────────────────────────────────────────────

/// 승격과 세션 쓰기가 겹쳐도 엉키지 않는다: 쓰기는 끝나고, 초기 로드가 끝나고, 그 뒤의 ref 변경은 다시
/// 그래프 재로드로 이어진다 (재로드 상태가 "도는 중"으로 남지 않는다)
#[tokio::test]
async fn promotion_while_writing_keeps_reloads_working() {
    for round in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        let path_a = root.join("a");
        let mut a = repo_at(&path_a);
        let core = core_with(CoreConfig::default()).await;
        let fid = open_folder(&core, &root).await;
        let (opened, _rx) = open_light(&core, fid, &path_a).await;
        let s = opened.session;
        a.write_file("x.txt", &format!("{round}\n"));
        core.stage(s, &["x.txt".into()]).await.unwrap();

        let (sink, mut rx) = collector();
        let (committed, promoted) = tokio::join!(
            core.commit(s, commit_spec("during promotion"), None),
            core.open_repo(&path_a, sink),
        );
        let committed = committed.unwrap();
        let promoted = promoted.unwrap();
        assert!(promoted.promoted);
        wait_finished(&mut rx, s).await;

        // 승격 뒤 ref 를 바꾸면 재로드가 온다
        a.write_file("y.txt", "y\n");
        core.stage(s, &["y.txt".into()]).await.unwrap();
        let after = core
            .commit(s, commit_spec("after promotion"), None)
            .await
            .unwrap();
        wait_for(&mut rx, Duration::from_secs(10), |e| {
            matches!(e, CoreEvent::GraphReloaded { .. })
        })
        .await;
        // 마지막 재로드가 끝날 때까지 기다린 뒤 맨 위 행이 HEAD 다
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let w = core.graph_window(s, 0, 5).unwrap();
            if w.finished && w.rows.first().map(|r| r.oid) == Some(after) {
                assert!(w.rows.iter().any(|r| r.oid == committed));
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "재로드가 멈췄다");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        core.verify_layout(s).unwrap();
        // 승격한 세션은 다시 가볍게 열리지 않는다
        let (back, _rx2) = open_light(&core, fid, &path_a).await;
        assert_eq!(back.profile, SessionProfile::Full);
        core.close_repo(s).unwrap();
    }
}

// ── 상한 ───────────────────────────────────────────────────────────────────────

/// 한 폴더의 가벼운 세션은 3개까지. 4번째는 열지 않고 `LightSessionLimit`(지금 잡은 세션 목록 포함).
/// 하나를 내려놓으면 다시 열린다. 승격된 세션·닫힌 세션은 세지 않는다
#[tokio::test]
async fn light_sessions_are_capped_per_folder() {
    assert_eq!(LIGHT_SESSIONS_PER_FOLDER, 3);
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let paths: Vec<PathBuf> = ["a", "b", "c", "d", "e"]
        .iter()
        .map(|n| root.join(n))
        .collect();
    let _repos: Vec<TestRepo> = paths.iter().map(|p| repo_at(p)).collect();
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let mut ids = Vec::new();
    for p in &paths[..3] {
        ids.push(open_light(&core, fid, p).await.0.session);
    }
    let before = core.command_log_recent(usize::MAX).len();
    let (sink, _rx) = collector();
    let err = core
        .folder_open_repo_session(fid, &paths[3], sink)
        .await
        .unwrap_err();
    match err {
        CoreError::LightSessionLimit { limit, sessions } => {
            assert_eq!(limit, 3);
            assert_eq!(sessions, ids);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        before,
        "상한 거부는 git 을 돌리기 전이다"
    );
    assert_eq!(core.sessions().len(), 3);

    // 내려놓으면 다시 열린다
    let r = core.folder_release_repo_session(fid, ids[0]);
    assert!(r.released);
    assert_eq!(r.profile, None);
    let d = open_light(&core, fid, &paths[3]).await.0.session;

    // 승격한 세션은 세지 않는다: b 를 탭으로 올리면 하나 더 열 수 있다
    let (sink, _rx) = collector();
    core.open_repo(&paths[1], sink).await.unwrap();
    let e = open_light(&core, fid, &paths[4]).await.0.session;
    let (sink, _rx) = collector();
    let full = core
        .folder_open_repo_session(fid, &paths[0], sink)
        .await
        .unwrap_err();
    assert!(
        matches!(&full, CoreError::LightSessionLimit { sessions, .. } if *sessions == vec![ids[2], d, e]),
        "{full:?}"
    );

    // close_repo 로 닫힌 세션도 세지 않는다
    core.close_repo(ids[2]).unwrap();
    open_light(&core, fid, &paths[0]).await;
}

/// 승격된 세션의 끝: 탭이 `close_repo` 로 닫으면 끝이고, 그 저장소를 쓰던 폴더는 다음에 필요할 때 가벼운
/// 세션을 새로 연다. 닫힌 세션은 어느 폴더의 상한 집계에도 남지 않는다
#[tokio::test]
async fn closed_promoted_session_leaves_no_trace_in_folder_limits() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let paths: Vec<PathBuf> = ["a", "b", "c", "d"].iter().map(|n| root.join(n)).collect();
    let _repos: Vec<TestRepo> = paths.iter().map(|p| repo_at(p)).collect();
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (light, _rx) = open_light(&core, fid, &paths[0]).await;
    let (sink, mut rx) = collector();
    let tab = core.open_repo(&paths[0], sink).await.unwrap();
    assert_eq!(tab.session, light.session);
    wait_finished(&mut rx, tab.session).await;
    // 승격된 세션의 해제는 아무것도 하지 않는다 (탭의 것)
    let r = core.folder_release_repo_session(fid, tab.session);
    assert!(!r.released);
    assert_eq!(r.profile, Some(SessionProfile::Full));
    assert_eq!(core.sessions(), vec![tab.session]);

    core.close_repo(tab.session).unwrap();
    assert!(matches!(
        core.repo_state(tab.session),
        Err(CoreError::SessionNotFound(_))
    ));
    let (reopened, _rx2) = open_light(&core, fid, &paths[0]).await;
    assert_ne!(reopened.session, tab.session);
    assert!(!reopened.already_open);
    assert_eq!(reopened.profile, SessionProfile::Light);
    let b = open_light(&core, fid, &paths[1]).await.0.session;
    let c = open_light(&core, fid, &paths[2]).await.0.session;
    let (sink, _rx3) = collector();
    match core
        .folder_open_repo_session(fid, &paths[3], sink)
        .await
        .unwrap_err()
    {
        CoreError::LightSessionLimit { sessions, .. } => {
            assert_eq!(sessions, vec![reopened.session, b, c]);
        }
        other => panic!("{other:?}"),
    }
}

// ── 해제·닫기 ──────────────────────────────────────────────────────────────────

/// `close_folder` 는 그 폴더만 잡은 가벼운 세션을 닫고, 승격된 세션과 다른 폴더도 잡은 세션은 둔다.
/// 닫힌 id 는 `SessionNotFound` 이고, 해제·`close_folder` 는 이미 닫힌 세션이 섞여도 오류 없이 끝난다
#[tokio::test]
async fn close_folder_closes_its_light_sessions_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    // a 는 두 폴더(root, root/group) 모두의 저장소다
    let path_a = root.join("group").join("a");
    let path_b = root.join("b");
    let path_c = root.join("c");
    let path_d = root.join("d");
    let _repos: Vec<TestRepo> = [&path_a, &path_b, &path_c, &path_d]
        .iter()
        .map(|p| repo_at(p))
        .collect();
    let core = core_with(CoreConfig::default()).await;
    let f1 = open_folder(&core, &root).await;
    let f2 = open_folder(&core, &root.join("group")).await;

    let a = open_light(&core, f1, &path_a).await.0.session;
    let shared = open_light(&core, f2, &path_a).await.0;
    assert_eq!(shared.session, a);
    assert!(shared.already_open);
    // b 는 승격(상한에서 빠진다), c 는 미리 닫힘
    let b = open_light(&core, f1, &path_b).await.0.session;
    let (sink, _rx) = collector();
    core.open_repo(&path_b, sink).await.unwrap();
    let c = open_light(&core, f1, &path_c).await.0.session;
    let d = open_light(&core, f1, &path_d).await.0.session;
    core.close_repo(c).unwrap();

    core.close_folder(f1).unwrap();
    assert_eq!(core.session_profile(a).unwrap(), SessionProfile::Light);
    assert_eq!(core.session_profile(b).unwrap(), SessionProfile::Full);
    for gone in [c, d] {
        assert!(matches!(
            core.repo_state(gone),
            Err(CoreError::SessionNotFound(_))
        ));
        // 이중 닫힘: close_repo 는 기존대로 SessionNotFound, 해제는 같은 모양의 결과
        assert!(matches!(
            core.close_repo(gone),
            Err(CoreError::SessionNotFound(_))
        ));
        let r = core.folder_release_repo_session(f1, gone);
        assert!(!r.released && r.profile.is_none());
    }
    // f1 이 이미 닫혔어도 해제는 할 일이 없을 뿐이다
    let r = core.folder_release_repo_session(f1, a);
    assert!(!r.released);
    assert_eq!(r.profile, Some(SessionProfile::Light));

    core.close_folder(f2).unwrap();
    assert!(matches!(
        core.repo_state(a),
        Err(CoreError::SessionNotFound(_))
    ));
    assert_eq!(core.sessions(), vec![b]);
    assert!(matches!(
        core.close_folder(f2),
        Err(CoreError::SessionNotFound(_))
    ));
}

/// 해제가 세션을 닫으면 감시도 내려간다: 그 뒤 파일을 바꿔도 이벤트가 오지 않는다
#[tokio::test]
async fn closing_a_light_session_stops_its_watch() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let core = core_watching_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, mut rx) = open_light(&core, fid, &path_a).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    a.write_file("before.txt", "x\n");
    wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::StatusChanged { .. })
    })
    .await;

    let r = core.folder_release_repo_session(fid, opened.session);
    assert!(r.released && r.profile.is_none());
    tokio::time::sleep(Duration::from_millis(300)).await;
    drain(&mut rx);
    a.write_file("after.txt", "y\n");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(
        !drain(&mut rx)
            .iter()
            .any(|e| matches!(e, CoreEvent::StatusChanged { .. })),
        "닫은 세션의 감시가 남아 있다"
    );
}

/// 실행 중인 쓰기가 있을 때 해제(마지막 잡음)하면 `close_repo` 와 같다:
/// 등록되지 않은 쓰기(op 없는 commit)는 git 이 끝까지 돌아 커밋은 남지만, API 는 세션이 사라져
/// `SessionNotFound` 로 끝난다. 등록된 장시간 명령(op 있음)은 취소된다
#[cfg(unix)]
#[tokio::test]
async fn releasing_during_a_write_behaves_like_close_repo() {
    for registered in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        let path_a = root.join("a");
        let mut a = repo_at(&path_a);
        let started = root.join("hook.started");
        a.install_hook(
            "pre-commit",
            &format!("#!/bin/sh\ntouch '{}'\nsleep 2\n", started.display()),
        );
        a.write_file("x.txt", "x\n");
        let before = a.head();
        let core = Arc::new(core_with(CoreConfig::default()).await);
        let fid = open_folder(&core, &root).await;
        let (opened, _rx) = open_light(&core, fid, &path_a).await;
        let s = opened.session;
        core.stage(s, &["x.txt".into()]).await.unwrap();
        let op = registered.then(|| core.begin_operation(s, "commit", "commit").unwrap());
        let task = {
            let core = Arc::clone(&core);
            tokio::spawn(async move { core.commit(s, commit_spec("slow"), op).await })
        };
        wait_file(&started, Duration::from_secs(10)).await;
        let r = core.folder_release_repo_session(fid, s);
        assert!(r.released && r.profile.is_none());
        let result = tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .unwrap()
            .unwrap();
        if registered {
            assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
            assert_eq!(a.head(), before, "취소된 커밋이 남았다");
        } else {
            assert!(
                matches!(result, Err(CoreError::SessionNotFound(id)) if id == s),
                "{result:?}"
            );
            assert_ne!(a.head(), before, "등록되지 않은 쓰기는 끝까지 돈다");
        }
    }
}

// ── 일괄 작업 잠금 ─────────────────────────────────────────────────────────────

/// 일괄 작업은 그 저장소의 쓰기 잠금을 잡는다: 세션의 쓰기(느린 pre-commit 훅이 도는 commit)가 끝난
/// 뒤에야 일괄 작업의 status·branch 가 돈다
#[cfg(unix)]
#[tokio::test]
async fn batch_waits_for_a_session_write_on_the_same_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let started = root.join("hook.started");
    a.install_hook(
        "pre-commit",
        &format!("#!/bin/sh\ntouch '{}'\nsleep 1\n", started.display()),
    );
    a.write_file("x.txt", "x\n");
    let core = Arc::new(core_with(CoreConfig::default()).await);
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    core.stage(s, &["x.txt".into()]).await.unwrap();
    let commit = {
        let core = Arc::clone(&core);
        tokio::spawn(async move { core.commit(s, commit_spec("slow"), None).await })
    };
    wait_file(&started, Duration::from_secs(10)).await;
    let called_at = now_ms();
    let batch = tokio::time::timeout(
        Duration::from_secs(20),
        core.folder_batch(
            fid,
            BatchOp::CreateBranch {
                name: "topic".into(),
                checkout: false,
                start_point: None,
            },
            std::slice::from_ref(&path_a),
        ),
    )
    .await
    .expect("교착 없이 끝나야 한다")
    .unwrap();
    assert_eq!(batch.failed, 0, "{batch:?}");
    commit.await.unwrap().unwrap();

    let commit_cmd = commands_in(&core, &path_a, "commit").pop().unwrap();
    let commit_end = commit_cmd.started_at + i64::from(commit_cmd.elapsed_ms);
    assert!(
        called_at < commit_end,
        "일괄 작업은 commit 이 도는 중에 불렸다"
    );
    let branch_cmd = commands_in(&core, &path_a, "branch").pop().unwrap();
    let batch_status = commands_in(&core, &path_a, "status")
        .into_iter()
        .filter(|r| r.started_at >= called_at)
        .min_by_key(|r| r.started_at)
        .unwrap();
    assert!(
        batch_status.started_at >= commit_end && branch_cmd.started_at >= commit_end,
        "일괄 작업이 세션 쓰기와 겹쳤다: commit 끝 {commit_end}, status {}, branch {}",
        batch_status.started_at,
        branch_cmd.started_at
    );
}

/// 반대 방향: 일괄 작업이 잠금을 쥔 동안(느린 post-checkout 훅) 세션의 쓰기는 기다린다
#[cfg(unix)]
#[tokio::test]
async fn session_write_waits_for_a_batch_on_the_same_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let started = root.join("hook.started");
    a.install_hook(
        "post-checkout",
        &format!("#!/bin/sh\ntouch '{}'\nsleep 1\n", started.display()),
    );
    let core = Arc::new(core_with(CoreConfig::default()).await);
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    let batch = {
        let core = Arc::clone(&core);
        let target = vec![path_a.clone()];
        tokio::spawn(async move {
            core.folder_batch(
                fid,
                BatchOp::CreateBranch {
                    name: "topic".into(),
                    checkout: true,
                    start_point: None,
                },
                &target,
            )
            .await
        })
    };
    wait_file(&started, Duration::from_secs(10)).await;
    a.write_file("x.txt", "x\n");
    let called_at = now_ms();
    tokio::time::timeout(Duration::from_secs(20), core.stage(s, &["x.txt".into()]))
        .await
        .expect("교착 없이 끝나야 한다")
        .unwrap();
    let result = batch.await.unwrap().unwrap();
    assert_eq!(result.failed, 0, "{result:?}");

    let checkout = commands_in(&core, &path_a, "checkout").pop().unwrap();
    let checkout_end = checkout.started_at + i64::from(checkout.elapsed_ms);
    assert!(
        called_at < checkout_end,
        "stage 는 일괄 checkout 이 도는 중에 불렸다"
    );
    let add = commands_in(&core, &path_a, "add").pop().unwrap();
    assert!(
        add.started_at >= checkout_end,
        "세션 쓰기가 일괄 작업과 겹쳤다: checkout 끝 {checkout_end}, add {}",
        add.started_at
    );
}

/// 같은 저장소의 워크트리 둘(같은 잠금)이 한 일괄에 들어도, 세션이 없는 저장소와 함께여도 시간 안에 끝난다
#[tokio::test]
async fn batch_over_worktrees_of_one_repo_does_not_deadlock() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let path_wt = root.join("a-wt");
    a.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt",
        &path_wt.to_string_lossy(),
    ]);
    let _b = repo_at(&root.join("b"));
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    // a 에는 가벼운 세션, 워크트리와 b 에는 세션이 없다
    open_light(&core, fid, &path_a).await;
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        core.folder_batch(fid, BatchOp::Fetch { prune: false }, &[]),
    )
    .await
    .expect("교착 없이 끝나야 한다")
    .unwrap();
    assert_eq!(result.results.len(), 3, "{result:?}");
    assert_eq!(result.failed, 0, "{result:?}");
}

// ── FS-12: 저장소 설정이 실행시키는 명령 ───────────────────────────────────────

/// 가벼운 세션을 열고 갱신해도 `core.fsmonitor` 에 적힌 프로그램이 돌지 않는다. 같은 저장소를 탭(전체
/// 프로필)으로 열면 도는 대조군으로, 이 시험이 실제로 그 통로를 본다는 것을 보인다. 사용자가 시킨 쓰기
/// (`git add`)는 범위 밖이라 설정대로 돈다는 것도 함께 고정한다
#[cfg(unix)]
#[tokio::test]
async fn light_session_does_not_run_repo_fsmonitor() {
    let dir = tempfile::tempdir().unwrap();
    let scripts = tempfile::tempdir().unwrap();
    let (script, marker) = marker_script(scripts.path(), "fsmonitor");
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.git_ok(["config", "core.fsmonitor", &script.to_string_lossy()]);
    // 사전 조건: 일반 git status 라면 이 설정이 실행된다
    a.git_ok(["status", "--porcelain"]);
    assert!(
        marker.exists(),
        "fsmonitor 설정이 실제로 동작해야 시험이 된다"
    );
    std::fs::remove_file(&marker).unwrap();

    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    assert!(!marker.exists(), "가벼운 세션 열기가 fsmonitor 를 실행했다");
    a.write_file("x.txt", "x\n");
    core.refresh(s).await.unwrap();
    assert_eq!(core.repo_state(s).unwrap().status.entries.len(), 1);
    assert!(!marker.exists(), "가벼운 세션 갱신이 fsmonitor 를 실행했다");
    let status = commands_in(&core, &path_a, "status");
    assert_eq!(status.len(), 2, "{status:?}");
    assert!(
        status
            .iter()
            .all(|r| r.args.iter().any(|x| x == "core.fsmonitor=false")),
        "{status:?}"
    );
    // 범위 밖(관찰): 사용자가 시킨 쓰기(`git add`)는 탭과 같이 저장소 설정대로 돈다 — 쓰기는 훅도 돌린다
    core.stage(s, &["x.txt".into()]).await.unwrap();
    assert!(
        marker.exists(),
        "stage(git add) 는 fsmonitor 를 따른다 (FS-12 범위 밖)"
    );
    std::fs::remove_file(&marker).unwrap();
    core.refresh(s).await.unwrap();
    assert!(!marker.exists(), "쓰기 뒤 갱신도 fsmonitor 를 끈다");

    // 대조군: 탭으로 승격하면 전체 프로필의 status 가 그 설정대로 돈다
    let (sink, _rx2) = collector();
    core.open_repo(&path_a, sink).await.unwrap();
    core.refresh(s).await.unwrap();
    assert!(
        marker.exists(),
        "전체 프로필은 저장소 설정의 fsmonitor 를 따른다"
    );
}

/// 가벼운 세션의 status 는 index 를 다시 쓰지 않으므로(`GIT_OPTIONAL_LOCKS=0`) index 를 쓸 때 도는
/// `post-index-change` 훅이 돌지 않는다. 전체 프로필의 사용자 새로고침은 index 를 써서 훅이 도는 대조군
#[cfg(unix)]
#[tokio::test]
async fn light_session_status_does_not_run_post_index_change_hook() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let marker = root.join("hook.ran");
    a.install_hook(
        "post-index-change",
        &format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    );
    /// 내용은 같고 시각만 다르게 다시 써서 index 의 stat 정보를 낡게 만든다
    fn stale_index(a: &mut TestRepo) {
        std::thread::sleep(Duration::from_millis(20));
        a.write_file("a.txt", "a\n");
    }
    stale_index(&mut a);
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    let s = opened.session;
    core.refresh(s).await.unwrap();
    assert!(opened.state.status.entries.is_empty());
    assert!(
        !marker.exists(),
        "가벼운 세션의 status 가 index 를 다시 썼다"
    );

    // 대조군: 탭으로 승격한 뒤의 사용자 새로고침은 index 를 갱신해 훅이 돈다
    let (sink, _rx2) = collector();
    core.open_repo(&path_a, sink).await.unwrap();
    stale_index(&mut a);
    core.refresh(s).await.unwrap();
    assert!(
        marker.exists(),
        "전체 프로필의 새로고침은 index 를 쓴다 (대조군)"
    );
}

/// 알려진 한계: gitattributes 의 clean 필터(`filter.<이름>.clean`)는 가벼운 세션의 status 에서도 돈다.
/// 내용을 비교하려면 필터가 필요하고(끄면 git-lfs 저장소의 파일이 모두 수정됨으로 보인다) fsmonitor 처럼 끌
/// 수 없다. 이 시험은 그 동작을 고정해 둔다 — 바뀌면 보고서의 FS-12 범위를 다시 본다
#[cfg(unix)]
#[tokio::test]
async fn light_session_status_still_runs_clean_filters_known_limit() {
    let dir = tempfile::tempdir().unwrap();
    let scripts = tempfile::tempdir().unwrap();
    let (script, marker) = marker_script(scripts.path(), "clean");
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.git_ok(["config", "filter.mark.clean", &script.to_string_lossy()]);
    a.write_file(".gitattributes", "*.dat filter=mark\n");
    a.write_file("f.dat", "data\n");
    a.stage(&[".gitattributes", "f.dat"]);
    a.commit_staged("filtered");
    let _ = std::fs::remove_file(&marker);
    // 내용은 같고 시각만 바꿔 git 이 내용을 다시 비교(= clean 필터 실행)하게 한다
    std::thread::sleep(Duration::from_millis(20));
    a.write_file("f.dat", "data\n");

    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    let (opened, _rx) = open_light(&core, fid, &path_a).await;
    assert!(
        opened.state.status.entries.is_empty(),
        "{:?}",
        opened.state.status
    );
    assert!(
        marker.exists(),
        "clean 필터가 돌지 않았다면 FS-12 보고(남은 통로)를 고쳐야 한다"
    );
}

/// `GitError::NotARepository` 는 목록에 있던 경로가 더는 저장소 최상위가 아닐 때다 (엉뚱한 상위 저장소에
/// 쓰지 않는다): 폴더가 다른 저장소 안에 있고 하위 저장소의 `.git` 이 지워진 경우
#[tokio::test]
async fn stale_roster_entry_inside_a_parent_repo_is_not_opened_as_the_parent() {
    let dir = tempfile::tempdir().unwrap();
    let outer = root_of(&dir);
    let _parent = repo_at(&outer);
    let root = outer.join("repos");
    let path_a = root.join("a");
    let _a = repo_at(&path_a);
    let core = core_with(CoreConfig::default()).await;
    let fid = open_folder(&core, &root).await;
    // 폴더를 연 뒤 a 의 `.git` 이 사라진다 (재스캔 전이라 목록에는 남아 있다)
    std::fs::remove_dir_all(path_a.join(".git")).unwrap();
    let (sink, _rx) = collector();
    let err = core
        .folder_open_repo_session(fid, &path_a, sink)
        .await
        .unwrap_err();
    assert!(
        matches!(err, CoreError::Git(GitError::NotARepository(_))),
        "{err:?}"
    );
    assert!(core.sessions().is_empty(), "상위 저장소를 열면 안 된다");
}
