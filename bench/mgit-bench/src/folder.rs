//! 폴더 모드 (W0 측정 기준선): 저장소 여러 개가 든 폴더를 여는 경로의 시간·메모리·git 명령 수를 잰다.
//!
//! ```text
//! cargo run --release -p mgit-bench -- --folder bench/repos/folder-20x10000 [--no-commit-graph] [--runs 3]
//! ```
//! 합격선(계획 5.8절 제안값): `open_folder` 2초(저장소 50개), 요약 전체 2초(20개),
//! 브랜치 목록 1초(20개), 타임라인 열기 → 완료 2초(20개 × 1만 커밋), RSS 300MB(20만 행),
//! 포함 브랜치(W9) 1초 또는 시간 상한(10초) 안(원격 브랜치 수백 개), 가벼운 세션 생성(W13) 300ms(1개),
//! 필터 질의·저장소 범위·작성자 후보(W16) 타임라인 열기와 같은 2초 (기본 측정 뒤 따로 잰다).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mgit_core::{
    CommandLogRecord, CommitFilter, Core, CoreEvent, EventSink, GraphQuery, GraphSort, Oid,
    SessionId, TextFilter,
};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::MemoryStore;
use mgit_watch::NotifyWatcher;
use tokio::sync::mpsc;

use crate::{Opts, core_config, rss_mb};

/// 합격선 (ms·MB)
const OPEN_FOLDER_LIMIT_MS: f64 = 2000.0;
pub(crate) const SUMMARIES_LIMIT_MS: f64 = 2000.0;
const BRANCHES_LIMIT_MS: f64 = 1000.0;
pub(crate) const TIMELINE_LIMIT_MS: f64 = 2000.0;
pub(crate) const RSS_LIMIT_MB: f64 = 300.0;
const CONTAINS_LIMIT_MS: f64 = 1000.0;
const LIGHT_OPEN_LIMIT_MS: f64 = 300.0;
/// RSS 표본 간격
const RSS_SAMPLE_INTERVAL: Duration = Duration::from_millis(5);

/// 측정 구간 동안 RSS 를 주기적으로 읽어 최댓값을 잡는다.
/// 로드가 끝난 뒤의 값만 보면 로드 중 잠깐 쥐는 `git log` 출력 버퍼가 빠진다
pub(crate) struct RssSampler {
    stop: Arc<AtomicBool>,
    /// 지금까지의 최댓값 (f64 비트). 구간을 나눠 잴 때 `reset` 으로 지금 값에서 다시 시작한다
    peak: Arc<AtomicU64>,
    handle: JoinHandle<()>,
}

impl RssSampler {
    /// 표본 스레드를 띄운다
    pub(crate) fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicU64::new(rss_mb().to_bits()));
        let flag = Arc::clone(&stop);
        let max = Arc::clone(&peak);
        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                std::thread::sleep(RSS_SAMPLE_INTERVAL);
                let now = rss_mb();
                // 지금 값이 더 클 때만 바꾼다. 다른 스레드가 먼저 바꿨으면 그 값으로 다시 비교한다
                let mut cur = max.load(Ordering::Relaxed);
                while now > f64::from_bits(cur) {
                    match max.compare_exchange_weak(
                        cur,
                        now.to_bits(),
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(actual) => cur = actual,
                    }
                }
            }
        });
        RssSampler { stop, peak, handle }
    }

    /// 지금까지의 최댓값 (MB). 표본은 계속 돈다
    pub(crate) fn peak(&self) -> f64 {
        f64::from_bits(self.peak.load(Ordering::Relaxed)).max(rss_mb())
    }

    /// 최댓값을 지금 RSS 로 되돌린다 (다음 구간을 따로 잰다)
    pub(crate) fn reset(&self) {
        self.peak.store(rss_mb().to_bits(), Ordering::Relaxed);
    }

    /// 표본을 멈추고 최댓값(MB)을 돌려준다
    pub(crate) fn finish(self) -> f64 {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.handle.join();
        f64::from_bits(self.peak.load(Ordering::Relaxed))
    }
}

/// 포함 브랜치 측정 대상: 첫 저장소의 루트 커밋(가장 오래됨), main 끝(가장 최신), 머지하지 않은 브랜치 끝
/// (HEAD 에서 닿지 않아 HEAD 확인이 한 번 더 돈다)
const CONTAINS_PROBES: [(&str, &[&str]); 3] = [
    ("oldest", &["rev-list", "--max-parents=0", "main"]),
    ("newest", &["rev-parse", "main"]),
    ("side", &["rev-parse", "feature/search"]),
];

/// 포함 브랜치 한 번의 결과
struct ContainsProbe {
    label: &'static str,
    ms: f64,
    /// 포함 브랜치 수 (HEAD 제외)
    branches: usize,
    head: bool,
    timed_out: bool,
    cmds: usize,
}

/// 가벼운 세션 열기 한 번과, 비교로 같은 저장소를 탭(전체 프로필)으로 연 결과 (W13)
struct LightProbe {
    /// `folder_open_repo_session` 호출부터 반환까지
    light_ms: f64,
    light_cmds: usize,
    /// `open_repo` 호출부터 반환까지 (그래프 로드는 뒤에서 돈다)
    full_open_ms: f64,
    /// `open_repo` 호출부터 `GraphLoadFinished` 수신까지
    full_loaded_ms: f64,
    /// `open_repo` 부터 그래프 로드 완료까지의 git 명령 수
    full_cmds: usize,
}

/// 필터 질의 하나의 결과 (W16): 질의·범위를 바꾼 때부터 타임라인 재로드 완료까지
struct FilterProbe {
    label: &'static str,
    ms: f64,
    rows: u32,
    cmds: usize,
    /// 걸러진 결과가 저장소당 상한을 넘은 저장소 수
    truncated: usize,
}

/// 작성자 후보 조회 한 번의 결과 (W16)
struct AuthorsProbe {
    label: &'static str,
    ms: f64,
    authors: usize,
    cmds: usize,
    timed_out: bool,
}

/// 구간 하나에서 돈 저장소 판별(`rev-parse --show-toplevel … --git-common-dir`)의 수와 실행 시간 합 (W18).
/// 실행 시간은 명령 로그의 ms 단위 값의 합이라 동시에 돈 구간에서는 벽시계 시간보다 크다
#[derive(Clone, Copy, Default)]
pub(crate) struct DiscoverShare {
    pub(crate) count: usize,
    pub(crate) sum_ms: u64,
}

impl DiscoverShare {
    /// 명령 기록들에서 판별만 센다
    pub(crate) fn of(records: &[CommandLogRecord]) -> Self {
        let found = records.iter().filter(|r| is_discover(r));
        DiscoverShare {
            count: found.clone().count(),
            sum_ms: found.map(|r| u64::from(r.elapsed_ms)).sum(),
        }
    }
}

/// 저장소 판별 명령인지 (`mgit_git::cmd::discover` 의 인자)
pub(crate) fn is_discover(r: &CommandLogRecord) -> bool {
    let has = |a: &str| r.args.iter().any(|x| x == a);
    has("rev-parse") && has("--show-toplevel") && has("--git-common-dir")
}

/// `git status` 명령인지
pub(crate) fn is_status(r: &CommandLogRecord) -> bool {
    r.args.iter().any(|x| x == "status")
}

/// 한 번 측정한 결과
struct FolderRun {
    repos: usize,
    open_ms: f64,
    summaries_ms: f64,
    summary_errors: usize,
    branches_ms: f64,
    branch_count: usize,
    branch_errors: usize,
    timeline_ms: f64,
    rows: u32,
    lane_count: u16,
    timeline_errors: usize,
    truncated: usize,
    cmds_open: usize,
    cmds_summaries: usize,
    cmds_branches: usize,
    cmds_timeline: usize,
    /// 구간별 저장소 판별 (open / summaries / branches / timeline, W18)
    discover: [DiscoverShare; 4],
    rss_peak_mb: f64,
    contains: Vec<ContainsProbe>,
    light: LightProbe,
}

/// 필터 측정 한 번의 결과 (W16)
struct FilterRun {
    filters: Vec<FilterProbe>,
    authors: Vec<AuthorsProbe>,
    /// 타임라인 열기 + 필터 재로드 여러 번 동안의 RSS 최댓값 (참고값)
    rss_peak_mb: f64,
}

impl FolderRun {
    /// 네 구간에서 실행된 git 명령 수 합계
    fn cmds_total(&self) -> usize {
        self.cmds_open + self.cmds_summaries + self.cmds_branches + self.cmds_timeline
    }
}

/// 지금까지 코어가 실행한 git 명령 수 (코어의 명령 로그 기준)
pub(crate) fn command_count(core: &Core) -> usize {
    core.command_log_recent(usize::MAX).len()
}

/// 명령 로그에서 앞의 `before` 개 뒤에 기록된 명령들 (실행 순서)
pub(crate) fn commands_since(core: &Core, before: usize) -> Vec<CommandLogRecord> {
    let mut all = core.command_log_recent(usize::MAX);
    all.truncate(all.len().saturating_sub(before));
    all.reverse();
    all
}

/// 경과 시간 (ms)
pub(crate) fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e3
}

/// 그래프 로드 완료 이벤트(통합 타임라인·저장소 세션 공용)를 기다려 (행 수, 레인 수)를 돌려준다
pub(crate) async fn wait_loaded(
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
) -> Result<(u32, u16), String> {
    let wait = tokio::time::timeout(Duration::from_secs(600), async {
        while let Some(e) = rx.recv().await {
            match e {
                CoreEvent::GraphLoadFinished {
                    session: s,
                    rows,
                    lane_count,
                    ..
                } if s == session => return Ok((rows, lane_count)),
                CoreEvent::GraphLoadFailed {
                    session: s,
                    message,
                    ..
                } if s == session => return Err(message),
                _ => {}
            }
        }
        Err("이벤트 채널이 닫힘".to_string())
    });
    wait.await.map_err(|_| "시간 초과".to_string())?
}

/// 타임라인 재로드 완료 이벤트를 기다려 행 수를 돌려준다
pub(crate) async fn wait_reloaded(
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
) -> Result<u32, String> {
    let wait = tokio::time::timeout(Duration::from_secs(600), async {
        while let Some(e) = rx.recv().await {
            if let CoreEvent::GraphReloaded {
                session: s, rows, ..
            } = e
                && s == session
            {
                return Ok(rows);
            }
        }
        Err("이벤트 채널이 닫힘".to_string())
    });
    wait.await.map_err(|_| "시간 초과".to_string())?
}

/// 필터 측정의 바뀌는 쪽: 질의(필터) 또는 저장소 범위
enum FilterCase {
    Query(GraphQuery),
    Scope(Vec<PathBuf>),
}

/// 날짜순 + 필터 질의 (타임라인 기본 정렬)
pub(crate) fn timeline_query(filter: CommitFilter) -> GraphQuery {
    GraphQuery {
        sort: GraphSort::Date,
        filter,
        ..GraphQuery::default()
    }
}

/// 글자 그대로·대소문자 무시 텍스트 필터
pub(crate) fn text_filter(pattern: &str) -> CommitFilter {
    CommitFilter {
        text: TextFilter {
            pattern: pattern.into(),
            regex: false,
            match_case: false,
        },
        ..CommitFilter::default()
    }
}

/// 필터 질의마다 타임라인 재로드 시간·git 명령 수를 잰다 (W16). 합성 폴더의 메시지·작성자 기준:
/// `search`(저장소당 3개), `change`(거의 전부), 작성자 `mina`(1/5), 최근 7일, 저장소 3개 범위, 해시 접두(텍스트 +
/// 해시 패스). 끝나면 기본 질의·전체 범위로 되돌리고, 작성자 후보를 테이블(필터 없음)·git(필터 있음)로 잰다
async fn measure_filters(
    core: &Core,
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
    repos: &[PathBuf],
) -> Result<(Vec<FilterProbe>, Vec<AuthorsProbe>), String> {
    let top = core
        .folder_timeline_window(session, 0, 101)
        .map_err(|e| e.to_string())?;
    let newest = top.rows.first().map(|r| r.commit_time).unwrap_or(0);
    let hash = top
        .rows
        .last()
        .map(|r| r.oid.to_hex()[..10].to_string())
        .unwrap_or_default();
    let cases: Vec<(&'static str, FilterCase)> = vec![
        (
            "text_few",
            FilterCase::Query(timeline_query(text_filter("search"))),
        ),
        (
            "text_many",
            FilterCase::Query(timeline_query(text_filter("change"))),
        ),
        (
            "author",
            FilterCase::Query(timeline_query(CommitFilter {
                authors: vec!["mina@example.invalid".into()],
                ..CommitFilter::default()
            })),
        ),
        (
            "date_7d",
            FilterCase::Query(timeline_query(CommitFilter {
                since: Some(newest - 7 * 24 * 3600),
                ..CommitFilter::default()
            })),
        ),
        (
            "hash",
            FilterCase::Query(timeline_query(text_filter(&hash))),
        ),
        (
            "scope_3",
            FilterCase::Scope(repos.iter().take(3).cloned().collect()),
        ),
    ];
    let mut probes = Vec::new();
    for (label, case) in cases {
        let before = command_count(core);
        let t = Instant::now();
        match &case {
            FilterCase::Query(q) => core
                .folder_timeline_query_set(session, q.clone())
                .await
                .map_err(|e| e.to_string())?,
            FilterCase::Scope(paths) => core
                .folder_timeline_scope_set(session, paths)
                .map_err(|e| e.to_string())?,
        }
        let rows = wait_reloaded(rx, session).await?;
        let ms = elapsed_ms(t);
        let cmds = command_count(core) - before;
        let info = core
            .folder_timeline_info(session)
            .map_err(|e| e.to_string())?;
        probes.push(FilterProbe {
            label,
            ms,
            rows,
            cmds,
            truncated: info.repos.iter().filter(|r| r.truncated).count(),
        });
        // 다음 측정을 위해 기본 질의·전체 범위로 되돌린다
        match case {
            FilterCase::Query(_) => core
                .folder_timeline_query_set(session, timeline_query(CommitFilter::default()))
                .await
                .map_err(|e| e.to_string())?,
            FilterCase::Scope(_) => core
                .folder_timeline_scope_set(session, &[])
                .map_err(|e| e.to_string())?,
        }
        wait_reloaded(rx, session).await?;
    }

    // 작성자 후보: 필터 없는 타임라인이면 테이블에서, 필터가 걸려 있으면 저장소마다 git
    let mut authors = Vec::new();
    for (label, filter) in [
        ("table", None),
        (
            "git",
            Some(CommitFilter {
                authors: vec!["mina@example.invalid".into()],
                ..CommitFilter::default()
            }),
        ),
    ] {
        if let Some(f) = filter {
            core.folder_timeline_query_set(session, timeline_query(f))
                .await
                .map_err(|e| e.to_string())?;
            wait_reloaded(rx, session).await?;
        }
        let before = command_count(core);
        let t = Instant::now();
        let list = core
            .folder_timeline_authors(session)
            .await
            .map_err(|e| e.to_string())?;
        authors.push(AuthorsProbe {
            label,
            ms: elapsed_ms(t),
            authors: list.authors.len(),
            cmds: command_count(core) - before,
            timed_out: list.timed_out,
        });
    }
    Ok((probes, authors))
}

/// 저장소에서 git 을 직접 돌려 측정할 커밋을 고른다 (코어 명령 로그에 들지 않는다). 없으면 `None`
pub(crate) fn probe_oid(repo: &Path, args: &[&str]) -> Option<Oid> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim();
    (out.status.success() && !first.is_empty())
        .then(|| Oid::from_hex(first.as_bytes()).ok())
        .flatten()
}

/// 첫 저장소에서 포함 브랜치(`folder_commit_containing_refs`)를 대상마다 한 번씩 잰다 (W9)
async fn measure_contains(
    core: &Core,
    session: SessionId,
    repo: &Path,
) -> Result<Vec<ContainsProbe>, String> {
    let mut probes = Vec::new();
    for (label, args) in CONTAINS_PROBES {
        let Some(oid) = probe_oid(repo, args) else {
            continue;
        };
        let before = command_count(core);
        let t = Instant::now();
        let r = core
            .folder_commit_containing_refs(session, repo, &oid)
            .await
            .map_err(|e| e.to_string())?;
        probes.push(ContainsProbe {
            label,
            ms: elapsed_ms(t),
            branches: r.branches.len(),
            head: r.head,
            timed_out: r.timed_out,
            cmds: command_count(core) - before,
        });
    }
    Ok(probes)
}

/// 첫 저장소의 가벼운 세션 열기 1회를 재고 내려놓은 뒤(닫힘), 비교로 같은 저장소를 탭으로 열어 응답까지와
/// 그래프 로드 완료까지를 잰다 (W13, 계획 5.8절 "가벼운 세션 생성 300ms")
async fn measure_light(core: &Core, folder: SessionId, repo: &Path) -> Result<LightProbe, String> {
    let ignore: Arc<dyn EventSink> = Arc::new(|_e: CoreEvent| {});
    let before = command_count(core);
    let t = Instant::now();
    let light = core
        .folder_open_repo_session(folder, repo, ignore)
        .await
        .map_err(|e| e.to_string())?;
    let light_ms = elapsed_ms(t);
    let light_cmds = command_count(core) - before;
    core.folder_release_repo_session(folder, light.session);

    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });
    let before = command_count(core);
    let t = Instant::now();
    let full = core
        .open_repo(repo, sink)
        .await
        .map_err(|e| e.to_string())?;
    let full_open_ms = elapsed_ms(t);
    wait_loaded(&mut rx, full.session).await?;
    let full_loaded_ms = elapsed_ms(t);
    let full_cmds = command_count(core) - before;
    core.close_repo(full.session).map_err(|e| e.to_string())?;
    Ok(LightProbe {
        light_ms,
        light_cmds,
        full_open_ms,
        full_loaded_ms,
        full_cmds,
    })
}

/// 폴더 열기 → 요약 전체 → 브랜치 목록 → 타임라인 열기·로드 완료 순(제품이 부르는 순서)으로 재고, 이어서
/// 첫 저장소의 포함 브랜치와 가벼운 세션 열기를 잰 뒤 세션을 닫는다. RSS 는 호출자가 채운다
async fn measure(core: &Core, folder: &Path) -> Result<FolderRun, String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });

    let t = Instant::now();
    let opened = core
        .open_folder(folder, sink)
        .await
        .map_err(|e| e.to_string())?;
    let open_ms = elapsed_ms(t);
    let after_open = command_count(core);

    let t = Instant::now();
    let summaries = core
        .folder_summaries(opened.session, &[])
        .await
        .map_err(|e| e.to_string())?;
    let summaries_ms = elapsed_ms(t);
    let after_summaries = command_count(core);

    let t = Instant::now();
    let branches = core
        .folder_branches(opened.session, &[])
        .await
        .map_err(|e| e.to_string())?;
    let branches_ms = elapsed_ms(t);
    let after_branches = command_count(core);

    let t = Instant::now();
    core.folder_timeline_open(opened.session)
        .map_err(|e| e.to_string())?;
    let (rows, lane_count) = wait_loaded(&mut rx, opened.session).await?;
    let timeline_ms = elapsed_ms(t);
    let after_timeline = command_count(core);

    // 구간별 저장소 판별 (W18): 명령 로그를 구간 경계의 명령 수로 나눈다
    let log = commands_since(core, 0);
    let bounds = [
        0,
        after_open,
        after_summaries,
        after_branches,
        after_timeline,
    ];
    let discover: [DiscoverShare; 4] =
        std::array::from_fn(|i| DiscoverShare::of(&log[bounds[i]..bounds[i + 1]]));

    let info = core
        .folder_timeline_info(opened.session)
        .map_err(|e| e.to_string())?;
    let first = opened
        .repos
        .iter()
        .map(|r| r.path.clone())
        .min()
        .ok_or_else(|| "저장소가 없음".to_string())?;
    let contains = measure_contains(core, opened.session, &first).await?;
    let light = measure_light(core, opened.session, &first).await?;
    core.close_folder(opened.session)
        .map_err(|e| e.to_string())?;
    Ok(FolderRun {
        repos: opened.repos.len(),
        open_ms,
        summaries_ms,
        summary_errors: summaries.iter().filter(|s| s.error.is_some()).count(),
        branches_ms,
        branch_count: branches.branches.len(),
        branch_errors: branches.repos.iter().filter(|r| r.error.is_some()).count(),
        timeline_ms,
        rows,
        lane_count,
        timeline_errors: info.repos.iter().filter(|r| r.error.is_some()).count(),
        truncated: info.repos.iter().filter(|r| r.truncated).count(),
        cmds_open: after_open,
        cmds_summaries: after_summaries - after_open,
        cmds_branches: after_branches - after_summaries,
        cmds_timeline: after_timeline - after_branches,
        discover,
        rss_peak_mb: f64::NAN,
        contains,
        light,
    })
}

/// 측정용 코어. 제품(데스크톱 셸)처럼 notify 감시자를 달아 `open_folder` 가 저장소마다 감시를 거는 비용도
/// 포함하고, 명령 수를 세려고 명령 로그 링버퍼를 넉넉히 둔다
pub(crate) async fn bench_core(opts: &Opts) -> Result<Core, String> {
    bench_core_with(opts, |_| {}).await
}

/// `bench_core` 에 설정을 더 바꿔 만든다 (레인 측정의 긴 엣지 접기 거리 등, 벤치 안에서만)
pub(crate) async fn bench_core_with(
    opts: &Opts,
    tweak: impl FnOnce(&mut mgit_core::CoreConfig),
) -> Result<Core, String> {
    let mut runner_cfg = RunnerConfig::default();
    if let Some(n) = opts.max_reads {
        runner_cfg.max_concurrent_reads = n;
    }
    if let Some(n) = opts.max_bulk_reads {
        runner_cfg.max_concurrent_bulk_reads = n;
    }
    if let Some(ms) = opts.slow_status_ms {
        runner_cfg.locate.configured_path = Some(slow_status_git(ms).await?);
    }
    let runner = TokioGitRunner::new(runner_cfg)
        .await
        .map_err(|e| e.to_string())?;
    let mut cfg = core_config(opts);
    cfg.command_log_capacity = usize::MAX;
    tweak(&mut cfg);
    Ok(Core::with_deps(
        Arc::new(runner),
        Arc::new(NotifyWatcher::default()),
        Arc::new(MemoryStore::new()),
        cfg,
    ))
}

/// `git status` 만 `ms` 만큼 늦게 시작하는 git 감싸개를 임시 폴더에 만든다 (`--slow-status-ms`, 경합 측정용). 합성 저장소의
/// status 는 수 ms 라, 작업 트리가 큰 실제 저장소처럼 status 가 느린 때의 줄 서기를 흉내 낸다. 다른 명령은 진짜 git 그대로다
async fn slow_status_git(ms: u64) -> Result<PathBuf, String> {
    let real = TokioGitRunner::new(RunnerConfig::default())
        .await
        .map_err(|e| e.to_string())?
        .git_path()
        .clone();
    let dir = std::env::temp_dir().join(format!("mgit-bench-slow-status-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("git");
    let body = format!(
        "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    status) sleep {}.{:03}; break ;;\n  esac\ndone\nexec '{}' \"$@\"\n",
        ms / 1000,
        ms % 1000,
        real.display()
    );
    std::fs::write(&script, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(script)
}

/// 코어를 새로 만들어 한 번 측정한다
async fn run_once(opts: &Opts, folder: &Path) -> Result<FolderRun, String> {
    let core = bench_core(opts).await?;
    let sampler = RssSampler::start();
    let result = measure(&core, folder).await;
    let rss_peak_mb = sampler.finish();
    result.map(|r| FolderRun { rss_peak_mb, ..r })
}

/// 필터 측정 한 번 (W16): 코어를 새로 만들어 폴더를 열고 타임라인을 다 읽은 뒤 필터 질의·범위·작성자 후보를
/// 잰다. 기본 측정(`run_once`)이 모두 끝난 뒤에 돌려, 필터 재로드가 남긴 메모리가 기본 측정의 RSS 에 섞이지 않게 한다
async fn run_filters_once(opts: &Opts, folder: &Path) -> Result<FilterRun, String> {
    let core = bench_core(opts).await?;
    let sampler = RssSampler::start();
    let result = async {
        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
            let _ = tx.send(e);
        });
        let opened = core
            .open_folder(folder, sink)
            .await
            .map_err(|e| e.to_string())?;
        core.folder_timeline_open(opened.session)
            .map_err(|e| e.to_string())?;
        wait_loaded(&mut rx, opened.session).await?;
        let info = core
            .folder_timeline_info(opened.session)
            .map_err(|e| e.to_string())?;
        let repos: Vec<PathBuf> = info.repos.iter().map(|r| r.path.clone()).collect();
        let measured = measure_filters(&core, &mut rx, opened.session, &repos).await?;
        core.close_folder(opened.session)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(measured)
    }
    .await;
    let rss_peak_mb = sampler.finish();
    result.map(|(filters, authors)| FilterRun {
        filters,
        authors,
        rss_peak_mb,
    })
}

/// 중앙값 (짝수 개면 가운데 두 값의 평균)
pub(crate) fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    match n {
        0 => f64::NAN,
        _ if n % 2 == 1 => values[n / 2],
        _ => (values[n / 2 - 1] + values[n / 2]) / 2.0,
    }
}

/// 합격선 이하인지를 출력용 문자열로
pub(crate) fn verdict(pass: bool) -> &'static str {
    if pass { "ok" } else { "over" }
}

/// 폴더 모드 진입점: `--runs` 번 재고 실행별 수치와 중앙값·합격선 대비를 출력한다
pub async fn run(opts: &Opts, folder: &Path) {
    println!(
        "folder={} commit_graph={} runs={}",
        folder.display(),
        !opts.no_commit_graph,
        opts.runs
    );
    let mut all = Vec::new();
    for i in 0..opts.runs {
        match run_once(opts, folder).await {
            Ok(r) => {
                println!(
                    "run {}: repos={} open_folder={:.0}ms summaries={:.0}ms branches={:.0}ms ({}개) timeline={:.0}ms rows={} lanes={} rss_peak={:.0}MB git_cmds={} (open {} / summaries {} / branches {} / timeline {}) summary_errors={} branch_errors={} timeline_errors={} truncated={}",
                    i + 1,
                    r.repos,
                    r.open_ms,
                    r.summaries_ms,
                    r.branches_ms,
                    r.branch_count,
                    r.timeline_ms,
                    r.rows,
                    r.lane_count,
                    r.rss_peak_mb,
                    r.cmds_total(),
                    r.cmds_open,
                    r.cmds_summaries,
                    r.cmds_branches,
                    r.cmds_timeline,
                    r.summary_errors,
                    r.branch_errors,
                    r.timeline_errors,
                    r.truncated
                );
                let d = &r.discover;
                println!(
                    "  discover(rev-parse 판별, 수·실행 시간 합): open {}·{}ms / summaries {}·{}ms / branches {}·{}ms / timeline {}·{}ms",
                    d[0].count,
                    d[0].sum_ms,
                    d[1].count,
                    d[1].sum_ms,
                    d[2].count,
                    d[2].sum_ms,
                    d[3].count,
                    d[3].sum_ms
                );
                for p in &r.contains {
                    println!(
                        "  contains {}: {:.1}ms branches={} head={} timed_out={} git_cmds={}",
                        p.label, p.ms, p.branches, p.head, p.timed_out, p.cmds
                    );
                }
                let l = &r.light;
                println!(
                    "  light_session: {:.1}ms git_cmds={} | full open_repo: {:.1}ms, graph loaded {:.1}ms, git_cmds={}",
                    l.light_ms, l.light_cmds, l.full_open_ms, l.full_loaded_ms, l.full_cmds
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
    let open = median(all.iter().map(|r| r.open_ms).collect());
    let summaries = median(all.iter().map(|r| r.summaries_ms).collect());
    let branches = median(all.iter().map(|r| r.branches_ms).collect());
    let timeline = median(all.iter().map(|r| r.timeline_ms).collect());
    let cmds = median(all.iter().map(|r| r.cmds_total() as f64).collect());
    let max_rss = all.iter().map(|r| r.rss_peak_mb).fold(0.0, f64::max);
    let pass_open = open <= OPEN_FOLDER_LIMIT_MS;
    let pass_summaries = summaries <= SUMMARIES_LIMIT_MS;
    let pass_branches = branches <= BRANCHES_LIMIT_MS;
    let pass_timeline = timeline <= TIMELINE_LIMIT_MS;
    let pass_rss = max_rss <= RSS_LIMIT_MB;
    let discover_counts = all[0].discover.map(|d| d.count);
    let discover_sums: [f64; 4] =
        std::array::from_fn(|i| median(all.iter().map(|r| r.discover[i].sum_ms as f64).collect()));
    let summary = serde_json::json!({
        "repos": all[0].repos,
        "rows": all[0].rows,
        "lane_count": all[0].lane_count,
        "commit_graph": !opts.no_commit_graph,
        "open_folder_ms_median": open,
        "summaries_ms_median": summaries,
        "branches_ms_median": branches,
        "branch_count": all[0].branch_count,
        "timeline_ms_median": timeline,
        "rss_peak_mb_max": max_rss,
        "git_cmds_median": cmds,
        "git_cmds_open": all[0].cmds_open,
        "git_cmds_summaries": all[0].cmds_summaries,
        "git_cmds_branches": all[0].cmds_branches,
        "git_cmds_timeline": all[0].cmds_timeline,
        "discover_counts": discover_counts,
        "discover_sum_ms_median": discover_sums,
        "pass_open_folder": pass_open,
        "pass_summaries": pass_summaries,
        "pass_branches": pass_branches,
        "pass_timeline": pass_timeline,
        "pass_rss": pass_rss,
    });
    println!("{summary}");
    println!(
        "폴더 측정(중앙값): open_folder {:.0}ms (≤{:.0}) {}, summaries {:.0}ms (≤{:.0}) {}, branches {:.0}ms (≤{:.0}) {}, timeline {:.0}ms (≤{:.0}) {}, rss {:.0}MB (≤{:.0}) {}, git_cmds {:.0}",
        open,
        OPEN_FOLDER_LIMIT_MS,
        verdict(pass_open),
        summaries,
        SUMMARIES_LIMIT_MS,
        verdict(pass_summaries),
        branches,
        BRANCHES_LIMIT_MS,
        verdict(pass_branches),
        timeline,
        TIMELINE_LIMIT_MS,
        verdict(pass_timeline),
        max_rss,
        RSS_LIMIT_MB,
        verdict(pass_rss),
        cmds
    );
    // 포함 브랜치: 대상별 중앙값. 시간 초과가 하나라도 있으면 합격선(1초 또는 상한 안)은 "상한 안" 쪽으로 본다
    let mut contains_json = serde_json::Map::new();
    for (label, _) in CONTAINS_PROBES {
        let runs: Vec<&ContainsProbe> = all
            .iter()
            .flat_map(|r| r.contains.iter().filter(move |p| p.label == label))
            .collect();
        let Some(first) = runs.first() else {
            continue;
        };
        let ms = median(runs.iter().map(|p| p.ms).collect());
        let timed_out = runs.iter().any(|p| p.timed_out);
        println!(
            "포함 브랜치 {label}(중앙값): {ms:.1}ms (≤{CONTAINS_LIMIT_MS:.0} 또는 시간 상한 안) {}, branches={} head={} git_cmds={}{}",
            verdict(ms <= CONTAINS_LIMIT_MS),
            first.branches,
            first.head,
            first.cmds,
            if timed_out {
                " (시간 초과 있음)"
            } else {
                ""
            }
        );
        contains_json.insert(
            label.to_string(),
            serde_json::json!({
                "ms_median": ms,
                "branches": first.branches,
                "head": first.head,
                "git_cmds": first.cmds,
                "timed_out": timed_out,
            }),
        );
    }
    println!("{}", serde_json::json!({ "contains": contains_json }));
    // 가벼운 세션 (W13): 생성 1회와 같은 저장소의 탭 열기 비교
    let light_ms = median(all.iter().map(|r| r.light.light_ms).collect());
    let full_open_ms = median(all.iter().map(|r| r.light.full_open_ms).collect());
    let full_loaded_ms = median(all.iter().map(|r| r.light.full_loaded_ms).collect());
    println!(
        "가벼운 세션(중앙값): 생성 {light_ms:.1}ms (≤{LIGHT_OPEN_LIMIT_MS:.0}) {}, git_cmds={} | 같은 저장소 탭 열기: 응답 {full_open_ms:.1}ms, 그래프 로드 완료 {full_loaded_ms:.1}ms, git_cmds={}",
        verdict(light_ms <= LIGHT_OPEN_LIMIT_MS),
        all[0].light.light_cmds,
        all[0].light.full_cmds
    );
    println!(
        "{}",
        serde_json::json!({ "light_session": {
            "ms_median": light_ms,
            "git_cmds": all[0].light.light_cmds,
            "pass": light_ms <= LIGHT_OPEN_LIMIT_MS,
            "full_open_ms_median": full_open_ms,
            "full_loaded_ms_median": full_loaded_ms,
            "full_git_cmds": all[0].light.full_cmds,
        }})
    );
    report_filters(opts, folder).await;
    crate::w18::report(opts, folder).await;
    // 합격선마다 조건이 달라 다른 크기의 폴더에서는 판정을 그대로 읽으면 안 된다
    println!(
        "합격선 조건(계획 5.8절): open_folder 는 저장소 50개, summaries·branches·timeline·rss 는 20개 × 1만 커밋(20만 행)"
    );
}

/// 필터 측정 (W16): 기본 측정이 끝난 뒤 `--runs` 번 따로 재고 실행별 수치와 중앙값을 출력한다.
/// 시간은 질의·범위를 바꾼 때부터 재로드 완료까지, 합격선은 타임라인 열기와 같은 2초
async fn report_filters(opts: &Opts, folder: &Path) {
    let mut all = Vec::new();
    for i in 0..opts.runs {
        match run_filters_once(opts, folder).await {
            Ok(r) => {
                println!("filter run {}: rss_peak={:.0}MB", i + 1, r.rss_peak_mb);
                for p in &r.filters {
                    println!(
                        "  filter {}: {:.0}ms rows={} git_cmds={} truncated={}",
                        p.label, p.ms, p.rows, p.cmds, p.truncated
                    );
                }
                for a in &r.authors {
                    println!(
                        "  authors {}: {:.1}ms authors={} git_cmds={} timed_out={}",
                        a.label, a.ms, a.authors, a.cmds, a.timed_out
                    );
                }
                all.push(r);
            }
            Err(e) => {
                eprintln!("filter run {} 실패: {e}", i + 1);
                std::process::exit(1);
            }
        }
    }
    let Some(head) = all.first() else {
        return;
    };
    let mut filters_json = serde_json::Map::new();
    for first in &head.filters {
        let label = first.label;
        let ms = median(
            all.iter()
                .flat_map(|r| r.filters.iter().filter(move |p| p.label == label))
                .map(|p| p.ms)
                .collect(),
        );
        println!(
            "필터 {label}(중앙값): {ms:.0}ms (≤{TIMELINE_LIMIT_MS:.0}) {}, rows={} git_cmds={} truncated={}",
            verdict(ms <= TIMELINE_LIMIT_MS),
            first.rows,
            first.cmds,
            first.truncated
        );
        filters_json.insert(
            label.to_string(),
            serde_json::json!({
                "ms_median": ms,
                "rows": first.rows,
                "git_cmds": first.cmds,
                "truncated": first.truncated,
                "pass": ms <= TIMELINE_LIMIT_MS,
            }),
        );
    }
    for first in &head.authors {
        let label = first.label;
        let ms = median(
            all.iter()
                .flat_map(|r| r.authors.iter().filter(move |a| a.label == label))
                .map(|a| a.ms)
                .collect(),
        );
        println!(
            "작성자 후보 {label}(중앙값): {ms:.1}ms (≤{TIMELINE_LIMIT_MS:.0}) {}, authors={} git_cmds={} timed_out={}",
            verdict(ms <= TIMELINE_LIMIT_MS),
            first.authors,
            first.cmds,
            first.timed_out
        );
        filters_json.insert(
            format!("authors_{label}"),
            serde_json::json!({
                "ms_median": ms,
                "authors": first.authors,
                "git_cmds": first.cmds,
                "timed_out": first.timed_out,
            }),
        );
    }
    let rss = all.iter().map(|r| r.rss_peak_mb).fold(0.0, f64::max);
    println!(
        "필터 측정의 RSS 최댓값: {rss:.0}MB (참고값 — 같은 프로세스에서 재로드가 이어져 기본 측정의 rss 와 범위가 다르다)"
    );
    filters_json.insert("rss_peak_mb_max".to_string(), serde_json::json!(rss));
    println!("{}", serde_json::json!({ "filters": filters_json }));
}
