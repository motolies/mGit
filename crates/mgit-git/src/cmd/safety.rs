use std::path::Path;

use mgit_model::{
    CommitTemplate, EnvProfile, GitError, GitRequest, GitRunner, HeadRef, Oid, RefSnapshot,
    ReflogEntry,
};

/// 로컬 브랜치·태그·HEAD 스냅샷 (SF-03)
pub async fn ref_snapshot(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<RefSnapshot, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            "refs/heads",
            "refs/tags",
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    let mut refs = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        if let Some((name, oid)) = line.split_once('\0')
            && let Ok(oid) = Oid::from_hex(oid.trim().as_bytes())
        {
            refs.push((name.to_string(), oid));
        }
    }
    refs.sort();
    let sym = runner
        .run(GitRequest::new(work_tree, ["symbolic-ref", "-q", "HEAD"]))
        .await?;
    let head = if sym.exit.success() {
        HeadRef::Symbolic {
            target: sym.stdout_lossy().trim().to_string(),
        }
    } else {
        let rp = runner
            .run(GitRequest::new(
                work_tree,
                ["rev-parse", "-q", "--verify", "HEAD"],
            ))
            .await?;
        match Oid::from_hex(rp.stdout_lossy().trim().as_bytes()) {
            Ok(oid) => HeadRef::Detached { oid },
            // unborn: HEAD 가 아직 없는 브랜치를 가리킴 — symbolic-ref 가 실패할 일은 없지만 방어
            Err(_) => HeadRef::Symbolic {
                target: "refs/heads/main".into(),
            },
        }
    };
    Ok(RefSnapshot { refs, head })
}

/// reflog 목록 (AD-02). `reference` 가 없으면 HEAD. 레코드는 `%x1e` 로 끝나 줄바꿈이 섞여도 안전하다
pub async fn list_reflog(
    runner: &dyn GitRunner,
    work_tree: &Path,
    reference: Option<&str>,
    limit: u32,
) -> Result<Vec<ReflogEntry>, GitError> {
    let n = format!("-n{limit}");
    let mut args: Vec<&str> = vec!["reflog", "show", "--format=%gd%x00%H%x00%gs%x00%ct%x1e", &n];
    if let Some(r) = reference {
        args.push("--end-of-options");
        args.push(r);
    }
    let req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadInteractive);
    let out = runner.run(req).await?;
    if !out.exit.success() {
        // reflog 가 없는 ref 는 빈 목록
        return Ok(Vec::new());
    }
    Ok(parse_reflog(&out.stdout_lossy()))
}

/// `%gd%x00%H%x00%gs%x00%ct%x1e` 레코드를 파싱한다
pub fn parse_reflog(text: &str) -> Vec<ReflogEntry> {
    text.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_matches(|c| c == '\n' || c == '\r');
            let mut f = rec.split('\0');
            let selector = f.next()?.trim().to_string();
            let oid = Oid::from_hex(f.next()?.trim().as_bytes()).ok()?;
            let subject = f.next()?.to_string();
            let time = f.next()?.trim().parse().ok()?;
            if selector.is_empty() {
                return None;
            }
            Some(ReflogEntry {
                selector,
                oid,
                subject,
                time,
            })
        })
        .collect()
}

/// 설정 값 하나 (`git config --get`). 없으면 `None`
pub async fn config_get(runner: &dyn GitRunner, work_tree: &Path, key: &str) -> Option<String> {
    let req = GitRequest::new(work_tree, ["config", "--get", key]);
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    let v = out.stdout_lossy().trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// `commit.template` 파일 내용 (CHG-07). `~` 는 홈으로 푼다
pub async fn commit_template(runner: &dyn GitRunner, work_tree: &Path) -> Option<CommitTemplate> {
    let raw = config_get(runner, work_tree, "commit.template").await?;
    let path = if let Some(rest) = raw.strip_prefix("~/") {
        std::env::var_os("HOME").map(|h| Path::new(&h).join(rest))?
    } else if Path::new(&raw).is_absolute() {
        Path::new(&raw).to_path_buf()
    } else {
        work_tree.join(&raw)
    };
    let body = std::fs::read_to_string(&path).ok()?;
    Some(CommitTemplate {
        name: format!("commit.template ({raw})"),
        body,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_reflog_records_with_embedded_newlines() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "HEAD@{{0}}\0{a}\0commit: multi\nline\0100\x1e\nHEAD@{{1}}\0{b}\0checkout: moving from x to y\090\x1e\n"
        );
        let r = parse_reflog(&text);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].selector, "HEAD@{0}");
        assert_eq!(r[0].subject, "commit: multi\nline");
        assert_eq!(r[1].time, 90);
    }
}
