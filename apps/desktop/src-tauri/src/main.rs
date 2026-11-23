// 릴리스 빌드의 Windows 에서 콘솔 창이 뜨지 않게 한다
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 실행 파일 진입점. git·ssh 가 `GIT_ASKPASS`/`SSH_ASKPASS` 로 이 실행 파일을 다시 띄우면
/// (환경에 헬퍼 토큰이 있고 인자가 프롬프트 하나) Tauri 를 초기화하지 않고 askpass 모드로 끝낸다.
/// `--askpass <prompt>` 로 직접 부를 수도 있다. 그 외에는 lib 의 run() 이 앱을 조립한다
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let helper_mode = std::env::var_os(mgit_helper::ENV_TOKEN).is_some();
    if let Some(prompt) = match args.as_slice() {
        [_, flag, prompt] if flag == "--askpass" => Some(prompt.as_str()),
        [_, prompt] if helper_mode && !prompt.starts_with('-') => Some(prompt.as_str()),
        _ => None,
    } {
        std::process::exit(mgit_helper::askpass_main(prompt));
    }
    mgit_desktop_lib::run()
}
