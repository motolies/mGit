//! Tauri 커맨드. 인자 검증과 DTO 변환만 하는 얇은 어댑터다. 실제 동작은 `mgit_core::Core`.

use std::path::Path;
use std::sync::Arc;

use mgit_core::{EventSink, Oid, SessionId};
use tauri::State;
use tauri::ipc::Channel;

use crate::dto::{CommandLogRecord, GitVersionInfo, GraphWindow, RepoOpened, RepoState};
use crate::error::IpcError;
use crate::events::{ChannelSink, SessionEvent};
use crate::state::AppState;

/// 시스템 git 의 버전과 실제 경로를 돌려준다
#[tauri::command]
#[specta::specta]
pub async fn git_version(state: State<'_, AppState>) -> Result<GitVersionInfo, IpcError> {
    let handle = state.core()?;
    Ok(GitVersionInfo {
        version: handle.core.git_version().short(),
        path: handle.git_path.clone(),
    })
}

/// 저장소를 열고 세션을 만든다. 그래프 로드 진행·상태 변경은 `on_event` 채널로 push 한다.
/// 로드 태스크는 즉시 시작되므로 이 커맨드가 돌아오기 전에 이벤트가 먼저 도착할 수 있다
#[tauri::command]
#[specta::specta]
pub async fn open_repo(
    state: State<'_, AppState>,
    path: String,
    on_event: Channel<SessionEvent>,
) -> Result<RepoOpened, IpcError> {
    let handle = state.core()?;
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink(on_event));
    let opened = handle.core.open_repo(Path::new(&path), sink).await?;
    Ok(opened.into())
}

/// 보이는 범위의 그래프 행·구간·엣지를 돌려준다. `count` 는 코어가 상한으로 자른다
#[tauri::command]
#[specta::specta]
pub async fn graph_window(
    state: State<'_, AppState>,
    session: u32,
    start: u32,
    count: u32,
) -> Result<GraphWindow, IpcError> {
    let handle = state.core()?;
    let window = handle.core.graph_window(SessionId(session), start, count)?;
    Ok(window.into())
}

/// 커밋의 현재 행 번호. 그래프에 없으면 `None` (재로드 뒤 스크롤 복원에 쓴다)
#[tauri::command]
#[specta::specta]
pub async fn find_row(
    state: State<'_, AppState>,
    session: u32,
    oid: String,
) -> Result<Option<u32>, IpcError> {
    let handle = state.core()?;
    let oid = Oid::from_hex(oid.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })?;
    Ok(handle.core.find_row(SessionId(session), &oid)?)
}

/// 세션의 상태 스냅샷 (ref·작업 트리 상태·진행 중 작업)
#[tauri::command]
#[specta::specta]
pub async fn repo_state(state: State<'_, AppState>, session: u32) -> Result<RepoState, IpcError> {
    let handle = state.core()?;
    Ok(handle.core.repo_state(SessionId(session))?.into())
}

/// 사용자 새로고침: 상태·ref 를 다시 읽고 바뀐 것만 이벤트로 보낸다
#[tauri::command]
#[specta::specta]
pub async fn refresh_repo(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    let handle = state.core()?;
    handle.core.refresh(SessionId(session)).await?;
    Ok(())
}

/// 그래프를 강제로 다시 로드한다 (`GraphReloaded` 로 완료 통지)
#[tauri::command]
#[specta::specta]
pub async fn reload_graph(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    let handle = state.core()?;
    handle.core.reload_graph(SessionId(session))?;
    Ok(())
}

/// 진행 중인 장시간 명령을 취소한다. 모르는 id 면 `false`
#[tauri::command]
#[specta::specta]
pub async fn cancel_operation(state: State<'_, AppState>, op_id: u32) -> Result<bool, IpcError> {
    let handle = state.core()?;
    Ok(handle.core.cancel_operation(op_id as u64))
}

/// 최근 명령 로그 (최신 순)
#[tauri::command]
#[specta::specta]
pub async fn command_log_recent(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<CommandLogRecord>, IpcError> {
    let handle = state.core()?;
    Ok(handle
        .core
        .command_log_recent(limit as usize)
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 세션을 닫는다. 진행 중인 로드는 중단된다
#[tauri::command]
#[specta::specta]
pub async fn close_repo(state: State<'_, AppState>, session: u32) -> Result<(), IpcError> {
    state.core()?.core.close_repo(SessionId(session))?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    //! 어댑터 경로 통합 테스트: 실제 git 으로 임시 저장소를 열어 DTO 까지 직렬화한다.
    //! Tauri IPC 전송만 빼고 커맨드가 하는 일을 그대로 밟는다.

    use std::sync::{Arc, Mutex};

    use mgit_core::{CoreEvent, EventSink, SessionId};

    use super::*;

    /// 이벤트를 벡터에 모으는 테스트용 싱크
    struct VecSink(Mutex<Vec<SessionEvent>>);

    impl EventSink for VecSink {
        fn emit(&self, event: CoreEvent) {
            self.0.lock().unwrap().push(event.into());
        }
    }

    /// 커밋 3개짜리 임시 저장소를 열어 창을 받고, 이벤트·DTO 가 camelCase JSON 으로 직렬화되는지 본다.
    /// (이 저장소 자신을 열면 얕은 clone·squash 히스토리에서 커밋 수가 달라져 결과가 흔들린다)
    #[test]
    fn open_repo_and_serialize_window() {
        tauri::async_runtime::block_on(async {
            let state = AppState::build(None).await;
            let handle = state.core().expect("시스템 git 이 있어야 한다");

            let version = handle.core.git_version().short();
            assert!(version.starts_with("2."), "버전 문자열: {version}");

            let repo = mgit_testkit::build(mgit_testkit::Scenario::Linear(3));
            let sink = Arc::new(VecSink(Mutex::new(Vec::new())));
            let opened: RepoOpened = handle
                .core
                .open_repo(repo.path(), sink.clone())
                .await
                .expect("저장소 열기")
                .into();
            assert!(!opened.already_open);
            assert!(!opened.info.work_tree.is_empty());
            let state_json = serde_json::to_value(&opened.state).unwrap();
            assert!(state_json["status"]["summary"]["staged"].is_number());
            assert!(state_json["refs"]["labels"].is_array());

            // 로드 완료까지 기다린다 (작은 저장소라 금방 끝난다)
            let session = SessionId(opened.session);
            for _ in 0..200 {
                if let Ok(mgit_core::LoadState::Finished) = handle.core.load_state(session) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }

            let window: GraphWindow = handle
                .core
                .graph_window(session, 0, 100)
                .expect("graph_window")
                .into();
            assert!(window.finished);
            assert_eq!(window.total_rows, 3, "커밋 수");
            assert_eq!(window.rows.len() as u32, window.total_rows.min(100));

            let json = serde_json::to_value(&window).unwrap();
            assert!(json["totalRows"].is_number());
            assert!(json["rows"][0]["authorTime"].is_number());
            assert_eq!(json["rows"][0]["oid"].as_str().unwrap().len(), 40);

            let events = sink.0.lock().unwrap();
            let finished = events
                .iter()
                .any(|e| matches!(e, SessionEvent::GraphLoadFinished { .. }));
            assert!(finished, "완료 이벤트가 와야 한다: {events:?}");
            let event_json = serde_json::to_value(&events[0]).unwrap();
            assert_eq!(event_json["type"], "graphLoadStarted");
            assert!(
                events
                    .iter()
                    .any(|e| matches!(e, SessionEvent::CommandLogged { .. }))
            );

            handle.core.close_repo(session).unwrap();
            let err: IpcError = handle.core.graph_window(session, 0, 1).unwrap_err().into();
            assert!(matches!(err, IpcError::SessionNotFound { .. }));
        });
    }

    /// 가벼운 세션 (W13): 폴더에서 연 응답은 `RepoOpened` 와 같은 모양에 `profile: "light"`, 그래프 API 는
    /// `graphUnavailable`, 해제 응답은 `{released, profile}`. 탭 열기 응답에도 `profile`·`promoted` 가 실린다
    #[test]
    fn light_session_dtos_serialize() {
        tauri::async_runtime::block_on(async {
            let state = AppState::build(None).await;
            let handle = state.core().expect("시스템 git 이 있어야 한다");
            // 임시 폴더 안에 빈 저장소 하나 (git init 만)
            let root = std::env::temp_dir().join(format!("mgit-light-dto-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("r")).unwrap();
            let root = root.canonicalize().unwrap();
            let status = std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(root.join("r"))
                .status()
                .unwrap();
            assert!(status.success());

            let sink = Arc::new(VecSink(Mutex::new(Vec::new())));
            let folder = handle.core.open_folder(&root, sink.clone()).await.unwrap();
            let opened: RepoOpened = handle
                .core
                .folder_open_repo_session(folder.session, &root.join("r"), sink.clone())
                .await
                .unwrap()
                .into();
            let json = serde_json::to_value(&opened).unwrap();
            assert_eq!(json["profile"], "light");
            assert_eq!(json["promoted"], false);
            assert_eq!(json["alreadyOpen"], false);
            assert!(json["state"]["status"]["summary"]["staged"].is_number());

            let err: IpcError = handle
                .core
                .graph_window(SessionId(opened.session), 0, 1)
                .unwrap_err()
                .into();
            let err_json = serde_json::to_value(&err).unwrap();
            assert_eq!(err_json["kind"], "graphUnavailable");

            let released: crate::dto::RepoSessionRelease = handle
                .core
                .folder_release_repo_session(folder.session, SessionId(opened.session))
                .into();
            assert_eq!(
                serde_json::to_value(released).unwrap(),
                serde_json::json!({ "released": true, "profile": null })
            );

            let tab: RepoOpened = handle
                .core
                .open_repo(&root.join("r"), sink.clone())
                .await
                .unwrap()
                .into();
            let tab_json = serde_json::to_value(&tab).unwrap();
            assert_eq!(tab_json["profile"], "full");
            assert_eq!(tab_json["promoted"], false);
            handle.core.close_repo(SessionId(tab.session)).unwrap();
            handle.core.close_folder(folder.session).unwrap();
            let _ = std::fs::remove_dir_all(&root);
        });
    }
}
