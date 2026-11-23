//! 작성자 후보 (LG-06): 필터 바의 작성자 드롭다운이 고를 목록.
//!
//! 후보는 필터를 걸기 전의 이력에서 나온다 (작성자로 거른 뒤의 목록에서 고르면 선택지가 사라진다).
//! 같은 이메일(ASCII 소문자로 접은 값)의 커밋을 한 사람으로 묶는다. 이름·이메일은 `%aN`·`%aE` 라 .mailmap 을
//! 따른다 — 필터의 `--author` 도 `--use-mailmap` 으로 같은 값에 맞춘다

use std::collections::HashMap;
use std::sync::PoisonError;
use std::time::Duration;

use mgit_git::cmd::{AuthorCount, log_authors};
use mgit_model::{AuthorCandidate, AuthorList};

use crate::commit_table::CommitTable;
use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::session::LoadState;

/// 돌려주는 후보 수 상한 (커밋 수가 많은 쪽부터)
pub const AUTHORS_MAX: usize = 1000;
/// 저장소 하나의 작성자 조회 시간 상한 (포함 브랜치와 같다). 넘으면 그 저장소는 빠지고 `timed_out`
pub(crate) const AUTHORS_TIMEOUT: Duration = Duration::from_secs(10);

/// 이메일 하나로 묶인 후보를 만드는 중간값
#[derive(Default)]
struct Group {
    commits: u32,
    names: HashMap<String, u32>,
    emails: HashMap<String, u32>,
}

/// 가장 많이 쓴 값 (같으면 사전순으로 앞선 값 — 결과가 늘 같다)
fn most_used(counts: HashMap<String, u32>) -> String {
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .map(|(v, _)| v)
        .unwrap_or_default()
}

/// (이름, 이메일) 별 커밋 수를 이메일로 묶어 후보 목록을 만든다. 정렬은 커밋 수 내림차순 → 이름(소문자) →
/// 이메일, 상한(`AUTHORS_MAX`)을 넘으면 자른다
pub(crate) fn group_authors(
    counts: impl IntoIterator<Item = AuthorCount>,
    timed_out: bool,
) -> AuthorList {
    let mut groups: HashMap<String, Group> = HashMap::new();
    for c in counts {
        let g = groups.entry(c.email.to_ascii_lowercase()).or_default();
        g.commits += c.commits;
        *g.names.entry(c.name).or_default() += c.commits;
        *g.emails.entry(c.email).or_default() += c.commits;
    }
    let mut authors: Vec<AuthorCandidate> = groups
        .into_values()
        .map(|g| AuthorCandidate {
            name: most_used(g.names),
            email: most_used(g.emails),
            commits: g.commits,
        })
        .collect();
    authors.sort_by(|a, b| {
        b.commits
            .cmp(&a.commits)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.email.cmp(&b.email))
    });
    let total = u32::try_from(authors.len()).unwrap_or(u32::MAX);
    let truncated = authors.len() > AUTHORS_MAX;
    authors.truncate(AUTHORS_MAX);
    AuthorList {
        authors,
        total,
        truncated,
        timed_out,
    }
}

/// 로드된 테이블의 행에서 (이름, 이메일) 별 커밋 수를 센다. `repo` 가 있으면 그 저장소의 행만 (통합 타임라인)
pub(crate) fn table_counts(table: &CommitTable, repo: Option<u16>) -> Vec<AuthorCount> {
    let mut index: HashMap<(&str, &str), u32> = HashMap::new();
    for row in 0..table.len() as u32 {
        if repo.is_some_and(|r| table.repo(row) != r) {
            continue;
        }
        *index.entry(table.author(row)).or_default() += 1;
    }
    index
        .into_iter()
        .map(|((name, email), commits)| AuthorCount {
            name: name.to_string(),
            email: email.to_string(),
            commits,
        })
        .collect()
}

impl Core {
    /// 저장소 탭의 작성자 후보: 모든 ref 에서 닿는 커밋(그래프 기본 범위)의 작성자. 지금 그래프가 이력 전체를
    /// 담고 있으면(필터·범위·첫 부모·머지 제외 없는 질의로 다 읽었고 재로드 중이 아니면) 그 테이블에서 세고
    /// git 을 돌리지 않는다. 아니면 `git log --all` 을 한 번 돈다(시간 상한 10초, 넘으면 빈 목록 + `timed_out`).
    /// 가벼운 세션은 그래프 API 라 `GraphUnavailable`
    pub async fn graph_authors(&self, session: SessionId) -> Result<AuthorList, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get_graph(session)?;
        let covered = s
            .graph_query
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .covers_all_commits();
        let reloading = s
            .reload
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running;
        if covered && !reloading {
            let g = s.graph();
            if g.state == LoadState::Finished {
                return Ok(group_authors(table_counts(&g.table, None), false));
            }
        }
        let found = log_authors(
            inner.runner(),
            &s.info.work_tree,
            &inner.cfg.git_config_overrides,
            None,
            AUTHORS_TIMEOUT,
        )
        .await?;
        Ok(match found {
            Some(counts) => group_authors(counts, false),
            None => group_authors(Vec::new(), true),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 작성자 수 한 줄
    fn count(name: &str, email: &str, commits: u32) -> AuthorCount {
        AuthorCount {
            name: name.into(),
            email: email.into(),
            commits,
        }
    }

    #[test]
    fn groups_by_email_ignoring_ascii_case_and_picks_the_most_used_spelling() {
        let list = group_authors(
            vec![
                count("Kim", "kim@x.com", 3),
                count("Kim Minsu", "Kim@X.com", 1),
                count("Kimberly", "kimberly@x.com", 2),
                count("Lee", "lee@x.com", 2),
            ],
            false,
        );
        let brief: Vec<(&str, &str, u32)> = list
            .authors
            .iter()
            .map(|a| (a.name.as_str(), a.email.as_str(), a.commits))
            .collect();
        // 같은 커밋 수면 이름순 (Kimberly < Lee)
        assert_eq!(
            brief,
            vec![
                ("Kim", "kim@x.com", 4),
                ("Kimberly", "kimberly@x.com", 2),
                ("Lee", "lee@x.com", 2),
            ]
        );
        assert_eq!(list.total, 3);
        assert!(!list.truncated && !list.timed_out);
    }

    #[test]
    fn caps_the_list_and_reports_the_total() {
        let counts: Vec<AuthorCount> = (0..AUTHORS_MAX + 5)
            .map(|i| count(&format!("a{i:05}"), &format!("a{i}@x"), 1))
            .collect();
        let list = group_authors(counts, true);
        assert_eq!(list.authors.len(), AUTHORS_MAX);
        assert_eq!(list.total as usize, AUTHORS_MAX + 5);
        assert!(list.truncated && list.timed_out);
        assert_eq!(list.authors[0].name, "a00000");
    }
}
