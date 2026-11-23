use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use mgit_git::cmd::{
    Discovered, detect_commit_graph, discover, find_child_repos, scan_repos, superproject,
};
use mgit_l10n::pick;
use mgit_model::{
    CommandLogRecord, GitError, GitRunner, GitVersion, MemoryStore, NoopWatcher, Oid, RecentKind,
    RefKind, RepoInfo, Store, WatchSpec, Watcher,
};
use serde::Serialize;

use crate::config::CoreConfig;
use crate::error::CoreError;
use crate::events::{CoreEvent, EventSink, SessionId};
use crate::load::{LoadMode, run_load};
use crate::logged_runner::{CommandLogHook, LoggedRunner};
use crate::ops::{OpHandle, OperationRegistry};
use crate::refresh::RefreshScope;
use crate::session::{Life, LoadState, RepoSession, SessionProfile};
use crate::state::RepoState;
use crate::window::{GraphRow, GraphWindow};
use crate::write::{WriteResult, WriteSpec};

/// 하위 저장소가 있으면 `MultiRepoFolder`, 없으면 주어진 오류를 그대로 돌려준다
fn multi_repo_or(path: &Path, fallback: CoreError) -> CoreError {
    let repos = find_child_repos(path);
    if repos.is_empty() {
        fallback
    } else {
        CoreError::MultiRepoFolder {
            path: path.to_path_buf(),
            repos,
        }
    }
}

/// 두 경로가 같은 디렉터리인지. 심링크·상대 경로 차이는 canonicalize 로 흡수한다
fn same_dir(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

/// `open_repo`·`folder_open_repo_session` 결과
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRepo {
    pub session: SessionId,
    /// 같은 작업 트리가 이미 열려 있어 기존 세션을 돌려줬는지 (승격했을 때도 참)
    pub already_open: bool,
    pub info: RepoInfo,
    /// 열 당시의 상태 스냅샷 (ref·status·진행 중 작업)
    pub state: RepoState,
    /// 작업 트리 바로 아래의 추적되지 않는 하위 저장소 (서브모듈 제외)
    pub nested_repos: Vec<PathBuf>,
    /// 이 저장소가 서브모듈이면 상위 저장소 작업 트리 (SUB-03)
    pub superproject: Option<PathBuf>,
    /// 돌려준 세션의 지금 프로필. `open_repo` 는 늘 `Full` 이다. 폴더에서 열었어도 그 작업 트리가 이미
    /// 탭으로 열려 있으면 `Full`(그 탭의 세션)이다
    pub profile: SessionProfile,
    /// 이 호출이 가벼운 세션을 전체 프로필로 올렸는지 (`open_repo` 만). 참이면 `already_open` 도 참이고,
    /// 세션 이벤트는 이제 이 호출에 넘긴 sink 로 간다
    pub promoted: bool,
}

/// 세션을 어떻게 여는가
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenAs {
    /// 저장소 탭 (`open_repo`). 같은 작업 트리에 가벼운 세션이 있으면 그것을 승격한다
    Tab,
    /// 폴더 화면이 여는 가벼운 세션. `folder` 가 잡는다
    Light { folder: SessionId },
}

/// 세션 등록과 닫기가 겹쳐 다시 시도하는 횟수 상한 (닫히던 세션을 만나면 한 번 더 본다)
const OPEN_ATTEMPTS: usize = 4;

/// 저장소 자체 설정(local·worktree)에 `core.sshCommand` 가 있는지. 전역 설정은 사용자의 것이라 제외
async fn has_repo_ssh_command(runner: &dyn GitRunner, work_tree: &Path) -> bool {
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

/// 코어 내부. `Core` 가 `Arc` 로 감싸 태스크·콜백과 공유한다
pub struct CoreInner {
    runner: Arc<LoggedRunner>,
    pub(crate) watcher: Arc<dyn Watcher>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) cfg: CoreConfig,
    pub(crate) sessions: RwLock<HashMap<SessionId, Arc<RepoSession>>>,
    pub(crate) next_id: AtomicU32,
    /// 폴더 세션 (MR). 저장소 세션과 id 공간을 공유한다
    pub(crate) folders:
        Mutex<std::collections::HashMap<SessionId, Arc<crate::folder::FolderSession>>>,
    write_locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    pub(crate) ops: OperationRegistry,
    command_log: Mutex<VecDeque<CommandLogRecord>>,
    /// 토큰 금고 (호스팅 계정). 셸이 키체인으로 바꾼다 (B1)
    pub(crate) vault: RwLock<Arc<dyn crate::credentials::SecretVault>>,
    /// 네트워크 명령의 인증 결과를 받는 쪽. 셸이 askpass 서비스를 단다
    pub(crate) credential_outcome: RwLock<Option<Arc<dyn crate::credentials::CredentialOutcome>>>,
    /// 네트워크 명령 태그 일련번호
    next_auth_tag: AtomicU64,
    /// 세션마다 마지막 포함 브랜치 요청 (W18: 새 요청이 앞 요청의 git 을 끝낸다)
    pub(crate) containing: crate::inspect::LatestRequests,
}

impl CoreInner {
    /// 기록하는 러너 (모든 git 호출은 이것으로)
    pub fn runner(&self) -> &dyn GitRunner {
        self.runner.as_ref()
    }

    /// 네트워크 명령에 붙일 태그. askpass 가 쓴 비밀을 이 명령과 잇는다
    pub(crate) fn auth_tag(&self) -> String {
        self.next_auth_tag
            .fetch_add(1, Ordering::Relaxed)
            .to_string()
    }

    /// 네트워크 명령이 끝났음을 알린다. `stderr` 가 서버의 자격 증명 거부면 쓴 비밀을 지우게 한다.
    /// 키체인은 블로킹 API 라 전용 스레드에서 처리한다
    pub(crate) async fn report_auth(&self, tag: &str, stderr: &str) {
        let outcome = self
            .credential_outcome
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(outcome) = outcome else {
            return;
        };
        let rejected = mgit_model::credentials_rejected(stderr);
        let tag = tag.to_string();
        let _ = tokio::task::spawn_blocking(move || {
            if rejected {
                outcome.rejected(&tag);
            } else {
                outcome.finished(&tag);
            }
        })
        .await;
    }

    /// 세션 조회
    pub fn get(&self, id: SessionId) -> Result<Arc<RepoSession>, CoreError> {
        self.sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned()
            .ok_or(CoreError::SessionNotFound(id))
    }

    /// `common_dir` 단위 쓰기 락
    pub fn write_lock_for(&self, common_dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let key = common_dir
            .canonicalize()
            .unwrap_or_else(|_| common_dir.to_path_buf());
        self.write_locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key)
            .or_default()
            .clone()
    }

    /// 그림자 재로드를 예약한다. 이미 돌고 있으면 끝난 뒤 한 번 더 돌도록 표시한다.
    /// 전체 프로필이 아니면(가벼운 세션·닫힘) 아무것도 하지 않는다. 승격은 `life` 잠금 안에서 프로필을 바꾸고
    /// 초기 로드까지 띄우므로, 여기서 `Full` 을 봤다면 초기 로드는 이미 등록돼 있고 이 재로드가 그것을
    /// 대신하는 설계된 경로(`run_load` 의 Reload 가 Initial 을 끊음)로 간다
    pub fn schedule_reload(self: &Arc<Self>, session: &Arc<RepoSession>) {
        if session.profile() != Some(SessionProfile::Full) {
            return;
        }
        let generation = {
            let mut r = session
                .reload
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if r.running {
                r.pending = true;
                return;
            }
            r.running = true;
            session.graph().generation + 1
        };
        let core = Arc::clone(self);
        let s = Arc::clone(session);
        let handle = tokio::spawn(run_load(core, s, generation, LoadMode::Reload));
        session.set_load_task(handle);
    }

    /// 재로드 태스크가 끝났을 때: 대기 중인 요청이 있으면 다시 돈다
    pub fn after_reload(self: &Arc<Self>, session: &Arc<RepoSession>) {
        let again = {
            let mut r = session
                .reload
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            r.running = false;
            std::mem::take(&mut r.pending)
        };
        if again {
            self.schedule_reload(session);
        }
    }

    /// 그래프 API 용 세션 조회. 가벼운 세션이면 로드를 시작하지 않고 `GraphUnavailable` 이다
    pub(crate) fn get_graph(&self, id: SessionId) -> Result<Arc<RepoSession>, CoreError> {
        let s = self.get(id)?;
        if s.is_light() {
            return Err(CoreError::GraphUnavailable(id));
        }
        Ok(s)
    }

    /// 열린 세션 전부의 사본 (`sessions` 잠금을 놓은 뒤 각 세션의 `life` 를 볼 때)
    pub(crate) fn all_sessions(&self) -> Vec<Arc<RepoSession>> {
        self.sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }

    /// 닫힌 세션의 남은 일을 멈춘다: 등록된 장시간 명령 취소, 자동 fetch·감시·그래프 로드 중단.
    /// `Life::Closed` 로 바꾼 쪽이 한 번만 부른다. 등록되지 않은 쓰기 명령(op 없는 commit 등)은 끝까지 돈다
    pub(crate) fn stop_session(&self, session: &RepoSession) {
        self.ops.cancel_session(session.id);
        session.stop_auto_fetch();
        session.stop_watch();
        session.abort_load();
    }

    /// 세션을 닫힘으로 바꾸고 목록에서 뺀다. `life` 를 쥔 쪽이 부른다 (잠금 순서 `life` → `sessions`)
    pub(crate) fn mark_closed(&self, life: &mut Life, id: SessionId) {
        *life = Life::Closed;
        self.sessions
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }

    /// 세션의 작업 트리 안에서 실행된 명령인지
    fn sessions_for_cwd(&self, cwd: &Path) -> Vec<Arc<RepoSession>> {
        self.sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|s| cwd.starts_with(&s.info.work_tree))
            .cloned()
            .collect()
    }

    /// 작업 디렉터리 `cwd` 를 저장소 목록에 품은 폴더 세션들과 그 저장소의 대표 경로 (W19 ② 폴더 콘솔). 폴더 경로로
    /// 먼저 거른 뒤 각 폴더의 메모리 목록에서 경로 접두로 찾는다 (`FolderSession::primary_of` — 디스크 접근 없음).
    /// 닫힌 폴더는 목록에서 빠져 있으므로 나오지 않고, 재스캔 뒤에는 새 목록으로 찾는다
    fn folders_for_cwd(&self, cwd: &Path) -> Vec<(Arc<crate::folder::FolderSession>, PathBuf)> {
        let candidates: Vec<Arc<crate::folder::FolderSession>> = self
            .folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|f| cwd.starts_with(&f.path))
            .cloned()
            .collect();
        candidates
            .into_iter()
            .filter_map(|f| f.primary_of(cwd).map(|repo| (f, repo)))
            .collect()
    }
}

impl CommandLogHook for CoreInner {
    /// 링버퍼에 넣고, 쓰기 명령은 저장소에 영속화하고, 해당 세션에 이벤트를 보낸다. 쓰기·네트워크 명령은 그 작업
    /// 디렉터리를 저장소 목록에 품은 폴더 세션에도 보낸다 (W19 ② 폴더 콘솔). 읽기 명령은 폴더를 찾지도 않는다 —
    /// 폴더 갱신 한 번에 읽기 명령이 저장소마다 여럿 돌아 콘솔을 덮고 이벤트가 쏟아지기 때문이다
    fn on_command(&self, record: CommandLogRecord) {
        {
            let mut log = self
                .command_log
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            log.push_back(record.clone());
            while log.len() > self.cfg.command_log_capacity {
                log.pop_front();
            }
        }
        if record.is_write
            && let Err(e) = self.store.log_command(&record)
        {
            tracing::warn!(error = %e, "명령 로그 저장 실패");
        }
        for s in self.sessions_for_cwd(&record.cwd) {
            s.sink.emit(CoreEvent::CommandLogged {
                session: s.id,
                record: record.clone(),
            });
        }
        if !record.is_write {
            return;
        }
        for (folder, repo) in self.folders_for_cwd(&record.cwd) {
            folder.sink.emit(CoreEvent::FolderCommandLogged {
                session: folder.id,
                repo,
                record: record.clone(),
            });
        }
    }
}

/// 응용 계층 진입점. 셸이 `tauri::State` 로 보관한다
pub struct Core {
    inner: Arc<CoreInner>,
}

impl std::fmt::Debug for Core {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Core")
    }
}

impl Core {
    /// 러너만 주입해 코어를 만든다 (감시 없음, 메모리 저장). 벤치·단위 테스트용
    pub fn new(runner: Arc<dyn GitRunner>, cfg: CoreConfig) -> Self {
        Self::with_deps(
            runner,
            Arc::new(NoopWatcher),
            Arc::new(MemoryStore::new()),
            cfg,
        )
    }

    /// 러너·감시자·저장소를 주입해 코어를 만든다
    pub fn with_deps(
        runner: Arc<dyn GitRunner>,
        watcher: Arc<dyn Watcher>,
        store: Arc<dyn Store>,
        cfg: CoreConfig,
    ) -> Self {
        let logged = Arc::new(LoggedRunner::new(runner));
        let inner = Arc::new(CoreInner {
            runner: Arc::clone(&logged),
            watcher,
            store,
            cfg,
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            folders: Mutex::new(std::collections::HashMap::new()),
            write_locks: Mutex::new(HashMap::new()),
            ops: OperationRegistry::default(),
            command_log: Mutex::new(VecDeque::new()),
            vault: RwLock::new(Arc::new(crate::credentials::MemoryVault::default())),
            credential_outcome: RwLock::new(None),
            next_auth_tag: AtomicU64::new(1),
            containing: crate::inspect::LatestRequests::default(),
        });
        let hook: Weak<dyn CommandLogHook> = Arc::downgrade(&inner) as Weak<dyn CommandLogHook>;
        logged.set_hook(hook);
        Core { inner }
    }

    /// 내부 상태에서 핸들을 다시 만든다 (감시 콜백 등 코어가 없는 곳에서)
    pub(crate) fn from_inner(inner: Arc<CoreInner>) -> Self {
        Core { inner }
    }

    /// 시작 시 확인한 git 버전
    pub fn git_version(&self) -> &GitVersion {
        self.inner.runner.version()
    }

    /// 로컬 저장소 포트
    pub fn store(&self) -> &Arc<dyn Store> {
        &self.inner.store
    }

    /// 설정
    pub fn config(&self) -> &CoreConfig {
        &self.inner.cfg
    }

    /// 내부 핸들 (기능 모듈용)
    pub(crate) fn inner(&self) -> &Arc<CoreInner> {
        &self.inner
    }

    /// 저장소를 연다: 판별 → HEAD·ref·status 로드 → 세션 등록 → 감시 시작 → 그래프 로드 태스크 시작 → 즉시 반환.
    /// 같은 작업 트리가 이미 열려 있으면 그 세션을 `already_open = true` 로 돌려준다. 그 세션이 가벼운
    /// 세션이면 같은 id 로 전체 프로필로 올리고(`promoted`), 이벤트 대상을 이 `sink` 로 바꾸며, 그래프 로드와
    /// 자동 fetch 를 시작한다. 이벤트는 이 함수가 반환하기 전에도 `sink` 로 올 수 있다.
    pub async fn open_repo(
        &self,
        path: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<OpenedRepo, CoreError> {
        let found = self.discover_for_tab(path).await?;
        self.open_session(found, sink, OpenAs::Tab).await
    }

    /// 탭으로 열 경로를 판별한다. 저장소가 아니거나 저장소 안의 하위 폴더인데 하위 저장소를 품고 있으면
    /// 멀티 저장소 폴더로 안내한다
    async fn discover_for_tab(&self, path: &Path) -> Result<Discovered, CoreError> {
        let inner = &self.inner;
        let found = match discover(inner.runner(), path).await {
            Ok(found) => found,
            // 저장소가 아니어도 하위 저장소를 품고 있으면 멀티 저장소 폴더로 안내한다
            Err(GitError::NotARepository(p)) => {
                return Err(multi_repo_or(path, GitError::NotARepository(p).into()));
            }
            Err(e) => return Err(e.into()),
        };
        // 저장소 안이지만 최상위가 아닌 폴더(예: gitignore 된 bench/repos)에 하위 저장소가 있으면
        // 상위 저장소를 여는 대신 멀티 저장소 폴더로 본다. 대시보드(MR)가 생기면 그쪽으로 연결한다
        if !same_dir(path, &found.work_tree) {
            let repos = find_child_repos(path);
            if !repos.is_empty() {
                return Err(CoreError::MultiRepoFolder {
                    path: path.to_path_buf(),
                    repos,
                });
            }
        }
        Ok(found)
    }

    /// 판별한 작업 트리의 세션을 연다 (탭·가벼운 세션 공용). 작업 트리당 세션은 하나다: 이미 있으면 그것을
    /// 돌려주고(`join_existing`), 없으면 상태를 읽어 새로 만든다. 확인과 등록 사이에 await 가 있으므로
    /// 등록할 때 `sessions` 쓰기 잠금 안에서 다시 확인하고, 진 쪽은 만든 세션을 버리고 이긴 세션에 합류한다
    pub(crate) async fn open_session(
        &self,
        found: Discovered,
        sink: Arc<dyn EventSink>,
        how: OpenAs,
    ) -> Result<OpenedRepo, CoreError> {
        let inner = &self.inner;
        let nested_repos: Vec<PathBuf> = scan_repos(&found.work_tree, 1)
            .into_iter()
            .filter(|r| r.kind != mgit_model::RepoKind::Submodule)
            .map(|r| r.path)
            .collect();
        let superproject = superproject(inner.runner(), &found.work_tree).await;
        // 가벼운 세션은 사용자가 고른 것이 아니라 최근 목록에 남기지 않는다 (승격하면 탭 쪽에서 남는다)
        if how == OpenAs::Tab {
            let repo_name = found
                .work_tree
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let _ = inner.store.recent_touch(
                &found.work_tree,
                mgit_model::RecentKind::Repo,
                &repo_name,
            );
        }
        let extras = (nested_repos, superproject);
        let mut built: Option<Arc<RepoSession>> = None;
        for _ in 0..OPEN_ATTEMPTS {
            let existing = match &built {
                // 만든 세션을 등록한다. 그사이 같은 작업 트리가 먼저 등록됐으면 그쪽에 합류한다
                Some(session) => match self.register(session) {
                    Ok(()) => {
                        return Ok(self.start_session(session, how, extras));
                    }
                    Err(existing) => existing,
                },
                None => match self.find_by_work_tree(&found.work_tree) {
                    Some(existing) => existing,
                    None => {
                        if let OpenAs::Light { folder } = how {
                            self.check_light_limit(folder, None)?;
                        }
                        built = Some(self.build_session(&found, &sink, how).await?);
                        continue;
                    }
                },
            };
            if let Some(opened) = self.join_existing(&existing, &sink, how, &extras)? {
                return Ok(opened);
            }
            // 합류하려던 세션이 그사이 닫혔다: 다시 본다
        }
        Err(CoreError::Invalid(
            pick(
                "세션 열기와 닫기가 계속 겹쳐 세션을 열지 못했습니다",
                "Could not open the session because opening and closing kept overlapping",
            )
            .into(),
        ))
    }

    /// 상태를 읽어 아직 등록하지 않은 세션을 만든다 (감시·로드 없음). 가벼운 세션의 status 는 저장소
    /// 설정의 명령을 실행하지 않는 쪽으로 읽는다 (`read_status`)
    async fn build_session(
        &self,
        found: &Discovered,
        sink: &Arc<dyn EventSink>,
        how: OpenAs,
    ) -> Result<Arc<RepoSession>, CoreError> {
        let inner = &self.inner;
        let life = match how {
            OpenAs::Tab => Life::Full,
            OpenAs::Light { folder } => Life::Light {
                holders: vec![folder],
            },
        };
        let commit_graph = detect_commit_graph(&found.common_dir);
        let probe = RepoInfo {
            work_tree: found.work_tree.clone(),
            git_dir: found.git_dir.clone(),
            common_dir: found.common_dir.clone(),
            object_format: found.object_format,
            head: mgit_model::HeadState::Unborn {
                branch: String::new(),
            },
            commit_graph,
            shallow: found.common_dir.join("shallow").is_file(),
        };
        // 프로필을 정한 채 읽어야 가벼운 세션의 status 가 fsmonitor 를 끄고 돈다
        let probe_session = RepoSession::with_life(
            SessionId(0),
            probe.clone(),
            RepoState {
                refs: crate::state::RepoRefs {
                    head: probe.head.clone(),
                    labels: Vec::new(),
                    stashes: Vec::new(),
                    worktrees: Vec::new(),
                    remotes: Vec::new(),
                },
                status: Default::default(),
                op: None,
            },
            Arc::clone(sink),
            life.clone(),
        );
        let refs = inner.read_refs(&probe_session).await?;
        let (status, op) = tokio::try_join!(
            inner.read_status(&probe_session, true),
            inner.read_op(&probe_session),
        )?;
        let info = RepoInfo {
            head: refs.head.clone(),
            ..probe
        };
        let state = RepoState { refs, status, op };
        let id = inner.alloc_session_id();
        Ok(Arc::new(RepoSession::with_life(
            id,
            info,
            state,
            Arc::clone(sink),
            life,
        )))
    }

    /// 만든 세션을 등록한다. 같은 작업 트리의 세션이 이미 있으면 등록하지 않고 그 세션을 돌려준다.
    /// 확인과 등록이 같은 쓰기 잠금 안이라 작업 트리당 세션이 하나로 유지된다
    fn register(&self, session: &Arc<RepoSession>) -> Result<(), Arc<RepoSession>> {
        let mut map = self
            .inner
            .sessions
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = map
            .values()
            .find(|s| s.info.work_tree == session.info.work_tree)
        {
            return Err(Arc::clone(existing));
        }
        map.insert(session.id, Arc::clone(session));
        Ok(())
    }

    /// 새로 등록한 세션을 돌린다: 감시는 둘 다, 자동 fetch·그래프 로드는 탭만. 최근 목록은 탭만 남긴다
    fn start_session(
        &self,
        session: &Arc<RepoSession>,
        how: OpenAs,
        (nested_repos, superproject): (Vec<PathBuf>, Option<PathBuf>),
    ) -> OpenedRepo {
        self.start_watch(session);
        if how == OpenAs::Tab {
            self.start_auto_fetch(session);
            let name = session
                .info
                .work_tree
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Err(e) =
                self.inner
                    .store
                    .recent_touch(&session.info.work_tree, RecentKind::Repo, &name)
            {
                tracing::warn!(error = %e, "최근 목록 갱신 실패");
            }
            self.start_graph(session);
        }
        OpenedRepo {
            session: session.id,
            already_open: false,
            info: session.info.clone(),
            state: session.state().clone(),
            nested_repos,
            superproject,
            profile: match how {
                OpenAs::Tab => SessionProfile::Full,
                OpenAs::Light { .. } => SessionProfile::Light,
            },
            promoted: false,
        }
    }

    /// 이미 있는 세션에 합류한다. 닫힌 세션이면 `None`(호출자가 다시 본다).
    /// - 탭으로 열 때 가벼운 세션이면 승격한다: `life` 를 쥔 채 이벤트 대상을 바꾸고, `Full` 로 바꾸고,
    ///   자동 fetch 와 초기 그래프 로드를 띄운다. 잡았던 폴더들의 잡음은 사라진다(폴더 상한 집계에서 빠짐).
    /// - 폴더가 열 때 가벼운 세션이면 잡은 폴더에 더한다(상한 검사). 탭의 세션이면 그대로 빌려 준다(잡지
    ///   않고 상한에 세지 않는다 — 탭이 닫으면 폴더는 다음에 필요할 때 새로 연다).
    fn join_existing(
        &self,
        existing: &Arc<RepoSession>,
        sink: &Arc<dyn EventSink>,
        how: OpenAs,
        (nested_repos, superproject): &(Vec<PathBuf>, Option<PathBuf>),
    ) -> Result<Option<OpenedRepo>, CoreError> {
        // 상한은 이 세션의 `life` 를 잡기 전에 센다 (두 세션의 `life` 를 함께 쥐지 않는다). 같은 폴더의
        // 열기는 폴더 잠금으로 줄을 서고 다른 곳에서는 잡음이 줄기만 하므로 미리 센 값으로 충분하다
        let held = match how {
            OpenAs::Light { folder } => self.light_holds(folder, Some(existing.id)),
            OpenAs::Tab => Vec::new(),
        };
        let (profile, promoted) = {
            let mut life = existing.life();
            match (&mut *life, how) {
                (Life::Closed, _) => return Ok(None),
                (Life::Full, _) => (SessionProfile::Full, false),
                (Life::Light { .. }, OpenAs::Tab) => {
                    existing.switch_sink(Arc::clone(sink));
                    *life = Life::Full;
                    self.start_auto_fetch(existing);
                    self.start_graph(existing);
                    (SessionProfile::Full, true)
                }
                (Life::Light { holders }, OpenAs::Light { folder }) => {
                    if !holders.contains(&folder) {
                        if held.len() >= crate::config::LIGHT_SESSIONS_PER_FOLDER {
                            return Err(CoreError::LightSessionLimit {
                                limit: crate::config::LIGHT_SESSIONS_PER_FOLDER,
                                sessions: held,
                            });
                        }
                        holders.push(folder);
                    }
                    (SessionProfile::Light, false)
                }
            }
        };
        Ok(Some(OpenedRepo {
            session: existing.id,
            already_open: true,
            info: existing.info.clone(),
            state: existing.state().clone(),
            nested_repos: nested_repos.clone(),
            superproject: superproject.clone(),
            profile,
            promoted,
        }))
    }

    /// 초기 그래프 로드를 띄운다 (새 탭·승격 공용). ref 가 하나도 없으면 git 을 부르지 않고 0행으로 끝낸다
    fn start_graph(&self, session: &Arc<RepoSession>) {
        let id = session.id;
        let generation = session.graph().generation;
        let has_commits = {
            let st = session.state();
            st.refs.head.oid().is_some() || !st.refs.labels.is_empty()
        };
        if has_commits {
            let handle = tokio::spawn(run_load(
                Arc::clone(&self.inner),
                Arc::clone(session),
                generation,
                LoadMode::Initial,
            ));
            session.set_load_task(handle);
            return;
        }
        {
            let mut g = session.graph_mut();
            g.layout.finish();
            g.state = LoadState::Finished;
        }
        let sink = &session.sink;
        sink.emit(CoreEvent::GraphLoadStarted {
            session: id,
            generation,
        });
        sink.emit(CoreEvent::GraphFirstChunk {
            session: id,
            generation,
            rows: 0,
        });
        sink.emit(CoreEvent::GraphLoadFinished {
            session: id,
            generation,
            rows: 0,
            lane_count: 0,
            elapsed_ms: 0,
            commit_graph_suggested: false,
        });
    }

    /// 자동 fetch (RM-02): 설정된 간격마다 `fetch --all` 을 조용히 돈다. 실패는 로그만 남긴다
    fn start_auto_fetch(&self, session: &Arc<RepoSession>) {
        let Some(interval) = self.inner.cfg.auto_fetch_interval else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let weak = Arc::downgrade(&self.inner);
        let weak_session = Arc::downgrade(session);
        let task = handle.spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let (Some(core), Some(session)) = (weak.upgrade(), weak_session.upgrade()) else {
                    return;
                };
                if session.state().refs.remotes.is_empty() {
                    continue;
                }
                let wt = session.info.work_tree.clone();
                // 사용자가 누르지 않은 fetch 로 저장소가 지정한 명령을 실행하지 않는다
                if has_repo_ssh_command(core.runner(), &wt).await {
                    continue;
                }
                let before = mgit_git::cmd::remote_refs(core.runner(), &wt)
                    .await
                    .unwrap_or_default();
                // 사용자 작업이 아니므로 undo 항목을 만들지 않는다 (태그를 받으면 ref 가 바뀐다)
                let spec = crate::write::WriteSpec::new(["fetch", "--all", "--prune"])
                    .network()
                    .no_undo();
                if let Err(e) = core.run_write(&session, spec).await {
                    tracing::debug!(session = ?session.id, error = %e, "자동 fetch 실패");
                    continue;
                }
                // 바뀐 원격 추적 ref 가 있으면 알린다 (UX-09)
                let after = mgit_git::cmd::remote_refs(core.runner(), &wt)
                    .await
                    .unwrap_or_default();
                let changed = mgit_git::cmd::changed_remote_refs(&before, &after);
                if !changed.is_empty() {
                    session.sink.emit(CoreEvent::AutoFetched {
                        session: session.id,
                        refs: changed,
                    });
                }
            }
        });
        session.set_auto_fetch(task);
    }

    /// 파일 감시를 건다. 실패해도 세션은 유지한다 (수동 새로고침으로 대체)
    fn start_watch(&self, session: &Arc<RepoSession>) {
        let inner = &self.inner;
        let mut spec = WatchSpec::new(
            session.info.git_dir.clone(),
            session.info.common_dir.clone(),
            inner
                .cfg
                .watch_work_tree
                .then(|| session.info.work_tree.clone()),
        );
        spec.ignore_dirs
            .extend(inner.cfg.extra_ignore_dirs.iter().cloned());
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::warn!("tokio 런타임 밖이라 감시를 걸지 않는다");
            return;
        };
        let weak = Arc::downgrade(inner);
        let weak_session = Arc::downgrade(session);
        let on_change: mgit_model::OnChange = Arc::new(move |changes| {
            let (Some(core), Some(session)) = (weak.upgrade(), weak_session.upgrade()) else {
                return;
            };
            handle.spawn(async move {
                core.on_changes(session, changes).await;
            });
        });
        match inner.watcher.watch(spec, on_change) {
            Ok(h) => session.set_watch(h),
            Err(e) => tracing::warn!(session = ?session.id, error = %e, "감시 시작 실패"),
        }
    }

    /// `[start, start+count)` 범위의 그래프. `count` 는 `max_window_rows` 로 clamp 된다.
    /// 스트리밍 중에도 호출할 수 있다. 가벼운 세션은 `GraphUnavailable`
    pub fn graph_window(
        &self,
        session: SessionId,
        start: u32,
        count: u32,
    ) -> Result<GraphWindow, CoreError> {
        let session = self.inner.get_graph(session)?;
        let count = count.min(self.inner.cfg.max_window_rows);
        let g = session.graph();
        let refs = session.ref_index();
        let hide_remotes = session
            .graph_query
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .hide_remotes;
        let lw = g.layout.window(start, count);
        let head_oid = session.state().refs.head.oid();
        let rows = lw
            .rows
            .iter()
            .enumerate()
            .map(|(i, rl)| {
                let row = lw.start + i as u32;
                let oid = g.table.oid(row);
                let (author_name, author_email) = g.table.author(row);
                // 원격 숨기기는 행 배지에서도 원격 추적 브랜치를 뺀다 (모드 무관)
                let labels = refs
                    .labels_for(&oid)
                    .iter()
                    .filter(|l| !(hide_remotes && matches!(l.kind, RefKind::RemoteBranch { .. })))
                    .cloned()
                    .collect();
                GraphRow {
                    row,
                    oid,
                    parents: g.table.parents(row).to_vec(),
                    author_name: author_name.to_string(),
                    author_email: author_email.to_string(),
                    author_time: g.table.author_time(row),
                    commit_time: g.table.commit_time(row),
                    subject: g.table.subject(row).to_string(),
                    lane: rl.lane,
                    color: rl.color,
                    refs: labels,
                    is_head: head_oid == Some(oid),
                    in_head: g.table.in_head(row),
                    repo: None,
                }
            })
            .collect();
        Ok(GraphWindow {
            generation: g.generation,
            start: lw.start,
            total_rows: g.layout.len() as u32,
            finished: g.state != LoadState::Loading,
            lane_count: lw.lane_count,
            rows,
            segments: lw.segments,
            edges: lw.edges,
            stubs: lw.stubs,
        })
    }

    /// 커밋의 행 번호 (현재 세대 기준). 없으면 `None`. 가벼운 세션은 `GraphUnavailable`
    pub fn find_row(&self, session: SessionId, oid: &Oid) -> Result<Option<u32>, CoreError> {
        Ok(self.inner.get_graph(session)?.graph().table.row_of(oid))
    }

    /// 세션의 로드 상태. 가벼운 세션은 로드가 없으므로 `Loading` 으로 보이지 않게 `GraphUnavailable`
    pub fn load_state(&self, session: SessionId) -> Result<LoadState, CoreError> {
        Ok(self.inner.get_graph(session)?.graph().state.clone())
    }

    /// 세션의 지금 프로필 (`Full`·`Light`)
    pub fn session_profile(&self, session: SessionId) -> Result<SessionProfile, CoreError> {
        self.inner
            .get(session)?
            .profile()
            .ok_or(CoreError::SessionNotFound(session))
    }

    /// 세션의 상태 스냅샷 (ref·status·진행 중 작업)
    pub fn repo_state(&self, session: SessionId) -> Result<RepoState, CoreError> {
        Ok(self.inner.get(session)?.state().clone())
    }

    /// 세션을 다시 읽는다 (사용자 새로고침). 바뀐 것만 이벤트로 온다
    pub async fn refresh(&self, session: SessionId) -> Result<(), CoreError> {
        let s = self.inner.get(session)?;
        self.inner
            .refresh_session(&s, RefreshScope::all(true))
            .await;
        Ok(())
    }

    /// 그래프를 강제로 다시 로드한다 (그림자 로드 → `GraphReloaded`). 가벼운 세션은 `GraphUnavailable`
    pub fn reload_graph(&self, session: SessionId) -> Result<(), CoreError> {
        let s = self.inner.get_graph(session)?;
        self.inner.schedule_reload(&s);
        Ok(())
    }

    /// 쓰기 명령을 큐에서 실행한다 (명세 2.3). S2 이후의 모든 상태 변경이 이 길을 지난다
    pub async fn run_write(
        &self,
        session: SessionId,
        spec: WriteSpec,
    ) -> Result<WriteResult, CoreError> {
        let s = self.inner.get(session)?;
        self.inner.run_write(&s, spec).await
    }

    /// 장시간 명령을 등록하고 `OperationStarted` 를 보낸다. 핸들을 `WriteSpec::with_op` 에 넘긴다
    pub fn begin_operation(
        &self,
        session: SessionId,
        kind: &str,
        label: &str,
    ) -> Result<OpHandle, CoreError> {
        let s = self.inner.get(session)?;
        let handle = self.inner.ops.begin(session);
        s.sink.emit(CoreEvent::OperationStarted {
            session,
            op_id: handle.id,
            kind: kind.to_string(),
            label: label.to_string(),
        });
        Ok(handle)
    }

    /// 등록한 명령을 git 실행 전에 포기한다. `OperationStarted` 뒤에 끝 이벤트가 없으면 진행 표시가 남는다
    pub(crate) fn abandon_operation(
        &self,
        session: SessionId,
        op: Option<&OpHandle>,
        message: &str,
    ) {
        let Some(op) = op else {
            return;
        };
        self.inner.ops.end(op.id);
        if let Ok(s) = self.inner.get(session) {
            s.sink.emit(CoreEvent::OperationFinished {
                session,
                op_id: op.id,
                ok: false,
                cancelled: false,
                message: message.to_string(),
                lock_left: false,
            });
        }
    }

    /// 진행 중 명령을 취소한다. 모르는 id 면 `false`
    pub fn cancel_operation(&self, op_id: u64) -> bool {
        self.inner.ops.cancel(op_id)
    }

    /// 최근 명령 로그 (최신 순, 메모리 링버퍼)
    pub fn command_log_recent(&self, limit: usize) -> Vec<CommandLogRecord> {
        self.inner
            .command_log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }

    /// 세션을 닫는다 (프로필 무관 — 가벼운 세션을 잡은 폴더가 있어도 닫는다). 진행 중인 로드·등록된 명령은
    /// 중단되고 감시가 멈춘다. 이미 닫혔거나 모르는 id 면 `SessionNotFound`. 닫힘으로 바꾸는 것과 목록에서
    /// 빼는 것이 `life` 잠금 한 구간이라 승격·폴더 해제와 겹쳐도 정리는 한 번만 일어난다
    pub fn close_repo(&self, session: SessionId) -> Result<(), CoreError> {
        let s = self.inner.get(session)?;
        {
            let mut life = s.life();
            if *life == Life::Closed {
                return Err(CoreError::SessionNotFound(session));
            }
            self.inner.mark_closed(&mut life, session);
        }
        self.inner.stop_session(&s);
        Ok(())
    }

    /// 열린 세션 목록
    pub fn sessions(&self) -> Vec<SessionId> {
        let mut v: Vec<SessionId> = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .copied()
            .collect();
        v.sort();
        v
    }

    /// 레이아웃 불변식 검사 (테스트·벤치용). 로드가 끝난 뒤에만 의미가 있다
    pub fn verify_layout(&self, session: SessionId) -> Result<(), CoreError> {
        let session = self.inner.get_graph(session)?;
        let g = session.graph();
        let query = session
            .graph_query
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        // 레이아웃에 넘긴 부모(첫 부모만·머지 제외)와 같은 기준으로 검사한다
        let stream: Vec<(Oid, Vec<Oid>)> = (0..g.table.len() as u32)
            .map(|r| {
                (
                    g.table.oid(r),
                    crate::load::layout_parents(&query, g.table.parents(r)).to_vec(),
                )
            })
            .collect();
        mgit_graph::check::check_all(&g.layout, &stream)
            .map_err(|m| CoreError::Git(GitError::Unsupported(m)))
    }

    /// 같은 작업 트리의 세션
    pub(crate) fn find_by_work_tree(&self, work_tree: &Path) -> Option<Arc<RepoSession>> {
        self.inner
            .sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .find(|s| s.info.work_tree == work_tree)
            .cloned()
    }
}

use std::sync::Weak;

impl CoreInner {
    /// 새 세션 id (저장소·폴더 공용)
    pub(crate) fn alloc_session_id(&self) -> SessionId {
        SessionId(self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// 같은 경로의 폴더 세션
    pub(crate) fn folders_find(&self, path: &Path) -> Option<Arc<crate::folder::FolderSession>> {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .find(|f| same_dir(&f.path, path))
            .cloned()
    }

    /// 폴더 세션 조회
    pub(crate) fn folders_get(
        &self,
        id: SessionId,
    ) -> Result<Arc<crate::folder::FolderSession>, CoreError> {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned()
            .ok_or(CoreError::SessionNotFound(id))
    }

    /// 폴더 세션 등록
    pub(crate) fn folders_insert(&self, session: Arc<crate::folder::FolderSession>) {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.id, session);
    }

    /// 폴더 세션 제거
    pub(crate) fn folders_remove(
        &self,
        id: SessionId,
    ) -> Result<Arc<crate::folder::FolderSession>, CoreError> {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id)
            .ok_or(CoreError::SessionNotFound(id))
    }
}

impl Core {
    /// 내부 상태의 `Arc` 사본 (태스크에 넘길 때)
    pub(crate) fn inner_arc(&self) -> Arc<CoreInner> {
        Arc::clone(&self.inner)
    }
}
