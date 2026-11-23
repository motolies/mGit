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

/// 범위 합치기 plan (프런트 `buildSquashRangePlan` 과 같은 조합, MRG-07): `commits` 는 `onto..HEAD` (todo 순서) 이고
/// 앞의 `range` 개가 범위다. 가장 오래된 commit 은 Reword, 범위의 나머지는 Fixup, 범위 뒤에서 HEAD 까지는 Pick
fn squash_range_plan(
    onto: Option<String>,
    commits: &[mgit_core::PlanCommit],
    range: usize,
    message: &str,
) -> RebasePlan {
    RebasePlan {
        onto,
        steps: commits
            .iter()
            .enumerate()
            .map(|(i, c)| RebaseStep {
                oid: c.oid,
                action: if i == 0 {
                    RebaseAction::Reword {
                        message: message.into(),
                    }
                } else if i < range {
                    RebaseAction::Fixup
                } else {
                    RebaseAction::Pick
                },
            })
            .collect(),
        autostash: true,
        update_refs: false,
        exec: None,
    }
}

/// 범위 합치기 관문 (MRG-07): 3개 범위가 사용자 메시지의 commit 하나가 되고, 트리는 범위 끝과 같고, 범위 뒤 commit 은
/// 내용·메시지가 보존되고, 백업과 Undo 항목이 남아 Undo 로 돌아온다
#[tokio::test]
async fn squash_range_folds_commits_into_one_with_user_message() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.checkout_new("topic");
    let a = repo.commit("A\n\nbody of A");
    repo.commit("B");
    let c = repo.commit("C");
    let d = repo.commit("D\n\nbody of D");
    let tree = |repo: &mut mgit_testkit::TestRepo, rev: &str| {
        repo.git_ok(["rev-parse", &format!("{rev}^{{tree}}")])
    };
    let tree_c = tree(&mut repo, &c.to_hex());
    let tree_d = tree(&mut repo, &d.to_hex());
    let author_a = repo.git_ok(["log", "-1", "--format=%an <%ae> %at", &a.to_hex()]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 프런트와 같은 순서: 범위 기준(older^)으로 plan 목록을 읽고, 머지가 없는지 본 뒤 plan 을 만든다
    let onto = repo.git_ok(["rev-parse", &format!("{}^", a.to_hex())]);
    let onto = onto.trim().to_string();
    let info = core
        .rebase_plan_info(opened.session, Some(&onto))
        .await
        .unwrap();
    assert!(!info.has_merges);
    assert_eq!(
        info.commits
            .iter()
            .map(|c| c.subject.as_str())
            .collect::<Vec<_>>(),
        ["A", "B", "C", "D"]
    );
    let message = "합친 제목\n\n합친 본문";
    let plan = squash_range_plan(Some(onto), &info.commits, 3, message);
    assert_eq!(
        core.rebase_interactive(opened.session, &plan)
            .await
            .unwrap(),
        OpOutcome::Clean
    );

    // 3개 → 1개, 메시지는 사용자 것 그대로
    assert_eq!(subjects(&mut repo), ["D", "합친 제목", "commit 1"]);
    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%B", "HEAD~1"])
            .trim_end(),
        message
    );
    // 트리는 범위 끝(C)과 같고, 범위 뒤 commit(D)은 트리·메시지가 그대로다
    assert_eq!(tree(&mut repo, "HEAD~1"), tree_c);
    assert_eq!(tree(&mut repo, "HEAD"), tree_d);
    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%B", "HEAD"]).trim_end(),
        "D\n\nbody of D"
    );
    // 작성자는 가장 오래된 commit 의 것 (git 기본)
    assert_eq!(
        repo.git_ok(["log", "-1", "--format=%an <%ae> %at", "HEAD~1"]),
        author_a
    );
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
    // 실행 전 branch 백업과 Undo 항목
    assert!(
        core.backup_refs(opened.session)
            .await
            .unwrap()
            .iter()
            .any(|b| b.branch == "topic" && b.oid == d)
    );
    let (entries, _) = core.undo_entries(opened.session).unwrap();
    assert_eq!(entries.first().map(|e| e.label.as_str()), Some("rebase -i"));
    // Undo 로 합치기 전 이력으로 돌아온다
    let undone = core.undo(opened.session).await.unwrap().unwrap();
    assert!(undone.skipped.is_empty(), "{undone:?}");
    assert_eq!(repo.head(), d);
    assert_eq!(subjects(&mut repo), ["D", "C", "B", "A", "commit 1"]);
}

/// 범위가 HEAD 까지면 Pick 없이 합치고, 첫 commit(root)이 들어가면 `--root` 로 합친다
#[tokio::test]
async fn squash_range_up_to_head_and_from_root() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.commit("A");
    repo.commit("B");
    let tree_head = repo.git_ok(["rev-parse", "HEAD^{tree}"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 범위 A..B (HEAD 까지): 범위 뒤 commit 이 없다
    let onto = repo.git_ok(["rev-parse", "HEAD~2"]).trim().to_string();
    let info = core
        .rebase_plan_info(opened.session, Some(&onto))
        .await
        .unwrap();
    let plan = squash_range_plan(Some(onto), &info.commits, 2, "AB");
    core.rebase_interactive(opened.session, &plan)
        .await
        .unwrap();
    assert_eq!(subjects(&mut repo), ["AB", "commit 1"]);
    assert_eq!(repo.git_ok(["rev-parse", "HEAD^{tree}"]), tree_head);

    // 범위 root..AB: 기준이 없으니 `--root` 로 전부 하나가 된다
    let info = core.rebase_plan_info(opened.session, None).await.unwrap();
    assert_eq!(info.commits.len(), 2);
    let plan = squash_range_plan(None, &info.commits, 2, "all in one");
    assert_eq!(
        core.rebase_interactive(opened.session, &plan)
            .await
            .unwrap(),
        OpOutcome::Clean
    );
    assert_eq!(subjects(&mut repo), ["all in one"]);
    assert_eq!(repo.git_ok(["rev-parse", "HEAD^{tree}"]), tree_head);
    assert!(core.repo_state(opened.session).unwrap().op.is_none());
}

/// 머지가 범위 안에 있거나 범위 위(HEAD 까지)에 있으면 plan 조회가 `has_merges` 로 알린다. 프런트는 이 값으로 합치기를
/// 거부한다 (실행하면 머지가 평탄화되므로)
#[tokio::test]
async fn squash_range_sees_merges_inside_or_above_the_range() {
    let core = core().await;
    // commit 1 - x1 - x2 - target - merge(topic) - top (topic 은 x2 에서 갈라진 t1)
    let mut repo = build(Scenario::Linear(1));
    let x1 = repo.commit("x1");
    repo.commit("x2");
    let target = repo.commit("target");
    repo.git_ok(["checkout", "-q", "-b", "topic", "HEAD~1"]);
    repo.commit("t1");
    repo.checkout("main");
    let merge = repo.merge(&["topic"], "merge topic");
    repo.commit("top");
    let head = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 범위 x1..x2: 범위 안은 선형이지만 위(HEAD 까지)에 머지가 있다
    let below = repo
        .git_ok(["rev-parse", &format!("{}^", x1.to_hex())])
        .trim()
        .to_string();
    let info = core
        .rebase_plan_info(opened.session, Some(&below))
        .await
        .unwrap();
    assert!(info.has_merges, "범위 위의 머지: {info:?}");
    // 범위 target..top: 머지가 범위 안에 있다
    let parent = repo
        .git_ok(["rev-parse", &format!("{}^", target.to_hex())])
        .trim()
        .to_string();
    let info = core
        .rebase_plan_info(opened.session, Some(&parent))
        .await
        .unwrap();
    assert!(info.has_merges, "범위 안의 머지: {info:?}");
    assert!(info.commits.iter().all(|c| c.oid != merge));
    // 머지 위의 선형 범위만이면 머지가 없다
    let info = core
        .rebase_plan_info(opened.session, Some(&merge.to_hex()))
        .await
        .unwrap();
    assert!(!info.has_merges);
    assert_eq!(repo.head(), head, "조회는 이력을 건드리지 않는다");
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
