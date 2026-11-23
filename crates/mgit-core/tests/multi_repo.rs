//! 멀티 저장소 폴더 판별 (REPO-01). 대시보드(MR)가 생기기 전까지는 `MultiRepoFolder` 오류로 안내한다.
#![allow(clippy::unwrap_used)]

mod common;

use std::path::Path;

use common::{collector, core};
use mgit_core::CoreError;
use mgit_testkit::{Scenario, build};

/// 테스트용 독립 저장소를 `git init` 으로 만든다 (커밋 불필요)
fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn folder_outside_any_repo_with_child_repos_is_multi_repo() {
    let core = core().await;
    let parent = tempfile::tempdir().unwrap();
    init_repo(&parent.path().join("api"));
    init_repo(&parent.path().join("web"));
    std::fs::create_dir(parent.path().join("notes")).unwrap(); // 저장소 아님

    let (sink, _rx) = collector();
    let err = core.open_repo(parent.path(), sink).await.unwrap_err();
    match err {
        CoreError::MultiRepoFolder { path, repos } => {
            assert_eq!(path, parent.path());
            let names: Vec<_> = repos
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
                .collect();
            assert_eq!(names, vec!["api", "web"]);
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn folder_outside_any_repo_without_child_repos_is_not_a_repository() {
    let core = core().await;
    let parent = tempfile::tempdir().unwrap();
    std::fs::create_dir(parent.path().join("notes")).unwrap();

    let (sink, _rx) = collector();
    let err = core.open_repo(parent.path(), sink).await.unwrap_err();
    assert!(
        matches!(err, CoreError::Git(mgit_core::GitError::NotARepository(_))),
        "{err:?}"
    );
}

#[tokio::test]
async fn subfolder_inside_repo_holding_nested_repos_is_multi_repo() {
    let core = core().await;
    let repo = build(Scenario::Linear(2));
    // gitignore 된 bench/repos 같은 상황: 저장소 안의 하위 폴더에 독립 저장소가 있다
    let nested = repo.path().join("vendor");
    init_repo(&nested.join("lib"));

    let (sink, _rx) = collector();
    let err = core.open_repo(&nested, sink).await.unwrap_err();
    assert!(matches!(err, CoreError::MultiRepoFolder { .. }), "{err:?}");
    assert!(core.sessions().is_empty());
}

#[tokio::test]
async fn plain_subfolder_inside_repo_opens_that_repo() {
    let core = core().await;
    let repo = build(Scenario::Linear(2));
    let plain = repo.path().join("src");
    std::fs::create_dir(&plain).unwrap();

    let (sink, _rx) = collector();
    let opened = core.open_repo(&plain, sink).await.unwrap();
    assert_eq!(
        opened.info.work_tree.canonicalize().unwrap(),
        repo.path().canonicalize().unwrap()
    );
}
