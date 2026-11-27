use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use mgit_model::{
    BoxFuture, CancelToken, EnvProfile, ExitInfo, GitError, GitOutput, GitRequest, GitRunner,
    GitStream, GitVersion, NON_LITERAL_COMMANDS, OutputSink,
};
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

use crate::env::apply_env;
use crate::locate::{LocateConfig, locate_git, resolve_xcrun_shim};

/// stdout 읽기 버퍼 크기
const CHUNK_SIZE: usize = 64 * 1024;
/// stderr 보관 상한 (마지막 부분만 남긴다)
const STDERR_KEEP: usize = 64 * 1024;
/// 스트림 채널 용량. 소비자가 느리면 git 이 파이프에서 블록된다 (역압)
const STREAM_CHANNEL_CAPACITY: usize = 32;
/// 프로세스가 끝난 뒤 파이프 EOF 를 기다리는 시간. 훅이 남긴 백그라운드 프로세스나 SSH 공유 연결이
/// 파이프를 쥐고 있어도 이 시간 뒤에는 명령을 끝낸다 (쓰기 큐가 막히지 않게)
const PIPE_DRAIN_GRACE: Duration = Duration::from_millis(300);
/// SIGTERM 시그널 번호 (unix)
#[cfg(unix)]
const SIGTERM: i32 = 15;

tokio::task_local! {
    /// 묶음 읽기 범위 표시 (`bulk_reads` 가 건다). 값은 없고 걸려 있는지만 본다
    static BULK_READ: ();
}

/// `fut` 안에서 도는 읽기 명령을 묶음 읽기로 센다 (반응성 슬라이스 12): 폴더 전체를 훑는 배경 읽기(요약·브랜치·변경·타임라인
/// 로드·작성자 후보·자동 fetch·백업 정리)가 읽기 한도 전부를 차지해 사용자가 누른 읽기를 줄 세우지 않게, 묶음 읽기는 따로 둔 작은
/// 한도(`RunnerConfig::max_concurrent_bulk_reads`)를 먼저 얻는다. 표시는 작업(task) 범위라 `tokio::spawn` 으로 넘긴 future 에는
/// 이어지지 않는다 — 훑기가 저장소마다 띄우는 작업마다 걸어야 한다. 쓰기·네트워크 명령에는 영향이 없다
pub async fn bulk_reads<F: Future>(fut: F) -> F::Output {
    BULK_READ.scope((), fut).await
}

/// 지금 작업이 묶음 읽기 범위 안인지
pub fn in_bulk_reads() -> bool {
    BULK_READ.try_with(|_| ()).is_ok()
}

/// 러너 설정
#[derive(Clone, Debug)]
pub struct RunnerConfig {
    pub locate: LocateConfig,
    /// 동시 읽기 명령 상한 (명세 2.3 동시성). 쓰기 명령은 쓰기 큐가 직렬화하므로 세지 않는다
    pub max_concurrent_reads: usize,
    /// 그중 묶음 읽기(`bulk_reads` 범위)가 동시에 쓸 수 있는 상한. 묶음 읽기는 이것을 먼저 얻고(대기열이 따로다) 전체 한도를
    /// 얻으므로, 사용자가 누른 읽기는 묶음 읽기의 긴 줄 뒤에 서지 않는다. 기본 7 은 전체 8 중 한 칸을 사용자가 누른 읽기에 늘
    /// 비워 둔다 — 커밋 상세(`log`·`diff-tree` 차례로)처럼 한 번에 git 하나씩 도는 조작은 기다리지 않는다. 측정(`mgit-bench
    /// --contention`, bench/README.md)에서 7 은 전체 갱신을 약 6%(status 가 느린 흉내에서 약 17%) 늦췄고, 6 은 약 20%(39%)
    /// 늦췄다. 전체 한도 이상이면 칸을 비워 두지 않는다(대기열만 따로)
    pub max_concurrent_bulk_reads: usize,
    /// 모든 명령에 붙는 환경 변수 (macOS 로그인 셸에서 얻은 PATH 등)
    pub extra_env: Vec<(String, String)>,
    /// `Network` 프로파일에만 붙는 환경 변수 (askpass 헬퍼)
    pub network_env: Vec<(String, String)>,
    /// 취소 시 SIGTERM 뒤 SIGKILL 까지 기다리는 시간
    pub terminate_grace: Duration,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        RunnerConfig {
            locate: LocateConfig::default(),
            max_concurrent_reads: 8,
            max_concurrent_bulk_reads: 7,
            extra_env: Vec::new(),
            network_env: Vec::new(),
            terminate_grace: Duration::from_secs(2),
        }
    }
}

/// tokio 프로세스 기반 [`GitRunner`] 구현
#[derive(Debug)]
pub struct TokioGitRunner {
    git: PathBuf,
    version: GitVersion,
    local_env_vars: Vec<String>,
    reads: Arc<Semaphore>,
    /// 묶음 읽기 한도 (`bulk_reads` 범위의 읽기만 먼저 얻는다)
    bulk_reads: Arc<Semaphore>,
    extra_env: Vec<(String, String)>,
    network_env: Mutex<Vec<(String, String)>>,
    grace: Duration,
}

impl TokioGitRunner {
    /// git 을 찾고 `--version` 으로 최소 버전을 검사한 뒤 `--local-env-vars` 목록을 보강한다
    pub async fn new(cfg: RunnerConfig) -> Result<Self, GitError> {
        let git = resolve_xcrun_shim(locate_git(&cfg.locate)?);
        let version = probe_version(&git, &cfg.extra_env).await?;
        if !version.meets_minimum() {
            return Err(GitError::VersionTooOld {
                found: version.short(),
                required: GitVersion::minimum_string(),
            });
        }
        let local_env_vars = probe_local_env_vars(&git, &cfg.extra_env).await;
        let reads = cfg.max_concurrent_reads.max(1);
        Ok(TokioGitRunner {
            git,
            version,
            local_env_vars,
            reads: Arc::new(Semaphore::new(reads)),
            bulk_reads: Arc::new(Semaphore::new(
                cfg.max_concurrent_bulk_reads.clamp(1, reads),
            )),
            extra_env: cfg.extra_env,
            network_env: Mutex::new(cfg.network_env),
            grace: cfg.terminate_grace,
        })
    }

    /// 찾은 git 실행 파일 경로
    pub fn git_path(&self) -> &PathBuf {
        &self.git
    }

    /// `Network` 프로파일 환경 변수를 교체한다 (askpass 소켓이 뜬 뒤 설정)
    pub fn set_network_env(&self, env: Vec<(String, String)>) {
        *self
            .network_env
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = env;
    }

    /// 요청으로 명령을 조립한다 (환경 정책·stdio·프로세스 그룹)
    fn build(&self, req: &GitRequest) -> CommandWrap {
        let mut cmd = Command::new(&self.git);
        cmd.args(&req.global_args)
            .args(&req.args)
            .current_dir(&req.cwd)
            .stdin(if req.stdin.is_some() {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let network = self
            .network_env
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        apply_env(
            &mut cmd,
            req.env,
            &self.local_env_vars,
            &self.extra_env,
            &network,
        );
        if req
            .args
            .first()
            .is_some_and(|sub| NON_LITERAL_COMMANDS.iter().any(|c| sub == c))
        {
            cmd.env_remove("GIT_LITERAL_PATHSPECS");
        }
        for (k, v) in &req.env_overrides {
            cmd.env(k, v);
        }
        wrap_command(cmd)
    }

    /// 지금 남은 (전체 읽기, 묶음 읽기) permit 수 (진단·테스트용)
    pub fn available_read_permits(&self) -> (usize, usize) {
        (
            self.reads.available_permits(),
            self.bulk_reads.available_permits(),
        )
    }

    /// 읽기 명령이면 세마포어 permit 을 얻는다. 쓰기는 큐가 직렬화하므로 바로 통과. 묶음 읽기 범위면 묶음 한도를 먼저 얻고
    /// 전체 한도를 얻는다 — 묶음 읽기가 전체 한도를 다 차지하지 못한다. 기다리는 중에 버려지면(취소) 얻은 것도 돌려준다
    async fn permit(&self, profile: EnvProfile) -> Result<Option<ReadPermit>, GitError> {
        if profile.is_write() {
            return Ok(None);
        }
        let bulk = if in_bulk_reads() {
            Some(
                self.bulk_reads
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| GitError::Cancelled)?,
            )
        } else {
            None
        };
        let read = self
            .reads
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| GitError::Cancelled)?;
        Ok(Some(ReadPermit {
            _bulk: bulk,
            _read: read,
        }))
    }
}

/// 읽기 명령 하나가 쥔 permit (드롭하면 둘 다 돌려준다)
#[derive(Debug)]
struct ReadPermit {
    _bulk: Option<OwnedSemaphorePermit>,
    _read: OwnedSemaphorePermit,
}

/// 플랫폼별 프로세스 그룹·콘솔 숨김을 적용한다. 드롭 시 kill 은 보험으로 항상 켠다
fn wrap_command(cmd: Command) -> CommandWrap {
    let mut wrap = CommandWrap::from(cmd);
    #[cfg(unix)]
    wrap.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        wrap.wrap(process_wrap::tokio::JobObject);
        wrap.wrap(process_wrap::tokio::CreationFlags(CREATE_NO_WINDOW));
    }
    wrap.wrap(KillOnDrop);
    wrap
}

/// 사용자 셸 명령(`sh -c`)을 프로세스 그룹으로 실행하고 출력을 모은다. `limit` 을 넘기면 자식까지
/// 그룹 전체를 끝내고 `None`. `kill_on_drop` 은 직계 자식만 끝내므로 명시적으로 그룹을 죽인다
pub async fn run_shell_command(
    cwd: &Path,
    command: &str,
    envs: &[(String, String)],
    limit: Duration,
) -> std::io::Result<Option<Output>> {
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = wrap_command(cmd).spawn()?;
    let stdout = child.stdout().take();
    let stderr = child.stderr().take();
    let deadline = tokio::time::Instant::now() + limit;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let finished = tokio::time::timeout_at(deadline, async {
        tokio::join!(
            pump(stdout, |c| out.extend_from_slice(c)),
            pump(stderr, |c| err.extend_from_slice(c)),
        );
        child.wait().await
    })
    .await;
    match finished {
        Ok(status) => Ok(Some(Output {
            status: status?,
            stdout: out,
            stderr: err,
        })),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Ok(None)
        }
    }
}

/// `git --version` 을 실행해 파싱한다
async fn probe_version(git: &PathBuf, extra: &[(String, String)]) -> Result<GitVersion, GitError> {
    let mut cmd = Command::new(git);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    apply_env(&mut cmd, EnvProfile::ReadBackground, &[], extra, &[]);
    let child = wrap_command(cmd).spawn().map_err(GitError::Spawn)?;
    let out = Box::into_pin(child.wait_with_output())
        .await
        .map_err(GitError::Spawn)?;
    if !out.status.success() {
        return Err(GitError::NotFound);
    }
    Ok(GitVersion::parse(&String::from_utf8_lossy(&out.stdout))?)
}

/// `git rev-parse --local-env-vars` 목록. 실패하면 빈 목록 (상수로 대체)
async fn probe_local_env_vars(git: &PathBuf, extra: &[(String, String)]) -> Vec<String> {
    let mut cmd = Command::new(git);
    cmd.args(["rev-parse", "--local-env-vars"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    apply_env(&mut cmd, EnvProfile::ReadBackground, &[], extra, &[]);
    let Ok(child) = wrap_command(cmd).spawn() else {
        return Vec::new();
    };
    match Box::into_pin(child.wait_with_output()).await {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// 파이프를 청크 단위로 읽어 콜백에 넘긴다. EOF 나 오류에서 끝난다
async fn pump<R: AsyncRead + Unpin>(pipe: Option<R>, mut on_chunk: impl FnMut(&[u8])) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => on_chunk(&buf[..n]),
        }
    }
}

/// stderr 링버퍼: 마지막 `STDERR_KEEP` 바이트만 남긴다
#[derive(Default)]
struct StderrTail(Vec<u8>);

impl StderrTail {
    /// 청크를 덧붙이고 상한을 넘으면 앞부분을 버린다
    fn push(&mut self, chunk: &[u8]) {
        self.0.extend_from_slice(chunk);
        if self.0.len() > STDERR_KEEP * 2 {
            let cut = self.0.len() - STDERR_KEEP;
            self.0.drain(..cut);
        }
    }

    /// lossy 문자열로 꺼낸다
    fn into_string(mut self) -> String {
        if self.0.len() > STDERR_KEEP {
            let cut = self.0.len() - STDERR_KEEP;
            self.0.drain(..cut);
        }
        String::from_utf8_lossy(&self.0).into_owned()
    }
}

/// stderr 를 링버퍼처럼 모은다 (스트림 경로용)
async fn collect_stderr(stderr: Option<tokio::process::ChildStderr>) -> String {
    let mut tail = StderrTail::default();
    pump(stderr, |c| tail.push(c)).await;
    tail.into_string()
}

/// stdin 에 바이트를 쓰고 닫는다
async fn write_stdin(stdin: Option<tokio::process::ChildStdin>, bytes: Option<Vec<u8>>) {
    if let (Some(mut pipe), Some(bytes)) = (stdin, bytes) {
        let _ = pipe.write_all(&bytes).await;
        let _ = pipe.shutdown().await;
    }
}

/// 취소 토큰이 있으면 취소를 기다리고, 없으면 영원히 대기한다
async fn wait_cancel(cancel: &Option<CancelToken>) {
    match cancel {
        Some(t) => t.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

/// 프로세스(그룹)를 부드럽게 끝낸다: SIGTERM → grace → SIGKILL (Windows 는 바로 종료)
fn terminate(child: &mut Box<dyn ChildWrapper>, _grace: Duration) -> bool {
    #[cfg(unix)]
    {
        child.signal(SIGTERM).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = child.start_kill();
        false
    }
}

/// 종료 상태를 `ExitInfo` 로
fn exit_info(status: std::process::ExitStatus, stderr: String) -> ExitInfo {
    ExitInfo {
        status: status.code(),
        stderr,
    }
}

/// 아무것도 하지 않는 출력 싱크 (`run` 용)
struct NullSink;

impl OutputSink for NullSink {
    fn on_stdout(&self, _: &[u8]) {}
    fn on_stderr(&self, _: &[u8]) {}
}

impl GitRunner for TokioGitRunner {
    fn version(&self) -> &GitVersion {
        &self.version
    }

    fn run<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        self.run_observed(req, Arc::new(NullSink))
    }

    fn run_observed<'a>(
        &'a self,
        req: GitRequest,
        sink: Arc<dyn OutputSink>,
    ) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        Box::pin(async move {
            let _permit = self.permit(req.env).await?;
            if req.cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
                return Err(GitError::Cancelled);
            }
            let started = Instant::now();
            let args = req.display_args();
            let mut child = self.build(&req).spawn().map_err(GitError::Spawn)?;
            let stdin = child.stdin().take();
            let stdout = child.stdout().take();
            let stderr = child.stderr().take();

            let stdin_bytes = req.stdin.clone();
            let io_sink = Arc::clone(&sink);
            let stdout_bytes = Arc::new(Mutex::new(Vec::new()));
            let stderr_tail = Arc::new(Mutex::new(StderrTail::default()));
            // 세 파이프는 별도 태스크가 EOF 까지 읽는다. 명령의 끝은 프로세스 종료로 판단한다
            let mut pipes = tokio::spawn({
                let stdout_bytes = Arc::clone(&stdout_bytes);
                let stderr_tail = Arc::clone(&stderr_tail);
                async move {
                    tokio::join!(
                        write_stdin(stdin, stdin_bytes),
                        pump(stdout, |c| {
                            stdout_bytes
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .extend_from_slice(c);
                            io_sink.on_stdout(c);
                        }),
                        pump(stderr, |c| {
                            stderr_tail
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .push(c);
                            io_sink.on_stderr(c);
                        }),
                    );
                }
            });

            let mut cancelled = false;
            let status = tokio::select! {
                status = child.wait() => status,
                _ = wait_cancel(&req.cancel) => {
                    cancelled = true;
                    if terminate(&mut child, self.grace)
                        && let Ok(status) = tokio::time::timeout(self.grace, child.wait()).await
                    {
                        status
                    } else {
                        // SIGTERM 을 무시하면 grace 뒤 SIGKILL
                        let _ = child.start_kill();
                        child.wait().await
                    }
                }
            }
            .map_err(GitError::Spawn)?;
            // 정상이면 바로 EOF 다. 시간을 넘기면 읽기 태스크는 둔 채 지금까지의 출력만 돌려준다
            let _ = tokio::time::timeout(PIPE_DRAIN_GRACE, &mut pipes).await;
            let stdout_bytes =
                std::mem::take(&mut *stdout_bytes.lock().unwrap_or_else(PoisonError::into_inner));
            let stderr_tail =
                std::mem::take(&mut *stderr_tail.lock().unwrap_or_else(PoisonError::into_inner));
            tracing::debug!(
                args = ?args,
                elapsed_ms = started.elapsed().as_millis() as u64,
                status = ?status.code(),
                cancelled,
                "git run"
            );
            if cancelled {
                return Err(GitError::Cancelled);
            }
            Ok(GitOutput {
                exit: exit_info(status, stderr_tail.into_string()),
                stdout: stdout_bytes,
            })
        })
    }

    fn stream<'a>(
        &'a self,
        req: GitRequest,
    ) -> BoxFuture<'a, Result<Box<dyn GitStream>, GitError>> {
        Box::pin(async move {
            let permit = self.permit(req.env).await?;
            let args = req.display_args();
            let mut child = self.build(&req).spawn().map_err(GitError::Spawn)?;
            let stdin = child.stdin().take();
            let stdout = child.stdout().take();
            let stderr = child.stderr().take();
            let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(STREAM_CHANNEL_CAPACITY);
            let (exit_tx, exit_rx) = oneshot::channel();
            let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

            // 리더 태스크가 child 를 소유한다. 취소 핸들이 드롭되면 kill 하고, 항상 wait() 한다
            tokio::spawn(stream_task(StreamTask {
                child,
                stdin,
                stdin_bytes: req.stdin,
                stdout,
                stderr,
                chunk_tx,
                exit_tx,
                cancel_rx,
                cancel: req.cancel,
                args,
                grace: self.grace,
            }));
            Ok(Box::new(TokioGitStream {
                rx: chunk_rx,
                exit: Some(exit_rx),
                _cancel: cancel_tx,
                _permit: permit,
            }) as Box<dyn GitStream>)
        })
    }
}

/// 스트림 리더 태스크 입력
struct StreamTask {
    child: Box<dyn ChildWrapper>,
    stdin: Option<tokio::process::ChildStdin>,
    stdin_bytes: Option<Vec<u8>>,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    chunk_tx: mpsc::Sender<Vec<u8>>,
    exit_tx: oneshot::Sender<Result<ExitInfo, GitError>>,
    cancel_rx: oneshot::Receiver<()>,
    cancel: Option<CancelToken>,
    args: Vec<String>,
    grace: Duration,
}

/// 스트림 리더 태스크: stdout 을 청크로 보내고, 취소 신호가 오면 프로세스(그룹)를 죽인다
async fn stream_task(task: StreamTask) {
    let StreamTask {
        mut child,
        stdin,
        stdin_bytes,
        stdout,
        stderr,
        chunk_tx,
        exit_tx,
        mut cancel_rx,
        cancel,
        args,
        grace,
    } = task;
    let started = Instant::now();
    let stderr_task = tokio::spawn(collect_stderr(stderr));
    write_stdin(stdin, stdin_bytes).await;

    let mut cancelled = false;
    if let Some(mut pipe) = stdout {
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            tokio::select! {
                read = pipe.read(&mut buf) => {
                    match read {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if chunk_tx.send(buf[..n].to_vec()).await.is_err() {
                                // 소비자가 사라짐 → 취소와 같다
                                cancelled = true;
                                break;
                            }
                        }
                    }
                }
                _ = &mut cancel_rx => {
                    cancelled = true;
                    break;
                }
                _ = wait_cancel(&cancel) => {
                    cancelled = true;
                    break;
                }
            }
        }
    }
    if cancelled {
        let graceful = terminate(&mut child, grace);
        if graceful && tokio::time::timeout(grace, child.wait()).await.is_err() {
            let _ = child.start_kill();
        }
    }
    drop(chunk_tx);
    let status = child.wait().await;
    let stderr_text = stderr_task.await.unwrap_or_default();
    tracing::debug!(
        args = ?args,
        elapsed_ms = started.elapsed().as_millis() as u64,
        status = ?status.as_ref().ok().and_then(|s| s.code()),
        cancelled,
        "git stream"
    );
    let result = if cancelled {
        Err(GitError::Cancelled)
    } else {
        status
            .map(|s| exit_info(s, stderr_text))
            .map_err(GitError::Spawn)
    };
    let _ = exit_tx.send(result);
}

/// 스트리밍 핸들. 드롭하면 `_cancel` 이 닫혀 리더 태스크가 프로세스를 죽인다
struct TokioGitStream {
    rx: mpsc::Receiver<Vec<u8>>,
    exit: Option<oneshot::Receiver<Result<ExitInfo, GitError>>>,
    _cancel: oneshot::Sender<()>,
    _permit: Option<ReadPermit>,
}

impl GitStream for TokioGitStream {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, GitError>> {
        Box::pin(async move { Ok(self.rx.recv().await) })
    }

    fn finish(mut self: Box<Self>) -> BoxFuture<'static, Result<ExitInfo, GitError>> {
        let exit = self.exit.take();
        Box::pin(async move {
            // 남은 청크를 비워 리더 태스크가 블록되지 않게 한다
            while self.rx.recv().await.is_some() {}
            match exit {
                Some(rx) => rx.await.unwrap_or(Err(GitError::Cancelled)),
                None => Err(GitError::Cancelled),
            }
        })
    }
}
