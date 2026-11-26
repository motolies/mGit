//! 워크트리 (WT-01~05). 목록은 상태 스냅샷(`refs.worktrees`)에 있고 여기서는 생성·삭제·검사를 한다

use std::path::{Path, PathBuf};

use mgit_git::cmd::work_tree_status;
use mgit_l10n::pick;
use mgit_model::{EnvProfile, GitRequest, Oid, WorktreeRemoveCheck};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::write::WriteSpec;

/// 워크트리 생성 방식 (WT-02)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorktreeSource {
    /// 새 브랜치를 만들며 (`-b name [start]`)
    NewBranch { name: String, start: Option<String> },
    /// 기존 브랜치를 체크아웃
    Branch(String),
    /// 커밋을 detached 로
    Detached(Oid),
}

/// 이름이 옵션으로 오해될 수 없는지
fn check_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_name(name)));
    }
    Ok(())
}

/// 브랜치명을 폴더명으로 (`/` → `-`)
pub fn worktree_dir_name(branch: &str) -> String {
    branch
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '-'
            } else {
                c
            }
        })
        .collect()
}

/// 기본 워크트리 경로 규칙: `../<저장소명>.worktrees/<브랜치명>`
pub fn default_worktree_path(main_work_tree: &Path, branch: &str) -> PathBuf {
    let name = main_work_tree
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let parent = main_work_tree
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| main_work_tree.to_path_buf());
    parent
        .join(format!("{name}.worktrees"))
        .join(worktree_dir_name(branch))
}

impl Core {
    /// 기본 경로 제안 (WT-02)
    pub fn suggest_worktree_path(
        &self,
        session: SessionId,
        branch: &str,
    ) -> Result<PathBuf, CoreError> {
        let s = self.inner().get(session)?;
        let main = s
            .state()
            .refs
            .worktrees
            .iter()
            .find(|w| w.is_main)
            .map(|w| w.path.clone())
            .unwrap_or_else(|| s.info.work_tree.clone());
        Ok(default_worktree_path(&main, branch))
    }

    /// 워크트리를 만든다 (WT-02). 만든 경로를 돌려준다
    pub async fn worktree_add(
        &self,
        session: SessionId,
        path: &Path,
        source: WorktreeSource,
    ) -> Result<PathBuf, CoreError> {
        if path.as_os_str().is_empty() {
            return Err(CoreError::Invalid(
                pick("경로를 지정하세요", "Specify a path").into(),
            ));
        }
        let path_str = path.to_string_lossy().into_owned();
        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        match &source {
            WorktreeSource::NewBranch { name, start } => {
                check_name(name)?;
                args.push("-b".into());
                args.push(name.clone());
                args.push("--end-of-options".into());
                args.push(path_str.clone());
                if let Some(start) = start {
                    check_name(start)?;
                    args.push(start.clone());
                }
            }
            WorktreeSource::Branch(name) => {
                check_name(name)?;
                args.push("--end-of-options".into());
                args.push(path_str.clone());
                args.push(name.clone());
            }
            WorktreeSource::Detached(oid) => {
                args.push("--detach".into());
                args.push("--end-of-options".into());
                args.push(path_str.clone());
                args.push(oid.to_hex());
            }
        }
        self.run_write(session, WriteSpec::new(args)).await?;
        Ok(path.to_path_buf())
    }

    /// 삭제 전 검사 (WT-04): 더티·미push·메인 여부
    pub async fn worktree_remove_check(
        &self,
        session: SessionId,
        path: &Path,
    ) -> Result<WorktreeRemoveCheck, CoreError> {
        let s = self.inner().get(session)?;
        let wt = s
            .state()
            .refs
            .worktrees
            .iter()
            .find(|w| same_path(&w.path, path))
            .cloned()
            .ok_or_else(|| CoreError::Invalid(messages::not_a_worktree(path)))?;
        let runner = self.inner().runner();
        let dirty = if wt.path.is_dir() {
            work_tree_status(runner, &wt.path, true)
                .await
                .map(|st| st.summary().has_changes())
                .unwrap_or(false)
        } else {
            false
        };
        let branch = wt
            .branch
            .as_deref()
            .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        let unpushed = match &branch {
            Some(b) => {
                let req = GitRequest::new(
                    &s.info.work_tree,
                    [
                        "rev-list",
                        "--count",
                        &format!("{b}@{{upstream}}..{b}"),
                        "--",
                    ],
                )
                .with_env(EnvProfile::ReadInteractive);
                match runner.run(req).await {
                    Ok(out) if out.exit.success() => out.stdout_lossy().trim().parse().ok(),
                    _ => None,
                }
            }
            None => None,
        };
        Ok(WorktreeRemoveCheck {
            path: wt.path.clone(),
            branch,
            dirty,
            unpushed,
            is_main: wt.is_main,
        })
    }

    /// 워크트리를 지운다 (WT-04). `delete_branch` 면 브랜치도 강제 삭제한다
    pub async fn worktree_remove(
        &self,
        session: SessionId,
        path: &Path,
        force: bool,
        delete_branch: bool,
    ) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        let wt = s
            .state()
            .refs
            .worktrees
            .iter()
            .find(|w| same_path(&w.path, path))
            .cloned()
            .ok_or_else(|| CoreError::Invalid(messages::not_a_worktree(path)))?;
        if wt.is_main {
            return Err(CoreError::Invalid(
                pick(
                    "메인 워크트리는 삭제할 수 없습니다",
                    "Cannot remove the main worktree",
                )
                .into(),
            ));
        }
        if same_path(&wt.path, &s.info.work_tree) {
            return Err(CoreError::Invalid(
                pick(
                    "현재 열려 있는 워크트리입니다. 메인 워크트리 탭에서 삭제하세요.",
                    "This worktree is currently open. Remove it from the main worktree tab",
                )
                .into(),
            ));
        }
        let path_str = wt.path.to_string_lossy().into_owned();
        let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
        if force {
            args.push("--force".into());
        }
        args.push("--end-of-options".into());
        args.push(path_str);
        let removed = wt.path.canonicalize().unwrap_or_else(|_| wt.path.clone());
        self.run_write(session, WriteSpec::new(args)).await?;
        // 워크트리 삭제는 끝났으므로 후속 브랜치 삭제가 실패하더라도 개요 목록은 정리한다.
        self.rescan_removed_worktree(&removed).await;
        if delete_branch && let Some(b) = wt.branch.as_deref() {
            let name = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            self.run_write(
                session,
                WriteSpec::new(["branch", "-D", "--end-of-options", &name]),
            )
            .await?;
        }
        Ok(())
    }

    /// 사라진 워크트리 정리 (`git worktree prune`)
    pub async fn worktree_prune(&self, session: SessionId) -> Result<(), CoreError> {
        self.run_write(session, WriteSpec::new(["worktree", "prune"]))
            .await?;
        Ok(())
    }
}

/// 두 경로가 같은 디렉터리인지 (canonicalize 가능하면 그것으로)
fn same_path(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

impl Core {
    /// 워크트리 잠금 (WT-08): 외장 드라이브 등에서 prune 되지 않게
    pub async fn worktree_lock(
        &self,
        session: SessionId,
        path: &Path,
        reason: Option<&str>,
    ) -> Result<(), CoreError> {
        let p = path.to_string_lossy().into_owned();
        let mut args: Vec<String> = vec!["worktree".into(), "lock".into()];
        if let Some(r) = reason.filter(|r| !r.trim().is_empty()) {
            args.push("--reason".into());
            args.push(r.into());
        }
        args.push("--end-of-options".into());
        args.push(p);
        self.run_write(session, WriteSpec::new(args).no_undo())
            .await?;
        Ok(())
    }

    /// 워크트리 잠금 해제
    pub async fn worktree_unlock(&self, session: SessionId, path: &Path) -> Result<(), CoreError> {
        let p = path.to_string_lossy().into_owned();
        self.run_write(
            session,
            WriteSpec::new(["worktree", "unlock", "--end-of-options", p.as_str()]).no_undo(),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_path_rule() {
        let p = default_worktree_path(Path::new("/w/repo"), "feature/x");
        assert_eq!(p, PathBuf::from("/w/repo.worktrees/feature-x"));
    }
}
