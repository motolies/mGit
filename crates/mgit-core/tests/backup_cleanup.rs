//! 백업 정리 (#18 백업 ref·#26 폐기 백업): 하루 한 번 자동 정리(세션·폴더), 고른 폐기 백업 삭제·기간 삭제
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use common::{collector, core, core_with, wait_finished};
use mgit_core::{BACKUP_NS, BackupPrune, BackupRecord, Core, CoreConfig, CoreError, SessionId};
use mgit_testkit::{Scenario, TestRepo, build};

/// 하루 (초)
const DAY: i64 = 86_400;

/// 폐기 백업 사본을 시스템 임시 폴더에 두는 코어. 사본을 지우는 테스트라, 공용 설정의 `target/` 아래 대신 지우기가
/// 늘 되는 곳을 쓴다 (돌려준 폴더는 테스트가 끝날 때까지 쥐고 있는다)
async fn core_with_temp_backups() -> (Core, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with(CoreConfig {
        backup_dir: Some(dir.path().join("backups")),
        ..CoreConfig::default()
    })
    .await;
    (core, dir)
}

/// 지금 epoch 초
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// 저장소 탭으로 열고 첫 로드를 기다린다. (세션, 작업 트리)
async fn open(core: &Core, repo: &TestRepo) -> (SessionId, PathBuf) {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    (opened.session, opened.info.work_tree)
}

/// `secs` 에 만든 것처럼 보이는 백업 ref 를 만든다
fn backup_ref_at(repo: &mut TestRepo, branch: &str, secs: i64, seq: u32) -> String {
    let name = format!("{BACKUP_NS}{branch}/{secs}-{seq:06}");
    let head = repo.head().to_hex();
    repo.git_ok(["update-ref", &name, &head]);
    name
}

/// 저장소의 백업 ref 이름들
fn backup_names(repo: &mut TestRepo) -> Vec<String> {
    repo.git_ok(["for-each-ref", "--format=%(refname)", "refs/mgit/backup"])
        .lines()
        .map(str::to_string)
        .collect()
}

/// `saved_ms` 에 만든 것처럼 보이는 폐기 백업 하나를 사본과 함께 넣는다 (사본 위치는 앱이 만드는 꼴)
fn file_backup_at(core: &Core, work_tree: &Path, stamp: &str, rel: &str, saved_ms: i64) -> u64 {
    let root = core.config().backup_dir.clone().unwrap();
    let blob = root.join("test-key").join(stamp).join(rel);
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, "copy").unwrap();
    core.store()
        .backup_add(&BackupRecord {
            id: 0,
            repo: work_tree.to_path_buf(),
            rel_path: rel.into(),
            saved_at: saved_ms,
            blob_path: blob,
            reason: "discard".into(),
        })
        .unwrap()
}

/// 보관 기간(30일)이 지난 백업 ref·폐기 백업만 지우고, 같은 날 다시 불러도 돌지 않으며, 하루가 지나면 다시 돈다
#[tokio::test]
async fn daily_prune_removes_only_expired_backups_once_a_day() {
    let (core, _backups) = core_with_temp_backups().await;
    let mut repo = build(Scenario::Linear(1));
    let (sid, work_tree) = open(&core, &repo).await;
    let now = now_secs();
    let old = backup_ref_at(&mut repo, "main", now - 40 * DAY, 1);
    let recent = backup_ref_at(&mut repo, "main", now - DAY, 2);
    // 폐기 백업: 실제 되돌리기로 만든 최근 것 하나와 40일 전 것 하나
    repo.write_file("f1.txt", "edit\n");
    core.refresh(sid).await.unwrap();
    let kept = core.discard(sid, &["f1.txt".into()]).await.unwrap();
    let stale = file_backup_at(
        &core,
        &work_tree,
        "1-0",
        "dir/old.txt",
        (now - 40 * DAY) * 1000,
    );
    let root = core.config().backup_dir.clone().unwrap();

    let r = core.prune_backups_daily_at(sid, now).await.unwrap();
    assert_eq!(
        r,
        BackupPrune {
            ran: true,
            refs: 1,
            files: 1
        }
    );
    assert_eq!(backup_names(&mut repo), std::slice::from_ref(&recent));
    assert!(!backup_names(&mut repo).contains(&old));
    let left: Vec<u64> = core
        .backups(sid, 10)
        .unwrap()
        .iter()
        .map(|b| b.id)
        .collect();
    assert_eq!(left, kept);
    assert!(core.store().backup_get(stale).unwrap().is_none());
    assert!(!root.join("test-key").exists());
    assert_eq!(
        core.store()
            .setting_get(&format!("backup-pruned:{}", work_tree.display()))
            .unwrap()
            .as_deref(),
        Some(now.to_string().as_str())
    );

    // 같은 날에는 새로 오래된 백업이 생겨도 돌지 않는다
    let later = backup_ref_at(&mut repo, "main", now - 50 * DAY, 3);
    let r = core.prune_backups_daily_at(sid, now + 3_600).await.unwrap();
    assert_eq!(r, BackupPrune::default());
    assert!(backup_names(&mut repo).contains(&later));
    // 하루가 지나면 다시 돈다
    let r = core.prune_backups_daily_at(sid, now + DAY).await.unwrap();
    assert!(r.ran && r.refs == 1 && r.files == 0, "{r:?}");
    assert_eq!(backup_names(&mut repo), [recent]);
}

/// 보관 기간이 0 이면 자동 정리는 아무것도 하지 않는다
#[tokio::test]
async fn daily_prune_is_off_when_keep_days_is_zero() {
    let core = core_with(CoreConfig {
        backup_keep_days: 0,
        ..CoreConfig::default()
    })
    .await;
    let mut repo = build(Scenario::Linear(1));
    let (sid, _) = open(&core, &repo).await;
    let old = backup_ref_at(&mut repo, "main", now_secs() - 400 * DAY, 1);
    let r = core.prune_backups_daily_at(sid, now_secs()).await.unwrap();
    assert_eq!(r, BackupPrune::default());
    assert_eq!(backup_names(&mut repo), [old]);
}

/// 경로에 커밋 하나짜리 저장소를 만든다
fn repo_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.commit("first");
    r
}

/// 폴더를 열면 하위 저장소마다 세션 없이 같은 규칙으로 정리한다. 저장소 탭과 하루 한 번 기록을 함께 쓴다
#[tokio::test]
async fn folder_prune_runs_per_repo_without_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut a = repo_at(&root.join("a"));
    let mut b = repo_at(&root.join("b"));
    let c = repo_at(&root.join("c"));
    let now = now_secs();
    backup_ref_at(&mut a, "main", now - 31 * DAY, 1);
    let keep_a = backup_ref_at(&mut a, "main", now - 29 * DAY, 2);
    backup_ref_at(&mut b, "main", now - 90 * DAY, 1);
    backup_ref_at(&mut b, "topic", now - 90 * DAY, 2);
    let core = core().await;
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let r = core.folder_prune_backups_daily_at(fid, now).await.unwrap();
    assert_eq!(
        r,
        BackupPrune {
            ran: true,
            refs: 3,
            files: 0
        }
    );
    assert_eq!(backup_names(&mut a), [keep_a]);
    assert!(backup_names(&mut b).is_empty());
    // 같은 날 다시 부르면 아무 저장소도 돌지 않는다
    assert_eq!(
        core.folder_prune_backups_daily_at(fid, now + 60)
            .await
            .unwrap(),
        BackupPrune::default()
    );
    // 저장소 탭으로 열어도 같은 날이면 돌지 않는다 (기록을 함께 쓴다)
    let (sid, _) = open(&core, &c).await;
    assert!(
        !core
            .prune_backups_daily_at(sid, now + 120)
            .await
            .unwrap()
            .ran
    );
}

/// 고른 폐기 백업 삭제·기간 삭제: 사본과 색인을 함께 지우고, 다른 저장소의 백업이 섞이면 아무것도 지우지 않는다
#[tokio::test]
async fn delete_file_backups_by_id_and_age() {
    let (core, _backups) = core_with_temp_backups().await;
    let mut repo = build(Scenario::Linear(2));
    let (sid, work_tree) = open(&core, &repo).await;
    repo.write_file("f1.txt", "one\n");
    repo.write_file("f2.txt", "two\n");
    core.refresh(sid).await.unwrap();
    let ids = core
        .discard(sid, &["f1.txt".into(), "f2.txt".into()])
        .await
        .unwrap();
    assert_eq!(ids.len(), 2);
    let blobs: Vec<PathBuf> = core
        .backups(sid, 10)
        .unwrap()
        .into_iter()
        .map(|b| b.blob_path)
        .collect();
    assert!(blobs.iter().all(|p| p.exists()));

    // 다른 저장소의 백업
    let mut other = build(Scenario::Linear(1));
    let (other_sid, _) = open(&core, &other).await;
    other.write_file("f1.txt", "x\n");
    core.refresh(other_sid).await.unwrap();
    let foreign = core.discard(other_sid, &["f1.txt".into()]).await.unwrap();
    assert!(matches!(
        core.delete_backups(sid, &[ids[0], foreign[0]]),
        Err(CoreError::Invalid(_))
    ));
    assert_eq!(core.backups(sid, 10).unwrap().len(), 2);

    // 하나 지우기: 사본 폴더도 사라진다. 없는 id 는 건너뛴다
    assert_eq!(core.delete_backups(sid, &[ids[0], 999_999]).unwrap(), 1);
    let left = core.backups(sid, 10).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, ids[1]);
    assert_eq!(blobs.iter().filter(|p| p.exists()).count(), 1);

    // 기간 삭제: 기준보다 오래된 것만
    let stale = file_backup_at(&core, &work_tree, "1-9", "old.txt", 1_000);
    assert_eq!(core.delete_backups_before(sid, 2_000).unwrap(), 1);
    assert!(core.store().backup_get(stale).unwrap().is_none());
    assert_eq!(core.backups(sid, 10).unwrap().len(), 1);
    // 아주 먼 뒤를 기준으로 하면 전부
    assert_eq!(core.delete_backups_before(sid, i64::MAX).unwrap(), 1);
    assert!(core.backups(sid, 10).unwrap().is_empty());
    assert!(blobs.iter().all(|p| !p.exists()));
    // 다른 저장소의 백업은 그대로다
    assert_eq!(core.backups(other_sid, 10).unwrap().len(), 1);
}
