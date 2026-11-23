//! tag 관리 커맨드 (BR-06, TG-01~18): tag push, 원격·로컬 tag 삭제, 원격 tag 상태 조회, 가져오기, 목록

use mgit_core::{
    LocalTag, RemoteTag, SessionId, TagDeleteItem, TagLeaseItem, TagLookupError,
    TagLookupErrorKind, TagRefResult, TagRefStatus, TagSyncCounts, TagSyncEntry, TagSyncReport,
    TagSyncState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_refs::parse_oid;
use crate::error::IpcError;
use crate::state::AppState;

/// tag 하나의 작업 결과 상태 (코어 `TagRefStatus` 와 1:1)
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TagRefStatusDto {
    Pushed,
    UpToDate,
    Deleted,
    AlreadyAbsent,
    Fetched,
    Diverged,
    RejectedExists,
    RejectedStale,
    RejectedRemote,
    Failed,
    Unknown,
    /// 확인 대기로 실행하지 않음 (원격 삭제에서 같은 호출의 다른 tag 가 diverged). 성공도 실패도 아니다
    NotRun,
}

impl From<TagRefStatus> for TagRefStatusDto {
    /// 코어 열거형과 1:1
    fn from(s: TagRefStatus) -> Self {
        match s {
            TagRefStatus::Pushed => Self::Pushed,
            TagRefStatus::UpToDate => Self::UpToDate,
            TagRefStatus::Deleted => Self::Deleted,
            TagRefStatus::AlreadyAbsent => Self::AlreadyAbsent,
            TagRefStatus::Fetched => Self::Fetched,
            TagRefStatus::Diverged => Self::Diverged,
            TagRefStatus::RejectedExists => Self::RejectedExists,
            TagRefStatus::RejectedStale => Self::RejectedStale,
            TagRefStatus::RejectedRemote => Self::RejectedRemote,
            TagRefStatus::Failed => Self::Failed,
            TagRefStatus::Unknown => Self::Unknown,
            TagRefStatus::NotRun => Self::NotRun,
        }
    }
}

/// tag 하나의 작업 결과. `remoteOid` 는 원격 ref 가 가리키는 객체(annotated 면 tag 객체)이고, `diverged` 면 이 값을
/// `expectedRemote` 로 넘겨 다시 요청한다. `remoteCommit` 은 그것을 벗긴 commit (확인창의 두 commit 중 원격 쪽)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagRefResultDto {
    pub name: String,
    pub status: TagRefStatusDto,
    /// 서버·git 이 준 사유나 실패 원문
    pub message: Option<String>,
    pub remote_oid: Option<String>,
    pub remote_commit: Option<String>,
}

impl From<TagRefResult> for TagRefResultDto {
    /// Oid 를 문자열로
    fn from(r: TagRefResult) -> Self {
        Self {
            name: r.name,
            status: r.status.into(),
            message: r.message,
            remote_oid: r.remote_oid.map(|o| o.to_hex()),
            remote_commit: r.remote_commit.map(|o| o.to_hex()),
        }
    }
}

/// 원격 삭제 요청 하나. `expectedRemote` 는 `diverged` 를 확인한 뒤 다시 부를 때 그때 받은 `remoteOid`
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagDeleteItemDto {
    pub name: String,
    pub expected_remote: Option<String>,
}

/// 원격 하나에 대한 tag 하나의 상태 (코어 `TagSyncState` 와 1:1)
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TagSyncStateDto {
    LocalOnly,
    RemoteOnly,
    Same,
    /// `sameCommit` 이면 벗긴 commit 은 같다 (예: 원격 경량, 로컬 annotated)
    Diverged {
        same_commit: bool,
    },
    Unknown,
}

impl From<TagSyncState> for TagSyncStateDto {
    /// 코어 열거형과 1:1
    fn from(s: TagSyncState) -> Self {
        match s {
            TagSyncState::LocalOnly => Self::LocalOnly,
            TagSyncState::RemoteOnly => Self::RemoteOnly,
            TagSyncState::Same => Self::Same,
            TagSyncState::Diverged { same_commit } => Self::Diverged { same_commit },
            TagSyncState::Unknown => Self::Unknown,
        }
    }
}

/// 비교 결과 한 줄 ("같음"이 아닌 것만 온다). oid 는 hex
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagSyncEntryDto {
    pub name: String,
    pub state: TagSyncStateDto,
    pub local_object: Option<String>,
    pub local_commit: Option<String>,
    pub remote_object: Option<String>,
    pub remote_commit: Option<String>,
}

impl From<TagSyncEntry> for TagSyncEntryDto {
    /// Oid 를 문자열로
    fn from(e: TagSyncEntry) -> Self {
        Self {
            name: e.name,
            state: e.state.into(),
            local_object: e.local_object.map(|o| o.to_hex()),
            local_commit: e.local_commit.map(|o| o.to_hex()),
            remote_object: e.remote_object.map(|o| o.to_hex()),
            remote_commit: e.remote_commit.map(|o| o.to_hex()),
        }
    }
}

/// 상태별 개수
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagSyncCountsDto {
    pub local_only: u32,
    pub remote_only: u32,
    pub same: u32,
    pub diverged: u32,
    pub unknown: u32,
}

impl From<TagSyncCounts> for TagSyncCountsDto {
    /// 코어 구조체와 1:1
    fn from(c: TagSyncCounts) -> Self {
        Self {
            local_only: c.local_only,
            remote_only: c.remote_only,
            same: c.same,
            diverged: c.diverged,
            unknown: c.unknown,
        }
    }
}

/// 원격 조회 실패 종류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TagLookupErrorKindDto {
    Auth,
    Network,
    Other,
}

/// 마지막 원격 조회 실패. `at` 은 epoch 밀리초
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagLookupErrorDto {
    pub kind: TagLookupErrorKindDto,
    #[specta(type = specta_typescript::Number)]
    pub at: i64,
    pub message: String,
}

impl From<TagLookupError> for TagLookupErrorDto {
    /// 코어 구조체와 1:1
    fn from(e: TagLookupError) -> Self {
        Self {
            kind: match e.kind {
                TagLookupErrorKind::Auth => TagLookupErrorKindDto::Auth,
                TagLookupErrorKind::Network => TagLookupErrorKindDto::Network,
                TagLookupErrorKind::Other => TagLookupErrorKindDto::Other,
            },
            at: e.at,
            message: e.message,
        }
    }
}

/// 원격 하나의 tag 비교 보고서 (TG-08). `checkedAt`(epoch 밀리초)이 null 이면 확인한 적이 없고 개수·항목이 비어 있다.
/// 개수는 전부를 세고 항목은 "같음"이 아닌 것만 이름순으로 온다. 조회가 실패해도 이전 값은 남고 `lastError` 가 붙는다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagSyncReportDto {
    pub remote: String,
    #[specta(type = Option<specta_typescript::Number>)]
    pub checked_at: Option<i64>,
    pub stale: bool,
    pub last_error: Option<TagLookupErrorDto>,
    pub counts: TagSyncCountsDto,
    pub entries: Vec<TagSyncEntryDto>,
    pub push_url_differs: bool,
}

impl From<TagSyncReport> for TagSyncReportDto {
    /// 코어 구조체를 wire 형태로
    fn from(r: TagSyncReport) -> Self {
        Self {
            remote: r.remote,
            checked_at: r.checked_at,
            stale: r.stale,
            last_error: r.last_error.map(Into::into),
            counts: r.counts.into(),
            entries: r.entries.into_iter().map(Into::into).collect(),
            push_url_differs: r.push_url_differs,
        }
    }
}

/// 원격 tag 하나 (단일 조회 결과). `peeled` 는 annotated 면 벗긴 commit
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTagDto {
    pub name: String,
    pub object: String,
    pub peeled: Option<String>,
}

impl From<RemoteTag> for RemoteTagDto {
    /// Oid 를 문자열로
    fn from(t: RemoteTag) -> Self {
        Self {
            name: t.name,
            object: t.object.to_hex(),
            peeled: t.peeled.map(|o| o.to_hex()),
        }
    }
}

/// 로컬 tag 목록의 한 줄 (TG-10 열·툴팁). `date` 는 epoch 초(annotated 는 tagger 날짜, 경량은 commit 날짜), oid 는 hex.
/// 경량이면 `tagSubject`·`tagger` 가 null 이고 `commit` 이 `object` 와 같다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagDto {
    pub name: String,
    pub annotated: bool,
    pub object: String,
    pub commit: String,
    #[specta(type = Option<specta_typescript::Number>)]
    pub date: Option<i64>,
    pub commit_subject: String,
    pub tag_subject: Option<String>,
    pub tagger: Option<String>,
}

impl From<LocalTag> for LocalTagDto {
    /// Oid 를 문자열로
    fn from(t: LocalTag) -> Self {
        Self {
            name: t.name,
            annotated: t.annotated,
            object: t.object.to_hex(),
            commit: t.commit.to_hex(),
            date: t.date,
            commit_subject: t.commit_subject,
            tag_subject: t.tag_subject,
            tagger: t.tagger,
        }
    }
}

/// 원격 조회 op 의 종류. 세션 busy 와 무관하고, 프런트는 오래 걸린 작업 토스트에서 이 종류를 뺀다 (TG-08 ⑥)
const TAG_CHECK_KIND: &str = "tagCheck";

/// 원격 tag 를 로컬 것으로 덮어쓰는 요청 하나. `expectedRemote` 는 확인한 원격 객체(`remoteOid`) — 지금 원격이 이 값일
/// 때만 덮어쓴다
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagLeaseItemDto {
    pub name: String,
    pub expected_remote: String,
}

/// op 라벨 뒤에 붙일 tag 목록: `v1` / `v1 v2 v3 (+N)`
fn names_label(names: &[String]) -> String {
    const SHOWN: usize = 3;
    let head = names
        .iter()
        .take(SHOWN)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    if names.len() > SHOWN {
        format!("{head} (+{})", names.len() - SHOWN)
    } else {
        head
    }
}

/// 고른 원격으로 tag 들을 push 한다 (TG-01). 진행률·출력은 operation 이벤트(kind `push`)로 온다.
/// 결과는 요청 순서대로 tag 마다 하나다. 첫 청크가 통째로 실패하면(인증·연결) `gitFailed`
#[tauri::command]
#[specta::specta]
pub async fn push_tags(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    names: Vec<String>,
) -> Result<Vec<TagRefResultDto>, IpcError> {
    let core = &state.core()?.core;
    let label = format!("push {remote} {}", names_label(&names));
    let op = core.begin_operation(SessionId(session), "push", &label)?;
    let results = core
        .push_tags(SessionId(session), &remote, &names, Some(op))
        .await?;
    Ok(results.into_iter().map(Into::into).collect())
}

/// 원격 tag 를 로컬 것으로 덮어쓴다 (TG-15 "로컬 것으로 맞추기"): 항목마다 `expectedRemote` 로 lease 를 건 push 한 번.
/// 결과는 `pushed`(덮어씀)·`upToDate`·`rejectedStale`(그 사이 원격이 바뀜, 원격 그대로)·`rejectedRemote`·`failed`·
/// `unknown`. `--force` 단독 경로는 없다. undo 항목 없음. operation 이벤트(kind `push`)
#[tauri::command]
#[specta::specta]
pub async fn replace_remote_tags(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    items: Vec<TagLeaseItemDto>,
) -> Result<Vec<TagRefResultDto>, IpcError> {
    let core = &state.core()?.core;
    let items = items
        .into_iter()
        .map(|i| {
            Ok(TagLeaseItem {
                expected_remote: parse_oid(&i.expected_remote)?,
                name: i.name,
            })
        })
        .collect::<Result<Vec<_>, IpcError>>()?;
    let names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
    let label = format!("push {remote} --force-with-lease {}", names_label(&names));
    let op = core.begin_operation(SessionId(session), "push", &label)?;
    let results = core
        .replace_remote_tags(SessionId(session), &remote, &items, Some(op))
        .await?;
    Ok(results.into_iter().map(Into::into).collect())
}

/// 고른 원격에서 tag 들을 지운다 (TG-04). 실행 직전에 모두 조회하고, `expectedRemote` 없이 로컬과 다른 것(`diverged`,
/// `remoteOid`·`remoteCommit`)이 하나라도 있으면 아무것도 지우지 않고 나머지는 `notRun` 이다. 아니면 조회값으로 lease 를
/// 걸어 지운다(원격에 없으면 `alreadyAbsent`, `expectedRemote` 가 조회값과 다르면 `rejectedStale`).
/// operation 이벤트(kind `push`)가 붙는다
#[tauri::command]
#[specta::specta]
pub async fn delete_remote_tags(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    items: Vec<TagDeleteItemDto>,
) -> Result<Vec<TagRefResultDto>, IpcError> {
    let core = &state.core()?.core;
    let items = items
        .into_iter()
        .map(|i| {
            Ok(TagDeleteItem {
                expected_remote: i.expected_remote.as_deref().map(parse_oid).transpose()?,
                name: i.name,
            })
        })
        .collect::<Result<Vec<_>, IpcError>>()?;
    let names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
    let label = format!("push {remote} --delete {}", names_label(&names));
    let op = core.begin_operation(SessionId(session), "push", &label)?;
    let results = core
        .delete_remote_tags(SessionId(session), &remote, &items, Some(op))
        .await?;
    Ok(results.into_iter().map(Into::into).collect())
}

/// 원격 tag 상태 보고서 (TG-08). `remote` 가 null 이면 업스트림의 원격 → origin → 첫 원격. `refresh` 면 원격을 조회하고
/// (op kind `tagCheck`, 세션 busy 와 무관, 취소 가능), 아니면 네트워크 없이 캐시로 만든다. 조회 실패는 거부가 아니라
/// `lastError` 가 붙은 보고서로 온다. 취소하면 `cancelled`
#[tauri::command]
#[specta::specta]
pub async fn remote_tags(
    state: State<'_, AppState>,
    session: u32,
    remote: Option<String>,
    refresh: bool,
) -> Result<TagSyncReportDto, IpcError> {
    let core = &state.core()?.core;
    let op = if refresh {
        let label = match &remote {
            Some(r) => format!("ls-remote --tags {r}"),
            None => "ls-remote --tags".to_string(),
        };
        Some(core.begin_operation(SessionId(session), TAG_CHECK_KIND, &label)?)
    } else {
        None
    };
    let report = core
        .remote_tags(SessionId(session), remote.as_deref(), refresh, op)
        .await?;
    Ok(report.into())
}

/// 원격 tag 몇 개를 조회한다 (단일 조회). 원격에 있는 것만 요청 순서대로 온다. 확인한 원격 상태가 있으면 그 이름들을
/// 고친다. op kind `tagCheck`
#[tauri::command]
#[specta::specta]
pub async fn lookup_remote_tags(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    names: Vec<String>,
) -> Result<Vec<RemoteTagDto>, IpcError> {
    let core = &state.core()?.core;
    let label = format!("ls-remote --tags {remote} {}", names_label(&names));
    let op = core.begin_operation(SessionId(session), TAG_CHECK_KIND, &label)?;
    let tags = core
        .lookup_remote_tags(SessionId(session), &remote, &names, Some(op))
        .await?;
    Ok(tags.into_iter().map(Into::into).collect())
}

/// 원격 tag 를 받아 온다 (TG-11). `overwrite` 면 로컬의 다른 tag 를 원격 것으로 바꾼다(TG-15 원격 것으로 맞추기).
/// 결과는 tag 마다 `fetched`·`upToDate`·`rejectedExists`(덮어쓰지 않음, `remoteOid` 는 원격 객체)·`unknown`. undo 항목
/// 하나. operation 이벤트(kind `fetch`)가 붙는다. 원격에 없는 이름이 섞이면 git 이 전체를 멈춰 `gitFailed`
#[tauri::command]
#[specta::specta]
pub async fn fetch_tags(
    state: State<'_, AppState>,
    session: u32,
    remote: String,
    names: Vec<String>,
    overwrite: bool,
) -> Result<Vec<TagRefResultDto>, IpcError> {
    let core = &state.core()?.core;
    let plus = if overwrite { "+" } else { "" };
    let label = format!("fetch {remote} {plus}{}", names_label(&names));
    let op = core.begin_operation(SessionId(session), "fetch", &label)?;
    let results = core
        .fetch_tags(SessionId(session), &remote, &names, overwrite, Some(op))
        .await?;
    Ok(results.into_iter().map(Into::into).collect())
}

/// 로컬 tag 목록 (TG-10): `for-each-ref` 한 번으로 종류·날짜·commit 제목·tag 제목·tagger. 이름순
#[tauri::command]
#[specta::specta]
pub async fn tag_list(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Vec<LocalTagDto>, IpcError> {
    let list = state.core()?.core.tag_list(SessionId(session)).await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 로컬 tag 들을 한 트랜잭션으로 지운다 (TG-06). undo 항목 하나 (`tag -d v1 v2 v3 (+N)`)
#[tauri::command]
#[specta::specta]
pub async fn delete_local_tags(
    state: State<'_, AppState>,
    session: u32,
    names: Vec<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .delete_local_tags(SessionId(session), &names)
        .await?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn op_label_lists_three_names() {
        let n = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(names_label(&n(&["v1"])), "v1");
        assert_eq!(names_label(&n(&["a", "b", "c", "d"])), "a b c (+1)");
    }

    #[test]
    fn result_dto_carries_hex_oids() {
        let hex = "a".repeat(40);
        let oid = mgit_core::Oid::from_hex(hex.as_bytes()).unwrap();
        let mut r = TagRefResult::new("v1", TagRefStatus::Diverged);
        r.remote_oid = Some(oid);
        r.remote_commit = Some(oid);
        let json = serde_json::to_value(TagRefResultDto::from(r)).unwrap();
        assert_eq!(json["status"], "diverged");
        assert_eq!(json["remoteOid"], hex);
        assert_eq!(json["remoteCommit"], hex);
        assert!(json["message"].is_null());
    }

    #[test]
    fn report_dto_serializes_state_kind_and_counts() {
        let report = TagSyncReport {
            remote: "origin".into(),
            checked_at: Some(5),
            stale: true,
            last_error: None,
            counts: TagSyncCounts {
                local_only: 1,
                ..TagSyncCounts::default()
            },
            entries: vec![TagSyncEntry {
                name: "v1".into(),
                state: TagSyncState::Diverged { same_commit: true },
                local_object: None,
                local_commit: None,
                remote_object: None,
                remote_commit: None,
            }],
            push_url_differs: false,
        };
        let json = serde_json::to_value(TagSyncReportDto::from(report)).unwrap();
        assert_eq!(json["checkedAt"], 5);
        assert_eq!(json["counts"]["localOnly"], 1);
        assert_eq!(json["entries"][0]["state"]["kind"], "diverged");
        assert_eq!(json["entries"][0]["state"]["sameCommit"], true);
        assert!(json["lastError"].is_null());
    }

    #[test]
    fn delete_item_reads_camel_case() {
        let item: TagDeleteItemDto =
            serde_json::from_str(r#"{"name":"v1","expectedRemote":null}"#).unwrap();
        assert_eq!(item.name, "v1");
        assert!(item.expected_remote.is_none());
    }
}
