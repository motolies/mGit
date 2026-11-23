use std::collections::HashMap;
use std::hash::Hash;

use mgit_model::Oid;
use serde::Serialize;

/// 범위 조회 인덱스의 청크 크기(행)
pub const CHUNK_ROWS: u32 = 256;
/// 레인 색 팔레트 크기. 프런트의 `--graph-lane-0..9` 와 맞춘다
pub const PALETTE_SIZE: u8 = 10;
/// 표시 레인 상한. 넘는 레인은 접는다 (이번 반복은 상수만 둔다)
pub const MAX_VISIBLE_LANES: u16 = 64;

/// 레이아웃 옵션. 모두 꺼진 `Default` 면 기존 동작과 같다.
/// `K` 는 커밋 키(단일 저장소는 `Oid`, 통합 타임라인은 `(저장소, Oid)`)
#[derive(Clone, Debug)]
pub struct LayoutOptions<K = Oid> {
    /// GRAPH-13: 이 커밋과 그 첫 부모 체인을 레인 0 에 고정한다
    pub pin: Option<K>,
    /// ref 팁 키 → 팔레트 색. 코어가 브랜치 이름 해시(`branch_color`)로 만든다
    pub ref_colors: HashMap<K, u8>,
    /// `Some(N)`: 부모가 N행보다 아래면 레인을 잡지 않고 스텁(`Stub`)으로 접는다
    pub collapse_long_edges: Option<u32>,
    /// 새 레인의 기본 색. `ref_colors` 에 없을 때 쓰고, 없으면 팔레트 순환
    pub lane_color: Option<fn(&K) -> u8>,
}

impl<K> Default for LayoutOptions<K> {
    /// 모두 꺼짐
    fn default() -> Self {
        LayoutOptions {
            pin: None,
            ref_colors: HashMap::new(),
            collapse_long_edges: None,
            lane_color: None,
        }
    }
}

impl<K: Eq + Hash> LayoutOptions<K> {
    /// 기능이 하나라도 켜져 있는지
    pub fn is_default(&self) -> bool {
        self.pin.is_none()
            && self.ref_colors.is_empty()
            && self.collapse_long_edges.is_none()
            && self.lane_color.is_none()
    }
}

/// 브랜치 이름으로 결정적인 팔레트 색 (FNV-1a 32). 같은 이름은 어느 저장소에서나 같은 색이다.
/// std 의 `Hash` 는 실행마다 시드가 달라 쓰지 않는다
pub fn branch_color(name: &str) -> u8 {
    let mut h: u32 = 0x811c_9dc5;
    for b in name.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    (h % u32::from(PALETTE_SIZE)) as u8
}

/// 행마다 노드가 놓이는 레인과 색 (4B)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowLane {
    pub lane: u16,
    pub color: u8,
}

/// 닫힌 레인 구간. `start..=end` 행에서 레인 `lane` 을 세로선이 지나간다
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub lane: u16,
    pub start: u32,
    /// inclusive
    pub end: u32,
    pub color: u8,
}

/// 인접 행 대각선. 항상 `top_row` → `top_row + 1`.
/// `top_lane == bottom_lane` 이면 같은 레인에서 색이 바뀌는 이음선이다 (ref 팁 색 전환)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub top_row: u32,
    pub top_lane: u16,
    pub bottom_lane: u16,
    pub color: u8,
}

/// 접힌 긴 엣지의 방향
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StubDir {
    /// 자식 행: 부모가 멀리 아래에 있다
    Down,
    /// 부모 행: 자식이 멀리 위에 있다
    Up,
}

/// 접힌 긴 엣지의 끝. `(row, lane)` 은 항상 그 행의 노드 셀
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stub<K = Oid> {
    pub row: u32,
    pub lane: u16,
    pub dir: StubDir,
    /// Down: 부모 행 (아직 안 왔거나 스트림 밖이면 `None`). Up: 자식 행 (항상 `Some`)
    pub other_row: Option<u32>,
    /// 상대 커밋 (Down 은 부모, Up 은 자식)
    pub other: K,
    pub color: u8,
}

/// 윈도용 스텁 (상대 키 제외)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStub {
    pub row: u32,
    pub lane: u16,
    pub dir: StubDir,
    pub other_row: Option<u32>,
    pub color: u8,
}

/// 스트리밍 중 아직 닫히지 않은 레인 (테스트·브루트포스 비교용)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenLane {
    pub lane: u16,
    pub seg_start: u32,
    pub color: u8,
}

/// 윈도에 클립된 구간. `continues_up/down` 은 윈도 밖으로 이어지는지
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSegment {
    pub lane: u16,
    pub from_row: u32,
    /// inclusive
    pub to_row: u32,
    pub color: u8,
    pub continues_up: bool,
    pub continues_down: bool,
}

/// 윈도와 겹치는 엣지. `top_row ∈ [start-1, start+count)`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEdge {
    pub top_row: u32,
    pub top_lane: u16,
    pub bottom_lane: u16,
    pub color: u8,
}

/// `[start, start+rows.len())` 범위의 레이아웃
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutWindow {
    pub start: u32,
    pub rows: Vec<RowLane>,
    pub segments: Vec<WindowSegment>,
    pub edges: Vec<WindowEdge>,
    /// 범위 안 행의 스텁 (`row ∈ [start, start+rows.len())`)
    pub stubs: Vec<WindowStub>,
    pub lane_count: u16,
}
