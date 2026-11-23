//! 스태시 (ST-01·03·04) 와 워크트리 (WT-01~05)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{CoreError, GitHint, RefKind, WorktreeSource, default_worktree_path};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn stash_push_apply_pop_drop_and_graph_label() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("f1.txt", "edited\n");
    repo.write_file("new.txt", "untracked\n");
    core.refresh(opened.session).await.unwrap();
    core.stash_push(opened.session, Some("작업 중"), true, false, &[])
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(!st.status.summary().has_changes());
    assert_eq!(st.refs.stashes.len(), 1);
    let stash = &st.refs.stashes[0];
    assert!(stash.includes_untracked);
    assert!(stash.message.contains("작업 중"));
    assert_eq!(stash.branch.as_deref(), Some("main"));
    // 그래프에 stash 라벨이 붙는다 (ST-04)
    assert!(
        st.refs
            .labels
            .iter()
            .any(|l| l.kind == RefKind::Stash && l.target == stash.oid)
    );
    // mGit 이 만든 스태시는 워크트리 출처가 기록된다
    let listed = core.stashes(opened.session).unwrap();
    let canonical = repo.path().canonicalize().unwrap();
    assert_eq!(
        listed[0].1.as_deref(),
        Some(canonical.to_string_lossy().as_ref())
    );
    // 내용: 수정 파일 + untracked 파일
    let files = core.stash_files(opened.session, &stash.oid).await.unwrap();
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        paths.contains(&"f1.txt") && paths.contains(&"new.txt"),
        "{paths:?}"
    );

    core.stash_apply(opened.session, 0).await.unwrap();
    assert_eq!(repo.read_file("f1.txt"), "edited\n");
    assert_eq!(
        core.repo_state(opened.session).unwrap().refs.stashes.len(),
        1
    );
    repo.git_ok(["reset", "-q", "--hard"]);
    repo.remove_file("new.txt");
    core.refresh(opened.session).await.unwrap();

    core.stash_pop(opened.session, 0).await.unwrap();
    assert_eq!(repo.read_file("new.txt"), "untracked\n");
    assert!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .stashes
            .is_empty()
    );

    core.stash_push(opened.session, None, false, false, &["f1.txt".into()])
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.stashes.len(), 1);
    assert_eq!(
        st.status.summary().untracked,
        1,
        "경로 지정 스태시는 다른 파일을 남긴다"
    );
    core.stash_drop(opened.session, 0).await.unwrap();
    assert!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .stashes
            .is_empty()
    );
}

#[tokio::test]
async fn stash_pop_conflict_is_reported() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("f1.txt", "stashed\n");
    core.refresh(opened.session).await.unwrap();
    core.stash_push(opened.session, None, false, false, &[])
        .await
        .unwrap();
    repo.write_file("f1.txt", "local\n");
    repo.stage(&["f1.txt"]);
    repo.commit_staged("local change");
    core.refresh(opened.session).await.unwrap();
    let err = core.stash_pop(opened.session, 0).await.unwrap_err();
    assert_eq!(err.hint(), Some(&GitHint::Conflicts), "{err:?}");
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.status.summary().conflicted, 1);
    assert_eq!(st.refs.stashes.len(), 1, "충돌 시 스태시는 남는다");
}

#[tokio::test]
async fn worktree_add_check_remove_and_hint() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let suggested = core
        .suggest_worktree_path(opened.session, "feature/x")
        .unwrap();
    let canonical = repo.path().canonicalize().unwrap();
    assert_eq!(suggested, default_worktree_path(&canonical, "feature/x"));
    assert!(suggested.ends_with("repo.worktrees/feature-x"));

    let path = core
        .worktree_add(
            opened.session,
            &suggested,
            WorktreeSource::NewBranch {
                name: "feature/x".into(),
                start: Some("main".into()),
            },
        )
        .await
        .unwrap();
    assert!(path.join("f1.txt").exists());
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.worktrees.len(), 2);
    let wt = st.refs.worktrees.iter().find(|w| !w.is_main).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("refs/heads/feature/x"));
    let label = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "feature/x")
        .unwrap();
    assert!(label.worktree_path.is_some());

    // 다른 워크트리의 브랜치는 checkout 거부 → 힌트 (WT-05)
    let err = core
        .checkout(
            opened.session,
            mgit_core::CheckoutTarget::Branch("feature/x".into()),
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        err.hint(),
        Some(GitHint::BranchCheckedOutElsewhere { .. })
    ));

    // 더티·미push 검사
    std::fs::write(path.join("dirty.txt"), "x").unwrap();
    let check = core
        .worktree_remove_check(opened.session, &path)
        .await
        .unwrap();
    assert!(check.dirty);
    assert_eq!(check.unpushed, None, "업스트림이 없으면 None");
    assert!(!check.is_main);
    assert_eq!(check.branch.as_deref(), Some("feature/x"));
    let main_check = core
        .worktree_remove_check(opened.session, repo.path())
        .await
        .unwrap();
    assert!(main_check.is_main);
    assert!(matches!(
        core.worktree_remove(opened.session, repo.path(), true, false)
            .await,
        Err(CoreError::Invalid(_))
    ));

    // 더티 워크트리는 force 없이는 거부된다
    assert!(
        core.worktree_remove(opened.session, &path, false, false)
            .await
            .is_err()
    );
    core.worktree_remove(opened.session, &path, true, true)
        .await
        .unwrap();
    assert!(!path.exists());
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.worktrees.len(), 1);
    assert!(!st.refs.labels.iter().any(|l| l.short_name == "feature/x"));

    // detached 워크트리 + prune
    let head = repo.head();
    let det = core
        .worktree_add(
            opened.session,
            &suggested.with_file_name("det"),
            WorktreeSource::Detached(head),
        )
        .await
        .unwrap();
    assert!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .worktrees
            .iter()
            .any(|w| w.detached)
    );
    std::fs::remove_dir_all(&det).unwrap();
    core.refresh(opened.session).await.unwrap();
    assert!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .worktrees
            .iter()
            .any(|w| w.prunable.is_some())
    );
    core.worktree_prune(opened.session).await.unwrap();
    assert_eq!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .worktrees
            .len(),
        1
    );
}

/// stash 경로도 글롭이 아니다. 리터럴 env 를 쓰면 `stash -u` 가 내부의 `clean :/` 을 못 돌리므로
/// 경로마다 `:(literal)` 로 넘긴다
#[tokio::test]
async fn stash_push_paths_are_literal_and_untracked_is_cleaned() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("a[bc].txt", "y\n");
    repo.write_file("ab.txt", "z\n");
    repo.git_ok(["add", "-A"]);
    repo.commit_staged("files");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("a[bc].txt", "y2\n");
    repo.write_file("ab.txt", "z2\n");
    core.refresh(opened.session).await.unwrap();
    core.stash_push(opened.session, None, false, false, &["a[bc].txt".into()])
        .await
        .unwrap();
    assert_eq!(repo.read_file("ab.txt"), "z2\n", "글롭에 걸리면 안 된다");
    assert_eq!(repo.read_file("a[bc].txt"), "y\n");

    // 경로 없는 -u 는 untracked 를 치운다
    repo.write_file("u.txt", "u\n");
    core.refresh(opened.session).await.unwrap();
    core.stash_push(opened.session, None, true, false, &[])
        .await
        .unwrap();
    assert!(!repo.path().join("u.txt").exists());
}
