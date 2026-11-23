use std::path::Path;

use mgit_model::{EnvProfile, GitError, GitRequest, GitRunner, Oid};

/// `ls-files -u` 한 항목: 스테이지별 (mode, oid)
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UnmergedEntry {
    pub path: String,
    /// [base, ours, theirs]
    pub stages: [Option<(u32, Oid)>; 3],
}

/// unmerged 항목 (`git ls-files -u -z`: `<mode> <oid> <stage>\t<path>\0`)
pub async fn list_unmerged(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<UnmergedEntry>, GitError> {
    let req = GitRequest::new(work_tree, ["ls-files", "-u", "-z"]);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(parse_unmerged(&out))
}

/// `ls-files -u -z` 출력을 경로별로 묶는다 (출력 순서 유지)
pub fn parse_unmerged(bytes: &[u8]) -> Vec<UnmergedEntry> {
    let mut out: Vec<UnmergedEntry> = Vec::new();
    for rec in bytes.split(|&b| b == 0).filter(|r| !r.is_empty()) {
        let text = String::from_utf8_lossy(rec);
        let Some((meta, path)) = text.split_once('\t') else {
            continue;
        };
        let mut parts = meta.split(' ');
        let (Some(mode), Some(oid), Some(stage)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(mode), Ok(oid), Ok(stage)) = (
            u32::from_str_radix(mode, 8),
            Oid::from_hex(oid.as_bytes()),
            stage.parse::<usize>(),
        ) else {
            continue;
        };
        if !(1..=3).contains(&stage) {
            continue;
        }
        let entry = match out.iter_mut().find(|e| e.path == path) {
            Some(e) => e,
            None => {
                out.push(UnmergedEntry {
                    path: path.to_string(),
                    stages: [None, None, None],
                });
                out.last_mut().expect("방금 넣음")
            }
        };
        entry.stages[stage - 1] = Some((mode, oid));
    }
    out
}

/// 인덱스 스테이지의 내용 (`git show :<stage>:<path>`). 바이너리 그대로
pub async fn show_stage(
    runner: &dyn GitRunner,
    work_tree: &Path,
    stage: u8,
    path: &str,
) -> Result<Vec<u8>, GitError> {
    let spec = format!(":{stage}:{path}");
    let req = GitRequest::new(work_tree, ["show", "--end-of-options", &spec]);
    let args = req.display_args();
    runner.run(req).await?.ok(&args)
}

/// 충돌 마커 스타일
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerStyle {
    Merge,
    Diff3,
    Zdiff3,
}

/// `git merge-file -p` 로 세 스테이지를 병합한다. 종료 코드는 충돌 수(<=127)라 실패로 보지 않는다.
/// `labels` 는 [ours, base, theirs]
pub async fn merge_file_stages(
    runner: &dyn GitRunner,
    work_tree: &Path,
    path: &str,
    labels: [&str; 3],
    marker_size: u32,
    style: MarkerStyle,
) -> Result<Vec<u8>, GitError> {
    let size = marker_size.to_string();
    let ours = format!(":2:{path}");
    let base = format!(":1:{path}");
    let theirs = format!(":3:{path}");
    let mut args: Vec<&str> = vec!["merge-file", "-p", "--diff-algorithm=histogram"];
    match style {
        MarkerStyle::Merge => {}
        MarkerStyle::Diff3 => args.push("--diff3"),
        MarkerStyle::Zdiff3 => args.push("--zdiff3"),
    }
    args.extend([
        "--marker-size",
        &size,
        "-L",
        labels[0],
        "-L",
        labels[1],
        "-L",
        labels[2],
        "--object-id",
        &ours,
        &base,
        &theirs,
    ]);
    let req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?;
    match out.exit.status {
        Some(code) if (0..=127).contains(&code) => Ok(out.stdout),
        _ => Err(GitError::Exit {
            status: out.exit.status,
            stderr: out.exit.stderr,
            args: display,
        }),
    }
}

/// `merge.conflictStyle` 설정 (없으면 `Merge`)
pub async fn conflict_style(runner: &dyn GitRunner, work_tree: &Path) -> MarkerStyle {
    let req = GitRequest::new(work_tree, ["config", "--get", "merge.conflictStyle"]);
    match runner.run(req).await {
        Ok(out) if out.exit.success() => match out.stdout_lossy().trim() {
            "diff3" => MarkerStyle::Diff3,
            "zdiff3" => MarkerStyle::Zdiff3,
            _ => MarkerStyle::Merge,
        },
        _ => MarkerStyle::Merge,
    }
}

/// 커밋을 가리키는 브랜치 이름 (`name-rev`). 없으면 `None`
pub async fn name_rev(runner: &dyn GitRunner, work_tree: &Path, rev: &str) -> Option<String> {
    let req = GitRequest::new(
        work_tree,
        [
            "name-rev",
            "--name-only",
            "--no-undefined",
            "--refs=refs/heads/*",
            "--refs=refs/remotes/*",
            "--end-of-options",
            rev,
        ],
    );
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    let text = out.stdout_lossy();
    let name = text.trim();
    if name.is_empty() || name == "undefined" {
        None
    } else {
        Some(name.to_string())
    }
}

/// 커밋 제목 한 줄
pub async fn commit_subject(runner: &dyn GitRunner, work_tree: &Path, rev: &str) -> Option<String> {
    let req = GitRequest::new(
        work_tree,
        ["log", "-1", "--format=%s", "--end-of-options", rev],
    );
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    let text = out.stdout_lossy();
    let s = text.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn groups_stages_by_path() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let text = format!(
            "100644 {a} 1\tf.txt\0100644 {b} 2\tf.txt\0100644 {c} 3\tf.txt\0100644 {b} 2\tonly-ours.txt\0"
        );
        let r = parse_unmerged(text.as_bytes());
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].path, "f.txt");
        assert!(r[0].stages.iter().all(Option::is_some));
        assert_eq!(r[0].stages[1].unwrap().0, 0o100644);
        assert_eq!(
            r[1].stages,
            [
                None,
                Some((0o100644, Oid::from_hex(b.as_bytes()).unwrap())),
                None
            ]
        );
    }
}
