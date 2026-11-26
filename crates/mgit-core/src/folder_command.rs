//! 선택한 저장소들에 git 명령 실행 (MR-14 일괄 명령). 사용자가 입력한 git 하위 명령을 저장소마다 그 작업 트리에서
//! 실행하고 종료 코드·소요 시간·출력을 모은다.
//!
//! 셸을 거치지 않는다: 프런트가 나눈 인자 배열을 러너(`GitRunner::stream`)로 그대로 실행한다 (명세 2.3 명령 주입 방지,
//! MR-14 "임의의 git 명령"). 그래서 환경 변수·PATH(로그인 셸 PATH)·자격 증명 대화상자(askpass)·명령 기록과 그 가림·
//! 취소(프로세스 그룹 SIGTERM → SIGKILL)를 다른 일괄 작업과 같은 규칙으로 쓴다. 일괄 작업의 동시 실행 수·취소·작업
//! 기록은 `BatchOp::RunCommand` 로 `batch_run` 을 그대로 지난다.

use std::ffi::OsString;
use std::path::Path;
use std::time::Instant;

use mgit_l10n::{pick, tr};
use mgit_model::{CancelToken, EnvProfile, GitError, GitRequest, redact_args, redact_text};
use serde::{Deserialize, Serialize};

use crate::core::CoreInner;
use crate::error::CoreError;
use crate::folder_batch::{RepoResult, reason};

/// 저장소 하나에서 보관하는 stdout 의 상한 (앞부분). 넘는 것은 읽어 버리고 잘렸다고 표시한다
pub const COMMAND_STDOUT_MAX: usize = 1024 * 1024;
/// 러너가 보관하는 stderr 끝부분의 크기 (`mgit-git` 의 `STDERR_KEEP`). 이만큼 차 있으면 앞부분이 잘렸다고 본다
pub const COMMAND_STDERR_KEEP: usize = 64 * 1024;
/// 인자 수의 상한
const ARGS_MAX: usize = 256;
/// 인자 전체 길이의 상한 (바이트)
const ARGS_BYTES_MAX: usize = 16 * 1024;
/// 작업 이름에 넣는 명령 글자의 상한 (넘으면 말줄임)
const LABEL_COMMAND_MAX: usize = 160;

/// 저장소 하나에서 실행한 명령의 결과
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    /// 종료 코드. 시그널로 끝났거나 취소했으면 None
    pub status: Option<i32>,
    pub elapsed_ms: u64,
    /// stdout 앞부분 (`COMMAND_STDOUT_MAX` 까지, URL 자격 증명 가림)
    pub stdout: String,
    /// stdout 이 상한을 넘어 뒷부분을 버렸다
    pub stdout_truncated: bool,
    /// stderr 끝부분 (`COMMAND_STDERR_KEEP` 까지, URL 자격 증명 가림)
    pub stderr: String,
    /// stderr 앞부분이 잘렸을 수 있다 (보관 크기만큼 차 있다)
    pub stderr_truncated: bool,
}

/// 명령 인자 검사: 비지 않았고, 첫 인자가 빈 글자가 아니며, 수·길이가 상한 안이고 NUL 이 없다
pub(crate) fn validate(args: &[String]) -> Result<(), CoreError> {
    let message = if args.first().is_none_or(|first| first.trim().is_empty()) {
        pick(
            "실행할 git 명령을 입력하세요.",
            "Enter a git command to run",
        )
        .to_string()
    } else if args.len() > ARGS_MAX {
        tr!(
            "인자가 너무 많습니다 (최대 {ARGS_MAX}개)",
            "Too many arguments (at most {ARGS_MAX})"
        )
    } else if args.iter().map(String::len).sum::<usize>() > ARGS_BYTES_MAX {
        pick("명령이 너무 깁니다.", "The command is too long").to_string()
    } else if args.iter().any(|a| a.contains('\0')) {
        let text = pick(
            "명령에 쓸 수 없는 글자가 있습니다.",
            "The command contains an invalid character",
        );
        text.to_string()
    } else {
        return Ok(());
    };
    Err(CoreError::Invalid(message))
}

/// 인자 하나를 보이는 꼴로: 공백·따옴표가 있으면 작은따옴표로 감싼다 (작업 이름 표시용, 다시 실행하지 않는다)
fn shown_arg(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| !c.is_whitespace() && !matches!(c, '\'' | '"' | '\\'));
    if plain {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// 진행 표시·작업 기록의 이름 (`명령 실행: git status -sb`). 자격 증명은 가리고 길면 줄인다
pub(crate) fn label(args: &[String]) -> String {
    let shown: Vec<String> = redact_args(args).iter().map(|a| shown_arg(a)).collect();
    let mut command = shown.join(" ");
    if command.chars().count() > LABEL_COMMAND_MAX {
        command = command.chars().take(LABEL_COMMAND_MAX).collect::<String>() + "…";
    }
    tr!("명령 실행: git {command}", "Run: git {command}")
}

/// stdout 을 상한까지 모은다. 넘는 것은 읽기만 하고 버린다 (프로세스가 파이프에서 막히지 않게)
#[derive(Default)]
struct HeadBuffer {
    bytes: Vec<u8>,
    truncated: bool,
}

impl HeadBuffer {
    /// 청크를 상한까지 덧붙인다
    fn push(&mut self, chunk: &[u8]) {
        let room = COMMAND_STDOUT_MAX.saturating_sub(self.bytes.len());
        if chunk.len() > room {
            self.truncated = true;
        }
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    /// lossy 문자열로 (잘린 끝의 깨진 UTF-8 은 대체 문자가 된다)
    fn into_text(self) -> (String, bool) {
        (
            String::from_utf8_lossy(&self.bytes).into_owned(),
            self.truncated,
        )
    }
}

/// 실패 줄에 붙일 사유 한 줄: stderr 의 마지막 빈 줄 아닌 줄 (없으면 종료 코드)
fn failure_line(stderr: &str, status: Option<i32>) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match status {
            Some(code) => tr!("종료 코드 {code}", "Exit code {code}"),
            None => pick("신호로 끝났습니다", "Terminated by a signal").into(),
        })
}

/// 저장소 하나에서 명령을 실행한다 (쓰기 잠금은 부르는 쪽이 쥐고 있다). 네트워크 명령일 수 있어 `Network`
/// 프로파일(자격 증명 대화상자)로 돌리고, 사용자가 쓴 pathspec 글롭(`'*.md'`)이 뜻대로 되게 글자 그대로 pathspec 을 끈다.
/// 종료 코드가 0 이 아니면 실패다. 취소로 멈추면 "실행 중에 취소" 로 따로 센다 (모은 출력은 남긴다)
pub(crate) async fn execute(
    inner: &CoreInner,
    work_tree: &Path,
    args: &[String],
    cancel: CancelToken,
    mut r: RepoResult,
) -> RepoResult {
    let started = Instant::now();
    let tag = inner.auth_tag();
    let req = GitRequest::new(work_tree, args.iter().map(OsString::from))
        .with_env(EnvProfile::Network)
        .with_env_var("GIT_LITERAL_PATHSPECS", "0")
        .with_env_var(mgit_helper::ENV_TAG, &tag)
        .with_cancel(cancel.clone());
    let mut head = HeadBuffer::default();
    let exit = match inner.runner().stream(req).await {
        Ok(mut stream) => {
            // 청크를 읽다 오류가 나면(취소 등) 그만 읽고 종료 정보로 넘어간다
            while let Ok(Some(chunk)) = stream.next_chunk().await {
                head.push(&chunk);
            }
            stream.finish().await
        }
        Err(e) => Err(e),
    };
    let (stdout, stdout_truncated) = head.into_text();
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let output = |status: Option<i32>, stderr: &str| CommandOutput {
        status,
        elapsed_ms,
        stdout: redact_text(&stdout),
        stdout_truncated,
        stderr: redact_text(stderr),
        stderr_truncated: stderr.len() >= COMMAND_STDERR_KEEP,
    };
    match exit {
        Ok(info) => {
            inner.report_auth(&tag, &info.stderr).await;
            r.ok = info.success();
            if !r.ok {
                r.message = redact_text(&failure_line(&info.stderr, info.status));
            }
            r.command = Some(output(info.status, &info.stderr));
        }
        Err(GitError::Cancelled) => {
            r.skip(reason::interrupted());
            r.cancelled = true;
            r.command = Some(output(None, ""));
        }
        Err(e) => {
            r.message = redact_text(&e.to_string());
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 글자 목록
    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn validate_rejects_empty_long_and_nul() {
        assert!(validate(&args(&["status", "-sb"])).is_ok());
        assert!(validate(&[]).is_err());
        assert!(validate(&args(&["  "])).is_err());
        assert!(validate(&args(&["log", "a\0b"])).is_err());
        assert!(validate(&vec!["x".to_string(); ARGS_MAX + 1]).is_err());
        assert!(validate(&args(&["log", &"x".repeat(ARGS_BYTES_MAX)])).is_err());
    }

    #[test]
    fn label_quotes_and_redacts() {
        let shown = label(&args(&[
            "log",
            "--format=%h %s",
            "https://user:s3cret@example.com/r.git",
        ]));
        assert!(shown.ends_with("git log '--format=%h %s' https://user:***@example.com/r.git"));
        assert!(!shown.contains("s3cret"));
        assert!(label(&args(&["x"; 200])).ends_with('…'));
    }

    #[test]
    fn head_buffer_keeps_the_first_part_and_marks_truncation() {
        let mut head = HeadBuffer::default();
        head.push(&vec![b'a'; COMMAND_STDOUT_MAX - 1]);
        head.push(b"bc");
        let (text, truncated) = head.into_text();
        assert_eq!(text.len(), COMMAND_STDOUT_MAX);
        assert!(text.ends_with('b'));
        assert!(truncated);
        let mut small = HeadBuffer::default();
        small.push(b"ok\n");
        assert_eq!(small.into_text(), ("ok\n".to_string(), false));
    }

    #[test]
    fn failure_line_is_the_last_stderr_line_or_the_exit_code() {
        assert_eq!(
            failure_line("warning: x\nfatal: no such ref\n\n", Some(128)),
            "fatal: no such ref"
        );
        assert!(failure_line("", Some(1)).contains('1'));
    }
}
