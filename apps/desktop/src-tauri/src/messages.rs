//! 화면에 나가는 오류 문구 (한국어·영어). 값이 들어가는 `IpcError` 의 thiserror `#[error]` 가 필드를 넘겨 부르고,
//! 지금 언어로 만든다. 인자 없는 문구는 변형 옆에서 `mgit_l10n::pick` 으로 고른다

use mgit_l10n::tr;

/// 경로가 Git 저장소가 아니다
pub(crate) fn not_a_repository(path: &str) -> String {
    tr!(
        "Git 저장소가 아닙니다: {path}",
        "Not a Git repository: {path}"
    )
}

/// 고른 폴더가 하위 저장소를 품은 멀티 저장소 폴더다
pub(crate) fn multi_repo_folder(path: &str) -> String {
    tr!(
        "멀티 저장소 폴더입니다: {path}",
        "Multi-repository folder: {path}"
    )
}

/// git 이 지원하는 최소 버전보다 낮다
pub(crate) fn git_too_old(found: &str, required: &str) -> String {
    tr!(
        "git {found} 는 최소 버전 {required} 미만입니다",
        "git {found} is older than the minimum version {required}"
    )
}

/// 세션이 없다
pub(crate) fn session_not_found(session: &u32) -> String {
    tr!(
        "세션을 찾을 수 없습니다: {session}",
        "Session not found: {session}"
    )
}

/// 쓰기 명령이 실패했다
pub(crate) fn git_failed(args: &[String], stderr: &str) -> String {
    tr!(
        "git {} 실패: {stderr}",
        "git {} failed: {stderr}",
        args.join(" ")
    )
}

/// 같은 이름의 로컬 브랜치가 고른 원격 브랜치를 추적하지 않는다
pub(crate) fn local_branch_tracks_other(local: &str, remote: &str, name: &str) -> String {
    tr!(
        "로컬 브랜치 {local} 은 {remote}/{name} 을 추적하지 않습니다",
        "Local branch {local} does not track {remote}/{name}"
    )
}

/// 이름이 다른 업스트림으로 push 하려 한다 (확인 요청)
pub(crate) fn push_upstream_mismatch(local: &str, remote: &str, upstream: &str) -> String {
    tr!(
        "로컬 브랜치 {local} 을 {remote}/{upstream} 로 push 합니다",
        "Pushing local branch {local} to {remote}/{upstream}"
    )
}

/// 가벼운 세션에는 커밋 그래프가 없다
pub(crate) fn graph_unavailable(session: &u32) -> String {
    tr!(
        "가벼운 세션이라 커밋 그래프가 없습니다: {session}",
        "No commit graph in a light session: {session}"
    )
}

/// 폴더의 가벼운 세션 수가 상한이다
pub(crate) fn light_session_limit(limit: &u32) -> String {
    tr!(
        "폴더의 가벼운 세션이 상한({limit}개)입니다",
        "The folder has reached its light session limit ({limit})"
    )
}
