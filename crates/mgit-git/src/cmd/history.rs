use std::path::Path;

use mgit_model::{
    AdvancedSearch, BlameLine, ChangedFile, DiffOptions, EnvProfile, FileDiff, GitError,
    GitRequest, GitRunner, HistoryEntry, Oid,
};

use super::commit::parse_name_status;
use crate::parse::parse_diff;

/// `git diff` 공통 인자 (출력 고정)
const DIFF_BASE_ARGS: &[&str] = &["--no-color", "--no-ext-diff", "--no-textconv"];

/// diff 옵션을 인자로
pub fn diff_option_args(opts: &DiffOptions) -> Vec<String> {
    let mut v = Vec::new();
    if opts.ignore_whitespace {
        v.push("-w".into());
    }
    if opts.context != 3 {
        v.push(format!("-U{}", opts.context.min(999)));
    }
    v
}

/// `git blame --line-porcelain` (DIFF-04). `rev` 가 없으면 작업 트리 기준
pub async fn blame_file(
    runner: &dyn GitRunner,
    work_tree: &Path,
    path: &str,
    rev: Option<&str>,
    ignore_whitespace: bool,
    detect_moves: bool,
) -> Result<Vec<BlameLine>, GitError> {
    let mut args: Vec<String> = vec!["blame".into(), "--line-porcelain".into()];
    if ignore_whitespace {
        args.push("-w".into());
    }
    if detect_moves {
        args.push("-M".into());
        args.push("-C".into());
    }
    // blame 은 `--end-of-options` 뒤의 `--` 를 경로 구분자로 보지 않으므로 rev 는 호출자가 검증한다
    if let Some(r) = rev {
        args.push(r.into());
    }
    args.push("--".into());
    args.push(path.into());
    let req = GitRequest::new(work_tree, args)
        .with_config("core.quotepath", "false")
        .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(parse_blame_porcelain(&String::from_utf8_lossy(&out)))
}

/// `--line-porcelain` 파서: 헤더 `<sha> <orig> <final> [<n>]` + 속성 줄 + TAB 내용 줄
pub fn parse_blame_porcelain(text: &str) -> Vec<BlameLine> {
    let mut out = Vec::new();
    let mut cur: Option<BlameLine> = None;
    for line in text.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            if let Some(mut b) = cur.take() {
                b.text = content.to_string();
                out.push(b);
            }
            continue;
        }
        if cur.is_none() {
            let mut f = line.split(' ');
            let (Some(sha), Some(orig), Some(fin)) = (f.next(), f.next(), f.next()) else {
                continue;
            };
            let (Ok(oid), Ok(orig_line), Ok(final_line)) = (
                Oid::from_hex(sha.as_bytes()),
                orig.parse::<u32>(),
                fin.parse::<u32>(),
            ) else {
                continue;
            };
            cur = Some(BlameLine {
                oid,
                orig_line,
                line: final_line,
                author: String::new(),
                author_mail: String::new(),
                author_time: 0,
                summary: String::new(),
                previous: None,
                boundary: false,
                text: String::new(),
            });
            continue;
        }
        let Some(b) = cur.as_mut() else {
            continue;
        };
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "author" => b.author = value.to_string(),
            "author-mail" => {
                b.author_mail = value.trim_matches(|c| c == '<' || c == '>').to_string()
            }
            "author-time" => b.author_time = value.parse().unwrap_or(0),
            "summary" => b.summary = value.to_string(),
            "boundary" => b.boundary = true,
            "previous" => {
                if let Some((sha, p)) = value.split_once(' ')
                    && let Ok(o) = Oid::from_hex(sha.as_bytes())
                {
                    b.previous = Some((o, p.to_string()));
                }
            }
            _ => {}
        }
    }
    if let Some(b) = cur {
        out.push(b);
    }
    out
}

/// 파일 히스토리 (DIFF-05): `--follow` 로 이름 변경을 따라간다. 최신 먼저
pub async fn file_history(
    runner: &dyn GitRunner,
    work_tree: &Path,
    path: &str,
    limit: u32,
) -> Result<Vec<HistoryEntry>, GitError> {
    let n = format!("-n{limit}");
    let req = GitRequest::new(
        work_tree,
        [
            "log",
            "--follow",
            "--name-only",
            "--no-merges",
            "--format=%x1e%H%x00%s%x00%aN%x00%at",
            &n,
            "--",
            path,
        ],
    )
    .with_config("core.quotepath", "false")
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(parse_file_history(&String::from_utf8_lossy(&out)))
}

/// `%x1e` 레코드: 헤더 한 줄 + 빈 줄 + 경로 줄
pub fn parse_file_history(text: &str) -> Vec<HistoryEntry> {
    text.split('\x1e')
        .filter_map(|rec| {
            let mut lines = rec.lines().filter(|l| !l.trim().is_empty());
            let header = lines.next()?;
            let mut f = header.split('\0');
            let oid = Oid::from_hex(f.next()?.trim().as_bytes()).ok()?;
            let subject = f.next()?.to_string();
            let author_name = f.next()?.to_string();
            // 그래프와 같이 날짜가 비정상이면 0 으로 둔다 (커밋을 빠뜨리지 않는다)
            let author_time = f.next()?.trim().parse().unwrap_or(0);
            let path = lines.next().unwrap_or("").trim().to_string();
            Some(HistoryEntry {
                oid,
                subject,
                author_name,
                author_time,
                path,
            })
        })
        .collect()
}

/// 두 ref 사이의 변경 파일 (DIFF-06). `three_dot` 이면 `A...B`(merge-base 기준)
pub async fn compare_files(
    runner: &dyn GitRunner,
    work_tree: &Path,
    a: &str,
    b: &str,
    three_dot: bool,
) -> Result<Vec<ChangedFile>, GitError> {
    let range = if three_dot {
        format!("{a}...{b}")
    } else {
        format!("{a}..{b}")
    };
    let req = GitRequest::new(
        work_tree,
        [
            "diff",
            "--name-status",
            "-M",
            "-z",
            "--end-of-options",
            &range,
        ],
    )
    .with_config("core.quotepath", "false")
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(parse_name_status(&out))
}

/// 두 ref 사이 파일 하나의 diff
pub async fn compare_file_diff(
    runner: &dyn GitRunner,
    work_tree: &Path,
    a: &str,
    b: &str,
    three_dot: bool,
    path: &str,
    opts: &DiffOptions,
) -> Result<Option<FileDiff>, GitError> {
    let range = if three_dot {
        format!("{a}...{b}")
    } else {
        format!("{a}..{b}")
    };
    let mut args: Vec<String> = vec!["diff".into()];
    args.extend(DIFF_BASE_ARGS.iter().map(|s| s.to_string()));
    args.push("-M".into());
    args.extend(diff_option_args(opts));
    args.push("--end-of-options".into());
    args.push(range);
    args.push("--".into());
    args.push(path.into());
    let req = GitRequest::new(work_tree, args)
        .with_config("core.quotepath", "false")
        .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    let mut files = parse_diff(&out);
    if files.is_empty() {
        Ok(None)
    } else {
        Ok(Some(files.remove(0)))
    }
}

/// 고급 검색 (GRAPH-07): 조건에 맞는 커밋 해시 (전체 ref, 최신 순)
pub async fn advanced_search(
    runner: &dyn GitRunner,
    work_tree: &Path,
    q: &AdvancedSearch,
    limit: u32,
) -> Result<Vec<Oid>, GitError> {
    let mut args: Vec<String> = vec![
        "log".into(),
        "--all".into(),
        "--exclude=refs/mgit/*".into(),
        "--format=%H".into(),
        format!("-n{limit}"),
        "--regexp-ignore-case".into(),
    ];
    if let Some(t) = q.text.as_deref().filter(|t| !t.trim().is_empty()) {
        args.push(format!("--grep={t}"));
    }
    if let Some(a) = q.author.as_deref().filter(|t| !t.trim().is_empty()) {
        args.push(format!("--author={a}"));
    }
    if let Some(p) = &q.pickaxe {
        args.push(format!(
            "{}{}",
            if p.regex { "-G" } else { "-S" },
            p.pattern
        ));
    }
    if let Some(s) = q.since.as_deref().filter(|t| !t.trim().is_empty()) {
        args.push(format!("--since={s}"));
    }
    if let Some(u) = q.until.as_deref().filter(|t| !t.trim().is_empty()) {
        args.push(format!("--until={u}"));
    }
    if let Some(p) = q.path.as_deref().filter(|t| !t.trim().is_empty()) {
        args.push("--".into());
        args.push(p.into());
    }
    // 경로 조건은 사용자가 입력하는 필터라 글롭을 그대로 쓴다
    let req = GitRequest::new(work_tree, args)
        .with_env(EnvProfile::ReadInteractive)
        .with_env_var("GIT_LITERAL_PATHSPECS", "0");
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| Oid::from_hex(l.trim().as_bytes()).ok())
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 날짜가 비정상인 커밋도 빠뜨리지 않는다 (그래프와 같이 0 으로 대체)
    #[test]
    fn file_history_keeps_commit_with_bad_time() {
        let oid = "a".repeat(40);
        let text = format!("\x1e{oid}\0제목\0kim\0not-a-time\nsrc/a.rs\n");
        let list = parse_file_history(&text);
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(list[0].author_time, 0);
        assert_eq!(list[0].path, "src/a.rs");
    }

    #[test]
    fn parses_line_porcelain() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "{a} 1 1 2\nauthor Kim\nauthor-mail <k@x>\nauthor-time 100\nauthor-tz +0900\ncommitter Kim\ncommitter-mail <k@x>\ncommitter-time 100\ncommitter-tz +0900\nsummary first\nboundary\nfilename f.txt\n\tline one\n{a} 2 2\nauthor Kim\nauthor-mail <k@x>\nauthor-time 100\nsummary first\nfilename f.txt\n\tline two\n{b} 1 3 1\nauthor Lee\nauthor-mail <l@x>\nauthor-time 200\nsummary second\nprevious {a} old.txt\nfilename f.txt\n\tline three\n"
        );
        let r = parse_blame_porcelain(&text);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].line, 1);
        assert_eq!(r[0].author, "Kim");
        assert_eq!(r[0].author_mail, "k@x");
        assert!(r[0].boundary);
        assert_eq!(r[1].line, 2);
        assert_eq!(r[2].summary, "second");
        assert_eq!(r[2].previous.as_ref().unwrap().1, "old.txt");
        assert_eq!(r[2].text, "line three");
    }

    #[test]
    fn parses_follow_history() {
        let a = "a".repeat(40);
        let text =
            format!("\x1e{a}\0rename\0Kim\0100\n\nnew.txt\n\x1e{a}\0first\0Kim\090\n\nold.txt\n");
        let r = parse_file_history(&text);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].path, "new.txt");
        assert_eq!(r[1].path, "old.txt");
        assert_eq!(r[1].author_time, 90);
    }

    #[test]
    fn diff_options_to_args() {
        assert!(diff_option_args(&DiffOptions::default()).is_empty());
        assert_eq!(
            diff_option_args(&DiffOptions {
                ignore_whitespace: true,
                context: 0
            }),
            vec!["-w", "-U0"]
        );
    }
}
