//! 폴더 화면의 stage·unstage (계획 부록 "W14 진행 방식"). 폴더 Commit 도구 창의 체크박스는 git index 를 그대로
//! 비춘다 — 체크 = stage, 해제 = unstage. 저장소 여러 개에 걸친 체크를 가벼운 세션(폴더당 3개)으로는 할 수
//! 없으므로, 폴더 세션 id + 저장소 경로로 부른다 (폴더 읽기 API·가벼운 세션 열기와 같은 틀).
//!
//! 세션용 `stage`·`unstage` 와 같은 본체(`changes.rs` 의 `index_write`·`refuse_nested_repos`)에 폴더 화면의 규칙을
//! 더한다:
//! - 대상은 "이 경로들"(`Paths`)과 "이 저장소의 전부"(`All`)를 다른 값으로 받는다. 빈 경로 목록은 전부가 아니라
//!   아무것도 하지 않는다 (폴더 일괄 작업의 "빈 목록 = 전부" 가 쓰기에서 범위를 넓히지 않게)
//! - 저장소 소속(FS-11)·경로(절대 경로·`..`)는 git 을 돌리기 전에 거부한다
//! - 충돌(unmerged) 경로는 건드리지 않고 결과로 알린다. `git add` 는 충돌 경로를 해결됨으로 바꾸고, 범위에
//!   충돌 경로가 든 `git restore --staged` 는 "is unmerged" 로 통째로 실패한다. 충돌 해결은 충돌 편집기의 일이다.
//!   `:(exclude)` pathspec 으로는 막을 수 없다 — `git add -A -- dir ':(exclude)dir/c'` 도 `dir/c` 의 충돌을 해결된
//!   것으로 바꾼다 (git 2.54 에서 확인). 그래서 대상 안에 충돌이 있으면 대상을 그 안의 변경 경로 하나하나로 풀고
//!   충돌 경로를 뺀다 (`expand_without_unmerged`). 충돌이 없으면 세션용과 같은 인자다
//! - 그 저장소의 쓰기 잠금(`write_lock_for(common_dir)`)을 쥐고 돈다 (세션 쓰기 큐·일괄 작업과 같은 잠금).
//!   잠금 안에서 대상의 상태를 읽고 바로 쓴다. 외부 git(터미널 등)이 그 사이에 충돌을 만들면 막지 못한다
//! - 쓴 뒤 폴더 세션으로 `FolderChanged{refs: false, repo}` 를 보낸다 (index 가 그대로라 폴더 감시가 조용한 경우도
//!   화면이 다시 읽게)

use std::path::{Component, Path};

use mgit_git::cmd::scanned_repo_status_in;
use mgit_model::{FileState, StatusEntry};

use crate::changes::{IndexOp, index_write, is_safe_rel_path};
use crate::core::Core;
use crate::error::CoreError;
use crate::events::{CoreEvent, SessionId};
use crate::light::{discover_member, folder_member};
use crate::messages;

/// 폴더 stage·unstage 의 대상
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IndexTarget {
    /// 이 경로들 (작업 트리 기준 상대 경로, 파일이나 디렉터리 — 디렉터리면 그 아래 전부). 글자 그대로
    /// 해석된다(글롭 없음). 비어 있으면 아무것도 하지 않는다
    Paths(Vec<String>),
    /// 이 저장소의 전부
    All,
}

/// 건너뛴 이유
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// 충돌 중인 경로 (충돌 편집기에서 해결한다)
    Unmerged,
}

/// 건너뛴 경로 하나
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkippedPath {
    pub path: String,
    pub reason: SkipReason,
}

/// 폴더 stage·unstage 결과
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexWriteResult {
    /// git 쓰기를 돌렸는지. 대상이 비었거나 대상이 모두 건너뛸 경로였으면 거짓이고 `FolderChanged` 도 없다
    pub ran: bool,
    /// 대상 안에서 건드리지 않은 경로 (git 의 경로순)
    pub skipped: Vec<SkippedPath>,
}

/// 대상 경로 하나를 git 을 돌리기 전에 검사한다: 세션의 버리기와 같은 기준(`is_safe_rel_path` — 빈 경로·절대
/// 경로·`..` 거부)에 더해 저장소 루트 자체(`.`, `./`)를 받지 않는다 — 전부는 `IndexTarget::All` 로만 고른다
fn check_target_path(path: &str) -> Result<(), CoreError> {
    let root_only = Path::new(path)
        .components()
        .all(|c| matches!(c, Component::CurDir));
    if !is_safe_rel_path(path) || root_only {
        return Err(CoreError::Invalid(messages::bad_path(path)));
    }
    Ok(())
}

/// 충돌이 든 대상을 그 안의 변경 경로로 푼다 (`entries` 는 대상으로 좁힌 status). 충돌 경로는 뺀다.
/// - stage: 작업 트리 쪽이 바뀐 경로(수정·삭제·형식 변경·untracked). index 쪽만 바뀐 경로는 할 일이 없고, 이름
///   변경의 옛 경로는 이미 index 에서 빠져 있어 넘기면 git 이 "did not match" 로 실패하므로 넣지 않는다
/// - unstage: index 쪽이 바뀐 경로와 이름 변경·복사의 옛 경로 (옛 경로를 HEAD 내용으로 되돌려야 rename 이 풀린다)
///
/// 무시된 파일은 status 에 없으므로 들지 않는다 (디렉터리 `git add` 와 같다). 경로순·중복 없음
fn expand_without_unmerged(op: IndexOp, entries: &[StatusEntry]) -> Vec<String> {
    let mut out: Vec<String> = entries
        .iter()
        .filter(|e| e.conflict.is_none())
        .flat_map(|e| match op {
            IndexOp::Stage if e.worktree != FileState::Unmodified => vec![e.path.clone()],
            IndexOp::Unstage if e.is_staged() => std::iter::once(e.path.clone())
                .chain(e.orig_path.clone())
                .collect(),
            _ => Vec::new(),
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

impl Core {
    /// 폴더 저장소의 경로들(또는 전부)을 stage 한다 (`git add -A`, 세션 `stage` 와 같은 인자). `repo` 는 이 폴더의
    /// 저장소 목록에 있는 경로이고 워크트리면 그 워크트리 자신의 index 에 쓴다. 대상 안의 충돌 경로는 건드리지
    /// 않고 `skipped` 로 알린다. 대상 안에 `.git` 을 품은 미등록 폴더가 있으면 아무것도 하지 않고 `NestedRepos`.
    /// 저장소 세션을 만들지 않는다
    pub async fn folder_stage(
        &self,
        folder: SessionId,
        repo: &Path,
        target: &IndexTarget,
    ) -> Result<IndexWriteResult, CoreError> {
        self.folder_index_write(folder, repo, IndexOp::Stage, target)
            .await
    }

    /// 폴더 저장소의 경로들(또는 전부)을 unstage 한다 (HEAD 가 있으면 `git restore --staged`, 없으면
    /// `git rm -r -q --cached` — 세션 `unstage` 와 같은 인자). 규칙은 `folder_stage` 와 같다
    pub async fn folder_unstage(
        &self,
        folder: SessionId,
        repo: &Path,
        target: &IndexTarget,
    ) -> Result<IndexWriteResult, CoreError> {
        self.folder_index_write(folder, repo, IndexOp::Unstage, target)
            .await
    }

    /// 폴더 stage·unstage 의 공통 흐름. 검사(폴더·소속·경로) → 판별(저장소 최상위 확인) → 쓰기 잠금 → 대상의
    /// 상태(충돌·untracked·HEAD) → 충돌이 있으면 대상을 풀기 → 본체(`refuse_nested_repos`·`index_write`) → 실행 →
    /// `FolderChanged`
    async fn folder_index_write(
        &self,
        folder_id: SessionId,
        repo: &Path,
        op: IndexOp,
        target: &IndexTarget,
    ) -> Result<IndexWriteResult, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(folder_id)?;
        let path = folder_member(&folder, repo)?;
        let (paths, scope): (Vec<String>, &[String]) = match target {
            IndexTarget::All => (vec![".".to_string()], &[]),
            IndexTarget::Paths(paths) => {
                for p in paths {
                    check_target_path(p)?;
                }
                (paths.clone(), paths.as_slice())
            }
        };
        if paths.is_empty() {
            return Ok(IndexWriteResult::default());
        }
        let found = discover_member(inner.runner(), &path).await?;
        let lock = inner.write_lock_for(&found.common_dir);
        let queued = lock.lock().await;
        // 대상 안의 상태: 충돌 경로(건드리지 않는다), untracked 폴더(미등록 하위 저장소 검사), HEAD 유무
        let status = scanned_repo_status_in(inner.runner(), &found.work_tree, scope).await?;
        let unmerged: Vec<String> = status
            .entries
            .iter()
            .filter(|e| e.conflict.is_some())
            .map(|e| e.path.clone())
            .collect();
        let skipped: Vec<SkippedPath> = unmerged
            .iter()
            .map(|p| SkippedPath {
                path: p.clone(),
                reason: SkipReason::Unmerged,
            })
            .collect();
        // 충돌이 없으면 대상 그대로(세션과 같은 인자), 있으면 그 안의 변경 경로 하나하나(충돌 제외, stdin 으로)
        let expanded = !unmerged.is_empty();
        let list = if expanded {
            expand_without_unmerged(op, &status.entries)
        } else {
            paths
        };
        if list.is_empty() {
            return Ok(IndexWriteResult {
                ran: false,
                skipped,
            });
        }
        if op == IndexOp::Stage {
            // 세션은 지정한 경로(전부면 untracked 항목)만 보지만, 폴더는 디렉터리를 체크하는 일이 흔하므로 대상
            // 아래의 untracked 폴더도 함께 본다
            let candidates: Vec<String> = list
                .iter()
                .cloned()
                .chain(
                    status
                        .entries
                        .iter()
                        .filter(|e| e.is_untracked())
                        .map(|e| e.path.clone()),
                )
                .collect();
            self.refuse_nested_repos(&found.work_tree, &candidates)
                .await?;
        }
        let has_head = status.branch.oid.is_some();
        let spec = index_write(op, has_head, &list, expanded);
        inner.run_write_at(&found.work_tree, &spec).await?;
        drop(queued);
        folder.sink.emit(CoreEvent::FolderChanged {
            session: folder_id,
            refs: false,
            repo: Some(path),
        });
        Ok(IndexWriteResult { ran: true, skipped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 저장소 밖·루트 자체·빈 경로는 거부하고, 공백·한글·`-`·`:` 로 시작하는 이름은 받는다
    #[test]
    fn target_paths_are_checked_before_git() {
        for bad in ["", "/abs", "../x", "a/../../x", ".", "./", "././"] {
            assert!(
                matches!(check_target_path(bad), Err(CoreError::Invalid(_))),
                "{bad:?}"
            );
        }
        for good in [
            "a.txt",
            "dir",
            "dir/",
            "공백 있는 파일.txt",
            "-dash",
            ":colon",
            "a/./b",
        ] {
            assert!(check_target_path(good).is_ok(), "{good:?}");
        }
    }

    /// 상태 항목 하나 (porcelain 두 글자로)
    fn entry(path: &str, xy: &[u8; 2], orig: Option<&str>) -> StatusEntry {
        StatusEntry {
            path: path.into(),
            orig_path: orig.map(Into::into),
            index: FileState::from_byte(xy[0]),
            worktree: FileState::from_byte(xy[1]),
            submodule: None,
            conflict: mgit_model::ConflictKind::from_xy(xy[0], xy[1]),
            rename_score: None,
        }
    }

    /// 충돌을 피해 대상을 풀 때: stage 는 작업 트리 쪽 변경만, unstage 는 index 쪽 변경과 rename 의 옛 경로만.
    /// 충돌 경로는 어느 쪽에도 없다
    #[test]
    fn expansion_keeps_only_paths_the_write_would_change() {
        let entries = vec![
            entry("c.txt", b"UU", None),
            entry("del.txt", b"DD", None),
            entry("m.txt", b".M", None),
            entry("s.txt", b"M.", None),
            entry("both.txt", b"MM", None),
            entry("gone.txt", b".D", None),
            entry("new.txt", b"R.", Some("old.txt")),
            entry("u.txt", b"??", None),
            entry("nested/", b"??", None),
        ];
        assert_eq!(
            expand_without_unmerged(IndexOp::Stage, &entries),
            ["both.txt", "gone.txt", "m.txt", "nested/", "u.txt"]
        );
        assert_eq!(
            expand_without_unmerged(IndexOp::Unstage, &entries),
            ["both.txt", "new.txt", "old.txt", "s.txt"]
        );
    }
}
