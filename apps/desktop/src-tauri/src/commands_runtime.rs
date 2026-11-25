//! 포트와 무관한 환경별 UI 설정. 읽기에 실패하면 빈 값으로 대체하지 않는다.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;

use crate::error::IpcError;
use crate::runtime_profile::{RuntimeInfo, RuntimeProfile};

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
}
