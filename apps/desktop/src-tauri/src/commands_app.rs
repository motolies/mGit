//! 앱 수준 커맨드 (S7): 자격 증명 응답, 외부 앱 열기, 외부 앱 설정, 자동 fetch 간격 (RM-02), 화면 언어 (다국어 L3)

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use mgit_l10n::{Lang, pick, tr};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command;

use crate::error::IpcError;
use crate::state::AppState;

/// 외부 앱 종류
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ExternalKind {
    /// 파일 탐색기에서 보기 (Finder / 탐색기)
    Reveal,
    Editor,
    Terminal,
}

/// 외부 앱 설정 (UX-07). `custom` 은 공백으로 나눈 명령 + 경로
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExternalApps {
    /// `vscode` | `idea` | `custom` | `` (자동)
    pub editor: String,
    pub editor_custom: String,
    /// `terminal` | `iterm` | `wt` | `custom` | `` (자동)
    pub terminal: String,
    pub terminal_custom: String,
}

const SETTING_KEY: &str = "externalApps";
/// 외부 명령의 종료를 기다리는 시간. 더 오래 돌면 앱이 떠 있는 것으로 본다
const LAUNCH_WAIT: Duration = Duration::from_secs(3);

/// 자동 fetch 간격 설정 키. 값은 `{"minutes": n}`
const AUTO_FETCH_KEY: &str = "autoFetch";
/// 자동 fetch 간격 상한 (분, 하루)
const AUTO_FETCH_MAX_MINUTES: u32 = 1440;

/// 저장하는 자동 fetch 설정 (RM-02, 앱 전체 값 하나). `minutes` 가 0 이면 끔
#[derive(Debug, Serialize, Deserialize)]
struct AutoFetchSetting {
    minutes: u32,
}

/// 저장된 자동 fetch 간격 (분). 값이 없거나 읽지 못하거나 범위를 벗어나면 기본값이다. 앱 시작(`state.rs`)과
/// `auto_fetch_get` 이 함께 쓴다
pub(crate) fn saved_auto_fetch_minutes(store: &dyn mgit_model::Store, default_minutes: u32) -> u32 {
    store
        .setting_get(AUTO_FETCH_KEY)
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<AutoFetchSetting>(&j).ok())
        .map(|s| s.minutes)
        .filter(|m| *m <= AUTO_FETCH_MAX_MINUTES)
        .unwrap_or(default_minutes)
}

/// 분 단위 간격을 코어 간격으로 바꾼다 (0 이면 끔)
pub(crate) fn auto_fetch_interval(minutes: u32) -> Option<Duration> {
    (minutes > 0).then(|| Duration::from_secs(u64::from(minutes) * 60))
}

/// 자동 fetch 간격 입력 검사 (0~1440분)
fn check_auto_fetch_minutes(minutes: u32) -> Result<(), IpcError> {
    if minutes > AUTO_FETCH_MAX_MINUTES {
        return Err(IpcError::Internal {
            message: tr!(
                "자동 fetch 간격은 0~{AUTO_FETCH_MAX_MINUTES}분이어야 합니다: {minutes}",
                "Auto fetch interval must be 0–{AUTO_FETCH_MAX_MINUTES} minutes: {minutes}"
            ),
        });
    }
    Ok(())
}

/// 자격 증명 대화상자 답 (AU-01). `secret` 이 없으면 취소
#[tauri::command]
#[specta::specta]
pub async fn credential_reply(
    state: State<'_, AppState>,
    req_id: u32,
    secret: Option<String>,
    remember: bool,
) -> Result<(), IpcError> {
    state.credentials.reply(u64::from(req_id), secret, remember);
    Ok(())
}

/// 대상의 저장된 비밀을 지운다 (잘못 저장했을 때)
#[tauri::command]
#[specta::specta]
pub async fn credential_forget(state: State<'_, AppState>, target: String) -> Result<(), IpcError> {
    if let Some(s) = state.askpass() {
        s.forget(&target);
    }
    Ok(())
}

/// 외부 앱 설정 읽기
#[tauri::command]
#[specta::specta]
pub async fn external_apps_get(state: State<'_, AppState>) -> Result<ExternalApps, IpcError> {
    let raw = state
        .core()?
        .core
        .store()
        .setting_get(SETTING_KEY)
        .ok()
        .flatten();
    Ok(raw
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default())
}

/// 외부 앱 설정 저장
#[tauri::command]
#[specta::specta]
pub async fn external_apps_set(
    state: State<'_, AppState>,
    apps: ExternalApps,
) -> Result<(), IpcError> {
    let json = serde_json::to_string(&apps).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })?;
    state
        .core()?
        .core
        .store()
        .setting_set(SETTING_KEY, &json)
        .map_err(|e| IpcError::Internal {
            message: e.to_string(),
        })?;
    Ok(())
}

/// 자동 fetch 간격 읽기 (분, 0 이면 끔). 첫 실행의 기본값은 실행 환경을 따른다
#[tauri::command]
#[specta::specta]
pub async fn auto_fetch_get(
    state: State<'_, AppState>,
    profile: State<'_, crate::runtime_profile::RuntimeProfile>,
) -> Result<u32, IpcError> {
    Ok(saved_auto_fetch_minutes(
        state.core()?.core.store().as_ref(),
        profile.auto_fetch_default(),
    ))
}

/// 자동 fetch 간격 저장 (분, 0~1440, 0 이면 끔). 저장한 뒤 곧바로 적용한다 — 열린 저장소 탭과 폴더의 자동 fetch 를
/// 새 간격으로 다시 건다
#[tauri::command]
#[specta::specta]
pub async fn auto_fetch_set(state: State<'_, AppState>, minutes: u32) -> Result<(), IpcError> {
    check_auto_fetch_minutes(minutes)?;
    let json =
        serde_json::to_string(&AutoFetchSetting { minutes }).map_err(|e| IpcError::Internal {
            message: e.to_string(),
        })?;
    let core = &state.core()?.core;
    core.store()
        .setting_set(AUTO_FETCH_KEY, &json)
        .map_err(|e| IpcError::Internal {
            message: e.to_string(),
        })?;
    core.set_auto_fetch_interval(auto_fetch_interval(minutes));
    Ok(())
}

/// OS 의 화면 언어 (BCP 47 태그, 예: `ko-KR`). 프런트가 "시스템 언어 따름"을 정할 때 쓴다. macOS 는 사용자 선호
/// 언어 목록(`CFLocaleCopyPreferredLanguages`)의 첫 항목, Windows 는 사용자 UI 언어, 그 밖의 유닉스는
/// `LANGUAGE`·`LC_ALL`·`LC_MESSAGES`·`LANG` 순서다. 읽지 못하면 null (프런트는 영어로 정한다)
#[tauri::command]
#[specta::specta]
pub fn system_locale() -> Option<String> {
    sys_locale::get_locale()
}

/// Rust 가 만드는 화면 문구의 언어를 바꾼다 (`ko`·`en` 같은 언어 코드, 모르는 코드는 영어). 이미 만든 문구는 그대로고
/// 이후에 만드는 오류·일괄 작업 라벨 등부터 따른다
#[tauri::command]
#[specta::specta]
pub fn set_language(lang: String) {
    mgit_l10n::set(Lang::from_code(&lang));
}

/// 외부 앱으로 열기 (UX-07). Reveal 은 opener 플러그인, 나머지는 프리셋 명령을 셸 없이 띄우고
/// 실패하면 다음 후보로 넘어간다
#[tauri::command]
#[specta::specta]
pub async fn open_external(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: ExternalKind,
    path: String,
) -> Result<(), IpcError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(IpcError::Internal {
            message: tr!("경로가 없습니다: {path}", "Path does not exist: {path}"),
        });
    }
    if matches!(kind, ExternalKind::Reveal) {
        return app
            .opener()
            .reveal_item_in_dir(p)
            .map_err(|e| IpcError::Internal {
                message: e.to_string(),
            });
    }
    let apps = external_apps_get(state.clone()).await?;
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| p.to_path_buf())
    };
    let candidates = match kind {
        ExternalKind::Editor => editor_commands(&apps, &path),
        ExternalKind::Terminal => terminal_commands(&apps, &dir.to_string_lossy()),
        ExternalKind::Reveal => Vec::new(),
    };
    launch_first(&candidates, state.login_path().as_deref(), LAUNCH_WAIT)
        .await
        .map_err(|message| IpcError::Internal { message })
}

/// 후보 명령을 앞에서부터 실행한다. spawn 성공만으로는 판단하지 않는다: `open -a` 는 앱이 없어도
/// 뜨고 나서 실패하므로 종료 상태를 본다. `wait` 안에 끝나지 않으면 앱이 떠 있는 것으로 본다
/// (tokio 가 나중에 회수한다)
async fn launch_first(
    candidates: &[Vec<String>],
    path_env: Option<&str>,
    wait: Duration,
) -> Result<(), String> {
    let mut last_err = String::from(pick("실행할 명령이 없습니다", "No command to run"));
    for argv in candidates {
        let Some((cmd, args)) = argv.split_first() else {
            continue;
        };
        let mut c = Command::new(cmd);
        c.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(pe) = path_env {
            c.env("PATH", pe);
        }
        let mut child = match c.spawn() {
            Ok(child) => child,
            Err(e) => {
                last_err = format!("{}: {e}", argv.join(" "));
                continue;
            }
        };
        match tokio::time::timeout(wait, child.wait()).await {
            Err(_) => return Ok(()),
            Ok(Ok(status)) if status.success() => return Ok(()),
            Ok(Ok(status)) => last_err = format!("{}: {status}", argv.join(" ")),
            Ok(Err(e)) => last_err = format!("{}: {e}", argv.join(" ")),
        }
    }
    Err(last_err)
}

/// 공백으로 나눈 사용자 명령 + 경로
fn custom_argv(custom: &str, path: &str) -> Option<Vec<String>> {
    let mut v: Vec<String> = custom.split_whitespace().map(str::to_string).collect();
    if v.is_empty() {
        return None;
    }
    v.push(path.to_string());
    Some(v)
}

/// 에디터 후보 명령 (앞에서부터 시도)
fn editor_commands(apps: &ExternalApps, path: &str) -> Vec<Vec<String>> {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
    let mut out = Vec::new();
    match apps.editor.as_str() {
        "custom" => {
            if let Some(v) = custom_argv(&apps.editor_custom, path) {
                out.push(v);
            }
        }
        "vscode" if cfg!(target_os = "macos") => {
            out.push(s(&["open", "-a", "Visual Studio Code", path]))
        }
        "idea" if cfg!(target_os = "macos") => out.push(s(&["open", "-a", "IntelliJ IDEA", path])),
        "vscode" => out.push(s(&["code", path])),
        "idea" => out.push(s(&["idea", path])),
        _ => {}
    }
    // 폴백: PATH 의 code → idea → OS 기본 열기
    out.push(s(&["code", path]));
    out.push(s(&["idea", path]));
    let os = std::env::consts::OS;
    out.push(if Path::new(path).is_dir() {
        editor_fallback_dir(os, path)
    } else {
        editor_fallback(os, path)
    });
    out
}

/// OS 의 마지막 폴백. 파일을 실행하지 않고 텍스트로 여는 명령만 쓴다: `open` 이나 `start` 는
/// 저장소의 `.command`·실행 파일을 그대로 실행한다
fn editor_fallback(os: &str, path: &str) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
    match os {
        "macos" => s(&["open", "-t", path]),
        "windows" => s(&["notepad.exe", path]),
        _ => s(&["xdg-open", path]),
    }
}

/// 터미널 후보 명령
fn terminal_commands(apps: &ExternalApps, dir: &str) -> Vec<Vec<String>> {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
    let mut out = Vec::new();
    match apps.terminal.as_str() {
        "custom" => {
            if let Some(v) = custom_argv(&apps.terminal_custom, dir) {
                out.push(v);
            }
        }
        "iterm" if cfg!(target_os = "macos") => out.push(s(&["open", "-a", "iTerm", dir])),
        "terminal" if cfg!(target_os = "macos") => out.push(s(&["open", "-a", "Terminal", dir])),
        "wt" if cfg!(target_os = "windows") => out.push(s(&["wt.exe", "-d", dir])),
        _ => {}
    }
    out.extend(terminal_fallbacks(std::env::consts::OS, dir));
    out
}

/// 폴더의 마지막 폴백. macOS 는 Finder 에서 보여 주기만 한다: `open` 은 `.app` 번들 폴더를 실행한다
fn editor_fallback_dir(os: &str, path: &str) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
    match os {
        "macos" => s(&["open", "-R", path]),
        _ => editor_fallback(os, path),
    }
}

/// OS 의 터미널 폴백
fn terminal_fallbacks(os: &str, dir: &str) -> Vec<Vec<String>> {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
    match os {
        "macos" => vec![s(&["open", "-a", "Terminal", dir])],
        // `cmd /c start` 는 폴더 이름의 `&` 를 명령으로 해석하므로 쓰지 않는다
        "windows" => vec![s(&["wt.exe", "-d", dir])],
        _ => vec![s(&["x-terminal-emulator", "--working-directory", dir])],
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#[cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]
mod tests {
    use super::*;

    /// 문자열 슬라이스 → 후보 argv
    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|x| (*x).to_string()).collect()
    }

    /// 어느 OS 든 에디터 폴백은 파일을 실행하지 않는 명령이어야 한다
    #[test]
    fn editor_fallback_never_executes_the_file() {
        assert_eq!(
            editor_fallback("macos", "/r/x.command"),
            argv(&["open", "-t", "/r/x.command"])
        );
        assert_eq!(
            editor_fallback("windows", "C:\\r\\x.bat"),
            argv(&["notepad.exe", "C:\\r\\x.bat"])
        );
    }

    /// 폴더는 텍스트 편집기로 보낼 수 없고, `.app` 번들 폴더는 `open` 하면 실행된다
    #[test]
    fn folder_fallback_only_reveals() {
        assert_eq!(
            editor_fallback_dir("macos", "/r/Evil.app"),
            argv(&["open", "-R", "/r/Evil.app"])
        );
    }

    /// Windows 터미널 후보에 셸이 다시 해석하는 경로가 없어야 한다 (`&` 가 든 폴더 이름)
    #[test]
    fn windows_terminal_fallback_avoids_cmd_start() {
        let list = terminal_fallbacks("windows", "C:\\a&calc");
        assert!(!list.is_empty());
        for c in &list {
            assert!(!c.iter().any(|a| a == "start"), "{c:?}");
            assert!(!c.iter().any(|a| a.contains("cd /d")), "{c:?}");
        }
    }

    /// 종료 코드가 실패면 다음 후보로 넘어간다
    #[cfg(unix)]
    #[test]
    fn failing_candidate_falls_through_to_next() {
        let dir = std::env::temp_dir().join(format!("mgit-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("second");
        let script = format!("touch '{}'", marker.display());
        let list = vec![argv(&["false"]), argv(&["sh", "-c", &script])];
        tauri::async_runtime::block_on(launch_first(&list, None, Duration::from_secs(5))).unwrap();
        assert!(marker.exists(), "실패한 후보 뒤의 명령이 돌지 않았다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 모든 후보가 실패하면 오류를 돌려준다
    #[cfg(unix)]
    #[test]
    fn all_failed_reports_error() {
        let list = vec![argv(&["false"])];
        let err = tauri::async_runtime::block_on(launch_first(&list, None, Duration::from_secs(5)))
            .unwrap_err();
        assert!(err.contains("false"), "{err}");
    }

    /// 오래 떠 있는 앱은 성공으로 보고 기다리지 않는다
    #[cfg(unix)]
    #[test]
    fn long_running_app_counts_as_launched() {
        let list = vec![argv(&["sleep", "2"])];
        let started = std::time::Instant::now();
        tauri::async_runtime::block_on(launch_first(&list, None, Duration::from_millis(200)))
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// 저장된 값이 없거나 깨졌거나 범위를 벗어나면 5분, 저장된 값(끔 0 포함)은 그대로 읽는다
    #[test]
    fn saved_auto_fetch_minutes_defaults_and_reads_back() {
        let store = mgit_model::MemoryStore::new();
        assert_eq!(saved_auto_fetch_minutes(&store, 5), 5);
        assert_eq!(saved_auto_fetch_minutes(&store, 0), 0);
        use mgit_model::Store as _;
        for (raw, want) in [
            (r#"{"minutes":0}"#, 0),
            (r#"{"minutes":15}"#, 15),
            (r#"{"minutes":1440}"#, 1440),
            (r#"{"minutes":1441}"#, 5),
            (r#"{"min":10}"#, 5),
            ("not json", 5),
        ] {
            store.setting_set(AUTO_FETCH_KEY, raw).unwrap();
            assert_eq!(saved_auto_fetch_minutes(&store, 5), want, "{raw}");
        }
    }

    /// 0 은 끔, 나머지는 분 → 초. 1440 을 넘는 입력은 거부한다
    #[test]
    fn auto_fetch_minutes_map_to_interval_and_are_bounded() {
        assert_eq!(auto_fetch_interval(0), None);
        assert_eq!(auto_fetch_interval(5), Some(Duration::from_secs(300)));
        assert_eq!(auto_fetch_interval(1440), Some(Duration::from_secs(86_400)));
        assert!(check_auto_fetch_minutes(0).is_ok());
        assert!(check_auto_fetch_minutes(1440).is_ok());
        assert!(matches!(
            check_auto_fetch_minutes(1441),
            Err(IpcError::Internal { .. })
        ));
    }

    /// 테스트가 끝나면(패닉 포함) 프로세스 전역 언어를 기본값(한국어)으로 되돌린다
    struct RestoreKorean;

    impl Drop for RestoreKorean {
        /// 전역 언어를 한국어로 되돌린다
        fn drop(&mut self) {
            mgit_l10n::set(Lang::Ko);
        }
    }

    /// `set_language` 는 언어 코드를 `Lang::from_code` 규칙으로 읽어 Rust 문구 언어를 바꾼다. 이 바이너리의 다른
    /// 테스트는 언어에 따라 달라지는 문구를 비교하지 않으므로 잠깐 영어로 바뀌어도 겹치지 않는다
    #[test]
    fn set_language_switches_rust_text_language() {
        let _restore = RestoreKorean;
        set_language("en".into());
        assert_eq!(mgit_l10n::current(), Lang::En);
        assert_eq!(pick("열기", "Open"), "Open");
        set_language("ko-KR".into());
        assert_eq!(mgit_l10n::current(), Lang::Ko);
        set_language("fr".into());
        assert_eq!(mgit_l10n::current(), Lang::En);
        set_language("ko".into());
        assert_eq!(mgit_l10n::current(), Lang::Ko);
    }

    /// macOS 는 선호 언어 목록이 비지 않으므로 OS 로캘을 늘 읽는다 (BCP 47: 밑줄 대신 하이픈)
    #[cfg(target_os = "macos")]
    #[test]
    fn system_locale_reads_preferred_language_on_macos() {
        let locale = system_locale().unwrap();
        assert!(!locale.is_empty());
        assert!(!locale.contains('_'), "{locale}");
    }
}
