//! 쓰기 큐 (명세 2.3 동시성): `common_dir` 단위 직렬화, `index.lock` 재시도,
//! 감시 억제 → 명령 후 전체 재조회 1회, 출력 스트리밍·취소.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use mgit_model::{EnvProfile, GitError, GitRequest, classify_stderr, redact_args, redact_text};

use crate::core::CoreInner;
use crate::error::CoreError;
use crate::events::CoreEvent;
use crate::messages;
use crate::ops::{LineEventSink, OpHandle};
use crate::refresh::RefreshScope;
use crate::session::RepoSession;

/// 쓰기 명령 명세
#[derive(Clone, Debug)]
pub struct WriteSpec {
    /// 서브커맨드부터 시작하는 인자
    pub args: Vec<OsString>,
    pub stdin: Option<Vec<u8>>,
    /// 네트워크 명령이면 `Network` 프로파일 (askpass)
    pub network: bool,
    /// 등록된 장시간 명령 핸들. 있으면 출력을 `OperationOutput` 으로 흘리고 취소할 수 있다
    pub op: Option<OpHandle>,
    /// 명령 뒤 재조회를 건너뛴다 (연속 명령의 중간 단계)
    pub skip_refresh: bool,
    /// stderr 의 `--progress` 줄을 `OperationProgress` 로 바꾼다 (op 가 있을 때)
    pub progress: bool,
    /// undo 스택 표시용 이름. 없으면 인자 앞 두 개로 만든다
    pub label: Option<String>,
    /// undo 스냅샷을 찍지 않는다 (undo/redo 자체, 백업 ref 쓰기 등)
    pub no_undo: bool,
    /// 요청 환경 변수 덮어쓰기
    pub env: Vec<(String, String)>,
}

impl WriteSpec {
    /// 인자만으로 만든다
    pub fn new(args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        WriteSpec {
            args: args.into_iter().map(Into::into).collect(),
            stdin: None,
            network: false,
            op: None,
            skip_refresh: false,
            progress: false,
            label: None,
            no_undo: false,
            env: Vec::new(),
        }
    }

    /// 환경 변수 덮어쓰기
    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    /// undo 표시 이름
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// undo 스냅샷 생략
    pub fn no_undo(mut self) -> Self {
        self.no_undo = true;
        self
    }

    /// 기본 라벨: 서브커맨드 + 첫 옵션
    pub fn default_label(&self) -> String {
        self.args
            .iter()
            .take(2)
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// 진행률 파싱 켜기
    pub fn progress(mut self) -> Self {
        self.progress = true;
        self
    }

    /// stdin 지정
    pub fn with_stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// 네트워크 프로파일
    pub fn network(mut self) -> Self {
        self.network = true;
        self
    }

    /// 장시간 명령 핸들을 붙인다
    pub fn with_op(mut self, op: OpHandle) -> Self {
        self.op = Some(op);
        self
    }

    /// 재조회 생략
    pub fn skip_refresh(mut self) -> Self {
        self.skip_refresh = true;
        self
    }
}

/// 쓰기 명령 결과 (종료 코드 0)
#[derive(Clone, Debug)]
pub struct WriteResult {
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl WriteResult {
    /// stdout 을 lossy 문자열로
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// stderr 가 `index.lock` 생성 실패를 말하는지
fn is_index_lock_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("index.lock") && (lower.contains("exists") || lower.contains("unable to create"))
}

impl CoreInner {
    /// 쓰기 명령을 큐에서 실행한다. 0이 아닌 코드는 `CommandFailed`(힌트 포함)로 돌려준다
    pub async fn run_write(
        self: &Arc<Self>,
        session: &Arc<RepoSession>,
        spec: WriteSpec,
    ) -> Result<WriteResult, CoreError> {
        let lock = self.write_lock_for(&session.info.common_dir);
        let _queued = lock.lock().await;
        // SF-03: ref 변경을 되돌릴 수 있게 전후 스냅샷을 찍는다 (브랜치·태그·HEAD 만)
        let before = if spec.no_undo {
            None
        } else {
            self.snapshot(session).await
        };
        session.suppress_watch();
        let outcome = self.run_write_locked(session, &spec).await;
        if let (Some(before), Ok(_)) = (&before, &outcome)
            && let Some(after) = self.snapshot(session).await
            && *before != after
        {
            session
                .undo
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(
                    spec.label.clone().unwrap_or_else(|| spec.default_label()),
                    before.clone(),
                    after,
                    self.cfg.undo_capacity,
                );
        }
        let deferred = session.release_watch();
        drop(_queued);

        if !spec.skip_refresh {
            // 명령이 만든 변경과 억제 중 쌓인 외부 변경을 한 번에 반영한다
            let mut scope = RefreshScope::all(true);
            if !deferred.is_empty() {
                scope = RefreshScope::all(true);
            }
            self.refresh_session(session, scope).await;
            // 같은 common_dir 를 쓰는 다른 세션(워크트리)도 ref 가 바뀌었을 수 있다
            for other in self.sessions_sharing(&session.info.common_dir, session.id) {
                self.refresh_session(&other, RefreshScope::all(true)).await;
            }
        }
        outcome
    }

    /// 같은 `common_dir` 를 공유하는 다른 세션들
    fn sessions_sharing(
        &self,
        common_dir: &std::path::Path,
        me: crate::events::SessionId,
    ) -> Vec<Arc<RepoSession>> {
        self.sessions
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|s| s.id != me && s.info.common_dir == common_dir)
            .cloned()
            .collect()
    }

    /// 세션 없이 작업 트리에 쓰기 명령 하나를 돌린다 (폴더 화면의 stage·unstage). 호출자가 그 저장소의 쓰기
    /// 잠금(`write_lock_for(common_dir)`)을 쥐고 부른다. 세션 쓰기와 같은 실행(설정 덮어쓰기·`index.lock` 재시도·
    /// 실패 분류·명령 로그)을 거치고, 세션에 묶인 것(undo 스냅샷·감시 억제·재조회·`op` 출력)은 없다.
    /// `spec.op`·`spec.network` 는 쓰지 않는다 (네트워크·장시간 명령은 세션의 `run_write` 로)
    pub(crate) async fn run_write_at(
        &self,
        work_tree: &Path,
        spec: &WriteSpec,
    ) -> Result<WriteResult, CoreError> {
        debug_assert!(spec.op.is_none() && !spec.network);
        self.run_write_in(work_tree, None, spec).await
    }

    /// 큐 락을 쥔 채로 실행한다 (`index.lock` 재시도 포함)
    async fn run_write_locked(
        &self,
        session: &Arc<RepoSession>,
        spec: &WriteSpec,
    ) -> Result<WriteResult, CoreError> {
        self.run_write_in(&session.info.work_tree, Some(session), spec)
            .await
    }

    /// 쓰기 잠금을 쥔 채 `work_tree` 에서 명령을 돌린다 (`index.lock` 재시도 포함). `session` 이 있으면 장시간 명령의
    /// 출력·끝 이벤트를 그 세션으로 보낸다. 세션 쓰기(`run_write_locked`)와 세션 없는 쓰기(`run_write_at`)가 함께 쓴다
    async fn run_write_in(
        &self,
        work_tree: &Path,
        session: Option<&Arc<RepoSession>>,
        spec: &WriteSpec,
    ) -> Result<WriteResult, CoreError> {
        let profile = if spec.network {
            EnvProfile::Network
        } else {
            EnvProfile::Write
        };
        let line_sink = spec.op.as_ref().zip(session).map(|(op, session)| {
            Arc::new(LineEventSink::new(
                Arc::clone(&session.sink),
                session.id,
                op.id,
                spec.progress,
            ))
        });
        // 장시간 명령이면 끝 이벤트를 세션으로 보낸다 (세션 없는 쓰기에는 등록된 명령이 없다)
        let finish = |ok: bool, cancelled: bool, message: &str| {
            if let Some(session) = session {
                self.finish_op(session, spec, ok, cancelled, message);
            }
        };

        let auth_tag = spec.network.then(|| self.auth_tag());
        let mut attempt = 0;
        loop {
            let mut req = GitRequest::new(work_tree, spec.args.clone()).with_env(profile);
            if let Some(tag) = &auth_tag {
                req = req.with_env_var(mgit_helper::ENV_TAG, tag);
            }
            for (k, v) in &self.cfg.git_config_overrides {
                req = req.with_config(k, v);
            }
            if let Some(bytes) = &spec.stdin {
                req = req.with_stdin(bytes.clone());
            }
            for (k, v) in &spec.env {
                req = req.with_env_var(k, v);
            }
            if let Some(op) = &spec.op {
                req = req.with_cancel(op.cancel.clone());
            }
            let args = redact_args(&req.display_args());
            let result = match &line_sink {
                Some(ls) => {
                    let out = self.runner().run_observed(req, ls.clone()).await;
                    ls.flush();
                    out
                }
                None => self.runner().run(req).await,
            };
            let out = match result {
                Ok(out) => out,
                Err(GitError::Cancelled) => {
                    if let Some(tag) = &auth_tag {
                        self.report_auth(tag, "").await;
                    }
                    finish(false, true, messages::cancelled());
                    return Err(CoreError::Cancelled);
                }
                Err(e) => {
                    if let Some(tag) = &auth_tag {
                        self.report_auth(tag, "").await;
                    }
                    finish(false, false, &redact_text(&e.to_string()));
                    return Err(e.into());
                }
            };
            if out.exit.success() {
                if let Some(tag) = &auth_tag {
                    self.report_auth(tag, "").await;
                }
                finish(true, false, "");
                return Ok(WriteResult {
                    stdout: out.stdout,
                    stderr: out.exit.stderr,
                });
            }
            if is_index_lock_error(&out.exit.stderr) && attempt < self.cfg.index_lock_retries {
                attempt += 1;
                tokio::time::sleep(self.cfg.index_lock_retry_delay).await;
                continue;
            }
            if let Some(tag) = &auth_tag {
                self.report_auth(tag, &out.exit.stderr).await;
            }
            // merge 의 CONFLICT 안내처럼 stdout 에만 나오는 메시지도 분류·표시에 쓴다
            let stdout_text = String::from_utf8_lossy(&out.stdout).into_owned();
            let hint = classify_stderr(&out.exit.stderr).or_else(|| classify_stderr(&stdout_text));
            let text = redact_text(if out.exit.stderr.trim().is_empty() {
                &stdout_text
            } else {
                &out.exit.stderr
            });
            finish(false, false, &text);
            return Err(CoreError::CommandFailed {
                args,
                status: out.exit.status,
                stderr: text,
                hint,
            });
        }
    }

    /// 장시간 명령이면 `OperationFinished` 를 보내고 등록을 지운다
    fn finish_op(
        &self,
        session: &RepoSession,
        spec: &WriteSpec,
        ok: bool,
        cancelled: bool,
        message: &str,
    ) {
        let Some(op) = &spec.op else {
            return;
        };
        self.ops.end(op.id);
        let lock_left = cancelled && session.info.git_dir.join("index.lock").exists();
        session.sink.emit(CoreEvent::OperationFinished {
            session: session.id,
            op_id: op.id,
            ok,
            cancelled,
            message: message.to_string(),
            lock_left,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_lock_detection() {
        assert!(is_index_lock_error(
            "fatal: Unable to create '/r/.git/index.lock': File exists.\n"
        ));
        assert!(!is_index_lock_error("error: something else"));
    }
}
