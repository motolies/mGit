//! 손으로 만든 DAG 시나리오의 레이아웃 스냅샷 (I7, I11)
#![allow(clippy::unwrap_used)]

mod common;

use common::{build, build_with, opts, stream};
use mgit_graph::check::check_all;
use mgit_graph::{StubDir, branch_color};

/// 스냅샷용 요약: (행 레인·색), 구간, 엣지, 레인 수. 스텁은 있을 때만 줄을 덧붙인다
fn summary(layout: &mgit_graph::GraphLayout) -> String {
    let rows: Vec<(u16, u8)> = layout.rows().iter().map(|r| (r.lane, r.color)).collect();
    let segs: Vec<(u16, u32, u32, u8)> = layout
        .segments()
        .iter()
        .map(|s| (s.lane, s.start, s.end, s.color))
        .collect();
    let edges: Vec<(u32, u16, u16, u8)> = layout
        .edges()
        .iter()
        .map(|e| (e.top_row, e.top_lane, e.bottom_lane, e.color))
        .collect();
    let mut out = format!(
        "rows(lane,color)={rows:?}\nsegments(lane,start,end,color)={segs:?}\nedges(top_row,top_lane,bottom_lane,color)={edges:?}\nlane_count={}",
        layout.lane_count()
    );
    if !layout.stubs().is_empty() {
        let stubs: Vec<(u32, u16, &str, Option<u32>, u8)> = layout
            .stubs()
            .iter()
            .map(|s| {
                (
                    s.row,
                    s.lane,
                    match s.dir {
                        StubDir::Down => "down",
                        StubDir::Up => "up",
                    },
                    s.other_row,
                    s.color,
                )
            })
            .collect();
        out.push_str(&format!("\nstubs(row,lane,dir,other_row,color)={stubs:?}"));
    }
    out
}

#[test]
fn linear_is_one_segment() {
    // I7: 선형 → 구간 1개, 엣지 0, 레인 1
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.segments().len(), 1);
    assert!(layout.edges().is_empty());
    assert_eq!(layout.lane_count(), 1);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn fork_and_merge_uses_two_lanes() {
    // 0 = merge(1, 2); 1 → 3; 2 → 3; 3 root
    let s = stream(&[(0, &[1, 2]), (1, &[3]), (2, &[3]), (3, &[])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.lane_count(), 2);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn octopus_uses_three_lanes() {
    // 0 = merge(1, 2, 3); 모두 4로 합류
    let s = stream(&[(0, &[1, 2, 3]), (1, &[4]), (2, &[4]), (3, &[4]), (4, &[])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.lane_count(), 3);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn orphan_branch_gets_new_lane_after_root() {
    // 0→1→2(root), 3→4(root): 고아 브랜치. 레인 0이 닫힌 뒤 재사용된다
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[]), (3, &[4]), (4, &[])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.lane_count(), 1);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn parent_in_next_row_makes_one_row_segment() {
    // 0 = merge(1, 2); 2 가 바로 다음 행 → 분기 레인은 길이 1 구간
    let s = stream(&[(0, &[2, 1]), (1, &[3]), (2, &[3]), (3, &[])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn dangling_parent_runs_to_bottom() {
    // 1의 부모 9는 스트림에 없다 → 레인이 마지막 행까지 이어지고 dangling 에 기록
    let s = stream(&[(0, &[1]), (1, &[9, 2]), (2, &[])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.dangling().len(), 1);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn dangling_branch_in_last_row_is_dropped() {
    // 마지막 행에서 스트림 밖 부모로 분기 → 구간·엣지 없이 dangling 만 기록
    let s = stream(&[(0, &[1]), (1, &[2, 9])]);
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.segments().len(), 1);
    assert!(layout.edges().is_empty());
    assert_eq!(layout.dangling().len(), 2); // 2 와 9 모두 스트림 밖
}

#[test]
fn window_clips_and_marks_continuation() {
    let s = stream(&[(0, &[1, 2]), (1, &[3]), (2, &[3]), (3, &[4]), (4, &[])]);
    let layout = build(&s);
    let w = layout.window(1, 2); // 행 1..=2
    assert_eq!(w.start, 1);
    assert_eq!(w.rows.len(), 2);
    // 레인 0 구간은 위아래로 이어지고, 레인 1 구간은 행 1..=2 로 딱 맞는다
    let lane0 = w.segments.iter().find(|s| s.lane == 0).unwrap();
    assert!(lane0.continues_up && lane0.continues_down);
    assert_eq!((lane0.from_row, lane0.to_row), (1, 2));
    let lane1 = w.segments.iter().find(|s| s.lane == 1).unwrap();
    assert_eq!((lane1.from_row, lane1.to_row), (1, 2));
    assert!(!lane1.continues_up);
    // 행 0→1 (윈도 위에서 들어오는 선) 과 행 2→3 (아래로 나가는 선) 엣지가 모두 포함된다
    assert!(w.edges.iter().any(|e| e.top_row == 0));
    assert!(w.edges.iter().any(|e| e.top_row == 2));
}

#[test]
fn window_during_streaming_includes_open_lanes() {
    let s = stream(&[(0, &[1, 2]), (1, &[3]), (2, &[3]), (3, &[])]);
    let mut layout = mgit_graph::GraphLayout::new();
    for (o, ps) in &s[..2] {
        layout.push(*o, ps);
    }
    let w = layout.window(0, 10);
    assert_eq!(w.rows.len(), 2);
    assert!(w.segments.iter().all(|seg| seg.continues_down));
    assert_eq!(w.segments.len(), 2);
}

#[test]
fn empty_layout_window_is_empty() {
    let layout: mgit_graph::GraphLayout = mgit_graph::GraphLayout::new();
    let w = layout.window(0, 100);
    assert!(w.rows.is_empty() && w.segments.is_empty() && w.edges.is_empty());
}

// ───────────── A. ref 팁 색 전환 ─────────────

#[test]
fn ref_color_switch_on_first_parent_chain() {
    // feature(0→1) 체인이 master 팁(2)에 닿으면 2 부터 색 5. 이전 구간은 1 에서 닫히고 같은 레인 이음선이 생긴다
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[])]);
    let layout = build_with(&s, opts(None, &[(2, 5)], None));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.rows()[1].color, layout.rows()[0].color);
    assert_eq!(layout.rows()[2].color, 5);
    assert_eq!(layout.rows()[3].color, 5);
    assert_eq!(layout.segments().len(), 2);
    assert!(
        layout
            .edges()
            .iter()
            .any(|e| e.top_row == 1 && e.top_lane == 0 && e.bottom_lane == 0)
    );
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn remote_tip_same_key_does_not_switch() {
    // master(0)·origin/master(2) 가 같은 색 키면 전환이 없다 → 구간 1개
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[])]);
    let layout = build_with(&s, opts(None, &[(0, 3), (2, 3)], None));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.segments().len(), 1);
    assert!(layout.rows().iter().all(|r| r.color == 3));
}

#[test]
fn tip_lane_uses_ref_color_and_branch_lane_pre_applies() {
    // 팁 0 은 색 7. 머지 0 의 둘째 부모 2 가 ref 색 4 면 분기 레인·엣지가 처음부터 색 4
    let s = stream(&[(0, &[1, 2]), (1, &[3]), (2, &[3]), (3, &[])]);
    let layout = build_with(&s, opts(None, &[(0, 7), (2, 4)], None));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.rows()[0].color, 7);
    assert_eq!(layout.rows()[2].color, 4);
    let branch = layout.edges().iter().find(|e| e.top_row == 0).unwrap();
    assert_eq!(branch.color, 4);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn branch_color_is_deterministic_and_in_palette() {
    assert_eq!(branch_color("master"), branch_color("master"));
    assert!(branch_color("develop") < mgit_graph::PALETTE_SIZE);
    assert_ne!(branch_color("a"), branch_color("b"));
}

// ───────────── B. 레인 0 고정 ─────────────

#[test]
fn pin_takes_lane0_when_other_tip_comes_first() {
    // feature 팁 0 이 먼저 오고 master 팁 1 이 뒤에 온다. 둘 다 2 를 부모로 → steal 로 master 가 레인 0
    let s = stream(&[(0, &[2]), (1, &[2]), (2, &[])]);
    let layout = build_with(&s, opts(Some(1), &[], None));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.rows()[0].lane, 1);
    assert_eq!(layout.rows()[1].lane, 0);
    assert_eq!(layout.rows()[2].lane, 0);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn pin_waited_by_feature_ahead() {
    // feature 0 이 master 팁 1 보다 1커밋 앞선 경우: 0 은 레인 1, 행 0→1 대각선, 1 부터 레인 0
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[])]);
    let layout = build_with(&s, opts(Some(1), &[], None));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.rows()[0].lane, 1);
    assert_eq!(layout.rows()[1].lane, 0);
    assert_eq!(
        layout.edges(),
        &[mgit_graph::Edge {
            top_row: 0,
            top_lane: 1,
            bottom_lane: 0,
            color: layout.rows()[0].color,
        }]
    );
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn pin_merged_as_second_parent() {
    // 0 = merge(1, 2) 에서 2 가 고정 커밋: 머지 곡선이 레인 0 으로 가고 2 는 레인 0
    let s = stream(&[(0, &[1, 2]), (1, &[3]), (2, &[3]), (3, &[])]);
    let layout = build_with(&s, opts(Some(2), &[], None));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.rows()[2].lane, 0);
    assert_eq!(layout.rows()[0].lane, 1);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn pin_absent_leaves_lane0_unused() {
    // 고정 커밋 9 가 스트림에 없다 → 레인 0 은 비고 흔적(구간·dangling) 없음
    let s = stream(&[(0, &[1]), (1, &[])]);
    let layout = build_with(&s, opts(Some(9), &[], None));
    check_all(&layout, &s).unwrap();
    assert!(layout.rows().iter().all(|r| r.lane == 1));
    assert!(layout.dangling().is_empty());
    assert_eq!(layout.lane_count(), 2);
}

#[test]
fn pin_is_first_row() {
    let s = stream(&[(0, &[1]), (1, &[])]);
    let layout = build_with(&s, opts(Some(0), &[], None));
    check_all(&layout, &s).unwrap();
    assert!(layout.rows().iter().all(|r| r.lane == 0));
    assert_eq!(layout.lane_count(), 1);
}

#[test]
fn pin_empty_stream_finish_clears_lanes() {
    let s = stream(&[]);
    let layout = build_with(&s, opts(Some(0), &[], None));
    check_all(&layout, &s).unwrap();
    assert!(layout.open_lanes().is_empty());
}

// ───────────── C. 긴 엣지 접기 (N=2) ─────────────

#[test]
fn far_first_parent_becomes_stub_pair() {
    // 0 의 첫 부모 5 는 5행 아래 → 레인을 잡지 않고 Down(0)·Up(5) 스텁. 레인 수 1
    let s = stream(&[
        (0, &[5]),
        (1, &[2]),
        (2, &[3]),
        (3, &[4]),
        (4, &[5]),
        (5, &[]),
    ]);
    let layout = build_with(&s, opts(None, &[], Some(2)));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.lane_count(), 1);
    let down = layout
        .stubs()
        .iter()
        .find(|s| s.dir == StubDir::Down)
        .unwrap();
    assert_eq!((down.row, down.lane, down.other_row), (0, 0, Some(5)));
    let up = layout
        .stubs()
        .iter()
        .find(|s| s.dir == StubDir::Up)
        .unwrap();
    assert_eq!((up.row, up.other_row), (5, Some(0)));
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn distance_exactly_n_keeps_lane_n_plus_one_collapses() {
    // 0→2 는 거리 2 (= N) → 레인 유지. 0→3 은 거리 3 → 스텁
    let s = stream(&[(0, &[2, 3]), (1, &[3]), (2, &[3]), (3, &[])]);
    let layout = build_with(&s, opts(None, &[], Some(2)));
    check_all(&layout, &s).unwrap();
    assert_eq!(
        layout
            .stubs()
            .iter()
            .filter(|s| s.dir == StubDir::Down)
            .count(),
        1
    );
    assert_eq!(layout.rows()[2].lane, 0);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn far_second_parent_stub_without_branch_lane() {
    // 머지 0 의 둘째 부모 4 가 멀다 → 분기 레인 없이 Down 스텁, 레인 수 1
    let s = stream(&[(0, &[1, 4]), (1, &[2]), (2, &[3]), (3, &[4]), (4, &[])]);
    let layout = build_with(&s, opts(None, &[], Some(2)));
    check_all(&layout, &s).unwrap();
    assert_eq!(layout.lane_count(), 1);
    assert!(
        layout
            .stubs()
            .iter()
            .any(|s| s.dir == StubDir::Down && s.row == 0)
    );
}

#[test]
fn far_parent_already_waited_joins_instead_of_stub() {
    // 고정 체인 0→5 는 거리와 무관하게 레인 0 이 5 를 기다린다. 그러면 1 의 먼 부모 5 는 스텁이 아니라 그 레인으로 합류
    let s = stream(&[
        (0, &[5]),
        (1, &[2, 5]),
        (2, &[3]),
        (3, &[4]),
        (4, &[5]),
        (5, &[]),
    ]);
    let layout = build_with(&s, opts(Some(0), &[], Some(2)));
    check_all(&layout, &s).unwrap();
    assert!(layout.stubs().is_empty());
    assert!(
        layout
            .edges()
            .iter()
            .any(|e| e.top_row == 1 && e.top_lane == 1 && e.bottom_lane == 0)
    );
}

#[test]
fn dangling_parent_with_collapse_is_stub() {
    // 스트림 밖 부모 9 는 항상 멀다 → Down(None) 스텁 + dangling
    let s = stream(&[(0, &[1, 9]), (1, &[])]);
    let layout = build_with(&s, opts(None, &[], Some(2)));
    check_all(&layout, &s).unwrap();
    let down = layout
        .stubs()
        .iter()
        .find(|s| s.dir == StubDir::Down)
        .unwrap();
    assert_eq!(down.other_row, None);
    assert_eq!(layout.dangling().len(), 1);
    assert!(layout.lane_count() == 1);
}

#[test]
fn window_includes_stubs_by_row_only() {
    let s = stream(&[
        (0, &[5]),
        (1, &[2]),
        (2, &[3]),
        (3, &[4]),
        (4, &[5]),
        (5, &[]),
    ]);
    let layout = build_with(&s, opts(None, &[], Some(2)));
    let w = layout.window(0, 1);
    assert_eq!(w.stubs.len(), 1);
    assert_eq!(w.stubs[0].row, 0);
    let w = layout.window(1, 3);
    assert!(w.stubs.is_empty());
    let w = layout.window(5, 1);
    assert_eq!(w.stubs.len(), 1);
    assert_eq!(w.stubs[0].dir, StubDir::Up);
}

#[test]
fn len_lags_by_n_until_finish() {
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[])]);
    let mut layout = mgit_graph::GraphLayout::with_options(opts(None, &[], Some(2)));
    for (o, ps) in &s {
        layout.push(*o, ps);
    }
    assert_eq!(layout.len(), 2);
    assert_eq!(layout.pushed(), 4);
    assert_eq!(layout.window(0, 10).rows.len(), 2);
    layout.finish();
    assert_eq!(layout.len(), 4);
    check_all(&layout, &s).unwrap();
}

// ───────────── 교차 ─────────────

#[test]
fn pinned_chain_far_first_parent_not_collapsed() {
    // 고정 커밋 0 의 첫 부모 5 가 멀어도 레인 0 이 이어진다 (스텁 없음)
    let s = stream(&[
        (0, &[5]),
        (1, &[2]),
        (2, &[3]),
        (3, &[4]),
        (4, &[5]),
        (5, &[]),
    ]);
    let layout = build_with(&s, opts(Some(0), &[], Some(2)));
    check_all(&layout, &s).unwrap();
    assert!(layout.stubs().is_empty());
    assert_eq!(layout.rows()[5].lane, 0);
    assert_eq!(layout.lane_count(), 2);
}

#[test]
fn far_join_into_virtual_pin_lane_is_stub() {
    // 고정 커밋 5 가 아직 안 왔는데 0 이 5 를 첫 부모로 멀리서 가리킴 → 레인 0 위에 긴 선 대신 스텁
    let s = stream(&[
        (0, &[5]),
        (1, &[2]),
        (2, &[3]),
        (3, &[4]),
        (4, &[5]),
        (5, &[]),
    ]);
    let layout = build_with(&s, opts(Some(5), &[], Some(2)));
    check_all(&layout, &s).unwrap();
    assert!(
        layout
            .stubs()
            .iter()
            .any(|s| s.dir == StubDir::Down && s.row == 0)
    );
    assert_eq!(layout.rows()[5].lane, 0);
    insta::assert_snapshot!(summary(&layout));
}

#[test]
fn ref_color_switch_on_pin_lane() {
    // 고정 체인(색 0) 위에서 release 팁 2(색 6)를 만나면 그 아래가 색 6 으로 바뀌고 레인은 0 그대로
    let s = stream(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[])]);
    let layout = build_with(&s, opts(Some(0), &[(0, 0), (2, 6)], None));
    check_all(&layout, &s).unwrap();
    assert!(layout.rows().iter().all(|r| r.lane == 0));
    assert_eq!(layout.rows()[1].color, 0);
    assert_eq!(layout.rows()[2].color, 6);
}

/// 첫 부모 합류로 레인이 닫힌 머지라도 둘째 부모 스텁은 그 행의 노드 색을 쓴다
#[test]
fn stub_of_later_parent_keeps_node_color_after_lane_closes() {
    // 행 1 머지: 첫 부모(2)는 행 0 의 레인이 기다려 레인이 닫히고, 둘째 부모(9)는 멀어 스텁이 된다
    let s = stream(&[
        (0, &[2]),
        (1, &[2, 9]),
        (2, &[3]),
        (3, &[4]),
        (4, &[5]),
        (5, &[6]),
        (6, &[7]),
        (7, &[8]),
        (8, &[9]),
        (9, &[]),
    ]);
    let layout = build_with(&s, opts(None, &[], Some(2)));
    check_all(&layout, &s).unwrap();
    let stub = layout
        .stubs()
        .iter()
        .find(|t| t.row == 1 && t.dir == StubDir::Down)
        .unwrap();
    assert_eq!(stub.color, layout.rows()[1].color);
    assert_ne!(stub.color, 0, "닫힌 레인의 기본값 0 이 아니어야 한다");
}
