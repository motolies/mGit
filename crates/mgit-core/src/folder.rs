//! 멀티 저장소 폴더 세션 (MR-01~04). 저장소 탭과 달리 그래프 없이 하위 저장소의 요약만 다룬다

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::UNIX_EPOCH;

use mgit_git::bulk_reads;
use mgit_git::cmd::{
    Discovered, discover, head_state, in_progress_op, list_refs, list_remotes, scan_repos,
    scanned_repo_status,
};
use mgit_l10n::{pick, tr};
use mgit_model::{
    ChangeKind, FoundRepo, GitError, HeadState, RecentKind, RefLabel, RepoKind, RepoSummary,
    WatchHandle, WatchSpec,
};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::{CoreEvent, EventSink, SessionId};
use crate::folder_timeline::TimelineState;
use crate::fs_tree::FsSpace;
use crate::group::{self, GroupId, GroupMount, GroupView};
use crate::messages;

/// 동시에 상태를 읽는 저장소 수
const SUMMARY_CONCURRENCY: usize = 8;
/// 스캔 깊이 (루트 바로 아래 = 1)
pub const SCAN_DEPTH: u32 = 3;
/// 그룹 열기가 정의 변경과 엇갈려 다시 시도하는 횟수 상한
const GROUP_OPEN_ATTEMPTS: usize = 4;

/// 폴더 세션이 보관하는 저장소 하나: 스캔 결과에 순번을 붙인 것. 열 때와 재스캔할 때 한 번 정한다
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderRepo {
    pub found: FoundRepo,
    /// 저장소 순번. `common_dir` 가 같은 것(워크트리와 원 저장소)은 같은 번호다
    pub ordinal: u16,
    /// 같은 순번 묶음의 대표인지 (독립 저장소 우선). 브랜치 목록·타임라인은 대표만 읽는다
    pub primary: bool,
}

impl FolderRepo {
    /// 저장소 색 번호 (LF-09). 요약·브랜치 목록·타임라인이 모두 이 값을 싣는다
    pub fn color(&self) -> u16 {
        repo_color(self.ordinal)
    }
}

/// 저장소 순번을 색 슬롯으로 유지한다. 실제 색은 전체 목록과 테마에 맞춰 화면에서 배정한다.
pub(crate) fn repo_color(ordinal: u16) -> u16 {
    ordinal
}

/// 저장소 목록에 순번을 매긴다. `common_dirs[i]` 는 `found[i]` 의 `common_dir` 이고, 판별에 실패한
/// 저장소(`None`)는 자기 경로로 따로 묶는다. 순번은 묶음이 처음 나온 차례라 목록이 같으면 늘 같다
fn assign_ordinals(found: Vec<FoundRepo>, common_dirs: &[Option<PathBuf>]) -> Vec<FolderRepo> {
    // 묶음 키 → (순번, 대표의 위치)
    let mut groups: HashMap<PathBuf, (u16, usize)> = HashMap::new();
    let mut out: Vec<FolderRepo> = Vec::with_capacity(found.len());
    for (i, repo) in found.into_iter().enumerate() {
        let key = common_dirs
            .get(i)
            .cloned()
            .flatten()
            .unwrap_or_else(|| repo.path.clone());
        let next = u16::try_from(groups.len()).unwrap_or(u16::MAX);
        let at = out.len();
        let (ordinal, primary_at) = groups.entry(key).or_insert((next, at));
        // 같은 저장소면 독립 저장소 쪽을 대표로 삼는다 (워크트리가 먼저 나왔을 때)
        let takes_over = *primary_at != at
            && out[*primary_at].found.kind == RepoKind::Worktree
            && repo.kind == RepoKind::Standalone;
        if takes_over {
            out[*primary_at].primary = false;
            *primary_at = at;
        }
        out.push(FolderRepo {
            found: repo,
            ordinal: *ordinal,
            primary: *primary_at == at,
        });
    }
    out
}

/// 경로의 마지막 요소 (저장소 이름)
pub(crate) fn repo_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 요청 경로를 스캔 결과와 같은 꼴(정규화)로 맞춘다
pub(crate) fn canonical_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .map(|p| p.canonicalize().unwrap_or_else(|_| p.clone()))
        .collect()
}

/// 목록에서 순번 묶음의 대표만 순번순으로 남긴다
fn groups_of(roster: Vec<FolderRepo>) -> Vec<FolderRepo> {
    let mut groups: Vec<FolderRepo> = roster.into_iter().filter(|r| r.primary).collect();
    groups.sort_by_key(|r| r.ordinal);
    groups
}

/// 목록에서 요청한 경로의 저장소만 고른다. 빈 요청은 전부, 목록에 없는 경로는 오류다
fn select_in(roster: Vec<FolderRepo>, paths: &[PathBuf]) -> Result<Vec<FolderRepo>, CoreError> {
    if paths.is_empty() {
        return Ok(roster);
    }
    let wanted = canonical_paths(paths);
    if let Some(stranger) = wanted
        .iter()
        .find(|p| !roster.iter().any(|r| &r.found.path == *p))
    {
        return Err(CoreError::Invalid(messages::not_folder_repo(stranger)));
    }
    Ok(roster
        .into_iter()
        .filter(|r| wanted.contains(&r.found.path))
        .collect())
}

/// 폴더 세션이 저장소 목록을 얻는 원천. 원천마다 세션 키·경로 포함·파일 경로 공간·재스캔 방법이 다르고, 로스터만
/// 쓰는 폴더 기능(일괄 작업·타임라인·브랜치 목록 등)은 원천을 모른다. 변형을 더하면 원천별로 갈라지는 곳이 모두
/// `match` 의 컴파일 오류로 드러난다
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FolderSource {
    /// 루트 폴더 아래를 `SCAN_DEPTH` 까지 스캔한다 (MR-01). `root` 는 열 때 정규화한 경로이고 바뀌지 않는다
    Scan { root: PathBuf },
    /// 가상 그룹 (MR-13): 정의의 멤버 저장소들이다. 바뀌는 이름·멤버 상태는 세션의 `group` 에 있다
    Group { id: GroupId },
}

/// 그룹 원천의 바뀌는 상태: 이름과 멤버(별칭·경로·지금 상태). 스캔 원천은 비어 있다. 재스캔과 열린 그룹 고치기
/// (M4 — 그 자리 반영)가 `rescan_lock` 안에서 로스터와 같은 구간에 통째로 바꾼다
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct GroupState {
    pub(crate) name: String,
    pub(crate) mounts: Vec<GroupMount>,
}

/// 폴더 세션. `.git` 만 감시하고 변경은 `FolderChanged` 로 알린다
pub struct FolderSession {
    pub id: SessionId,
    /// 저장소 목록의 원천. 세션 동안 바뀌지 않는다
    pub(crate) source: FolderSource,
    /// 저장소 목록과 순번. 재스캔이 통째로 바꾸고 조회는 사본을 떠 간다 (잠금을 쥔 채 git 을 돌리지 않는다)
    repos: RwLock<Vec<FolderRepo>>,
    /// 그룹 원천의 이름·멤버와 지금 상태 (스캔 원천은 비어 있다). 재스캔·그룹 고치기가 `rescan_lock` 안에서 로스터와 같은
    /// 구간에 바꾸고, 파일 경로 공간·포함 검사는 짧게 읽어 사본을 쓴다
    group: RwLock<GroupState>,
    pub(crate) sink: Arc<dyn EventSink>,
    watches: Mutex<Vec<Box<dyn WatchHandle>>>,
    /// 폴더 루트(비재귀) 감시 (MR-10)
    root_watch: Mutex<Option<Box<dyn WatchHandle>>>,
    /// 수동·감시·워크트리 작업의 재스캔을 순서대로 반영한다.
    rescan_lock: tokio::sync::Mutex<()>,
    /// 통합 타임라인 (MR-12). 처음 열 때까지는 비어 있다
    pub(crate) timeline: TimelineState,
    /// 이 폴더의 가벼운 세션 열기를 줄 세운다 (상한 검사와 잡기가 엇갈리지 않게, `light.rs`)
    pub(crate) light_open: tokio::sync::Mutex<()>,
    /// 폴더 자동 fetch 태스크 (`folder_auto_fetch.rs`, 폴더를 닫을 때 중단)
    auto_fetch: Mutex<Option<JoinHandle<()>>>,
}

impl FolderSession {
    /// 아직 감시·자동 fetch 를 걸지 않은 세션을 만든다. 열기와 시험이 같은 초기 상태를 쓴다
    fn new(
        id: SessionId,
        source: FolderSource,
        roster: Vec<FolderRepo>,
        group: GroupState,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        FolderSession {
            id,
            source,
            repos: RwLock::new(roster),
            group: RwLock::new(group),
            sink,
            watches: Mutex::new(Vec::new()),
            root_watch: Mutex::new(None),
            rescan_lock: tokio::sync::Mutex::new(()),
            timeline: TimelineState::default(),
            light_open: tokio::sync::Mutex::new(()),
            auto_fetch: Mutex::new(None),
        }
    }

    /// 세션 키: 폴더 설정 키(`folder:<키>`)와 화면의 탭 키가 쓰는 값. 스캔 원천은 루트 경로를 `display` 로 적은
    /// 문자열이다 — 이미 저장된 설정 키와 같은 꼴이어야 한다. 그룹 원천은 `mgit-group:<id>` 다
    pub fn key(&self) -> String {
        match &self.source {
            FolderSource::Scan { root } => root.display().to_string(),
            FolderSource::Group { id, .. } => group::group_key(id),
        }
    }

    /// 절대 경로 `abs` 가 이 폴더 아래인지 (폴더 자신 포함, 경로 구성요소 단위). 파일 저장·파일 작업 뒤 갱신 알림과
    /// 콘솔 명령의 폴더 찾기가 쓴다. 디스크를 건드리지 않는다 — `abs` 는 호출자가 정한 꼴 그대로 비교한다.
    /// 그룹은 멤버 루트 중 하나 아래인지다 (메모리의 정규화한 멤버 경로만 본다)
    pub(crate) fn contains(&self, abs: &Path) -> bool {
        match &self.source {
            FolderSource::Scan { root } => abs.starts_with(root),
            FolderSource::Group { .. } => self
                .group
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .mounts
                .iter()
                .any(|m| abs.starts_with(&m.path)),
        }
    }

    /// 이 폴더의 파일 경로 공간 (FS-01). 스캔 원천은 루트 폴더 하나, 그룹 원천은 별칭으로 나눈 멤버들이다
    pub(crate) fn fs_space(&self) -> FsSpace {
        match &self.source {
            FolderSource::Scan { root } => FsSpace::Dir(root.clone()),
            FolderSource::Group { .. } => FsSpace::Group(self.mounts()),
        }
    }

    /// 스캔 원천의 루트. 같은 경로의 폴더 찾기와 폴더 루트 감시는 스캔 원천만 한다
    pub(crate) fn scan_root(&self) -> Option<&Path> {
        match &self.source {
            FolderSource::Scan { root } => Some(root),
            FolderSource::Group { .. } => None,
        }
    }

    /// 그룹 원천의 id. 스캔 원천은 None
    pub(crate) fn group_id(&self) -> Option<&GroupId> {
        match &self.source {
            FolderSource::Scan { .. } => None,
            FolderSource::Group { id, .. } => Some(id),
        }
    }

    /// 그룹 멤버와 지금 상태의 사본 (스캔 원천은 비어 있다)
    pub(crate) fn mounts(&self) -> Vec<GroupMount> {
        self.group_state().mounts
    }

    /// 그룹 원천의 이름·멤버 상태의 사본 (스캔 원천은 빈 값)
    fn group_state(&self) -> GroupState {
        self.group
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 그룹 원천의 모습 (이름·멤버 상태). 스캔 원천은 None
    pub(crate) fn group_view(&self) -> Option<GroupView> {
        match &self.source {
            FolderSource::Scan { .. } => None,
            FolderSource::Group { id } => {
                let state = self.group_state();
                Some(GroupView {
                    id: id.clone(),
                    name: state.name,
                    members: state.mounts,
                })
            }
        }
    }

    /// 이미 열린 세션의 열기 응답. 경로는 스캔이면 루트, 그룹이면 세션 키(`mgit-group:<id>`)다
    fn opened(&self) -> FolderOpened {
        let path = match &self.source {
            FolderSource::Scan { root } => root.clone(),
            FolderSource::Group { .. } => PathBuf::from(self.key()),
        };
        FolderOpened {
            session: self.id,
            path,
            repos: self.repos(),
            group: self.group_view(),
        }
    }

    /// 자동 fetch 태스크를 다시 건다: 돌던 태스크를 끊고 `start` 가 만든 태스크를 보관한다(`None` 이면 멈춘 채로 둔다).
    /// 간격 읽기와 보관이 한 잠금 구간이라 폴더 열기와 간격 변경이 겹쳐도 옛 간격의 태스크가 남지 않는다
    /// (`RepoSession::rearm_auto_fetch` 와 같다). `start` 안에서 다른 잠금을 잡지 않는다
    pub(crate) fn rearm_auto_fetch(&self, start: impl FnOnce() -> Option<JoinHandle<()>>) {
        let mut slot = self
            .auto_fetch
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(old) = slot.take() {
            old.abort();
        }
        *slot = start();
    }

    /// 자동 fetch 를 멈춘다
    pub(crate) fn stop_auto_fetch(&self) {
        let handle = self
            .auto_fetch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(handle) = handle {
            handle.abort();
        }
    }

    /// 현재 하위 저장소 목록
    pub fn repos(&self) -> Vec<FoundRepo> {
        self.roster().into_iter().map(|r| r.found).collect()
    }

    /// 순번이 붙은 저장소 목록 (스캔 순서)
    pub fn roster(&self) -> Vec<FolderRepo> {
        self.repos
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 순번 묶음의 대표들 (순번순). 워크트리는 원 저장소에 흡수되고, 목록의 위치가 곧 순번이다
    pub fn groups(&self) -> Vec<FolderRepo> {
        groups_of(self.roster())
    }

    /// 요청한 경로의 저장소들 (FS-11). 비어 있으면 전부다. 이 폴더의 저장소 목록에 없는 경로가
    /// 하나라도 있으면 거부한다 — 폴더 API 로 폴더 밖 경로를 읽게 하지 않는다
    pub fn select(&self, paths: &[PathBuf]) -> Result<Vec<FolderRepo>, CoreError> {
        select_in(self.roster(), paths)
    }

    /// 요청한 경로가 속한 묶음의 대표들 (순번순). 워크트리 경로를 주면 원 저장소가 나온다.
    /// 비어 있으면 전부고, 목록에 없는 경로는 `select` 와 같이 거부한다
    pub fn select_groups(&self, paths: &[PathBuf]) -> Result<Vec<FolderRepo>, CoreError> {
        // 선택과 대표 찾기가 같은 시점의 목록을 봐야 순번이 어긋나지 않는다 (재스캔과 겹칠 때)
        let roster = self.roster();
        let picked: Vec<u16> = select_in(roster.clone(), paths)?
            .iter()
            .map(|r| r.ordinal)
            .collect();
        Ok(groups_of(roster)
            .into_iter()
            .filter(|g| picked.contains(&g.ordinal))
            .collect())
    }

    /// 경로 하나가 속한 묶음의 대표 (FS-11). 워크트리 경로면 원 저장소가 나온다. 이 폴더의 저장소
    /// 목록에 없는 경로(폴더 밖, 폴더 자신, 저장소 안의 하위 폴더 등)는 거부한다 — 폴더 읽기 API 는
    /// git 을 돌리기 전에 이것으로 저장소를 정한다
    pub fn group_of(&self, path: &Path) -> Result<FolderRepo, CoreError> {
        self.select_groups(&[path.to_path_buf()])?
            .pop()
            .ok_or_else(|| CoreError::Invalid(messages::not_folder_repo(path)))
    }

    /// 작업 디렉터리 `cwd` 가 속한 저장소의 대표 경로 (W19 ② 폴더 콘솔). 목록에서 `cwd` 를 품은 가장 깊은 저장소를
    /// 고르고, 그 순번 묶음의 대표(워크트리면 원 저장소)를 돌려준다. 목록 밖이면 None.
    /// 모든 쓰기 명령마다 불리므로 메모리의 목록만 본다 — 경로를 정규화하거나 디스크·git 을 건드리지 않는다 (목록의
    /// 경로는 스캔 때 정규화된 것이고, 코어가 돌리는 명령의 작업 디렉터리는 git 이 알려 준 최상위라 같은 꼴이다)
    pub(crate) fn primary_of(&self, cwd: &Path) -> Option<PathBuf> {
        let roster = self.repos.read().unwrap_or_else(PoisonError::into_inner);
        let hit = roster
            .iter()
            .filter(|r| cwd.starts_with(&r.found.path))
            .max_by_key(|r| r.found.path.components().count())?;
        roster
            .iter()
            .find(|r| r.primary && r.ordinal == hit.ordinal)
            .map(|r| r.found.path.clone())
    }

    /// 감시 핸들을 모두 내려놓는다
    fn stop_watches(&self) {
        self.watches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        self.root_watch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

/// `open_folder`·`open_group` 결과. 그룹이면 `path` 가 세션 키(`mgit-group:<id>`)이고 `group` 에 멤버 상태가 있다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderOpened {
    pub session: SessionId,
    pub path: PathBuf,
    pub repos: Vec<FoundRepo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<GroupView>,
}

/// 파일 수정 시각을 epoch 밀리초로
fn mtime_millis(path: &Path) -> Option<i64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    let d = m.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(d.as_millis()).ok()
}

/// 저장소들을 판별한다 (스캔 결과와 같은 순서). 순번 매기기와 `.git` 감시가 같은 결과를 쓴다
async fn discover_all(inner: &CoreInner, found: &[FoundRepo]) -> Vec<Option<Discovered>> {
    let mut out = Vec::with_capacity(found.len());
    for repo in found {
        out.push(discover(inner.runner(), &repo.path).await.ok());
    }
    out
}

/// 스캔 결과를 판별해 순번을 매긴 목록과 판별 결과를 함께 돌려준다
async fn build_roster(
    inner: &CoreInner,
    found: Vec<FoundRepo>,
) -> (Vec<FolderRepo>, Vec<Option<Discovered>>) {
    let discovered = discover_all(inner, &found).await;
    let common_dirs: Vec<Option<PathBuf>> = discovered
        .iter()
        .map(|d| d.as_ref().map(|d| d.common_dir.clone()))
        .collect();
    (assign_ordinals(found, &common_dirs), discovered)
}

/// 저장소 하나의 HEAD 와 ref 라벨을 읽는다 (브랜치 목록·타임라인 공용). `log` 는 돌리지 않는다
pub(crate) async fn read_head_refs(
    inner: &CoreInner,
    path: &Path,
) -> Result<(Discovered, HeadState, Vec<RefLabel>), GitError> {
    let runner = inner.runner();
    let d = discover(runner, path).await?;
    let head = head_state(runner, &d.work_tree).await?;
    let labels = list_refs(runner, &d.work_tree, &head).await?;
    Ok((d, head, labels))
}

/// 저장소에 등록된 원격 이름 (`git remote -v` 순서). 요약과 일괄 push 가 같은 목록을 본다
pub(crate) async fn remote_names(
    runner: &dyn mgit_model::GitRunner,
    work_tree: &Path,
) -> Result<Vec<String>, GitError> {
    Ok(list_remotes(runner, work_tree)
        .await?
        .into_iter()
        .map(|r| r.name)
        .collect())
}

/// 저장소 하나의 요약을 읽는다. 실패해도 줄은 남긴다 (`error` 에 이유)
async fn summarize(inner: &CoreInner, repo: FolderRepo) -> RepoSummary {
    let color = repo.color();
    let found = repo.found;
    let mut summary = RepoSummary {
        path: found.path.clone(),
        name: repo_name(&found.path),
        kind: found.kind,
        color,
        branch: None,
        detached: false,
        changed: 0,
        conflicted: 0,
        ahead: None,
        behind: None,
        op: None,
        last_fetch: None,
        error: None,
        remotes: None,
        stash_count: 0,
    };
    let runner = inner.runner();
    let d = match discover(runner, &found.path).await {
        Ok(d) => d,
        Err(e) => {
            summary.error = Some(e.to_string());
            return summary;
        }
    };
    match scanned_repo_status(runner, &d.work_tree).await {
        Ok(status) => {
            let s = status.summary();
            summary.changed = s.staged + s.unstaged + s.untracked + s.conflicted;
            summary.conflicted = s.conflicted;
            // `--show-stash` 머리 (`STATUS_ARGS`): stash 수를 따로 읽지 않는다
            summary.stash_count = status.stash_count;
            let b = &status.branch;
            summary.branch = b.head.clone();
            summary.detached = b.head.is_none() && b.oid.is_some();
            if b.upstream.is_some() {
                summary.ahead = Some(b.ahead);
                summary.behind = Some(b.behind);
            } else if b.head.is_some() {
                // 일괄 push 가 새 업스트림을 둘 원격을 미리 보이게 한다. 업스트림이 있는 branch 는 읽지 않는다
                summary.remotes = remote_names(runner, &d.work_tree).await.ok();
            }
        }
        Err(e) => summary.error = Some(e.to_string()),
    }
    summary.op = in_progress_op(runner, &d.git_dir, &d.common_dir, &d.work_tree)
        .await
        .ok()
        .flatten()
        .map(|op| op.kind());
    summary.last_fetch = mtime_millis(&d.git_dir.join("FETCH_HEAD"));
    summary
}

impl Core {
    /// 폴더를 연다 (MR-01): 하위 저장소를 스캔하고 각 `.git` 을 감시하고 자동 fetch 를 건다. 최근 목록에 폴더로
    /// 기록한다. 이미 열린 폴더면 그 세션을 돌려준다 (감시·자동 fetch 는 그대로)
    pub async fn open_folder(
        &self,
        path: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<FolderOpened, CoreError> {
        if !path.is_dir() {
            return Err(CoreError::Invalid(tr!(
                "폴더가 아닙니다: {}",
                "Not a folder: {}",
                path.display()
            )));
        }
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let inner = self.inner_arc();
        if let Some(existing) = inner.folders_find(&path) {
            return Ok(existing.opened());
        }
        let repos = scan_repos(&path, SCAN_DEPTH);
        let (roster, discovered) = build_roster(&inner, repos.clone()).await;
        // 판별하는 동안 같은 폴더가 먼저 열렸을 수 있다. 확인과 등록 사이에는 await 를 두지 않는다
        if let Some(existing) = inner.folders_find(&path) {
            return Ok(existing.opened());
        }
        let id = inner.alloc_session_id();
        let session = Arc::new(FolderSession::new(
            id,
            FolderSource::Scan { root: path.clone() },
            roster,
            GroupState::default(),
            sink,
        ));
        inner.folders_insert(Arc::clone(&session));
        self.watch_folder(&session, &repos, discovered);
        self.watch_root(&session);
        inner.arm_folder_auto_fetch(&session);
        let _ = self
            .store()
            .recent_touch(&path, RecentKind::Folder, &repo_name(&path));
        Ok(FolderOpened {
            session: id,
            path,
            repos,
            group: None,
        })
    }

    /// 가상 그룹을 연다 (MR-13): 멤버 상태를 다시 보고 → 있는 멤버로 로스터를 만들고 → 각 `.git` 을 감시하고 → 자동
    /// fetch 를 걸고 → 마지막 연 시각을 적는다. 폴더 루트 감시·최근 목록은 없다. 이미 열린 그룹이면 그 세션을 돌려준다.
    /// 판별(await)하는 동안 정의가 바뀌었으면 처음부터 다시 하고, 지워졌으면 오류다 — 등록은 그룹 잠금 안에서 정의를 다시
    /// 읽고 하므로 열기와 고치기·지우기가 엇갈려 옛 멤버로 열린 세션이 남지 않는다
    pub async fn open_group(
        &self,
        id: &GroupId,
        sink: Arc<dyn EventSink>,
    ) -> Result<FolderOpened, CoreError> {
        let inner = self.inner_arc();
        for _ in 0..GROUP_OPEN_ATTEMPTS {
            let def = inner.group_def(id)?;
            if let Some(existing) = inner.folders_find_group(id) {
                return Ok(existing.opened());
            }
            let mounts = group::mounts_of(&def.members);
            let repos = group::present_repos(&mounts);
            let (roster, discovered) = build_roster(&inner, repos.clone()).await;
            let registered = {
                let _guard = inner
                    .groups_lock
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let mut groups = group::load_groups(inner.store.as_ref())?;
                let Some(now) = groups.iter_mut().find(|g| g.id == *id) else {
                    return Err(group::not_found(id));
                };
                if now.members != def.members {
                    None
                } else if let Some(existing) = inner.folders_find_group(id) {
                    return Ok(existing.opened());
                } else {
                    let session = Arc::new(FolderSession::new(
                        inner.alloc_session_id(),
                        FolderSource::Group { id: id.clone() },
                        roster,
                        GroupState {
                            name: now.name.clone(),
                            mounts,
                        },
                        Arc::clone(&sink),
                    ));
                    inner.folders_insert(Arc::clone(&session));
                    now.last_opened_at = group::now_millis();
                    if let Err(e) = group::save_groups(inner.store.as_ref(), &groups) {
                        tracing::warn!(error = %e, "그룹을 연 시각을 저장하지 못함");
                    }
                    Some(session)
                }
            };
            let Some(session) = registered else {
                continue;
            };
            self.watch_folder(&session, &repos, discovered);
            inner.arm_folder_auto_fetch(&session);
            return Ok(FolderOpened {
                session: session.id,
                path: PathBuf::from(session.key()),
                repos,
                group: session.group_view(),
            });
        }
        Err(CoreError::Invalid(
            pick(
                "그룹이 바뀌는 중이라 열지 못했습니다. 다시 시도하세요",
                "The group changed while opening. Try again",
            )
            .into(),
        ))
    }

    /// 하위 저장소 전부의 `.git` 을 비재귀로 감시한다. 판별·감시에 실패한 저장소는 건너뛴다.
    /// 변경은 어느 저장소에서 왔는지(`repo`)와 함께 알린다 (PF-02)
    fn watch_folder(
        &self,
        session: &Arc<FolderSession>,
        repos: &[FoundRepo],
        discovered: Vec<Option<Discovered>>,
    ) {
        let inner = self.inner_arc();
        // 저장소 감시만 내린다. 폴더 루트 감시는 재스캔 뒤에도 살아 있어야 한다 (MR-10)
        session
            .watches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let mut handles = Vec::new();
        for (repo, d) in repos.iter().zip(discovered) {
            let Some(d) = d else {
                continue;
            };
            let spec = WatchSpec::new(d.git_dir, d.common_dir, None);
            let weak = Arc::downgrade(session);
            let path = repo.path.clone();
            let on_change: mgit_model::OnChange = Arc::new(move |changes| {
                if let Some(s) = weak.upgrade() {
                    // HEAD·ref·packed-refs 변경이면 타임라인도 다시 읽어야 한다. FETCH_HEAD 만 바뀐 것(받을 것이 없던
                    // fetch)은 요약(마지막 fetch 시각)만 다시 읽으면 된다 (G6)
                    let refs = changes.kinds.iter().any(|k| {
                        matches!(
                            k,
                            ChangeKind::Head | ChangeKind::Refs | ChangeKind::PackedRefs
                        )
                    });
                    s.sink.emit(CoreEvent::FolderChanged {
                        session: s.id,
                        refs,
                        repo: Some(path.clone()),
                    });
                }
            });
            match inner.watcher.watch(spec, on_change) {
                Ok(h) => handles.push(h),
                Err(e) => tracing::warn!(path = %repo.path.display(), error = %e, "폴더 감시 실패"),
            }
        }
        *session
            .watches
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = handles;
    }

    /// 폴더 루트를 비재귀로 감시해 저장소가 생기거나 사라지면 다시 스캔한다 (MR-10). 스캔 원천만 감시한다
    fn watch_root(&self, session: &Arc<FolderSession>) {
        let Some(root) = session.scan_root().map(Path::to_path_buf) else {
            return;
        };
        let inner = self.inner_arc();
        let weak = Arc::downgrade(session);
        let weak_inner = Arc::downgrade(&inner);
        let scan_root = root.clone();
        let on_change: mgit_model::OnChange = Arc::new(move |_changes| {
            let (Some(folder), Some(inner)) = (weak.upgrade(), weak_inner.upgrade()) else {
                return;
            };
            let Ok(handle) = tokio::runtime::Handle::try_current() else {
                return;
            };
            let scan_root = scan_root.clone();
            handle.spawn(async move {
                // 폴더가 막 생겼을 때는 `.git` 이 아직 없을 수 있어 잠시 뒤 한 번 더 본다
                let mut changed = false;
                for delay in [0u64, 1500] {
                    if delay > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    }
                    let before: Vec<PathBuf> = folder.repos().into_iter().map(|r| r.path).collect();
                    let after: Vec<PathBuf> = scan_repos(&scan_root, SCAN_DEPTH)
                        .into_iter()
                        .map(|r| r.path)
                        .collect();
                    if before != after {
                        changed = true;
                        break;
                    }
                }
                if !changed {
                    return;
                }
                let core = Core::from_inner(inner);
                if let Err(e) = core.rescan_folder(folder.id, true).await {
                    tracing::debug!(error = %e, "폴더 재스캔 실패");
                }
            });
        });
        match inner.watcher.watch_dir(root.clone(), on_change) {
            Ok(h) => {
                *session
                    .root_watch
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(h);
            }
            Err(e) => {
                tracing::debug!(path = %root.display(), error = %e, "폴더 루트 감시 없음")
            }
        }
    }

    /// 대시보드 요약 (MR-02). 저장소마다 status·진행 중 작업·마지막 fetch 를 읽는다 (동시 8개).
    /// `repos` 가 비어 있으면 전부, 아니면 그 저장소만 읽는다 (PF-02). 목록에 없는 경로는 거부한다
    pub async fn folder_summaries(
        &self,
        session: SessionId,
        repos: &[PathBuf],
    ) -> Result<Vec<RepoSummary>, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let sem = Arc::new(Semaphore::new(SUMMARY_CONCURRENCY));
        let mut set = JoinSet::new();
        for repo in folder.select(repos)? {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            // 묶음 읽기로 센다: 저장소 수만큼 퍼지는 배경 읽기가 사용자가 누른 읽기의 칸까지 차지하지 않게 (반응성 12)
            set.spawn(bulk_reads(async move {
                let _permit = sem.acquire().await;
                summarize(&inner, repo).await
            }));
        }
        let mut out = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok(s) = r {
                out.push(s);
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// 하위 저장소를 다시 스캔해 순번을 다시 매기고 감시를 다시 건다. 그룹은 스캔 대신 멤버 상태를 다시 본다.
    /// 저장소 집합이 그대로면 순번(색)도 그대로다
    pub async fn folder_rescan(&self, session: SessionId) -> Result<Vec<FoundRepo>, CoreError> {
        self.rescan_folder(session, false).await
    }

    /// 자동 재스캔은 감시와 삭제 알림이 겹쳐도 목록이 바뀐 경우에만 이벤트를 보낸다. 그룹 원천은 정의를 다시 읽지 않고
    /// 지금 멤버(별칭·경로)를 다시 본다 — 사라진 멤버는 `Missing` 으로 남고 로스터에서 빠지며, 멤버 상태는 로스터와
    /// 같은 잠금 구간(`rescan_lock`)에서 바꾸고 `GroupChanged` 로 알린다
    async fn rescan_folder(
        &self,
        session: SessionId,
        only_changed: bool,
    ) -> Result<Vec<FoundRepo>, CoreError> {
        self.rescan_folder_with(session, only_changed, false).await
    }

    /// 열린 그룹에 저장된 정의를 그 자리에서 반영한다 (M4): `rescan_lock` 을 잡은 뒤 정의를 다시 읽어 이름·멤버를 바꾸고
    /// 로스터·감시를 다시 건다. 이벤트는 재스캔과 같다(`FolderRescanned` → `GroupChanged`). 잠금 안에서 그때의 정의를
    /// 읽으므로 고치기가 겹쳐도 마지막에 저장된 정의가 남는다
    pub(crate) async fn reload_group_session(
        &self,
        session: SessionId,
    ) -> Result<Vec<FoundRepo>, CoreError> {
        self.rescan_folder_with(session, false, true).await
    }

    /// 재스캔 공용: 스캔 원천은 폴더를 다시 스캔하고, 그룹 원천은 `from_definition` 이면 저장된 정의의 이름·멤버를,
    /// 아니면 지금 멤버를 다시 본다(정의가 그새 지워졌으면 지금 것). 저장소 목록·멤버 상태·이름은 `rescan_lock` 안의 한
    /// 구간에서 바꾼다. 잠금 순서는 `rescan_lock`(tokio) → 그룹 잠금(정의 읽기, 짧게) → 상태 쓰기 → 감시다
    async fn rescan_folder_with(
        &self,
        session: SessionId,
        only_changed: bool,
        from_definition: bool,
    ) -> Result<Vec<FoundRepo>, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let _scanning = folder.rescan_lock.lock().await;
        let (repos, next) = match &folder.source {
            FolderSource::Scan { root } => (scan_repos(root, SCAN_DEPTH), None),
            FolderSource::Group { id } => {
                let current = folder.group_state();
                let def = if from_definition {
                    inner.group_def(id).ok()
                } else {
                    None
                };
                let (name, members) = match def {
                    Some(def) => (def.name, def.members),
                    None => (
                        current.name,
                        current.mounts.iter().map(GroupMount::member).collect(),
                    ),
                };
                let mounts = group::mounts_of(&members);
                (
                    group::present_repos(&mounts),
                    Some(GroupState { name, mounts }),
                )
            }
        };
        let unchanged =
            repos == folder.repos() && next.as_ref().is_none_or(|g| *g == folder.group_state());
        if only_changed && unchanged {
            return Ok(repos);
        }
        let (roster, discovered) = build_roster(&inner, repos.clone()).await;
        if let Some(next) = next {
            *folder.group.write().unwrap_or_else(PoisonError::into_inner) = next;
        }
        *folder.repos.write().unwrap_or_else(PoisonError::into_inner) = roster;
        self.watch_folder(&folder, &repos, discovered);
        folder.sink.emit(CoreEvent::FolderRescanned {
            session,
            repos: repos.clone(),
        });
        if let Some(group) = folder.group_view() {
            folder.sink.emit(CoreEvent::GroupChanged { session, group });
        }
        // 타임라인을 열어 둔 상태면 저장소 목록 변화를 반영한다
        if folder.timeline.is_opened() {
            self.schedule_timeline_load(&folder);
        }
        Ok(repos)
    }

    /// 삭제된 워크트리를 포함하던 열린 폴더만 재스캔하며 삭제 자체의 성공은 보존한다.
    pub(crate) async fn rescan_removed_worktree(&self, removed: &Path) {
        let folders: Vec<SessionId> = self
            .inner()
            .folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|folder| {
                folder
                    .repos()
                    .iter()
                    .any(|repo| repo.path.starts_with(removed))
            })
            .map(|folder| folder.id)
            .collect();
        for session in folders {
            if let Err(error) = self.rescan_folder(session, true).await
                && !matches!(error, CoreError::SessionNotFound(_))
            {
                tracing::warn!(?session, %error, "워크트리 삭제 후 폴더 재스캔 실패");
            }
        }
    }

    /// 폴더 세션을 닫는다. 안전망으로 이 폴더가 잡은 가벼운 세션의 잡음을 모두 풀어, 아직 가벼운 프로필이고
    /// 다른 폴더가 잡지 않은 세션은 함께 닫는다 (승격된 탭의 세션은 둔다). 실행 중인 등록된 명령이 있어도
    /// 닫는다 — 폴더를 닫은 것이 사용자의 뜻이다. 그 판단(초안·실행 중 작업이면 닫지 않기)은 프런트의
    /// LRU 규칙이고 이것은 누수를 막는 마지막 정리다
    pub fn close_folder(&self, session: SessionId) -> Result<(), CoreError> {
        let folder = self.inner_arc().folders_remove(session)?;
        // 목록에서 뺀 뒤에 멈춘다: 겹쳐 건 루프는 거는 쪽이 등록을 다시 확인해 스스로 멈춘다 (`arm_folder_auto_fetch`)
        folder.stop_auto_fetch();
        folder.stop_watches();
        folder.timeline.abort();
        self.release_folder_holds(session);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 스캔 결과 한 줄
    fn found(path: &str, kind: RepoKind) -> FoundRepo {
        FoundRepo {
            path: PathBuf::from(path),
            kind,
        }
    }

    /// (경로, 순번, 대표 여부) 로 줄인다
    fn brief(roster: &[FolderRepo]) -> Vec<(String, u16, bool)> {
        roster
            .iter()
            .map(|r| (r.found.path.display().to_string(), r.ordinal, r.primary))
            .collect()
    }

    #[test]
    fn worktrees_share_the_ordinal_of_their_repo() {
        let roster = assign_ordinals(
            vec![
                found("/f/a", RepoKind::Standalone),
                found("/f/a-wt", RepoKind::Worktree),
                found("/f/b", RepoKind::Standalone),
            ],
            &[
                Some(PathBuf::from("/f/a/.git")),
                Some(PathBuf::from("/f/a/.git")),
                Some(PathBuf::from("/f/b/.git")),
            ],
        );
        assert_eq!(
            brief(&roster),
            vec![
                ("/f/a".to_string(), 0, true),
                ("/f/a-wt".to_string(), 0, false),
                ("/f/b".to_string(), 1, true),
            ]
        );
        assert_eq!(roster[0].color(), roster[1].color());
    }

    #[test]
    fn standalone_takes_over_from_an_earlier_worktree() {
        // 워크트리가 경로순으로 먼저 나와도 원 저장소가 대표가 되고 순번은 묶음이 처음 나온 차례다
        let roster = assign_ordinals(
            vec![
                found("/f/a-wt", RepoKind::Worktree),
                found("/f/b", RepoKind::Standalone),
                found("/f/z-main", RepoKind::Standalone),
            ],
            &[
                Some(PathBuf::from("/f/z-main/.git")),
                Some(PathBuf::from("/f/b/.git")),
                Some(PathBuf::from("/f/z-main/.git")),
            ],
        );
        assert_eq!(
            brief(&roster),
            vec![
                ("/f/a-wt".to_string(), 0, false),
                ("/f/b".to_string(), 1, true),
                ("/f/z-main".to_string(), 0, true),
            ]
        );
        // 대표만 순번순으로 추리면 위치가 곧 순번이다 (타임라인의 저장소 번호가 이것에 기댄다)
        let groups = groups_of(roster);
        assert_eq!(
            brief(&groups),
            vec![
                ("/f/z-main".to_string(), 0, true),
                ("/f/b".to_string(), 1, true),
            ]
        );
        assert!(
            groups
                .iter()
                .enumerate()
                .all(|(i, g)| usize::from(g.ordinal) == i)
        );
    }

    /// 명령의 작업 디렉터리 → 대표 경로 (W19 ②): 경로 구성요소 단위 접두로 찾고(`/f/ab` 는 `/f/a` 가 아니다), 가장
    /// 깊은 저장소를 고르며, 워크트리는 원 저장소로 간다. 폴더 자신·목록 밖은 없다
    #[test]
    fn primary_of_maps_a_cwd_to_the_group_primary() {
        let roster = assign_ordinals(
            vec![
                found("/f/a", RepoKind::Standalone),
                found("/f/a-wt", RepoKind::Worktree),
                found("/f/b", RepoKind::Standalone),
                found("/f/b/vendor/c", RepoKind::Standalone),
            ],
            &[
                Some(PathBuf::from("/f/a/.git")),
                Some(PathBuf::from("/f/a/.git")),
                Some(PathBuf::from("/f/b/.git")),
                Some(PathBuf::from("/f/b/vendor/c/.git")),
            ],
        );
        let sink: Arc<dyn EventSink> = Arc::new(|_e: CoreEvent| {});
        let folder = FolderSession::new(
            SessionId(1),
            FolderSource::Scan {
                root: PathBuf::from("/f"),
            },
            roster,
            GroupState::default(),
            sink,
        );
        let primary = |cwd: &str| folder.primary_of(Path::new(cwd));
        assert_eq!(primary("/f/a"), Some(PathBuf::from("/f/a")));
        assert_eq!(primary("/f/a/src/deep"), Some(PathBuf::from("/f/a")));
        assert_eq!(primary("/f/a/.git"), Some(PathBuf::from("/f/a")));
        assert_eq!(primary("/f/a-wt"), Some(PathBuf::from("/f/a")));
        assert_eq!(
            primary("/f/b/vendor/c/x"),
            Some(PathBuf::from("/f/b/vendor/c"))
        );
        assert_eq!(primary("/f/b/vendor"), Some(PathBuf::from("/f/b")));
        assert_eq!(primary("/f/ab"), None);
        assert_eq!(primary("/f"), None);
        assert_eq!(primary("/elsewhere/a"), None);
    }

    /// 스캔 원천 세션 (저장소 없음)
    fn scan_session(root: &str) -> FolderSession {
        let sink: Arc<dyn EventSink> = Arc::new(|_e: CoreEvent| {});
        FolderSession::new(
            SessionId(1),
            FolderSource::Scan {
                root: PathBuf::from(root),
            },
            Vec::new(),
            GroupState::default(),
            sink,
        )
    }

    /// 그룹 원천 세션: `/a/api`(있음), `/b/web`(없음) 두 멤버
    #[allow(clippy::unwrap_used)]
    fn group_session() -> FolderSession {
        let sink: Arc<dyn EventSink> = Arc::new(|_e: CoreEvent| {});
        let mount = |alias: &str, path: &str, state| GroupMount {
            alias: alias.into(),
            path: PathBuf::from(path),
            state,
        };
        FolderSession::new(
            SessionId(2),
            FolderSource::Group {
                id: GroupId::parse("g0123456789ab").unwrap(),
            },
            Vec::new(),
            GroupState {
                name: "작업".into(),
                mounts: vec![
                    mount(
                        "api",
                        "/a/api",
                        group::MemberState::Present(RepoKind::Standalone),
                    ),
                    mount("web", "/b/web", group::MemberState::Missing),
                ],
            },
            sink,
        )
    }

    /// 그룹 원천: 키는 `mgit-group:<id>`(폴더 설정 키 `folder:mgit-group:<id>` 의 재료), 포함은 멤버 루트 중 하나 아래
    /// (구성요소 단위, 없는 멤버 포함), 공간은 멤버들, 스캔 루트는 없다(루트 감시·경로로 찾기 없음)
    #[test]
    #[allow(clippy::unwrap_used)]
    fn group_source_key_contains_space_and_no_scan_root() {
        let folder = group_session();
        assert_eq!(folder.key(), "mgit-group:g0123456789ab");
        for (abs, want) in [
            ("/a/api", true),
            ("/a/api/src/x.rs", true),
            ("/b/web/x", true),
            ("/a/apix", false),
            ("/a", false),
            ("/", false),
        ] {
            assert_eq!(folder.contains(Path::new(abs)), want, "{abs}");
        }
        assert_eq!(folder.fs_space(), FsSpace::Group(folder.mounts()));
        assert_eq!(folder.scan_root(), None);
        let view = folder.group_view().unwrap();
        assert_eq!((view.name.as_str(), view.members.len()), ("작업", 2));
        let opened = folder.opened();
        assert_eq!(opened.path, PathBuf::from("mgit-group:g0123456789ab"));
        assert_eq!(opened.group, Some(view));
        assert_eq!(scan_session("/f").group_view(), None);
    }

    /// 스캔 원천의 키는 루트 경로를 `display` 로 적은 그대로다 — 원천을 들이기 전의 설정 키(`folder:<경로>`)·탭 키와
    /// 같은 문자열이어야 저장된 폴더 설정을 그대로 읽는다. 공백·한글·끝 구분자 없는 꼴도 바꾸지 않는다
    #[test]
    fn scan_key_is_the_root_path_as_displayed() {
        for root in ["/f", "/Users/me/작업 폴더", "/a/b.c/d-e"] {
            assert_eq!(
                scan_session(root).key(),
                Path::new(root).display().to_string()
            );
            assert_eq!(scan_session(root).key(), root);
        }
    }

    /// 스캔 원천의 포함은 경로 구성요소 단위 접두다: 루트 자신·하위는 참, 이름만 앞이 같은 형제(`/f/ab` 와 `/f/a`)·
    /// 상위·바깥은 거짓. 디스크를 보지 않는다
    #[test]
    fn scan_contains_is_a_component_prefix_check() {
        let folder = scan_session("/f/a");
        let cases = [
            ("/f/a", true),
            ("/f/a/", true),
            ("/f/a/x", true),
            ("/f/a/x/.git/HEAD", true),
            ("/f/ab", false),
            ("/f/ab/x", false),
            ("/f", false),
            ("/", false),
            ("/elsewhere/f/a", false),
            ("f/a", false),
        ];
        for (abs, want) in cases {
            assert_eq!(folder.contains(Path::new(abs)), want, "{abs}");
        }
    }

    /// 스캔 원천의 파일 경로 공간은 루트 디렉터리 하나이고, 스캔 루트도 그 루트다
    #[test]
    fn scan_space_and_root_are_the_folder_root() {
        let folder = scan_session("/f/a");
        assert_eq!(folder.fs_space(), FsSpace::Dir(PathBuf::from("/f/a")));
        assert_eq!(folder.scan_root(), Some(Path::new("/f/a")));
    }

    #[test]
    fn undiscovered_repos_get_distinct_color_slots() {
        let repos: Vec<FoundRepo> = (0..300)
            .map(|i| found(&format!("/f/r{i:02}"), RepoKind::Standalone))
            .collect();
        let roster = assign_ordinals(repos, &[]);
        assert!(roster.iter().all(|r| r.primary));
        let ordinals: Vec<u16> = roster.iter().map(|r| r.ordinal).collect();
        assert_eq!(ordinals, (0..300).collect::<Vec<u16>>());
        assert_eq!(roster[9].color(), 9);
        assert_eq!(roster[10].color(), 10);
        assert_eq!(roster[11].color(), 11);
        assert_eq!(roster[256].color(), 256);
        assert_eq!(roster[299].color(), 299);
    }
    /// 감시와 삭제 후 재스캔이 겹쳐도 같은 목록 변경은 한 번만 통지한다.
    #[tokio::test]
    #[allow(clippy::unwrap_used)]
    async fn automatic_rescans_coalesce_roster_change_and_manual_rescan_still_notifies() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("repo");
        std::fs::create_dir_all(&path).unwrap();
        let mut repo = mgit_testkit::TestRepo::at(&path);
        repo.git_ok(["init", "-q", "-b", "main"]);
        repo.commit("base");
        let runner = mgit_git::TokioGitRunner::new(mgit_git::RunnerConfig::default())
            .await
            .unwrap();
        let core = Core::new(Arc::new(runner), crate::CoreConfig::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let sink: Arc<dyn EventSink> = Arc::new(move |event: CoreEvent| {
            if matches!(event, CoreEvent::FolderRescanned { .. }) {
                count.fetch_add(1, Ordering::SeqCst);
            }
        });
        let folder = core.open_folder(root.path(), sink).await.unwrap();
        std::fs::remove_dir_all(path).unwrap();
        let (a, b) = tokio::join!(
            core.rescan_folder(folder.session, true),
            core.rescan_folder(folder.session, true)
        );
        assert!(a.unwrap().is_empty());
        assert!(b.unwrap().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        core.folder_rescan(folder.session).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
