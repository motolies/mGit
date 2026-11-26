//! 일반 파일 편집의 바이트 보존·경합·경계·인덱스 불변식을 검증한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, wait_finished};
use mgit_core::{
    FsEditableFile, FsEncoding, FsFile, FsLineEnding, FsLineEndingCounts, FsSaveResult,
};
use mgit_testkit::TestRepo;

/// 편집 조회에서 revision과 파일 키를 꺼낸다.
fn editable(file: FsEditableFile) -> (String, String, String) {
    let FsEditableFile::Text {
        revision,
        file_key,
        text,
        ..
    } = file
    else {
        panic!("편집 가능한 텍스트여야 한다: {file:?}");
    };
    (revision, file_key, text)
}

/// BOM·줄 끝·마지막 개행·한글·이모지를 그대로 저장하고 인덱스와 권한을 유지한다.
#[tokio::test]
async fn saves_exact_bytes_without_changing_index() {
    let mut repo = TestRepo::init();
    repo.write_file("a.txt", "original\n");
    repo.commit("initial");
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let index = std::fs::read(repo.path().join(".git/index")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            repo.path().join("a.txt"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    for text in [
        "\u{feff}한글😀\r\n끝\r\n",
        "hello\n끝",
        "",
        "\u{feff}한글😀\n끝\n",
    ] {
        let (revision, _, _) =
            editable(core.fs_read_editable_file(session, "a.txt").await.unwrap());
        let saved = core
            .fs_save_file(session, "a.txt", &revision, text)
            .await
            .unwrap();
        assert!(matches!(saved, FsSaveResult::Saved { .. }), "{saved:?}");
        assert_eq!(
            std::fs::read(repo.path().join("a.txt")).unwrap(),
            text.as_bytes()
        );
        let FsSaveResult::Saved { revision: next } = saved else {
            unreachable!()
        };
        assert_eq!(
            editable(core.fs_read_editable_file(session, "a.txt").await.unwrap()).0,
            next
        );
        assert_eq!(
            std::fs::read(repo.path().join(".git/index")).unwrap(),
            index
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(repo.path().join("a.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
}

/// 같은 파일을 폴더·저장소에서 열면 키와 revision을 공유하고 동시 저장 중 하나만 성공한다.
#[tokio::test]
async fn shared_identity_serializes_cross_session_saves() {
    let mut repo = TestRepo::init();
    repo.write_file("a.txt", "initial\n");
    repo.commit("initial");
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let (sink, _) = collector();
    let folder = core.open_folder(repo.path(), sink).await.unwrap().session;
    let initial = editable(core.fs_read_editable_file(session, "a.txt").await.unwrap());
    assert_eq!(
        editable(core.fs_read_editable_file(folder, "a.txt").await.unwrap()),
        initial
    );
    let (a, b) = tokio::join!(
        core.fs_save_file(session, "a.txt", &initial.0, "one"),
        core.fs_save_file(folder, "a.txt", &initial.0, "two")
    );
    let outcomes = [a.unwrap(), b.unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| matches!(v, FsSaveResult::Saved { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| matches!(v, FsSaveResult::Conflict))
            .count(),
        1
    );
}

/// 외부 수정·삭제·이름 변경·형식 변경 뒤 저장은 파일을 복원하거나 덮어쓰지 않는다.
#[tokio::test]
async fn external_changes_and_unavailable_files_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "initial").unwrap();
    let core = core().await;
    let (sink, _) = collector();
    let session = core.open_folder(dir.path(), sink).await.unwrap().session;
    let initial = editable(core.fs_read_editable_file(session, "a.txt").await.unwrap());
    std::fs::write(dir.path().join("a.txt"), "outside").unwrap();
    assert_eq!(
        core.fs_save_file(session, "a.txt", &initial.0, "mine")
            .await
            .unwrap(),
        FsSaveResult::Conflict
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "outside"
    );
    std::fs::rename(dir.path().join("a.txt"), dir.path().join("moved.txt")).unwrap();
    assert_eq!(
        core.fs_save_file(session, "a.txt", &initial.0, "mine")
            .await
            .unwrap(),
        FsSaveResult::Conflict
    );
    assert!(!dir.path().join("a.txt").exists());
    for (name, bytes) in [
        ("mixed.txt", b"a\nb\r\n".as_slice()),
        ("cr.txt", b"a\rb"),
        ("binary", b"a\0b"),
        ("latin", b"\xff"),
    ] {
        std::fs::write(dir.path().join(name), bytes).unwrap();
        assert!(!matches!(
            core.fs_read_editable_file(session, name).await.unwrap(),
            FsEditableFile::Text { .. }
        ));
    }
    let mut late_nul = vec![b'a'; 8_001];
    late_nul.push(0);
    std::fs::write(dir.path().join("late-nul.txt"), late_nul).unwrap();
    assert!(matches!(
        core.fs_read_editable_file(session, "late-nul.txt")
            .await
            .unwrap(),
        FsEditableFile::Unavailable(FsFile::Binary { .. })
    ));
    std::fs::write(dir.path().join("large.txt"), vec![b'a'; 1024 * 1024 + 1]).unwrap();
    assert!(matches!(
        core.fs_read_editable_file(session, "large.txt")
            .await
            .unwrap(),
        FsEditableFile::Unavailable(FsFile::TooLarge { .. })
    ));
    for path in ["../outside", ".git/config", "/tmp/file", "x/../moved.txt"] {
        assert!(core.fs_read_editable_file(session, path).await.is_err());
        assert!(core.fs_save_file(session, path, "x", "mine").await.is_err());
    }
    assert!(matches!(
        core.fs_read_editable_file(session, "absent").await.unwrap(),
        FsEditableFile::Unavailable(FsFile::Missing)
    ));
}

/// 링크와 읽기 전용·용량 초과 저장을 거부하고 원문을 유지한다.
#[cfg(unix)]
#[tokio::test]
async fn symlink_readonly_and_oversize_are_not_overwritten() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "initial").unwrap();
    symlink("a.txt", dir.path().join("link")).unwrap();
    std::fs::create_dir(dir.path().join("child")).unwrap();
    std::fs::write(dir.path().join("child/file.txt"), "untouched").unwrap();
    symlink("child", dir.path().join("linked-dir")).unwrap();
    let core = core().await;
    let (sink, _) = collector();
    let session = core.open_folder(dir.path(), sink).await.unwrap().session;
    let (revision, _, _) = editable(core.fs_read_editable_file(session, "a.txt").await.unwrap());
    assert!(matches!(
        core.fs_read_editable_file(session, "link").await.unwrap(),
        FsEditableFile::Unavailable(FsFile::Unsupported { .. })
    ));
    assert!(
        core.fs_save_file(session, "linked-dir/file.txt", &revision, "mine")
            .await
            .is_err()
    );
    assert_eq!(
        core.fs_save_file(session, "link", &revision, "mine")
            .await
            .unwrap(),
        FsSaveResult::Conflict
    );
    assert!(matches!(
        core.fs_save_file(session, "a.txt", &revision, &"x".repeat(1024 * 1024 + 1))
            .await
            .unwrap(),
        FsSaveResult::Failed { .. }
    ));
    std::fs::set_permissions(
        dir.path().join("a.txt"),
        std::fs::Permissions::from_mode(0o444),
    )
    .unwrap();
    let (revision, _, _) = editable(core.fs_read_editable_file(session, "a.txt").await.unwrap());
    assert!(matches!(
        core.fs_save_file(session, "a.txt", &revision, "mine")
            .await
            .unwrap(),
        FsSaveResult::Failed { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "initial"
    );
}

/// 줄 끝이 섞인 파일의 조회 결과에서 원문·revision·줄 끝 수를 꺼낸다.
fn mixed(file: FsEditableFile) -> (String, String, FsLineEndingCounts) {
    let FsEditableFile::MixedLineEndings {
        text,
        revision,
        counts,
        ..
    } = file
    else {
        panic!("줄 끝이 섞인 파일이어야 한다: {file:?}");
    };
    (text, revision, counts)
}

/// 줄 끝이 섞인 파일: 원문·revision·줄 끝 수를 읽기 전용으로 주고, 고른 형식으로 통일하면 정확히 그 바이트로 저장한 뒤
/// 편집할 수 있게 된다. BOM·글자·마지막 줄 끝의 유무·인덱스는 그대로이고, 단독 CR 도 줄 끝으로 바뀐다. 읽은 뒤 파일이
/// 바뀌었거나 revision 이 다르면 쓰지 않는다. 저장소 세션과 폴더 세션 모두 같은 경로로 저장한다
#[tokio::test]
async fn normalizes_mixed_line_endings_after_confirmation() {
    let mut repo = TestRepo::init();
    repo.write_file("mixed.txt", "seed\n");
    repo.commit("initial");
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let (sink, _) = collector();
    let folder = core.open_folder(repo.path(), sink).await.unwrap().session;
    let path = repo.path().join("mixed.txt");
    let index = std::fs::read(repo.path().join(".git/index")).unwrap();

    // BOM + CRLF + LF + 단독 CR, 마지막 줄 끝 없음: 원문 그대로 읽기 전용으로 준다
    let original = "\u{feff}한글😀\r\nb\nc\rd";
    std::fs::write(&path, original).unwrap();
    let file = core
        .fs_read_editable_file(session, "mixed.txt")
        .await
        .unwrap();
    let FsEditableFile::MixedLineEndings { size, .. } = &file else {
        panic!("{file:?}");
    };
    assert_eq!(*size, original.len() as u64);
    let (text, stale, counts) = mixed(file);
    assert_eq!(text, original);
    assert_eq!(
        counts,
        FsLineEndingCounts {
            lf: 1,
            crlf: 1,
            cr: 1
        }
    );
    // 폴더 세션에서 본 같은 파일은 같은 revision 이다
    assert_eq!(
        mixed(
            core.fs_read_editable_file(folder, "mixed.txt")
                .await
                .unwrap()
        )
        .1,
        stale
    );

    // 읽은 뒤 바뀌었으면 통일하지 않는다. 엉뚱한 revision 도 거부한다
    let outside = "\u{feff}x\r\ny\n";
    std::fs::write(&path, outside).unwrap();
    for revision in [stale.as_str(), "bogus"] {
        assert_eq!(
            core.fs_normalize_line_endings(session, "mixed.txt", revision, FsLineEnding::Lf)
                .await
                .unwrap(),
            FsSaveResult::Conflict
        );
        assert_eq!(std::fs::read(&path).unwrap(), outside.as_bytes());
    }

    // 다시 읽은 revision 으로 LF 통일: BOM 과 마지막 줄 끝을 지킨다. 그 뒤로는 편집할 수 있는 텍스트다
    let (_, revision, _) = mixed(
        core.fs_read_editable_file(session, "mixed.txt")
            .await
            .unwrap(),
    );
    let saved = core
        .fs_normalize_line_endings(session, "mixed.txt", &revision, FsLineEnding::Lf)
        .await
        .unwrap();
    let FsSaveResult::Saved { revision: next } = saved else {
        panic!("{saved:?}");
    };
    assert_eq!(std::fs::read(&path).unwrap(), "\u{feff}x\ny\n".as_bytes());
    let FsEditableFile::Text {
        revision: now,
        line_ending,
        bom,
        ..
    } = core
        .fs_read_editable_file(session, "mixed.txt")
        .await
        .unwrap()
    else {
        panic!("통일하면 편집할 수 있어야 한다");
    };
    assert_eq!((now, line_ending, bom), (next, FsLineEnding::Lf, true));

    // 폴더 세션에서 CRLF 통일: 마지막 줄 끝이 없으면 붙이지 않는다. 단독 CR 도 CRLF 가 된다
    std::fs::write(&path, "a\nb\r\nc\rd").unwrap();
    let (_, revision, _) = mixed(
        core.fs_read_editable_file(folder, "mixed.txt")
            .await
            .unwrap(),
    );
    assert!(matches!(
        core.fs_normalize_line_endings(folder, "mixed.txt", &revision, FsLineEnding::Crlf)
            .await
            .unwrap(),
        FsSaveResult::Saved { .. }
    ));
    assert_eq!(std::fs::read(&path).unwrap(), b"a\r\nb\r\nc\r\nd");
    assert!(matches!(
        core.fs_read_editable_file(session, "mixed.txt")
            .await
            .unwrap(),
        FsEditableFile::Text {
            line_ending: FsLineEnding::Crlf,
            bom: false,
            ..
        }
    ));
    // 작업 트리 파일만 바뀌고 인덱스는 그대로다
    assert_eq!(
        std::fs::read(repo.path().join(".git/index")).unwrap(),
        index
    );
}

/// 주기 검사 표지 (N6): 원문을 읽지 않고, 파일이 그대로면 같고 쓰면(같은 내용이어도) 바뀐다. 없음·폴더·링크·
/// 루트 밖은 None 이다
#[tokio::test]
async fn file_stamps_change_only_when_the_file_is_written() {
    let mut repo = TestRepo::init();
    repo.write_file("a.txt", "one\n");
    repo.write_file("dir/b.txt", "two\n");
    repo.commit("initial");
    #[cfg(unix)]
    std::os::unix::fs::symlink("a.txt", repo.path().join("link.txt")).unwrap();
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let paths: Vec<String> = [
        "a.txt",
        "dir/b.txt",
        "missing.txt",
        "dir",
        "link.txt",
        "../x",
    ]
    .map(String::from)
    .to_vec();
    let first = core.fs_file_stamps(session, &paths).await.unwrap();
    assert!(first[0].is_some() && first[1].is_some());
    assert_ne!(first[0], first[1]);
    assert_eq!(&first[2..], &[None, None, None, None]);
    // 그대로면 같다
    assert_eq!(core.fs_file_stamps(session, &paths).await.unwrap(), first);
    // 같은 내용을 다시 써도(시각이 바뀐다) 바뀌고, 다른 파일은 그대로다
    std::thread::sleep(std::time::Duration::from_millis(20));
    repo.write_file("a.txt", "one\n");
    let second = core.fs_file_stamps(session, &paths).await.unwrap();
    assert_ne!(second[0], first[0]);
    assert_eq!(second[1], first[1]);
    // 앱의 저장도 표지를 바꾼다
    let (revision, _, _) = editable(
        core.fs_read_editable_file(session, "dir/b.txt")
            .await
            .unwrap(),
    );
    std::thread::sleep(std::time::Duration::from_millis(20));
    let saved = core
        .fs_save_file(session, "dir/b.txt", &revision, "changed\n")
        .await
        .unwrap();
    assert!(matches!(saved, FsSaveResult::Saved { .. }));
    let third = core.fs_file_stamps(session, &paths).await.unwrap();
    assert_ne!(third[1], second[1]);
}

/// UTF-16 바이트 (LE·BE). 글자열 맨 앞의 U+FEFF 가 BOM 바이트가 된다
fn utf16(text: &str, little: bool) -> Vec<u8> {
    assert!(
        text.starts_with('\u{feff}'),
        "시험 파일은 BOM 으로 시작한다"
    );
    let mut out = Vec::new();
    for unit in text.encode_utf16() {
        out.extend(if little {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        });
    }
    out
}

/// 인코딩 시험 파일 하나: 원래 바이트, 알아낸 인코딩과 추정 여부, 디코드한 글자, 고친 글자와 그 저장 바이트
struct EncodedCase {
    name: &'static str,
    bytes: Vec<u8>,
    encoding: FsEncoding,
    guessed: bool,
    text: &'static str,
    edited: &'static str,
    edited_bytes: Vec<u8>,
}

/// UTF-8 이 아닌 인코딩 (R2): EUC-KR·Shift_JIS 는 BOM 없이 추정하고 UTF-16 LE/BE 는 BOM 으로 정한다. 편집 조회의 원문은
/// 디코드한 글자(BOM 은 맨 앞 U+FEFF)이고, 고친 원문은 같은 인코딩으로 다시 써서 BOM·CRLF 를 그대로 둔다. 저장 뒤 다시 읽은
/// revision 이 저장 결과와 같다. UTF-16 은 앞부분에 NUL 이 있어도 바이너리가 아니다
#[tokio::test]
async fn edits_non_utf8_encodings_with_the_same_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let core = core().await;
    let (sink, _) = collector();
    let session = core.open_folder(dir.path(), sink).await.unwrap().session;
    let euc_kr = |text: &str| FsEncoding::EucKr.encode(text).unwrap();
    let sjis = |text: &str| FsEncoding::ShiftJis.encode(text).unwrap();
    let cases = [
        EncodedCase {
            name: "kr.txt",
            bytes: euc_kr("한글\r\n둘째 줄\r\n"),
            encoding: FsEncoding::EucKr,
            guessed: true,
            text: "한글\r\n둘째 줄\r\n",
            edited: "한글\r\n고친 줄\r\n",
            edited_bytes: euc_kr("한글\r\n고친 줄\r\n"),
        },
        EncodedCase {
            name: "jp.txt",
            bytes: sjis("日本語\n"),
            encoding: FsEncoding::ShiftJis,
            guessed: true,
            text: "日本語\n",
            edited: "日本語です\n",
            edited_bytes: sjis("日本語です\n"),
        },
        EncodedCase {
            name: "le.txt",
            bytes: utf16("\u{feff}가\nb\n", true),
            encoding: FsEncoding::Utf16Le,
            guessed: false,
            text: "\u{feff}가\nb\n",
            edited: "\u{feff}가\nc😀\n",
            edited_bytes: utf16("\u{feff}가\nc😀\n", true),
        },
        EncodedCase {
            name: "be.txt",
            bytes: utf16("\u{feff}a\r\n", false),
            encoding: FsEncoding::Utf16Be,
            guessed: false,
            text: "\u{feff}a\r\n",
            edited: "\u{feff}ab\r\n",
            edited_bytes: utf16("\u{feff}ab\r\n", false),
        },
    ];
    for EncodedCase {
        name,
        bytes,
        encoding: want,
        guessed: want_guessed,
        text: want_text,
        edited,
        edited_bytes,
    } in cases
    {
        std::fs::write(dir.path().join(name), &bytes).unwrap();
        let file = core.fs_read_editable_file(session, name).await.unwrap();
        let FsEditableFile::Text {
            text,
            revision,
            encoding,
            guessed,
            bom,
            size,
            ..
        } = file
        else {
            panic!("{name}: {file:?}");
        };
        assert_eq!(
            (text.as_str(), encoding, guessed),
            (want_text, want, want_guessed),
            "{name}"
        );
        assert_eq!(bom, want_text.starts_with('\u{feff}'), "{name}");
        assert_eq!(size, bytes.len() as u64, "{name}");
        // 고르지 않아도 같은 인코딩을 고른 조회와 revision 이 같다 (저장의 비교 기준)
        let chosen = core
            .fs_read_editable_file_as(session, name, Some(encoding))
            .await
            .unwrap();
        assert_eq!(editable(chosen).0, revision, "{name}");
        let saved = core
            .fs_save_file_as(session, name, &revision, edited, encoding)
            .await
            .unwrap();
        let FsSaveResult::Saved { revision: next } = saved else {
            panic!("{name}: {saved:?}");
        };
        assert_eq!(
            std::fs::read(dir.path().join(name)).unwrap(),
            edited_bytes,
            "{name}"
        );
        let again = core.fs_read_editable_file(session, name).await.unwrap();
        assert_eq!(editable(again).0, next, "{name}");
    }
    // 파일 보기(읽기 전용 조회)는 UTF-16 을 바이너리가 아니라 UTF-8 아님으로 알린다
    assert_eq!(
        core.fs_read_file(session, "le.txt").await.unwrap(),
        FsFile::NotUtf8 {
            size: utf16("\u{feff}가\nc😀\n", true).len() as u64
        }
    );
}

/// 다시 쓸 수 없는 경우 (R2): 그 인코딩으로 쓸 수 없는 글자는 쓰지 않고 알린다. 다른 인코딩으로 읽은 revision 이나 읽은 뒤
/// 바뀐 파일은 덮어쓰지 않는다. 고른 인코딩으로 읽을 수 없는 바이트가 있거나 다시 쓰면 바이트가 달라지면 읽기 전용
/// (`Lossy`)이다. 줄 끝이 섞인 EUC-KR 파일은 같은 인코딩으로 통일한다
#[tokio::test]
async fn refuses_lossy_encoding_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let core = core().await;
    let (sink, _) = collector();
    let session = core.open_folder(dir.path(), sink).await.unwrap().session;
    let original = FsEncoding::EucKr.encode("한글\n").unwrap();
    let path = dir.path().join("kr.txt");
    std::fs::write(&path, &original).unwrap();
    let (revision, _, _) = editable(core.fs_read_editable_file(session, "kr.txt").await.unwrap());

    // EUC-KR 로 쓸 수 없는 글자 → 실패, 원문 그대로
    let FsSaveResult::Failed { message } = core
        .fs_save_file_as(session, "kr.txt", &revision, "한글😀\n", FsEncoding::EucKr)
        .await
        .unwrap()
    else {
        panic!("쓸 수 없는 글자는 실패여야 한다");
    };
    assert!(
        message.contains('😀') && message.contains("EUC-KR"),
        "{message}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    // UTF-8 로 저장하려 하면 (그 인코딩으로 읽을 수 없어) 충돌, 원문 그대로
    assert_eq!(
        core.fs_save_file(session, "kr.txt", &revision, "x\n")
            .await
            .unwrap(),
        FsSaveResult::Conflict
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    // 읽은 뒤 바뀐 파일은 덮어쓰지 않는다
    std::fs::write(&path, FsEncoding::EucKr.encode("바뀜\n").unwrap()).unwrap();
    assert_eq!(
        core.fs_save_file_as(session, "kr.txt", &revision, "내 것\n", FsEncoding::EucKr)
            .await
            .unwrap(),
        FsSaveResult::Conflict
    );

    // 고른 인코딩으로 읽을 수 없는 바이트: U+FFFD 로 보이는 읽기 전용
    let lossy = core
        .fs_read_editable_file_as(session, "kr.txt", Some(FsEncoding::Utf8))
        .await
        .unwrap();
    let FsEditableFile::Lossy {
        text,
        encoding,
        malformed,
        ..
    } = lossy
    else {
        panic!("{lossy:?}");
    };
    assert!(malformed && encoding == FsEncoding::Utf8 && text.contains('\u{fffd}'));
    // 다시 쓰면 바이트가 달라지는 Shift_JIS (NEC 선정 IBM 확장 자리의 ⅰ)
    std::fs::write(dir.path().join("jp.txt"), [0xEE, 0xEF, b'\n']).unwrap();
    let lossy = core
        .fs_read_editable_file_as(session, "jp.txt", Some(FsEncoding::ShiftJis))
        .await
        .unwrap();
    assert!(
        matches!(&lossy, FsEditableFile::Lossy { text, malformed: false, .. } if text == "ⅰ\n"),
        "{lossy:?}"
    );

    // 줄 끝이 섞인 EUC-KR: 같은 인코딩으로 읽어 통일하고 같은 인코딩으로 쓴다
    std::fs::write(
        dir.path().join("mixed.txt"),
        FsEncoding::EucKr.encode("한\r\n글\n").unwrap(),
    )
    .unwrap();
    let file = core
        .fs_read_editable_file(session, "mixed.txt")
        .await
        .unwrap();
    let FsEditableFile::MixedLineEndings {
        revision, encoding, ..
    } = file
    else {
        panic!("{file:?}");
    };
    assert_eq!(encoding, FsEncoding::EucKr);
    let saved = core
        .fs_normalize_line_endings_as(session, "mixed.txt", &revision, FsLineEnding::Lf, encoding)
        .await
        .unwrap();
    assert!(matches!(saved, FsSaveResult::Saved { .. }), "{saved:?}");
    assert_eq!(
        std::fs::read(dir.path().join("mixed.txt")).unwrap(),
        FsEncoding::EucKr.encode("한\n글\n").unwrap()
    );
}
