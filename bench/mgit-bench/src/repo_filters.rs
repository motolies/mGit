//! 저장소 모드의 해시 패스 측정 (W18, `--repo <경로> --filters`). 단일 저장소 그래프에서 검색어가 해시로 보이면
//! (7~40자 hex) 메시지 검색 뒤에 같은 범위의 로그를 한 번 더 걸어 해시 접두가 맞는 커밋을 끼운다. 그 추가 비용을
//! 결과 수가 같은(0~1개) 해시가 아닌 텍스트 검색과 견줘 잰다:
//!
//! - `text_nohash`: hex 가 아닌 글자 `zqxwvk` — 메시지 검색 한 번 (전 이력, 일치 0)
//! - `hash`: `HEAD~5000`(없으면 HEAD) 해시의 앞 10자 — 메시지 검색 + 해시 패스(전 이력을 받아 파싱)
//!
//! 시간은 `set_graph_query` 호출부터 `GraphReloaded` 까지 (정규식 확인·ref 확인 포함, 화면이 기다리는 시간). 경우 사이에는
//! 기본 질의로 되돌린다 (되돌리는 재로드는 재지 않는다)

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use mgit_core::{CoreEvent, EventSink, GraphQuery};
use serde_json::json;
use tokio::sync::mpsc;

use crate::Opts;
use crate::folder::{
    bench_core, command_count, elapsed_ms, median, probe_oid, text_filter, wait_loaded,
    wait_reloaded,
};

/// 해시 패스 측정 진입점: 경우마다 `--runs` 번 재고 중앙값을 출력한다
pub async fn report(opts: &Opts, repo: &Path) {
    let result = async {
        let core = bench_core(opts).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
            let _ = tx.send(e);
        });
        let opened = core
            .open_repo(repo, sink)
            .await
            .map_err(|e| e.to_string())?;
        let id = opened.session;
        let (rows, _) = wait_loaded(&mut rx, id).await?;
        let base = core.graph_query(id).map_err(|e| e.to_string())?;
        let target = probe_oid(repo, &["rev-parse", "HEAD~5000"])
            .or_else(|| probe_oid(repo, &["rev-parse", "HEAD"]))
            .ok_or("HEAD 없음")?;
        let hash = target.to_hex()[..10].to_string();
        let cases = [("text_nohash", "zqxwvk".to_string()), ("hash", hash)];
        let mut out = Vec::new();
        for (label, pattern) in &cases {
            let mut ms = Vec::new();
            let mut rows_found = 0;
            let mut cmds = 0;
            for _ in 0..opts.runs {
                let query = GraphQuery {
                    filter: text_filter(pattern),
                    ..base.clone()
                };
                let before = command_count(&core);
                let t = Instant::now();
                core.set_graph_query(id, query)
                    .await
                    .map_err(|e| e.to_string())?;
                rows_found = wait_reloaded(&mut rx, id).await?;
                ms.push(elapsed_ms(t));
                cmds = command_count(&core) - before;
                core.set_graph_query(id, base.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                wait_reloaded(&mut rx, id).await?;
            }
            out.push((*label, ms, rows_found, cmds));
        }
        core.close_repo(id).map_err(|e| e.to_string())?;
        Ok::<_, String>((rows, out))
    }
    .await;
    match result {
        Ok((rows, cases)) => {
            println!(
                "filters repo={} rows={rows} runs={}",
                repo.display(),
                opts.runs
            );
            let mut map = serde_json::Map::new();
            let mut meds = Vec::new();
            for (label, ms, found, cmds) in cases {
                let runs: Vec<String> = ms.iter().map(|m| format!("{m:.0}")).collect();
                let med = median(ms);
                println!(
                    "필터 {label}(중앙값): {med:.0}ms [{}] rows={found} git_cmds={cmds}",
                    runs.join(", ")
                );
                map.insert(
                    label.to_string(),
                    json!({ "ms_median": med, "rows": found, "git_cmds": cmds }),
                );
                meds.push(med);
            }
            if let [plain, hash] = meds[..] {
                println!("해시 패스 추가 시간(중앙값 차): {:.0}ms", hash - plain);
            }
            println!("{}", json!({ "repo_filters": map }));
        }
        Err(e) => {
            eprintln!("해시 패스 측정 실패: {e}");
            std::process::exit(1);
        }
    }
}
