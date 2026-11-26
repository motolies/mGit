//! 일괄 병합·리베이스는 승인된 스냅샷과 저장소별 Git 상태를 보존한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core};
use mgit_core::{
    BatchMergeMode, BatchOp, IntegrationOutcome, IntegrationPreview, IntegrationTarget,
};
use mgit_testkit::TestRepo;
use std::path::Path;

/// 서로 다른 파일을 고친 분기 두 개를 만든다.
fn repo(path: &Path, conflict: bool) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.write_file("shared", "base\n");
    r.commit("base");
    r.git_ok(["checkout", "-q", "-b", "topic"]);
    r.write_file(if conflict { "shared" } else { "feature" }, "source\n");
    r.commit("source");
    r.git_ok(["checkout", "-q", "main"]);
    r.write_file(if conflict { "shared" } else { "local" }, "local\n");
    r.commit("local");
    r
}
/// 실제 사전 확인의 실행 가능한 행만 승인 대상으로 만든다.
fn targets(rows: Vec<IntegrationPreview>) -> Vec<IntegrationTarget> {
    rows.into_iter()
        .filter(|r| r.reason.is_none())
        .map(|r| IntegrationTarget {
            path: r.path,
            current_branch: r.current_branch.unwrap(),
            head: r.head.unwrap(),
            source_oid: r.source_oid.unwrap(),
        })
        .collect()
}

#[tokio::test]
async fn merge_conflict_keeps_other_repository_success_and_never_checkouts() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let mut b = repo(&dir.path().join("b"), true);
    let core = core().await;
    let (sink, _) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    assert_eq!(plan.len(), 2);
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Merge {
                reference: "refs/heads/topic".into(),
                mode: BatchMergeMode::Default,
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.succeeded, 1);
    assert_eq!(result.failed, 1);
    assert_eq!(
        result.results[0].integration,
        Some(IntegrationOutcome::Clean)
    );
    assert_eq!(
        result.results[1].integration,
        Some(IntegrationOutcome::Conflicts)
    );
    assert!(b.path().join(".git/MERGE_HEAD").exists());
    assert_eq!(
        a.git_ok(["log", "-1", "--format=%s"]).trim(),
        "Merge branch 'topic' into main"
    );
    assert!(
        std::fs::read_to_string(b.path().join(".git/MERGE_MSG"))
            .unwrap()
            .starts_with("Merge branch 'topic' into main")
    );
    b.write_file("shared", "resolved\n");
    b.git_ok(["add", "shared"]);
    b.git_ok(["commit", "--no-edit"]);
    assert_eq!(
        b.git_ok(["log", "-1", "--format=%s"]).trim(),
        "Merge branch 'topic' into main"
    );
    assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        a.git_ok(["rev-list", "--parents", "-n1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}

#[tokio::test]
async fn rebase_backs_up_head_and_refuses_stale_dirty_detached_or_missing_targets() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let mut b = repo(&dir.path().join("b"), false);
    let core = core().await;
    let (sink, _) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let before = a.head();
    let b_before = b.head();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[a.path().into()])
            .await
            .unwrap(),
    );
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: plan.clone(),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.succeeded, 1);
    assert_eq!(result.results.len(), 1);
    assert_eq!(b.head(), b_before);
    assert_ne!(a.head(), before);
    assert!(
        a.git_ok([
            "for-each-ref",
            "--format=%(objectname)",
            "refs/mgit/backup/main/"
        ])
        .contains(&before.to_hex())
    );
    let stale = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(stale.skipped, 1);
    b.write_file("untracked", "keep");
    let rows = core
        .folder_integration_preview(f.session, "refs/heads/topic", &[b.path().into()])
        .await
        .unwrap();
    assert!(rows[0].reason.is_some());
    std::fs::remove_file(b.path().join("untracked")).unwrap();
    b.git_ok(["checkout", "--detach", "-q"]);
    assert!(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[b.path().into()])
            .await
            .unwrap()[0]
            .reason
            .is_some()
    );
    assert!(
        core.folder_integration_preview(f.session, "refs/heads/missing", &[])
            .await
            .unwrap()
            .iter()
            .all(|r| r.reason.is_some())
    );
    assert!(
        core.folder_integration_preview(f.session, "HEAD", &[])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn backup_failure_or_changed_source_prevents_rebase() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let core = core().await;
    let (sink, _) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    let before = a.head();
    a.git_ok(["update-ref", "refs/mgit/backup", "HEAD"]);
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: plan.clone(),
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.failed, 1);
    assert_eq!(a.head(), before);
    a.git_ok(["update-ref", "refs/heads/topic", "HEAD"]);
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.skipped, 1);
    assert_eq!(a.head(), before);
}

#[tokio::test]
async fn squash_needs_commit_only_when_it_produces_changes_and_no_autostash() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let core = core().await;
    let (sink, _) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let before = a.head();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Merge {
                reference: "refs/heads/topic".into(),
                mode: BatchMergeMode::Squash,
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        result.results[0].integration,
        Some(IntegrationOutcome::Squashed)
    );
    assert_eq!(a.head(), before);
    assert!(!a.git_ok(["diff", "--cached", "--name-only"]).is_empty());
    a.git_ok(["reset", "--hard", "-q", "HEAD"]);
    a.git_ok(["update-ref", "refs/heads/topic", "HEAD"]);
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Merge {
                reference: "refs/heads/topic".into(),
                mode: BatchMergeMode::Squash,
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        result.results[0].integration,
        Some(IntegrationOutcome::Clean)
    );
    assert_eq!(a.head(), before);
}

/// 시작 직후 취소는 아직 실행하지 않은 저장소의 HEAD와 백업을 바꾸지 않는다.
#[tokio::test]
async fn cancellation_before_dispatch_skips_all_and_empty_approval_is_rejected() {
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let mut b = repo(&dir.path().join("b"), false);
    let before = [a.head(), b.head()];
    let core = Arc::new(core().await);
    let cancelling = Arc::downgrade(&core);
    let sink: Arc<dyn mgit_core::EventSink> = Arc::new(move |event: mgit_core::CoreEvent| {
        if let mgit_core::CoreEvent::OperationStarted { op_id, .. } = event {
            assert!(cancelling.upgrade().unwrap().cancel_operation(op_id));
        }
    });
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    assert!(
        core.folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: vec![]
            },
            &[]
        )
        .await
        .is_err()
    );
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.skipped, 2);
    assert_eq!(result.failed, 0);
    assert_eq!([a.head(), b.head()], before);
}

/// 실행 중인 Git도 취소 신호를 받으며, 재작성 전 백업은 남긴다.
#[cfg(unix)]
#[tokio::test]
async fn cancellation_terminates_inflight_rebase_and_keeps_backup() {
    use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let before = a.head();
    let hook = a.path().join(".git/hooks/pre-rebase");
    std::fs::write(
        &hook,
        "#!/bin/sh\ntouch .git/integration-started\nsleep 30\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let core = Arc::new(core().await);
    let (sink, mut events) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    let running = Arc::clone(&core);
    let task = tokio::spawn(async move {
        running
            .folder_batch(
                f.session,
                BatchOp::Rebase {
                    reference: "refs/heads/topic".into(),
                    targets: plan,
                },
                &[],
            )
            .await
    });
    let op = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(mgit_core::CoreEvent::OperationStarted { op_id, .. }) = events.recv().await
            {
                break op_id;
            }
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !a.path().join(".git/integration-started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(core.cancel_operation(op));
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.failed, 1);
    assert_eq!(a.head(), before);
    assert!(
        a.git_ok([
            "for-each-ref",
            "--format=%(objectname)",
            "refs/mgit/backup/main/"
        ])
        .contains(&before.to_hex())
    );
}

/// 확인 뒤의 새 변경·브랜치 전환·제외 설정을 잠금 안에서 다시 확인한다.
#[tokio::test]
async fn late_changes_are_skipped_and_selected_paths_must_match_approval() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let mut b = repo(&dir.path().join("b"), false);
    let mut c = repo(&dir.path().join("c"), false);
    let before = [a.head(), b.head(), c.head()];
    let core = core().await;
    let (sink, _) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/heads/topic", &[])
            .await
            .unwrap(),
    );
    let mismatch = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: vec![plan[0].clone()],
            },
            &[b.path().into()],
        )
        .await;
    assert!(mismatch.is_err());
    a.git_ok(["checkout", "-b", "other", "-q"]);
    std::fs::write(b.path().join("late.txt"), "keep").unwrap();
    core.set_folder_settings(
        f.session,
        &mgit_core::FolderSettings {
            exclude: vec!["c".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Rebase {
                reference: "refs/heads/topic".into(),
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.skipped, 3);
    assert_eq!(result.failed, 0);
    assert_eq!([a.head(), b.head(), c.head()], before);
    assert_eq!(a.git_ok(["branch", "--show-current"]).trim(), "other");
    assert_eq!(
        std::fs::read_to_string(b.path().join("late.txt")).unwrap(),
        "keep"
    );
}

/// 원격 추적 브랜치도 fetch 없이 확인한 커밋으로 병합하며 FF 정책을 명시적으로 적용한다.
#[tokio::test]
async fn merge_modes_and_remote_source_are_respected() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = repo(&dir.path().join("a"), false);
    let before = a.head();
    a.git_ok([
        "update-ref",
        "refs/remotes/origin/topic",
        "refs/heads/topic",
    ]);
    let core = core().await;
    let (sink, _) = collector();
    let f = core.open_folder(dir.path(), sink).await.unwrap();
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/remotes/origin/topic", &[])
            .await
            .unwrap(),
    );
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Merge {
                reference: "refs/remotes/origin/topic".into(),
                mode: BatchMergeMode::FfOnly,
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.failed, 1);
    assert_eq!(a.head(), before);
    a.git_ok(["reset", "--hard", "-q", "topic^"]);
    let plan = targets(
        core.folder_integration_preview(f.session, "refs/remotes/origin/topic", &[])
            .await
            .unwrap(),
    );
    let result = core
        .folder_batch(
            f.session,
            BatchOp::Merge {
                reference: "refs/remotes/origin/topic".into(),
                mode: BatchMergeMode::NoFf,
                targets: plan,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(result.succeeded, 1);
    assert_eq!(
        a.git_ok(["log", "-1", "--format=%s"]).trim(),
        "Merge remote-tracking branch 'origin/topic' into main"
    );
    assert_eq!(
        a.git_ok(["rev-list", "--parents", "-n1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}
