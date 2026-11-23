//! 포함 브랜치(`for-each-ref --contains`)의 시간 상한과 프로세스 정리를 실제 프로세스로 검증한다.
//! 뜻(로컬·원격·HEAD·정렬)은 코어 통합 테스트(`mgit-core/tests/containing_refs.rs`)가 맡는다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mgit_git::cmd::containing_branches;
use mgit_git::{LocateConfig, RunnerConfig, TokioGitRunner};
use mgit_model::{GitError, Oid};
use mgit_testkit::{Scenario, build};

/// 기본 설정 러너
async fn runner() -> TokioGitRunner {
    TokioGitRunner::new(RunnerConfig::default()).await.unwrap()
}

/// `--contains=` 가 든 호출만 자기 pid 를 적고 오래 잠드는 가짜 git. 나머지는 진짜 git 으로 넘긴다
/// (러너 초기화의 `--version`·`rev-parse --local-env-vars` 도 진짜로 돈다)
fn slow_contains_git(dir: &Path, real: &Path, pid_file: &Path) -> PathBuf {
    let script = dir.join("git");
    let body = format!(
        "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    --contains=*) echo $$ > '{}'; exec sleep 30 ;;\n  esac\ndone\nexec '{}' \"$@\"\n",
        pid_file.display(),
        real.display()
    );
    std::fs::write(&script, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    script
}

/// 프로세스가 살아 있는지 (`kill -0`). 거두어진 프로세스는 없는 것으로 나온다
fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

/// 상한이 지나면 `None` 이고, 잠든 git 프로세스는 끝나고 거두어져 남지 않는다
#[cfg(unix)]
#[tokio::test]
async fn timeout_returns_none_and_reaps_the_process() {
    let mut repo = build(Scenario::Linear(2));
    let oid = repo.head();
    let real = runner().await.git_path().clone();
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let fake = slow_contains_git(dir.path(), &real, &pid_file);
    let slow = TokioGitRunner::new(RunnerConfig {
        locate: LocateConfig {
            configured_path: Some(fake),
        },
        ..RunnerConfig::default()
    })
    .await
    .unwrap();

    let started = Instant::now();
    let got = containing_branches(&slow, repo.path(), &[], &oid, Duration::from_millis(300))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(got, None, "시간 초과는 None");
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(3),
        "상한 뒤 곧 돌아와야 한다: {elapsed:?}"
    );
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    let pid = pid.trim();
    assert!(!pid.is_empty());
    assert!(!alive(pid), "시간 초과 뒤 git({pid}) 이 남아 돈다");
}

/// 상한 안에 끝나면 결과를 그대로 준다 (같은 가짜 git 이라도 `--contains` 가 아니면 진짜로 돈다)
#[tokio::test]
async fn finishes_within_the_limit() {
    let mut repo = build(Scenario::Linear(2));
    let oid = repo.head();
    let r = runner().await;
    let got = containing_branches(&r, repo.path(), &[], &oid, Duration::from_secs(10))
        .await
        .unwrap()
        .unwrap();
    assert!(got.head);
    assert_eq!(
        got.branches
            .iter()
            .map(|b| (b.short_name.as_str(), b.current))
            .collect::<Vec<_>>(),
        vec![("main", true)]
    );
}

/// 그 저장소에 없는 커밋은 시간 초과가 아니라 git 오류다
#[tokio::test]
async fn unknown_commit_is_a_git_error() {
    let repo = build(Scenario::Linear(1));
    let r = runner().await;
    let nowhere = Oid::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
    let err = containing_branches(&r, repo.path(), &[], &nowhere, Duration::from_secs(10))
        .await
        .unwrap_err();
    match err {
        GitError::Exit { stderr, .. } => assert!(stderr.contains("no such commit"), "{stderr}"),
        other => panic!("git 오류여야 한다: {other:?}"),
    }
}
