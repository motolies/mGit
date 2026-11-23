use std::path::PathBuf;

use serde::Serialize;

use crate::oid::Oid;

/// 그래프 행에 붙는 ref 라벨 (브랜치·태그)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    /// `refs/heads/main` 같은 전체 이름
    pub full_name: String,
    /// `main`, `origin/main`, `v1.0` 같은 표시 이름
    pub short_name: String,
    pub kind: RefKind,
    /// 가리키는 커밋. annotated 태그는 peeled 커밋
    pub target: Oid,
    /// HEAD 가 가리키는 로컬 브랜치인지
    pub is_current: bool,
    /// 업스트림 전체 이름 (`refs/remotes/origin/main`)
    pub upstream: Option<String>,
    /// 업스트림 대비 앞선 커밋 수 (업스트림 없으면 `None`)
    pub ahead: Option<u32>,
    /// 업스트림 대비 뒤처진 커밋 수
    pub behind: Option<u32>,
    /// 업스트림 ref 가 사라졌는지 (`[gone]`)
    pub upstream_gone: bool,
    /// 이 브랜치가 체크아웃된 워크트리 경로 (BR-01·WT-05)
    pub worktree_path: Option<PathBuf>,
    /// annotated tag 면 ref 가 가리키는 tag 객체 (`target` 은 벗긴 commit). 원격 tag 와의 비교에만 쓰고(TG-08) 화면으로는
    /// 보내지 않는다. 경량 tag·브랜치는 `None`
    #[serde(skip)]
    pub tag_object: Option<Oid>,
}

/// ref 종류
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch {
        remote: String,
    },
    Tag {
        annotated: bool,
    },
    /// `refs/stash` (가장 최근 스태시). 그래프에 스태시 커밋을 표시한다 (ST-04)
    Stash,
}

/// HEAD 상태
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HeadState {
    /// 브랜치를 가리킴
    Attached { branch: String, oid: Oid },
    /// 커밋을 직접 가리킴
    Detached { oid: Oid },
    /// 브랜치를 가리키지만 아직 커밋이 없음 (빈 저장소)
    Unborn { branch: String },
}

impl HeadState {
    /// HEAD 커밋이 있으면 돌려준다
    pub fn oid(&self) -> Option<Oid> {
        match self {
            HeadState::Attached { oid, .. } | HeadState::Detached { oid } => Some(*oid),
            HeadState::Unborn { .. } => None,
        }
    }

    /// 브랜치 전체 이름이 있으면 돌려준다 (`refs/heads/main`)
    pub fn branch(&self) -> Option<&str> {
        match self {
            HeadState::Attached { branch, .. } | HeadState::Unborn { branch } => Some(branch),
            HeadState::Detached { .. } => None,
        }
    }
}

/// `refs/remotes/` 뒤의 문자열에서 원격 이름을 찾는다. 원격 이름에 `/` 가 있을 수 있으므로
/// 등록된 원격 중 `<원격>/<브랜치>` 로 맞는 가장 긴 이름을 고른다
pub fn matching_remote<'a>(
    rest: &str,
    remotes: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    remotes
        .into_iter()
        .filter(|name| {
            rest.strip_prefix(name)
                .and_then(|r| r.strip_prefix('/'))
                .is_some_and(|branch| !branch.is_empty())
        })
        .max_by_key(|name| name.len())
}
