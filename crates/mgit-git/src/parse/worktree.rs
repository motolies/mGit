use std::path::PathBuf;

use mgit_model::{Oid, WorktreeInfo};

/// `git worktree list --porcelain -z` 출력을 파싱한다.
/// 속성 줄마다 NUL 로 끝나고, 항목 끝에는 빈 NUL 레코드가 하나 더 온다
pub fn parse_worktree_list(output: &[u8]) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeInfo> = None;
    for rec in output.split(|&b| b == 0) {
        if rec.is_empty() {
            if let Some(wt) = current.take() {
                out.push(wt);
            }
            continue;
        }
        let text = String::from_utf8_lossy(rec);
        let (key, value) = text.split_once(' ').unwrap_or((&text, ""));
        match key {
            "worktree" => {
                if let Some(wt) = current.take() {
                    out.push(wt);
                }
                current = Some(WorktreeInfo {
                    path: PathBuf::from(value),
                    head: None,
                    branch: None,
                    detached: false,
                    bare: false,
                    locked: None,
                    prunable: None,
                    is_main: out.is_empty(),
                });
            }
            _ => {
                let Some(wt) = current.as_mut() else {
                    continue;
                };
                match key {
                    "HEAD" => wt.head = Oid::from_hex(value.as_bytes()).ok(),
                    "branch" => wt.branch = Some(value.to_string()),
                    "detached" => wt.detached = true,
                    "bare" => wt.bare = true,
                    "locked" => wt.locked = Some(value.to_string()),
                    "prunable" => wt.prunable = Some(value.to_string()),
                    _ => {}
                }
            }
        }
    }
    if let Some(wt) = current.take() {
        out.push(wt);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_and_linked_worktrees() {
        let h = "a".repeat(40);
        let out = format!(
            "worktree /r\0HEAD {h}\0branch refs/heads/main\0\0worktree /r.worktrees/f\0HEAD {h}\0detached\0locked\0\0worktree /gone\0HEAD {h}\0branch refs/heads/x\0prunable gitdir file points to non-existent location\0\0"
        );
        let list = parse_worktree_list(out.as_bytes());
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("refs/heads/main"));
        assert!(list[1].detached && !list[1].is_main);
        assert_eq!(list[1].locked.as_deref(), Some(""));
        assert!(
            list[2]
                .prunable
                .as_deref()
                .unwrap_or("")
                .starts_with("gitdir")
        );
    }
}
