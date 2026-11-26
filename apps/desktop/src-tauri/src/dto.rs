//! 프런트로 넘어가는 wire 타입(DTO).
//!
//! 코어(`mgit-core`) 타입과 1:1 로 대응하지만 specta derive 를 코어에 전파하지 않기 위해
//! 여기서 따로 정의하고 `From<mgit_core::…>` 으로 변환한다.
//! 모든 필드는 camelCase 로 직렬화한다. i64 타임스탬프는 specta-typescript 가 금지하므로
//! `Number` 로 명시해 내보낸다(Unix epoch 초는 f64 로 손실 없이 표현된다). u64 는 u32 로 좁힌다.

use serde::Serialize;

/// u64 카운터(generation, elapsed_ms, id)를 TS `number` 안전 범위의 u32 로 좁힌다
pub(crate) fn narrow_u64(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// `refs/heads/main` → `main`. 상태 바·배지에 쓰는 짧은 이름
fn short_branch(full: &str) -> String {
    full.strip_prefix("refs/heads/").unwrap_or(full).to_string()
}

/// 경로를 표시용 문자열로
fn path_str(path: &std::path::Path) -> String {
    path.display().to_string()
}

/// 상태 바에 표시할 git 버전 정보
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitVersionInfo {
    pub version: String,
    pub path: String,
}

/// HEAD 상태. `branch` 는 `refs/heads/` 를 뗀 짧은 이름이다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HeadState {
    Attached { branch: String, oid: String },
    Detached { oid: String },
    Unborn { branch: String },
}

impl From<mgit_core::HeadState> for HeadState {
    /// 전체 refname 을 짧은 브랜치명으로, Oid 를 hex 문자열로 바꾼다
    fn from(head: mgit_core::HeadState) -> Self {
        match head {
            mgit_core::HeadState::Attached { branch, oid } => HeadState::Attached {
                branch: short_branch(&branch),
                oid: oid.to_string(),
            },
            mgit_core::HeadState::Detached { oid } => HeadState::Detached {
                oid: oid.to_string(),
            },
            mgit_core::HeadState::Unborn { branch } => HeadState::Unborn {
                branch: short_branch(&branch),
            },
        }
    }
}

/// 객체 해시 형식
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ObjectFormat {
    Sha1,
    Sha256,
}

impl From<mgit_core::ObjectFormat> for ObjectFormat {
    /// 코어 열거형과 1:1
    fn from(format: mgit_core::ObjectFormat) -> Self {
        match format {
            mgit_core::ObjectFormat::Sha1 => ObjectFormat::Sha1,
            mgit_core::ObjectFormat::Sha256 => ObjectFormat::Sha256,
        }
    }
}

/// commit-graph 파일 존재 여부 (AD-03 제안의 근거)
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphStatus {
    pub present: bool,
}

impl From<mgit_core::CommitGraphStatus> for CommitGraphStatus {
    /// 코어 구조체와 1:1
    fn from(status: mgit_core::CommitGraphStatus) -> Self {
        Self {
            present: status.present,
        }
    }
}

/// 열린 저장소 정보. 경로는 표시용 문자열이다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub work_tree: String,
    pub git_dir: String,
    pub common_dir: String,
    pub object_format: ObjectFormat,
    pub head: HeadState,
    pub commit_graph: CommitGraphStatus,
    /// 얕은 복제 (REPO-03)
    pub shallow: bool,
}

impl From<mgit_core::RepoInfo> for RepoInfo {
    /// PathBuf 를 문자열로 바꾸고 하위 타입을 변환한다
    fn from(info: mgit_core::RepoInfo) -> Self {
        Self {
            work_tree: path_str(&info.work_tree),
            git_dir: path_str(&info.git_dir),
            common_dir: path_str(&info.common_dir),
            object_format: info.object_format.into(),
            head: info.head.into(),
            commit_graph: info.commit_graph.into(),
            shallow: info.shallow,
        }
    }
}

/// ref 종류
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch { remote: String },
    Tag { annotated: bool },
    Stash,
}

impl From<mgit_core::RefKind> for RefKind {
    /// 코어 열거형과 1:1
    fn from(kind: mgit_core::RefKind) -> Self {
        match kind {
            mgit_core::RefKind::LocalBranch => RefKind::LocalBranch,
            mgit_core::RefKind::RemoteBranch { remote } => RefKind::RemoteBranch { remote },
            mgit_core::RefKind::Tag { annotated } => RefKind::Tag { annotated },
            mgit_core::RefKind::Stash => RefKind::Stash,
        }
    }
}

/// 그래프 행·사이드바에 쓰는 ref 라벨
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub full_name: String,
    pub short_name: String,
    pub kind: RefKind,
    pub target: String,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub upstream_gone: bool,
    pub worktree_path: Option<String>,
}

impl From<mgit_core::RefLabel> for RefLabel {
    /// Oid·경로를 문자열로 바꾼다
    fn from(label: mgit_core::RefLabel) -> Self {
        Self {
            full_name: label.full_name,
            short_name: label.short_name,
            kind: label.kind.into(),
            target: label.target.to_string(),
            is_current: label.is_current,
            upstream: label.upstream,
            ahead: label.ahead,
            behind: label.behind,
            upstream_gone: label.upstream_gone,
            worktree_path: label.worktree_path.as_deref().map(path_str),
        }
    }
}

/// 작업 트리 항목의 한 글자 상태
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
    Untracked,
    Ignored,
}

impl From<mgit_core::FileState> for FileState {
    /// 코어 열거형과 1:1
    fn from(s: mgit_core::FileState) -> Self {
        use mgit_core::FileState as F;
        match s {
            F::Unmodified => FileState::Unmodified,
            F::Modified => FileState::Modified,
            F::TypeChanged => FileState::TypeChanged,
            F::Added => FileState::Added,
            F::Deleted => FileState::Deleted,
            F::Renamed => FileState::Renamed,
            F::Copied => FileState::Copied,
            F::Unmerged => FileState::Unmerged,
            F::Untracked => FileState::Untracked,
            F::Ignored => FileState::Ignored,
        }
    }
}

/// 충돌 유형
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    BothDeleted,
    AddedByUs,
    AddedByThem,
    DeletedByUs,
    DeletedByThem,
}

impl From<mgit_core::ConflictKind> for ConflictKind {
    /// 코어 열거형과 1:1
    fn from(k: mgit_core::ConflictKind) -> Self {
        use mgit_core::ConflictKind as C;
        match k {
            C::BothModified => ConflictKind::BothModified,
            C::BothAdded => ConflictKind::BothAdded,
            C::BothDeleted => ConflictKind::BothDeleted,
            C::AddedByUs => ConflictKind::AddedByUs,
            C::AddedByThem => ConflictKind::AddedByThem,
            C::DeletedByUs => ConflictKind::DeletedByUs,
            C::DeletedByThem => ConflictKind::DeletedByThem,
        }
    }
}

/// 서브모듈 항목의 추가 상태
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleState {
    pub commit_changed: bool,
    pub tracked_changes: bool,
    pub untracked_changes: bool,
}

impl From<mgit_core::SubmoduleState> for SubmoduleState {
    /// 코어 구조체와 1:1
    fn from(s: mgit_core::SubmoduleState) -> Self {
        Self {
            commit_changed: s.commit_changed,
            tracked_changes: s.tracked_changes,
            untracked_changes: s.untracked_changes,
        }
    }
}

/// 작업 트리 상태 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub index: FileState,
    pub worktree: FileState,
    pub submodule: Option<SubmoduleState>,
    pub conflict: Option<ConflictKind>,
    pub rename_score: Option<u8>,
}

impl From<mgit_core::StatusEntry> for StatusEntry {
    /// 코어 구조체와 1:1
    fn from(e: mgit_core::StatusEntry) -> Self {
        Self {
            path: e.path,
            orig_path: e.orig_path,
            index: e.index.into(),
            worktree: e.worktree.into(),
            submodule: e.submodule.map(Into::into),
            conflict: e.conflict.map(Into::into),
            rename_score: e.rename_score,
        }
    }
}

/// `--branch` 헤더
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchHeader {
    pub oid: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

impl From<mgit_core::BranchHeader> for BranchHeader {
    /// Oid 를 문자열로
    fn from(b: mgit_core::BranchHeader) -> Self {
        Self {
            oid: b.oid.map(|o| o.to_string()),
            head: b.head,
            upstream: b.upstream,
            ahead: b.ahead,
            behind: b.behind,
        }
    }
}

/// 상태 집계
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub ahead: u32,
    pub behind: u32,
    pub stash_count: u32,
    pub upstream: Option<String>,
}

impl From<mgit_core::StatusSummary> for StatusSummary {
    /// 코어 구조체와 1:1
    fn from(s: mgit_core::StatusSummary) -> Self {
        Self {
            staged: s.staged,
            unstaged: s.unstaged,
            untracked: s.untracked,
            conflicted: s.conflicted,
            ahead: s.ahead,
            behind: s.behind,
            stash_count: s.stash_count,
            upstream: s.upstream,
        }
    }
}

/// 작업 트리 상태 전체 (집계 포함)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkTreeStatus {
    pub branch: BranchHeader,
    pub stash_count: u32,
    pub entries: Vec<StatusEntry>,
    pub summary: StatusSummary,
}

impl From<mgit_core::WorkTreeStatus> for WorkTreeStatus {
    /// 집계를 미리 계산해 함께 보낸다
    fn from(s: mgit_core::WorkTreeStatus) -> Self {
        let summary = s.summary().into();
        Self {
            branch: s.branch.into(),
            stash_count: s.stash_count,
            entries: s.entries.into_iter().map(Into::into).collect(),
            summary,
        }
    }
}

/// 진행 중 작업
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InProgressOp {
    Merge {
        head: String,
    },
    Rebase {
        interactive: bool,
        head_name: Option<String>,
        onto: Option<String>,
        step: u32,
        total: u32,
    },
    CherryPick {
        head: String,
        sequencer: bool,
    },
    Revert {
        head: String,
        sequencer: bool,
    },
    Bisect,
    Am,
}

impl From<mgit_core::InProgressOp> for InProgressOp {
    /// Oid 를 문자열로, 브랜치 전체 이름을 짧은 이름으로
    fn from(op: mgit_core::InProgressOp) -> Self {
        use mgit_core::InProgressOp as O;
        match op {
            O::Merge { head } => InProgressOp::Merge {
                head: head.to_string(),
            },
            O::Rebase {
                interactive,
                head_name,
                onto,
                step,
                total,
            } => InProgressOp::Rebase {
                interactive,
                head_name: head_name.as_deref().map(short_branch),
                onto: onto.map(|o| o.to_string()),
                step,
                total,
            },
            O::CherryPick { head, sequencer } => InProgressOp::CherryPick {
                head: head.to_string(),
                sequencer,
            },
            O::Revert { head, sequencer } => InProgressOp::Revert {
                head: head.to_string(),
                sequencer,
            },
            O::Bisect => InProgressOp::Bisect,
            O::Am => InProgressOp::Am,
        }
    }
}

/// 스태시 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub oid: String,
    pub base: Option<String>,
    pub message: String,
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    pub includes_untracked: bool,
    pub branch: Option<String>,
}

impl From<mgit_core::StashInfo> for StashInfo {
    /// Oid 를 문자열로
    fn from(s: mgit_core::StashInfo) -> Self {
        Self {
            index: s.index,
            oid: s.oid.to_string(),
            base: s.base.map(|o| o.to_string()),
            message: s.message,
            time: s.time,
            includes_untracked: s.includes_untracked,
            branch: s.branch,
        }
    }
}

/// 워크트리 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: Option<String>,
    /// 짧은 브랜치명
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub is_main: bool,
}

impl From<mgit_core::WorktreeInfo> for WorktreeInfo {
    /// 경로·Oid 를 문자열로, 브랜치를 짧은 이름으로
    fn from(w: mgit_core::WorktreeInfo) -> Self {
        Self {
            path: path_str(&w.path),
            head: w.head.map(|o| o.to_string()),
            branch: w.branch.as_deref().map(short_branch),
            detached: w.detached,
            bare: w.bare,
            locked: w.locked,
            prunable: w.prunable,
            is_main: w.is_main,
        }
    }
}

/// ref 스냅샷
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoRefs {
    pub head: HeadState,
    pub labels: Vec<RefLabel>,
    pub stashes: Vec<StashInfo>,
    pub worktrees: Vec<WorktreeInfo>,
    pub remotes: Vec<crate::commands_remote::RemoteInfo>,
}

impl From<mgit_core::RepoRefs> for RepoRefs {
    /// 하위 벡터를 변환한다
    fn from(r: mgit_core::RepoRefs) -> Self {
        Self {
            head: r.head.into(),
            labels: r.labels.into_iter().map(Into::into).collect(),
            stashes: r.stashes.into_iter().map(Into::into).collect(),
            worktrees: r.worktrees.into_iter().map(Into::into).collect(),
            remotes: r.remotes.into_iter().map(Into::into).collect(),
        }
    }
}

/// 저장소 상태 스냅샷
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub refs: RepoRefs,
    pub status: WorkTreeStatus,
    pub op: Option<InProgressOp>,
}

impl From<mgit_core::RepoState> for RepoState {
    /// 하위 타입을 변환한다
    fn from(s: mgit_core::RepoState) -> Self {
        Self {
            refs: s.refs.into(),
            status: s.status.into(),
            op: s.op.map(Into::into),
        }
    }
}

/// 저장소 세션 프로필 (계획 5.1절). 탭 = `full`, 폴더 화면의 가벼운 세션 = `light`(그래프·자동 fetch 없음)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionProfile {
    Full,
    Light,
}

impl From<mgit_core::SessionProfile> for SessionProfile {
    /// 코어 enum 과 1:1
    fn from(p: mgit_core::SessionProfile) -> Self {
        match p {
            mgit_core::SessionProfile::Full => SessionProfile::Full,
            mgit_core::SessionProfile::Light => SessionProfile::Light,
        }
    }
}

/// `open_repo`·`folder_open_repo_session` 응답
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpened {
    pub session: u32,
    /// 같은 작업 트리의 세션이 이미 있어 그것을 돌려줬는지 (승격했을 때도 참)
    pub already_open: bool,
    pub info: RepoInfo,
    pub state: RepoState,
    /// 추적되지 않는 하위 저장소 (서브모듈 제외)
    pub nested_repos: Vec<String>,
    /// 서브모듈이면 상위 저장소 경로
    pub superproject: Option<String>,
    /// 돌려준 세션의 지금 프로필. wire 에는 늘 실린다. TS 에서 선택 필드인 것은 기존 프런트 코드·테스트가
    /// 이 필드 없이 `RepoOpened` 를 만들기 때문이다 (없으면 `full` 로 읽는다)
    #[specta(optional)]
    pub profile: SessionProfile,
    /// 이 `openRepo` 호출이 가벼운 세션을 전체 프로필로 올렸는지. 참이면 그 세션의 이벤트는 이제 이 호출의
    /// 채널로 간다. wire 에는 늘 실린다 (TS 선택 필드인 이유는 `profile` 과 같다)
    #[specta(optional)]
    pub promoted: bool,
}

impl From<mgit_core::OpenedRepo> for RepoOpened {
    /// SessionId 를 u32 로 푼다
    fn from(opened: mgit_core::OpenedRepo) -> Self {
        Self {
            session: opened.session.0,
            already_open: opened.already_open,
            info: opened.info.into(),
            state: opened.state.into(),
            nested_repos: opened
                .nested_repos
                .into_iter()
                .map(|p| p.display().to_string())
                .collect(),
            superproject: opened.superproject.map(|p| p.display().to_string()),
            profile: opened.profile.into(),
            promoted: opened.promoted,
        }
    }
}

/// `folder_release_repo_session` 응답. 이미 닫혔거나 잡지 않은 세션도 오류가 아니라 이 모양이다
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSessionRelease {
    /// 이 호출로 그 폴더의 잡음이 풀렸는지
    pub released: bool,
    /// 세션이 아직 열려 있으면 그 프로필, 닫혔으면(이 호출로든 그 전에든) null
    pub profile: Option<SessionProfile>,
}

impl From<mgit_core::RepoSessionRelease> for RepoSessionRelease {
    /// 코어 → wire
    fn from(r: mgit_core::RepoSessionRelease) -> Self {
        Self {
            released: r.released,
            profile: r.profile.map(Into::into),
        }
    }
}

/// 명령 로그 한 줄 (SF-01)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogRecord {
    pub id: u32,
    pub args: Vec<String>,
    pub cwd: String,
    #[specta(type = specta_typescript::Number)]
    pub started_at: i64,
    pub elapsed_ms: u32,
    pub status: Option<i32>,
    pub stderr_tail: String,
    pub is_write: bool,
    pub cancelled: bool,
}

impl From<mgit_core::CommandLogRecord> for CommandLogRecord {
    /// id 를 u32 로 좁히고 경로를 문자열로
    fn from(r: mgit_core::CommandLogRecord) -> Self {
        Self {
            id: narrow_u64(r.id),
            args: r.args,
            cwd: path_str(&r.cwd),
            started_at: r.started_at,
            elapsed_ms: r.elapsed_ms,
            status: r.status,
            stderr_tail: r.stderr_tail,
            is_write: r.is_write,
            cancelled: r.cancelled,
        }
    }
}

/// 실패한 쓰기 명령의 힌트
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GitHint {
    DirtyWorkTree { files: Vec<String> },
    BranchCheckedOutElsewhere { path: String },
    NotFullyMerged,
    Conflicts,
    IndexLock,
    NonFastForward,
    AuthFailed,
    StaleInfo,
    DetachedHead,
    NothingToCommit,
    HookFailed,
    NoUpstream,
    RemoteTagExists,
    RemoteRejected { reason: String },
}

impl From<mgit_core::GitHint> for GitHint {
    /// 코어 열거형과 1:1
    fn from(h: mgit_core::GitHint) -> Self {
        use mgit_core::GitHint as H;
        match h {
            H::DirtyWorkTree { files } => GitHint::DirtyWorkTree { files },
            H::BranchCheckedOutElsewhere { path } => GitHint::BranchCheckedOutElsewhere { path },
            H::NotFullyMerged => GitHint::NotFullyMerged,
            H::Conflicts => GitHint::Conflicts,
            H::IndexLock => GitHint::IndexLock,
            H::NonFastForward => GitHint::NonFastForward,
            H::AuthFailed => GitHint::AuthFailed,
            H::StaleInfo => GitHint::StaleInfo,
            H::DetachedHead => GitHint::DetachedHead,
            H::NothingToCommit => GitHint::NothingToCommit,
            H::HookFailed => GitHint::HookFailed,
            H::NoUpstream => GitHint::NoUpstream,
            H::RemoteTagExists => GitHint::RemoteTagExists,
            H::RemoteRejected { reason } => GitHint::RemoteRejected { reason },
        }
    }
}

/// 그래프 한 행
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub row: u32,
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    #[specta(type = specta_typescript::Number)]
    pub author_time: i64,
    #[specta(type = specta_typescript::Number)]
    pub commit_time: i64,
    pub subject: String,
    pub lane: u16,
    pub color: u16,
    pub refs: Vec<RefLabel>,
    pub is_head: bool,
    /// HEAD(현재 브랜치)에서 닿는 커밋인지
    pub in_head: bool,
    /// 통합 타임라인의 저장소 인덱스 (단일 저장소는 None)
    pub repo: Option<u16>,
}

impl From<mgit_core::GraphRow> for GraphRow {
    /// Oid 들을 hex 문자열로, 라벨을 DTO 로 바꾼다
    fn from(row: mgit_core::GraphRow) -> Self {
        Self {
            row: row.row,
            oid: row.oid.to_string(),
            parents: row.parents.iter().map(ToString::to_string).collect(),
            author_name: row.author_name,
            author_email: row.author_email,
            author_time: row.author_time,
            commit_time: row.commit_time,
            subject: row.subject,
            lane: row.lane,
            color: row.color,
            refs: row.refs.into_iter().map(Into::into).collect(),
            is_head: row.is_head,
            in_head: row.in_head,
            repo: row.repo,
        }
    }
}

/// 접힌 긴 엣지의 방향
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum StubDir {
    Down,
    Up,
}

/// 접힌 긴 엣지의 끝 (자식 행은 Down, 부모 행은 Up)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowStub {
    pub row: u32,
    pub lane: u16,
    pub dir: StubDir,
    /// 상대 행 (부모가 아직 안 왔거나 스트림 밖이면 None)
    pub other_row: Option<u32>,
    pub color: u16,
}

impl From<mgit_core::WindowStub> for WindowStub {
    /// 코어 구조체와 1:1
    fn from(s: mgit_core::WindowStub) -> Self {
        Self {
            row: s.row,
            lane: s.lane,
            dir: match s.dir {
                mgit_core::StubDir::Down => StubDir::Down,
                mgit_core::StubDir::Up => StubDir::Up,
            },
            other_row: s.other_row,
            color: s.color,
        }
    }
}

/// 요청 범위에 클립된 레인 세로 구간
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowSegment {
    pub lane: u16,
    pub from_row: u32,
    pub to_row: u32,
    pub color: u16,
    pub continues_up: bool,
    pub continues_down: bool,
}

impl From<mgit_core::WindowSegment> for WindowSegment {
    /// 코어 구조체와 1:1
    fn from(seg: mgit_core::WindowSegment) -> Self {
        Self {
            lane: seg.lane,
            from_row: seg.from_row,
            to_row: seg.to_row,
            color: seg.color,
            continues_up: seg.continues_up,
            continues_down: seg.continues_down,
        }
    }
}

/// 인접 행 사이의 대각선 엣지 (top_row → top_row + 1)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowEdge {
    pub top_row: u32,
    pub top_lane: u16,
    pub bottom_lane: u16,
    pub color: u16,
}

impl From<mgit_core::WindowEdge> for WindowEdge {
    /// 코어 구조체와 1:1
    fn from(edge: mgit_core::WindowEdge) -> Self {
        Self {
            top_row: edge.top_row,
            top_lane: edge.top_lane,
            bottom_lane: edge.bottom_lane,
            color: edge.color,
        }
    }
}

/// `graph_window` 응답: 보이는 범위의 행·구간·엣지
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphWindow {
    pub generation: u32,
    pub start: u32,
    pub total_rows: u32,
    pub finished: bool,
    pub lane_count: u16,
    pub rows: Vec<GraphRow>,
    pub segments: Vec<WindowSegment>,
    pub edges: Vec<WindowEdge>,
    pub stubs: Vec<WindowStub>,
}

impl From<mgit_core::GraphWindow> for GraphWindow {
    /// generation 을 u32 로 좁히고 하위 벡터를 변환한다
    fn from(window: mgit_core::GraphWindow) -> Self {
        Self {
            generation: narrow_u64(window.generation),
            start: window.start,
            total_rows: window.total_rows,
            finished: window.finished,
            lane_count: window.lane_count,
            rows: window.rows.into_iter().map(Into::into).collect(),
            segments: window.segments.into_iter().map(Into::into).collect(),
            edges: window.edges.into_iter().map(Into::into).collect(),
            stubs: window.stubs.into_iter().map(Into::into).collect(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn short_branch_strips_heads_prefix() {
        assert_eq!(short_branch("refs/heads/main"), "main");
        assert_eq!(short_branch("refs/heads/feature/a"), "feature/a");
        assert_eq!(short_branch("main"), "main");
    }

    #[test]
    fn narrow_u64_saturates() {
        assert_eq!(narrow_u64(7), 7);
        assert_eq!(narrow_u64(u64::MAX), u32::MAX);
    }
}
