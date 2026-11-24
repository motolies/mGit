//! 초기 로드를 끊은 재로드가 실패해도 그래프가 로딩 상태에 머물지 않는다
#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::{collector, wait_for};
use mgit_core::{Core, CoreConfig, CoreEvent, LoadState};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::{
    BoxFuture, ExitInfo, GitError, GitOutput, GitRequest, GitRunner, GitStream, GitVersion,
    OutputSink,
};
use mgit_testkit::{Scenario, build};

/// 영원히 끝나지 않는 로그 스트림 (로드가 도는 중인 상태를 붙잡아 둔다)
struct Stuck;

impl GitStream for Stuck {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, GitError>> {
        Box::pin(std::future::pending())
    }

    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<ExitInfo, GitError>> {
        Box::pin(std::future::pending())
    }
}

/// 처음엔 스트림을 멈춰 두고, `fail` 이 켜지면 스트림을 실패시키는 러너
struct Flaky {
    inner: TokioGitRunner,
    started: AtomicBool,
    fail: AtomicBool,
}

impl GitRunner for Flaky {
    fn version(&self) -> &GitVersion {
        self.inner.version()
    }

    fn run<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        self.inner.run(req)
    }

    fn run_observed<'a>(
        &'a self,
        req: GitRequest,
        sink: Arc<dyn OutputSink>,
    ) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        self.inner.run_observed(req, sink)
    }

    fn stream<'a>(
        &'a self,
        _req: GitRequest,
    ) -> BoxFuture<'a, Result<Box<dyn GitStream>, GitError>> {
        Box::pin(async move {
            if self.fail.load(Ordering::SeqCst) {
                return Err(GitError::Unsupported("재로드 실패".into()));
            }
            self.started.store(true, Ordering::SeqCst);
            Ok(Box::new(Stuck) as Box<dyn GitStream>)
        })
    }
}

/// 초기 로드 중 재로드가 끝까지 실패하면 그래프는 실패 상태로 끝나고 프런트에 알린다
#[tokio::test]
async fn failed_reload_after_aborted_initial_load_ends_loading() {
    let inner = TokioGitRunner::new(RunnerConfig::default()).await.unwrap();
    let runner = Arc::new(Flaky {
        inner,
        started: AtomicBool::new(false),
        fail: AtomicBool::new(false),
    });
    let core = Core::new(
        Arc::clone(&runner) as Arc<dyn GitRunner>,
        CoreConfig::default(),
    );
    let repo = build(Scenario::Linear(2));
    let (sink, _rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    while !runner.started.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // 로드 중 재연결도 현재 행 수를 알리고, 뒤의 실패 이벤트를 새 채널로 전달합니다.
    let (sink, mut reconnected) = collector();
    let again = core.open_repo(repo.path(), sink).await.unwrap();
    assert_eq!(again.session, opened.session);
    wait_for(&mut reconnected, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphFirstChunk { rows: 0, .. })
    })
    .await;
    let mut rx = reconnected;

    runner.fail.store(true, Ordering::SeqCst);
    core.reload_graph(opened.session).unwrap();
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphReloadFailed { .. })
    })
    .await;
    let state = core.load_state(opened.session).unwrap();
    assert!(matches!(state, LoadState::Failed(_)), "{state:?}");
    assert!(core.graph_window(opened.session, 0, 10).unwrap().finished);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::GraphLoadFailed { .. })),
        "프런트가 streaming 에서 벗어나도록 초기 로드 실패도 알린다: {events:?}"
    );

    // 실패한 상태를 다시 열면 무한 로딩 대신 원래 실패를 새 채널로 재전송합니다.
    let (sink, mut reconnected) = collector();
    core.open_repo(repo.path(), sink).await.unwrap();
    wait_for(&mut reconnected, Duration::from_secs(5), |e| {
        matches!(e, CoreEvent::GraphLoadFailed { message, .. } if message.contains("재로드 실패"))
    }).await;
    let mut rx = reconnected;

    // 실패 상태의 그래프를 재배치로 완료처럼 보이게 하지 않고 다시 읽기를 시도한다
    core.relayout_graph(opened.session).unwrap();
    let events = wait_for(&mut rx, Duration::from_secs(5), |e| {
        matches!(
            e,
            CoreEvent::GraphReloaded { .. } | CoreEvent::GraphReloadFailed { .. }
        )
    })
    .await;
    assert!(
        matches!(events.last(), Some(CoreEvent::GraphReloadFailed { .. })),
        "{events:?}"
    );
}
