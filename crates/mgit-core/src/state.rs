use mgit_model::{
    HeadState, InProgressOp, RefLabel, RemoteInfo, StashInfo, WorkTreeStatus, WorktreeInfo,
};
use serde::Serialize;

/// ref 스냅샷: HEAD, 브랜치·태그 라벨, 스태시, 워크트리. `RefsChanged` 로 통째로 보낸다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRefs {
    pub head: HeadState,
    pub labels: Vec<RefLabel>,
    pub stashes: Vec<StashInfo>,
    pub worktrees: Vec<WorktreeInfo>,
    pub remotes: Vec<RemoteInfo>,
}

impl RepoRefs {
    /// 그래프 내용이 달라졌을 수 있는지: HEAD 커밋, 라벨 (이름, 대상), 스태시 커밋 집합을 비교한다.
    /// ahead/behind 나 워크트리 경로만 바뀐 경우는 재로드하지 않는다
    pub fn graph_differs(&self, other: &RepoRefs) -> bool {
        if self.head.oid() != other.head.oid() {
            return true;
        }
        if self.labels.len() != other.labels.len() || self.stashes.len() != other.stashes.len() {
            return true;
        }
        let mut a: Vec<(&str, _)> = self
            .labels
            .iter()
            .map(|l| (l.full_name.as_str(), l.target))
            .collect();
        let mut b: Vec<(&str, _)> = other
            .labels
            .iter()
            .map(|l| (l.full_name.as_str(), l.target))
            .collect();
        a.sort_unstable();
        b.sort_unstable();
        if a != b {
            return true;
        }
        let sa: Vec<_> = self.stashes.iter().map(|s| s.oid).collect();
        let sb: Vec<_> = other.stashes.iter().map(|s| s.oid).collect();
        sa != sb
    }
}

/// 세션의 저장소 상태 스냅샷 (그래프 제외)
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub refs: RepoRefs,
    pub status: WorkTreeStatus,
    pub op: Option<InProgressOp>,
}
