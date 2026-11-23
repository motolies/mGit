//! mGit 도메인 타입과 포트 트레이트.
//!
//! 이 crate는 git 실행·IO를 전혀 하지 않는다. `mgit-git` 같은 인프라 crate가
//! 여기 정의된 포트([`GitRunner`], [`Watcher`], [`Store`])를 구현하고,
//! `mgit-core`가 그 포트에만 의존한다.

mod commit;
mod conflict;
mod diff;
mod env;
mod error;
mod folder;
mod framing;
mod hint;
mod history;
mod log;
mod messages;
mod oid;
mod op;
mod refs;
mod rel_path;
mod remote;
mod repo;
mod runner;
mod safety;
mod settings;
mod stash;
mod status;
mod store;
mod tags;
mod version;
mod watch;
mod worktree;

pub use commit::CommitRecord;
pub use conflict::{ConflictFile, ConflictSide, SideLabels, UnresolveMode};
pub use diff::{
    BinaryInfo, ChangedFile, DiffChange, DiffLine, FileDiff, Hunk, LineKind, LineSelection,
    MarkerHit,
};
pub use env::{EnvProfile, LOCAL_ENV_VARS, NON_LITERAL_COMMANDS};
pub use error::{GitError, ParseError};
pub use folder::{
    CloneSpec, FoundRepo, GitignoreTemplate, RepoKind, RepoSummary, SubmoduleInfo, SubmoduleStatus,
};
pub use framing::{LineFramer, NulFramer};
pub use hint::{GitHint, classify_stderr, credentials_rejected};
pub use history::{
    AdvancedSearch, AuthorCandidate, AuthorList, BlameLine, CommitFilter, DiffOptions,
    DifftoolTarget, GraphLayoutPrefs, GraphQuery, GraphRevs, GraphSort, HASH_PREFIX_MAX,
    HASH_PREFIX_MIN, HistoryEntry, Pickaxe, TextFilter,
};
pub use log::{CommandLogRecord, STDERR_TAIL_MAX, redact_args, redact_text, stderr_tail};
pub use oid::Oid;
pub use op::{InProgressOp, OpKind};
pub use refs::{HeadState, RefKind, RefLabel, matching_remote};
pub use rel_path::{REL_PATH_COMPONENT_MAX_BYTES, REL_PATH_MAX_BYTES, RelPath, RelPathError};
pub use remote::{PullMode, PushSpec, RemoteInfo, WorktreeRemoveCheck};
pub use repo::{CommitGraphStatus, ObjectFormat, RepoInfo};
pub use runner::{
    BoxFuture, CancelToken, ExitInfo, GitOutput, GitRequest, GitRunner, GitStream, OutputSink,
};
pub use safety::{
    BackupRef, CommitTemplate, HeadRef, RefRollback, RefSnapshot, ReflogEntry, UndoEntryInfo,
    UndoResult,
};
pub use settings::{
    HookInfo, PerfStatus, RepoSettings, SecretHit, SecretIgnore, SignatureStatus, SigningInfo,
};
pub use stash::StashInfo;
pub use status::{
    BranchHeader, ConflictKind, FileState, StatusEntry, StatusSummary, SubmoduleState,
    WorkTreeStatus,
};
pub use store::{
    BackupRecord, MemoryStore, RecentEntry, RecentKind, Store, StoreError, now_millis,
};
pub use tags::{
    LocalTag, LocalTagRef, RemoteTag, TagLookupError, TagLookupErrorKind, TagRefResult,
    TagRefStatus, TagSyncCounts, TagSyncEntry, TagSyncReport, TagSyncState, compare_tags,
};
pub use version::{GitVersion, MIN_GIT_VERSION};
pub use watch::{
    ChangeKind, ChangeSet, NoopWatcher, OnChange, WatchError, WatchHandle, WatchSpec, Watcher,
};
pub use worktree::WorktreeInfo;
