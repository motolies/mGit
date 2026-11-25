//! diff·히스토리·그래프 질의 커맨드 (Phase 2 A3)

use mgit_core::{
    AdvancedSearch, AuthorList, CommitFilter, DiffOptions, DifftoolTarget, GraphLayoutPrefs,
    GraphQuery, GraphRevs, GraphSort, Oid, Pickaxe, SessionId, TextFilter,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands_refs::{ChangedFile, SearchResult};
use crate::dto_diff::FileDiff;
use crate::error::IpcError;
use crate::state::AppState;

/// 그래프 ref 선택
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GraphRevsDto {
    All,
    Branches {
        names: Vec<String>,
    },
    Solo {
        name: String,
    },
    /// HEAD 에서 닿는 커밋만. 통합 타임라인에서는 저장소마다 자기 HEAD 다 (BT-03)
    Head,
}

/// 그래프 행 순서
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GraphSortDto {
    Topo,
    Date,
}

/// 커밋 메시지 텍스트 필터. `pattern` 이 비면 텍스트 조건이 없다. 7~64자 hex 로 보이면 그 해시의 커밋도 든다
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct TextFilterDto {
    pub pattern: String,
    /// 참이면 POSIX 확장 정규식(ERE), 거짓이면 글자 그대로
    pub regex: bool,
    /// 참이면 대소문자 구분
    pub match_case: bool,
}

/// 커밋 필터. 텍스트·작성자·날짜는 AND, 작성자 여럿은 OR. 빠진 필드는 "조건 없음"
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitFilterDto {
    pub text: TextFilterDto,
    /// 작성자 이메일 (`AuthorCandidate.email`). ASCII 대소문자 무시, 전체 일치
    pub authors: Vec<String>,
    /// 커밋 시각 하한 (epoch 초, 포함)
    #[specta(type = f64)]
    pub since: Option<i64>,
    /// 커밋 시각 상한 (epoch 초, 포함)
    #[specta(type = f64)]
    pub until: Option<i64>,
}

impl From<CommitFilterDto> for CommitFilter {
    /// wire → 코어
    fn from(f: CommitFilterDto) -> Self {
        CommitFilter {
            text: TextFilter {
                pattern: f.text.pattern,
                regex: f.text.regex,
                match_case: f.text.match_case,
            },
            authors: f.authors,
            since: f.since,
            until: f.until,
        }
    }
}

impl From<CommitFilter> for CommitFilterDto {
    /// 코어 → wire
    fn from(f: CommitFilter) -> Self {
        CommitFilterDto {
            text: TextFilterDto {
                pattern: f.text.pattern,
                regex: f.text.regex,
                match_case: f.text.match_case,
            },
            authors: f.authors,
            since: f.since,
            until: f.until,
        }
    }
}

/// 그래프 질의
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphQueryDto {
    pub revs: GraphRevsDto,
    pub hide_remotes: bool,
    pub path_scope: Vec<String>,
    pub sort: GraphSortDto,
    pub first_parent: bool,
    pub no_merges: bool,
    /// 커밋 필터. 저장해 둔 옛 질의(이 필드 없음)도 받도록 빠지면 "필터 없음"이다
    #[serde(default)]
    pub filter: CommitFilterDto,
}

impl From<GraphQueryDto> for GraphQuery {
    /// wire → 코어
    fn from(q: GraphQueryDto) -> Self {
        GraphQuery {
            revs: match q.revs {
                GraphRevsDto::All => GraphRevs::All,
                GraphRevsDto::Branches { names } => GraphRevs::Branches { names },
                GraphRevsDto::Solo { name } => GraphRevs::Solo { name },
                GraphRevsDto::Head => GraphRevs::Head,
            },
            hide_remotes: q.hide_remotes,
            path_scope: q.path_scope,
            sort: match q.sort {
                GraphSortDto::Topo => GraphSort::Topo,
                GraphSortDto::Date => GraphSort::Date,
            },
            first_parent: q.first_parent,
            no_merges: q.no_merges,
            filter: q.filter.into(),
        }
    }
}

impl From<GraphQuery> for GraphQueryDto {
    /// 코어 → wire
    fn from(q: GraphQuery) -> Self {
        GraphQueryDto {
            revs: match q.revs {
                GraphRevs::All => GraphRevsDto::All,
                GraphRevs::Branches { names } => GraphRevsDto::Branches { names },
                GraphRevs::Solo { name } => GraphRevsDto::Solo { name },
                GraphRevs::Head => GraphRevsDto::Head,
            },
            hide_remotes: q.hide_remotes,
            path_scope: q.path_scope,
            sort: match q.sort {
                GraphSort::Topo => GraphSortDto::Topo,
                GraphSort::Date => GraphSortDto::Date,
            },
            first_parent: q.first_parent,
            no_merges: q.no_merges,
            filter: q.filter.into(),
        }
    }
}

/// 작성자 후보 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthorCandidateDto {
    /// 그 이메일로 가장 많이 쓴 이름 (.mailmap 적용)
    pub name: String,
    /// 필터(`CommitFilter.authors`)에 넣을 값
    pub email: String,
    pub commits: u32,
}

/// 작성자 후보 목록 (커밋 수 내림차순 → 이름 → 이메일, 최대 1000개)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthorListDto {
    pub authors: Vec<AuthorCandidateDto>,
    /// 자르기 전 후보 수
    pub total: u32,
    pub truncated: bool,
    /// 시간 상한(저장소마다 10초)에 걸린 저장소가 있어 일부만 찼다 (오류가 아니다)
    pub timed_out: bool,
}

impl From<AuthorList> for AuthorListDto {
    /// 코어 → wire
    fn from(l: AuthorList) -> Self {
        AuthorListDto {
            authors: l
                .authors
                .into_iter()
                .map(|a| AuthorCandidateDto {
                    name: a.name,
                    email: a.email,
                    commits: a.commits,
                })
                .collect(),
            total: l.total,
            truncated: l.truncated,
            timed_out: l.timed_out,
        }
    }
}

/// 레이아웃 설정 (고정 레인·ref 색·긴 엣지 접기)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayoutPrefsDto {
    pub pin_head: bool,
    pub ref_colors: bool,
    pub collapse_long_edges: bool,
}

impl From<GraphLayoutPrefsDto> for GraphLayoutPrefs {
    /// wire → 코어
    fn from(p: GraphLayoutPrefsDto) -> Self {
        GraphLayoutPrefs {
            pin_head: p.pin_head,
            ref_colors: p.ref_colors,
            collapse_long_edges: p.collapse_long_edges,
        }
    }
}

impl From<GraphLayoutPrefs> for GraphLayoutPrefsDto {
    /// 코어 → wire
    fn from(p: GraphLayoutPrefs) -> Self {
        GraphLayoutPrefsDto {
            pin_head: p.pin_head,
            ref_colors: p.ref_colors,
            collapse_long_edges: p.collapse_long_edges,
        }
    }
}

/// diff 옵션
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptionsDto {
    pub ignore_whitespace: bool,
    pub context: u32,
}

impl From<DiffOptionsDto> for DiffOptions {
    /// wire → 코어
    fn from(o: DiffOptionsDto) -> Self {
        DiffOptions {
            ignore_whitespace: o.ignore_whitespace,
            context: o.context,
        }
    }
}

/// blame 한 줄
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: String,
    pub orig_line: u32,
    pub line: u32,
    pub author: String,
    pub author_mail: String,
    #[specta(type = f64)]
    pub author_time: i64,
    pub summary: String,
    pub previous_oid: Option<String>,
    pub previous_path: Option<String>,
    pub boundary: bool,
    pub text: String,
}

/// 파일 히스토리 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub oid: String,
    pub subject: String,
    pub author_name: String,
    #[specta(type = f64)]
    pub author_time: i64,
    pub path: String,
}

/// 고급 검색 조건
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedSearchDto {
    pub text: Option<String>,
    pub author: Option<String>,
    pub path: Option<String>,
    pub pickaxe: Option<String>,
    pub pickaxe_regex: bool,
    pub since: Option<String>,
    pub until: Option<String>,
}

/// 범위 diff 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RangeFiles {
    /// 비교 기준 (`older^` 또는 빈 트리)
    pub base: String,
    pub files: Vec<ChangedFile>,
}

/// hex → Oid
fn parse_oid(hex: &str) -> Result<Oid, IpcError> {
    Oid::from_hex(hex.as_bytes()).map_err(|e| IpcError::Internal {
        message: e.to_string(),
    })
}

/// 현재 그래프 질의
#[tauri::command]
#[specta::specta]
pub async fn graph_query(
    state: State<'_, AppState>,
    session: u32,
) -> Result<GraphQueryDto, IpcError> {
    Ok(state.core()?.core.graph_query(SessionId(session))?.into())
}

/// 그래프 질의 변경 (재로드)
#[tauri::command]
#[specta::specta]
pub async fn set_graph_query(
    state: State<'_, AppState>,
    session: u32,
    query: GraphQueryDto,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_graph_query(SessionId(session), query.into())
        .await?;
    Ok(())
}

/// 작성자 후보 (필터 바의 작성자 드롭다운). 필터와 무관하게 모든 ref 의 커밋 작성자다.
/// 가벼운 세션은 `graphUnavailable`
#[tauri::command]
#[specta::specta]
pub async fn graph_authors(
    state: State<'_, AppState>,
    session: u32,
) -> Result<AuthorListDto, IpcError> {
    Ok(state
        .core()?
        .core
        .graph_authors(SessionId(session))
        .await?
        .into())
}

/// 현재 레이아웃 설정
#[tauri::command]
#[specta::specta]
pub async fn graph_layout_prefs(
    state: State<'_, AppState>,
    session: u32,
) -> Result<GraphLayoutPrefsDto, IpcError> {
    Ok(state
        .core()?
        .core
        .graph_layout_prefs(SessionId(session))?
        .into())
}

/// 레이아웃 설정 변경 (git 없이 재배치, `GraphReloaded`)
#[tauri::command]
#[specta::specta]
pub async fn set_graph_layout_prefs(
    state: State<'_, AppState>,
    session: u32,
    prefs: GraphLayoutPrefsDto,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_graph_layout_prefs(SessionId(session), prefs.into())?;
    Ok(())
}

/// blame (DIFF-04)
#[tauri::command]
#[specta::specta]
pub async fn blame(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    rev: Option<String>,
    ignore_whitespace: bool,
) -> Result<Vec<BlameLine>, IpcError> {
    let lines = state
        .core()?
        .core
        .blame(SessionId(session), &path, rev.as_deref(), ignore_whitespace)
        .await?;
    Ok(lines
        .into_iter()
        .map(|b| BlameLine {
            oid: b.oid.to_hex(),
            orig_line: b.orig_line,
            line: b.line,
            author: b.author,
            author_mail: b.author_mail,
            author_time: b.author_time,
            summary: b.summary,
            previous_oid: b.previous.as_ref().map(|(o, _)| o.to_hex()),
            previous_path: b.previous.map(|(_, p)| p),
            boundary: b.boundary,
            text: b.text,
        })
        .collect())
}

/// 파일 히스토리 (DIFF-05)
#[tauri::command]
#[specta::specta]
pub async fn file_history(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    limit: u32,
) -> Result<Vec<HistoryEntry>, IpcError> {
    let list = state
        .core()?
        .core
        .file_history(SessionId(session), &path, limit)
        .await?;
    Ok(list
        .into_iter()
        .map(|h| HistoryEntry {
            oid: h.oid.to_hex(),
            subject: h.subject,
            author_name: h.author_name,
            author_time: h.author_time,
            path: h.path,
        })
        .collect())
}

/// 두 ref 비교 — 파일 목록 (DIFF-06)
#[tauri::command]
#[specta::specta]
pub async fn compare_refs(
    state: State<'_, AppState>,
    session: u32,
    a: String,
    b: String,
    three_dot: bool,
) -> Result<Vec<ChangedFile>, IpcError> {
    let list = state
        .core()?
        .core
        .compare_refs(SessionId(session), &a, &b, three_dot)
        .await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// 두 ref 비교 — 파일 diff
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub async fn compare_file_diff(
    state: State<'_, AppState>,
    session: u32,
    a: String,
    b: String,
    three_dot: bool,
    path: String,
    options: DiffOptionsDto,
    full: bool,
) -> Result<Option<FileDiff>, IpcError> {
    let d = state
        .core()?
        .core
        .compare_file_diff(
            SessionId(session),
            &a,
            &b,
            three_dot,
            &path,
            options.into(),
            full,
        )
        .await?;
    Ok(d.map(Into::into))
}

/// 연속 commit 범위의 변경 파일 (GRAPH-10)
#[tauri::command]
#[specta::specta]
pub async fn range_files(
    state: State<'_, AppState>,
    session: u32,
    newer: String,
    older: String,
) -> Result<RangeFiles, IpcError> {
    let (base, files) = state
        .core()?
        .core
        .range_files(SessionId(session), &parse_oid(&newer)?, &parse_oid(&older)?)
        .await?;
    Ok(RangeFiles {
        base,
        files: files.into_iter().map(Into::into).collect(),
    })
}

/// 고급 검색 (GRAPH-07)
#[tauri::command]
#[specta::specta]
pub async fn search_advanced(
    state: State<'_, AppState>,
    session: u32,
    query: AdvancedSearchDto,
    limit: u32,
) -> Result<SearchResult, IpcError> {
    let q = AdvancedSearch {
        text: query.text,
        author: query.author,
        path: query.path,
        pickaxe: query
            .pickaxe
            .filter(|p| !p.trim().is_empty())
            .map(|pattern| Pickaxe {
                pattern,
                regex: query.pickaxe_regex,
            }),
        since: query.since,
        until: query.until,
    };
    let r = state
        .core()?
        .core
        .search_advanced(SessionId(session), &q, limit as usize)
        .await?;
    Ok(SearchResult {
        rows: r.rows,
        total: r.total,
        truncated: r.truncated,
    })
}

/// 외부 diff 도구 대상
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DifftoolTargetDto {
    WorkTree {
        path: String,
        staged: bool,
    },
    Commit {
        oid: String,
        path: String,
    },
    Range {
        a: String,
        b: String,
        three_dot: bool,
        path: String,
    },
}

/// 외부 diff 도구 열기 (DIFF-07)
#[tauri::command]
#[specta::specta]
pub async fn open_difftool(
    state: State<'_, AppState>,
    session: u32,
    target: DifftoolTargetDto,
) -> Result<(), IpcError> {
    let t = match target {
        DifftoolTargetDto::WorkTree { path, staged } => DifftoolTarget::WorkTree { path, staged },
        DifftoolTargetDto::Commit { oid, path } => DifftoolTarget::Commit {
            oid: parse_oid(&oid)?,
            path,
        },
        DifftoolTargetDto::Range {
            a,
            b,
            three_dot,
            path,
        } => DifftoolTarget::Range {
            a,
            b,
            three_dot,
            path,
        },
    };
    state
        .core()?
        .core
        .open_difftool(SessionId(session), t)
        .await?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 필터 필드가 없는 옛 질의(프런트가 저장해 둔 값)도 "필터 없음"으로 읽힌다
    #[test]
    fn old_query_without_filter_reads_as_no_filter() {
        let q: GraphQuery = serde_json::from_value::<GraphQueryDto>(serde_json::json!({
            "revs": {"kind": "all"},
            "hideRemotes": false,
            "pathScope": [],
            "sort": "topo",
            "firstParent": false,
            "noMerges": false
        }))
        .unwrap()
        .into();
        assert!(q.is_default(), "{q:?}");
        assert_eq!(q.filter, CommitFilter::default());
    }

    /// 필터 안의 필드도 빠지면 기본값이다. 날짜는 epoch 초 숫자, 비우면 null
    #[test]
    fn partial_filter_fills_defaults_and_round_trips() {
        let q: GraphQuery = serde_json::from_value::<GraphQueryDto>(serde_json::json!({
            "revs": {"kind": "head"},
            "hideRemotes": true,
            "pathScope": ["src"],
            "sort": "date",
            "firstParent": false,
            "noMerges": false,
            "filter": {"text": {"pattern": "fix"}, "since": 1700000000}
        }))
        .unwrap()
        .into();
        assert_eq!(q.filter.text.pattern, "fix");
        assert!(!q.filter.text.regex && !q.filter.text.match_case);
        assert!(q.filter.authors.is_empty());
        assert_eq!(
            (q.filter.since, q.filter.until),
            (Some(1_700_000_000), None)
        );

        let back = serde_json::to_value(GraphQueryDto::from(q)).unwrap();
        assert_eq!(
            back["filter"],
            serde_json::json!({
                "text": {"pattern": "fix", "regex": false, "matchCase": false},
                "authors": [],
                "since": 1700000000,
                "until": null
            })
        );
    }

    /// 작성자 후보는 `{authors:[{name,email,commits}], total, truncated, timedOut}` 로 나간다
    #[test]
    fn author_list_wire_shape() {
        let dto = AuthorListDto::from(AuthorList {
            authors: vec![mgit_core::AuthorCandidate {
                name: "Kim".into(),
                email: "kim@x.com".into(),
                commits: 3,
            }],
            total: 1,
            truncated: false,
            timed_out: true,
        });
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            serde_json::json!({
                "authors": [{"name": "Kim", "email": "kim@x.com", "commits": 3}],
                "total": 1,
                "truncated": false,
                "timedOut": true
            })
        );
    }
}

/// 전체 원문과 확정된 비교 기준을 함께 조회한다.
#[tauri::command]
#[specta::specta]
pub async fn compare_file_diff_document(
    state: State<'_, AppState>,
    session: u32,
    a: String,
    b: String,
    three_dot: bool,
    path: String,
    options: DiffOptionsDto,
    full: bool,
) -> Result<crate::dto_diff::DiffDocument, IpcError> {
    let d = state
        .core()?
        .core
        .compare_file_diff_document(
            SessionId(session),
            &a,
            &b,
            three_dot,
            &path,
            options.into(),
            full,
        )
        .await?;
    Ok(d.into())
}
