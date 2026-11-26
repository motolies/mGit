use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::fmt::Debug;
use std::hash::Hash;

use mgit_model::Oid;

use crate::types::{
    CHUNK_ROWS, Edge, LayoutOptions, LayoutWindow, OpenLane, PALETTE_SIZE, RowLane, Segment, Stub,
    StubDir, WindowEdge, WindowSegment, WindowStub,
};

/// 아직 실체화되지 않은 가상(고정) 레인의 구간 시작 표식
const UNSET: u32 = u32::MAX;

/// 열린 레인 상태
#[derive(Clone, Copy, Debug)]
struct Lane<K> {
    /// 이 레인이 기다리는 부모
    expected: K,
    /// 구간 시작 행. 가상 고정 레인은 첫 노드·합류가 들어올 때까지 `UNSET`
    seg_start: u32,
    color: u16,
    /// GRAPH-13 고정 레인(레인 0). 첫 부모 체인이 다른 레인으로 합류하지 않는다
    pinned: bool,
}

/// 커밋 그래프 레이아웃. `push` 로 자식이 먼저 오는 순서(`--topo-order`·`--date-order`)의
/// 행을 하나씩 넣고 `window` 로 범위를 조회한다. `K` 는 커밋 키(기본 `Oid`)
#[derive(Debug)]
pub struct GraphLayout<K = Oid> {
    opts: LayoutOptions<K>,
    rows: Vec<RowLane>,
    segments: Vec<Segment>,
    /// `chunks[k]` = `[k*256, (k+1)*256)` 과 교차하는 segment id
    chunks: Vec<Vec<u32>>,
    /// `top_row` 단조 비감소 (행 r 에서만 top_row=r 또는 r-1 인 엣지가 생긴다)
    edges: Vec<Edge>,
    /// `row` 단조 비감소
    stubs: Vec<Stub<K>>,
    lane_count: u16,
    /// `finish()` 에서 부모가 끝내 나오지 않은 레인·스텁
    dangling: Vec<(u16, K)>,
    finished: bool,

    lanes: Vec<Option<Lane<K>>>,
    /// 부모 키 → 그 부모를 기다리는 유일한 레인
    waiting: HashMap<K, u16>,
    /// 부모 키 → 그 부모를 멀리서 가리키는 Down 스텁 (스텁 index, 자식 키)
    stub_waiting: HashMap<K, Vec<(u32, K)>>,
    /// 비어 있는 레인 (가장 왼쪽 우선)
    free: BinaryHeap<Reverse<u16>>,
    /// 이번 행에서 닫힌 레인. 행 끝에 `free` 로 옮겨 같은 행 재사용을 막는다
    pending_free: Vec<u16>,
    next_color: u8,
    /// 긴 엣지 접기용 선행 버퍼: 아직 배정하지 않은 행
    queue: VecDeque<(K, Vec<K>)>,
    /// 버퍼에 있는 행의 최종 행 번호
    lookahead_rows: HashMap<K, u32>,
}

impl<K: Copy + Eq + Hash + Debug> Default for GraphLayout<K> {
    /// 옵션이 모두 꺼진 빈 레이아웃
    fn default() -> Self {
        Self::with_options(LayoutOptions::default())
    }
}

impl<K: Copy + Eq + Hash + Debug> GraphLayout<K> {
    /// 빈 레이아웃 (옵션 없음)
    pub fn new() -> Self {
        Self::default()
    }

    /// 예상 커밋 수만큼 미리 할당한다
    pub fn with_capacity(rows: usize) -> Self {
        let mut l = Self::default();
        l.rows.reserve(rows);
        l
    }

    /// 옵션을 적용한 빈 레이아웃. `pin` 이 있으면 레인 0 을 그 커밋을 기다리는 가상 레인으로 심는다
    pub fn with_options(opts: LayoutOptions<K>) -> Self {
        let mut l = GraphLayout {
            opts,
            rows: Vec::new(),
            segments: Vec::new(),
            chunks: Vec::new(),
            edges: Vec::new(),
            stubs: Vec::new(),
            lane_count: 0,
            dangling: Vec::new(),
            finished: false,
            lanes: Vec::new(),
            waiting: HashMap::new(),
            stub_waiting: HashMap::new(),
            free: BinaryHeap::new(),
            pending_free: Vec::new(),
            next_color: 0,
            queue: VecDeque::new(),
            lookahead_rows: HashMap::new(),
        };
        if let Some(p) = l.opts.pin {
            let color = l.color_for_new_lane(&p);
            l.lanes.push(Some(Lane {
                expected: p,
                seg_start: UNSET,
                color,
                pinned: true,
            }));
            l.waiting.insert(p, 0);
            l.lane_count = 1;
        }
        l
    }

    /// 적용된 옵션
    pub fn options(&self) -> &LayoutOptions<K> {
        &self.opts
    }

    /// 커밋 하나를 넣는다. `parents` 는 중복이 제거된 상태여야 한다.
    /// 긴 엣지 접기가 켜져 있으면 N행 뒤에 실제 배정된다 (`len()` 은 배정된 행 수)
    pub fn push(&mut self, key: K, parents: &[K]) {
        debug_assert!(!self.finished, "finish() 이후에는 push 할 수 없다");
        match self.opts.collapse_long_edges {
            None => self.assign(key, parents),
            Some(n) => {
                let idx = (self.rows.len() + self.queue.len()) as u32;
                self.lookahead_rows.insert(key, idx);
                self.queue.push_back((key, parents.to_vec()));
                if self.queue.len() > n as usize
                    && let Some((k, ps)) = self.queue.pop_front()
                {
                    self.assign(k, &ps);
                }
            }
        }
    }

    /// 행 하나를 실제로 배정한다 (노드 레인 → 부모 처리 → 행 마감)
    fn assign(&mut self, key: K, parents: &[K]) {
        let r = self.rows.len() as u32;
        self.lookahead_rows.remove(&key);

        // 1. 노드 레인: 누군가 기다리던 커밋이면 그 레인, 아니면 새 레인(팁)
        let lane = match self.waiting.remove(&key) {
            Some(l) => {
                if let Some(ln) = self.lanes[l as usize].as_mut()
                    && ln.seg_start == UNSET
                {
                    ln.seg_start = r;
                }
                if let Some(&c) = self.opts.ref_colors.get(&key) {
                    self.recolor(l, r, u16::from(c));
                }
                l
            }
            None => {
                let l = self.alloc();
                let color = self.color_for_new_lane(&key);
                self.lanes[l as usize] = Some(Lane {
                    expected: key,
                    seg_start: r,
                    color,
                    pinned: false,
                });
                l
            }
        };
        // 1b. 멀리서 이 커밋을 가리키던 Down 스텁을 맺고 Up 스텁을 둔다
        if let Some(children) = self.stub_waiting.remove(&key) {
            let color = self.lane_color(lane);
            for (idx, child) in children {
                let child_row = self.stubs[idx as usize].row;
                self.stubs[idx as usize].other_row = Some(r);
                self.stubs.push(Stub {
                    row: r,
                    lane,
                    dir: StubDir::Up,
                    other_row: Some(child_row),
                    other: child,
                    color,
                });
            }
        }
        let color = self.lane_color(lane);
        self.rows.push(RowLane { lane, color });

        // 2. 부모 처리
        match parents.split_first() {
            None => self.close(lane, r), // 루트 커밋
            Some((&p1, rest)) => {
                self.link_first_parent(key, lane, r, p1);
                for &p in rest {
                    self.link_other_parent(key, lane, r, p, color);
                }
            }
        }

        // 3. 행 마감: 이번 행에서 닫힌 레인을 재사용 가능하게
        for l in self.pending_free.drain(..) {
            self.free.push(Reverse(l));
        }
    }

    /// 첫 부모: 직진 대기, 기존 레인으로 합류, 고정 레인의 steal, 또는 긴 엣지 스텁
    fn link_first_parent(&mut self, key: K, lane: u16, r: u32, p1: K) {
        let pinned = self.lanes[lane as usize].is_some_and(|l| l.pinned);
        let color = self.lane_color(lane);
        if let Some(&w) = self.waiting.get(&p1) {
            if pinned && w != lane {
                // steal: 고정 체인은 떠나지 않는다. 기다리던 레인 w 를 레인 0 으로 합류시킨다
                let wc = self.lane_color(w);
                self.edges.push(Edge {
                    top_row: r,
                    top_lane: w,
                    bottom_lane: lane,
                    color: wc,
                });
                self.close(w, r);
                self.waiting.insert(p1, lane);
                if let Some(ln) = self.lanes[lane as usize].as_mut() {
                    ln.expected = p1;
                }
            } else if self.is_virtual(w) && self.is_far(r, &p1) {
                // 아직 실체화되지 않은 고정 레인으로의 먼 합류: 레인 0 위에 긴 선을 긋지 않는다
                self.push_down_stub(key, lane, r, p1, color);
                self.close(lane, r);
            } else {
                // 첫 부모를 이미 다른 레인이 기다림 → 즉시 합류
                self.edges.push(Edge {
                    top_row: r,
                    top_lane: lane,
                    bottom_lane: w,
                    color,
                });
                self.materialize(w, r + 1);
                self.close(lane, r);
            }
        } else if !pinned && self.is_far(r, &p1) {
            // 먼 첫 부모: 레인을 잡지 않고 스텁만 남긴다
            self.push_down_stub(key, lane, r, p1, color);
            self.close(lane, r);
        } else {
            // 직진: 이 레인이 첫 부모를 기다린다 (고정 체인은 거리와 무관하게 이어진다)
            if let Some(ln) = self.lanes[lane as usize].as_mut() {
                ln.expected = p1;
            }
            self.waiting.insert(p1, lane);
        }
    }

    /// 나머지 부모: 기존 레인으로 머지 곡선, 새 분기 레인, 또는 긴 엣지 스텁.
    /// 첫 부모 처리로 `lane` 이 이미 닫혔을 수 있어 스텁 색은 호출자가 넘긴 노드 색을 쓴다
    fn link_other_parent(&mut self, key: K, lane: u16, r: u32, p: K, color: u16) {
        if let Some(&w) = self.waiting.get(&p) {
            if self.is_virtual(w) && self.is_far(r, &p) {
                self.push_down_stub(key, lane, r, p, color);
            } else {
                // 기존 레인으로 머지 곡선 (대상 레인 색)
                let wc = self.lane_color(w);
                self.edges.push(Edge {
                    top_row: r,
                    top_lane: lane,
                    bottom_lane: w,
                    color: wc,
                });
                self.materialize(w, r + 1);
            }
        } else if self.is_far(r, &p) {
            self.push_down_stub(key, lane, r, p, color);
        } else {
            // 새 레인으로 분기 (기다릴 부모의 ref 색을 미리 쓴다)
            let n = self.alloc();
            let c = self.color_for_new_lane(&p);
            self.lanes[n as usize] = Some(Lane {
                expected: p,
                seg_start: r + 1,
                color: c,
                pinned: false,
            });
            self.waiting.insert(p, n);
            self.edges.push(Edge {
                top_row: r,
                top_lane: lane,
                bottom_lane: n,
                color: c,
            });
        }
    }

    /// 긴 엣지 접기가 켜져 있고 부모가 다음 N행 안에 없는지
    fn is_far(&self, r: u32, p: &K) -> bool {
        let Some(n) = self.opts.collapse_long_edges else {
            return false;
        };
        !self
            .lookahead_rows
            .get(p)
            .is_some_and(|&rp| rp > r && rp - r <= n)
    }

    /// 아직 실체화되지 않은 가상 고정 레인인지
    fn is_virtual(&self, lane: u16) -> bool {
        self.lanes[lane as usize].is_some_and(|l| l.pinned && l.seg_start == UNSET)
    }

    /// 가상 레인에 처음 무언가가 들어오면 그 행부터 구간을 시작한다
    fn materialize(&mut self, lane: u16, row: u32) {
        if let Some(ln) = self.lanes[lane as usize].as_mut()
            && ln.seg_start == UNSET
        {
            ln.seg_start = row;
        }
    }

    /// 자식 행에 Down 스텁을 두고 부모 도착을 기다린다
    fn push_down_stub(&mut self, child: K, lane: u16, r: u32, parent: K, color: u16) {
        let idx = self.stubs.len() as u32;
        self.stubs.push(Stub {
            row: r,
            lane,
            dir: StubDir::Down,
            other_row: None,
            other: parent,
            color,
        });
        self.stub_waiting
            .entry(parent)
            .or_default()
            .push((idx, child));
    }

    /// ref 팁에서 레인 색을 바꾼다: 이전 구간을 r-1 에서 닫고 같은 레인 이음선으로 잇는다
    fn recolor(&mut self, lane: u16, r: u32, color: u16) {
        let Some(ln) = self.lanes[lane as usize] else {
            return;
        };
        if ln.color == color {
            return;
        }
        if ln.seg_start < r {
            self.record_segment(lane, ln.seg_start, r - 1, ln.color);
            self.edges.push(Edge {
                top_row: r - 1,
                top_lane: lane,
                bottom_lane: lane,
                color: ln.color,
            });
        }
        if let Some(ln) = self.lanes[lane as usize].as_mut() {
            if ln.seg_start < r {
                ln.seg_start = r;
            }
            ln.color = color;
        }
    }

    /// 스트림 끝. 선행 버퍼를 비우고 열린 레인을 모두 닫으며 부모가 나오지 않은 레인·스텁을 기록한다
    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        while let Some((k, ps)) = self.queue.pop_front() {
            self.assign(k, &ps);
        }
        self.finished = true;
        let last = self.rows.len().checked_sub(1).map(|l| l as u32);
        if let Some(last) = last {
            // 마지막 행에서 아래로 내려가는 엣지는 그릴 다음 행이 없다 (분기·합류 모두). 전부 지운다
            self.edges.retain(|e| e.top_row != last);
        }
        for l in 0..self.lanes.len() {
            let Some(lane) = self.lanes[l] else {
                continue;
            };
            if lane.seg_start == UNSET {
                // 끝내 실체화되지 않은 가상 레인: 흔적을 남기지 않는다
                self.lanes[l] = None;
                continue;
            }
            self.dangling.push((l as u16, lane.expected));
            match last {
                Some(last) if lane.seg_start <= last => self.close(l as u16, last),
                // 마지막 행에서 분기만 되고 구간이 없는 레인: 구간 없이 버린다
                _ => self.lanes[l] = None,
            }
        }
        // 부모가 끝내 오지 않은 Down 스텁 (stubs 순서라 결정적)
        for i in 0..self.stubs.len() {
            let s = self.stubs[i];
            if s.dir == StubDir::Down && s.other_row.is_none() {
                self.dangling.push((s.lane, s.other));
            }
        }
        self.waiting.clear();
        self.stub_waiting.clear();
        self.pending_free.clear();
        self.lookahead_rows.clear();
    }

    /// `[start, start+count)` 와 교차하는 구간·엣지·스텁을 돌려준다.
    /// 스트리밍 중에도 호출할 수 있으며 열린 레인은 `continues_down = true` 로 포함된다
    pub fn window(&self, start: u32, count: u32) -> LayoutWindow {
        let total = self.rows.len() as u32;
        let start = start.min(total);
        let end = start.saturating_add(count).min(total); // exclusive
        if start >= end {
            return LayoutWindow {
                start,
                rows: Vec::new(),
                segments: Vec::new(),
                edges: Vec::new(),
                stubs: Vec::new(),
                lane_count: self.lane_count,
            };
        }
        let last = end - 1;

        // 닫힌 구간: 청크 인덱스로 후보를 모아 교차 필터·클립
        let mut ids: Vec<u32> = ((start / CHUNK_ROWS)..=(last / CHUNK_ROWS))
            .filter_map(|k| self.chunks.get(k as usize))
            .flatten()
            .copied()
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let mut segments: Vec<WindowSegment> = ids
            .into_iter()
            .map(|id| self.segments[id as usize])
            .filter(|s| s.start <= last && s.end >= start)
            .map(|s| WindowSegment {
                lane: s.lane,
                from_row: s.start.max(start),
                to_row: s.end.min(last),
                color: s.color,
                continues_up: s.start < start,
                continues_down: s.end > last,
            })
            .collect();

        // 열린 레인: 윈도 끝까지 이어지고 아래로 계속된다 (가상 레인은 UNSET 이라 제외)
        for (l, lane) in self.lanes.iter().enumerate() {
            if let Some(lane) = lane
                && lane.seg_start <= last
            {
                segments.push(WindowSegment {
                    lane: l as u16,
                    from_row: lane.seg_start.max(start),
                    to_row: last,
                    color: lane.color,
                    continues_up: lane.seg_start < start,
                    continues_down: true,
                });
            }
        }
        segments.sort_by_key(|s| (s.lane, s.from_row));

        // 엣지: top_row ∈ [start-1, end)
        let lo = self
            .edges
            .partition_point(|e| e.top_row < start.saturating_sub(1));
        let hi = self.edges.partition_point(|e| e.top_row < end);
        let edges = self.edges[lo..hi]
            .iter()
            .map(|e| WindowEdge {
                top_row: e.top_row,
                top_lane: e.top_lane,
                bottom_lane: e.bottom_lane,
                color: e.color,
            })
            .collect();

        // 스텁: row ∈ [start, end)
        let lo = self.stubs.partition_point(|s| s.row < start);
        let hi = self.stubs.partition_point(|s| s.row < end);
        let stubs = self.stubs[lo..hi]
            .iter()
            .map(|s| WindowStub {
                row: s.row,
                lane: s.lane,
                dir: s.dir,
                other_row: s.other_row,
                color: s.color,
            })
            .collect();

        LayoutWindow {
            start,
            rows: self.rows[start as usize..end as usize].to_vec(),
            segments,
            edges,
            stubs,
            lane_count: self.lane_count,
        }
    }

    /// 지금까지 배정된 행 수 (선행 버퍼에 있는 행은 제외)
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// `push` 된 행 수 (배정된 행 + 선행 버퍼)
    pub fn pushed(&self) -> usize {
        self.rows.len() + self.queue.len()
    }

    /// 배정된 행이 하나도 없는지
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// 사용된 레인 수(최대 폭)
    pub fn lane_count(&self) -> u16 {
        self.lane_count
    }

    /// `finish()` 가 호출됐는지
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// 행별 노드 레인
    pub fn rows(&self) -> &[RowLane] {
        &self.rows
    }

    /// 닫힌 구간 전체 (닫힌 순서)
    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// 엣지 전체 (`top_row` 단조)
    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// 스텁 전체 (`row` 단조)
    pub fn stubs(&self) -> &[Stub<K>] {
        &self.stubs
    }

    /// 아직 열린(실체화된) 레인
    pub fn open_lanes(&self) -> Vec<OpenLane> {
        self.lanes
            .iter()
            .enumerate()
            .filter_map(|(l, lane)| {
                lane.filter(|lane| lane.seg_start != UNSET)
                    .map(|lane| OpenLane {
                        lane: l as u16,
                        seg_start: lane.seg_start,
                        color: lane.color,
                    })
            })
            .collect()
    }

    /// 스트림에 나오지 않은 부모를 기다리던 레인·스텁 (`finish()` 이후)
    pub fn dangling(&self) -> &[(u16, K)] {
        &self.dangling
    }

    /// 구간을 기록하고 청크 인덱스에 넣는다 (레인 상태는 건드리지 않는다)
    fn record_segment(&mut self, lane: u16, start: u32, end: u32, color: u16) {
        debug_assert!(start <= end, "빈 구간은 생길 수 없다");
        let id = self.segments.len() as u32;
        self.segments.push(Segment {
            lane,
            start,
            end,
            color,
        });
        for k in (start / CHUNK_ROWS)..=(end / CHUNK_ROWS) {
            let k = k as usize;
            if self.chunks.len() <= k {
                self.chunks.resize_with(k + 1, Vec::new);
            }
            self.chunks[k].push(id);
        }
    }

    /// 레인을 닫아 구간으로 기록하고 반납한다
    fn close(&mut self, lane: u16, end: u32) {
        let Some(l) = self.lanes[lane as usize].take() else {
            return;
        };
        self.record_segment(lane, l.seg_start, end, l.color);
        self.pending_free.push(lane);
    }

    /// 빈 레인을 하나 얻는다. 없으면 오른쪽에 새로 만든다
    fn alloc(&mut self) -> u16 {
        match self.free.pop() {
            Some(Reverse(l)) => l,
            None => {
                let l = self.lanes.len() as u16;
                self.lanes.push(None);
                self.lane_count = self.lane_count.max(l + 1);
                l
            }
        }
    }

    /// 새 레인의 색: 기다릴 키의 ref 색 → 옵션의 키 색 → 팔레트 순환
    fn color_for_new_lane(&mut self, waits_for: &K) -> u16 {
        if let Some(&c) = self.opts.ref_colors.get(waits_for) {
            return u16::from(c);
        }
        if let Some(f) = self.opts.lane_color {
            return f(waits_for);
        }
        self.next_color()
    }

    /// 다음 팔레트 색
    fn next_color(&mut self) -> u16 {
        let c = self.next_color;
        self.next_color = (self.next_color + 1) % PALETTE_SIZE;
        u16::from(c)
    }

    /// 열린 레인의 색. 닫힌 레인이면 0
    fn lane_color(&self, lane: u16) -> u16 {
        self.lanes[lane as usize].map(|l| l.color).unwrap_or(0)
    }
}
