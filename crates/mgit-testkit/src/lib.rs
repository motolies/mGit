//! 테스트 전용 결정적 git 저장소 생성기.
//!
//! 날짜·작성자·전역 설정을 고정해 어느 환경에서 만들어도 같은 해시가 나오게 한다.
//! `std::process::Command` 로 git을 직접 실행하므로 `mgit-git` 에 의존하지 않는다.

mod env;
mod repo;
mod scenarios;

pub use env::DeterministicEnv;
pub use repo::TestRepo;
pub use scenarios::{Scenario, build};

/// 그래프 로드에 쓰는 `git log` 인자. 코어의 `cmd::log` 와 같은 형식이어야 한다
pub const GRAPH_LOG_ARGS: &[&str] = &[
    "log",
    "--exclude=refs/notes/*",
    "--exclude=refs/mgit/*",
    "--exclude=refs/replace/*",
    "--all",
    "--topo-order",
    "--no-show-signature",
    "--no-color",
    "--encoding=UTF-8",
    "-z",
    "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s",
];

/// ref 라벨 조회 인자. 코어의 `cmd::refs` 와 같은 형식이어야 한다
pub const REFS_ARGS: &[&str] = &[
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(upstream)%00%(symref)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(HEAD)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
    "refs/stash",
];

/// 작업 트리 상태 조회 인자. 코어의 `cmd::status` 와 같은 형식이어야 한다
pub const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--show-stash",
    "--untracked-files=all",
];
