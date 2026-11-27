//! 통합 타임라인 (MR-12): 폴더의 모든 저장소 커밋을 한 그래프에 시간순으로 합친다.
//!
//! 저장소마다 `git log --date-order --max-count=<cap>` 을 `run` 으로 받고(스트림은 읽기 permit 을 잡아
//! 저장소가 8개를 넘으면 교착하므로 쓰지 않는다) commit_time 으로 k-way 병합한다. 저장소 안 순서는
//! 그대로 유지되므로 "자식이 부모보다 먼저" 가 지켜진다. 레이아웃 키는 `(저장소, Oid)` 라 같은 커밋을
//! 가진 저장소(클론·포크)가 섞여도 레인이 합쳐지지 않고, 레인 색은 저장소 번호다

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Instant;

use mgit_git::bulk_reads;
use mgit_git::cmd::{AuthorCount, graph_log_request_with, log_authors};
use mgit_git::parse::LogParser;
use mgit_graph::{GraphLayout, LayoutOptions};
use mgit_l10n::pick;
use mgit_model::{
    AuthorList, CommitRecord, EnvProfile, FoundRepo, GraphLayoutPrefs, GraphQuery, GraphRevs,
    GraphSort, HeadState, Oid, RefKind, RefLabel,
};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

use crate::authors::{AUTHORS_TIMEOUT, group_authors, table_counts};
use crate::commit_table::CommitTable;
use crate::config::CoreConfig;
use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::{CoreEvent, SessionId};
use crate::folder::{FolderRepo, FolderSession, read_head_refs, repo_color, repo_name};
use crate::history::{check_filter_pattern, check_query};
use crate::inspect::GraphPlace;
use crate::load::{HashMerge, HeadReach, hash_matches, layout_parents};
use crate::ref_index::RefIndex;
use crate::session::{LoadState, ReloadState};
use crate::window::{GraphRow, GraphWindow};

/// 동시에 로그를 읽는 저장소 수
const READ_CONCURRENCY: usize = 8;

/// 타임라인에 든 저장소 하나. `index` 는 폴더 세션이 매긴 순번이다 (워크트리는 원 저장소에 흡수).
/// 저장소 범위 밖의 저장소도 자리(번호·색)를 지키며 들어 있고, 그때는 아무것도 읽지 않아 커밋·ref 가 비어 있다
pub struct TimelineRepo {
    pub index: u16,
    pub path: PathBuf,
    pub name: String,
    pub color: u16,
    pub head: Option<Oid>,
    pub head_branch: Option<String>,
    pub refs: RefIndex,
    pub truncated: bool,
    pub error: Option<String>,
    /// 저장소 범위에 들었는지 (범위가 "전부"면 모두 참)
    pub in_scope: bool,
}

/// 타임라인 그래프 데이터
pub struct TimelineData {
    pub layout: GraphLayout<(u16, Oid)>,
    pub table: CommitTable,
    pub state: LoadState,
    pub generation: u64,
    pub repos: Vec<TimelineRepo>,
}

impl TimelineData {
    /// 빈 데이터
    fn empty(generation: u64) -> Self {
        TimelineData {
            layout: GraphLayout::new(),
            table: CommitTable::new(),
            state: LoadState::Loading,
            generation,
            repos: Vec::new(),
        }
    }

    /// 경로(묶음 대표의 경로)로 타임라인의 저장소를 찾는다. 번호가 아니라 경로로 찾으므로 재스캔 뒤
    /// 다시 읽기 전의 데이터에서도 같은 저장소를 가리킨다. 타임라인에 없으면 `None`
    fn repo_at(&self, path: &Path) -> Option<&TimelineRepo> {
        self.repos.iter().find(|r| r.path == path)
    }
}

/// 폴더 세션이 소유하는 타임라인 상태. 처음 `folder_timeline_open` 전까지는 아무것도 읽지 않는다
pub struct TimelineState {
    pub data: RwLock<TimelineData>,
    pub query: RwLock<GraphQuery>,
    pub prefs: RwLock<GraphLayoutPrefs>,
    pub reload: Mutex<ReloadState>,
    /// 저장소 범위 (묶음 대표의 경로, 순번순). 비어 있으면 전부다. 질의(`GraphQuery`)와 따로 둔다 —
    /// 질의는 단일 저장소 그래프와 같은 계약이고 범위는 폴더에만 뜻이 있다
    pub(crate) scope: RwLock<Vec<PathBuf>>,
    task: Mutex<Option<JoinHandle<()>>>,
    opened: AtomicBool,
}

impl Default for TimelineState {
    /// 기본 질의는 날짜순 전체, 범위는 전부
    fn default() -> Self {
        TimelineState {
            data: RwLock::new(TimelineData::empty(0)),
            query: RwLock::new(GraphQuery {
                sort: GraphSort::Date,
                ..GraphQuery::default()
            }),
            prefs: RwLock::new(GraphLayoutPrefs::default()),
            reload: Mutex::new(ReloadState::default()),
            scope: RwLock::new(Vec::new()),
            task: Mutex::new(None),
            opened: AtomicBool::new(false),
        }
    }
}

impl TimelineState {
    /// 한 번이라도 열렸는지
    pub fn is_opened(&self) -> bool {
        self.opened.load(Ordering::SeqCst)
    }

    /// 로드 태스크를 중단한다
    pub fn abort(&self) {
        if let Some(h) = self
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            h.abort();
        }
    }

    /// 지금 범위에 든 저장소를 고른다: 저장된 범위를 지금 저장소 목록(`groups`)에 맞춰 줄여 다시 저장하고,
    /// 범위의 저장소가 재스캔으로 모두 사라졌으면 "전부"로 돌아간다. 돌려주는 목록이 비어 있으면 전부다
    pub(crate) fn effective_scope(&self, groups: &[FolderRepo]) -> Vec<PathBuf> {
        let mut scope = self.scope.write().unwrap_or_else(PoisonError::into_inner);
        scope.retain(|p| groups.iter().any(|g| &g.found.path == p));
        scope.clone()
    }

    /// 로드 태스크 핸들을 보관한다 (이전 것은 중단)
    fn set_task(&self, handle: JoinHandle<()>) {
        let mut slot = self.task.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(old) = slot.replace(handle) {
            old.abort();
        }
    }

    /// 커밋 상세의 그래프 필드를 지금 타임라인에서 복사해 꺼낸다 (`repo` 는 묶음 대표의 경로).
    /// - 타임라인에 그 저장소가 없으면(아직 열지 않음, 첫 로드 중, 재스캔 뒤 새로 생긴 저장소) 모두 빈다.
    /// - 저장소는 있지만 지금 질의에 그 커밋이 없으면 행·자식만 빈다. 라벨은 질의와 무관한 그 저장소의
    ///   ref 색인에서 온다(`hide_remotes` 로 거르지 않는다 — 저장소 세션의 상세와 같다).
    /// - 자식은 같은 저장소 안의 자식만이다 (테이블 키가 `(저장소, Oid)`).
    ///
    /// 잠금은 이 함수 안에서만 쥐고 놓는다. 자식 색인은 로드가 끝난 뒤 처음 요청할 때 한 번 만든다
    pub(crate) fn place_of(&self, repo: &Path, oid: &Oid) -> GraphPlace {
        let needs_build = {
            let d = self.data.read().unwrap_or_else(PoisonError::into_inner);
            d.state == LoadState::Finished && !d.table.children_built()
        };
        if needs_build {
            let mut d = self.data.write().unwrap_or_else(PoisonError::into_inner);
            // 그사이 다른 요청이 만들었거나 데이터가 바뀌었을 수 있다
            if d.state == LoadState::Finished && !d.table.children_built() {
                d.table.build_children();
            }
        }
        let d = self.data.read().unwrap_or_else(PoisonError::into_inner);
        let Some(r) = d.repo_at(repo) else {
            return GraphPlace::default();
        };
        let refs = r.refs.labels_for(oid).to_vec();
        match d.table.row_of_in(r.index, oid) {
            Some(row) => GraphPlace {
                row: Some(row),
                children: d
                    .table
                    .children_of(row)
                    .iter()
                    .map(|&c| d.table.oid(c))
                    .collect(),
                refs,
            },
            None => GraphPlace {
                refs,
                ..GraphPlace::default()
            },
        }
    }
}

/// 정보 응답의 저장소 항목. 범위 밖 저장소도 들어 있다 (필터 바의 저장소 목록은 전체를 그린다)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRepoInfo {
    pub index: u16,
    pub name: String,
    pub path: PathBuf,
    pub color: u16,
    pub head_branch: Option<String>,
    /// 저장소당 상한을 넘어 오래된 커밋이 잘렸는지. 필터가 있으면 "걸러진 결과가 상한을 넘었는지"다
    pub truncated: bool,
    pub error: Option<String>,
    /// 저장소 범위에 들었는지. 범위 밖이면 git 을 돌리지 않아 `head_branch` 가 비고 행이 없다
    pub in_scope: bool,
}

/// `folder_timeline_open`/`folder_timeline_info` 응답. 브랜치 목록은 타임라인과 따로 `folder_branches` 가 준다 (PF-03)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineInfo {
    pub generation: u64,
    pub rows: u32,
    pub finished: bool,
    pub max_per_repo: u32,
    pub repos: Vec<TimelineRepoInfo>,
    /// 범위 밖 저장소가 하나라도 있는지 (거짓이면 "전부" — 범위를 비웠거나 모든 저장소를 골랐다).
    /// 저장소마다의 포함 여부는 `repos[].in_scope`
    pub scoped: bool,
}

/// 저장소 하나의 로드 결과
struct RepoLoad {
    found: FoundRepo,
    records: Vec<CommitRecord>,
    head: HeadState,
    labels: Vec<RefLabel>,
    truncated: bool,
    error: Option<String>,
    in_scope: bool,
}

impl RepoLoad {
    /// 아직 아무것도 읽지 않은 결과 (커밋·ref 없음)
    fn empty(found: FoundRepo) -> Self {
        RepoLoad {
            found,
            records: Vec::new(),
            head: HeadState::Unborn {
                branch: String::new(),
            },
            labels: Vec::new(),
            truncated: false,
            error: None,
            in_scope: true,
        }
    }
}

/// 저장소 하나의 HEAD·ref·로그를 읽는다. 질의의 ref 가 없는 저장소는 커밋 없이 돌려준다
async fn load_repo(inner: &CoreInner, found: FoundRepo, query: &GraphQuery, cap: u32) -> RepoLoad {
    let runner = inner.runner();
    let mut load = RepoLoad::empty(found);
    let d = match read_head_refs(inner, &load.found.path).await {
        Ok((d, head, labels)) => {
            load.head = head;
            load.labels = labels;
            d
        }
        Err(e) => {
            load.error = Some(e.to_string());
            return load;
        }
    };
    let has = |name: &str| {
        load.labels
            .iter()
            .any(|l| l.short_name == name || l.full_name == name)
    };
    // solo/branches 는 이 저장소에 있는 ref 만 넘긴다. 하나도 없으면 건너뛴다
    let query = match &query.revs {
        GraphRevs::All => query.clone(),
        GraphRevs::Solo { name } => {
            if !has(name) {
                return load;
            }
            query.clone()
        }
        GraphRevs::Branches { names } => {
            let present: Vec<String> = names.iter().filter(|n| has(n)).cloned().collect();
            if present.is_empty() {
                return load;
            }
            GraphQuery {
                revs: GraphRevs::Branches { names: present },
                ..query.clone()
            }
        }
        // 저장소마다 자기 HEAD (detached 포함). 커밋이 없는 저장소(unborn)는 건너뛴다
        GraphRevs::Head => {
            if load.head.oid().is_none() {
                return load;
            }
            query.clone()
        }
    };
    // 상한보다 하나 더 받아, 넘쳤을 때만 잘림으로 표시하고 넘친 하나는 버린다
    // (커밋 수가 상한과 정확히 같은 저장소를 잘렸다고 하지 않는다). 필터가 있으면 `--max-count` 는 걸러진
    // 커밋을 세므로 잘림은 "걸러진 결과가 상한을 넘었다"는 뜻이다
    let over = Some(cap.saturating_add(1));
    let overrides = &inner.cfg.git_config_overrides;
    let req = graph_log_request_with(&d.work_tree, overrides, &query, over)
        .with_env(EnvProfile::ReadInteractive);
    let out = match runner.run(req).await {
        Ok(o) => o,
        Err(e) => {
            load.error = Some(e.to_string());
            return load;
        }
    };
    if !out.exit.success() {
        load.error = Some(out.exit.stderr.trim().to_string());
        return load;
    }
    let mut parser = LogParser::new();
    let records = match parser
        .feed(&out.stdout)
        .and_then(|r| parser.finish().map(|()| r))
    {
        Ok(records) => records,
        Err(e) => {
            load.error = Some(e.to_string());
            return load;
        }
    };
    // 텍스트가 해시 접두로 보이면 그 해시의 커밋(같은 범위의 최신 상한 개 안에서)을 끼운다
    let extra = match hash_matches(runner, &d.work_tree, overrides, &query, over, false).await {
        Ok(extra) => extra,
        Err(e) => {
            load.error = Some(e.to_string());
            return load;
        }
    };
    let mut records = HashMerge::merge_all(records, extra);
    load.truncated = records.len() > cap as usize;
    records.truncate(cap as usize);
    load.records = records;
    load
}

/// 저장소별 로드 결과를 commit_time 내림차순으로 k-way 병합해 테이블·레이아웃에 넣는다.
/// 동률은 저장소 번호가 낮은 쪽이 먼저라 결정적이다
fn merge_loads(
    loads: Vec<RepoLoad>,
    query: &GraphQuery,
    opts: LayoutOptions<(u16, Oid)>,
    generation: u64,
) -> TimelineData {
    let mut data = TimelineData::empty(generation);
    data.layout = GraphLayout::with_options(opts);
    let mut heads = vec![0usize; loads.len()];
    let mut reach: Vec<HeadReach> = loads.iter().map(|l| HeadReach::new(l.head.oid())).collect();
    loop {
        let mut best: Option<(usize, i64)> = None;
        for (i, l) in loads.iter().enumerate() {
            if let Some(rec) = l.records.get(heads[i]) {
                match best {
                    Some((_, t)) if t >= rec.commit_time => {}
                    _ => best = Some((i, rec.commit_time)),
                }
            }
        }
        let Some((i, _)) = best else {
            break;
        };
        let rec = &loads[i].records[heads[i]];
        heads[i] += 1;
        let idx = i as u16;
        let in_head = reach[i].visit(&rec.oid, &rec.parents);
        data.table.push_in(idx, rec, in_head);
        let parents: Vec<(u16, Oid)> = layout_parents(query, &rec.parents)
            .iter()
            .map(|p| (idx, *p))
            .collect();
        data.layout.push((idx, rec.oid), &parents);
    }
    data.layout.finish();
    // 도달성을 알 수 없는 저장소는 흐리지 않는다
    for (i, r) in reach.iter().enumerate() {
        if r.unknown(query) {
            data.table.mark_in_head(i as u16);
        }
    }
    data.repos = loads
        .into_iter()
        .enumerate()
        .map(|(i, l)| TimelineRepo {
            index: i as u16,
            name: repo_name(&l.found.path),
            path: l.found.path,
            color: repo_color(i as u16),
            head: l.head.oid(),
            // 범위 밖 저장소는 읽지 않았으므로 현재 브랜치를 모른다 (빈 자리값의 빈 이름을 내보내지 않는다)
            head_branch: l
                .head
                .branch()
                .filter(|_| l.in_scope)
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string()),
            refs: RefIndex::new(l.labels),
            truncated: l.truncated,
            error: l.error,
            in_scope: l.in_scope,
        })
        .collect();
    data.state = LoadState::Finished;
    data
}

/// 레인 색 = 저장소 색. 키의 저장소 번호가 폴더 세션의 순번이라 요약·브랜치 목록의 색과 같다
fn repo_lane_color(key: &(u16, Oid)) -> u16 {
    repo_color(key.0)
}

/// 타임라인 레이아웃 옵션: 고정·ref 색 없음, 레인 색 = 저장소, 긴 엣지 접기는 설정대로
fn timeline_options(prefs: &GraphLayoutPrefs, cfg: &CoreConfig) -> LayoutOptions<(u16, Oid)> {
    LayoutOptions {
        pin: None,
        ref_colors: HashMap::new(),
        collapse_long_edges: prefs
            .collapse_long_edges
            .then_some(cfg.graph_long_edge_rows),
        lane_color: Some(repo_lane_color),
    }
}

/// 전체 로드: 폴더 세션이 순번을 매겨 둔 저장소(묶음의 대표)별 읽기(동시 8개) → 병합.
/// 목록의 위치가 순번이므로 병합이 붙이는 저장소 번호와 색이 요약·브랜치 목록과 같다.
/// 저장소 범위 밖의 저장소는 git 을 하나도 돌리지 않고 빈 자리로 둔다 (번호·색은 그대로)
async fn load_timeline(
    inner: &Arc<CoreInner>,
    folder: &Arc<FolderSession>,
    query: &GraphQuery,
    prefs: &GraphLayoutPrefs,
    generation: u64,
) -> TimelineData {
    let cap = inner.cfg.timeline_max_per_repo.max(1);
    let sem = Arc::new(Semaphore::new(READ_CONCURRENCY));
    let groups = folder.groups();
    let scope = folder.timeline.effective_scope(&groups);
    let in_scope = |repo: &FolderRepo| scope.is_empty() || scope.contains(&repo.found.path);
    let mut set = JoinSet::new();
    for (i, repo) in groups.iter().enumerate() {
        if !in_scope(repo) {
            continue;
        }
        let inner = Arc::clone(inner);
        let sem = Arc::clone(&sem);
        let query = query.clone();
        let found = repo.found.clone();
        // 묶음 읽기로 센다: 저장소 수만큼 퍼지는 배경 읽기가 사용자가 누른 읽기의 칸까지 차지하지 않게 (반응성 12)
        set.spawn(bulk_reads(async move {
            let _permit = sem.acquire().await;
            (i, load_repo(&inner, found, &query, cap).await)
        }));
    }
    let mut slots: Vec<Option<RepoLoad>> = groups.iter().map(|_| None).collect();
    while let Some(r) = set.join_next().await {
        if let Ok((i, load)) = r {
            slots[i] = Some(load);
        }
    }
    // 읽기 태스크가 죽은 저장소·범위 밖 저장소도 자리를 지킨다. 빠지면 뒤 저장소의 번호(= 순번)와 색이 밀린다
    let loads: Vec<RepoLoad> = slots
        .into_iter()
        .zip(groups)
        .map(|(load, repo)| match load {
            Some(load) => load,
            None if !in_scope(&repo) => RepoLoad {
                in_scope: false,
                ..RepoLoad::empty(repo.found)
            },
            None => RepoLoad {
                error: Some(
                    pick(
                        "타임라인 읽기가 중단되었습니다",
                        "Reading the timeline was interrupted",
                    )
                    .into(),
                ),
                ..RepoLoad::empty(repo.found)
            },
        })
        .collect();
    merge_loads(
        loads,
        query,
        timeline_options(prefs, &inner.cfg),
        generation,
    )
}

/// 로드 태스크 본체. 끝나면 데이터를 통째로 바꾸고 폴더 세션 id 로 그래프 이벤트를 보낸다
async fn run_timeline_load(inner: Arc<CoreInner>, folder: Arc<FolderSession>, generation: u64) {
    let id = folder.id;
    let initial = generation == 1;
    if initial {
        folder.sink.emit(CoreEvent::GraphLoadStarted {
            session: id,
            generation,
        });
    }
    let started = Instant::now();
    let (query, prefs) = {
        let t = &folder.timeline;
        (
            t.query
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
            *t.prefs.read().unwrap_or_else(PoisonError::into_inner),
        )
    };
    let data = load_timeline(&inner, &folder, &query, &prefs, generation).await;
    let (rows, lane_count) = (data.layout.len() as u32, data.layout.lane_count());
    *folder
        .timeline
        .data
        .write()
        .unwrap_or_else(PoisonError::into_inner) = data;
    if initial {
        folder.sink.emit(CoreEvent::GraphLoadFinished {
            session: id,
            generation,
            rows,
            lane_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
            commit_graph_suggested: false,
        });
    } else {
        folder.sink.emit(CoreEvent::GraphReloaded {
            session: id,
            generation,
            rows,
            lane_count,
        });
    }
    let again = {
        let mut r = folder
            .timeline
            .reload
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        r.running = false;
        std::mem::take(&mut r.pending)
    };
    if again {
        Core::from_inner(inner).schedule_timeline_load(&folder);
    }
}

/// 정보 응답을 만든다
fn info_of(folder: &FolderSession, cfg: &CoreConfig) -> TimelineInfo {
    let d = folder
        .timeline
        .data
        .read()
        .unwrap_or_else(PoisonError::into_inner);
    TimelineInfo {
        generation: d.generation,
        rows: d.layout.len() as u32,
        finished: d.state != LoadState::Loading,
        max_per_repo: cfg.timeline_max_per_repo,
        repos: d
            .repos
            .iter()
            .map(|r| TimelineRepoInfo {
                index: r.index,
                name: r.name.clone(),
                path: r.path.clone(),
                color: r.color,
                head_branch: r.head_branch.clone(),
                truncated: r.truncated,
                error: r.error.clone(),
                in_scope: r.in_scope,
            })
            .collect(),
        // 데이터를 만든 범위를 따른다 (범위를 바꾼 직후 재로드가 끝나기 전에는 이전 범위)
        scoped: d.repos.iter().any(|r| !r.in_scope),
    }
}

impl Core {
    /// 타임라인 로드를 예약한다 (돌고 있으면 끝난 뒤 한 번 더)
    pub(crate) fn schedule_timeline_load(&self, folder: &Arc<FolderSession>) {
        let generation = {
            let mut r = folder
                .timeline
                .reload
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if r.running {
                r.pending = true;
                return;
            }
            r.running = true;
            folder
                .timeline
                .data
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .generation
                + 1
        };
        let inner = self.inner_arc();
        let handle = tokio::spawn(run_timeline_load(inner, Arc::clone(folder), generation));
        folder.timeline.set_task(handle);
    }

    /// 타임라인을 연다 (MR-12). 처음이면 로드를 시작하고, 이후엔 현재 정보만 돌려준다
    pub fn folder_timeline_open(&self, session: SessionId) -> Result<TimelineInfo, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        if !folder.timeline.opened.swap(true, Ordering::SeqCst) {
            self.schedule_timeline_load(&folder);
        }
        Ok(info_of(&folder, &inner.cfg))
    }

    /// 타임라인 정보 (저장소 목록, 행 수)
    pub fn folder_timeline_info(&self, session: SessionId) -> Result<TimelineInfo, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        Ok(info_of(&folder, &inner.cfg))
    }

    /// 타임라인 다시 읽기
    pub fn folder_timeline_reload(&self, session: SessionId) -> Result<(), CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        folder.timeline.opened.store(true, Ordering::SeqCst);
        self.schedule_timeline_load(&folder);
        Ok(())
    }

    /// 타임라인 질의 변경 (저장소 모두에 같은 범위·필터). 다시 읽는다. 정규식이 잘못됐으면 질의를 바꾸지 않고
    /// `InvalidFilter` 를 돌려준다 (범위의 첫 저장소에서 git 이 패턴을 컴파일해 본다 — 같은 git 이라 모든
    /// 저장소에서 결과가 같다)
    pub async fn folder_timeline_query_set(
        &self,
        session: SessionId,
        query: GraphQuery,
    ) -> Result<(), CoreError> {
        check_query(&query)?;
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let groups = folder.groups();
        let scope = folder.timeline.effective_scope(&groups);
        if let Some(repo) = groups
            .iter()
            .find(|g| scope.is_empty() || scope.contains(&g.found.path))
        {
            check_filter_pattern(inner.runner(), &repo.found.path, &query.filter).await?;
        }
        *folder
            .timeline
            .query
            .write()
            .unwrap_or_else(PoisonError::into_inner) = query;
        self.folder_timeline_reload(session)
    }

    /// 타임라인의 저장소 범위를 바꾼다 ("이 저장소들만 보기"). 다시 읽는다. `repos` 는 이 폴더의 저장소 경로이고
    /// 워크트리 경로는 원 저장소로 바뀐다. 비어 있으면 전부, 목록에 없는 경로가 있으면 범위를 바꾸지 않고
    /// 거부한다 (FS-11). 범위 밖 저장소는 번호·색을 그대로 둔 채 행만 빠지고 git 을 돌리지 않는다.
    /// 재스캔으로 범위의 저장소가 사라지면 다음 로드에서 범위에서 빠지고, 모두 사라지면 전부로 돌아간다
    pub fn folder_timeline_scope_set(
        &self,
        session: SessionId,
        repos: &[PathBuf],
    ) -> Result<(), CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let scope: Vec<PathBuf> = if repos.is_empty() {
            Vec::new()
        } else {
            folder
                .select_groups(repos)?
                .into_iter()
                .map(|g| g.found.path)
                .collect()
        };
        *folder
            .timeline
            .scope
            .write()
            .unwrap_or_else(PoisonError::into_inner) = scope;
        self.folder_timeline_reload(session)
    }

    /// 타임라인 레이아웃 설정 변경. 다시 읽는다
    pub fn folder_timeline_prefs_set(
        &self,
        session: SessionId,
        prefs: GraphLayoutPrefs,
    ) -> Result<(), CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        *folder
            .timeline
            .prefs
            .write()
            .unwrap_or_else(PoisonError::into_inner) = prefs;
        self.folder_timeline_reload(session)
    }

    /// 타임라인 그래프 범위. 행마다 저장소 번호·그 저장소의 배지·HEAD 가 붙는다
    pub fn folder_timeline_window(
        &self,
        session: SessionId,
        start: u32,
        count: u32,
    ) -> Result<GraphWindow, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let count = count.min(inner.cfg.max_window_rows);
        let hide_remotes = folder
            .timeline
            .query
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .hide_remotes;
        let d = folder
            .timeline
            .data
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let lw = d.layout.window(start, count);
        let rows = lw
            .rows
            .iter()
            .enumerate()
            .map(|(i, rl)| {
                let row = lw.start + i as u32;
                let oid = d.table.oid(row);
                let repo = d.table.repo(row);
                let r = d.repos.get(repo as usize);
                let (author_name, author_email) = d.table.author(row);
                let refs = r
                    .map(|r| {
                        r.refs
                            .labels_for(&oid)
                            .iter()
                            .filter(|l| {
                                !(hide_remotes && matches!(l.kind, RefKind::RemoteBranch { .. }))
                            })
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                GraphRow {
                    row,
                    oid,
                    parents: d.table.parents(row).to_vec(),
                    author_name: author_name.to_string(),
                    author_email: author_email.to_string(),
                    author_time: d.table.author_time(row),
                    commit_time: d.table.commit_time(row),
                    subject: d.table.subject(row).to_string(),
                    lane: rl.lane,
                    color: rl.color,
                    refs,
                    is_head: r.is_some_and(|r| r.head == Some(oid)),
                    in_head: d.table.in_head(row),
                    repo: Some(repo),
                }
            })
            .collect();
        Ok(GraphWindow {
            generation: d.generation,
            start: lw.start,
            total_rows: d.layout.len() as u32,
            finished: d.state != LoadState::Loading,
            lane_count: lw.lane_count,
            rows,
            segments: lw.segments,
            edges: lw.edges,
            stubs: lw.stubs,
        })
    }

    /// 폴더 타임라인의 작성자 후보: 저장소 범위에 든 저장소마다 필터 없는 타임라인이 보여 줄 커밋(최신
    /// `timeline_max_per_repo` 개, 모든 ref)의 작성자를 합친다. 지금 타임라인이 그 범위를 다 담고 있으면(필터·
    /// 범위 질의 없이 읽혔고 재로드 중이 아니며 그 저장소를 범위 안에서 오류 없이 읽음) 테이블에서 세고, 아니면
    /// 그 저장소만 `git log --all --date-order --max-count` 를 돈다 (동시 8개, 저장소마다 시간 상한 10초 —
    /// 넘은 저장소는 빠지고 `timed_out`). 실패한 저장소도 빠진다
    pub async fn folder_timeline_authors(
        &self,
        session: SessionId,
    ) -> Result<AuthorList, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let groups = folder.groups();
        let scope = folder.timeline.effective_scope(&groups);
        let cap = inner.cfg.timeline_max_per_repo.max(1);
        let mut counts: Vec<AuthorCount> = Vec::new();
        let mut need_git: Vec<PathBuf> = Vec::new();
        {
            let t = &folder.timeline;
            let covered = t
                .query
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .covers_all_commits();
            let reloading = t
                .reload
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .running;
            let d = t.data.read().unwrap_or_else(PoisonError::into_inner);
            let table_ok = covered && !reloading && d.state == LoadState::Finished;
            for g in &groups {
                let path = &g.found.path;
                if !(scope.is_empty() || scope.contains(path)) {
                    continue;
                }
                match d.repo_at(path) {
                    Some(r) if table_ok && r.in_scope && r.error.is_none() => {
                        counts.extend(table_counts(&d.table, Some(r.index)));
                    }
                    _ => need_git.push(path.clone()),
                }
            }
        }
        let sem = Arc::new(Semaphore::new(READ_CONCURRENCY));
        let mut set = JoinSet::new();
        for path in need_git {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            // 묶음 읽기로 센다: 저장소 수만큼 퍼지는 배경 읽기가 사용자가 누른 읽기의 칸까지 차지하지 않게 (반응성 12)
            set.spawn(bulk_reads(async move {
                let _permit = sem.acquire().await;
                log_authors(
                    inner.runner(),
                    &path,
                    &inner.cfg.git_config_overrides,
                    Some(cap),
                    AUTHORS_TIMEOUT,
                )
                .await
            }));
        }
        let mut timed_out = false;
        while let Some(r) = set.join_next().await {
            match r {
                Ok(Ok(Some(found))) => counts.extend(found),
                Ok(Ok(None)) => timed_out = true,
                // 읽지 못한 저장소는 후보에서 빠진다 (타임라인 자체가 그 저장소의 오류를 보여 준다)
                Ok(Err(_)) | Err(_) => {}
            }
        }
        Ok(group_authors(counts, timed_out))
    }

    /// 타임라인에서 (저장소, 커밋) 의 행 번호. 저장소 번호는 지금 타임라인의 번호다 — 화면에 떠 있는
    /// 동안의 스크롤 기준처럼 짧게 쓰는 값에만 쓴다 (재스캔으로 저장소 집합이 바뀌면 밀린다)
    pub fn folder_timeline_find_row(
        &self,
        session: SessionId,
        repo: u16,
        oid: &Oid,
    ) -> Result<Option<u32>, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let d = folder
            .timeline
            .data
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        Ok(d.table.row_of_in(repo, oid))
    }

    /// 타임라인에서 (저장소 경로, 커밋) 의 행 번호. 경로는 번호와 달리 재스캔으로 저장소 집합이 바뀌어도
    /// 같은 저장소를 가리킨다. 워크트리 경로는 원 저장소의 행을 찾는다. 이 폴더의 저장소가 아닌 경로는
    /// 거부한다 (FS-11). 타임라인에 그 저장소나 커밋이 없으면 `None`
    pub fn folder_timeline_find_row_at(
        &self,
        session: SessionId,
        repo: &Path,
        oid: &Oid,
    ) -> Result<Option<u32>, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let primary = folder.group_of(repo)?;
        let d = folder
            .timeline
            .data
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        Ok(d.repo_at(&primary.found.path)
            .and_then(|r| d.table.row_of_in(r.index, oid)))
    }
}
