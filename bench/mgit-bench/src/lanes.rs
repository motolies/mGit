//! 폴더 모드의 레인 수 분포 (W18, `--lanes`). 통합 타임라인은 저장소당 레인이 하나라 저장소가 많고 커밋이 고르게
//! 섞이면 그래프 열이 넓어진다. 화면 한 장(연속 50행)마다 보이는 레인 수를 재 분포를 낸다.
//!
//! 화면의 레인 수는 그래프 뷰(`packages/graph-view/src/GraphView.tsx`)가 열 폭을 정하는 방식과 같게 센다: 그 범위의
//! 행 노드 레인과 구간(segment) 레인의 최댓값 + 1. 그래프 뷰는 스크롤하며 본 최댓값을 줄이지 않으므로(단조 증가)
//! 처음부터 n행까지 훑었을 때의 최댓값도 함께 낸다. 열 폭(px) = min(레인, 24) × 14 + 8 (뷰의 기본 `laneWidth`·`laneCap`).
//!
//! 긴 엣지 접기 거리(`graph_long_edge_rows`)를 바꾼 경우도 벤치 안에서만 설정을 바꿔 잰다 (제품 설정은 그대로).
//! 접기 거리를 줄이면 레인 대신 스텁(끊긴 짧은 선)이 늘어나므로 50행당 스텁 수도 함께 낸다

use std::path::Path;
use std::sync::Arc;

use mgit_core::{CoreEvent, EventSink};
use serde_json::json;
use tokio::sync::mpsc;

use crate::Opts;
use crate::folder::{bench_core_with, median, wait_loaded};

/// 화면 한 장의 행 수
const SCREEN_ROWS: u32 = 50;
/// 견줄 긴 엣지 접기 거리 (첫 값이 제품 기본값 `CoreConfig::graph_long_edge_rows`)
const LONG_EDGE_ROWS: [u32; 4] = [40, 20, 10, 5];
/// 그래프 뷰의 기본 레인 폭·상한·여백 (px)
const LANE_WIDTH: u32 = 14;
const LANE_CAP: u32 = 24;
const GRAPH_PADDING: u32 = 8;

/// 레인 수의 그래프 열 폭 (px)
fn column_px(lanes: u32) -> u32 {
    lanes.clamp(1, LANE_CAP) * LANE_WIDTH + GRAPH_PADDING
}

/// 정렬된 값에서 분위수 (가장 가까운 순위)
fn percentile(sorted: &[u32], p: f64) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// 접기 거리 하나로 타임라인을 읽고 화면마다 레인 수·스텁 수를 센다
async fn measure(
    opts: &Opts,
    folder: &Path,
    long_edge_rows: u32,
) -> Result<serde_json::Value, String> {
    let core = bench_core_with(opts, |c| c.graph_long_edge_rows = long_edge_rows).await?;
    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });
    let opened = core
        .open_folder(folder, sink)
        .await
        .map_err(|e| e.to_string())?;
    let id = opened.session;
    core.folder_timeline_open(id).map_err(|e| e.to_string())?;
    let (rows, lane_count) = wait_loaded(&mut rx, id).await?;
    let mut lanes = Vec::new();
    let mut stubs = Vec::new();
    let mut start = 0;
    while start < rows {
        let w = core
            .folder_timeline_window(id, start, SCREEN_ROWS)
            .map_err(|e| e.to_string())?;
        let max_row = w.rows.iter().map(|r| r.lane).max().unwrap_or(0);
        let max_seg = w.segments.iter().map(|s| s.lane).max().unwrap_or(0);
        lanes.push(u32::from(max_row.max(max_seg)) + 1);
        stubs.push(w.stubs.len() as f64);
        start += SCREEN_ROWS;
    }
    core.close_folder(id).map_err(|e| e.to_string())?;
    // 처음부터 n행까지 훑었을 때 본 최댓값 (그래프 뷰의 열 폭은 줄지 않는다)
    let seen_until = |n: u32| {
        let screens = n.div_ceil(SCREEN_ROWS) as usize;
        lanes
            .iter()
            .take(screens.max(1))
            .copied()
            .max()
            .unwrap_or(0)
    };
    let mut sorted = lanes.clone();
    sorted.sort_unstable();
    let share_over = |limit: u32| {
        lanes.iter().filter(|&&l| l > limit).count() as f64 / lanes.len().max(1) as f64
    };
    let p50 = percentile(&sorted, 50.0);
    let p90 = percentile(&sorted, 90.0);
    let max = sorted.last().copied().unwrap_or(0);
    Ok(json!({
        "long_edge_rows": long_edge_rows,
        "rows": rows,
        "lane_count": lane_count,
        "screens": lanes.len(),
        "screen_lanes_p50": p50,
        "screen_lanes_p90": p90,
        "screen_lanes_p99": percentile(&sorted, 99.0),
        "screen_lanes_max": max,
        "column_px_p50": column_px(p50),
        "column_px_p90": column_px(p90),
        "column_px_max": column_px(max),
        "share_over_8": share_over(8),
        "share_over_13": share_over(13),
        "seen_first_screen": seen_until(SCREEN_ROWS),
        "seen_first_1000": seen_until(1_000),
        "seen_first_10000": seen_until(10_000),
        "seen_all": max,
        "stubs_per_screen_median": median(stubs),
    }))
}

/// 레인 측정 진입점: 접기 거리마다 한 번씩 재고 JSON 줄과 요약을 출력한다 (레이아웃은 결정적이라 반복하지 않는다)
pub async fn report(opts: &Opts, folder: &Path) {
    println!(
        "lanes folder={} screen_rows={SCREEN_ROWS} long_edge_rows={LONG_EDGE_ROWS:?}",
        folder.display()
    );
    for n in LONG_EDGE_ROWS {
        match measure(opts, folder, n).await {
            Ok(v) => {
                println!(
                    "레인 N={n}: 전체 {} | 화면당 p50 {} / p90 {} / p99 {} / 최대 {} (열 {}px / {}px / 최대 {}px) | 13 초과 화면 {:.1}% | 처음 1,000행 {} | 50행당 스텁 {}",
                    v["lane_count"],
                    v["screen_lanes_p50"],
                    v["screen_lanes_p90"],
                    v["screen_lanes_p99"],
                    v["screen_lanes_max"],
                    v["column_px_p50"],
                    v["column_px_p90"],
                    v["column_px_max"],
                    v["share_over_13"].as_f64().unwrap_or(0.0) * 100.0,
                    v["seen_first_1000"],
                    v["stubs_per_screen_median"],
                );
                println!("{}", json!({ "lanes": v }));
            }
            Err(e) => {
                eprintln!("레인 측정 N={n} 실패: {e}");
                std::process::exit(1);
            }
        }
    }
}
