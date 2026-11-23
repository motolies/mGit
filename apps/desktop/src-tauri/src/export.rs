//! 창을 띄우지 않고 TS 바인딩만 생성한다. `pnpm gen:ipc` 가 이 테스트를 실행한다.

/// bindings.ts 를 생성한다. 실패하면 테스트가 실패한다
#[test]
fn export_bindings() {
    crate::specta_builder()
        .export(crate::ts_config(), crate::bindings_path())
        .expect("TS 바인딩 내보내기 실패");
}
