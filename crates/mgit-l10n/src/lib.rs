//! 화면에 나가는 문구의 언어 (한국어·영어). 프로세스 전역 언어 하나를 두고, 문구를 만드는 자리에서 두 언어 문구를
//! 함께 적어 지금 언어의 것을 고른다. 외부 다국어 프레임워크는 쓰지 않는다.
//!
//! - 인자 없는 고정 문구: [`pick`] (할당 없음)
//! - 값이 들어가는 문구: [`tr!`] (`format!` 과 같은 문법, 결과는 `String`)
//!
//! 기본 언어는 한국어다. 앱 셸이 사용자 설정을 받아 [`set`] 한다. 언어는 읽는 시점에 정해지므로, 이미 만든 문구는
//! 언어를 바꿔도 그대로다.

use std::sync::atomic::{AtomicU8, Ordering};

/// 화면 문구 언어
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Lang {
    /// 한국어 (기본)
    Ko = 0,
    /// 영어
    En = 1,
}

impl Lang {
    /// 언어 코드(`ko`, `ko-KR`, `ko_KR.UTF-8`, `KO` …)를 언어로 바꾼다. 언어 부분(`-`·`_`·`.`·`@` 앞)이 대소문자
    /// 구분 없이 `ko` 면 한국어, 그 밖(빈 값·알 수 없는 코드 포함)은 영어
    pub fn from_code(code: &str) -> Lang {
        let language = code
            .trim()
            .split(['-', '_', '.', '@'])
            .next()
            .unwrap_or_default();
        if language.eq_ignore_ascii_case("ko") {
            Lang::Ko
        } else {
            Lang::En
        }
    }
}

/// 지금 언어 (`Lang` 의 `u8` 값). 다른 메모리와 함께 공개하는 값이 아니라 `Relaxed` 로 충분하다
static CURRENT: AtomicU8 = AtomicU8::new(Lang::Ko as u8);

/// 프로세스 전역 언어를 바꾼다. 이후에 만드는 문구부터 따른다
pub fn set(lang: Lang) {
    CURRENT.store(lang as u8, Ordering::Relaxed);
}

/// 지금 언어 (기본 [`Lang::Ko`])
pub fn current() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == Lang::En as u8 {
        Lang::En
    } else {
        Lang::Ko
    }
}

/// 인자 없는 고정 문구를 지금 언어로 고른다 (할당 없음)
pub fn pick(ko: &'static str, en: &'static str) -> &'static str {
    match current() {
        Lang::Ko => ko,
        Lang::En => en,
    }
}

/// 값이 들어가는 문구를 지금 언어로 만든다: `tr!("한국어 포맷", "English format", 인자…)`.
///
/// 두 포맷 문자열은 `format!` 문법을 따르고, 결과는 `String` 이다. 호출한 자리의 변수를 이름으로 바로 쓸 수 있고
/// (`{path}`), 추가 인자도 받는다. 인자는 두 포맷 모두에서 써야 한다 (`format!` 처럼 쓰지 않은 인자는 컴파일 오류).
/// 인자 없는 고정 문구는 할당이 없는 [`pick`] 을 쓴다.
///
/// ```
/// let path = "a.txt";
/// assert_eq!(mgit_l10n::tr!("{path} 을 열 수 없습니다", "Cannot open {path}"), "a.txt 을 열 수 없습니다");
/// assert_eq!(mgit_l10n::tr!("{}개", "{} items", 3), "3개");
/// ```
#[macro_export]
macro_rules! tr {
    ($ko:literal, $en:literal $(,)?) => {
        match $crate::current() {
            $crate::Lang::Ko => ::std::format!($ko),
            $crate::Lang::En => ::std::format!($en),
        }
    };
    ($ko:literal, $en:literal, $($arg:tt)+) => {
        match $crate::current() {
            $crate::Lang::Ko => ::std::format!($ko, $($arg)+),
            $crate::Lang::En => ::std::format!($en, $($arg)+),
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, PoisonError};

    /// 전역 언어를 읽거나 바꾸는 테스트끼리 직렬화한다 (같은 바이너리의 테스트는 병렬로 돈다)
    static LOCK: Mutex<()> = Mutex::new(());

    /// 잠금을 쥐고 있다가, 끝날 때(패닉 포함) 언어를 기본값(한국어)으로 되돌린다
    struct Locked {
        _guard: MutexGuard<'static, ()>,
    }

    impl Drop for Locked {
        /// 잠금을 풀기 전에 언어를 한국어로 되돌린다 (필드는 이 함수 뒤에 해제된다)
        fn drop(&mut self) {
            set(Lang::Ko);
        }
    }

    /// 전역 언어 잠금을 잡는다. 앞선 테스트가 패닉해 잠금이 오염돼도 이어 쓴다 (언어는 가드가 되돌려 놓았다)
    fn locked() -> Locked {
        Locked {
            _guard: LOCK.lock().unwrap_or_else(PoisonError::into_inner),
        }
    }

    #[test]
    fn from_code_is_korean_only_for_ko_language_part() {
        for code in [
            "ko",
            "KO",
            "Ko",
            "ko-KR",
            "ko_KR",
            "ko_KR.UTF-8",
            " ko-kr ",
            "ko@x",
        ] {
            assert_eq!(Lang::from_code(code), Lang::Ko, "{code}");
        }
        for code in [
            "en",
            "en-US",
            "fr_FR",
            "",
            "k",
            "kok",
            "kor",
            "C",
            "POSIX",
            "한국어",
        ] {
            assert_eq!(Lang::from_code(code), Lang::En, "{code}");
        }
    }

    #[test]
    fn defaults_to_korean_and_current_and_pick_follow_set() {
        let _lock = locked();
        assert_eq!(current(), Lang::Ko);
        assert_eq!(pick("열기", "Open"), "열기");

        set(Lang::En);
        assert_eq!(current(), Lang::En);
        assert_eq!(pick("열기", "Open"), "Open");

        set(Lang::Ko);
        assert_eq!(current(), Lang::Ko);
        assert_eq!(pick("열기", "Open"), "열기");
    }

    #[test]
    fn tr_captures_caller_variables_by_name() {
        let _lock = locked();
        let path = "src/main.rs";
        let n = 3;
        assert_eq!(
            tr!("{path} 의 변경 {n}개", "{n} changes in {path}"),
            "src/main.rs 의 변경 3개"
        );
        set(Lang::En);
        assert_eq!(
            tr!("{path} 의 변경 {n}개", "{n} changes in {path}"),
            "3 changes in src/main.rs"
        );
    }

    #[test]
    fn tr_takes_extra_args_and_trailing_comma_and_evaluates_args_once() {
        let _lock = locked();
        let mut calls = 0;
        let mut next = || {
            calls += 1;
            calls
        };
        assert_eq!(tr!("{} 개", "{} items", next()), "1 개");
        assert_eq!(tr!("{a} / {b}", "{b} of {a}", a = 1, b = 2,), "1 / 2");
        set(Lang::En);
        assert_eq!(tr!("{} 개", "{} items", next()), "2 items");
        assert_eq!(tr!("{a} / {b}", "{b} of {a}", a = 1, b = 2,), "2 of 1");
        assert_eq!(calls, 2);
    }

    #[test]
    fn text_keeps_the_language_it_was_made_in() {
        let _lock = locked();
        let name = "main";
        let before = tr!("{name} 삭제", "Delete {name}");
        set(Lang::En);
        let after = tr!("{name} 삭제", "Delete {name}");
        assert_eq!(before, "main 삭제");
        assert_eq!(after, "Delete main");
    }
}
