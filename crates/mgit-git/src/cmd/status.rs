use std::path::Path;

use mgit_model::{EnvProfile, GitError, GitRequest, GitRunner, WorkTreeStatus};

use crate::parse::parse_status_v2;

/// 작업 트리 상태 조회 인자 (명세 2.3). untracked 는 파일 단위로 전부 받는다
pub const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--show-stash",
    "--untracked-files=all",
];

/// `git status --porcelain=v2` 로 작업 트리 상태를 읽는다.
/// `interactive` 면 `GIT_OPTIONAL_LOCKS` 를 붙이지 않아 index 의 stat 정보가 갱신된다
pub async fn work_tree_status(
    runner: &dyn GitRunner,
    work_tree: &Path,
    interactive: bool,
) -> Result<WorkTreeStatus, GitError> {
    let profile = if interactive {
        EnvProfile::ReadInteractive
    } else {
        EnvProfile::ReadBackground
    };
    let req = GitRequest::new(work_tree, STATUS_ARGS).with_env(profile);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_status_v2(&out)?)
}

/// 사용자가 저장소 탭을 열지 않았는데 코어가 스스로 도는 status 에 붙이는 설정 (FS-12, 계획 결정 13번).
/// `core.fsmonitor` 에 적힌 프로그램을 실행하지 않는다. 폴더 대시보드와 가벼운 세션이 함께 쓰는 한 곳이다
pub const UNATTENDED_STATUS_CONFIG: &[(&str, &str)] = &[("core.fsmonitor", "false")];

/// 사용자가 직접 고르지 않은 저장소를 훑을 때의 상태 조회 (폴더 대시보드·가벼운 세션).
/// 그 저장소 설정의 fsmonitor 명령을 실행하지 않고(`UNATTENDED_STATUS_CONFIG`), `GIT_OPTIONAL_LOCKS=0` 으로
/// index 를 다시 쓰지 않는다 (index 를 쓰면 `post-index-change` 훅이 돈다)
pub async fn scanned_repo_status(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<WorkTreeStatus, GitError> {
    scanned_repo_status_in(runner, work_tree, &[]).await
}

/// `scanned_repo_status` 를 경로로 좁힌다 (폴더 화면의 stage·unstage 가 쓰기 전에 대상 안의 충돌·untracked
/// 폴더를 본다). 경로는 러너의 리터럴 pathspec 으로 글자 그대로 해석되고 디렉터리면 그 아래 전부다.
/// 비어 있으면 저장소 전체 (`scanned_repo_status` 와 같은 인자)
pub async fn scanned_repo_status_in(
    runner: &dyn GitRunner,
    work_tree: &Path,
    pathspecs: &[String],
) -> Result<WorkTreeStatus, GitError> {
    let mut args: Vec<String> = STATUS_ARGS.iter().map(|a| (*a).to_string()).collect();
    if !pathspecs.is_empty() {
        args.push("--".into());
        args.extend(pathspecs.iter().cloned());
    }
    let mut req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadBackground);
    for (key, value) in UNATTENDED_STATUS_CONFIG {
        req = req.with_config(key, value);
    }
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_status_v2(&out)?)
}
