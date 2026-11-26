//! 폴더 자동 fetch (RM-02 의 폴더 탭). 폴더 세션마다 루프 하나가 간격마다 하위 저장소(순번 묶음의 대표)를 fetch 하고,
//! 원격 추적 ref 가 바뀌었거나 실패한 저장소를 `FolderAutoFetched` 로 알린다. 간격과 저장소 하나의 절차·규칙(묻지 않는
//! 인증, 저장소 설정의 ssh 명령 건너뛰기, undo·Operation 없음)은 저장소 탭 루프와 함께 `auto_fetch.rs` 에 있다

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::cmd::{discover, list_remotes};
use mgit_l10n::pick;
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::auto_fetch::{AUTO_FETCH_ARGS, SILENT_ENV, fetch_changed_refs, has_repo_ssh_command};
use crate::core::{Core, CoreInner};
use crate::events::CoreEvent;
use crate::folder::{FolderSession, repo_name};
use crate::folder_batch::{FolderSettings, run_git_env};
use crate::session::SessionProfile;

/// 폴더 자동 fetch 의 저장소 하나 결과. `FolderAutoFetched` 에는 ref 가 바뀌었거나 실패한 저장소만 싣는다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoFetchedRepo {
    /// 폴더 저장소 목록의 대표 경로 (요약의 `path` 와 같은 꼴)
    pub path: PathBuf,
    pub name: String,
    /// 새로 생기거나 바뀐 원격 추적 ref (`origin/main` 꼴). 실패면 비어 있다
    pub refs: Vec<String>,
    /// 실패 메시지 (URL 토큰을 가렸다). 성공이면 `None`
    pub error: Option<String>,
}

/// 경로를 정규화한다 (실패하면 그대로). 세션의 `common_dir` 과 폴더 저장소의 판별 결과를 같은 꼴로 비교한다
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// 한 바퀴 결과를 알린다: ref 가 바뀐 저장소마다 `FolderChanged { refs: true }`(프런트가 그 저장소만 다시 읽게), 그다음
/// 바뀌었거나 실패한 저장소가 하나라도 있으면 `FolderAutoFetched` 한 번. 아무 일도 없었으면 보내지 않는다
fn report_round(folder: &FolderSession, repos: Vec<AutoFetchedRepo>) {
    for r in repos.iter().filter(|r| !r.refs.is_empty()) {
        folder.sink.emit(CoreEvent::FolderChanged {
            session: folder.id,
            refs: true,
            repo: Some(r.path.clone()),
        });
    }
    if !repos.is_empty() {
        folder.sink.emit(CoreEvent::FolderAutoFetched {
            session: folder.id,
            repos,
        });
    }
}

impl CoreInner {
    /// 폴더 자동 fetch 를 지금 간격으로 (다시) 건다. 끔이면 멈춘다. 돌던 루프는 끊고 타이머도 처음부터다. 간격은 폴더의
    /// 태스크 잠금 안에서 읽는다(`rearm_auto_fetch`). 태스크를 건 뒤(잠금을 놓은 뒤) 폴더가 아직 등록돼 있는지 다시 보고
    /// 그새 닫혔으면 멈춘다 — `close_folder` 는 목록에서 뺀 뒤 멈추므로 열기·간격 변경과 닫기가 어느 순서로 겹쳐도 닫힌
    /// 폴더에 루프가 남지 않는다
    pub(crate) fn arm_folder_auto_fetch(self: &Arc<Self>, folder: &Arc<FolderSession>) {
        folder.rearm_auto_fetch(|| {
            let interval = self.auto_fetch_interval()?;
            let handle = tokio::runtime::Handle::try_current().ok()?;
            let weak = Arc::downgrade(self);
            let weak_folder = Arc::downgrade(folder);
            Some(handle.spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    let (Some(inner), Some(folder)) = (weak.upgrade(), weak_folder.upgrade())
                    else {
                        return;
                    };
                    // 설정은 바퀴마다 읽는다 (제외·동시 실행 수를 바꾸면 다음 바퀴부터). 닫힌 폴더면 끝낸다
                    let Ok(settings) =
                        Core::from_inner(Arc::clone(&inner)).folder_settings(folder.id)
                    else {
                        return;
                    };
                    let repos = inner.auto_fetch_round(&folder, &settings).await;
                    report_round(&folder, repos);
                }
            }))
        });
        if self.folders_get(folder.id).is_err() {
            folder.stop_auto_fetch();
        }
    }

    /// 폴더 자동 fetch 한 바퀴. 순번 묶음의 대표마다(워크트리는 원 저장소에 흡수돼 한 번만) 폴더 설정의 동시 실행 수로
    /// 나눠 돌고, ref 가 바뀌었거나 실패한 저장소만 경로순으로 돌려준다. 폴더 설정에서 뺀 저장소와 저장소 탭으로 열린
    /// 저장소(그 탭의 루프가 돈다)는 건너뛴다
    async fn auto_fetch_round(
        self: &Arc<Self>,
        folder: &FolderSession,
        settings: &FolderSettings,
    ) -> Vec<AutoFetchedRepo> {
        let tabs = Arc::new(self.tab_common_dirs());
        let sem = Arc::new(Semaphore::new(settings.parallelism()));
        let mut set = JoinSet::new();
        for group in folder.groups() {
            let path = group.found.path;
            if settings.excludes(&repo_name(&path)) {
                continue;
            }
            let inner = Arc::clone(self);
            let tabs = Arc::clone(&tabs);
            let sem = Arc::clone(&sem);
            set.spawn(async move {
                let _permit = sem.acquire().await;
                inner.auto_fetch_repo(path, &tabs).await
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(Some(r)) = joined {
                out.push(r);
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// 저장소 탭(Full 세션)으로 열린 저장소들의 정규화한 `common_dir`. 탭의 자동 fetch 가 같은 저장소의 원격 추적 ref 를
    /// 갱신하므로 폴더 루프는 그 저장소를 건너뛴다 (워크트리를 탭으로 열어도 같은 저장소다). 가벼운 세션은 자동 fetch 가
    /// 없으므로 세지 않는다. `sessions` 잠금을 놓은 사본으로 세션마다 프로필을 본다 (잠금 규칙)
    fn tab_common_dirs(&self) -> Vec<PathBuf> {
        self.all_sessions()
            .into_iter()
            .filter(|s| s.profile() == Some(SessionProfile::Full))
            .map(|s| canonical(&s.info.common_dir))
            .collect()
    }

    /// 폴더 저장소 하나의 자동 fetch. 건너뛰었거나 바뀐 것이 없으면 `None`. 판별·원격·ssh 설정 확인은 잠금 밖에서 하고,
    /// fetch 와 그 전후 비교는 그 저장소의 쓰기 잠금(`write_lock_for(common_dir)` — 세션 쓰기 큐·폴더 일괄 작업과 같은
    /// 잠금) 안에서 한다. 판별에 실패한 저장소(그새 지워짐 등)는 재스캔이 정리하므로 실패로 알리지 않는다
    async fn auto_fetch_repo(
        self: &Arc<Self>,
        path: PathBuf,
        tabs: &[PathBuf],
    ) -> Option<AutoFetchedRepo> {
        let runner = self.runner();
        let d = match discover(runner, &path).await {
            Ok(d) => d,
            Err(e) => {
                tracing::debug!(path = %path.display(), error = %e, "자동 fetch: 저장소 판별 실패");
                return None;
            }
        };
        if tabs.contains(&canonical(&d.common_dir)) {
            return None;
        }
        if !list_remotes(runner, &d.work_tree)
            .await
            .is_ok_and(|remotes| !remotes.is_empty())
        {
            return None;
        }
        // 사용자가 누르지 않은 fetch 로 저장소가 지정한 명령을 실행하지 않는다
        if has_repo_ssh_command(runner, &d.work_tree).await {
            return None;
        }
        let lock = self.write_lock_for(&d.common_dir);
        let _queued = lock.lock().await;
        let args: Vec<String> = AUTO_FETCH_ARGS.iter().map(|a| (*a).to_string()).collect();
        let fetched = fetch_changed_refs(runner, &d.work_tree, async {
            // 원격 tag 를 받아 왔으면 열린 탭의 원격 tag 캐시를 오래됨으로 (TG-08 ④, 폴더 일괄 fetch 와 같다)
            let tags_before = self.tag_marks_at(&d.common_dir, &d.work_tree).await;
            let (ok, msg) = run_git_env(self, &d.work_tree, &args, true, &[SILENT_ENV]).await;
            if tags_before.is_some() {
                let tags_after = self.tag_marks_at(&d.common_dir, &d.work_tree).await;
                self.stale_if_tags_changed(&d.common_dir, tags_before, tags_after);
            }
            match (ok, msg.is_empty()) {
                (true, _) => Ok(()),
                (false, false) => Err(msg),
                (false, true) => {
                    Err(pick("원격 정보를 가져오지 못했습니다", "fetch failed").to_string())
                }
            }
        })
        .await;
        let (refs, error) = match fetched {
            Ok(refs) if refs.is_empty() => return None,
            Ok(refs) => (refs, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        Some(AutoFetchedRepo {
            name: repo_name(&path),
            path,
            refs,
            error,
        })
    }
}
