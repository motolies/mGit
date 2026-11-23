//! proptest 불변식 I1~I13 (옵션 없음·옵션 포함)
#![allow(clippy::unwrap_used)]

mod common;

use std::collections::HashMap;

use common::{build, build_with, oid};
use mgit_graph::check::{brute_force_window, check_all};
use mgit_graph::{GraphLayout, LayoutOptions};
use mgit_model::Oid;
use proptest::prelude::*;

/// 임의 DAG 스트림. 커밋 i 의 부모는 i+1..n 에서 중복 없이 고르고, 5% 는 스트림 밖 oid
fn arb_stream() -> impl Strategy<Value = Vec<(Oid, Vec<Oid>)>> {
    (1u32..120).prop_flat_map(|n| {
        (0..n)
            .map(move |i| {
                let remaining = n - i - 1;
                // 부모 수 분포: 0=5%, 1=75%, 2=17%, 3~4=3%
                let k = prop_oneof![
                    5 => Just(0usize),
                    75 => Just(1usize),
                    17 => Just(2usize),
                    3 => 3usize..=4,
                ];
                let dangling = proptest::collection::vec(any::<bool>(), 0..5);
                (k, proptest::collection::vec(0u32..u32::MAX, 0..5), dangling).prop_map(
                    move |(k, picks, dang)| {
                        let mut parents: Vec<Oid> = Vec::new();
                        if remaining == 0 && k > 0 {
                            // 마지막 커밋: 부모는 스트림 밖뿐
                            if dang.first().copied().unwrap_or(false) {
                                parents.push(oid(n + 1000 + i));
                            }
                            return (oid(i), parents);
                        }
                        for (j, pick) in picks.iter().take(k).enumerate() {
                            let is_dangling =
                                dang.get(j).copied().unwrap_or(false) && pick.is_multiple_of(20);
                            let p = if is_dangling {
                                oid(n + 1000 + (pick % 7))
                            } else {
                                oid(i + 1 + (pick % remaining))
                            };
                            if !parents.contains(&p) {
                                parents.push(p);
                            }
                        }
                        (oid(i), parents)
                    },
                )
            })
            .collect::<Vec<_>>()
    })
}

/// 임의 옵션: 고정(없음·스트림 안·스트림 밖), 임의 ref 색 부분집합, 접기 거리 1..8
/// (시드, 고정 행, ref 색 목록, 접기 거리)
type OptionSpec = (u32, Option<u32>, Vec<(u32, u8)>, Option<u32>);

fn arb_options() -> impl Strategy<Value = OptionSpec> {
    (
        0u32..120,
        prop_oneof![
            4 => Just(None),
            4 => (0u32..120).prop_map(Some),
            1 => Just(Some(5000u32)),
        ],
        proptest::collection::vec((0u32..120, 0u8..10), 0..8),
        prop_oneof![
            1 => Just(None),
            2 => (1u32..8).prop_map(Some),
        ],
    )
}

/// 옵션 튜플을 스트림 길이에 맞춰 `LayoutOptions` 로 바꾼다
fn options_for(n: usize, (seed, pin, colors, collapse): &OptionSpec) -> LayoutOptions {
    let n = n.max(1) as u32;
    let pin = pin.map(|p| if p == 5000 { oid(5000) } else { oid(p % n) });
    let mut ref_colors: HashMap<Oid, u8> = colors.iter().map(|(i, c)| (oid(i % n), *c)).collect();
    if let Some(p) = pin
        && seed.is_multiple_of(2)
    {
        ref_colors.insert(p, 0);
    }
    LayoutOptions {
        pin,
        ref_colors,
        collapse_long_edges: *collapse,
        lane_color: None,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// I1~I5, I10
    #[test]
    fn invariants_hold(s in arb_stream()) {
        let layout = build(&s);
        check_all(&layout, &s).map_err(TestCaseError::fail).unwrap();
        prop_assert!(layout.lane_count() as usize <= s.len().max(1));
    }

    /// I1~I5, I10 + S1~S4, I11~I13 (옵션 포함)
    #[test]
    fn invariants_hold_with_options(s in arb_stream(), o in arb_options()) {
        let layout = build_with(&s, options_for(s.len(), &o));
        check_all(&layout, &s).map_err(TestCaseError::fail).unwrap();
    }

    /// I6: 결정성
    #[test]
    fn deterministic(s in arb_stream(), o in arb_options()) {
        let a = build_with(&s, options_for(s.len(), &o));
        let b = build_with(&s, options_for(s.len(), &o));
        prop_assert_eq!(a.rows(), b.rows());
        prop_assert_eq!(a.segments(), b.segments());
        prop_assert_eq!(a.edges(), b.edges());
        prop_assert_eq!(a.stubs(), b.stubs());
    }

    /// I8: window == 브루트포스 (finish 전·후 모두). 스트리밍 중엔 배정된 행만 보인다
    #[test]
    fn window_matches_brute_force(s in arb_stream(), o in arb_options(), start in 0u32..130, count in 0u32..64, cut in 0usize..130) {
        let mut layout = GraphLayout::with_options(options_for(s.len(), &o));
        let cut = cut.min(s.len());
        for (o, ps) in &s[..cut] {
            layout.push(*o, ps);
        }
        prop_assert!(layout.len() <= cut);
        let w = layout.window(start, count);
        let (segs, edges, stubs) = brute_force_window(&layout, start, count);
        prop_assert_eq!(&w.segments, &segs);
        prop_assert_eq!(&w.edges, &edges);
        prop_assert_eq!(&w.stubs, &stubs);

        for (o, ps) in &s[cut..] {
            layout.push(*o, ps);
        }
        layout.finish();
        let w = layout.window(start, count);
        let (segs, edges, stubs) = brute_force_window(&layout, start, count);
        prop_assert_eq!(&w.segments, &segs);
        prop_assert_eq!(&w.edges, &edges);
        prop_assert_eq!(&w.stubs, &stubs);
        let total = layout.len() as u32;
        let expect_rows = start.min(total).saturating_add(count).min(total).saturating_sub(start.min(total));
        prop_assert_eq!(w.rows.len() as u32, expect_rows);
    }

    /// I9: 배치를 어떻게 나눠도 결과가 같다 (선행 버퍼가 있어도 배정은 배치 경계와 무관)
    #[test]
    fn batch_split_equivalent(s in arb_stream(), o in arb_options(), cut in 0usize..130) {
        let whole = build_with(&s, options_for(s.len(), &o));
        let cut = cut.min(s.len());
        let mut split = GraphLayout::with_options(options_for(s.len(), &o));
        for (o, ps) in &s[..cut] { split.push(*o, ps); }
        let _ = split.window(0, 16); // 중간 조회가 상태를 바꾸지 않는지
        for (o, ps) in &s[cut..] { split.push(*o, ps); }
        split.finish();
        prop_assert_eq!(whole.rows(), split.rows());
        prop_assert_eq!(whole.segments(), split.segments());
        prop_assert_eq!(whole.edges(), split.edges());
        prop_assert_eq!(whole.stubs(), split.stubs());
    }
}

/// 회귀: 마지막 커밋의 첫 부모를 다른 레인이 이미 기다리면 합류 엣지가 마지막 행 아래를 가리켰다 (I4)
#[test]
fn last_row_merge_into_waiting_lane_leaves_no_edge() {
    let outside = oid(999);
    let s = vec![(oid(0), vec![oid(1), outside]), (oid(1), vec![outside])];
    let layout = build(&s);
    check_all(&layout, &s).unwrap();
    assert!(
        layout
            .edges()
            .iter()
            .all(|e| e.top_row + 1 < layout.len() as u32)
    );
}
