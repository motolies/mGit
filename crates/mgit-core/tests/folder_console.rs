//! 폴더 콘솔 (W19 ②, WS-12): 폴더의 저장소에서 돈 쓰기·네트워크 명령이 폴더 세션으로 `FolderCommandLogged` 가 되어
//! 간다. 일괄 fetch·폴더 stage·폴더 commit 이 저장소 경로와 함께 오고, 읽기 명령(요약·브랜치·변경·타임라인)은 오지
//! 않으며, 폴더 밖 저장소·닫힌 폴더·재스캔 전 목록에 없는 저장소의 명령도 오지 않는다. 워크트리에서 돈 명령은 원
//! 저장소로 오고, 같은 작업 트리의 저장소 세션에는 기존 `CommandLogged` 가 그대로 간다. 폴더 길의 기록도 자격 증명이
//! 가려져 있고 실패한 명령은 종료 코드·stderr 꼬리를 싣는다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{BatchOp, CommandLogRecord, Core, CoreEvent, IndexTarget, SessionId};
use mgit_testkit::TestRepo;
use tokio::sync::mpsc::UnboundedReceiver;

/// 비밀로 쓰는 글자 (이벤트 어디에도 나오면 안 된다)
const LEAK: &str = "SECRETTOKEN";

/// 폴더 안 경로에 커밋 하나(`a.txt`)짜리 저장소를 만든다
fn repo_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.write_file("a.txt", "a\n");
    r.stage(&["a.txt"]);
    r.commit_staged("first");
    r
}

/// 정규화한 임시 폴더 루트 (macOS 의 `/var` → `/private/var` 를 흡수해 이벤트의 경로와 비교할 수 있게)
fn root_of(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().unwrap()
}

/// 폴더를 연다 (이벤트 수신기 포함)
async fn open_folder(core: &Core, root: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, rx) = collector();
    (core.open_folder(root, sink).await.unwrap().session, rx)
}

/// 저장소 탭을 열고 첫 그래프 로드를 기다린다 (이벤트 수신기 포함)
async fn open_tab(core: &Core, path: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, mut rx) = collector();
    let session = core.open_repo(path, sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    drain(&mut rx);
    (session, rx)
}

/// 받은 이벤트를 다 꺼낸다
fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// 폴더 콘솔 이벤트만 (폴더 세션 id, 대표 경로, 기록)
fn folder_logs(events: &[CoreEvent]) -> Vec<(SessionId, PathBuf, CommandLogRecord)> {
    events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::FolderCommandLogged {
                session,
                repo,
                record,
            } => Some((*session, repo.clone(), record.clone())),
            _ => None,
        })
        .collect()
}

/// 저장소 세션의 명령 기록 이벤트만
fn session_logs(events: &[CoreEvent]) -> Vec<CommandLogRecord> {
    events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::CommandLogged { record, .. } => Some(record.clone()),
            _ => None,
        })
        .collect()
}

/// 기록의 서브커맨드 (전역 `-c` 인자 뒤의 첫 인자)
fn subcommand(record: &CommandLogRecord) -> &str {
    let mut args = record.args.iter();
    while let Some(a) = args.next() {
        if a == "-c" {
            args.next();
            continue;
        }
        return a;
    }
    ""
}

/// 폴더 콘솔 이벤트를 (대표 경로, 서브커맨드) 로 줄인다
fn brief(logs: &[(SessionId, PathBuf, CommandLogRecord)]) -> Vec<(PathBuf, String)> {
    let mut v: Vec<(PathBuf, String)> = logs
        .iter()
        .map(|(_, repo, r)| (repo.clone(), subcommand(r).to_string()))
        .collect();
    v.sort();
    v
}

/// 일괄 fetch·폴더 stage·폴더 commit 은 폴더 세션으로 저장소 경로와 함께 기록 이벤트를 보내고, 요약·브랜치·변경·
/// 타임라인을 읽는 명령은 (실제로 돌았어도) 보내지 않는다. 폴더 밖의 bare 원격에는 이벤트가 없다
#[tokio::test]
async fn folder_writes_reach_the_folder_console_and_reads_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let path_b = root.join("b");
    let mut a = repo_at(&path_a);
    a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    let mut b = repo_at(&path_b);
    b.write_file("new.txt", "n\n");
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    // 읽기: 요약·브랜치·변경·타임라인 — 명령은 돌지만 폴더 콘솔로는 오지 않는다
    let ran_before = core.command_log_recent(usize::MAX).len();
    core.folder_summaries(fid, &[]).await.unwrap();
    core.folder_branches(fid, &[]).await.unwrap();
    core.folder_changes(fid, &[]).await.unwrap();
    core.folder_timeline_open(fid).unwrap();
    let events = wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphLoadFinished { session, .. } if *session == fid),
    )
    .await;
    let reads = core.command_log_recent(usize::MAX);
    assert!(reads.len() > ran_before + 4, "읽기 명령이 돌았어야 한다");
    assert!(reads.iter().all(|r| !r.is_write), "{reads:?}");
    assert!(folder_logs(&events).is_empty(), "{events:?}");
    assert!(folder_logs(&drain(&mut rx)).is_empty());

    // 일괄 fetch: 저장소마다 한 줄, 성공, 대표 경로 = 목록의 그 저장소
    let r = core
        .folder_batch(fid, BatchOp::Fetch { prune: true }, &[])
        .await
        .unwrap();
    assert!(r.results.iter().all(|x| x.ok), "{r:?}");
    let logs = folder_logs(&drain(&mut rx));
    assert_eq!(
        brief(&logs),
        vec![
            (path_a.clone(), "fetch".to_string()),
            (path_b.clone(), "fetch".to_string())
        ]
    );
    for (session, repo, record) in &logs {
        assert_eq!(*session, fid);
        assert_eq!(&record.cwd, repo);
        assert!(record.is_write && !record.cancelled);
        assert_eq!(record.status, Some(0));
        assert!(record.args.iter().any(|x| x == "--prune"), "{record:?}");
    }

    // 폴더 stage: 그 저장소의 `add` 한 줄
    core.folder_stage(fid, &path_b, &IndexTarget::Paths(vec!["new.txt".into()]))
        .await
        .unwrap();
    let logs = folder_logs(&drain(&mut rx));
    assert_eq!(brief(&logs), vec![(path_b.clone(), "add".to_string())]);
    assert!(logs[0].2.args.iter().any(|x| x == "new.txt"));

    // 폴더 commit: 커밋한 저장소의 `commit` 한 줄 (stage 된 것이 없는 a 는 git 쓰기 없이 건너뛴다)
    let r = core
        .folder_commit(fid, &[], "feat: console", false)
        .await
        .unwrap();
    assert_eq!(r.succeeded, 1, "{r:?}");
    let logs = folder_logs(&drain(&mut rx));
    assert_eq!(brief(&logs), vec![(path_b.clone(), "commit".to_string())]);
    assert_eq!(logs[0].2.status, Some(0));
}

/// 워크트리에서 돈 명령은 목록의 대표(원 저장소) 경로로 온다. 실제 작업 디렉터리는 기록의 `cwd` 에 남는다
#[tokio::test]
async fn worktree_commands_come_to_the_primary_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let path_wt = root.join("a-wt");
    let mut a = repo_at(&path_a);
    a.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt",
        &path_wt.to_string_lossy(),
    ]);
    std::fs::write(path_wt.join("a.txt"), "changed in worktree\n").unwrap();
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    core.folder_stage(fid, &path_wt, &IndexTarget::All)
        .await
        .unwrap();
    let logs = folder_logs(&drain(&mut rx));
    assert_eq!(logs.len(), 1, "{logs:?}");
    let (session, repo, record) = &logs[0];
    assert_eq!(*session, fid);
    assert_eq!(repo, &path_a);
    assert_eq!(record.cwd, path_wt);
    assert_eq!(subcommand(record), "add");
}

/// 같은 저장소를 탭으로도 열었으면: 탭에서 쓴 명령도 폴더 콘솔로 오고(작업 디렉터리가 폴더의 저장소), 폴더 stage 는
/// 탭 세션에도 기존 `CommandLogged` 로 간다(같은 기록 id). 폴더 밖 저장소의 명령은 오지 않고, 폴더를 닫은 뒤에는
/// 아무것도 오지 않는다 (탭 세션에는 계속 간다)
#[tokio::test]
async fn tab_writes_reach_the_folder_but_outside_repos_and_closed_folders_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let elsewhere = tempfile::tempdir().unwrap();
    let mut outside = repo_at(&root_of(&elsewhere).join("o"));
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;
    let (tab_a, mut rx_a) = open_tab(&core, &path_a).await;
    let (tab_out, mut rx_out) = open_tab(&core, outside.path()).await;

    // 탭에서 stage → 폴더 콘솔에도 같은 기록
    a.write_file("t.txt", "t\n");
    core.stage(tab_a, &["t.txt".to_string()]).await.unwrap();
    let to_folder = folder_logs(&drain(&mut rx));
    assert_eq!(brief(&to_folder), vec![(path_a.clone(), "add".to_string())]);
    let to_tab = session_logs(&drain(&mut rx_a));
    assert!(
        to_tab.iter().any(|r| r.id == to_folder[0].2.id),
        "탭 세션에도 같은 기록이 가야 한다: {to_tab:?}"
    );

    // 폴더 stage → 탭 세션에도 기존 이벤트 (읽기 명령도 함께 — 저장소 세션의 콘솔은 그대로다)
    a.write_file("u.txt", "u\n");
    core.folder_stage(fid, &path_a, &IndexTarget::Paths(vec!["u.txt".into()]))
        .await
        .unwrap();
    let to_folder = folder_logs(&drain(&mut rx));
    assert_eq!(brief(&to_folder), vec![(path_a.clone(), "add".to_string())]);
    let to_tab = session_logs(&drain(&mut rx_a));
    assert!(to_tab.iter().any(|r| r.id == to_folder[0].2.id));
    assert!(
        to_tab.iter().any(|r| !r.is_write),
        "읽기 기록도 탭에는 간다"
    );

    // 폴더 밖 저장소의 쓰기는 폴더로 오지 않는다
    outside.write_file("o.txt", "o\n");
    core.stage(tab_out, &["o.txt".to_string()]).await.unwrap();
    assert!(!session_logs(&drain(&mut rx_out)).is_empty());
    assert!(folder_logs(&drain(&mut rx)).is_empty());

    // 폴더를 닫은 뒤에는 오지 않는다 (탭에는 계속 간다)
    core.close_folder(fid).unwrap();
    a.write_file("v.txt", "v\n");
    core.stage(tab_a, &["v.txt".to_string()]).await.unwrap();
    assert!(folder_logs(&drain(&mut rx)).is_empty());
    assert!(
        session_logs(&drain(&mut rx_a))
            .iter()
            .any(|r| r.is_write && subcommand(r) == "add")
    );
    core.close_repo(tab_a).unwrap();
    core.close_repo(tab_out).unwrap();
}

/// 재스캔 전에는 목록에 없는 새 저장소의 명령이 오지 않고, 재스캔 뒤에는 새 목록으로 찾아 온다
#[tokio::test]
async fn rescan_switches_the_console_to_the_new_roster() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    repo_at(&root.join("a"));
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    let path_c = root.join("c");
    let mut c = repo_at(&path_c);
    let (tab_c, _rx_c) = open_tab(&core, &path_c).await;
    c.write_file("x.txt", "x\n");
    core.stage(tab_c, &["x.txt".to_string()]).await.unwrap();
    assert!(folder_logs(&drain(&mut rx)).is_empty(), "재스캔 전 목록 밖");

    core.folder_rescan(fid).await.unwrap();
    drain(&mut rx);
    c.write_file("y.txt", "y\n");
    core.stage(tab_c, &["y.txt".to_string()]).await.unwrap();
    assert_eq!(
        brief(&folder_logs(&drain(&mut rx))),
        vec![(path_c.clone(), "add".to_string())]
    );
    core.close_repo(tab_c).unwrap();
}

/// 받은 태그를 남기지 않고 `stderr` 를 내며 실패하는 가짜 ssh 스크립트 (테스트 임시 폴더 안에 만든다)
#[cfg(unix)]
fn fake_ssh(dir: &Path, stderr: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("fake-ssh.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho '{stderr}' >&2\nexit 255\n"),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

/// 폴더 길로 가는 기록도 자격 증명이 가려져 있다: 실패한 일괄 fetch 의 stderr 꼬리(종료 코드 ≠ 0)와, 폴더가 연 가벼운
/// 세션에서 넣은 원격 URL 인자. 대조로 가린 꼴(`***@`)이 실제로 실려 있음을 함께 본다
#[cfg(unix)]
#[tokio::test]
async fn folder_console_records_are_masked_and_carry_failures() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake_ssh(dir.path(), "remote: see https://SECRETTOKEN@h/x");
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.git_ok([
        "remote",
        "add",
        "origin",
        "ssh://git@example.invalid/o/r.git",
    ]);
    a.git_ok(["config", "core.sshCommand", &script.to_string_lossy()]);
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    // 실패한 fetch: 종료 코드 ≠ 0, stderr 꼬리에 가린 URL
    let r = core
        .folder_batch(fid, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(r.failed, 1, "{r:?}");
    let logs = folder_logs(&drain(&mut rx));
    assert_eq!(logs.len(), 1, "{logs:?}");
    let (_, repo, record) = &logs[0];
    assert_eq!(repo, &path_a);
    assert_eq!(subcommand(record), "fetch");
    assert!(
        matches!(record.status, Some(code) if code != 0),
        "{record:?}"
    );
    assert!(!record.cancelled);
    assert!(
        record.stderr_tail.contains("https://***@h/x"),
        "{}",
        record.stderr_tail
    );
    let shown = format!("{logs:?}");
    assert!(!shown.contains(LEAK), "{shown}");

    // 가벼운 세션의 원격 추가: 인자의 URL 토큰이 가려진다
    let (sink, _light_rx) = collector();
    let light = core
        .folder_open_repo_session(fid, &path_a, sink)
        .await
        .unwrap()
        .session;
    drain(&mut rx);
    core.remote_add(light, "x", "https://SECRETTOKEN@h/a.git")
        .await
        .unwrap();
    let logs = folder_logs(&drain(&mut rx));
    assert_eq!(logs.len(), 1, "{logs:?}");
    assert_eq!(logs[0].1, path_a);
    assert!(
        logs[0].2.args.iter().any(|x| x == "https://***@h/a.git"),
        "{:?}",
        logs[0].2.args
    );
    let shown = format!("{logs:?}");
    assert!(!shown.contains(LEAK), "{shown}");
}
