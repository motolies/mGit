//! 파일 트리·파일 보기 API (W10: FS-01~10). 폴더 세션 루트와 저장소 세션 루트에 같은 표준 트리를 깔고
//! 같은 상대 경로로 부른다 — 두 루트에서 결과가 같아야 하고, 어느 쪽이든 루트 밖·`.git` 안·링크 너머를
//! 읽을 수 없어야 한다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use common::{collector, core, wait_finished};
use mgit_core::{
    Core, CoreError, FS_LIST_DEFAULT_LIMIT, FS_READ_MAX_BYTES, FsEntryKind, FsFile, FsListing,
    SessionId,
};
use mgit_testkit::TestRepo;

/// 루트 밖 파일의 표식
const OUTSIDE_SECRET: &str = "SECRET-OUTSIDE";
/// `.git` 안 파일의 표식
const DOTGIT_SECRET: &str = "SECRET-DOTGIT";
/// 루트 안에서 정상으로 읽히는 파일 (본문 = `MARK:<상대 경로>`)
const MARKED: &[&str] = &[
    "README.md",
    "alpha.txt",
    "Beta.txt",
    "emoji-😀.txt",
    ".claude/settings.json",
    "src/main.rs",
    "src/한글 이름.txt",
    "docs/space name.md",
    "deep/a/b/c/d.txt",
    "nested/inner.txt",
    "wt/file.txt",
];

/// 루트 하나 (폴더 세션 또는 저장소 세션)
struct Root {
    label: &'static str,
    core: Core,
    session: SessionId,
    /// 테스트가 만든 루트 경로 (정규화하지 않음: macOS 는 `/var` → `/private/var` 링크를 거친다)
    path: PathBuf,
    /// 루트 밖 디렉터리
    outside: PathBuf,
    _keep: Keep,
}

/// 루트가 사는 동안 임시 디렉터리를 붙잡아 둔다
#[allow(dead_code)]
enum Keep {
    Temp(tempfile::TempDir),
    Repo(TestRepo),
}

/// 부모 디렉터리까지 만들고 파일을 쓴다
fn write(path: &Path, body: impl AsRef<[u8]>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

/// 빈 저장소를 만든다
fn init_at(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    TestRepo::at(path).git_ok(["init", "-q", "-b", "main"]);
}

/// 표준 트리를 `base` 에 깐다. `.git` 안(진짜 저장소든 가짜든)과 중첩 저장소의 `.git`, 워크트리식
/// gitfile, 내용 종류별 파일, 루트 밖 비밀, (unix) 링크
fn populate(base: &Path, outside: &Path) {
    for rel in MARKED {
        if !rel.starts_with("nested/") {
            write(&base.join(rel), format!("MARK:{rel}\n"));
        }
    }
    write(&base.join(".git/mgit-marker"), DOTGIT_SECRET);
    init_at(&base.join("nested"));
    write(&base.join("nested/inner.txt"), "MARK:nested/inner.txt\n");
    write(&base.join("nested/.git/mgit-marker"), DOTGIT_SECRET);
    write(&base.join("wt/.git"), "gitdir: ../nested/.git\n");
    // 내용 종류 (FS-08)
    let mut nul_after_probe = vec![b'a'; 8_000];
    nul_after_probe.push(0);
    write(
        &base.join("kinds/binary.bin"),
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
    );
    write(&base.join("kinds/nul-after-probe.txt"), nul_after_probe);
    write(&base.join("kinds/latin1.txt"), b"caf\xe9\n");
    write(&base.join("kinds/bom.txt"), "\u{feff}안녕\n");
    write(&base.join("kinds/empty.txt"), "");
    write(&base.join("kinds/crlf.txt"), "a\r\nb\r\n");
    write(&outside.join("secret.txt"), OUTSIDE_SECRET);
    write(&outside.join("sub/x.txt"), OUTSIDE_SECRET);
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(outside.join("secret.txt"), base.join("link-out-file")).unwrap();
        symlink(outside, base.join("link-out-dir")).unwrap();
        symlink("README.md", base.join("link-in-file")).unwrap();
        symlink("src", base.join("link-in-dir")).unwrap();
        symlink("nowhere", base.join("link-broken")).unwrap();
    }
}

/// 폴더 세션 루트: `tmp/folder` 에 표준 트리(루트의 `.git` 은 가짜 디렉터리, 저장소는 `nested`·`wt`)
async fn folder_root() -> Root {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("folder");
    let outside = dir.path().join("outside");
    populate(&base, &outside);
    let core = core().await;
    let (sink, _rx) = collector();
    let session = core.open_folder(&base, sink).await.unwrap().session;
    Root {
        label: "폴더 세션",
        core,
        session,
        path: base,
        outside,
        _keep: Keep::Temp(dir),
    }
}

/// 저장소 세션 루트: 커밋 하나 있는 저장소의 작업 트리에 표준 트리 (그래프 로드가 끝날 때까지 기다린다)
async fn repo_root() -> Root {
    let mut repo = TestRepo::init();
    let base = repo.path().to_path_buf();
    let outside = base.parent().unwrap().join("outside");
    populate(&base, &outside);
    repo.git_ok(["add", "README.md", "src"]);
    repo.commit_staged("init");
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(&base, sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    Root {
        label: "저장소 세션",
        core,
        session,
        path: base,
        outside,
        _keep: Keep::Repo(repo),
    }
}

/// 두 루트
async fn roots() -> [Root; 2] {
    [folder_root().await, repo_root().await]
}

/// 나열 (기본 상한)
async fn list(root: &Root, dir: &str) -> Result<FsListing, CoreError> {
    root.core.fs_list_dir(root.session, dir, None).await
}

/// 읽기
async fn read(root: &Root, path: &str) -> Result<FsFile, CoreError> {
    root.core.fs_read_file(root.session, path).await
}

/// 나열 결과의 이름들. 나열이 아니면 panic
fn names(listing: &FsListing) -> Vec<String> {
    match listing {
        FsListing::Listed { entries, .. } => entries.iter().map(|e| e.name.clone()).collect(),
        other => panic!("나열이 아니다: {other:?}"),
    }
}

/// 텍스트 본문. 텍스트가 아니면 panic
fn text(file: FsFile) -> String {
    match file {
        FsFile::Text { text, .. } => text,
        other => panic!("텍스트가 아니다: {other:?}"),
    }
}

/// 거부(`Invalid`)인지 확인하고 문구를 돌려준다
fn rejection<T: std::fmt::Debug>(result: Result<T, CoreError>, what: &str) -> String {
    match result {
        Err(CoreError::Invalid(message)) => message,
        other => panic!("{what}: 거부여야 한다 — {other:?}"),
    }
}

/// FS-01: 모르는 세션은 `SessionNotFound`, 닫은 세션도 같다
#[tokio::test]
async fn fs01_unknown_or_closed_session_is_not_found() {
    let root = folder_root().await;
    let unknown = SessionId(u32::MAX - 7);
    assert!(matches!(
        root.core.fs_list_dir(unknown, "", None).await,
        Err(CoreError::SessionNotFound(s)) if s == unknown
    ));
    assert!(matches!(
        root.core.fs_read_file(unknown, "README.md").await,
        Err(CoreError::SessionNotFound(_))
    ));
    root.core.close_folder(root.session).unwrap();
    assert!(matches!(
        list(&root, "").await,
        Err(CoreError::SessionNotFound(_))
    ));
}

/// FS-01: 루트는 세션 종류로 정한다 — 폴더 세션은 폴더, 저장소 세션은 작업 트리(하위 폴더로 열어도
/// 최상위). 두 세션은 한 코어에서 id 공간을 공유하므로 id 만으로 서로 다른 루트를 고른다.
/// 같은 표준 트리를 깐 두 루트의 나열은 같다
#[tokio::test]
async fn fs01_root_comes_from_the_session_kind() {
    let [folder, repo] = roots().await;
    assert_eq!(
        names(&list(&folder, "").await.unwrap()),
        names(&list(&repo, "").await.unwrap())
    );
    // 저장소 세션: 하위 폴더로 열어도 같은 세션, 루트는 작업 트리 최상위다
    let (sink, _rx) = collector();
    let again = repo
        .core
        .open_repo(&repo.path.join("src"), sink)
        .await
        .unwrap();
    assert_eq!(again.session, repo.session);
    assert!(names(&list(&repo, "").await.unwrap()).contains(&"README.md".to_string()));
    // 한 코어에 폴더 세션과 그 안 저장소의 저장소 세션: id 가 다르고 루트도 다르다
    let (sink, _rx) = collector();
    let nested = folder
        .core
        .open_repo(&folder.path.join("nested"), sink)
        .await
        .unwrap()
        .session;
    assert_ne!(nested, folder.session);
    assert_eq!(
        names(&folder.core.fs_list_dir(nested, "", None).await.unwrap()),
        ["inner.txt"]
    );
    assert!(names(&list(&folder, "").await.unwrap()).contains(&"nested".to_string()));
    assert_eq!(
        text(folder.core.fs_read_file(nested, "inner.txt").await.unwrap()),
        "MARK:nested/inner.txt\n"
    );
}

/// FS-02: 어휘 검증 표 (두 루트, 나열·읽기). 거부 문구에 루트의 절대 경로가 없다
#[tokio::test]
async fn fs02_lexical_rejections() {
    for root in roots().await {
        let absolute = root.path.join("README.md").display().to_string();
        let long_path = ["abc"; 1_100].join("/");
        let long_part = "x".repeat(256);
        let cases: Vec<&str> = vec![
            "/etc/passwd",
            "/",
            "//server/share",
            "..",
            "../outside/secret.txt",
            "src/../README.md",
            "src/..",
            ".",
            "./README.md",
            "src/./main.rs",
            "a\0b",
            "\0",
            "src//main.rs",
            "src/",
            &long_path,
            &long_part,
        ];
        let canon = root.path.canonicalize().unwrap();
        for case in &cases {
            let shown = &case[..case.len().min(30)];
            let message = rejection(
                read(&root, case).await,
                &format!("{} 읽기 {shown:?}", root.label),
            );
            assert!(
                !message.contains(&*root.path.to_string_lossy()),
                "{message}"
            );
            assert!(!message.contains(&*canon.to_string_lossy()), "{message}");
            rejection(
                list(&root, case).await,
                &format!("{} 나열 {shown:?}", root.label),
            );
        }
        // 빈 문자열: 나열은 루트, 읽기는 거부
        rejection(read(&root, "").await, "빈 경로 읽기");
        assert!(matches!(
            list(&root, "").await,
            Ok(FsListing::Listed { .. })
        ));
        // 절대 경로는 루트 안을 가리켜도 거부한다 (문구에는 요청한 그대로만 있다)
        rejection(read(&root, &absolute).await, "루트 안의 절대 경로");
        rejection(
            list(&root, &root.path.display().to_string()).await,
            "루트 자신의 절대 경로",
        );
    }
}

/// FS-02 (unix): 역슬래시는 구분자가 아니라 이름의 일부다 — 그 이름으로 나열되고 그대로 다시 읽힌다
#[cfg(unix)]
#[tokio::test]
async fn fs02_backslash_is_part_of_a_name_on_unix() {
    for root in roots().await {
        write(&root.path.join("back\\slash.txt"), "MARK:back\\slash.txt\n");
        assert!(names(&list(&root, "").await.unwrap()).contains(&"back\\slash.txt".to_string()));
        assert_eq!(
            text(read(&root, "back\\slash.txt").await.unwrap()),
            "MARK:back\\slash.txt\n"
        );
        // `src\main.rs` 는 `src/main.rs` 가 아니다
        assert_eq!(read(&root, "src\\main.rs").await.unwrap(), FsFile::Missing);
    }
}

/// FS-02·05 불변식 (proptest): 어떤 요청이든 읽어 온 본문은 루트 안 파일의 것이고(`MARK:`), 나열에는
/// `.git` 과 루트 밖·`.git` 안에만 있는 이름이 없다. 두 루트 모두
#[test]
fn fs02_any_request_stays_inside_the_root() {
    use proptest::prelude::*;
    use proptest::test_runner::{Config, TestRunner};

    let rt = tokio::runtime::Runtime::new().unwrap();
    let roots = rt.block_on(roots());
    let part = proptest::sample::select(vec![
        "README.md",
        "src",
        "main.rs",
        "nested",
        "inner.txt",
        "wt",
        "file.txt",
        ".git",
        ".GIT",
        "mgit-marker",
        "HEAD",
        "config",
        "link-out-file",
        "link-out-dir",
        "link-in-dir",
        "link-in-file",
        "secret.txt",
        "sub",
        "x.txt",
        "..",
        ".",
        "",
        "\0",
    ]);
    let joined = proptest::collection::vec(part, 0..5)
        .prop_map(|parts| parts.join("/"))
        .boxed();
    let strategy = prop_oneof![
        joined.clone(),
        joined.prop_map(|p| format!("/{p}")),
        "\\PC{0,16}",
    ];
    /// 루트 밖·`.git` 안에만 있는 이름
    const FORBIDDEN: &[&str] = &[
        "secret.txt",
        "sub",
        "x.txt",
        "mgit-marker",
        "HEAD",
        "config",
    ];
    let mut runner = TestRunner::new(Config {
        cases: 256,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&strategy, |request| {
            for root in &roots {
                if let Ok(FsFile::Text { text, .. }) = rt.block_on(read(root, &request)) {
                    prop_assert!(text.starts_with("MARK:"), "{request:?} → {text:?}");
                    prop_assert!(!text.contains("SECRET"), "{request:?}");
                }
                if let Ok(FsListing::Listed { entries, .. }) = rt.block_on(list(root, &request)) {
                    for e in entries {
                        prop_assert!(!e.name.eq_ignore_ascii_case(".git"), "{request:?}");
                        prop_assert!(
                            !FORBIDDEN.contains(&e.name.as_str()),
                            "{request:?} → {}",
                            e.name
                        );
                    }
                }
            }
            Ok(())
        })
        .unwrap();
}

/// FS-03: `.git` 디렉터리·gitfile 은 나열에 없고 `total` 에도 세지 않는다. `.git`(대소문자 무시)이
/// 들어간 경로는 나열·읽기 모두 거부한다 — 루트의 것, 중첩 저장소의 것, gitfile 모두
#[tokio::test]
async fn fs03_dot_git_is_hidden_and_refused() {
    for root in roots().await {
        for dir in ["", "nested", "wt"] {
            let listing = list(&root, dir).await.unwrap();
            let FsListing::Listed { entries, total, .. } = &listing else {
                panic!("나열이 아니다");
            };
            assert!(
                entries.iter().all(|e| !e.name.eq_ignore_ascii_case(".git")),
                "{} {dir:?}",
                root.label
            );
            assert_eq!(*total as usize, entries.len());
        }
        assert_eq!(names(&list(&root, "wt").await.unwrap()), ["file.txt"]);
        for path in [
            ".git",
            ".GIT",
            ".git/HEAD",
            ".git/mgit-marker",
            ".GIT/config",
            ".Git/mgit-marker",
            "nested/.git/config",
            "nested/.Git/HEAD",
            "nested/.git/mgit-marker",
            "wt/.git",
        ] {
            let message = rejection(
                read(&root, path).await,
                &format!("{} 읽기 {path}", root.label),
            );
            assert!(!message.contains(DOTGIT_SECRET));
            rejection(
                list(&root, path).await,
                &format!("{} 나열 {path}", root.label),
            );
        }
    }
}

/// FS-04 (unix): 링크는 나열에 "링크"로만 나오고(열 수 없음, 크기 없음), 끝이 링크인 읽기는 "지원 안 함",
/// 링크 나열과 링크를 거치는 경로는 거부한다. 루트 안·밖을 가리키는 링크, 깨진 링크 모두 같다.
/// 대상의 내용은 결과 어디에도 없다
#[cfg(unix)]
#[tokio::test]
async fn fs04_symlinks_are_listed_but_never_followed() {
    for root in roots().await {
        let listing = list(&root, "").await.unwrap();
        let FsListing::Listed { entries, .. } = &listing else {
            panic!("나열이 아니다");
        };
        let links: Vec<_> = entries
            .iter()
            .filter(|e| e.name.starts_with("link-"))
            .collect();
        assert_eq!(links.len(), 5, "{}", root.label);
        for e in &links {
            assert_eq!(e.kind, FsEntryKind::Symlink, "{}", e.name);
            assert!(!e.openable && e.size.is_none(), "{}", e.name);
        }
        let mut seen = format!("{listing:?}");
        for link in [
            "link-out-file",
            "link-in-file",
            "link-broken",
            "link-out-dir",
            "link-in-dir",
        ] {
            let got = read(&root, link).await.unwrap();
            assert_eq!(
                got,
                FsFile::Unsupported {
                    kind: FsEntryKind::Symlink
                },
                "{link}"
            );
            seen.push_str(&format!("{got:?}"));
            seen.push_str(&rejection(list(&root, link).await, &format!("나열 {link}")));
        }
        for path in [
            "link-out-dir/secret.txt",
            "link-out-dir/sub",
            "link-out-dir/sub/x.txt",
            "link-in-dir/main.rs",
        ] {
            seen.push_str(&rejection(read(&root, path).await, &format!("읽기 {path}")));
            seen.push_str(&rejection(list(&root, path).await, &format!("나열 {path}")));
        }
        assert!(!seen.contains(OUTSIDE_SECRET), "{}", root.label);
        assert!(!seen.contains(&*root.outside.to_string_lossy()));
    }
}

/// FS-05: 루트가 링크를 거친 경로(macOS 임시 디렉터리 `/var` → `/private/var`, 일부러 만든 별칭)여도
/// 정상 동작한다. 대소문자를 무시하는 파일 시스템이면 `Src`·`readme.md` 도 같은 파일로 풀리고, 구분하면
/// 없음이다. `.GIT` 은 어느 쪽이든 거부, HFS+ 가 무시하는 문자를 끼운 `.g‌it` 도 `.git` 의 내용을 주지 않는다
#[tokio::test]
async fn fs05_canonical_root_and_case_handling() {
    let root = folder_root().await;
    // 별칭 링크로 연 폴더: 세션은 정규화한 경로로 열리고 나열이 같다
    #[cfg(unix)]
    {
        let alias = root.path.parent().unwrap().join("alias");
        std::os::unix::fs::symlink(&root.path, &alias).unwrap();
        let core = core().await;
        let (sink, _rx) = collector();
        let session = core.open_folder(&alias, sink).await.unwrap().session;
        assert_eq!(
            names(&core.fs_list_dir(session, "", None).await.unwrap()),
            names(&list(&root, "").await.unwrap())
        );
        assert_eq!(
            text(core.fs_read_file(session, "src/main.rs").await.unwrap()),
            "MARK:src/main.rs\n"
        );
    }
    for root in [root, repo_root().await] {
        let insensitive = root.path.join("readme.md").exists();
        eprintln!(
            "{}: 대소문자 {}",
            root.label,
            if insensitive { "무시" } else { "구분" }
        );
        if insensitive {
            assert_eq!(
                text(read(&root, "readme.md").await.unwrap()),
                "MARK:README.md\n"
            );
            assert!(names(&list(&root, "SRC").await.unwrap()).contains(&"main.rs".to_string()));
        } else {
            assert_eq!(read(&root, "readme.md").await.unwrap(), FsFile::Missing);
            assert_eq!(list(&root, "SRC").await.unwrap(), FsListing::Missing);
        }
        rejection(read(&root, ".GIT/mgit-marker").await, ".GIT");
        rejection(list(&root, "NESTED/.GIT").await, "NESTED/.GIT");
        // U+200C(ZWNJ)는 HFS+ 가 이름 비교에서 무시하는 문자다. 어느 파일 시스템이든 `.git` 의 내용은 안 나온다
        let variant = ".g\u{200C}it/mgit-marker";
        match read(&root, variant).await {
            Ok(FsFile::Missing) | Err(CoreError::Invalid(_)) => {}
            other => panic!("{}: {variant:?} → {other:?}", root.label),
        }
    }
}

/// FS-06 (unix): `mkfifo` 로 만든 FIFO 를 읽어도 멈추지 않고 "지원 안 함"(시간 상한 5초). 디렉터리·소켓도
/// "지원 안 함"이고 나열에는 그 밖(FIFO·소켓)·디렉터리로 나온다
#[cfg(unix)]
#[tokio::test]
async fn fs06_only_regular_files_are_read() {
    for root in roots().await {
        let fifo = root.path.join("pipe");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let limit = std::time::Duration::from_secs(5);
        let got = tokio::time::timeout(limit, read(&root, "pipe")).await;
        let Ok(got) = got else {
            // 막혔다면 쓰는 쪽을 열어 풀어 주고 실패시킨다
            let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
            panic!("{}: FIFO 읽기가 멈췄다", root.label);
        };
        assert_eq!(
            got.unwrap(),
            FsFile::Unsupported {
                kind: FsEntryKind::Other
            }
        );
        assert_eq!(
            read(&root, "src").await.unwrap(),
            FsFile::Unsupported {
                kind: FsEntryKind::Dir
            }
        );
        let socket = std::os::unix::net::UnixListener::bind(root.path.join("sock"));
        if socket.is_ok() {
            assert_eq!(
                read(&root, "sock").await.unwrap(),
                FsFile::Unsupported {
                    kind: FsEntryKind::Other
                }
            );
        } else {
            eprintln!("{}: 소켓 경로가 길어 소켓 확인은 건너뛴다", root.label);
        }
        let FsListing::Listed { entries, .. } = list(&root, "").await.unwrap() else {
            panic!("나열이 아니다");
        };
        let kind_of = |name: &str| {
            entries
                .iter()
                .find(|e| e.name == name)
                .map(|e| (e.kind, e.openable))
        };
        assert_eq!(kind_of("pipe"), Some((FsEntryKind::Other, false)));
        assert_eq!(kind_of("src"), Some((FsEntryKind::Dir, false)));
        assert_eq!(kind_of("README.md"), Some((FsEntryKind::File, true)));
    }
}

/// FS-07: 크기 상한 경계 — 상한−1·상한은 본문이 있고, 상한+1·그 이상은 본문 없이 "너무 큼"과 실제 크기
#[tokio::test]
async fn fs07_size_limit_boundaries() {
    let max = FS_READ_MAX_BYTES as usize;
    for root in roots().await {
        for (name, len) in [
            ("under", max - 1),
            ("at", max),
            ("over", max + 1),
            ("huge", 3 * max),
        ] {
            write(&root.path.join("big").join(name), vec![b'a'; len]);
        }
        assert_eq!(text(read(&root, "big/under").await.unwrap()).len(), max - 1);
        assert_eq!(text(read(&root, "big/at").await.unwrap()).len(), max);
        for (name, len) in [("over", max + 1), ("huge", 3 * max)] {
            assert_eq!(
                read(&root, &format!("big/{name}")).await.unwrap(),
                FsFile::TooLarge {
                    size: len as u64,
                    limit: FS_READ_MAX_BYTES
                },
                "{}",
                root.label
            );
        }
        // 나열의 크기는 실제 크기다
        let FsListing::Listed { entries, .. } = list(&root, "big").await.unwrap() else {
            panic!("나열이 아니다");
        };
        let huge = entries.iter().find(|e| e.name == "huge").unwrap();
        assert_eq!(huge.size, Some(3 * FS_READ_MAX_BYTES));
    }
}

/// FS-08: 앞 8,000 바이트 안의 NUL 은 바이너리, 밖이면 텍스트. 잘못된 UTF-8 은 본문 없이 "UTF-8 아님".
/// BOM·CRLF 는 그대로, 빈 파일은 빈 텍스트
#[tokio::test]
async fn fs08_content_kinds() {
    for root in roots().await {
        assert!(matches!(
            read(&root, "kinds/binary.bin").await.unwrap(),
            FsFile::Binary { size: 16 }
        ));
        assert!(text(read(&root, "kinds/nul-after-probe.txt").await.unwrap()).ends_with('\0'));
        assert_eq!(
            read(&root, "kinds/latin1.txt").await.unwrap(),
            FsFile::NotUtf8 { size: 5 }
        );
        assert_eq!(
            text(read(&root, "kinds/bom.txt").await.unwrap()),
            "\u{feff}안녕\n"
        );
        assert_eq!(text(read(&root, "kinds/empty.txt").await.unwrap()), "");
        assert_eq!(
            read(&root, "kinds/crlf.txt").await.unwrap(),
            FsFile::Text {
                text: "a\r\nb\r\n".into(),
                size: 6
            }
        );
    }
}

/// FS-09: 항목 수 상한 — 정확히 상한이면 다 주고, 넘으면 앞에서 상한까지만 주고 `truncated`·`total`.
/// 정렬은 자르기 전에 한다(디렉터리가 이름과 무관하게 맨 앞). 상한을 올려 다시 부르면 나머지도 온다.
/// 상한은 1~최댓값으로 맞춘다
#[tokio::test]
async fn fs09_entry_limit_and_truncation() {
    let limit = FS_LIST_DEFAULT_LIMIT as usize;
    for root in roots().await {
        let exact = root.path.join("exact");
        let many = root.path.join("many");
        std::fs::create_dir_all(&exact).unwrap();
        std::fs::create_dir_all(many.join("zz-dir")).unwrap();
        for i in 0..limit {
            std::fs::write(exact.join(format!("f{i:04}")), "").unwrap();
            std::fs::write(many.join(format!("f{i:04}")), "").unwrap();
        }
        let FsListing::Listed {
            entries,
            total,
            truncated,
            ..
        } = list(&root, "exact").await.unwrap()
        else {
            panic!("나열이 아니다");
        };
        assert_eq!(
            (entries.len(), total, truncated),
            (limit, limit as u32, false)
        );

        let FsListing::Listed {
            entries,
            total,
            truncated,
            ..
        } = list(&root, "many").await.unwrap()
        else {
            panic!("나열이 아니다");
        };
        assert_eq!(
            (entries.len(), total, truncated),
            (limit, limit as u32 + 1, true)
        );
        assert_eq!(entries[0].name, "zz-dir");
        assert_eq!(entries[1].name, "f0000");
        assert_eq!(entries[limit - 1].name, format!("f{:04}", limit - 2));

        let more = root
            .core
            .fs_list_dir(root.session, "many", Some(limit as u32 + 1))
            .await
            .unwrap();
        let FsListing::Listed {
            entries, truncated, ..
        } = more
        else {
            panic!("나열이 아니다");
        };
        assert_eq!((entries.len(), truncated), (limit + 1, false));
        assert_eq!(entries[limit].name, format!("f{:04}", limit - 1));

        // 0 은 1 로, 아주 큰 값은 최댓값으로 맞춘다 (2,001 개는 모두 들어간다)
        let one = root
            .core
            .fs_list_dir(root.session, "many", Some(0))
            .await
            .unwrap();
        assert_eq!(names(&one), ["zz-dir"]);
        let all = root
            .core
            .fs_list_dir(root.session, "many", Some(u32::MAX))
            .await
            .unwrap();
        assert_eq!(names(&all).len(), limit + 1);
    }
}

/// 디렉터리 아래 전부(링크는 따라가지 않음)의 (상대 경로, 크기, 수정 시각)
fn snapshot(dir: &Path) -> Vec<(PathBuf, u64, Option<SystemTime>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(at) = stack.pop() {
        let meta = std::fs::symlink_metadata(&at).unwrap();
        out.push((
            at.strip_prefix(dir).unwrap().to_path_buf(),
            meta.len(),
            meta.modified().ok(),
        ));
        if meta.is_dir() {
            for entry in std::fs::read_dir(&at).unwrap() {
                stack.push(entry.unwrap().path());
            }
        }
    }
    out.sort();
    out
}

/// FS-10: 나열·읽기를 여러 번(거부·없음 포함) 불러도 git 명령이 하나도 실행되지 않고, 루트·루트 밖의
/// 파일과 디렉터리(`.git` 포함)의 목록·크기·수정 시각이 그대로다
#[tokio::test]
async fn fs10_no_git_and_no_writes() {
    for root in roots().await {
        let tmp = root.path.parent().unwrap();
        let before_cmds = root.core.command_log_recent(usize::MAX).len();
        let before = snapshot(tmp);
        for _ in 0..3 {
            for dir in [
                "",
                "src",
                "nested",
                "wt",
                "kinds",
                "deep/a/b/c",
                "gone",
                "../x",
                ".git",
            ] {
                let _ = list(&root, dir).await;
            }
            for path in MARKED {
                text(read(&root, path).await.unwrap());
            }
            for path in [
                "kinds/binary.bin",
                "kinds/latin1.txt",
                "gone.txt",
                ".git/HEAD",
                "../x",
            ] {
                let _ = read(&root, path).await;
            }
        }
        assert_eq!(
            root.core.command_log_recent(usize::MAX).len(),
            before_cmds,
            "{}",
            root.label
        );
        assert_eq!(snapshot(tmp), before, "{}", root.label);
    }
}

/// 없음: 지워진 파일·디렉터리, 디렉터리가 아닌 것을 나열, 경로 중간이 파일. 나열 뒤 지운 파일도 없음
#[tokio::test]
async fn missing_paths_are_a_state_not_an_error() {
    for root in roots().await {
        assert_eq!(read(&root, "gone.txt").await.unwrap(), FsFile::Missing);
        assert_eq!(read(&root, "gone/x.txt").await.unwrap(), FsFile::Missing);
        assert_eq!(read(&root, "README.md/x").await.unwrap(), FsFile::Missing);
        assert_eq!(list(&root, "gone").await.unwrap(), FsListing::Missing);
        assert_eq!(list(&root, "README.md").await.unwrap(), FsListing::Missing);
        assert_eq!(
            list(&root, "src/main.rs/x").await.unwrap(),
            FsListing::Missing
        );
        assert!(names(&list(&root, "deep/a/b/c").await.unwrap()).contains(&"d.txt".to_string()));
        std::fs::remove_file(root.path.join("deep/a/b/c/d.txt")).unwrap();
        assert_eq!(
            read(&root, "deep/a/b/c/d.txt").await.unwrap(),
            FsFile::Missing
        );
        std::fs::remove_dir_all(root.path.join("deep/a")).unwrap();
        assert_eq!(list(&root, "deep/a/b").await.unwrap(), FsListing::Missing);
    }
}

/// 권한을 되돌려 놓는다 (임시 디렉터리를 지울 수 있게)
#[cfg(unix)]
struct RestoreMode(Vec<(PathBuf, u32)>);

#[cfg(unix)]
impl Drop for RestoreMode {
    /// 바꿨던 권한을 원래대로
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        for (path, mode) in &self.0 {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(*mode));
        }
    }
}

/// 권한 없음 (unix): 읽을 수 없는 디렉터리의 나열과 그 안의 읽기, 읽을 수 없는 파일은 "권한 없음" 상태다.
/// root 로 돌면(권한을 무시하므로) 건너뛴다
#[cfg(unix)]
#[tokio::test]
async fn denied_paths_are_a_state_not_an_error() {
    use std::os::unix::fs::PermissionsExt;
    for root in roots().await {
        let locked = root.path.join("locked");
        let file = root.path.join("private.txt");
        write(&locked.join("x.txt"), "MARK:locked/x.txt\n");
        write(&file, "MARK:private.txt\n");
        let _restore = RestoreMode(vec![(locked.clone(), 0o755), (file.clone(), 0o644)]);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&locked).is_ok() {
            eprintln!("권한을 무시하는 사용자(root)로 돌아 건너뛴다");
            return;
        }
        assert_eq!(list(&root, "locked").await.unwrap(), FsListing::Denied);
        assert_eq!(read(&root, "locked/x.txt").await.unwrap(), FsFile::Denied);
        assert_eq!(read(&root, "private.txt").await.unwrap(), FsFile::Denied);
        // 나열에는 그대로 나온다
        assert!(names(&list(&root, "").await.unwrap()).contains(&"locked".to_string()));
    }
}

/// 이름·정렬·메타데이터: 한글·공백·이모지 이름이 그대로 나오고 다시 읽힌다. 루트 나열은 디렉터리 먼저,
/// 대소문자 무시 이름순이다(PT-01). 파일은 크기·수정 시각, 디렉터리는 수정 시각만 있다
#[tokio::test]
async fn names_order_and_metadata() {
    for root in roots().await {
        let got = names(&list(&root, "").await.unwrap());
        let mut want = vec![
            ".claude",
            "deep",
            "docs",
            "kinds",
            "nested",
            "src",
            "wt",
            "alpha.txt",
            "Beta.txt",
            "emoji-😀.txt",
        ];
        #[cfg(unix)]
        want.extend([
            "link-broken",
            "link-in-dir",
            "link-in-file",
            "link-out-dir",
            "link-out-file",
        ]);
        want.push("README.md");
        assert_eq!(got, want, "{}", root.label);
        assert_eq!(
            names(&list(&root, "src").await.unwrap()),
            ["main.rs", "한글 이름.txt"]
        );
        for path in ["src/한글 이름.txt", "docs/space name.md", "emoji-😀.txt"] {
            assert_eq!(
                text(read(&root, path).await.unwrap()),
                format!("MARK:{path}\n")
            );
        }
        let FsListing::Listed { entries, .. } = list(&root, "").await.unwrap() else {
            panic!("나열이 아니다");
        };
        let readme = entries.iter().find(|e| e.name == "README.md").unwrap();
        assert_eq!(readme.size, Some("MARK:README.md\n".len() as u64));
        assert!(readme.openable);
        // 2020-01-01 이후 (방금 만든 파일)
        assert!(readme.mtime_ms.unwrap() > 1_577_836_800_000);
        let src = entries.iter().find(|e| e.name == "src").unwrap();
        assert_eq!(
            (src.kind, src.size, src.openable),
            (FsEntryKind::Dir, None, false)
        );
        assert!(src.mtime_ms.is_some());
    }
}

/// 이미지 조회도 저장소·폴더 세션의 루트만 사용하고 닫힌 세션을 거부한다.
#[tokio::test]
async fn images_use_repo_and_folder_session_roots() {
    for root in roots().await {
        write(&root.path.join("docs/한글 그림.svg"), "<svg/>");
        assert!(matches!(
            root.core
                .fs_read_image(root.session, "docs/한글 그림.svg")
                .await
                .unwrap(),
            mgit_core::FsImage::Image { size: 6, .. }
        ));
        assert!(matches!(
            root.core
                .fs_read_image(root.session, ".git/mgit-marker")
                .await,
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            root.core
                .fs_read_image(SessionId(u32::MAX), "docs/한글 그림.svg")
                .await,
            Err(CoreError::SessionNotFound(_))
        ));
    }
}
