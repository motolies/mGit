//! tags 모드 (TG-17, B4, `--tags <픽스처>`). 픽스처는 `bench/setup.sh tags N` 으로 만든 `repos/tags-<N>/` 이다
//! (작업 저장소 `repo-01` + bare 원격 `origin.git`, 원격 상태가 같음·로컬에만·원격에만·다름으로 섞임). 재는 것:
//!
//! - `refresh`: `Core::remote_tags(refresh=true)` 한 번 (전체 `ls-remote --tags` + 파싱 + 비교 + 보고서). 그중 ls-remote
//!   몫(`refresh_ls_remote`)은 코어 명령 로그의 `elapsed_ms`(ms 단위)다
//! - 나눠 재기: 벤치가 같은 `ls-remote` 를 직접 돌려(`direct_ls_remote`) 출력 크기를 보고, 그 출력으로
//!   `parse_ls_remote_tags`(`parse`)·`compare_tags`(`compare`)를 따로 잰다 — 코어 안의 몫을 같은 함수로 바깥에서 재현한다
//! - `cached`: `remote_tags(refresh=false)` — 네트워크 없이 캐시와 로컬 라벨로 보고서를 만든다 (IPC 응답을 만드는 비용)
//! - `report_json`: `serde_json::to_vec(&보고서)` 의 시간·크기 (IPC 직렬화). 합격선은 2MB·100ms (계획 B4)
//! - `refs_json`: `RefsChanged` 가 통째로 싣는 `RepoRefs`(라벨 전부)의 JSON 시간·크기 — 기존 동작의 기준선
//! - `lookup_1`·`lookup_50`·`lookup_51`: `lookup_remote_tags` 이름 1개·50개(이름별 패턴)·51개(전체 조회) — 원격 삭제
//!   직전 조회와 같은 경로
//! - `push`·`delete`: 로컬에만 있는 tag k개를 `push_tags` 로 올린 뒤 같은 tag 를 `delete_remote_tags` 로 지운다(삭제 안의
//!   직전 조회 몫은 `delete_lookup`). 픽스처를 바꾸지 않도록 작업 저장소와 원격을 `<픽스처>/.bench-tmp/` 에 복사해서 하고
//!   끝나면 지운다. 실행마다 push → 삭제 짝이라 복사본은 처음 상태로 돌아온다. k 는 로컬에만 있는 tag 전부이고, 1천 개를
//!   넘으면 1천 개도 따로 잰다. 가장 큰 k 는 청크 예산을 없앤 코어(명령 하나)로도 재서 청크 비용을 견준다

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use mgit_core::{Core, CoreEvent, EventSink, SessionId, TagDeleteItem, TagRefStatus};
use mgit_git::parse::parse_ls_remote_tags;
use mgit_model::{LocalTagRef, RefKind, RefLabel, TagSyncReport, TagSyncState, compare_tags};
use serde_json::json;
use tokio::sync::mpsc;

use crate::Opts;
use crate::folder::{
    bench_core, bench_core_with, command_count, commands_since, elapsed_ms, median, verdict,
    wait_loaded,
};

/// 보고서 JSON 크기 합격선 (계획 B4 "보고서 2MB", 10진 MB 로 엄하게 본다)
const REPORT_LIMIT_BYTES: f64 = 2_000_000.0;
/// IPC 응답 합격선: 캐시로 보고서 만들기 + 직렬화 (계획 B4 "IPC 100ms")
const IPC_LIMIT_MS: f64 = 100.0;
/// 일괄 push·삭제를 따로 재는 작은 묶음 크기
const SMALL_BATCH: usize = 1_000;

/// 읽기 측정 항목 (출력 순서). `_bytes`·`_lines` 는 크기, 나머지는 ms
const READ_KEYS: [&str; 15] = [
    "refresh_ms",
    "refresh_ls_remote_ms",
    "direct_ls_remote_ms",
    "parse_ms",
    "compare_ms",
    "cached_ms",
    "report_json_ms",
    "refs_json_ms",
    "lookup_1_ms",
    "lookup_50_ms",
    "lookup_51_ms",
    "ls_remote_bytes",
    "ls_remote_lines",
    "report_json_bytes",
    "refs_json_bytes",
];

/// 쓰기 측정 항목 (묶음 하나의 push → 삭제 한 쌍)
const WRITE_KEYS: [&str; 5] = [
    "push_ms",
    "push_git",
    "delete_ms",
    "delete_lookup_ms",
    "delete_git",
];

/// 픽스처의 작업 저장소와 원격 경로
fn fixture_paths(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let repo = root.join("repo-01");
    let remote = root.join("origin.git");
    if !repo.join(".git").is_dir() || !remote.is_dir() {
        return Err(format!(
            "tag 픽스처가 아닙니다: {} (먼저 bench/setup.sh tags N)",
            root.display()
        ));
    }
    Ok((repo, remote))
}

/// git 을 직접 돌린다 (복사본 준비·나눠 재기용, 코어를 거치지 않는다). 실패하면 stderr 를 오류로
fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// 저장소를 열고 그래프 로드가 끝날 때까지 기다린다. 그 뒤 이벤트는 버린다 (보내기 실패는 무시된다)
pub(crate) async fn open(core: &Core, repo: &Path) -> Result<SessionId, String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });
    let opened = core
        .open_repo(repo, sink)
        .await
        .map_err(|e| e.to_string())?;
    wait_loaded(&mut rx, opened.session).await?;
    Ok(opened.session)
}

/// ref 라벨에서 로컬 tag 비교 재료를 뽑는다 (코어 `local_tag_refs` 와 같은 규칙)
fn local_tags(labels: &[RefLabel]) -> Vec<LocalTagRef> {
    labels
        .iter()
        .filter(|l| matches!(l.kind, RefKind::Tag { .. }))
        .filter_map(|l| {
            Some(LocalTagRef {
                name: l.full_name.strip_prefix("refs/tags/")?.to_string(),
                object: l.tag_object.unwrap_or(l.target),
                commit: l.target,
            })
        })
        .collect()
}

/// 앞의 `before` 개 뒤에 돈 명령 중 인자에 `sub` 가 있는 것들의 (수, 명령 로그 elapsed 합 ms)
fn commands_of(core: &Core, before: usize, sub: &str) -> (usize, f64) {
    let list = commands_since(core, before);
    let hits: Vec<_> = list
        .iter()
        .filter(|r| r.args.iter().any(|a| a == sub))
        .collect();
    (
        hits.len(),
        hits.iter().map(|r| f64::from(r.elapsed_ms)).sum(),
    )
}

/// 읽기 측정 한 번 (`READ_KEYS` 순서의 값)과 그때의 보고서. `names` 는 원격에 있는 tag 이름 51개 이상
async fn read_once(
    core: &Core,
    id: SessionId,
    repo: &Path,
    names: &[String],
) -> Result<(Vec<f64>, TagSyncReport), String> {
    // 전체 조회 (코어): ls-remote + 파싱 + 비교 + 보고서
    let before = command_count(core);
    let t = Instant::now();
    let fresh = core
        .remote_tags(id, Some("origin"), true, None)
        .await
        .map_err(|e| e.to_string())?;
    let refresh_ms = elapsed_ms(t);
    if let Some(err) = &fresh.last_error {
        return Err(format!("원격 조회 실패: {}", err.message));
    }
    let (_, refresh_ls_ms) = commands_of(core, before, "ls-remote");

    // 나눠 재기: 같은 조회를 직접 돌리고 같은 함수로 파싱·비교한다
    let t = Instant::now();
    let out = git(repo, &["ls-remote", "--tags", "--end-of-options", "origin"])?;
    let direct_ms = elapsed_ms(t);
    let lines = out.iter().filter(|&&b| b == b'\n').count();
    let t = Instant::now();
    let remote = parse_ls_remote_tags(&out);
    let parse_ms = elapsed_ms(t);
    let labels = core.repo_state(id).map_err(|e| e.to_string())?.refs.labels;
    let local = local_tags(&labels);
    let t = Instant::now();
    let (counts, _entries) = compare_tags(&local, &remote, &HashSet::new());
    let compare_ms = elapsed_ms(t);
    if counts != fresh.counts {
        return Err(format!(
            "벤치의 비교와 코어 보고서가 다름: {counts:?} / {:?}",
            fresh.counts
        ));
    }

    // 캐시로 보고서 (IPC 응답) + 직렬화
    let t = Instant::now();
    let cached = core
        .remote_tags(id, Some("origin"), false, None)
        .await
        .map_err(|e| e.to_string())?;
    let cached_ms = elapsed_ms(t);
    let t = Instant::now();
    let report_json = serde_json::to_vec(&cached).map_err(|e| e.to_string())?;
    let report_json_ms = elapsed_ms(t);

    // RefsChanged 기준선: 라벨 전부를 싣는 ref 스냅샷
    let refs = core.repo_state(id).map_err(|e| e.to_string())?.refs;
    let t = Instant::now();
    let refs_json = serde_json::to_vec(&refs).map_err(|e| e.to_string())?;
    let refs_json_ms = elapsed_ms(t);

    // 단일 조회 (원격 삭제 직전 조회와 같은 경로)
    let mut lookups = Vec::new();
    for n in [1usize, 50, 51] {
        let list = names.get(..n).ok_or("원격 tag 가 51개보다 적음")?;
        let t = Instant::now();
        let found = core
            .lookup_remote_tags(id, "origin", list, None)
            .await
            .map_err(|e| e.to_string())?;
        lookups.push(elapsed_ms(t));
        if found.len() != n {
            return Err(format!("단일 조회 {n}개 중 {}개만 찾음", found.len()));
        }
    }

    let values = vec![
        refresh_ms,
        refresh_ls_ms,
        direct_ms,
        parse_ms,
        compare_ms,
        cached_ms,
        report_json_ms,
        refs_json_ms,
        lookups[0],
        lookups[1],
        lookups[2],
        out.len() as f64,
        lines as f64,
        report_json.len() as f64,
        refs_json.len() as f64,
    ];
    Ok((values, cached))
}

/// 복사본 폴더. 버릴 때(실패·패닉 포함) 지운다
struct Scratch {
    root: PathBuf,
}

impl Drop for Scratch {
    /// 복사본을 지운다
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 폴더를 통째로 복사한다 (git 저장소 복사본용 — 심볼릭 링크는 다루지 않고 오류로 본다)
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to)?;
        } else {
            return Err(std::io::Error::other(format!(
                "복사할 수 없는 항목: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

/// 작업 저장소와 원격을 `<픽스처>/.bench-tmp/` 에 복사하고, 복사본의 origin 이 복사한 원격을 가리키게 한다
fn make_scratch(fixture: &Path) -> Result<(Scratch, PathBuf), String> {
    let (repo, remote) = fixture_paths(fixture)?;
    let root = fixture.join(".bench-tmp");
    if root.exists() {
        // 앞선 측정이 중간에 죽어 남긴 복사본
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let scratch = Scratch { root: root.clone() };
    let copy_repo = root.join("repo-01");
    let copy_remote = root.join("origin.git");
    copy_dir(&repo, &copy_repo).map_err(|e| e.to_string())?;
    copy_dir(&remote, &copy_remote).map_err(|e| e.to_string())?;
    let url = copy_remote.to_string_lossy().into_owned();
    git(&copy_repo, &["config", "remote.origin.url", &url])?;
    Ok((scratch, copy_repo))
}

/// 묶음 하나를 push 한 뒤 원격에서 지운다 (`WRITE_KEYS` 순서의 값). 모두 pushed·deleted 가 아니면 오류
async fn push_delete_once(
    core: &Core,
    id: SessionId,
    names: &[String],
) -> Result<Vec<f64>, String> {
    let before = command_count(core);
    let op = core
        .begin_operation(id, "push", "bench push tags")
        .map_err(|e| e.to_string())?;
    let t = Instant::now();
    let pushed = core
        .push_tags(id, "origin", names, Some(op))
        .await
        .map_err(|e| e.to_string())?;
    let push_ms = elapsed_ms(t);
    if let Some(bad) = pushed.iter().find(|r| r.status != TagRefStatus::Pushed) {
        return Err(format!("push 결과가 pushed 가 아님: {bad:?}"));
    }
    let (push_git, _) = commands_of(core, before, "push");

    let items: Vec<TagDeleteItem> = names
        .iter()
        .map(|n| TagDeleteItem {
            name: n.clone(),
            expected_remote: None,
        })
        .collect();
    let before = command_count(core);
    let op = core
        .begin_operation(id, "push", "bench delete tags")
        .map_err(|e| e.to_string())?;
    let t = Instant::now();
    let deleted = core
        .delete_remote_tags(id, "origin", &items, Some(op))
        .await
        .map_err(|e| e.to_string())?;
    let delete_ms = elapsed_ms(t);
    if let Some(bad) = deleted.iter().find(|r| r.status != TagRefStatus::Deleted) {
        return Err(format!("삭제 결과가 deleted 가 아님: {bad:?}"));
    }
    let (_, lookup_ms) = commands_of(core, before, "ls-remote");
    let (delete_git, _) = commands_of(core, before, "push");
    Ok(vec![
        push_ms,
        push_git as f64,
        delete_ms,
        lookup_ms,
        delete_git as f64,
    ])
}

/// 실행별 값의 항목마다 중앙값
fn medians(runs: &[Vec<f64>], keys: usize) -> Vec<f64> {
    (0..keys)
        .map(|i| median(runs.iter().filter_map(|r| r.get(i).copied()).collect()))
        .collect()
}

/// 항목 이름과 값을 `이름=값` 한 줄로 (ms 는 소수 한 자리, 나머지는 정수)
fn line(keys: &[&str], values: &[f64]) -> String {
    keys.iter()
        .zip(values)
        .map(|(k, v)| {
            if k.ends_with("_ms") {
                format!("{k}={v:.1}")
            } else {
                format!("{k}={v:.0}")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 읽기 측정: 픽스처를 그대로 열어 `--runs` 번 잰다 (원격을 바꾸지 않는다). (실행별 값, 마지막 보고서, ref 라벨 수)
async fn read_phase(
    opts: &Opts,
    repo: &Path,
) -> Result<(Vec<Vec<f64>>, TagSyncReport, usize), String> {
    let core = bench_core(opts).await?;
    let id = open(&core, repo).await?;
    // 단일 조회 대상: 원격에 있는 tag 이름 (이름순 앞 51개)
    let listing = git(repo, &["ls-remote", "--tags", "--end-of-options", "origin"])?;
    let mut names: Vec<String> = parse_ls_remote_tags(&listing)
        .into_iter()
        .map(|t| t.name)
        .collect();
    names.sort();
    names.truncate(51);
    let labels = core
        .repo_state(id)
        .map_err(|e| e.to_string())?
        .refs
        .labels
        .len();
    let mut runs = Vec::new();
    let mut last = None;
    for i in 0..opts.runs {
        let (values, report) = read_once(&core, id, repo, &names).await?;
        println!("tags read run {}: {}", i + 1, line(&READ_KEYS, &values));
        runs.push(values);
        last = Some(report);
    }
    core.close_repo(id).map_err(|e| e.to_string())?;
    let report = last.ok_or("--runs 가 0")?;
    Ok((runs, report, labels))
}

/// 쓰기 측정: 복사본에서 묶음마다 push → 삭제를 `runs` 번, 가장 큰 묶음은 청크 없는 코어로도 `one_chunk_runs` 번 잰다.
/// git 의 push 가 refspec 마다 ref 전부를 대조해(refspec 수 × ref 수) 큰 픽스처에서는 한 번에 수 분이 걸리므로 횟수를
/// 읽기와 따로 받는다. (묶음 크기들, 묶음별 실행 값들, 청크 없는 실행 값들)
async fn write_phase(
    opts: &Opts,
    fixture: &Path,
    runs: u32,
    one_chunk_runs: u32,
) -> Result<(Vec<usize>, Vec<Vec<Vec<f64>>>, Vec<Vec<f64>>), String> {
    if runs == 0 {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    let (scratch, copy_repo) = make_scratch(fixture)?;
    let core = bench_core(opts).await?;
    let id = open(&core, &copy_repo).await?;
    let report = core
        .remote_tags(id, Some("origin"), true, None)
        .await
        .map_err(|e| e.to_string())?;
    let local_only: Vec<String> = report
        .entries
        .iter()
        .filter(|e| e.state == TagSyncState::LocalOnly)
        .map(|e| e.name.clone())
        .collect();
    if local_only.is_empty() {
        return Err("로컬에만 있는 tag 가 없음".into());
    }
    let mut sizes = vec![local_only.len()];
    if local_only.len() > SMALL_BATCH {
        sizes.insert(0, SMALL_BATCH);
    }
    // `--write-limit` 보다 큰 묶음은 재지 않는다 (5만의 5천 개처럼 한 번에 수 분 걸리는 묶음을 건너뛸 때)
    if let Some(limit) = opts.write_limit {
        sizes.retain(|&k| k <= limit);
        if sizes.is_empty() {
            sizes.push(limit.min(local_only.len()));
        }
    }
    let mut per_size: Vec<Vec<Vec<f64>>> = vec![Vec::new(); sizes.len()];
    for i in 0..runs {
        let mut parts = Vec::new();
        for (j, &k) in sizes.iter().enumerate() {
            let values = push_delete_once(&core, id, &local_only[..k]).await?;
            parts.push(format!("[{k}] {}", line(&WRITE_KEYS, &values)));
            per_size[j].push(values);
        }
        println!("tags write run {}: {}", i + 1, parts.join(" | "));
    }
    core.close_repo(id).map_err(|e| e.to_string())?;
    if one_chunk_runs == 0 {
        drop(scratch);
        return Ok((sizes, per_size, Vec::new()));
    }

    // 청크 예산을 없앤 코어: 가장 큰 묶음을 명령 하나로
    let one = bench_core_with(opts, |c| {
        c.tag_chunk_bytes = usize::MAX;
        c.tag_chunk_refs = usize::MAX;
    })
    .await?;
    let id = open(&one, &copy_repo).await?;
    let largest = sizes.last().copied().unwrap_or_default();
    let mut single = Vec::new();
    for i in 0..one_chunk_runs {
        let values = push_delete_once(&one, id, &local_only[..largest]).await?;
        println!(
            "tags write one-chunk run {}: [{largest}] {}",
            i + 1,
            line(&WRITE_KEYS, &values)
        );
        single.push(values);
    }
    one.close_repo(id).map_err(|e| e.to_string())?;
    drop(scratch);
    Ok((sizes, per_size, single))
}

/// tags 모드 진입점: 읽기를 `--runs` 번, 쓰기를 `--write-runs` 번(기본 `--runs`, 0 이면 건너뜀), 청크 없는 비교를
/// `--one-chunk-runs` 번(기본 쓰기 횟수) 재고 중앙값·합격선 대비·요약 JSON 을 출력한다
pub async fn run(opts: &Opts, fixture: &Path) {
    let write_runs = opts.write_runs.unwrap_or(opts.runs);
    let one_chunk_runs = opts.one_chunk_runs.unwrap_or(write_runs);
    let result = async {
        let (repo, _) = fixture_paths(fixture)?;
        let (reads, report, labels) = read_phase(opts, &repo).await?;
        let (sizes, writes, single) =
            write_phase(opts, fixture, write_runs, one_chunk_runs).await?;
        Ok::<_, String>((reads, report, labels, sizes, writes, single))
    }
    .await;
    let (reads, report, labels, sizes, writes, single) = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("tags 측정 실패: {e}");
            std::process::exit(1);
        }
    };
    let c = report.counts;
    println!(
        "tags fixture={} runs={} write_runs={write_runs} one_chunk_runs={one_chunk_runs} labels={labels} counts(same={} localOnly={} remoteOnly={} diverged={} unknown={}) entries={}",
        fixture.display(),
        opts.runs,
        c.same,
        c.local_only,
        c.remote_only,
        c.diverged,
        c.unknown,
        report.entries.len()
    );
    let read_med = medians(&reads, READ_KEYS.len());
    println!("tags 읽기(중앙값): {}", line(&READ_KEYS, &read_med));
    let mut write_json = serde_json::Map::new();
    for (k, runs) in sizes.iter().zip(&writes) {
        let med = medians(runs, WRITE_KEYS.len());
        println!("tags 쓰기 [{k}](중앙값): {}", line(&WRITE_KEYS, &med));
        write_json.insert(k.to_string(), keyed(&WRITE_KEYS, &med));
    }
    let single_med = medians(&single, WRITE_KEYS.len());
    let largest = sizes.last().copied().unwrap_or_default();
    if !single.is_empty() {
        println!(
            "tags 쓰기 [{largest}] 청크 없음(중앙값): {}",
            line(&WRITE_KEYS, &single_med)
        );
    }

    let report_bytes = read_med[13];
    let ipc_ms = read_med[5] + read_med[6];
    println!(
        "판정: 보고서 JSON {report_bytes:.0}B (≤{REPORT_LIMIT_BYTES:.0}) {}, 캐시 보고서 + 직렬화 {ipc_ms:.1}ms (≤{IPC_LIMIT_MS:.0}) {}",
        verdict(report_bytes <= REPORT_LIMIT_BYTES),
        verdict(ipc_ms <= IPC_LIMIT_MS)
    );
    // 청크 없는 비교를 건너뛰었으면 null (빈 측정의 NaN 을 싣지 않는다)
    let one_chunk_json = if single.is_empty() {
        serde_json::Value::Null
    } else {
        json!({ largest.to_string(): keyed(&WRITE_KEYS, &single_med) })
    };
    let summary = json!({
        "tags": {
            "labels": labels,
            "counts": report.counts,
            "entries": report.entries.len(),
            "read_median": keyed(&READ_KEYS, &read_med),
            "write_median": write_json,
            "write_one_chunk_median": one_chunk_json,
            "pass_report_bytes": report_bytes <= REPORT_LIMIT_BYTES,
            "pass_ipc_ms": ipc_ms <= IPC_LIMIT_MS,
        }
    });
    println!("{summary}");
}

/// 항목 이름 → 값 JSON 객체
fn keyed(keys: &[&str], values: &[f64]) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = keys
        .iter()
        .zip(values)
        .map(|(k, v)| ((*k).to_string(), json!(v)))
        .collect();
    serde_json::Value::Object(map)
}
