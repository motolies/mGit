//! `git fetch --porcelain` 결과 파서 (`man git-fetch` OUTPUT, git 2.41+).
//!
//! 결과는 stdout 에 한 ref 가 한 줄이다: `<flag> <old-object-id> <new-object-id> <local-reference>`. flag 는
//! ` `(fast-forward) `+`(강제) `-`(정리) `t`(tag 갱신) `*`(새 ref) `!`(거부) `=`(같음) 중 하나다

use mgit_model::Oid;

/// 한 ref 의 fetch 결과 flag
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchFlag {
    /// ` ` fast-forward 갱신
    FastForward,
    /// `+` 강제 갱신
    Forced,
    /// `-` 정리됨
    Pruned,
    /// `t` tag 갱신
    TagUpdate,
    /// `*` 새 ref
    New,
    /// `!` 거부 (덮어쓰지 않음)
    Rejected,
    /// `=` 이미 같음
    UpToDate,
}

impl FetchFlag {
    /// flag 문자 하나를 해석한다
    fn from_char(c: char) -> Option<Self> {
        Some(match c {
            ' ' => FetchFlag::FastForward,
            '+' => FetchFlag::Forced,
            '-' => FetchFlag::Pruned,
            't' => FetchFlag::TagUpdate,
            '*' => FetchFlag::New,
            '!' => FetchFlag::Rejected,
            '=' => FetchFlag::UpToDate,
            _ => return None,
        })
    }
}

/// fetch 결과 한 줄
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchRefLine {
    pub flag: FetchFlag,
    /// 갱신 전 로컬 값 (새 ref 면 0 oid)
    pub old: Oid,
    /// 원격에서 받은 값
    pub new: Oid,
    /// 로컬 ref 전체 이름
    pub local_ref: String,
}

/// stdout 전체를 파싱한다. 형식에 맞지 않는 줄은 건너뛴다
pub fn parse_fetch_porcelain(stdout: &str) -> Vec<FetchRefLine> {
    stdout.lines().filter_map(parse_line).collect()
}

/// 한 줄: 첫 글자가 flag (공백일 수 있다), 그 뒤 공백 하나와 `<old> <new> <ref>`
fn parse_line(line: &str) -> Option<FetchRefLine> {
    let mut chars = line.chars();
    let flag = FetchFlag::from_char(chars.next()?)?;
    let rest = chars.as_str().strip_prefix(' ')?;
    let mut parts = rest.splitn(3, ' ');
    let old = Oid::from_hex(parts.next()?.as_bytes()).ok()?;
    let new = Oid::from_hex(parts.next()?.as_bytes()).ok()?;
    let local_ref = parts.next()?.trim_end().to_string();
    if local_ref.is_empty() {
        return None;
    }
    Some(FetchRefLine {
        flag,
        old,
        new,
        local_ref,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 40자 hex
    fn h(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[test]
    fn parses_each_flag() {
        let z = h('0');
        let a = h('a');
        let b = h('b');
        let out = format!(
            "* {z} {a} refs/tags/new\n= {a} {a} refs/tags/same\n! {a} {b} refs/tags/clobber\n+ {a} {b} refs/tags/forced\nt {a} {b} refs/tags/moved\n  {a} {b} refs/remotes/origin/main\n- {a} {z} refs/tags/gone\nnoise\n"
        );
        let lines = parse_fetch_porcelain(&out);
        assert_eq!(lines.len(), 7, "{lines:#?}");
        assert_eq!(lines[0].flag, FetchFlag::New);
        assert_eq!(lines[0].local_ref, "refs/tags/new");
        assert_eq!(lines[0].new.to_hex(), a);
        assert_eq!(lines[1].flag, FetchFlag::UpToDate);
        assert_eq!(lines[2].flag, FetchFlag::Rejected);
        assert_eq!(lines[2].old.to_hex(), a);
        assert_eq!(lines[2].new.to_hex(), b);
        assert_eq!(lines[3].flag, FetchFlag::Forced);
        assert_eq!(lines[4].flag, FetchFlag::TagUpdate);
        assert_eq!(lines[5].flag, FetchFlag::FastForward);
        assert_eq!(lines[5].local_ref, "refs/remotes/origin/main");
        assert_eq!(lines[6].flag, FetchFlag::Pruned);
    }
}
