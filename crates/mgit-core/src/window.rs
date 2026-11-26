use mgit_graph::{WindowEdge, WindowSegment, WindowStub};
use mgit_model::{Oid, RefLabel};
use serde::Serialize;

/// `graph_window` 응답. `[start, start + rows.len())` 범위
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphWindow {
    pub generation: u64,
    pub start: u32,
    /// 지금까지 레이아웃에 배정된 전체 행 수 (스트리밍 중이면 늘어난다)
    pub total_rows: u32,
    /// 로드가 끝났는지 (성공·실패 모두 true)
    pub finished: bool,
    pub lane_count: u16,
    pub rows: Vec<GraphRow>,
    pub segments: Vec<WindowSegment>,
    pub edges: Vec<WindowEdge>,
    /// 접힌 긴 엣지의 끝 (범위 안 행)
    pub stubs: Vec<WindowStub>,
}

/// 그래프 한 행
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub row: u32,
    pub oid: Oid,
    pub parents: Vec<Oid>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
    pub lane: u16,
    pub color: u16,
    pub refs: Vec<RefLabel>,
    pub is_head: bool,
    /// HEAD(현재 브랜치)에서 닿는 커밋인지. 아니면 흐리게 그린다.
    /// HEAD 가 로그에 없거나 머지 제외라 알 수 없으면 전 행이 `true` 다
    pub in_head: bool,
    /// 통합 타임라인의 저장소 인덱스. 단일 저장소 창은 `None`
    pub repo: Option<u16>,
}
