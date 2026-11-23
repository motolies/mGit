use std::path::PathBuf;

use serde::Serialize;

/// 원격 하나 (`git remote -v`)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    /// fetch URL 과 다를 때만 `Some`
    pub push_url: Option<String>,
}

/// pull 방식 (RM-03). `Default` 는 `pull.rebase`·`pull.ff` 설정을 따른다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullMode {
    Default,
    Merge,
    Rebase,
    FfOnly,
}

/// push 옵션 (RM-04). 강제 push 는 `--force-with-lease --force-if-includes` 만 제공한다
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PushSpec {
    /// 없으면 업스트림의 원격, 그것도 없으면 하나뿐인 원격이나 `origin`. 업스트림의 원격으로 보내면
    /// 업스트림 브랜치를 갱신하고, 다른 원격이면 같은 이름의 브랜치로 보낸다
    pub remote: Option<String>,
    /// `-u` 로 업스트림을 지정한다. 원격을 고르지 않았고 업스트림이 없으면 이 값과 무관하게 붙는다
    pub set_upstream: bool,
    /// `--follow-tags`
    pub tags: bool,
    pub force_with_lease: bool,
    /// 로컬과 이름이 다른 업스트림 브랜치로 보내도 좋다고 사용자가 확인했다
    pub confirm_upstream_mismatch: bool,
    /// 확인을 이 브랜치·업스트림 조합에 기억해 다음부터 묻지 않는다
    pub remember_upstream_mismatch: bool,
}

/// 워크트리 삭제 전 검사 결과 (WT-04)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveCheck {
    pub path: PathBuf,
    /// 체크아웃된 브랜치 (짧은 이름)
    pub branch: Option<String>,
    /// 커밋되지 않은 변경이 있음
    pub dirty: bool,
    /// 업스트림 대비 push 되지 않은 커밋 수. 업스트림이 없으면 `None`
    pub unpushed: Option<u32>,
    /// 메인 워크트리라 지울 수 없음
    pub is_main: bool,
}
