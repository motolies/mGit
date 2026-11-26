//! 가상 그룹 커맨드 (MR-13): 정의 목록·경로 확인·만들기·고치기·지우기와 그룹 열기. 그룹 세션은 폴더 세션이라 열린 뒤에는
//! 폴더 커맨드(`folder_*`)를 그대로 쓴다

use std::path::PathBuf;
use std::sync::Arc;

use mgit_core::{
    Core, CoreError, EventSink, GroupId, GroupMember, GroupUpdate, MemberState, PathIssue,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::commands_repo::{FolderOpened, RepoKind};
use crate::error::IpcError;
use crate::events::{ChannelSink, SessionEvent};
use crate::state::AppState;

/// 멤버의 지금 상태
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GroupMemberState {
    /// 저장소가 그 자리에 있다
    Present,
    /// 경로가 없다 (정의는 남고 로스터에서 빠진다)
    Missing,
    /// 경로는 있으나 저장소가 아니다
    NotRepo,
}

/// 그룹 멤버 하나 (별칭·경로·상태). `kind` 는 있는 멤버만
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberInfo {
    pub alias: String,
    pub path: String,
    pub state: GroupMemberState,
    pub kind: Option<RepoKind>,
}

impl From<mgit_core::GroupMount> for GroupMemberInfo {
    /// 경로를 문자열로, 상태를 종류와 나눠 싣는다
    fn from(m: mgit_core::GroupMount) -> Self {
        let (state, kind) = match m.state {
            MemberState::Present(kind) => (GroupMemberState::Present, Some(kind.into())),
            MemberState::Missing => (GroupMemberState::Missing, None),
            MemberState::NotRepo => (GroupMemberState::NotRepo, None),
        };
        GroupMemberInfo {
            alias: m.alias,
            path: m.path.display().to_string(),
            state,
            kind,
        }
    }
}

/// 열린 그룹의 모습 (`FolderOpened.group`, `groupChanged`)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub members: Vec<GroupMemberInfo>,
}

impl From<mgit_core::GroupView> for GroupInfo {
    /// 코어 → wire
    fn from(v: mgit_core::GroupView) -> Self {
        GroupInfo {
            id: v.id.as_str().to_owned(),
            name: v.name,
            members: v.members.into_iter().map(Into::into).collect(),
        }
    }
}

/// 그룹 목록 한 줄 (홈 화면·편집 대화상자). 목록은 고정 먼저, 그다음 최근에 연 순이다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupListItem {
    pub id: String,
    pub name: String,
    pub members: Vec<GroupMemberInfo>,
    pub pinned: bool,
    /// 마지막으로 연 시각 (epoch 밀리초, 연 적 없으면 0)
    #[specta(type = f64)]
    pub last_opened_at: i64,
}

impl From<mgit_core::GroupSummary> for GroupListItem {
    /// 코어 → wire
    fn from(s: mgit_core::GroupSummary) -> Self {
        let info = GroupInfo::from(s.group);
        GroupListItem {
            id: info.id,
            name: info.name,
            members: info.members,
            pinned: s.pinned,
            last_opened_at: s.last_opened_at,
        }
    }
}

/// 멤버 후보를 받아들이지 않은 이유
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GroupPathIssue {
    Missing,
    NotRepo,
    Duplicate,
    Nested,
}

impl From<PathIssue> for GroupPathIssue {
    /// 코어 enum 과 1:1
    fn from(i: PathIssue) -> Self {
        match i {
            PathIssue::Missing => GroupPathIssue::Missing,
            PathIssue::NotRepo => GroupPathIssue::NotRepo,
            PathIssue::Duplicate => GroupPathIssue::Duplicate,
            PathIssue::Nested => GroupPathIssue::Nested,
        }
    }
}

/// 경로 확인 한 줄. 고른 폴더 하나가 저장소 여럿으로 펼쳐지면 줄도 여럿이다 (`input` 이 같다)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupPathCheck {
    /// 사용자가 고른 경로
    pub input: String,
    /// 멤버가 될 저장소 최상위 (못 찾았으면 `input`)
    pub path: String,
    pub kind: Option<RepoKind>,
    /// 받아들이면 붙을 별칭
    pub alias: Option<String>,
    /// 거부 이유
    pub issue: Option<GroupPathIssue>,
}

impl From<mgit_core::GroupPathCheck> for GroupPathCheck {
    /// 경로를 문자열로
    fn from(c: mgit_core::GroupPathCheck) -> Self {
        GroupPathCheck {
            input: c.input.display().to_string(),
            path: c.path.display().to_string(),
            kind: c.kind.map(Into::into),
            alias: c.alias,
            issue: c.issue.map(Into::into),
        }
    }
}

/// 고치기의 멤버 하나 (별칭·경로)
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberEdit {
    pub alias: String,
    pub path: String,
}

/// 그룹 고치기. null 인 항목은 그대로 둔다. `members` 는 바뀐 뒤의 전체 목록이다 (추가·빼기·순서·위치 다시 지정)
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupUpdateDto {
    pub name: Option<String>,
    pub members: Option<Vec<GroupMemberEdit>>,
    pub pinned: Option<bool>,
}

impl From<GroupUpdateDto> for GroupUpdate {
    /// wire → 코어
    fn from(u: GroupUpdateDto) -> Self {
        GroupUpdate {
            name: u.name,
            members: u.members.map(|list| {
                list.into_iter()
                    .map(|m| GroupMember {
                        alias: m.alias,
                        path: PathBuf::from(m.path),
                    })
                    .collect()
            }),
            pinned: u.pinned,
        }
    }
}

/// 디스크를 보는 동기 코어 호출(멤버 상태 확인·폴더 스캔)을 블로킹 스레드에서 돌린다 — 깊은 폴더를 펼쳐도 비동기 작업자를
/// 막지 않는다. 스레드가 패닉하면 내부 오류다
async fn blocking<T: Send + 'static>(
    core: Arc<Core>,
    work: impl FnOnce(&Core) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || work(&core))
        .await
        .map_err(|e| IpcError::Internal {
            message: e.to_string(),
        })?
        .map_err(Into::into)
}

/// 그룹 목록 (고정 먼저, 그다음 최근에 연 순). 멤버 상태는 디스크로 다시 본다
#[tauri::command]
#[specta::specta]
pub async fn groups_list(state: State<'_, AppState>) -> Result<Vec<GroupListItem>, IpcError> {
    let core = Arc::clone(&state.core()?.core);
    let list = blocking(core, |core| core.groups_list()).await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 고른 경로들을 멤버 후보로 판정한다 (저장하지 않음). `group` 을 주면 그 그룹에 더하는 것으로, 없으면 새 그룹으로 본다.
/// 폴더는 그 아래 저장소들로 펼치고, 저장소 안의 폴더는 그 최상위로 고친다
#[tauri::command]
#[specta::specta]
pub async fn group_check_paths(
    state: State<'_, AppState>,
    group: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<GroupPathCheck>, IpcError> {
    let group = group.as_deref().map(GroupId::parse).transpose()?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let core = Arc::clone(&state.core()?.core);
    let list = blocking(core, move |core| {
        core.group_check_paths(group.as_ref(), &paths)
    })
    .await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 새 그룹을 만든다. 거부할 경로가 하나라도 있으면 만들지 않는다
#[tauri::command]
#[specta::specta]
pub async fn group_create(
    state: State<'_, AppState>,
    name: String,
    paths: Vec<String>,
) -> Result<GroupListItem, IpcError> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let core = Arc::clone(&state.core()?.core);
    Ok(blocking(core, move |core| core.group_create(&name, &paths))
        .await?
        .into())
}

/// 그룹을 고친다. 열린 그룹이면 그 세션에 그 자리에서 반영하고(탭을 닫지 않는다) 그 채널로 `folderRescanned` →
/// `groupChanged` 가 온다. 디스크를 보는 멤버 검사는 코어가 블로킹 스레드에서 한다
#[tauri::command]
#[specta::specta]
pub async fn group_update(
    state: State<'_, AppState>,
    id: String,
    update: GroupUpdateDto,
) -> Result<GroupListItem, IpcError> {
    let id = GroupId::parse(&id)?;
    let core = Arc::clone(&state.core()?.core);
    Ok(core.group_update(&id, update.into()).await?.into())
}

/// 그룹을 지운다. 열린 그룹은 지우지 않는다. 그 그룹의 폴더 설정(`folder:mgit-group:<id>`)도 지운다
#[tauri::command]
#[specta::specta]
pub async fn group_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    let id = GroupId::parse(&id)?;
    state.core()?.core.group_delete(&id)?;
    Ok(())
}

/// 그룹을 연다. 응답은 `open_folder` 와 같은 모양이고 `path` 가 `mgit-group:<id>`, `group` 에 멤버 상태가 있다. 이벤트는
/// 폴더 세션과 같고 재스캔 때 `groupChanged` 가 더 온다. 이미 열린 그룹이면 그 세션이다
#[tauri::command]
#[specta::specta]
pub async fn open_group(
    state: State<'_, AppState>,
    id: String,
    on_event: Channel<SessionEvent>,
) -> Result<FolderOpened, IpcError> {
    let id = GroupId::parse(&id)?;
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink(on_event));
    let opened = state.core()?.core.open_group(&id, sink).await?;
    Ok(opened.into())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 목록 한 줄의 wire 모양: 상태와 종류를 나눠 싣고(없는 멤버는 `kind: null`), 시각은 숫자다
    #[test]
    fn group_list_item_wire_shape() {
        let item = GroupListItem::from(mgit_core::GroupSummary {
            group: mgit_core::GroupView {
                id: GroupId::parse("g0123456789ab").unwrap(),
                name: "작업".into(),
                members: vec![
                    mgit_core::GroupMount {
                        alias: "api".into(),
                        path: "/a/api".into(),
                        state: MemberState::Present(mgit_core::RepoKind::Worktree),
                    },
                    mgit_core::GroupMount {
                        alias: "web".into(),
                        path: "/b/web".into(),
                        state: MemberState::Missing,
                    },
                ],
            },
            pinned: true,
            last_opened_at: 1_763_500_000_123,
        });
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            serde_json::json!({
                "id": "g0123456789ab",
                "name": "작업",
                "members": [
                    { "alias": "api", "path": "/a/api", "state": "present", "kind": "worktree" },
                    { "alias": "web", "path": "/b/web", "state": "missing", "kind": null }
                ],
                "pinned": true,
                "lastOpenedAt": 1_763_500_000_123_i64
            })
        );
    }

    /// 고치기 요청의 wire 모양: 빠진 항목은 null 로 오고 그대로 둔다
    #[test]
    fn group_update_request_reads_nulls_as_unchanged() {
        let dto: GroupUpdateDto = serde_json::from_value(serde_json::json!({
            "name": null,
            "members": [{ "alias": "api", "path": "/a/api" }],
            "pinned": null
        }))
        .unwrap();
        let update = GroupUpdate::from(dto);
        assert_eq!(update.name, None);
        assert_eq!(update.pinned, None);
        assert_eq!(
            update.members.unwrap(),
            vec![GroupMember {
                alias: "api".into(),
                path: "/a/api".into()
            }]
        );
    }
}
