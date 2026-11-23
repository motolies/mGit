//! 레이아웃 불변식 검사기. proptest 와 코어 통합 테스트가 함께 쓴다.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Debug;
use std::hash::Hash;

use crate::layout::GraphLayout;
use crate::types::{LayoutOptions, StubDir, WindowEdge, WindowSegment, WindowStub};

/// 검사 입력: 스트림 순서대로의 (키, 부모들)
pub type Stream<K> = [(K, Vec<K>)];

/// `finish()` 된 레이아웃이 불변식 I1~I5, I10 과 옵션별 불변식(S1~S5, I11~I13)을 만족하는지 검사한다
pub fn check_all<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
) -> Result<(), String> {
    if !layout.is_finished() {
        return Err("finish() 전".into());
    }
    if layout.len() != stream.len() {
        return Err(format!("행 수 {} != 입력 {}", layout.len(), stream.len()));
    }
    if !layout.open_lanes().is_empty() {
        return Err("I10: finish 후 열린 레인이 남음".into());
    }
    let cover = covered_cells(layout);
    check_segments(layout, &cover)?;
    check_edges(layout, &cover)?;
    check_stubs(layout, stream)?;
    check_connectivity(layout, stream, &cover)?;
    check_dangling(layout, stream)?;
    check_pin(layout, stream)?;
    check_collapse_narrower(layout, stream)?;
    check_ref_colors(layout, stream)?;
    Ok(())
}

/// 구간이 덮는 (행, 레인) 셀 집합
fn covered_cells<K: Copy + Eq + Hash + Debug>(layout: &GraphLayout<K>) -> HashSet<(u32, u16)> {
    let mut set = HashSet::new();
    for s in layout.segments() {
        for r in s.start..=s.end {
            set.insert((r, s.lane));
        }
    }
    set
}

/// I1: 노드 행은 그 레인 구간에 덮인다. I2: 같은 레인 구간은 겹치지 않고 start ≤ end
fn check_segments<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    cover: &HashSet<(u32, u16)>,
) -> Result<(), String> {
    for (r, row) in layout.rows().iter().enumerate() {
        if !cover.contains(&(r as u32, row.lane)) {
            return Err(format!(
                "I1: 행 {r} 레인 {} 이 구간에 덮이지 않음",
                row.lane
            ));
        }
    }
    let mut by_lane: HashMap<u16, Vec<(u32, u32)>> = HashMap::new();
    for s in layout.segments() {
        if s.start > s.end {
            return Err(format!("I2: 빈 구간 {s:?}"));
        }
        by_lane.entry(s.lane).or_default().push((s.start, s.end));
    }
    for (lane, mut v) in by_lane {
        v.sort_unstable();
        for w in v.windows(2) {
            if w[0].1 >= w[1].0 {
                return Err(format!("I2: 레인 {lane} 구간 겹침 {:?} {:?}", w[0], w[1]));
            }
        }
    }
    Ok(())
}

/// I4: 엣지 양 끝 셀이 덮여 있고 top_row+1 < rows. I5: top_row 단조
fn check_edges<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    cover: &HashSet<(u32, u16)>,
) -> Result<(), String> {
    let n = layout.len() as u32;
    let mut prev = 0;
    for e in layout.edges() {
        if e.top_row + 1 >= n {
            return Err(format!("I4: 엣지 {e:?} 가 마지막 행을 넘어감"));
        }
        if !cover.contains(&(e.top_row, e.top_lane)) {
            return Err(format!("I4: 엣지 {e:?} 의 위쪽 셀이 덮이지 않음"));
        }
        if !cover.contains(&(e.top_row + 1, e.bottom_lane)) {
            return Err(format!("I4: 엣지 {e:?} 의 아래쪽 셀이 덮이지 않음"));
        }
        if e.top_row < prev {
            return Err(format!("I5: 엣지 top_row 가 감소 {e:?}"));
        }
        prev = e.top_row;
    }
    Ok(())
}

/// S1: 스텁 셀 == 그 행의 노드 레인. S2: row 단조. S3: Down(Some) 은 거리 > N 이고 부모 관계·Up 짝이 맞는다.
/// S4: Down(None) ⇔ 상대가 스트림 밖. S5: Down 스텁 색 == 자식 행의 노드 색
fn check_stubs<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
) -> Result<(), String> {
    let stubs = layout.stubs();
    if stubs.is_empty() {
        return Ok(());
    }
    let n = layout
        .options()
        .collapse_long_edges
        .ok_or("S0: 접기가 꺼져 있는데 스텁이 있음")?;
    let index: HashMap<K, u32> = stream
        .iter()
        .enumerate()
        .map(|(i, (k, _))| (*k, i as u32))
        .collect();
    let rows = layout.rows();
    let mut prev = 0;
    for s in stubs {
        if rows.get(s.row as usize).map(|r| r.lane) != Some(s.lane) {
            return Err(format!("S1: 스텁 {s:?} 이 노드 레인에 있지 않음"));
        }
        if s.row < prev {
            return Err(format!("S2: 스텁 row 가 감소 {s:?}"));
        }
        prev = s.row;
        if s.dir == StubDir::Down && rows[s.row as usize].color != s.color {
            return Err(format!("S5: Down 스텁 {s:?} 의 색이 노드 색과 다름"));
        }
        match (s.dir, s.other_row) {
            (StubDir::Down, Some(rp)) => {
                if rp <= s.row || rp - s.row <= n {
                    return Err(format!("S3: Down 스텁 {s:?} 의 거리가 N 이하"));
                }
                if index.get(&s.other) != Some(&rp) {
                    return Err(format!("S3: Down 스텁 {s:?} 의 상대 행이 틀림"));
                }
                if !stream[s.row as usize].1.contains(&s.other) {
                    return Err(format!("S3: Down 스텁 {s:?} 의 상대가 부모가 아님"));
                }
                let paired = stubs
                    .iter()
                    .any(|u| u.dir == StubDir::Up && u.row == rp && u.other_row == Some(s.row));
                if !paired {
                    return Err(format!("S3: Down 스텁 {s:?} 의 Up 짝이 없음"));
                }
            }
            (StubDir::Down, None) => {
                if index.contains_key(&s.other) {
                    return Err(format!("S4: 스트림 안 부모를 가리키는 미해결 스텁 {s:?}"));
                }
            }
            (StubDir::Up, Some(rc)) => {
                let paired = stubs
                    .iter()
                    .any(|d| d.dir == StubDir::Down && d.row == rc && d.other_row == Some(s.row));
                if !paired {
                    return Err(format!("S3: Up 스텁 {s:?} 의 Down 짝이 없음"));
                }
            }
            (StubDir::Up, None) => return Err(format!("S3: Up 스텁 {s:?} 에 자식 행이 없음")),
        }
    }
    Ok(())
}

/// I3: 스트림에 존재하는 모든 (자식 행, 부모 행) 쌍에 대해 셀 그래프 경로가 있거나 그 부모를 가리키는 Down 스텁이 있다.
/// 셀 그래프: `(r,l)→(r+1,l)` 은 구간이 둘 다 덮을 때, `(r,l)→(r+1,l')` 은 엣지가 있을 때
fn check_connectivity<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
    cover: &HashSet<(u32, u16)>,
) -> Result<(), String> {
    let index: HashMap<K, u32> = stream
        .iter()
        .enumerate()
        .map(|(i, (k, _))| (*k, i as u32))
        .collect();
    let mut edges_from: HashMap<(u32, u16), Vec<u16>> = HashMap::new();
    for e in layout.edges() {
        edges_from
            .entry((e.top_row, e.top_lane))
            .or_default()
            .push(e.bottom_lane);
    }
    let stubbed: HashSet<(u32, K)> = layout
        .stubs()
        .iter()
        .filter(|s| s.dir == StubDir::Down)
        .map(|s| (s.row, s.other))
        .collect();
    let rows = layout.rows();
    for (c, (_, parents)) in stream.iter().enumerate() {
        let c = c as u32;
        for p in parents {
            let Some(&pr) = index.get(p) else {
                continue; // 스트림 밖 부모
            };
            if pr <= c {
                return Err(format!("입력 오류: 부모 행 {pr} 이 자식 행 {c} 앞에 있음"));
            }
            if stubbed.contains(&(c, *p)) {
                continue;
            }
            let target = (pr, rows[pr as usize].lane);
            let start = (c, rows[c as usize].lane);
            if !reachable(start, target, cover, &edges_from) {
                return Err(format!("I3: 행 {c} → 부모 행 {pr} 경로 없음"));
            }
        }
    }
    Ok(())
}

/// 셀 그래프에서 BFS 로 도달 가능한지. 행은 항상 1씩 증가하므로 target 행에서 멈춘다
fn reachable(
    start: (u32, u16),
    target: (u32, u16),
    cover: &HashSet<(u32, u16)>,
    edges_from: &HashMap<(u32, u16), Vec<u16>>,
) -> bool {
    let mut seen = HashSet::new();
    let mut q = VecDeque::from([start]);
    while let Some(cell @ (r, l)) = q.pop_front() {
        if cell == target {
            return true;
        }
        if r >= target.0 || !seen.insert(cell) {
            continue;
        }
        if cover.contains(&(r + 1, l)) {
            q.push_back((r + 1, l));
        }
        if let Some(next) = edges_from.get(&cell) {
            for &nl in next {
                q.push_back((r + 1, nl));
            }
        }
    }
    false
}

/// I10: dangling 의 키 집합 == 스트림에 없던 부모 집합
fn check_dangling<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
) -> Result<(), String> {
    let present: HashSet<K> = stream.iter().map(|(o, _)| *o).collect();
    let expected: HashSet<K> = stream
        .iter()
        .flat_map(|(_, ps)| ps.iter().copied())
        .filter(|p| !present.contains(p))
        .collect();
    let actual: HashSet<K> = layout.dangling().iter().map(|(_, o)| *o).collect();
    if expected != actual {
        return Err(format!(
            "I10: dangling 불일치 expected={expected:?} actual={actual:?}"
        ));
    }
    Ok(())
}

/// I11: 고정 커밋부터 첫 부모를 따라가는 체인은 모두 레인 0 이고, 그 구간에서 레인 0 은 체인만 쓴다
fn check_pin<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
) -> Result<(), String> {
    let Some(pin) = layout.options().pin else {
        return Ok(());
    };
    let index: HashMap<K, u32> = stream
        .iter()
        .enumerate()
        .map(|(i, (k, _))| (*k, i as u32))
        .collect();
    let Some(&start) = index.get(&pin) else {
        return Ok(()); // 고정 커밋이 스트림에 없으면 검사할 체인이 없다
    };
    let rows = layout.rows();
    let mut chain = HashSet::new();
    let mut cur = start;
    loop {
        chain.insert(cur);
        if rows[cur as usize].lane != 0 {
            return Err(format!(
                "I11: 고정 체인 행 {cur} 이 레인 {}",
                rows[cur as usize].lane
            ));
        }
        match stream[cur as usize].1.first().and_then(|p| index.get(p)) {
            Some(&next) => cur = next,
            None => break,
        }
    }
    for r in start..=cur {
        if rows[r as usize].lane == 0 && !chain.contains(&r) {
            return Err(format!("I11: 고정 구간 안의 행 {r} 이 체인 밖인데 레인 0"));
        }
    }
    Ok(())
}

/// I12: 긴 엣지를 접으면 레인 수가 늘지 않는다 (같은 옵션에서 접기만 끈 것과 비교)
fn check_collapse_narrower<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
) -> Result<(), String> {
    if layout.options().collapse_long_edges.is_none() {
        return Ok(());
    }
    let opts = LayoutOptions {
        collapse_long_edges: None,
        ..layout.options().clone()
    };
    let mut plain = GraphLayout::with_options(opts);
    for (k, ps) in stream {
        plain.push(*k, ps);
    }
    plain.finish();
    if layout.lane_count() > plain.lane_count() {
        return Err(format!(
            "I12: 접기 레인 수 {} > 안 접은 레인 수 {}",
            layout.lane_count(),
            plain.lane_count()
        ));
    }
    Ok(())
}

/// I13: ref 색이 지정된 커밋의 노드 색은 그 색이다
fn check_ref_colors<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    stream: &Stream<K>,
) -> Result<(), String> {
    let colors = &layout.options().ref_colors;
    if colors.is_empty() {
        return Ok(());
    }
    for (r, (k, _)) in stream.iter().enumerate() {
        if let Some(&c) = colors.get(k)
            && layout.rows()[r].color != c
        {
            return Err(format!(
                "I13: 행 {r} 색 {} != ref 색 {c}",
                layout.rows()[r].color
            ));
        }
    }
    Ok(())
}

/// I8 용 브루트포스: 전체 구간·열린 레인·엣지·스텁을 직접 필터·클립한다
pub fn brute_force_window<K: Copy + Eq + Hash + Debug>(
    layout: &GraphLayout<K>,
    start: u32,
    count: u32,
) -> (Vec<WindowSegment>, Vec<WindowEdge>, Vec<WindowStub>) {
    let total = layout.len() as u32;
    let start = start.min(total);
    let end = start.saturating_add(count).min(total);
    if start >= end {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    let last = end - 1;
    let mut segments: Vec<WindowSegment> = layout
        .segments()
        .iter()
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
    for o in layout.open_lanes() {
        if o.seg_start <= last {
            segments.push(WindowSegment {
                lane: o.lane,
                from_row: o.seg_start.max(start),
                to_row: last,
                color: o.color,
                continues_up: o.seg_start < start,
                continues_down: true,
            });
        }
    }
    segments.sort_by_key(|s| (s.lane, s.from_row));
    let edges = layout
        .edges()
        .iter()
        .filter(|e| e.top_row + 1 >= start && e.top_row < end)
        .map(|e| WindowEdge {
            top_row: e.top_row,
            top_lane: e.top_lane,
            bottom_lane: e.bottom_lane,
            color: e.color,
        })
        .collect();
    let stubs = layout
        .stubs()
        .iter()
        .filter(|s| s.row >= start && s.row < end)
        .map(|s| WindowStub {
            row: s.row,
            lane: s.lane,
            dir: s.dir,
            other_row: s.other_row,
            color: s.color,
        })
        .collect();
    (segments, edges, stubs)
}
