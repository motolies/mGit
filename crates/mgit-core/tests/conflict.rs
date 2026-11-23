//! 충돌 해결 (MRG-06, CF-06~13·23·24·26)
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{
    Block, ConflictKind, ConflictSide, CoreError, EDITOR_MARKER_SIZE, Resolution, UnresolveMode,
    has_conflict_markers, parse_markers, render,
};
use mgit_testkit::{Scenario, TestRepo, build};

#[tokio::test]
async fn merge_conflict_payload_labels_and_resolutions_match_git() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let files = core.conflicts(opened.session).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "conflict.txt");
    assert_eq!(files[0].kind, ConflictKind::BothModified);
    assert!(!files[0].binary && !files[0].submodule);
    assert!(files[0].stages.iter().all(Option::is_some));

    let labels = core.side_labels(opened.session).await.unwrap();
    assert_eq!(labels.ours, "main");
    assert_eq!(labels.theirs, "other");

    let p = core
        .conflict_file(opened.session, "conflict.txt")
        .await
        .unwrap();
    assert_eq!(p.ours.as_deref(), Some("line1\nOURS\nline3\n"));
    assert_eq!(p.theirs.as_deref(), Some("line1\nTHEIRS\nline3\n"));
    assert_eq!(p.base.as_deref(), Some("line1\nline2\nline3\n"));
    assert!(!p.worktree_modified, "git 이 써 둔 자동 병합 결과 그대로");
    let doc = p.doc.unwrap();
    assert_eq!(doc.conflict_count(), 1);
    match &doc.blocks[1] {
        Block::Conflict {
            ours, base, theirs, ..
        } => {
            assert_eq!(ours, &vec!["OURS".to_string()]);
            assert_eq!(base, &vec!["line2".to_string()]);
            assert_eq!(theirs, &vec!["THEIRS".to_string()]);
        }
        other => panic!("{other:?}"),
    }

    // 명세 3.9: 전부 Ours/Theirs/둘 다 == git merge-file --ours/--theirs/--union
    let git_merge = |repo: &mut mgit_testkit::TestRepo, flag: &str| {
        repo.git_bytes([
            "merge-file",
            "-p",
            flag,
            "--object-id",
            ":2:conflict.txt",
            ":1:conflict.txt",
            ":3:conflict.txt",
        ])
    };
    assert_eq!(
        render(&doc, &[Resolution::Ours]),
        git_merge(&mut repo, "--ours")
    );
    assert_eq!(
        render(&doc, &[Resolution::Theirs]),
        git_merge(&mut repo, "--theirs")
    );
    assert_eq!(
        render(&doc, &[Resolution::BothOursFirst]),
        git_merge(&mut repo, "--union")
    );

    // 작업 트리를 손대면 modified
    repo.write_file("conflict.txt", "line1\nedited\nline3\n");
    let p2 = core
        .conflict_file(opened.session, "conflict.txt")
        .await
        .unwrap();
    assert!(p2.worktree_modified);
    assert_eq!(p2.worktree.as_deref(), Some("line1\nedited\nline3\n"));

    // 마커가 남은 내용은 거부 (CF-23)
    let bad = render(&doc, &[Resolution::Unresolved]);
    assert!(has_conflict_markers(&bad, 7));
    assert!(matches!(
        core.resolve_file(opened.session, "conflict.txt", &bad, false)
            .await,
        Err(CoreError::ConflictMarkers { .. })
    ));
    // 해결 저장 → stage 됨, 충돌 목록 비움, verify_staged 통과
    let good = render(
        &doc,
        &[Resolution::Custom {
            lines: vec!["MERGED".into()],
        }],
    );
    core.resolve_file(opened.session, "conflict.txt", &good, false)
        .await
        .unwrap();
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());
    assert_eq!(repo.read_file("conflict.txt"), "line1\nMERGED\nline3\n");
    assert!(core.verify_staged(opened.session).await.unwrap().is_empty());
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.status.summary().conflicted, 0);
    assert_eq!(st.status.summary().staged, 1);

    // 다시 충돌 상태로 (CF-26): Remake 는 마커를 되살리고, KeepWorktree 는 내용을 둔다
    core.unresolve(opened.session, "conflict.txt", UnresolveMode::Remake)
        .await
        .unwrap();
    assert_eq!(core.conflicts(opened.session).await.unwrap().len(), 1);
    assert!(has_conflict_markers(
        repo.read_file("conflict.txt").as_bytes(),
        7
    ));
    core.resolve_file(opened.session, "conflict.txt", &good, false)
        .await
        .unwrap();
    core.unresolve(opened.session, "conflict.txt", UnresolveMode::KeepWorktree)
        .await
        .unwrap();
    assert_eq!(core.conflicts(opened.session).await.unwrap().len(), 1);
    assert_eq!(repo.read_file("conflict.txt"), "line1\nMERGED\nline3\n");

    // 한쪽 선택 (CF-11)
    core.resolve_side(opened.session, "conflict.txt", ConflictSide::Theirs)
        .await
        .unwrap();
    assert_eq!(repo.read_file("conflict.txt"), "line1\nTHEIRS\nline3\n");
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());
    // 이어서 commit 까지 (MRG-06)
    core.op_continue(opened.session, false).await.unwrap();
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
}

#[tokio::test]
async fn rebase_and_cherry_pick_labels() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.checkout("other");
    repo.begin_rebase_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let labels = core.side_labels(opened.session).await.unwrap();
    assert!(labels.ours.starts_with("main"), "{labels:?}");
    assert!(labels.theirs.starts_with("other"), "{labels:?}");
    assert!(labels.theirs.contains("other change"), "{labels:?}");
    core.op_abort(opened.session).await.unwrap();

    repo.checkout("main");
    repo.begin_cherry_pick_conflict();
    core.refresh(opened.session).await.unwrap();
    let labels = core.side_labels(opened.session).await.unwrap();
    assert_eq!(labels.ours, "main");
    assert_eq!(labels.theirs, "cherry-pick: other change");
    core.op_abort(opened.session).await.unwrap();
}

#[tokio::test]
async fn delete_conflict_and_binary_side_pick() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    // main 은 파일을 수정, other 는 삭제 → merge 시 deleted by them
    repo.write_file("doomed.txt", "v1\n");
    repo.write_file("img.bin", "\u{0}\u{1}\u{2}base");
    repo.stage(&["doomed.txt", "img.bin"]);
    repo.commit_staged("base");
    repo.checkout_new("other");
    repo.remove_file("doomed.txt");
    repo.git_ok(["rm", "-q", "doomed.txt"]);
    repo.write_file("img.bin", "\u{0}\u{1}\u{2}theirs");
    repo.stage(&["img.bin"]);
    repo.commit_staged("other");
    repo.checkout("main");
    repo.write_file("doomed.txt", "v2\n");
    repo.write_file("img.bin", "\u{0}\u{1}\u{2}ours");
    repo.stage(&["doomed.txt", "img.bin"]);
    repo.commit_staged("main");
    let out = repo.git(["merge", "other"]);
    assert!(!out.status.success());

    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let files = core.conflicts(opened.session).await.unwrap();
    let doomed = files.iter().find(|f| f.path == "doomed.txt").unwrap();
    assert_eq!(doomed.kind, ConflictKind::DeletedByThem);
    let img = files.iter().find(|f| f.path == "img.bin").unwrap();
    assert!(img.binary);
    let p = core.conflict_file(opened.session, "img.bin").await.unwrap();
    assert!(p.doc.is_none() && p.ours.is_none());
    let p = core
        .conflict_file(opened.session, "doomed.txt")
        .await
        .unwrap();
    assert!(p.doc.is_none());
    assert_eq!(p.ours.as_deref(), Some("v2\n"));
    assert_eq!(p.theirs, None);

    core.resolve_delete(opened.session, "doomed.txt", true)
        .await
        .unwrap();
    assert_eq!(repo.read_file("doomed.txt"), "v2\n");
    core.resolve_side(opened.session, "img.bin", ConflictSide::Theirs)
        .await
        .unwrap();
    assert_eq!(repo.read_file("img.bin"), "\u{0}\u{1}\u{2}theirs");
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());

    // 다른 삭제 방향: 지우기로 해결
    core.unresolve(opened.session, "doomed.txt", UnresolveMode::KeepWorktree)
        .await
        .unwrap();
    core.resolve_delete(opened.session, "doomed.txt", false)
        .await
        .unwrap();
    assert!(!repo.path().join("doomed.txt").exists());
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());
}

#[test]
fn editor_marker_size_separates_marker_like_content() {
    let m = "<".repeat(EDITOR_MARKER_SIZE as usize);
    let e = "=".repeat(EDITOR_MARKER_SIZE as usize);
    let g = ">".repeat(EDITOR_MARKER_SIZE as usize);
    let text = format!("{m} a\n<<<<<<< fake\n{e}\n>>>>>>> fake\n{g} b\n");
    let doc = parse_markers(text.as_bytes(), EDITOR_MARKER_SIZE as usize).unwrap();
    assert_eq!(doc.conflict_count(), 1);
    assert!(has_conflict_markers(&render(&doc, &[Resolution::Ours]), 7));
}

/// 서브모듈 포인터 충돌에서 고른 쪽의 commit 이 stage 된다
#[tokio::test]
async fn pick_side_of_submodule_conflict_stages_that_commit() {
    let core = mgit_core_file_ok().await;
    let lib = build(Scenario::Linear(1));
    let mut repo = build(Scenario::Linear(1));
    repo.add_submodule("sub", lib.path());
    let mut sub = TestRepo::at(&repo.path().join("sub"));
    let base = sub.head();
    let ours = sub.commit("A");
    sub.git_ok(["checkout", "-q", &base.to_hex()]);
    let theirs = sub.commit("B");

    repo.checkout_new("th");
    repo.git_ok([
        "update-index",
        "--cacheinfo",
        &format!("160000,{},sub", theirs.to_hex()),
    ]);
    repo.commit_staged("point at B");
    repo.checkout("main");
    repo.git_ok([
        "update-index",
        "--cacheinfo",
        &format!("160000,{},sub", ours.to_hex()),
    ]);
    repo.commit_staged("point at A");
    sub.git_ok(["checkout", "-q", &ours.to_hex()]);
    assert!(!repo.git(["merge", "--no-edit", "th"]).status.success());

    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let files = core.conflicts(opened.session).await.unwrap();
    assert!(files[0].submodule, "{files:?}");

    core.resolve_side(opened.session, "sub", ConflictSide::Theirs)
        .await
        .unwrap();

    assert_eq!(
        repo.git_ok(["ls-files", "-s", "sub"]).trim(),
        format!("160000 {} 0\tsub", theirs.to_hex())
    );
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());
}

/// 비 UTF-8 충돌은 바이너리처럼 파일 단위 선택만 허용하고, 고른 쪽의 바이트를 보존한다
#[tokio::test]
async fn non_utf8_conflict_is_side_pick_only() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let theirs: &[u8] = b"ascii\n\xb1\xdb\n";
    std::fs::write(repo.path().join("e.txt"), b"ascii\nbase\n").unwrap();
    repo.stage(&["e.txt"]);
    repo.commit_staged("base");
    repo.checkout_new("other");
    std::fs::write(repo.path().join("e.txt"), theirs).unwrap();
    repo.stage(&["e.txt"]);
    repo.commit_staged("theirs");
    repo.checkout("main");
    std::fs::write(repo.path().join("e.txt"), b"ascii\n\xc7\xd1\n").unwrap();
    repo.stage(&["e.txt"]);
    repo.commit_staged("ours");
    assert!(!repo.git(["merge", "--no-edit", "other"]).status.success());
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let files = core.conflicts(opened.session).await.unwrap();
    assert!(files[0].binary, "{files:?}");
    let payload = core.conflict_file(opened.session, "e.txt").await.unwrap();
    assert!(payload.doc.is_none() && payload.ours.is_none());
    let err = core
        .resolve_file(
            opened.session,
            "e.txt",
            "lossy \u{fffd}\n".as_bytes(),
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");

    core.resolve_side(opened.session, "e.txt", ConflictSide::Theirs)
        .await
        .unwrap();
    assert_eq!(repo.git_bytes(["show", ":e.txt"]), theirs);
    assert_eq!(std::fs::read(repo.path().join("e.txt")).unwrap(), theirs);
}

/// 심링크 충돌은 파일 단위 선택만 허용한다: 링크를 따라가 대상 파일을 덮어쓰면 안 된다
#[cfg(unix)]
#[tokio::test]
async fn symlink_conflict_never_writes_through_the_link() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    for (dir, body) in [("v1", "one"), ("v2", "two"), ("v3", "three")] {
        repo.write_file(&format!("{dir}/app.conf"), body);
    }
    let link = repo.path().join("current");
    std::os::unix::fs::symlink("v1/app.conf", &link).unwrap();
    repo.git_ok(["add", "-A"]);
    repo.commit_staged("base");
    repo.checkout_new("t");
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("v3/app.conf", &link).unwrap();
    repo.git_ok(["add", "-A"]);
    repo.commit_staged("t");
    repo.checkout("main");
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("v2/app.conf", &link).unwrap();
    repo.git_ok(["add", "-A"]);
    repo.commit_staged("m");
    assert!(!repo.git(["merge", "--no-edit", "t"]).status.success());
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    assert!(core.conflicts(opened.session).await.unwrap()[0].binary);
    let err = core
        .resolve_file(opened.session, "current", b"resolved text\n", false)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert_eq!(repo.read_file("v2/app.conf"), "two", "링크 대상은 그대로");

    core.resolve_side(opened.session, "current", ConflictSide::Theirs)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_link(&link).unwrap(),
        std::path::Path::new("v3/app.conf")
    );
}

/// 7자 제목 밑줄이 있는 파일도 해결·저장할 수 있다
#[tokio::test]
async fn resolve_file_accepts_heading_underline() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.resolve_file(opened.session, "conflict.txt", b"Install\n=======\n", false)
        .await
        .unwrap();

    assert!(core.conflicts(opened.session).await.unwrap().is_empty());
    core.op_continue(opened.session, false).await.unwrap();
    assert_eq!(repo.read_file("conflict.txt"), "Install\n=======\n");
}

/// 진짜 마커도 사용자가 고르면 저장·계속할 수 있다 (fixture 처럼 마커가 내용인 파일)
#[tokio::test]
async fn resolve_and_continue_allow_markers_only_when_asked() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let fixture = b"<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n";

    let err = core
        .resolve_file(opened.session, "conflict.txt", fixture, false)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::ConflictMarkers { .. }), "{err:?}");

    core.resolve_file(opened.session, "conflict.txt", fixture, true)
        .await
        .unwrap();
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());

    let err = core.op_continue(opened.session, false).await.unwrap_err();
    assert!(matches!(err, CoreError::ConflictMarkers { .. }), "{err:?}");
    assert!(
        repo.path().join(".git/MERGE_HEAD").exists(),
        "아직 merge 중"
    );

    core.op_continue(opened.session, true).await.unwrap();
    assert!(!repo.path().join(".git/MERGE_HEAD").exists());
    assert_eq!(
        repo.git_ok(["show", "HEAD:conflict.txt"]).as_bytes(),
        fixture
    );
}

/// 우회해도 해결하지 않은 충돌 파일은 계속할 수 없다
#[tokio::test]
async fn op_continue_bypass_does_not_skip_unresolved_files() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let err = core.op_continue(opened.session, true).await.unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
}

/// 편집기 저장은 작업 트리 밖(절대 경로·`..`·`.git` 안·링크 너머)에 쓰지 않는다. 거부는 쓰기 전에 일어나
/// 파일도 상위 디렉터리도 생기지 않고, 정상 경로의 저장은 그대로 된다
#[tokio::test]
async fn resolve_file_refuses_paths_outside_the_work_tree() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let work_tree = repo.path().to_path_buf();
    let outside = work_tree.parent().unwrap().join("outside-resolve-file");
    std::fs::create_dir_all(&outside).unwrap();
    #[allow(unused_mut)]
    let mut cases = vec![
        "../outside-resolve-file/up.txt".to_string(),
        "sub/../../outside-resolve-file/up2.txt".to_string(),
        outside.join("abs.txt").to_string_lossy().into_owned(),
        ".git/hooks/pre-commit".to_string(),
        ".GIT/hooks/pre-commit".to_string(),
        "sub/.git/config".to_string(),
    ];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, work_tree.join("link-out")).unwrap();
        cases.push("link-out/via-link.txt".to_string());
        cases.push("link-out/new-dir/deep.txt".to_string());
    }
    for path in &cases {
        let err = core
            .resolve_file(opened.session, path, b"PWNED\n", false)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{path}: {err:?}");
    }
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        0,
        "작업 트리 밖에 파일이 생겼다"
    );
    assert!(!work_tree.join(".git/hooks/pre-commit").exists());
    assert!(
        !work_tree.join("sub").exists(),
        "거부한 경로의 상위 디렉터리를 만들지 않는다"
    );

    assert_eq!(core.conflicts(opened.session).await.unwrap().len(), 1);
    core.resolve_file(
        opened.session,
        "conflict.txt",
        b"line1\nMERGED\nline3\n",
        false,
    )
    .await
    .unwrap();
    assert!(core.conflicts(opened.session).await.unwrap().is_empty());
    assert_eq!(repo.read_file("conflict.txt"), "line1\nMERGED\nline3\n");
}

/// 로컬 file 프로토콜을 허용하는 코어
async fn mgit_core_file_ok() -> mgit_core::Core {
    common::core_with(mgit_core::CoreConfig {
        git_config_overrides: vec![("protocol.file.allow".into(), "always".into())],
        ..mgit_core::CoreConfig::default()
    })
    .await
}
