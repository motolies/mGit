//! 앱을 조립하기 전에 확정하는 실행 환경. 배포 데이터는 이동하거나 복사하지 않는다.
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

const PRODUCTION_ID: &str = "io.github.motolies.mgit";

#[derive(Clone, Debug, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Production,
    Development,
    Test,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub kind: RuntimeKind,
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeProfile {
    pub info: RuntimeInfo,
    pub identifier: String,
    pub keyring_service: String,
    pub root: Option<PathBuf>,
    pub data_store_identifier: Option<[u8; 16]>,
}

impl RuntimeProfile {
    /// 빌드 종류와 런처 설정을 함께 검사하고 checkout 자체에서 워크트리 ID를 계산한다.
    pub fn detect() -> Result<Self, String> {
        let requested = std::env::var("MGIT_RUNTIME_MODE").unwrap_or_default();
        let kind = select_kind(
            cfg!(debug_assertions),
            tauri::is_dev(),
            env!("MGIT_BUILD_RUNTIME_MODE"),
            &requested,
        )?;
        if kind == RuntimeKind::Production {
            return Ok(Self::production());
        }
        let checkout = dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .map_err(|e| {
                mgit_l10n::tr!(
                    "작업 사본 경로를 확인할 수 없습니다: {e}",
                    "Could not resolve the working copy path: {e}"
                )
            })?;
        if let Some(expected) = std::env::var_os("MGIT_CHECKOUT_ROOT") {
            let expected = dunce::canonicalize(expected).map_err(|e| e.to_string())?;
            if expected != checkout {
                return Err(mgit_l10n::pick(
                    "런처와 빌드가 서로 다른 작업 사본을 사용하고 있습니다",
                    "The launcher and build use different working copies",
                )
                .into());
            }
        }
        let run_id = std::env::var("MGIT_TEST_RUN_ID")
            .unwrap_or_else(|_| uuid::Uuid::new_v4().simple().to_string());
        let profile = Self::isolated(&checkout, kind, &run_id)?;
        if let Some(root) = &profile.root {
            std::fs::create_dir_all(root).map_err(|e| {
                mgit_l10n::tr!(
                    "환경 디렉터리를 만들 수 없습니다: {e}",
                    "Could not create the runtime directory: {e}"
                )
            })?;
        }
        Ok(profile)
    }

    /// 배포 앱의 식별자·키체인·기본 WebKit 저장소를 그대로 유지한다.
    pub(crate) fn production() -> Self {
        Self {
            info: RuntimeInfo {
                kind: RuntimeKind::Production,
                id: "production".into(),
                title: "mGit".into(),
            },
            identifier: PRODUCTION_ID.into(),
            keyring_service: "mGit".into(),
            root: None,
            data_store_identifier: None,
        }
    }

    /// 정규화된 checkout 경로와 테스트 실행 ID만으로 격리 자원을 결정한다.
    pub(crate) fn isolated(
        checkout: &Path,
        kind: RuntimeKind,
        run_id: &str,
    ) -> Result<Self, String> {
        let checkout = dunce::canonicalize(checkout).map_err(|e| e.to_string())?;
        let path = checkout.to_str().ok_or(mgit_l10n::pick(
            "작업 사본 경로가 UTF-8 형식이 아닙니다",
            "The working copy path is not valid UTF-8",
        ))?;
        let id = format!("{:x}", Sha256::digest(path.as_bytes()))[..16].to_string();
        let name = checkout
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("checkout");
        let mut root = checkout.join("target/runtime").join(&id);
        let (identifier, title) = match kind {
            RuntimeKind::Development => (
                format!("{PRODUCTION_ID}.dev.{id}"),
                format!("mGit Dev · {name}"),
            ),
            RuntimeKind::Test => {
                if run_id.is_empty()
                    || run_id.len() > 32
                    || !run_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err(mgit_l10n::pick(
                        "테스트 실행 ID는 영문·숫자·하이픈 1~32자여야 합니다",
                        "The test run ID must contain 1–32 letters, digits, or hyphens",
                    )
                    .into());
                }
                root = root.join("test").join(run_id);
                (
                    format!("{PRODUCTION_ID}.test.{id}.{run_id}"),
                    format!("mGit TEST · {name}"),
                )
            }
            RuntimeKind::Production => {
                return Err(mgit_l10n::pick(
                    "배포 환경에서는 작업 사본의 저장소를 사용할 수 없습니다",
                    "Production mode cannot use a working-copy data directory",
                )
                .into());
            }
        };
        let mut data_store_identifier = [0; 16];
        data_store_identifier.copy_from_slice(&Sha256::digest(identifier.as_bytes())[..16]);
        let id = if kind == RuntimeKind::Test {
            format!("{id}.{run_id}")
        } else {
            id
        };
        Ok(Self {
            info: RuntimeInfo { kind, id, title },
            keyring_service: identifier.replacen(PRODUCTION_ID, "mGit", 1),
            identifier,
            root: Some(root),
            data_store_identifier: Some(data_store_identifier),
        })
    }

    /// 플러그인·창 생성 전에 앱 ID와 모든 앱 디렉터리 및 WebKit 저장소를 바꾼다.
    pub fn configure(&self, config: &mut tauri::Config) {
        let Some(root) = &self.root else {
            return;
        };
        config.identifier = self.identifier.clone();
        config.product_name = Some(self.info.title.clone());
        config.app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(root.clone()),
        );
        for window in &mut config.app.windows {
            window.title = self.info.title.clone();
            window.data_store_identifier = self.data_store_identifier;
            window.data_directory = Some(root.join("webview"));
        }
    }

    /// 개발·테스트의 자동 fetch는 명시적으로 저장된 설정이 없으면 끈다.
    pub fn auto_fetch_default(&self) -> u32 {
        if self.info.kind == RuntimeKind::Production {
            5
        } else {
            0
        }
    }
}

/// 디버그 여부만으로 배포를 판단하지 않아 최적화한 개발 실행도 격리한다.
fn select_kind(
    debug: bool,
    tauri_dev: bool,
    built_mode: &str,
    requested: &str,
) -> Result<RuntimeKind, String> {
    if !matches!(requested, "" | "development" | "test") {
        return Err(mgit_l10n::pick(
            "MGIT_RUNTIME_MODE 값이 올바르지 않습니다",
            "Invalid MGIT_RUNTIME_MODE value",
        )
        .into());
    }
    if requested == "test" || built_mode == "test" {
        Ok(RuntimeKind::Test)
    } else if debug || tauri_dev || built_mode == "development" || requested == "development" {
        Ok(RuntimeKind::Development)
    } else {
        Ok(RuntimeKind::Production)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 직접 실행과 최적화 개발 빌드가 배포로 분류되지 않는지 확인한다.
    #[test]
    fn development_detection_cannot_be_downgraded() {
        assert_eq!(
            select_kind(false, true, "", "").unwrap(),
            RuntimeKind::Development
        );
        assert_eq!(
            select_kind(false, false, "development", "").unwrap(),
            RuntimeKind::Development
        );
        assert_eq!(
            select_kind(false, false, "", "").unwrap(),
            RuntimeKind::Production
        );
        assert!(select_kind(true, true, "", "production").is_err());
    }

    /// 컨텍스트 변경은 창·플러그인보다 먼저 적용하고 배포 설정은 건드리지 않는다.
    #[test]
    fn config_is_isolated_before_build_and_production_is_unchanged() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let original = serde_json::to_value(&config).unwrap();
        RuntimeProfile::production().configure(&mut config);
        assert_eq!(serde_json::to_value(&config).unwrap(), original);
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let dev = RuntimeProfile::isolated(&checkout, RuntimeKind::Development, "unused").unwrap();
        dev.configure(&mut config);
        assert_eq!(config.identifier, dev.identifier);
        assert_eq!(
            config.app.windows[0].data_store_identifier,
            dev.data_store_identifier
        );
        assert_eq!(config.app.windows[0].title, dev.info.title);
        assert_eq!(
            config.app.app_directories_override,
            Some(tauri::utils::config::AppDirectoriesOverride::Root(
                dev.root.unwrap()
            ))
        );
    }

    /// 워크트리·테스트 실행은 모든 식별자가 다르고 배포 계약은 유지된다.
    #[test]
    fn resources_are_stable_and_isolated() {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let dev = RuntimeProfile::isolated(&checkout, RuntimeKind::Development, "unused").unwrap();
        let again = RuntimeProfile::isolated(
            &checkout.join("apps/.."),
            RuntimeKind::Development,
            "unused",
        )
        .unwrap();
        let a = RuntimeProfile::isolated(&checkout, RuntimeKind::Test, "run-a").unwrap();
        let b = RuntimeProfile::isolated(&checkout, RuntimeKind::Test, "run-b").unwrap();
        let other = RuntimeProfile::isolated(
            &checkout.join("apps/desktop"),
            RuntimeKind::Development,
            "unused",
        )
        .unwrap();
        assert_ne!(dev.identifier, other.identifier);
        assert_ne!(dev.keyring_service, other.keyring_service);
        assert_ne!(dev.data_store_identifier, other.data_store_identifier);
        assert_eq!(dev.root, again.root);
        assert_ne!(dev.identifier, a.identifier);
        assert_ne!(a.root, b.root);
        assert_ne!(a.data_store_identifier, b.data_store_identifier);
        assert_eq!(RuntimeProfile::production().keyring_service, "mGit");
        assert_eq!(dev.auto_fetch_default(), 0);
        assert!(RuntimeProfile::isolated(&checkout, RuntimeKind::Test, "../escape").is_err());
    }
}
