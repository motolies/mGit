//! `git push --porcelain` 결과 표 파서 (`man git-push` OUTPUT).
//!
//! 표는 stdout 으로 나오고 한 ref 가 한 줄이다: `<flag>\t<from>:<to>\t<summary> (<reason>)`.
//! `To <url>` 머리줄과 성공 때의 `Done` 꼬리줄은 건너뛴다. 사유는 사람이 읽는 문장이라 분기는 flag 와
//! summary 의 대괄호로만 하고, 사유는 원문을 그대로 넘긴다

/// 한 ref 의 push 결과 flag
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushFlag {
    /// ` ` fast-forward 로 갱신
    FastForward,
    /// `+` 강제 갱신
    Forced,
    /// `-` 삭제
    Deleted,
    /// `*` 새 ref
    New,
    /// `!` 거부·실패
    Rejected,
    /// `=` 이미 같음
    UpToDate,
}

impl PushFlag {
    /// flag 문자 하나를 해석한다
    fn from_char(c: char) -> Option<Self> {
        Some(match c {
            ' ' => PushFlag::FastForward,
            '+' => PushFlag::Forced,
            '-' => PushFlag::Deleted,
            '*' => PushFlag::New,
            '!' => PushFlag::Rejected,
            '=' => PushFlag::UpToDate,
            _ => return None,
        })
    }
}

/// push 결과 표의 한 줄
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushRefLine {
    pub flag: PushFlag,
    /// 보낸 쪽 ref. 삭제면 빈 문자열, 거부된 삭제면 `(delete)`
    pub from: String,
    /// 원격 쪽 ref 전체 이름
    pub to: String,
    /// `[new tag]`, `[up to date]`, `[rejected]`, `[remote rejected]`, `a..b` 같은 요약
    pub summary: String,
    /// 괄호 안 사유 (`already exists`, `stale info`, `pre-receive hook declined` …)
    pub reason: Option<String>,
}

/// stdout 전체를 파싱한다. 형식에 맞지 않는 줄(`To …`, `Done`, 빈 줄)은 건너뛴다
pub fn parse_push_porcelain(stdout: &str) -> Vec<PushRefLine> {
    stdout.lines().filter_map(parse_line).collect()
}

/// 한 줄을 파싱한다. `<flag>\t<from>:<to>\t<summary>[ (<reason>)]`
fn parse_line(line: &str) -> Option<PushRefLine> {
    let mut parts = line.splitn(3, '\t');
    let flag_part = parts.next()?;
    let refs = parts.next()?;
    let rest = parts.next()?;
    let mut flag_chars = flag_part.chars();
    let flag = PushFlag::from_char(flag_chars.next()?)?;
    if flag_chars.next().is_some() {
        return None;
    }
    // ref 이름에는 `:` 가 올 수 없으므로 첫 `:` 에서 나눈다 (삭제면 앞이 비어 있다)
    let (from, to) = refs.split_once(':')?;
    let (summary, reason) = split_reason(rest);
    Some(PushRefLine {
        flag,
        from: from.to_string(),
        to: to.to_string(),
        summary,
        reason,
    })
}

/// `summary (reason)` 을 나눈다. 사유가 없으면 `None`
fn split_reason(rest: &str) -> (String, Option<String>) {
    let rest = rest.trim_end();
    if rest.ends_with(')')
        && let Some(open) = rest.find(" (")
    {
        let summary = rest[..open].trim().to_string();
        let reason = rest[open + 2..rest.len() - 1].trim().to_string();
        return (summary, Some(reason));
    }
    (rest.trim().to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags_summary_and_reason() {
        let out = "To /tmp/r.git\n\
*\trefs/tags/v1:refs/tags/v1\t[new tag]\n\
=\trefs/tags/v2:refs/tags/v2\t[up to date]\n\
!\trefs/tags/v3:refs/tags/v3\t[rejected] (already exists)\n\
!\trefs/tags/v4:refs/tags/v4\t[remote rejected] (pre-receive hook declined)\n\
-\t:refs/tags/v5\t[deleted]\n\
!\t(delete):refs/tags/v6\t[rejected] (stale info)\n\
+\trefs/heads/a:refs/heads/a\t1111111...2222222 (forced update)\n"
            .to_string()
            // 줄 이음(`\`)은 다음 줄 앞 공백을 지우므로 공백 flag 줄은 따로 붙인다
            + " \trefs/heads/b:refs/heads/b\t1111111..2222222\nDone\n";
        let lines = parse_push_porcelain(&out);
        assert_eq!(lines.len(), 8, "{lines:#?}");
        assert_eq!(
            lines[0],
            PushRefLine {
                flag: PushFlag::New,
                from: "refs/tags/v1".into(),
                to: "refs/tags/v1".into(),
                summary: "[new tag]".into(),
                reason: None,
            }
        );
        assert_eq!(lines[1].flag, PushFlag::UpToDate);
        assert_eq!(lines[2].flag, PushFlag::Rejected);
        assert_eq!(lines[2].summary, "[rejected]");
        assert_eq!(lines[2].reason.as_deref(), Some("already exists"));
        assert_eq!(lines[3].summary, "[remote rejected]");
        assert_eq!(
            lines[3].reason.as_deref(),
            Some("pre-receive hook declined")
        );
        assert_eq!(lines[4].flag, PushFlag::Deleted);
        assert_eq!(lines[4].from, "");
        assert_eq!(lines[4].to, "refs/tags/v5");
        // 거부된 삭제는 보낸 쪽 자리에 `(delete)` 가 온다
        assert_eq!(lines[5].from, "(delete)");
        assert_eq!(lines[5].to, "refs/tags/v6");
        assert_eq!(lines[5].reason.as_deref(), Some("stale info"));
        assert_eq!(lines[6].flag, PushFlag::Forced);
        assert_eq!(lines[6].reason.as_deref(), Some("forced update"));
        assert_eq!(lines[7].flag, PushFlag::FastForward);
        assert_eq!(lines[7].summary, "1111111..2222222");
    }

    #[test]
    fn ignores_noise_lines() {
        assert!(parse_push_porcelain("To x\nDone\n\nwarning: y\n").is_empty());
        // flag 자리가 두 글자면 표 줄이 아니다
        assert!(parse_push_porcelain("!!\ta:b\tc\n").is_empty());
    }
}
