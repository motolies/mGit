//! 커밋 그래프 레인 배정과 범위 조회.
//!
//! 자식이 먼저 오는 순서(`--topo-order`·`--date-order`)로 들어오는 커밋을 받는 즉시 레인을 배정하고,
//! 결과를 "레인 구간(레인, 시작 행, 끝 행, 색)" 과 인접 행 사이의 대각선 엣지로 저장한다.
//! IO가 없는 순수 로직이라 단위 테스트와 속성 기반 테스트로 검증한다.
//!
//! 조기 합류(join-early) 규칙: 어떤 부모를 기다리는 레인은 항상 최대 1개다.
//! 그래서 여러 행을 건너는 연결은 세로 구간 + 인접 행 대각선 하나로 분해되고,
//! 프런트는 윈도 밖 정보 없이 보이는 행만 그릴 수 있다.
//!
//! 옵션(`LayoutOptions`):
//! - ref 팁 색: 팁 커밋이 기다리던 레인에 도착하면 그 행부터 레인 색을 바꾼다
//!   (이전 구간을 `r-1` 에서 닫고 같은 레인 이음선 엣지로 잇는다).
//! - 레인 0 고정(GRAPH-13): 레인 0 을 고정 커밋을 기다리는 가상 레인으로 심어, 고정 커밋과 그 첫 부모 체인이
//!   항상 레인 0 에 놓인다. 고정 체인은 다른 레인으로 합류하지 않고(steal) 거리와 무관하게 이어진다.
//! - 긴 엣지 접기: N행 선행 버퍼로 부모가 N행보다 아래인지 알아내, 멀면 레인을 잡지 않고
//!   자식 행에 Down 스텁·부모 행에 Up 스텁만 남긴다. `len()` 은 배정된 행 수다.

pub mod check;
mod layout;
mod types;

pub use layout::GraphLayout;
pub use types::{
    CHUNK_ROWS, Edge, LayoutOptions, LayoutWindow, MAX_VISIBLE_LANES, OpenLane, PALETTE_SIZE,
    RowLane, Segment, Stub, StubDir, WindowEdge, WindowSegment, WindowStub, branch_color,
};
