//! 파일 트리 모드 (W18, `--fs <폴더>`): 파일 트리 API 의 코어 쪽 시간을 잰다. 픽스처는 `bench/setup.sh fs` 로 만든
//! git 저장소가 아닌 폴더다 (`big/` 에 빈 파일 N개, `file-1m.txt` 정확히 1 MiB 텍스트). 폴더 세션의 루트로 연다.
//!
//! - `list_default`: `fs_list_dir("big")` 기본 상한(2,000개) — 처음 펼칠 때
//! - `list_max`: `fs_list_dir("big", 50,000)` — "더 보기"로 상한까지 올렸을 때
//! - `read_1mib`: `fs_read_file("file-1m.txt")` — 파일 보기 상한과 같은 크기의 텍스트를 다 읽는다
//!
//! 시간은 호출부터 반환까지(블로킹 스레드 왕복 포함)이고 IPC 직렬화·화면 그리기는 들지 않는다 (W18 ② 의 몫)

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use mgit_core::{Core, CoreEvent, EventSink, FS_LIST_MAX_LIMIT, FsFile, FsListing, SessionId};
use serde_json::json;

use crate::Opts;
use crate::folder::{bench_core, elapsed_ms, median};

/// 파일 트리 측정 대상 하나
struct FsProbe {
    label: &'static str,
    ms: Vec<f64>,
    detail: String,
}

/// 나열 한 번: (시간, 요약)
async fn list_once(
    core: &Core,
    id: SessionId,
    limit: Option<u32>,
) -> Result<(f64, String), String> {
    let t = Instant::now();
    let listing = core
        .fs_list_dir(id, "big", limit)
        .await
        .map_err(|e| e.to_string())?;
    let ms = elapsed_ms(t);
    let detail = match listing {
        FsListing::Listed {
            entries,
            total,
            truncated,
            ..
        } => format!(
            "entries={} total={total} truncated={truncated}",
            entries.len()
        ),
        other => format!("{other:?}"),
    };
    Ok((ms, detail))
}

/// 1 MiB 파일 읽기 한 번: (시간, 요약)
async fn read_once(core: &Core, id: SessionId) -> Result<(f64, String), String> {
    let t = Instant::now();
    let file = core
        .fs_read_file(id, "file-1m.txt")
        .await
        .map_err(|e| e.to_string())?;
    let ms = elapsed_ms(t);
    let detail = match file {
        FsFile::Text { text, size } => format!("text bytes={} size={size}", text.len()),
        other => format!("{other:?}"),
    };
    Ok((ms, detail))
}

/// 파일 트리 모드 진입점: 대상마다 `--runs` 번 재고 중앙값을 출력한다
pub async fn run(opts: &Opts, root: &Path) {
    let result = async {
        let core = bench_core(opts).await?;
        let sink: Arc<dyn EventSink> = Arc::new(|_e: CoreEvent| {});
        let t = Instant::now();
        let opened = core
            .open_folder(root, sink)
            .await
            .map_err(|e| e.to_string())?;
        let open_ms = elapsed_ms(t);
        let id = opened.session;
        let mut probes = vec![
            FsProbe {
                label: "list_default",
                ms: Vec::new(),
                detail: String::new(),
            },
            FsProbe {
                label: "list_max",
                ms: Vec::new(),
                detail: String::new(),
            },
            FsProbe {
                label: "read_1mib",
                ms: Vec::new(),
                detail: String::new(),
            },
        ];
        for _ in 0..opts.runs {
            for p in &mut probes {
                let (ms, detail) = match p.label {
                    "list_default" => list_once(&core, id, None).await?,
                    "list_max" => list_once(&core, id, Some(FS_LIST_MAX_LIMIT)).await?,
                    _ => read_once(&core, id).await?,
                };
                p.ms.push(ms);
                p.detail = detail;
            }
        }
        core.close_folder(id).map_err(|e| e.to_string())?;
        Ok::<_, String>((open_ms, probes))
    }
    .await;
    match result {
        Ok((open_ms, probes)) => {
            println!(
                "fs root={} runs={} open_folder={open_ms:.0}ms",
                root.display(),
                opts.runs
            );
            let mut out = serde_json::Map::new();
            for p in probes {
                let runs: Vec<String> = p.ms.iter().map(|m| format!("{m:.1}")).collect();
                let med = median(p.ms);
                println!(
                    "fs {}(중앙값): {med:.1}ms [{}] {}",
                    p.label,
                    runs.join(", "),
                    p.detail
                );
                out.insert(
                    p.label.to_string(),
                    json!({ "ms_median": med, "detail": p.detail }),
                );
            }
            println!("{}", json!({ "fs": out }));
        }
        Err(e) => {
            eprintln!("fs 측정 실패: {e}");
            std::process::exit(1);
        }
    }
}
