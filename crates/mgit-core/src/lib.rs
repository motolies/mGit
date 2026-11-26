//! mGit 응용 계층.
//!
//! 저장소 세션을 열고, `git log` 스트림을 받아 레인을 배정하고,
//! 프런트가 요청하는 범위(`graph_window`)만 돌려준다. 파일 감시로 외부 변경을 반영하고,
//! 쓰기 명령은 `common_dir` 단위 큐로 직렬화한다.
//! `GitRunner`·`Watcher`·`Store` 구현체를 주입받으므로 tauri 를 모른다.

mod authors;
mod auto_fetch;
mod backup_cleanup;
mod branch;
mod branch_delete;
mod branch_update;
mod changes;
mod clone_batch;
pub use clone_batch::{CLONE_CONCURRENCY_DEFAULT, CloneBatch, CloneTarget};
mod diff_document;
pub use diff_document::{DiffDocument, DiffDocumentSide};
mod commit_table;
mod comparison_commits;
mod config;
mod conflict;
mod conflict_assist;
mod core;
mod credentials;
mod error;
mod events;
mod folder;
mod folder_auto_fetch;
mod folder_batch;
mod folder_command;
pub use folder_command::{COMMAND_STDERR_KEEP, COMMAND_STDOUT_MAX, CommandOutput};
mod folder_integration;
mod folder_stash;
pub use folder_integration::{
    BatchMergeMode, IntegrationOutcome, IntegrationPreview, IntegrationTarget,
};
pub use folder_stash::{StashBatch, StashBatchRepo};
mod folder_branches;
mod folder_index;
mod folder_inspect;
mod folder_timeline;
mod fs_tree;
mod group;
mod history;
mod hosting;
mod hosting_pr;
mod inspect;
mod lfs;
mod light;
mod load;
mod logged_runner;
mod merge_ops;
mod messages;
mod modules;
mod ops;
mod preview;
mod rebase_plan;
mod ref_index;
mod refname;
mod refresh;
mod repo_ops;
mod repo_settings;
mod safety;
mod secrets;
mod session;
mod signing;
mod stash;
mod state;
mod submodule;
mod sync;
mod tag_cache;
mod tags;
mod verify;
mod window;
mod worktree;
mod write;

pub use authors::AUTHORS_MAX;
pub use backup_cleanup::BackupPrune;
pub use branch::{CheckoutTarget, is_not_fully_merged};
pub use branch_delete::{
    BranchDeleteLocalTarget, BranchDeleteTarget, BranchDeletionResult, BranchDeletionStatus,
    BranchDeletionStep, LocalBranchDeletionResult,
};
pub use branch_update::BranchUpdate;
pub use changes::CommitSpec;
pub use commit_table::CommitTable;
pub use config::{CoreConfig, LIGHT_SESSIONS_PER_FOLDER};
pub use conflict::{ConflictPayload, EDITOR_MARKER_SIZE};
pub use conflict_assist::{
    ConflictOrigins, ConflictRule, KEEP_REF_PREFIX, KeptResolution, OriginCommit, RenameConflict,
    RerereStatus, ResolutionReview, RuleAction, RuleResult, is_three_way,
};
pub use core::{Core, OpenedRepo};
pub use credentials::{
    AskpassService, CredentialOutcome, CredentialPrompt, CredentialReply, CredentialRequest,
    KeyringVault, MemoryVault, PromptKind, SecretVault, vault_key,
};
pub use error::CoreError;
pub use events::{CoreEvent, EventSink, SessionId};
pub use folder::{FolderOpened, FolderRepo, FolderSession, SCAN_DEPTH};
pub use folder_auto_fetch::AutoFetchedRepo;
pub use folder_batch::{
    BatchOp, BatchPullMode, BatchResult, FolderSettings, NewUpstream, PushRemote, RefMove,
    RepoChanges, RepoCommitMessage, RepoResult,
};
pub use folder_branches::{FolderBranch, FolderBranchIn, FolderBranchRepo, FolderBranches};
pub use folder_index::{IndexTarget, IndexWriteResult, SkipReason, SkippedPath};
pub use folder_timeline::{TimelineInfo, TimelineRepoInfo};
pub use fs_tree::{
    FS_IMAGE_MAX_BYTES, FS_LIST_DEFAULT_LIMIT, FS_LIST_MAX_LIMIT, FS_READ_MAX_BYTES,
    FsEditableFile, FsEncoding, FsEntry, FsEntryKind, FsFile, FsImage, FsLineEnding,
    FsLineEndingCounts, FsListing, FsSaveResult,
};
pub use fs_tree::{
    FsConflictKind, FsDecisionAction, FsLocation, FsOperationDecision, FsOperationItem,
    FsOperationKind, FsOperationOutcome, FsOperationPlan, FsOperationProgress, FsOperationRequest,
    FsOperationResult, FsOperations, FsOutcomeStatus, FsSource, FsTrash,
};
pub use group::{
    GROUP_KEY_PREFIX, GROUP_NAME_MAX_CHARS, GROUPS_SETTING_KEY, GroupDef, GroupId, GroupMember,
    GroupMount, GroupPathCheck, GroupSummary, GroupUpdate, GroupView, MemberState, PathIssue,
    group_key,
};
pub use history::EMPTY_TREE;
pub use hosting::{HostingAccount, OauthConfig, Profile, SshKeyInfo, account_id};
pub use hosting_pr::{PrTemplate, RemoteProject, avatar_url_for, parse_remote_url};
pub use inspect::{CommitDetail, ContainingBranch, ContainingRefs, SearchFields, SearchResult};
pub use lfs::{LfsFile, LfsLock, LfsStatus};
pub use light::RepoSessionRelease;
pub use merge_ops::{MergeMode, OpOutcome, ResetMode};
pub use mgit_hosting::{
    CreatePr, DeviceCodes, HostKind, HostingClient, HostingError, PullRequest, RepoPage,
    RepoSummary as HostedRepo, UserInfo,
};
pub use mgit_merge::{
    AutoSuggestion, Block, BlockClass, ConflictDoc, Eol, Resolution, conflict_marker_lines,
    has_conflict_markers, parse_markers, render,
};
pub use modules::{Module, ModuleKind, ModuleOverrides, detect_modules, module_config_files};
pub use ops::OpHandle;
pub use preview::{
    ISOLATED_PREFIX, IsolatedMerge, MergePreview, RadarEntry, RadarKind, RebaseStepPreview,
    STRATEGY_OPTIONS,
};
pub use rebase_plan::{
    PlanCommit, RebaseAction, RebasePlan, RebasePlanInfo, RebaseStep, WorktreeWip,
};
pub use repo_ops::{gitignore_body, gitignore_templates};
pub use repo_settings::PERF_SUGGEST_FILES;
pub use safety::{BACKUP_NS, UndoStack};
pub use secrets::glob_match;
pub use session::{LoadState, SessionProfile};
pub use state::{RepoRefs, RepoState};
pub use submodule::{SubmoduleCommit, SubmodulePointerLog, SubmoduleSides, SubmoduleUnpushed};
pub use tags::{TagDeleteItem, TagLeaseItem};
pub use verify::{CommandRun, SyntaxCompare};
pub use window::{GraphRow, GraphWindow};
pub use worktree::{WorktreeSource, default_worktree_path};
pub use write::{WriteResult, WriteSpec};

// 셸이 DTO 변환에 쓰는 타입을 재수출한다
pub use mgit_graph::{LayoutOptions, StubDir, WindowEdge, WindowSegment, WindowStub, branch_color};
pub use mgit_model::{
    BackupRecord, BinaryInfo, BranchHeader, ChangedFile, CloneSpec, CommandLogRecord,
    CommitGraphStatus, ConflictKind, DiffChange, DiffLine, FileDiff, FileState, FoundRepo,
    GitError, GitHint, GitVersion, GitignoreTemplate, HeadState, Hunk, InProgressOp, LineKind,
    LineSelection, MarkerHit, ObjectFormat, Oid, OpKind, PullMode, PushSpec, RecentEntry,
    RecentKind, RefKind, RefLabel, RemoteInfo, RepoInfo, RepoKind, RepoSummary, StashInfo,
    StatusEntry, StatusSummary, SubmoduleInfo, SubmoduleState, SubmoduleStatus, WorkTreeStatus,
    WorktreeInfo, WorktreeRemoveCheck,
};

// tag 관리 (BR-06) 모델 재수출
pub use mgit_model::{
    LocalTag, RemoteTag, TagLookupError, TagLookupErrorKind, TagRefResult, TagRefStatus,
    TagSyncCounts, TagSyncEntry, TagSyncReport, TagSyncState,
};

// 충돌 해결 (S6) 모델 재수출
pub use mgit_model::{ConflictFile, ConflictSide, SideLabels, UnresolveMode};

// 안전장치 (Phase 2 A1) 모델 재수출
pub use mgit_model::{
    BackupRef, CommitTemplate, HeadRef, RefSnapshot, ReflogEntry, UndoEntryInfo, UndoResult,
};

// diff·히스토리·그래프 질의 (Phase 2 A3) 모델 재수출
pub use mgit_model::{
    AdvancedSearch, AuthorCandidate, AuthorList, BlameLine, CommitFilter, DiffOptions,
    DifftoolTarget, GraphLayoutPrefs, GraphQuery, GraphRevs, GraphSort, HistoryEntry, Pickaxe,
    TextFilter,
};

// 설정·서명·비밀 스캔 (Phase 2 A4) 모델 재수출
pub use mgit_model::{
    HookInfo, PerfStatus, RepoSettings, SecretHit, SecretIgnore, SignatureStatus, SigningInfo,
};

pub use fs_tree::{
    REPLACE_BACKUP_REASON, REPLACE_FILE_LIMIT, REPLACE_PREVIEW_LINES, ReplaceChoice,
    ReplaceExcluded, ReplaceFilePreview, ReplaceLine, ReplaceMatch, ReplaceOutcome, ReplacePattern,
    ReplacePlan, ReplacePreview, ReplaceQuery, ReplaceSkipReason, ReplaceUndo, ReplaceUndoOutcome,
};
pub use fs_tree::{
    SearchDraft, WorkspaceFileList, WorkspaceSearchHit, WorkspaceSearchQuery, WorkspaceSearchResult,
};
