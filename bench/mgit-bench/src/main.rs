//! 벤치 하네스. 모드는 다섯이다.
//!
//! - 저장소 모드(PoC-1): 대형 저장소에서 첫 청크·전체 로드 시간, 윈도 지연, 메모리를 잰다.
//!   `--filters` 면 대신 해시 패스의 추가 시간을 잰다 (W18, `repo_filters` 모듈).
//! - 폴더 모드(W0): 저장소 여러 개가 든 폴더를 여는 경로를 잰다 (`folder` 모듈, W18 측정은 `w18` 모듈).
//!   `--memory` 면 메모리 분해(`memory`), `--lanes` 면 화면당 레인 수 분포(`lanes`)만 잰다.
//! - 파일 트리 모드(W18): 큰 디렉터리 나열·1 MiB 파일 읽기 (`fs` 모듈).
//! - stage 모드(W18): 변경 파일이 많은 저장소의 폴더 stage·unstage (`stage` 모듈).
//! - tags 모드(TG-17): 원격 tag 조회·비교·보고서 크기, `RefsChanged` 기준선, 일괄 push·원격 삭제 (`tags` 모듈).
//!
//! ```text
//! cargo run --release -p mgit-bench -- --repo bench/repos/git [--no-commit-graph] [--window 500] [--runs 3] [--filters]
//! cargo run --release -p mgit-bench -- --folder bench/repos/folder-20x10000 [--no-commit-graph] [--runs 3] [--memory | --lanes]
//! cargo run --release -p mgit-bench -- --fs bench/repos/fs-50000 [--runs 5]
//! cargo run --release -p mgit-bench -- --stage bench/repos/stage-5000 [--runs 3]
//! cargo run --release -p mgit-bench -- --tags bench/repos/tags-10000 [--runs 5] [--write-runs N] [--one-chunk-runs N] [--write-limit N]
//! ```
//! 통과 기준(명세 PoC-1): commit-graph 있음 기준 첫 화면 1초 이하, RSS 500MB 이하.

mod folder;
mod fs;
mod lanes;
mod memory;
mod repo_filters;
mod stage;
mod tags;
mod w18;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mgit_core::{Core, CoreConfig, CoreEvent, EventSink};
use mgit_git::{RunnerConfig, TokioGitRunner};
use tokio::sync::mpsc;

/// 명령줄 옵션. `repo`·`folder`·`fs`·`stage`·`tags` 중 정확히 하나를 준다
struct Opts {
    repo: PathBuf,
    folder: Option<PathBuf>,
    fs: Option<PathBuf>,
    stage: Option<PathBuf>,
    /// tags 모드: `bench/setup.sh tags N` 픽스처 폴더
    tags: Option<PathBuf>,
    no_commit_graph: bool,
    window: u32,
    runs: u32,
    /// 저장소 모드: 해시 패스 측정
    filters: bool,
    /// 폴더 모드: 메모리 분해만
    memory: bool,
    /// 폴더 모드: 메모리 분해의 단계 하나 (부모가 띄우는 자식 프로세스용)
    memory_phase: Option<String>,
    /// 폴더 모드: 레인 수 분포만
    lanes: bool,
    /// tags 모드: 일괄 push·삭제 반복 수 (없으면 `runs`, 0 이면 건너뜀)
    write_runs: Option<u32>,
    /// tags 모드: 청크 없는 비교 반복 수 (없으면 `write_runs`, 0 이면 건너뜀)
    one_chunk_runs: Option<u32>,
    /// tags 모드: 이보다 큰 일괄 묶음은 재지 않는다
    write_limit: Option<usize>,
}

/// 인자를 파싱한다. 잘못되면 사용법을 출력하고 종료
fn parse_opts() -> Opts {
    let mut opts = Opts {
        repo: PathBuf::new(),
        folder: None,
        fs: None,
        stage: None,
        tags: None,
        no_commit_graph: false,
        window: 500,
        runs: 3,
        filters: false,
        memory: false,
        memory_phase: None,
        lanes: false,
        write_runs: None,
        one_chunk_runs: None,
        write_limit: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--repo" => opts.repo = PathBuf::from(args.next().unwrap_or_default()),
            "--folder" => opts.folder = args.next().map(PathBuf::from),
            "--fs" => opts.fs = args.next().map(PathBuf::from),
            "--stage" => opts.stage = args.next().map(PathBuf::from),
            "--tags" => opts.tags = args.next().map(PathBuf::from),
            "--no-commit-graph" => opts.no_commit_graph = true,
            "--window" => opts.window = args.next().and_then(|v| v.parse().ok()).unwrap_or(500),
            "--runs" => opts.runs = args.next().and_then(|v| v.parse().ok()).unwrap_or(3),
            "--filters" => opts.filters = true,
            "--memory" => opts.memory = true,
            "--memory-phase" => opts.memory_phase = args.next(),
            "--lanes" => opts.lanes = true,
            "--write-runs" => opts.write_runs = args.next().and_then(|v| v.parse().ok()),
            "--one-chunk-runs" => opts.one_chunk_runs = args.next().and_then(|v| v.parse().ok()),
            "--write-limit" => opts.write_limit = args.next().and_then(|v| v.parse().ok()),
            _ => usage(),
        }
    }
    let modes = [
        !opts.repo.as_os_str().is_empty(),
        opts.folder.is_some(),
        opts.fs.is_some(),
        opts.stage.is_some(),
        opts.tags.is_some(),
    ];
    if modes.iter().filter(|&&m| m).count() != 1 {
        usage();
    }
    opts
}

/// 사용법 출력 후 종료
fn usage() -> ! {
    eprintln!(
        "usage: mgit-bench (--repo <path> [--window N] [--filters] | --folder <path> [--memory | --lanes] | --fs <path> | --stage <path> | --tags <path> [--write-runs N] [--one-chunk-runs N] [--write-limit N]) [--no-commit-graph] [--runs N]"
    );
    std::process::exit(2)
}

/// 현재 프로세스 RSS (MB)
fn rss_mb() -> f64 {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem as f64 / (1024.0 * 1024.0))
        .unwrap_or(f64::NAN)
}

/// 두 모드가 함께 쓰는 코어 설정 (`--no-commit-graph` 반영)
fn core_config(opts: &Opts) -> CoreConfig {
    let mut cfg = CoreConfig::default();
    if opts.no_commit_graph {
        cfg.git_config_overrides
            .push(("core.commitGraph".into(), "false".into()));
    }
    cfg
}

/// 한 번 측정한 결과
struct RunResult {
    first_chunk_ms: f64,
    finished_ms: f64,
    rows: u32,
    lane_count: u16,
    segments: usize,
    edges: usize,
    window_top_us: f64,
    window_mid_us: f64,
    rss_before_mb: f64,
    rss_after_mb: f64,
}

/// 저장소를 한 번 열어 끝까지 로드하고 수치를 잰다
async fn run_once(opts: &Opts) -> Result<RunResult, String> {
    let runner = TokioGitRunner::new(RunnerConfig::default())
        .await
        .map_err(|e| e.to_string())?;
    let core = Core::new(Arc::new(runner), core_config(opts));
    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });

    let rss_before_mb = rss_mb();
    let t0 = Instant::now();
    let opened = core
        .open_repo(&opts.repo, sink)
        .await
        .map_err(|e| e.to_string())?;

    let mut first_chunk_ms = f64::NAN;
    let mut finished_ms = f64::NAN;
    let mut rows = 0;
    let mut lane_count = 0;
    let deadline = tokio::time::timeout(Duration::from_secs(600), async {
        while let Some(e) = rx.recv().await {
            match e {
                CoreEvent::GraphFirstChunk { .. } => {
                    first_chunk_ms = t0.elapsed().as_secs_f64() * 1e3;
                }
                CoreEvent::GraphLoadFinished {
                    rows: r,
                    lane_count: l,
                    ..
                } => {
                    finished_ms = t0.elapsed().as_secs_f64() * 1e3;
                    rows = r;
                    lane_count = l;
                    return Ok(());
                }
                CoreEvent::GraphLoadFailed { message, .. } => return Err(message),
                _ => {}
            }
        }
        Err("이벤트 채널이 닫힘".to_string())
    });
    deadline.await.map_err(|_| "시간 초과".to_string())??;

    let t = Instant::now();
    let top = core
        .graph_window(opened.session, 0, opts.window)
        .map_err(|e| e.to_string())?;
    let window_top_us = t.elapsed().as_secs_f64() * 1e6;
    let t = Instant::now();
    let mid = core
        .graph_window(opened.session, rows / 2, opts.window)
        .map_err(|e| e.to_string())?;
    let window_mid_us = t.elapsed().as_secs_f64() * 1e6;
    let rss_after_mb = rss_mb();

    // 구간·엣지 수는 윈도가 아니라 전체가 필요하므로 끝에서 끝까지 큰 창으로 센다
    let (segments, edges) = count_layout(&core, opened.session, rows, opts.window);
    let _ = (top.rows.len(), mid.rows.len());
    Ok(RunResult {
        first_chunk_ms,
        finished_ms,
        rows,
        lane_count,
        segments,
        edges,
        window_top_us,
        window_mid_us,
        rss_before_mb,
        rss_after_mb,
    })
}

/// 전체 레이아웃의 구간·엣지 수를 윈도를 훑어 센다 (청크 경계에서 잘린 구간은 중복 계산되므로 근사치)
fn count_layout(
    core: &Core,
    session: mgit_core::SessionId,
    rows: u32,
    window: u32,
) -> (usize, usize) {
    let mut segments = 0;
    let mut edges = 0;
    let step = window.max(1);
    let mut start = 0;
    while start < rows {
        if let Ok(w) = core.graph_window(session, start, step) {
            segments += w.segments.iter().filter(|s| !s.continues_up).count();
            edges += w.edges.iter().filter(|e| e.top_row >= start).count();
        }
        start += step;
    }
    (segments, edges)
}

/// 진입점: 인자에 따라 모드를 고른다
#[tokio::main]
async fn main() {
    let opts = parse_opts();
    if let Some(folder) = &opts.folder {
        match (&opts.memory_phase, opts.memory, opts.lanes) {
            (Some(phase), _, _) => memory::run_phase(&opts, folder, phase).await,
            (None, true, _) => memory::report(&opts, folder).await,
            (None, false, true) => lanes::report(&opts, folder).await,
            (None, false, false) => folder::run(&opts, folder).await,
        }
    } else if let Some(root) = &opts.fs {
        fs::run(&opts, root).await;
    } else if let Some(folder) = &opts.stage {
        stage::run(&opts, folder).await;
    } else if let Some(fixture) = &opts.tags {
        tags::run(&opts, fixture).await;
    } else if opts.filters {
        repo_filters::report(&opts, &opts.repo).await;
    } else {
        run_repo_mode(&opts).await;
    }
}

/// 저장소 모드(PoC-1): `--runs` 번 재고 최솟값과 통과 여부를 출력한다
async fn run_repo_mode(opts: &Opts) {
    println!(
        "repo={} commit_graph={} window={} runs={}",
        opts.repo.display(),
        !opts.no_commit_graph,
        opts.window,
        opts.runs
    );
    let mut all = Vec::new();
    for i in 0..opts.runs {
        match run_once(opts).await {
            Ok(r) => {
                println!(
                    "run {}: first_chunk={:.0}ms finished={:.0}ms rows={} lanes={} segments≈{} edges={} window_top={:.0}µs window_mid={:.0}µs rss={:.0}→{:.0}MB",
                    i + 1,
                    r.first_chunk_ms,
                    r.finished_ms,
                    r.rows,
                    r.lane_count,
                    r.segments,
                    r.edges,
                    r.window_top_us,
                    r.window_mid_us,
                    r.rss_before_mb,
                    r.rss_after_mb
                );
                all.push(r);
            }
            Err(e) => {
                eprintln!("run {} 실패: {e}", i + 1);
                std::process::exit(1);
            }
        }
    }
    if all.is_empty() {
        return;
    }
    let best_first = all
        .iter()
        .map(|r| r.first_chunk_ms)
        .fold(f64::INFINITY, f64::min);
    let best_finished = all
        .iter()
        .map(|r| r.finished_ms)
        .fold(f64::INFINITY, f64::min);
    let max_rss = all.iter().map(|r| r.rss_after_mb).fold(0.0, f64::max);
    let pass_first = best_first <= 1000.0;
    let pass_rss = max_rss <= 500.0;
    // 폴더 모드·W18 표와 같은 통계로도 견줄 수 있게 중앙값을 함께 낸다 (판정은 PoC-1 그대로 최솟값)
    let med = |f: fn(&RunResult) -> f64| folder::median(all.iter().map(f).collect());
    let summary = serde_json::json!({
        "rows": all[0].rows,
        "lane_count": all[0].lane_count,
        "commit_graph": !opts.no_commit_graph,
        "first_chunk_ms_min": best_first,
        "finished_ms_min": best_finished,
        "first_chunk_ms_median": med(|r| r.first_chunk_ms),
        "finished_ms_median": med(|r| r.finished_ms),
        "window_top_us_median": med(|r| r.window_top_us),
        "window_mid_us_median": med(|r| r.window_mid_us),
        "rss_first_run_mb": all[0].rss_after_mb,
        "rss_mb_max": max_rss,
        "pass_first_chunk": pass_first,
        "pass_rss": pass_rss,
    });
    println!("{summary}");
    println!(
        "PoC-1 {}: first_chunk {:.0}ms (≤1000) {}, rss {:.0}MB (≤500) {}",
        if pass_first && pass_rss {
            "PASS"
        } else {
            "FAIL"
        },
        best_first,
        if pass_first { "ok" } else { "over" },
        max_rss,
        if pass_rss { "ok" } else { "over" }
    );
}
