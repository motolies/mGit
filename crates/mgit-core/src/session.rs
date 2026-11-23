use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use mgit_graph::GraphLayout;
use mgit_model::{ChangeSet, RepoInfo, WatchHandle};
use serde::Serialize;
use tokio::task::JoinHandle;

use crate::commit_table::CommitTable;
use crate::events::{CoreEvent, EventSink, SessionId};
use crate::ref_index::RefIndex;
use crate::state::RepoState;

/// 저장소 세션 프로필 (계획 5.1절). 저장소 탭은 `Full`, 폴더 화면이 쓰기·상태 기능을 위해 조용히 여는
/// 세션은 `Light` 다. `Light` 는 커밋 그래프를 읽지 않고 자동 fetch 를 돌리지 않으며, status 는
/// 저장소 설정의 명령(fsmonitor)을 실행하지 않는다. `Light` → `Full` 승격만 있고 내리는 승격은 없다
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionProfile {
    Full,
    Light,
}

/// 세션 수명 상태. 프로필·잡은 폴더·닫힘을 이 하나로 정해 승격·닫기·해제·상한 집계가 서로 엇갈리지
/// 않게 한다. 잠금 규칙: `life` → (`reload`·`load_task`·`auto_fetch`·`sessions` 쓰기) 순서만 허용하고,
/// `sessions` 잠금을 쥔 채 `life` 를 잡지 않으며, 두 세션의 `life` 를 함께 쥐지 않고, 쥔 채 await 하지 않는다
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Life {
    /// 가벼운 세션. `holders` 는 이 세션을 연(잡고 있는) 폴더 세션들이다 (비지 않는다)
    Light { holders: Vec<SessionId> },
    /// 저장소 탭의 세션 (처음부터 탭으로 열었거나 승격됨). 폴더의 잡음·상한 집계와 무관하다
    Full,
    /// 닫힘. 세션 목록에서 빠지는 것과 같은 잠금 구간에서 바뀌므로 정리는 한 번만 일어난다
    Closed,
}

/// 세션 이벤트를 보낼 곳. 승격하면 탭이 넘긴 새 채널로 바꾼다. `run_load`·`LineEventSink` 처럼 sink 를
/// 복제해 쥐고 있는 곳도 이 래퍼를 쥐므로 바꾼 뒤의 이벤트는 모두 새 채널로 간다
struct SwitchSink(RwLock<Arc<dyn EventSink>>);

impl EventSink for SwitchSink {
    /// 지금 대상에게 전달한다
    fn emit(&self, event: CoreEvent) {
        let target = Arc::clone(&self.0.read().unwrap_or_else(PoisonError::into_inner));
        target.emit(event);
    }
}

/// 그래프 로드 상태
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadState {
    Loading,
    Finished,
    Failed(String),
}

/// 세션이 소유하는 그래프 데이터. 로드 태스크가 쓰고 `graph_window` 가 읽는다
#[derive(Debug)]
pub struct GraphData {
    pub layout: GraphLayout,
    pub table: CommitTable,
    pub state: LoadState,
    /// 로드 세대. 재로드마다 1씩 증가하며 이벤트·윈도에 실린다
    pub generation: u64,
}

impl GraphData {
    /// 빈 그래프
    pub fn empty(generation: u64) -> Self {
        GraphData {
            layout: GraphLayout::new(),
            table: CommitTable::new(),
            state: LoadState::Loading,
            generation,
        }
    }
}

/// 그림자 재로드 상태
#[derive(Debug, Default)]
pub struct ReloadState {
    /// 재로드 태스크가 돌고 있음
    pub running: bool,
    /// 돌고 있는 동안 또 요청이 와서 끝나면 한 번 더 돌아야 함
    pub pending: bool,
}

/// 열린 저장소 하나
pub struct RepoSession {
    pub id: SessionId,
    /// 열 때 판별한 정보. `head` 는 열 당시 값이고 이후는 `state().refs.head` 를 본다
    pub info: RepoInfo,
    /// 이 세션의 이벤트 싱크 (`switch` 와 같은 객체. 승격 때 대상만 바뀐다)
    pub sink: Arc<dyn EventSink>,
    switch: Arc<SwitchSink>,
    /// 프로필·잡은 폴더·닫힘 (`Life` 의 잠금 규칙을 따른다)
    life: Mutex<Life>,
    graph: Arc<RwLock<GraphData>>,
    state: RwLock<RepoState>,
    ref_index: RwLock<RefIndex>,
    load_task: Mutex<Option<JoinHandle<()>>>,
    /// 자동 fetch 태스크 (세션 닫을 때 중단)
    auto_fetch: Mutex<Option<JoinHandle<()>>>,
    watch: Mutex<Option<Box<dyn WatchHandle>>>,
    /// 쓰기 명령이 도는 동안 감시 이벤트를 억제하는 깊이
    suppress: AtomicU32,
    /// 억제 중 쌓인 변경
    pending_changes: Mutex<ChangeSet>,
    /// 그림자 재로드 상태
    pub reload: Mutex<ReloadState>,
    /// 세션별 재조회 직렬화
    pub refresh_lock: tokio::sync::Mutex<()>,
    /// 그래프 질의 (GRAPH-08 필터·경로 범위)
    pub graph_query: RwLock<mgit_model::GraphQuery>,
    /// 레이아웃 설정 (고정 레인·ref 색·긴 엣지 접기)
    pub layout_prefs: RwLock<mgit_model::GraphLayoutPrefs>,
    /// undo/redo 스택 (SF-03)
    pub undo: Mutex<crate::safety::UndoStack>,
}

impl std::fmt::Debug for RepoSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RepoSession")
            .field("id", &self.id)
            .field("work_tree", &self.info.work_tree)
            .finish()
    }
}

impl RepoSession {
    /// 빈 그래프로 세션을 만든다. 수명 상태(프로필·잡은 폴더)를 함께 정한다 — 세션 목록에 넣기 전에
    /// 프로필이 정해져 있어야 주인 없이 보이는 순간이 없다
    pub(crate) fn with_life(
        id: SessionId,
        info: RepoInfo,
        state: RepoState,
        sink: Arc<dyn EventSink>,
        life: Life,
    ) -> Self {
        let ref_index = RefIndex::new(state.refs.labels.clone());
        let switch = Arc::new(SwitchSink(RwLock::new(sink)));
        RepoSession {
            id,
            info,
            sink: Arc::clone(&switch) as Arc<dyn EventSink>,
            switch,
            life: Mutex::new(life),
            graph: Arc::new(RwLock::new(GraphData::empty(1))),
            state: RwLock::new(state),
            ref_index: RwLock::new(ref_index),
            load_task: Mutex::new(None),
            auto_fetch: Mutex::new(None),
            watch: Mutex::new(None),
            suppress: AtomicU32::new(0),
            pending_changes: Mutex::new(ChangeSet::default()),
            reload: Mutex::new(ReloadState::default()),
            refresh_lock: tokio::sync::Mutex::new(()),
            graph_query: RwLock::new(mgit_model::GraphQuery::default()),
            layout_prefs: RwLock::new(mgit_model::GraphLayoutPrefs::default()),
            undo: Mutex::new(crate::safety::UndoStack::default()),
        }
    }

    /// 수명 상태 잠금. 잠금 규칙은 `Life` 주석
    pub(crate) fn life(&self) -> MutexGuard<'_, Life> {
        self.life.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 지금 프로필. 닫힌 세션은 `None`
    pub fn profile(&self) -> Option<SessionProfile> {
        match &*self.life() {
            Life::Light { .. } => Some(SessionProfile::Light),
            Life::Full => Some(SessionProfile::Full),
            Life::Closed => None,
        }
    }

    /// 가벼운 세션인지 (그래프 API 거부, fsmonitor 를 끈 status)
    pub fn is_light(&self) -> bool {
        matches!(*self.life(), Life::Light { .. })
    }

    /// 이벤트 대상을 바꾼다 (승격). `life` 잠금 구간 안에서 부른다
    pub(crate) fn switch_sink(&self, sink: Arc<dyn EventSink>) {
        *self
            .switch
            .0
            .write()
            .unwrap_or_else(PoisonError::into_inner) = sink;
    }

    /// 그래프 읽기 락. poison 은 무시한다 (데이터는 배치 단위로 일관됨)
    pub fn graph(&self) -> RwLockReadGuard<'_, GraphData> {
        self.graph.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// 그래프 쓰기 락
    pub fn graph_mut(&self) -> RwLockWriteGuard<'_, GraphData> {
        self.graph.write().unwrap_or_else(PoisonError::into_inner)
    }

    /// 로드 태스크가 쓰는 그래프 핸들 (초기 로드는 세션 그래프 자체를 채운다)
    pub fn graph_handle(&self) -> Arc<RwLock<GraphData>> {
        Arc::clone(&self.graph)
    }

    /// 상태 스냅샷 읽기
    pub fn state(&self) -> RwLockReadGuard<'_, RepoState> {
        self.state.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// 상태 스냅샷 쓰기
    pub fn state_mut(&self) -> RwLockWriteGuard<'_, RepoState> {
        self.state.write().unwrap_or_else(PoisonError::into_inner)
    }

    /// 커밋 → 라벨 색인
    pub fn ref_index(&self) -> RwLockReadGuard<'_, RefIndex> {
        self.ref_index
            .read()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 라벨이 바뀌면 색인을 다시 만든다
    pub fn set_ref_index(&self, index: RefIndex) {
        *self
            .ref_index
            .write()
            .unwrap_or_else(PoisonError::into_inner) = index;
    }

    /// 로드 태스크 핸들을 보관한다
    pub fn set_load_task(&self, handle: JoinHandle<()>) {
        let mut slot = self
            .load_task
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(old) = slot.replace(handle) {
            old.abort();
        }
    }

    /// 자동 fetch 태스크를 보관한다
    pub fn set_auto_fetch(&self, handle: JoinHandle<()>) {
        let mut slot = self
            .auto_fetch
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(old) = slot.replace(handle) {
            old.abort();
        }
    }

    /// 자동 fetch 를 멈춘다
    pub fn stop_auto_fetch(&self) {
        if let Some(h) = self
            .auto_fetch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            h.abort();
        }
    }

    /// 로드 태스크를 중단한다. 스트림이 드롭되어 git 프로세스가 죽는다
    pub fn abort_load(&self) {
        let mut slot = self
            .load_task
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(handle) = slot.take() {
            handle.abort();
        }
    }

    /// 감시 핸들을 보관한다
    pub fn set_watch(&self, handle: Box<dyn WatchHandle>) {
        *self.watch.lock().unwrap_or_else(PoisonError::into_inner) = Some(handle);
    }

    /// 감시를 멈춘다
    pub fn stop_watch(&self) {
        self.watch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    /// 감시 억제 시작 (쓰기 명령 중)
    pub fn suppress_watch(&self) {
        self.suppress.fetch_add(1, Ordering::SeqCst);
    }

    /// 감시 억제 종료. 억제 중 쌓인 변경을 돌려준다
    pub fn release_watch(&self) -> ChangeSet {
        self.suppress.fetch_sub(1, Ordering::SeqCst);
        std::mem::take(
            &mut *self
                .pending_changes
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// 억제 중이면 변경을 쌓고 `true` 를 돌려준다
    pub fn defer_if_suppressed(&self, changes: &ChangeSet) -> bool {
        if self.suppress.load(Ordering::SeqCst) == 0 {
            return false;
        }
        self.pending_changes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .merge(changes);
        true
    }
}
