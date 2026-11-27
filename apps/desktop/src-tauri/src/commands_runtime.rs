//! 포트와 무관한 환경별 UI 설정. 읽기에 실패하면 빈 값으로 대체하지 않는다.
//! 개발·테스트 실행의 성능 기록 파일(`perf.jsonl`)도 같은 환경 폴더에 둔다.
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;

use crate::error::IpcError;
use crate::runtime_profile::{RuntimeInfo, RuntimeKind, RuntimeProfile};

type Snapshot = BTreeMap<String, String>;

pub struct UiSettings {
    path: PathBuf,
    lock: Mutex<()>,
}

impl UiSettings {
    /// 환경 경로만 받아 고정 파일에 저장한다. IPC에는 파일 경로를 노출하지 않는다.
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join("ui-settings.json"),
            lock: Mutex::new(()),
        }
    }

    /// 파일이 없는 첫 실행만 빈 설정으로 처리하고 손상·권한 오류는 전달한다.
    fn read(&self) -> Result<Snapshot, IpcError> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(internal),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Snapshot::new()),
            Err(e) => Err(internal(e)),
        }
    }

    /// 같은 프로세스의 키별 변경을 직렬화하고 임시 파일을 원자적으로 교체한다.
    fn set(&self, key: String, value: Option<String>) -> Result<(), IpcError> {
        let _guard = self.lock.lock().map_err(internal)?;
        let mut snapshot = self.read()?;
        if let Some(value) = value {
            snapshot.insert(key, value);
        } else {
            snapshot.remove(&key);
        }
        let bytes = serde_json::to_vec(&snapshot).map_err(internal)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).map_err(internal)?;
        std::fs::rename(&tmp, &self.path).map_err(internal)
    }
}

/// 저장 오류를 프런트가 표시할 수 있는 IPC 오류로 바꾼다.
fn internal(error: impl std::fmt::Display) -> IpcError {
    IpcError::Internal {
        message: error.to_string(),
    }
}

/// 성능 기록 파일의 상한 (넘으면 표시 한 줄을 남기고 더 쓰지 않는다)
const PERF_LOG_LIMIT: u64 = 20 * 1024 * 1024;

/// 이번 프로세스의 성능 기록 상태
#[derive(Default)]
struct PerfLogState {
    /// 이전 실행의 기록을 `perf.prev.jsonl` 로 넘겼는지 (첫 쓰기 때 한 번)
    rotated: bool,
    /// 이번 실행이 쓴 바이트 수
    bytes: u64,
    /// 상한에 닿아 기록을 멈췄는지
    capped: bool,
}

/// 개발·테스트 실행 전용 성능 기록(`perf.jsonl`). 배포 프로필은 경로가 없어 모든 쓰기를 거부한다.
pub struct PerfLog {
    path: Option<PathBuf>,
    limit: u64,
    state: Mutex<PerfLogState>,
}

impl PerfLog {
    /// 배포가 아닌 격리 실행 환경에서만 `dir/perf.jsonl` 을 쓴다. 파일은 첫 쓰기 전까지 건드리지 않는다.
    pub fn new(profile: &RuntimeProfile, dir: PathBuf) -> Self {
        let enabled = profile.info.kind != RuntimeKind::Production && profile.root.is_some();
        Self {
            path: enabled.then(|| dir.join("perf.jsonl")),
            limit: PERF_LOG_LIMIT,
            state: Mutex::new(PerfLogState::default()),
        }
    }

    /// 줄 묶음을 덧붙인다. 첫 쓰기에서 이전 실행의 파일을 넘기고, 상한을 넘으면 표시 줄을 쓰고 false 를 준다.
    fn append(&self, lines: &str) -> Result<bool, IpcError> {
        let Some(path) = &self.path else {
            return Err(internal(mgit_l10n::pick(
                "배포 환경에서는 성능 기록을 쓰지 않습니다",
                "Performance recording is disabled in production",
            )));
        };
        let mut state = self.state.lock().map_err(internal)?;
        if state.capped {
            return Ok(false);
        }
        if !state.rotated {
            match std::fs::rename(path, path.with_file_name("perf.prev.jsonl")) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(internal(e)),
            }
            state.rotated = true;
        }
        let body = lines.trim_end_matches('\n');
        if body.is_empty() {
            return Ok(true);
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(internal)?;
        let size = body.len() as u64 + 1;
        if state.bytes + size > self.limit {
            state.capped = true;
            writeln!(
                file,
                "{{\"t\":null,\"kind\":\"capped\",\"bytes\":{},\"limit\":{}}}",
                state.bytes, self.limit
            )
            .map_err(internal)?;
            return Ok(false);
        }
        file.write_all(body.as_bytes()).map_err(internal)?;
        file.write_all(b"\n").map_err(internal)?;
        state.bytes += size;
        Ok(true)
    }
}

/// 스토어 초기화 전에 실행 환경을 확인한다.
#[tauri::command]
#[specta::specta]
pub fn runtime_profile(profile: State<'_, RuntimeProfile>) -> RuntimeInfo {
    profile.info.clone()
}

/// 설정 어댑터 초기화를 위한 전체 snapshot을 읽는다.
#[tauri::command]
#[specta::specta]
pub fn ui_settings_snapshot(settings: State<'_, UiSettings>) -> Result<Snapshot, IpcError> {
    let _guard = settings.lock.lock().map_err(internal)?;
    settings.read()
}

/// 메모리에 반영한 설정 키 하나를 디스크에 저장한다. null은 삭제다.
#[tauri::command]
#[specta::specta]
pub fn ui_settings_set(
    settings: State<'_, UiSettings>,
    key: String,
    value: Option<String>,
) -> Result<(), IpcError> {
    settings.set(key, value)
}

/// 성능 기록기(개발·테스트 프로필)가 모은 JSON 줄을 덧붙인다. 배포 프로필은 거부하고, 상한에 닿으면 false 다.
/// UI 스레드를 막지 않도록 비동기 명령으로 둔다.
#[tauri::command]
#[specta::specta]
pub async fn perf_append(log: State<'_, PerfLog>, lines: String) -> Result<bool, IpcError> {
    log.append(&lines)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 포트가 바뀌어도 같은 설정 파일을 읽고 손상된 파일은 덮어쓰지 않는다.
    #[test]
    fn persists_key_updates_and_preserves_unreadable_settings() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../target/runtime-tests")
            .join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let settings = UiSettings::new(root.clone());
        settings.set("theme".into(), Some("dark".into())).unwrap();
        settings.set("language".into(), Some("ko".into())).unwrap();
        assert_eq!(
            UiSettings::new(root.clone()).read().unwrap()["theme"],
            "dark"
        );
        settings.set("theme".into(), None).unwrap();
        assert!(!settings.read().unwrap().contains_key("theme"));
        std::fs::write(&settings.path, "invalid JSON").unwrap();
        assert!(settings.set("language".into(), Some("en".into())).is_err());
        assert_eq!(
            std::fs::read_to_string(&settings.path).unwrap(),
            "invalid JSON"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 테스트마다 따로 쓰는 환경 폴더
    fn scratch_root() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../target/runtime-tests")
            .join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// 배포 프로필은 성능 기록을 거부하고 파일을 만들지 않는다.
    #[test]
    fn perf_log_rejects_production() {
        let root = scratch_root();
        let log = PerfLog::new(&RuntimeProfile::production(), root.clone());
        assert!(log.append("{\"t\":1,\"kind\":\"ipc\"}\n").is_err());
        assert!(!root.join("perf.jsonl").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 개발 프로필은 첫 쓰기에서 이전 실행 기록을 넘기고, 같은 실행의 다음 쓰기는 이어 붙인다.
    #[test]
    fn perf_log_rotates_once_and_appends() {
        let root = scratch_root();
        std::fs::write(root.join("perf.jsonl"), "old\n").unwrap();
        let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let dev = RuntimeProfile::isolated(&checkout, RuntimeKind::Development, "unused").unwrap();
        let log = PerfLog::new(&dev, root.clone());
        assert!(log.append("a\nb\n").unwrap());
        assert!(log.append("c").unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("perf.prev.jsonl")).unwrap(),
            "old\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("perf.jsonl")).unwrap(),
            "a\nb\nc\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 상한을 넘는 묶음은 쓰지 않고 표시 줄 하나만 남긴 뒤 계속 거절한다.
    #[test]
    fn perf_log_stops_at_limit() {
        let root = scratch_root();
        let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let test = RuntimeProfile::isolated(&checkout, RuntimeKind::Test, "perf-cap").unwrap();
        let mut log = PerfLog::new(&test, root.clone());
        log.limit = 8;
        assert!(log.append("1234567").unwrap());
        assert!(!log.append("89").unwrap());
        assert!(!log.append("x").unwrap());
        let text = std::fs::read_to_string(root.join("perf.jsonl")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "1234567");
        assert!(lines[1].contains("\"kind\":\"capped\""));
        std::fs::remove_dir_all(root).unwrap();
    }
}
