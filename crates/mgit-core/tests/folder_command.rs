//! 선택한 저장소들에 git 명령 실행 (MR-14): 실제 git 으로 종료 코드·출력·작업 트리(cwd)·pathspec 글롭·출력 상한·
//! 자격 증명 가림·취소(자식 프로세스까지)를 본다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, wait_for};
use mgit_core::{BatchOp, BatchResult, COMMAND_STDOUT_MAX, CoreEvent, FolderSettings, RepoResult};
use mgit_testkit::TestRepo;

/// 경로에 첫 commit 이 있는 저장소를 만든다
fn repo_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.commit("first");
    r
}

/// 임시 루트 아래 저장소 둘 (a·b)
fn two_repos(dir: &tempfile::TempDir) -> (PathBuf, TestRepo, TestRepo) {
    let root = dir.path().join("work");
    let a = repo_at(&root.join("a"));
    let b = repo_at(&root.join("b"));
    (root, a, b)
}

/// 명령 인자
fn command(args: &[&str]) -> BatchOp {
    BatchOp::RunCommand {
        args: args.iter().map(|s| (*s).to_string()).collect(),
    }
}

/// 결과에서 그 이름의 저장소 줄
fn row<'a>(r: &'a BatchResult, name: &str) -> &'a RepoResult {
    r.results.iter().find(|x| x.name == name).unwrap()
}

#[tokio::test]
async fn run_command_reports_exit_codes_output_and_cwd() {
    let core = core().await;
    let dir = tempfile::tempdir().unwrap();
    let (root, mut a, _b) = two_repos(&dir);
    a.git_ok(["branch", "feature"]);
    a.write_file("docs/guide.txt", "g");
    a.write_file("notes.md", "n");
    a.stage(&["docs/guide.txt", "notes.md"]);
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    // 작업 트리가 cwd 다: 저장소마다 자기 최상위 경로를 낸다. 종료 코드 0 이면 성공
    let r = core
        .folder_batch(fid, command(&["rev-parse", "--show-toplevel"]), &[])
        .await
        .unwrap();
    assert_eq!((r.succeeded, r.failed), (2, 0), "{r:?}");
    assert!(
        r.label.ends_with("git rev-parse --show-toplevel"),
        "{}",
        r.label
    );
    for name in ["a", "b"] {
        let out = row(&r, name).command.as_ref().unwrap();
        assert_eq!(out.status, Some(0));
        let top = PathBuf::from(out.stdout.trim());
        assert_eq!(
            top.canonicalize().unwrap(),
            root.join(name).canonicalize().unwrap()
        );
        assert!(!out.stdout_truncated && !out.stderr_truncated);
    }

    // 종료 코드가 0 이 아니면 실패다: b 에는 feature 가 없다. 사유는 stderr 마지막 줄
    let r = core
        .folder_batch(fid, command(&["rev-parse", "--verify", "feature"]), &[])
        .await
        .unwrap();
    assert_eq!((r.succeeded, r.failed), (1, 1), "{r:?}");
    let b = row(&r, "b");
    assert!(!b.ok);
    assert_eq!(b.command.as_ref().unwrap().status, Some(128));
    assert!(b.message.starts_with("fatal:"), "{}", b.message);
    assert!(b.command.as_ref().unwrap().stderr.contains("fatal:"));

    // 사용자가 쓴 pathspec 글롭은 뜻대로 된다 (앱의 글자 그대로 pathspec 을 끈다)
    let r = core
        .folder_batch(
            fid,
            command(&["ls-files", "--", "*.txt"]),
            &[root.join("a")],
        )
        .await
        .unwrap();
    let listed = &row(&r, "a").command.as_ref().unwrap().stdout;
    assert!(listed.contains("docs/guide.txt"), "{listed}");
    assert!(!listed.contains("notes.md"), "{listed}");

    // 폴더 설정에서 뺀 저장소는 건너뛴다 (다른 일괄 작업과 같다)
    core.set_folder_settings(
        fid,
        &FolderSettings {
            exclude: vec!["b".into()],
            ..FolderSettings::default()
        },
    )
    .unwrap();
    let r = core
        .folder_batch(fid, command(&["status", "--short"]), &[])
        .await
        .unwrap();
    assert_eq!((r.succeeded, r.skipped), (1, 1), "{r:?}");
    assert!(row(&r, "b").command.is_none());

    // 빈 명령은 실행하기 전에 거부한다
    assert!(core.folder_batch(fid, command(&[]), &[]).await.is_err());
}

#[tokio::test]
async fn run_command_caps_output_and_redacts_credentials() {
    let core = core().await;
    let dir = tempfile::tempdir().unwrap();
    let (root, mut a, _b) = two_repos(&dir);
    a.write_file("big.txt", &"a".repeat(COMMAND_STDOUT_MAX + 512 * 1024));
    a.stage(&["big.txt"]);
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    let only_a = [root.join("a")];

    // 저장소당 stdout 은 앞 1 MiB 까지만 남기고 잘렸다고 표시한다. 명령은 끝까지 돌아 종료 코드가 있다
    let r = core
        .folder_batch(fid, command(&["show", ":big.txt"]), &only_a)
        .await
        .unwrap();
    let out = row(&r, "a").command.clone().unwrap();
    assert_eq!(out.status, Some(0));
    assert_eq!(out.stdout.len(), COMMAND_STDOUT_MAX);
    assert!(out.stdout_truncated);

    // 인자의 자격 증명은 작업 이름·명령 기록에서 가리고, 출력의 URL 자격 증명도 가린다
    let secret_url = "https://user:s3cret@example.com/team/r.git";
    let r = core
        .folder_batch(
            fid,
            command(&["remote", "add", "origin", secret_url]),
            &only_a,
        )
        .await
        .unwrap();
    assert_eq!(r.succeeded, 1, "{r:?}");
    assert!(!r.label.contains("s3cret"), "{}", r.label);
    assert!(r.label.contains("user:***@example.com"), "{}", r.label);
    let logged = core.command_log_recent(50);
    let record = logged
        .iter()
        .find(|rec| rec.args.first().is_some_and(|a| a == "remote"))
        .unwrap();
    assert!(
        record.args.iter().all(|a| !a.contains("s3cret")),
        "{record:?}"
    );
    let r = core
        .folder_batch(fid, command(&["remote", "-v"]), &only_a)
        .await
        .unwrap();
    let shown = &row(&r, "a").command.as_ref().unwrap().stdout;
    assert!(shown.contains("user:***@example.com"), "{shown}");
    assert!(!shown.contains("s3cret"), "{shown}");
}

/// 취소: 실행 중이던 명령은 자식 프로세스까지 끝나 "실행 중에 취소" 로, 시작하지 않은 저장소는 "취소됨" 으로 남는다.
/// 별칭(`!`)이 띄운 셸과 그 자식(`sleep`)도 함께 끝나 뒤의 `touch` 가 돌지 않는다
#[cfg(unix)]
#[tokio::test]
async fn run_command_cancel_stops_the_process_group() {
    let core = core().await;
    let dir = tempfile::tempdir().unwrap();
    let (root, _a, _b) = two_repos(&dir);
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    core.set_folder_settings(
        fid,
        &FolderSettings {
            concurrency: 1,
            ..FolderSettings::default()
        },
    )
    .unwrap();
    let started = std::time::Instant::now();
    let op = command(&["-c", "alias.slow=!sleep 3 && touch marker", "slow"]);
    let (result, ()) = tokio::join!(core.folder_batch(fid, op, &[]), async {
        let events = wait_for(&mut rx, Duration::from_secs(10), |e| {
            matches!(e, CoreEvent::OperationStarted { .. })
        })
        .await;
        let op_id = events
            .iter()
            .find_map(|e| match e {
                CoreEvent::OperationStarted { op_id, .. } => Some(*op_id),
                _ => None,
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(core.cancel_operation(op_id));
    });
    let r = result.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "별칭의 sleep(3초)을 기다리지 않아야 한다: {:?}",
        started.elapsed()
    );
    assert_eq!(r.cancelled, 2, "{r:?}");
    assert!(r.results.iter().all(|x| x.cancelled && x.ok), "{r:?}");
    // 한 번에 하나씩이라 하나는 실행 중에 멈췄고(출력 칸이 있다), 하나는 시작하지 않았다
    let running: Vec<_> = r.results.iter().filter(|x| x.command.is_some()).collect();
    assert_eq!(running.len(), 1, "{r:?}");
    assert_eq!(
        running[0].skipped.as_deref(),
        Some("실행 중에 취소했습니다 (반영 여부를 확인하세요)")
    );
    assert_eq!(running[0].command.as_ref().unwrap().status, None);
    let pending: Vec<_> = r.results.iter().filter(|x| x.command.is_none()).collect();
    assert_eq!(pending[0].skipped.as_deref(), Some("취소됨"));
    // sleep 이 살아 있었다면 3초 뒤 marker 를 만든다
    tokio::time::sleep(Duration::from_millis(3500)).await;
    for name in ["a", "b"] {
        assert!(!root.join(name).join("marker").exists(), "{name}");
    }
}
