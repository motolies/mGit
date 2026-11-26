use std::path::Path;

use mgit_model::{EnvProfile, FileDiff, GitError, GitRequest, GitRunner, SignatureStatus};

use crate::parse::parse_diff;

/// `%G?` 서명 검증 (CHG-08). 서명이 없으면 code `N`
pub async fn commit_signature(
    runner: &dyn GitRunner,
    work_tree: &Path,
    oid: &str,
) -> Result<SignatureStatus, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "log",
            "-1",
            "--format=%G?%x00%GS%x00%GK",
            "--end-of-options",
            oid,
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    let text = String::from_utf8_lossy(&out);
    let mut f = text.trim_end().split('\0');
    Ok(SignatureStatus {
        code: f.next().unwrap_or("N").trim().to_string(),
        signer: f.next().unwrap_or("").trim().to_string(),
        key: f.next().unwrap_or("").trim().to_string(),
    })
}

/// 추적 파일 수 (`ls-files -z` 의 NUL 개수)
pub async fn tracked_count(runner: &dyn GitRunner, work_tree: &Path) -> Result<u32, GitError> {
    let req = GitRequest::new(work_tree, ["ls-files", "-z"]).with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(out.iter().filter(|&&b| b == 0).count() as u32)
}

/// 설정 값 하나를 범위(`--local`·`--global`)로 읽는다. 없으면 None
pub async fn config_get_scoped(
    runner: &dyn GitRunner,
    work_tree: &Path,
    scope: &str,
    key: &str,
) -> Option<String> {
    let req = GitRequest::new(work_tree, ["config", scope, "--get", key]);
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    let s = out.stdout_lossy();
    let v = s.trim_end_matches(['\n', '\r']);
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// bool 설정 (`--type=bool` 로 yes/on/1 을 정규화). 없으면 None
pub async fn config_get_bool(runner: &dyn GitRunner, work_tree: &Path, key: &str) -> Option<bool> {
    let req = GitRequest::new(work_tree, ["config", "--type=bool", "--get", key]);
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    match out.stdout_lossy().trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// staged 전체 diff (문맥 0줄) — 비밀 스캔용 (CHG-09)
pub async fn staged_diff(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<FileDiff>, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "diff",
            "--cached",
            "-U0",
            "-M",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
        ],
    )
    .with_config("core.quotepath", "false")
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(parse_diff(&out))
}

/// 원격 추적 ref 스냅샷 (`refs/remotes/*` → oid). 자동 fetch 전후 비교용 (UX-09).
/// 심볼릭 ref(`<원격>/HEAD` — 원격의 기본 branch 표시)는 뺀다 (`parse_remote_refs`)
pub async fn remote_refs(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<(String, String)>, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/remotes/",
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(parse_remote_refs(&out))
}

/// `remote_refs` 의 `for-each-ref` 출력(`refname\0objectname\0symref` 줄)을 (이름, oid) 목록으로 바꾼다 (순수).
/// 심볼릭 ref 는 원격 branch 가 아니라 기본 branch 를 가리키는 표시라 뺀다 — git 2.48+ 의 fetch 는 없던
/// `<원격>/HEAD` 를 처음 fetch 에서 만들므로, 넣으면 새 커밋이 없어도 원격 변경으로 알리게 된다. 가리키는 branch 는
/// 따로 실리므로 빠지는 변경은 없다
fn parse_remote_refs(out: &[u8]) -> Vec<(String, String)> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|l| {
            let mut fields = l.split('\0');
            let name = fields.next()?;
            let oid = fields.next()?.trim();
            let symref = fields.next().unwrap_or("").trim();
            symref
                .is_empty()
                .then(|| (name.to_string(), oid.to_string()))
        })
        .collect()
}

/// 두 스냅샷에서 새로 생기거나 바뀐 ref 이름 (`refs/remotes/` 접두 제거)
pub fn changed_remote_refs(before: &[(String, String)], after: &[(String, String)]) -> Vec<String> {
    after
        .iter()
        .filter(|(name, oid)| {
            before
                .iter()
                .find(|(n, _)| n == name)
                .is_none_or(|(_, o)| o != oid)
        })
        .map(|(name, _)| {
            name.strip_prefix("refs/remotes/")
                .unwrap_or(name)
                .to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_new_and_moved_remote_refs() {
        let before = vec![
            ("refs/remotes/origin/main".to_string(), "a".to_string()),
            ("refs/remotes/origin/dev".to_string(), "b".to_string()),
        ];
        let after = vec![
            ("refs/remotes/origin/main".to_string(), "a2".to_string()),
            ("refs/remotes/origin/dev".to_string(), "b".to_string()),
            ("refs/remotes/origin/new".to_string(), "c".to_string()),
        ];
        assert_eq!(
            changed_remote_refs(&before, &after),
            vec!["origin/main".to_string(), "origin/new".to_string()]
        );
    }

    /// 스냅샷은 심볼릭 `<원격>/HEAD` 를 빼고, 심볼릭이 아닌 ref(옛 방식의 실제 `HEAD` 이름 ref 포함)는 그대로 둔다.
    /// 그래서 `<원격>/HEAD` 가 새로 생겨도 변경으로 나오지 않는다
    #[test]
    fn snapshot_skips_symbolic_remote_head() {
        let before = parse_remote_refs(b"refs/remotes/origin/main\0a\0\n");
        let after = parse_remote_refs(
            b"refs/remotes/origin/HEAD\0a\0refs/remotes/origin/main\n\
              refs/remotes/origin/main\0a\0\n\
              refs/remotes/up/HEAD\0b\0\n",
        );
        assert_eq!(
            after,
            vec![
                ("refs/remotes/origin/main".to_string(), "a".to_string()),
                ("refs/remotes/up/HEAD".to_string(), "b".to_string()),
            ]
        );
        assert_eq!(
            changed_remote_refs(&before, &after),
            vec!["up/HEAD".to_string()]
        );
    }
}
