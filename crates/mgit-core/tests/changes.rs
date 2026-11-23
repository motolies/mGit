//! 스테이징·부분 스테이징·discard 백업·커밋 (CHG-02~06, DIFF-01·02)
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::time::Duration;

use common::{collector, core, wait_finished, wait_for};
use mgit_core::{
    CommitSpec, CoreError, CoreEvent, DiffChange, DiffOptions, LineKind, LineSelection,
};
use mgit_testkit::{Scenario, TestRepo, build};

#[tokio::test]
async fn stage_unstage_round_trip() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("a.txt", "a");
    repo.write_file("b.txt", "b");
    repo.write_file("f1.txt", "edited");
    repo.remove_file("f1.txt");
    core.refresh(opened.session).await.unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.status.summary().untracked, 2);
    assert_eq!(st.status.summary().unstaged, 1); // 삭제

    core.stage(opened.session, &["a.txt".into(), "f1.txt".into()])
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    let s = st.status.summary();
    assert_eq!((s.staged, s.untracked, s.unstaged), (2, 1, 0));

    core.unstage(opened.session, &["a.txt".into()])
        .await
        .unwrap();
    let s = core.repo_state(opened.session).unwrap().status.summary();
    assert_eq!((s.staged, s.untracked), (1, 2));

    core.stage_all(opened.session).await.unwrap();
    assert_eq!(
        core.repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .staged,
        3
    );
    core.unstage_all(opened.session).await.unwrap();
    let s = core.repo_state(opened.session).unwrap().status.summary();
    assert_eq!((s.staged, s.untracked, s.unstaged), (0, 2, 1));
}

#[tokio::test]
async fn unstage_works_in_unborn_repo() {
    let core = core().await;
    let mut repo = build(Scenario::Empty);
    repo.write_file("x.txt", "x");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    core.stage(opened.session, &["x.txt".into()]).await.unwrap();
    assert_eq!(
        core.repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .staged,
        1
    );
    core.unstage(opened.session, &["x.txt".into()])
        .await
        .unwrap();
    let s = core.repo_state(opened.session).unwrap().status.summary();
    assert_eq!((s.staged, s.untracked), (0, 1));
}

#[tokio::test]
async fn work_tree_diff_for_modified_untracked_staged_and_binary() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("f1.txt", "commit 1\nmore\n");
    repo.write_file("new.txt", "hello\n한글\n");
    std::fs::write(repo.path().join("bin.dat"), [0u8, 1, 2, 3, 0, 255]).unwrap();
    core.refresh(opened.session).await.unwrap();

    let d = core
        .work_tree_diff(opened.session, "f1.txt", false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d.change, DiffChange::Modified);
    assert_eq!(d.path(), "f1.txt");
    assert_eq!(d.hunks.len(), 1);
    let adds: Vec<&str> = d.hunks[0]
        .lines
        .iter()
        .filter(|l| l.kind == LineKind::Add)
        .map(|l| l.text.as_str())
        .collect();
    // 원본은 끝 줄바꿈이 없어 첫 줄도 바뀐 것으로 나온다
    assert!(adds.contains(&"more"), "{adds:?}");
    assert!(d.hunks[0].lines.iter().any(|l| l.kind == LineKind::Del));
    assert!(!d.truncated);

    let u = core
        .work_tree_diff(opened.session, "new.txt", false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(u.change, DiffChange::Added);
    assert_eq!(u.old_path, None);
    assert_eq!(u.new_path.as_deref(), Some("new.txt"));
    assert_eq!(u.hunks[0].lines.len(), 2);
    assert_eq!(u.hunks[0].lines[1].text, "한글");

    let b = core
        .work_tree_diff(opened.session, "bin.dat", false, false)
        .await
        .unwrap()
        .unwrap();
    let info = b.binary.unwrap();
    assert_eq!(info.new_size, Some(6));
    assert!(b.hunks.is_empty());

    core.stage(opened.session, &["f1.txt".into()])
        .await
        .unwrap();
    let s = core
        .work_tree_diff(opened.session, "f1.txt", true, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.hunks.len(), 1);
    assert!(
        core.work_tree_diff(opened.session, "f1.txt", false, false)
            .await
            .unwrap()
            .is_none(),
        "stage 뒤 작업 트리 diff 는 없다"
    );
}

#[tokio::test]
async fn partial_staging_round_trip() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("p.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    repo.stage(&["p.txt"]);
    repo.commit_staged("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 두 군데를 고친다 (서로 멀어 hunk 2개)
    repo.write_file("p.txt", "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nL10\n");
    core.refresh(opened.session).await.unwrap();
    let d = core
        .work_tree_diff(opened.session, "p.txt", false, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d.hunks.len(), 2);

    // 첫 hunk 만 stage
    core.stage_lines(
        opened.session,
        "p.txt",
        &[LineSelection {
            hunk: 0,
            lines: vec![],
        }],
        false,
        DiffOptions::default(),
    )
    .await
    .unwrap();
    let staged = repo.git_ok(["diff", "--cached", "--", "p.txt"]);
    assert!(
        staged.contains("+L1\n") && !staged.contains("+L10\n"),
        "{staged}"
    );
    let unstaged = repo.git_ok(["diff", "--", "p.txt"]);
    assert!(
        !unstaged.contains("+L1\n") && unstaged.contains("+L10\n"),
        "{unstaged}"
    );

    // 두 번째 hunk 의 줄만 골라 stage (hunk 1 의 Del·Add 줄 인덱스)
    let d2 = core
        .work_tree_diff(opened.session, "p.txt", false, true)
        .await
        .unwrap()
        .unwrap();
    let change_lines: Vec<u32> = d2.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.kind != LineKind::Context)
        .map(|(i, _)| i as u32)
        .collect();
    core.stage_lines(
        opened.session,
        "p.txt",
        &[LineSelection {
            hunk: 0,
            lines: change_lines,
        }],
        false,
        DiffOptions::default(),
    )
    .await
    .unwrap();
    assert!(repo.git_ok(["diff", "--", "p.txt"]).is_empty());
    assert!(
        repo.git_ok(["diff", "--cached", "--", "p.txt"])
            .contains("+L10\n")
    );

    // 첫 hunk 를 unstage → 작업 트리는 그대로, index 에서만 빠진다
    core.stage_lines(
        opened.session,
        "p.txt",
        &[LineSelection {
            hunk: 0,
            lines: vec![],
        }],
        true,
        DiffOptions::default(),
    )
    .await
    .unwrap();
    let staged = repo.git_ok(["diff", "--cached", "--", "p.txt"]);
    assert!(
        !staged.contains("+L1\n") && staged.contains("+L10\n"),
        "{staged}"
    );
    assert_eq!(repo.read_file("p.txt").lines().next(), Some("L1"));
}

#[tokio::test]
async fn partial_stage_of_new_file_and_no_newline() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("n.txt", "a\nb\nc"); // 끝 줄바꿈 없음
    core.refresh(opened.session).await.unwrap();
    let d = core
        .work_tree_diff(opened.session, "n.txt", false, true)
        .await
        .unwrap()
        .unwrap();
    assert!(d.hunks[0].lines.last().unwrap().no_newline);
    core.stage_lines(
        opened.session,
        "n.txt",
        &[LineSelection {
            hunk: 0,
            lines: vec![],
        }],
        false,
        DiffOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        core.repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .staged,
        1
    );
    assert_eq!(repo.git_ok(["show", ":n.txt"]), "a\nb\nc");
}

#[tokio::test]
async fn discard_backs_up_and_restores() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("f1.txt", "precious edit\n");
    repo.write_file("junk.txt", "untracked junk\n");
    core.refresh(opened.session).await.unwrap();
    let ids = core
        .discard(opened.session, &["f1.txt".into(), "junk.txt".into()])
        .await
        .unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(repo.read_file("f1.txt"), "commit 1");
    assert!(!repo.path().join("junk.txt").exists());
    assert!(
        !core
            .repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .has_changes()
    );

    let backups = core.backups(opened.session, 10).unwrap();
    assert_eq!(backups.len(), 2);
    let junk = backups.iter().find(|b| b.rel_path == "junk.txt").unwrap();
    assert_eq!(
        std::fs::read_to_string(&junk.blob_path).unwrap(),
        "untracked junk\n"
    );
    core.restore_backup(opened.session, junk.id).await.unwrap();
    assert_eq!(repo.read_file("junk.txt"), "untracked junk\n");
    assert_eq!(
        core.repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .untracked,
        1
    );

    assert!(matches!(
        core.discard(opened.session, &["../escape".into()]).await,
        Err(CoreError::Invalid(_))
    ));
}

#[tokio::test]
async fn discard_lines_reverts_only_selected_hunk() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("p.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    repo.stage(&["p.txt"]);
    repo.commit_staged("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("p.txt", "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nL10\n");
    core.refresh(opened.session).await.unwrap();
    let id = core
        .discard_lines(
            opened.session,
            "p.txt",
            &[LineSelection {
                hunk: 0,
                lines: vec![],
            }],
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert!(id.is_some());
    assert_eq!(
        repo.read_file("p.txt"),
        "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nL10\n"
    );
}

#[tokio::test]
async fn commit_amend_hooks_and_markers() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("c.txt", "c");
    core.stage(opened.session, &["c.txt".into()]).await.unwrap();
    let head = core
        .commit(
            opened.session,
            CommitSpec {
                sign: None,
                message: "요약\n\n본문 줄".into(),
                ..CommitSpec::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(repo.head(), head);
    assert_eq!(repo.git_ok(["log", "-1", "--format=%s"]).trim(), "요약");
    assert_eq!(
        core.last_commit_message(opened.session).await.unwrap(),
        "요약\n\n본문 줄"
    );

    let amended = core
        .commit(
            opened.session,
            CommitSpec {
                sign: None,
                message: "고친 요약".into(),
                amend: true,
                ..CommitSpec::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_ne!(amended, head);
    assert_eq!(repo.git_ok(["rev-list", "--count", "HEAD"]).trim(), "2");
    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%s"]).trim(),
        "고친 요약"
    );

    // 실패하는 pre-commit hook: 출력이 스트리밍되고 커밋은 거부된다
    repo.install_hook(
        "pre-commit",
        "#!/bin/sh\necho 'hook says 안녕' >&2\necho stdout-line\nexit 1\n",
    );
    repo.write_file("d.txt", "d");
    core.stage(opened.session, &["d.txt".into()]).await.unwrap();
    let op = core
        .begin_operation(opened.session, "commit", "commit")
        .unwrap();
    let op_id = op.id;
    let err = core
        .commit(
            opened.session,
            CommitSpec {
                sign: None,
                message: "hook test".into(),
                ..CommitSpec::default()
            },
            Some(op),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            CoreError::CommandFailed {
                status: Some(1),
                ..
            }
        ),
        "{err:?}"
    );
    let events = wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, ok: false, .. } if *id == op_id),
    )
    .await;
    let outputs: Vec<(bool, String)> = events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::OperationOutput {
                op_id: id,
                stderr,
                text,
                ..
            } if *id == op_id => Some((*stderr, text.clone())),
            _ => None,
        })
        .collect();
    assert!(
        outputs.contains(&(true, "hook says 안녕".to_string())),
        "{outputs:?}"
    );
    // git 은 hook 의 stdout 을 stderr 로 돌린다
    assert!(
        outputs.contains(&(true, "stdout-line".to_string())),
        "{outputs:?}"
    );

    // --no-verify 로 건너뛴다
    core.commit(
        opened.session,
        CommitSpec {
            sign: None,
            message: "skip hook".into(),
            no_verify: true,
            ..CommitSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(repo.git_ok(["rev-list", "--count", "HEAD"]).trim(), "3");

    // 충돌 마커가 남은 파일은 커밋을 막는다
    repo.write_file(
        "m.txt",
        "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n",
    );
    core.stage(opened.session, &["m.txt".into()]).await.unwrap();
    let markers = core.verify_staged(opened.session).await.unwrap();
    assert_eq!(markers.len(), 2, "`=======` 은 세지 않는다");
    assert_eq!(markers[0].path, "m.txt");
    let err = core
        .commit(
            opened.session,
            CommitSpec {
                sign: None,
                message: "bad".into(),
                no_verify: true,
                ..CommitSpec::default()
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, CoreError::ConflictMarkers { ref files } if files == &["m.txt".to_string()]),
        "{err:?}"
    );
}

/// 0..30 줄 번호 파일
fn numbered() -> Vec<String> {
    (0..30).map(|i| format!("line{i}")).collect()
}

/// 줄 목록을 파일 내용으로
fn joined(lines: &[String]) -> String {
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// 같은 블록이 `n` 번 반복되는 파일
fn blocks(n: usize) -> Vec<String> {
    (0..n)
        .flat_map(|_| ["block", "  alpha", "  beta", "  gamma", "end", ""])
        .map(str::to_string)
        .collect()
}

/// `lines` 를 커밋한 저장소를 연다
async fn repo_with(core: &mgit_core::Core, lines: &[String]) -> (TestRepo, mgit_core::SessionId) {
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("f.txt", &joined(lines));
    repo.stage(&["f.txt"]);
    repo.commit_staged("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    (repo, opened.session)
}

/// hunk 하나 전체를 고른다
fn whole(hunk: u32) -> Vec<LineSelection> {
    vec![LineSelection {
        hunk,
        lines: vec![],
    }]
}

/// 공백 무시 화면의 hunk 번호는 기본 diff 와 다르다. 화면과 같은 옵션으로 패치를 만들어야 한다
#[tokio::test]
async fn stage_lines_uses_the_options_of_the_view() {
    let core = core().await;
    let mut lines = numbered();
    let (mut repo, session) = repo_with(&core, &lines).await;
    lines[2] = "  line2".into();
    lines[20] = "line20-CHANGED".into();
    repo.write_file("f.txt", &joined(&lines));
    core.refresh(session).await.unwrap();
    let opts = DiffOptions {
        ignore_whitespace: true,
        context: 3,
    };
    let shown = core
        .work_tree_diff_opts(session, "f.txt", false, true, opts)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.hunks.len(), 1, "화면에는 내용 변경만 보인다");
    core.stage_lines(session, "f.txt", &whole(0), false, opts)
        .await
        .unwrap();
    let staged = repo.git_ok(["diff", "--cached", "--", "f.txt"]);
    assert!(staged.contains("+line20-CHANGED"), "{staged}");
    assert!(!staged.contains("+  line2"), "{staged}");
}

#[tokio::test]
async fn discard_lines_uses_the_options_of_the_view() {
    let core = core().await;
    let mut lines = numbered();
    let (mut repo, session) = repo_with(&core, &lines).await;
    lines[2] = "  line2".into();
    lines[20] = "line20-CHANGED".into();
    repo.write_file("f.txt", &joined(&lines));
    core.refresh(session).await.unwrap();
    let opts = DiffOptions {
        ignore_whitespace: true,
        context: 3,
    };
    core.discard_lines(session, "f.txt", &whole(0), opts)
        .await
        .unwrap();
    lines[20] = "line20".into();
    assert_eq!(
        repo.read_file("f.txt"),
        joined(&lines),
        "화면의 변경만 버린다"
    );
}

/// 공백 무시 화면의 문맥 줄은 대상과 공백이 달라도 정방향 적용이 되어야 한다
#[tokio::test]
async fn stage_lines_with_ignored_whitespace_in_context_lines() {
    let core = core().await;
    let mut lines = numbered();
    let (mut repo, session) = repo_with(&core, &lines).await;
    lines[19] = "  line19".into();
    lines[20] = "line20-CHANGED".into();
    repo.write_file("f.txt", &joined(&lines));
    core.refresh(session).await.unwrap();
    let opts = DiffOptions {
        ignore_whitespace: true,
        context: 3,
    };
    core.stage_lines(session, "f.txt", &whole(0), false, opts)
        .await
        .unwrap();
    let staged = repo.git_ok(["diff", "--cached", "--", "f.txt"]);
    assert!(staged.contains("+line20-CHANGED"), "{staged}");
    assert!(
        !staged.contains("+  line19"),
        "공백 변경은 남는다: {staged}"
    );
}

/// 문맥 0줄 화면: 추가·삭제·수정 hunk 모두 제자리에 적용된다
#[tokio::test]
async fn zero_context_hunks_apply_in_place() {
    let core = core().await;
    let base = numbered();
    let (mut repo, session) = repo_with(&core, &base).await;
    let mut lines = base.clone();
    lines[5] = "line5-CHANGED".into();
    lines.insert(15, "inserted".into());
    lines.remove(26); // line25
    repo.write_file("f.txt", &joined(&lines));
    core.refresh(session).await.unwrap();
    let opts = DiffOptions {
        ignore_whitespace: false,
        context: 0,
    };
    let shown = core
        .work_tree_diff_opts(session, "f.txt", false, true, opts)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.hunks.len(), 3);

    // 삽입 hunk 만 stage
    core.stage_lines(session, "f.txt", &whole(1), false, opts)
        .await
        .unwrap();
    let mut index = base.clone();
    index.insert(15, "inserted".into());
    assert_eq!(repo.git_ok(["show", ":f.txt"]), joined(&index));

    // 삭제 hunk 를 버리면 그 줄이 제자리로 돌아온다 (남은 hunk: 수정, 삭제)
    core.discard_lines(session, "f.txt", &whole(1), opts)
        .await
        .unwrap();
    let mut expect = lines.clone();
    expect.insert(26, "line25".into());
    assert_eq!(repo.read_file("f.txt"), joined(&expect));

    // 삽입을 다시 unstage
    core.stage_lines(session, "f.txt", &whole(0), true, opts)
        .await
        .unwrap();
    assert_eq!(repo.git_ok(["show", ":f.txt"]), joined(&base));
}

/// 넓은 문맥 화면의 줄 번호는 그 화면의 hunk 기준이다
#[tokio::test]
async fn wide_context_line_selection_uses_view_line_numbers() {
    let core = core().await;
    let mut lines = numbered();
    let (mut repo, session) = repo_with(&core, &lines).await;
    lines[3] = "line3-CHANGED".into();
    lines[12] = "line12-CHANGED".into();
    repo.write_file("f.txt", &joined(&lines));
    core.refresh(session).await.unwrap();
    let opts = DiffOptions {
        ignore_whitespace: false,
        context: 20,
    };
    let shown = core
        .work_tree_diff_opts(session, "f.txt", false, true, opts)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.hunks.len(), 1);
    let picked: Vec<u32> = shown.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.text.contains("line12"))
        .map(|(i, _)| i as u32)
        .collect();
    core.stage_lines(
        session,
        "f.txt",
        &[LineSelection {
            hunk: 0,
            lines: picked,
        }],
        false,
        opts,
    )
    .await
    .unwrap();
    let staged = repo.git_ok(["diff", "--cached", "--", "f.txt"]);
    assert!(staged.contains("+line12-CHANGED"), "{staged}");
    assert!(!staged.contains("+line3-CHANGED"), "{staged}");
}

/// 반복되는 블록에서 고르지 않은 앞 hunk 가 있어도 고른 블록에 stage 된다
#[tokio::test]
async fn partial_stage_lands_on_the_selected_block_of_a_repeating_file() {
    let core = core().await;
    let base = blocks(8);
    let (mut repo, session) = repo_with(&core, &base).await;
    let mut lines = base.clone();
    lines[4 * 6 + 2] = "  BETA-CHANGED".into();
    let mut top: Vec<String> = (0..6).map(|i| format!("n{i}")).collect();
    top.extend(lines);
    repo.write_file("f.txt", &joined(&top));
    core.refresh(session).await.unwrap();
    core.stage_lines(session, "f.txt", &whole(1), false, DiffOptions::default())
        .await
        .unwrap();
    let mut expect = base.clone();
    expect[4 * 6 + 2] = "  BETA-CHANGED".into();
    assert_eq!(repo.git_ok(["show", ":f.txt"]), joined(&expect));
}

/// 같은 수정이 두 블록에 있고 앞에 고르지 않은 hunk 가 있어도 고른 블록만 되돌린다
#[tokio::test]
async fn partial_discard_reverts_the_selected_block_of_a_repeating_file() {
    let core = core().await;
    let base = blocks(8);
    let (mut repo, session) = repo_with(&core, &base).await;
    let mut lines = base.clone();
    lines[2 * 6 + 2] = "  BETA-CHANGED".into();
    lines[4 * 6 + 2] = "  BETA-CHANGED".into();
    let mut top: Vec<String> = (0..12).map(|i| format!("n{i}")).collect();
    top.extend(lines);
    repo.write_file("f.txt", &joined(&top));
    core.refresh(session).await.unwrap();
    core.discard_lines(session, "f.txt", &whole(2), DiffOptions::default())
        .await
        .unwrap();
    let mut expect = top.clone();
    expect[12 + 4 * 6 + 2] = "  beta".into();
    assert_eq!(repo.read_file("f.txt"), joined(&expect));
}

/// unstage(-R --cached) 도 같은 위치 규칙을 따른다
#[tokio::test]
async fn partial_unstage_reverts_the_selected_block_of_a_repeating_file() {
    let core = core().await;
    let base = blocks(8);
    let (mut repo, session) = repo_with(&core, &base).await;
    let mut lines = base.clone();
    lines[2 * 6 + 2] = "  BETA-CHANGED".into();
    lines[4 * 6 + 2] = "  BETA-CHANGED".into();
    let mut top: Vec<String> = (0..12).map(|i| format!("n{i}")).collect();
    top.extend(lines);
    repo.write_file("f.txt", &joined(&top));
    repo.stage(&["f.txt"]);
    core.refresh(session).await.unwrap();
    core.stage_lines(session, "f.txt", &whole(2), true, DiffOptions::default())
        .await
        .unwrap();
    let mut expect = top.clone();
    expect[12 + 4 * 6 + 2] = "  beta".into();
    assert_eq!(repo.git_ok(["show", ":f.txt"]), joined(&expect));
}

/// 경로는 글롭이 아니다: `[id]` 폴더를 되돌려도 `i` 폴더는 그대로다 (백업 없는 손실 방지)
#[tokio::test]
async fn paths_are_literal_for_discard_and_stage() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("app/[id]/page.tsx", "o\n");
    repo.write_file("app/i/page.tsx", "o\n");
    repo.git_ok(["add", "-A"]);
    repo.commit_staged("pages");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("app/[id]/page.tsx", "mine\n");
    repo.write_file("app/i/page.tsx", "PRECIOUS\n");
    core.refresh(opened.session).await.unwrap();
    core.discard(opened.session, &["app/[id]/page.tsx".into()])
        .await
        .unwrap();
    assert_eq!(repo.read_file("app/i/page.tsx"), "PRECIOUS\n");
    assert_eq!(repo.read_file("app/[id]/page.tsx"), "o\n");

    repo.write_file("app/[id]/page.tsx", "again\n");
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &["app/[id]/page.tsx".into()])
        .await
        .unwrap();
    assert_eq!(
        repo.git_ok(["diff", "--cached", "--name-only"]).trim(),
        "app/[id]/page.tsx"
    );

    // `:` 로 시작하는 파일도 경로 그대로다
    repo.write_file(":memory:", "m\n");
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &[":memory:".into()])
        .await
        .unwrap();
    core.unstage(opened.session, &[":memory:".into()])
        .await
        .unwrap();
    core.stage_all(opened.session).await.unwrap();
    core.unstage_all(opened.session).await.unwrap();
    assert!(
        repo.git_ok(["diff", "--cached", "--name-only"]).is_empty(),
        "stage_all·unstage_all 의 `.` 은 리터럴에서도 전체다"
    );
}

/// 백업할 수 없는 폴더는 지우지 않고, 함께 고른 파일도 건드리지 않는다
#[tokio::test]
async fn discard_refuses_untracked_directory_it_cannot_back_up() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("nested/s.txt", "s");
    let mut nested = TestRepo::at(&repo.path().join("nested"));
    nested.git_ok(["init", "-q", "-b", "main"]);
    nested.commit("nested work");
    repo.write_file("u.txt", "u");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(
        core.repo_state(opened.session)
            .unwrap()
            .status
            .entries
            .iter()
            .any(|e| e.path == "nested/" && e.is_untracked())
    );

    let err = core
        .discard(opened.session, &["u.txt".into(), "nested/".into()])
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("nested/")),
        "{err:?}"
    );
    assert!(repo.path().join("nested/.git").exists());
    assert_eq!(repo.read_file("u.txt"), "u", "함께 고른 파일도 그대로");
}

/// 끊긴 심볼릭 링크도 되돌리기로 지워진다 (조용히 남지 않는다)
#[cfg(unix)]
#[tokio::test]
async fn discard_removes_untracked_symlinks_without_following_them() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("dir/keep.txt", "keep");
    repo.git_ok(["add", "-A"]);
    repo.commit_staged("dir");
    std::os::unix::fs::symlink("dir", repo.path().join("link-to-dir")).unwrap();
    std::os::unix::fs::symlink("missing", repo.path().join("dangling")).unwrap();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    core.discard(opened.session, &["link-to-dir".into(), "dangling".into()])
        .await
        .unwrap();
    assert!(repo.path().join("link-to-dir").symlink_metadata().is_err());
    assert!(repo.path().join("dangling").symlink_metadata().is_err());
    assert_eq!(repo.read_file("dir/keep.txt"), "keep");
}

/// UTF-8 이 아닌 줄은 패치로 되돌릴 수 없으니 줄 단위 작업을 막고, 파일 단위는 바이트를 보존한다
#[tokio::test]
async fn partial_actions_refuse_non_utf8_hunks() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("e.txt", "ascii 1\nascii 2\nascii 3\n");
    repo.stage(&["e.txt"]);
    let base = repo.commit_staged("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let raw: &[u8] = b"ascii 1\n\xc7\xd1\xb1\xdb\nascii 2\nascii 3\n";
    std::fs::write(repo.path().join("e.txt"), raw).unwrap();
    core.refresh(opened.session).await.unwrap();
    let diff = core
        .work_tree_diff(opened.session, "e.txt", false, true)
        .await
        .unwrap()
        .unwrap();
    assert!(diff.non_utf8, "프런트가 줄 단위 버튼을 숨길 수 있어야 한다");

    let err = core
        .stage_lines(
            opened.session,
            "e.txt",
            &whole(0),
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    let err = core
        .discard_lines(opened.session, "e.txt", &whole(0), DiffOptions::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert_eq!(std::fs::read(repo.path().join("e.txt")).unwrap(), raw);
    assert_eq!(
        repo.git_bytes(["show", ":e.txt"]),
        repo.git_bytes(["show", &format!("{}:e.txt", base.to_hex())]),
        "index 는 그대로"
    );

    core.stage(opened.session, &["e.txt".into()]).await.unwrap();
    assert_eq!(repo.git_bytes(["show", ":e.txt"]), raw);
}

/// 7자 제목 밑줄은 충돌 마커가 아니다 (README 를 커밋할 수 있어야 한다)
#[tokio::test]
async fn heading_underline_is_not_a_conflict_marker() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("README.md", "Install\n=======\n\nrun\n");
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &["README.md".into()])
        .await
        .unwrap();
    assert!(core.verify_staged(opened.session).await.unwrap().is_empty());
    core.commit(
        opened.session,
        CommitSpec {
            message: "docs".into(),
            ..CommitSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(repo.git_ok(["log", "-1", "--format=%s"]).trim(), "docs");
}

/// 진짜 마커는 막되, 사용자가 고르면 커밋할 수 있다
#[tokio::test]
async fn conflict_markers_block_commit_unless_explicitly_allowed() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file(
        "fixture.txt",
        "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n",
    );
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &["fixture.txt".into()])
        .await
        .unwrap();
    let err = core
        .commit(
            opened.session,
            CommitSpec {
                message: "fixture".into(),
                ..CommitSpec::default()
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::ConflictMarkers { .. }), "{err:?}");
    core.commit(
        opened.session,
        CommitSpec {
            message: "fixture".into(),
            allow_conflict_markers: true,
            ..CommitSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(repo.git_ok(["log", "-1", "--format=%s"]).trim(), "fixture");
}

/// reword 입력란에 넣을 전체 메시지
#[tokio::test]
async fn commit_message_returns_full_body() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let oid = repo.commit("제목\n\n본문 줄\n둘째 줄\n");
    repo.commit("later");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert_eq!(
        core.commit_message(opened.session, &oid).await.unwrap(),
        "제목\n\n본문 줄\n둘째 줄"
    );
}

/// `log.showSignature=true` 여도 메시지에 서명 검증 줄이 섞이지 않는다
#[tokio::test]
async fn last_commit_message_ignores_show_signature() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let key = repo.path().join(".git/test-key");
    let status = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .status()
        .unwrap();
    assert!(status.success());
    let public = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let allowed = repo.path().join(".git/allowed-signers");
    std::fs::write(&allowed, format!("t@example.invalid {public}")).unwrap();
    repo.git_ok(["config", "gpg.format", "ssh"]);
    repo.git_ok(["config", "user.signingkey", key.to_str().unwrap()]);
    repo.git_ok([
        "config",
        "gpg.ssh.allowedSignersFile",
        allowed.to_str().unwrap(),
    ]);
    repo.write_file("s.txt", "s");
    repo.stage(&["s.txt"]);
    repo.git_ok(["commit", "-q", "-S", "-m", "signed subject"]);
    repo.git_ok(["config", "log.showSignature", "true"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert_eq!(
        core.last_commit_message(opened.session).await.unwrap(),
        "signed subject"
    );
}

/// 공백 무시 화면에서도 아직 index 에 없는 새 파일을 부분 stage 할 수 있다
#[tokio::test]
async fn stage_lines_of_untracked_file_with_ignored_whitespace() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("new.txt", "a\nb\n");
    core.refresh(opened.session).await.unwrap();
    let opts = DiffOptions {
        ignore_whitespace: true,
        context: 3,
    };
    core.stage_lines(opened.session, "new.txt", &whole(0), false, opts)
        .await
        .unwrap();
    assert_eq!(repo.git_ok(["show", ":new.txt"]), "a\nb\n");
}

/// 마커로 거부된 커밋도 진행 표시가 남지 않게 끝 이벤트를 보낸다
#[tokio::test]
async fn refused_commit_finishes_its_operation() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("m.txt", "<<<<<<< ours\n");
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &["m.txt".into()]).await.unwrap();
    let op = core
        .begin_operation(opened.session, "commit", "commit")
        .unwrap();
    let op_id = op.id;

    let err = core
        .commit(
            opened.session,
            CommitSpec {
                message: "x".into(),
                ..CommitSpec::default()
            },
            Some(op),
        )
        .await
        .unwrap_err();

    assert!(matches!(err, CoreError::ConflictMarkers { .. }), "{err:?}");
    wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, ok: false, .. } if *id == op_id),
    )
    .await;
}
