//! 여러 저장소 한꺼번에 clone: 로컬 원격(`file://`) 여러 개를 실제 git 으로 clone 하고, 이미 있는 대상은 건너뛰며
//! (그 폴더는 건드리지 않는다), 잘못된 URL 은 실패하고 만들던 폴더를 지운다. 취소하면 실행 중인 clone 을 자식
//! 프로세스까지 멈추고 만들던 폴더만 지운다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, core_with, wait_for};
use mgit_core::{CloneBatch, CloneTarget, CoreConfig, CoreEvent};
use mgit_testkit::TestRepo;

/// 경로에 commit 이 있는 원본 저장소를 만든다
fn source_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.commit("first");
    r
}

/// 경로의 `file://` URL
fn file_url(path: &Path) -> String {
    format!("file://{}", path.canonicalize().unwrap().display())
}

/// clone 대상 하나
fn target(url: &str, name: &str) -> CloneTarget {
    CloneTarget {
        url: url.into(),
        name: name.into(),
    }
}

/// 상위 폴더와 대상으로 요청을 만든다
fn batch(parent: &Path, targets: Vec<CloneTarget>, concurrency: u32) -> CloneBatch {
    CloneBatch {
        parent: parent.to_path_buf(),
        targets,
        recurse_submodules: false,
        depth: None,
        blobless: false,
        single_branch: false,
        concurrency,
    }
}

/// 이미 있던 폴더 하나 (안에 표시 파일이 있다)
fn existing_folder(parent: &Path, name: &str) -> PathBuf {
    let dir = parent.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("keep.txt"), "mine").unwrap();
    dir
}

#[tokio::test]
async fn clone_many_clones_skips_existing_and_cleans_failures() {
    let core = core().await;
    let dir = tempfile::tempdir().unwrap();
    let a = source_at(&dir.path().join("src/a"));
    let b = source_at(&dir.path().join("src/b"));
    let parent = dir.path().join("dest");
    std::fs::create_dir_all(&parent).unwrap();
    let keep = existing_folder(&parent, "keep");
    let (sink, mut rx) = collector();

    let r = core
        .clone_many(
            batch(
                &parent,
                vec![
                    target(&file_url(a.path()), "a"),
                    target(&file_url(b.path()), "keep"),
                    target("file:///mgit-no-such-remote/x.git", "bad"),
                    target(&file_url(b.path()), "b2"),
                ],
                2,
            ),
            sink,
        )
        .await
        .unwrap();
    // 결과는 요청 순서다
    let names: Vec<_> = r.results.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["a", "keep", "bad", "b2"]);
    assert_eq!((r.succeeded, r.skipped, r.failed), (2, 1, 1), "{r:?}");
    assert!(parent.join("a/.git").is_dir());
    assert!(parent.join("b2/.git").is_dir());
    // 이미 있던 폴더는 건너뛰고 그대로 둔다
    assert_eq!(
        r.results[1].skipped.as_deref(),
        Some("이미 있는 폴더입니다")
    );
    assert_eq!(
        std::fs::read_to_string(keep.join("keep.txt")).unwrap(),
        "mine"
    );
    assert!(!keep.join(".git").exists());
    // 실패한 clone 은 사유가 있고, 이번에 만든 폴더는 남지 않는다
    let bad = &r.results[2];
    assert!(!bad.ok && !bad.message.is_empty(), "{bad:?}");
    assert!(!parent.join("bad").exists());
    // 진행은 세션 0 의 clone 작업으로 온다
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::OperationFinished { .. })
    })
    .await;
    assert!(events.iter().any(|e| matches!(
        e,
        CoreEvent::OperationStarted { kind, label, .. } if kind == "clone" && label == "일괄 복제 (4개)"
    )));

    // 같은 폴더 이름이 두 번이면 아무것도 만들지 않고 거부한다
    let (sink, _rx) = collector();
    let err = core
        .clone_many(
            batch(
                &parent,
                vec![
                    target(&file_url(a.path()), "twice"),
                    target(&file_url(b.path()), "twice"),
                ],
                2,
            ),
            sink,
        )
        .await;
    assert!(err.is_err());
    assert!(!parent.join("twice").exists());
}

/// 취소: 실행 중이던 clone(원격 쪽이 오래 걸리는 ext 전송)은 자식 프로세스까지 멈추고 만들던 폴더를 지운다. 시작하지
/// 않은 대상은 "취소됨" 이고 폴더를 만들지 않는다. 이미 있던 폴더는 건드리지 않는다
#[cfg(unix)]
#[tokio::test]
async fn clone_many_cancel_removes_partial_folders_only() {
    let core = core_with(CoreConfig {
        git_config_overrides: vec![("protocol.ext.allow".into(), "always".into())],
        ..CoreConfig::default()
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let a = source_at(&dir.path().join("src/a"));
    let parent = dir.path().join("dest");
    std::fs::create_dir_all(&parent).unwrap();
    let keep = existing_folder(&parent, "keep");
    let (sink, mut rx) = collector();
    let started = std::time::Instant::now();
    let request = batch(
        &parent,
        vec![
            target("ext::sh -c sleep% 5", "slow"),
            target(&file_url(a.path()), "later"),
            target(&file_url(a.path()), "keep"),
        ],
        1,
    );
    let (result, ()) = tokio::join!(core.clone_many(request, sink), async {
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
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(core.cancel_operation(op_id));
    });
    let r = result.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "원격 쪽 sleep(5초)을 기다리지 않아야 한다: {:?}",
        started.elapsed()
    );
    assert_eq!((r.cancelled, r.failed), (3, 0), "{r:?}");
    assert_eq!(
        r.results[0].skipped.as_deref(),
        Some("실행 중에 취소했습니다 (만들던 폴더는 지웠습니다)")
    );
    assert_eq!(r.results[1].skipped.as_deref(), Some("취소됨"));
    assert!(!parent.join("slow").exists());
    assert!(!parent.join("later").exists());
    assert_eq!(
        std::fs::read_to_string(keep.join("keep.txt")).unwrap(),
        "mine"
    );
}
