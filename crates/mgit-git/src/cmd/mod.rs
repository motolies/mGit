//! 용도별 git 읽기 명령. 요청을 만들고 출력을 모델 타입으로 바꾼다.

mod commit;
mod conflict;
mod contains;
mod diff;
mod discover;
mod head;
mod history;
mod settings;
pub use history::{
    advanced_search, blame_file, compare_file_diff, compare_files, diff_option_args, file_history,
    parse_blame_porcelain, parse_file_history,
};
pub use settings::{
    changed_remote_refs, commit_signature, config_get_bool, config_get_scoped, remote_refs,
    staged_diff, tracked_count,
};
mod log;
mod merge_tree;
mod op;
mod refs;
mod remote;
mod safety;
mod stash;
mod status;
mod submodule;
mod worktree;

pub use commit::{CommitMeta, commit_files, commit_meta, parse_name_status};
pub use conflict::{
    MarkerStyle, UnmergedEntry, commit_subject, conflict_style, list_unmerged, merge_file_stages,
    name_rev, parse_unmerged, show_stage,
};
pub use contains::{
    CONTAINS_FORMAT, Containing, ContainingBranch, containing_branches, containing_branches_with,
    parse_containing,
};
pub use diff::{blob_size, commit_file_diff, staged_conflict_markers, work_tree_diff};
pub use discover::{
    Discovered, SCAN_SKIP_DIRS, classify_repo_dir, detect_commit_graph, discover, find_child_repos,
    scan_repos,
};
pub use head::head_state;
pub use log::{
    AUTHOR_LOG_FORMAT, AuthorCount, author_log_request, filter_args, filter_rejection,
    graph_log_request, graph_log_request_with, log_authors, parse_author_log, rev_resolves,
};
pub use merge_tree::{MergeTreeResult, merge_tree, parse_merge_tree};
pub use op::in_progress_op;
pub use refs::{REFS_FORMAT, list_refs, tag_list, tag_objects};
pub use remote::{list_remotes, parse_remote_v};
pub use safety::{commit_template, config_get, list_reflog, parse_reflog, ref_snapshot};
pub use stash::{STASH_LIST_ARGS, list_stashes};
pub use status::{
    STATUS_ARGS, UNATTENDED_STATUS_CONFIG, scanned_repo_status, scanned_repo_status_in,
    work_tree_status,
};
pub use submodule::{list_submodules, parse_submodule_status, superproject};
pub use worktree::list_worktrees;
