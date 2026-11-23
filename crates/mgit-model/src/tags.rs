//! tag 관리 (BR-06, TG-01~18) 도메인 타입: ref 단위 작업 결과

use serde::Serialize;

use crate::oid::Oid;

/// tag 하나에 대한 원격·로컬 작업 결과 (push·원격 삭제·가져오기·로컬 삭제)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TagRefStatus {
    /// 원격에 새로 올라감 (또는 갱신)
    Pushed,
    /// 원격에 이미 같은 객체가 있음
    UpToDate,
    /// 지워짐 (원격 또는 로컬)
    Deleted,
    /// 지우려 했는데 이미 없음 — 성공으로 친다
    AlreadyAbsent,
    /// 원격에서 받아 옴
    Fetched,
    /// 원격 tag 가 로컬(또는 기대한 값)과 다른 객체를 가리켜 실행하지 않음. `remote_oid` 로 다시 요청할 수 있다
    Diverged,
    /// 원격에 같은 이름의 다른 tag 가 있어 거부됨 (`already exists`)
    RejectedExists,
    /// lease 가 맞지 않아 거부됨 — 그 사이 원격이 바뀜 (`stale info`)
    RejectedStale,
    /// 서버가 거부함 (`[remote rejected]`, hook·보호 규칙). 사유는 `message`
    RejectedRemote,
    /// 그 밖의 실패. 원문은 `message`
    Failed,
    /// 취소·연결 끊김 등으로 결과를 알 수 없음 — 실패로 단정하지 않는다. 다시 확인해야 한다
    Unknown,
    /// 확인 대기로 실행하지 않음 (성공도 실패도 아님). 원격 삭제에서 같은 호출의 다른 tag 가 `Diverged` 라 사용자 확인 전에는
    /// 아무것도 지우지 않았다 — 확인한 뒤 다시 부르면 실행된다
    NotRun,
}

impl TagRefStatus {
    /// 원하는 결과에 도달했는지 (원격 삭제에서 `AlreadyAbsent` 도 성공)
    pub fn is_success(self) -> bool {
        matches!(
            self,
            TagRefStatus::Pushed
                | TagRefStatus::UpToDate
                | TagRefStatus::Deleted
                | TagRefStatus::AlreadyAbsent
                | TagRefStatus::Fetched
        )
    }
}

/// tag 하나의 작업 결과
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRefResult {
    /// tag 이름 (`refs/tags/` 뒤)
    pub name: String,
    pub status: TagRefStatus,
    /// 서버·git 이 준 사유나 실패 원문 (거부 사유, 취소 안내 등)
    pub message: Option<String>,
    /// 원격 ref 가 가리키는 객체 (annotated 면 tag 객체). `Diverged` 면 이 값을 `expected_remote` 로 넘겨 다시 요청한다
    pub remote_oid: Option<Oid>,
    /// 원격 ref 를 벗긴 commit (`^{}`). 확인창에 두 commit 을 보일 때 쓴다
    pub remote_commit: Option<Oid>,
}

impl TagRefResult {
    /// 사유 없는 결과
    pub fn new(name: impl Into<String>, status: TagRefStatus) -> Self {
        TagRefResult {
            name: name.into(),
            status,
            message: None,
            remote_oid: None,
            remote_commit: None,
        }
    }

    /// 사유를 붙인다
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

/// 원격 tag 하나 (`ls-remote --tags` 의 `refs/tags/<n>` 줄과 `refs/tags/<n>^{}` 줄을 합친 것)
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTag {
    /// tag 이름 (`refs/tags/` 뒤)
    pub name: String,
    /// ref 가 가리키는 객체 (annotated 면 tag 객체). lease 와 비교의 기준
    pub object: Oid,
    /// annotated 면 벗긴 객체 (`^{}` 줄), 경량이면 `None`
    pub peeled: Option<Oid>,
}

impl RemoteTag {
    /// 가리키는 commit (annotated 면 벗긴 것)
    pub fn commit(&self) -> Oid {
        self.peeled.unwrap_or(self.object)
    }
}

/// 로컬 tag 목록의 한 줄 (TG-10 ④ 열·툴팁 재료, `tag_list`)
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTag {
    /// tag 이름 (`refs/tags/` 뒤)
    pub name: String,
    pub annotated: bool,
    /// ref 가 가리키는 객체 (annotated 면 tag 객체)
    pub object: Oid,
    /// 벗긴 객체 (보통 commit). 경량이면 `object` 와 같다
    pub commit: Oid,
    /// 만든 시각 (epoch 초): annotated 는 tagger 날짜, 경량은 commit 날짜
    pub date: Option<i64>,
    /// 가리키는 commit 의 제목
    pub commit_subject: String,
    /// annotated 면 tag 메시지 제목
    pub tag_subject: Option<String>,
    /// annotated 면 tagger `이름 <메일>`
    pub tagger: Option<String>,
}

/// 로컬 tag 하나 (비교 재료). `object` 는 ref 가 가리키는 객체, `commit` 은 벗긴 commit
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalTagRef {
    pub name: String,
    pub object: Oid,
    pub commit: Oid,
}

/// 원격 하나에 대한 tag 하나의 상태 (TG-08 ③). 비교 기준은 ref 가 가리키는 객체
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TagSyncState {
    /// 로컬에만 있음 (push 안 됨)
    LocalOnly,
    /// 원격에만 있음
    RemoteOnly,
    /// 같은 객체
    Same,
    /// 다른 객체. `same_commit` 이면 벗긴 commit 은 같다 (예: 원격 경량, 로컬 annotated)
    Diverged { same_commit: bool },
    /// 결과를 알 수 없는 작업 뒤라 다시 확인해야 함
    Unknown,
}

/// 비교 결과 한 줄
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSyncEntry {
    pub name: String,
    pub state: TagSyncState,
    pub local_object: Option<Oid>,
    pub local_commit: Option<Oid>,
    pub remote_object: Option<Oid>,
    pub remote_commit: Option<Oid>,
}

/// 상태별 개수 (보고서 요약)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSyncCounts {
    pub local_only: u32,
    pub remote_only: u32,
    pub same: u32,
    pub diverged: u32,
    pub unknown: u32,
}

/// 원격 조회 실패 종류 (TG-08 ⑤)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TagLookupErrorKind {
    /// 인증 실패
    Auth,
    /// 연결 불가·원격 저장소 없음
    Network,
    /// 그 밖의 실패
    Other,
}

/// 마지막 원격 조회 실패. 이전 결과는 지우지 않는다
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLookupError {
    pub kind: TagLookupErrorKind,
    /// epoch 밀리초
    pub at: i64,
    /// 화면에 보일 한 줄 (자격 증명은 가린다)
    pub message: String,
}

/// 원격 하나의 tag 비교 보고서 (TG-08). 개수는 전부를 세고, 항목은 "같음"이 아닌 것만 이름순으로 싣는다
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSyncReport {
    pub remote: String,
    /// 마지막으로 성공한 조회 시각 (epoch 밀리초). 확인한 적이 없으면 `None` 이고 개수·항목이 비어 있다
    pub checked_at: Option<i64>,
    /// 조회 뒤 원격이 바뀌었을 수 있는 사건(tag 를 받아 온 fetch, follow-tags push, 결과를 알 수 없는 작업, 조회 중 쓰기)이
    /// 있었다
    pub stale: bool,
    pub last_error: Option<TagLookupError>,
    pub counts: TagSyncCounts,
    pub entries: Vec<TagSyncEntry>,
    /// push URL 이 fetch URL 과 달라 조회 대상과 쓰기 대상이 다를 수 있다
    pub push_url_differs: bool,
}

/// 로컬 tag 들과 원격 tag 표를 비교한다 (TG-08 ③). `unknown` 의 이름은 어느 쪽에 있든 `Unknown` 이다.
/// 개수와 "같음"이 아닌 항목(이름순)을 돌려준다
pub fn compare_tags(
    local: &[LocalTagRef],
    remote: &[RemoteTag],
    unknown: &std::collections::HashSet<String>,
) -> (TagSyncCounts, Vec<TagSyncEntry>) {
    use std::collections::HashMap;
    let remote_by: HashMap<&str, &RemoteTag> =
        remote.iter().map(|t| (t.name.as_str(), t)).collect();
    let mut counts = TagSyncCounts::default();
    let mut entries = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for l in local {
        if !seen.insert(l.name.as_str()) {
            continue;
        }
        let r = remote_by.get(l.name.as_str()).copied();
        let state = if unknown.contains(&l.name) {
            TagSyncState::Unknown
        } else {
            match r {
                None => TagSyncState::LocalOnly,
                Some(r) if r.object == l.object => TagSyncState::Same,
                Some(r) => TagSyncState::Diverged {
                    same_commit: r.commit() == l.commit,
                },
            }
        };
        bump(&mut counts, state);
        if state != TagSyncState::Same {
            entries.push(TagSyncEntry {
                name: l.name.clone(),
                state,
                local_object: Some(l.object),
                local_commit: Some(l.commit),
                remote_object: r.map(|r| r.object),
                remote_commit: r.map(RemoteTag::commit),
            });
        }
    }
    for r in remote {
        if !seen.insert(r.name.as_str()) {
            continue;
        }
        let state = if unknown.contains(&r.name) {
            TagSyncState::Unknown
        } else {
            TagSyncState::RemoteOnly
        };
        bump(&mut counts, state);
        entries.push(TagSyncEntry {
            name: r.name.clone(),
            state,
            local_object: None,
            local_commit: None,
            remote_object: Some(r.object),
            remote_commit: Some(r.commit()),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    (counts, entries)
}

/// 상태 하나를 센다
fn bump(counts: &mut TagSyncCounts, state: TagSyncState) {
    match state {
        TagSyncState::LocalOnly => counts.local_only += 1,
        TagSyncState::RemoteOnly => counts.remote_only += 1,
        TagSyncState::Same => counts.same += 1,
        TagSyncState::Diverged { .. } => counts.diverged += 1,
        TagSyncState::Unknown => counts.unknown += 1,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    /// 글자 하나로 만든 oid
    fn o(c: char) -> Oid {
        Oid::from_hex(c.to_string().repeat(40).as_bytes()).unwrap_or_else(|_| unreachable!())
    }

    /// 로컬 tag
    fn local(name: &str, object: char, commit: char) -> LocalTagRef {
        LocalTagRef {
            name: name.into(),
            object: o(object),
            commit: o(commit),
        }
    }

    /// 원격 tag
    fn remote(name: &str, object: char, peeled: Option<char>) -> RemoteTag {
        RemoteTag {
            name: name.into(),
            object: o(object),
            peeled: peeled.map(o),
        }
    }

    #[test]
    fn classifies_five_states_and_reports_non_same() {
        let locals = [
            local("only-local", 'a', 'a'),
            local("same", 'b', 'b'),
            local("diff", 'c', 'c'),
            // 로컬 annotated(객체 d, commit e), 원격 경량(commit e)
            local("same-commit", 'd', 'e'),
            local("unsure", 'f', 'f'),
        ];
        let remotes = [
            remote("same", 'b', None),
            remote("diff", '1', Some('2')),
            remote("same-commit", 'e', None),
            remote("only-remote", '3', Some('4')),
        ];
        let unknown: HashSet<String> = ["unsure".to_string()].into();
        let (counts, entries) = compare_tags(&locals, &remotes, &unknown);
        assert_eq!(
            counts,
            TagSyncCounts {
                local_only: 1,
                remote_only: 1,
                same: 1,
                diverged: 2,
                unknown: 1,
            }
        );
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            ["diff", "only-local", "only-remote", "same-commit", "unsure"]
        );
        let by = |n: &str| entries.iter().find(|e| e.name == n).map(|e| e.state);
        assert_eq!(
            by("diff"),
            Some(TagSyncState::Diverged { same_commit: false })
        );
        assert_eq!(
            by("same-commit"),
            Some(TagSyncState::Diverged { same_commit: true })
        );
        assert_eq!(by("only-local"), Some(TagSyncState::LocalOnly));
        assert_eq!(by("only-remote"), Some(TagSyncState::RemoteOnly));
        assert_eq!(by("unsure"), Some(TagSyncState::Unknown));
        let diff = entries.iter().find(|e| e.name == "diff");
        assert_eq!(diff.and_then(|e| e.remote_commit), Some(o('2')));
        assert_eq!(diff.and_then(|e| e.remote_object), Some(o('1')));
    }

    #[test]
    fn serializes_state_with_kind() {
        let json =
            serde_json::to_value(TagSyncState::Diverged { same_commit: true }).unwrap_or_default();
        assert_eq!(json["kind"], "diverged");
        assert_eq!(json["sameCommit"], true);
    }
}
