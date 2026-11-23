//! 모든 git 호출을 기록하는 러너 래퍼 (SF-01 명령 로그).
//!
//! `mgit-git` 의 명령 함수들은 `&dyn GitRunner` 만 받으므로, 코어가 주입받은 러너를
//! 이 래퍼로 감싸 넘기면 읽기·쓰기 구분 없이 모든 명령이 기록된다.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, Weak};
use std::time::Instant;

use mgit_model::{
    BoxFuture, CommandLogRecord, ExitInfo, GitError, GitOutput, GitRequest, GitRunner, GitStream,
    GitVersion, OutputSink, now_millis, redact_args, redact_text, stderr_tail,
};

/// 기록을 받을 곳
pub trait CommandLogHook: Send + Sync {
    /// 명령 하나가 끝났다
    fn on_command(&self, record: CommandLogRecord);
}

/// 기록하는 러너
pub struct LoggedRunner {
    inner: Arc<dyn GitRunner>,
    next_id: AtomicU64,
    hook: RwLock<Option<Weak<dyn CommandLogHook>>>,
}

impl std::fmt::Debug for LoggedRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LoggedRunner")
    }
}

/// 실행 전에 잡아 두는 기록 재료
#[derive(Clone)]
struct Pending {
    id: u64,
    args: Vec<String>,
    cwd: std::path::PathBuf,
    started_at: i64,
    started: Instant,
    is_write: bool,
}

impl LoggedRunner {
    /// 러너를 감싼다. 훅은 나중에 `set_hook` 으로 단다
    pub fn new(inner: Arc<dyn GitRunner>) -> Self {
        LoggedRunner {
            inner,
            next_id: AtomicU64::new(1),
            hook: RwLock::new(None),
        }
    }

    /// 기록 훅을 단다 (약한 참조라 코어가 먼저 사라져도 안전)
    pub fn set_hook(&self, hook: Weak<dyn CommandLogHook>) {
        *self.hook.write().unwrap_or_else(|e| e.into_inner()) = Some(hook);
    }

    /// 요청에서 기록 재료를 만든다
    fn begin(&self, req: &GitRequest) -> Pending {
        Pending {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            args: redact_args(&req.display_args()),
            cwd: req.cwd.clone(),
            started_at: now_millis(),
            started: Instant::now(),
            is_write: req.env.is_write(),
        }
    }

    /// 기록을 완성해 훅에 넘긴다
    fn finish(&self, p: &Pending, status: Option<i32>, stderr: &str, cancelled: bool) {
        let record = CommandLogRecord {
            id: p.id,
            args: p.args.clone(),
            cwd: p.cwd.clone(),
            started_at: p.started_at,
            elapsed_ms: p.started.elapsed().as_millis().min(u32::MAX as u128) as u32,
            status,
            stderr_tail: stderr_tail(&redact_text(stderr)),
            is_write: p.is_write,
            cancelled,
        };
        let hook = self
            .hook
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(Weak::upgrade);
        if let Some(h) = hook {
            h.on_command(record);
        }
    }

    /// `run`/`run_observed` 결과를 기록한다
    fn record_result(&self, p: &Pending, result: &Result<GitOutput, GitError>) {
        match result {
            Ok(out) => self.finish(p, out.exit.status, &out.exit.stderr, false),
            Err(GitError::Cancelled) => self.finish(p, None, "", true),
            Err(e) => self.finish(p, None, &e.to_string(), false),
        }
    }
}

impl GitRunner for LoggedRunner {
    fn version(&self) -> &GitVersion {
        self.inner.version()
    }

    fn run<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        Box::pin(async move {
            let p = self.begin(&req);
            let result = self.inner.run(req).await;
            self.record_result(&p, &result);
            result
        })
    }

    fn run_observed<'a>(
        &'a self,
        req: GitRequest,
        sink: Arc<dyn OutputSink>,
    ) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        Box::pin(async move {
            let p = self.begin(&req);
            let result = self.inner.run_observed(req, sink).await;
            self.record_result(&p, &result);
            result
        })
    }

    fn stream<'a>(
        &'a self,
        req: GitRequest,
    ) -> BoxFuture<'a, Result<Box<dyn GitStream>, GitError>> {
        Box::pin(async move {
            let p = self.begin(&req);
            match self.inner.stream(req).await {
                Ok(stream) => Ok(Box::new(LoggedStream {
                    inner: Some(stream),
                    pending: Some(p),
                    logger: self_arc(self),
                }) as Box<dyn GitStream>),
                Err(e) => {
                    self.finish(&p, None, &e.to_string(), false);
                    Err(e)
                }
            }
        })
    }
}

/// `&self` 로는 `'static` 스트림에 기록기를 넣을 수 없어 훅만 떼어 쓴다
fn self_arc(runner: &LoggedRunner) -> StreamLogger {
    StreamLogger {
        hook: runner
            .hook
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    }
}

/// 스트림 종료 시 기록을 남기는 최소 정보
struct StreamLogger {
    hook: Option<Weak<dyn CommandLogHook>>,
}

impl StreamLogger {
    /// 기록을 완성해 훅에 넘긴다
    fn finish(&self, p: &Pending, status: Option<i32>, stderr: &str, cancelled: bool) {
        let record = CommandLogRecord {
            id: p.id,
            args: p.args.clone(),
            cwd: p.cwd.clone(),
            started_at: p.started_at,
            elapsed_ms: p.started.elapsed().as_millis().min(u32::MAX as u128) as u32,
            status,
            stderr_tail: stderr_tail(&redact_text(stderr)),
            is_write: p.is_write,
            cancelled,
        };
        if let Some(h) = self.hook.as_ref().and_then(Weak::upgrade) {
            h.on_command(record);
        }
    }
}

/// 종료·드롭 시 기록을 남기는 스트림 래퍼
struct LoggedStream {
    inner: Option<Box<dyn GitStream>>,
    pending: Option<Pending>,
    logger: StreamLogger,
}

impl GitStream for LoggedStream {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, GitError>> {
        match self.inner.as_mut() {
            Some(s) => s.next_chunk(),
            None => Box::pin(async { Err(GitError::Cancelled) }),
        }
    }

    fn finish(mut self: Box<Self>) -> BoxFuture<'static, Result<ExitInfo, GitError>> {
        let inner = self.inner.take();
        let pending = self.pending.take();
        let logger = StreamLogger {
            hook: self.logger.hook.clone(),
        };
        Box::pin(async move {
            let result = match inner {
                Some(s) => s.finish().await,
                None => Err(GitError::Cancelled),
            };
            if let Some(p) = pending {
                match &result {
                    Ok(exit) => logger.finish(&p, exit.status, &exit.stderr, false),
                    Err(GitError::Cancelled) => logger.finish(&p, None, "", true),
                    Err(e) => logger.finish(&p, None, &e.to_string(), false),
                }
            }
            result
        })
    }
}

impl Drop for LoggedStream {
    /// `finish` 없이 드롭되면 취소로 기록한다
    fn drop(&mut self) {
        if let Some(p) = self.pending.take() {
            self.logger.finish(&p, None, "", true);
        }
    }
}
