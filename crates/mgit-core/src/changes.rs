//! 변경 사항·스테이징·커밋 (CHG-02~06, DIFF-01·02).
//!
//! 모든 상태 변경은 `run_write`(쓰기 큐)를 지난다. discard·rollback 은 되돌릴 수 없으므로
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
    BackupRecord, DiffOptions, EnvProfile, FileDiff, FileState, GitRequest, InProgressOp, LineKind,
    LineSelection, MarkerHit, Oid, StatusEntry, now_millis,
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
            "UTF-8이 아닌 파일은 줄 단위로 처리할 수 없습니다. 파일 전체를 스테이징하거나 되돌리세요: {path}",
            "Non-UTF-8 files cannot be processed line by line. Stage or revert the whole file: {path}"
        )));
    }
    Ok(())
}

/// Rollback 할 대상 (요청 경로를 status 항목으로 펼친 결과)
#[derive(Debug, Default, PartialEq, Eq)]
struct RollbackPlan {
    /// 백업할 작업 트리 경로 (항목의 현재 경로)
    backup: Vec<String>,
    /// 지울 untracked 경로
    untracked: Vec<String>,
    /// git 으로 HEAD 에 맞출 경로 (rename·copy 의 원래 경로 포함)
    tracked: Vec<String>,
    /// index 에 추가(A)된 경로 — unborn 저장소에서 디스크에서도 지울 대상
    added: Vec<String>,
}

/// 요청 경로를 비교용으로 다듬는다: `.`·빈 조각·끝의 `/` 를 없앤다. 빈 문자열이면 저장소 전체다
fn norm_rel(p: &str) -> String {
    p.split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// status 경로 `path` 가 다듬은 요청 경로 `want` 자체이거나 그 아래인지
fn path_under(path: &str, want: &str) -> bool {
    let path = path.trim_end_matches('/');
    want.is_empty()
        || path == want
        || path
            .strip_prefix(want)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// 요청 경로(파일·폴더)를 status 항목으로 펼치고 되돌릴 수 있는지 검사한다 (세션 상태만 보는 순수 함수).
/// 충돌 항목과, 진행 중 작업(bisect 제외)에서 stage 된 항목이 하나라도 있으면 아무것도 하지 않고 거부한다.
/// 어느 항목에도 걸리지 않는 요청 경로(이미 깨끗한 파일)는 조용히 건너뛴다
fn plan_rollback(
    entries: &[StatusEntry],
    paths: &[String],
    op: Option<&InProgressOp>,
) -> Result<RollbackPlan, CoreError> {
    let wants: Vec<String> = paths.iter().map(|p| norm_rel(p)).collect();
    let hit = |p: &str| wants.iter().any(|w| path_under(p, w));
    let chosen: Vec<&StatusEntry> = entries
        .iter()
        .filter(|e| e.worktree != FileState::Ignored)
        .filter(|e| hit(&e.path) || e.orig_path.as_deref().is_some_and(hit))
        .collect();

    let conflicts: Vec<&str> = chosen
        .iter()
        .filter(|e| e.conflict.is_some())
        .map(|e| e.path.as_str())
        .collect();
    if !conflicts.is_empty() {
        return Err(CoreError::Invalid(tr!(
            "충돌 중인 파일은 되돌리지 않습니다. 먼저 충돌을 해결하거나 작업을 중단하세요: {}",
            "Conflicted files are not rolled back. Resolve the conflicts or abort the operation first: {}",
            conflicts.join(", ")
        )));
    }
    // bisect 는 index 에 해결 결과를 두지 않으니 막지 않는다
    if op.is_some_and(|o| !matches!(o, InProgressOp::Bisect)) {
        let staged: Vec<&str> = chosen
            .iter()
            .filter(|e| e.is_staged())
            .map(|e| e.path.as_str())
            .collect();
        if !staged.is_empty() {
            return Err(CoreError::Invalid(tr!(
                "병합·리베이스 등이 진행 중이므로 충돌 해결 결과를 보호하기 위해 스테이징된 변경을 되돌리지 않습니다: {}",
                "An operation such as merge or rebase is in progress, so staged changes are not rolled back (protecting resolutions): {}",
                staged.join(", ")
            )));
        }
    }

    let mut plan = RollbackPlan::default();
    for e in chosen {
        plan.backup.push(e.path.clone());
        if e.is_untracked() {
            plan.untracked.push(e.path.clone());
            continue;
        }
        plan.tracked.push(e.path.clone());
        if let Some(orig) = &e.orig_path {
            plan.tracked.push(orig.clone());
        }
        if e.index == FileState::Added {
            plan.added.push(e.path.clone());
        }
    }
    Ok(plan)
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
        self.stage_lines_checked(session, path, selection, unstage, opts, None)
            .await
    }

    /// 표시 revision을 확인하고 쓰기 큐 안에서 다시 검사하여 오래된 선택을 거부한다.
    pub async fn stage_lines_checked(
        &self,
        session: SessionId,
        path: &str,
        selection: &[LineSelection],
        unstage: bool,
        opts: DiffOptions,
        expected_revision: Option<&str>,
    ) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        let revision = crate::diff_document::work_revision(
            self.inner().runner(),
            &s.info.work_tree,
            path,
            unstage,
            opts,
        )
        .await?;
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(crate::diff_document::stale_diff_error());
        }
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
        let mut spec = WriteSpec::new(args).with_stdin(patch);
        spec.diff_revision = Some((path.into(), unstage, opts, revision));
        self.run_write(session, spec).await?;
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
        self.discard_lines_checked(session, path, selection, opts, None)
            .await
    }

    /// 되돌리기도 표시 revision을 쓰기 큐 안에서 재검증한다.
    pub async fn discard_lines_checked(
        &self,
        session: SessionId,
        path: &str,
        selection: &[LineSelection],
        opts: DiffOptions,
        expected_revision: Option<&str>,
    ) -> Result<Option<u64>, CoreError> {
        let s = self.inner().get(session)?;
        let revision = crate::diff_document::work_revision(
            self.inner().runner(),
            &s.info.work_tree,
            path,
            false,
            opts,
        )
        .await?;
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(crate::diff_document::stale_diff_error());
        }
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
        let mut spec = WriteSpec::new(args).with_stdin(patch);
        spec.diff_revision = Some((path.into(), false, opts, revision));
        self.run_write(session, spec).await?;
        Ok(id)
    }

    /// 경로들의 변경을 HEAD 기준으로 되돌린다 (Rollback, CHG-04). stage 된 변경까지 되돌리는 점이
    /// unstaged 만 버리는 `discard` 와 다르다. 지우거나 덮기 전에 작업 트리 파일을 모두 백업하고 백업 id 를 돌려준다.
    ///
    /// - 요청 경로는 파일이나 폴더다. 폴더면 그 아래 status 항목(untracked 는 `-uall` 이라 파일 단위)으로 펼친다
    /// - 충돌 항목, 진행 중 작업(merge·rebase 등)의 stage 된 항목은 거부한다 (해결 결과 보호)
    /// - untracked 파일은 지운다 (링크는 따라가지 않는다). 폴더 자체는 지우지 않는다
    /// - 추적·stage 항목은 `git restore --source=HEAD --staged --worktree` 로 되돌린다. no-overlay 라 HEAD 에 없는
    ///   추가(A) 항목은 index·디스크에서 사라지고, rename 은 원래 경로와 새 경로를 함께 넘긴다
    /// - HEAD 가 없는(unborn) 저장소는 index 의 항목이 모두 추가라 `rm --cached` 뒤 파일을 지운다
    pub async fn rollback(
        &self,
        session: SessionId,
        paths: &[String],
    ) -> Result<Vec<u64>, CoreError> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        for p in paths {
            if !is_safe_rel_path(p) {
                return Err(CoreError::Invalid(tr!(
                    "잘못된 경로: {p}",
                    "Invalid path: {p}"
                )));
            }
        }
        let s = self.inner().get(session)?;
        // 화면이 본 상태가 오래됐을 수 있으니 되돌리기 전에 status·진행 중 작업을 다시 읽는다
        self.inner()
            .refresh_session(&s, RefreshScope::all(true))
            .await;
        let (plan, has_head) = {
            let st = s.state();
            (
                plan_rollback(&st.status.entries, paths, st.op.as_ref())?,
                st.refs.head.oid().is_some(),
            )
        };
        // 백업할 수 없는 폴더(중첩 저장소 등)는 함께 고른 파일까지 건드리기 전에 거부한다
        let dirs: Vec<&str> = plan
            .untracked
            .iter()
            .filter(|p| {
                s.info
                    .work_tree
                    .join(p)
                    .symlink_metadata()
                    .is_ok_and(|m| m.is_dir())
            })
            .map(String::as_str)
            .collect();
        if !dirs.is_empty() {
            return Err(CoreError::Invalid(tr!(
                "폴더는 백업할 수 없어 되돌리지 않습니다: {}. 필요하면 직접 지우세요",
                "Folders cannot be backed up, so they were not rolled back: {}. Delete them yourself if needed",
                dirs.join(", ")
            )));
        }
        let mut ids = Vec::new();
        for p in &plan.backup {
            if let Some(id) = self.backup_file(&s, p, "rollback")? {
                ids.push(id);
            }
        }
        // git 쪽을 먼저 한다. 실패하면 untracked 파일은 그대로 남는다
        if !plan.tracked.is_empty() {
            let args: &[&str] = if has_head {
                &["restore", "--source=HEAD", "--staged", "--worktree"]
            } else {
                &["rm", "--cached", "-f", "-q", "--ignore-unmatch"]
            };
            let mut args: Vec<String> = args.iter().map(|a| (*a).to_string()).collect();
            args.extend([
                "--pathspec-from-file=-".into(),
                "--pathspec-file-nul".into(),
            ]);
            let mut list = Vec::new();
            for p in &plan.tracked {
                list.extend_from_slice(p.as_bytes());
                list.push(0);
            }
            self.run_write(
                session,
                WriteSpec::new(args)
                    .with_stdin(list)
                    .label("rollback")
                    .skip_refresh(),
            )
            .await?;
        }
        // unborn 이면 index 에서 뺀 추가 파일을 디스크에서도 지운다 (폴더·서브모듈은 건드리지 않는다)
        let mut remove: Vec<&String> = plan.untracked.iter().collect();
        if !has_head {
            remove.extend(plan.added.iter());
        }
        for p in remove {
            // 링크는 따라가지 않고 링크 자체를 지운다 (끊긴 링크 포함)
            let abs = s.info.work_tree.join(p);
            if abs.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
                std::fs::remove_file(&abs).map_err(mgit_model::StoreError::Io)?;
            }
        }
        self.inner()
            .refresh_session(&s, RefreshScope::all(true))
            .await;
        Ok(ids)
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
                    "커밋 후 HEAD를 찾을 수 없습니다",
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
        self.store_backup(&s.info.work_tree, rel, reason, |dest| {
            std::fs::copy(&src, dest).map(|_| ())
        })
        .map(Some)
    }

    /// 확인을 마친 원문을 폐기 백업으로 남긴다 (여러 파일 바꾸기의 이유 `replace`). 디스크를 다시 복사하지 않고
    /// revision 을 확인한 원문 그대로 쓰므로, 같은 revision 으로 저장에 성공하면 사본이 덮어쓴 원문과 같다
    pub(crate) fn backup_text(
        &self,
        work_tree: &Path,
        rel: &str,
        reason: &str,
        text: &str,
    ) -> Result<u64, CoreError> {
        self.store_backup(work_tree, rel, reason, |dest| std::fs::write(dest, text))
    }

    /// 사본 자리 `<백업 루트>/<저장소 키>/<시각-순번>/<상대 경로>` 를 만들어 `write` 로 채우고 색인을 남긴다
    fn store_backup(
        &self,
        work_tree: &Path,
        rel: &str,
        reason: &str,
        write: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<u64, CoreError> {
        let root: PathBuf = crate::backup_cleanup::backup_root(self.config());
        let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = root
            .join(repo_key(work_tree))
            .join(format!("{}-{seq}", now_millis()));
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(mgit_model::StoreError::Io)?;
        }
        write(&dest).map_err(mgit_model::StoreError::Io)?;
        let id = self.store().backup_add(&BackupRecord {
            id: 0,
            repo: work_tree.to_path_buf(),
            rel_path: rel.to_string(),
            saved_at: now_millis(),
            blob_path: dest,
            reason: reason.to_string(),
        })?;
        Ok(id)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
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

    /// 시험용 status 항목
    fn entry(path: &str, index: FileState, worktree: FileState) -> StatusEntry {
        StatusEntry {
            path: path.into(),
            orig_path: None,
            index,
            worktree,
            submodule: None,
            conflict: None,
            rename_score: None,
        }
    }

    /// 요청 경로를 다듬어 폴더 접두사로 비교한다 (`a` 는 `ab/x` 를 고르지 않는다)
    #[test]
    fn rollback_path_matching() {
        assert_eq!(norm_rel("./a//b/"), "a/b");
        assert_eq!(norm_rel("."), "");
        assert!(path_under("a/b.txt", "a"));
        assert!(path_under("a", "a"));
        assert!(path_under("nested/", "nested"));
        assert!(!path_under("ab/x", "a"));
        assert!(path_under("anything", ""));
    }

    /// 폴더 요청은 그 아래 항목으로 펼치고, rename 은 원래 경로도 git 에 넘기며, 추가(A)는 따로 모은다
    #[test]
    fn rollback_plan_expands_folders_and_renames() {
        use FileState::*;
        let mut renamed = entry("dir/new.txt", Renamed, Unmodified);
        renamed.orig_path = Some("old.txt".into());
        let entries = vec![
            entry("dir/a.txt", Added, Unmodified),
            entry("dir/u.txt", Unmodified, Untracked),
            entry("other.txt", Modified, Modified),
            renamed,
        ];
        let plan = plan_rollback(&entries, &["dir/".into()], None).unwrap();
        assert_eq!(plan.backup, ["dir/a.txt", "dir/u.txt", "dir/new.txt"]);
        assert_eq!(plan.untracked, ["dir/u.txt"]);
        assert_eq!(plan.tracked, ["dir/a.txt", "dir/new.txt", "old.txt"]);
        assert_eq!(plan.added, ["dir/a.txt"]);
        // rename 의 원래 경로로 골라도 같은 항목이다
        let plan = plan_rollback(&entries, &["old.txt".into()], None).unwrap();
        assert_eq!(plan.tracked, ["dir/new.txt", "old.txt"]);
        // 깨끗한 경로는 조용히 건너뛴다
        assert_eq!(
            plan_rollback(&entries, &["clean.txt".into()], None).unwrap(),
            RollbackPlan::default()
        );
    }

    /// 충돌 항목은 늘, 진행 중 작업(bisect 제외)의 stage 된 항목은 거부한다. unstaged 만 있는 항목은 된다
    #[test]
    fn rollback_plan_refuses_conflicts_and_staged_during_operation() {
        use FileState::*;
        let mut conflicted = entry("c.txt", Unmerged, Unmerged);
        conflicted.conflict = Some(mgit_model::ConflictKind::BothModified);
        let entries = vec![
            conflicted,
            entry("s.txt", Modified, Unmodified),
            entry("w.txt", Unmodified, Modified),
        ];
        assert!(plan_rollback(&entries, &["c.txt".into()], None).is_err());
        let merge = InProgressOp::Merge {
            head: Oid::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap(),
        };
        assert!(plan_rollback(&entries, &["s.txt".into()], Some(&merge)).is_err());
        assert!(plan_rollback(&entries, &["w.txt".into()], Some(&merge)).is_ok());
        assert!(plan_rollback(&entries, &["s.txt".into()], Some(&InProgressOp::Bisect)).is_ok());
        assert!(plan_rollback(&entries, &["s.txt".into()], None).is_ok());
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
