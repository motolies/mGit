//! 변경 사항·스테이징·커밋 (CHG-02~06, DIFF-01·02).
//!
//! 모든 상태 변경은 `run_write`(쓰기 큐)를 지난다. discard 는 되돌릴 수 없으므로
//! 지우기 전 사본을 앱 백업 영역에 두고 색인을 남긴다 (CHG-04).

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use mgit_git::cmd::{
    blob_size, commit_file_diff, commit_meta, show_stage, staged_conflict_markers,
    work_tree_diff as git_work_tree_diff,
};
use mgit_git::patch::build_partial_patch;
use mgit_l10n::{pick, tr};
use mgit_model::{
    BackupRecord, DiffOptions, EnvProfile, FileDiff, GitRequest, LineKind, LineSelection,
    MarkerHit, Oid, now_millis,
};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::ops::OpHandle;
use crate::refresh::RefreshScope;
use crate::session::RepoSession;
use crate::write::WriteSpec;

/// 커밋 옵션 (CHG-05)
#[derive(Clone, Debug, Default)]
pub struct CommitSpec {
    /// 요약·본문을 합친 전체 메시지
    pub message: String,
    pub amend: bool,
    /// `--no-verify` (hook 건너뛰기)
    pub no_verify: bool,
    pub allow_empty: bool,
    /// `Some(true)` = `-S`, `Some(false)` = `--no-gpg-sign`, `None` = 설정(commit.gpgSign)대로 (CHG-08)
    pub sign: Option<bool>,
    /// 충돌 마커가 남아 있어도 커밋한다 (사용자가 "그래도 커밋"을 고른 경우)
    pub allow_conflict_markers: bool,
}

/// 백업 디렉터리 안의 순번 (같은 밀리초에 여러 파일을 백업할 때 구분)
static BACKUP_SEQ: AtomicU32 = AtomicU32::new(0);

/// 작업 트리 경로를 백업 디렉터리 이름으로 쓸 짧은 키로
fn repo_key(work_tree: &Path) -> String {
    let mut h = DefaultHasher::new();
    work_tree.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 경로가 작업 트리 밖으로 나가지 않는지. 일반 이름과 `.` 만 허용한다.
/// `is_absolute()` 만으로는 안 된다: Windows 에서 `/abs`·`\abs`(루트만)와 `C:x`(드라이브만)는 절대 경로가
/// 아니지만 `work_tree.join` 하면 작업 트리를 버리고 그 드라이브의 다른 곳을 가리킨다
pub(crate) fn is_safe_rel_path(rel: &str) -> bool {
    !rel.is_empty()
        && Path::new(rel).components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

/// index 쓰기 종류 (세션·폴더 공용)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndexOp {
    /// `git add -A`: 수정·추가·삭제 모두
    Stage,
    /// HEAD 가 있으면 `git restore --staged`, 없으면(unborn) `git rm -r -q --cached`
    Unstage,
}

/// stage·unstage 의 쓰기 명령 (세션·폴더 공용 본체). `paths` 는 git 에 넘길 경로(`.` 은 전부)이고 러너의
/// `GIT_LITERAL_PATHSPECS=1` 로 글자 그대로 해석된다 (디렉터리면 그 아래 전부).
///
/// `from_stdin` 이 거짓이면 경로를 `--` 뒤 인자로 넘긴다 (세션용 그대로). 참이면 `--pathspec-from-file=-
/// --pathspec-file-nul` 로 stdin 에 NUL 로 끊어 넘긴다 — 폴더 화면이 충돌 파일을 피하려 대상을 파일 하나하나로
/// 풀었을 때 그 수가 인자 길이 상한을 넘지 않게. 같은 리터럴 규칙이 적용된다
pub(crate) fn index_write(
    op: IndexOp,
    has_head: bool,
    paths: &[String],
    from_stdin: bool,
) -> WriteSpec {
    let mut args: Vec<String> = match (op, has_head) {
        (IndexOp::Stage, _) => vec!["add".into(), "-A".into()],
        (IndexOp::Unstage, true) => vec!["restore".into(), "--staged".into()],
        (IndexOp::Unstage, false) => {
            vec!["rm".into(), "-r".into(), "-q".into(), "--cached".into()]
        }
    };
    if !from_stdin {
        args.push("--".into());
        args.extend(paths.iter().cloned());
        return WriteSpec::new(args);
    }
    args.extend([
        "--pathspec-from-file=-".into(),
        "--pathspec-file-nul".into(),
    ]);
    let mut list = Vec::new();
    for p in paths {
        list.extend_from_slice(p.as_bytes());
        list.push(0);
    }
    WriteSpec::new(args).with_stdin(list)
}

/// 화면의 diff 옵션에 맞춘 `git apply` 인자. 문맥 0줄 hunk 는 `--unidiff-zero` 가 있어야 적용된다
fn apply_flags(opts: &DiffOptions) -> Vec<String> {
    if opts.context == 0 {
        vec!["--unidiff-zero".to_string()]
    } else {
        Vec::new()
    }
}

/// UTF-8 이 아닌 줄은 문자열로 읽는 순간 바이트를 잃어 패치로 되돌릴 수 없다
fn refuse_non_utf8(diff: &FileDiff, path: &str) -> Result<(), CoreError> {
    if diff.non_utf8 {
        return Err(CoreError::Invalid(tr!(
            "UTF-8 이 아닌 파일은 줄 단위로 처리할 수 없습니다. 파일 전체를 stage 하거나 되돌리세요: {path}",
            "Non-UTF-8 files cannot be processed line by line. Stage or revert the whole file: {path}"
        )));
    }
    Ok(())
}

impl Core {
    /// 경로들을 stage 한다 (`git add -A -- …`: 수정·추가·삭제 모두). 본체(미등록 하위 저장소 거부·인자)는
    /// 폴더 화면의 `folder_stage` 와 같다
    pub async fn stage(&self, session: SessionId, paths: &[String]) -> Result<(), CoreError> {
        if paths.is_empty() {
            return Ok(());
        }
        let s = self.inner().get(session)?;
        // `.git` 을 품은 untracked 폴더는 gitlink 로 들어가 버리므로 먼저 막는다 (SUB-11)
        let candidates: Vec<String> = if paths.iter().any(|p| p == ".") {
            let st = s.state();
            st.status
                .entries
                .iter()
                .filter(|e| e.is_untracked())
                .map(|e| e.path.clone())
                .collect()
        } else {
            paths.to_vec()
        };
        self.refuse_nested_repos(&s.info.work_tree, &candidates)
            .await?;
        self.run_write(session, index_write(IndexOp::Stage, true, paths, false))
            .await?;
        Ok(())
    }

    /// 경로들을 unstage 한다. HEAD 가 없는 저장소는 `git rm --cached`. 인자는 폴더 화면의 `folder_unstage` 와 같다
    pub async fn unstage(&self, session: SessionId, paths: &[String]) -> Result<(), CoreError> {
        if paths.is_empty() {
            return Ok(());
        }
        let s = self.inner().get(session)?;
        let has_head = s.state().refs.head.oid().is_some();
        self.run_write(
            session,
            index_write(IndexOp::Unstage, has_head, paths, false),
        )
        .await?;
        Ok(())
    }

    /// 후보 경로 중 `.git` 을 품은 미등록 하위 저장소가 있으면 거부한다 (SUB-11, stage 의 본체 — 세션·폴더 공용).
    /// `git add` 가 그런 폴더를 gitlink 로 넣어 버리기 때문이다
    pub(crate) async fn refuse_nested_repos(
        &self,
        work_tree: &Path,
        candidates: &[String],
    ) -> Result<(), CoreError> {
        let nested = self.nested_repo_dirs_at(work_tree, candidates).await?;
        if nested.is_empty() {
            Ok(())
        } else {
            Err(CoreError::NestedRepos { paths: nested })
        }
    }

    /// 전부 stage
    pub async fn stage_all(&self, session: SessionId) -> Result<(), CoreError> {
        self.stage(session, &[".".to_string()]).await
    }

    /// 전부 unstage
    pub async fn unstage_all(&self, session: SessionId) -> Result<(), CoreError> {
        self.unstage(session, &[".".to_string()]).await
    }

    /// 작업 트리 diff (기본 옵션)
    pub async fn work_tree_diff(
        &self,
        session: SessionId,
        path: &str,
        staged: bool,
        full: bool,
    ) -> Result<Option<FileDiff>, CoreError> {
        self.work_tree_diff_opts(session, path, staged, full, DiffOptions::default())
            .await
    }

    /// 작업 트리 diff. `staged` 면 index 대 HEAD. 크기 임계를 넘으면 `full` 이 아닐 때 앞부분만 준다.
    /// `opts` 는 공백 무시·문맥 줄 수 (DIFF-03)
    pub async fn work_tree_diff_opts(
        &self,
        session: SessionId,
        path: &str,
        staged: bool,
        full: bool,
        opts: DiffOptions,
    ) -> Result<Option<FileDiff>, CoreError> {
        let s = self.inner().get(session)?;
        let untracked = !staged
            && s.state()
                .status
                .entries
                .iter()
                .any(|e| e.path == path && e.is_untracked());
        let Some(mut diff) = git_work_tree_diff(
            self.inner().runner(),
            &s.info.work_tree,
            path,
            staged,
            untracked,
            &opts,
        )
        .await?
        else {
            return Ok(None);
        };
        if let Some(info) = diff.binary.as_mut() {
            let wt = &s.info.work_tree;
            if let Some(old) = diff
                .old_blob
                .as_deref()
                .filter(|b| !b.trim_matches('0').is_empty())
            {
                info.old_size = blob_size(self.inner().runner(), wt, old).await;
            }
            if staged {
                if let Some(new) = diff
                    .new_blob
                    .as_deref()
                    .filter(|b| !b.trim_matches('0').is_empty())
                {
                    info.new_size = blob_size(self.inner().runner(), wt, new).await;
                }
            } else {
                info.new_size = std::fs::metadata(wt.join(path)).ok().map(|m| m.len());
            }
        }
        if !full {
            diff.truncate_to(self.config().diff_max_lines);
        }
        Ok(Some(diff))
    }

    /// 커밋 하나에서 파일 하나의 diff (기본 옵션, 옛 경로 없이)
    pub async fn commit_file_diff(
        &self,
        session: SessionId,
        oid: &Oid,
        path: &str,
        full: bool,
    ) -> Result<Option<FileDiff>, CoreError> {
        self.commit_file_diff_opts(session, oid, path, None, full, DiffOptions::default())
            .await
    }

    /// 커밋 하나에서 파일 하나의 diff (GRAPH-04). `old_path` 는 이름이 바뀐 파일의 옛 경로(상세의
    /// `ChangedFile.old_path`)로, 주면 rename 으로 짝지어 실제 변경분만 나온다.
    /// `opts` 는 공백 무시·문맥 줄 수 (DIFF-03)
    pub async fn commit_file_diff_opts(
        &self,
        session: SessionId,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<Option<FileDiff>, CoreError> {
        let s = self.inner().get(session)?;
        self.commit_file_diff_at(&s.info.work_tree, oid, path, old_path, full, opts)
            .await
    }

    /// 작업 트리 경로로 커밋 하나에서 파일 하나의 diff 를 읽는다 (저장소 세션·폴더 공용).
    /// 상세의 파일 목록과 같은 기준이다: 머지 커밋은 첫 부모, 루트 커밋은 빈 트리. `old_path` 를 주면
    /// rename 으로 짝짓는다. 바이너리면 blob 크기를 채우고, `full` 이 아니면 줄 수 상한(`diff_max_lines`)에서
    /// 자른다. 그 경로의 변경이 없으면 `None`. 경로(`path`·`old_path`)는 따로 검사하지 않는다 — 러너가
    /// `GIT_LITERAL_PATHSPECS=1` 을 붙여 글자 그대로 해석되고(glob·`:(magic)` 없음), 저장소 밖·빈 경로는
    /// git 오류다
    pub(crate) async fn commit_file_diff_at(
        &self,
        work_tree: &Path,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<Option<FileDiff>, CoreError> {
        let runner = self.inner().runner();
        let Some(mut diff) =
            commit_file_diff(runner, work_tree, &oid.to_hex(), path, old_path, &opts).await?
        else {
            return Ok(None);
        };
        if let Some(info) = diff.binary.as_mut() {
            for (blob, slot) in [
                (diff.old_blob.as_deref(), &mut info.old_size),
                (diff.new_blob.as_deref(), &mut info.new_size),
            ] {
                if let Some(b) = blob.filter(|b| !b.trim_matches('0').is_empty()) {
                    *slot = blob_size(runner, work_tree, b).await;
                }
            }
        }
        if !full {
            diff.truncate_to(self.config().diff_max_lines);
        }
        Ok(Some(diff))
    }

    /// 고른 hunk·줄만 stage(`unstage = false`) 하거나 unstage 한다 (CHG-03).
    /// 선택 줄로 패치를 다시 만들어 `git apply --cached [-R] --recount` 로 적용한다.
    /// `selection` 의 번호는 화면의 diff 기준이므로 `opts` 는 화면과 같아야 한다
    pub async fn stage_lines(
        &self,
        session: SessionId,
        path: &str,
        selection: &[LineSelection],
        unstage: bool,
        opts: DiffOptions,
    ) -> Result<(), CoreError> {
        let Some(diff) = self
            .work_tree_diff_opts(session, path, unstage, true, opts)
            .await?
        else {
            return Err(CoreError::Invalid(tr!(
                "변경이 없습니다: {path}",
                "No changes: {path}"
            )));
        };
        refuse_non_utf8(&diff, path)?;
        let mut diff = diff;
        if opts.ignore_whitespace && !unstage {
            self.align_context_with_index(session, path, &mut diff)
                .await?;
        }
        let Some(patch) = build_partial_patch(&diff, selection, unstage) else {
            return Ok(()); // 고른 변경이 없다
        };
        let mut args: Vec<String> = vec!["apply".into(), "--cached".into()];
        if unstage {
            args.push("-R".into());
        }
        args.extend(["--recount".into(), "--whitespace=nowarn".into()]);
        args.extend(apply_flags(&opts));
        self.run_write(session, WriteSpec::new(args).with_stdin(patch))
            .await?;
        Ok(())
    }

    /// 공백 무시 diff 의 문맥 줄은 새 쪽 내용이라 공백이 index 와 다를 수 있다. 정방향 패치는 index 에
    /// 맞아야 하므로 문맥 줄을 index 의 같은 줄로 바꾼다
    async fn align_context_with_index(
        &self,
        session: SessionId,
        path: &str,
        diff: &mut FileDiff,
    ) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        // index 에 없는 새 파일은 문맥 줄이 없다
        let Ok(bytes) = show_stage(self.inner().runner(), &s.info.work_tree, 0, path).await else {
            return Ok(());
        };
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').collect();
        for line in diff.hunks.iter_mut().flat_map(|h| h.lines.iter_mut()) {
            if line.kind == LineKind::Context
                && let Some(old) = line
                    .old_no
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|i| lines.get(i as usize))
            {
                line.text = (*old).to_string();
            }
        }
        Ok(())
    }

    /// 작업 트리 변경을 버린다 (CHG-04). 지우기 전 사본을 백업하고 백업 id 목록을 돌려준다.
    /// 추적 파일은 index 내용으로 되돌리고, untracked 파일은 지운다
    pub async fn discard(
        &self,
        session: SessionId,
        paths: &[String],
    ) -> Result<Vec<u64>, CoreError> {
        let s = self.inner().get(session)?;
        let is_untracked = |p: &String| {
            s.state()
                .status
                .entries
                .iter()
                .any(|e| e.path == *p && e.is_untracked())
        };
        // 폴더(중첩 저장소)는 백업할 수 없다. 함께 고른 파일까지 건드리기 전에 거부한다
        let mut dirs = Vec::new();
        for p in paths {
            if !is_safe_rel_path(p) {
                return Err(CoreError::Invalid(tr!(
                    "잘못된 경로: {p}",
                    "Invalid path: {p}"
                )));
            }
            let meta = s.info.work_tree.join(p).symlink_metadata();
            if is_untracked(p) && meta.is_ok_and(|m| m.is_dir()) {
                dirs.push(p.as_str());
            }
        }
        if !dirs.is_empty() {
            return Err(CoreError::Invalid(tr!(
                "폴더는 백업할 수 없어 버리지 않습니다: {}. 필요하면 직접 지우세요",
                "Folders cannot be backed up, so they were not discarded: {}. Delete them yourself if needed",
                dirs.join(", ")
            )));
        }
        let mut ids = Vec::new();
        let mut tracked = Vec::new();
        for p in paths {
            if let Some(id) = self.backup_file(&s, p, "discard")? {
                ids.push(id);
            }
            if is_untracked(p) {
                // 링크는 따라가지 않고 링크 자체를 지운다 (끊긴 링크 포함)
                let abs = s.info.work_tree.join(p);
                if abs.symlink_metadata().is_ok() {
                    std::fs::remove_file(&abs).map_err(mgit_model::StoreError::Io)?;
                }
            } else {
                tracked.push(p.clone());
            }
        }
        if !tracked.is_empty() {
            let mut args: Vec<String> = vec!["restore".into(), "--worktree".into(), "--".into()];
            args.extend(tracked);
            self.run_write(session, WriteSpec::new(args)).await?;
        } else {
            self.inner()
                .refresh_session(&s, RefreshScope::all(true))
                .await;
        }
        Ok(ids)
    }

    /// 고른 hunk·줄만 작업 트리에서 되돌린다. 파일 전체를 먼저 백업한다.
    /// `selection` 의 번호는 화면의 diff 기준이므로 `opts` 는 화면과 같아야 한다
    pub async fn discard_lines(
        &self,
        session: SessionId,
        path: &str,
        selection: &[LineSelection],
        opts: DiffOptions,
    ) -> Result<Option<u64>, CoreError> {
        let s = self.inner().get(session)?;
        if !is_safe_rel_path(path) {
            return Err(CoreError::Invalid(tr!(
                "잘못된 경로: {path}",
                "Invalid path: {path}"
            )));
        }
        let Some(diff) = self
            .work_tree_diff_opts(session, path, false, true, opts)
            .await?
        else {
            return Ok(None);
        };
        refuse_non_utf8(&diff, path)?;
        let Some(patch) = build_partial_patch(&diff, selection, true) else {
            return Ok(None);
        };
        let id = self.backup_file(&s, path, "discard-lines")?;
        let mut args: Vec<String> = ["apply", "-R", "--recount", "--whitespace=nowarn"]
            .map(String::from)
            .to_vec();
        args.extend(apply_flags(&opts));
        self.run_write(session, WriteSpec::new(args).with_stdin(patch))
            .await?;
        Ok(id)
    }

    /// 세션 저장소의 백업 목록 (최신 순)
    pub fn backups(&self, session: SessionId, limit: u32) -> Result<Vec<BackupRecord>, CoreError> {
        let s = self.inner().get(session)?;
        Ok(self.store().backups_for(&s.info.work_tree, limit)?)
    }

    /// 백업 사본을 작업 트리로 되돌린다
    pub async fn restore_backup(&self, session: SessionId, id: u64) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        let Some(rec) = self.store().backup_get(id)? else {
            return Err(CoreError::Invalid(tr!(
                "백업을 찾을 수 없습니다: {id}",
                "Backup not found: {id}"
            )));
        };
        if rec.repo != s.info.work_tree || !is_safe_rel_path(&rec.rel_path) {
            return Err(CoreError::Invalid(
                pick(
                    "다른 저장소의 백업입니다",
                    "This backup belongs to another repository",
                )
                .into(),
            ));
        }
        let dest = s.info.work_tree.join(&rec.rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(mgit_model::StoreError::Io)?;
        }
        std::fs::copy(&rec.blob_path, &dest).map_err(mgit_model::StoreError::Io)?;
        self.inner()
            .refresh_session(&s, RefreshScope::all(true))
            .await;
        Ok(())
    }

    /// stage 된 내용에 남은 충돌 마커 (CF-24)
    pub async fn verify_staged(&self, session: SessionId) -> Result<Vec<MarkerHit>, CoreError> {
        let s = self.inner().get(session)?;
        Ok(staged_conflict_markers(self.inner().runner(), &s.info.work_tree).await?)
    }

    /// 커밋한다 (CHG-05). 메시지는 stdin(`-F -`)으로 넘기고 hook 출력은 `op` 가 있으면 스트리밍된다 (CHG-06).
    /// 충돌 마커가 남아 있으면 `allow_conflict_markers` 가 아닌 한 커밋하지 않는다. 새 HEAD 를 돌려준다
    pub async fn commit(
        &self,
        session: SessionId,
        spec: CommitSpec,
        op: Option<OpHandle>,
    ) -> Result<Oid, CoreError> {
        if !spec.allow_conflict_markers {
            let markers = self.verify_staged(session).await?;
            if !markers.is_empty() {
                let mut files: Vec<String> = markers.into_iter().map(|m| m.path).collect();
                files.dedup();
                let err = CoreError::ConflictMarkers { files };
                self.abandon_operation(session, op.as_ref(), &err.to_string());
                return Err(err);
            }
        }
        let mut args: Vec<String> = vec!["commit".into(), "-q".into(), "-F".into(), "-".into()];
        if spec.amend {
            args.push("--amend".into());
            if let Some(b) = self.head_branch_name(session) {
                let _ = self.backup_ref(session, &b, "amend").await;
            }
        }
        if spec.no_verify {
            args.push("--no-verify".into());
        }
        if spec.allow_empty {
            args.push("--allow-empty".into());
        }
        match spec.sign {
            Some(true) => args.push("-S".into()),
            Some(false) => args.push("--no-gpg-sign".into()),
            None => {}
        }
        let mut message = spec.message.clone();
        if !message.ends_with('\n') {
            message.push('\n');
        }
        let mut write = WriteSpec::new(args).with_stdin(message.into_bytes());
        if let Some(op) = op {
            write = write.with_op(op);
        }
        self.run_write(session, write).await?;
        let s = self.inner().get(session)?;
        let head = s.state().refs.head.oid();
        head.ok_or_else(|| {
            CoreError::Invalid(
                pick(
                    "커밋 뒤 HEAD 를 찾을 수 없습니다",
                    "Cannot find HEAD after commit",
                )
                .into(),
            )
        })
    }

    /// HEAD 커밋의 전체 메시지 (amend 입력란 채우기용). 커밋이 없으면 빈 문자열
    pub async fn last_commit_message(&self, session: SessionId) -> Result<String, CoreError> {
        let s = self.inner().get(session)?;
        if s.state().refs.head.oid().is_none() {
            return Ok(String::new());
        }
        // `log.showSignature` 가 켜져 있어도 서명 검증 줄이 메시지에 섞이지 않게 한다
        let req = GitRequest::new(
            &s.info.work_tree,
            ["log", "-1", "--no-show-signature", "--format=%B"],
        )
        .with_env(EnvProfile::ReadInteractive);
        let args = req.display_args();
        let out = self.inner().runner().run(req).await?.ok(&args)?;
        Ok(String::from_utf8_lossy(&out)
            .trim_end_matches('\n')
            .to_string())
    }

    /// 커밋 하나의 전체 메시지 (reword 입력란 채우기용)
    pub async fn commit_message(&self, session: SessionId, oid: &Oid) -> Result<String, CoreError> {
        let s = self.inner().get(session)?;
        Ok(commit_meta(self.inner().runner(), &s.info.work_tree, oid)
            .await?
            .message)
    }

    /// 작업 트리 파일을 백업 영역에 복사하고 색인을 남긴다. 파일이 없으면 `None`
    fn backup_file(
        &self,
        s: &Arc<RepoSession>,
        rel: &str,
        reason: &str,
    ) -> Result<Option<u64>, CoreError> {
        let src = s.info.work_tree.join(rel);
        if !src.is_file() {
            return Ok(None);
        }
        let root: PathBuf = self
            .config()
            .backup_dir
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("mgit-backups"));
        let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = root
            .join(repo_key(&s.info.work_tree))
            .join(format!("{}-{seq}", now_millis()));
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(mgit_model::StoreError::Io)?;
        }
        std::fs::copy(&src, &dest).map_err(mgit_model::StoreError::Io)?;
        let id = self.store().backup_add(&BackupRecord {
            id: 0,
            repo: s.info.work_tree.clone(),
            rel_path: rel.to_string(),
            saved_at: now_millis(),
            blob_path: dest,
            reason: reason.to_string(),
        })?;
        Ok(Some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_safety() {
        assert!(is_safe_rel_path("a/b.txt"));
        assert!(!is_safe_rel_path("../x"));
        assert!(!is_safe_rel_path("a/../../x"));
        assert!(!is_safe_rel_path("/abs"));
        assert!(!is_safe_rel_path(""));
        assert!(is_safe_rel_path("./a/b.txt"));
    }

    /// Windows 에서는 루트만 있는 경로·드라이브만 있는 경로·UNC 도 작업 트리 밖이다
    #[cfg(windows)]
    #[test]
    fn rel_path_safety_windows_prefixes() {
        for bad in [r"\abs", r"C:x", r"C:\x", r"\\server\share\x", r"a\..\..\x"] {
            assert!(!is_safe_rel_path(bad), "{bad:?}");
        }
        assert!(is_safe_rel_path(r"a\b.txt"));
    }

    /// 쓰기 명령의 인자를 문자열로
    fn args_of(spec: &WriteSpec) -> Vec<String> {
        spec.args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// 인자로 넘기면 세션용 그대로다: `--` 뒤에 경로, stdin·환경 없음 (러너의 리터럴 pathspec 이 그대로 적용)
    #[test]
    fn index_write_as_arguments_keeps_session_arguments() {
        let paths = vec!["a b.txt".to_string(), "-x".to_string(), ":odd".to_string()];
        let stage = index_write(IndexOp::Stage, true, &paths, false);
        assert_eq!(
            args_of(&stage),
            ["add", "-A", "--", "a b.txt", "-x", ":odd"]
        );
        assert!(stage.stdin.is_none() && stage.env.is_empty());
        let unstage = index_write(IndexOp::Unstage, true, &paths, false);
        assert_eq!(
            args_of(&unstage),
            ["restore", "--staged", "--", "a b.txt", "-x", ":odd"]
        );
        let unborn = index_write(IndexOp::Unstage, false, &[".".into()], false);
        assert_eq!(args_of(&unborn), ["rm", "-r", "-q", "--cached", "--", "."]);
    }

    /// stdin 으로 넘기면 경로마다 NUL 로 끝맺어 `--pathspec-from-file=- --pathspec-file-nul` 로 준다 (줄바꿈이 든
    /// 이름도 한 경로다). 인자에는 경로가 없다
    #[test]
    fn index_write_from_stdin_lists_paths_nul_terminated() {
        let spec = index_write(
            IndexOp::Unstage,
            true,
            &["a\nb.txt".into(), "dir/*".into()],
            true,
        );
        assert_eq!(
            args_of(&spec),
            [
                "restore",
                "--staged",
                "--pathspec-from-file=-",
                "--pathspec-file-nul"
            ]
        );
        assert_eq!(spec.stdin.as_deref(), Some(&b"a\nb.txt\0dir/*\0"[..]));
        assert!(spec.env.is_empty());
    }
}
