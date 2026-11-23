use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use crate::log::CommandLogRecord;
use crate::oid::Oid;

/// 최근 항목 종류
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecentKind {
    Repo,
    Folder,
}

/// 최근 저장소·폴더
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: PathBuf,
    pub kind: RecentKind,
    pub name: String,
    pub pinned: bool,
    /// epoch 밀리초
    pub last_opened_at: i64,
}

/// discard 백업 색인 항목 (CHG-04)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: u64,
    pub repo: PathBuf,
    /// 작업 트리 기준 상대 경로
    pub rel_path: String,
    /// epoch 밀리초
    pub saved_at: i64,
    /// 백업 사본의 절대 경로
    pub blob_path: PathBuf,
    /// 사유 (`discard`, `discard-lines` …)
    pub reason: String,
}

/// 저장소 오류
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{}", crate::messages::store_db(.0))]
    Db(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// 로컬 저장 포트. `mgit-store` 가 SQLite 로 구현한다. 모든 메서드는 동기·블로킹이다
pub trait Store: Send + Sync + 'static {
    /// 최근 목록 (고정 → 최근 순)
    fn recent_list(&self) -> Result<Vec<RecentEntry>, StoreError>;
    /// 최근 목록에 넣거나 시각을 갱신한다
    fn recent_touch(&self, path: &Path, kind: RecentKind, name: &str) -> Result<(), StoreError>;
    /// 고정 여부
    fn recent_pin(&self, path: &Path, pinned: bool) -> Result<(), StoreError>;
    /// 제거
    fn recent_remove(&self, path: &Path) -> Result<(), StoreError>;

    /// 명령 로그 저장 (쓰기·네트워크 명령)
    fn log_command(&self, record: &CommandLogRecord) -> Result<(), StoreError>;
    /// 최근 명령 로그 (최신 순)
    fn command_log_recent(&self, limit: u32) -> Result<Vec<CommandLogRecord>, StoreError>;

    /// 백업 색인 추가. 새 id 를 돌려준다 (`record.id` 는 무시)
    fn backup_add(&self, record: &BackupRecord) -> Result<u64, StoreError>;
    /// 저장소의 백업 목록 (최신 순)
    fn backups_for(&self, repo: &Path, limit: u32) -> Result<Vec<BackupRecord>, StoreError>;
    /// 백업 하나
    fn backup_get(&self, id: u64) -> Result<Option<BackupRecord>, StoreError>;

    /// 설정값 (JSON 문자열)
    fn setting_get(&self, key: &str) -> Result<Option<String>, StoreError>;
    /// 설정값 저장
    fn setting_set(&self, key: &str, value_json: &str) -> Result<(), StoreError>;

    /// 마지막으로 열려 있던 탭 경로
    fn open_tabs_get(&self) -> Result<Vec<PathBuf>, StoreError>;
    /// 열린 탭 저장
    fn open_tabs_set(&self, paths: &[PathBuf]) -> Result<(), StoreError>;

    /// mGit 이 만든 스태시가 어느 워크트리에서 만들어졌는지 기록
    fn stash_origin_set(&self, repo: &Path, stash: &Oid, worktree: &Path)
    -> Result<(), StoreError>;
    /// 스태시의 워크트리
    fn stash_origin_get(&self, repo: &Path, stash: &Oid) -> Result<Option<PathBuf>, StoreError>;
}

/// 메모리 구현 (테스트·벤치). 프로세스가 끝나면 사라진다
#[derive(Debug, Default)]
pub struct MemoryStore {
    inner: Mutex<MemoryInner>,
}

/// `MemoryStore` 내부 상태
#[derive(Debug, Default)]
struct MemoryInner {
    recent: Vec<RecentEntry>,
    commands: Vec<CommandLogRecord>,
    backups: Vec<BackupRecord>,
    settings: HashMap<String, String>,
    open_tabs: Vec<PathBuf>,
    stash_origin: HashMap<(PathBuf, Oid), PathBuf>,
}

impl MemoryStore {
    /// 빈 저장소
    pub fn new() -> Self {
        Self::default()
    }

    /// 내부 락
    fn lock(&self) -> std::sync::MutexGuard<'_, MemoryInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 현재 시각 (epoch 밀리초)
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Store for MemoryStore {
    fn recent_list(&self) -> Result<Vec<RecentEntry>, StoreError> {
        let mut v = self.lock().recent.clone();
        v.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.last_opened_at.cmp(&a.last_opened_at))
        });
        Ok(v)
    }

    fn recent_touch(&self, path: &Path, kind: RecentKind, name: &str) -> Result<(), StoreError> {
        let mut g = self.lock();
        let now = now_millis();
        if let Some(e) = g.recent.iter_mut().find(|e| e.path == path) {
            e.last_opened_at = now;
            e.kind = kind;
            e.name = name.to_string();
        } else {
            g.recent.push(RecentEntry {
                path: path.to_path_buf(),
                kind,
                name: name.to_string(),
                pinned: false,
                last_opened_at: now,
            });
        }
        Ok(())
    }

    fn recent_pin(&self, path: &Path, pinned: bool) -> Result<(), StoreError> {
        if let Some(e) = self.lock().recent.iter_mut().find(|e| e.path == path) {
            e.pinned = pinned;
        }
        Ok(())
    }

    fn recent_remove(&self, path: &Path) -> Result<(), StoreError> {
        self.lock().recent.retain(|e| e.path != path);
        Ok(())
    }

    fn log_command(&self, record: &CommandLogRecord) -> Result<(), StoreError> {
        self.lock().commands.push(record.clone());
        Ok(())
    }

    fn command_log_recent(&self, limit: u32) -> Result<Vec<CommandLogRecord>, StoreError> {
        let g = self.lock();
        Ok(g.commands
            .iter()
            .rev()
            .take(limit as usize)
            .cloned()
            .collect())
    }

    fn backup_add(&self, record: &BackupRecord) -> Result<u64, StoreError> {
        let mut g = self.lock();
        let id = g.backups.len() as u64 + 1;
        g.backups.push(BackupRecord {
            id,
            ..record.clone()
        });
        Ok(id)
    }

    fn backups_for(&self, repo: &Path, limit: u32) -> Result<Vec<BackupRecord>, StoreError> {
        let g = self.lock();
        Ok(g.backups
            .iter()
            .rev()
            .filter(|b| b.repo == repo)
            .take(limit as usize)
            .cloned()
            .collect())
    }

    fn backup_get(&self, id: u64) -> Result<Option<BackupRecord>, StoreError> {
        Ok(self.lock().backups.iter().find(|b| b.id == id).cloned())
    }

    fn setting_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.lock().settings.get(key).cloned())
    }

    fn setting_set(&self, key: &str, value_json: &str) -> Result<(), StoreError> {
        self.lock()
            .settings
            .insert(key.to_string(), value_json.to_string());
        Ok(())
    }

    fn open_tabs_get(&self) -> Result<Vec<PathBuf>, StoreError> {
        Ok(self.lock().open_tabs.clone())
    }

    fn open_tabs_set(&self, paths: &[PathBuf]) -> Result<(), StoreError> {
        self.lock().open_tabs = paths.to_vec();
        Ok(())
    }

    fn stash_origin_set(
        &self,
        repo: &Path,
        stash: &Oid,
        worktree: &Path,
    ) -> Result<(), StoreError> {
        self.lock()
            .stash_origin
            .insert((repo.to_path_buf(), *stash), worktree.to_path_buf());
        Ok(())
    }

    fn stash_origin_get(&self, repo: &Path, stash: &Oid) -> Result<Option<PathBuf>, StoreError> {
        Ok(self
            .lock()
            .stash_origin
            .get(&(repo.to_path_buf(), *stash))
            .cloned())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_recent_orders_pinned_first() {
        let s = MemoryStore::new();
        s.recent_touch(Path::new("/a"), RecentKind::Repo, "a")
            .unwrap();
        s.recent_touch(Path::new("/b"), RecentKind::Folder, "b")
            .unwrap();
        s.recent_pin(Path::new("/a"), true).unwrap();
        let list = s.recent_list().unwrap();
        assert_eq!(list[0].path, Path::new("/a"));
        assert!(list[0].pinned);
        s.recent_remove(Path::new("/a")).unwrap();
        assert_eq!(s.recent_list().unwrap().len(), 1);
    }
}
