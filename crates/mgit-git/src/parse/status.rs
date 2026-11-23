use mgit_model::{
    ConflictKind, FileState, Oid, ParseError, StatusEntry, SubmoduleState, WorkTreeStatus,
};

/// `git status --porcelain=v2 -z --branch --show-stash` 출력을 파싱한다.
///
/// `-z` 에서는 모든 레코드가 NUL 로 끝나고, 이름 변경·복사(`2`) 레코드는
/// `<path>\0<origPath>\0` 로 **NUL 레코드 두 개**를 차지한다.
pub fn parse_status_v2(output: &[u8]) -> Result<WorkTreeStatus, ParseError> {
    let mut records: Vec<&[u8]> = output.split(|&b| b == 0).collect();
    // 마지막 NUL 뒤의 빈 조각은 레코드가 아니다
    if records.last().is_some_and(|r| r.is_empty()) {
        records.pop();
    }
    let mut status = WorkTreeStatus::default();
    let mut i = 0;
    while i < records.len() {
        let rec = records[i];
        i += 1;
        match rec.first() {
            Some(b'#') => parse_header(rec, &mut status),
            Some(b'1') => status.entries.push(parse_ordinary(rec, i - 1)?),
            Some(b'2') => {
                let orig = records.get(i).copied().unwrap_or_default();
                i += 1;
                status.entries.push(parse_renamed(rec, orig, i - 2)?);
            }
            Some(b'u') => status.entries.push(parse_unmerged(rec, i - 1)?),
            Some(b'?') => status.entries.push(simple_entry(rec, FileState::Untracked)),
            Some(b'!') => status.entries.push(simple_entry(rec, FileState::Ignored)),
            _ => {} // 빈 레코드나 모르는 형식은 건너뛴다
        }
    }
    Ok(status)
}

/// `# branch.*`, `# stash N` 헤더
fn parse_header(rec: &[u8], status: &mut WorkTreeStatus) {
    let text = String::from_utf8_lossy(rec);
    let Some(rest) = text.strip_prefix("# ") else {
        return;
    };
    let Some((key, value)) = rest.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" => {
            status.branch.oid = Oid::from_hex(value.as_bytes()).ok();
        }
        "branch.head" => {
            status.branch.head = (value != "(detached)").then(|| value.to_string());
        }
        "branch.upstream" => status.branch.upstream = Some(value.to_string()),
        "branch.ab" => {
            for part in value.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    status.branch.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    status.branch.behind = n.parse().unwrap_or(0);
                }
            }
        }
        "stash" => status.stash_count = value.parse().unwrap_or(0),
        _ => {}
    }
}

/// 공백으로 `n` 개 필드를 떼고 나머지를 경로로 돌려준다
fn split_fields(rec: &[u8], n: usize, record: usize) -> Result<(Vec<&[u8]>, &[u8]), ParseError> {
    let mut fields = Vec::with_capacity(n);
    let mut rest = rec;
    for _ in 0..n {
        let pos = rest
            .iter()
            .position(|&b| b == b' ')
            .ok_or(ParseError::Truncated {
                fields_seen: fields.len(),
            })?;
        fields.push(&rest[..pos]);
        rest = &rest[pos + 1..];
    }
    if fields.len() != n {
        return Err(ParseError::Desync { record });
    }
    Ok((fields, rest))
}

/// `XY` 두 글자를 상태 쌍으로
fn xy(field: &[u8]) -> (FileState, FileState, Option<ConflictKind>) {
    let x = field.first().copied().unwrap_or(b'.');
    let y = field.get(1).copied().unwrap_or(b'.');
    (
        FileState::from_byte(x),
        FileState::from_byte(y),
        ConflictKind::from_xy(x, y),
    )
}

/// `N...` 또는 `S<C><M><U>`
fn submodule(field: &[u8]) -> Option<SubmoduleState> {
    if field.first() != Some(&b'S') {
        return None;
    }
    Some(SubmoduleState {
        commit_changed: field.get(1) == Some(&b'C'),
        tracked_changes: field.get(2) == Some(&b'M'),
        untracked_changes: field.get(3) == Some(&b'U'),
    })
}

/// 경로 바이트를 문자열로 (lossy, 정규화 없음)
fn path_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
fn parse_ordinary(rec: &[u8], record: usize) -> Result<StatusEntry, ParseError> {
    let (f, path) = split_fields(rec, 8, record)?;
    let (index, worktree, _) = xy(f[1]);
    Ok(StatusEntry {
        path: path_string(path),
        orig_path: None,
        index,
        worktree,
        submodule: submodule(f[2]),
        conflict: None,
        rename_score: None,
    })
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + 다음 레코드 `<origPath>`
fn parse_renamed(rec: &[u8], orig: &[u8], record: usize) -> Result<StatusEntry, ParseError> {
    let (f, path) = split_fields(rec, 9, record)?;
    let (index, worktree, _) = xy(f[1]);
    let score = std::str::from_utf8(&f[8][1..])
        .ok()
        .and_then(|s| s.parse::<u8>().ok());
    Ok(StatusEntry {
        path: path_string(path),
        orig_path: Some(path_string(orig)),
        index,
        worktree,
        submodule: submodule(f[2]),
        conflict: None,
        rename_score: score,
    })
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
fn parse_unmerged(rec: &[u8], record: usize) -> Result<StatusEntry, ParseError> {
    let (f, path) = split_fields(rec, 10, record)?;
    let (index, worktree, conflict) = xy(f[1]);
    Ok(StatusEntry {
        path: path_string(path),
        orig_path: None,
        index,
        worktree,
        submodule: submodule(f[2]),
        conflict: conflict.or(Some(ConflictKind::BothModified)),
        rename_score: None,
    })
}

/// `? <path>` / `! <path>`
fn simple_entry(rec: &[u8], state: FileState) -> StatusEntry {
    let path = rec.get(2..).unwrap_or_default();
    StatusEntry {
        path: path_string(path),
        orig_path: None,
        index: state,
        worktree: state,
        submodule: None,
        conflict: None,
        rename_score: None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// NUL 레코드들을 이어 붙인다
    fn z(records: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for r in records {
            v.extend_from_slice(r.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn parses_headers_entries_and_rename_pair() {
        let out = z(&[
            "# branch.oid 9a137b0f0ae7b9d0f2c1a7f1c1b8e5a6d4c3b2a1",
            "# branch.head master",
            "# branch.upstream origin/master",
            "# branch.ab +2 -1",
            "# stash 3",
            "1 M. N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 src/a.rs",
            "2 R. N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 c.txt",
            "? 한글 파일.txt",
            "1 .M SC.. 160000 160000 160000 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 vendor/lib",
        ]);
        let st = parse_status_v2(&out).unwrap();
        assert_eq!(st.branch.head.as_deref(), Some("master"));
        assert_eq!(st.branch.upstream.as_deref(), Some("origin/master"));
        assert_eq!((st.branch.ahead, st.branch.behind), (2, 1));
        assert_eq!(st.stash_count, 3);
        assert_eq!(st.entries.len(), 5);
        assert_eq!(st.entries[0].index, FileState::Modified);
        assert_eq!(st.entries[1].path, "new name.txt");
        assert_eq!(st.entries[1].orig_path.as_deref(), Some("old name.txt"));
        assert_eq!(st.entries[1].rename_score, Some(100));
        assert_eq!(st.entries[2].conflict, Some(ConflictKind::BothModified));
        assert_eq!(st.entries[3].path, "한글 파일.txt");
        assert!(st.entries[3].is_untracked());
        assert_eq!(
            st.entries[4].submodule,
            Some(SubmoduleState {
                commit_changed: true,
                tracked_changes: false,
                untracked_changes: false
            })
        );
        let s = st.summary();
        assert_eq!(
            (s.staged, s.unstaged, s.untracked, s.conflicted),
            (2, 1, 1, 1)
        );
    }

    #[test]
    fn unborn_and_detached_headers() {
        let st = parse_status_v2(&z(&["# branch.oid (initial)", "# branch.head main"])).unwrap();
        assert_eq!(st.branch.oid, None);
        assert_eq!(st.branch.head.as_deref(), Some("main"));
        let st = parse_status_v2(&z(&["# branch.head (detached)"])).unwrap();
        assert_eq!(st.branch.head, None);
    }

    #[test]
    fn empty_output_is_clean() {
        let st = parse_status_v2(b"").unwrap();
        assert!(st.entries.is_empty());
        assert!(!st.summary().has_changes());
    }
}
