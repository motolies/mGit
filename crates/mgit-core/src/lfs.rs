//! Git LFS (AD-01): 설치 감지·추적 패턴·LFS 파일·잠금

use mgit_model::{EnvProfile, GitRequest};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::write::WriteSpec;

/// LFS 로 관리되는 파일
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    pub oid: String,
    pub path: String,
    /// 내용이 받아져 있으면 true (`*`), 포인터만 있으면 false (`-`)
    pub full: bool,
}

/// LFS 잠금
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LfsLock {
    pub id: String,
    pub path: String,
    pub owner: String,
    pub locked_at: String,
}

/// LFS 상태
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// `git lfs` 가 실행되는지
    pub installed: bool,
    pub version: Option<String>,
    /// 이 저장소에 hook·filter 가 설치돼 있는지 (`lfs install --local` 했는지)
    pub configured: bool,
    /// `.gitattributes` 의 추적 패턴
    pub patterns: Vec<String>,
    pub files: Vec<LfsFile>,
    pub locks: Vec<LfsLock>,
    /// 잠금 조회 실패 사유 (원격 없음 등)
    pub locks_error: Option<String>,
}

/// 옵션으로 오해될 수 없는 인자인지
fn check_arg(v: &str) -> Result<(), CoreError> {
    if v.trim().is_empty() || v.starts_with('-') || v.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_value(v)));
    }
    Ok(())
}

/// `git lfs track` 출력에서 패턴만
fn parse_track(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_tracked = false;
    for line in text.lines() {
        if line.starts_with("Listing tracked patterns") {
            in_tracked = true;
            continue;
        }
        if line.starts_with("Listing excluded patterns") {
            in_tracked = false;
            continue;
        }
        if in_tracked && line.starts_with("    ") {
            let item = line.trim();
            let pat = item.rsplit_once(" (").map(|(p, _)| p).unwrap_or(item);
            if !pat.is_empty() {
                out.push(pat.to_string());
            }
        }
    }
    out
}

/// `git lfs ls-files` 출력 (`<oid> <*|-> <path>`)
fn parse_ls_files(text: &str) -> Vec<LfsFile> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, ' ');
            let oid = it.next()?.trim();
            let marker = it.next()?.trim();
            let path = it.next()?.trim();
            if oid.is_empty() || path.is_empty() {
                return None;
            }
            Some(LfsFile {
                oid: oid.to_string(),
                path: path.to_string(),
                full: marker == "*",
            })
        })
        .collect()
}

/// `git lfs locks --json`
fn parse_locks(text: &str) -> Vec<LfsLock> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    Some(LfsLock {
                        id: l.get("id")?.as_str().unwrap_or("").to_string(),
                        path: l.get("path")?.as_str()?.to_string(),
                        owner: l
                            .get("owner")
                            .and_then(|o| o.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string(),
                        locked_at: l
                            .get("locked_at")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Core {
    /// LFS 상태 (AD-01)
    pub async fn lfs_status(&self, session: SessionId) -> Result<LfsStatus, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let wt = &s.info.work_tree;
        let run = |args: &[&str]| {
            GitRequest::new(wt, args.iter().map(|a| (*a).to_string()))
                .with_env(EnvProfile::ReadInteractive)
        };
        let mut st = LfsStatus::default();
        let v = runner.run(run(&["lfs", "version"])).await?;
        if !v.exit.success() {
            return Ok(st);
        }
        st.installed = true;
        st.version = v
            .stdout_lossy()
            .split_whitespace()
            .next()
            .map(|x| x.trim_start_matches("git-lfs/").to_string());
        let cfg = runner
            .run(run(&["config", "--get", "filter.lfs.clean"]))
            .await?;
        st.configured = cfg.exit.success() && !cfg.stdout_lossy().trim().is_empty();
        if let Ok(o) = runner.run(run(&["lfs", "track"])).await
            && o.exit.success()
        {
            st.patterns = parse_track(&o.stdout_lossy());
        }
        if let Ok(o) = runner.run(run(&["lfs", "ls-files"])).await
            && o.exit.success()
        {
            st.files = parse_ls_files(&o.stdout_lossy());
        }
        if !st.patterns.is_empty() || !st.files.is_empty() {
            match runner.run(run(&["lfs", "locks", "--json"])).await {
                Ok(o) if o.exit.success() => st.locks = parse_locks(&o.stdout_lossy()),
                Ok(o) => st.locks_error = Some(o.exit.stderr.trim().to_string()),
                Err(e) => st.locks_error = Some(e.to_string()),
            }
        }
        Ok(st)
    }

    /// 이 저장소에 LFS hook·filter 설치 (`git lfs install --local`)
    pub async fn lfs_install(&self, session: SessionId) -> Result<(), CoreError> {
        self.run_write(
            session,
            WriteSpec::new(["lfs", "install", "--local"]).no_undo(),
        )
        .await?;
        Ok(())
    }

    /// 패턴을 LFS 로 추적 (`.gitattributes` 갱신)
    pub async fn lfs_track(&self, session: SessionId, pattern: &str) -> Result<(), CoreError> {
        check_arg(pattern)?;
        self.run_write(session, WriteSpec::new(["lfs", "track", pattern]).no_undo())
            .await?;
        Ok(())
    }

    /// 추적 해제
    pub async fn lfs_untrack(&self, session: SessionId, pattern: &str) -> Result<(), CoreError> {
        check_arg(pattern)?;
        self.run_write(
            session,
            WriteSpec::new(["lfs", "untrack", pattern]).no_undo(),
        )
        .await?;
        Ok(())
    }

    /// 파일 잠금
    pub async fn lfs_lock(&self, session: SessionId, path: &str) -> Result<(), CoreError> {
        check_arg(path)?;
        self.run_write(
            session,
            WriteSpec::new(["lfs", "lock", path]).network().no_undo(),
        )
        .await?;
        Ok(())
    }

    /// 잠금 해제
    pub async fn lfs_unlock(
        &self,
        session: SessionId,
        path: &str,
        force: bool,
    ) -> Result<(), CoreError> {
        check_arg(path)?;
        let mut args: Vec<&str> = vec!["lfs", "unlock"];
        if force {
            args.push("--force");
        }
        args.push(path);
        self.run_write(session, WriteSpec::new(args).network().no_undo())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lfs_outputs() {
        assert_eq!(
            parse_track(
                "Listing tracked patterns\n    *.psd (.gitattributes)\n    assets/*.bin (assets/.gitattributes)\nListing excluded patterns\n    *.txt (.gitattributes)\n"
            ),
            vec!["*.psd", "assets/*.bin"]
        );
        let files = parse_ls_files("4d7a2148a7 * a.bin\n5b3c1 - dir/with space.psd\n");
        assert_eq!(files.len(), 2);
        assert!(files[0].full && files[0].path == "a.bin");
        assert!(!files[1].full && files[1].path == "dir/with space.psd");
        let locks = parse_locks(
            r#"[{"id":"1","path":"a.bin","owner":{"name":"nw"},"locked_at":"2026-10-29T00:00:00Z"}]"#,
        );
        assert_eq!(locks[0].owner, "nw");
        assert!(parse_locks("not json").is_empty());
    }
}
