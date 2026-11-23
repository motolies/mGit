//! 빌드 멀티 모듈 (MOD-01·05)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{Module, ModuleKind, ModuleOverrides};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn detects_modules_from_build_files_and_remembers_scope() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    // Gradle
    repo.write_file(
        "settings.gradle.kts",
        "rootProject.name = \"demo\"\ninclude(\":app\", \":libs:core\")\n",
    );
    repo.write_file("app/build.gradle.kts", "");
    repo.write_file("libs/core/build.gradle.kts", "");
    // Maven
    repo.write_file(
        "pom.xml",
        "<project><modules><module>svc</module><module>missing</module></modules></project>",
    );
    repo.write_file("svc/pom.xml", "");
    // pnpm + package.json workspaces
    repo.write_file("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    repo.write_file("packages/ui/package.json", "{}");
    repo.write_file("packages/not-a-pkg/readme.md", "");
    repo.write_file("package.json", "{\"workspaces\": [\"apps/*\"]}");
    repo.write_file("apps/web/package.json", "{}");
    // Cargo
    repo.write_file("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n");
    repo.write_file("crates/x/Cargo.toml", "[package]\nname=\"x\"\n");
    repo.write_file("crates/noty/README.md", "");
    // Go
    repo.write_file("go.work", "go 1.22\nuse (\n  ./gosvc\n)\n");
    repo.write_file("gosvc/go.mod", "module gosvc\n");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let mods = core.modules(opened.session).unwrap();
    let paths: Vec<&str> = mods.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "app",
            "apps/web",
            "crates/x",
            "gosvc",
            "libs/core",
            "packages/ui",
            "svc"
        ],
        "{paths:?}"
    );
    let kind_of = |p: &str| mods.iter().find(|m| m.path == p).unwrap().kind;
    assert_eq!(kind_of("app"), ModuleKind::Gradle);
    assert_eq!(kind_of("libs/core"), ModuleKind::Gradle);
    assert_eq!(kind_of("svc"), ModuleKind::Maven);
    assert_eq!(kind_of("packages/ui"), ModuleKind::Npm);
    assert_eq!(kind_of("apps/web"), ModuleKind::Npm);
    assert_eq!(kind_of("crates/x"), ModuleKind::Cargo);
    assert_eq!(kind_of("gosvc"), ModuleKind::Go);
    assert_eq!(
        mods.iter().find(|m| m.path == "libs/core").unwrap().name,
        "core"
    );

    // 수동 보정: 추가 + 숨김
    core.set_module_overrides(
        opened.session,
        &ModuleOverrides {
            added: vec![Module {
                name: String::new(),
                path: "./tools/".into(),
                kind: ModuleKind::Gradle,
            }],
            hidden: vec!["svc".into()],
        },
    )
    .unwrap();
    repo.write_file("tools/x.txt", "");
    let mods = core.modules(opened.session).unwrap();
    let paths: Vec<&str> = mods.iter().map(|m| m.path.as_str()).collect();
    assert!(!paths.contains(&"svc"));
    let tools = mods.iter().find(|m| m.path == "tools").unwrap();
    assert_eq!(tools.name, "tools");
    assert_eq!(tools.kind, ModuleKind::Manual);
    assert!(
        core.set_module_overrides(
            opened.session,
            &ModuleOverrides {
                added: vec![Module {
                    name: "bad".into(),
                    path: "../out".into(),
                    kind: ModuleKind::Manual
                }],
                hidden: vec![],
            }
        )
        .is_err()
    );

    // 범위 기억 (MOD-05)
    assert!(core.module_scope(opened.session).unwrap().is_none());
    core.set_module_scope(opened.session, Some("libs/core/"))
        .unwrap();
    assert_eq!(
        core.module_scope(opened.session).unwrap().as_deref(),
        Some("libs/core")
    );
    core.set_module_scope(opened.session, None).unwrap();
    assert!(core.module_scope(opened.session).unwrap().is_none());
}
