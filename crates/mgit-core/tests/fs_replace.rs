//! 여러 파일 바꾸기 (P): 미리보기·적용·폐기 백업·되돌리기를 실제 저장소·폴더 세션에서 확인한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, wait_finished};
use mgit_core::{
    CoreEvent, ReplaceChoice, ReplaceOutcome, ReplacePattern, ReplacePlan, ReplacePreview,
    ReplaceQuery, ReplaceSkipReason, ReplaceUndo, ReplaceUndoOutcome,
};
use mgit_testkit::TestRepo;

/// 받은 이벤트 중 상태 변경(`StatusChanged`) 수. 받아 둔 이벤트는 모두 비운다
fn status_events(rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) -> usize {
    let mut n = 0;
    while let Ok(event) = rx.try_recv() {
        if matches!(event, CoreEvent::StatusChanged { .. }) {
            n += 1;
        }
    }
    n
}

/// 여러 파일을 바꾸거나 되돌려도 세션 상태는 묶음 끝에 한 번만 다시 읽는다 (파일마다 `git status` 를 돌리지 않는다)
#[tokio::test]
async fn batch_refreshes_the_session_once() {
    let mut repo = TestRepo::init();
    for i in 0..12 {
        repo.write_file(&format!("d{}/f{i}.txt", i % 3), "alpha beta\n");
    }
    repo.commit("initial");
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let preview = core
        .workspace_replace_preview(
            session,
            query(pattern("alpha", false, "gamma")),
            Default::default(),
        )
        .await
        .unwrap();
    let files = preview
        .files
        .iter()
        .map(|f| choice(&preview, &f.path, &[]))
        .collect();
    status_events(&mut rx);
    let outcomes = core
        .workspace_replace_apply(
            session,
            ReplacePlan {
                pattern: pattern("alpha", false, "gamma"),
                files,
            },
        )
        .await
        .unwrap();
    assert_eq!(undo_items(&outcomes).len(), 12);
    assert_eq!(status_events(&mut rx), 1);
    let undone = core
        .workspace_replace_undo(session, undo_items(&outcomes))
        .await
        .unwrap();
    assert!(
        undone
            .iter()
            .all(|o| matches!(o, ReplaceUndoOutcome::Restored { .. }))
    );
    assert_eq!(status_events(&mut rx), 1);
}

/// 시험용 찾기·바꾸기 (대소문자 구분)
fn pattern(text: &str, regex: bool, replacement: &str) -> ReplacePattern {
    ReplacePattern {
        text: text.into(),
        regex,
        case_sensitive: true,
        replacement: replacement.into(),
    }
}

/// 범위·필터 없는 미리보기 요청
fn query(pattern: ReplacePattern) -> ReplaceQuery {
    ReplaceQuery {
        pattern,
        path_filter: String::new(),
        scope: String::new(),
        drafts: vec![],
    }
}

/// 미리보기의 파일 하나를 적용 선택으로 (뺄 일치 순번과 함께)
fn choice(preview: &ReplacePreview, path: &str, excluded: &[u32]) -> ReplaceChoice {
    let file = preview.files.iter().find(|f| f.path == path).unwrap();
    ReplaceChoice {
        path: path.into(),
        revision: file.revision.clone(),
        excluded: excluded.to_vec(),
    }
}

/// 적용 결과를 되돌리기 요청으로
fn undo_items(outcomes: &[ReplaceOutcome]) -> Vec<ReplaceUndo> {
    outcomes
        .iter()
        .filter_map(|o| match o {
            ReplaceOutcome::Applied {
                path,
                backup,
                revision,
                ..
            } => Some(ReplaceUndo {
                path: path.clone(),
                backup: *backup,
                revision: revision.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// 폴더 세션: 정규식 묶음을 펼쳐 바꾸고, 뺀 일치·BOM·CRLF 는 그대로 둔다. 원문은 그 저장소의 폐기 백업(`replace`)으로
/// 남아 저장소 탭의 목록에 보이고, 되돌리기는 원문 바이트를 되살린다. 저장소 밖 파일은 사유와 함께 뺀다
#[tokio::test]
async fn folder_replace_backs_up_and_undo_restores_exact_bytes() {
    let root = tempfile::tempdir().unwrap();
    let mut app = TestRepo::at(&root.path().join("app"));
    std::fs::create_dir_all(app.path()).unwrap();
    app.git_ok(["init", "-q", "-b", "main"]);
    let a = "\u{feff}let foo_1 = foo_2;\r\nfoo_3\r\n";
    let b = "foo_9\n끝";
    app.write_file("a.txt", a);
    app.write_file("src/b.txt", b);
    app.commit("initial");
    std::fs::write(root.path().join("note.txt"), "foo_1\n").unwrap();
    // UTF-8 이 아닌 파일은 편집기에서는 열리지만(R2) 여러 파일 바꾸기에서는 지금처럼 빠진다 (읽지 못한 수)
    std::fs::write(
        app.path().join("kr.txt"),
        mgit_core::FsEncoding::EucKr.encode("foo_5 한글\n").unwrap(),
    )
    .unwrap();
    let core = core().await;
    let (sink, _) = collector();
    let folder = core.open_folder(root.path(), sink).await.unwrap().session;

    let preview = core
        .workspace_replace_preview(
            folder,
            query(pattern(r"foo_(\d)", true, "bar$1")),
            Default::default(),
        )
        .await
        .unwrap();
    let mut files: Vec<_> = preview.files.iter().map(|f| f.path.as_str()).collect();
    files.sort_unstable();
    assert_eq!(files, ["app/a.txt", "app/src/b.txt"]);
    assert_eq!(preview.unreadable, 1);
    assert_eq!(preview.excluded.len(), 1);
    assert_eq!(preview.excluded[0].path, "note.txt");
    assert_eq!(
        preview.excluded[0].reason,
        ReplaceSkipReason::OutsideRepository
    );
    let first = &preview
        .files
        .iter()
        .find(|f| f.path == "app/a.txt")
        .unwrap();
    assert_eq!(first.matches, 3);
    assert_eq!(first.lines[0].matches[1].replacement, "bar2");

    let outcomes = core
        .workspace_replace_apply(
            folder,
            ReplacePlan {
                pattern: pattern(r"foo_(\d)", true, "bar$1"),
                files: vec![
                    choice(&preview, "app/a.txt", &[1]),
                    choice(&preview, "app/src/b.txt", &[]),
                ],
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(&outcomes[0], ReplaceOutcome::Applied { replaced: 2, .. }),
        "{outcomes:?}"
    );
    assert!(
        matches!(&outcomes[1], ReplaceOutcome::Applied { replaced: 1, .. }),
        "{outcomes:?}"
    );
    assert_eq!(
        std::fs::read(app.path().join("a.txt")).unwrap(),
        "\u{feff}let bar1 = foo_2;\r\nbar3\r\n".as_bytes()
    );
    assert_eq!(
        std::fs::read_to_string(app.path().join("src/b.txt")).unwrap(),
        "bar9\n끝"
    );

    // 원문은 그 저장소의 폐기 백업으로 남아 저장소 탭의 목록에 보인다
    let (sink, mut rx) = collector();
    let repo = core.open_repo(app.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, repo).await;
    let mut backups: Vec<_> = core
        .backups(repo, 10)
        .unwrap()
        .into_iter()
        .map(|b| (b.rel_path, b.reason))
        .collect();
    backups.sort();
    assert_eq!(
        backups,
        [
            ("a.txt".to_string(), "replace".to_string()),
            ("src/b.txt".to_string(), "replace".to_string()),
        ]
    );

    let undone = core
        .workspace_replace_undo(folder, undo_items(&outcomes))
        .await
        .unwrap();
    assert_eq!(
        undone,
        [
            ReplaceUndoOutcome::Restored {
                path: "app/a.txt".into()
            },
            ReplaceUndoOutcome::Restored {
                path: "app/src/b.txt".into()
            },
        ]
    );
    assert_eq!(
        std::fs::read(app.path().join("a.txt")).unwrap(),
        a.as_bytes()
    );
    assert_eq!(
        std::fs::read_to_string(app.path().join("src/b.txt")).unwrap(),
        b
    );
}

/// 미리보기 뒤에 바뀐 파일은 건너뛰고 백업도 남기지 않는다. 바꾼 뒤 또 바뀐 파일은 되돌리지 않고, 다른 파일의 백업으로는
/// 되돌릴 수 없다
#[tokio::test]
async fn changed_files_are_skipped_on_apply_and_undo() {
    let mut repo = TestRepo::init();
    repo.write_file("a.txt", "old\n");
    repo.write_file("b.txt", "old\n");
    repo.commit("initial");
    let core = core().await;
    let (sink, mut rx) = collector();
    let session = core.open_repo(repo.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, session).await;
    let preview = core
        .workspace_replace_preview(
            session,
            query(pattern("old", false, "new")),
            Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(preview.files.len(), 2);
    std::fs::write(repo.path().join("a.txt"), "old changed\n").unwrap();

    let outcomes = core
        .workspace_replace_apply(
            session,
            ReplacePlan {
                pattern: pattern("old", false, "new"),
                files: vec![
                    choice(&preview, "a.txt", &[]),
                    choice(&preview, "b.txt", &[]),
                ],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        outcomes[0],
        ReplaceOutcome::Skipped {
            path: "a.txt".into(),
            reason: ReplaceSkipReason::Changed
        }
    );
    assert!(matches!(&outcomes[1], ReplaceOutcome::Applied { .. }));
    assert_eq!(
        std::fs::read_to_string(repo.path().join("a.txt")).unwrap(),
        "old changed\n"
    );
    let backups: Vec<_> = core
        .backups(session, 10)
        .unwrap()
        .into_iter()
        .map(|b| b.rel_path)
        .collect();
    assert_eq!(backups, ["b.txt"]);

    // 모든 일치를 뺀 파일은 바꾸지 않는다
    let none = core
        .workspace_replace_apply(
            session,
            ReplacePlan {
                pattern: pattern("old", false, "new"),
                files: vec![ReplaceChoice {
                    path: "a.txt".into(),
                    revision: core
                        .workspace_replace_preview(
                            session,
                            query(pattern("old", false, "new")),
                            Default::default(),
                        )
                        .await
                        .unwrap()
                        .files[0]
                        .revision
                        .clone(),
                    excluded: vec![0],
                }],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        none,
        [ReplaceOutcome::Skipped {
            path: "a.txt".into(),
            reason: ReplaceSkipReason::Unchanged
        }]
    );

    let mut items = undo_items(&outcomes);
    let wrong = ReplaceUndo {
        path: "a.txt".into(),
        ..items[0].clone()
    };
    assert!(matches!(
        core.workspace_replace_undo(session, vec![wrong])
            .await
            .unwrap()[0],
        ReplaceUndoOutcome::Failed { .. }
    ));
    std::fs::write(repo.path().join("b.txt"), "edited after replace\n").unwrap();
    let undone = core
        .workspace_replace_undo(session, std::mem::take(&mut items))
        .await
        .unwrap();
    assert_eq!(
        undone,
        [ReplaceUndoOutcome::Skipped {
            path: "b.txt".into(),
            reason: ReplaceSkipReason::Changed
        }]
    );
    assert_eq!(
        std::fs::read_to_string(repo.path().join("b.txt")).unwrap(),
        "edited after replace\n"
    );
}
