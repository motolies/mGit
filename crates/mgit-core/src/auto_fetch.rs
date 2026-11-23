//! 자동 fetch (RM-02): 간격(실행 중에 바꿀 수 있음), 저장소 탭 루프, 탭·폴더 루프가 함께 쓰는 저장소 하나의 절차.
//! 폴더 루프는 `folder_auto_fetch.rs` 에 있다.
//!
//! 두 루프 모두 사용자가 누르지 않은 fetch 라서 다음을 지킨다
//! - 저장소 자체 설정의 `core.sshCommand` 를 실행하지 않는다 (그 저장소는 건너뛴다)
//! - 인증 대화상자를 띄우지 않는다 (`mgit_helper::ENV_SILENT` — 키체인에 없으면 실패)
//! - undo 항목·Operation 이벤트를 만들지 않는다
//! - `fetch.pruneTags=true` 여도 아직 push 하지 않은 로컬 tag 를 지우지 않는다 (`--no-prune-tags`, TG-16)

use std::future::Future;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use mgit_model::GitRunner;

use crate::core::{Core, CoreInner};
use crate::events::CoreEvent;
use crate::session::{Life, RepoSession};
use crate::write::WriteSpec;

/// 자동 fetch 명령. 되돌릴 수 없는 tag 삭제를 백그라운드에서 하지 않도록 `--no-prune-tags` 를 붙인다 (TG-16).
/// 수동 fetch 는 사용자 설정을 따른다
pub(crate) const AUTO_FETCH_ARGS: [&str; 4] = ["fetch", "--all", "--prune", "--no-prune-tags"];

/// 묻지 않는 인증 표시 (`MGIT_HELPER_SILENT=1`). 자동 fetch 의 git 환경에 붙인다
pub(crate) const SILENT_ENV: (&str, &str) = (mgit_helper::ENV_SILENT, "1");

/// 간격을 원자 값(밀리초, 0 = 끔)으로 바꾼다. 0 이 아닌 간격은 1ms 이상으로 둔다 (0 은 끔과 겹친다)
pub(crate) fn interval_to_millis(interval: Option<Duration>) -> u64 {
    match interval {
        None => 0,
        Some(d) if d.is_zero() => 0,
        Some(d) => u64::try_from(d.as_millis()).unwrap_or(u64::MAX).max(1),
    }
}

/// 저장소 자체 설정(local·worktree)에 `core.sshCommand` 가 있는지. 전역 설정은 사용자의 것이라 제외
pub(crate) async fn has_repo_ssh_command(runner: &dyn GitRunner, work_tree: &Path) -> bool {
    let req = mgit_model::GitRequest::new(
        work_tree,
        ["config", "--show-scope", "--get", "core.sshCommand"],
    );
    let Ok(out) = runner.run(req).await else {
        return false;
    };
    let text = out.stdout_lossy();
    out.exit.success() && (text.starts_with("local") || text.starts_with("worktree"))
}

/// 저장소 하나의 자동 fetch 를 돌리고 바뀐 원격 추적 ref 이름(`origin/main` 꼴)을 돌려준다 (UX-09).
/// 원격 추적 ref 를 읽고 → `fetch` 를 기다리고 → 다시 읽어 비교한다. `fetch` 는 실제 명령(탭은 세션 쓰기 큐, 폴더는
/// 세션 없는 실행)과 tag 캐시 처리를 맡고, 실패하면 화면에 보일 수 있는(가린) 메시지를 돌려준다
pub(crate) async fn fetch_changed_refs<F>(
    runner: &dyn GitRunner,
    work_tree: &Path,
    fetch: F,
) -> Result<Vec<String>, String>
where
    F: Future<Output = Result<(), String>>,
{
    let before = mgit_git::cmd::remote_refs(runner, work_tree)
        .await
        .unwrap_or_default();
    fetch.await?;
    let after = mgit_git::cmd::remote_refs(runner, work_tree)
        .await
        .unwrap_or_default();
    Ok(mgit_git::cmd::changed_remote_refs(&before, &after))
}

impl CoreInner {
    /// 지금 자동 fetch 간격. `None` 이면 끔
    pub(crate) fn auto_fetch_interval(&self) -> Option<Duration> {
        match self.auto_fetch_ms.load(Ordering::SeqCst) {
            0 => None,
            ms => Some(Duration::from_millis(ms)),
        }
    }

    /// 저장소 탭(Full 세션)의 자동 fetch 를 지금 간격으로 (다시) 건다. 끔이면 멈춘다. 이미 돌던 루프는 끊고 새로
    /// 시작한다(타이머도 처음부터). 간격은 세션의 태스크 잠금 안에서 읽는다(`rearm_auto_fetch`). 승격·간격 변경처럼
    /// `life` 를 쥔 쪽이 부르면 잠금 순서 `life` → `auto_fetch` 를 지킨다
    pub(crate) fn arm_auto_fetch(self: &Arc<Self>, session: &Arc<RepoSession>) {
        session.rearm_auto_fetch(|| {
            let interval = self.auto_fetch_interval()?;
            let handle = tokio::runtime::Handle::try_current().ok()?;
            let weak = Arc::downgrade(self);
            let weak_session = Arc::downgrade(session);
            Some(handle.spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    let (Some(core), Some(session)) = (weak.upgrade(), weak_session.upgrade())
                    else {
                        return;
                    };
                    core.auto_fetch_session(&session).await;
                }
            }))
        });
    }

    /// 저장소 탭의 자동 fetch 한 번: 원격이 없거나 저장소 설정의 ssh 명령이 있으면 건너뛰고, 세션 쓰기 큐로 fetch 한 뒤
    /// 바뀐 원격 추적 ref 가 있으면 `AutoFetched` 를 보낸다. 실패는 로그만 남긴다
    async fn auto_fetch_session(self: &Arc<Self>, session: &Arc<RepoSession>) {
        if session.state().refs.remotes.is_empty() {
            return;
        }
        let wt = session.info.work_tree.clone();
        // 사용자가 누르지 않은 fetch 로 저장소가 지정한 명령을 실행하지 않는다
        if has_repo_ssh_command(self.runner(), &wt).await {
            return;
        }
        // 사용자 작업이 아니므로 undo 항목을 만들지 않는다 (태그를 받으면 ref 가 바뀐다)
        let spec = WriteSpec::new(AUTO_FETCH_ARGS)
            .network()
            .no_undo()
            .env(SILENT_ENV.0, SILENT_ENV.1);
        let fetched = fetch_changed_refs(self.runner(), &wt, async {
            // 원격 tag 를 받아 왔으면 원격 tag 캐시를 오래됨으로 (TG-08 ④)
            let tags_before = self.tag_marks(session);
            let result = self.run_write(session, spec).await;
            self.after_fetch(session, tags_before);
            result.map(drop).map_err(|e| e.to_string())
        })
        .await;
        match fetched {
            Err(e) => tracing::debug!(session = ?session.id, error = %e, "자동 fetch 실패"),
            Ok(changed) if !changed.is_empty() => session.sink.emit(CoreEvent::AutoFetched {
                session: session.id,
                refs: changed,
            }),
            Ok(_) => {}
        }
    }
}

impl Core {
    /// 지금 자동 fetch 간격 (`None` 이면 끔). 처음 값은 `CoreConfig::auto_fetch_interval` 이다
    pub fn auto_fetch_interval(&self) -> Option<Duration> {
        self.inner().auto_fetch_interval()
    }

    /// 자동 fetch 간격을 바꾸고 곧바로 적용한다. 저장소 탭(Full 세션)과 열린 폴더의 루프를 모두 새 간격으로 다시 건다
    /// (끔이면 멈춘다). 같은 값이면 아무것도 하지 않는다. 탭은 세션마다 `life` 를 쥐고 프로필을 확인한 뒤 건다 —
    /// `sessions` 잠금을 놓은 사본으로 돌고 두 세션의 `life` 를 함께 쥐지 않는다 (`Life` 의 잠금 규칙).
    /// 간격을 먼저 바꾸므로 이 호출과 겹쳐 새로 열리거나 승격된 세션·폴더도 새 간격을 읽는다
    pub fn set_auto_fetch_interval(&self, interval: Option<Duration>) {
        let inner = self.inner();
        let ms = interval_to_millis(interval);
        if inner.auto_fetch_ms.swap(ms, Ordering::SeqCst) == ms {
            return;
        }
        for session in inner.all_sessions() {
            let life = session.life();
            if *life == Life::Full {
                inner.arm_auto_fetch(&session);
            }
        }
        let folders: Vec<Arc<crate::folder::FolderSession>> = inner
            .folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for folder in folders {
            inner.arm_folder_auto_fetch(&folder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 끔(None·0)은 0, 1ms 보다 짧은 간격은 끔으로 뭉개지지 않는다
    #[test]
    fn interval_millis_keeps_off_distinct() {
        assert_eq!(interval_to_millis(None), 0);
        assert_eq!(interval_to_millis(Some(Duration::ZERO)), 0);
        assert_eq!(interval_to_millis(Some(Duration::from_micros(10))), 1);
        assert_eq!(interval_to_millis(Some(Duration::from_secs(300))), 300_000);
    }
}
