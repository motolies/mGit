use mgit_model::{CommandLogRecord, InProgressOp, WorkTreeStatus};
use serde::{Deserialize, Serialize};

use crate::state::RepoRefs;

/// 열린 저장소 세션 식별자
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionId(pub u32);

/// 코어가 프런트로 push 하는 이벤트. 그래프 이벤트의 `generation` 이 현재 값보다 작으면 무시해야 한다
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CoreEvent {
    GraphLoadStarted {
        session: SessionId,
        generation: u64,
    },
    /// 첫 화면을 그릴 수 있을 만큼 행이 쌓였다
    GraphFirstChunk {
        session: SessionId,
        generation: u64,
        rows: u32,
    },
    GraphProgress {
        session: SessionId,
        generation: u64,
        rows: u32,
    },
    GraphLoadFinished {
        session: SessionId,
        generation: u64,
        rows: u32,
        lane_count: u16,
        elapsed_ms: u64,
        /// commit-graph 가 없고 커밋이 많아 생성을 제안할 만한지
        commit_graph_suggested: bool,
    },
    GraphLoadFailed {
        session: SessionId,
        generation: u64,
        message: String,
    },
    /// 그림자 재로드가 끝나 그래프가 새 세대로 교체됐다. 프런트는 캐시를 비우고 스크롤을 복원한다
    GraphReloaded {
        session: SessionId,
        generation: u64,
        rows: u32,
        lane_count: u16,
    },
    /// 재로드 실패. 기존 그래프는 그대로 유지된다
    GraphReloadFailed {
        session: SessionId,
        message: String,
    },
    /// 질의의 ref 가 저장소에서 사라져 코어가 질의를 좁혔다 (모두 사라지면 전체 범위).
    /// `query` 가 이제 세션의 질의이고 `dropped` 는 빠진 이름이다
    GraphQueryAdjusted {
        session: SessionId,
        query: mgit_model::GraphQuery,
        dropped: Vec<String>,
    },
    /// 작업 트리 상태나 진행 중 작업이 바뀌었다
    StatusChanged {
        session: SessionId,
        status: WorkTreeStatus,
        op: Option<InProgressOp>,
    },
    /// HEAD·브랜치·태그·스태시·워크트리 목록이 바뀌었다
    RefsChanged {
        session: SessionId,
        refs: RepoRefs,
    },
    /// 자동 fetch 로 원격 추적 ref 가 바뀌었다 (UX-09). 이름은 `origin/main` 꼴. 심볼릭 `<원격>/HEAD` 는 싣지 않는다
    AutoFetched {
        session: SessionId,
        refs: Vec<String>,
    },
    /// 장시간 명령 시작 (RM-05)
    OperationStarted {
        session: SessionId,
        op_id: u64,
        kind: String,
        label: String,
    },
    /// 진행률 (`--progress` 파싱)
    OperationProgress {
        session: SessionId,
        op_id: u64,
        phase: String,
        percent: Option<u8>,
        message: String,
    },
    /// 명령 출력 한 줄 (hook 출력 스트리밍 CHG-06)
    OperationOutput {
        session: SessionId,
        op_id: u64,
        stderr: bool,
        text: String,
    },
    /// 장시간 명령 종료
    OperationFinished {
        session: SessionId,
        op_id: u64,
        ok: bool,
        cancelled: bool,
        message: String,
        /// 취소 뒤 `index.lock` 이 남았는지
        lock_left: bool,
    },
    /// 폴더 세션의 하위 저장소 `.git` 이 바뀌었다 (MR-03). 프런트가 요약을 다시 읽는다.
    /// `refs` 가 참이면 HEAD·ref·packed-refs 가 바뀐 것이라 통합 타임라인(MR-12)도 다시 읽는다.
    /// `repo` 는 바뀐 저장소의 경로(폴더의 저장소 목록에 있는 그 경로)로, 프런트가 그 저장소만
    /// 다시 읽는 데 쓴다 (PF-02). 어느 저장소인지 모르면 `None` 이고 전부 다시 읽어야 한다
    FolderChanged {
        session: SessionId,
        refs: bool,
        repo: Option<std::path::PathBuf>,
    },
    /// 폴더 자동 fetch 한 바퀴의 결과 (RM-02). 원격 추적 ref 가 바뀌었거나 fetch 가 실패한 저장소만 싣고, 그런
    /// 저장소가 없으면 보내지 않는다. ref 가 바뀐 저장소마다 이 이벤트 앞에 `FolderChanged { refs: true }` 가 따로 간다
    FolderAutoFetched {
        session: SessionId,
        repos: Vec<crate::folder_auto_fetch::AutoFetchedRepo>,
    },
    /// 폴더 루트가 바뀌어(또는 수동으로) 하위 저장소를 다시 스캔했다 (MR-10)
    FolderRescanned {
        session: SessionId,
        repos: Vec<mgit_model::FoundRepo>,
    },
    /// git 명령 하나가 끝났다 (SF-01 명령 로그)
    CommandLogged {
        session: SessionId,
        record: CommandLogRecord,
    },
    /// 폴더 세션의 저장소에서 쓰기·네트워크 명령 하나가 끝났다 (W19 ② 폴더 콘솔, WS-12). 작업 디렉터리가 그 폴더의
    /// 저장소 목록(워크트리 포함) 안인 명령만 오고, 상태를 읽는 명령은 오지 않는다. `repo` 는 그 저장소가 속한 순번
    /// 묶음의 대표 경로(워크트리에서 돈 명령이면 원 저장소)이고, 실제 작업 디렉터리는 `record.cwd` 다. 같은 기록이
    /// 그 작업 트리의 저장소 세션에는 `CommandLogged` 로도 간다
    FolderCommandLogged {
        session: SessionId,
        repo: std::path::PathBuf,
        record: CommandLogRecord,
    },
    /// 그룹 세션의 멤버 상태가 바뀌었다 (MR-13, 재스캔 = 멤버 재확인). 같은 재스캔의 `FolderRescanned` 바로 뒤에 온다.
    /// 프런트는 이것으로 파일 경로 공간(별칭 → 멤버 루트)과 누락 멤버 표시를 바꾼다
    GroupChanged {
        session: SessionId,
        group: crate::group::GroupView,
    },
}

impl CoreEvent {
    /// 이벤트가 속한 세션
    pub fn session(&self) -> SessionId {
        match self {
            CoreEvent::GraphLoadStarted { session, .. }
            | CoreEvent::GraphFirstChunk { session, .. }
            | CoreEvent::GraphProgress { session, .. }
            | CoreEvent::GraphLoadFinished { session, .. }
            | CoreEvent::GraphLoadFailed { session, .. }
            | CoreEvent::GraphReloaded { session, .. }
            | CoreEvent::GraphReloadFailed { session, .. }
            | CoreEvent::GraphQueryAdjusted { session, .. }
            | CoreEvent::StatusChanged { session, .. }
            | CoreEvent::RefsChanged { session, .. }
            | CoreEvent::AutoFetched { session, .. }
            | CoreEvent::OperationStarted { session, .. }
            | CoreEvent::OperationProgress { session, .. }
            | CoreEvent::OperationOutput { session, .. }
            | CoreEvent::OperationFinished { session, .. }
            | CoreEvent::FolderChanged { session, .. }
            | CoreEvent::FolderAutoFetched { session, .. }
            | CoreEvent::FolderRescanned { session, .. }
            | CoreEvent::CommandLogged { session, .. }
            | CoreEvent::FolderCommandLogged { session, .. }
            | CoreEvent::GroupChanged { session, .. } => *session,
        }
    }
}

/// 이벤트를 받을 포트. 셸은 Tauri Channel 로, 테스트·벤치는 클로저로 구현한다
pub trait EventSink: Send + Sync + 'static {
    /// 이벤트를 전달한다. 실패해도 코어는 신경 쓰지 않는다
    fn emit(&self, event: CoreEvent);
}

impl<F> EventSink for F
where
    F: Fn(CoreEvent) + Send + Sync + 'static,
{
    fn emit(&self, event: CoreEvent) {
        self(event)
    }
}
