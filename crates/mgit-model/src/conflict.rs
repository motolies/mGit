use serde::{Deserialize, Serialize};

use crate::{ConflictKind, Oid};

/// 인덱스의 unmerged 항목 (`ls-files -u`). 스테이지 1=base, 2=ours, 3=theirs
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
    /// 어느 한쪽이라도 바이너리로 보이면 true (한쪽 선택만 가능, CF-12)
    pub binary: bool,
    /// 서브모듈 (gitlink, mode 160000)
    pub submodule: bool,
    /// [base, ours, theirs] 의 blob. 없는 쪽은 `None`
    pub stages: [Option<Oid>; 3],
}

/// 충돌의 어느 쪽인지
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// 편집기 열 제목 (CF-13). rebase 는 ours/theirs 의 의미가 뒤집히므로 설명을 붙인다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SideLabels {
    pub ours: String,
    pub base: String,
    pub theirs: String,
}

/// 해결한 파일을 다시 충돌 상태로 (CF-26)
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UnresolveMode {
    /// `checkout -m`: 작업 트리 파일을 git 의 자동 병합 결과로 다시 만든다
    Remake,
    /// `update-index --unresolve`: 작업 트리는 두고 인덱스만 되돌린다
    KeepWorktree,
}
