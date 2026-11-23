use std::path::PathBuf;

use serde::Serialize;

/// 실행한 git 명령 하나의 기록 (SF-01)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogRecord {
    pub id: u64,
    /// 가림 처리된 인자 (`git` 제외)
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// epoch 밀리초
    pub started_at: i64,
    pub elapsed_ms: u32,
    /// 종료 코드. 시그널·취소면 `None`
    pub status: Option<i32>,
    /// stderr 마지막 부분 (최대 2KB)
    pub stderr_tail: String,
    /// 쓰기·네트워크 명령인지
    pub is_write: bool,
    pub cancelled: bool,
}

/// stderr 보관 상한 (바이트)
pub const STDERR_TAIL_MAX: usize = 2 * 1024;

/// 인자에서 자격 증명을 가린다 (명세 4.3).
/// - `scheme://user:secret@host` → `scheme://user:***@host`, `scheme://token@host` → `scheme://***@host`
/// - `Authorization:` 헤더 값, `token=`·`password=` 뒤 값
pub fn redact_args(args: &[String]) -> Vec<String> {
    args.iter().map(|a| redact_one(a)).collect()
}

/// 자유 텍스트(stderr 등) 안의 URL 자격 증명을 가린다. 여러 줄·여러 URL 을 모두 처리한다
pub fn redact_text(text: &str) -> String {
    redact_url_secret(text)
}

/// 인자 하나를 가린다
fn redact_one(arg: &str) -> String {
    let mut out = redact_url_secret(arg);
    for key in ["Authorization:", "authorization:"] {
        if let Some(pos) = out.find(key) {
            out.truncate(pos + key.len());
            out.push_str(" ***");
            return out;
        }
    }
    for key in ["token=", "password=", "Password=", "TOKEN="] {
        if let Some(pos) = out.find(key) {
            out.truncate(pos + key.len());
            out.push_str("***");
            return out;
        }
    }
    out
}

/// 문자열 안 모든 URL 의 userinfo 를 가린다. `user:secret@` → `user:***@`, 콜론 없는 `token@` → `***@`.
/// ssh 계열의 콜론 없는 사용자 이름(`git@`)은 비밀이 아니므로 그대로 둔다
fn redact_url_secret(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("://") {
        let (before, after) = rest.split_at(pos + 3);
        out.push_str(before);
        let is_ssh = before[..pos].ends_with("ssh");
        // authority 는 경로·쿼리·따옴표·공백 앞까지다
        let end = after
            .find(|c: char| matches!(c, '/' | '?' | '#' | '\'' | '"') || c.is_whitespace())
            .unwrap_or(after.len());
        let authority = &after[..end];
        match authority.rfind('@') {
            Some(at) => {
                let (userinfo, host) = authority.split_at(at);
                match userinfo.find(':') {
                    Some(colon) => {
                        out.push_str(&userinfo[..colon]);
                        out.push_str(":***");
                    }
                    None if is_ssh => out.push_str(userinfo),
                    None => out.push_str("***"),
                }
                out.push_str(host);
            }
            None => out.push_str(authority),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// stderr 꼬리를 잘라 보관 길이로 맞춘다 (UTF-8 경계 보존)
pub fn stderr_tail(stderr: &str) -> String {
    if stderr.len() <= STDERR_TAIL_MAX {
        return stderr.to_string();
    }
    let mut start = stderr.len() - STDERR_TAIL_MAX;
    while !stderr.is_char_boundary(start) {
        start += 1;
    }
    stderr[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_password_is_masked() {
        let args = vec![
            "clone".to_string(),
            "https://user:s3cr3t@github.com/a/b.git".to_string(),
        ];
        assert_eq!(redact_args(&args)[1], "https://user:***@github.com/a/b.git");
    }

    #[test]
    fn url_without_secret_is_untouched() {
        let s = "https://github.com/a/b.git".to_string();
        assert_eq!(redact_args(std::slice::from_ref(&s))[0], s);
        let t = "git@github.com:a/b.git".to_string();
        assert_eq!(redact_args(std::slice::from_ref(&t))[0], t);
    }

    #[test]
    fn header_and_token_values_are_masked() {
        let h = "http.extraheader=Authorization: Bearer abc".to_string();
        assert_eq!(
            redact_args(std::slice::from_ref(&h))[0],
            "http.extraheader=Authorization: ***"
        );
        let t = "--password=hunter2".to_string();
        assert_eq!(redact_args(std::slice::from_ref(&t))[0], "--password=***");
    }

    #[test]
    fn token_only_userinfo_is_masked() {
        let a = "https://ghp_abc123@github.com/o/r.git".to_string();
        assert_eq!(
            redact_args(std::slice::from_ref(&a))[0],
            "https://***@github.com/o/r.git"
        );
        // ssh 사용자 이름은 비밀이 아니다
        let s = "ssh://git@github.com/o/r.git".to_string();
        assert_eq!(redact_args(std::slice::from_ref(&s))[0], s);
        // 경로의 @ 는 userinfo 가 아니다
        let p = "https://github.com/o/r@v1".to_string();
        assert_eq!(redact_args(std::slice::from_ref(&p))[0], p);
    }

    #[test]
    fn free_text_masks_every_url() {
        let t = "fatal: unable to access 'https://tok1@h1/x/': 'https://u:tok2@h2' failed\n";
        let out = redact_text(t);
        assert!(!out.contains("tok1") && !out.contains("tok2"), "{out}");
        assert_eq!(
            out,
            "fatal: unable to access 'https://***@h1/x/': 'https://u:***@h2' failed\n"
        );
        assert_eq!(redact_text("보통 메시지 a@b.c"), "보통 메시지 a@b.c");
    }

    #[test]
    fn stderr_tail_respects_char_boundary() {
        let long = "가".repeat(STDERR_TAIL_MAX);
        let tail = stderr_tail(&long);
        assert!(tail.len() <= STDERR_TAIL_MAX);
        assert!(tail.chars().all(|c| c == '가'));
    }
}
