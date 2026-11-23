use std::path::{Path, PathBuf};
use std::process::Command;

use mgit_model::LOCAL_ENV_VARS;

/// 결정적 git 환경. 전역·시스템 설정을 끊고 작성자와 날짜를 고정한다
#[derive(Debug, Clone)]
pub struct DeterministicEnv {
    /// 임시 `gitconfig` 경로 (`GIT_CONFIG_GLOBAL`)
    pub config_global: PathBuf,
}

impl DeterministicEnv {
    /// 작성자 이름·이메일
    pub const AUTHOR: (&str, &str) = ("mGit Test", "test@mgit.invalid");
    /// 첫 커밋의 epoch 초. 커밋마다 60초씩 더한다
    pub const EPOCH_START: i64 = 1_700_000_000;

    /// 임시 디렉터리 안에 gitconfig 를 쓰고 환경을 만든다
    pub fn create(dir: &Path) -> std::io::Result<Self> {
        let config_global = dir.join("gitconfig");
        std::fs::write(
            &config_global,
            concat!(
                "[init]\n\tdefaultBranch = main\n",
                "[core]\n\tautocrlf = false\n",
                "[commit]\n\tgpgsign = false\n",
                "[tag]\n\tgpgsign = false\n",
                "[gc]\n\tauto = 0\n",
                "[advice]\n\tdetachedHead = false\n",
            ),
        )?;
        Ok(Self { config_global })
    }

    /// 명령에 결정적 환경을 적용한다. `clock` 은 작성·커밋 날짜(epoch 초)
    pub fn apply(&self, cmd: &mut Command, clock: i64) {
        for var in LOCAL_ENV_VARS {
            cmd.env_remove(var);
        }
        let date = format!("@{clock} +0000");
        cmd.env("GIT_CONFIG_GLOBAL", &self.config_global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", Self::AUTHOR.0)
            .env("GIT_AUTHOR_EMAIL", Self::AUTHOR.1)
            .env("GIT_COMMITTER_NAME", Self::AUTHOR.0)
            .env("GIT_COMMITTER_EMAIL", Self::AUTHOR.1)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_PAGER", "cat")
            .env("LC_ALL", "C");
    }
}
