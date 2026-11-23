//! 테스트 공용: 인덱스로 결정적 Oid 를 만들고 손 DAG 를 레이아웃에 넣는다
#![allow(dead_code)]

use std::collections::HashMap;

use mgit_graph::{GraphLayout, LayoutOptions};
use mgit_model::Oid;

/// 인덱스 `i` 를 20바이트에 박은 결정적 Oid
pub fn oid(i: u32) -> Oid {
    let mut b = [0u8; 20];
    b[16..].copy_from_slice(&i.to_be_bytes());
    Oid::from_bytes(b)
}

/// `(행 인덱스, 부모 인덱스들)` 손 DAG 를 스트림으로 바꾼다
pub fn stream(dag: &[(u32, &[u32])]) -> Vec<(Oid, Vec<Oid>)> {
    dag.iter()
        .map(|(i, ps)| (oid(*i), ps.iter().map(|p| oid(*p)).collect()))
        .collect()
}

/// 스트림을 전부 push 하고 finish 한 레이아웃 (옵션 없음)
pub fn build(stream: &[(Oid, Vec<Oid>)]) -> GraphLayout {
    build_with(stream, LayoutOptions::default())
}

/// 옵션을 적용해 스트림을 전부 push 하고 finish 한 레이아웃
pub fn build_with(stream: &[(Oid, Vec<Oid>)], opts: LayoutOptions) -> GraphLayout {
    let mut layout = GraphLayout::with_options(opts);
    for (o, ps) in stream {
        layout.push(*o, ps);
    }
    layout.finish();
    layout
}

/// `(행 인덱스, 색)` 목록 → ref 색 맵
pub fn colors(list: &[(u32, u8)]) -> HashMap<Oid, u8> {
    list.iter().map(|(i, c)| (oid(*i), *c)).collect()
}

/// 옵션 묶음: 고정 행 인덱스, ref 색, 접기 거리
pub fn opts(pin: Option<u32>, ref_colors: &[(u32, u8)], collapse: Option<u32>) -> LayoutOptions {
    LayoutOptions {
        pin: pin.map(oid),
        ref_colors: colors(ref_colors),
        collapse_long_edges: collapse,
        lane_color: None,
    }
}
