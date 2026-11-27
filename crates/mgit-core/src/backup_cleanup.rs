//! 백업 정리 (#18 백업 ref·#26 폐기 백업). 둘 다 보관 기간(`CoreConfig::backup_keep_days`, 기본 30일)이 지나면 지운다.
//!
//! - 자동 정리: 앱이 저장소 탭을 열 때(`prune_backups_daily`)와 폴더를 열고 첫 요약을 읽은 뒤
//!   (`folder_prune_backups_daily`) 부른다. 작업 트리마다 **하루 한 번**만 돈다 — 마지막으로 정리한 시각을 설정
//!   저장소 키 `backup-pruned:<작업 트리>` 에 남긴다. 폐기 백업 색인이 작업 트리별이라 열쇠도 작업 트리다 (워크트리끼리
//!   함께 쓰는 백업 ref 는 먼저 연 쪽이 지우고, 나머지는 지울 것이 없어 `for-each-ref` 한 번으로 끝난다).
//! - 세션이 있든 없든 같은 길로 돈다: 그 저장소의 쓰기 잠금(`write_lock_for(common_dir)`, 세션 쓰기 큐·폴더 일괄과
//!   같은 잠금)을 쥐고 세션 없는 쓰기(`run_write_at`)로 지운다. undo 스냅샷·재조회는 없다 (백업 ref 는 화면의 ref
//!   목록에 없다). 잠금 안에서 날짜를 다시 보므로 같은 저장소를 동시에 열어도 한 번만 돈다.
//! - 사용자가 고른 폐기 백업 삭제(`delete_backups`·`delete_backups_before`)는 하루 한 번 규칙과 상관없다.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use mgit_git::bulk_reads;
use mgit_git::cmd::discover;
use mgit_l10n::pick;
use mgit_model::BackupRecord;
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::config::CoreConfig;
use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::SessionId;
use crate::safety::{delete_script, expired_backup_refs, list_backup_refs};
use crate::write::WriteSpec;

/// 하루 (초)
const DAY_SECS: i64 = 86_400;
/// 폴더 정리의 동시 저장소 수 (첫 요약·감시와 다투지 않게 낮게)
const FOLDER_PRUNE_CONCURRENCY: usize = 2;
/// 폐기 백업 목록을 정리할 때 한 번에 읽는 최대 수 (사실상 전부)
const ALL_BACKUPS: u32 = u32::MAX;

/// 자동 정리 한 번의 결과
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPrune {
    /// 정리를 실제로 돌렸다 (하루 안에 이미 했거나 자동 정리가 꺼졌으면 false)
    pub ran: bool,
    /// 지운 백업 ref 수
    pub refs: u32,
    /// 지운 폐기 백업 수
    pub files: u32,
}

impl BackupPrune {
    /// 두 결과를 더한다 (폴더 정리의 합계)
    fn add(self, other: BackupPrune) -> BackupPrune {
        BackupPrune {
            ran: self.ran || other.ran,
            refs: self.refs + other.refs,
            files: self.files + other.files,
        }
    }
}

/// 지금 epoch 초
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 마지막 자동 정리 시각을 남기는 설정 키
fn pruned_key(work_tree: &Path) -> String {
    format!("backup-pruned:{}", work_tree.display())
}

/// 자동 정리를 돌릴 때인지: 한 번도 안 했거나, 마지막 정리에서 하루가 지났거나, 시계가 뒤로 갔다
pub(crate) fn prune_due(last: Option<i64>, now: i64) -> bool {
    last.is_none_or(|at| now - at >= DAY_SECS || now < at)
}

/// 폐기 백업 사본을 두는 폴더 (`CoreConfig::backup_dir`, 없으면 임시 폴더 아래). 만들기·지우기가 같은 값을 쓴다
pub(crate) fn backup_root(cfg: &CoreConfig) -> PathBuf {
    cfg.backup_dir
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join("mgit-backups"))
}

/// 폐기 백업 사본 하나를 지운다. 사본은 `<root>/<저장소 키>/<시각-순번>/<상대 경로>` 에 하나씩 있으므로 그
/// `<시각-순번>` 폴더째 지운다. 사본이 백업 폴더 밖을 가리키면(설정이 바뀐 옛 색인 등) 건드리지 않는다. 이미 없으면
/// 지운 것으로 본다. 비게 된 `<저장소 키>` 폴더도 지운다 (안 비었으면 그대로)
fn remove_backup_copy(root: &Path, rec: &BackupRecord) -> std::io::Result<()> {
    if !rec.blob_path.starts_with(root) {
        return Ok(());
    }
    let depth = Path::new(&rec.rel_path).components().count();
    let stamp_dir = rec
        .blob_path
        .ancestors()
        .nth(depth)
        .filter(|dir| dir.parent().and_then(Path::parent) == Some(root));
    let removed = match stamp_dir {
        Some(dir) => std::fs::remove_dir_all(dir),
        None => std::fs::remove_file(&rec.blob_path),
    };
    match removed {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    if let Some(repo_dir) = stamp_dir.and_then(Path::parent) {
        let _ = std::fs::remove_dir(repo_dir);
    }
    Ok(())
}

impl CoreInner {
    /// 폐기 백업 하나를 지운다: 사본 → 색인. 사본을 못 지우면 색인을 남기고 오류 (다음에 다시 지울 수 있게)
    pub(crate) fn delete_file_backup(&self, rec: &BackupRecord) -> Result<(), CoreError> {
        remove_backup_copy(&backup_root(&self.cfg), rec).map_err(mgit_model::StoreError::Io)?;
        self.store.backup_delete(rec.id)?;
        Ok(())
    }

    /// 작업 트리의 폐기 백업 중 `before_ms`(epoch 밀리초)보다 먼저 만든 것을 지운다. 지운 수를 돌려준다
    fn delete_file_backups_before(
        &self,
        work_tree: &Path,
        before_ms: i64,
    ) -> Result<u32, CoreError> {
        let old: Vec<BackupRecord> = self
            .store
            .backups_for(work_tree, ALL_BACKUPS)?
            .into_iter()
            .filter(|b| b.saved_at < before_ms)
            .collect();
        let mut deleted = 0;
        for rec in &old {
            self.delete_file_backup(rec)?;
            deleted += 1;
        }
        Ok(deleted)
    }

    /// 작업 트리 하나의 하루 한 번 자동 정리 (`now` 는 epoch 초). 보관 기간이 0 이면 끈다. 쓰기 잠금을 쥔 채 날짜
    /// 확인 → 기간 지난 백업 ref 삭제 → 기간 지난 폐기 백업 삭제 → 날짜 기록 순으로 돈다. 실패하면 날짜를 남기지 않아
    /// 다음에 다시 한다
    pub(crate) async fn prune_backups_daily_at(
        &self,
        work_tree: &Path,
        common_dir: &Path,
        now: i64,
    ) -> Result<BackupPrune, CoreError> {
        let keep = self.cfg.backup_keep_days;
        if keep == 0 {
            return Ok(BackupPrune::default());
        }
        let key = pruned_key(work_tree);
        let lock = self.write_lock_for(common_dir);
        let _queued = lock.lock().await;
        let last = self
            .store
            .setting_get(&key)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str::<i64>(&json).ok());
        if !prune_due(last, now) {
            return Ok(BackupPrune::default());
        }
        let cutoff = now - i64::from(keep) * DAY_SECS;
        let old = expired_backup_refs(list_backup_refs(self.runner(), work_tree).await?, cutoff);
        if !old.is_empty() {
            self.run_write_at(
                work_tree,
                &WriteSpec::new(["update-ref", "--stdin"])
                    .with_stdin(delete_script(&old).into_bytes())
                    .no_undo()
                    .skip_refresh(),
            )
            .await?;
        }
        let files = self.delete_file_backups_before(work_tree, cutoff.saturating_mul(1000))?;
        self.store.setting_set(&key, &now.to_string())?;
        let result = BackupPrune {
            ran: true,
            refs: old.len() as u32,
            files,
        };
        if result.refs + result.files > 0 {
            tracing::debug!(
                work_tree = %work_tree.display(),
                refs = result.refs,
                files = result.files,
                "보관 기간이 지난 백업을 정리했다"
            );
        }
        Ok(result)
    }
}

impl Core {
    /// 저장소 탭의 하루 한 번 백업 정리 (#18·#26). 앱이 탭을 연 뒤 기다리지 않고 부른다
    pub async fn prune_backups_daily(&self, session: SessionId) -> Result<BackupPrune, CoreError> {
        self.prune_backups_daily_at(session, now_secs()).await
    }

    /// `prune_backups_daily` 에 지금 시각(epoch 초)을 넣는 판 (테스트·재현용)
    pub async fn prune_backups_daily_at(
        &self,
        session: SessionId,
        now: i64,
    ) -> Result<BackupPrune, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        inner
            .prune_backups_daily_at(&s.info.work_tree, &s.info.common_dir, now)
            .await
    }

    /// 폴더의 하위 저장소마다 하루 한 번 백업 정리 (#18·#26). 저장소 세션 없이 낮은 동시성으로 돈다. 한 저장소가
    /// 실패해도 나머지는 계속하고 실패는 디버그 로그에만 남긴다. 합계를 돌려준다
    pub async fn folder_prune_backups_daily(
        &self,
        session: SessionId,
    ) -> Result<BackupPrune, CoreError> {
        self.folder_prune_backups_daily_at(session, now_secs())
            .await
    }

    /// `folder_prune_backups_daily` 에 지금 시각(epoch 초)을 넣는 판 (테스트·재현용)
    pub async fn folder_prune_backups_daily_at(
        &self,
        session: SessionId,
        now: i64,
    ) -> Result<BackupPrune, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let sem = Arc::new(Semaphore::new(FOLDER_PRUNE_CONCURRENCY));
        let mut set = JoinSet::new();
        for found in folder.repos() {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            // 묶음 읽기로 센다: 저장소 수만큼 퍼지는 배경 읽기가 사용자가 누른 읽기의 칸까지 차지하지 않게 (반응성 12)
            set.spawn(bulk_reads(async move {
                let _permit = sem.acquire().await;
                let result = match discover(inner.runner(), &found.path).await {
                    Ok(d) => {
                        inner
                            .prune_backups_daily_at(&d.work_tree, &d.common_dir, now)
                            .await
                    }
                    Err(e) => Err(e.into()),
                };
                result.unwrap_or_else(|e| {
                    tracing::debug!(path = %found.path.display(), error = %e, "백업 정리 실패");
                    BackupPrune::default()
                })
            }));
        }
        let mut total = BackupPrune::default();
        while let Some(joined) = set.join_next().await {
            if let Ok(one) = joined {
                total = total.add(one);
            }
        }
        Ok(total)
    }

    /// 고른 폐기 백업을 지운다 (#26). 사본과 색인을 함께 지우며 되돌릴 수 없다. 다른 저장소의 백업이 섞여 있으면
    /// 아무것도 지우지 않고 거부한다. 이미 없는 id 는 건너뛴다. 지운 수를 돌려준다
    pub fn delete_backups(&self, session: SessionId, ids: &[u64]) -> Result<u32, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let mut found = Vec::new();
        for &id in ids {
            if let Some(rec) = inner.store.backup_get(id)? {
                if rec.repo != s.info.work_tree {
                    return Err(CoreError::Invalid(
                        pick(
                            "다른 저장소의 백업입니다",
                            "This backup belongs to another repository",
                        )
                        .into(),
                    ));
                }
                found.push(rec);
            }
        }
        for rec in &found {
            inner.delete_file_backup(rec)?;
        }
        Ok(found.len() as u32)
    }

    /// 이 저장소의 폐기 백업 중 `before_ms`(epoch 밀리초)보다 먼저 만든 것을 모두 지운다 (#26 "N일보다 오래된 것").
    /// 되돌릴 수 없다. 지운 수를 돌려준다
    pub fn delete_backups_before(
        &self,
        session: SessionId,
        before_ms: i64,
    ) -> Result<u32, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        inner.delete_file_backups_before(&s.info.work_tree, before_ms)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn due_once_a_day_or_when_clock_goes_back() {
        assert!(prune_due(None, 1_000));
        assert!(!prune_due(Some(1_000), 1_000));
        assert!(!prune_due(Some(1_000), 1_000 + DAY_SECS - 1));
        assert!(prune_due(Some(1_000), 1_000 + DAY_SECS));
        assert!(prune_due(Some(5_000), 1_000));
    }

    /// 백업 사본 하나 (`<root>/<key>/<stamp>/<rel>`)
    fn record(root: &Path, stamp: &str, rel: &str) -> BackupRecord {
        BackupRecord {
            id: 1,
            repo: PathBuf::from("/r"),
            rel_path: rel.into(),
            saved_at: 0,
            blob_path: root.join("key").join(stamp).join(rel),
            reason: "discard".into(),
        }
    }

    #[test]
    fn removes_whole_stamp_dir_and_empty_repo_dir_only_under_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        let a = record(&root, "1-0", "src/deep/a.txt");
        let b = record(&root, "2-1", "b.txt");
        for rec in [&a, &b] {
            std::fs::create_dir_all(rec.blob_path.parent().unwrap()).unwrap();
            std::fs::write(&rec.blob_path, "x").unwrap();
        }
        remove_backup_copy(&root, &a).unwrap();
        assert!(!root.join("key/1-0").exists());
        // 다른 사본이 남아 있어 저장소 키 폴더는 그대로
        assert!(b.blob_path.exists());
        remove_backup_copy(&root, &b).unwrap();
        assert!(!root.join("key").exists());
        assert!(root.exists());
        // 이미 없는 사본은 지운 것으로 본다
        remove_backup_copy(&root, &b).unwrap();
        // 백업 폴더 밖을 가리키면 건드리지 않는다
        let outside = dir.path().join("keep.txt");
        std::fs::write(&outside, "x").unwrap();
        let stray = BackupRecord {
            blob_path: outside.clone(),
            ..record(&root, "3-2", "keep.txt")
        };
        remove_backup_copy(&root, &stray).unwrap();
        assert!(outside.exists());
    }
}
