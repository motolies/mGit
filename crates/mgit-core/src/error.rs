use mgit_l10n::pick;
use mgit_model::{GitError, GitHint, StoreError, WatchError};

use crate::events::SessionId;
use crate::messages;

/// 코어 공개 API 오류
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("{}", messages::session_not_found(.0))]
    SessionNotFound(SessionId),
    /// 고른 폴더가 저장소 최상위가 아니면서 하위 저장소를 품고 있다 (멀티 저장소 대시보드 대상)
    #[error("{}", messages::multi_repo_folder(.path, .repos.len()))]
    MultiRepoFolder {
        path: std::path::PathBuf,
        repos: Vec<std::path::PathBuf>,
    },
    #[error("{}", pick("잘못된 범위", "Invalid range"))]
    BadRange,
    /// 쓰기 명령이 0이 아닌 코드로 끝났다. `hint` 는 stderr 분류 결과
    #[error("{}", messages::command_failed(.args, .status, .stderr))]
    CommandFailed {
        args: Vec<String>,
        status: Option<i32>,
        stderr: String,
        hint: Option<GitHint>,
    },
    #[error("{}", messages::cancelled())]
    Cancelled,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Watch(#[from] WatchError),
    #[error("{}", messages::hosting(.0))]
    Hosting(#[from] mgit_hosting::HostingError),
    /// `.git` 을 품은 폴더를 서브모듈 등록 없이 stage 하려 했다 (SUB-11)
    #[error("{}", messages::nested_repos(.paths))]
    NestedRepos { paths: Vec<String> },
    /// stage 된 내용에 충돌 마커가 남아 있다 (CF-24)
    #[error("{}", messages::conflict_markers(.files))]
    ConflictMarkers { files: Vec<String> },
    /// 원격 브랜치를 체크아웃하려는데 같은 이름의 로컬 브랜치가 다른 곳을 추적하거나
    /// 업스트림이 없다 (BR-02). `upstream` 은 그 로컬 브랜치의 현재 업스트림 full ref
    #[error("{}", messages::local_branch_tracks_other(.local, .remote, .name))]
    LocalBranchTracksOther {
        local: String,
        remote: String,
        name: String,
        upstream: Option<String>,
    },
    /// push 대상이 로컬과 이름이 다른 업스트림 브랜치다 (RM-04). git 을 실행하지 않고 호출자에게 묻는다.
    /// `upstream` 은 원격 쪽 브랜치 이름, 확인하면 `PushSpec::confirm_upstream_mismatch` 로 다시 부른다
    #[error("{}", messages::push_upstream_mismatch(.local, .remote, .upstream))]
    PushUpstreamMismatch {
        local: String,
        remote: String,
        upstream: String,
    },
    /// 가벼운(Light) 세션에는 커밋 그래프가 없다. 그래프 창·행 찾기·검색·질의 변경 같은 그래프 API 를
    /// 부르면 로드를 시작하지 않고 바로 이것을 돌려준다 (계획 5.1절)
    #[error("{}", messages::graph_unavailable(.0))]
    GraphUnavailable(SessionId),
    /// 폴더 하나가 잡은 가벼운 세션이 이미 상한이다. 새 세션은 열지 않았다. `sessions` 는 그 폴더가 지금
    /// 잡고 있는 가벼운 세션들 (프런트가 하나를 내려놓고 다시 연다)
    #[error("{}", messages::light_session_limit(.limit))]
    LightSessionLimit {
        limit: usize,
        sessions: Vec<SessionId>,
    },
    /// 커밋 필터를 쓸 수 없다: 잘못된 정규식(git 이 거부), 줄바꿈·NUL 이 든 패턴 (LG-06). 질의는 바꾸지 않았다
    #[error("{0}")]
    InvalidFilter(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{}", messages::io(.0))]
    Io(#[from] std::io::Error),
}

impl CoreError {
    /// 쓰기 명령 실패의 힌트
    pub fn hint(&self) -> Option<&GitHint> {
        match self {
            CoreError::CommandFailed { hint, .. } => hint.as_ref(),
            _ => None,
        }
    }
}
