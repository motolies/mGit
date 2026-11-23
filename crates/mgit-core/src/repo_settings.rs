//! 저장소 설정 (REPO-07)·상태 조회 최적화 (AD-07)·얕은 복제 보완 (REPO-03)

use std::path::{Path, PathBuf};

use mgit_git::cmd::{config_get, config_get_bool, config_get_scoped, tracked_count};
use mgit_l10n::tr;
use mgit_model::{GitRequest, HookInfo, PerfStatus, RepoSettings};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::write::WriteSpec;

/// 추적 파일이 이만큼 이상이고 fsmonitor 가 꺼져 있으면 제안한다 (AD-07)
pub const PERF_SUGGEST_FILES: u32 = 20_000;

/// 실행 가능 비트 (유닉스). 윈도는 항상 true
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

/// hook 디렉터리의 실제 hook (`.sample` 제외), 이름순
fn list_hooks(dir: &Path) -> Vec<HookInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut hooks: Vec<HookInfo> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".sample") {
                return None;
            }
            let path = e.path();
            Some(HookInfo {
                executable: is_executable(&path),
                name,
                path,
            })
        })
        .collect();
    hooks.sort_by(|a, b| a.name.cmp(&b.name));
    hooks
}

impl Core {
    /// 얕은 복제인지 (`<common_dir>/shallow`)
    pub fn is_shallow(&self, session: SessionId) -> Result<bool, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(s.info.common_dir.join("shallow").is_file())
    }

    /// `.gitignore` 내용 (없으면 None)
    pub fn read_gitignore(&self, session: SessionId) -> Result<Option<String>, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(std::fs::read_to_string(s.info.work_tree.join(".gitignore")).ok())
    }

    /// 상태 조회 최적화 상태 (AD-07). 추적 파일 수는 `ls-files` 로 센다
    pub async fn perf_status(&self, session: SessionId) -> Result<PerfStatus, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let wt = &s.info.work_tree;
        let runner = inner.runner();
        let fsmonitor = config_get_bool(runner, wt, "core.fsmonitor")
            .await
            .unwrap_or(false);
        let untracked_cache = config_get_bool(runner, wt, "core.untrackedCache")
            .await
            .unwrap_or(false);
        let tracked_files = tracked_count(runner, wt).await?;
        let builtin_daemon = cfg!(any(target_os = "macos", target_os = "windows"));
        Ok(PerfStatus {
            fsmonitor,
            untracked_cache,
            tracked_files,
            suggested: builtin_daemon && !fsmonitor && tracked_files >= PERF_SUGGEST_FILES,
        })
    }

    /// 저장소 설정 묶음 (REPO-07)
    pub async fn repo_settings(&self, session: SessionId) -> Result<RepoSettings, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let wt = &s.info.work_tree;
        let runner = inner.runner();
        let hooks_path = config_get(runner, wt, "core.hooksPath").await;
        let hooks_dir: PathBuf = match &hooks_path {
            Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
            Some(p) => wt.join(p),
            None => s.info.common_dir.join("hooks"),
        };
        Ok(RepoSettings {
            user_name: config_get(runner, wt, "user.name").await,
            user_email: config_get(runner, wt, "user.email").await,
            local_user_name: config_get_scoped(runner, wt, "--local", "user.name").await,
            local_user_email: config_get_scoped(runner, wt, "--local", "user.email").await,
            hooks_path,
            hooks: list_hooks(&hooks_dir),
            gitignore: self.read_gitignore(session)?,
            perf: self.perf_status(session).await?,
            shallow: self.is_shallow(session)?,
            signing: self.signing_info(session).await?,
        })
    }

    /// 저장소(local) 사용자 이름·이메일. 빈 값은 local 설정을 지운다
    pub async fn set_user(
        &self,
        session: SessionId,
        name: &str,
        email: &str,
    ) -> Result<(), CoreError> {
        for (key, value) in [("user.name", name.trim()), ("user.email", email.trim())] {
            if value.is_empty() {
                self.config_unset_local(session, key).await?;
            } else {
                self.run_write(
                    session,
                    WriteSpec::new(["config", "--local", key, value])
                        .no_undo()
                        .skip_refresh(),
                )
                .await?;
            }
        }
        Ok(())
    }

    /// local 설정 하나를 지운다 (없어도 오류 아님)
    pub(crate) async fn config_unset_local(
        &self,
        session: SessionId,
        key: &str,
    ) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(&s.info.work_tree, ["config", "--local", "--unset", key]);
        let out = inner.runner().run(req).await?;
        // 5 = 값이 없음
        if out.exit.success() || out.exit.status == Some(5) {
            Ok(())
        } else {
            Err(CoreError::Invalid(tr!(
                "{key} 설정 해제 실패: {}",
                "Failed to unset {key}: {}",
                out.exit.stderr
            )))
        }
    }

    /// `.gitignore` 를 쓰고 상태를 다시 읽는다
    pub async fn write_gitignore(&self, session: SessionId, text: &str) -> Result<(), CoreError> {
        let path = {
            let s = self.inner_arc().get(session)?;
            s.info.work_tree.join(".gitignore")
        };
        std::fs::write(&path, text)?;
        self.refresh(session).await
    }

    /// fsmonitor·untrackedCache 를 켠다 (AD-07)
    pub async fn enable_perf(&self, session: SessionId) -> Result<(), CoreError> {
        for (key, value) in [("core.fsmonitor", "true"), ("core.untrackedCache", "true")] {
            self.run_write(
                session,
                WriteSpec::new(["config", "--local", key, value])
                    .no_undo()
                    .skip_refresh(),
            )
            .await?;
        }
        self.refresh(session).await
    }

    /// 얕은 복제를 전체 이력으로 (`fetch --unshallow`, REPO-03). 끝나면 얕은지 여부를 돌려준다
    pub async fn unshallow(&self, session: SessionId) -> Result<bool, CoreError> {
        if !self.is_shallow(session)? {
            return Ok(false);
        }
        let op = self.begin_operation(session, "fetch", "fetch --unshallow")?;
        self.run_write(
            session,
            WriteSpec::new(["fetch", "--unshallow", "--progress"])
                .network()
                .with_op(op)
                .progress()
                .no_undo(),
        )
        .await?;
        self.is_shallow(session)
    }
}
