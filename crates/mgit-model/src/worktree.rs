use std::path::PathBuf;

use serde::Serialize;

use crate::oid::Oid;

/// 워크트리 항목 (`git worktree list --porcelain -z`)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: PathBuf,
    /// HEAD 커밋. bare 나 unborn 이면 `None`
    pub head: Option<Oid>,
    /// 체크아웃된 브랜치 전체 이름 (`refs/heads/main`). detached 면 `None`
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    /// 잠김 여부와 이유 (`Some("")` = 이유 없음)
    pub locked: Option<String>,
    /// 폴더가 사라져 정리 대상인지와 이유
    pub prunable: Option<String>,
    /// 첫 항목(메인 워크트리)인지
    pub is_main: bool,
}
