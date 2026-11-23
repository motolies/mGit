//! git 출력 파서. 전부 순수 함수라 fixture 로 테스트한다.

mod diff;
mod fetch;
mod log;
mod ls_remote;
mod progress;
mod push;
mod refs;
mod stash;
mod status;
mod tag_list;
mod worktree;

pub use diff::parse_diff;
pub use fetch::{FetchFlag, FetchRefLine, parse_fetch_porcelain};
pub use log::{FIELDS_PER_RECORD, LogParser};
pub use ls_remote::parse_ls_remote_tags;
pub use progress::{ProgressLine, ProgressTracker, parse_progress_line};
pub use push::{PushFlag, PushRefLine, parse_push_porcelain};
pub use refs::{assign_remotes, parse_refs};
pub use stash::parse_stash_list;
pub use status::parse_status_v2;
pub use tag_list::{TAG_LIST_FORMAT, parse_tag_list};
pub use worktree::parse_worktree_list;
