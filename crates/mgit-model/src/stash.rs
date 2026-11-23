use serde::Serialize;

use crate::oid::Oid;

/// 스태시 항목 (`git stash list`)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// `stash@{n}` 의 n
    pub index: u32,
    /// 스태시 커밋
    pub oid: Oid,
    /// 스태시를 만든 시점의 HEAD (첫 부모)
    pub base: Option<Oid>,
    /// reflog 제목 (`WIP on main: abc1234 subject` 또는 사용자 메시지)
    pub message: String,
    /// 커밋 시각 (epoch 초)
    pub time: i64,
    /// `-u` 로 untracked 파일을 포함했는지 (세 번째 부모 존재)
    pub includes_untracked: bool,
    /// 메시지에서 뽑은 브랜치명 (`WIP on <branch>` / `On <branch>`)
    pub branch: Option<String>,
}

impl StashInfo {
    /// `WIP on main: …` / `On main: …` 형식에서 브랜치명을 뽑는다
    pub fn branch_from_message(message: &str) -> Option<String> {
        let rest = message
            .strip_prefix("WIP on ")
            .or_else(|| message.strip_prefix("On "))?;
        let (branch, _) = rest.split_once(':')?;
        let branch = branch.trim();
        (!branch.is_empty() && branch != "(no branch)").then(|| branch.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_is_parsed_from_default_messages() {
        assert_eq!(
            StashInfo::branch_from_message("WIP on main: abc1234 subject").as_deref(),
            Some("main")
        );
        assert_eq!(
            StashInfo::branch_from_message("On feature/x: my message").as_deref(),
            Some("feature/x")
        );
        assert_eq!(
            StashInfo::branch_from_message("WIP on (no branch): abc1234 x"),
            None
        );
        assert_eq!(StashInfo::branch_from_message("custom"), None);
    }
}
