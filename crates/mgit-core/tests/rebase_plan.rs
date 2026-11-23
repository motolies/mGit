//! 인터랙티브 리베이스 (MRG-07), 빠른 이력 수정 (MRG-09), 워크트리 WIP (WT-06)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{CoreError, OpOutcome, RebaseAction, RebasePlan, RebaseStep, WorktreeSource};
use mgit_testkit::{Scenario, build};

/// `log --format=%s` 를 줄 목록으로 (최신 먼저)
fn subjects(repo: &mut mgit_testkit::TestRepo) -> Vec<String> {
    repo.git_ok(["log", "--format=%s"])
        .lines()
        .map(str::to_string)
        .collect()
}

#[tokio::test]
async fn interactive_plan_reorders_squashes_drops_and_rewords() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    repo.write_file("a.txt", "a");
    repo.commit("A");
    repo.write_file("b.txt", "b");
    repo.commit("B");
    repo.write_file("c.txt", "c");
    repo.commit("C");
    repo.write_file("d.txt", "d");
    repo.commit("D");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let commits = core
        .rebase_plan_commits(opened.session, Some("main"))
        .await
        .unwrap();
    assert_eq!(
        commits
            .iter()
            .map(|c| c.subject.as_str())
            .collect::<Vec<_>>(),
        ["A", "B", "C", "D"]
    );
    let by = |s: &str| commits.iter().find(|c| c.subject == s).unwrap().oid;

    // 순서: C, A(reword), B(fixup → A 에 합침), D(drop)
    let plan = RebasePlan {
        onto: Some("main".into()),
        steps: vec![
            RebaseStep {
                oid: by("C"),
                action: RebaseAction::Pick,
            },
            RebaseStep {
                oid: by("A"),
                action: RebaseAction::Reword {
                    message: "A reworded\n\nbody".into(),
                },
            },
            RebaseStep {
                oid: by("B"),
                action: RebaseAction::Fixup,
            },
            RebaseStep {
                oid: by("D"),
                action: RebaseAction::Drop,
            },
        ],
        autostash: false,
        update_refs: false,
        exec: None,
    };
    assert_eq!(
        core.rebase_interactive(opened.session, &plan)
            .await
            .unwrap(),
        OpOutcome::Clean
    );
    assert_eq!(subjects(&mut repo), ["A reworded", "C", "commit 1"]);
    assert!(repo.path().join("b.txt").exists(), "fixup 은 내용을 합친다");
    assert!(!repo.path().join("d.txt").exists(), "drop 은 커밋을 버린다");
    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%B", "HEAD"]).trim(),
        "A reworded\n\nbody"
    );
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
    // 백업 ref 가 남았다
    assert!(
        core.backup_refs(opened.session)
            .await
            .unwrap()
            .iter()
            .any(|b| b.branch == "topic")
    );

    // 플랜이 이력과 다르면 거부
    let stale = core.rebase_interactive(opened.session, &plan).await;
    assert!(matches!(stale, Err(CoreError::Invalid(_))));
}

#[tokio::test]
async fn edit_stops_and_continue_resumes() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    repo.write_file("a.txt", "a");
    repo.commit("A");
    repo.write_file("b.txt", "b");
    repo.commit("B");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let commits = core
        .rebase_plan_commits(opened.session, Some("main"))
        .await
        .unwrap();
    let plan = RebasePlan {
        onto: Some("main".into()),
        steps: vec![
            RebaseStep {
                oid: commits[0].oid,
                action: RebaseAction::Edit,
            },
            RebaseStep {
                oid: commits[1].oid,
                action: RebaseAction::Pick,
            },
        ],
        autostash: false,
        update_refs: false,
        exec: None,
    };
    // edit 에서 멈추면 git 은 비0 으로 끝난다 → 진행 중 작업(rebase)
    let r = core.rebase_interactive(opened.session, &plan).await;
    let st = core.repo_state(opened.session).unwrap();
    assert!(st.op.is_some(), "{r:?}");
    assert_eq!(repo.git_ok(["log", "-1", "--format=%s"]).trim(), "A");
    // 멈춘 커밋을 고치고 계속
    repo.write_file("a.txt", "a2");
    repo.stage(&["a.txt"]);
    repo.git_ok(["commit", "--amend", "--no-edit", "-q"]);
    core.refresh(opened.session).await.unwrap();
    core.op_continue(opened.session, false).await.unwrap();
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
    assert_eq!(subjects(&mut repo), ["B", "A", "commit 1"]);
    assert_eq!(repo.read_file("a.txt"), "a2");
}

#[tokio::test]
async fn reword_and_squash_into_parent_without_editor() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("a.txt", "a");
    repo.commit("A");
    repo.write_file("b.txt", "b");
    repo.commit("B");
    repo.write_file("c.txt", "c");
    repo.commit("C");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let oid_of = |repo: &mut mgit_testkit::TestRepo, s: &str| {
        mgit_core::Oid::from_hex(
            repo.git_ok(["log", "--format=%H", "--grep", &format!("^{s}$"), "-1"])
                .trim()
                .as_bytes(),
        )
        .unwrap()
    };

    // HEAD reword → amend
    let c = oid_of(&mut repo, "C");
    core.reword_commit(opened.session, &c, "C2").await.unwrap();
    assert_eq!(subjects(&mut repo), ["C2", "B", "A", "commit 1"]);
    // 가운데 커밋 reword → fixup=reword + autosquash, 내용은 그대로
    let a = oid_of(&mut repo, "A");
    core.reword_commit(opened.session, &a, "A2\n\nwhy")
        .await
        .unwrap();
    assert_eq!(subjects(&mut repo), ["C2", "B", "A2", "commit 1"]);
    assert_eq!(repo.read_file("a.txt"), "a");
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
    // 더티 작업 트리에서도 autostash 로 진행된다
    repo.write_file("dirty.txt", "x");
    core.refresh(opened.session).await.unwrap();
    let b = oid_of(&mut repo, "B");
    core.squash_into_parent(opened.session, &b).await.unwrap();
    assert_eq!(subjects(&mut repo), ["C2", "A2", "commit 1"]);
    assert!(repo.path().join("b.txt").exists());
    assert_eq!(repo.read_file("dirty.txt"), "x", "autostash 로 복원");
    // 루트는 합칠 수 없다
    let root = oid_of(&mut repo, "commit 1");
    assert!(matches!(
        core.squash_into_parent(opened.session, &root).await,
        Err(CoreError::Invalid(_))
    ));
}

/// c0 - target - merge(topic) - top. 머지 커밋에서만 들어간 파일(evil)이 있다
fn merged_history() -> (mgit_testkit::TestRepo, mgit_core::Oid, mgit_core::Oid) {
    let mut repo = build(Scenario::Linear(1));
    let target = repo.commit("target");
    repo.git_ok(["checkout", "-q", "-b", "topic", "HEAD~1"]);
    repo.commit("t1");
    repo.checkout("main");
    let merge = repo.merge(&["topic"], "merge topic");
    repo.write_file("evil.txt", "only in merge");
    repo.git_ok(["add", "-A"]);
    repo.git_ok(["commit", "-q", "--amend", "--no-edit"]);
    let merge = {
        let _ = merge;
        repo.head()
    };
    repo.commit("top");
    (repo, target, merge)
}

/// 머지가 낀 구간의 reword·squash 는 이력을 평탄화하지 않고 거부한다
#[tokio::test]
async fn reword_and_squash_refuse_ranges_with_merges() {
    let core = core().await;
    let (mut repo, target, merge) = merged_history();
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    for oid in [target, merge] {
        let err = core
            .reword_commit(opened.session, &oid, "new message")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Invalid(m) if m.contains("머지")),
            "{err:?}"
        );
    }
    let err = core
        .squash_into_parent(opened.session, &target)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("머지")),
        "{err:?}"
    );
    // 부모가 머지인 커밋을 합치는 경우도 같다
    let err = core
        .squash_into_parent(opened.session, &head)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("머지")),
        "{err:?}"
    );
    assert_eq!(repo.head(), head, "이력을 건드리지 않는다");
    assert!(repo.path().join("evil.txt").exists());
    assert!(!repo.path().join(".git/rebase-merge").exists());
}

/// 머지 위쪽의 선형 구간은 그대로 고칠 수 있다
#[tokio::test]
async fn reword_above_a_merge_keeps_the_merge() {
    let core = core().await;
    let (mut repo, _target, _merge) = merged_history();
    let above = repo.head();
    repo.commit("newest");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.reword_commit(opened.session, &above, "top reworded")
        .await
        .unwrap();

    assert_eq!(
        subjects(&mut repo)[..3],
        ["newest", "top reworded", "merge topic"]
    );
    assert_eq!(
        repo.git_ok(["rev-list", "--merges", "--count", "HEAD"])
            .trim(),
        "1"
    );
}

/// HEAD 밖 커밋을 고치려 하면 현재 브랜치를 그 커밋 쪽으로 rebase 하지 않는다
#[tokio::test]
async fn reword_and_squash_refuse_commits_outside_head() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.commit("m1");
    repo.git_ok(["checkout", "-q", "-b", "side", "HEAD~1"]);
    repo.commit("s1");
    let s2 = repo.commit("s2");
    repo.checkout("main");
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let err = core
        .reword_commit(opened.session, &s2, "new")
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("현재 브랜치")),
        "{err:?}"
    );
    let err = core
        .squash_into_parent(opened.session, &s2)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("현재 브랜치")),
        "{err:?}"
    );
    assert_eq!(repo.head(), head);
}

/// `--update-refs`: 구간 안의 다른 브랜치도 새 커밋으로 옮겨 간다. 다른 워크트리 브랜치는 그대로다
#[tokio::test]
async fn interactive_plan_updates_stacked_branches() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    repo.commit("A");
    repo.commit("B");
    repo.branch("stack");
    repo.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "elsewhere",
        "../wt-elsewhere",
        "HEAD",
    ]);
    repo.commit("C");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let commits = core
        .rebase_plan_commits(opened.session, Some("main"))
        .await
        .unwrap();
    let elsewhere_before = repo.git_ok(["rev-parse", "elsewhere"]);

    let plan = RebasePlan {
        onto: Some("main".into()),
        steps: commits
            .iter()
            .map(|c| RebaseStep {
                oid: c.oid,
                action: if c.subject == "A" {
                    RebaseAction::Drop
                } else {
                    RebaseAction::Pick
                },
            })
            .collect(),
        autostash: false,
        update_refs: true,
        exec: None,
    };
    core.rebase_interactive(opened.session, &plan)
        .await
        .unwrap();

    assert_eq!(subjects(&mut repo)[..2], ["C", "B"]);
    assert_eq!(
        repo.git_ok(["log", "--format=%s", "-1", "stack"]).trim(),
        "B"
    );
    assert_eq!(
        repo.git_ok(["rev-parse", "stack"]),
        repo.git_ok(["rev-parse", "HEAD~1"]),
        "stack 이 새 커밋을 가리킨다"
    );
    assert_eq!(repo.git_ok(["rev-parse", "elsewhere"]), elsewhere_before);
}

/// 합쳐지는 커밋에 브랜치가 있으면 합친 결과를 가리킨다
#[tokio::test]
async fn update_refs_follow_the_end_of_a_squash_chain() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    repo.commit("A");
    repo.branch("stack");
    repo.commit("B");
    repo.commit("C");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let commits = core
        .rebase_plan_commits(opened.session, Some("main"))
        .await
        .unwrap();
    let plan = RebasePlan {
        onto: Some("main".into()),
        steps: commits
            .iter()
            .map(|c| RebaseStep {
                oid: c.oid,
                action: if c.subject == "B" {
                    RebaseAction::Fixup
                } else {
                    RebaseAction::Pick
                },
            })
            .collect(),
        autostash: false,
        update_refs: true,
        exec: None,
    };
    core.rebase_interactive(opened.session, &plan)
        .await
        .unwrap();
    assert_eq!(subjects(&mut repo)[..2], ["C", "A"]);
    assert_eq!(
        repo.git_ok(["rev-parse", "stack"]),
        repo.git_ok(["rev-parse", "HEAD~1"]),
    );
}

/// 플랜 조회가 구간의 머지를 알려 프런트가 평탄화를 경고할 수 있다
#[tokio::test]
async fn rebase_plan_info_reports_merges_in_range() {
    let core = core().await;
    let (mut repo, target, merge) = merged_history();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let parent = repo.git_ok(["rev-parse", &format!("{}^", target.to_hex())]);

    let info = core
        .rebase_plan_info(opened.session, Some(parent.trim()))
        .await
        .unwrap();
    assert!(info.has_merges, "{info:?}");
    assert!(
        info.commits.iter().all(|c| c.oid != merge),
        "목록에는 머지가 없다"
    );

    let root = core.rebase_plan_info(opened.session, None).await.unwrap();
    assert!(root.has_merges, "루트까지의 구간");

    let above = core
        .rebase_plan_info(opened.session, Some(&merge.to_hex()))
        .await
        .unwrap();
    assert!(!above.has_merges, "{above:?}");
    assert_eq!(above.commits.len(), 1);
}

/// 앞쪽을 전부 drop 하고 squash·fixup 이 오면 합칠 커밋이 없다: git 을 돌리기 전에 거부한다
#[tokio::test]
async fn plan_with_squash_after_leading_drops_is_refused() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    repo.commit("A");
    repo.commit("B");
    repo.commit("C");
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let commits = core
        .rebase_plan_commits(opened.session, Some("main"))
        .await
        .unwrap();

    for merged in [RebaseAction::Squash, RebaseAction::Fixup] {
        let plan = RebasePlan {
            onto: Some("main".into()),
            steps: commits
                .iter()
                .map(|c| RebaseStep {
                    oid: c.oid,
                    action: match c.subject.as_str() {
                        "A" => RebaseAction::Drop,
                        "B" => merged.clone(),
                        _ => RebaseAction::Pick,
                    },
                })
                .collect(),
            autostash: false,
            update_refs: false,
            exec: None,
        };
        let err = core
            .rebase_interactive(opened.session, &plan)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
        assert!(!repo.path().join(".git/rebase-merge").exists());
        assert_eq!(repo.head(), head);
    }
}

#[tokio::test]
async fn worktree_wips_lists_dirty_worktrees() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let p1 = core.suggest_worktree_path(opened.session, "w1").unwrap();
    core.worktree_add(
        opened.session,
        &p1,
        WorktreeSource::NewBranch {
            name: "w1".into(),
            start: None,
        },
    )
    .await
    .unwrap();
    let p2 = core.suggest_worktree_path(opened.session, "w2").unwrap();
    core.worktree_add(
        opened.session,
        &p2,
        WorktreeSource::NewBranch {
            name: "w2".into(),
            start: None,
        },
    )
    .await
    .unwrap();
    assert!(core.worktree_wips(opened.session).await.unwrap().is_empty());
    std::fs::write(p2.join("new.txt"), "x").unwrap();
    repo.write_file("main-dirty.txt", "m");
    let wips = core.worktree_wips(opened.session).await.unwrap();
    assert_eq!(
        wips.len(),
        1,
        "현재 워크트리와 깨끗한 워크트리는 제외: {wips:?}"
    );
    assert_eq!(wips[0].branch.as_deref(), Some("w2"));
    assert_eq!(wips[0].summary.untracked, 1);
    assert_eq!(wips[0].head, repo.head());
}
