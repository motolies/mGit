//! 폴더 자동 fetch (RM-02 의 폴더 탭). 폴더 세션마다 루프 하나가 간격마다 하위 저장소(순번 묶음의 대표)를 fetch 하고,
//! 원격 추적 ref 가 바뀌었거나 실패한 저장소를 `FolderAutoFetched` 로 알린다. 간격과 저장소 하나의 절차·규칙(묻지 않는
//! 인증, 저장소 설정의 ssh 명령 건너뛰기, undo·Operation 없음)은 저장소 탭 루프와 함께 `auto_fetch.rs` 에 있다

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::bulk_reads;
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
    /// 새로 생기거나 바뀐 원격 추적 ref (`origin/main` 꼴, 심볼릭 `<원격>/HEAD` 는 빼고). 실패면 비어 있다
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
            // 묶음 읽기로 센다: 저장소 수만큼 퍼지는 배경 읽기가 사용자가 누른 읽기의 칸까지 차지하지 않게 (반응성 12)
            set.spawn(bulk_reads(async move {
                let _permit = sem.acquire().await;
                inner.auto_fetch_repo(path, &tabs).await
            }));
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
    /// 잠금) 안에서 한다. 판별에 실패한 저장소(그새 지워짐 등)는 재스캔이 정리하므로 실패로 알리지 않는다.
    /// 다른 탭이 간격의 절반 안에 받은 저장소는 건너뛴다 (M5) — 잠금을 기다리는 사이 다른 폴더·그룹의 바퀴가 먼저 받았을
    /// 수 있어 잠금을 잡은 뒤에도 다시 본다. 성공하면 적는다
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
        if self.fetched_recently(&d.common_dir) {
            return None;
        }
        let lock = self.write_lock_for(&d.common_dir);
        let _queued = lock.lock().await;
        if self.fetched_recently(&d.common_dir) {
            return None;
        }
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
        if fetched.is_ok() {
            self.note_fetched(&d.common_dir);
        }
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

/// 자동 fetch 중복 제거 (M5): 타이머를 기다리지 않고 한 바퀴(`auto_fetch_round`)·탭 한 번(`auto_fetch_session`)을 직접
/// 돌려 명령 로그의 fetch 수를 센다. 간격은 1시간이라 시험 중에 루프가 스스로 돌지 않는다
#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::time::{Duration, Instant};

    use mgit_testkit::TestRepo;

    use super::*;
    use crate::events::EventSink;
    use crate::{BatchOp, CoreConfig};

    /// 시험 간격 (루프가 시험 중에 돌지 않을 만큼 길다)
    const INTERVAL: Duration = Duration::from_secs(3600);

    /// 이벤트를 버리는 sink
    fn sink() -> Arc<dyn EventSink> {
        Arc::new(|_e: CoreEvent| {})
    }

    /// 명령 로그의 fetch 수
    fn fetches(core: &Core) -> usize {
        core.command_log_recent(10_000)
            .iter()
            .filter(|r| r.args.iter().any(|a| a == "fetch"))
            .count()
    }

    /// 간격 1시간인 코어
    async fn core() -> Core {
        let runner = mgit_git::TokioGitRunner::new(mgit_git::RunnerConfig::default())
            .await
            .unwrap();
        Core::new(
            Arc::new(runner),
            CoreConfig {
                auto_fetch_interval: Some(INTERVAL),
                ..CoreConfig::default()
            },
        )
    }

    /// `root/name` 에 커밋 하나짜리 저장소. `remote` 면 bare 원격과 업스트림, 아니면 fetch 가 늘 실패하는 원격
    fn repo(root: &Path, name: &str, remote: bool) -> (PathBuf, TestRepo) {
        let path = root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        let mut r = TestRepo::at(&path);
        r.git_ok(["init", "-q", "-b", "main"]);
        r.commit("first");
        if remote {
            r.add_bare_remote();
            r.git_ok(["push", "-q", "-u", "origin", "main"]);
        } else {
            let missing = root.join("no-such-remote.git");
            r.git_ok(["remote", "add", "origin", &missing.to_string_lossy()]);
        }
        (path, r)
    }

    /// 같은 저장소를 담은 폴더 세션과 그룹 세션 (그룹 멤버는 `members`)
    async fn folder_and_group(
        core: &Core,
        root: &Path,
        members: &[PathBuf],
    ) -> (Arc<FolderSession>, Arc<FolderSession>) {
        let fid = core.open_folder(root, sink()).await.unwrap().session;
        let created = core.group_create("g", members).unwrap();
        let gid = core
            .open_group(&created.group.id, sink())
            .await
            .unwrap()
            .session;
        let inner = core.inner();
        (
            inner.folders_get(fid).unwrap(),
            inner.folders_get(gid).unwrap(),
        )
    }

    /// 같은 저장소를 담은 폴더 탭과 그룹 탭의 바퀴가 한 간격 안에 겹치면 fetch 는 한 번이다. 워크트리로 넣어도 같은
    /// 저장소다(`common_dir` 공유). 간격의 절반이 지난 표지면 다시 받는다
    #[tokio::test]
    async fn folder_and_group_rounds_fetch_a_repo_once_per_interval() {
        let core = core().await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (api, mut r) = repo(&root, "api", true);
        let wt = root.join("api-wt");
        r.git_ok(["worktree", "add", "-q", "-b", "wt", &wt.to_string_lossy()]);
        let (folder, group) = folder_and_group(&core, &root, std::slice::from_ref(&wt)).await;
        let inner = core.inner();
        let settings = FolderSettings::default();
        let start = fetches(&core);
        inner.auto_fetch_round(&folder, &settings).await;
        assert_eq!(fetches(&core), start + 1);
        // 그룹은 워크트리로 같은 저장소를 담았다: 방금 받았으니 건너뛴다
        inner.auto_fetch_round(&group, &settings).await;
        inner.auto_fetch_round(&folder, &settings).await;
        assert_eq!(fetches(&core), start + 1);
        // 간격의 절반이 지난 표지면 다시 받는다 (부팅 뒤 30분이 안 된 기계에서는 시각을 만들 수 없어 건너뛴다)
        if let Some(old) = Instant::now().checked_sub(INTERVAL / 2 + Duration::from_secs(1)) {
            inner.fetch_marks.mark(&api.join(".git"), old);
            inner.auto_fetch_round(&group, &settings).await;
            assert_eq!(fetches(&core), start + 2);
        }
    }

    /// 실패한 fetch 는 적지 않는다: 다른 탭의 바퀴가 다음에 다시 시도한다
    #[tokio::test]
    async fn failed_fetch_is_not_recorded() {
        let core = core().await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (broken, _r) = repo(&root, "broken", false);
        let (folder, group) = folder_and_group(&core, &root, std::slice::from_ref(&broken)).await;
        let inner = core.inner();
        let settings = FolderSettings::default();
        let start = fetches(&core);
        inner.auto_fetch_round(&folder, &settings).await;
        inner.auto_fetch_round(&group, &settings).await;
        assert_eq!(fetches(&core), start + 2);
        assert_eq!(inner.fetch_marks.last(&broken.join(".git")), None);
    }

    /// 사용자 fetch(일괄 fetch·저장소 탭 fetch)는 막지 않고 시각만 적는다. 그 뒤 저장소 탭의 자동 fetch 와 폴더 바퀴는
    /// 건너뛴다. 원격 하나만 받은 사용자 fetch 는 적지 않는다
    #[tokio::test]
    async fn user_fetch_is_never_blocked_and_suppresses_auto_fetch() {
        let core = core().await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (api, _r) = repo(&root, "api", true);
        let (folder, group) = folder_and_group(&core, &root, std::slice::from_ref(&api)).await;
        let inner = core.inner();
        let settings = FolderSettings::default();
        let start = fetches(&core);
        inner.auto_fetch_round(&folder, &settings).await;
        core.folder_batch(group.id, BatchOp::Fetch { prune: false }, &[])
            .await
            .unwrap();
        assert_eq!(fetches(&core), start + 2);
        inner.auto_fetch_round(&group, &settings).await;
        assert_eq!(fetches(&core), start + 2);

        // 저장소 탭: 사용자 fetch 는 바로 전에 받았어도 돈다, 자동 fetch 는 건너뛴다
        let tab = core.open_repo(&api, sink()).await.unwrap().session;
        core.fetch(tab, None, false, None).await.unwrap();
        assert_eq!(fetches(&core), start + 3);
        let session = inner.get(tab).unwrap();
        inner.auto_fetch_session(&session).await;
        assert_eq!(fetches(&core), start + 3);

        // 원격 하나만 받은 fetch 는 모든 원격을 대신하지 않아 적지 않는다
        let marked = inner.fetch_marks.last(&api.join(".git"));
        core.fetch(tab, Some("origin"), false, None).await.unwrap();
        assert_eq!(fetches(&core), start + 4);
        assert_eq!(inner.fetch_marks.last(&api.join(".git")), marked);
    }

    /// 받은 이벤트를 모으는 sink
    fn recorder() -> (Arc<dyn EventSink>, Arc<std::sync::Mutex<Vec<CoreEvent>>>) {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let out = Arc::clone(&seen);
        let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| out.lock().unwrap().push(e));
        (sink, seen)
    }

    /// `r` 의 원격에 다른 clone 에서 커밋 하나를 올린다 (`r` 의 원격 추적 ref 는 그대로라 다음 fetch 가 받아 온다)
    fn push_from_other_clone(r: &mut TestRepo) {
        let remote = r.git_ok(["remote", "get-url", "origin"]).trim().to_string();
        let mut other = TestRepo::init();
        other.git_ok(["remote", "add", "origin", &remote]);
        other.git_ok(["fetch", "-q", "origin"]);
        other.git_ok(["checkout", "-q", "-b", "main", "--track", "origin/main"]);
        other.commit("from other");
        other.git_ok(["push", "-q", "origin", "main"]);
    }

    /// 원격의 기본 branch 표시(심볼릭 `<원격>/HEAD`)는 원격 변경이 아니다. `push -u` 로만 원격을 잡아 `origin/HEAD` 가
    /// 없는 저장소의 첫 자동 fetch 는 (git 2.48+ 가 그것을 만들어도) 새 커밋이 없으면 아무것도 알리지 않고, 새 커밋이
    /// 있으면 그 branch 만 알린다 — 저장소 탭(`AutoFetched`)
    #[tokio::test]
    async fn tab_auto_fetch_ignores_remote_head_creation() {
        let core = core().await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (quiet, _q) = repo(&root, "quiet", true);
        let (moved, mut m) = repo(&root, "moved", true);
        push_from_other_clone(&mut m);
        let inner = core.inner();
        let mut notified = Vec::new();
        for path in [&quiet, &moved] {
            let (sink, seen) = recorder();
            let tab = core.open_repo(path, sink).await.unwrap().session;
            inner.auto_fetch_session(&inner.get(tab).unwrap()).await;
            let refs: Vec<Vec<String>> = seen
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    CoreEvent::AutoFetched { refs, .. } => Some(refs.clone()),
                    _ => None,
                })
                .collect();
            notified.push(refs);
        }
        assert_eq!(notified, [vec![], vec![vec!["origin/main".to_string()]]]);
    }

    /// 폴더·그룹 바퀴도 같다: 새 커밋이 없는 저장소는 결과(`FolderAutoFetched`·`FolderChanged`)에 실리지 않고, 새 커밋이
    /// 있는 저장소는 그 branch 만 실린다
    #[tokio::test]
    async fn folder_and_group_rounds_ignore_remote_head_creation() {
        let core = core().await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (_quiet, _q) = repo(&root, "quiet", true);
        let (_moved, mut m) = repo(&root, "moved", true);
        push_from_other_clone(&mut m);
        // 그룹 멤버는 폴더 밖에 두어 폴더 바퀴와 겹치지 않게 한다 (겹치면 M5 가 건너뛴다)
        let outside = tempfile::tempdir().unwrap();
        let out_root = outside.path().canonicalize().unwrap();
        let (g_quiet, _gq) = repo(&out_root, "g-quiet", true);
        let (g_moved, mut gm) = repo(&out_root, "g-moved", true);
        push_from_other_clone(&mut gm);
        let (folder, group) = folder_and_group(&core, &root, &[g_quiet, g_moved]).await;
        let inner = core.inner();
        let settings = FolderSettings::default();
        let summary = |repos: Vec<AutoFetchedRepo>| {
            repos
                .into_iter()
                .map(|r| (r.name, r.refs, r.error))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            summary(inner.auto_fetch_round(&folder, &settings).await),
            [("moved".to_string(), vec!["origin/main".to_string()], None)]
        );
        assert_eq!(
            summary(inner.auto_fetch_round(&group, &settings).await),
            [("g-moved".to_string(), vec!["origin/main".to_string()], None)]
        );
    }

    /// 자동 fetch 가 꺼져 있으면 건너뛰지 않는다 (예전과 같다 — 바퀴를 직접 돌리면 탭마다 받는다)
    #[tokio::test]
    async fn interval_off_keeps_the_old_behavior() {
        let core = core().await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (api, _r) = repo(&root, "api", true);
        let (folder, group) = folder_and_group(&core, &root, std::slice::from_ref(&api)).await;
        core.set_auto_fetch_interval(None);
        let inner = core.inner();
        let settings = FolderSettings::default();
        let start = fetches(&core);
        inner.auto_fetch_round(&folder, &settings).await;
        inner.auto_fetch_round(&group, &settings).await;
        assert_eq!(fetches(&core), start + 2);
    }
}
