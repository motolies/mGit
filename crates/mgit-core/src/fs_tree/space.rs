//! 파일 API 의 경로 공간: 요청이 보낸 상대 경로를 실제 루트와 그 루트 기준 나머지 경로로 나눈다. 세션이 공간을
//! 정하고(`Core::fs_space`), 진입점은 루트를 직접 묻지 않고 `locate`·`roots` 로 루트를 얻는다 (FS-01).
//!
//! 공간은 디렉터리 하나(저장소 세션의 작업 트리, 폴더 세션의 폴더)이거나 가상 그룹(MR-13)이다. 보안 경계(FS-02~05)는
//! 이 모듈이 아니라 하류가 지킨다 — `locate` 가 돌려준 나머지 경로는 그 루트에서 어휘 검증(`parse`)·구성요소 확인
//! (`resolve`)·정규화 재검사(`check_inside`)를 그대로 다시 거친다. 그래서 `Dir` 은 요청을 손대지 않고 넘기며, 결과가
//! 공간을 들이기 전과 같다.
//!
//! 그룹의 가상 경로는 `"" | alias | alias "/" rest` 다. 첫 구성요소로 멤버를 고르기 전에 요청 전체를 어휘 검증하므로
//! (`alias/..`·`./alias`·절대 경로 거부) 별칭 분리가 검증을 건너뛰는 길이 되지 않는다. 빈 문자열은 그룹 맨 위로, 별칭들을
//! 나열만 하고 읽기·쓰기·대상은 모두 거부한다. 별칭 단독은 그 멤버 루트다 (기존 루트 의미: 안에 만들기 허용, 루트 자신의
//! 이름 바꾸기·휴지통 거부)

use std::path::PathBuf;

use super::{parse, rejected};
use crate::error::CoreError;
use crate::group::{GroupMount, MemberState};

/// 모르는 별칭 거부 사유
const UNKNOWN_ALIAS_REASON: (&str, &str) = ("그룹에 없는 이름입니다", "Not a member of this group");
/// 저장소가 아니게 된 멤버 거부 사유 (링크로 바뀐 멤버 루트를 따라가지 않는다)
const NOT_REPO_REASON: (&str, &str) = (
    "저장소가 아니게 된 멤버입니다",
    "This member is no longer a repository",
);
/// 그룹 맨 위 거부 사유
const GROUP_TOP_REASON: (&str, &str) = (
    "그룹 맨 위에는 파일이 없습니다",
    "The top of a group holds no files",
);

/// 세션의 파일 경로 공간. 변형을 더할 때 `locate`·`roots` 와 진입점의 구조 분해가 모두 컴파일 오류로 드러난다
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FsSpace {
    /// 디렉터리 하나가 루트다. 요청 경로는 이 루트 기준이고, 빈 문자열은 루트 자신이다
    Dir(PathBuf),
    /// 가상 그룹: 첫 구성요소(별칭)가 멤버를 고르고 나머지는 그 멤버 루트 기준이다. 빈 문자열은 그룹 맨 위다
    Group(Vec<GroupMount>),
}

/// `locate` 결과: 요청 경로가 가리키는 실제 루트와 그 루트 기준 나머지
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Located {
    /// `root` 아래의 `rest`. `rest` 는 아직 검증하지 않은 경로이고, 빈 문자열이면 `root` 자신이다
    Under { root: PathBuf, rest: String },
    /// 그룹 맨 위 (멤버들). 나열만 되고 파일·대상으로는 거부한다
    GroupTop(Vec<GroupMount>),
}

impl Located {
    /// 파일·대상 하나를 가리키는 요청의 (루트, 나머지). 그룹 맨 위는 파일도 대상도 아니므로 거부한다 (`request` 는 거부
    /// 문구에 싣는 요청 경로)
    pub(crate) fn into_under(self, request: &str) -> Result<(PathBuf, String), CoreError> {
        match self {
            Located::Under { root, rest } => Ok((root, rest)),
            Located::GroupTop(_) => Err(rejected(request, GROUP_TOP_REASON)),
        }
    }
}

impl FsSpace {
    /// 요청 상대 경로를 실제 루트와 나머지로 나눈다. `Dir` 은 루트가 하나라 요청을 그대로 나머지로 넘긴다 — 검증은
    /// 하류가 같은 요청에 대해 하므로 거부·상태·거부 문구가 공간을 들이기 전과 같다. `Group` 은 빈 문자열이면 맨 위,
    /// 아니면 전체를 먼저 어휘 검증한 뒤 첫 구성요소를 별칭과 정확히(대소문자 구분) 맞추고 나머지를 `/` 로 이어 넘긴다.
    /// 모르는 별칭·저장소가 아니게 된 멤버는 거부, 없는 멤버는 그 루트로 넘겨 하류가 "없음"으로 답하게 한다
    pub(crate) fn locate(&self, rel: &str) -> Result<Located, CoreError> {
        match self {
            FsSpace::Dir(root) => Ok(Located::Under {
                root: root.clone(),
                rest: rel.to_owned(),
            }),
            FsSpace::Group(mounts) => {
                if rel.is_empty() {
                    return Ok(Located::GroupTop(mounts.clone()));
                }
                let parsed = parse(rel)?;
                let Some((alias, rest)) = parsed.components().split_first() else {
                    return Ok(Located::GroupTop(mounts.clone()));
                };
                let mount = mounts
                    .iter()
                    .find(|m| m.alias == *alias)
                    .ok_or_else(|| rejected(rel, UNKNOWN_ALIAS_REASON))?;
                if mount.state == MemberState::NotRepo {
                    return Err(rejected(rel, NOT_REPO_REASON));
                }
                Ok(Located::Under {
                    root: mount.path.clone(),
                    rest: rest.join("/"),
                })
            }
        }
    }

    /// 검색·⌘P 가 순회할 (결과 경로 접두, 실제 루트) 목록. `Dir` 은 접두 없는 루트 하나, `Group` 은 있는 멤버마다
    /// (별칭, 멤버 루트)다
    pub(crate) fn roots(&self) -> Vec<(String, PathBuf)> {
        match self {
            FsSpace::Dir(root) => vec![(String::new(), root.clone())],
            FsSpace::Group(mounts) => mounts
                .iter()
                .filter(|m| matches!(m.state, MemberState::Present(_)))
                .map(|m| (m.alias.clone(), m.path.clone()))
                .collect(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
// unix 전용 표 줄만 쓰는 도우미는 다른 OS 빌드에서 쓰이지 않는다
#[cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]
mod tests {
    use std::fmt::Debug;
    use std::path::Path;

    use super::*;
    use crate::fs_tree::{FsEntryKind, FsFile, FsListing, list_dir_at, read_file_at};

    /// 결과 분류. 표의 기대값이다
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Class {
        Text,
        /// 정규 파일이 아님 (디렉터리·링크)
        Unsupported,
        Missing,
        Listed,
        /// `CoreError::Invalid` (어휘 위반·루트 밖·`.git`·경로 중간의 링크·링크 나열)
        Rejected,
    }

    /// 읽기 결과 → 분류
    fn read_class(r: &Result<FsFile, CoreError>) -> Class {
        match r {
            Ok(FsFile::Text { .. }) => Class::Text,
            Ok(FsFile::Unsupported { .. }) => Class::Unsupported,
            Ok(FsFile::Missing) => Class::Missing,
            Err(CoreError::Invalid(_)) => Class::Rejected,
            other => panic!("표에 없는 읽기 결과: {other:?}"),
        }
    }

    /// 나열 결과 → 분류
    fn list_class(r: &Result<FsListing, CoreError>) -> Class {
        match r {
            Ok(FsListing::Listed { .. }) => Class::Listed,
            Ok(FsListing::Missing) => Class::Missing,
            Err(CoreError::Invalid(_)) => Class::Rejected,
            other => panic!("표에 없는 나열 결과: {other:?}"),
        }
    }

    /// 결과 전체를 비교할 수 있는 문자열로 (오류는 문구까지). `CoreError` 는 `PartialEq` 가 없다
    fn outcome<T: Debug>(r: &Result<T, CoreError>) -> String {
        match r {
            Ok(v) => format!("Ok({v:?})"),
            Err(e) => format!("Err({e})"),
        }
    }

    /// 부모 디렉터리까지 만들고 파일을 쓴다
    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// 시험용 루트 `tmp/root` 와 루트 밖 `tmp/outside` (unix 에서는 링크도)
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        write(&root.join("top.txt"), "MARK:top");
        write(&root.join("a/b.txt"), "MARK:a/b");
        write(&root.join(".git/config"), "SECRET-DOTGIT");
        write(&outside.join("secret.txt"), "SECRET-OUTSIDE");
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, root.join("out-dir")).unwrap();
            symlink(outside.join("secret.txt"), root.join("out-file")).unwrap();
            symlink("top.txt", root.join("in-file")).unwrap();
        }
        (dir, root)
    }

    /// `Dir` 공간을 거친 읽기·나열이 루트를 직접 쓰던 기존 경로 해석(`parse`→`resolve`→`check_inside`)과 결과·거부
    /// 문구까지 같다. 정상·`..`·절대 경로·`.git`·NUL·빈 구성요소·없음·링크(끝·중간·나열) 를 표로 본다
    #[test]
    fn dir_locate_matches_the_direct_root_resolution() {
        use Class::*;
        let (dir, root) = fixture();
        let outside_abs = dir.path().join("outside/secret.txt");
        let outside_abs = outside_abs.to_str().unwrap();
        let space = FsSpace::Dir(root.clone());
        // (요청, 읽기 기대, 나열 기대)
        let mut table: Vec<(&str, Class, Class)> = vec![
            ("top.txt", Text, Missing),
            ("a/b.txt", Text, Missing),
            ("a", Unsupported, Listed),
            ("", Rejected, Listed),
            ("missing.txt", Missing, Missing),
            ("a/missing", Missing, Missing),
            ("..", Rejected, Rejected),
            ("../outside/secret.txt", Rejected, Rejected),
            ("a/../top.txt", Rejected, Rejected),
            ("./top.txt", Rejected, Rejected),
            ("/top.txt", Rejected, Rejected),
            (outside_abs, Rejected, Rejected),
            ("a//b.txt", Rejected, Rejected),
            ("a/", Rejected, Rejected),
            (".git/config", Rejected, Rejected),
            (".GIT", Rejected, Rejected),
            ("a\0b", Rejected, Rejected),
        ];
        #[cfg(unix)]
        table.extend([
            ("out-file", Unsupported, Rejected),
            ("in-file", Unsupported, Rejected),
            ("out-dir", Unsupported, Rejected),
            ("out-dir/secret.txt", Rejected, Rejected),
        ]);
        for (request, read_expect, list_expect) in table {
            let (at, rest) = space.locate(request).unwrap().into_under(request).unwrap();
            assert_eq!((&at, rest.as_str()), (&root, request), "{request:?}");

            let located = read_file_at(&at, &rest);
            let direct = read_file_at(&root, request);
            assert_eq!(outcome(&located), outcome(&direct), "읽기 {request:?}");
            assert_eq!(read_class(&located), read_expect, "읽기 {request:?}");
            if let Ok(FsFile::Text { text, .. }) = &located {
                assert!(text.starts_with("MARK:"), "{request:?}: {text}");
            }
            if let Ok(FsFile::Unsupported { kind }) = &located
                && request != "a"
            {
                assert_eq!(*kind, FsEntryKind::Symlink, "{request:?}");
            }

            let located = list_dir_at(&at, &rest, 100);
            let direct = list_dir_at(&root, request, 100);
            assert_eq!(outcome(&located), outcome(&direct), "나열 {request:?}");
            assert_eq!(list_class(&located), list_expect, "나열 {request:?}");
        }
    }

    /// `Dir` 의 검색·⌘P 순회 루트는 접두 없는 그 루트 하나다
    #[test]
    fn dir_roots_is_the_single_unprefixed_root() {
        let space = FsSpace::Dir(PathBuf::from("/r/root"));
        assert_eq!(
            space.roots(),
            vec![(String::new(), PathBuf::from("/r/root"))]
        );
    }

    /// 멤버 하나
    fn mount(alias: &str, path: &Path, state: MemberState) -> GroupMount {
        GroupMount {
            alias: alias.into(),
            path: path.to_path_buf(),
            state,
        }
    }

    /// 서로 다른 곳의 멤버 `api`(=`tmp/root`, 위 고정물)·`web`(=`tmp/other/web`)·`gone`(없음)·`plain`(저장소 아님)과
    /// 그 그룹 공간
    fn group_fixture() -> (tempfile::TempDir, PathBuf, PathBuf, FsSpace) {
        use crate::RepoKind::Standalone;
        let (dir, api) = fixture();
        let web = dir.path().join("other/web");
        write(&web.join("w.txt"), "MARK:web");
        let plain = dir.path().join("plain");
        write(&plain.join("p.txt"), "MARK:plain");
        let space = FsSpace::Group(vec![
            mount("api", &api, MemberState::Present(Standalone)),
            mount("web", &web, MemberState::Present(Standalone)),
            mount("gone", &dir.path().join("gone"), MemberState::Missing),
            mount("plain", &plain, MemberState::NotRepo),
        ]);
        (dir, api, web, space)
    }

    /// 그룹 `locate`: 빈 문자열은 맨 위, 별칭 단독은 그 멤버 루트, `별칭/나머지` 는 그 멤버 기준 나머지다. 전체를 먼저
    /// 어휘 검증하므로 `api/..`·`./api`·절대 경로·`.git`·빈 구성요소는 별칭을 고르기 전에 거부되고, 모르는 별칭·대소문자가
    /// 다른 별칭·저장소가 아니게 된 멤버도 거부한다. 없는 멤버는 그 루트로 넘겨 하류가 "없음"으로 답한다
    #[test]
    fn group_locate_splits_alias_after_lexical_validation() {
        let (dir, api, web, space) = group_fixture();
        let under = |request: &str| match space.locate(request).unwrap() {
            Located::Under { root, rest } => (root, rest),
            other => panic!("{request:?}: {other:?}"),
        };
        assert!(matches!(space.locate(""), Ok(Located::GroupTop(m)) if m.len() == 4));
        assert_eq!(under("api"), (api.clone(), String::new()));
        assert_eq!(under("api/a/b.txt"), (api.clone(), "a/b.txt".into()));
        assert_eq!(under("web/w.txt"), (web.clone(), "w.txt".into()));
        assert_eq!(under("gone/x"), (dir.path().join("gone"), "x".into()));
        let outside = dir.path().join("outside/secret.txt");
        for request in [
            "api/..",
            "api/../web/w.txt",
            "..",
            "../outside/secret.txt",
            "./api",
            "/api",
            outside.to_str().unwrap(),
            "api//a",
            "api/",
            ".git",
            "api/.git/config",
            "api/.GIT",
            "a\0b",
            "nope",
            "nope/x",
            "API/top.txt",
            "Api",
            "plain/p.txt",
            "plain",
        ] {
            assert!(
                matches!(space.locate(request), Err(CoreError::Invalid(_))),
                "{request:?}"
            );
        }
        // 맨 위는 파일·대상이 아니다
        let top = space.locate("").unwrap();
        assert!(matches!(top.into_under(""), Err(CoreError::Invalid(_))));
    }

    /// 그룹 공간을 거친 읽기·나열은 고른 멤버의 루트에서 기존 경로 해석을 그대로 거친다: 멤버 파일은 읽히고, 멤버 안의
    /// 링크 탈출·`.git` 은 여전히 거부되며, 없는 멤버는 "없음"이다
    #[test]
    fn group_reads_go_through_the_member_root_checks() {
        let (_dir, _api, _web, space) = group_fixture();
        let read = |request: &str| {
            let (root, rest) = space.locate(request)?.into_under(request)?;
            read_file_at(&root, &rest)
        };
        let list = |request: &str| {
            let (root, rest) = space.locate(request)?.into_under(request)?;
            list_dir_at(&root, &rest, 100)
        };
        assert!(matches!(read("api/top.txt"), Ok(FsFile::Text { text, .. }) if text == "MARK:top"));
        assert!(matches!(read("web/w.txt"), Ok(FsFile::Text { text, .. }) if text == "MARK:web"));
        assert_eq!(read_class(&read("gone/x")), Class::Missing);
        assert_eq!(list_class(&list("gone")), Class::Missing);
        assert_eq!(list_class(&list("api")), Class::Listed);
        assert_eq!(read_class(&read("api")), Class::Rejected);
        #[cfg(unix)]
        {
            assert_eq!(read_class(&read("api/out-dir/secret.txt")), Class::Rejected);
            assert_eq!(list_class(&list("api/out-dir")), Class::Rejected);
            assert_eq!(read_class(&read("api/out-file")), Class::Unsupported);
        }
    }

    /// 그룹의 검색·⌘P 순회 루트는 있는 멤버마다 (별칭, 루트)다 — 없는·저장소 아닌 멤버는 빠진다
    #[test]
    fn group_roots_are_present_members_with_alias_prefixes() {
        let (_dir, api, web, space) = group_fixture();
        assert_eq!(
            space.roots(),
            vec![("api".into(), api), ("web".into(), web)]
        );
    }

    /// FS-02·05 불변식 (그룹): 어떤 요청이든 그룹 공간을 거쳐 읽힌 본문·나열 이름은 고른 멤버 루트 안의 것뿐이다 —
    /// 루트 밖·`.git`·저장소 아닌 멤버의 내용이 없다
    #[test]
    fn group_requests_never_escape_member_roots() {
        use proptest::prelude::*;
        use proptest::test_runner::{Config, TestRunner};
        let (_dir, _api, _web, space) = group_fixture();
        let part = proptest::sample::select(vec![
            "api",
            "web",
            "gone",
            "plain",
            "API",
            "a",
            "b.txt",
            "top.txt",
            "w.txt",
            "p.txt",
            ".git",
            "config",
            "..",
            ".",
            "",
            "out-dir",
            "out-file",
            "in-file",
            "secret.txt",
            "\0",
        ]);
        let strategy = prop_oneof![
            proptest::collection::vec(part.clone(), 0..5).prop_map(|p| p.join("/")),
            proptest::collection::vec(part, 0..5).prop_map(|p| format!("/{}", p.join("/"))),
            "\\PC{0,24}",
        ];
        let mut runner = TestRunner::new(Config {
            cases: 512,
            failure_persistence: None,
            ..Config::default()
        });
        runner
            .run(&strategy, |request| {
                let Ok(located) = space.locate(&request) else {
                    return Ok(());
                };
                match located {
                    Located::GroupTop(_) => prop_assert!(request.is_empty()),
                    Located::Under { root, rest } => {
                        if let Ok(FsFile::Text { text, .. }) = read_file_at(&root, &rest) {
                            prop_assert!(text.starts_with("MARK:"), "{request:?}: {text}");
                            prop_assert!(text != "MARK:plain", "{request:?}");
                        }
                        if let Ok(FsListing::Listed { entries, .. }) =
                            list_dir_at(&root, &rest, 100)
                        {
                            for e in entries {
                                prop_assert!(e.name != ".git" && e.name != "secret.txt");
                                prop_assert!(e.name != "p.txt", "{request:?}");
                            }
                        }
                    }
                }
                Ok(())
            })
            .unwrap();
    }
}
