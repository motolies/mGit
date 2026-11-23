//! 포함 브랜치의 "세션마다 마지막 요청만 살리기" (W18). 이력이 깊은 저장소에서 `for-each-ref --contains` 가 1초를
//! 넘을 때, 같은 세션(폴더면 폴더 세션)의 새 요청이 앞 요청의 git 을 끝내는지 실제 프로세스로 확인한다.
//! 느린 git 은 `--contains=<지정 커밋>` 일 때만 자기 pid 를 적고 오래 잠드는 가짜 git 으로 흉내 낸다 — 다른 호출은
//! 진짜 git 으로 넘기므로 저장소 열기·그래프 로드·다른 커밋의 포함 브랜치는 그대로 돈다
#![cfg(unix)]
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{collector, wait_finished};
use mgit_core::{Core, CoreConfig, CoreError, Oid, SessionId};
use mgit_git::{LocateConfig, RunnerConfig, TokioGitRunner};
use mgit_testkit::{Scenario, TestRepo, build};

/// 느린 요청이 끝나야 하는 상한. 시간 상한(10초)·가짜 git 의 잠(30초)보다 훨씬 짧다
const CANCEL_WITHIN: Duration = Duration::from_secs(5);

/// `--contains=<slow>` 호출만 자기 pid 를 `pid_file` 에 덧붙이고 30초 잠드는 가짜 git. 나머지는 진짜 git 으로 넘긴다
fn slow_contains_git(dir: &Path, real: &Path, pid_file: &Path, slow: &Oid) -> PathBuf {
    let script = dir.join("git");
    let body = format!(
        "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    --contains={}) echo $$ >> '{}'; exec sleep 30 ;;\n  esac\ndone\nexec '{}' \"$@\"\n",
        slow.to_hex(),
        pid_file.display(),
        real.display()
    );
    std::fs::write(&script, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

/// 가짜 git 을 쓰는 코어 (감시 없음)
async fn core_with_slow_git(dir: &Path, pid_file: &Path, slow: &Oid) -> Core {
    let real = TokioGitRunner::new(RunnerConfig::default())
        .await
        .unwrap()
        .git_path()
        .clone();
    let fake = slow_contains_git(dir, &real, pid_file, slow);
    let runner = TokioGitRunner::new(RunnerConfig {
        locate: LocateConfig {
            configured_path: Some(fake),
        },
        ..RunnerConfig::default()
    })
    .await
    .unwrap();
    Core::new(Arc::new(runner), CoreConfig::default())
}

/// 가짜 git 이 pid 를 적을 때까지 기다려 마지막 pid 를 돌려준다
async fn wait_pid(pid_file: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(pid_file)
            && let Some(pid) = text.lines().last().filter(|l| !l.trim().is_empty())
        {
            return pid.trim().to_string();
        }
        assert!(Instant::now() < deadline, "느린 git 이 시작되지 않음");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 프로세스가 돌고 있는지 (`ps` 의 상태). 없거나 끝나고 거두기만 기다리는 좀비(`Z`)면 거짓 — 버린 future 의 자식은
/// 러너의 kill-on-drop 으로 끝나지만 거두기는 tokio 가 나중에 하므로 `kill -0` 으로는 가를 수 없다
fn alive(pid: &str) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

/// 프로세스가 끝날 때까지 잠시 기다린다 (러너가 끝내고 거두는 데 걸리는 시간)
async fn wait_gone(pid: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 저장소 세션을 열고 그래프 로드가 끝날 때까지 기다린다
async fn open_session(core: &Core, path: &Path) -> SessionId {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(path, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    opened.session
}

/// 같은 저장소 세션에서 새 요청이 오면 도는 앞 요청의 git 이 곧 끝나고 앞 요청은 `Cancelled`, 새 요청은 결과를 낸다
#[tokio::test]
async fn a_newer_request_ends_the_older_git_in_the_same_session() {
    let mut repo = build(Scenario::Linear(3));
    let newest = repo.head();
    let oldest = Oid::from_hex(repo.git_ok(["rev-parse", "HEAD~2"]).trim().as_bytes()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let core = core_with_slow_git(dir.path(), &pid_file, &oldest).await;
    let session = open_session(&core, repo.path()).await;

    let started = Instant::now();
    let older = async {
        let r = core.commit_containing_refs(session, &oldest).await;
        (r, started.elapsed())
    };
    let newer = async {
        let pid = wait_pid(&pid_file).await;
        let r = core.commit_containing_refs(session, &newest).await;
        (r, pid)
    };
    let ((older, older_took), (newer, pid)) = tokio::join!(older, newer);
    assert!(
        matches!(older, Err(CoreError::Cancelled)),
        "앞 요청은 취소돼야 한다: {older:?}"
    );
    assert!(
        older_took < CANCEL_WITHIN,
        "앞 요청이 늦게 끝남: {older_took:?}"
    );
    let newer = newer.unwrap();
    assert!(!newer.timed_out && newer.head, "{newer:?}");
    assert!(wait_gone(&pid).await, "앞 요청의 git({pid}) 이 남아 돈다");
    // 취소로 끝난 명령이 명령 로그에 남는다
    assert!(
        core.command_log_recent(usize::MAX)
            .iter()
            .any(|r| r.cancelled && r.args.iter().any(|a| a.starts_with("--contains="))),
        "취소된 --contains 기록이 없다"
    );
}

/// 폴더는 폴더 세션 하나가 열쇠다: 다른 저장소의 새 요청도 앞 요청을 끝낸다 (상세 칸 하나가 차례로 묻는다)
#[tokio::test]
async fn folder_requests_end_each_other_across_repos() {
    let root = tempfile::tempdir().unwrap();
    let mut a = init_at(&root.path().join("a"));
    let slow = a.commit("a1");
    a.commit("a2");
    let mut b = init_at(&root.path().join("b"));
    let b_head = b.commit("b1");
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let core = core_with_slow_git(dir.path(), &pid_file, &slow).await;
    let (sink, _rx) = collector();
    let folder = core.open_folder(root.path(), sink).await.unwrap().session;
    let a_path = root.path().join("a");
    let b_path = root.path().join("b");

    let started = Instant::now();
    let older = async {
        let r = core
            .folder_commit_containing_refs(folder, &a_path, &slow)
            .await;
        (r, started.elapsed())
    };
    let newer = async {
        let pid = wait_pid(&pid_file).await;
        let r = core
            .folder_commit_containing_refs(folder, &b_path, &b_head)
            .await;
        (r, pid)
    };
    let ((older, older_took), (newer, pid)) = tokio::join!(older, newer);
    assert!(matches!(older, Err(CoreError::Cancelled)), "{older:?}");
    assert!(
        older_took < CANCEL_WITHIN,
        "앞 요청이 늦게 끝남: {older_took:?}"
    );
    let newer = newer.unwrap();
    assert!(newer.head && newer.branches.len() == 1, "{newer:?}");
    assert!(wait_gone(&pid).await, "앞 요청의 git({pid}) 이 남아 돈다");
}

/// 세션이 다르면 서로 끝내지 않는다. 호출자가 버린 요청은 자리를 비워 다음 요청이 밀린 것으로 오해하지 않는다
#[tokio::test]
async fn other_sessions_keep_running_and_dropped_requests_leave_no_slot() {
    let root = tempfile::tempdir().unwrap();
    let mut a = init_at(&root.path().join("a"));
    let slow = a.commit("a1");
    let a_head = a.commit("a2");
    let mut b = init_at(&root.path().join("b"));
    let b_head = b.commit("b1");
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let core = core_with_slow_git(dir.path(), &pid_file, &slow).await;
    let s1 = open_session(&core, &root.path().join("a")).await;
    let s2 = open_session(&core, &root.path().join("b")).await;

    // 나중에 버릴 수 있게 힙에 고정한다 (`tokio::pin!` 은 스코프 끝까지 future 를 쥔다)
    let mut older = Box::pin(core.commit_containing_refs(s1, &slow));
    let (newer, pid) = tokio::select! {
        biased;
        r = &mut older => panic!("다른 세션의 요청이 앞 요청을 끝냈다: {r:?}"),
        done = async {
            let pid = wait_pid(&pid_file).await;
            (core.commit_containing_refs(s2, &b_head).await, pid)
        } => done,
    };
    assert!(newer.unwrap().head);
    assert!(alive(&pid), "다른 세션의 git({pid}) 은 계속 돌아야 한다");

    // 호출자가 future 를 버리면 git 은 러너가 끝내고, 자리도 비워진다 — 같은 세션의 다음 요청은 정상 결과다
    drop(older);
    assert!(wait_gone(&pid).await, "버린 요청의 git({pid}) 이 남아 돈다");
    let next = core.commit_containing_refs(s1, &a_head).await.unwrap();
    assert!(next.head && !next.timed_out, "{next:?}");
}
