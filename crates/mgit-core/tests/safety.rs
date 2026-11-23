//! 안전장치 (SF-03 Undo/Redo, SF-04 백업 ref, AD-02 reflog, ST-02, CHG-07·10, WT-08)
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{BACKUP_NS, CheckoutTarget, CommitTemplate, ResetMode, WorktreeSource};
use mgit_testkit::{Scenario, TestRepo, build};

#[tokio::test]
async fn undo_redo_restores_refs_after_reset_and_branch_delete() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(3));
    repo.branch("feat");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let head_before = repo.head();

    // reset --hard HEAD~1 → undo → 브랜치가 원래 커밋으로
    core.reset(opened.session, "HEAD~1", ResetMode::Hard)
        .await
        .unwrap();
    assert_ne!(repo.head(), head_before);
    let (entries, redo) = core.undo_entries(opened.session).unwrap();
    assert_eq!(redo, 0);
    assert!(entries[0].label.starts_with("reset --hard"), "{entries:?}");
    assert!(entries[0].changed >= 1);
    let undone = core.undo(opened.session).await.unwrap().unwrap();
    assert_eq!(undone.entry.label, entries[0].label);
    assert!(undone.skipped.is_empty());
    assert_eq!(repo.head(), head_before);
    assert_eq!(core.undo_entries(opened.session).unwrap().1, 1, "redo 가능");
    // redo → 다시 뒤로
    core.redo(opened.session).await.unwrap();
    assert_ne!(repo.head(), head_before);
    core.undo(opened.session).await.unwrap();
    assert_eq!(repo.head(), head_before);

    // 브랜치 삭제 → undo 로 복구 (백업 ref 도 생겼다)
    core.delete_branch(opened.session, "feat", true)
        .await
        .unwrap();
    assert!(
        repo.git(["rev-parse", "--verify", "refs/heads/feat"])
            .status
            .code()
            != Some(0)
    );
    let backups = core.backup_refs(opened.session).await.unwrap();
    assert!(backups.iter().any(|b| b.branch == "feat"), "{backups:?}");
    core.undo(opened.session).await.unwrap();
    assert_eq!(
        repo.git_ok(["rev-parse", "refs/heads/feat"]).trim(),
        head_before.to_hex()
    );

    // stage 만 하는 명령은 undo 항목을 만들지 않는다
    let n = core.undo_entries(opened.session).unwrap().0.len();
    repo.write_file("x.txt", "x");
    core.refresh(opened.session).await.unwrap();
    core.stage(opened.session, &["x.txt".into()]).await.unwrap();
    assert_eq!(core.undo_entries(opened.session).unwrap().0.len(), n);

    // 백업 ref 는 그래프에 보이지 않는다
    let st = core.repo_state(opened.session).unwrap();
    assert!(
        !st.refs
            .labels
            .iter()
            .any(|l| l.full_name.starts_with(BACKUP_NS))
    );
}

#[tokio::test]
async fn backup_ref_before_rebase_and_restore_prune() {
    let core = core().await;
    let mut repo = build(Scenario::BranchMerge);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.checkout_new("topic");
    repo.commit("t1");
    core.refresh(opened.session).await.unwrap();
    let topic_before = repo.head();

    core.rebase(opened.session, "main", false).await.unwrap();
    let backups = core.backup_refs(opened.session).await.unwrap();
    let b = backups.iter().find(|b| b.branch == "topic").unwrap();
    assert_eq!(b.oid, topic_before);
    assert!(b.name.starts_with("refs/mgit/backup/topic/"));
    let before_log = repo.git_ok(["log", "--oneline", "--all"]);
    assert!(!before_log.contains("mgit backup"));

    // 새 브랜치로 복원
    core.backup_restore(opened.session, &b.name, Some("topic-before"))
        .await
        .unwrap();
    assert_eq!(
        repo.git_ok(["rev-parse", "refs/heads/topic-before"]).trim(),
        topic_before.to_hex()
    );
    // 원래 브랜치 되돌리기
    core.backup_restore(opened.session, &b.name, None)
        .await
        .unwrap();
    assert_eq!(repo.head(), topic_before);
    // 삭제. 체크아웃된 브랜치의 복원은 reset 이라 새 백업이 생길 수 있으니 전부 지운다
    core.backup_delete(opened.session, &b.name).await.unwrap();
    assert!(
        core.backup_refs(opened.session)
            .await
            .unwrap()
            .iter()
            .all(|x| x.name != b.name)
    );
    for rest in core.backup_refs(opened.session).await.unwrap() {
        core.backup_delete(opened.session, &rest.name)
            .await
            .unwrap();
    }
    // 오래된 백업 정리: 만든 지 100일 지난 ref 를 흉내 낸다
    let old = format!("{BACKUP_NS}topic/{}", 1_000_000);
    repo.git_ok(["update-ref", &old, &topic_before.to_hex()]);
    assert_eq!(core.prune_backups(opened.session).await.unwrap(), 1);
    assert!(core.backup_refs(opened.session).await.unwrap().is_empty());
}

#[tokio::test]
async fn reflog_lists_and_restores() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let second = repo.head();
    core.reset(opened.session, "HEAD~1", ResetMode::Hard)
        .await
        .unwrap();
    let log = core.reflog(opened.session, None, 50).await.unwrap();
    assert!(log.len() >= 3, "{log:?}");
    assert!(log[0].selector.starts_with("HEAD@{0}"));
    assert!(log[0].subject.starts_with("reset:"), "{:?}", log[0].subject);
    let lost = log.iter().find(|e| e.oid == second).unwrap();
    core.reflog_restore(opened.session, &lost.oid, "recovered")
        .await
        .unwrap();
    assert_eq!(
        repo.git_ok(["rev-parse", "refs/heads/recovered"]).trim(),
        second.to_hex()
    );
    let main_log = core.reflog(opened.session, Some("main"), 10).await.unwrap();
    assert!(main_log.iter().all(|e| e.selector.starts_with("main@{")));
    assert!(
        core.reflog(opened.session, Some("nope"), 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn staged_stash_ignore_and_templates() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // ST-02: staged 만 stash
    repo.write_file("f1.txt", "staged\n");
    repo.stage(&["f1.txt"]);
    repo.write_file("other.txt", "untracked\n");
    core.refresh(opened.session).await.unwrap();
    core.stash_push(opened.session, None, false, true, &[])
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.status.summary().staged, 0);
    assert_eq!(st.status.summary().untracked, 1, "untracked 는 남는다");
    assert_eq!(st.refs.stashes.len(), 1);

    // CHG-10: ignore 추가 → untracked 사라짐, 중복은 안 붙음
    core.ignore_add(opened.session, &["other.txt".into(), "*.log".into()])
        .await
        .unwrap();
    core.ignore_add(opened.session, &["*.log".into()])
        .await
        .unwrap();
    assert_eq!(repo.read_file(".gitignore"), "other.txt\n*.log\n");
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(
        st.status.summary().untracked,
        1,
        ".gitignore 자신만 untracked"
    );

    // CHG-07: commit.template + 앱 템플릿
    repo.write_file("tmpl.txt", "feat: \n\n# 본문\n");
    repo.git_ok(["config", "commit.template", "tmpl.txt"]);
    core.set_app_commit_templates(&[CommitTemplate {
        name: "fix".into(),
        body: "fix: ".into(),
    }])
    .unwrap();
    let t = core.commit_templates(opened.session).await.unwrap();
    assert_eq!(t.len(), 2);
    assert!(t[0].name.contains("commit.template"));
    assert_eq!(t[0].body, "feat: \n\n# 본문\n");
    assert_eq!(t[1].name, "fix");
}

#[tokio::test]
async fn worktree_lock_unlock_and_checkout_hint_detached() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let path = core.suggest_worktree_path(opened.session, "wt").unwrap();
    core.worktree_add(
        opened.session,
        &path,
        WorktreeSource::NewBranch {
            name: "wt".into(),
            start: None,
        },
    )
    .await
    .unwrap();
    core.worktree_lock(opened.session, &path, Some("외장 드라이브"))
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    let wt = st.refs.worktrees.iter().find(|w| !w.is_main).unwrap();
    assert_eq!(wt.locked.as_deref(), Some("외장 드라이브"));
    core.worktree_unlock(opened.session, &path).await.unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(
        st.refs
            .worktrees
            .iter()
            .find(|w| !w.is_main)
            .unwrap()
            .locked
            .is_none()
    );

    // SF-05: detached 에서 push → DetachedHead 힌트 (원격 없이도 분류)
    core.checkout(opened.session, CheckoutTarget::Commit(repo.head()), false)
        .await
        .unwrap();
    let err = core
        .push(opened.session, mgit_core::PushSpec::default(), None)
        .await
        .unwrap_err();
    assert!(matches!(err, mgit_core::CoreError::Invalid(_)));
    assert_eq!(
        mgit_model::classify_stderr("fatal: You are not currently on a branch."),
        Some(mgit_model::GitHint::DetachedHead)
    );
    assert_eq!(
        mgit_model::classify_stderr("fatal: The current branch x has no upstream branch."),
        Some(mgit_model::GitHint::NoUpstream)
    );
}

/// 저장소를 연다
async fn opened(core: &mgit_core::Core, repo: &TestRepo) -> mgit_core::SessionId {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    opened.session
}

/// undo 는 그 작업이 바꾼 ref 만 되돌린다. 터미널의 커밋·새 브랜치는 그대로다
#[tokio::test]
async fn undo_leaves_refs_the_operation_did_not_change() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let session = opened(&core, &repo).await;
    core.create_branch(session, "mgit-op", None, false)
        .await
        .unwrap();

    let terminal = repo.commit("terminal work");
    repo.branch("terminal-branch");
    let undone = core.undo(session).await.unwrap().unwrap();

    assert!(undone.skipped.is_empty(), "{undone:?}");
    assert_eq!(repo.head(), terminal, "main 은 터미널 커밋 그대로");
    assert_eq!(
        repo.git_ok(["rev-parse", "refs/heads/terminal-branch"])
            .trim(),
        terminal.to_hex()
    );
    assert!(
        !repo
            .git(["rev-parse", "--verify", "refs/heads/mgit-op"])
            .status
            .success()
    );
}

/// 작업 뒤에 외부에서 또 바뀐 ref 는 되돌리지 않고 결과로 알린다
#[tokio::test]
async fn undo_skips_ref_moved_after_the_operation_and_reports_it() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(3));
    let session = opened(&core, &repo).await;
    core.reset(session, "HEAD~1", ResetMode::Hard)
        .await
        .unwrap();
    let external = repo.commit("external");

    let undone = core.undo(session).await.unwrap().unwrap();

    assert_eq!(undone.skipped, ["refs/heads/main"]);
    assert_eq!(repo.head(), external, "외부 커밋을 덮지 않는다");
    assert_eq!(
        core.undo_entries(session).unwrap().1,
        0,
        "아무것도 되돌리지 못했으면 redo 도 없다"
    );
}

/// redo 도 같은 규칙이다: undo 뒤 외부에서 같은 이름을 만들었으면 건너뛴다
#[tokio::test]
async fn redo_skips_ref_changed_after_undo() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let session = opened(&core, &repo).await;
    core.create_branch(session, "x", Some("HEAD~1"), false)
        .await
        .unwrap();
    core.undo(session).await.unwrap().unwrap();
    repo.branch("x");

    let redone = core.redo(session).await.unwrap().unwrap();

    assert_eq!(redone.skipped, ["refs/heads/x"]);
    assert_eq!(
        repo.git_ok(["rev-parse", "refs/heads/x"]).trim(),
        repo.head().to_hex()
    );
}

/// 적용이 실패하면 항목을 잃지 않는다
#[tokio::test]
async fn failed_undo_keeps_the_entry() {
    let core = core().await;
    let repo = build(Scenario::Linear(3));
    let session = opened(&core, &repo).await;
    core.reset(session, "HEAD~1", ResetMode::Soft)
        .await
        .unwrap();
    let lock = repo.path().join(".git/refs/heads/main.lock");
    std::fs::write(&lock, "").unwrap();

    assert!(core.undo(session).await.is_err());

    let (entries, redo) = core.undo_entries(session).unwrap();
    assert_eq!((entries.len(), redo), (1, 0), "{entries:?}");
    std::fs::remove_file(&lock).unwrap();
    assert!(core.undo(session).await.unwrap().is_some());
}

/// UTF-8 이 아닌 `.gitignore` 도 기존 바이트를 보존하고 덧붙인다
#[tokio::test]
async fn ignore_add_appends_to_non_utf8_gitignore() {
    let core = core().await;
    let repo = build(Scenario::Linear(1));
    let raw: &[u8] = b"# \xc7\xd1\xb1\xdb \xc1\xd6\xbc\xae\nsecrets/\n";
    let path = repo.path().join(".gitignore");
    std::fs::write(&path, raw).unwrap();
    let session = opened(&core, &repo).await;

    core.ignore_add(session, &["*.log".into()]).await.unwrap();
    let mut expect = raw.to_vec();
    expect.extend_from_slice(b"*.log\n");
    assert_eq!(std::fs::read(&path).unwrap(), expect);

    core.ignore_add(session, &["secrets/".into()])
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        expect,
        "이미 있으면 안 붙인다"
    );
}

/// 읽지 못한 파일을 빈 파일로 보고 덮어쓰면 안 된다
#[cfg(unix)]
#[tokio::test]
async fn ignore_add_reports_read_failure_instead_of_overwriting() {
    use std::os::unix::fs::PermissionsExt;
    let core = core().await;
    let repo = build(Scenario::Linear(1));
    let path = repo.path().join(".gitignore");
    std::fs::write(&path, "keep\n").unwrap();
    let session = opened(&core, &repo).await;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o200)).unwrap();

    let result = core.ignore_add(session, &["*.log".into()]).await;

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(result.is_err(), "{result:?}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep\n");
}

/// 체크아웃된 브랜치의 복원은 확인 창 문구대로 작업 트리까지 되돌린다
#[tokio::test]
async fn backup_restore_of_checked_out_branch_resets_work_tree() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let tip = repo.head();
    let session = opened(&core, &repo).await;
    core.reset(session, "HEAD~1", ResetMode::Hard)
        .await
        .unwrap();
    assert!(!repo.path().join("f2.txt").exists());
    let backup = core.backup_refs(session).await.unwrap().remove(0);
    assert_eq!(backup.oid, tip);

    core.backup_restore(session, &backup.name, None)
        .await
        .unwrap();

    assert_eq!(repo.head(), tip);
    assert!(repo.path().join("f2.txt").exists(), "작업 트리도 돌아온다");
    assert!(
        repo.git_ok(["status", "--porcelain"]).is_empty(),
        "update-ref 만 하면 역변경이 staged 로 남는다"
    );
}

/// 다른 워크트리에 체크아웃된 브랜치는 복원을 거부한다
#[tokio::test]
async fn backup_restore_refuses_branch_checked_out_in_other_worktree() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let wt_path = repo.add_worktree("wt", Some("wt-branch"));
    let session = opened(&core, &repo).await;
    let backup = core
        .backup_ref(session, "wt-branch", "test")
        .await
        .unwrap()
        .unwrap();
    let mut wt = TestRepo::at(&wt_path);
    let moved = wt.commit("in worktree");

    let err = core
        .backup_restore(session, &backup.name, None)
        .await
        .unwrap_err();

    assert!(
        matches!(&err, mgit_core::CoreError::Invalid(m) if m.contains("워크트리")),
        "{err:?}"
    );
    assert_eq!(wt.head(), moved);
}

/// 어디에도 체크아웃되지 않은 브랜치는 ref 만 옮긴다
#[tokio::test]
async fn backup_restore_of_idle_branch_moves_only_the_ref() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.git_ok(["branch", "idle", "HEAD~1"]);
    let idle_before = repo.git_ok(["rev-parse", "idle"]);
    let head = repo.head();
    let session = opened(&core, &repo).await;
    let backup = core
        .backup_ref(session, "idle", "test")
        .await
        .unwrap()
        .unwrap();
    repo.git_ok(["branch", "-f", "idle", "HEAD"]);
    repo.write_file("dirty.txt", "keep");

    core.backup_restore(session, &backup.name, None)
        .await
        .unwrap();

    assert_eq!(repo.git_ok(["rev-parse", "idle"]), idle_before);
    assert_eq!(repo.head(), head);
    assert!(repo.path().join("dirty.txt").exists());
}

/// 같은 초에 만든 백업이 서로를 덮지 않고, 최근 것이 앞에 온다
#[tokio::test]
async fn backups_in_the_same_second_are_all_kept() {
    let core = core().await;
    let repo = mgit_testkit::build(mgit_testkit::Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    let a = core.backup_ref(id, "main", "첫째").await.unwrap().unwrap();
    let b = core.backup_ref(id, "main", "둘째").await.unwrap().unwrap();
    assert_ne!(a.name, b.name);
    let list = core.backup_refs(id).await.unwrap();
    assert_eq!(list.len(), 2, "{list:?}");
    assert_eq!(list[0].name, b.name, "{list:?}");
    assert!(list.iter().all(|x| x.branch == "main" && x.created_at > 0));
}
