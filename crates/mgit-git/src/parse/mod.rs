//! git 출력 파서. 전부 순수 함수라 fixture 로 테스트한다.

mod diff;
mod log;
mod progress;
mod refs;
mod stash;
mod status;
mod worktree;

pub use diff::parse_diff;
pub use log::{FIELDS_PER_RECORD, LogParser};
pub use progress::{ProgressLine, ProgressTracker, parse_progress_line};
pub use refs::{assign_remotes, parse_refs};
pub use stash::parse_stash_list;
pub use status::parse_status_v2;
pub use worktree::parse_worktree_list;
