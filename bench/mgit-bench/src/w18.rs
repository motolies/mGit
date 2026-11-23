//! 폴더 모드의 W18 측정 (W0~W16 의 기본·필터 측정이 끝난 뒤 코어를 새로 만들어 따로 잰다 — 기본 측정의 RSS 와
//! 순서를 W0 과 같게 둔다).
//!
//! - 전체 갱신 한 번: 프런트의 `reload('all')` 처럼 요약 + 브랜치 목록 + 변경 목록을 동시에 부른다 (창 포커스·
//!   60초 주기·새로고침이 하는 일). 저장소당 `git status` 가 요약과 변경에서 한 번씩 돈다
//! - 커밋 상세: 타임라인을 다 읽은 뒤 첫 `folder_commit_detail`(자식 색인을 만든다)과 다음 요청
//! - 저장소 1개 ref 변경: 경로순 첫 저장소에 빈 커밋을 가리키는 브랜치를 만들고(벤치가 git 을 직접 돌린다),
//!   감시 이벤트(`FolderChanged{refs}`) → 그 저장소만 부분 갱신 → 타임라인 재로드를 차례로 잰다. 끝나면 브랜치를
//!   지운다 (시작할 때도 남은 것이 있으면 지운다 — 픽스처를 바꾸지 않는다)

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mgit_core::{Core, CoreEvent, EventSink, SessionId};
use tokio::sync::mpsc;

use crate::Opts;
use crate::folder::{
    DiscoverShare, RssSampler, TIMELINE_LIMIT_MS, bench_core, command_count, commands_since,
    elapsed_ms, is_status, median, probe_oid, verdict, wait_loaded, wait_reloaded,
};

/// 합격선: 전체 갱신 한 번은 "요약 전체"와 같은 2초, 저장소 1개 ref 변경 → 갱신은 디바운스 뒤 1초
const REFRESH_LIMIT_MS: f64 = 2000.0;
const REF_CHANGE_LIMIT_MS: f64 = 1000.0;
/// ref 변경 측정이 만들고 지우는 브랜치
const PROBE_BRANCH: &str = "refs/heads/bench/w18-ref-change";
/// 감시 이벤트를 기다리는 상한
const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

/// 전체 갱신 한 번 (요약 + 브랜치 + 변경, 동시)
struct RefreshProbe {
    ms: f64,
    cmds: usize,
    status: usize,
    discover: DiscoverShare,
    changed_repos: usize,
}

/// 저장소 1개 ref 변경 → 갱신
struct RefChangeProbe {
    /// `update-ref` 직후부터 그 저장소의 `FolderChanged{refs: true}` 까지 (감시·디바운스 150ms 포함)
    event_ms: f64,
    /// 그 저장소만의 요약 + 브랜치 + 변경 (프런트의 부분 갱신)
    partial_ms: f64,
    partial_cmds: usize,
    /// 부분 갱신의 git 이 다른 저장소에서 돈 수 (0 이어야 한다)
    partial_foreign: usize,
    /// 타임라인 재로드 (`folder_timeline_reload` → `GraphReloaded`)
    reload_ms: f64,
    reload_cmds: usize,
    rows_before: u32,
    rows_after: u32,
    /// 재로드한 타임라인에 새 커밋이 들어왔는지 (저장소당 상한에 걸린 저장소면 가장 오래된 커밋이 대신 빠져 행 수는 같다)
    new_commit_found: bool,
}

/// 포함 브랜치 연속 요청 (커밋을 빠르게 옮겨 다닐 때): `BURST` 개를 `BURST_GAP` 간격으로 낸다.
/// 간격은 프런트의 디바운스(200ms)보다 조금 길다 — 디바운스를 넘겨 실제 요청이 나가는 가장 빠른 이동
struct BurstProbe {
    /// 마지막 요청을 낸 때부터 그 결과까지 (멈춘 뒤 화면이 기다리는 시간)
    last_ms: f64,
    /// 첫 요청부터 모든 요청이 끝날 때까지
    total_ms: f64,
    ok: usize,
    cancelled: usize,
    timed_out: usize,
    /// `for-each-ref --contains` 프로세스 수, 그중 취소로 끝난 수, 실행 시간 합 (명령 로그)
    processes: usize,
    processes_cancelled: usize,
    process_ms_sum: u64,
}

/// 연속 요청 수와 간격
const BURST: usize = 5;
const BURST_GAP: Duration = Duration::from_millis(250);

/// W18 측정 한 번의 결과
struct W18Run {
    refresh: RefreshProbe,
    detail_first_ms: f64,
    detail_next_ms: f64,
    detail_children: usize,
    ref_change: RefChangeProbe,
    burst: BurstProbe,
    rss_peak_mb: f64,
}

/// 경로순 첫 저장소에서 포함 브랜치를 `BURST` 번 `BURST_GAP` 간격으로 요청한다 (서로 다른 커밋 `main~1`…).
/// 앞 요청의 결과를 기다리지 않는다 — 프런트는 늦게 온 옛 응답을 버리지만 코어의 요청은 그대로 돈다
async fn measure_burst(core: &Core, session: SessionId, repo: &Path) -> Result<BurstProbe, String> {
    let targets: Vec<mgit_core::Oid> = (1..=BURST)
        .map(|k| probe_oid(repo, &["rev-parse", &format!("main~{k}")]).ok_or("대상 커밋 없음"))
        .collect::<Result<_, _>>()?;
    let before = command_count(core);
    let start = Instant::now();
    let one = |i: usize| {
        let oid = targets[i];
        async move {
            tokio::time::sleep(BURST_GAP * i as u32).await;
            let sent = Instant::now();
            let r = core
                .folder_commit_containing_refs(session, repo, &oid)
                .await;
            (r, elapsed_ms(sent))
        }
    };
    let results = tokio::join!(one(0), one(1), one(2), one(3), one(4));
    let total_ms = elapsed_ms(start);
    let results = [results.0, results.1, results.2, results.3, results.4];
    let mut probe = BurstProbe {
        last_ms: results[BURST - 1].1,
        total_ms,
        ok: 0,
        cancelled: 0,
        timed_out: 0,
        processes: 0,
        processes_cancelled: 0,
        process_ms_sum: 0,
    };
    for (r, _) in &results {
        match r {
            Ok(c) if c.timed_out => probe.timed_out += 1,
            Ok(_) => probe.ok += 1,
            Err(mgit_core::CoreError::Cancelled) => probe.cancelled += 1,
            Err(e) => return Err(e.to_string()),
        }
    }
    for rec in commands_since(core, before)
        .iter()
        .filter(|r| r.args.iter().any(|a| a.starts_with("--contains=")))
    {
        probe.processes += 1;
        probe.processes_cancelled += usize::from(rec.cancelled);
        probe.process_ms_sum += u64::from(rec.elapsed_ms);
    }
    Ok(probe)
}

/// 벤치가 git 을 직접 돌린다 (코어 명령 로그에 들지 않는다). 실패하면 stderr 를 돌려준다
fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_AUTHOR_DATE", "1760000600 +0000")
        .env("GIT_COMMITTER_DATE", "1760000600 +0000")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 측정용 브랜치가 남아 있으면 지운다 (앞선 측정이 중간에 끊긴 경우)
fn remove_probe_branch(repo: &Path) {
    if git(repo, &["rev-parse", "--verify", "--quiet", PROBE_BRANCH]).is_ok() {
        let _ = git(repo, &["update-ref", "-d", PROBE_BRANCH]);
    }
}

/// 그 저장소의 `FolderChanged{refs: true}` 를 기다린다. 다른 이벤트(색인 갱신의 refs:false 등)는 버린다
async fn wait_ref_changed(
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
    repo: &Path,
) -> Result<(), String> {
    let wait = tokio::time::timeout(EVENT_TIMEOUT, async {
        while let Some(e) = rx.recv().await {
            if let CoreEvent::FolderChanged {
                session: s,
                refs: true,
                repo: Some(r),
            } = e
                && s == session
                && r == repo
            {
                return Ok(());
            }
        }
        Err("이벤트 채널이 닫힘".to_string())
    });
    wait.await
        .map_err(|_| "감시 이벤트가 오지 않음".to_string())?
}

/// 받은 이벤트를 모두 버린다 (앞 측정이 남긴 감시 이벤트가 다음 측정의 대기에 섞이지 않게)
async fn drain(rx: &mut mpsc::UnboundedReceiver<CoreEvent>) {
    // 감시 디바운스(150ms)가 끝날 만큼 기다린 뒤 비운다
    tokio::time::sleep(Duration::from_millis(400)).await;
    while rx.try_recv().is_ok() {}
}

/// 요약 + 브랜치 + 변경을 동시에 부른다 (프런트의 `reload`). `repos` 가 비면 전부. 변경이 있는 저장소 수를 돌려준다
async fn refresh(core: &Core, session: SessionId, repos: &[PathBuf]) -> Result<usize, String> {
    let (summaries, branches, changes) = tokio::join!(
        core.folder_summaries(session, repos),
        core.folder_branches(session, repos),
        core.folder_changes(session, repos),
    );
    summaries.map_err(|e| e.to_string())?;
    branches.map_err(|e| e.to_string())?;
    Ok(changes.map_err(|e| e.to_string())?.len())
}

/// 경로순 첫 저장소에서 ref 변경 → 감시 이벤트 → 부분 갱신 → 타임라인 재로드를 잰다
async fn measure_ref_change(
    core: &Core,
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
    repo: &Path,
) -> Result<RefChangeProbe, String> {
    let rows_before = core
        .folder_timeline_info(session)
        .map_err(|e| e.to_string())?
        .rows;
    let tree = git(repo, &["rev-parse", "main^{tree}"])?;
    let oid = git(
        repo,
        &[
            "-c",
            "user.name=Bench",
            "-c",
            "user.email=bench@example.invalid",
            "commit-tree",
            &tree,
            "-p",
            "main",
            "-m",
            "w18 ref change",
        ],
    )?;
    drain(rx).await;
    let t = Instant::now();
    git(repo, &["update-ref", PROBE_BRANCH, &oid])?;
    let result = async {
        wait_ref_changed(rx, session, repo).await?;
        let event_ms = elapsed_ms(t);

        let before = command_count(core);
        let t = Instant::now();
        refresh(core, session, &[repo.to_path_buf()]).await?;
        let partial_ms = elapsed_ms(t);
        let partial = commands_since(core, before);

        let before = command_count(core);
        let t = Instant::now();
        core.folder_timeline_reload(session)
            .map_err(|e| e.to_string())?;
        let rows_after = wait_reloaded(rx, session).await?;
        let reload_ms = elapsed_ms(t);
        let new_oid = mgit_core::Oid::from_hex(oid.as_bytes()).map_err(|e| e.to_string())?;
        let new_commit_found = core
            .folder_timeline_find_row_at(session, repo, &new_oid)
            .map_err(|e| e.to_string())?
            .is_some();
        Ok::<_, String>(RefChangeProbe {
            new_commit_found,
            event_ms,
            partial_ms,
            partial_cmds: partial.len(),
            partial_foreign: partial.iter().filter(|r| r.cwd != repo).count(),
            reload_ms,
            reload_cmds: command_count(core) - before,
            rows_before,
            rows_after,
        })
    }
    .await;
    remove_probe_branch(repo);
    result
}

/// W18 측정 한 번: 코어를 새로 만들어 폴더를 열고 타임라인을 다 읽은 뒤 전체 갱신 → 커밋 상세 → ref 변경 순으로 잰다
async fn run_once(opts: &Opts, folder: &Path) -> Result<W18Run, String> {
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
        let id = opened.session;
        let first = opened
            .repos
            .iter()
            .map(|r| r.path.clone())
            .min()
            .ok_or_else(|| "저장소가 없음".to_string())?;
        remove_probe_branch(&first);
        core.folder_timeline_open(id).map_err(|e| e.to_string())?;
        wait_loaded(&mut rx, id).await?;

        // 전체 갱신 한 번
        let before = command_count(&core);
        let t = Instant::now();
        let changed_repos = refresh(&core, id, &[]).await?;
        let ms = elapsed_ms(t);
        let log = commands_since(&core, before);
        let refresh = RefreshProbe {
            ms,
            cmds: log.len(),
            status: log.iter().filter(|r| is_status(r)).count(),
            discover: DiscoverShare::of(&log),
            changed_repos,
        };

        // 커밋 상세: 첫 요청이 타임라인 자식 색인(20만 행)을 만든다
        let a = probe_oid(&first, &["rev-parse", "main~100"]).ok_or("main~100 없음")?;
        let b = probe_oid(&first, &["rev-parse", "main~200"]).ok_or("main~200 없음")?;
        let t = Instant::now();
        let detail = core
            .folder_commit_detail(id, &first, &a)
            .await
            .map_err(|e| e.to_string())?;
        let detail_first_ms = elapsed_ms(t);
        let t = Instant::now();
        core.folder_commit_detail(id, &first, &b)
            .await
            .map_err(|e| e.to_string())?;
        let detail_next_ms = elapsed_ms(t);

        let ref_change = measure_ref_change(&core, &mut rx, id, &first).await?;
        let burst = measure_burst(&core, id, &first).await?;
        core.close_folder(id).map_err(|e| e.to_string())?;
        Ok::<_, String>(W18Run {
            refresh,
            detail_first_ms,
            detail_next_ms,
            detail_children: detail.children.len(),
            ref_change,
            burst,
            rss_peak_mb: f64::NAN,
        })
    }
    .await;
    let rss_peak_mb = sampler.finish();
    result.map(|r| W18Run { rss_peak_mb, ..r })
}

/// W18 측정 진입점: `--runs` 번 재고 실행별 수치와 중앙값·합격선 대비를 출력한다
pub async fn report(opts: &Opts, folder: &Path) {
    let mut all = Vec::new();
    for i in 0..opts.runs {
        match run_once(opts, folder).await {
            Ok(r) => {
                let f = &r.refresh;
                let c = &r.ref_change;
                println!(
                    "w18 run {}: refresh={:.0}ms git_cmds={} status={} discover={}·{}ms changed_repos={} | detail first={:.1}ms next={:.1}ms children={} | ref_change event={:.0}ms partial={:.1}ms git_cmds={} foreign={} timeline_reload={:.0}ms git_cmds={} rows {}→{} new_commit_found={} | rss_peak={:.0}MB",
                    i + 1,
                    f.ms,
                    f.cmds,
                    f.status,
                    f.discover.count,
                    f.discover.sum_ms,
                    f.changed_repos,
                    r.detail_first_ms,
                    r.detail_next_ms,
                    r.detail_children,
                    c.event_ms,
                    c.partial_ms,
                    c.partial_cmds,
                    c.partial_foreign,
                    c.reload_ms,
                    c.reload_cmds,
                    c.rows_before,
                    c.rows_after,
                    c.new_commit_found,
                    r.rss_peak_mb
                );
                let b = &r.burst;
                println!(
                    "  contains burst({BURST}개, {}ms 간격): 마지막 요청 {:.0}ms, 전체 {:.0}ms, 결과 ok {} / 취소 {} / 시간 초과 {}, --contains 프로세스 {} (취소 {}) 실행 시간 합 {}ms",
                    BURST_GAP.as_millis(),
                    b.last_ms,
                    b.total_ms,
                    b.ok,
                    b.cancelled,
                    b.timed_out,
                    b.processes,
                    b.processes_cancelled,
                    b.process_ms_sum
                );
                all.push(r);
            }
            Err(e) => {
                eprintln!("w18 run {} 실패: {e}", i + 1);
                std::process::exit(1);
            }
        }
    }
    let Some(head) = all.first() else {
        return;
    };
    let med = |f: fn(&W18Run) -> f64| median(all.iter().map(f).collect());
    let refresh_ms = med(|r| r.refresh.ms);
    let detail_first = med(|r| r.detail_first_ms);
    let detail_next = med(|r| r.detail_next_ms);
    let event_ms = med(|r| r.ref_change.event_ms);
    let partial_ms = med(|r| r.ref_change.partial_ms);
    let reload_ms = med(|r| r.ref_change.reload_ms);
    let rss = all.iter().map(|r| r.rss_peak_mb).fold(0.0, f64::max);
    // ref 변경 → 갱신 완료의 판정은 디바운스 뒤의 일(부분 갱신, 타임라인 재로드 중 늦은 쪽)로 한다.
    // 프런트에서는 둘이 따로 예약되므로(부분 400ms, 타임라인 1.5초 디바운스) 더하지 않는다
    let after_debounce = partial_ms.max(reload_ms);
    println!(
        "W18 전체 갱신(중앙값): {refresh_ms:.0}ms (≤{REFRESH_LIMIT_MS:.0}) {}, git_cmds={} status={} discover={}",
        verdict(refresh_ms <= REFRESH_LIMIT_MS),
        head.refresh.cmds,
        head.refresh.status,
        head.refresh.discover.count
    );
    println!(
        "W18 커밋 상세(중앙값): 첫 요청 {detail_first:.1}ms (자식 색인 생성 포함), 다음 요청 {detail_next:.1}ms"
    );
    println!(
        "W18 ref 변경(중앙값): 감시 이벤트 {event_ms:.0}ms, 부분 갱신 {partial_ms:.1}ms (git {}, 다른 저장소 {}), 타임라인 재로드 {reload_ms:.0}ms (git {}) → 디바운스 뒤 {after_debounce:.0}ms (≤{REF_CHANGE_LIMIT_MS:.0}) {}",
        head.ref_change.partial_cmds,
        head.ref_change.partial_foreign,
        head.ref_change.reload_cmds,
        verdict(after_debounce <= REF_CHANGE_LIMIT_MS)
    );
    let burst_last = med(|r| r.burst.last_ms);
    let burst_total = med(|r| r.burst.total_ms);
    let burst_cpu = med(|r| r.burst.process_ms_sum as f64);
    println!(
        "W18 포함 브랜치 연속 요청(중앙값): 마지막 요청 {burst_last:.0}ms, 전체 {burst_total:.0}ms, ok {} / 취소 {}, --contains 프로세스 실행 시간 합 {burst_cpu:.0}ms",
        head.burst.ok, head.burst.cancelled
    );
    println!("W18 측정의 RSS 최댓값: {rss:.0}MB (참고값 — 재로드 1회 포함)");
    println!(
        "{}",
        serde_json::json!({ "w18": {
            "refresh_ms_median": refresh_ms,
            "refresh_git_cmds": head.refresh.cmds,
            "refresh_status_cmds": head.refresh.status,
            "refresh_discover_cmds": head.refresh.discover.count,
            "refresh_pass": refresh_ms <= REFRESH_LIMIT_MS,
            "detail_first_ms_median": detail_first,
            "detail_next_ms_median": detail_next,
            "ref_change_event_ms_median": event_ms,
            "ref_change_partial_ms_median": partial_ms,
            "ref_change_partial_git_cmds": head.ref_change.partial_cmds,
            "ref_change_partial_foreign_cmds": head.ref_change.partial_foreign,
            "ref_change_reload_ms_median": reload_ms,
            "ref_change_reload_git_cmds": head.ref_change.reload_cmds,
            "ref_change_new_commit_found": all.iter().all(|r| r.ref_change.new_commit_found),
            "ref_change_pass": after_debounce <= REF_CHANGE_LIMIT_MS,
            "contains_burst_last_ms_median": burst_last,
            "contains_burst_total_ms_median": burst_total,
            "contains_burst_process_ms_sum_median": burst_cpu,
            "contains_burst_ok": head.burst.ok,
            "contains_burst_cancelled": head.burst.cancelled,
            "timeline_limit_ms": TIMELINE_LIMIT_MS,
            "rss_peak_mb_max": rss,
        }})
    );
}
