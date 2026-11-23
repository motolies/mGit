//! 사용자·화면이 넘긴 ref 이름 검사 (여러 기능이 함께 쓴다). git 이 받기 전에 옵션 오인과 refspec 오해를 막는다

use mgit_l10n::tr;

use crate::error::CoreError;

/// 옵션으로 오인되거나 공백·제어 문자(NUL 포함)·`..` 가 든 이름인지
fn has_basic_problem(name: &str) -> bool {
    name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// 브랜치·ref 이름 검사 (옵션 오인·공백·제어 문자(NUL 포함)·`..` 방지). 폴더 일괄 작업의 시작점(`HEAD~1` 등)에도
/// 쓰므로 revision 문법 문자는 막지 않는다
pub(crate) fn check_ref_name(name: &str) -> Result<(), CoreError> {
    if has_basic_problem(name) {
        return Err(CoreError::Invalid(tr!(
            "잘못된 branch 이름: {name:?}",
            "Invalid branch name: {name:?}"
        )));
    }
    Ok(())
}

/// tag 이름 검사. 기본 검사에 더해 `refs/tags/<n>:refs/tags/<n>` refspec 을 깨거나 glob·revision 으로 해석될 문자
/// (`:` `*` `?` `[` `\` `^` `~` `@{`)와 `/` 로 시작·끝나는 이름을 막는다. 모두 git 이 tag 이름으로 허용하지 않는 것이다
pub(crate) fn check_tag_name(name: &str) -> Result<(), CoreError> {
    let refspec_problem = name
        .chars()
        .any(|c| matches!(c, ':' | '*' | '?' | '[' | '\\' | '^' | '~'))
        || name.contains("@{")
        || name.starts_with('/')
        || name.ends_with('/');
    if has_basic_problem(name) || refspec_problem {
        return Err(CoreError::Invalid(tr!(
            "잘못된 tag 이름: {name:?}",
            "Invalid tag name: {name:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_name_keeps_revision_syntax() {
        assert!(check_ref_name("feature/x").is_ok());
        assert!(check_ref_name("HEAD~1").is_ok());
        assert!(check_ref_name("-x").is_err());
        assert!(check_ref_name("a..b").is_err());
        assert!(check_ref_name("a b").is_err());
        assert!(check_ref_name("").is_err());
    }

    #[test]
    fn tag_name_rejects_refspec_breakers() {
        for ok in ["v1.0", "release/2024-01", "v1+build", "@"] {
            assert!(check_tag_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-v1", "a..b", "a b", "v1:main", "v*", "v?", "v[1]", "v^{}", "v~1", "a@{0", "/v1",
            "v1/", "a\\b", "a\0b",
        ] {
            assert!(check_tag_name(bad).is_err(), "{bad:?}");
        }
    }
}
