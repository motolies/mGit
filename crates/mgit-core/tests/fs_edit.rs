//! 일반 파일 편집의 바이트 보존·경합·경계·인덱스 불변식을 검증한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, wait_finished};
use mgit_core::{FsEditableFile, FsFile, FsSaveResult};
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
