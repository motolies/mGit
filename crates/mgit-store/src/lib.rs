//! SQLite 로컬 저장 (`mgit-model::Store` 구현).
//!
//! WAL 모드, 단일 커넥션을 `Mutex` 로 직렬화한다. 모든 메서드는 동기·블로킹이며
//! 호출 빈도가 낮고 ms 단위라 코어가 그대로 부른다.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use mgit_model::{
    BackupRecord, CommandLogRecord, Oid, RecentEntry, RecentKind, Store, StoreError, now_millis,
};
use rusqlite::{Connection, OptionalExtension, params};

/// 스키마 버전. 올리면 `migrate` 에 단계를 추가한다
const SCHEMA_VERSION: i64 = 1;

/// SQLite 기반 저장소
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for SqliteStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SqliteStore")
    }
}

/// rusqlite 오류를 포트 오류로
fn db_err(e: rusqlite::Error) -> StoreError {
    StoreError::Db(e.to_string())
}

impl SqliteStore {
    /// DB 파일을 열거나 만든다. 디렉터리가 없으면 만든다
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        Self::init(conn)
    }

    /// 메모리 DB (테스트)
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory().map_err(db_err)?;
        Self::init(conn)
    }

    /// PRAGMA 와 마이그레이션
    fn init(conn: Connection) -> Result<Self, StoreError> {
        conn.busy_timeout(Duration::from_secs(1)).map_err(db_err)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )
        .map_err(db_err)?;
        migrate(&conn)?;
        Ok(SqliteStore {
            conn: Mutex::new(conn),
        })
    }

    /// 커넥션 락
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 스키마를 만들거나 올린다
fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(db_err)?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS recent (
                path TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                last_opened_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS command_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                args_json TEXT NOT NULL,
                cwd TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                elapsed_ms INTEGER NOT NULL,
                status INTEGER,
                stderr_tail TEXT NOT NULL,
                is_write INTEGER NOT NULL,
                cancelled INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS backup (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                saved_at INTEGER NOT NULL,
                blob_path TEXT NOT NULL,
                reason TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS backup_repo ON backup(repo, saved_at);
            CREATE TABLE IF NOT EXISTS setting (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS open_tabs (
                ordinal INTEGER PRIMARY KEY,
                path TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stash_origin (
                repo TEXT NOT NULL,
                stash_oid TEXT NOT NULL,
                worktree TEXT NOT NULL,
                PRIMARY KEY (repo, stash_oid)
            );",
        )
        .map_err(db_err)?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(db_err)?;
    Ok(())
}

/// 경로를 DB 문자열로
fn p(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `RecentKind` ↔ 문자열
fn kind_str(kind: RecentKind) -> &'static str {
    match kind {
        RecentKind::Repo => "repo",
        RecentKind::Folder => "folder",
    }
}

/// 문자열 → `RecentKind` (모르면 repo)
fn kind_of(s: &str) -> RecentKind {
    if s == "folder" {
        RecentKind::Folder
    } else {
        RecentKind::Repo
    }
}

impl Store for SqliteStore {
    fn recent_list(&self) -> Result<Vec<RecentEntry>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT path, kind, name, pinned, last_opened_at FROM recent
                 ORDER BY pinned DESC, last_opened_at DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RecentEntry {
                    path: PathBuf::from(r.get::<_, String>(0)?),
                    kind: kind_of(&r.get::<_, String>(1)?),
                    name: r.get(2)?,
                    pinned: r.get::<_, i64>(3)? != 0,
                    last_opened_at: r.get(4)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn recent_touch(&self, path: &Path, kind: RecentKind, name: &str) -> Result<(), StoreError> {
        self.conn()
            .execute(
                "INSERT INTO recent (path, kind, name, pinned, last_opened_at)
                 VALUES (?1, ?2, ?3, 0, ?4)
                 ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, name = excluded.name,
                    last_opened_at = excluded.last_opened_at",
                params![p(path), kind_str(kind), name, now_millis()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn recent_pin(&self, path: &Path, pinned: bool) -> Result<(), StoreError> {
        self.conn()
            .execute(
                "UPDATE recent SET pinned = ?2 WHERE path = ?1",
                params![p(path), pinned as i64],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn recent_remove(&self, path: &Path) -> Result<(), StoreError> {
        self.conn()
            .execute("DELETE FROM recent WHERE path = ?1", params![p(path)])
            .map_err(db_err)?;
        Ok(())
    }

    fn log_command(&self, record: &CommandLogRecord) -> Result<(), StoreError> {
        let args_json = serde_json::to_string(&record.args).unwrap_or_default();
        self.conn()
            .execute(
                "INSERT INTO command_log
                 (args_json, cwd, started_at, elapsed_ms, status, stderr_tail, is_write, cancelled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    args_json,
                    p(&record.cwd),
                    record.started_at,
                    record.elapsed_ms as i64,
                    record.status,
                    record.stderr_tail,
                    record.is_write as i64,
                    record.cancelled as i64,
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn command_log_recent(&self, limit: u32) -> Result<Vec<CommandLogRecord>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, args_json, cwd, started_at, elapsed_ms, status, stderr_tail, is_write, cancelled
                 FROM command_log ORDER BY id DESC LIMIT ?1",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                let args: Vec<String> =
                    serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or_default();
                Ok(CommandLogRecord {
                    id: r.get::<_, i64>(0)? as u64,
                    args,
                    cwd: PathBuf::from(r.get::<_, String>(2)?),
                    started_at: r.get(3)?,
                    elapsed_ms: r.get::<_, i64>(4)? as u32,
                    status: r.get(5)?,
                    stderr_tail: r.get(6)?,
                    is_write: r.get::<_, i64>(7)? != 0,
                    cancelled: r.get::<_, i64>(8)? != 0,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn backup_add(&self, record: &BackupRecord) -> Result<u64, StoreError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO backup (repo, rel_path, saved_at, blob_path, reason)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                p(&record.repo),
                record.rel_path,
                record.saved_at,
                p(&record.blob_path),
                record.reason
            ],
        )
        .map_err(db_err)?;
        Ok(conn.last_insert_rowid() as u64)
    }

    fn backups_for(&self, repo: &Path, limit: u32) -> Result<Vec<BackupRecord>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, repo, rel_path, saved_at, blob_path, reason FROM backup
                 WHERE repo = ?1 ORDER BY id DESC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![p(repo), limit as i64], backup_row)
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn backup_get(&self, id: u64) -> Result<Option<BackupRecord>, StoreError> {
        self.conn()
            .query_row(
                "SELECT id, repo, rel_path, saved_at, blob_path, reason FROM backup WHERE id = ?1",
                params![id as i64],
                backup_row,
            )
            .optional()
            .map_err(db_err)
    }

    fn setting_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.conn()
            .query_row(
                "SELECT value_json FROM setting WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)
    }

    fn setting_set(&self, key: &str, value_json: &str) -> Result<(), StoreError> {
        self.conn()
            .execute(
                "INSERT INTO setting (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                params![key, value_json],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn open_tabs_get(&self) -> Result<Vec<PathBuf>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT path FROM open_tabs ORDER BY ordinal")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok(PathBuf::from(r.get::<_, String>(0)?)))
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn open_tabs_set(&self, paths: &[PathBuf]) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute("DELETE FROM open_tabs", []).map_err(db_err)?;
        for (i, path) in paths.iter().enumerate() {
            tx.execute(
                "INSERT INTO open_tabs (ordinal, path) VALUES (?1, ?2)",
                params![i as i64, p(path)],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    fn stash_origin_set(
        &self,
        repo: &Path,
        stash: &Oid,
        worktree: &Path,
    ) -> Result<(), StoreError> {
        self.conn()
            .execute(
                "INSERT INTO stash_origin (repo, stash_oid, worktree) VALUES (?1, ?2, ?3)
                 ON CONFLICT(repo, stash_oid) DO UPDATE SET worktree = excluded.worktree",
                params![p(repo), stash.to_hex(), p(worktree)],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn stash_origin_get(&self, repo: &Path, stash: &Oid) -> Result<Option<PathBuf>, StoreError> {
        self.conn()
            .query_row(
                "SELECT worktree FROM stash_origin WHERE repo = ?1 AND stash_oid = ?2",
                params![p(repo), stash.to_hex()],
                |r| Ok(PathBuf::from(r.get::<_, String>(0)?)),
            )
            .optional()
            .map_err(db_err)
    }
}

/// 백업 행을 레코드로
fn backup_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<BackupRecord> {
    Ok(BackupRecord {
        id: r.get::<_, i64>(0)? as u64,
        repo: PathBuf::from(r.get::<_, String>(1)?),
        rel_path: r.get(2)?,
        saved_at: r.get(3)?,
        blob_path: PathBuf::from(r.get::<_, String>(4)?),
        reason: r.get(5)?,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn recent_round_trip_and_ordering() {
        let s = SqliteStore::open_in_memory().unwrap();
        s.recent_touch(Path::new("/a"), RecentKind::Repo, "a")
            .unwrap();
        s.recent_touch(Path::new("/b"), RecentKind::Folder, "b")
            .unwrap();
        s.recent_pin(Path::new("/a"), true).unwrap();
        let list = s.recent_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, Path::new("/a"));
        assert!(list[0].pinned);
        assert_eq!(list[1].kind, RecentKind::Folder);
        s.recent_remove(Path::new("/b")).unwrap();
        assert_eq!(s.recent_list().unwrap().len(), 1);
    }

    #[test]
    fn command_log_and_settings_and_tabs() {
        let s = SqliteStore::open_in_memory().unwrap();
        s.log_command(&CommandLogRecord {
            id: 0,
            args: vec!["commit".into(), "-F".into(), "-".into()],
            cwd: PathBuf::from("/r"),
            started_at: 1,
            elapsed_ms: 12,
            status: Some(0),
            stderr_tail: String::new(),
            is_write: true,
            cancelled: false,
        })
        .unwrap();
        let logs = s.command_log_recent(10).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].args[0], "commit");
        assert!(logs[0].is_write);

        assert_eq!(s.setting_get("x").unwrap(), None);
        s.setting_set("x", "{\"a\":1}").unwrap();
        s.setting_set("x", "{\"a\":2}").unwrap();
        assert_eq!(s.setting_get("x").unwrap().as_deref(), Some("{\"a\":2}"));

        s.open_tabs_set(&[PathBuf::from("/a"), PathBuf::from("/b")])
            .unwrap();
        assert_eq!(
            s.open_tabs_get().unwrap(),
            vec![PathBuf::from("/a"), PathBuf::from("/b")]
        );
    }

    #[test]
    fn backups_and_stash_origin() {
        let s = SqliteStore::open_in_memory().unwrap();
        let id = s
            .backup_add(&BackupRecord {
                id: 0,
                repo: PathBuf::from("/r"),
                rel_path: "a.txt".into(),
                saved_at: 5,
                blob_path: PathBuf::from("/bk/1/a.txt"),
                reason: "discard".into(),
            })
            .unwrap();
        assert_eq!(s.backup_get(id).unwrap().unwrap().rel_path, "a.txt");
        assert_eq!(s.backups_for(Path::new("/r"), 10).unwrap().len(), 1);
        assert!(s.backups_for(Path::new("/other"), 10).unwrap().is_empty());

        let oid = Oid::from_hex("a".repeat(40).as_bytes()).unwrap();
        s.stash_origin_set(Path::new("/r"), &oid, Path::new("/r/wt"))
            .unwrap();
        assert_eq!(
            s.stash_origin_get(Path::new("/r"), &oid).unwrap(),
            Some(PathBuf::from("/r/wt"))
        );
    }

    #[test]
    fn opens_file_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("mgit.db");
        {
            let s = SqliteStore::open(&path).unwrap();
            s.setting_set("k", "1").unwrap();
        }
        let s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.setting_get("k").unwrap().as_deref(), Some("1"));
    }
}
