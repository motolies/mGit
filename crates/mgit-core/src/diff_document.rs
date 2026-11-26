//! 전체 파일 비교 원문과 쓰기 검증용 revision. 패치의 hunk 번호는 그대로 유지한다.
use std::path::Path;

use mgit_git::cmd::compare_files;
use mgit_model::{DiffChange, DiffOptions, FileDiff, GitRequest, GitRunner, Oid};
use sha2::{Digest, Sha256};

use crate::{Core, CoreError, SessionId};

/// 비교 한쪽의 확정된 원문. 없는 파일은 빈 문자열, 표시할 수 없는 원문은 None이다.
#[derive(Clone, Debug)]
pub struct DiffDocumentSide {
    pub path: Option<String>,
    pub label: String,
    pub content: Option<String>,
    pub line_count: u32,
}

/// 패치와 원문을 함께 전달하며 원문 제한과 패치 잘림을 구분한다.
#[derive(Clone, Debug)]
pub struct DiffDocument {
    pub diff: FileDiff,
    pub old: DiffDocumentSide,
    pub new: DiffDocumentSide,
    pub revision: String,
    pub limit_reason: Option<String>,
}

#[derive(Default)]
struct Source {
    path: Option<String>,
    bytes: Vec<u8>,
    mode: u32,
}

/// 파일 경로는 pathspec 문법으로 해석하지 않고 조회 실패는 누락 파일과 구분한다.
async fn git(runner: &dyn GitRunner, wt: &Path, args: &[&str]) -> Result<Vec<u8>, CoreError> {
    let mut req = GitRequest::new(wt, args.iter().copied());
    req.global_args.push("--literal-pathspecs".into());
    let display = req.display_args();
    Ok(runner.run(req).await?.ok(&display)?)
}

/// ref 이름을 먼저 확정해 조회 도중 브랜치가 이동해도 비교 기준을 유지한다.
async fn resolve(runner: &dyn GitRunner, wt: &Path, name: &str) -> Result<String, CoreError> {
    crate::history::check_ref(name)?;
    Ok(String::from_utf8_lossy(
        &git(
            runner,
            wt,
            &["rev-parse", "--verify", "--end-of-options", name],
        )
        .await?,
    )
    .trim()
    .into())
}

/// 트리 또는 인덱스의 경로를 조회하고 blob만 읽는다. 링크·서브모듈은 내용을 따라가지 않는다.
async fn source(
    runner: &dyn GitRunner,
    wt: &Path,
    revision: Option<&str>,
    path: &str,
) -> Result<Source, CoreError> {
    let entries = match revision {
        Some(rev) => git(runner, wt, &["ls-tree", "-z", rev, "--", path]).await?,
        None => git(runner, wt, &["ls-files", "--stage", "-z", "--", path]).await?,
    };
    let Some(entry) = entries.split(|b| *b == 0).find(|e| !e.is_empty()) else {
        return Ok(Source::default());
    };
    let meta = String::from_utf8_lossy(entry.split(|b| *b == b'\t').next().unwrap_or_default());
    let fields: Vec<_> = meta.split_whitespace().collect();
    let mode = u32::from_str_radix(fields[0], 8).unwrap_or_default();
    let blob = if revision.is_some() {
        fields.get(2)
    } else {
        fields.get(1)
    };
    let bytes = if mode & 0o170000 == 0o100000 {
        git(
            runner,
            wt,
            &["cat-file", "blob", blob.copied().unwrap_or("")],
        )
        .await?
    } else {
        Vec::new()
    };
    Ok(Source {
        path: Some(path.into()),
        bytes,
        mode,
    })
}

/// 작업 파일을 읽되 중간 링크·특수 파일을 따라가지 않는다.
fn work_source(wt: &Path, path: &str) -> Result<Source, CoreError> {
    if !crate::changes::is_safe_rel_path(path) {
        return Err(CoreError::Invalid("Invalid diff path".into()));
    }
    let mut full = wt.to_path_buf();
    let components: Vec<_> = Path::new(path).components().collect();
    for (index, part) in components.iter().enumerate() {
        full.push(part);
        let meta = match full.symlink_metadata() {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Source::default()),
            Err(e) => return Err(CoreError::Invalid(e.to_string())),
        };
        if meta.file_type().is_symlink() {
            if index + 1 != components.len() {
                return Err(CoreError::Invalid(
                    "Diff path contains a symbolic link".into(),
                ));
            }
            return Ok(Source {
                path: Some(path.into()),
                bytes: std::fs::read_link(&full)
                    .map_err(|e| CoreError::Invalid(e.to_string()))?
                    .as_os_str()
                    .as_encoded_bytes()
                    .to_vec(),
                mode: 0o120000,
            });
        }
        if index + 1 == components.len() {
            if !meta.is_file() {
                return Ok(Source {
                    path: Some(path.into()),
                    bytes: Vec::new(),
                    mode: 0o160000,
                });
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            use std::io::Read;
            let mut file = options
                .open(&full)
                .map_err(|e| CoreError::Invalid(e.to_string()))?;
            if !file
                .metadata()
                .map_err(|e| CoreError::Invalid(e.to_string()))?
                .is_file()
            {
                return Err(CoreError::Invalid("Diff target changed".into()));
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|e| CoreError::Invalid(e.to_string()))?;
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                if file
                    .metadata()
                    .map_err(|e| CoreError::Invalid(e.to_string()))?
                    .permissions()
                    .mode()
                    & 0o111
                    != 0
                {
                    0o100755
                } else {
                    0o100644
                }
            };
            #[cfg(not(unix))]
            let mode = 0o100644;
            return Ok(Source {
                path: Some(path.into()),
                bytes,
                mode,
            });
        }
    }
    Ok(Source::default())
}

/// HEAD·인덱스·작업 원문의 지문은 공백 무시와 무관하게 실제 변경을 감지한다.
pub(crate) async fn work_revision(
    runner: &dyn GitRunner,
    wt: &Path,
    path: &str,
    staged: bool,
    opts: DiffOptions,
) -> Result<String, CoreError> {
    let mut hash = Sha256::new();
    hash.update(path.as_bytes());
    hash.update(format!("{staged}:{opts:?}"));
    let head = runner
        .run(GitRequest::new(wt, ["rev-parse", "--verify", "-q", "HEAD"]))
        .await?;
    hash.update(&head.stdout);
    hash.update(git(runner, wt, &["ls-files", "--stage", "-z"]).await?);
    if !staged {
        let work = work_source(wt, path)?;
        hash.update(work.mode.to_le_bytes());
        hash.update(work.bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// 원문이 지원되지 않는 이유를 정하고 줄 수 제한을 양쪽에 같이 적용한다.
#[allow(clippy::too_many_arguments)]
fn document(
    patch: Option<FileDiff>,
    old: Source,
    new: Source,
    old_label: String,
    new_label: String,
    revision: String,
    max: u32,
    full: bool,
) -> DiffDocument {
    let mut diff = patch.unwrap_or_else(|| FileDiff {
        old_path: old.path.clone(),
        new_path: new.path.clone(),
        change: if old.path.is_none() {
            DiffChange::Added
        } else if new.path.is_none() {
            DiffChange::Deleted
        } else {
            DiffChange::Modified
        },
        old_mode: Some(old.mode),
        new_mode: Some(new.mode),
        old_blob: None,
        new_blob: None,
        binary: None,
        hunks: Vec::new(),
        truncated: false,
        total_lines: 0,
        non_utf8: false,
    });
    let mut reason = None;
    let mut side = |src: Source, label| {
        let lines = if src.bytes.is_empty() {
            0
        } else {
            src.bytes.iter().filter(|b| **b == b'\n').count() as u32
                + u32::from(!src.bytes.ends_with(b"\n"))
        };
        let content = if src.path.is_some() && src.mode & 0o170000 != 0o100000 {
            reason = Some("unsupported-file-type".into());
            None
        } else if src.bytes.contains(&0) {
            reason = Some("binary".into());
            None
        } else {
            match String::from_utf8(src.bytes) {
                Ok(text) => Some(text),
                Err(_) => {
                    diff.non_utf8 = true;
                    reason = Some("non-utf8".into());
                    None
                }
            }
        };
        DiffDocumentSide {
            path: src.path,
            label,
            content,
            line_count: lines,
        }
    };
    let mut old = side(old, old_label);
    let mut new = side(new, new_label);
    if reason.is_none() && !full && (old.line_count > max || new.line_count > max) {
        reason = Some("line-limit".into());
        old.content = None;
        new.content = None;
    }
    if !full && reason.is_some() {
        diff.truncate_to(max);
    }
    DiffDocument {
        diff,
        old,
        new,
        revision,
        limit_reason: reason,
    }
}

impl Core {
    /// 작업 트리 비교는 조회 전후 revision이 일치할 때만 반환한다.
    pub async fn work_tree_diff_document(
        &self,
        session: SessionId,
        path: &str,
        staged: bool,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        for _ in 0..3 {
            let revision = work_revision(runner, wt, path, staged, opts).await?;
            let patch = self
                .work_tree_diff_opts(session, path, staged, true, opts)
                .await?;
            let old_path = patch
                .as_ref()
                .and_then(|d| d.old_path.as_deref())
                .unwrap_or(path);
            let old = if staged {
                let head = runner
                    .run(GitRequest::new(wt, ["rev-parse", "--verify", "-q", "HEAD"]))
                    .await?;
                if head.exit.success() {
                    source(
                        runner,
                        wt,
                        Some(String::from_utf8_lossy(&head.stdout).trim()),
                        old_path,
                    )
                    .await?
                } else {
                    Source::default()
                }
            } else {
                source(runner, wt, None, old_path).await?
            };
            let new = if staged {
                source(runner, wt, None, path).await?
            } else {
                work_source(wt, path)?
            };
            if revision == work_revision(runner, wt, path, staged, opts).await? {
                return Ok(document(
                    patch,
                    old,
                    new,
                    if staged { "HEAD" } else { "Index" }.into(),
                    if staged { "Index" } else { "Working tree" }.into(),
                    revision,
                    self.config().diff_max_lines,
                    full,
                ));
            }
        }
        Err(CoreError::Invalid(
            "File changed while loading the diff; reload and try again".into(),
        ))
    }

    /// 커밋 비교는 기존 첫 부모·루트 규칙을 사용한다.
    pub async fn commit_file_diff_document(
        &self,
        session: SessionId,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let s = self.inner().get(session)?;
        self.commit_file_diff_document_at(&s.info.work_tree, oid, path, old_path, full, opts)
            .await
    }

    /// 폴더와 저장소 세션의 커밋 원문 조회를 공유한다.
    pub(crate) async fn commit_file_diff_document_at(
        &self,
        wt: &Path,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let runner = self.inner().runner();
        let oid = oid.to_hex();
        let parents = git(runner, wt, &["rev-list", "--parents", "-n1", &oid]).await?;
        let parents = String::from_utf8_lossy(&parents);
        let parent = parents.split_whitespace().nth(1);
        let parsed_oid =
            Oid::from_hex(oid.as_bytes()).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let patch = self
            .commit_file_diff_at(wt, &parsed_oid, path, old_path, true, opts)
            .await?;
        let old_path = patch
            .as_ref()
            .and_then(|d| d.old_path.as_deref())
            .or(old_path)
            .unwrap_or(path);
        let old = if let Some(parent) = parent {
            source(runner, wt, Some(parent), old_path).await?
        } else {
            Source::default()
        };
        let new = source(runner, wt, Some(&oid), path).await?;
        Ok(document(
            patch,
            old,
            new,
            parent.unwrap_or("Empty tree").into(),
            oid.clone(),
            oid,
            self.config().diff_max_lines,
            full,
        ))
    }

    /// 폴더 소속 저장소만 조회하고 새 저장소 세션은 만들지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub async fn folder_commit_file_diff_document(
        &self,
        session: SessionId,
        repo: &Path,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let primary = folder.group_of(repo)?;
        self.commit_file_diff_document_at(&primary.found.path, oid, path, old_path, full, opts)
            .await
    }

    /// three-dot은 실제 merge base를 고정하고 rename의 양쪽 경로를 함께 조회한다.
    #[allow(clippy::too_many_arguments)]
    pub async fn compare_file_diff_document(
        &self,
        session: SessionId,
        a: &str,
        b: &str,
        three_dot: bool,
        path: &str,
        opts: DiffOptions,
        full: bool,
    ) -> Result<DiffDocument, CoreError> {
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        let mut a = resolve(runner, wt, a).await?;
        let b = resolve(runner, wt, b).await?;
        if three_dot {
            a = String::from_utf8_lossy(&git(runner, wt, &["merge-base", &a, &b]).await?)
                .trim()
                .into();
        }
        let files = compare_files(runner, wt, &a, &b, false).await?;
        let old_path = files
            .iter()
            .find(|f| f.path == path)
            .and_then(|f| f.old_path.as_deref())
            .unwrap_or(path);
        let mut args = vec![
            "diff".into(),
            "--no-color".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "-M".into(),
        ];
        args.extend(mgit_git::cmd::diff_option_args(&opts));
        args.extend([a.clone(), b.clone(), "--".into(), old_path.into()]);
        if old_path != path {
            args.push(path.into());
        }
        let refs: Vec<_> = args.iter().map(String::as_str).collect();
        let patches = mgit_git::parse::parse_diff(&git(runner, wt, &refs).await?);
        let patch = patches.into_iter().find(|d| d.path() == path);
        let old = source(runner, wt, Some(&a), old_path).await?;
        let new = source(runner, wt, Some(&b), path).await?;
        Ok(document(
            patch,
            old,
            new,
            a.clone(),
            b.clone(),
            format!("{a}:{b}"),
            self.config().diff_max_lines,
            full,
        ))
    }
}

/// 화면과 현재 파일이 다르면 다시 읽고 선택하도록 안내한다.
pub(crate) fn stale_diff_error() -> CoreError {
    CoreError::Invalid(
        mgit_l10n::pick(
            "표시 이후 파일이 변경되었습니다. 다시 불러온 뒤 선택하세요",
            "The file changed after it was displayed. Reload and select the changes again",
        )
        .into(),
    )
}

impl Core {
    /// 비교 입력을 이동하지 않는 객체 식별자로 확정한다.
    pub async fn resolve_revision(
        &self,
        session: SessionId,
        rev: &str,
    ) -> Result<String, CoreError> {
        let s = self.inner().get(session)?;
        resolve(self.inner().runner(), &s.info.work_tree, rev).await
    }

    /// 편집기에서 사용할 특정 커밋의 파일 원문을 읽는다. 없는 경로는 None이다.
    pub async fn revision_file_content(
        &self,
        session: SessionId,
        rev: &str,
        path: &str,
    ) -> Result<Option<String>, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let runner = self.inner().runner();
        let rev = resolve(runner, &s.info.work_tree, rev).await?;
        let src = source(runner, &s.info.work_tree, Some(&rev), path).await?;
        Ok(if src.path.is_some() && src.mode & 0o170000 == 0o100000 {
            String::from_utf8(src.bytes).ok()
        } else {
            None
        })
    }

    /// 미저장 원문을 stdin으로 전달하므로 작업 파일과 인덱스를 변경하지 않는다.
    pub async fn blame_contents(
        &self,
        session: SessionId,
        path: &str,
        text: &str,
        ignore_whitespace: bool,
    ) -> Result<Vec<mgit_model::BlameLine>, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let mut args = vec!["blame", "--line-porcelain", "--contents", "-"];
        if ignore_whitespace {
            args.push("-w");
        }
        args.extend(["--", path]);
        let req = GitRequest::new(&s.info.work_tree, args).with_stdin(text.as_bytes().to_vec());
        let display = req.display_args();
        let out = self.inner().runner().run(req).await?.ok(&display)?;
        Ok(mgit_git::cmd::parse_blame_porcelain(
            &String::from_utf8_lossy(&out),
        ))
    }

    /// 기준 커밋을 고정하고 디스크와 초안을 합친 최종 상태의 변경 파일을 찾는다.
    pub async fn compare_local_files(
        &self,
        session: SessionId,
        base: &str,
        drafts: &[(String, String)],
    ) -> Result<(String, Vec<mgit_model::ChangedFile>), CoreError> {
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        let base = resolve(runner, wt, base).await?;
        let raw = git(
            runner,
            wt,
            &["diff", "--no-renames", "--name-only", "-z", &base, "--"],
        )
        .await?;
        let untracked = git(
            runner,
            wt,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )
        .await?;
        let mut paths = std::collections::BTreeSet::new();
        for bytes in [&raw, &untracked] {
            for p in bytes.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                if let Ok(p) = std::str::from_utf8(p) {
                    paths.insert(p.to_owned());
                }
            }
        }
        for (path, _) in drafts {
            mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
            let listed = git(
                runner,
                wt,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    path,
                ],
            )
            .await?;
            if !listed.is_empty() {
                paths.insert(path.clone());
            }
        }
        let mut files = Vec::new();
        for path in paths {
            let old = source(runner, wt, Some(&base), &path).await?;
            let mut new = work_source(wt, &path)?;
            if let Some((_, text)) = drafts.iter().find(|(p, _)| *p == path) {
                new = Source {
                    path: Some(path.clone()),
                    bytes: text.as_bytes().to_vec(),
                    mode: if new.path.is_some() {
                        new.mode
                    } else if old.path.is_some() {
                        old.mode
                    } else {
                        0o100644
                    },
                };
            }
            if old.bytes != new.bytes
                || old.path.is_some() != new.path.is_some()
                || old.mode != new.mode
            {
                files.push(mgit_model::ChangedFile {
                    path,
                    old_path: None,
                    change: if old.path.is_none() {
                        DiffChange::Added
                    } else if new.path.is_none() {
                        DiffChange::Deleted
                    } else {
                        DiffChange::Modified
                    },
                });
            }
        }
        let renames = mgit_git::cmd::parse_name_status(
            &git(
                runner,
                wt,
                &["diff", "--name-status", "-M", "-z", &base, "--"],
            )
            .await?,
        );
        for rename in renames.into_iter().filter(|f| f.old_path.is_some()) {
            let old_path = rename.old_path.as_deref().unwrap_or_default();
            if files
                .iter()
                .any(|f| f.path == old_path && f.change == DiffChange::Deleted)
                && files
                    .iter()
                    .any(|f| f.path == rename.path && f.change == DiffChange::Added)
            {
                files.retain(|f| f.path != old_path && f.path != rename.path);
                files.push(rename);
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok((base, files))
    }

    /// 임시 원문 두 개의 패치만 계산하고 실제 저장소에는 쓰지 않는다.
    pub async fn compare_local_document(
        &self,
        session: SessionId,
        base: &str,
        path: &str,
        draft: Option<&str>,
        opts: DiffOptions,
        full: bool,
    ) -> Result<DiffDocument, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        let base = resolve(runner, wt, base).await?;
        let renames = mgit_git::cmd::parse_name_status(
            &git(
                runner,
                wt,
                &["diff", "--name-status", "-M", "-z", &base, "--"],
            )
            .await?,
        );
        let rename = renames
            .iter()
            .find(|f| f.path == path && f.old_path.is_some());
        let old_path = rename.and_then(|f| f.old_path.as_deref()).unwrap_or(path);
        let old = source(runner, wt, Some(&base), old_path).await?;
        let mut new = work_source(wt, path)?;
        if let Some(text) = draft {
            new = Source {
                path: Some(path.into()),
                bytes: text.as_bytes().to_vec(),
                mode: if new.path.is_some() {
                    new.mode
                } else if old.path.is_some() {
                    old.mode
                } else {
                    0o100644
                },
            };
        }
        let temp = tempfile::tempdir().map_err(|e| CoreError::Invalid(e.to_string()))?;
        let a = temp.path().join("before");
        let b = temp.path().join("after");
        std::fs::write(&a, &old.bytes).map_err(|e| CoreError::Invalid(e.to_string()))?;
        std::fs::write(&b, &new.bytes).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let mut args = vec![
            "diff".to_string(),
            "--no-index".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--no-color".into(),
        ];
        args.extend(mgit_git::cmd::diff_option_args(&opts));
        args.extend([
            "--".into(),
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ]);
        let req = GitRequest::new(wt, args);
        let display = req.display_args();
        let out = runner.run(req).await?;
        let output = if out.exit.status == Some(1) {
            out.stdout
        } else {
            out.ok(&display)?
        };
        let patch = mgit_git::parse::parse_diff(&output)
            .into_iter()
            .next()
            .map(|mut d| {
                d.old_path = old.path.clone();
                d.new_path = new.path.clone();
                d.change = if old.path.is_none() {
                    DiffChange::Added
                } else if new.path.is_none() {
                    DiffChange::Deleted
                } else {
                    rename.map(|f| f.change).unwrap_or(DiffChange::Modified)
                };
                d
            });
        let revision = format!("{}:{:x}", base, Sha256::digest(&new.bytes));
        let mut doc = document(
            patch,
            old,
            new,
            base,
            "LOCAL".into(),
            revision,
            self.config().diff_max_lines,
            full,
        );
        if let Some(rename) = rename {
            doc.diff.change = rename.change;
        }
        Ok(doc)
    }
}
