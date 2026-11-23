//! 폴더 stage·unstage 모드 (W18, `--stage <폴더>`). 픽스처는 `bench/setup.sh stage` 로 만든 폴더다 (저장소 1개,
//! 추적 파일 N개가 모두 수정된 상태). 폴더 Commit 도구 창의 체크박스가 하는 일과 그 뒤의 부분 갱신을 잰다:
//!
//! - `stage_all` / `unstage_all`: 저장소 전부 (`IndexTarget::All`)
//! - `stage_dir` / `unstage_dir`: 디렉터리 하나 (`src/d-00`, 파일 N/100개)
//! - `stage_file` / `unstage_file`: 파일 하나
//! - `refresh`: 쓰기 뒤 그 저장소만 요약 + 브랜치 + 변경을 동시에 다시 읽기 (프런트의 `reloadNow`)
//!
//! 매 실행은 stage → unstage 짝이라 끝나면 픽스처가 처음 상태(전부 unstaged)로 돌아온다. 시작할 때도 전부 unstage 해
//! 앞선 측정이 중간에 끊겨 남은 stage 를 지운다

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use mgit_core::{Core, CoreEvent, EventSink, IndexTarget, SessionId};
use serde_json::json;

use crate::Opts;
use crate::folder::{bench_core, command_count, elapsed_ms, median, verdict};

/// 합격선: 쓰기 한 번 + 부분 갱신을 "요약 전체"와 같은 2초 안으로 본다 (계획에 따로 없는 값 — W18 의 판단 기준)
const STAGE_LIMIT_MS: f64 = 2000.0;

/// 측정 단계 이름 (출력 순서)
const STEPS: [&str; 9] = [
    "changes",
    "stage_all",
    "refresh_after_stage",
    "unstage_all",
    "refresh_after_unstage",
    "stage_dir",
    "unstage_dir",
    "stage_file",
    "unstage_file",
];

/// 그 저장소만 요약 + 브랜치 + 변경을 동시에 읽는다. (stage 된 수, 변경 수)
async fn refresh_one(core: &Core, id: SessionId, repo: &Path) -> Result<(u32, usize), String> {
    let repos = [repo.to_path_buf()];
    let (s, b, c) = tokio::join!(
        core.folder_summaries(id, &repos),
        core.folder_branches(id, &repos),
        core.folder_changes(id, &repos),
    );
    s.map_err(|e| e.to_string())?;
    b.map_err(|e| e.to_string())?;
    let changes = c.map_err(|e| e.to_string())?;
    let staged = changes.iter().map(|r| r.summary.staged).sum();
    let entries = changes.iter().map(|r| r.entries.len()).sum();
    Ok((staged, entries))
}

/// stage·unstage 한 번 (시간, git 명령 수)
async fn write_once(
    core: &Core,
    id: SessionId,
    repo: &Path,
    stage: bool,
    target: &IndexTarget,
) -> Result<(f64, usize), String> {
    let before = command_count(core);
    let t = Instant::now();
    let r = if stage {
        core.folder_stage(id, repo, target).await
    } else {
        core.folder_unstage(id, repo, target).await
    };
    r.map_err(|e| e.to_string())?;
    Ok((elapsed_ms(t), command_count(core) - before))
}

/// 한 번 측정: 단계마다 (시간, git 명령 수, 메모)
async fn run_once(
    core: &Core,
    id: SessionId,
    repo: &Path,
    file: &str,
) -> Result<Vec<(f64, usize, String)>, String> {
    let mut out = Vec::new();
    let before = command_count(core);
    let t = Instant::now();
    let changes = core
        .folder_changes(id, &[repo.to_path_buf()])
        .await
        .map_err(|e| e.to_string())?;
    let entries: usize = changes.iter().map(|r| r.entries.len()).sum();
    out.push((
        elapsed_ms(t),
        command_count(core) - before,
        format!("entries={entries}"),
    ));
    let all = IndexTarget::All;
    let dir = IndexTarget::Paths(vec!["src/d-00".into()]);
    let one = IndexTarget::Paths(vec![file.to_string()]);
    for (stage, target) in [(true, &all), (false, &all)] {
        let (ms, cmds) = write_once(core, id, repo, stage, target).await?;
        out.push((ms, cmds, String::new()));
        let before = command_count(core);
        let t = Instant::now();
        let (staged, entries) = refresh_one(core, id, repo).await?;
        out.push((
            elapsed_ms(t),
            command_count(core) - before,
            format!("staged={staged} entries={entries}"),
        ));
    }
    for target in [&dir, &one] {
        for stage in [true, false] {
            let (ms, cmds) = write_once(core, id, repo, stage, target).await?;
            out.push((ms, cmds, String::new()));
        }
    }
    Ok(out)
}

/// stage 모드 진입점: `--runs` 번 재고 단계별 중앙값을 출력한다
pub async fn run(opts: &Opts, folder: &Path) {
    let result = async {
        let core = bench_core(opts).await?;
        let sink: Arc<dyn EventSink> = Arc::new(|_e: CoreEvent| {});
        let opened = core
            .open_folder(folder, sink)
            .await
            .map_err(|e| e.to_string())?;
        let id = opened.session;
        let repo: PathBuf = opened
            .repos
            .first()
            .map(|r| r.path.clone())
            .ok_or("저장소가 없음")?;
        // 앞선 측정이 남긴 stage 를 지운다
        core.folder_unstage(id, &repo, &IndexTarget::All)
            .await
            .map_err(|e| e.to_string())?;
        let file = "src/d-00/file-00000.txt";
        let mut runs = Vec::new();
        for i in 0..opts.runs {
            let r = run_once(&core, id, &repo, file).await?;
            let line: Vec<String> = STEPS
                .iter()
                .zip(&r)
                .map(|(s, (ms, cmds, note))| {
                    let note = if note.is_empty() {
                        String::new()
                    } else {
                        format!("({note})")
                    };
                    format!("{s}={ms:.0}ms/git{cmds}{note}")
                })
                .collect();
            println!("stage run {}: {}", i + 1, line.join(" "));
            runs.push(r);
        }
        let (_, entries) = refresh_one(&core, id, &repo).await?;
        core.close_folder(id).map_err(|e| e.to_string())?;
        Ok::<_, String>((repo, runs, entries))
    }
    .await;
    let (repo, runs, entries) = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("stage 측정 실패: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "stage repo={} runs={} 끝난 뒤 변경 {entries}개",
        repo.display(),
        runs.len()
    );
    let mut out = serde_json::Map::new();
    for (i, step) in STEPS.iter().enumerate() {
        let ms = median(runs.iter().map(|r| r[i].0).collect());
        let (_, cmds, note) = &runs[0][i];
        println!("stage {step}(중앙값): {ms:.1}ms git_cmds={cmds} {note}");
        out.insert(
            (*step).to_string(),
            json!({ "ms_median": ms, "git_cmds": cmds, "note": note }),
        );
    }
    let all_round = median(runs.iter().map(|r| r[1].0 + r[2].0).collect());
    println!(
        "stage 전부 + 부분 갱신(중앙값): {all_round:.0}ms (≤{STAGE_LIMIT_MS:.0}) {}",
        verdict(all_round <= STAGE_LIMIT_MS)
    );
    out.insert("stage_all_with_refresh_ms_median".into(), json!(all_round));
    println!("{}", json!({ "stage": out }));
}
