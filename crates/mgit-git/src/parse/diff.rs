use mgit_model::{BinaryInfo, DiffChange, DiffLine, FileDiff, Hunk, LineKind};

/// `git diff --no-color --no-ext-diff` 패치 출력을 파일 단위로 파싱한다.
///
/// 경로는 `---`/`+++`·`rename from/to` 줄에서 읽는다. `core.quotepath=false` 로 실행해야
/// 한글 경로가 이스케이프되지 않는다. 호출자가 경로를 알고 있으면 덮어쓸 수 있다
pub fn parse_diff(output: &[u8]) -> Vec<FileDiff> {
    let mut files = Vec::new();
    let mut current: Option<FileDiff> = None;
    let mut hunk: Option<Hunk> = None;
    let mut old_no = 0u32;
    let mut new_no = 0u32;

    /// 진행 중인 hunk 를 파일에 넣는다
    fn flush_hunk(current: &mut Option<FileDiff>, hunk: &mut Option<Hunk>) {
        if let (Some(f), Some(h)) = (current.as_mut(), hunk.take()) {
            f.hunks.push(h);
        }
    }

    for raw in split_lines(output) {
        let line = String::from_utf8_lossy(raw);
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush_hunk(&mut current, &mut hunk);
            if let Some(f) = current.take() {
                files.push(f);
            }
            let (a, b) = split_git_header(rest);
            current = Some(FileDiff {
                old_path: a,
                new_path: b,
                change: DiffChange::Modified,
                old_mode: None,
                new_mode: None,
                old_blob: None,
                new_blob: None,
                binary: None,
                hunks: Vec::new(),
                truncated: false,
                total_lines: 0,
                non_utf8: false,
            });
            continue;
        }
        let Some(f) = current.as_mut() else {
            continue; // 헤더 전의 잡음
        };
        if let Some(h) = hunk.as_mut() {
            if std::str::from_utf8(raw).is_err() {
                f.non_utf8 = true;
            }
            match raw.first() {
                Some(b'+') => {
                    h.lines.push(DiffLine {
                        kind: LineKind::Add,
                        old_no: None,
                        new_no: Some(new_no),
                        text: String::from_utf8_lossy(&raw[1..]).into_owned(),
                        no_newline: false,
                    });
                    new_no += 1;
                    continue;
                }
                Some(b'-') => {
                    h.lines.push(DiffLine {
                        kind: LineKind::Del,
                        old_no: Some(old_no),
                        new_no: None,
                        text: String::from_utf8_lossy(&raw[1..]).into_owned(),
                        no_newline: false,
                    });
                    old_no += 1;
                    continue;
                }
                Some(b' ') => {
                    h.lines.push(DiffLine {
                        kind: LineKind::Context,
                        old_no: Some(old_no),
                        new_no: Some(new_no),
                        text: String::from_utf8_lossy(&raw[1..]).into_owned(),
                        no_newline: false,
                    });
                    old_no += 1;
                    new_no += 1;
                    continue;
                }
                Some(b'\\') => {
                    if let Some(last) = h.lines.last_mut() {
                        last.no_newline = true;
                    }
                    continue;
                }
                None => {
                    // 빈 줄은 공백 접두가 생략된 컨텍스트 줄로 본다 (일부 도구 출력)
                    h.lines.push(DiffLine {
                        kind: LineKind::Context,
                        old_no: Some(old_no),
                        new_no: Some(new_no),
                        text: String::new(),
                        no_newline: false,
                    });
                    old_no += 1;
                    new_no += 1;
                    continue;
                }
                _ => {}
            }
        }
        if let Some(rest) = line.strip_prefix("@@ ") {
            flush_hunk(&mut current, &mut hunk);
            let Some(f) = current.as_mut() else {
                continue;
            };
            let _ = f;
            if let Some(h) = parse_hunk_header(rest) {
                old_no = h.old_start;
                new_no = h.new_start;
                hunk = Some(h);
            }
            continue;
        }
        parse_extended_header(f, &line);
    }
    flush_hunk(&mut current, &mut hunk);
    if let Some(f) = current.take() {
        files.push(f);
    }
    for f in &mut files {
        f.total_lines = f.line_count();
    }
    files
}

/// 확장 헤더·`---`/`+++`·바이너리 표시를 반영한다
fn parse_extended_header(f: &mut FileDiff, line: &str) {
    if let Some(m) = line.strip_prefix("old mode ") {
        f.old_mode = u32::from_str_radix(m.trim(), 8).ok();
    } else if let Some(m) = line.strip_prefix("new mode ") {
        f.new_mode = u32::from_str_radix(m.trim(), 8).ok();
        if f.change == DiffChange::Modified {
            f.change = DiffChange::TypeChanged;
        }
    } else if let Some(m) = line.strip_prefix("new file mode ") {
        f.new_mode = u32::from_str_radix(m.trim(), 8).ok();
        f.change = DiffChange::Added;
        f.old_path = None;
    } else if let Some(m) = line.strip_prefix("deleted file mode ") {
        f.old_mode = u32::from_str_radix(m.trim(), 8).ok();
        f.change = DiffChange::Deleted;
        f.new_path = None;
    } else if let Some(p) = line.strip_prefix("rename from ") {
        f.old_path = Some(p.to_string());
        if let DiffChange::Copied { similarity } = f.change {
            f.change = DiffChange::Renamed { similarity };
        } else if !matches!(f.change, DiffChange::Renamed { .. }) {
            f.change = DiffChange::Renamed { similarity: 0 };
        }
    } else if let Some(p) = line.strip_prefix("rename to ") {
        f.new_path = Some(p.to_string());
    } else if let Some(p) = line.strip_prefix("copy from ") {
        f.old_path = Some(p.to_string());
        if !matches!(f.change, DiffChange::Copied { .. }) {
            f.change = DiffChange::Copied { similarity: 0 };
        }
    } else if let Some(p) = line.strip_prefix("copy to ") {
        f.new_path = Some(p.to_string());
    } else if let Some(s) = line.strip_prefix("similarity index ") {
        let similarity = s.trim_end_matches('%').trim().parse().unwrap_or(0);
        f.change = match f.change {
            DiffChange::Copied { .. } => DiffChange::Copied { similarity },
            _ => DiffChange::Renamed { similarity },
        };
    } else if let Some(rest) = line.strip_prefix("index ") {
        let ids = rest.split(' ').next().unwrap_or("");
        if let Some((a, b)) = ids.split_once("..") {
            f.old_blob = Some(a.to_string());
            f.new_blob = Some(b.to_string());
        }
    } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
        f.binary = Some(BinaryInfo::default());
    } else if let Some(p) = line.strip_prefix("--- ") {
        if p == "/dev/null" {
            f.old_path = None;
            if f.change == DiffChange::Modified {
                f.change = DiffChange::Added;
            }
        } else {
            f.old_path = Some(strip_prefix_ab(p));
        }
    } else if let Some(p) = line.strip_prefix("+++ ") {
        if p == "/dev/null" {
            f.new_path = None;
            if f.change == DiffChange::Modified {
                f.change = DiffChange::Deleted;
            }
        } else {
            f.new_path = Some(strip_prefix_ab(p));
        }
    }
}

/// `a/path` → `path`. 탭 뒤의 시각 정보는 버린다
fn strip_prefix_ab(p: &str) -> String {
    let p = p.split('\t').next().unwrap_or(p);
    let p = p.trim_end_matches('\r');
    p.strip_prefix("a/")
        .or_else(|| p.strip_prefix("b/"))
        .unwrap_or(p)
        .to_string()
}

/// `diff --git a/x b/y` 의 두 경로. 공백이 있으면 ` b/` 기준으로 나눈다 (경로가 같다는 가정)
fn split_git_header(rest: &str) -> (Option<String>, Option<String>) {
    let rest = rest.trim_end_matches('\r');
    if let Some(stripped) = rest.strip_prefix("a/")
        && let Some(pos) = stripped.find(" b/")
    {
        let a = &stripped[..pos];
        let b = &stripped[pos + 3..];
        return (Some(a.to_string()), Some(b.to_string()));
    }
    (None, None)
}

/// `-a[,b] +c[,d] @@ section`
fn parse_hunk_header(rest: &str) -> Option<Hunk> {
    let (ranges, section) = rest.split_once(" @@")?;
    let mut parts = ranges.split(' ');
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    let (old_start, old_lines) = parse_range(old)?;
    let (new_start, new_lines) = parse_range(new)?;
    Some(Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        section: section.trim().trim_end_matches('\r').to_string(),
        lines: Vec::new(),
    })
}

/// `12,3` 또는 `12` (줄 수 생략 = 1)
fn parse_range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

/// `\n` 으로 나누되 마지막 줄바꿈 뒤의 빈 조각은 버린다. `\r` 은 내용으로 남긴다
fn split_lines(output: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut parts: Vec<&[u8]> = output.split(|&b| b == b'\n').collect();
    if parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    parts.into_iter()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/src/a.rs b/src/a.rs\nindex 1111111..2222222 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,4 @@ fn main\n line1\n-old\n+new\n+added\n line3\n\\ No newline at end of file\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\ndiff --git a/img.png b/img.png\nindex 4444444..5555555 100644\nBinary files a/img.png and b/img.png differ\ndiff --git a/old name.txt b/new name.txt\nsimilarity index 90%\nrename from old name.txt\nrename to new name.txt\nindex 6666666..7777777 100644\n--- a/old name.txt\t\n+++ b/new name.txt\t\n@@ -1 +1 @@\n-a\n+b\n";

    #[test]
    fn parses_modified_added_binary_and_renamed() {
        let files = parse_diff(SAMPLE.as_bytes());
        assert_eq!(files.len(), 4);

        let a = &files[0];
        assert_eq!(a.path(), "src/a.rs");
        assert_eq!(a.change, DiffChange::Modified);
        assert_eq!(a.old_blob.as_deref(), Some("1111111"));
        assert_eq!(a.hunks.len(), 1);
        let h = &a.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 3, 1, 4)
        );
        assert_eq!(h.section, "fn main");
        let kinds: Vec<_> = h.lines.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            vec![
                LineKind::Context,
                LineKind::Del,
                LineKind::Add,
                LineKind::Add,
                LineKind::Context
            ]
        );
        assert_eq!(h.lines[1].old_no, Some(2));
        assert_eq!(h.lines[2].new_no, Some(2));
        assert_eq!(h.lines[4].old_no, Some(3));
        assert_eq!(h.lines[4].new_no, Some(4));
        assert!(h.lines[4].no_newline);
        assert_eq!(a.total_lines, 5);

        let n = &files[1];
        assert_eq!(n.change, DiffChange::Added);
        assert_eq!(n.old_path, None);
        assert_eq!(n.new_path.as_deref(), Some("new.txt"));
        assert_eq!(n.new_mode, Some(0o100644));

        let b = &files[2];
        assert!(b.binary.is_some());
        assert!(b.hunks.is_empty());

        let r = &files[3];
        assert_eq!(r.change, DiffChange::Renamed { similarity: 90 });
        assert_eq!(r.old_path.as_deref(), Some("old name.txt"));
        assert_eq!(r.new_path.as_deref(), Some("new name.txt"));
    }

    #[test]
    fn truncate_keeps_prefix_and_marks() {
        let mut files = parse_diff(SAMPLE.as_bytes());
        let a = &mut files[0];
        a.truncate_to(2);
        assert!(a.truncated);
        assert_eq!(a.total_lines, 5);
        assert_eq!(a.line_count(), 2);
    }

    #[test]
    fn marks_hunks_with_non_utf8_lines() {
        let mut bytes = b"diff --git a/e.txt b/e.txt\nindex 1..2 100644\n--- a/e.txt\n+++ b/e.txt\n@@ -1 +1,2 @@\n ok\n+".to_vec();
        bytes.extend_from_slice(&[0xc7, 0xd1, b'\n']);
        assert!(parse_diff(&bytes)[0].non_utf8);
        assert!(!parse_diff(SAMPLE.as_bytes())[0].non_utf8);
    }

    #[test]
    fn empty_output_has_no_files() {
        assert!(parse_diff(b"").is_empty());
    }
}
