//! 화면에 나가는 오류 문구 (한국어·영어). 값이 들어가는 thiserror `#[error]` 가 필드를 넘겨 부르고, 지금 언어로
//! 만든다. 인자 없는 문구는 변형 옆에서 `mgit_l10n::pick` 으로 고른다

use std::path::Path;

use mgit_l10n::tr;

/// git 이 지원하는 최소 버전보다 낮다
pub(crate) fn git_too_old(found: &str, required: &str) -> String {
    tr!(
        "설치된 Git 버전({found})이 최소 요구 버전({required})보다 낮습니다",
        "git {found} is older than the minimum version {required}"
    )
}

/// git 프로세스를 띄우지 못했다
pub(crate) fn git_spawn_failed(error: &std::io::Error) -> String {
    tr!(
        "Git을 실행하지 못했습니다: {error}",
        "Failed to run git: {error}"
    )
}

/// git 이 0 이 아닌 코드로 끝났다
pub(crate) fn git_exit(status: &Option<i32>, stderr: &str) -> String {
    tr!(
        "git 종료 코드 {status:?}: {stderr}",
        "git exit code {status:?}: {stderr}"
    )
}

/// 경로가 git 저장소가 아니다
pub(crate) fn not_a_repository(path: &Path) -> String {
    tr!(
        "Git 저장소가 아닙니다: {}",
        "Not a git repository: {}",
        path.display()
    )
}

/// 지원하지 않는 대상이다 (`what` 은 대상 설명)
pub(crate) fn unsupported(what: &str) -> String {
    tr!(
        "지원하지 않는 기능 또는 형식입니다: {what}",
        "Unsupported: {what}"
    )
}

/// 객체 ID 꼴이 아니다
pub(crate) fn bad_oid(text: &str) -> String {
    tr!(
        "올바르지 않은 객체 ID입니다: {text:?}",
        "Invalid object ID: {text:?}"
    )
}

/// 레코드의 필드 값이 올바르지 않다
pub(crate) fn bad_field(record: &usize, field: &usize) -> String {
    tr!(
        "레코드 {record}의 필드 {field}가 올바르지 않습니다",
        "Field {field} of record {record} is invalid"
    )
}

/// 스트림이 레코드 중간에서 끝났다
pub(crate) fn truncated(fields_seen: &usize) -> String {
    tr!(
        "데이터를 모두 읽기 전에 전송이 끝났습니다 (읽은 필드 {fields_seen}개)",
        "Stream ended in the middle of a record ({fields_seen} fields)"
    )
}

/// 레코드 경계가 어긋났다
pub(crate) fn desync(record: &usize) -> String {
    tr!(
        "데이터 구분 위치가 일치하지 않습니다 (레코드 {record})",
        "Lost sync at record {record}"
    )
}

/// 로컬 DB 오류
pub(crate) fn store_db(detail: &str) -> String {
    tr!("로컬 DB 오류: {detail}", "Local database error: {detail}")
}

/// 파일 감시를 시작하지 못했다
pub(crate) fn watch_init(detail: &str) -> String {
    tr!(
        "파일 감시를 시작할 수 없습니다: {detail}",
        "Cannot start file watching: {detail}"
    )
}
