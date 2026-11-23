//! 저장소 관리·폴더 대시보드·서브모듈 (REPO-02·04·05·06, MR-01~03, SUB-01~03)
#![allow(clippy::unwrap_used)]

mod common;

use std::time::Duration;

use common::{collector, core, core_watching, core_with, wait_finished, wait_for};
use mgit_core::{
    CloneSpec, CoreError, CoreEvent, RecentKind, RepoKind, SCAN_DEPTH, SubmoduleStatus,
    gitignore_templates,
};
use mgit_git::cmd::scan_repos;
use mgit_testkit::{Scenario, TestRepo, build};

#[test]
fn scan_finds_repos_by_kind_and_skips_build_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let root = root.as_path();
    let mut a = TestRepo::init();
    a.commit("a1");
    copy_dir(a.path(), &root.join("a"));
    let mut main = build(Scenario::Linear(1));
    let main_copy = root.join("group").join("main");
    copy_dir(main.path(), &main_copy);
    let wt_copy = root.join("group").join("wt");
    let wt_path = main.add_worktree(&wt_copy.to_string_lossy(), Some("wt-x"));
    assert_eq!(wt_path, wt_copy);
    std::fs::create_dir_all(root.join("node_modules").join("pkg").join(".git")).unwrap();
    std::fs::create_dir_all(root.join("deep").join("l2").join("l3").join("l4")).unwrap();
    copy_dir(
        a.path(),
        &root.join("deep").join("l2").join("l3").join("l4"),
    );

    let found = scan_repos(root, SCAN_DEPTH);
    let names: Vec<String> = found
        .iter()
        .map(|r| r.path.strip_prefix(root).unwrap().display().to_string())
        .collect();
    assert!(names.contains(&"a".to_string()), "{names:?}");
    assert!(names.contains(&"group/main".to_string()), "{names:?}");
    assert!(names.contains(&"group/wt".to_string()), "{names:?}");
    assert!(
        !names.iter().any(|n| n.starts_with("node_modules")),
        "{names:?}"
    );
    assert!(
        !names.iter().any(|n| n.contains("l4")),
        "깊이 3 초과는 제외: {names:?}"
    );
    let wt_found = found.iter().find(|r| r.path == wt_copy).unwrap();
    assert_eq!(wt_found.kind, RepoKind::Worktree);
    assert_eq!(
        found.iter().find(|r| r.path == main_copy).unwrap().kind,
        RepoKind::Standalone
    );
    // 저장소 안으로는 들어가지 않는다
    assert_eq!(
        found
            .iter()
            .filter(|r| r.path.starts_with(&main_copy))
            .count(),
        1
    );
}

/// 디렉터리 복사 (테스트용)
fn copy_dir(src: &std::path::Path, dst: &std::path::Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap().filter_map(Result::ok) {
        let p = entry.path();
        let target = dst.join(entry.file_name());
        if p.is_dir() {
            copy_dir(&p, &target);
        } else {
            std::fs::copy(&p, &target).unwrap();
        }
    }
}

#[tokio::test]
async fn folder_session_summaries_and_change_events() {
    let core = core_watching().await;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let mut clean = build(Scenario::Linear(2));
    copy_dir(clean.path(), &root.join("clean"));
    let mut dirty = build(Scenario::Linear(1));
    dirty.write_file("x.txt", "x");
    copy_dir(dirty.path(), &root.join("dirty"));
    let mut merging = build(Scenario::Linear(1));
    merging.prepare_conflict();
    merging.begin_merge_conflict();
    copy_dir(merging.path(), &root.join("merging"));
    let _ = (&mut clean, &mut dirty, &mut merging);

    let (sink, mut rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();
    assert_eq!(opened.repos.len(), 3);
    assert_eq!(opened.path, root);
    // 같은 폴더를 다시 열면 같은 세션
    let (sink2, _rx2) = collector();
    assert_eq!(
        core.open_folder(&root, sink2).await.unwrap().session,
        opened.session
    );
    let recent = core.recent_list().unwrap();
    assert!(
        recent
            .iter()
            .any(|r| r.path == root && r.kind == RecentKind::Folder)
    );

    let summaries = core.folder_summaries(opened.session, &[]).await.unwrap();
    assert_eq!(summaries.len(), 3);
    let by_name = |n: &str| summaries.iter().find(|s| s.name == n).unwrap();
    assert_eq!(by_name("clean").changed, 0);
    assert_eq!(by_name("clean").branch.as_deref(), Some("main"));
    assert_eq!(by_name("clean").ahead, None, "업스트림 없으면 None");
    assert_eq!(by_name("dirty").changed, 1, "{summaries:#?}");
    assert_eq!(by_name("merging").conflicted, 1);
    assert!(by_name("merging").op.is_some());
    assert!(summaries.iter().all(|s| s.error.is_none()), "{summaries:?}");

    // 하위 저장소에서 외부 커밋 → FolderChanged
    let mut ext = TestRepo::at(&root.join("clean"));
    ext.write_file("y.txt", "y");
    ext.commit("external");
    wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::FolderChanged { session, .. } if *session == opened.session),
    )
    .await;

    // 저장소 추가 뒤 재스캔
    copy_dir(clean.path(), &root.join("added"));
    let repos = core.folder_rescan(opened.session).await.unwrap();
    assert_eq!(repos.len(), 4);
    core.close_folder(opened.session).unwrap();
    assert!(matches!(
        core.folder_summaries(opened.session, &[]).await,
        Err(CoreError::SessionNotFound(_))
    ));
}

#[tokio::test]
async fn clone_init_recent_and_tabs() {
    let core = core().await;
    let mut src = build(Scenario::Linear(3));
    let remote = src.add_bare_remote();
    src.git_ok(["push", "-q", "origin", "main"]);
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("cloned");

    let (sink, mut rx) = collector();
    let cloned = core
        .clone_repo(
            CloneSpec {
                // file:// 를 쓰면 로컬 하드링크 최적화 대신 일반 전송을 타 진행률이 나온다
                url: format!("file://{}", remote.display()),
                dest: dest.clone(),
                branch: None,
                recurse_submodules: false,
                depth: None,
                blobless: false,
                single_branch: false,
            },
            sink,
        )
        .await
        .unwrap();
    assert_eq!(cloned, dest);
    assert!(dest.join("f1.txt").exists());
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::OperationFinished { ok: true, .. })
    })
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationStarted { kind, .. } if kind == "clone"))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationProgress { .. })),
        "로컬 clone 도 --progress 로 진행률이 온다: {events:#?}"
    );
    // 이미 있는 경로는 거부
    assert!(matches!(
        core.clone_repo(
            CloneSpec {
                url: remote.to_string_lossy().into_owned(),
                dest: dest.clone(),
                branch: None,
                recurse_submodules: false,
                depth: None,
                blobless: false,
                single_branch: false,
            },
            collector().0,
        )
        .await,
        Err(CoreError::Invalid(_))
    ));

    // init + 템플릿
    assert!(gitignore_templates().iter().any(|t| t.id == "rust"));
    let new_path = tmp.path().join("fresh");
    let created = core
        .init_repo(&new_path, "trunk", Some("rust"))
        .await
        .unwrap();
    assert!(created.join(".git").is_dir());
    assert!(created.join(".gitignore").is_file());
    assert!(
        std::fs::read_to_string(created.join(".gitignore"))
            .unwrap()
            .contains("target/")
    );
    let mut fresh = TestRepo::at(&created);
    assert_eq!(
        fresh.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "trunk"
    );
    assert!(matches!(
        core.init_repo(&new_path, "main", None).await,
        Err(CoreError::Invalid(_))
    ));

    // 최근 목록: clone·init 둘 다 기록, 고정·제거
    let recent = core.recent_list().unwrap();
    assert!(
        recent
            .iter()
            .any(|r| r.path == dest.canonicalize().unwrap() || r.path == dest)
    );
    assert!(recent.iter().any(|r| r.path == created));
    core.recent_pin(&created, true).unwrap();
    assert!(core.recent_list().unwrap()[0].pinned);
    core.recent_remove(&created).unwrap();
    assert!(
        !core
            .recent_list()
            .unwrap()
            .iter()
            .any(|r| r.path == created)
    );

    // 열린 탭 저장·복원
    core.open_tabs_set(&[dest.clone(), created.clone()])
        .unwrap();
    assert_eq!(
        core.open_tabs_get().unwrap(),
        vec![dest.clone(), created.clone()]
    );

    // 폴더 스캔 등록
    let found = core.scan_and_register(tmp.path()).unwrap();
    assert_eq!(found.len(), 2);
    assert!(
        core.recent_list()
            .unwrap()
            .iter()
            .any(|r| r.path == created)
    );
}

#[tokio::test]
async fn submodules_list_update_and_superproject() {
    // 서브모듈 clone 은 file 전송이 기본 차단이라(git 2.38+) -c 로 허용한다. 자식 프로세스에도 전파된다
    let core = core_with(mgit_core::CoreConfig {
        git_config_overrides: vec![("protocol.file.allow".into(), "always".into())],
        ..mgit_core::CoreConfig::default()
    })
    .await;
    let mut lib = build(Scenario::Linear(2));
    let lib_remote = lib.add_bare_remote();
    lib.git_ok(["push", "-q", "origin", "main"]);
    let mut app = build(Scenario::Linear(1));
    app.add_submodule("libs/lib", &lib_remote);
    let app_remote = app.add_bare_remote();
    app.git_ok(["push", "-q", "origin", "main"]);

    // 상위 저장소 열기: 서브모듈은 초기화됨 + 하위 저장소 목록에는 안 들어간다
    let (sink, mut rx) = collector();
    let opened = core.open_repo(app.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(opened.nested_repos.is_empty(), "{:?}", opened.nested_repos);
    assert_eq!(opened.superproject, None);
    let subs = core.submodules(opened.session).await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].path, "libs/lib");
    assert_eq!(subs[0].status, SubmoduleStatus::Clean);

    // 서브모듈 안에서 변경 → Dirty
    std::fs::write(app.path().join("libs/lib/z.txt"), "z").unwrap();
    core.refresh(opened.session).await.unwrap();
    let subs = core.submodules(opened.session).await.unwrap();
    assert_eq!(subs[0].status, SubmoduleStatus::Dirty);

    // 서브모듈 폴더를 열면 superproject 가 상위 저장소
    let (sink2, mut rx2) = collector();
    let sub_opened = core
        .open_repo(&app.path().join("libs/lib"), sink2)
        .await
        .unwrap();
    wait_finished(&mut rx2, sub_opened.session).await;
    assert_eq!(
        sub_opened
            .superproject
            .as_deref()
            .map(|p| p.canonicalize().unwrap()),
        Some(app.path().canonicalize().unwrap())
    );

    // 서브모듈 없이 clone → NotInitialized → update --init → Clean
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("app2");
    core.clone_repo(
        CloneSpec {
            url: app_remote.to_string_lossy().into_owned(),
            dest: dest.clone(),
            branch: None,
            recurse_submodules: false,
            depth: None,
            blobless: false,
            single_branch: false,
        },
        collector().0,
    )
    .await
    .unwrap();
    let (sink3, mut rx3) = collector();
    let o2 = core.open_repo(&dest, sink3).await.unwrap();
    wait_finished(&mut rx3, o2.session).await;
    let subs = core.submodules(o2.session).await.unwrap();
    assert_eq!(subs[0].status, SubmoduleStatus::NotInitialized);
    core.submodule_update(o2.session, true, None).await.unwrap();
    let subs = core.submodules(o2.session).await.unwrap();
    assert_eq!(subs[0].status, SubmoduleStatus::Clean);
    assert!(dest.join("libs/lib/f1.txt").exists());
}
