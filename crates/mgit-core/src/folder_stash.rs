//! 폴더 일괄 stash (저장·꺼내기). 한 번의 일괄 저장으로 만든 항목들을 같은 **묶음**으로 묶는다: stash 메시지 끝에 묶음
//! 표시 `[mgit-batch:<id>]` 를 붙이고, 꺼낼 때는 저장소마다 stash 목록에서 그 표시로 항목을 다시 찾는다 — 그사이 다른
//! stash 가 위에 쌓여 인덱스가 밀려도, 앱을 다시 켜 작업 기록이 사라져도 찾을 수 있다.
//!
//! 연결된 워크트리는 주 작업 트리와 stash 목록(`refs/stash`)을 함께 쓴다. 같은 묶음에서 두 작업 트리가 만든 항목을 서로
//! 꺼내지 않게, 연결된 워크트리의 표시에는 그 워크트리 이름(`.git/worktrees/<이름>`)을 붙인다 (`[mgit-batch:<id>@<이름>]`)

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::cmd::{Discovered, discover, list_stashes, list_unmerged};
use mgit_l10n::{pick, tr};
use mgit_model::{FoundRepo, GitRunner, StashInfo, WorkTreeStatus};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::SessionId;
use crate::folder::repo_name;
use crate::folder_batch::{RepoResult, read_out, reason, run_git, strs};
use crate::messages;

/// 묶음 표시의 앞부분 (`[mgit-batch:<id>]`)
const TAG_OPEN: &str = "[mgit-batch:";
/// 묶음 id 의 최대 길이
const BATCH_ID_MAX: usize = 40;
/// 묶음 목록을 읽는 동시 저장소 수
const LIST_CONCURRENCY: usize = 8;
/// 충돌 안내에 적는 파일 수의 상한 (넘는 것은 "외 N개")
const CONFLICT_FILES_SHOWN: usize = 5;

/// 일괄 stash 저장 한 번의 값 (`BatchOp::StashPush`)
pub(crate) struct StashSave<'a> {
    /// 묶음 id (검사를 마친 값)
    pub batch: &'a str,
    /// 사용자 메시지 (없으면 묶음 표시만)
    pub message: Option<&'a str>,
    /// 미추적 파일도 넣는다 (`--include-untracked`)
    pub include_untracked: bool,
}

/// 묶음 id 인지: 영문자·숫자·`-`·`_` 만으로 1~40자 (메시지 안의 표시를 다시 읽을 수 있게 `@`·`]` 를 막는다)
fn is_batch_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= BATCH_ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 묶음 id 검사 (`BatchOp::validate`)
pub(crate) fn validate_batch_id(id: &str) -> Result<(), CoreError> {
    if is_batch_id(id) {
        Ok(())
    } else {
        Err(CoreError::Invalid(messages::bad_value(id)))
    }
}

/// 사용자 메시지를 한 줄로: 줄바꿈 등 제어 문자는 공백으로 바꾸고 앞뒤 공백을 뺀다 (stash 제목은 한 줄이다)
pub(crate) fn one_line(message: &str) -> String {
    message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 이 작업 트리를 묶음 표시에서 가리키는 이름: 주 작업 트리(와 서브모듈)는 없음, 연결된 워크트리는
/// `.git/worktrees/<이름>` 의 이름. 워크트리를 옮겨도(`git worktree move`) 이름은 그대로다
fn worktree_key(d: &Discovered) -> Option<String> {
    if d.git_dir == d.common_dir {
        return None;
    }
    d.git_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

/// 묶음 표시 (`[mgit-batch:<id>]`, 연결된 워크트리면 `[mgit-batch:<id>@<이름>]`)
fn batch_tag(batch: &str, worktree: Option<&str>) -> String {
    match worktree {
        Some(name) => format!("{TAG_OPEN}{batch}@{name}]"),
        None => format!("{TAG_OPEN}{batch}]"),
    }
}

/// stash 메시지: 한 줄로 다듬은 사용자 메시지 끝에 묶음 표시를 붙인다 (메시지가 없으면 표시만)
pub(crate) fn tagged_message(message: Option<&str>, tag: &str) -> String {
    let text = one_line(message.unwrap_or_default());
    if text.is_empty() {
        tag.to_string()
    } else {
        format!("{text} {tag}")
    }
}

/// stash 제목(`On <branch>: <메시지>`)의 묶음 표시를 읽는다: (묶음 id, 연결된 워크트리 이름). 표시는 제목 끝에 있어야
/// 한다 — 사용자가 메시지 중간에 비슷한 글자를 적어도 앱이 끝에 붙인 것만 본다
pub(crate) fn parse_tag(subject: &str) -> Option<(&str, Option<&str>)> {
    let body = subject.trim_end().strip_suffix(']')?;
    let start = body.rfind(TAG_OPEN)? + TAG_OPEN.len();
    let inner = &body[start..];
    let (id, worktree) = match inner.split_once('@') {
        Some((id, name)) => (id, Some(name)),
        None => (inner, None),
    };
    (is_batch_id(id) && worktree.is_none_or(|name| !name.is_empty())).then_some((id, worktree))
}

/// 제목에서 사용자 메시지만: `On <branch>: ` 머리와 끝의 묶음 표시를 뺀다 (없으면 빈 문자열)
fn note_of(subject: &str) -> String {
    let body = subject
        .strip_prefix("On ")
        .and_then(|rest| rest.split_once(": "))
        .map_or(subject, |(_, message)| message)
        .trim_end();
    body.rfind(TAG_OPEN)
        .map_or(body, |at| &body[..at])
        .trim()
        .to_string()
}

/// 이 작업 트리의 stash 목록에서 그 묶음의 항목: 가장 최근 것 (인덱스가 가장 작은 것)
fn entry_of<'a>(
    stashes: &'a [StashInfo],
    batch: &str,
    worktree: Option<&str>,
) -> Option<&'a StashInfo> {
    stashes
        .iter()
        .find(|s| parse_tag(&s.message) == Some((batch, worktree)))
}

/// 지금 `refs/stash` 가 가리키는 항목 (없으면 None)
async fn stash_top(runner: &dyn GitRunner, work_tree: &Path) -> Option<String> {
    read_out(
        runner,
        work_tree,
        &["rev-parse", "--verify", "--quiet", "refs/stash"],
    )
    .await
}

/// 충돌이 남은 파일 (읽지 못하면 빈 목록)
async fn conflicted_paths(runner: &dyn GitRunner, work_tree: &Path) -> Vec<String> {
    let mut paths: Vec<String> = list_unmerged(runner, work_tree)
        .await
        .map(|entries| entries.into_iter().map(|e| e.path).collect())
        .unwrap_or_default();
    paths.dedup();
    paths
}

/// 건너뜀·실패 사유 (지금 언어)
mod why {
    use mgit_l10n::{pick, tr};

    /// 저장할 변경이 없다
    pub(super) fn no_changes() -> &'static str {
        pick("스태시할 변경이 없습니다", "No changes to stash")
    }

    /// 미추적 파일만 있는데 넣지 않기로 했다
    pub(super) fn untracked_only() -> &'static str {
        pick(
            "미추적 파일만 있습니다 (미추적 파일 포함을 켜면 저장합니다)",
            "Only untracked files (turn on Include untracked files to stash them)",
        )
    }

    /// 아직 commit 이 없어 stash 를 만들 수 없다
    pub(super) fn no_commits() -> &'static str {
        pick("아직 커밋이 없습니다", "No commits yet")
    }

    /// 그 묶음의 항목이 이 작업 트리에 없다
    pub(super) fn no_batch_stash() -> &'static str {
        pick("이 묶음의 스태시가 없습니다", "No stash from this batch")
    }

    /// 적용했는데 충돌이 났다. git 의 pop 처럼 항목은 남긴다
    pub(super) fn conflict_kept(files: &[String]) -> String {
        let shown = files
            .iter()
            .take(super::CONFLICT_FILES_SHOWN)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let more = files.len().saturating_sub(super::CONFLICT_FILES_SHOWN);
        let list = if more > 0 {
            tr!("{shown} 외 {more}개", "{shown} and {more} more")
        } else {
            shown
        };
        tr!(
            "충돌이 났습니다: {list}. 스태시 항목은 지우지 않고 남겼습니다 — 저장소를 열어 충돌을 해결한 뒤 그 항목을 지우세요",
            "Conflicts: {list}. The stash entry was kept — open the repository, resolve the conflicts, then drop it"
        )
    }

    /// 적용했지만 항목을 지우지 못했다 (같은 항목이 남아 있다)
    pub(super) fn applied_not_dropped(error: &str) -> String {
        tr!(
            "스태시를 적용했지만 항목을 지우지 못했습니다: {error}",
            "Applied the stash but could not drop the entry: {error}"
        )
    }
}

/// 일괄 stash 저장 한 저장소. 호출자(`run_batch_one`)가 그 저장소의 쓰기 잠금을 쥐고 있다.
/// 진행 중 작업·충돌이 있으면, 아직 commit 이 없으면, 저장할 변경이 없으면(미추적 파일만 있고 넣지 않을 때 포함) 건너뛴다.
/// "저장할 변경" 은 일괄 pull·checkout 이 "커밋하지 않은 변경" 으로 보는 것(stage·작업 트리 변경)과 같고, 미추적 파일은
/// `include_untracked` 일 때만 더한다. git 은 저장할 것이 없어도 성공으로 끝나므로 전후 `refs/stash` 를 비교해 항목이
/// 생겼는지 본다. 만든 항목의 작업 트리는 단일 저장처럼 store 에 남긴다 (Stash 탭이 다른 워크트리의 것을 알아본다)
pub(crate) async fn push_one(
    inner: &Arc<CoreInner>,
    d: &Discovered,
    status: &WorkTreeStatus,
    in_op: bool,
    save: &StashSave<'_>,
    mut r: RepoResult,
) -> RepoResult {
    let sum = status.summary();
    if in_op || sum.conflicted > 0 {
        r.skip(reason::in_progress());
        return r;
    }
    if status.branch.oid.is_none() {
        r.skip(why::no_commits());
        return r;
    }
    let tracked = sum.staged + sum.unstaged > 0;
    let untracked = save.include_untracked && sum.untracked > 0;
    if !tracked && !untracked {
        r.skip(if sum.untracked > 0 {
            why::untracked_only()
        } else {
            why::no_changes()
        });
        return r;
    }
    let runner = inner.runner();
    let before = stash_top(runner, &d.work_tree).await;
    let tag = batch_tag(save.batch, worktree_key(d).as_deref());
    let mut args = strs(&["stash", "push"]);
    if save.include_untracked {
        args.push("--include-untracked".into());
    }
    args.push("-m".into());
    args.push(tagged_message(save.message, &tag));
    let (ok, msg) = run_git(inner, &d.work_tree, &args, false).await;
    r.message = msg;
    if !ok {
        return r;
    }
    match stash_top(runner, &d.work_tree).await {
        Some(top) if Some(&top) != before.as_ref() => {
            r.ok = true;
            if let Ok(oid) = mgit_model::Oid::from_hex(top.as_bytes()) {
                let _ = inner
                    .store
                    .stash_origin_set(&d.common_dir, &oid, &d.work_tree);
            }
        }
        _ => r.skip(why::no_changes()),
    }
    r
}

/// 일괄 stash 꺼내기 한 저장소. 호출자(`run_batch_one`)가 그 저장소의 쓰기 잠금을 쥐고 있다.
/// 진행 중 작업·충돌이 있으면 건너뛴다. 이 작업 트리의 stash 목록에서 묶음 표시로 항목을 찾아(맨 위가 아니어도 된다) oid 로
/// `stash apply` 하고, 성공하면 인덱스를 다시 찾아 `stash drop` 한다 (= pop. `pop`·`drop` 은 `stash@{n}` 만 받는다).
/// 적용에 실패하면 git 의 pop 처럼 항목을 남기고 실패로 알린다 — 충돌이면 그 파일과 할 일을 적는다. 그 묶음의 항목이
/// 없으면 건너뛴다
pub(crate) async fn pop_one(
    inner: &Arc<CoreInner>,
    d: &Discovered,
    status: &WorkTreeStatus,
    in_op: bool,
    batch: &str,
    mut r: RepoResult,
) -> RepoResult {
    if in_op || status.summary().conflicted > 0 {
        r.skip(reason::in_progress());
        return r;
    }
    let runner = inner.runner();
    let stashes = if status.stash_count == 0 {
        Vec::new()
    } else {
        match list_stashes(runner, &d.work_tree).await {
            Ok(list) => list,
            Err(e) => {
                r.message = mgit_model::redact_text(&e.to_string());
                return r;
            }
        }
    };
    let key = worktree_key(d);
    let Some(entry) = entry_of(&stashes, batch, key.as_deref()) else {
        r.skip(why::no_batch_stash());
        return r;
    };
    let oid = entry.oid.to_hex();
    let (ok, msg) = run_git(
        inner,
        &d.work_tree,
        &strs(&["stash", "apply", "--quiet", &oid]),
        false,
    )
    .await;
    if !ok {
        let conflicts = conflicted_paths(runner, &d.work_tree).await;
        r.message = if conflicts.is_empty() {
            msg
        } else {
            why::conflict_kept(&conflicts)
        };
        return r;
    }
    // 적용하는 동안 목록이 바뀌었어도 이 항목만 지우게 oid 로 인덱스를 다시 찾는다 (이미 없으면 지울 것이 없다)
    let index = match list_stashes(runner, &d.work_tree).await {
        Ok(list) => list.iter().find(|s| s.oid == entry.oid).map(|s| s.index),
        Err(e) => {
            r.message = why::applied_not_dropped(&mgit_model::redact_text(&e.to_string()));
            return r;
        }
    };
    if let Some(index) = index {
        let selector = format!("stash@{{{index}}}");
        let (ok, msg) = run_git(
            inner,
            &d.work_tree,
            &strs(&["stash", "drop", "--quiet", &selector]),
            false,
        )
        .await;
        if !ok {
            r.message = why::applied_not_dropped(&msg);
            return r;
        }
    }
    r.ok = true;
    r.message = entry.message.clone();
    r
}

/// 일괄 stash 묶음에서 저장소 하나의 항목
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashBatchRepo {
    pub path: PathBuf,
    pub name: String,
    /// 지금 `stash@{n}` 의 n. 다른 stash 가 쌓이면 밀리므로 꺼낼 때는 묶음 표시로 다시 찾는다
    pub index: u32,
    /// 저장할 때의 branch (분리 HEAD 면 None)
    pub branch: Option<String>,
    /// 만든 시각 (epoch 초)
    pub time: i64,
}

/// 저장소들의 stash 목록에서 모은 일괄 stash 묶음 하나
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashBatch {
    /// 묶음 id (`BatchOp::StashPop` 에 넘긴다)
    pub id: String,
    /// 사용자 메시지 (묶음 표시를 뺀 것). 없으면 빈 문자열
    pub message: String,
    /// 가장 최근 항목의 시각 (epoch 초)
    pub time: i64,
    /// 그 묶음의 항목이 남은 저장소 (경로순)
    pub repos: Vec<StashBatchRepo>,
}

/// 저장소 하나의 stash 목록을 묶음별로 모은다. 그 작업 트리의 항목만, 묶음마다 가장 최근 항목 하나만 (꺼내기도 그것을
/// 꺼낸다). 묶음의 메시지·시각은 가장 최근 항목의 것이다
fn collect(
    batches: &mut BTreeMap<String, StashBatch>,
    path: &Path,
    worktree: Option<&str>,
    stashes: &[StashInfo],
) {
    let mut seen: HashSet<&str> = HashSet::new();
    for s in stashes {
        let Some((id, owner)) = parse_tag(&s.message) else {
            continue;
        };
        if owner != worktree || !seen.insert(id) {
            continue;
        }
        let batch = batches.entry(id.to_string()).or_insert_with(|| StashBatch {
            id: id.to_string(),
            message: String::new(),
            time: i64::MIN,
            repos: Vec::new(),
        });
        if s.time >= batch.time {
            batch.time = s.time;
            batch.message = note_of(&s.message);
        }
        batch.repos.push(StashBatchRepo {
            path: path.to_path_buf(),
            name: repo_name(path),
            index: s.index,
            branch: s.branch.clone(),
            time: s.time,
        });
    }
}

impl Core {
    /// 폴더 저장소들의 stash 목록에서 일괄 stash 묶음을 모은다 (최근 묶음부터). `repos` 가 비어 있으면 전부, 아니면 그
    /// 저장소만 읽고 목록에 없는 경로는 거부한다. 저장소마다 그 작업 트리가 만든 항목만 센다 (워크트리는 목록을 함께 쓴다).
    /// 읽지 못한 저장소는 결과에 없다. 작업 기록과 상관없이 저장소에서 다시 읽으므로 앱을 다시 켜도 꺼낼 묶음을 찾는다
    pub async fn folder_stash_batches(
        &self,
        session: SessionId,
        repos: &[PathBuf],
    ) -> Result<Vec<StashBatch>, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let sem = Arc::new(Semaphore::new(LIST_CONCURRENCY));
        let mut set = JoinSet::new();
        for found in folder.select(repos)?.into_iter().map(|r| r.found) {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            set.spawn(async move {
                let _permit = sem.acquire().await;
                let runner = inner.runner();
                let d = discover(runner, &found.path).await.ok()?;
                let stashes = list_stashes(runner, &d.work_tree).await.ok()?;
                Some((found.path, worktree_key(&d), stashes))
            });
        }
        let mut batches: BTreeMap<String, StashBatch> = BTreeMap::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(Some((path, key, stashes))) = joined {
                collect(&mut batches, &path, key.as_deref(), &stashes);
            }
        }
        let mut out: Vec<StashBatch> = batches.into_values().collect();
        for batch in &mut out {
            batch.repos.sort_by(|a, b| a.path.cmp(&b.path));
        }
        out.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }
}

/// 일괄 stash 저장의 진행 라벨 (`BatchOp::label`)
pub(crate) fn push_label(message: Option<&str>) -> String {
    match message.map(one_line).filter(|m| !m.is_empty()) {
        Some(m) => tr!("스태시 일괄 저장: {m}", "Batch stash: {m}"),
        None => pick("스태시 일괄 저장", "Batch stash").into(),
    }
}

/// 일괄 stash 꺼내기의 진행 라벨 (`BatchOp::label`): 묶음 id 로. 저장할 때의 메시지를 모를 때 쓴다
pub(crate) fn pop_label(batch: &str) -> String {
    tr!("스태시 일괄 꺼내기 ({batch})", "Batch stash pop ({batch})")
}

/// 꺼내기 라벨의 메시지를 찾을 때 stash 목록을 읽는 대상 저장소 수의 상한. 화면에서 고른 대상은 모두 그 묶음이 있는
/// 저장소라 보통 첫 저장소에서 찾는다 — 묶음이 사라진 저장소가 앞에 몰려도 시작이 늦어지지 않게 막는다
const POP_LABEL_LOOKUPS: usize = 3;

/// 일괄 stash 꺼내기의 진행·결과 라벨: 대상 저장소의 stash 목록에서 그 묶음 항목을 찾아, 저장할 때 적은 메시지가 있으면
/// `스태시 일괄 꺼내기: <메시지>` 로 짓는다 (`스태시 일괄 저장: <메시지>` 와 짝). 앞쪽 몇 저장소(`POP_LABEL_LOOKUPS`)만 보고,
/// 못 찾거나 메시지가 없거나 목록을 읽지 못하면 묶음 id 라벨(`pop_label`)이다. 한 번의 저장에서는 모든 저장소의 메시지가
/// 같아 어느 작업 트리의 항목이든 쓴다 (다시 실행에서 메시지를 고쳤으면 앞쪽 저장소에서 먼저 찾은 것)
pub(crate) async fn pop_label_in(
    runner: &dyn GitRunner,
    repos: &[FoundRepo],
    batch: &str,
) -> String {
    for repo in repos.iter().take(POP_LABEL_LOOKUPS) {
        let Ok(stashes) = list_stashes(runner, &repo.path).await else {
            continue;
        };
        let found = stashes
            .iter()
            .find(|s| parse_tag(&s.message).is_some_and(|(id, _)| id == batch));
        if let Some(entry) = found {
            let note = note_of(&entry.message);
            if note.is_empty() {
                break;
            }
            return tr!("스태시 일괄 꺼내기: {note}", "Batch stash pop: {note}");
        }
    }
    pop_label(batch)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn batch_id_rules() {
        assert!(is_batch_id("mi8x2k3a7f"));
        assert!(is_batch_id("a-b_C9"));
        assert!(!is_batch_id(""));
        assert!(!is_batch_id("a@b"));
        assert!(!is_batch_id("a]b"));
        assert!(!is_batch_id("a b"));
        assert!(!is_batch_id(&"x".repeat(BATCH_ID_MAX + 1)));
        assert!(validate_batch_id("ok1").is_ok());
        assert!(validate_batch_id("bad id").is_err());
    }

    #[test]
    fn message_is_one_line_with_tag_at_end() {
        let tag = batch_tag("b1", None);
        assert_eq!(tag, "[mgit-batch:b1]");
        assert_eq!(tagged_message(None, &tag), "[mgit-batch:b1]");
        assert_eq!(tagged_message(Some("  "), &tag), "[mgit-batch:b1]");
        assert_eq!(
            tagged_message(Some(" 작업\n정리 "), &tag),
            "작업 정리 [mgit-batch:b1]"
        );
        assert_eq!(batch_tag("b1", Some("wt-a")), "[mgit-batch:b1@wt-a]");
    }

    #[test]
    fn parses_tag_only_at_end() {
        assert_eq!(
            parse_tag("On main: 작업 [mgit-batch:b1]"),
            Some(("b1", None))
        );
        assert_eq!(
            parse_tag("On (no branch): [mgit-batch:b1@wt@x]"),
            Some(("b1", Some("wt@x")))
        );
        // 사용자가 메시지에 적은 비슷한 글자보다 끝의 표시가 이긴다
        assert_eq!(
            parse_tag("On main: [mgit-batch:fake] 정리 [mgit-batch:real]"),
            Some(("real", None))
        );
        assert_eq!(parse_tag("On main: [mgit-batch:b1] 뒤에 글자"), None);
        assert_eq!(parse_tag("WIP on main: abc subject"), None);
        assert_eq!(parse_tag("On main: [mgit-batch:]"), None);
        assert_eq!(parse_tag("On main: [mgit-batch:b1@]"), None);
    }

    #[test]
    fn note_drops_branch_head_and_tag() {
        assert_eq!(note_of("On main: 작업 정리 [mgit-batch:b1]"), "작업 정리");
        assert_eq!(note_of("On feat/x: [mgit-batch:b1]"), "");
        assert_eq!(note_of("custom [mgit-batch:b1]"), "custom");
    }

    /// 목록 항목 하나
    fn info(index: u32, message: &str, time: i64) -> StashInfo {
        StashInfo {
            index,
            oid: mgit_model::Oid::from_hex(format!("{index:040x}").as_bytes()).unwrap(),
            base: None,
            message: message.into(),
            time,
            includes_untracked: false,
            branch: StashInfo::branch_from_message(message),
        }
    }

    #[test]
    fn entry_and_collect_respect_worktree_and_latest() {
        let list = vec![
            info(0, "On wt: 다른 워크트리 [mgit-batch:b1@wt]", 30),
            info(1, "On main: 나중 [mgit-batch:b1]", 20),
            info(2, "On main: 손으로 만든 것", 15),
            info(3, "On main: 처음 [mgit-batch:b1]", 10),
            info(4, "On main: 다른 묶음 [mgit-batch:b2]", 5),
        ];
        assert_eq!(entry_of(&list, "b1", None).map(|s| s.index), Some(1));
        assert_eq!(entry_of(&list, "b1", Some("wt")).map(|s| s.index), Some(0));
        assert_eq!(entry_of(&list, "b3", None), None);

        let mut batches = BTreeMap::new();
        collect(&mut batches, Path::new("/f/a"), None, &list);
        let b1 = &batches["b1"];
        assert_eq!(b1.message, "나중");
        assert_eq!(b1.time, 20);
        assert_eq!(b1.repos.len(), 1);
        assert_eq!(b1.repos[0].index, 1);
        assert_eq!(b1.repos[0].branch.as_deref(), Some("main"));
        assert_eq!(batches["b2"].repos[0].index, 4);
        // 같은 목록을 워크트리 쪽에서 읽으면 자기 항목만
        collect(&mut batches, Path::new("/f/wt"), Some("wt"), &list);
        let b1 = &batches["b1"];
        assert_eq!(b1.repos.len(), 2);
        assert_eq!(b1.time, 30);
        assert_eq!(b1.message, "다른 워크트리");
        assert_eq!(batches["b2"].repos.len(), 1);
    }
}
