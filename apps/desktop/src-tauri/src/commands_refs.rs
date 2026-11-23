//! 커밋 상세·검색·브랜치·태그·병합 커맨드 (S3)

use mgit_core::{CheckoutTarget, MergeMode, Oid, ResetMode, SearchFields, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::dto::RefLabel;
use crate::dto_diff::DiffChange;
use crate::error::IpcError;
use crate::state::AppState;

/// hex 문자열을 Oid 로 (폴더 커밋 상세도 같은 규칙으로 쓴다)
pub(crate) fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 커밋이 바꾼 파일
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub change: DiffChange,
}

impl From<mgit_core::ChangedFile> for ChangedFile {
    /// 코어 구조체와 1:1
    fn from(f: mgit_core::ChangedFile) -> Self {
        Self {
            path: f.path,
            old_path: f.old_path,
            change: f.change.into(),
        }
    }
}

/// 커밋 상세
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub parents: Vec<String>,
    pub children: Vec<String>,
    pub row: Option<u32>,
    pub author_name: String,
    pub author_email: String,
    #[specta(type = specta_typescript::Number)]
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    #[specta(type = specta_typescript::Number)]
    pub committer_time: i64,
    pub message: String,
    pub refs: Vec<RefLabel>,
    pub files: Vec<ChangedFile>,
}

impl From<mgit_core::CommitDetail> for CommitDetail {
    /// Oid 를 문자열로
    fn from(d: mgit_core::CommitDetail) -> Self {
        Self {
            oid: d.oid.to_hex(),
            parents: d.parents.iter().map(Oid::to_hex).collect(),
            children: d.children.iter().map(Oid::to_hex).collect(),
            row: d.row,
            author_name: d.author_name,
            author_email: d.author_email,
            author_time: d.author_time,
            committer_name: d.committer_name,
            committer_email: d.committer_email,
            committer_time: d.committer_time,
            message: d.message,
            refs: d.refs.into_iter().map(Into::into).collect(),
            files: d.files.into_iter().map(Into::into).collect(),
        }
    }
}

/// 검색 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub rows: Vec<u32>,
    pub total: u32,
    pub truncated: bool,
}

/// checkout 대상 (프런트 → 코어)
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CheckoutTargetDto {
    Branch {
        name: String,
    },
    /// `local` 은 만들 로컬 브랜치 이름. 없으면 원격 브랜치 이름을 쓴다
    RemoteBranch {
        remote: String,
        name: String,
        local: Option<String>,
    },
    Commit {
        oid: String,
    },
    NewBranch {
        name: String,
        start: Option<String>,
    },
}

impl TryFrom<CheckoutTargetDto> for CheckoutTarget {
    type Error = IpcError;

    /// wire → 코어
    fn try_from(t: CheckoutTargetDto) -> Result<Self, IpcError> {
        Ok(match t {
            CheckoutTargetDto::Branch { name } => CheckoutTarget::Branch(name),
            CheckoutTargetDto::RemoteBranch {
                remote,
                name,
                local,
            } => CheckoutTarget::RemoteBranch {
                remote,
                name,
                local,
            },
            CheckoutTargetDto::Commit { oid } => CheckoutTarget::Commit(parse_oid(&oid)?),
            CheckoutTargetDto::NewBranch { name, start } => {
                CheckoutTarget::NewBranch { name, start }
            }
        })
    }
}

/// merge 방식
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeModeDto {
    Default,
    NoFf,
    FfOnly,
    Squash,
}

impl From<MergeModeDto> for MergeMode {
    /// wire → 코어
    fn from(m: MergeModeDto) -> Self {
        match m {
            MergeModeDto::Default => MergeMode::Default,
            MergeModeDto::NoFf => MergeMode::NoFf,
            MergeModeDto::FfOnly => MergeMode::FfOnly,
            MergeModeDto::Squash => MergeMode::Squash,
        }
    }
}

/// reset 방식
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ResetModeDto {
    Soft,
    Mixed,
    Hard,
}

impl From<ResetModeDto> for ResetMode {
    /// wire → 코어
    fn from(m: ResetModeDto) -> Self {
        match m {
            ResetModeDto::Soft => ResetMode::Soft,
            ResetModeDto::Mixed => ResetMode::Mixed,
            ResetModeDto::Hard => ResetMode::Hard,
        }
    }
}

/// 병합류 결과
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpOutcome {
    Clean,
    Conflicts,
}

impl From<mgit_core::OpOutcome> for OpOutcome {
    /// 코어 → wire
    fn from(o: mgit_core::OpOutcome) -> Self {
        match o {
            mgit_core::OpOutcome::Clean => OpOutcome::Clean,
            mgit_core::OpOutcome::Conflicts => OpOutcome::Conflicts,
        }
    }
}

/// 커밋을 포함하는 브랜치 하나 (CD-03)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContainingBranchDto {
    /// 전체 ref 이름 (`refs/heads/x`, `refs/remotes/origin/x`)
    pub name: String,
    /// 화면용 짧은 이름 (`x`, `origin/x`)
    pub short_name: String,
    pub remote: bool,
    /// HEAD 가 가리키는 현재 브랜치
    pub current: bool,
}

/// 커밋을 포함하는 브랜치 목록 (CD-03). 시간 초과는 오류가 아니라 `timed_out` 으로 온다 —
/// 이때 `head`·`branches` 는 비어 있고 "다시 시도" 로 다시 묻는다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContainingRefsDto {
    pub timed_out: bool,
    /// HEAD 에서 닿는지 (화면은 목록 맨 앞에 `HEAD`)
    pub head: bool,
    /// 현재 브랜치 → 로컬(이름순) → 원격(이름순)
    pub branches: Vec<ContainingBranchDto>,
}

impl From<mgit_core::ContainingRefs> for ContainingRefsDto {
    /// 코어 → wire (1:1)
    fn from(r: mgit_core::ContainingRefs) -> Self {
        ContainingRefsDto {
            timed_out: r.timed_out,
            head: r.head,
            branches: r
                .branches
                .into_iter()
                .map(|b| ContainingBranchDto {
                    name: b.name,
                    short_name: b.short_name,
                    remote: b.remote,
                    current: b.current,
                })
                .collect(),
        }
    }
}

/// 커밋을 포함하는 로컬·원격 브랜치와 HEAD 포함 여부 (CD-03). 커밋 상세와 따로 뒤늦게 부른다.
/// 10초 안에 끝나지 않으면 `timedOut`
#[tauri::command]
#[specta::specta]
pub async fn commit_containing_refs(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<ContainingRefsDto, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .commit_containing_refs(SessionId(session), &oid)
        .await?
        .into())
}

/// 커밋 상세
#[tauri::command]
#[specta::specta]
pub async fn commit_detail(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<CommitDetail, IpcError> {
    let oid = parse_oid(&oid)?;
    Ok(state
        .core()?
        .core
        .commit_detail(SessionId(session), &oid)
        .await?
        .into())
}

/// 메시지·작성자·해시 검색 (GRAPH-06)
#[tauri::command]
#[specta::specta]
pub async fn search_commits(
    state: State<'_, AppState>,
    session: u32,
    query: String,
    subject: bool,
    author: bool,
    hash: bool,
    limit: u32,
) -> Result<SearchResult, IpcError> {
    let r = state.core()?.core.search_commits(
        SessionId(session),
        &query,
        SearchFields {
            subject,
            author,
            hash,
        },
        limit as usize,
    )?;
    Ok(SearchResult {
        rows: r.rows,
        total: r.total,
        truncated: r.truncated,
    })
}

/// 체크아웃 (BR-02·03). 실패 힌트는 `gitFailed.hint`
#[tauri::command]
#[specta::specta]
pub async fn checkout(
    state: State<'_, AppState>,
    session: u32,
    target: CheckoutTargetDto,
    stash_first: bool,
) -> Result<(), IpcError> {
    let target: CheckoutTarget = target.try_into()?;
    state
        .core()?
        .core
        .checkout(SessionId(session), target, stash_first)
        .await?;
    Ok(())
}

/// 브랜치 생성
#[tauri::command]
#[specta::specta]
pub async fn create_branch(
    state: State<'_, AppState>,
    session: u32,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .create_branch(SessionId(session), &name, start.as_deref(), checkout)
        .await?;
    Ok(())
}

/// 브랜치 이름 변경
#[tauri::command]
#[specta::specta]
pub async fn rename_branch(
    state: State<'_, AppState>,
    session: u32,
    old_name: String,
    new_name: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .rename_branch(SessionId(session), &old_name, &new_name)
        .await?;
    Ok(())
}

/// 로컬 브랜치 삭제. 병합되지 않았으면 `notFullyMerged` 힌트
#[tauri::command]
#[specta::specta]
pub async fn delete_branch(
    state: State<'_, AppState>,
    session: u32,
    name: String,
    force: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .delete_branch(SessionId(session), &name, force)
        .await?;
    Ok(())
}

/// 원격 브랜치 삭제
#[tauri::command]
#[specta::specta]
pub async fn delete_remote_branch(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    name: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .delete_remote_branch(SessionId(session), &remote, &name)
        .await?;
    Ok(())
}

/// 업스트림 지정·해제
#[tauri::command]
#[specta::specta]
pub async fn set_upstream(
    state: State<'_, AppState>,
    session: u32,
    branch: String,
    upstream: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_upstream(SessionId(session), &branch, upstream.as_deref())
        .await?;
    Ok(())
}

/// 태그 생성 (message 가 있으면 annotated)
#[tauri::command]
#[specta::specta]
pub async fn create_tag(
    state: State<'_, AppState>,
    session: u32,
    name: String,
    target: Option<String>,
    message: Option<String>,
    sign: bool,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .create_tag(
            SessionId(session),
            &name,
            target.as_deref(),
            message.as_deref(),
            sign,
        )
        .await?;
    Ok(())
}

/// 태그 삭제
#[tauri::command]
#[specta::specta]
pub async fn delete_tag(
    state: State<'_, AppState>,
    session: u32,
    name: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .delete_tag(SessionId(session), &name)
        .await?;
    Ok(())
}

/// merge (MRG-01)
#[tauri::command]
#[specta::specta]
pub async fn merge(
    state: State<'_, AppState>,
    session: u32,
    reference: String,
    mode: MergeModeDto,
) -> Result<OpOutcome, IpcError> {
    Ok(state
        .core()?
        .core
        .merge(SessionId(session), &reference, mode.into())
        .await?
        .into())
}

/// rebase (MRG-02)
#[tauri::command]
#[specta::specta]
pub async fn rebase(
    state: State<'_, AppState>,
    session: u32,
    onto: String,
    autostash: bool,
) -> Result<OpOutcome, IpcError> {
    Ok(state
        .core()?
        .core
        .rebase(SessionId(session), &onto, autostash)
        .await?
        .into())
}

/// cherry-pick (MRG-03)
#[tauri::command]
#[specta::specta]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    session: u32,
    oids: Vec<String>,
) -> Result<OpOutcome, IpcError> {
    let oids = oids
        .iter()
        .map(|o| parse_oid(o))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(state
        .core()?
        .core
        .cherry_pick(SessionId(session), &oids)
        .await?
        .into())
}

/// revert (MRG-03)
#[tauri::command]
#[specta::specta]
pub async fn revert(
    state: State<'_, AppState>,
    session: u32,
    oids: Vec<String>,
) -> Result<OpOutcome, IpcError> {
    let oids = oids
        .iter()
        .map(|o| parse_oid(o))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(state
        .core()?
        .core
        .revert(SessionId(session), &oids)
        .await?
        .into())
}

/// reset (MRG-04). hard 는 프런트가 확인을 받는다 (SF-02)
#[tauri::command]
#[specta::specta]
pub async fn reset(
    state: State<'_, AppState>,
    session: u32,
    target: String,
    mode: ResetModeDto,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .reset(SessionId(session), &target, mode.into())
        .await?;
    Ok(())
}

/// 진행 중 작업 계속 (MRG-05). 마커가 남아 있으면 `allow_conflict_markers` 가 아닌 한
/// `ConflictMarkers` 오류
#[tauri::command]
#[specta::specta]
pub async fn op_continue(
    state: State<'_, AppState>,
    session: u32,
    allow_conflict_markers: bool,
) -> Result<OpOutcome, IpcError> {
    Ok(state
        .core()?
        .core
        .op_continue(SessionId(session), allow_conflict_markers)
        .await?
        .into())
}

/// 진행 중 작업 건너뛰기
#[tauri::command]
#[specta::specta]
pub async fn op_skip(state: State<'_, AppState>, session: u32) -> Result<OpOutcome, IpcError> {
    Ok(state.core()?.core.op_skip(SessionId(session)).await?.into())
}

/// 진행 중 작업 중단
#[tauri::command]
#[specta::specta]
pub async fn op_abort(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.op_abort(SessionId(session)).await?;
    Ok(())
}

/// commit-graph 생성 (AD-03)
#[tauri::command]
#[specta::specta]
pub async fn commit_graph_write(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .commit_graph_write(SessionId(session))
        .await?;
    Ok(())
}
