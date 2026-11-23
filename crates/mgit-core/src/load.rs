use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Instant;

use mgit_git::cmd::{graph_log_request, graph_log_request_with, rev_resolves};
use mgit_git::parse::LogParser;
use mgit_graph::{GraphLayout, LayoutOptions, branch_color};
use mgit_model::{
    CommitRecord, EnvProfile, GitError, GitRunner, GraphLayoutPrefs, GraphQuery, GraphRevs, Oid,
    RefKind, TextFilter,
};

use crate::config::CoreConfig;
use crate::core::CoreInner;
use crate::events::{CoreEvent, EventSink};
use crate::session::{GraphData, LoadState, RepoSession};
use crate::state::RepoRefs;

/// 로드 종류
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadMode {
    /// 처음 열 때: 세션 그래프를 직접 채우고 Started/FirstChunk/Progress/Finished 를 보낸다
    Initial,
    /// 외부 변경 뒤: 그림자 그래프를 채우고 끝나면 교체(`GraphReloaded`)한다
    Reload,
}

/// 레이아웃에 넘길 부모 목록: 첫 부모만(`--first-parent`) 또는 없음(목록 모드: 머지 제외, 텍스트·작성자 필터)
pub fn layout_parents<'a>(query: &GraphQuery, parents: &'a [Oid]) -> &'a [Oid] {
    if query.list_mode() {
        &[]
    } else if query.first_parent {
        &parents[..parents.len().min(1)]
    } else {
        parents
    }
}

/// 브랜치 라벨의 색 키: 로컬은 짧은 이름, 원격은 리모트 접두사를 뗀 이름 (같은 브랜치는 같은 색)
fn color_key(label: &mgit_model::RefLabel) -> Option<String> {
    match &label.kind {
        RefKind::LocalBranch => Some(label.short_name.clone()),
        RefKind::RemoteBranch { remote } => Some(
            label
                .short_name
                .strip_prefix(&format!("{remote}/"))
                .unwrap_or(&label.short_name)
                .to_string(),
        ),
        RefKind::Tag { .. } | RefKind::Stash => None,
    }
}

/// 짧은 브랜치 이름 (`refs/heads/x` → `x`)
fn short_branch(full: &str) -> &str {
    full.strip_prefix("refs/heads/").unwrap_or(full)
}

/// 질의·설정·ref 로 레이아웃 옵션을 만든다.
/// 고정은 HEAD 브랜치 팁이 질의에 확실히 포함될 때만(전체, 또는 그 이름을 고른 경우; 경로 범위·머지 제외·
/// 커밋 필터는 제외 — 날짜 상한이 HEAD 를 빼면 고정 레인이 빈 채로 남는다)
pub fn layout_options(
    refs: &RepoRefs,
    query: &GraphQuery,
    prefs: &GraphLayoutPrefs,
    cfg: &CoreConfig,
) -> LayoutOptions<Oid> {
    let head_branch = refs.head.branch();
    let names_include_head = |names: &[String]| {
        head_branch.is_some_and(|b| {
            let short = short_branch(b);
            names.iter().any(|n| n == b || n == short)
        })
    };
    let included = query.path_scope.is_empty()
        && !query.list_mode()
        && query.filter.is_empty()
        && match &query.revs {
            GraphRevs::All | GraphRevs::Head => true,
            GraphRevs::Branches { names } => names_include_head(names),
            GraphRevs::Solo { name } => names_include_head(std::slice::from_ref(name)),
        };
    let pin = if prefs.pin_head && included && head_branch.is_some() {
        refs.head.oid()
    } else {
        None
    };

    let mut ref_colors: HashMap<Oid, u8> = HashMap::new();
    if prefs.ref_colors {
        // 커밋마다 우선순위(현재 → 로컬 → 원격, 이름순)가 가장 높은 브랜치 하나의 색
        let mut best: HashMap<Oid, (u8, String)> = HashMap::new();
        for l in &refs.labels {
            if query.hide_remotes && matches!(l.kind, RefKind::RemoteBranch { .. }) {
                continue;
            }
            let Some(key) = color_key(l) else {
                continue;
            };
            let order = match (&l.kind, l.is_current) {
                (RefKind::LocalBranch, true) => 0,
                (RefKind::LocalBranch, false) => 1,
                _ => 2,
            };
            let cand = (order, key);
            match best.get(&l.target) {
                Some(cur) if *cur <= cand => {}
                _ => {
                    best.insert(l.target, cand);
                }
            }
        }
        for (oid, (_, key)) in best {
            ref_colors.insert(oid, branch_color(&key));
        }
        if let Some(p) = pin {
            ref_colors.insert(p, 0);
        }
    }

    LayoutOptions {
        pin,
        ref_colors,
        collapse_long_edges: prefs
            .collapse_long_edges
            .then_some(cfg.graph_long_edge_rows),
        lane_color: if query.list_mode() { Some(|_| 0) } else { None },
    }
}

/// 텍스트 입력이 해시 접두로 보일 때 그 해시의 커밋을 찾는다 (LG-06). 텍스트 조건만 뺀 같은 질의(범위·작성자·
/// 날짜·경로·첫 부모·머지 제외가 그대로)로 로그를 한 번 더 읽어, 해시가 접두로 시작하는 커밋을 고른다.
/// 그래서 범위 밖이거나 다른 조건에 안 맞는 커밋은 해시가 맞아도 들지 않는다. `max_count` 는 타임라인의
/// 저장소당 상한(그 범위의 최신 커밋 중에서만 찾는다). `stream` 이면 출력을 쌓지 않고 흘려 읽는다 — 통합
/// 타임라인은 저장소가 많으면 스트림의 읽기 permit 이 교착하므로 `run` 으로 받는다
pub(crate) async fn hash_matches(
    runner: &dyn GitRunner,
    work_tree: &Path,
    overrides: &[(String, String)],
    query: &GraphQuery,
    max_count: Option<u32>,
    stream: bool,
) -> Result<Vec<CommitRecord>, GitError> {
    let Some(prefix) = query.filter.hash_prefix() else {
        return Ok(Vec::new());
    };
    let mut plain = query.clone();
    plain.filter.text = TextFilter::default();
    let req = graph_log_request_with(work_tree, overrides, &plain, max_count)
        .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let mut parser = LogParser::new();
    let mut found = Vec::new();
    let mut keep = |records: Vec<CommitRecord>| {
        found.extend(
            records
                .into_iter()
                .filter(|r| r.oid.to_hex().starts_with(&prefix)),
        );
    };
    if stream {
        let mut s = runner.stream(req).await?;
        while let Some(chunk) = s.next_chunk().await? {
            keep(parser.feed(&chunk)?);
        }
        parser.finish()?;
        let exit = s.finish().await?;
        if !exit.success() {
            return Err(GitError::Exit {
                status: exit.status,
                stderr: exit.stderr,
                args: display,
            });
        }
    } else {
        let stdout = runner.run(req).await?.ok(&display)?;
        keep(parser.feed(&stdout)?);
        parser.finish()?;
    }
    Ok(found)
}

/// 해시 일치 커밋을 메시지 일치 커밋 흐름에 끼운다. 해시 일치 커밋은 커밋 시각이 처음으로 자기보다 이른
/// 메시지 일치 커밋 앞에 들어가고(목록 모드라 선이 없어 위치는 시각 차례면 된다), 둘 다에 맞는 커밋은 한 번만 든다
pub(crate) struct HashMerge {
    /// 아직 넣지 않은 해시 일치 커밋 (커밋 시각 내림차순)
    pending: Vec<CommitRecord>,
    /// 해시 일치로 먼저 넣은 커밋 (뒤에 메시지 일치로 또 오면 건너뛴다)
    inserted: HashSet<Oid>,
}

impl HashMerge {
    /// 해시 일치 커밋으로 시작한다
    pub(crate) fn new(mut extra: Vec<CommitRecord>) -> Self {
        extra.sort_by_key(|r| std::cmp::Reverse(r.commit_time));
        HashMerge {
            pending: extra,
            inserted: HashSet::new(),
        }
    }

    /// 메시지 일치 커밋 `rec` 를 넣기 전에 넣을 해시 일치 커밋들과, `rec` 를 넣을지(해시 일치로 이미 넣었으면 거짓)
    pub(crate) fn step(&mut self, rec: &CommitRecord) -> (Vec<CommitRecord>, bool) {
        if self.pending.is_empty() && self.inserted.is_empty() {
            return (Vec::new(), true);
        }
        if self.inserted.contains(&rec.oid) {
            return (Vec::new(), false);
        }
        // 메시지로도 맞는 해시 일치 커밋은 메시지 차례에 한 번만 넣는다
        self.pending.retain(|p| p.oid != rec.oid);
        let split = self
            .pending
            .iter()
            .position(|p| p.commit_time <= rec.commit_time)
            .unwrap_or(self.pending.len());
        let before: Vec<CommitRecord> = self.pending.drain(..split).collect();
        self.inserted.extend(before.iter().map(|r| r.oid));
        (before, true)
    }

    /// 메시지 일치 커밋이 끝난 뒤 남은 해시 일치 커밋
    pub(crate) fn rest(self) -> Vec<CommitRecord> {
        self.pending
    }

    /// 두 목록을 한 번에 합친다 (통합 타임라인의 저장소 하나)
    pub(crate) fn merge_all(
        main: Vec<CommitRecord>,
        extra: Vec<CommitRecord>,
    ) -> Vec<CommitRecord> {
        if extra.is_empty() {
            return main;
        }
        let mut merge = HashMerge::new(extra);
        let mut out = Vec::with_capacity(main.len() + merge.pending.len());
        for rec in main {
            let (before, keep) = merge.step(&rec);
            out.extend(before);
            if keep {
                out.push(rec);
            }
        }
        out.extend(merge.rest());
        out
    }
}

/// 질의의 ref 중 저장소에 없는 것을 뺀다 (타임라인과 같은 규칙). 하나도 남지 않으면 전체 범위로 돌아간다.
/// 바뀐 질의와 빠진 이름을 돌려준다. 빠진 것이 없으면 질의는 그대로다
pub(crate) async fn drop_missing_refs(
    runner: &dyn GitRunner,
    work_tree: &Path,
    query: &GraphQuery,
) -> (GraphQuery, Vec<String>) {
    let names: &[String] = match &query.revs {
        // HEAD 범위는 이름을 고른 것이 아니라 빠질 ref 가 없다 (커밋이 없는 HEAD 는 로드가 따로 다룬다)
        GraphRevs::All | GraphRevs::Head => return (query.clone(), Vec::new()),
        GraphRevs::Branches { names } => names,
        GraphRevs::Solo { name } => std::slice::from_ref(name),
    };
    let mut present = Vec::new();
    let mut dropped = Vec::new();
    for name in names {
        if rev_resolves(runner, work_tree, name).await {
            present.push(name.clone());
        } else {
            dropped.push(name.clone());
        }
    }
    if dropped.is_empty() {
        return (query.clone(), dropped);
    }
    let revs = if present.is_empty() {
        GraphRevs::All
    } else {
        GraphRevs::Branches { names: present }
    };
    (
        GraphQuery {
            revs,
            ..query.clone()
        },
        dropped,
    )
}

/// HEAD 도달성 추적: 자식이 먼저 오는 스트림에서 `pending` 에 있던 커밋이면 닿고, 그 부모를 다시 `pending` 에 넣는다
pub struct HeadReach {
    pending: HashSet<Oid>,
    /// HEAD 커밋을 스트림에서 만났는지
    seen_head: bool,
}

impl HeadReach {
    /// HEAD 커밋으로 시작한다
    pub fn new(head: Option<Oid>) -> Self {
        HeadReach {
            pending: head.into_iter().collect(),
            seen_head: false,
        }
    }

    /// 이 커밋이 HEAD 에서 닿는지 판정하고 부모를 이어서 추적한다
    pub fn visit(&mut self, oid: &Oid, parents: &[Oid]) -> bool {
        if self.pending.remove(oid) {
            self.seen_head = true;
            self.pending.extend(parents.iter().copied());
            true
        } else {
            false
        }
    }

    /// 이 스트림으로 도달성을 판정할 수 없는지. 범위 필터로 HEAD 가 로그에 없으면 전파가 시작되지 않고,
    /// 목록 모드(머지 제외, 텍스트·작성자 필터)는 걸러진 커밋에서 체인이 끊긴다. 이때 호출자는 전 행을 닿는
    /// 것으로 표시해 흐리지 않는다
    pub fn unknown(&self, query: &GraphQuery) -> bool {
        query.list_mode() || !self.seen_head
    }
}

/// 그래프 로드 파이프라인: 스트림 청크 → 파서 → 테이블·레이아웃 배치 push → 이벤트
pub async fn run_load(
    core: Arc<CoreInner>,
    session: Arc<RepoSession>,
    generation: u64,
    mode: LoadMode,
) {
    let id = session.id;
    let sink = Arc::clone(&session.sink);
    let target = match mode {
        LoadMode::Initial => session.graph_handle(),
        LoadMode::Reload => Arc::new(RwLock::new(GraphData::empty(generation))),
    };
    if mode == LoadMode::Initial {
        sink.emit(CoreEvent::GraphLoadStarted {
            session: id,
            generation,
        });
    }
    let started = Instant::now();
    let result = load_inner(
        core.runner(),
        &session,
        &target,
        &sink,
        &core.cfg,
        generation,
        mode,
        started,
    )
    .await;
    match (mode, result) {
        (LoadMode::Initial, Ok(())) => {}
        (LoadMode::Initial, Err(e)) => {
            let message = e.to_string();
            {
                let mut g = session.graph_mut();
                if g.generation == generation {
                    g.layout.finish();
                    g.state = LoadState::Failed(message.clone());
                }
            }
            sink.emit(CoreEvent::GraphLoadFailed {
                session: id,
                generation,
                message,
            });
        }
        (LoadMode::Reload, Ok(())) => {
            let (rows, lane_count) = {
                let mut shadow = target.write().unwrap_or_else(PoisonError::into_inner);
                let mut current = session.graph_mut();
                std::mem::swap(&mut *current, &mut *shadow);
                current.generation = generation;
                (current.layout.len() as u32, current.layout.lane_count())
            };
            sink.emit(CoreEvent::GraphReloaded {
                session: id,
                generation,
                rows,
                lane_count,
            });
            core.after_reload(&session);
        }
        (LoadMode::Reload, Err(e)) => {
            tracing::warn!(session = ?id, error = %e, "그래프 재로드 실패");
            let message = e.to_string();
            // 이 재로드가 초기 로드를 끊었다면 세션 그래프는 아직 로딩 중이다. 실패로 끝내야 멈춰 있지 않는다
            let interrupted = {
                let mut g = session.graph_mut();
                if g.state == LoadState::Loading {
                    g.layout.finish();
                    g.state = LoadState::Failed(message.clone());
                    Some(g.generation)
                } else {
                    None
                }
            };
            if let Some(generation) = interrupted {
                sink.emit(CoreEvent::GraphLoadFailed {
                    session: id,
                    generation,
                    message: message.clone(),
                });
            }
            sink.emit(CoreEvent::GraphReloadFailed {
                session: id,
                message,
            });
            core.after_reload(&session);
        }
    }
}

/// 없는 ref 를 뺀 질의를 세션 질의로 삼고 알린다. 그사이 사용자가 질의를 바꿨으면 그 재로드가 예약돼 있으므로
/// 덮어쓰지 않는다
fn adopt_adjusted_query(
    session: &RepoSession,
    sink: &Arc<dyn EventSink>,
    requested: &GraphQuery,
    adjusted: &GraphQuery,
    dropped: Vec<String>,
) {
    {
        let mut current = session
            .graph_query
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        if *current != *requested {
            return;
        }
        *current = adjusted.clone();
    }
    sink.emit(CoreEvent::GraphQueryAdjusted {
        session: session.id,
        query: adjusted.clone(),
        dropped,
    });
}

/// 실제 로드. 오류는 호출자가 상태·이벤트로 바꾼다
#[allow(clippy::too_many_arguments)]
async fn load_inner(
    runner: &dyn GitRunner,
    session: &Arc<RepoSession>,
    target: &Arc<RwLock<GraphData>>,
    sink: &Arc<dyn EventSink>,
    cfg: &CoreConfig,
    generation: u64,
    mode: LoadMode,
    started: Instant,
) -> Result<(), GitError> {
    let id = session.id;
    let requested = session
        .graph_query
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let (query, dropped) = drop_missing_refs(runner, &session.info.work_tree, &requested).await;
    if !dropped.is_empty() {
        adopt_adjusted_query(session, sink, &requested, &query, dropped);
    }
    let prefs = *session
        .layout_prefs
        .read()
        .unwrap_or_else(PoisonError::into_inner);
    let (opts, mut reach) = {
        let state = session.state();
        (
            layout_options(&state.refs, &query, &prefs, cfg),
            HeadReach::new(state.refs.head.oid()),
        )
    };
    {
        let mut g = target.write().unwrap_or_else(PoisonError::into_inner);
        g.layout = GraphLayout::with_options(opts);
    }
    let mut first_sent = false;
    let notify = mode == LoadMode::Initial;
    // HEAD 범위인데 커밋이 아직 없으면(unborn) `git log HEAD` 가 실패한다. 로그를 돌리지 않고 빈 그래프로 끝낸다
    let unborn_head = query.revs == GraphRevs::Head
        && !rev_resolves(runner, &session.info.work_tree, "HEAD").await;
    if !unborn_head {
        // 텍스트가 해시 접두로 보이면 그 해시의 커밋을 먼저 찾아 두고 메시지 일치 흐름에 끼운다
        let mut merge = HashMerge::new(
            hash_matches(
                runner,
                &session.info.work_tree,
                &cfg.git_config_overrides,
                &query,
                None,
                true,
            )
            .await?,
        );
        let req = graph_log_request(&session.info.work_tree, &cfg.git_config_overrides, &query);
        let mut stream = runner.stream(req).await?;
        let mut parser = LogParser::new();
        let mut last_progress = Instant::now();
        // 레코드 하나를 테이블·레이아웃에 넣는다
        let push = |g: &mut GraphData, reach: &mut HeadReach, rec: &CommitRecord| {
            let in_head = reach.visit(&rec.oid, &rec.parents);
            g.table.push(rec, in_head);
            g.layout.push(rec.oid, layout_parents(&query, &rec.parents));
        };

        while let Some(chunk) = stream.next_chunk().await? {
            let records = parser.feed(&chunk)?;
            if records.is_empty() {
                continue;
            }
            let rows = {
                let mut g = target.write().unwrap_or_else(PoisonError::into_inner);
                for rec in &records {
                    let (before, keep) = merge.step(rec);
                    for h in &before {
                        push(&mut g, &mut reach, h);
                    }
                    if keep {
                        push(&mut g, &mut reach, rec);
                    }
                }
                g.layout.len() as u32
            };
            if !notify {
                continue;
            }
            if !first_sent && rows >= cfg.first_chunk_rows {
                first_sent = true;
                sink.emit(CoreEvent::GraphFirstChunk {
                    session: id,
                    generation,
                    rows,
                });
                last_progress = Instant::now();
            } else if last_progress.elapsed() >= cfg.progress_interval {
                last_progress = Instant::now();
                sink.emit(CoreEvent::GraphProgress {
                    session: id,
                    generation,
                    rows,
                });
            }
        }
        parser.finish()?;
        let exit = stream.finish().await?;
        if !exit.success() {
            return Err(GitError::Exit {
                status: exit.status,
                stderr: exit.stderr,
                args: vec!["log".into()],
            });
        }
        let rest = merge.rest();
        if !rest.is_empty() {
            let mut g = target.write().unwrap_or_else(PoisonError::into_inner);
            for h in &rest {
                push(&mut g, &mut reach, h);
            }
        }
    }

    let (rows, lane_count) = {
        let mut g = target.write().unwrap_or_else(PoisonError::into_inner);
        g.layout.finish();
        if reach.unknown(&query) {
            g.table.mark_in_head(0);
        }
        g.state = LoadState::Finished;
        (g.layout.len() as u32, g.layout.lane_count())
    };
    if !notify {
        return Ok(());
    }
    if !first_sent {
        sink.emit(CoreEvent::GraphFirstChunk {
            session: id,
            generation,
            rows,
        });
    }
    let commit_graph_suggested =
        !session.info.commit_graph.present && rows >= cfg.commit_graph_suggest_threshold;
    sink.emit(CoreEvent::GraphLoadFinished {
        session: id,
        generation,
        rows,
        lane_count,
        elapsed_ms: started.elapsed().as_millis() as u64,
        commit_graph_suggested,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 시각 `t` 의 레코드 (oid 는 바이트 하나로 구분)
    fn rec(id: u8, t: i64) -> CommitRecord {
        CommitRecord {
            oid: Oid::from_bytes([id; 20]),
            parents: Vec::new(),
            author_name: String::new(),
            author_email: String::new(),
            author_time: t,
            commit_time: t,
            subject: id.to_string(),
        }
    }

    /// 합친 결과의 id 목록
    fn ids(v: &[CommitRecord]) -> Vec<u8> {
        v.iter().map(|r| r.oid.as_bytes()[0]).collect()
    }

    /// 해시 일치 커밋은 커밋 시각 차례로 끼고, 메시지로도 맞는 커밋은 한 번만 든다
    #[test]
    fn hash_matches_merge_by_time_without_duplicates() {
        let main = vec![rec(1, 50), rec(2, 40), rec(3, 30), rec(4, 10)];
        // 9 는 40 과 30 사이, 3 은 메시지로도 맞는다, 8 은 맨 뒤, 7 은 맨 앞
        let extra = vec![rec(9, 35), rec(3, 30), rec(8, 5), rec(7, 60)];
        assert_eq!(
            ids(&HashMerge::merge_all(main, extra)),
            vec![7, 1, 2, 9, 3, 4, 8]
        );
        // 해시 일치로 먼저 넣은 커밋이 뒤에 메시지 일치로 또 오면 건너뛴다 (토폴로지 순서는 시각과 어긋날 수 있다)
        let main = vec![rec(1, 50), rec(2, 10), rec(5, 40)];
        assert_eq!(
            ids(&HashMerge::merge_all(main, vec![rec(5, 40)])),
            vec![1, 5, 2]
        );
        // 해시 일치가 없으면 그대로
        let main = vec![rec(1, 50), rec(2, 40)];
        assert_eq!(ids(&HashMerge::merge_all(main, Vec::new())), vec![1, 2]);
    }
}
