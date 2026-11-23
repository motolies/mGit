use serde::Serialize;

use crate::oid::Oid;

/// 진행 중인 작업 종류
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
    Am,
}

/// `$GIT_DIR` 의 상태 파일로 판별한 진행 중 작업 (MRG-05 배너의 근거)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InProgressOp {
    /// `MERGE_HEAD` 가 있음
    Merge { head: Oid },
    /// `rebase-merge/` 또는 `rebase-apply/` 가 있음
    Rebase {
        interactive: bool,
        /// 다시 적용 중인 브랜치 전체 이름 (`refs/heads/feature`). detached 면 `None`
        head_name: Option<String>,
        onto: Option<Oid>,
        /// 끝난 단계 수 (1부터 세는 현재 단계 = step + 1)
        step: u32,
        total: u32,
    },
    /// `CHERRY_PICK_HEAD`
    CherryPick {
        head: Oid,
        /// 여러 커밋을 순서대로 적용 중 (`sequencer/`)
        sequencer: bool,
    },
    /// `REVERT_HEAD`
    Revert { head: Oid, sequencer: bool },
    /// `BISECT_LOG`
    Bisect,
    /// `rebase-apply/applying`
    Am,
}

impl InProgressOp {
    /// 종류
    pub fn kind(&self) -> OpKind {
        match self {
            InProgressOp::Merge { .. } => OpKind::Merge,
            InProgressOp::Rebase { .. } => OpKind::Rebase,
            InProgressOp::CherryPick { .. } => OpKind::CherryPick,
            InProgressOp::Revert { .. } => OpKind::Revert,
            InProgressOp::Bisect => OpKind::Bisect,
            InProgressOp::Am => OpKind::Am,
        }
    }
}
