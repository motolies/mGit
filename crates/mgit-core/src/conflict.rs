//! 충돌 해결 (MRG-06, CF-06~13·23·24·26). 작업 트리 파일 쓰기와 `git add` 는 쓰기 큐를 지난다

use std::io;
use std::path::{Component, Path, PathBuf};

use mgit_git::cmd::{
    MarkerStyle, commit_subject, conflict_style, list_unmerged, merge_file_stages, name_rev,
    show_stage,
};
use mgit_l10n::tr;
use mgit_merge::{AutoSuggestion, ConflictDoc, classify_doc, has_conflict_markers, parse_markers};
use mgit_model::{
    ConflictFile, ConflictKind, ConflictSide, InProgressOp, SideLabels, UnresolveMode,
};
use serde::Serialize;

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::fs_tree::is_dot_git;
use crate::messages;
use crate::write::WriteSpec;

/// 편집기용 마커 크기. 본문에 7자 마커 모양이 있어도 구분된다
pub const EDITOR_MARKER_SIZE: u32 = 32;
/// 바이너리 판정에 보는 앞부분 길이 (파일 보기 FS-08 도 같은 값을 쓴다)
pub(crate) const BINARY_PROBE: usize = 8000;
/// 서브모듈 gitlink mode
const GITLINK_MODE: u32 = 0o160000;
/// 심볼릭 링크 mode
const SYMLINK_MODE: u32 = 0o120000;

/// 3-way 편집기에 넘기는 한 파일의 모든 것 (CF-06)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPayload {
    pub file: ConflictFile,
    pub labels: SideLabels,
    /// 텍스트 충돌이면 각 쪽 내용. 없는 쪽(삭제·추가 충돌)은 `None`. 바이너리면 모두 `None`
    pub ours: Option<String>,
    pub base: Option<String>,
    pub theirs: Option<String>,
    /// 블록 문서 (텍스트 both-modified 만). 마커 크기 32 로 만든 `merge-file --zdiff3` 결과
    pub doc: Option<ConflictDoc>,
    /// 작업 트리 파일이 git 의 자동 병합 결과와 달라졌는지 (이어서/처음부터 선택, CF-07)
    pub worktree_modified: bool,
    /// 서브모듈 포인터 충돌이면 양쪽 commit 요약 (SUB-10)
    pub submodule_sides: Option<crate::submodule::SubmoduleSides>,
    /// 작업 트리 파일 내용 (텍스트일 때). 이어서 편집할 때 쓴다
    pub worktree: Option<String>,
    /// 블록 분류와 자동 결합 제안 (CF-15). `doc` 의 충돌 블록 순서
    pub auto: Vec<AutoSuggestion>,
}

/// 앞부분(`BINARY_PROBE` 바이트) 안에 NUL 이 있는지. 충돌 편집기와 파일 보기(FS-08)가 함께 쓰는
/// 바이너리 판정이다
pub(crate) fn has_nul_in_probe(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_PROBE)].contains(&0)
}

/// 편집기로 왕복할 수 없는 내용인지. 앞부분에 NUL 이 있거나 UTF-8 이 아니면 문자열로 바꾸는 순간
/// 바이트를 잃으므로 바이너리처럼 파일 단위 선택만 허용한다
fn looks_binary(bytes: &[u8]) -> bool {
    has_nul_in_probe(bytes) || std::str::from_utf8(bytes).is_err()
}

/// 스테이지 조합으로 충돌 종류를 가른다
fn kind_of(stages: &[Option<(u32, mgit_model::Oid)>; 3]) -> ConflictKind {
    match (
        stages[0].is_some(),
        stages[1].is_some(),
        stages[2].is_some(),
    ) {
        (true, true, true) => ConflictKind::BothModified,
        (false, true, true) => ConflictKind::BothAdded,
        (true, false, true) => ConflictKind::DeletedByUs,
        (true, true, false) => ConflictKind::DeletedByThem,
        (false, true, false) => ConflictKind::AddedByUs,
        (false, false, true) => ConflictKind::AddedByThem,
        _ => ConflictKind::BothDeleted,
    }
}

/// 옵션으로 오해될 수 없는 경로인지
fn check_path(path: &str) -> Result<(), CoreError> {
    if path.is_empty() || path.starts_with('-') || path.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_path(path)));
    }
    Ok(())
}

/// 편집기 저장(`resolve_file`)이 쓸 실제 경로. 작업 트리 밖을 가리키는 경로는 쓰기 전에 거부한다.
///
/// - 글자 검사: 절대 경로와 `..`·`.` 구성요소, `.git` 구성요소(ASCII 대소문자 무시)를 거부한다. git 은
///   `.git` 안의 경로를 추적하지 않아 충돌 파일일 수 없고, 거기에 쓰면 hook 으로 임의 명령이 돌 수 있다
/// - 실제 위치: 저장할 때 없는 상위 디렉터리를 만들기 때문에, 이미 있는 가장 가까운 조상 디렉터리를
///   정규화해 작업 트리 아래인지 본다 (경로 중간의 심볼릭 링크로 밖으로 나가는 경우)
///
/// 길이·이름 모양 같은 그 밖의 규칙은 두지 않는다 — git 이 알려 주는 충돌 경로는 그대로 통과해야 한다
fn save_target(work_tree: &Path, path: &str) -> Result<PathBuf, CoreError> {
    let outside = || {
        CoreError::Invalid(tr!(
            "작업 트리 밖의 경로에는 저장할 수 없습니다: {path:?}",
            "Cannot save to a path outside the working tree: {path:?}"
        ))
    };
    let rel = Path::new(path);
    let plain = rel
        .components()
        .all(|c| matches!(c, Component::Normal(name) if !is_dot_git(name)));
    if !plain {
        return Err(outside());
    }
    let full = work_tree.join(rel);
    let root = work_tree.canonicalize()?;
    let mut dir = full.parent();
    while let Some(d) = dir {
        match d.canonicalize() {
            Ok(real) => {
                let below = real.strip_prefix(&root).map_err(|_| outside())?;
                let in_git_dir = below
                    .components()
                    .any(|c| matches!(c, Component::Normal(name) if is_dot_git(name)));
                if in_git_dir {
                    return Err(outside());
                }
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => dir = d.parent(),
            Err(e) => return Err(CoreError::Io(e)),
        }
    }
    Ok(full)
}

impl Core {
    /// 충돌 파일 목록 (CF-06). 종류·바이너리·서브모듈 여부를 함께 준다
    pub async fn conflicts(&self, session: SessionId) -> Result<Vec<ConflictFile>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let entries = list_unmerged(runner, &s.info.work_tree).await?;
        let mut out = Vec::with_capacity(entries.len());
        for e in entries {
            let submodule = e
                .stages
                .iter()
                .flatten()
                .any(|(mode, _)| *mode == GITLINK_MODE);
            // 심볼릭 링크의 내용은 링크 대상 경로라 편집기로 다룰 수 없다
            let mut binary = e
                .stages
                .iter()
                .flatten()
                .any(|(mode, _)| *mode == SYMLINK_MODE);
            if !submodule && !binary {
                for (i, st) in e.stages.iter().enumerate() {
                    if st.is_some()
                        && let Ok(bytes) =
                            show_stage(runner, &s.info.work_tree, i as u8 + 1, &e.path).await
                        && looks_binary(&bytes)
                    {
                        binary = true;
                        break;
                    }
                }
            }
            out.push(ConflictFile {
                path: e.path.clone(),
                kind: kind_of(&e.stages),
                binary,
                submodule,
                stages: [
                    e.stages[0].map(|(_, o)| o),
                    e.stages[1].map(|(_, o)| o),
                    e.stages[2].map(|(_, o)| o),
                ],
            });
        }
        Ok(out)
    }

    /// 편집기 열 제목 (CF-13). 진행 중 작업에 따라 ours/theirs 의 뜻이 다르다
    pub async fn side_labels(&self, session: SessionId) -> Result<SideLabels, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let wt = &s.info.work_tree;
        let (head_branch, op) = {
            let st = s.state();
            (
                st.refs
                    .head
                    .branch()
                    .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string()),
                st.op.clone(),
            )
        };
        let head_label = head_branch.unwrap_or_else(|| "HEAD".to_string());
        let labels = match op {
            Some(InProgressOp::Merge { .. }) => SideLabels {
                ours: head_label,
                base: "base".into(),
                theirs: name_rev(runner, wt, "MERGE_HEAD")
                    .await
                    .unwrap_or_else(|| "MERGE_HEAD".into()),
            },
            Some(InProgressOp::Rebase {
                head_name, onto, ..
            }) => {
                let onto_name = match onto {
                    Some(o) => name_rev(runner, wt, &o.to_hex()).await,
                    None => None,
                }
                .unwrap_or_else(|| "onto".into());
                let mine = head_name
                    .map(|h| h.strip_prefix("refs/heads/").unwrap_or(&h).to_string())
                    .unwrap_or_else(|| "HEAD".into());
                let applying = commit_subject(runner, wt, "REBASE_HEAD")
                    .await
                    .map(|sub| format!(" — {sub}"))
                    .unwrap_or_default();
                SideLabels {
                    ours: tr!(
                        "{onto_name} (리베이스 대상, 현재 결과)",
                        "{onto_name} (rebase target, current result)"
                    ),
                    base: "base".into(),
                    theirs: tr!(
                        "{mine} (적용 중인 내 커밋{applying})",
                        "{mine} (my commit being applied{applying})"
                    ),
                }
            }
            Some(InProgressOp::CherryPick { head, .. }) => SideLabels {
                ours: head_label,
                base: "base".into(),
                theirs: commit_subject(runner, wt, &head.to_hex())
                    .await
                    .map(|sub| format!("cherry-pick: {sub}"))
                    .unwrap_or_else(|| "CHERRY_PICK_HEAD".into()),
            },
            Some(InProgressOp::Revert { head, .. }) => SideLabels {
                ours: head_label,
                base: "base".into(),
                theirs: commit_subject(runner, wt, &head.to_hex())
                    .await
                    .map(|sub| format!("revert: {sub}"))
                    .unwrap_or_else(|| "REVERT_HEAD".into()),
            },
            // stash pop 충돌 등 (진행 중 작업 파일 없음)
            _ => SideLabels {
                ours: head_label,
                base: "base".into(),
                theirs: "stash".into(),
            },
        };
        Ok(labels)
    }

    /// 한 파일의 3-way 자료 (CF-06·07). 텍스트 both-modified 만 블록 문서를 만든다
    pub async fn conflict_file(
        &self,
        session: SessionId,
        path: &str,
    ) -> Result<ConflictPayload, CoreError> {
        check_path(path)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let file = self
            .conflicts(session)
            .await?
            .into_iter()
            .find(|f| f.path == path)
            .ok_or_else(|| CoreError::Invalid(messages::not_a_conflict_file(path)))?;
        let labels = self.side_labels(session).await?;
        let mut payload = ConflictPayload {
            file: file.clone(),
            labels: labels.clone(),
            ours: None,
            base: None,
            theirs: None,
            doc: None,
            worktree_modified: false,
            worktree: None,
            submodule_sides: None,
            auto: Vec::new(),
        };
        if file.submodule {
            payload.submodule_sides = Some(self.submodule_sides(session, path, file.stages).await);
            return Ok(payload);
        }
        if file.binary {
            return Ok(payload);
        }
        let mut sides: [Option<String>; 3] = [None, None, None];
        for (i, st) in file.stages.iter().enumerate() {
            if st.is_some()
                && let Ok(b) = show_stage(runner, &s.info.work_tree, i as u8 + 1, path).await
            {
                sides[i] = Some(String::from_utf8_lossy(&b).into_owned());
            }
        }
        payload.base = sides[0].take();
        payload.ours = sides[1].take();
        payload.theirs = sides[2].take();
        let worktree_bytes = std::fs::read(s.info.work_tree.join(path)).ok();
        payload.worktree = worktree_bytes
            .as_ref()
            .map(|b| String::from_utf8_lossy(b).into_owned());

        if file.kind == ConflictKind::BothModified || file.kind == ConflictKind::BothAdded {
            let lab = [
                labels.ours.as_str(),
                labels.base.as_str(),
                labels.theirs.as_str(),
            ];
            let merged = merge_file_stages(
                runner,
                &s.info.work_tree,
                path,
                lab,
                EDITOR_MARKER_SIZE,
                MarkerStyle::Zdiff3,
            )
            .await?;
            payload.doc = Some(parse_markers(&merged, EDITOR_MARKER_SIZE as usize).map_err(
                |e| {
                    CoreError::Invalid(tr!(
                        "충돌 마커를 해석하지 못했습니다: {e}",
                        "Failed to parse markers: {e}"
                    ))
                },
            )?);
            payload.auto = payload.doc.as_ref().map(classify_doc).unwrap_or_default();
            // git 이 작업 트리에 써 둔 자동 병합 결과와 같으면 아직 손대지 않은 것이다
            if let Some(wt_bytes) = &worktree_bytes {
                let style = conflict_style(runner, &s.info.work_tree).await;
                let auto =
                    merge_file_stages(runner, &s.info.work_tree, path, lab, 7, style).await?;
                payload.worktree_modified = wt_bytes != &auto;
                if payload.worktree_modified {
                    // 라벨만 다를 수도 있다: 마커 라벨을 떼고 비교
                    let strip = |b: &[u8]| {
                        parse_markers(b, 7).ok().map(|d| {
                            mgit_merge::render(
                                &d,
                                &vec![mgit_merge::Resolution::Unresolved; d.conflict_count()],
                            )
                        })
                    };
                    if let (Some(a), Some(b)) = (strip(wt_bytes), strip(&auto)) {
                        let normalize = |v: Vec<u8>| {
                            String::from_utf8_lossy(&v)
                                .lines()
                                .map(|l| {
                                    if l.starts_with("<<<<<<<")
                                        || l.starts_with(">>>>>>>")
                                        || l.starts_with("|||||||")
                                    {
                                        l[..7].to_string()
                                    } else {
                                        l.to_string()
                                    }
                                })
                                .collect::<Vec<_>>()
                        };
                        payload.worktree_modified = normalize(a) != normalize(b);
                    }
                }
            } else {
                payload.worktree_modified = true;
            }
        }
        Ok(payload)
    }

    /// 편집 결과를 저장하고 stage 한다 (CF-10·23). 마커가 남아 있으면 `allow_conflict_markers` 가
    /// 아닌 한 거부한다 (마커가 내용인 fixture 등)
    pub async fn resolve_file(
        &self,
        session: SessionId,
        path: &str,
        content: &[u8],
        allow_conflict_markers: bool,
    ) -> Result<(), CoreError> {
        check_path(path)?;
        if !allow_conflict_markers && has_conflict_markers(content, 7) {
            return Err(CoreError::ConflictMarkers {
                files: vec![path.to_string()],
            });
        }
        let s = self.inner_arc().get(session)?;
        let full = save_target(&s.info.work_tree, path)?;
        let is_link = full
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink());
        let side_pick_only = self
            .conflicts(session)
            .await?
            .iter()
            .any(|f| f.path == path && f.binary);
        if is_link || side_pick_only {
            return Err(CoreError::Invalid(tr!(
                "편집기에서 저장할 수 없는 파일입니다. 사용할 쪽을 선택하세요: {path}",
                "This file cannot be saved from the editor. Choose a side: {path}"
            )));
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let stages = self.stage_oids(session, path).await;
        std::fs::write(&full, content)?;
        self.run_write(session, WriteSpec::new(["add", "--", path]))
            .await?;
        self.keep_resolution(session, path, stages).await;
        Ok(())
    }

    /// 한쪽을 통째로 택한다 (CF-11·12): `checkout --ours|--theirs` 뒤 `add`.
    /// 그쪽에 파일이 없는 충돌(삭제·추가)이면 `resolve_delete` 를 쓴다
    pub async fn resolve_side(
        &self,
        session: SessionId,
        path: &str,
        side: ConflictSide,
    ) -> Result<(), CoreError> {
        check_path(path)?;
        if self.resolve_gitlink_side(session, path, side).await? {
            return Ok(());
        }
        let stages = self.stage_oids(session, path).await;
        let flag = match side {
            ConflictSide::Ours => "--ours",
            ConflictSide::Theirs => "--theirs",
        };
        self.run_write(
            session,
            WriteSpec::new(["checkout", flag, "--", path]).skip_refresh(),
        )
        .await?;
        self.run_write(session, WriteSpec::new(["add", "--", path]))
            .await?;
        self.keep_resolution(session, path, stages).await;
        Ok(())
    }

    /// 서브모듈 포인터 충돌이면 고른 쪽의 commit 을 stage 하고 `true`. `checkout --theirs` 는 서브모듈을
    /// 옮기지 않아 `add` 가 지금 체크아웃된 commit 을 stage 해 버리므로 index 에 직접 쓴다 (SUB-10)
    async fn resolve_gitlink_side(
        &self,
        session: SessionId,
        path: &str,
        side: ConflictSide,
    ) -> Result<bool, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let entries = list_unmerged(inner.runner(), &s.info.work_tree).await?;
        let Some(entry) = entries.iter().find(|e| e.path == path) else {
            return Ok(false);
        };
        let is_gitlink =
            |st: &Option<(u32, mgit_model::Oid)>| st.is_some_and(|(mode, _)| mode == GITLINK_MODE);
        if !entry.stages.iter().any(is_gitlink) {
            return Ok(false);
        }
        let chosen = match side {
            ConflictSide::Ours => entry.stages[1],
            ConflictSide::Theirs => entry.stages[2],
        };
        let Some((mode, oid)) = chosen else {
            return Err(CoreError::Invalid(tr!(
                "선택한 쪽에 서브모듈이 없습니다: {path}",
                "The chosen side has no submodule: {path}"
            )));
        };
        let info = format!("{mode:o},{},{path}", oid.to_hex());
        self.run_write(
            session,
            WriteSpec::new(["update-index", "--cacheinfo", &info]),
        )
        .await?;
        Ok(true)
    }

    /// 삭제 충돌 해결 (CF-11): `keep` 이면 남아 있는 쪽을 stage, 아니면 `git rm`
    pub async fn resolve_delete(
        &self,
        session: SessionId,
        path: &str,
        keep: bool,
    ) -> Result<(), CoreError> {
        check_path(path)?;
        let s = self.inner_arc().get(session)?;
        if keep {
            // 작업 트리에 없으면 남아 있는 스테이지에서 되살린다
            if !s.info.work_tree.join(path).exists() {
                let file = self
                    .conflicts(session)
                    .await?
                    .into_iter()
                    .find(|f| f.path == path)
                    .ok_or_else(|| CoreError::Invalid(messages::not_a_conflict_file(path)))?;
                let flag = if file.stages[1].is_some() {
                    "--ours"
                } else {
                    "--theirs"
                };
                self.run_write(
                    session,
                    WriteSpec::new(["checkout", flag, "--", path]).skip_refresh(),
                )
                .await?;
            }
            self.run_write(session, WriteSpec::new(["add", "--", path]))
                .await?;
        } else {
            self.run_write(session, WriteSpec::new(["rm", "-q", "--", path]))
                .await?;
        }
        Ok(())
    }

    /// 해결한 파일을 다시 충돌 상태로 (CF-26). `rerere forget` 은 실패해도 무시한다
    pub async fn unresolve(
        &self,
        session: SessionId,
        path: &str,
        mode: UnresolveMode,
    ) -> Result<(), CoreError> {
        check_path(path)?;
        match mode {
            UnresolveMode::Remake => {
                self.run_write(session, WriteSpec::new(["checkout", "-m", "--", path]))
                    .await?;
            }
            UnresolveMode::KeepWorktree => {
                self.run_write(
                    session,
                    WriteSpec::new(["update-index", "--unresolve", "--", path]),
                )
                .await?;
            }
        }
        let _ = self
            .run_write(
                session,
                WriteSpec::new(["rerere", "forget", "--", path]).skip_refresh(),
            )
            .await;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 작업 트리 안의 경로는 그대로 통과한다: 아직 없는 상위 디렉터리, 긴 이름(길이 규칙 없음), 공백·한글,
    /// `.git` 과 닮았지만 다른 이름. 확인만 하고 디렉터리를 만들지 않는다
    #[test]
    fn save_target_accepts_paths_inside_the_work_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let long = "가".repeat(100);
        for path in [
            "a.txt",
            "src/b.txt",
            "new/deep/c.txt",
            "src/한글 이름.txt",
            long.as_str(),
            ".gitignore",
            "x.git/y",
        ] {
            assert_eq!(save_target(root, path).unwrap(), root.join(path), "{path}");
        }
        assert!(!root.join("new").exists());
    }

    /// 작업 트리 밖을 가리키는 글자 모양은 파일 시스템을 보기 전에 거부한다
    #[test]
    fn save_target_rejects_escaping_shapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for path in [
            "../up.txt",
            "a/../../up.txt",
            "/etc/passwd",
            ".git/config",
            ".GIT/hooks/pre-commit",
            "a/.git/config",
            "./a.txt",
        ] {
            assert!(
                matches!(save_target(root, path), Err(CoreError::Invalid(_))),
                "{path}"
            );
        }
    }
}
