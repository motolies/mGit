//! 폴더 모드의 읽기 경합 측정 (계획 3라운드 "배경 읽기와 조작 읽기의 동시 실행 한도 분리", 반응성 슬라이스 12).
//!
//! 배경 묶음 읽기(전체 갱신 = 요약 + 브랜치 + 변경을 동시에, 통합 타임라인 재로드)를 시작하고 `DELAYS_MS` 뒤에 사용자 조작
//! 읽기 하나(경로순 첫 저장소의 `folder_commit_detail` — 커밋을 눌렀을 때 화면이 기다리는 것, git 2개를 차례로)를 보내
//! 그 응답 시간을 잰다. 같은 실행 안에서 한가할 때의 같은 호출을 바로 앞에 재 견준다. 커밋은 매번 다른 것(`main~k`)을
//! 고른다. 첫 상세 요청이 만드는 타임라인 자식 색인은 측정 전에 한 번 만들어 둔다 (git 이 아닌 계산이 섞이지 않게).
//! 응답 시간은 셋으로 가른다: 읽기 permit 대기(명령 로그의 시간 − 러너의 실행 시간), git 실행(러너가 permit 을 얻은 뒤
//! 잰 시간 — `mgit_git` 의 "git run" 추적 이벤트를 이 모듈의 작은 구독자가 받는다), 나머지(코어 계산·스케줄링).
//! 타임라인 재로드 뒤 첫 상세 요청은 자식 색인을 다시 만들므로, 재로드 표본 뒤에는 상세를 한 번 더 불러 데운다.
//! 저장소를 바꾸지 않는다 (읽기만)

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use mgit_core::{Core, CoreEvent, EventSink, Oid, SessionId};
use tokio::sync::mpsc;

use crate::Opts;
use crate::folder::{
    bench_core, command_count, commands_since, elapsed_ms, median, probe_oid, wait_loaded,
    wait_reloaded,
};

/// 배경 읽기를 시작한 뒤 조작 읽기를 보내기까지의 간격
const DELAYS_MS: [u64; 3] = [5, 20, 50];
/// 배경 읽기 종류
const BACKGROUNDS: [Background; 2] = [Background::Refresh, Background::TimelineReload];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Background {
    /// 전체 갱신 한 번 (프런트의 `reload('all')` — 창 포커스·주기·새로고침)
    Refresh,
    /// 통합 타임라인 재로드 (ref 변경·필터 변경 뒤)
    TimelineReload,
}

impl Background {
    /// 출력용 이름
    fn label(self) -> &'static str {
        match self {
            Background::Refresh => "refresh",
            Background::TimelineReload => "timeline_reload",
        }
    }
}

/// 러너의 "git run" 추적 이벤트에서 (인자 표시 → 실행 시간들)을 모은다. 인자에 커밋 해시가 든 명령만 남긴다
#[derive(Default)]
struct ExecLog {
    by_args: Mutex<HashMap<String, Vec<u64>>>,
}

/// 전역 기록 (구독자는 프로세스에 하나)
fn exec_log() -> &'static ExecLog {
    static LOG: OnceLock<ExecLog> = OnceLock::new();
    LOG.get_or_init(ExecLog::default)
}

/// 이벤트 필드 읽개
#[derive(Default)]
struct RunFields {
    message: String,
    args: String,
    elapsed_ms: Option<u64>,
}

impl tracing::field::Visit for RunFields {
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "elapsed_ms" {
            self.elapsed_ms = Some(value);
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" => {
                let _ = write!(self.message, "{value:?}");
            }
            "args" => {
                let _ = write!(self.args, "{value:?}");
            }
            _ => {}
        }
    }
}

/// `mgit_git` 의 추적 이벤트만 받는 최소 구독자
struct RunRecorder;

impl tracing::Subscriber for RunRecorder {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target().starts_with("mgit_git")
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut fields = RunFields::default();
        event.record(&mut fields);
        if fields.message != "git run" {
            return;
        }
        if let Some(ms) = fields.elapsed_ms {
            exec_log()
                .by_args
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(fields.args)
                .or_default()
                .push(ms);
        }
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// 그 커밋 해시를 인자로 단 명령들의 러너 실행 시간 합 (ms). 기록은 비운다
fn take_exec_ms(hex: &str) -> f64 {
    let mut map = exec_log()
        .by_args
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let keys: Vec<String> = map.keys().filter(|k| k.contains(hex)).cloned().collect();
    let mut sum = 0;
    for key in keys {
        sum += map.remove(&key).unwrap_or_default().iter().sum::<u64>();
    }
    map.clear();
    sum as f64
}

/// 조작 읽기 한 번의 결과: 응답 시간, 명령 로그의 시간 합(permit 대기 포함), 러너 실행 시간 합(permit 뒤)
#[derive(Clone, Copy)]
struct Op {
    ms: f64,
    logged_ms: f64,
    exec_ms: f64,
}

impl Op {
    /// 읽기 permit 을 기다린 시간
    fn permit_wait_ms(self) -> f64 {
        self.logged_ms - self.exec_ms
    }
}

/// 한 번의 표본: 한가할 때의 조작 읽기, 배경 읽기 도중의 조작 읽기, 그 배경 읽기 전체 시간
struct Sample {
    background: Background,
    delay_ms: u64,
    idle: Op,
    busy: Op,
    background_ms: f64,
}

/// 조작 읽기 한 번 (커밋 상세)
async fn interactive(
    core: &Core,
    session: SessionId,
    repo: &Path,
    oid: &Oid,
) -> Result<Op, String> {
    let before = command_count(core);
    let t = Instant::now();
    core.folder_commit_detail(session, repo, oid)
        .await
        .map_err(|e| e.to_string())?;
    let ms = elapsed_ms(t);
    // 이 커밋 해시를 인자로 단 명령은 이 조작 읽기의 것뿐이다 (배경 읽기는 커밋 해시를 넘기지 않는다)
    let hex = oid.to_hex();
    let logged: u32 = commands_since(core, before)
        .iter()
        .filter(|r| r.args.iter().any(|a| a.contains(&hex)))
        .map(|r| r.elapsed_ms)
        .sum();
    Ok(Op {
        ms,
        logged_ms: f64::from(logged),
        exec_ms: take_exec_ms(&hex),
    })
}

/// 전체 갱신 한 번 (요약 + 브랜치 + 변경, 동시)
async fn refresh(core: &Core, session: SessionId) -> Result<(), String> {
    let (s, b, c) = tokio::join!(
        core.folder_summaries(session, &[]),
        core.folder_branches(session, &[]),
        core.folder_changes(session, &[]),
    );
    s.map_err(|e| e.to_string())?;
    b.map_err(|e| e.to_string())?;
    c.map_err(|e| e.to_string())?;
    Ok(())
}

/// 배경 읽기를 시작하고 `delay` 뒤 조작 읽기를 보낸다. (조작 읽기, 배경 읽기 시간)
async fn under_background(
    core: &Core,
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
    repo: &Path,
    oid: &Oid,
    background: Background,
    delay: Duration,
) -> Result<(Op, f64), String> {
    let start = Instant::now();
    let probe = async {
        tokio::time::sleep(delay).await;
        interactive(core, session, repo, oid).await
    };
    match background {
        Background::Refresh => {
            let bg = async {
                refresh(core, session).await?;
                Ok::<_, String>(elapsed_ms(start))
            };
            let (op, bg) = tokio::join!(probe, bg);
            Ok((op?, bg?))
        }
        Background::TimelineReload => {
            core.folder_timeline_reload(session)
                .map_err(|e| e.to_string())?;
            let bg = async {
                wait_reloaded(rx, session).await?;
                Ok::<_, String>(elapsed_ms(start))
            };
            let (op, bg) = tokio::join!(probe, bg);
            Ok((op?, bg?))
        }
    }
}

/// 한 번 잰다: 코어를 새로 만들어 폴더를 열고 타임라인을 다 읽은 뒤, 배경 종류 × 간격마다 한가할 때 → 배경 도중 순으로
/// 잰다. 끝에 조작 읽기 없는 전체 갱신의 시간을 하나 더 잰다 (`delay_ms == u64::MAX` 표본)
async fn run_once(opts: &Opts, folder: &Path, round: usize) -> Result<Vec<Sample>, String> {
    let core = bench_core(opts).await?;
    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });
    let opened = core
        .open_folder(folder, sink)
        .await
        .map_err(|e| e.to_string())?;
    let id = opened.session;
    let first = opened
        .repos
        .iter()
        .map(|r| r.path.clone())
        .min()
        .ok_or_else(|| "저장소가 없음".to_string())?;
    core.folder_timeline_open(id).map_err(|e| e.to_string())?;
    wait_loaded(&mut rx, id).await?;
    // 데우기: 전체 갱신 한 번(저장소 판별·파일 캐시), 커밋 상세 한 번(타임라인 자식 색인)
    refresh(&core, id).await?;
    let warm = probe_oid(&first, &["rev-parse", "main~1"]).ok_or("main~1 없음")?;
    interactive(&core, id, &first, &warm).await?;

    let mut samples = Vec::new();
    let mut k = 10 + round * 40;
    for background in BACKGROUNDS {
        for delay in DELAYS_MS {
            let idle_oid =
                probe_oid(&first, &["rev-parse", &format!("main~{k}")]).ok_or("커밋 없음")?;
            let busy_oid =
                probe_oid(&first, &["rev-parse", &format!("main~{}", k + 1)]).ok_or("커밋 없음")?;
            k += 2;
            // 앞 표본의 배경 작업·감시 이벤트가 가라앉게 잠깐 쉰 뒤 한가할 때를 잰다
            tokio::time::sleep(Duration::from_millis(300)).await;
            let idle = interactive(&core, id, &first, &idle_oid).await?;
            let (busy, background_ms) = under_background(
                &core,
                &mut rx,
                id,
                &first,
                &busy_oid,
                background,
                Duration::from_millis(delay),
            )
            .await?;
            samples.push(Sample {
                background,
                delay_ms: delay,
                idle,
                busy,
                background_ms,
            });
            if background == Background::TimelineReload {
                // 재로드한 타임라인의 자식 색인을 다시 만들어 둔다 (다음 한가할 때 표본에 섞이지 않게)
                interactive(&core, id, &first, &warm).await?;
            }
        }
    }
    // 배경 읽기만의 시간 (조작 읽기 없이) — 조작 읽기가 배경 읽기를 늦추는지 견준다
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    refresh(&core, id).await?;
    let alone = elapsed_ms(t);
    let none = Op {
        ms: f64::NAN,
        logged_ms: f64::NAN,
        exec_ms: f64::NAN,
    };
    samples.push(Sample {
        background: Background::Refresh,
        delay_ms: u64::MAX,
        idle: none,
        busy: none,
        background_ms: alone,
    });
    core.close_folder(id).map_err(|e| e.to_string())?;
    Ok(samples)
}

/// 시스템 부하 평균 (1·5·15분). 읽지 못하면 "?"
fn load_average() -> String {
    let out = std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    out.or_else(|| std::fs::read_to_string("/proc/loadavg").ok())
        .map(|s| s.trim().trim_matches(['{', '}']).trim().to_string())
        .unwrap_or_else(|| "?".into())
}

/// 최댓값
fn max(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::NAN, f64::max)
}

/// 읽기 경합 측정 진입점: `--runs` 번 재고 배경 종류 × 간격마다 조작 읽기의 중앙값·최댓값을 한가할 때와 견준다
pub async fn report(opts: &Opts, folder: &Path) {
    println!(
        "contention folder={} runs={} max_reads={} max_bulk_reads={} slow_status_ms={} load_avg_before=[{}]",
        folder.display(),
        opts.runs,
        opts.max_reads
            .unwrap_or(mgit_git::RunnerConfig::default().max_concurrent_reads),
        opts.max_bulk_reads
            .unwrap_or(mgit_git::RunnerConfig::default().max_concurrent_bulk_reads),
        opts.slow_status_ms.unwrap_or(0),
        load_average()
    );
    // 러너의 실행 시간(permit 뒤)을 받는다. 이미 다른 구독자가 있으면(테스트 등) 실행 시간을 0 으로 본다
    let _ = tracing::subscriber::set_global_default(RunRecorder);
    let mut all = Vec::new();
    for round in 0..opts.runs as usize {
        match run_once(opts, folder, round).await {
            Ok(samples) => {
                for s in samples.iter().filter(|s| s.delay_ms != u64::MAX) {
                    println!(
                        "contention run {}: {} +{}ms → detail idle={:.1}ms (permit 대기 {:.1} / git {:.1}) busy={:.1}ms (permit 대기 {:.1} / git {:.1}) background={:.0}ms",
                        round + 1,
                        s.background.label(),
                        s.delay_ms,
                        s.idle.ms,
                        s.idle.permit_wait_ms(),
                        s.idle.exec_ms,
                        s.busy.ms,
                        s.busy.permit_wait_ms(),
                        s.busy.exec_ms,
                        s.background_ms
                    );
                }
                all.extend(samples);
            }
            Err(e) => {
                eprintln!("contention run {} 실패: {e}", round + 1);
                std::process::exit(1);
            }
        }
    }
    let measured: Vec<&Sample> = all.iter().filter(|s| s.delay_ms != u64::MAX).collect();
    let mut rows = Vec::new();
    for background in BACKGROUNDS {
        let own: Vec<&&Sample> = measured
            .iter()
            .filter(|s| s.background == background)
            .collect();
        let idle_median = median(own.iter().map(|s| s.idle.ms).collect());
        let idle_exec = median(own.iter().map(|s| s.idle.exec_ms).collect());
        let idle_wait = median(own.iter().map(|s| s.idle.permit_wait_ms()).collect());
        println!(
            "contention {} 한가할 때 커밋 상세: 중앙값 {idle_median:.1}ms (permit 대기 {idle_wait:.1}ms, git {idle_exec:.1}ms)",
            background.label()
        );
        for delay in DELAYS_MS {
            let of: Vec<&&&Sample> = own.iter().filter(|s| s.delay_ms == delay).collect();
            let busy_median = median(of.iter().map(|s| s.busy.ms).collect());
            let busy_max = max(of.iter().map(|s| s.busy.ms));
            let wait_median = median(of.iter().map(|s| s.busy.permit_wait_ms()).collect());
            let wait_max = max(of.iter().map(|s| s.busy.permit_wait_ms()));
            let exec_median = median(of.iter().map(|s| s.busy.exec_ms).collect());
            let bg_median = median(of.iter().map(|s| s.background_ms).collect());
            println!(
                "contention {} +{delay}ms: 커밋 상세 중앙값 {busy_median:.1}ms (한가할 때의 {:.1}배) — permit 대기 {wait_median:.1}ms (최대 {wait_max:.1}), git {exec_median:.1}ms / 최댓값 {busy_max:.1}ms, 배경 읽기 중앙값 {bg_median:.0}ms",
                background.label(),
                busy_median / idle_median
            );
            rows.push(serde_json::json!({
                "background": background.label(),
                "delay_ms": delay,
                "detail_idle_ms_median": idle_median,
                "detail_busy_ms_median": busy_median,
                "detail_busy_ms_max": busy_max,
                "detail_permit_wait_ms_median": wait_median,
                "detail_permit_wait_ms_max": wait_max,
                "detail_exec_ms_median": exec_median,
                "background_ms_median": bg_median,
            }));
        }
    }
    let alone = median(
        all.iter()
            .filter(|s| s.delay_ms == u64::MAX)
            .map(|s| s.background_ms)
            .collect(),
    );
    println!("contention 전체 갱신만(조작 읽기 없이): 중앙값 {alone:.0}ms");
    println!("contention load_avg_after=[{}]", load_average());
    println!(
        "{}",
        serde_json::json!({ "contention": {
            "max_reads": opts.max_reads.unwrap_or(mgit_git::RunnerConfig::default().max_concurrent_reads),
            "max_bulk_reads": opts.max_bulk_reads.unwrap_or(mgit_git::RunnerConfig::default().max_concurrent_bulk_reads),
            "refresh_alone_ms_median": alone,
            "cases": rows,
        }})
    );
}
