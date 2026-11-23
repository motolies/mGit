use serde::{Deserialize, Serialize};

use crate::Oid;

/// 그래프에 포함할 ref (GRAPH-08)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GraphRevs {
    /// 모든 ref (`--all`)
    #[default]
    All,
    /// 고른 브랜치·태그만
    Branches { names: Vec<String> },
    /// 한 ref 만 (solo)
    Solo { name: String },
    /// HEAD 에서 닿는 커밋만 (BT-03). detached 여도 되고, 통합 타임라인에서는 저장소마다 자기 HEAD 다
    Head,
}

/// 그래프 행 순서
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum GraphSort {
    /// `--topo-order`: 브랜치 커밋을 모아 선이 덜 엮인다
    #[default]
    Topo,
    /// `--date-order`: 커밋 시각 순 (자식 먼저는 유지)
    Date,
}

/// 해시(접두)로 보는 입력의 최소·최대 길이. 7 은 git 의 기본 축약 길이, 64 는 SHA-256 해시 길이
pub const HASH_PREFIX_MIN: usize = 7;
pub const HASH_PREFIX_MAX: usize = 64;

/// 커밋 메시지 텍스트 필터 (LG-06). 메시지 전체(제목+본문)에서 찾는다
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TextFilter {
    /// 찾을 글자. 비어 있으면 텍스트 필터가 없는 것이다 (공백도 글자로 본다)
    pub pattern: String,
    /// 참이면 POSIX 확장 정규식(ERE), 거짓이면 글자 그대로
    pub regex: bool,
    /// 참이면 대소문자를 구분한다 (거짓이면 ASCII 대소문자 무시)
    pub match_case: bool,
}

/// 커밋 필터 (계획 5.5, 결정 14). 텍스트·작성자·날짜는 서로 AND, 작성자 여럿은 OR.
/// 기본값은 "필터 없음"이고 그때의 `git log` 인자는 필터가 생기기 전과 같다
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitFilter {
    /// 메시지 텍스트. 입력이 해시 접두로 보이면(`hash_prefix`) 그 해시의 커밋도 결과에 든다
    pub text: TextFilter,
    /// 작성자 이메일(.mailmap 적용 뒤). 하나라도 맞으면 포함, 이메일 전체가 같아야 맞는다(ASCII 대소문자 무시)
    pub authors: Vec<String>,
    /// 커밋 시각(committer date) 하한, epoch 초, 경계 포함
    pub since: Option<i64>,
    /// 커밋 시각 상한, epoch 초, 경계 포함
    pub until: Option<i64>,
}

impl CommitFilter {
    /// 아무 조건도 없는지
    pub fn is_empty(&self) -> bool {
        !self.has_text() && self.authors.is_empty() && self.since.is_none() && self.until.is_none()
    }

    /// 텍스트 조건이 있는지 (빈 패턴은 조건이 아니다)
    pub fn has_text(&self) -> bool {
        !self.text.pattern.is_empty()
    }

    /// 결과가 이어진 이력이 아니라 흩어진 커밋인지 (텍스트·작성자). 이때 레이아웃은 목록 모드다.
    /// 날짜만 걸면 그 기간의 이력은 이어져 있으므로 그래프를 그린다
    pub fn scatters(&self) -> bool {
        self.has_text() || !self.authors.is_empty()
    }

    /// 텍스트 입력이 해시 접두로 보이면 소문자 hex 를 돌려준다: 앞뒤 공백을 뺀 값이 hex 7~64자.
    /// 정규식·대소문자 설정과 무관하다
    pub fn hash_prefix(&self) -> Option<String> {
        let p = self.text.pattern.trim();
        ((HASH_PREFIX_MIN..=HASH_PREFIX_MAX).contains(&p.len())
            && p.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| p.to_ascii_lowercase())
    }
}

/// 그래프 질의 (GRAPH-08 필터, MOD-03 경로 범위, 정렬·첫 부모·머지 제외, LG-06 커밋 필터)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphQuery {
    pub revs: GraphRevs,
    /// 원격 브랜치 숨기기 (`--exclude=refs/remotes/*` + 행 배지에서 원격 제외)
    pub hide_remotes: bool,
    /// 경로 범위. 비어 있지 않으면 `--full-history --parents -- <paths>`
    pub path_scope: Vec<String>,
    pub sort: GraphSort,
    /// `--first-parent`: 머지의 첫 부모만 따라간다 (레이아웃도 첫 부모만 잇는다)
    pub first_parent: bool,
    /// `--no-merges`: 머지 커밋 제외. DAG 가 끊기므로 레이아웃은 목록 모드(레인 0, 엣지 없음)
    pub no_merges: bool,
    /// 커밋 필터 (텍스트·해시·작성자·날짜). 옛 모양(필드 없음)은 "필터 없음"으로 읽힌다
    pub filter: CommitFilter,
}

impl GraphQuery {
    /// 기본 질의(전체, 토폴로지 순, 필터 없음)인지
    pub fn is_default(&self) -> bool {
        self.revs == GraphRevs::All
            && !self.hide_remotes
            && self.path_scope.is_empty()
            && self.sort == GraphSort::Topo
            && !self.first_parent
            && !self.no_merges
            && self.filter.is_empty()
    }

    /// 레이아웃을 목록 모드(그래프 선 없음)로 그리는지: 머지 제외, 또는 텍스트·작성자 필터
    pub fn list_mode(&self) -> bool {
        self.no_merges || self.filter.scatters()
    }

    /// 모든 ref 의 모든 커밋을 담는 질의인지 (정렬은 무관). 이 질의로 읽은 테이블은 이력 전체다
    pub fn covers_all_commits(&self) -> bool {
        self.revs == GraphRevs::All
            && !self.hide_remotes
            && self.path_scope.is_empty()
            && !self.first_parent
            && !self.no_merges
            && self.filter.is_empty()
    }
}

/// 작성자 후보 하나 (필터 바의 작성자 드롭다운). 이메일(ASCII 소문자로 접은 값)이 같은 커밋을 묶는다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorCandidate {
    /// 그 이메일로 가장 많이 쓴 이름 (.mailmap 적용 뒤)
    pub name: String,
    /// 가장 많이 쓴 철자의 이메일. `CommitFilter.authors` 에 이 값을 넣는다
    pub email: String,
    /// 커밋 수
    pub commits: u32,
}

/// 작성자 후보 목록 (커밋 수 내림차순 → 이름 → 이메일)
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorList {
    pub authors: Vec<AuthorCandidate>,
    /// 자르기 전 후보 수
    pub total: u32,
    /// 상한으로 잘렸는지
    pub truncated: bool,
    /// 시간 상한에 걸린 저장소가 있어 목록이 일부만 찼는지 (오류가 아니다)
    pub timed_out: bool,
}

/// 레이아웃 설정 (세션 단위, git 재실행 없이 재배치)
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphLayoutPrefs {
    /// GRAPH-13: HEAD 브랜치를 레인 0 에 고정
    pub pin_head: bool,
    /// ref 팁에서 브랜치 이름 색으로 전환
    pub ref_colors: bool,
    /// 긴 엣지를 스텁으로 접기
    pub collapse_long_edges: bool,
}

impl Default for GraphLayoutPrefs {
    /// 모두 켬
    fn default() -> Self {
        GraphLayoutPrefs {
            pin_head: true,
            ref_colors: true,
            collapse_long_edges: true,
        }
    }
}

/// diff 보기 옵션 (DIFF-03). 줄바꿈·탭 폭은 뷰 전용
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    /// `-w`
    pub ignore_whitespace: bool,
    /// `-U<n>`
    pub context: u32,
}

impl Default for DiffOptions {
    /// git 기본값
    fn default() -> Self {
        DiffOptions {
            ignore_whitespace: false,
            context: 3,
        }
    }
}

/// blame 한 줄 (DIFF-04)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: Oid,
    /// 그 커밋에서의 줄 번호
    pub orig_line: u32,
    /// 현재 파일의 줄 번호 (1부터)
    pub line: u32,
    pub author: String,
    pub author_mail: String,
    pub author_time: i64,
    pub summary: String,
    /// 직전 시점 (커밋, 그때 경로). 최초 추가면 None
    pub previous: Option<(Oid, String)>,
    /// 경계 커밋 (더 거슬러 갈 수 없음)
    pub boundary: bool,
    /// 줄 내용 (개행 제외)
    pub text: String,
}

/// 파일 히스토리 항목 (DIFF-05)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub oid: Oid,
    pub subject: String,
    pub author_name: String,
    pub author_time: i64,
    /// 그 커밋 시점의 경로 (`--follow` 로 이름 변경 추적)
    pub path: String,
}

/// 코드 내용 검색 (GRAPH-07): `-S`(문자열 등장 횟수 변화) 또는 `-G`(정규식 diff 일치)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pickaxe {
    pub pattern: String,
    /// true 면 `-G`, 아니면 `-S`
    pub regex: bool,
}

/// 고급 검색 조건 (GRAPH-07). 모두 AND 로 묶인다
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedSearch {
    /// 메시지 (`--grep`, 대소문자 무시)
    pub text: Option<String>,
    pub author: Option<String>,
    /// 파일 경로 (pathspec)
    pub path: Option<String>,
    pub pickaxe: Option<Pickaxe>,
    /// `--since` / `--until` (git 날짜 문법)
    pub since: Option<String>,
    pub until: Option<String>,
}

/// 외부 diff 도구 대상 (DIFF-07)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DifftoolTarget {
    /// 작업 트리 파일 (staged 면 index 대 HEAD)
    WorkTree { path: String, staged: bool },
    /// 커밋 하나의 파일 (첫 부모 기준)
    Commit { oid: Oid, path: String },
    /// 두 ref 사이
    Range {
        a: String,
        b: String,
        three_dot: bool,
        path: String,
    },
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 필터 필드가 없는 옛 질의 JSON 은 "필터 없음"으로 읽히고 기본 질의로 판정된다
    #[test]
    fn old_query_json_reads_with_no_filter() {
        let q: GraphQuery = serde_json::from_value(serde_json::json!({
            "revs": {"kind": "all"},
            "hideRemotes": false,
            "pathScope": [],
            "sort": "topo",
            "firstParent": false,
            "noMerges": false
        }))
        .unwrap();
        assert_eq!(q, GraphQuery::default());
        assert!(q.is_default() && q.covers_all_commits() && !q.list_mode());
        // 일부만 쓴 필터도 나머지는 기본값
        let q: GraphQuery =
            serde_json::from_value(serde_json::json!({"filter": {"authors": ["a@b"]}})).unwrap();
        assert_eq!(q.filter.authors, ["a@b"]);
        assert_eq!(q.filter.text, TextFilter::default());
        assert!(!q.is_default() && q.list_mode() && !q.covers_all_commits());
    }

    /// 텍스트·작성자는 목록 모드, 날짜만은 그래프. 빈 검색어는 조건이 아니다
    #[test]
    fn list_mode_follows_scattering_filters() {
        let with = |f: CommitFilter| GraphQuery {
            filter: f,
            ..GraphQuery::default()
        };
        let text = |p: &str| CommitFilter {
            text: TextFilter {
                pattern: p.into(),
                ..TextFilter::default()
            },
            ..CommitFilter::default()
        };
        assert!(with(text("x")).list_mode());
        assert!(!with(text("")).list_mode() && with(text("")).is_default());
        let dated = with(CommitFilter {
            since: Some(1),
            ..CommitFilter::default()
        });
        assert!(!dated.list_mode() && !dated.is_default() && !dated.covers_all_commits());
        assert!(
            GraphQuery {
                no_merges: true,
                ..GraphQuery::default()
            }
            .list_mode()
        );
    }

    /// 해시로 보는 입력: 앞뒤 공백을 뺀 hex 7~64자 (소문자로)
    #[test]
    fn hash_prefix_detection() {
        let prefix = |p: &str| {
            CommitFilter {
                text: TextFilter {
                    pattern: p.into(),
                    regex: true,
                    match_case: true,
                },
                ..CommitFilter::default()
            }
            .hash_prefix()
        };
        assert_eq!(prefix(" ABCdef0 "), Some("abcdef0".to_string()));
        assert_eq!(prefix(&"a".repeat(64)), Some("a".repeat(64)));
        assert_eq!(prefix("abcdef"), None); // 6자
        assert_eq!(prefix(&"a".repeat(65)), None);
        assert_eq!(prefix("abcdefg"), None); // g 는 hex 가 아니다
        assert_eq!(prefix("abc def0"), None);
        assert_eq!(prefix(""), None);
    }
}
