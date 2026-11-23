//! diff·히스토리·그래프 질의 (DIFF-04·05·06, GRAPH-07·08·10, MOD-03 기반)

use std::path::Path;
use std::sync::PoisonError;

use mgit_git::cmd::{
    advanced_search, blame_file, compare_file_diff, compare_files, config_get, file_history,
    filter_rejection,
};
use mgit_l10n::{pick, tr};
use mgit_model::{
    AdvancedSearch, BlameLine, ChangedFile, CommitFilter, DiffOptions, DifftoolTarget, FileDiff,
    GitRunner, GraphLayoutPrefs, GraphQuery, GraphRevs, HistoryEntry, Oid,
};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::inspect::SearchResult;
use crate::messages;

/// git 의 빈 트리 (루트 커밋과 비교할 때)
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// 옵션으로 오해될 수 없는 값인지
pub(crate) fn check_ref(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_ref(name)));
    }
    Ok(())
}

/// 경로가 옵션으로 오해될 수 없는지
pub(crate) fn check_path(path: &str) -> Result<(), CoreError> {
    if path.is_empty() || path.starts_with('-') || path.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_path(path)));
    }
    Ok(())
}

/// 필터 값이 한 줄짜리인지. git 은 패턴의 줄바꿈을 패턴 여러 개(OR)로 나눠 읽고 NUL 은 인자로 넘길 수 없다
fn check_filter_values(filter: &CommitFilter) -> Result<(), CoreError> {
    let bad = |s: &str| s.contains(['\0', '\n', '\r']);
    if bad(&filter.text.pattern) {
        return Err(CoreError::InvalidFilter(
            pick(
                "검색어에 줄바꿈이나 NUL 문자를 쓸 수 없습니다",
                "Search text cannot contain line breaks or NUL characters",
            )
            .into(),
        ));
    }
    if filter.authors.iter().any(|a| bad(a)) {
        return Err(CoreError::InvalidFilter(
            pick(
                "작성자에 줄바꿈이나 NUL 문자를 쓸 수 없습니다",
                "Author cannot contain line breaks or NUL characters",
            )
            .into(),
        ));
    }
    Ok(())
}

/// 그래프 질의의 값 검사 (단일 저장소·통합 타임라인 공용): 고른 ref·경로가 옵션으로 읽히지 않고, 필터 값이
/// 한 줄짜리인지. git 을 돌리지 않는다
pub(crate) fn check_query(query: &GraphQuery) -> Result<(), CoreError> {
    match &query.revs {
        GraphRevs::Branches { names } => {
            if names.is_empty() {
                return Err(CoreError::Invalid(
                    pick(
                        "표시할 ref 를 하나 이상 고르세요",
                        "Choose at least one ref to show",
                    )
                    .into(),
                ));
            }
            for n in names {
                check_ref(n)?;
            }
        }
        GraphRevs::Solo { name } => check_ref(name)?,
        GraphRevs::All | GraphRevs::Head => {}
    }
    for p in &query.path_scope {
        check_path(p)?;
    }
    check_filter_values(&query.filter)
}

/// 정규식 텍스트 필터를 git 에 미리 컴파일시켜 본다. 거부되면 `InvalidFilter`(질의를 바꾸기 전에 알려 빈 결과와
/// 구분한다). 글자 그대로의 텍스트와 작성자는 코어가 이스케이프하므로 검사하지 않는다 (git 명령 0회)
pub(crate) async fn check_filter_pattern(
    runner: &dyn GitRunner,
    work_tree: &Path,
    filter: &CommitFilter,
) -> Result<(), CoreError> {
    if !(filter.has_text() && filter.text.regex) {
        return Ok(());
    }
    match filter_rejection(runner, work_tree, filter).await {
        Some(reason) => Err(CoreError::InvalidFilter(tr!(
            "잘못된 정규식입니다: {reason}",
            "Invalid regular expression: {reason}"
        ))),
        None => Ok(()),
    }
}

impl Core {
    /// 현재 그래프 질의
    pub fn graph_query(&self, session: SessionId) -> Result<GraphQuery, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(s.graph_query
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone())
    }

    /// 그래프 질의를 바꾸고 그림자 재로드한다 (GRAPH-08 필터, MOD-03 경로 범위, LG-06 커밋 필터).
    /// 고른 ref 가 저장소에 없거나 정규식이 잘못됐으면 질의를 바꾸지 않고 오류를 돌려준다 (잘못된 정규식은
    /// `InvalidFilter`. 결과가 0개인 필터는 오류가 아니라 빈 그래프다)
    pub async fn set_graph_query(
        &self,
        session: SessionId,
        query: GraphQuery,
    ) -> Result<(), CoreError> {
        check_query(&query)?;
        let inner = self.inner_arc();
        // 가벼운 세션은 그래프가 없으므로 질의를 받아 두지도 않는다 (`GraphUnavailable`)
        let s = inner.get_graph(session)?;
        check_filter_pattern(inner.runner(), &s.info.work_tree, &query.filter).await?;
        let (_, missing) =
            crate::load::drop_missing_refs(inner.runner(), &s.info.work_tree, &query).await;
        if !missing.is_empty() {
            return Err(CoreError::Invalid(tr!(
                "찾을 수 없는 참조: {}",
                "Ref not found: {}",
                missing.join(", ")
            )));
        }
        *s.graph_query
            .write()
            .unwrap_or_else(PoisonError::into_inner) = query;
        self.reload_graph(session)
    }

    /// 현재 레이아웃 설정
    pub fn graph_layout_prefs(&self, session: SessionId) -> Result<GraphLayoutPrefs, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(*s
            .layout_prefs
            .read()
            .unwrap_or_else(PoisonError::into_inner))
    }

    /// 레이아웃 설정을 바꾸고 git 없이 재배치한다 (로드 중이면 재로드로 대신한다)
    pub fn set_graph_layout_prefs(
        &self,
        session: SessionId,
        prefs: GraphLayoutPrefs,
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get_graph(session)?;
        *s.layout_prefs
            .write()
            .unwrap_or_else(PoisonError::into_inner) = prefs;
        self.relayout_graph(session)
    }

    /// 테이블은 그대로 두고 레이아웃만 다시 만든다. 세대가 올라가고 `GraphReloaded` 가 나간다.
    /// 로드 중이거나 그림자 재로드가 돌고 있으면 그 결과가 새 설정을 반영하도록 재로드를 예약한다.
    /// 로드에 실패한 그래프도 재로드한다 (재배치하면 일부 행이 완료처럼 보이고 오류가 사라진다)
    pub fn relayout_graph(&self, session: SessionId) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get_graph(session)?;
        let running = s
            .reload
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running;
        if running || s.graph().state != crate::session::LoadState::Finished {
            inner.schedule_reload(&s);
            return Ok(());
        }
        let query = s
            .graph_query
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let prefs = *s
            .layout_prefs
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let opts = {
            let state = s.state();
            crate::load::layout_options(&state.refs, &query, &prefs, &inner.cfg)
        };
        let (generation, rows, lane_count) = {
            let mut g = s.graph_mut();
            let mut layout = mgit_graph::GraphLayout::with_options(opts);
            {
                let table = &g.table;
                for row in 0..table.len() as u32 {
                    layout.push(
                        table.oid(row),
                        crate::load::layout_parents(&query, table.parents(row)),
                    );
                }
            }
            layout.finish();
            g.layout = layout;
            g.generation += 1;
            (g.generation, g.layout.len() as u32, g.layout.lane_count())
        };
        s.sink.emit(crate::events::CoreEvent::GraphReloaded {
            session,
            generation,
            rows,
            lane_count,
        });
        Ok(())
    }

    /// blame (DIFF-04). `rev` 가 없으면 작업 트리
    pub async fn blame(
        &self,
        session: SessionId,
        path: &str,
        rev: Option<&str>,
        ignore_whitespace: bool,
    ) -> Result<Vec<BlameLine>, CoreError> {
        check_path(path)?;
        if let Some(r) = rev {
            check_ref(r)?;
        }
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        Ok(blame_file(
            inner.runner(),
            &s.info.work_tree,
            path,
            rev,
            ignore_whitespace,
            true,
        )
        .await?)
    }

    /// 파일 히스토리 (DIFF-05)
    pub async fn file_history(
        &self,
        session: SessionId,
        path: &str,
        limit: u32,
    ) -> Result<Vec<HistoryEntry>, CoreError> {
        check_path(path)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        Ok(file_history(
            inner.runner(),
            &s.info.work_tree,
            path,
            limit.clamp(1, 5000),
        )
        .await?)
    }

    /// 두 ref 비교 — 변경 파일 (DIFF-06)
    pub async fn compare_refs(
        &self,
        session: SessionId,
        a: &str,
        b: &str,
        three_dot: bool,
    ) -> Result<Vec<ChangedFile>, CoreError> {
        check_ref(a)?;
        check_ref(b)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        Ok(compare_files(inner.runner(), &s.info.work_tree, a, b, three_dot).await?)
    }

    /// 두 ref 비교 — 파일 하나의 diff
    #[allow(clippy::too_many_arguments)]
    pub async fn compare_file_diff(
        &self,
        session: SessionId,
        a: &str,
        b: &str,
        three_dot: bool,
        path: &str,
        opts: DiffOptions,
        full: bool,
    ) -> Result<Option<FileDiff>, CoreError> {
        check_ref(a)?;
        check_ref(b)?;
        check_path(path)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let diff = compare_file_diff(
            inner.runner(),
            &s.info.work_tree,
            a,
            b,
            three_dot,
            path,
            &opts,
        )
        .await?;
        Ok(diff.map(|mut d| {
            if !full {
                d.truncate_to(self.config().diff_max_lines);
            }
            d
        }))
    }

    /// 연속 commit 범위의 결합 diff (GRAPH-10): `older^..newer`. 루트면 빈 트리와 비교
    pub async fn range_files(
        &self,
        session: SessionId,
        newer: &Oid,
        older: &Oid,
    ) -> Result<(String, Vec<ChangedFile>), CoreError> {
        let base = self.range_base(session, older).await?;
        let files = self
            .compare_refs(session, &base, &newer.to_hex(), false)
            .await?;
        Ok((base, files))
    }

    /// 범위 diff 의 기준 (`older^` 또는 빈 트리)
    async fn range_base(&self, session: SessionId, older: &Oid) -> Result<String, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = mgit_model::GitRequest::new(
            &s.info.work_tree,
            [
                "rev-parse",
                "--verify",
                "-q",
                &format!("{}^", older.to_hex()),
            ],
        )
        .with_env(mgit_model::EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        Ok(if out.exit.success() {
            out.stdout_lossy().trim().to_string()
        } else {
            EMPTY_TREE.to_string()
        })
    }

    /// 고급 검색 (GRAPH-07): git 이 찾은 해시를 그래프 행으로 바꾼다. 그래프에 없는 커밋은 뺀다
    pub async fn search_advanced(
        &self,
        session: SessionId,
        q: &AdvancedSearch,
        limit: usize,
    ) -> Result<SearchResult, CoreError> {
        if let Some(p) = q.path.as_deref() {
            check_path(p)?;
        }
        let inner = self.inner_arc();
        // 결과가 그래프 행 번호라 그래프 없는 가벼운 세션은 git 을 돌리기 전에 거부한다
        let s = inner.get_graph(session)?;
        let oids = advanced_search(
            inner.runner(),
            &s.info.work_tree,
            q,
            limit.clamp(1, 50_000) as u32,
        )
        .await?;
        let g = s.graph();
        let mut rows: Vec<u32> = oids.iter().filter_map(|o| g.table.row_of(o)).collect();
        rows.sort_unstable();
        rows.dedup();
        let total = rows.len() as u32;
        rows.truncate(limit);
        Ok(SearchResult {
            truncated: oids.len() as u32 >= limit.min(50_000) as u32,
            total,
            rows,
        })
    }
}

impl Core {
    /// 외부 diff 도구 (DIFF-07): `git difftool -y`. `diff.tool` 이 없으면 안내 오류.
    /// 도구가 닫힐 때까지 기다린다 (호출자는 결과를 기다리지 않아도 된다)
    pub async fn open_difftool(
        &self,
        session: SessionId,
        target: DifftoolTarget,
    ) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        if config_get(inner.runner(), &s.info.work_tree, "diff.tool")
            .await
            .is_none()
        {
            return Err(CoreError::Invalid(pick("diff.tool 이 설정돼 있지 않습니다. `git config --global diff.tool <이름>` 으로 지정하세요", "diff.tool is not set. Set it with `git config --global diff.tool <name>`").into()));
        }
        let mut args: Vec<String> = vec!["difftool".into(), "-y".into()];
        match target {
            DifftoolTarget::WorkTree { path, staged } => {
                check_path(&path)?;
                if staged {
                    args.push("--cached".into());
                }
                args.push("--".into());
                args.push(path);
            }
            DifftoolTarget::Commit { oid, path } => {
                check_path(&path)?;
                let base = self.range_base(session, &oid).await?;
                args.push(base);
                args.push(oid.to_hex());
                args.push("--".into());
                args.push(path);
            }
            DifftoolTarget::Range {
                a,
                b,
                three_dot,
                path,
            } => {
                check_ref(&a)?;
                check_ref(&b)?;
                check_path(&path)?;
                args.push(if three_dot {
                    format!("{a}...{b}")
                } else {
                    format!("{a}..{b}")
                });
                args.push("--".into());
                args.push(path);
            }
        }
        let req = mgit_model::GitRequest::new(&s.info.work_tree, args)
            .with_env(mgit_model::EnvProfile::ReadInteractive);
        let display = req.display_args();
        inner.runner().run(req).await?.ok(&display)?;
        Ok(())
    }
}
