//! 비교 모드 (M2, `--compare <저장소>`). 비교 화면이 부르는 코어 API 를 화면과 같은 순서로 불러 구간별 시간과
//! git 명령 수(코어 명령 로그 기준)를 잰다. 저장소는 읽기만 한다 (쓰기 명령을 부르지 않는다).
//!
//! - 로컬 비교 (`--base <rev>` ↔ 지금 디스크, 초안 없음): `resolve_revision(base)` → `compare_local_files` →
//!   결과 첫 파일의 `compare_local_document`
//! - ref↔ref (`--other <rev>` 가 있을 때만): `resolve_revision` ×2 → `compare_refs`(two-dot) →
//!   `comparison_commits` 양방향 → 첫 파일의 `compare_file_diff_document`
//!
//! 저장소는 한 번 열고 그래프 로드가 끝난 뒤 실행마다 같은 세션으로 잰다.
//!
//! ```text
//! cargo run --release -p mgit-bench -- --compare <저장소> [--base HEAD] [--other <rev>] [--runs 3]
//! ```

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::time::Instant;

use mgit_core::{CommandLogRecord, Core, CoreError, DiffOptions, SessionId};
use serde_json::json;

use crate::Opts;
use crate::folder::{bench_core, command_count, commands_since, elapsed_ms, median};

/// 측정 구간 하나의 결과
struct Step {
    name: &'static str,
    ms: f64,
    git: usize,
    /// 경로 수 등 구간 결과 요약
    note: String,
    /// 이 구간에 돈 git 하위 명령별 횟수와 명령 로그의 소요 합계 (예: `ls-tree×323(1400ms)`)
    mix: String,
}

/// 명령 로그 한 줄의 하위 명령 이름. 전역 인자(`-c k=v`, `--literal-pathspecs` 등)는 건너뛴다
fn subcommand(args: &[String]) -> &str {
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "-c" || arg == "-C" {
            it.next();
        } else if !arg.starts_with('-') {
            return arg;
        }
    }
    "?"
}

/// 명령들을 하위 명령별 (횟수, 소요 합계 ms) 로 묶어 한 줄로 만든다 (이름 순). 소요는 명령 로그의 `elapsed_ms` 다
fn mix(records: &[CommandLogRecord]) -> String {
    let mut counts: BTreeMap<&str, (usize, u64)> = BTreeMap::new();
    for r in records {
        let slot = counts.entry(subcommand(&r.args)).or_default();
        slot.0 += 1;
        slot.1 += u64::from(r.elapsed_ms);
    }
    counts
        .iter()
        .map(|(name, (n, ms))| format!("{name}×{n}({ms}ms)"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 코어 호출 하나를 재서 (값, 구간 결과) 를 돌려준다. `note` 는 값으로 요약을 만든다
async fn step<T>(
    core: &Core,
    name: &'static str,
    call: impl Future<Output = Result<T, CoreError>>,
    note: impl FnOnce(&T) -> String,
) -> Result<(T, Step), String> {
    let before = command_count(core);
    let t = Instant::now();
    let value = call.await.map_err(|e| format!("{name}: {e}"))?;
    let ms = elapsed_ms(t);
    let ran = commands_since(core, before);
    let step = Step {
        name,
        ms,
        git: ran.len(),
        note: note(&value),
        mix: mix(&ran),
    };
    Ok((value, step))
}

/// 로컬 비교 한 번: 기준 확정 → 변경 파일 목록 → 첫 파일 문서
async fn local_once(core: &Core, id: SessionId, base: &str) -> Result<Vec<Step>, String> {
    let mut out = Vec::new();
    let (oid, s) = step(core, "resolve", core.resolve_revision(id, base), |_| {
        String::new()
    })
    .await?;
    out.push(s);
    let ((_, files), s) = step(
        core,
        "local_files",
        core.compare_local_files(id, &oid, &[]),
        |(_, files)| format!("paths={}", files.len()),
    )
    .await?;
    out.push(s);
    if let Some(first) = files.first() {
        let (_, s) = step(
            core,
            "local_document",
            core.compare_local_document(id, &oid, &first.path, None, DiffOptions::default(), false),
            |d| {
                format!(
                    "path={} hunks={} reason={}",
                    first.path,
                    d.diff.hunks.len(),
                    d.limit_reason.as_deref().unwrap_or("-")
                )
            },
        )
        .await?;
        out.push(s);
    }
    Ok(out)
}

/// ref↔ref 비교 한 번: 양쪽 확정 → 변경 파일 → 양쪽 커밋 목록 → 첫 파일 문서
async fn refs_once(
    core: &Core,
    id: SessionId,
    base: &str,
    other: &str,
) -> Result<Vec<Step>, String> {
    let mut out = Vec::new();
    let (a, s) = step(core, "resolve_a", core.resolve_revision(id, base), |_| {
        String::new()
    })
    .await?;
    out.push(s);
    let (b, s) = step(core, "resolve_b", core.resolve_revision(id, other), |_| {
        String::new()
    })
    .await?;
    out.push(s);
    let (files, s) = step(
        core,
        "compare_refs",
        core.compare_refs(id, &a, &b, false),
        |files| format!("paths={}", files.len()),
    )
    .await?;
    out.push(s);
    let commits_note = |(rows, truncated): &(Vec<(String, String, String)>, bool)| {
        format!("rows={}{}", rows.len(), if *truncated { "+" } else { "" })
    };
    let (_, s) = step(
        core,
        "commits_only_b",
        core.comparison_commits(id, &b, &a),
        commits_note,
    )
    .await?;
    out.push(s);
    let (_, s) = step(
        core,
        "commits_only_a",
        core.comparison_commits(id, &a, &b),
        commits_note,
    )
    .await?;
    out.push(s);
    if let Some(first) = files.first() {
        let (_, s) = step(
            core,
            "file_document",
            core.compare_file_diff_document(
                id,
                &a,
                &b,
                false,
                &first.path,
                DiffOptions::default(),
                false,
            ),
            |d| format!("path={} hunks={}", first.path, d.diff.hunks.len()),
        )
        .await?;
        out.push(s);
    }
    Ok(out)
}

/// 실행 한 번의 구간들을 한 줄로
fn run_line(steps: &[Step]) -> String {
    steps
        .iter()
        .map(|s| {
            let note = if s.note.is_empty() {
                String::new()
            } else {
                format!("({})", s.note)
            };
            format!("{}={:.0}ms/git{}{note}", s.name, s.ms, s.git)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 실행들의 구간별 중앙값을 찍고 JSON 으로 모은다. git 수·요약·명령 구성은 첫 실행 값이다
fn summarize(label: &str, runs: &[Vec<Step>]) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let Some(first) = runs.first() else {
        return out.into();
    };
    for (i, s) in first.iter().enumerate() {
        let ms = median(runs.iter().filter_map(|r| r.get(i)).map(|r| r.ms).collect());
        println!(
            "compare {label} {}(중앙값): {ms:.1}ms git_cmds={} {} [{}]",
            s.name, s.git, s.note, s.mix
        );
        out.insert(
            s.name.to_string(),
            json!({ "ms_median": ms, "git_cmds": s.git, "note": s.note, "mix": s.mix }),
        );
    }
    out.into()
}

/// 비교 모드 진입점: 저장소를 열고 `--runs` 번 재서 구간별 중앙값을 출력한다
pub async fn run(opts: &Opts, repo: &Path) {
    let result = async {
        let core = bench_core(opts).await?;
        let id = crate::tags::open(&core, repo).await?;
        let mut local = Vec::new();
        let mut refs = Vec::new();
        for i in 0..opts.runs {
            let steps = local_once(&core, id, &opts.base).await?;
            println!("compare local run {}: {}", i + 1, run_line(&steps));
            local.push(steps);
            if let Some(other) = &opts.other {
                let steps = refs_once(&core, id, &opts.base, other).await?;
                println!("compare refs run {}: {}", i + 1, run_line(&steps));
                refs.push(steps);
            }
        }
        core.close_repo(id).map_err(|e| e.to_string())?;
        Ok::<_, String>((local, refs))
    }
    .await;
    let (local, refs) = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("비교 측정 실패: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "compare repo={} base={} other={} runs={}",
        repo.display(),
        opts.base,
        opts.other.as_deref().unwrap_or("-"),
        local.len()
    );
    let local = summarize("local", &local);
    let refs = summarize("refs", &refs);
    println!("{}", json!({ "compare": { "local": local, "refs": refs } }));
}
