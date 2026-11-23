//! 서브모듈 관리 (SUB-04~11)
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use common::{collector, core_with, wait_finished};
use mgit_core::{BatchOp, CoreConfig, CoreError};
use mgit_testkit::{Scenario, build};

/// 로컬 file 프로토콜을 허용하는 코어 (submodule add 가 file:// 를 쓴다)
async fn core_file_ok() -> mgit_core::Core {
    core_with(CoreConfig {
        git_config_overrides: vec![("protocol.file.allow".into(), "always".into())],
        ..CoreConfig::default()
    })
    .await
}

#[tokio::test]
async fn add_set_branch_sync_pointer_log_and_remove() {
    let core = core_file_ok().await;
    let mut lib = build(Scenario::Linear(2));
    let lib_first = lib.git_ok(["rev-parse", "HEAD~1"]).trim().to_string();
    let lib_head = lib.git_ok(["rev-parse", "HEAD"]).trim().to_string();
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 추가 (SUB-05)
    core.submodule_add(
        opened.session,
        &lib.path().to_string_lossy(),
        "libs/a",
        None,
        None,
    )
    .await
    .unwrap();
    let names = core.submodule_names(opened.session).await.unwrap();
    assert_eq!(names, vec![("libs/a".to_string(), "libs/a".to_string())]);
    let list = core.submodules(opened.session).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "libs/a");
    assert!(
        core.submodule_add(opened.session, "x", "../out", None, None)
            .await
            .is_err()
    );

    // 추적 branch (SUB-06)·sync (SUB-07)
    core.submodule_set_branch(opened.session, "libs/a", Some("main"))
        .await
        .unwrap();
    let branch = repo.git(["config", "-f", ".gitmodules", "submodule.libs/a.branch"]);
    assert_eq!(String::from_utf8_lossy(&branch.stdout).trim(), "main");
    core.submodule_set_branch(opened.session, "libs/a", None)
        .await
        .unwrap();
    core.submodule_sync(opened.session).await.unwrap();

    // 포인터 로그 (SUB-04): 이전 commit → 현재 HEAD
    let old = mgit_core::Oid::from_hex(lib_first.as_bytes()).unwrap();
    let new = mgit_core::Oid::from_hex(lib_head.as_bytes()).unwrap();
    let log = core
        .submodule_pointer_log(opened.session, "libs/a", Some(old), new)
        .await
        .unwrap();
    assert_eq!(log.commits.len(), 1);
    assert!(!log.reversed && !log.missing);
    let back = core
        .submodule_pointer_log(opened.session, "libs/a", Some(new), old)
        .await
        .unwrap();
    assert!(back.reversed);
    assert_eq!(back.commits.len(), 1);
    let fresh = core
        .submodule_pointer_log(opened.session, "libs/a", None, new)
        .await
        .unwrap();
    assert_eq!(fresh.commits.len(), 2);
    // 서브모듈 안에서 새 commit 을 만들면 push 안 된 것으로 잡힌다 (SUB-09)
    let mut sub = mgit_testkit::TestRepo::at(&repo.path().join("libs/a"));
    sub.commit("inside");
    let unpushed = core.submodule_unpushed(opened.session).await.unwrap();
    assert_eq!(unpushed.len(), 1);
    assert_eq!(unpushed[0].path, "libs/a");
    assert_eq!(unpushed[0].count, 1);

    // 일괄 작업 (SUB-08): fetch 는 성공
    let r = core
        .submodule_batch(opened.session, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(r.succeeded, 1, "{r:?}");

    // 제거 (SUB-05): deinit → rm → modules 디렉터리 삭제
    core.submodule_remove(opened.session, "libs/a")
        .await
        .unwrap();
    assert!(!repo.path().join("libs/a").exists());
    assert!(!repo.path().join(".git/modules/libs/a").exists());
    assert!(core.submodules(opened.session).await.unwrap().is_empty());
    assert!(
        core.submodule_remove(opened.session, "libs/a")
            .await
            .is_err()
    );
    let _ = lib_head;
}

#[tokio::test]
async fn nested_repo_blocks_stage_and_can_be_adopted() {
    let core = core_file_ok().await;
    let mut lib = build(Scenario::Linear(1));
    lib.add_bare_remote();
    let mut repo = build(Scenario::Linear(1));
    // 서브모듈 등록 없이 하위 저장소를 clone 해 둔다
    let nested = repo.path().join("vendor/lib");
    std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
    repo.git_ok([
        "-c",
        "protocol.file.allow=always",
        "clone",
        "-q",
        &lib.path().to_string_lossy(),
        &nested.to_string_lossy(),
    ]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    core.refresh(opened.session).await.unwrap();

    let found = core
        .nested_repo_dirs(opened.session, &["vendor/lib/".into(), "README.md".into()])
        .await
        .unwrap();
    assert_eq!(found, vec!["vendor/lib".to_string()]);
    let err = core
        .stage(opened.session, &["vendor/lib".into()])
        .await
        .unwrap_err();
    assert!(
        matches!(err, CoreError::NestedRepos { ref paths } if paths == &vec!["vendor/lib".to_string()])
    );
    let err = core.stage_all(opened.session).await.unwrap_err();
    assert!(matches!(err, CoreError::NestedRepos { .. }));

    // 채택 (SUB-11) 뒤에는 등록된 서브모듈이라 stage 가 된다
    core.submodule_adopt(opened.session, "vendor/lib")
        .await
        .unwrap();
    let names = core.submodule_names(opened.session).await.unwrap();
    assert_eq!(names[0].0, "vendor/lib");
    assert!(
        core.nested_repo_dirs(opened.session, &["vendor/lib".into()])
            .await
            .unwrap()
            .is_empty()
    );
    core.stage_all(opened.session).await.unwrap();
}

/// 저장소에 gitlink 와 `.gitmodules` 를 직접 넣는다 (git 이 만들어 주지 않는 이름을 시험할 때)
fn add_raw_gitlink(repo: &mut mgit_testkit::TestRepo, path: &str, oid: &str, gitmodules: &str) {
    repo.git_ok([
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{oid},{path}"),
    ]);
    repo.write_file(".gitmodules", gitmodules);
    repo.stage(&[".gitmodules"]);
    repo.commit_staged("raw submodule");
}

/// 경로에 공백이 있는 서브모듈도 등록된 것으로 본다: stage 와 제거가 된다
#[tokio::test]
async fn submodule_with_space_in_name_is_registered() {
    let core = core_file_ok().await;
    let lib = build(Scenario::Linear(2));
    let mut repo = build(Scenario::Linear(1));
    repo.add_submodule("my lib", lib.path());
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let names = core.submodule_names(opened.session).await.unwrap();
    assert_eq!(names, vec![("my lib".to_string(), "my lib".to_string())]);

    // 포인터를 옮기고 stage 한다
    let mut sub = mgit_testkit::TestRepo::at(&repo.path().join("my lib"));
    sub.git_ok(["checkout", "-q", "HEAD~1"]);
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &["my lib".into()])
        .await
        .unwrap();
    assert!(
        repo.git_ok(["diff", "--cached", "--name-only"])
            .contains("my lib")
    );

    core.submodule_remove(opened.session, "my lib")
        .await
        .unwrap();
    assert!(!repo.path().join(".git/modules/my lib").exists());
}

/// 이름이 절대 경로인 서브모듈은 제거를 거부하고 아무것도 지우지 않는다
#[tokio::test]
async fn submodule_remove_refuses_absolute_name() {
    let core = core_file_ok().await;
    let lib = build(Scenario::Linear(1));
    let mut lib_copy = mgit_testkit::TestRepo::at(lib.path());
    let oid = lib_copy.head().to_hex();
    let mut repo = build(Scenario::Linear(1));
    let victim = tempfile::tempdir().unwrap();
    std::fs::write(victim.path().join("keep.txt"), "keep").unwrap();
    let gitmodules = format!(
        "[submodule \"{}\"]\n\tpath = evil\n\turl = ../lib\n",
        victim.path().display()
    );
    add_raw_gitlink(&mut repo, "evil", &oid, &gitmodules);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let err = core
        .submodule_remove(opened.session, "evil")
        .await
        .unwrap_err();

    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(victim.path().join("keep.txt").exists());
    assert!(
        !repo.git_ok(["ls-files", "-s", "evil"]).is_empty(),
        "거부하면 저장소도 그대로다"
    );
}

/// `..` 이름과 정상 이름이 같은 경로를 가리키면 정상 항목을 고른다
#[tokio::test]
async fn submodule_remove_prefers_safe_name_in_mixed_gitmodules() {
    let core = core_file_ok().await;
    let lib = build(Scenario::Linear(1));
    let mut repo = build(Scenario::Linear(1));
    repo.add_submodule("sub", lib.path());
    let sentinel = repo.path().parent().unwrap().join("sentinel.txt");
    std::fs::write(&sentinel, "keep").unwrap();
    let original = repo.read_file(".gitmodules");
    // git 은 경고만 내고 status·deinit·rm 이 모두 성공한다
    repo.write_file(
        ".gitmodules",
        &format!("[submodule \"../../..\"]\n\tpath = sub\n\turl = ../x\n{original}"),
    );
    repo.stage(&[".gitmodules"]);
    repo.commit_staged("mixed");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(repo.path().join(".git/modules/sub").is_dir());

    core.submodule_remove(opened.session, "sub").await.unwrap();

    assert!(sentinel.exists(), "저장소 바깥을 지우면 안 된다");
    assert!(repo.path().join(".git/HEAD").exists());
    assert!(!repo.path().join(".git/modules/sub").exists());
}

/// 이름이 `..` 뿐이면 거부한다
#[tokio::test]
async fn submodule_remove_refuses_parent_name_only() {
    let core = core_file_ok().await;
    let lib = build(Scenario::Linear(1));
    let mut lib_copy = mgit_testkit::TestRepo::at(lib.path());
    let oid = lib_copy.head().to_hex();
    let mut repo = build(Scenario::Linear(1));
    repo.add_submodule("good", lib.path());
    let sentinel = repo.path().parent().unwrap().join("sentinel.txt");
    std::fs::write(&sentinel, "keep").unwrap();
    let original = repo.read_file(".gitmodules");
    let gitmodules = format!("{original}[submodule \"../../..\"]\n\tpath = evil\n\turl = ../x\n");
    add_raw_gitlink(&mut repo, "evil", &oid, &gitmodules);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let err = core
        .submodule_remove(opened.session, "evil")
        .await
        .unwrap_err();

    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(sentinel.exists());
    assert!(repo.path().join(".git/modules/good").is_dir());
}

/// `.git/modules/<이름>` 이 바깥을 가리키는 링크면 삭제 전에 멈춘다
#[cfg(unix)]
#[tokio::test]
async fn submodule_remove_refuses_modules_dir_outside_common_dir() {
    let core = core_file_ok().await;
    let lib = build(Scenario::Linear(1));
    let mut lib_copy = mgit_testkit::TestRepo::at(lib.path());
    let oid = lib_copy.head().to_hex();
    let mut repo = build(Scenario::Linear(1));
    add_raw_gitlink(
        &mut repo,
        "linked",
        &oid,
        "[submodule \"linked\"]\n\tpath = linked\n\turl = ../lib\n",
    );
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
    std::fs::create_dir_all(repo.path().join(".git/modules")).unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.path().join(".git/modules/linked")).unwrap();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let err = core
        .submodule_remove(opened.session, "linked")
        .await
        .unwrap_err();

    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(outside.path().join("keep.txt").exists());
}
