//! 화면에 나가는 오류 문구 (한국어·영어). 값이 들어가는 thiserror `#[error]` 가 필드를 넘겨 부르고, 지금 언어로
//! 만든다. 인자 없는 문구는 변형 옆에서 `mgit_l10n::pick` 으로 고른다

use mgit_l10n::tr;

/// 요청이 네트워크 단계에서 실패했다
pub(crate) fn http(error: &reqwest::Error) -> String {
    tr!("네트워크 오류: {error}", "Network error: {error}")
}

/// 권한이 없다 (`detail` 은 서버가 준 사유)
pub(crate) fn forbidden(detail: &str) -> String {
    tr!(
        "접근 권한이 없습니다: {detail}",
        "Permission denied: {detail}"
    )
}

/// 대상을 찾지 못했다
pub(crate) fn not_found(detail: &str) -> String {
    tr!(
        "요청한 항목을 찾을 수 없습니다: {detail}",
        "Not found: {detail}"
    )
}

/// 요청 한도를 넘었다
pub(crate) fn rate_limited(retry_after: &u64) -> String {
    tr!(
        "요청 한도를 초과했습니다. {retry_after}초 후에 다시 시도하세요.",
        "Rate limit exceeded. Try again in {retry_after} seconds"
    )
}

/// 서버가 예상 밖의 상태 코드로 답했다
pub(crate) fn status(status: &u16, body: &str) -> String {
    tr!(
        "서버 응답 {status}: {body}",
        "Server responded {status}: {body}"
    )
}

/// 응답 본문을 해석하지 못했다
pub(crate) fn parse(detail: &str) -> String {
    tr!(
        "서버 응답을 해석하지 못했습니다: {detail}",
        "Failed to parse response: {detail}"
    )
}

/// 프로젝트 이름이 `owner/repo` 꼴이 아니다
pub(crate) fn bad_project(project: &str) -> String {
    tr!(
        "올바르지 않은 프로젝트 경로입니다: {project}",
        "Invalid project: {project}"
    )
}
