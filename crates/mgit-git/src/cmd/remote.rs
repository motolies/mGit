use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, RemoteInfo};

/// 원격 목록 (`git remote -v`: `<name>\t<url> (fetch|push)` 줄)
pub async fn list_remotes(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<RemoteInfo>, GitError> {
    let req = GitRequest::new(work_tree, ["remote", "-v"]);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_remote_v(&String::from_utf8_lossy(&out)))
}

/// `git remote -v` 출력을 파싱한다. 같은 이름의 fetch·push 줄을 하나로 합친다
pub fn parse_remote_v(text: &str) -> Vec<RemoteInfo> {
    let mut out: Vec<RemoteInfo> = Vec::new();
    for line in text.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let (url, kind) = match rest.rsplit_once(' ') {
            Some((u, k)) => (u.trim(), k.trim_matches(|c| c == '(' || c == ')')),
            None => (rest.trim(), "fetch"),
        };
        let entry = match out.iter_mut().find(|r| r.name == name) {
            Some(e) => e,
            None => {
                out.push(RemoteInfo {
                    name: name.to_string(),
                    fetch_url: String::new(),
                    push_url: None,
                });
                out.last_mut().expect("방금 넣음")
            }
        };
        if kind == "push" {
            if entry.fetch_url != url {
                entry.push_url = Some(url.to_string());
            }
        } else {
            entry.fetch_url = url.to_string();
            if entry.push_url.as_deref() == Some(url) {
                entry.push_url = None;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_fetch_and_push_lines() {
        let text = "origin\thttps://a/b.git (fetch)\norigin\thttps://a/b.git (push)\nfork\tgit@x:y.git (fetch)\nfork\tgit@x:z.git (push)\n";
        let r = parse_remote_v(text);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].name, "origin");
        assert_eq!(r[0].push_url, None);
        assert_eq!(r[1].push_url.as_deref(), Some("git@x:z.git"));
    }
}
