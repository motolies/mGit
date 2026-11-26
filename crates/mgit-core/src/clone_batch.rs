//! 여러 저장소 한꺼번에 clone. 상위 폴더 하나 아래에 URL 마다 폴더를 만들어 clone 한다.
//!
//! 단일 clone(`clone_repo`)과 같은 인자(`clone_args`)·환경(`Network`, 자격 증명 대화상자)·명령 기록을 쓰고, 진행·취소는
//! 단일 clone 처럼 세션 0 의 operation 이벤트와 `cancel_operation` 으로 한다. 결과는 일괄 작업과 같은 `BatchResult` 라
//! 프런트의 결과 알림·작업 기록·"실패만 다시 실행" 을 그대로 쓴다.
//!
//! 대상 폴더는 clone 직전에 직접 만든다(`create_dir` — 이미 있으면 실패하므로 원자적으로 "이번 실행이 만든 폴더" 임을
//! 안다). 이미 있으면 건너뛰고, clone 이 실패하거나 취소되면 이번에 만든 폴더만 지운다. 이미 있던 폴더는 건드리지 않는다.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mgit_l10n::{pick, tr};
use mgit_model::{CancelToken, CloneSpec, EnvProfile, GitError, GitRequest, redact_text};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::{CoreEvent, EventSink, SessionId};
use crate::folder_batch::{BatchResult, RepoResult};
use crate::repo_ops::{check_arg, clone_args};

/// 기본 동시 clone 수 (자격 증명 대화상자는 프런트가 하나씩 띄우지만 같은 호스트를 여러 번 묻지 않게 낮게 둔다)
pub const CLONE_CONCURRENCY_DEFAULT: u32 = 2;
/// 동시 clone 수의 상한
const CLONE_CONCURRENCY_MAX: u32 = 4;
/// 한 번에 받는 대상 수의 상한
const CLONE_TARGETS_MAX: usize = 200;
/// 실패·취소 뒤 만든 폴더를 지울 때 다시 시도하는 횟수와 간격 (끝나 가는 자식 프로세스가 아직 쓰고 있을 수 있다)
const REMOVE_ATTEMPTS: u32 = 5;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(100);

/// clone 할 저장소 하나: URL 과 상위 폴더 아래에 만들 폴더 이름
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneTarget {
    pub url: String,
    pub name: String,
}

/// 여러 저장소 clone 요청. 경량 복제·서브모듈 옵션은 모든 대상에 같게 건다 (브랜치는 저장소마다 달라 받지 않는다)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneBatch {
    /// 대상 폴더들을 만들 상위 폴더 (있어야 한다)
    pub parent: PathBuf,
    pub targets: Vec<CloneTarget>,
    pub recurse_submodules: bool,
    pub depth: Option<u32>,
    pub blobless: bool,
    pub single_branch: bool,
    /// 동시 clone 수 (1~4 로 자른다)
    pub concurrency: u32,
}

/// 폴더 이름 하나가 상위 폴더 바로 아래의 이름인지: 비지 않았고 `.`·`..` 가 아니며 경로 구분자·NUL 이 없다
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// 요청 검사: 상위 폴더가 있고, 대상이 있고(상한 안), URL 이 옵션으로 오해되지 않으며, 폴더 이름이 바르고 겹치지 않는다
fn validate(batch: &CloneBatch) -> Result<(), CoreError> {
    let invalid = |msg: String| Err(CoreError::Invalid(msg));
    if !batch.parent.is_dir() {
        return invalid(tr!(
            "복제할 상위 폴더가 없습니다: {}",
            "The parent folder does not exist: {}",
            batch.parent.display()
        ));
    }
    if batch.targets.is_empty() {
        return invalid(pick("복제할 저장소가 없습니다", "No repositories to clone").into());
    }
    if batch.targets.len() > CLONE_TARGETS_MAX {
        return invalid(tr!(
            "한 번에 {CLONE_TARGETS_MAX}개까지 복제할 수 있습니다",
            "You can clone at most {CLONE_TARGETS_MAX} repositories at once"
        ));
    }
    let mut names = HashSet::new();
    for target in &batch.targets {
        check_arg(&target.url)?;
        if !valid_name(&target.name) {
            return invalid(tr!(
                "쓸 수 없는 폴더 이름입니다: {}",
                "Invalid folder name: {}",
                target.name
            ));
        }
        if !names.insert(target.name.as_str()) {
            return invalid(tr!(
                "같은 폴더 이름이 두 번 있습니다: {}",
                "The same folder name appears twice: {}",
                target.name
            ));
        }
    }
    Ok(())
}

/// 이번 실행이 만든 대상 폴더를 지운다 (실패·취소 뒤). 끝나 가는 자식 프로세스가 아직 쓰고 있으면 잠시 뒤 다시 한다.
/// 지우지 못했으면 사유를 돌려준다
async fn remove_created(dest: &Path) -> Option<String> {
    let mut last = None;
    for _ in 0..REMOVE_ATTEMPTS {
        match std::fs::remove_dir_all(dest) {
            Ok(()) => return None,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => last = Some(e.to_string()),
        }
        tokio::time::sleep(REMOVE_RETRY_DELAY).await;
    }
    last.map(|e| {
        tr!(
            "만들던 폴더를 지우지 못했습니다: {e}",
            "Couldn't remove the partial folder: {e}"
        )
    })
}

/// 저장소 하나를 clone 한다. 대상 폴더를 먼저 만들어(이미 있으면 건너뜀) 그 안에 clone 하고, 실패하거나 취소되면 그
/// 폴더를 지운다. 결과 줄의 경로는 대상 폴더다
async fn clone_one(
    inner: Arc<CoreInner>,
    batch: Arc<CloneBatch>,
    target: CloneTarget,
    cancel: CancelToken,
) -> RepoResult {
    let dest = batch.parent.join(&target.name);
    let mut r = RepoResult::new(dest.clone());
    if cancel.is_cancelled() {
        r.cancel();
        return r;
    }
    match std::fs::create_dir(&dest) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            r.skip(pick("이미 있는 폴더입니다", "The folder already exists"));
            return r;
        }
        Err(e) => {
            r.message = e.to_string();
            return r;
        }
    }
    let spec = CloneSpec {
        url: target.url.clone(),
        dest: dest.clone(),
        branch: None,
        recurse_submodules: batch.recurse_submodules,
        depth: batch.depth,
        blobless: batch.blobless,
        single_branch: batch.single_branch,
    };
    let args = match clone_args(&spec) {
        Ok(args) => args,
        Err(e) => {
            r.message = e.to_string();
            if let Some(why) = remove_created(&dest).await {
                r.message = format!("{}\n{why}", r.message);
            }
            return r;
        }
    };
    let tag = inner.auth_tag();
    let mut req = GitRequest::new(&batch.parent, args)
        .with_env(EnvProfile::Network)
        .with_env_var(mgit_helper::ENV_TAG, &tag)
        .with_cancel(cancel);
    for (k, v) in &inner.cfg.git_config_overrides {
        req = req.with_config(k, v);
    }
    let result = inner.runner().run(req).await;
    let failed_stderr = match &result {
        Ok(out) if !out.exit.success() => out.exit.stderr.as_str(),
        _ => "",
    };
    inner.report_auth(&tag, failed_stderr).await;
    match result {
        Ok(out) if out.exit.success() => {
            r.ok = true;
            return r;
        }
        Ok(out) => r.message = redact_text(out.exit.stderr.trim()),
        Err(GitError::Cancelled) => {
            r.skip(pick(
                "실행 중에 취소했습니다 (만들던 폴더는 지웠습니다)",
                "Canceled while running (the partial folder was removed)",
            ));
            r.cancelled = true;
        }
        Err(e) => r.message = redact_text(&e.to_string()),
    }
    if let Some(why) = remove_created(&dest).await {
        r.message = if r.message.is_empty() {
            why
        } else {
            format!("{}\n{why}", r.message)
        };
    }
    r
}

impl Core {
    /// 여러 저장소를 한 상위 폴더 아래에 clone 한다. 동시 clone 수는 요청대로(1~4). 진행률은 `sink` 로 세션 0 의
    /// operation 이벤트(저장소 하나가 끝날 때마다), 취소는 `cancel_operation(op_id)` — 실행 중인 clone 은 프로세스
    /// 그룹째 멈추고 만들던 폴더를 지우며, 시작하지 않은 저장소는 "취소됨" 이다. 결과는 요청 순서다
    pub async fn clone_many(
        &self,
        batch: CloneBatch,
        sink: Arc<dyn EventSink>,
    ) -> Result<BatchResult, CoreError> {
        validate(&batch)?;
        let inner = self.inner_arc();
        let total = batch.targets.len();
        let label = tr!("일괄 복제 ({total}개)", "Batch clone ({total})");
        let op = inner.ops.begin(SessionId(0));
        sink.emit(CoreEvent::OperationStarted {
            session: SessionId(0),
            op_id: op.id,
            kind: "clone".into(),
            label: label.clone(),
        });
        let sem = Arc::new(Semaphore::new(
            batch.concurrency.clamp(1, CLONE_CONCURRENCY_MAX) as usize,
        ));
        let targets = batch.targets.clone();
        let batch = Arc::new(batch);
        let mut set = JoinSet::new();
        for (index, target) in targets.into_iter().enumerate() {
            let inner = Arc::clone(&inner);
            let batch = Arc::clone(&batch);
            let sem = Arc::clone(&sem);
            let cancel = op.cancel.clone();
            set.spawn(async move {
                let _permit = sem.acquire().await;
                (index, clone_one(inner, batch, target, cancel).await)
            });
        }
        let mut results: Vec<(usize, RepoResult)> = Vec::with_capacity(total);
        while let Some(joined) = set.join_next().await {
            if let Ok((index, res)) = joined {
                sink.emit(CoreEvent::OperationProgress {
                    session: SessionId(0),
                    op_id: op.id,
                    phase: res.name.clone(),
                    percent: Some(((results.len() + 1) * 100 / total) as u8),
                    message: if res.ok {
                        String::new()
                    } else {
                        res.message.clone()
                    },
                });
                results.push((index, res));
            }
        }
        results.sort_by_key(|(index, _)| *index);
        let result = BatchResult::tally(label, results.into_iter().map(|(_, r)| r).collect());
        let (succeeded, skipped, failed, cancelled) = (
            result.succeeded,
            result.skipped,
            result.failed,
            result.cancelled,
        );
        let mut message = tr!(
            "성공 {succeeded} · 건너뜀 {skipped} · 실패 {failed}",
            "{succeeded} succeeded · {skipped} skipped · {failed} failed"
        );
        if cancelled > 0 {
            message.push_str(&tr!(" · 취소됨 {cancelled}", " · {cancelled} canceled"));
        }
        sink.emit(CoreEvent::OperationFinished {
            session: SessionId(0),
            op_id: op.id,
            ok: failed == 0,
            cancelled: op.cancel.is_cancelled(),
            message,
            lock_left: false,
        });
        inner.ops.end(op.id);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 대상 하나
    fn target(url: &str, name: &str) -> CloneTarget {
        CloneTarget {
            url: url.into(),
            name: name.into(),
        }
    }

    /// 상위 폴더가 임시 폴더인 요청
    fn batch(targets: Vec<CloneTarget>) -> CloneBatch {
        CloneBatch {
            parent: std::env::temp_dir(),
            targets,
            recurse_submodules: false,
            depth: None,
            blobless: false,
            single_branch: false,
            concurrency: CLONE_CONCURRENCY_DEFAULT,
        }
    }

    #[test]
    fn names_must_be_single_components() {
        for good in ["app", "my app", "앱-1", ".hidden"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "  ", ".", "..", "a/b", "a\\b", "a\0b"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn validate_rejects_bad_requests() {
        assert!(validate(&batch(vec![target("https://h/a.git", "a")])).is_ok());
        assert!(validate(&batch(vec![])).is_err());
        assert!(validate(&batch(vec![target("--upload-pack=x", "a")])).is_err());
        assert!(validate(&batch(vec![target("https://h/a.git", "../a")])).is_err());
        assert!(
            validate(&batch(vec![
                target("https://h/a.git", "a"),
                target("https://g/a.git", "a"),
            ]))
            .is_err()
        );
        let mut missing = batch(vec![target("https://h/a.git", "a")]);
        missing.parent = std::env::temp_dir().join("mgit-no-such-parent-folder");
        assert!(validate(&missing).is_err());
    }
}
