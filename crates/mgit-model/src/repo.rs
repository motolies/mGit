use std::path::PathBuf;

use serde::Serialize;

use crate::refs::HeadState;

/// 열린 저장소 정보
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub work_tree: PathBuf,
    pub git_dir: PathBuf,
    /// 워크트리들이 공유하는 디렉터리. 쓰기 큐 단위
    pub common_dir: PathBuf,
    pub object_format: ObjectFormat,
    pub head: HeadState,
    pub commit_graph: CommitGraphStatus,
    /// 얕은 복제 (`<common_dir>/shallow` 존재)
    pub shallow: bool,
}

/// 객체 해시 형식
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObjectFormat {
    Sha1,
    Sha256,
}

/// commit-graph 파일 존재 여부 (AD-03 제안 근거)
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphStatus {
    pub present: bool,
}
