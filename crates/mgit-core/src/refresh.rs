//! 감시 이벤트·쓰기 명령 뒤의 재조회 파이프라인 (명세 2.4).
//!
//! 종류별로 필요한 것만 다시 읽고, 바뀐 것만 이벤트로 보낸다. 라벨 집합이나 HEAD 커밋이
//! 바뀌면 그래프를 그림자 재로드한다.

use std::sync::Arc;

use mgit_git::cmd::{
    head_state, in_progress_op, list_refs, list_remotes, list_stashes, list_worktrees,
};
use mgit_model::{ChangeKind, ChangeSet, GitError};

use crate::core::CoreInner;
use crate::events::CoreEvent;
use crate::ref_index::RefIndex;
use crate::session::RepoSession;
use crate::state::RepoRefs;

/// 재조회 범위
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RefreshScope {
    pub refs: bool,
    pub status: bool,
    pub op: bool,
    /// 사용자가 직접 새로고침했는지 (`GIT_OPTIONAL_LOCKS` 를 붙이지 않는다)
    pub interactive: bool,
}

impl RefreshScope {
    /// 전부
    pub fn all(interactive: bool) -> Self {
        RefreshScope {
            refs: true,
            status: true,
            op: true,
            interactive,
        }
    }

    /// 변경 묶음으로 범위를 정한다
    pub fn from_changes(changes: &ChangeSet) -> Self {
        let mut s = RefreshScope::default();
        for k in &changes.kinds {
            match k {
                ChangeKind::Head | ChangeKind::Refs | ChangeKind::PackedRefs => {
                    s.refs = true;
                    s.status = true;
                    s.op = true;
                }
                ChangeKind::Index | ChangeKind::WorkTree => s.status = true,
                ChangeKind::Op => {
                    s.op = true;
                    s.status = true;
                }
                ChangeKind::Config => s.refs = true,
            }
        }
        s
    }

    /// 아무것도 안 하는지
    pub fn is_empty(&self) -> bool {
        !(self.refs || self.status || self.op)
    }
}

impl CoreInner {
    /// 세션을 범위대로 다시 읽고 바뀐 것만 이벤트로 보낸다. 세션별로 직렬화된다
    pub async fn refresh_session(
        self: &Arc<Self>,
        session: &Arc<RepoSession>,
        scope: RefreshScope,
    ) {
        if scope.is_empty() {
            return;
        }
        let _serial = session.refresh_lock.lock().await;
        let mut status_changed = false;
        if scope.refs
            && let Err(e) = self.refresh_refs(session).await
        {
            tracing::warn!(session = ?session.id, error = %e, "ref 재조회 실패");
        }
        if scope.status {
            match self.read_status(session, scope.interactive).await {
                Ok(status) => {
                    let mut st = session.state_mut();
                    if st.status != status {
                        st.status = status;
                        status_changed = true;
                    }
                }
                Err(e) => tracing::warn!(session = ?session.id, error = %e, "status 재조회 실패"),
            }
        }
        if scope.op {
            match self.read_op(session).await {
                Ok(op) => {
                    let mut st = session.state_mut();
                    if st.op != op {
                        st.op = op;
                        status_changed = true;
                    }
                }
                Err(e) => {
                    tracing::warn!(session = ?session.id, error = %e, "진행 중 작업 판별 실패")
                }
            }
        }
        if status_changed {
            let (status, op) = {
                let st = session.state();
                (st.status.clone(), st.op.clone())
            };
            session.sink.emit(CoreEvent::StatusChanged {
                session: session.id,
                status,
                op,
            });
        }
    }

    /// HEAD·라벨·스태시·워크트리를 다시 읽는다. 바뀌면 `RefsChanged`, 그래프가 달라졌으면 재로드
    async fn refresh_refs(self: &Arc<Self>, session: &Arc<RepoSession>) -> Result<(), GitError> {
        let refs = self.read_refs(session).await?;
        let (changed, reload) = {
            let mut st = session.state_mut();
            if st.refs == refs {
                (false, false)
            } else {
                let reload = st.refs.graph_differs(&refs);
                st.refs = refs.clone();
                (true, reload)
            }
        };
        if !changed {
            return Ok(());
        }
        session.set_ref_index(RefIndex::new(refs.labels.clone()));
        session.sink.emit(CoreEvent::RefsChanged {
            session: session.id,
            refs,
        });
        if reload {
            self.schedule_reload(session);
        }
        Ok(())
    }

    /// ref 스냅샷을 읽는다
    pub async fn read_refs(&self, session: &RepoSession) -> Result<RepoRefs, GitError> {
        let wt = &session.info.work_tree;
        let runner = self.runner();
        let head = head_state(runner, wt).await?;
        let (labels, stashes, worktrees, remotes) = tokio::try_join!(
            list_refs(runner, wt, &head),
            list_stashes(runner, wt),
            list_worktrees(runner, wt),
            list_remotes(runner, wt),
        )?;
        Ok(RepoRefs {
            head,
            labels,
            stashes,
            worktrees,
            remotes,
        })
    }

    /// 작업 트리 상태를 읽는다. 가벼운 세션은 폴더 대시보드와 같은 길(`scanned_repo_status`)로 읽어
    /// 저장소 설정의 fsmonitor 명령을 실행하지 않고 index 를 다시 쓰지 않는다 (FS-12). `interactive` 는
    /// 전체 프로필에만 뜻이 있다
    pub async fn read_status(
        &self,
        session: &RepoSession,
        interactive: bool,
    ) -> Result<mgit_model::WorkTreeStatus, GitError> {
        let wt = &session.info.work_tree;
        if session.is_light() {
            return mgit_git::cmd::scanned_repo_status(self.runner(), wt).await;
        }
        mgit_git::cmd::work_tree_status(self.runner(), wt, interactive).await
    }

    /// 진행 중 작업을 읽는다
    pub async fn read_op(
        &self,
        session: &RepoSession,
    ) -> Result<Option<mgit_model::InProgressOp>, GitError> {
        in_progress_op(
            self.runner(),
            &session.info.git_dir,
            &session.info.common_dir,
            &session.info.work_tree,
        )
        .await
    }

    /// 감시 묶음을 받았을 때. 쓰기 명령 중이면 미룬다
    pub async fn on_changes(self: &Arc<Self>, session: Arc<RepoSession>, changes: ChangeSet) {
        if session.defer_if_suppressed(&changes) {
            return;
        }
        let scope = RefreshScope::from_changes(&changes);
        self.refresh_session(&session, scope).await;
    }
}
