use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use crate::env::EnvProfile;
use crate::error::GitError;
use crate::version::GitVersion;

/// 객체 안전 트레이트용 boxed future
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 취소 신호. 복제본은 같은 신호를 공유한다. 러너는 취소되면 프로세스(그룹)에
/// SIGTERM 을 보내고 잠시 뒤 SIGKILL 한다 (명세 2.3 장시간 명령·취소)
#[derive(Clone, Debug, Default)]
pub struct CancelToken(tokio_util::sync::CancellationToken);

impl CancelToken {
    /// 새 토큰
    pub fn new() -> Self {
        Self::default()
    }

    /// 취소를 알린다. 여러 번 불러도 안전하다
    pub fn cancel(&self) {
        self.0.cancel();
    }

    /// 이미 취소됐는지
    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    /// 취소될 때까지 기다린다
    pub async fn cancelled(&self) {
        self.0.cancelled().await;
    }
}

/// git 실행 요청. 셸을 거치지 않고 인자 배열로 실행한다.
#[derive(Clone, Debug)]
pub struct GitRequest {
    pub cwd: PathBuf,
    /// 서브커맨드 앞에 오는 전역 인자 (`-c key=value` 등)
    pub global_args: Vec<OsString>,
    /// 서브커맨드부터 시작하는 인자
    pub args: Vec<OsString>,
    pub env: EnvProfile,
    /// `Some` 이면 파이프로 써 넣고 닫는다. `None` 이면 stdin 을 닫아 입력 대기를 막는다
    pub stdin: Option<Vec<u8>>,
    /// 취소 토큰. 없으면 취소할 수 없다
    pub cancel: Option<CancelToken>,
    /// 프로파일 뒤에 덮어쓰는 환경 변수 (예: `GIT_SEQUENCE_EDITOR`)
    pub env_overrides: Vec<(String, String)>,
}

impl GitRequest {
    /// 백그라운드 읽기 프로파일로 요청을 만든다
    pub fn new(
        cwd: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        GitRequest {
            cwd: cwd.into(),
            global_args: Vec::new(),
            args: args.into_iter().map(Into::into).collect(),
            env: EnvProfile::ReadBackground,
            stdin: None,
            cancel: None,
            env_overrides: Vec::new(),
        }
    }

    /// `-c key=value` 전역 설정을 붙인다
    pub fn with_config(mut self, key: &str, value: &str) -> Self {
        self.global_args.push("-c".into());
        self.global_args.push(format!("{key}={value}").into());
        self
    }

    /// 환경 프로파일을 바꾼다
    pub fn with_env(mut self, env: EnvProfile) -> Self {
        self.env = env;
        self
    }

    /// 환경 변수 하나를 덮어쓴다 (프로파일 설정보다 우선)
    pub fn with_env_var(mut self, key: &str, value: &str) -> Self {
        self.env_overrides
            .push((key.to_string(), value.to_string()));
        self
    }

    /// stdin 으로 넘길 바이트를 지정한다
    pub fn with_stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// 취소 토큰을 붙인다
    pub fn with_cancel(mut self, cancel: CancelToken) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// 로그용 인자 문자열 목록
    pub fn display_args(&self) -> Vec<String> {
        self.global_args
            .iter()
            .chain(self.args.iter())
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }
}

/// 프로세스 종료 정보
#[derive(Clone, Debug)]
pub struct ExitInfo {
    /// 종료 코드. 시그널로 죽었으면 `None`
    pub status: Option<i32>,
    /// stderr 마지막 부분 (lossy UTF-8)
    pub stderr: String,
}

impl ExitInfo {
    /// 정상 종료(0)인지
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }
}

/// `run` 결과
#[derive(Debug)]
pub struct GitOutput {
    pub exit: ExitInfo,
    pub stdout: Vec<u8>,
}

impl GitOutput {
    /// 종료 코드가 0이면 stdout 을, 아니면 `GitError::Exit` 를 돌려준다
    pub fn ok(self, args: &[String]) -> Result<Vec<u8>, GitError> {
        if self.exit.success() {
            Ok(self.stdout)
        } else {
            Err(GitError::Exit {
                status: self.exit.status,
                stderr: self.exit.stderr,
                args: args.to_vec(),
            })
        }
    }

    /// stdout 을 lossy 문자열로
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// 실행 중인 명령의 출력을 청크 단위로 받는 포트 (hook 출력 스트리밍, 진행률)
pub trait OutputSink: Send + Sync {
    /// stdout 청크
    fn on_stdout(&self, bytes: &[u8]);
    /// stderr 청크
    fn on_stderr(&self, bytes: &[u8]);
}

/// git 실행 포트. `mgit-git` 이 tokio 프로세스로 구현한다.
pub trait GitRunner: Send + Sync + 'static {
    /// 시작 시 확인한 git 버전
    fn version(&self) -> &GitVersion;

    /// 끝까지 실행하고 stdout 전체를 모은다
    fn run<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>>;

    /// 끝까지 실행하되 stdout·stderr 청크를 `sink` 로 흘려 보낸다. 결과에는 stdout 전체와
    /// stderr 마지막 부분이 함께 담긴다
    fn run_observed<'a>(
        &'a self,
        req: GitRequest,
        sink: Arc<dyn OutputSink>,
    ) -> BoxFuture<'a, Result<GitOutput, GitError>>;

    /// stdout 을 청크 단위로 스트리밍한다
    fn stream<'a>(&'a self, req: GitRequest)
    -> BoxFuture<'a, Result<Box<dyn GitStream>, GitError>>;
}

/// 스트리밍 중인 git 프로세스. 드롭하면 프로세스(그룹)를 죽인다.
pub trait GitStream: Send {
    /// 다음 stdout 청크. `None` 이면 EOF
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, GitError>>;

    /// 프로세스 종료를 기다리고 종료 정보를 돌려준다
    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<ExitInfo, GitError>>;
}
