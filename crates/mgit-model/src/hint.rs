use serde::Serialize;

/// 실패한 쓰기 명령의 stderr 를 분류한 힌트. 프런트가 전용 대화상자로 분기한다
/// (BR-03 변경 중 전환, WT-05 워크트리 충돌, BR-04 미병합 삭제, SF-05 오류 안내)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GitHint {
    /// 로컬 변경이 덮어써질 수 있어 checkout·merge 가 거부됨
    DirtyWorkTree { files: Vec<String> },
    /// 브랜치가 다른 워크트리에 체크아웃돼 있음
    BranchCheckedOutElsewhere { path: String },
    /// 병합되지 않은 브랜치 삭제 거부
    NotFullyMerged,
    /// 충돌이 발생해 작업이 중단됨
    Conflicts,
    /// `index.lock` 이 남아 있음
    IndexLock,
    /// non-fast-forward 로 push 거부
    NonFastForward,
    /// 인증 실패
    AuthFailed,
    /// 원격 ref 가 바뀌어 `--force-with-lease`·`--force-if-includes` 가 거부됨
    StaleInfo,
    /// detached HEAD 라 push·브랜치 작업이 거부됨
    DetachedHead,
    /// stage 된 변경이 없음
    NothingToCommit,
    /// hook 이 실패해 작업이 거부됨
    HookFailed,
    /// 업스트림이 없어 push·pull 대상이 없음
    NoUpstream,
    /// 원격에 같은 이름의 다른 tag 가 있어 push 가 거부됨 (`(already exists)`)
    RemoteTagExists,
    /// 서버가 ref 갱신을 거부함 (`[remote rejected]`, pre-receive hook·보호 규칙 등). `reason` 은 괄호 안 사유
    RemoteRejected { reason: String },
}

/// stderr 본문에서 힌트를 분류한다. 영어 메시지 패턴에 의존하므로 실패해도 원문은 항상 보여 준다
pub fn classify_stderr(stderr: &str) -> Option<GitHint> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("index.lock") {
        return Some(GitHint::IndexLock);
    }
    if lower.contains("is already used by worktree at")
        || lower.contains("is already checked out at")
        || lower.contains("already used by worktree")
    {
        let path = stderr
            .split('\'')
            .rfind(|s| s.starts_with('/') || s.chars().nth(1) == Some(':'))
            .unwrap_or("")
            .to_string();
        return Some(GitHint::BranchCheckedOutElsewhere { path });
    }
    if lower.contains("would be overwritten by") || lower.contains("your local changes") {
        let files = stderr
            .lines()
            .filter(|l| l.starts_with('\t'))
            .map(|l| l.trim().to_string())
            .collect();
        return Some(GitHint::DirtyWorkTree { files });
    }
    if lower.contains("is not fully merged") {
        return Some(GitHint::NotFullyMerged);
    }
    if lower.contains("stale info") || lower.contains("remote ref updated since checkout") {
        return Some(GitHint::StaleInfo);
    }
    // push 거부는 구체적인 것부터: non-fast-forward → tag 이름 충돌 → 서버 거부 → 그 밖의 push 실패(NFF 대비책).
    // 예전에는 `failed to push some refs` 만 보고 NFF 로 판단해 tag·hook 거부에도 강제 push 를 권했다
    if lower.contains("non-fast-forward") || lower.contains("fetch first") {
        return Some(GitHint::NonFastForward);
    }
    if lower.contains("(already exists)") {
        return Some(GitHint::RemoteTagExists);
    }
    if let Some(reason) = remote_rejected_reason(stderr) {
        return Some(GitHint::RemoteRejected { reason });
    }
    if lower.contains("failed to push some refs") {
        return Some(GitHint::NonFastForward);
    }
    if lower.contains("authentication failed")
        || lower.contains("permission denied (publickey")
        || lower.contains("could not read username")
        || lower.contains("terminal prompts disabled")
        || lower.contains("invalid username or")
    {
        return Some(GitHint::AuthFailed);
    }
    if lower.contains("conflict") || lower.contains("automatic merge failed") {
        return Some(GitHint::Conflicts);
    }
    // 아래는 다른 패턴에 걸리지 않을 때만 (status 꼬리말의 "no changes added" 가 충돌을 가리지 않게)
    if lower.contains("not currently on a branch") || lower.contains("detached head") {
        return Some(GitHint::DetachedHead);
    }
    if lower.contains("has no upstream branch") || lower.contains("no tracking information") {
        return Some(GitHint::NoUpstream);
    }
    if lower.contains("nothing to commit") {
        return Some(GitHint::NothingToCommit);
    }
    if lower.contains("hook")
        && (lower.contains("declined") || lower.contains("failed") || lower.contains("rejected"))
    {
        return Some(GitHint::HookFailed);
    }
    None
}

/// `! [remote rejected] <src> -> <dst> (<사유>)` 줄의 사유. 그런 줄이 없으면 `None`, 괄호가 없으면 빈 문자열
fn remote_rejected_reason(stderr: &str) -> Option<String> {
    let line = stderr
        .lines()
        .find(|l| l.to_ascii_lowercase().contains("[remote rejected]"))?;
    let reason = line
        .rfind('(')
        .zip(line.rfind(')'))
        .filter(|(open, close)| open < close)
        .map(|(open, close)| line[open + 1..close].trim().to_string())
        .unwrap_or_default();
    Some(reason)
}

/// 서버가 자격 증명을 거부했는지. 취소·네트워크 오류와 구분해 저장된 비밀을 지울 때만 쓴다
pub fn credentials_rejected(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("authentication failed")
        || lower.contains("permission denied (")
        || lower.contains("invalid username or")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_rejected_only_on_server_refusal() {
        assert!(credentials_rejected(
            "fatal: Authentication failed for 'https://h/o/r.git/'\n"
        ));
        assert!(credentials_rejected(
            "git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.\n"
        ));
        assert!(credentials_rejected(
            "u@h: Permission denied (password,publickey).\n"
        ));
        assert!(credentials_rejected(
            "remote: Invalid username or password.\n"
        ));
        // 사용자가 대화상자를 취소했거나 연결이 안 된 경우는 비밀이 틀렸다는 뜻이 아니다
        assert!(!credentials_rejected(
            "fatal: could not read Password for 'https://u@h': terminal prompts disabled\n"
        ));
        assert!(!credentials_rejected(
            "fatal: unable to access 'https://h/': Could not resolve host: h\n"
        ));
    }

    #[test]
    fn dirty_work_tree_lists_files() {
        let s = "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tb/c.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
        assert_eq!(
            classify_stderr(s),
            Some(GitHint::DirtyWorkTree {
                files: vec!["a.txt".into(), "b/c.txt".into()]
            })
        );
    }

    #[test]
    fn worktree_conflict_extracts_path() {
        let s = "fatal: 'feature' is already used by worktree at '/tmp/wt'\n";
        assert_eq!(
            classify_stderr(s),
            Some(GitHint::BranchCheckedOutElsewhere {
                path: "/tmp/wt".into()
            })
        );
    }

    #[test]
    fn other_patterns() {
        assert_eq!(
            classify_stderr("error: The branch 'x' is not fully merged."),
            Some(GitHint::NotFullyMerged)
        );
        assert_eq!(
            classify_stderr("CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed"),
            Some(GitHint::Conflicts)
        );
        assert_eq!(
            classify_stderr("fatal: Unable to create '/r/.git/index.lock': File exists."),
            Some(GitHint::IndexLock)
        );
        assert_eq!(
            classify_stderr("! [rejected] main -> main (non-fast-forward)"),
            Some(GitHint::NonFastForward)
        );
        // --force-if-includes 거부도 "원격이 바뀌었다" 로 분류해 강제 push 를 다시 권하지 않는다
        assert_eq!(
            classify_stderr(
                " ! [rejected] main -> main (remote ref updated since checkout)\nerror: failed to push some refs to 'x'\n"
            ),
            Some(GitHint::StaleInfo)
        );
        assert_eq!(classify_stderr("fatal: unknown"), None);
    }

    /// TG-07: push 거부 분류 순서 (StaleInfo → NFF → tag 충돌 → 서버 거부 → NFF 대비책)
    #[test]
    fn push_rejection_order() {
        assert_eq!(
            classify_stderr(
                "To /r.git\n ! [rejected]        v1 -> v1 (already exists)\nerror: failed to push some refs to '/r.git'\nhint: Updates were rejected because the tag already exists in the remote.\n"
            ),
            Some(GitHint::RemoteTagExists)
        );
        assert_eq!(
            classify_stderr(
                "remote: nope\nTo /r.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to '/r.git'\n"
            ),
            Some(GitHint::RemoteRejected {
                reason: "pre-receive hook declined".into()
            })
        );
        // 사유 괄호가 없어도 서버 거부로 본다
        assert_eq!(
            classify_stderr(" ! [remote rejected] v1\nerror: failed to push some refs to 'x'\n"),
            Some(GitHint::RemoteRejected {
                reason: String::new()
            })
        );
        // 한 push 에 non-fast-forward 와 tag 충돌이 함께 있으면 NFF 가 먼저다
        assert_eq!(
            classify_stderr(
                " ! [rejected] main -> main (non-fast-forward)\n ! [rejected] v1 -> v1 (already exists)\nerror: failed to push some refs to 'x'\n"
            ),
            Some(GitHint::NonFastForward)
        );
        assert_eq!(
            classify_stderr(
                " ! [rejected] main -> main (fetch first)\nerror: failed to push some refs to 'x'\n"
            ),
            Some(GitHint::NonFastForward)
        );
        // lease 거부는 여전히 StaleInfo
        assert_eq!(
            classify_stderr(
                " ! [rejected] v1 (stale info)\nerror: failed to push some refs to 'x'\n"
            ),
            Some(GitHint::StaleInfo)
        );
        // 다른 줄 없이 실패만 말하면 예전처럼 NFF 로 본다 (마지막 대비책)
        assert_eq!(
            classify_stderr("error: failed to push some refs to 'x'\n"),
            Some(GitHint::NonFastForward)
        );
        // 로컬 tag 생성 실패는 원격 충돌이 아니다
        assert_eq!(classify_stderr("fatal: tag 'v1' already exists\n"), None);
    }
}
