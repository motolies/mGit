use serde::Serialize;

use crate::error::ParseError;

/// 지원하는 최소 git 버전 (D8)
pub const MIN_GIT_VERSION: (u32, u32, u32) = (2, 45, 0);

/// `git --version` 결과
#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    /// 원문 (`git version 2.54.0 (Apple Git-157)`)
    pub raw: String,
}

impl GitVersion {
    /// `git version 2.54.0 (Apple Git-157)`, `git version 2.45.0.windows.1` 같은 출력을 파싱한다.
    /// 세 번째 토큰을 `.` 으로 나눠 앞 세 조각만 숫자로 읽는다.
    pub fn parse(output: &str) -> Result<Self, ParseError> {
        let raw = output.trim().to_string();
        let token = raw.split_whitespace().nth(2).ok_or(ParseError::BadField {
            record: 0,
            field: 2,
        })?;
        let mut parts = token.split('.').map(|p| p.parse::<u32>());
        let mut next = |field: usize| -> Result<u32, ParseError> {
            parts
                .next()
                .and_then(Result::ok)
                .ok_or(ParseError::BadField { record: 0, field })
        };
        let major = next(0)?;
        let minor = next(1)?;
        // patch 가 없는 `2.45` 같은 출력은 0 으로 본다
        let patch = next(2).unwrap_or(0);
        Ok(GitVersion {
            major,
            minor,
            patch,
            raw,
        })
    }

    /// 최소 버전 이상인지
    pub fn meets_minimum(&self) -> bool {
        (self.major, self.minor, self.patch) >= MIN_GIT_VERSION
    }

    /// `2.54.0` 형식
    pub fn short(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }

    /// 최소 버전을 `2.45.0` 형식으로
    pub fn minimum_string() -> String {
        format!(
            "{}.{}.{}",
            MIN_GIT_VERSION.0, MIN_GIT_VERSION.1, MIN_GIT_VERSION.2
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_apple_git() {
        let v = GitVersion::parse("git version 2.54.0 (Apple Git-157)\n").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (2, 54, 0));
        assert!(v.meets_minimum());
        assert_eq!(v.short(), "2.54.0");
    }

    #[test]
    fn parses_windows_suffix() {
        let v = GitVersion::parse("git version 2.45.0.windows.1").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (2, 45, 0));
        assert!(v.meets_minimum());
    }

    #[test]
    fn detects_too_old() {
        let v = GitVersion::parse("git version 2.39.5").unwrap();
        assert!(!v.meets_minimum());
    }

    #[test]
    fn rejects_garbage() {
        assert!(GitVersion::parse("not git").is_err());
        assert!(GitVersion::parse("git version x.y").is_err());
    }
}
