//! 커밋 상세와 검색 (GRAPH-04, GRAPH-06), 커밋을 포함하는 브랜치 (CD-03)

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use mgit_git::cmd::{commit_files, commit_meta, containing_branches_with};
use mgit_model::{CancelToken, ChangedFile, Oid, RefLabel};
use serde::Serialize;

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::session::{LoadState, RepoSession};

/// 커밋 상세
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: Oid,
    pub parents: Vec<Oid>,
    /// 그래프에서 이 커밋을 부모로 둔 커밋들 (로드가 끝난 뒤에만 채워진다)
    pub children: Vec<Oid>,
    /// 그래프 행 번호 (그래프에 없으면 `None`)
    pub row: Option<u32>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub message: String,
    pub refs: Vec<RefLabel>,
    pub files: Vec<ChangedFile>,
}

/// 커밋 상세 중 그래프에 묶인 필드: 행 번호·자식·라벨. 저장소 세션은 자기 그래프에서, 폴더는 통합
/// 타임라인에서 채운다. 기본값(모두 빔)은 "그래프에 없음"이다
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct GraphPlace {
    pub row: Option<u32>,
    pub children: Vec<Oid>,
    pub refs: Vec<RefLabel>,
}

impl CommitDetail {
    /// 그래프에 묶인 필드를 `place` 로 채운다 (나머지 필드는 그대로)
    pub(crate) fn placed(self, place: GraphPlace) -> Self {
        CommitDetail {
            row: place.row,
            children: place.children,
            refs: place.refs,
            ..self
        }
    }
}

/// 저장소 세션 그래프에서 커밋의 자리. 자식 색인은 로드가 끝난 뒤 처음 요청할 때 한 번 만든다
fn session_place(s: &RepoSession, oid: &Oid) -> GraphPlace {
    let needs_build = {
        let g = s.graph();
        g.state == LoadState::Finished && !g.table.children_built()
    };
    if needs_build {
        s.graph_mut().table.build_children();
    }
    let (row, children) = {
        let g = s.graph();
        match g.table.row_of(oid) {
            Some(row) => (
                Some(row),
                g.table
                    .children_of(row)
                    .iter()
                    .map(|&r| g.table.oid(r))
                    .collect(),
            ),
            None => (None, Vec::new()),
        }
    };
    GraphPlace {
        row,
        children,
        refs: s.ref_index().labels_for(oid).to_vec(),
    }
}

/// 포함 브랜치 읽기의 시간 상한 (계획 5.5절). 넘으면 git 을 끝내고 `timed_out` 으로 알린다
pub(crate) const CONTAINING_TIMEOUT: Duration = Duration::from_secs(10);

/// 세션마다 마지막 요청만 살린다 (W18, 포함 브랜치). 이력이 깊은 저장소에서는 `for-each-ref --contains` 가 1초를
/// 넘는데(40만 커밋 × 원격 브랜치 300개: commit-graph 있음 1.2초, 없음 1.9초), 프런트는 커밋을 옮길 때마다 새로 묻고
/// 늦게 온 옛 응답은 버린다. 옛 요청의 git 이 끝까지 돌면 읽기 permit 과 CPU 를 잡고 있으므로, 같은 세션에서 새 요청이
/// 오면 앞 요청의 취소 토큰을 취소해 그 git 을 끝낸다.
///
/// 열쇠는 요청을 받은 세션이다 — 저장소 세션은 자기, 폴더는 폴더 세션. 폴더의 포함 브랜치는 저장소가 달라도 한
/// 화면(상세 칸)이 차례로 묻고 마지막 것만 보이므로(프런트의 폴더 스토어가 차례 하나로 옛 응답을 버린다) 저장소로
/// 나누지 않는다. 통합 타임라인은 이웃한 행의 저장소가 자주 바뀌어 저장소별로 나누면 빠르게 옮길 때 서로 끊지 못한다
#[derive(Default)]
pub(crate) struct LatestRequests {
    /// 요청 차례 (0 은 쓰지 않는다)
    next: AtomicU64,
    /// 세션 → (도는 마지막 요청의 차례, 그 토큰)
    live: Mutex<HashMap<SessionId, (u64, CancelToken)>>,
}

impl LatestRequests {
    /// 새 요청을 올린다: 같은 세션에 도는 요청이 있으면 그 토큰을 취소하고, 이 요청의 표식을 돌려준다
    fn begin(&self, session: SessionId) -> LatestGuard<'_> {
        let turn = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = CancelToken::new();
        let older = self
            .live
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session, (turn, cancel.clone()));
        if let Some((_, older)) = older {
            older.cancel();
        }
        LatestGuard {
            requests: self,
            session,
            turn,
            cancel,
        }
    }
}

/// 도는 요청 하나의 표식. 버려지면(끝났거나 호출자가 future 를 버렸으면) 아직 마지막 요청일 때만 자리를 비운다
pub(crate) struct LatestGuard<'a> {
    requests: &'a LatestRequests,
    session: SessionId,
    turn: u64,
    cancel: CancelToken,
}

impl LatestGuard<'_> {
    /// 그사이 같은 세션에 새 요청이 와서 밀렸는지
    fn superseded(&self) -> bool {
        self.requests
            .live
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&self.session)
            .is_none_or(|(turn, _)| *turn != self.turn)
    }
}

impl Drop for LatestGuard<'_> {
    /// 아직 마지막 요청이면 자리를 비운다 (밀렸으면 새 요청의 자리라 그대로 둔다)
    fn drop(&mut self) {
        let mut live = self
            .requests
            .live
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if live
            .get(&self.session)
            .is_some_and(|(t, _)| *t == self.turn)
        {
            live.remove(&self.session);
        }
    }
}

/// 커밋을 포함하는 브랜치 하나 (CD-03)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainingBranch {
    /// 전체 ref 이름 (`refs/heads/x`, `refs/remotes/origin/x`)
    pub name: String,
    /// 화면용 짧은 이름 (`x`, `origin/x`)
    pub short_name: String,
    /// 원격 추적 브랜치인지
    pub remote: bool,
    /// HEAD 가 가리키는 현재 브랜치인지
    pub current: bool,
}

/// 커밋을 포함하는 브랜치 목록 (CD-03). 태그는 들지 않는다
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainingRefs {
    /// 시간 상한 안에 끝나지 않아 git 을 멈췄다. 이때 `head`·`branches` 는 비어 있다 (모른다는 뜻)
    pub timed_out: bool,
    /// HEAD(브랜치든 분리 HEAD 든)에서 그 커밋에 닿는지. 화면은 목록 맨 앞에 `HEAD` 로 보인다
    pub head: bool,
    /// 현재 브랜치 → 로컬(이름순) → 원격(이름순). 원격 `HEAD` 심볼릭 ref 는 없다
    pub branches: Vec<ContainingBranch>,
}

/// git 이 준 포함 브랜치를 화면 순서(현재 브랜치 → 로컬 → 원격, 각각 이름순)로 바꾼다
fn ordered(found: mgit_git::cmd::Containing) -> ContainingRefs {
    let mut branches: Vec<ContainingBranch> = found
        .branches
        .into_iter()
        .map(|b| ContainingBranch {
            name: b.full_name,
            short_name: b.short_name,
            remote: b.remote,
            current: b.current,
        })
        .collect();
    branches.sort_by(|a, b| {
        let rank = |x: &ContainingBranch| (x.remote, !x.current);
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.short_name.cmp(&b.short_name))
    });
    ContainingRefs {
        timed_out: false,
        head: found.head,
        branches,
    }
}

/// 검색 대상 필드
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchFields {
    pub subject: bool,
    pub author: bool,
    pub hash: bool,
}

impl Default for SearchFields {
    fn default() -> Self {
        SearchFields {
            subject: true,
            author: true,
            hash: true,
        }
    }
}

/// 검색 결과: 일치한 행 번호 (오름차순)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub rows: Vec<u32>,
    /// 전체 일치 수 (`rows` 는 상한까지만)
    pub total: u32,
    pub truncated: bool,
}

impl Core {
    /// 커밋 상세: 메타데이터, 부모·자식, 라벨, 바꾼 파일 목록.
    /// git 을 돈 뒤에 그래프에서 행·자식·라벨을 채운다. 가벼운 세션은 그래프가 비어 있어 행·자식이 비고
    /// 라벨(ref 색인은 상태에서 만든다)만 채워진다 — 폴더 API 의 "타임라인이 없을 때"와 같은 모양이다
    pub async fn commit_detail(
        &self,
        session: SessionId,
        oid: &Oid,
    ) -> Result<CommitDetail, CoreError> {
        let s = self.inner().get(session)?;
        let detail = self.commit_detail_at(&s.info.work_tree, oid).await?;
        Ok(detail.placed(session_place(&s, oid)))
    }

    /// 작업 트리 경로로 커밋을 읽어 그래프와 무관한 상세를 만든다 (저장소 세션·폴더 공용).
    /// git 은 메타데이터(`log -1`)·파일 목록(`diff-tree`, 머지는 첫 부모 기준, 루트는 빈 트리 기준)
    /// 두 번만 돈다. 행·자식·라벨은 비어 있으므로 호출자가 `placed` 로 채운다.
    /// 그 저장소에 없는 커밋은 git 오류(`bad object`)가 그대로 `CoreError::Git` 으로 나간다
    pub(crate) async fn commit_detail_at(
        &self,
        work_tree: &Path,
        oid: &Oid,
    ) -> Result<CommitDetail, CoreError> {
        let runner = self.inner().runner();
        let meta = commit_meta(runner, work_tree, oid).await?;
        let files = commit_files(runner, work_tree, oid, !meta.parents.is_empty()).await?;
        Ok(CommitDetail {
            oid: meta.oid,
            parents: meta.parents,
            children: Vec::new(),
            row: None,
            author_name: meta.author_name,
            author_email: meta.author_email,
            author_time: meta.author_time,
            committer_name: meta.committer_name,
            committer_email: meta.committer_email,
            committer_time: meta.committer_time,
            message: meta.message,
            refs: Vec::new(),
            files,
        })
    }

    /// 커밋을 포함하는 로컬·원격 브랜치와 HEAD 포함 여부 (CD-03). 커밋 상세와 따로, 뒤늦게 부른다.
    /// 10초 안에 끝나지 않으면 git 을 끝내고 `timed_out` 이다. 그 저장소에 없는 커밋은 `CoreError::Git`.
    /// 같은 세션의 다음 요청이 오면 이 요청의 git 을 끝내고 `CoreError::Cancelled` 다 (마지막 요청만 산다)
    pub async fn commit_containing_refs(
        &self,
        session: SessionId,
        oid: &Oid,
    ) -> Result<ContainingRefs, CoreError> {
        let work_tree = self.inner().get(session)?.info.work_tree.clone();
        self.containing_refs_at(session, &work_tree, oid, CONTAINING_TIMEOUT)
            .await
    }

    /// 작업 트리 경로로 포함 브랜치를 읽는다 (저장소 세션·폴더 공용). 그래프·타임라인을 보지 않고 git 으로만
    /// 정한다: `for-each-ref --contains` 1회, 현재 브랜치가 목록에 없으면 HEAD 확인(`merge-base
    /// --is-ancestor`) 1회 더. 요청마다 붙이는 설정(`git_config_overrides`)도 함께 넘긴다.
    /// `session` 은 요청을 받은 세션(폴더면 폴더 세션)이고, 그 세션의 앞 요청이 아직 돌면 끝낸다 (`LatestRequests`).
    /// 이 요청이 그사이 밀렸으면 결과와 무관하게 `CoreError::Cancelled` 다
    pub(crate) async fn containing_refs_at(
        &self,
        session: SessionId,
        work_tree: &Path,
        oid: &Oid,
        limit: Duration,
    ) -> Result<ContainingRefs, CoreError> {
        let inner = self.inner();
        let latest = inner.containing.begin(session);
        let found = containing_branches_with(
            inner.runner(),
            work_tree,
            &inner.cfg.git_config_overrides,
            oid,
            limit,
            &latest.cancel,
        )
        .await;
        if latest.superseded() {
            return Err(CoreError::Cancelled);
        }
        Ok(found?.map(ordered).unwrap_or(ContainingRefs {
            timed_out: true,
            ..ContainingRefs::default()
        }))
    }

    /// 메모리의 커밋 테이블을 훑어 메시지(제목)·작성자·해시 접두로 검색한다 (대소문자 무시)
    pub fn search_commits(
        &self,
        session: SessionId,
        query: &str,
        fields: SearchFields,
        limit: usize,
    ) -> Result<SearchResult, CoreError> {
        let s = self.inner().get_graph(session)?;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(SearchResult {
                rows: Vec::new(),
                total: 0,
                truncated: false,
            });
        }
        let is_hexish = needle.len() >= 4 && needle.bytes().all(|b| b.is_ascii_hexdigit());
        let g = s.graph();
        let mut rows = Vec::new();
        let mut total = 0u32;
        for row in 0..g.table.len() as u32 {
            let hit = (fields.hash && is_hexish && g.table.oid(row).to_hex().starts_with(&needle))
                || (fields.subject && g.table.subject(row).to_lowercase().contains(&needle))
                || (fields.author && {
                    let (name, email) = g.table.author(row);
                    name.to_lowercase().contains(&needle) || email.to_lowercase().contains(&needle)
                });
            if hit {
                total += 1;
                if rows.len() < limit {
                    rows.push(row);
                }
            }
        }
        Ok(SearchResult {
            truncated: total as usize > rows.len(),
            rows,
            total,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use mgit_model::{
        BoxFuture, CancelToken, GitError, GitOutput, GitRequest, GitRunner, GitStream, GitVersion,
        OutputSink,
    };

    use super::*;
    use crate::config::CoreConfig;

    /// 취소될 때까지 끝나지 않는 러너. 받은 요청의 취소 토큰을 남긴다
    struct Stuck {
        version: GitVersion,
        tokens: Mutex<Vec<CancelToken>>,
        calls: AtomicUsize,
    }

    impl Stuck {
        /// 새 러너
        fn new() -> Self {
            Stuck {
                version: GitVersion::parse("git version 2.54.0").unwrap(),
                tokens: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            }
        }

        /// 요청을 받아 취소될 때까지 기다린다 (토큰이 없으면 영원히)
        fn hang<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let token = req.cancel.clone();
            if let Some(t) = &token {
                self.tokens.lock().unwrap().push(t.clone());
            }
            Box::pin(async move {
                match token {
                    Some(t) => t.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
                Err(GitError::Cancelled)
            })
        }
    }

    impl GitRunner for Stuck {
        fn version(&self) -> &GitVersion {
            &self.version
        }

        fn run<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>> {
            self.hang(req)
        }

        fn run_observed<'a>(
            &'a self,
            req: GitRequest,
            _sink: Arc<dyn OutputSink>,
        ) -> BoxFuture<'a, Result<GitOutput, GitError>> {
            self.hang(req)
        }

        fn stream<'a>(
            &'a self,
            _req: GitRequest,
        ) -> BoxFuture<'a, Result<Box<dyn GitStream>, GitError>> {
            Box::pin(async { Err(GitError::Unsupported("stream".into())) })
        }
    }

    /// 상한 안에 git 이 끝나지 않으면 오류가 아니라 `timed_out` 이고, 요청은 취소 토큰으로 멈춘다
    #[tokio::test]
    async fn slow_git_is_reported_as_timed_out_and_cancelled() {
        let runner = Arc::new(Stuck::new());
        let core = Core::new(
            Arc::clone(&runner) as Arc<dyn GitRunner>,
            CoreConfig::default(),
        );
        let oid = Oid::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
        let got = core
            .containing_refs_at(
                SessionId(1),
                Path::new("/nowhere"),
                &oid,
                Duration::from_millis(50),
            )
            .await
            .unwrap();
        assert_eq!(
            got,
            ContainingRefs {
                timed_out: true,
                head: false,
                branches: Vec::new(),
            }
        );
        assert_eq!(
            runner.calls.load(Ordering::SeqCst),
            1,
            "for-each-ref 에서 멈췄다"
        );
        let tokens = runner.tokens.lock().unwrap();
        assert_eq!(tokens.len(), 1);
        assert!(tokens[0].is_cancelled(), "시간 초과면 git 을 취소해야 한다");
        drop(tokens);
        assert!(
            core.inner().containing.live.lock().unwrap().is_empty(),
            "끝난 요청은 자리를 남기지 않는다"
        );
    }

    /// 같은 세션의 새 요청이 오면 앞 요청의 토큰이 취소되고 앞 요청은 `Cancelled` 다. 다른 세션의 요청은 끊지 않는다
    #[tokio::test]
    async fn a_newer_request_cancels_only_the_same_session() {
        let runner = Arc::new(Stuck::new());
        let core = Core::new(
            Arc::clone(&runner) as Arc<dyn GitRunner>,
            CoreConfig::default(),
        );
        let oid = Oid::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
        let wt = Path::new("/nowhere");
        let long = Duration::from_secs(10);
        let short = Duration::from_millis(50);
        // 앞 요청(상한 10초)이 git 에서 멈춘 뒤 같은 세션의 새 요청(상한 50ms)이 온다
        let older = core.containing_refs_at(SessionId(1), wt, &oid, long);
        let newer = async {
            while runner.calls.load(Ordering::SeqCst) < 1 {
                tokio::task::yield_now().await;
            }
            core.containing_refs_at(SessionId(1), wt, &oid, short).await
        };
        let (older, newer) = tokio::join!(older, newer);
        assert!(matches!(older, Err(CoreError::Cancelled)), "{older:?}");
        assert!(newer.unwrap().timed_out, "새 요청은 제 상한대로 끝난다");

        // 다른 세션: 앞 요청(상한 200ms)은 새 요청에 끊기지 않고 제 상한에서 끝난다
        let calls = runner.calls.load(Ordering::SeqCst);
        let older = core.containing_refs_at(SessionId(1), wt, &oid, Duration::from_millis(200));
        let newer = async {
            while runner.calls.load(Ordering::SeqCst) < calls + 1 {
                tokio::task::yield_now().await;
            }
            core.containing_refs_at(SessionId(2), wt, &oid, short).await
        };
        let (older, newer) = tokio::join!(older, newer);
        assert!(
            older.unwrap().timed_out,
            "다른 세션의 요청에 끊기면 안 된다"
        );
        assert!(newer.unwrap().timed_out);
        assert!(core.inner().containing.live.lock().unwrap().is_empty());
    }

    /// 화면 순서: 현재 브랜치 → 로컬 → 원격, 각각 이름순
    #[test]
    fn orders_current_then_locals_then_remotes() {
        let b = |name: &str, remote: bool, current: bool| mgit_git::cmd::ContainingBranch {
            full_name: format!("refs/{}/{name}", if remote { "remotes" } else { "heads" }),
            short_name: name.to_string(),
            remote,
            current,
        };
        let got = ordered(mgit_git::cmd::Containing {
            head: true,
            branches: vec![
                b("origin/a", true, false),
                b("zeta", false, false),
                b("main", false, true),
                b("alpha", false, false),
                b("origin/main", true, false),
            ],
        });
        assert!(got.head && !got.timed_out);
        assert_eq!(
            got.branches
                .iter()
                .map(|b| b.short_name.as_str())
                .collect::<Vec<_>>(),
            vec!["main", "alpha", "zeta", "origin/a", "origin/main"]
        );
        assert_eq!(got.branches[0].name, "refs/heads/main");
    }
}
