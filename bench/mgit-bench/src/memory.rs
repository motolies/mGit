//! 폴더 모드의 메모리 분해 (W18, `--memory`). W16 에서 필터를 걸 때 RSS 가 240~329MB 까지 오른 까닭을 나눠 잰다.
//!
//! 한 프로세스에서 이어 재면 앞 구간이 놓아준 메모리를 할당자가 쥐고 있어(다음 구간이 그 자리를 다시 쓴다) 구간별
//! 최댓값이 섞인다. 그래서 단계마다 이 벤치 바이너리를 새 프로세스로 띄워(`--memory-phase <단계>`) 한 단계만 재고,
//! 부모가 결과(JSON 한 줄)를 모은다. 단계:
//!
//! - `load`: 폴더를 열고 타임라인(20만 행)을 처음 읽는다 — 데이터가 없는 상태에서 새 데이터 + 저장소별 레코드
//! - `reload`: 다 읽은 뒤 같은 질의로 재로드 — 옛 데이터가 살아 있는 채 새 데이터 + 레코드를 만든다
//! - `small_to_big`: 저장소 1개 범위로 읽은 뒤(1만 행) 전부로 넓힌다 — 옛 데이터가 작은 재로드 (reload 와 견주면
//!   옛 데이터의 몫이 나온다)
//! - `text_few`·`text_many`·`hash`: W16 의 필터 경우 (`hash` 는 해시 패스로 저장소마다 로그를 한 번 더 받는다 —
//!   결과 수가 비슷한 `text_few` 와 견준다)
//! - `repeat`: W16 처럼 필터 재로드와 되돌리기를 이어서 12번 — 재로드마다 RSS 가 계속 오르는지(누수) 멈추는지(할당자 보유)
//! - `cycles`: 코어를 새로 만들어 열기 → 다 읽기 → 닫기 → 코어 버리기를 5번 — 닫은 뒤 메모리가 돌아오는지
//!
//! 부모는 단계와 별개로 저장소마다 타임라인과 같은 `git log` 를 직접 돌려 출력 크기(바이트)와 파싱한 레코드의 힙 크기
//! 어림값(문자열·부모 목록의 용량 합)을 센다 — 재로드 중 함께 살아 있는 저장소별 출력 버퍼·레코드의 크기다

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mgit_core::{CommitFilter, Core, CoreEvent, EventSink, GraphQuery, GraphSort, SessionId};
use mgit_git::cmd::graph_log_request_with;
use mgit_git::parse::LogParser;
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::{CommitRecord, EnvProfile, GitRunner, Oid};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::folder::{
    RSS_LIMIT_MB, RssSampler, bench_core, median, text_filter, timeline_query, wait_loaded,
    wait_reloaded,
};
use crate::{Opts, core_config, rss_mb};

/// 단계 이름 (자식 프로세스의 `--memory-phase` 값)
const PHASES: [&str; 8] = [
    "load",
    "reload",
    "small_to_big",
    "text_few",
    "text_many",
    "hash",
    "repeat",
    "cycles",
];
/// 자식이 결과 줄 앞에 붙이는 표식
const RESULT_MARK: &str = "MEMORY_PHASE ";
/// 구간이 끝난 뒤 RSS 를 읽기 전에 기다리는 시간 (해제·감시 태스크 정리)
const SETTLE: Duration = Duration::from_millis(300);
/// 타임라인 저장소당 상한 + 1 (코어가 넘침을 보려고 하나 더 받는다)
const LOG_MAX: u32 = 10_001;

/// 측정용 폴더 세션 (이벤트 수신기 포함)
struct Opened {
    id: SessionId,
    rx: mpsc::UnboundedReceiver<CoreEvent>,
    /// 경로순 첫 저장소
    first: PathBuf,
    repos: Vec<PathBuf>,
}

/// 폴더를 연다 (타임라인은 열지 않는다)
async fn open(core: &Core, folder: &Path) -> Result<Opened, String> {
    let (tx, rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });
    let opened = core
        .open_folder(folder, sink)
        .await
        .map_err(|e| e.to_string())?;
    let repos: Vec<PathBuf> = opened.repos.iter().map(|r| r.path.clone()).collect();
    let first = repos
        .iter()
        .min()
        .cloned()
        .ok_or_else(|| "저장소가 없음".to_string())?;
    Ok(Opened {
        id: opened.session,
        rx,
        first,
        repos,
    })
}

/// 질의를 바꾸고 재로드를 기다린다
async fn query_reload(core: &Core, o: &mut Opened, query: GraphQuery) -> Result<u32, String> {
    core.folder_timeline_query_set(o.id, query)
        .await
        .map_err(|e| e.to_string())?;
    wait_reloaded(&mut o.rx, o.id).await
}

/// 해시 필터의 검색어: 맨 위 101행 중 마지막 행 해시의 앞 10자 (W16 필터 측정과 같은 대상)
fn hash_query(core: &Core, id: SessionId) -> Result<GraphQuery, String> {
    let top = core
        .folder_timeline_window(id, 0, 101)
        .map_err(|e| e.to_string())?;
    let hash = top
        .rows
        .last()
        .map(|r| r.oid.to_hex()[..10].to_string())
        .ok_or("타임라인이 비었음")?;
    Ok(timeline_query(text_filter(&hash)))
}

/// 잠시 기다린 뒤 RSS (MB)
async fn settled_rss() -> f64 {
    tokio::time::sleep(SETTLE).await;
    rss_mb()
}

/// 할당자가 보는 힙: 살아 있는 할당의 바이트(MB)와 할당자가 쥐고 있지만 비어 있는 몫(조각, MB), 커널이 세는
/// 물리 사용량(physical footprint — 활성 상태 보기의 "메모리". 재사용 표시된 해제 페이지는 빠진다)과 그 최고치
#[derive(Clone, Copy)]
struct HeapStats {
    allocated_mb: f64,
    frag_mb: f64,
    footprint_mb: f64,
    footprint_peak_mb: f64,
}

/// `vmmap` 의 크기 표기(`816K`, `37.2M`, `3312`)를 MB 로
fn vmmap_size_mb(text: &str) -> Option<f64> {
    let (num, unit) = match text.chars().last()? {
        'K' => (&text[..text.len() - 1], 1.0 / 1024.0),
        'M' => (&text[..text.len() - 1], 1.0),
        'G' => (&text[..text.len() - 1], 1024.0),
        _ => (text, 1.0 / (1024.0 * 1024.0)),
    };
    num.parse::<f64>().ok().map(|n| n * unit)
}

/// 이 프로세스의 malloc 영역 합계를 macOS `vmmap -summary` 로 읽는다 (RSS 와 달리 살아 있는 할당만 센다 — 누수와
/// 할당자 보유를 가른다). 도구가 없거나(다른 OS) 읽지 못하면 `None`
fn heap_stats() -> Option<HeapStats> {
    let out = std::process::Command::new("vmmap")
        .args(["-summary", &std::process::id().to_string()])
        .output()
        .ok()?;
    // 원인 추적용: 환경 변수로 준 폴더에 측정점마다 vmmap 전체 출력을 남긴다 (영역 종류별 증감 비교)
    if let Some(dir) = std::env::var_os("MGIT_BENCH_VMMAP_DIR") {
        static POINT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = POINT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = std::fs::write(
            Path::new(&dir).join(format!("point-{n:02}.txt")),
            &out.stdout,
        );
    }
    parse_vmmap(&String::from_utf8_lossy(&out.stdout))
}

/// `vmmap -summary` 출력의 malloc 영역 표에서 마지막 `TOTAL` 줄을 읽는다: 가상·상주·더티·스왑 크기, 할당 수,
/// 할당 바이트, 조각 크기, 조각 %, 영역 수
fn parse_vmmap(text: &str) -> Option<HeapStats> {
    // 머리의 "Physical footprint:" / "Physical footprint (peak):" 줄
    let footprint = |label: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(label))
            .and_then(|v| vmmap_size_mb(v.trim()))
    };
    // 앞의 영역 표에도 "see MALLOC ZONE table below" 가 있으므로 마지막 표 머리 뒤를 본다
    let (_, zones) = text.rsplit_once("MALLOC ZONE")?;
    let total = zones.lines().rev().find(|l| l.starts_with("TOTAL"))?;
    let cols: Vec<&str> = total.split_whitespace().collect();
    Some(HeapStats {
        allocated_mb: vmmap_size_mb(cols.get(6)?)?,
        frag_mb: vmmap_size_mb(cols.get(7)?)?,
        footprint_mb: footprint("Physical footprint:")?,
        footprint_peak_mb: footprint("Physical footprint (peak):")?,
    })
}

/// 잠시 기다린 뒤 RSS 와 힙 (JSON: rss, heap, frag)
async fn settled_point() -> Value {
    let rss = settled_rss().await;
    let heap = heap_stats();
    json!({
        "rss": rss,
        "heap": heap.map(|h| h.allocated_mb),
        "frag": heap.map(|h| h.frag_mb),
        "footprint": heap.map(|h| h.footprint_mb),
        "footprint_peak": heap.map(|h| h.footprint_peak_mb),
    })
}

/// 자식 프로세스: 단계 하나를 재고 결과를 JSON 한 줄로 출력한다
pub async fn run_phase(opts: &Opts, folder: &Path, phase: &str) {
    match phase_once(opts, folder, phase).await {
        Ok(v) => println!("{RESULT_MARK}{v}"),
        Err(e) => {
            eprintln!("memory phase {phase} 실패: {e}");
            std::process::exit(1);
        }
    }
}

/// 단계 하나. 공통으로 `base`(코어를 만든 직후), `load_peak`·`loaded`(타임라인 첫 로드의 최댓값·끝난 뒤),
/// `action_peak`·`after`(단계 동작의 최댓값·끝난 뒤)를 싣는다
async fn phase_once(opts: &Opts, folder: &Path, phase: &str) -> Result<Value, String> {
    if phase == "cycles" {
        return cycles(opts, folder).await;
    }
    let core = bench_core(opts).await?;
    let base = rss_mb();
    let sampler = RssSampler::start();
    let mut o = open(&core, folder).await?;
    if phase == "small_to_big" {
        core.folder_timeline_scope_set(o.id, std::slice::from_ref(&o.first))
            .map_err(|e| e.to_string())?;
    } else {
        core.folder_timeline_open(o.id).map_err(|e| e.to_string())?;
    }
    let rows_loaded = wait_loaded(&mut o.rx, o.id).await?.0;
    let load_peak = sampler.peak();
    let loaded_point = settled_point().await;
    let loaded = loaded_point["rss"].as_f64().unwrap_or(f64::NAN);
    sampler.reset();
    let mut series = Vec::new();
    let rows_after = match phase {
        "load" => rows_loaded,
        "reload" => {
            core.folder_timeline_reload(o.id)
                .map_err(|e| e.to_string())?;
            wait_reloaded(&mut o.rx, o.id).await?
        }
        "small_to_big" => {
            core.folder_timeline_scope_set(o.id, &[])
                .map_err(|e| e.to_string())?;
            wait_reloaded(&mut o.rx, o.id).await?
        }
        "text_few" => query_reload(&core, &mut o, timeline_query(text_filter("search"))).await?,
        "text_many" => query_reload(&core, &mut o, timeline_query(text_filter("change"))).await?,
        "hash" => {
            let q = hash_query(&core, o.id)?;
            query_reload(&core, &mut o, q).await?
        }
        "repeat" => {
            // 짝 수(필터 → 되돌리기)는 기본 6. 증가가 멈추는지 길게 볼 때만 환경 변수로 늘린다
            let pairs: usize = std::env::var("MGIT_BENCH_REPEAT_PAIRS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(6);
            let mut rows = 0;
            for _ in 0..pairs {
                query_reload(&core, &mut o, timeline_query(text_filter("change"))).await?;
                series.push(settled_point().await);
                rows = query_reload(&core, &mut o, timeline_query(CommitFilter::default())).await?;
                series.push(settled_point().await);
            }
            rows
        }
        other => return Err(format!("모르는 단계: {other}")),
    };
    let action_peak = sampler.peak();
    let after_point = settled_point().await;
    core.close_folder(o.id).map_err(|e| e.to_string())?;
    drop(core);
    let closed_point = settled_point().await;
    sampler.finish();
    Ok(json!({
        "phase": phase,
        "base": base,
        "rows_loaded": rows_loaded,
        "load_peak": load_peak,
        "loaded": loaded,
        "loaded_heap": loaded_point["heap"],
        "loaded_footprint": loaded_point["footprint"],
        "loaded_footprint_peak": loaded_point["footprint_peak"],
        "rows_after": rows_after,
        "action_peak": action_peak,
        "after": after_point["rss"],
        "after_heap": after_point["heap"],
        "after_footprint": after_point["footprint"],
        "after_footprint_peak": after_point["footprint_peak"],
        "closed": closed_point["rss"],
        "closed_heap": closed_point["heap"],
        "closed_frag": closed_point["frag"],
        "series": series,
    }))
}

/// `cycles` 단계: 코어를 새로 만들어 열기 → 다 읽기 → 닫기 → 버리기를 5번, 매번 RSS·힙
async fn cycles(opts: &Opts, folder: &Path) -> Result<Value, String> {
    let base = rss_mb();
    let mut series = Vec::new();
    for _ in 0..5 {
        let core = bench_core(opts).await?;
        let mut o = open(&core, folder).await?;
        core.folder_timeline_open(o.id).map_err(|e| e.to_string())?;
        wait_loaded(&mut o.rx, o.id).await?;
        core.close_folder(o.id).map_err(|e| e.to_string())?;
        drop(core);
        series.push(settled_point().await);
    }
    Ok(json!({ "phase": "cycles", "base": base, "series": series }))
}

/// 저장소 하나의 타임라인 로그 출력 크기와 레코드 힙 어림값
struct LogSize {
    stdout_bytes: usize,
    records: usize,
    record_heap_bytes: usize,
}

/// 레코드 하나가 힙에서 차지하는 어림값: 구조체 + 문자열 3개·부모 목록의 용량 (할당자 반올림·머리 미포함)
fn record_heap(r: &CommitRecord) -> usize {
    std::mem::size_of::<CommitRecord>()
        + r.author_name.capacity()
        + r.author_email.capacity()
        + r.subject.capacity()
        + r.parents.capacity() * std::mem::size_of::<Oid>()
}

/// 저장소마다 타임라인과 같은 `git log`(날짜순, 상한 + 1)를 돌려 출력 크기와 레코드 크기를 센다
async fn log_sizes(opts: &Opts, folder: &Path) -> Result<Vec<LogSize>, String> {
    let core = bench_core(opts).await?;
    let o = open(&core, folder).await?;
    let repos = o.repos.clone();
    core.close_folder(o.id).map_err(|e| e.to_string())?;
    let runner = TokioGitRunner::new(RunnerConfig::default())
        .await
        .map_err(|e| e.to_string())?;
    let overrides = core_config(opts).git_config_overrides;
    let query = GraphQuery {
        sort: GraphSort::Date,
        ..GraphQuery::default()
    };
    let mut out = Vec::new();
    for repo in repos {
        let req = graph_log_request_with(&repo, &overrides, &query, Some(LOG_MAX))
            .with_env(EnvProfile::ReadInteractive);
        let res = runner.run(req).await.map_err(|e| e.to_string())?;
        let mut parser = LogParser::new();
        let records = parser.feed(&res.stdout).map_err(|e| e.to_string())?;
        parser.finish().map_err(|e| e.to_string())?;
        out.push(LogSize {
            stdout_bytes: res.stdout.len(),
            records: records.len(),
            record_heap_bytes: records.capacity() * std::mem::size_of::<CommitRecord>()
                + records.iter().map(record_heap).sum::<usize>()
                - records.len() * std::mem::size_of::<CommitRecord>(),
        });
    }
    Ok(out)
}

/// 자식 프로세스로 단계 하나를 돌려 결과를 받는다
fn spawn_phase(opts: &Opts, folder: &Path, phase: &str) -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--folder")
        .arg(folder)
        .args(["--memory-phase", phase]);
    if opts.no_commit_graph {
        cmd.arg("--no-commit-graph");
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix(RESULT_MARK))
        .ok_or("결과 줄이 없음")?;
    serde_json::from_str(line).map_err(|e| e.to_string())
}

/// MB 값 꺼내기
fn mb(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// 부모: 단계마다 `--runs` 번 자식 프로세스를 띄워 재고 중앙값과 분해를 출력한다
pub async fn report(opts: &Opts, folder: &Path) {
    println!(
        "memory folder={} commit_graph={} runs={}",
        folder.display(),
        !opts.no_commit_graph,
        opts.runs
    );
    match log_sizes(opts, folder).await {
        Ok(sizes) => {
            let total_out: usize = sizes.iter().map(|s| s.stdout_bytes).sum();
            let mut by_size: Vec<usize> = sizes.iter().map(|s| s.stdout_bytes).collect();
            by_size.sort_unstable_by(|a, b| b.cmp(a));
            let top8: usize = by_size.iter().take(8).sum();
            let records: usize = sizes.iter().map(|s| s.records).sum();
            let heap: usize = sizes.iter().map(|s| s.record_heap_bytes).sum();
            let mib = |b: usize| b as f64 / (1024.0 * 1024.0);
            println!(
                "memory log_sizes: repos={} records={} stdout 합 {:.1}MiB (동시 8개 최대 {:.1}MiB) records 힙 어림 {:.1}MiB ({:.0}B/커밋)",
                sizes.len(),
                records,
                mib(total_out),
                mib(top8),
                mib(heap),
                heap as f64 / records.max(1) as f64
            );
            println!(
                "{}",
                json!({ "memory_log_sizes": {
                    "repos": sizes.len(),
                    "records": records,
                    "stdout_mib_total": mib(total_out),
                    "stdout_mib_top8": mib(top8),
                    "record_heap_mib": mib(heap),
                }})
            );
        }
        Err(e) => eprintln!("memory log_sizes 실패: {e}"),
    }
    let mut medians = serde_json::Map::new();
    for phase in PHASES {
        let mut runs = Vec::new();
        for i in 0..opts.runs {
            match spawn_phase(opts, folder, phase) {
                Ok(v) => {
                    println!("memory {phase} run {}: {v}", i + 1);
                    runs.push(v);
                }
                Err(e) => {
                    eprintln!("memory {phase} run {} 실패: {e}", i + 1);
                    std::process::exit(1);
                }
            }
        }
        let keys: &[&str] = if phase == "cycles" {
            &["base"]
        } else {
            &[
                "base",
                "load_peak",
                "loaded",
                "loaded_heap",
                "loaded_footprint",
                "loaded_footprint_peak",
                "action_peak",
                "after",
                "after_heap",
                "after_footprint",
                "after_footprint_peak",
                "closed",
                "closed_heap",
                "closed_frag",
            ]
        };
        let mut m = serde_json::Map::new();
        for key in keys {
            m.insert(
                (*key).to_string(),
                json!(median(runs.iter().map(|v| mb(v, key)).collect())),
            );
        }
        // 이어진 값(series: 점마다 rss·heap·frag)은 칸·항목마다 중앙값
        let len = runs
            .iter()
            .filter_map(|v| v.get("series").and_then(Value::as_array).map(Vec::len))
            .min()
            .unwrap_or(0);
        let series: Vec<Value> = (0..len)
            .map(|i| {
                let at = |key: &str| {
                    median(
                        runs.iter()
                            .filter_map(|v| v.get("series").and_then(Value::as_array))
                            .filter_map(|s| s.get(i).and_then(|p| p.get(key)?.as_f64()))
                            .collect(),
                    )
                };
                json!({
                    "rss": at("rss"),
                    "heap": at("heap"),
                    "frag": at("frag"),
                    "footprint": at("footprint"),
                })
            })
            .collect();
        m.insert("series".to_string(), json!(series));
        println!("memory {phase}(중앙값): {}", Value::Object(m.clone()));
        medians.insert(phase.to_string(), Value::Object(m));
    }
    // 분해: 같은 새 데이터를 만드는 재로드끼리 견주면 옛 데이터의 몫, 결과가 비슷한 필터끼리 견주면 해시 패스의 몫이 나온다
    let get = |phase: &str, key: &str| {
        medians
            .get(phase)
            .and_then(|v| v.get(key))
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    };
    let steady = get("load", "loaded");
    let reload_peak = get("reload", "action_peak");
    let s2b_peak = get("small_to_big", "action_peak");
    println!(
        "memory 분해(MB): 정상 상태(20만 행 읽은 뒤) {steady:.0} (≤{RSS_LIMIT_MB:.0}) {} | 첫 로드 최댓값 {:.0} | 재로드 최댓값 {reload_peak:.0} (옛 데이터 작은 재로드 {s2b_peak:.0} → 옛 데이터 몫 {:.0}) | text_few {:.0} / hash {:.0} (해시 패스 몫 {:.0}) / text_many {:.0} | 닫은 뒤 {:.0} (시작 {:.0})",
        crate::folder::verdict(steady <= RSS_LIMIT_MB),
        get("load", "load_peak"),
        reload_peak - s2b_peak,
        get("text_few", "action_peak"),
        get("hash", "action_peak"),
        get("hash", "action_peak") - get("text_few", "action_peak"),
        get("text_many", "action_peak"),
        get("reload", "closed"),
        get("reload", "base"),
    );
    println!(
        "memory 힙(MB, vmmap 의 malloc 할당 바이트): 20만 행 읽은 뒤 {:.0} | 재로드 뒤 {:.0} | 닫고 코어를 버린 뒤 {:.0} (조각 {:.0})",
        get("load", "loaded_heap"),
        get("reload", "after_heap"),
        get("reload", "closed_heap"),
        get("reload", "closed_frag"),
    );
    println!(
        "memory 물리 사용량(MB, physical footprint): 20만 행 읽은 뒤 {:.0} (최고 {:.0}) | 재로드 뒤 {:.0} (최고 {:.0}) | text_many 뒤 최고 {:.0} | hash 뒤 최고 {:.0}",
        get("load", "loaded_footprint"),
        get("load", "loaded_footprint_peak"),
        get("reload", "after_footprint"),
        get("reload", "after_footprint_peak"),
        get("text_many", "after_footprint_peak"),
        get("hash", "after_footprint_peak"),
    );
    println!("{}", json!({ "memory": Value::Object(medians) }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `vmmap -summary` 의 malloc 영역 표에서 할당 바이트·조각 크기를, 머리에서 physical footprint 를 MB 로 읽는다
    #[test]
    fn reads_malloc_zone_totals() {
        let text = "\
Physical footprint:         28.7M
Physical footprint (peak):  29.0M
Malloc Small                      20.0M    8352K    8352K       0K       0K       0K       0K        7         see MALLOC ZONE table below
TOTAL                            386.9G    85.5M    3120K       0K       0K      16K       0K      371

                                 VIRTUAL   RESIDENT      DIRTY    SWAPPED ALLOCATION      BYTES DIRTY+SWAP          REGION
MALLOC ZONE                         SIZE       SIZE       SIZE       SIZE      COUNT  ALLOCATED  FRAG SIZE  % FRAG   COUNT
===========                      =======  =========  =========  =========  =========  =========  =========  ======  ======
DefaultMallocZone_0x1052f8000      69.3M      27.7M      27.7M         0K      45223       9.8M      17.9M     65%      22
===========                      =======  =========  =========  =========  =========  =========  =========  ======  ======
TOTAL                              69.3M      27.8M      27.8M         0K      45633       9.8M      17.9M     65%      24
";
        let h = parse_vmmap(text).expect("표를 읽는다");
        assert!((h.allocated_mb - 9.8).abs() < 1e-9);
        assert!((h.frag_mb - 17.9).abs() < 1e-9);
        assert!((h.footprint_mb - 28.7).abs() < 1e-9);
        assert!((h.footprint_peak_mb - 29.0).abs() < 1e-9);
        assert_eq!(vmmap_size_mb("816K"), Some(816.0 / 1024.0));
        assert_eq!(vmmap_size_mb("1048576"), Some(1.0));
        assert_eq!(vmmap_size_mb("1.5G"), Some(1536.0));
    }
}
