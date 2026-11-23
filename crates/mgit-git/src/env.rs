use mgit_model::{EnvProfile, LOCAL_ENV_VARS};
use tokio::process::Command;

/// 명세 2.3 환경 변수 정책을 명령에 적용한다.
/// - `local_env_vars` 는 `git rev-parse --local-env-vars` 결과(없으면 상수)
/// - `extra` 는 모든 명령에 붙는 추가 변수(macOS 로그인 셸 PATH 등)
/// - `network` 는 `Network` 프로파일에만 붙는 변수(askpass 헬퍼 경로·소켓·토큰)
pub fn apply_env(
    cmd: &mut Command,
    profile: EnvProfile,
    local_env_vars: &[String],
    extra: &[(String, String)],
    network: &[(String, String)],
) {
    for var in LOCAL_ENV_VARS {
        cmd.env_remove(var);
    }
    for var in local_env_vars {
        cmd.env_remove(var);
    }
    for (k, v) in extra {
        cmd.env(k, v);
    }
    for (k, v) in EnvProfile::COMMON {
        cmd.env(k, v);
    }
    for (k, v) in profile.vars() {
        cmd.env(k, v);
    }
    if profile == EnvProfile::Network {
        for (k, v) in network {
            cmd.env(k, v);
        }
    }
}

/// macOS 에서 Finder 로 실행하면 PATH 가 빈약하다. 로그인 셸(`$SHELL -ilc '/usr/bin/env -0'`)의
/// PATH 를 3초 안에 읽어 현재 PATH 앞에 합친다. 실패하면 `None` (현재 PATH 그대로)
pub async fn login_shell_path() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", "/usr/bin/env -0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let shell_path = text
        .split('\0')
        .find_map(|kv| kv.strip_prefix("PATH="))?
        .to_string();
    let current = std::env::var("PATH").unwrap_or_default();
    let mut merged: Vec<&str> = Vec::new();
    for p in shell_path.split(':').chain(current.split(':')) {
        if !p.is_empty() && !merged.contains(&p) {
            merged.push(p);
        }
    }
    Some(merged.join(":"))
}
