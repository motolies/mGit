//! 일반 파일 편집: 경로 검증은 파일 조회와 공유하고 저장은 revision 비교 후 원자 교체한다.
use std::io::Write;
use std::sync::PoisonError;

use mgit_git::cmd::discover;
use mgit_model::GitError;
use sha2::{Digest, Sha256};

use super::*;
use crate::events::CoreEvent;
use crate::refresh::RefreshScope;

/// 편집 가능한 줄바꿈 형식이다. 개행 없는 파일은 LF로 시작한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsLineEnding {
    Lf,
    Crlf,
}

/// 편집 조회 결과. 원문은 BOM과 줄 끝을 포함한 UTF-8 그대로다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsEditableFile {
    Text {
        text: String,
        size: u64,
        file_key: String,
        revision: String,
        line_ending: FsLineEnding,
        bom: bool,
    },
    Unavailable(FsFile),
    MixedLineEndings,
}

/// 저장은 새 파일을 만들지 않으며 비교 실패 시 기존 디스크와 초안을 그대로 둔다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsSaveResult {
    Saved { revision: String },
    Conflict,
    Failed { message: String },
}

impl Core {
    /// 편집 원문과 실제 경로 식별 키, 메타데이터·원문을 묶은 revision을 조회한다.
    pub async fn fs_read_editable_file(
        &self,
        session: SessionId,
        path: &str,
    ) -> Result<FsEditableFile, CoreError> {
        let root = self.fs_root(session)?;
        let path = path.to_owned();
        run_blocking(move || read_editable_at(&root, &path)).await
    }

    /// 저장소 쓰기 큐와 실제 파일 단위 잠금을 잡은 뒤 revision을 재검증하여 저장한다.
    pub async fn fs_save_file(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        text: &str,
    ) -> Result<FsSaveResult, CoreError> {
        let _mutation_guard = super::FS_MUTATION_LOCK.lock().await;
        let root = self.fs_root(session)?;
        let parsed = parse(path)?;
        let root_for_resolve = root.clone();
        let request = path.to_owned();
        let resolved =
            run_blocking(move || resolve(&root_for_resolve, parsed.components(), &request)).await?;
        let Resolved::Found(target) = resolved else {
            return Ok(FsSaveResult::Conflict);
        };
        if !target.meta.is_file() || target.meta.file_type().is_symlink() {
            return Ok(FsSaveResult::Conflict);
        }
        let inner = self.inner_arc();
        // 폴더로 연 저장소 파일도 git 작업과 동일한 큐를 사용한다. 판별 오류를 일반 폴더로 숨기지 않는다.
        let repo = match discover(inner.runner(), target.path.parent().unwrap_or(&root)).await {
            Ok(repo) => Some(repo),
            Err(GitError::NotARepository(_)) => None,
            Err(error) => return Err(error.into()),
        };
        let repo_lock = repo.as_ref().map(|r| inner.write_lock_for(&r.common_dir));
        let _repo_guard = match &repo_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        let file_lock = inner.write_lock_for(&target.path);
        let _file_guard = file_lock.lock().await;
        let expected = expected_revision.to_owned();
        let text = text.to_owned();
        let request = path.to_owned();
        let result = run_blocking(move || save_at(&root, &request, &expected, &text)).await?;
        drop(_file_guard);
        drop(_repo_guard);
        if matches!(result, FsSaveResult::Saved { .. }) {
            // 기존 갱신 파이프라인에 연결한다. 인덱스를 바꾸는 명령은 실행하지 않는다.
            let sessions: Vec<_> = inner
                .sessions
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .values()
                .cloned()
                .collect();
            for opened in sessions {
                if target.path.starts_with(&opened.info.work_tree) {
                    inner
                        .refresh_session(
                            &opened,
                            RefreshScope {
                                status: true,
                                ..RefreshScope::default()
                            },
                        )
                        .await;
                }
            }
            let folders: Vec<_> = inner
                .folders
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .values()
                .cloned()
                .collect();
            for folder in folders {
                if target.path.starts_with(&folder.path) {
                    folder.sink.emit(CoreEvent::FolderChanged {
                        session: folder.id,
                        refs: false,
                        repo: repo.as_ref().map(|r| r.work_tree.clone()),
                    });
                }
            }
        }
        Ok(result)
    }
}

/// 줄 끝 혼합이나 단독 CR은 편집기 정규화로 훼손될 수 있으므로 거부한다.
fn line_ending(text: &str) -> Option<FsLineEnding> {
    let mut lf = false;
    let mut crlf = false;
    let bytes = text.as_bytes();
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'\r' && bytes.get(i + 1) != Some(&b'\n') {
            return None;
        }
        if *byte == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf = true;
            } else {
                lf = true;
            }
        }
    }
    if lf && crlf {
        None
    } else if crlf {
        Some(FsLineEnding::Crlf)
    } else {
        Some(FsLineEnding::Lf)
    }
}

/// 원문과 정밀 수정 시각·파일 식별자를 묶어 외부 교체와 동일 길이 수정을 감지한다.
fn revision(target: &Target, text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(target.path.as_os_str().as_encoded_bytes());
    hash.update(text.as_bytes());
    hash.update(format!("{:?}", target.meta.modified()).as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(target.meta.dev().to_le_bytes());
        hash.update(target.meta.ino().to_le_bytes());
        hash.update(target.meta.mode().to_le_bytes());
        hash.update(target.meta.ctime().to_le_bytes());
        hash.update(target.meta.ctime_nsec().to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// 기존 경로 안전성 검사와 제한을 적용하고 원문 읽기 전후 revision이 같을 때만 반환한다.
fn read_editable_at(root: &Path, request: &str) -> Result<FsEditableFile, CoreError> {
    let rel = parse(request)?;
    let target = match resolve(root, rel.components(), request)? {
        Resolved::Found(target) => target,
        Resolved::Missing => return Ok(FsEditableFile::Unavailable(FsFile::Missing)),
        Resolved::Denied => return Ok(FsEditableFile::Unavailable(FsFile::Denied)),
    };
    let file = read_target(&target, request)?;
    let FsFile::Text { text, size } = file else {
        return Ok(FsEditableFile::Unavailable(file));
    };
    if text.contains('\0') {
        return Ok(FsEditableFile::Unavailable(FsFile::Binary { size }));
    }
    let Some(line_ending) = line_ending(&text) else {
        return Ok(FsEditableFile::MixedLineEndings);
    };
    let now = match resolve(root, rel.components(), request)? {
        Resolved::Found(now) => now,
        _ => return Ok(FsEditableFile::Unavailable(FsFile::Missing)),
    };
    if revision(&target, &text) != revision(&now, &text) {
        return Err(rejected(request, CHANGED_REASON));
    }
    Ok(FsEditableFile::Text {
        revision: revision(&target, &text),
        file_key: format!(
            "{:x}",
            Sha256::digest(target.path.as_os_str().as_encoded_bytes())
        ),
        bom: text.starts_with('\u{feff}'),
        text,
        size,
        line_ending,
    })
}

/// 임시 파일에 권한과 원문을 기록하고 교체 직전에 경로·revision을 다시 검사한다.
fn save_at(
    root: &Path,
    request: &str,
    expected: &str,
    text: &str,
) -> Result<FsSaveResult, CoreError> {
    let failed = |message: &str| FsSaveResult::Failed {
        message: message.into(),
    };
    if text.len() as u64 > FS_READ_MAX_BYTES {
        return Ok(failed(pick(
            "파일이 1 MiB를 초과합니다",
            "File exceeds 1 MiB",
        )));
    }
    if text.contains('\0') || line_ending(text).is_none() {
        return Ok(failed(pick(
            "지원하지 않는 텍스트 형식입니다",
            "Unsupported text format",
        )));
    }
    let FsEditableFile::Text {
        revision: current, ..
    } = read_editable_at(root, request)?
    else {
        return Ok(FsSaveResult::Conflict);
    };
    if current != expected {
        return Ok(FsSaveResult::Conflict);
    }
    let rel = parse(request)?;
    let Resolved::Found(target) = resolve(root, rel.components(), request)? else {
        return Ok(FsSaveResult::Conflict);
    };
    if target.meta.permissions().readonly() {
        return Ok(failed(pick("읽기 전용 파일입니다", "File is read-only")));
    }
    let save = || -> Result<FsSaveResult, CoreError> {
        let parent = target
            .path
            .parent()
            .ok_or_else(|| rejected(request, OUTSIDE_REASON))?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".mgit-save-")
            .tempfile_in(parent)?;
        temporary
            .as_file()
            .set_permissions(target.meta.permissions())?;
        temporary.write_all(text.as_bytes())?;
        temporary.as_file().sync_all()?;
        let FsEditableFile::Text {
            revision: latest, ..
        } = read_editable_at(root, request)?
        else {
            return Ok(FsSaveResult::Conflict);
        };
        if latest != expected {
            return Ok(FsSaveResult::Conflict);
        }
        temporary
            .persist(&target.path)
            .map_err(|error| CoreError::Io(error.error))?;
        let meta = std::fs::symlink_metadata(&target.path)?;
        Ok(FsSaveResult::Saved {
            revision: revision(
                &Target {
                    path: target.path.clone(),
                    meta,
                },
                text,
            ),
        })
    };
    match save() {
        Ok(result) => Ok(result),
        Err(CoreError::Io(error)) => Ok(FsSaveResult::Failed {
            message: error.kind().to_string(),
        }),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// 큐 대기 중 checkout에 해당하는 외부 교체가 일어나면 잠금 뒤 재검증으로 덮어쓰기를 막는다.
    #[tokio::test]
    #[allow(clippy::unwrap_used)]
    async fn save_revision_is_checked_after_repository_queue() {
        let runner = mgit_git::TokioGitRunner::new(mgit_git::RunnerConfig::default())
            .await
            .unwrap();
        let core = Core::new(Arc::new(runner), crate::CoreConfig::default());
        let mut repo = mgit_testkit::build(mgit_testkit::Scenario::Linear(1));
        repo.write_file("f1.txt", "displayed\n");
        let opened = core
            .open_repo(repo.path(), Arc::new(|_: CoreEvent| {}))
            .await
            .unwrap();
        let session = core.inner().get(opened.session).unwrap();
        let FsEditableFile::Text { revision, .. } = core
            .fs_read_editable_file(opened.session, "f1.txt")
            .await
            .unwrap()
        else {
            panic!("텍스트여야 한다");
        };
        let lock = core.inner().write_lock_for(&session.info.common_dir);
        let held = lock.lock().await;
        let pending = core.fs_save_file(opened.session, "f1.txt", &revision, "mine");
        tokio::pin!(pending);
        tokio::select! {
            _ = &mut pending => panic!("쓰기 큐 잠금을 기다려야 한다"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(30)) => {}
        }
        repo.git_ok(["checkout", "--", "f1.txt"]);
        drop(held);
        assert_eq!(pending.await.unwrap(), FsSaveResult::Conflict);
        assert!(repo.git_ok(["diff", "--cached", "--name-only"]).is_empty());
    }
}
