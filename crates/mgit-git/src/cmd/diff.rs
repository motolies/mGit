use std::path::Path;

use mgit_model::{DiffOptions, EnvProfile, FileDiff, GitError, GitRequest, GitRunner, MarkerHit};

use super::conflict::show_stage;
use super::history::diff_option_args;
use crate::parse::parse_diff;

/// 작업 트리 diff 의 공통 인자. 사용자 설정이 출력을 바꾸지 않게 고정한다 (명세 2.3 출력 고정)
const DIFF_BASE_ARGS: &[&str] = &["--no-color", "--no-ext-diff", "--no-textconv"];

/// 작업 트리 diff. `staged` 면 index 대 HEAD (`--cached`), 아니면 작업 트리 대 index.
/// untracked 파일은 `--no-index` 로 `/dev/null` 과 비교해 전체가 추가된 diff 를 만든다
pub async fn work_tree_diff(
    runner: &dyn GitRunner,
    work_tree: &Path,
    path: &str,
    staged: bool,
    untracked: bool,
    opts: &DiffOptions,
) -> Result<Option<FileDiff>, GitError> {
    let mut args: Vec<String> = vec!["diff".into()];
    args.extend(DIFF_BASE_ARGS.iter().map(|s| s.to_string()));
    args.extend(diff_option_args(opts));
    if untracked {
        args.push("--no-index".into());
        args.push("--".into());
        args.push("/dev/null".into());
        args.push(path.to_string());
    } else {
        if staged {
            args.push("--cached".into());
        }
        args.push("--".into());
        args.push(path.to_string());
    }
    let req = GitRequest::new(work_tree, args)
        .with_config("core.quotepath", "false")
        .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?;
    // `--no-index` 는 차이가 있으면 1 로 끝난다
    let ok = out.exit.success() || (untracked && out.exit.status == Some(1));
    if !ok {
        return Err(GitError::Exit {
            status: out.exit.status,
            stderr: out.exit.stderr,
            args: display,
        });
    }
    let mut files = parse_diff(&out.stdout);
    if files.is_empty() {
        return Ok(None);
    }
    let mut f = files.remove(0);
    // 호출자가 경로를 알고 있으므로 헤더 해석보다 우선한다
    if untracked {
        f.old_path = None;
        f.new_path = Some(path.to_string());
        f.change = mgit_model::DiffChange::Added;
    } else {
        if f.new_path.is_some() {
            f.new_path = Some(path.to_string());
        }
        if f.old_path.is_some() && f.old_path.as_deref() != Some(path) && f.new_path.is_none() {
            f.old_path = Some(path.to_string());
        }
    }
    Ok(Some(f))
}

/// 커밋 하나에서 파일 하나의 diff. 커밋 목록(`commit_files`)과 같은 기준이다: 머지 커밋은 첫 부모
/// (`--diff-merges=first-parent`, git 2.31+ — 앱 최소 2.45), 루트 커밋은 빈 트리(`--root`), 나머지는 부모.
/// git 은 한 번만 돈다.
///
/// `old_path` 는 이름이 바뀐 파일의 옛 경로다. pathspec 으로 먼저 거른 뒤 rename 을 찾으므로 새 경로만
/// 넘기면 짝이 없어 "추가"로 나온다 — 옛 경로를 함께 넘기면 rename 으로 짝지어 실제 변경분만 나온다.
/// 옛 경로와 짝지어지지 않으면(유사도 미달) 새 경로 쪽 결과를 고른다. 경로는 러너가 붙이는
/// `GIT_LITERAL_PATHSPECS=1` 로 글자 그대로 해석된다 (glob·`:(magic)` 없음)
pub async fn commit_file_diff(
    runner: &dyn GitRunner,
    work_tree: &Path,
    oid: &str,
    path: &str,
    old_path: Option<&str>,
    opts: &DiffOptions,
) -> Result<Option<FileDiff>, GitError> {
    let mut args: Vec<String> = vec!["diff-tree".into(), "-p".into()];
    args.extend(diff_option_args(opts));
    args.extend(
        [
            "-r",
            "-M",
            "--root",
            "--no-commit-id",
            "--diff-merges=first-parent",
        ]
        .map(String::from),
    );
    args.extend(DIFF_BASE_ARGS.iter().map(|s| s.to_string()));
    args.push(oid.to_string());
    args.push("--".into());
    let old_path = old_path.filter(|old| *old != path);
    if let Some(old) = old_path {
        args.push(old.to_string());
    }
    args.push(path.to_string());
    let req = GitRequest::new(work_tree, args)
        .with_config("core.quotepath", "false")
        .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    let mut files = parse_diff(&out);
    // 옛 경로를 함께 넘겼으면 결과가 둘(옛 경로 삭제·새 경로 추가)일 수 있다. 새 경로 쪽을 고른다
    let at = match old_path {
        Some(_) => files
            .iter()
            .position(|f| f.new_path.as_deref() == Some(path))
            .unwrap_or(0),
        None => 0,
    };
    Ok((!files.is_empty()).then(|| files.remove(at)))
}

/// blob 크기 (바이너리 크기 변화 표시용). 실패하면 `None`
pub async fn blob_size(runner: &dyn GitRunner, work_tree: &Path, blob: &str) -> Option<u64> {
    let out = runner
        .run(GitRequest::new(work_tree, ["cat-file", "-s", blob]))
        .await
        .ok()?;
    if !out.exit.success() {
        return None;
    }
    out.stdout_lossy().trim().parse().ok()
}

/// `git diff --cached --check` 로 stage 된 내용의 충돌 마커를 찾는다 (CF-24).
/// 종료 코드는 공백 오류와 공유하므로 stdout 의 `leftover conflict marker` 줄만 본다.
/// `--check` 는 `=======` 도 마커로 치지만 7자 제목 밑줄일 수 있어 `<`·`>` 줄만 남긴다
pub async fn staged_conflict_markers(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<MarkerHit>, GitError> {
    let req = GitRequest::new(work_tree, ["diff", "--cached", "--check", "--no-color"])
        .with_env(EnvProfile::ReadInteractive);
    let out = runner.run(req).await?;
    let text = out.stdout_lossy();
    let hits = text.lines().filter_map(|l| {
        let rest = l.strip_suffix(": leftover conflict marker")?;
        let (path, line) = rest.rsplit_once(':')?;
        Some(MarkerHit {
            path: path.to_string(),
            line: line.parse().ok()?,
        })
    });
    let mut kept = Vec::new();
    // 같은 파일의 줄이 이어서 오므로 내용은 파일마다 한 번만 읽는다
    let mut loaded: Option<(String, Option<Vec<u8>>)> = None;
    for hit in hits {
        if loaded.as_ref().is_none_or(|(path, _)| *path != hit.path) {
            let content = show_stage(runner, work_tree, 0, &hit.path).await.ok();
            loaded = Some((hit.path.clone(), content));
        }
        let content = loaded.as_ref().and_then(|(_, c)| c.as_deref());
        // 내용을 못 읽으면 git 의 판정을 따른다
        if content.is_none_or(|c| is_open_or_close_marker(c, hit.line)) {
            kept.push(hit);
        }
    }
    Ok(kept)
}

/// `line` 번째 줄(1부터)이 `<<<<<<<` 또는 `>>>>>>>` 로 시작하는지
fn is_open_or_close_marker(content: &[u8], line: u32) -> bool {
    content
        .split(|&b| b == b'\n')
        .nth((line as usize).saturating_sub(1))
        .is_some_and(|l| l.starts_with(b"<<<<<<<") || l.starts_with(b">>>>>>>"))
}
