//! 묶음 읽기 한도 (반응성 슬라이스 12): 묶음 읽기(`bulk_reads` 범위)가 따로 둔 한도를 채우고 있어도 사용자가 누른 읽기는
//! 기다리지 않고 시작하고, 묶음 읽기끼리는 그 한도를 넘지 않으며, 사용자가 누른 읽기는 전체 한도까지 쓴다. 취소·오류·버림 뒤에
//! permit 이 새지 않는다. 느린 git 은 `mgit-slow` 인자가 있으면 잠드는 가짜 git 으로 흉내 낸다
#![cfg(unix)]
#![allow(clippy::unwrap_used)]
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mgit_git::{LocateConfig, RunnerConfig, TokioGitRunner, bulk_reads, in_bulk_reads};
use mgit_model::{CancelToken, GitError, GitRequest, GitRunner};
use mgit_testkit::{Scenario, build};

/// 전체 읽기 한도와 묶음 읽기 한도 (작게 잡아 빨리 채운다)
const READS: usize = 3;
const BULK: usize = 2;
/// 느린 git 의 잠
const SLOW_SECS: u64 = 2;

/// `mgit-slow` 인자면 잠들고(`mgit-fail` 이면 실패로 끝나고), 아니면 진짜 git 으로 넘기는 가짜 git
fn fake_git(dir: &Path, real: &Path) -> PathBuf {
    let script = dir.join("git");
    let body = format!(
        "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    mgit-slow) exec sleep {SLOW_SECS} ;;\n    mgit-fail) exit 3 ;;\n  esac\ndone\nexec '{}' \"$@\"\n",
        real.display()
    );
    std::fs::write(&script, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

/// 가짜 git 을 쓰는 러너 (전체 `READS`, 묶음 `BULK`)
async fn runner(dir: &Path) -> Arc<TokioGitRunner> {
    let real = TokioGitRunner::new(RunnerConfig::default())
        .await
        .unwrap()
        .git_path()
        .clone();
    let fake = fake_git(dir, &real);
    Arc::new(
        TokioGitRunner::new(RunnerConfig {
            locate: LocateConfig {
                configured_path: Some(fake),
            },
            max_concurrent_reads: READS,
            max_concurrent_bulk_reads: BULK,
            ..RunnerConfig::default()
        })
        .await
        .unwrap(),
    )
}

/// 잠드는 요청
fn slow(cwd: &Path) -> GitRequest {
    GitRequest::new(cwd, ["mgit-slow"])
}

/// permit 이 `want` 가 될 때까지 기다린다 (명령이 시작·끝나는 사이). 넘기면 지금 값을 준다
async fn settle_permits(r: &TokioGitRunner, want: (usize, usize)) -> (usize, usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while r.available_read_permits() != want && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    r.available_read_permits()
}

#[tokio::test]
async fn interactive_read_starts_while_bulk_reads_fill_their_limit() {
    let dir = tempfile::tempdir().unwrap();
    let repo = build(Scenario::Linear(1));
    let r = runner(dir.path()).await;
    // 묶음 읽기 넷: 둘만 돌고 둘은 묶음 한도를 기다린다 (전체 한도는 쥐지 않는다)
    let mut bulk = Vec::new();
    for _ in 0..4 {
        let r = Arc::clone(&r);
        let cwd = repo.path().to_path_buf();
        bulk.push(tokio::spawn(bulk_reads(
            async move { r.run(slow(&cwd)).await },
        )));
    }
    assert_eq!(
        settle_permits(&r, (READS - BULK, 0)).await,
        (READS - BULK, 0)
    );

    // 사용자가 누른 읽기는 남은 칸에서 곧바로 돈다 (느린 묶음 읽기의 잠보다 훨씬 빨리)
    let t = Instant::now();
    let out = r
        .run(GitRequest::new(repo.path(), ["rev-parse", "HEAD"]))
        .await
        .unwrap();
    assert!(out.exit.success());
    assert!(
        t.elapsed() < Duration::from_secs(1),
        "묶음 읽기 뒤에 줄을 섰다: {:?}",
        t.elapsed()
    );
    for h in bulk {
        h.await.unwrap().unwrap();
    }
    assert_eq!(r.available_read_permits(), (READS, BULK));
}

#[tokio::test]
async fn interactive_reads_use_the_whole_limit() {
    let dir = tempfile::tempdir().unwrap();
    let repo = build(Scenario::Linear(1));
    let r = runner(dir.path()).await;
    let mut running = Vec::new();
    for _ in 0..READS {
        let r = Arc::clone(&r);
        let cwd = repo.path().to_path_buf();
        running.push(tokio::spawn(async move { r.run(slow(&cwd)).await }));
    }
    // 묶음 한도는 건드리지 않고 전체 한도를 다 쓴다
    assert_eq!(settle_permits(&r, (0, BULK)).await, (0, BULK));
    for h in running {
        h.await.unwrap().unwrap();
    }
    assert_eq!(r.available_read_permits(), (READS, BULK));
}

#[tokio::test]
async fn permits_come_back_after_errors_cancel_and_drop() {
    let dir = tempfile::tempdir().unwrap();
    let repo = build(Scenario::Linear(1));
    let r = runner(dir.path()).await;

    // 실패로 끝난 묶음 읽기 (종료 코드 3)
    let failed = bulk_reads(r.run(GitRequest::new(repo.path(), ["mgit-fail"])))
        .await
        .unwrap();
    assert_eq!(failed.exit.status, Some(3));
    // 실행하지 못한 묶음 읽기 (없는 작업 폴더)
    let spawn = bulk_reads(r.run(GitRequest::new("/nonexistent/mgit-bulk", ["status"]))).await;
    assert!(matches!(spawn, Err(GitError::Spawn(_))), "{spawn:?}");
    // 돌다가 취소된 묶음 읽기
    let cancel = CancelToken::new();
    let running = {
        let r = Arc::clone(&r);
        let req = slow(repo.path()).with_cancel(cancel.clone());
        tokio::spawn(bulk_reads(async move { r.run(req).await }))
    };
    settle_permits(&r, (READS - 1, BULK - 1)).await;
    cancel.cancel();
    assert!(matches!(running.await.unwrap(), Err(GitError::Cancelled)));
    // 묶음 한도를 기다리다 버려진 것과 돌다가 버려진 것
    let holders: Vec<_> = (0..BULK)
        .map(|_| {
            let r = Arc::clone(&r);
            let cwd = repo.path().to_path_buf();
            tokio::spawn(bulk_reads(async move { r.run(slow(&cwd)).await }))
        })
        .collect();
    settle_permits(&r, (READS - BULK, 0)).await;
    let waiting = {
        let r = Arc::clone(&r);
        let cwd = repo.path().to_path_buf();
        tokio::spawn(bulk_reads(async move { r.run(slow(&cwd)).await }))
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    waiting.abort();
    for h in holders {
        h.abort();
    }
    assert_eq!(
        settle_permits(&r, (READS, BULK)).await,
        (READS, BULK),
        "permit 이 새었다"
    );
}

#[tokio::test]
async fn bulk_scope_does_not_cross_spawn() {
    assert!(!in_bulk_reads());
    let (inside, spawned) = bulk_reads(async {
        let inside = in_bulk_reads();
        let spawned = tokio::spawn(async { in_bulk_reads() }).await.unwrap();
        (inside, spawned)
    })
    .await;
    assert!(inside, "범위 안");
    assert!(
        !spawned,
        "tokio::spawn 으로 넘긴 작업에는 이어지지 않는다 (훑기가 작업마다 건다)"
    );
}
