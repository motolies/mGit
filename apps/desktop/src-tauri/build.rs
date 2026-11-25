/// Tauri 빌드 환경을 기록해 최적화된 개발 바이너리도 배포 저장소를 사용하지 않게 한다.
fn main() {
    println!("cargo:rerun-if-env-changed=MGIT_RUNTIME_MODE");
    let mode = std::env::var("MGIT_RUNTIME_MODE").unwrap_or_default();
    assert!(
        matches!(mode.as_str(), "" | "development" | "test"),
        "잘못된 MGIT_RUNTIME_MODE"
    );
    println!("cargo:rustc-env=MGIT_BUILD_RUNTIME_MODE={mode}");
    tauri_build::build()
}
