//! 코어 테스트 공용: 러너·코어 조립과 이벤트 수집
#![allow(dead_code, clippy::unwrap_used)]

use std::sync::Arc;
use std::time::Duration;

use mgit_core::{Core, CoreConfig, CoreEvent, EventSink, SessionId};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::MemoryStore;
use mgit_watch::NotifyWatcher;
use tokio::sync::mpsc;

/// 기본 설정으로 코어를 만든다 (감시 없음)
pub async fn core() -> Core {
    core_with(CoreConfig::default()).await
}

/// 설정을 지정해 코어를 만든다 (감시 없음)
pub async fn core_with(cfg: CoreConfig) -> Core {
    let cfg = isolated_config(cfg);
    let runner = TokioGitRunner::new(RunnerConfig::default()).await.unwrap();
    Core::new(Arc::new(runner), cfg)
}

/// notify 감시자를 단 코어 (외부 변경 반영 테스트)
pub async fn core_watching() -> Core {
    let runner = TokioGitRunner::new(RunnerConfig::default()).await.unwrap();
    Core::with_deps(
        Arc::new(runner),
        Arc::new(NotifyWatcher {
            debounce: Duration::from_millis(100),
            ..NotifyWatcher::default()
        }),
        Arc::new(MemoryStore::new()),
        isolated_config(CoreConfig::default()),
    )
}

/// 테스트의 rebase 자료와 폐기 백업이 배포·다른 테스트의 임시 자료에 접근하지 않게 한다.
fn isolated_config(mut cfg: CoreConfig) -> CoreConfig {
    let parent =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/core-test-runtime");
    std::fs::create_dir_all(&parent).unwrap();
    // 코어가 살아 있는 동안 유지하며 실패 시 분석할 수 있도록 checkout의 target 아래에 남긴다.
    let root = tempfile::tempdir_in(parent).unwrap().keep();
    if cfg.temp_dir.is_none() {
        cfg.temp_dir = Some(root.join("temp"));
    }
    if cfg.backup_dir.is_none() {
        cfg.backup_dir = Some(root.join("backups"));
    }
    cfg
}

/// 이벤트를 채널로 모으는 sink
pub fn collector() -> (Arc<dyn EventSink>, mpsc::UnboundedReceiver<CoreEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
        let _ = tx.send(e);
    });
    (sink, rx)
}

/// `GraphLoadFinished` 또는 `GraphLoadFailed` 가 올 때까지 이벤트를 모은다
pub async fn wait_finished(
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    session: SessionId,
) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    let deadline = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(e) = rx.recv().await {
            if e.session() != session {
                continue;
            }
            let done = matches!(
                e,
                CoreEvent::GraphLoadFinished { .. } | CoreEvent::GraphLoadFailed { .. }
            );
            events.push(e);
            if done {
                break;
            }
        }
    });
    deadline.await.expect("로드 완료 이벤트 시간 초과");
    events
}

/// 이벤트가 `quiet` 동안 끊길 때까지 받아 버린다 (최대 `max`, 넘기면 panic). 받은 이벤트를 돌려준다.
/// 저장소를 연 직후 `git status` 가 `.git/index` 를 고치는 등 늦게 오는 감시 이벤트를 비울 때 쓴다
/// (느린 CI 에서는 고정 대기보다 늦게 도착한다)
pub async fn wait_quiet(
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    quiet: Duration,
    max: Duration,
) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    let res = tokio::time::timeout(max, async {
        while let Ok(Some(e)) = tokio::time::timeout(quiet, rx.recv()).await {
            events.push(e);
        }
    })
    .await;
    assert!(
        res.is_ok(),
        "이벤트가 잦아들지 않음. 받은 이벤트: {events:#?}"
    );
    events
}

/// 조건에 맞는 이벤트가 올 때까지 기다린다 (시간 초과면 panic). 그 사이 이벤트도 함께 돌려준다
pub async fn wait_for(
    rx: &mut mpsc::UnboundedReceiver<CoreEvent>,
    timeout: Duration,
    mut pred: impl FnMut(&CoreEvent) -> bool,
) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    let res = tokio::time::timeout(timeout, async {
        while let Some(e) = rx.recv().await {
            let hit = pred(&e);
            events.push(e);
            if hit {
                break;
            }
        }
    })
    .await;
    assert!(res.is_ok(), "이벤트 시간 초과. 받은 이벤트: {events:#?}");
    events
}
