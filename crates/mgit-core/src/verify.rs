//! 해결 검증 (CF-25)·저장소별 검증 명령·워크트리 초기화 명령 (WT-07)

use std::path::Path;
use std::time::Instant;

use mgit_git::cmd::show_stage;
use mgit_git::run_shell_command;
use mgit_l10n::{pick, tr};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;

/// 출력 보관 최대 길이 (끝부분)
const OUTPUT_TAIL: usize = 8000;

/// 구문 검사 비교 (CF-25): 결과 vs 양쪽 원본
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCompare {
    pub language: String,
    pub result_errors: u32,
    /// 충돌 중이면 ours/theirs 의 오류 수
    pub ours_errors: Option<u32>,
    pub theirs_errors: Option<u32>,
    pub first_error_line: Option<u32>,
    /// 결과의 오류가 양쪽 중 나은 쪽보다 많다 (새로 생긴 오류)
    pub new_errors: bool,
}

/// 셸 명령 실행 결과
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRun {
    pub command: String,
    pub ok: bool,
    pub status: Option<i32>,
    /// stdout+stderr 끝부분
    pub output: String,
    pub elapsed_ms: u64,
    pub timed_out: bool,
}

/// 검증 명령 설정 키 (워크트리끼리 공유: common dir 기준)
fn verify_key(common_dir: &Path) -> String {
    format!("verify-command:{}", common_dir.display())
}

/// 워크트리 초기화 명령 설정 키
fn init_key(common_dir: &Path) -> String {
    format!("worktree-init:{}", common_dir.display())
}

/// 문자열 설정 읽기 (JSON 문자열)
fn get_string(core: &Core, key: &str) -> Option<String> {
    core.store()
        .setting_get(key)
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<Option<String>>(&j).ok())
        .flatten()
        .filter(|s| !s.trim().is_empty())
}

/// 문자열 설정 쓰기
fn set_string(core: &Core, key: &str, value: Option<&str>) -> Result<(), CoreError> {
    let v: Option<String> = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let json = serde_json::to_string(&v)
        .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
    core.store().setting_set(key, &json)?;
    Ok(())
}

/// 사용자 셸 명령의 환경 변수: 지정한 값에 로그인 셸 PATH 를 더한다
pub(crate) fn command_env(core: &Core, envs: &[(&str, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = envs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect();
    if let Some(path) = &core.config().command_path {
        out.push(("PATH".to_string(), path.clone()));
    }
    out
}

/// `sh -c <cmd>` 를 실행하고 출력 끝부분을 모은다. 시간 제한을 넘기면 자식까지 끝낸다
async fn run_shell(core: &Core, cwd: &Path, cmd: &str, envs: &[(&str, String)]) -> CommandRun {
    let started = Instant::now();
    let out = run_shell_command(
        cwd,
        cmd,
        &command_env(core, envs),
        core.config().command_timeout,
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match out {
        Ok(Some(o)) => {
            let mut text = String::from_utf8_lossy(&o.stdout).into_owned();
            if !o.stderr.is_empty() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&String::from_utf8_lossy(&o.stderr));
            }
            if text.len() > OUTPUT_TAIL {
                let cut = text.len() - OUTPUT_TAIL;
                let cut = text
                    .char_indices()
                    .map(|(i, _)| i)
                    .find(|&i| i >= cut)
                    .unwrap_or(cut);
                text = format!("…{}", &text[cut..]);
            }
            CommandRun {
                command: cmd.to_string(),
                ok: o.status.success(),
                status: o.status.code(),
                output: text,
                elapsed_ms,
                timed_out: false,
            }
        }
        Err(e) => CommandRun {
            command: cmd.to_string(),
            ok: false,
            status: None,
            output: e.to_string(),
            elapsed_ms,
            timed_out: false,
        },
        Ok(None) => CommandRun {
            command: cmd.to_string(),
            ok: false,
            status: None,
            output: pick("시간 초과", "Timed out").into(),
            elapsed_ms,
            timed_out: true,
        },
    }
}

impl Core {
    /// 결과 내용의 구문 오류를 양쪽 원본과 비교한다 (CF-25). 지원하지 않는 확장자면 None
    pub async fn syntax_compare(
        &self,
        session: SessionId,
        path: &str,
        content: &[u8],
    ) -> Result<Option<SyntaxCompare>, CoreError> {
        #[cfg(not(feature = "syntax-check"))]
        {
            let _ = (session, path, content);
            Ok(None)
        }
        #[cfg(feature = "syntax-check")]
        {
            let Some(report) = mgit_syntax::check(path, content) else {
                return Ok(None);
            };
            let inner = self.inner_arc();
            let s = inner.get(session)?;
            let stages = self.stage_oids(session, path).await;
            let runner = inner.runner();
            let wt: &std::path::Path = &s.info.work_tree;
            let side = |stage: u8| async move {
                show_stage(runner, wt, stage, path)
                    .await
                    .ok()
                    .and_then(|b| mgit_syntax::check(path, &b))
                    .map(|r| r.errors)
            };
            let ours_errors = if stages[1].is_some() {
                side(2).await
            } else {
                None
            };
            let theirs_errors = if stages[2].is_some() {
                side(3).await
            } else {
                None
            };
            let baseline = match (ours_errors, theirs_errors) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) | (None, Some(a)) => a,
                (None, None) => 0,
            };
            Ok(Some(SyntaxCompare {
                language: report.language.to_string(),
                result_errors: report.errors,
                ours_errors,
                theirs_errors,
                first_error_line: report.first_error_line,
                new_errors: report.errors > baseline,
            }))
        }
    }

    /// 저장소 검증 명령 (CF-25)
    pub fn verify_command(&self, session: SessionId) -> Result<Option<String>, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(get_string(self, &verify_key(&s.info.common_dir)))
    }

    /// 검증 명령 저장 (None/빈 문자열이면 해제)
    pub fn set_verify_command(
        &self,
        session: SessionId,
        cmd: Option<&str>,
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get(session)?;
        set_string(self, &verify_key(&s.info.common_dir), cmd)
    }

    /// 검증 명령을 작업 트리에서 실행한다
    pub async fn run_verify(&self, session: SessionId) -> Result<CommandRun, CoreError> {
        let cmd = self.verify_command(session)?.ok_or_else(|| {
            CoreError::Invalid(
                pick(
                    "검증 명령이 설정돼 있지 않습니다",
                    "No verification command is set",
                )
                .into(),
            )
        })?;
        let s = self.inner_arc().get(session)?;
        Ok(run_shell(self, &s.info.work_tree, &cmd, &[]).await)
    }

    /// 워크트리 초기화 명령 (WT-07)
    pub fn worktree_init_command(&self, session: SessionId) -> Result<Option<String>, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(get_string(self, &init_key(&s.info.common_dir)))
    }

    /// 워크트리 초기화 명령 저장
    pub fn set_worktree_init_command(
        &self,
        session: SessionId,
        cmd: Option<&str>,
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get(session)?;
        set_string(self, &init_key(&s.info.common_dir), cmd)
    }

    /// 새 워크트리에서 초기화 명령을 실행한다. `MGIT_WORKTREE`·`MGIT_MAIN` 환경 변수를 준다
    pub async fn run_worktree_init(
        &self,
        session: SessionId,
        worktree: &Path,
    ) -> Result<Option<CommandRun>, CoreError> {
        let Some(cmd) = self.worktree_init_command(session)? else {
            return Ok(None);
        };
        if !worktree.is_dir() {
            return Err(CoreError::Invalid(tr!(
                "워크트리 폴더가 없습니다: {}",
                "Worktree folder does not exist: {}",
                worktree.display()
            )));
        }
        let s = self.inner_arc().get(session)?;
        let envs = [
            ("MGIT_WORKTREE", worktree.to_string_lossy().into_owned()),
            ("MGIT_MAIN", s.info.work_tree.to_string_lossy().into_owned()),
        ];
        Ok(Some(run_shell(self, worktree, &cmd, &envs).await))
    }
}
