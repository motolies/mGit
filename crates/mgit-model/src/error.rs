use std::path::PathBuf;

use mgit_l10n::pick;

use crate::messages;

/// git 실행·해석 과정의 오류
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error(
        "{}",
        pick("Git 실행 파일을 찾을 수 없습니다", "Cannot find the git executable")
    )]
    NotFound,
    #[error("{}", messages::git_too_old(.found, .required))]
    VersionTooOld { found: String, required: String },
    #[error("{}", messages::git_spawn_failed(.0))]
    Spawn(#[source] std::io::Error),
    #[error("{}", messages::git_exit(.status, .stderr))]
    Exit {
        status: Option<i32>,
        stderr: String,
        args: Vec<String>,
    },
    #[error("{}", pick("취소됨", "Canceled"))]
    Cancelled,
    #[error("{}", messages::not_a_repository(.0))]
    NotARepository(PathBuf),
    #[error("{}", messages::unsupported(.0))]
    Unsupported(String),
    #[error(transparent)]
    Parse(#[from] ParseError),
}

/// git 출력 파싱 오류
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("{}", messages::bad_oid(.0))]
    BadOid(String),
    #[error("{}", messages::bad_field(.record, .field))]
    BadField { record: usize, field: usize },
    #[error("{}", messages::truncated(.fields_seen))]
    Truncated { fields_seen: usize },
    #[error("{}", messages::desync(.record))]
    Desync { record: usize },
}
