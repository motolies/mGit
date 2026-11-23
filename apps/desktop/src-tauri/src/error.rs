use mgit_core::{CoreError, GitError};
use mgit_l10n::pick;
use mgit_model::redact_text;
use serde::Serialize;

use crate::dto::GitHint;
use crate::messages;

/// 프런트로 넘어가는 오류. 프런트는 `kind` 로 분기해 화면 언어의 안내 문구로 바꿔 쓴다. `message` 는 셸이 받은
/// 화면 언어(`set_language`)로 만든 문구다
#[derive(Debug, Clone, Serialize, specta::Type, thiserror::Error)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IpcError {
    #[error("{}", messages::not_a_repository(.path))]
    NotARepository { path: String },
    /// 하위 저장소를 품은 폴더. 멀티 저장소 대시보드(MR)가 생기기 전까지는 안내만 한다
    #[error("{}", messages::multi_repo_folder(.path))]
    MultiRepoFolder { path: String, repos: Vec<String> },
    #[error(
        "{}",
        pick("git 실행 파일을 찾을 수 없습니다", "Cannot find the git executable")
    )]
    GitNotFound,
    #[error("{}", messages::git_too_old(.found, .required))]
    GitTooOld { found: String, required: String },
    #[error("{}", messages::session_not_found(.session))]
    SessionNotFound { session: u32 },
    /// 쓰기 명령이 실패했다. `stderr` 는 원문, `hint` 는 분류 결과
    #[error("{}", messages::git_failed(.args, .stderr))]
    GitFailed {
        args: Vec<String>,
        status: Option<i32>,
        stderr: String,
        hint: Option<GitHint>,
    },
    #[error("{}", pick("취소됨", "Canceled"))]
    Cancelled,
    /// stage 된 내용에 충돌 마커가 남아 있다 (CF-24)
    #[error("{}", pick("충돌 마커가 남아 있습니다", "Conflict markers remain"))]
    ConflictMarkers { files: Vec<String> },
    /// `.git` 을 품은 미등록 하위 저장소 (SUB-11)
    #[error("{}", pick("미등록 하위 저장소", "Unregistered nested repositories"))]
    NestedRepos { paths: Vec<String> },
    /// 원격 브랜치 체크아웃: 같은 이름의 로컬 브랜치가 다른 곳을 추적한다 (BR-02).
    /// `upstream` 은 그 로컬 브랜치의 현재 업스트림 full ref, 없으면 null
    #[error("{}", messages::local_branch_tracks_other(.local, .remote, .name))]
    LocalBranchTracksOther {
        local: String,
        remote: String,
        name: String,
        upstream: Option<String>,
    },
    /// push 대상이 로컬과 이름이 다른 업스트림 브랜치다 (RM-04). git 을 실행하지 않았다.
    /// 확인하면 `confirmUpstreamMismatch` 로 다시 부른다. `upstream` 은 원격 쪽 브랜치 이름
    #[error("{}", messages::push_upstream_mismatch(.local, .remote, .upstream))]
    PushUpstreamMismatch {
        local: String,
        remote: String,
        upstream: String,
    },
    /// 가벼운(Light) 세션에 그래프 API 를 불렀다. 로드는 시작하지 않았다 (그 세션은 그래프가 없다)
    #[error("{}", messages::graph_unavailable(.session))]
    GraphUnavailable { session: u32 },
    /// 폴더가 잡은 가벼운 세션이 이미 상한이라 열지 않았다. `sessions` 는 그 폴더가 지금 잡은 가벼운 세션들 —
    /// 하나를 `folderReleaseRepoSession` 으로 내려놓고 다시 연다
    #[error("{}", messages::light_session_limit(.limit))]
    LightSessionLimit { limit: u32, sessions: Vec<u32> },
    /// 커밋 필터를 쓸 수 없다 (잘못된 정규식, 줄바꿈·NUL 이 든 값). 질의는 바뀌지 않았다 — 결과 0개(빈 그래프)와
    /// 구분된다. `message` 는 화면 언어의 안내 + git 의 거부 사유(원문)
    #[error("{message}")]
    InvalidFilter { message: String },
    #[error("{message}")]
    Internal { message: String },
}

impl From<GitError> for IpcError {
    /// 프런트가 구분해서 안내해야 하는 오류만 변형으로 나누고 나머지는 Internal 로 묶는다
    fn from(error: GitError) -> Self {
        match error {
            GitError::NotFound => IpcError::GitNotFound,
            GitError::VersionTooOld { found, required } => IpcError::GitTooOld { found, required },
            GitError::NotARepository(path) => IpcError::NotARepository {
                path: path.display().to_string(),
            },
            GitError::Cancelled => IpcError::Cancelled,
            other => IpcError::Internal {
                message: redact_text(&other.to_string()),
            },
        }
    }
}

impl From<CoreError> for IpcError {
    /// 코어 오류를 wire 오류로 바꾼다
    fn from(error: CoreError) -> Self {
        match error {
            CoreError::Git(git) => git.into(),
            CoreError::SessionNotFound(session) => IpcError::SessionNotFound { session: session.0 },
            CoreError::MultiRepoFolder { path, repos } => IpcError::MultiRepoFolder {
                path: path.display().to_string(),
                repos: repos.iter().map(|p| p.display().to_string()).collect(),
            },
            CoreError::CommandFailed {
                args,
                status,
                stderr,
                hint,
            } => IpcError::GitFailed {
                args,
                status,
                stderr,
                hint: hint.map(Into::into),
            },
            CoreError::Cancelled => IpcError::Cancelled,
            CoreError::ConflictMarkers { files } => IpcError::ConflictMarkers { files },
            CoreError::NestedRepos { paths } => IpcError::NestedRepos { paths },
            CoreError::LocalBranchTracksOther {
                local,
                remote,
                name,
                upstream,
            } => IpcError::LocalBranchTracksOther {
                local,
                remote,
                name,
                upstream,
            },
            CoreError::PushUpstreamMismatch {
                local,
                remote,
                upstream,
            } => IpcError::PushUpstreamMismatch {
                local,
                remote,
                upstream,
            },
            CoreError::GraphUnavailable(session) => {
                IpcError::GraphUnavailable { session: session.0 }
            }
            CoreError::LightSessionLimit { limit, sessions } => IpcError::LightSessionLimit {
                limit: u32::try_from(limit).unwrap_or(u32::MAX),
                sessions: sessions.into_iter().map(|s| s.0).collect(),
            },
            CoreError::InvalidFilter(message) => IpcError::InvalidFilter { message },
            CoreError::Io(e) => IpcError::Internal {
                message: e.to_string(),
            },
            CoreError::BadRange => IpcError::Internal {
                message: pick("잘못된 범위", "Invalid range").to_string(),
            },
            other => IpcError::Internal {
                message: redact_text(&other.to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가벼운 세션의 두 오류는 `internal` 로 뭉개지지 않고 각자의 kind 로 나간다
    #[test]
    #[allow(clippy::unwrap_used)]
    fn light_session_errors_keep_their_kind() {
        let json = serde_json::to_value(IpcError::from(CoreError::GraphUnavailable(
            mgit_core::SessionId(7),
        )))
        .unwrap();
        assert_eq!(json["kind"], "graphUnavailable");
        assert_eq!(json["session"], 7);

        let json = serde_json::to_value(IpcError::from(CoreError::LightSessionLimit {
            limit: 3,
            sessions: vec![mgit_core::SessionId(2), mgit_core::SessionId(5)],
        }))
        .unwrap();
        assert_eq!(json["kind"], "lightSessionLimit");
        assert_eq!(json["limit"], 3);
        assert_eq!(json["sessions"], serde_json::json!([2, 5]));
    }

    /// 잘못된 필터는 `internal` 이 아니라 자기 kind 로 나가 빈 결과·일반 오류와 구분된다
    #[test]
    #[allow(clippy::unwrap_used)]
    fn invalid_filter_keeps_its_kind() {
        let json = serde_json::to_value(IpcError::from(CoreError::InvalidFilter(
            "잘못된 정규식입니다: command line, '(': parentheses not balanced".into(),
        )))
        .unwrap();
        assert_eq!(json["kind"], "invalidFilter");
        assert!(
            json["message"]
                .as_str()
                .unwrap()
                .contains("parentheses not balanced")
        );
    }

    /// 내부 오류 문자열에 섞인 URL 토큰은 프런트로 넘기지 않는다
    #[test]
    fn internal_errors_mask_url_tokens() {
        let git = GitError::Exit {
            status: Some(1),
            stderr: "see https://SECRETTOKEN@h/x".into(),
            args: Vec::new(),
        };
        let IpcError::Internal { message } = IpcError::from(CoreError::Git(git)) else {
            panic!("Internal 이어야 한다");
        };
        assert!(message.contains("https://***@h/x"), "{message}");
        assert!(!message.contains("SECRETTOKEN"), "{message}");
    }
}
