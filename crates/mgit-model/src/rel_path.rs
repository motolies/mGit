//! 상대 경로의 어휘 검증 (FS-02). 파일 시스템을 보지 않고 문자열만 본다.
//!
//! 프런트가 보내는 "루트 기준 상대 경로"를 받아 루트 밖으로 나갈 수 있는 꼴을 모두 거부한다.
//! 심볼릭 링크·정규화 뒤의 포함 관계(FS-04·05)는 파일 시스템을 봐야 하므로 여기서 다루지 않는다

use std::path::{Component, Path, PathBuf, is_separator};

use mgit_l10n::pick;

/// 상대 경로 전체의 길이 상한 (바이트)
pub const REL_PATH_MAX_BYTES: usize = 4096;
/// 구성요소 하나의 길이 상한 (바이트)
pub const REL_PATH_COMPONENT_MAX_BYTES: usize = 255;

/// 상대 경로를 거부한 이유
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RelPathError {
    #[error("{}", pick("경로가 비어 있습니다", "Empty path"))]
    Empty,
    #[error(
        "{}",
        pick("경로에 NUL 문자가 있습니다", "Path contains a NUL character")
    )]
    Nul,
    #[error("{}", pick("경로가 너무 깁니다", "Path is too long"))]
    TooLong,
    #[error(
        "{}",
        pick("절대 경로는 사용할 수 없습니다", "Absolute paths are not allowed")
    )]
    Absolute,
    #[error(
        "{}",
        pick("경로에 비어 있는 부분이 있습니다", "Path has an empty component")
    )]
    EmptyComponent,
    #[error("{}", pick("경로의 일부가 너무 깁니다", "Path component is too long"))]
    ComponentTooLong,
    #[error(
        "{}",
        pick("경로에 `.`을 사용할 수 없습니다", "`.` components are not allowed")
    )]
    CurrentDir,
    #[error(
        "{}",
        pick("경로에 `..`을 사용할 수 없습니다", "`..` components are not allowed")
    )]
    ParentDir,
    #[error(
        "{}",
        pick(
            "`.git` 내부에는 접근할 수 없습니다",
            "Paths inside `.git` are not allowed"
        )
    )]
    DotGit,
}

/// 어휘 검증을 통과한 상대 경로. 구성요소는 모두 평범한 이름이다
/// (`.`·`..`·`.git`·빈 이름·구분자·NUL 없음)
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RelPath(Vec<String>);

impl RelPath {
    /// 상대 경로 문자열을 검증해 구성요소로 나눈다. 구분자는 `/` 와 그 플랫폼의 경로 구분자다
    /// (Windows 의 `\`). 앞뒤·중간의 빈 구성요소(`a//b`, `a/`)도 거부한다 — 호출자가 만든 경로만 받는다
    pub fn parse(path: &str) -> Result<Self, RelPathError> {
        if path.is_empty() {
            return Err(RelPathError::Empty);
        }
        if path.contains('\0') {
            return Err(RelPathError::Nul);
        }
        if path.len() > REL_PATH_MAX_BYTES {
            return Err(RelPathError::TooLong);
        }
        if path.starts_with(is_path_separator) || Path::new(path).is_absolute() {
            return Err(RelPathError::Absolute);
        }
        let mut components = Vec::new();
        for part in path.split(is_path_separator) {
            components.push(check_component(part)?.to_string());
        }
        Ok(RelPath(components))
    }

    /// 구성요소 목록 (하나 이상)
    pub fn components(&self) -> &[String] {
        &self.0
    }

    /// 구성요소를 이어 붙인 상대 경로. 루트에 `join` 해도 루트 밖을 가리키지 않는다 (어휘 기준)
    pub fn to_path(&self) -> PathBuf {
        self.0.iter().collect()
    }
}

/// 경로 구분자인지: `/` 는 항상, 그 밖에는 플랫폼의 구분자
fn is_path_separator(c: char) -> bool {
    c == '/' || is_separator(c)
}

/// 구성요소 하나를 검사한다. 통과하면 그대로 돌려준다
fn check_component(part: &str) -> Result<&str, RelPathError> {
    if part.is_empty() {
        return Err(RelPathError::EmptyComponent);
    }
    if part.len() > REL_PATH_COMPONENT_MAX_BYTES {
        return Err(RelPathError::ComponentTooLong);
    }
    if part == "." {
        return Err(RelPathError::CurrentDir);
    }
    if part == ".." {
        return Err(RelPathError::ParentDir);
    }
    if part.eq_ignore_ascii_case(".git") {
        return Err(RelPathError::DotGit);
    }
    // 표준 라이브러리의 해석으로도 평범한 이름 하나여야 한다 (Windows 의 `C:` 같은 드라이브 접두 거부)
    let mut parsed = Path::new(part).components();
    match (parsed.next(), parsed.next()) {
        (Some(Component::Normal(name)), None) if name == part => Ok(part),
        _ => Err(RelPathError::Absolute),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// 통과한 경로의 구성요소를 `/` 로 이어 본다
    fn joined(path: &str) -> Result<String, RelPathError> {
        RelPath::parse(path).map(|p| p.components().join("/"))
    }

    #[test]
    fn accepts_plain_relative_paths() {
        let cases = [
            "a",
            "a/b",
            "src/main/java/App.java",
            "한글 폴더/파일 이름.txt",
            ".github/workflows/ci.yml",
            ".gitignore",
            ".gitmodules",
            "a.git/b",
            "git",
            "...",
            "a/..b/c..",
            "-rf",
        ];
        for case in cases {
            assert_eq!(joined(case).as_deref(), Ok(case), "{case:?}");
        }
    }

    #[test]
    fn rejects_paths_that_could_leave_the_root() {
        let long_component = "x".repeat(REL_PATH_COMPONENT_MAX_BYTES + 1);
        let long_path = ["abc"; REL_PATH_MAX_BYTES / 4 + 1].join("/");
        let cases: Vec<(&str, RelPathError)> = vec![
            ("", RelPathError::Empty),
            ("a\0b", RelPathError::Nul),
            ("\0", RelPathError::Nul),
            ("/", RelPathError::Absolute),
            ("/etc/passwd", RelPathError::Absolute),
            ("//server/share", RelPathError::Absolute),
            ("..", RelPathError::ParentDir),
            ("../x", RelPathError::ParentDir),
            ("a/../b", RelPathError::ParentDir),
            ("a/b/..", RelPathError::ParentDir),
            (".", RelPathError::CurrentDir),
            ("./a", RelPathError::CurrentDir),
            ("a/./b", RelPathError::CurrentDir),
            ("a//b", RelPathError::EmptyComponent),
            ("a/", RelPathError::EmptyComponent),
            ("a/b/", RelPathError::EmptyComponent),
            (".git", RelPathError::DotGit),
            (".git/config", RelPathError::DotGit),
            ("a/.git/HEAD", RelPathError::DotGit),
            ("a/.GIT/HEAD", RelPathError::DotGit),
            ("sub/.Git", RelPathError::DotGit),
            (&long_component, RelPathError::ComponentTooLong),
            (&long_path, RelPathError::TooLong),
        ];
        for (case, want) in cases {
            assert_eq!(
                RelPath::parse(case),
                Err(want),
                "{:?}",
                &case[..case.len().min(40)]
            );
        }
    }

    #[test]
    fn length_limits_are_inclusive() {
        let component = "x".repeat(REL_PATH_COMPONENT_MAX_BYTES);
        assert!(RelPath::parse(&component).is_ok());
        // `abc/` 1023번(4092바이트) + 4바이트 = 상한과 정확히 같다
        let mut path = format!("{}abcd", "abc/".repeat(REL_PATH_MAX_BYTES / 4 - 1));
        assert_eq!(path.len(), REL_PATH_MAX_BYTES);
        assert!(RelPath::parse(&path).is_ok());
        path.push('e');
        assert_eq!(RelPath::parse(&path), Err(RelPathError::TooLong));
    }

    #[test]
    fn to_path_joins_components() {
        let p = RelPath::parse("a/b/c.txt").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(p.components(), ["a", "b", "c.txt"]);
        assert_eq!(p.to_path(), Path::new("a").join("b").join("c.txt"));
    }

    /// 거부돼야 하는 구성요소
    fn bad_component() -> impl Strategy<Value = String> {
        prop_oneof![
            Just(String::new()),
            Just(".".to_string()),
            Just("..".to_string()),
            "[.][gG][iI][tT]",
        ]
    }

    /// 평범한 구성요소 (금지된 이름은 뺀다)
    fn good_component() -> impl Strategy<Value = String> {
        "[A-Za-z0-9가-힣 _.-]{1,12}".prop_filter("금지된 이름", |s| check_component(s).is_ok())
    }

    proptest! {
        /// 어떤 문자열이 와도 죽지 않고, 통과했다면 루트 아래의 평범한 이름들로만 이뤄진다
        #[test]
        fn accepted_paths_stay_under_the_root(path in "\\PC{0,40}|[./a-c\\\\\\x00]{0,12}") {
            let Ok(parsed) = RelPath::parse(&path) else {
                return Ok(());
            };
            prop_assert!(!parsed.components().is_empty());
            for part in parsed.components() {
                prop_assert!(!part.is_empty());
                prop_assert!(part != "." && part != "..");
                prop_assert!(!part.eq_ignore_ascii_case(".git"));
                prop_assert!(!part.contains(['/', '\0']));
                prop_assert!(!part.chars().any(is_separator));
            }
            let root = Path::new("/root/dir");
            let full = root.join(parsed.to_path());
            prop_assert!(full.starts_with(root));
            let below: Vec<Component> = full.strip_prefix(root).map_err(|e| {
                TestCaseError::fail(e.to_string())
            })?.components().collect();
            prop_assert_eq!(below.len(), parsed.components().len());
            prop_assert!(below.iter().all(|c| matches!(c, Component::Normal(_))));
        }

        /// 평범한 구성요소를 `/` 로 이은 경로는 통과하고 구성요소가 그대로 나온다
        #[test]
        fn good_components_round_trip(parts in proptest::collection::vec(good_component(), 1..6)) {
            let parsed = RelPath::parse(&parts.join("/"));
            prop_assert_eq!(parsed.as_ref().map(RelPath::components), Ok(parts.as_slice()));
        }

        /// 금지된 구성요소가 어느 자리에 끼어도 거부한다
        #[test]
        fn any_bad_component_is_rejected(
            mut parts in proptest::collection::vec(good_component(), 0..5),
            bad in bad_component(),
            at in 0usize..6,
        ) {
            let at = at.min(parts.len());
            parts.insert(at, bad);
            prop_assert!(RelPath::parse(&parts.join("/")).is_err());
        }
    }
}
