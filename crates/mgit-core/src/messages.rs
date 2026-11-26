//! 화면에 나가는 문구 (한국어·영어). `CoreError` 의 thiserror 문구와 여러 곳이 함께 쓰는 문구를 모아 지금
//! 언어로 만든다. 한 곳에서만 쓰는 문구는 그 자리에서 `tr!`·`pick` 으로 만든다

use std::fmt::Debug;
use std::path::Path;

use mgit_l10n::{pick, tr};

use crate::events::SessionId;

/// 세션이 없다
pub(crate) fn session_not_found(session: &SessionId) -> String {
    tr!(
        "세션을 찾을 수 없습니다: {session:?}",
        "Session not found: {session:?}"
    )
}

/// 고른 폴더가 하위 저장소를 품은 멀티 저장소 폴더다
pub(crate) fn multi_repo_folder(path: &Path, repos: usize) -> String {
    tr!(
        "여러 저장소가 포함된 폴더입니다: {} (하위 저장소 {}개)",
        "Multi-repository folder: {} ({} child repositories)",
        path.display(),
        repos
    )
}

/// 쓰기 명령이 0 이 아닌 코드로 끝났다
pub(crate) fn command_failed(args: &[String], status: &Option<i32>, stderr: &str) -> String {
    tr!(
        "Git 명령이 실패했습니다 (종료 코드 {status:?}): git {} — {stderr}",
        "git {} failed (code {status:?}): {stderr}",
        args.join(" ")
    )
}

/// 호스팅 API 오류를 감싼다
pub(crate) fn hosting(error: &mgit_hosting::HostingError) -> String {
    tr!("호스팅 서비스 오류: {error}", "Hosting: {error}")
}

/// 서브모듈로 등록하지 않은 하위 저장소를 stage 하려 했다
pub(crate) fn nested_repos(paths: &[String]) -> String {
    tr!(
        "서브모듈로 등록되지 않은 하위 저장소입니다: {}",
        "Unregistered nested repositories: {}",
        paths.join(", ")
    )
}

/// stage 된 내용에 충돌 마커가 남아 있다 (단일 저장소 커밋과 폴더 일괄 commit 이 함께 쓴다)
pub(crate) fn conflict_markers(files: &[String]) -> String {
    tr!(
        "충돌 마커가 남아 있습니다: {}",
        "Conflict markers remain: {}",
        files.join(", ")
    )
}

/// 같은 이름의 로컬 브랜치가 고른 원격 브랜치를 추적하지 않는다
pub(crate) fn local_branch_tracks_other(local: &str, remote: &str, name: &str) -> String {
    tr!(
        "로컬 브랜치 {local}은(는) {remote}/{name}을(를) 추적하지 않습니다",
        "Local branch {local} does not track {remote}/{name}"
    )
}

/// 이름이 다른 업스트림으로 push 하려 한다 (확인 요청)
pub(crate) fn push_upstream_mismatch(local: &str, remote: &str, upstream: &str) -> String {
    tr!(
        "로컬 브랜치 {local}을(를) {remote}/{upstream}(으)로 푸시합니다",
        "Pushing local branch {local} to {remote}/{upstream}"
    )
}

/// 가벼운 세션에는 커밋 그래프가 없다
pub(crate) fn graph_unavailable(session: &SessionId) -> String {
    tr!(
        "현재 화면에서는 커밋 그래프를 사용할 수 없습니다: {session:?}",
        "No commit graph in a light session: {session:?}"
    )
}

/// 폴더의 가벼운 세션 수가 상한이다
pub(crate) fn light_session_limit(limit: &usize) -> String {
    tr!(
        "폴더 화면에서 동시에 열 수 있는 저장소 수({limit}개)에 도달했습니다",
        "The folder has reached its light session limit ({limit})"
    )
}

/// 입출력 오류
pub(crate) fn io(error: &std::io::Error) -> String {
    tr!("입출력 오류: {error}", "I/O error: {error}")
}

/// 취소됨 (오류·건너뜀 사유·작업 종료 문구가 함께 쓴다)
pub(crate) fn cancelled() -> &'static str {
    pick("취소됨", "Canceled")
}

/// 원격이 하나도 없다 (push 대상·원격 tag 비교 대상이 없음)
pub(crate) fn no_remotes() -> &'static str {
    pick(
        "원격 저장소가 없습니다. 먼저 원격 저장소를 추가하세요.",
        "No remotes. Add a remote first",
    )
}

/// 등록되지 않은 원격 이름
pub(crate) fn unknown_remote(name: &str) -> String {
    tr!(
        "등록된 원격 저장소가 없습니다: {name}",
        "No such remote: {name}"
    )
}

/// 로컬에 없는 tag
pub(crate) fn tag_not_found(name: &str) -> String {
    tr!("태그를 찾을 수 없습니다: {name}", "No such tag: {name}")
}

/// tag 일괄 작업 중 일부가 원하는 결과에 이르지 못했다 (op 끝 이벤트 문구)
pub(crate) fn tag_results_failed(failed: usize, total: usize) -> String {
    tr!(
        "태그 {total}개 중 {failed}개를 처리하지 못했습니다",
        "Tags not processed: {failed} of {total}"
    )
}

/// 원격 삭제를 다시 불렀는데 확인한 뒤 원격 tag 가 또 바뀌었다 (`expected_remote` 불일치)
pub(crate) fn tag_remote_changed() -> &'static str {
    pick(
        "확인 이후 원격 태그가 변경되었습니다. 다시 확인하세요.",
        "The remote tag changed after it was checked. Check again",
    )
}

/// 취소·연결 끊김으로 tag 결과를 알 수 없다
pub(crate) fn tag_result_unknown() -> &'static str {
    pick(
        "처리 결과를 확인할 수 없습니다. 원격 태그를 다시 확인하세요.",
        "Result unknown. Check the remote tags again",
    )
}

/// 옵션으로 읽힐 수 있거나 쓸 수 없는 경로 (값은 따옴표로 보인다)
pub(crate) fn bad_path(path: impl Debug) -> String {
    tr!(
        "올바르지 않은 경로입니다: {path:?}",
        "Invalid path: {path:?}"
    )
}

/// 옵션으로 읽힐 수 있는 참조 이름
pub(crate) fn bad_ref(name: impl Debug) -> String {
    tr!(
        "올바르지 않은 참조입니다: {name:?}",
        "Invalid ref: {name:?}"
    )
}

/// 옵션으로 읽힐 수 있는 이름 (브랜치·원격·워크트리)
pub(crate) fn bad_name(name: impl Debug) -> String {
    tr!(
        "올바르지 않은 이름입니다: {name:?}",
        "Invalid name: {name:?}"
    )
}

/// 옵션으로 읽힐 수 있는 인자 값
pub(crate) fn bad_value(value: impl Debug) -> String {
    tr!(
        "올바르지 않은 값입니다: {value:?}",
        "Invalid value: {value:?}"
    )
}

/// 설정을 JSON 으로 바꾸지 못했다
pub(crate) fn settings_serialize_failed(error: &serde_json::Error) -> String {
    tr!(
        "설정을 저장할 형식으로 변환하지 못했습니다: {error}",
        "Failed to serialize settings: {error}"
    )
}

/// 폴더 세션에 속하지 않은 저장소를 골랐다
pub(crate) fn not_folder_repo(path: &Path) -> String {
    tr!(
        "이 폴더의 저장소가 아닙니다: {}",
        "Not a repository in this folder: {}",
        path.display()
    )
}

/// 워크트리 목록에 없는 경로다
pub(crate) fn not_a_worktree(path: &Path) -> String {
    tr!(
        "워크트리가 아닙니다: {}",
        "Not a worktree: {}",
        path.display()
    )
}

/// 충돌 목록에 없는 파일이다
pub(crate) fn not_a_conflict_file(path: &str) -> String {
    tr!(
        "충돌 파일이 아닙니다: {path}",
        "Not a conflicted file: {path}"
    )
}

/// 고른 커밋이 없다 (cherry-pick·revert)
pub(crate) fn choose_commits() -> &'static str {
    pick("커밋을 선택하세요.", "Select commits")
}

/// 원격이 GitHub·GitLab 프로젝트로 보이지 않는다
pub(crate) fn not_hosted_project() -> &'static str {
    pick(
        "원격 저장소가 GitHub/GitLab 프로젝트가 아닙니다",
        "The remote repository is not a GitHub/GitLab project",
    )
}

/// 격리 병합으로 만든 워크트리 세션이 아니다
pub(crate) fn not_isolated_worktree() -> &'static str {
    pick(
        "격리 병합 워크트리가 아닙니다",
        "Not an isolated merge worktree",
    )
}

/// `git merge-file` 이 실패했다 (`stderr` 는 git 이 남긴 사유)
pub(crate) fn merge_file_failed(stderr: &str) -> String {
    tr!(
        "파일 병합에 실패했습니다 (git merge-file): {stderr}",
        "merge-file failed: {stderr}"
    )
}
