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

/// 원격 추적 ref 스냅샷 (`refs/remotes/*` → oid). 자동 fetch 전후 비교용 (UX-09)
pub async fn remote_refs(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<(String, String)>, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            "refs/remotes/",
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| {
            let (name, oid) = l.split_once('\0')?;
            Some((name.to_string(), oid.trim().to_string()))
        })
        .collect())
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
}
