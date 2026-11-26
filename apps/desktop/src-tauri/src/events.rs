//! 코어가 push 하는 세션 이벤트의 wire 형식과 Channel 싱크.
//!
//! `open_repo` 가 받은 `Channel<SessionEvent>` 로 보내므로 세션마다 채널이 하나다.
//! 전역 이벤트(`emit`)를 쓰지 않아 구독 누락 레이스와 추가 권한이 없다.

use mgit_core::{CoreEvent, EventSink};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::commands_group::GroupInfo;
use crate::commands_history::GraphQueryDto;
use crate::commands_repo::FoundRepo;
use crate::dto::{CommandLogRecord, InProgressOp, RepoRefs, WorkTreeStatus, narrow_u64};

/// 세션 이벤트. 그래프 이벤트의 `generation` 이 현재 값보다 작으면 프런트는 무시한다.
/// 변형 이름은 TS 쪽 `type` 태그(`graphLoadStarted` 등)와 1:1 이라 접두사를 유지한다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    GraphLoadStarted {
        session: u32,
        generation: u32,
    },
    GraphFirstChunk {
        session: u32,
        generation: u32,
        rows: u32,
    },
    GraphProgress {
        session: u32,
        generation: u32,
        rows: u32,
    },
    GraphLoadFinished {
        session: u32,
        generation: u32,
        rows: u32,
        lane_count: u16,
        elapsed_ms: u32,
        commit_graph_suggested: bool,
    },
    GraphLoadFailed {
        session: u32,
        generation: u32,
        message: String,
    },
    GraphReloaded {
        session: u32,
        generation: u32,
        rows: u32,
        lane_count: u16,
    },
    GraphReloadFailed {
        session: u32,
        message: String,
    },
    /// 질의의 ref 가 사라져 코어가 질의를 좁혔다. `query` 가 이제 세션의 질의다
    GraphQueryAdjusted {
        session: u32,
        query: GraphQueryDto,
        dropped: Vec<String>,
    },
    StatusChanged {
        session: u32,
        status: WorkTreeStatus,
        op: Option<InProgressOp>,
    },
    RefsChanged {
        session: u32,
        refs: RepoRefs,
    },
    /// 자동 fetch 로 바뀐 원격 추적 ref (UX-09)
    AutoFetched {
        session: u32,
        refs: Vec<String>,
    },
    /// 폴더 자동 fetch 한 바퀴의 결과 (RM-02). 폴더 세션 채널로만 온다. ref 가 바뀌었거나 실패한 저장소만 싣고, 그런
    /// 저장소가 없으면 오지 않는다. ref 가 바뀐 저장소마다 이 이벤트 앞에 `folderChanged`(`refs: true`)가 따로 온다
    FolderAutoFetched {
        session: u32,
        repos: Vec<AutoFetchedRepoDto>,
    },
    OperationStarted {
        session: u32,
        op_id: u32,
        kind: String,
        label: String,
    },
    OperationProgress {
        session: u32,
        op_id: u32,
        phase: String,
        percent: Option<u8>,
        message: String,
    },
    OperationOutput {
        session: u32,
        op_id: u32,
        stderr: bool,
        text: String,
    },
    OperationFinished {
        session: u32,
        op_id: u32,
        ok: bool,
        cancelled: bool,
        message: String,
        lock_left: bool,
    },
    CommandLogged {
        session: u32,
        record: CommandLogRecord,
    },
    /// 폴더 세션의 하위 저장소가 바뀌었다 (MR-03). `refs` 면 타임라인도 다시 읽는다.
    /// `repo` 는 바뀐 저장소의 경로다 (PF-02). 없으면 어느 저장소인지 모르는 것이라 전부 다시 읽는다
    FolderChanged {
        session: u32,
        refs: bool,
        repo: Option<String>,
    },
    /// 하위 저장소를 다시 스캔했다 (MR-10)
    FolderRescanned {
        session: u32,
        repos: Vec<FoundRepo>,
    },
    /// 폴더의 저장소에서 쓰기·네트워크 명령 하나가 끝났다 (W19 ② 폴더 콘솔). 폴더 세션 채널로만 온다. `repo` 는 폴더
    /// 목록의 대표 경로(워크트리에서 돈 명령이면 원 저장소 — 요약의 `path` 와 같은 꼴), 실제 작업 디렉터리는
    /// `record.cwd`. 상태를 읽는 명령은 오지 않는다
    FolderCommandLogged {
        session: u32,
        repo: String,
        record: CommandLogRecord,
    },
    /// 그룹 세션의 멤버 상태가 바뀌었다 (MR-13, 재스캔 = 멤버 재확인). 같은 재스캔의 `folderRescanned` 바로 뒤에 온다.
    /// 폴더 세션 채널로만, 그룹일 때만 온다
    GroupChanged {
        session: u32,
        group: GroupInfo,
    },
}

/// 폴더 자동 fetch 의 저장소 하나 (`folderAutoFetched`). `path` 는 폴더 목록의 대표 경로(요약의 `path` 와 같은 꼴),
/// `refs` 는 바뀐 원격 추적 ref(`origin/main` 꼴, 실패면 빈 목록), `error` 는 실패 메시지(URL 토큰을 가림)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoFetchedRepoDto {
    pub path: String,
    pub name: String,
    pub refs: Vec<String>,
    pub error: Option<String>,
}

impl From<mgit_core::AutoFetchedRepo> for AutoFetchedRepoDto {
    /// 경로를 문자열로 바꾼다
    fn from(r: mgit_core::AutoFetchedRepo) -> Self {
        AutoFetchedRepoDto {
            path: r.path.display().to_string(),
            name: r.name,
            refs: r.refs,
            error: r.error,
        }
    }
}

impl From<CoreEvent> for SessionEvent {
    /// 코어 이벤트를 wire 형식으로 바꾼다. u64 카운터는 u32 로 좁힌다
    fn from(event: CoreEvent) -> Self {
        match event {
            CoreEvent::GraphLoadStarted {
                session,
                generation,
            } => SessionEvent::GraphLoadStarted {
                session: session.0,
                generation: narrow_u64(generation),
            },
            CoreEvent::GraphFirstChunk {
                session,
                generation,
                rows,
            } => SessionEvent::GraphFirstChunk {
                session: session.0,
                generation: narrow_u64(generation),
                rows,
            },
            CoreEvent::GraphProgress {
                session,
                generation,
                rows,
            } => SessionEvent::GraphProgress {
                session: session.0,
                generation: narrow_u64(generation),
                rows,
            },
            CoreEvent::GraphLoadFinished {
                session,
                generation,
                rows,
                lane_count,
                elapsed_ms,
                commit_graph_suggested,
            } => SessionEvent::GraphLoadFinished {
                session: session.0,
                generation: narrow_u64(generation),
                rows,
                lane_count,
                elapsed_ms: narrow_u64(elapsed_ms),
                commit_graph_suggested,
            },
            CoreEvent::GraphLoadFailed {
                session,
                generation,
                message,
            } => SessionEvent::GraphLoadFailed {
                session: session.0,
                generation: narrow_u64(generation),
                message,
            },
            CoreEvent::GraphReloaded {
                session,
                generation,
                rows,
                lane_count,
            } => SessionEvent::GraphReloaded {
                session: session.0,
                generation: narrow_u64(generation),
                rows,
                lane_count,
            },
            CoreEvent::GraphReloadFailed { session, message } => SessionEvent::GraphReloadFailed {
                session: session.0,
                message,
            },
            CoreEvent::GraphQueryAdjusted {
                session,
                query,
                dropped,
            } => SessionEvent::GraphQueryAdjusted {
                session: session.0,
                query: query.into(),
                dropped,
            },
            CoreEvent::StatusChanged {
                session,
                status,
                op,
            } => SessionEvent::StatusChanged {
                session: session.0,
                status: status.into(),
                op: op.map(Into::into),
            },
            CoreEvent::RefsChanged { session, refs } => SessionEvent::RefsChanged {
                session: session.0,
                refs: refs.into(),
            },
            CoreEvent::AutoFetched { session, refs } => SessionEvent::AutoFetched {
                session: session.0,
                refs,
            },
            CoreEvent::FolderAutoFetched { session, repos } => SessionEvent::FolderAutoFetched {
                session: session.0,
                repos: repos.into_iter().map(Into::into).collect(),
            },
            CoreEvent::OperationStarted {
                session,
                op_id,
                kind,
                label,
            } => SessionEvent::OperationStarted {
                session: session.0,
                op_id: narrow_u64(op_id),
                kind,
                label,
            },
            CoreEvent::OperationProgress {
                session,
                op_id,
                phase,
                percent,
                message,
            } => SessionEvent::OperationProgress {
                session: session.0,
                op_id: narrow_u64(op_id),
                phase,
                percent,
                message,
            },
            CoreEvent::OperationOutput {
                session,
                op_id,
                stderr,
                text,
            } => SessionEvent::OperationOutput {
                session: session.0,
                op_id: narrow_u64(op_id),
                stderr,
                text,
            },
            CoreEvent::OperationFinished {
                session,
                op_id,
                ok,
                cancelled,
                message,
                lock_left,
            } => SessionEvent::OperationFinished {
                session: session.0,
                op_id: narrow_u64(op_id),
                ok,
                cancelled,
                message,
                lock_left,
            },
            CoreEvent::CommandLogged { session, record } => SessionEvent::CommandLogged {
                session: session.0,
                record: record.into(),
            },
            CoreEvent::FolderChanged {
                session,
                refs,
                repo,
            } => SessionEvent::FolderChanged {
                session: session.0,
                refs,
                repo: repo.map(|p| p.display().to_string()),
            },
            CoreEvent::FolderRescanned { session, repos } => SessionEvent::FolderRescanned {
                session: session.0,
                repos: repos.into_iter().map(Into::into).collect(),
            },
            CoreEvent::FolderCommandLogged {
                session,
                repo,
                record,
            } => SessionEvent::FolderCommandLogged {
                session: session.0,
                repo: repo.display().to_string(),
                record: record.into(),
            },
            CoreEvent::GroupChanged { session, group } => SessionEvent::GroupChanged {
                session: session.0,
                group: group.into(),
            },
        }
    }
}

/// Tauri Channel 로 이벤트를 보내는 싱크. 코어의 `EventSink` 포트 구현체다
pub struct ChannelSink(pub Channel<SessionEvent>);

impl ChannelSink {
    /// 이벤트를 WebView 로 보낸다. 창이 닫혀 실패해도 무시한다
    pub fn send(&self, event: SessionEvent) {
        let _ = self.0.send(event);
    }
}

impl EventSink for ChannelSink {
    /// 코어 이벤트를 wire 형식으로 바꿔 채널로 보낸다
    fn emit(&self, event: CoreEvent) {
        self.send(event.into());
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 폴더 자동 fetch 이벤트의 wire 모양: `{type:'folderAutoFetched', session, repos:[{path,name,refs,error}]}`. 실패가 없으면
    /// `error` 는 null 로 나간다
    #[test]
    fn folder_auto_fetched_wire_shape() {
        let event = SessionEvent::from(CoreEvent::FolderAutoFetched {
            session: mgit_core::SessionId(3),
            repos: vec![
                mgit_core::AutoFetchedRepo {
                    path: "/f/api".into(),
                    name: "api".into(),
                    refs: vec!["origin/main".into()],
                    error: None,
                },
                mgit_core::AutoFetchedRepo {
                    path: "/f/web".into(),
                    name: "web".into(),
                    refs: Vec::new(),
                    error: Some("fatal: could not read Username".into()),
                },
            ],
        });
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "type": "folderAutoFetched",
                "session": 3,
                "repos": [
                    { "path": "/f/api", "name": "api", "refs": ["origin/main"], "error": null },
                    {
                        "path": "/f/web",
                        "name": "web",
                        "refs": [],
                        "error": "fatal: could not read Username"
                    }
                ]
            })
        );
    }

    /// 폴더 콘솔 이벤트의 wire 모양 (W19 ②): `{type:'folderCommandLogged', session, repo, record}`. 기록은
    /// 저장소 세션의 `commandLogged` 와 같은 DTO(카멜 표기, 숫자 시각)다
    #[test]
    fn folder_command_logged_wire_shape() {
        let record = mgit_core::CommandLogRecord {
            id: 41,
            args: vec!["push".into()],
            cwd: "/f/web-wt".into(),
            started_at: 1_763_500_000_123,
            elapsed_ms: 912,
            status: Some(1),
            stderr_tail: " ! [rejected] main -> main (fetch first)".into(),
            is_write: true,
            cancelled: false,
        };
        let event = SessionEvent::from(CoreEvent::FolderCommandLogged {
            session: mgit_core::SessionId(7),
            repo: "/f/web".into(),
            record,
        });
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "type": "folderCommandLogged",
                "session": 7,
                "repo": "/f/web",
                "record": {
                    "id": 41,
                    "args": ["push"],
                    "cwd": "/f/web-wt",
                    "startedAt": 1_763_500_000_123_i64,
                    "elapsedMs": 912,
                    "status": 1,
                    "stderrTail": " ! [rejected] main -> main (fetch first)",
                    "isWrite": true,
                    "cancelled": false
                }
            })
        );
    }
}
