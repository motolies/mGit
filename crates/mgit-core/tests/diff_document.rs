//! 전체 파일 원문·비교 기준·부분 작업 revision 통합 검증.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, subcommand, wait_finished};
use mgit_core::{DiffOptions, LineSelection};
use mgit_testkit::{Scenario, build};

/// 공백 무시 시에도 양쪽 원문·탭·CRLF·마지막 개행을 보존한다.
#[tokio::test]
async fn whitespace_only_document_keeps_both_originals() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("text.txt", "한글 👨‍👩‍👧\told\r\nlast");
    repo.commit("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("text.txt", "한글 👨‍👩‍👧  old\r\nlast");
    let opts = DiffOptions {
        ignore_whitespace: true,
        ..Default::default()
    };
    let doc = core
        .work_tree_diff_document(opened.session, "text.txt", false, false, opts)
        .await
        .unwrap();
    assert!(doc.diff.hunks.is_empty());
    assert_eq!(doc.old.content.as_deref(), Some("한글 👨‍👩‍👧\told\r\nlast"));
    assert_eq!(doc.new.content.as_deref(), Some("한글 👨‍👩‍👧  old\r\nlast"));
    assert_eq!(doc.old.line_count, 2);
}

/// 전체 파일 표시에도 hunk가 합쳐지지 않고 하나만 stage·unstage·discard된다.
#[tokio::test]
async fn whole_document_keeps_hunks_and_rejects_stale_selection() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let base = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
    repo.write_file("text.txt", &base);
    repo.commit("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let changed = base
        .replace("line 2\n", "first\n")
        .replace("line 35\n", "second\n");
    repo.write_file("text.txt", &changed);
    let opts = DiffOptions::default();
    let doc = core
        .work_tree_diff_document(opened.session, "text.txt", false, false, opts)
        .await
        .unwrap();
    assert_eq!(doc.old.line_count, 40);
    assert_eq!(doc.diff.hunks.len(), 2);
    let selection = [LineSelection {
        hunk: 0,
        lines: vec![],
    }];
    core.stage_lines_checked(
        opened.session,
        "text.txt",
        &selection,
        false,
        opts,
        Some(&doc.revision),
    )
    .await
    .unwrap();
    let staged = core
        .work_tree_diff_document(opened.session, "text.txt", true, false, opts)
        .await
        .unwrap();
    assert!(staged.new.content.as_ref().unwrap().contains("first\n"));
    assert!(!staged.new.content.as_ref().unwrap().contains("second\n"));
    core.stage_lines_checked(
        opened.session,
        "text.txt",
        &selection,
        true,
        opts,
        Some(&staged.revision),
    )
    .await
    .unwrap();
    let doc = core
        .work_tree_diff_document(opened.session, "text.txt", false, false, opts)
        .await
        .unwrap();
    core.discard_lines_checked(
        opened.session,
        "text.txt",
        &selection,
        opts,
        Some(&doc.revision),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.path().join("text.txt")).unwrap(),
        base.replace("line 35\n", "second\n")
    );
    let doc = core
        .work_tree_diff_document(opened.session, "text.txt", false, false, opts)
        .await
        .unwrap();
    repo.write_file("text.txt", &changed);
    assert!(
        core.stage_lines_checked(
            opened.session,
            "text.txt",
            &selection,
            false,
            opts,
            Some(&doc.revision)
        )
        .await
        .is_err()
    );
    assert!(
        core.discard_lines_checked(
            opened.session,
            "text.txt",
            &selection,
            opts,
            Some(&doc.revision)
        )
        .await
        .is_err()
    );
}

/// 10,000줄 초과는 패치와 별도로 제한하고 명시적으로 원문을 다시 읽을 수 있다.
#[tokio::test]
async fn original_line_limit_and_explicit_full_load() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let original = "same\n".repeat(10_001);
    repo.write_file("large.txt", &original);
    repo.commit("large");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("large.txt", &format!("changed\n{original}"));
    let doc = core
        .work_tree_diff_document(
            opened.session,
            "large.txt",
            false,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(doc.limit_reason.as_deref(), Some("line-limit"));
    assert_eq!(doc.old.line_count, 10_001);
    assert!(doc.old.content.is_none());
    assert!(!doc.diff.truncated);
    let full = core
        .work_tree_diff_document(
            opened.session,
            "large.txt",
            false,
            true,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert!(full.limit_reason.is_none());
    assert_eq!(full.old.content.as_deref(), Some(original.as_str()));
    assert_eq!(full.revision, doc.revision);
}

/// 루트·이름 변경·삭제·빈 파일을 동일한 문서 계약으로 조회한다.
#[tokio::test]
async fn root_rename_deleted_and_empty_documents() {
    let core = core().await;
    let mut repo = build(Scenario::Empty);
    repo.write_file("old.txt", "one\ntwo\nthree\n");
    repo.write_file("empty.txt", "");
    let root = repo.commit("root");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let doc = core
        .commit_file_diff_document(
            opened.session,
            &root,
            "old.txt",
            None,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(doc.old.label, "Empty tree");
    assert_eq!(doc.old.content.as_deref(), Some(""));
    let empty = core
        .commit_file_diff_document(
            opened.session,
            &root,
            "empty.txt",
            None,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(empty.new.content.as_deref(), Some(""));
    repo.git_ok(["mv", "old.txt", "new.txt"]);
    let staged = core
        .work_tree_diff_document(
            opened.session,
            "new.txt",
            true,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(staged.old.path.as_deref(), Some("old.txt"));
    assert_eq!(staged.new.path.as_deref(), Some("new.txt"));
    let rename = repo.commit_staged("rename");
    let compared = core
        .compare_file_diff_document(
            opened.session,
            &root.to_hex(),
            &rename.to_hex(),
            false,
            "new.txt",
            DiffOptions::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(compared.old.path.as_deref(), Some("old.txt"));
    assert_eq!(compared.old.content, compared.new.content);
    repo.remove_file("new.txt");
    let deleted = core
        .work_tree_diff_document(
            opened.session,
            "new.txt",
            false,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.new.content.as_deref(), Some(""));
    assert!(deleted.new.path.is_none());
}

/// three-dot은 화면에 실제 merge base를 표시하고 그 원문을 읽는다.
#[tokio::test]
async fn three_dot_uses_merge_base_and_merge_commit_first_parent() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("text.txt", "base\n");
    let base = repo.commit("base");
    repo.branch("other");
    repo.write_file("text.txt", "main\n");
    let main = repo.commit("main");
    repo.checkout("other");
    repo.write_file("other.txt", "other\n");
    let other = repo.commit("other");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let doc = core
        .compare_file_diff_document(
            opened.session,
            &other.to_hex(),
            &main.to_hex(),
            true,
            "text.txt",
            DiffOptions::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(doc.old.label, base.to_hex());
    assert_eq!(doc.old.content.as_deref(), Some("base\n"));
    repo.git_ok(["merge", "--no-ff", "-m", "merge", &main.to_hex()]);
    let merge = repo.head();
    let doc = core
        .commit_file_diff_document(
            opened.session,
            &merge,
            "text.txt",
            None,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(doc.old.label, other.to_hex());
    assert_eq!(doc.new.content.as_deref(), Some("main\n"));
}

/// 비 UTF-8·바이너리·심볼릭 링크는 손실 원문으로 부분 쓰기를 유도하지 않는다.
#[tokio::test]
async fn unsupported_sources_have_explicit_reasons() {
    let core = core().await;
    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    std::fs::write(repo.path().join("bad.txt"), [255, b'\n']).unwrap();
    std::fs::write(repo.path().join("binary"), [0, 1, 2]).unwrap();
    core.refresh(opened.session).await.unwrap();
    let doc = core
        .work_tree_diff_document(
            opened.session,
            "bad.txt",
            false,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(doc.limit_reason.as_deref(), Some("non-utf8"));
    assert!(doc.diff.non_utf8);
    let doc = core
        .work_tree_diff_document(
            opened.session,
            "binary",
            false,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(doc.limit_reason.as_deref(), Some("binary"));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("bad.txt", repo.path().join("link")).unwrap();
        core.refresh(opened.session).await.unwrap();
        let doc = core
            .work_tree_diff_document(opened.session, "link", false, false, DiffOptions::default())
            .await
            .unwrap();
        assert_eq!(doc.limit_reason.as_deref(), Some("unsupported-file-type"));
        assert!(doc.new.content.is_none());
    }
}

/// 양쪽 원문이 제한 이하면 추가·삭제 합계가 제한을 넘어도 완전한 hunk를 유지한다.
#[tokio::test]
async fn replacement_patch_is_complete_when_each_source_fits() {
    let core = common::core_with(mgit_core::CoreConfig {
        diff_max_lines: 3,
        ..Default::default()
    })
    .await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("text.txt", "one\ntwo\nthree\n");
    repo.commit("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("text.txt", "a\nb\nc\n");
    let doc = core
        .work_tree_diff_document(
            opened.session,
            "text.txt",
            false,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert!(doc.limit_reason.is_none());
    assert!(!doc.diff.truncated);
    assert_eq!(doc.diff.hunks[0].lines.len(), 6);
}

/// 수정 쌍을 되돌리면 Index와 같은 구간의 선택하지 않은 수정 및 폐기 백업을 보존한다.
#[tokio::test]
async fn paired_row_discard_restores_index_without_other_changes() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("text.txt", "HEAD 내용\n확인\n원래 값\n");
    repo.commit("base");
    repo.write_file("text.txt", "Index 내용\n확인\n원래 값\n");
    repo.stage(&["text.txt"]);
    repo.write_file("text.txt", "Index 내용\n확인 안함\n다른 수정\n");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let opts = DiffOptions::default();
    let doc = core
        .work_tree_diff_document(opened.session, "text.txt", false, false, opts)
        .await
        .unwrap();
    assert_eq!(doc.diff.hunks.len(), 1);
    let lines = doc.diff.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.text == "확인" || line.text == "확인 안함")
        .map(|(index, _)| index as u32)
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 2);
    let before_index = repo.git_ok(["show", ":text.txt"]);
    let backup = core
        .discard_lines_checked(
            opened.session,
            "text.txt",
            &[LineSelection { hunk: 0, lines }],
            opts,
            Some(&doc.revision),
        )
        .await
        .unwrap();
    assert!(backup.is_some());
    assert_eq!(
        std::fs::read_to_string(repo.path().join("text.txt")).unwrap(),
        "Index 내용\n확인\n다른 수정\n"
    );
    assert_eq!(repo.git_ok(["show", ":text.txt"]), before_index);
}

/// 초안은 저장 없이 비교하고 디스크 변경을 되돌린 초안은 목록에서 제거한다.
#[tokio::test]
async fn local_comparison_uses_drafts_and_keeps_disk_and_index() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("text.txt", "base\n");
    repo.write_file(".gitignore", "ignored.txt\n");
    repo.commit("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("text.txt", "disk\n");
    repo.write_file("new.txt", "new\n");
    repo.write_file("ignored.txt", "ignored\n");
    let index = std::fs::read(repo.path().join(".git/index")).unwrap();
    let (base, files) = core
        .compare_local_files(
            opened.session,
            "HEAD",
            &[("text.txt".into(), "base\n".into())],
        )
        .await
        .unwrap();
    assert!(!files.iter().any(|f| f.path == "text.txt"));
    assert!(!files.iter().any(|f| f.path == "ignored.txt"));
    assert!(files.iter().any(|f| f.path == "new.txt"));
    let d = core
        .compare_local_document(
            opened.session,
            &base,
            "text.txt",
            Some("draft\n"),
            DiffOptions::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(d.old.content.as_deref(), Some("base\n"));
    assert_eq!(d.new.content.as_deref(), Some("draft\n"));
    assert!(!d.diff.hunks.is_empty());
    assert_eq!(
        std::fs::read_to_string(repo.path().join("text.txt")).unwrap(),
        "disk\n"
    );
    assert_eq!(
        std::fs::read(repo.path().join(".git/index")).unwrap(),
        index
    );
    let lines = core
        .blame_contents(opened.session, "text.txt", "base\nnew\n", false)
        .await
        .unwrap();
    assert_ne!(lines[0].oid.to_hex(), "0".repeat(40));
    assert_eq!(lines[1].oid.to_hex(), "0".repeat(40));
}

/// 이름 변경의 원래 경로와 기준 blob이 유지된다.
#[tokio::test]
async fn local_comparison_preserves_rename_source() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("before.txt", "same\n");
    repo.commit("base");
    std::fs::rename(
        repo.path().join("before.txt"),
        repo.path().join("after.txt"),
    )
    .unwrap();
    repo.stage(&["before.txt", "after.txt"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let (base, files) = core
        .compare_local_files(opened.session, "HEAD", &[])
        .await
        .unwrap();
    let file = files.iter().find(|f| f.path == "after.txt").unwrap();
    assert_eq!(file.old_path.as_deref(), Some("before.txt"));
    let d = core
        .compare_local_document(
            opened.session,
            &base,
            "after.txt",
            None,
            DiffOptions::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(d.old.path.as_deref(), Some("before.txt"));
    assert_eq!(d.old.content.as_deref(), Some("same\n"));
}

/// 대괄호·별표·pathspec 접두가 있는 이름도 다른 파일과 섞지 않고 초안 허용 여부를 판정한다.
#[tokio::test]
async fn comparison_paths_are_literal_in_sources_and_draft_lookup() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("a[1].txt", "brackets\n");
    repo.write_file("a1.txt", "not brackets\n");
    repo.write_file(":(glob)*.txt", "literal magic\n");
    repo.write_file("ignored1.txt", "tracked\n");
    repo.commit("literal files");
    repo.write_file(".gitignore", "ignored*\n");
    repo.commit("ignore untracked matches");
    repo.write_file("ignored[1].txt", "ignored disk\n");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    for (path, expected) in [
        ("a[1].txt", "brackets\n"),
        (":(glob)*.txt", "literal magic\n"),
    ] {
        assert_eq!(
            core.revision_file_content(opened.session, "HEAD", path)
                .await
                .unwrap()
                .as_deref(),
            Some(expected)
        );
        let doc = core
            .compare_local_document(
                opened.session,
                "HEAD",
                path,
                Some("draft\n"),
                DiffOptions::default(),
                false,
            )
            .await
            .unwrap();
        assert_eq!(doc.old.content.as_deref(), Some(expected));
        assert_eq!(doc.new.content.as_deref(), Some("draft\n"));
        assert_eq!(doc.old.path.as_deref(), Some(path));
    }
    let (_, files) = core
        .compare_local_files(
            opened.session,
            "HEAD",
            &[
                ("a[1].txt".into(), "draft brackets\n".into()),
                (":(glob)*.txt".into(), "draft magic\n".into()),
                ("ignored[1].txt".into(), "ignored draft\n".into()),
            ],
        )
        .await
        .unwrap();
    let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, [":(glob)*.txt", "a[1].txt"]);
}

/// `compare_local_files` 한 번이 띄운 git 하위 명령 (이름 순)
async fn local_comparison_commands(
    core: &mgit_core::Core,
    session: mgit_core::SessionId,
    drafts: &[(String, String)],
) -> (usize, Vec<String>) {
    let before = core.command_log_recent(usize::MAX).len();
    let (_, files) = core
        .compare_local_files(session, "HEAD", drafts)
        .await
        .unwrap();
    let mut all = core.command_log_recent(usize::MAX);
    all.truncate(all.len() - before);
    let mut ran: Vec<String> = all.iter().map(subcommand).collect();
    ran.sort();
    (files.len(), ran)
}

/// 바뀐 경로가 수백 개여도 로컬 비교 목록의 git 명령 수는 일정하다 (경로마다 `ls-tree`·`cat-file` 을 띄우지 않는다).
/// 크기가 같은 수정·다른 수정·삭제·미추적이 섞이고, 초안은 아는 경로면 `ls-files` 하나로 함께 확인한다
#[tokio::test]
async fn local_comparison_git_commands_do_not_grow_with_paths() {
    let core = core().await;
    let mut counts = Vec::new();
    for n in [30usize, 300] {
        let mut repo = build(Scenario::Linear(1));
        for i in 0..n {
            repo.write_file(
                &format!("d{}/f{i:04}.txt", i % 7),
                &format!("base {i:04}\n"),
            );
        }
        repo.commit("many");
        for i in 0..n {
            let path = format!("d{}/f{i:04}.txt", i % 7);
            match i % 4 {
                0 => repo.write_file(&path, &format!("BASE {i:04}\n")),
                1 => repo.write_file(&path, &format!("grown {i:04}\n")),
                2 => repo.remove_file(&path),
                _ => repo.write_file(&format!("new/u{i:04}.txt"), "untracked\n"),
            }
        }
        let (sink, mut rx) = collector();
        let opened = core.open_repo(repo.path(), sink).await.unwrap();
        wait_finished(&mut rx, opened.session).await;
        let (files, ran) = local_comparison_commands(&core, opened.session, &[]).await;
        assert_eq!(files, n, "수정·크기 다른 수정·삭제·미추적 {n}");
        assert_eq!(
            ran,
            [
                "cat-file",
                "cat-file",
                "diff",
                "diff",
                "ls-files",
                "ls-tree",
                "rev-parse"
            ],
            "경로 {n}개"
        );
        let drafts = vec![
            ("d0/f0000.txt".to_string(), "draft\n".to_string()),
            ("f1.txt".to_string(), "draft\n".to_string()),
        ];
        let (_, with_drafts) = local_comparison_commands(&core, opened.session, &drafts).await;
        assert_eq!(
            with_drafts,
            [
                "cat-file",
                "cat-file",
                "diff",
                "diff",
                "ls-files",
                "ls-files",
                "ls-tree",
                "rev-parse"
            ],
            "아는 경로의 초안 두 개는 ls-files 하나로 확인한다"
        );
        counts.push(ran.len());
        core.close_repo(opened.session).unwrap();
    }
    assert_eq!(counts[0], counts[1]);
}
