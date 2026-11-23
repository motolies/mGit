//! 충돌 예방 (CF-01~05)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{MergeMode, OpOutcome, RadarKind};
use mgit_testkit::{Scenario, build};

/// main 과 side 가 같은 파일을 다르게 고친 저장소 (+ 충돌 없는 add 브랜치)
fn conflicting_repo() -> mgit_testkit::TestRepo {
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("f.txt", "a\n");
    repo.stage(&["f.txt"]);
    repo.commit_staged("base f");
    repo.checkout_new("side");
    repo.write_file("f.txt", "b\n");
    repo.stage(&["f.txt"]);
    repo.commit_staged("side f");
    repo.checkout("main");
    repo.checkout_new("add");
    repo.write_file("new.txt", "n\n");
    repo.stage(&["new.txt"]);
    repo.commit_staged("add new");
    repo.checkout("main");
    repo.write_file("f.txt", "c\n");
    repo.stage(&["f.txt"]);
    repo.commit_staged("main f");
    repo
}

#[tokio::test]
async fn preview_simulate_radar_and_rebase_prediction() {
    let core = core().await;
    let mut repo = conflicting_repo();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // CF-01 미리보기
    let p = core
        .merge_preview(opened.session, "side", &[], false)
        .await
        .unwrap();
    assert!(!p.clean);
    assert_eq!(p.conflicts, vec!["f.txt"]);
    assert!(p.messages.iter().any(|m| m.contains("CONFLICT")));
    let content = core
        .preview_file(opened.session, &p.tree, "f.txt")
        .await
        .unwrap();
    assert!(content.contains("<<<<<<<") && content.contains(">>>>>>>"));
    let clean = core
        .merge_preview(opened.session, "add", &[], false)
        .await
        .unwrap();
    assert!(clean.clean && clean.conflicts.is_empty());
    // CF-04 옵션: ours 면 충돌 없음, 잘못된 옵션은 거부
    let ours = core
        .merge_preview(opened.session, "side", &["ours".into()], false)
        .await
        .unwrap();
    assert!(ours.clean);
    assert!(
        core.merge_preview(opened.session, "side", &["rm -rf".into()], false)
            .await
            .is_err()
    );
    let sim = core
        .merge_simulate(opened.session, "side", false)
        .await
        .unwrap();
    assert_eq!(sim.len(), 6);
    assert!(!sim[0].clean);
    assert!(sim.iter().any(|s| s.strategy == vec!["ours"] && s.clean));

    // WIP 포함: 작업 트리 변경이 충돌을 만든다
    repo.write_file("new.txt", "local\n");
    core.refresh(opened.session).await.unwrap();
    let with_wip = core
        .merge_preview(opened.session, "add", &[], true)
        .await
        .unwrap();
    assert!(with_wip.wip_included);
    assert!(!with_wip.clean, "{with_wip:?}");
    assert_eq!(with_wip.conflicts, vec!["new.txt"]);
    repo.remove_file("new.txt");
    core.refresh(opened.session).await.unwrap();

    // CF-02 레이더: side 는 충돌, add 는 깨끗
    let radar = core
        .conflict_radar(opened.session, 10, false)
        .await
        .unwrap();
    let side = radar.iter().find(|r| r.reference == "side").unwrap();
    assert!(!side.clean);
    assert_eq!(side.kind, RadarKind::Local);
    assert_eq!(side.behind, 1);
    assert_eq!(side.ahead, 1);
    let add = radar.iter().find(|r| r.reference == "add").unwrap();
    assert!(add.clean);
    assert!(
        core.conflict_radar(opened.session, 1, false)
            .await
            .unwrap()
            .len()
            <= 1
    );

    // CF-03 rebase 예측: main 의 "main f" 를 side 위에 얹으면 충돌
    let steps = core.rebase_preview(opened.session, "side").await.unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].subject, "main f");
    assert!(!steps[0].clean);
    assert_eq!(steps[0].conflicts, vec!["f.txt"]);
    let steps = core.rebase_preview(opened.session, "add").await.unwrap();
    assert_eq!(steps.len(), 1);
    assert!(steps[0].clean && !steps[0].approximate);
}

#[tokio::test]
async fn isolated_merge_apply_and_discard() {
    let core = core().await;
    let repo = conflicting_repo();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let head_before = core
        .repo_state(opened.session)
        .unwrap()
        .refs
        .head
        .oid()
        .unwrap();

    // 충돌하는 branch: 격리 워크트리에 충돌 상태로 남고, 작업 트리는 그대로
    let iso = core
        .isolated_merge(opened.session, "side", MergeMode::Default)
        .await
        .unwrap();
    assert_eq!(iso.outcome, OpOutcome::Conflicts);
    assert!(iso.worktree.join("f.txt").exists());
    assert!(iso.branch.starts_with("mgit/isolated-"));
    assert_eq!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .head
            .oid()
            .unwrap(),
        head_before
    );
    let (sink2, mut rx2) = collector();
    let wt = core.open_repo(&iso.worktree, sink2).await.unwrap();
    wait_finished(&mut rx2, wt.session).await;
    assert!(core.isolated_info(wt.session).unwrap().is_some());
    assert!(core.isolated_info(opened.session).unwrap().is_none());
    let main = core.isolated_discard(wt.session).await.unwrap();
    assert_eq!(main, repo.path().canonicalize().unwrap());
    let _ = core.close_repo(wt.session);
    assert!(!iso.worktree.exists());
    core.refresh(opened.session).await.unwrap();
    assert!(
        !core
            .repo_state(opened.session)
            .unwrap()
            .refs
            .labels
            .iter()
            .any(|l| l.short_name == iso.branch)
    );

    // 깨끗한 branch: 적용하면 메인 HEAD 가 전진한다
    let iso = core
        .isolated_merge(opened.session, "add", MergeMode::Default)
        .await
        .unwrap();
    assert_eq!(iso.outcome, OpOutcome::Clean);
    let (sink3, mut rx3) = collector();
    let wt = core.open_repo(&iso.worktree, sink3).await.unwrap();
    wait_finished(&mut rx3, wt.session).await;
    core.isolated_apply(wt.session).await.unwrap();
    let _ = core.close_repo(wt.session);
    core.refresh(opened.session).await.unwrap();
    assert!(repo.path().join("new.txt").exists());
    assert_ne!(
        core.repo_state(opened.session)
            .unwrap()
            .refs
            .head
            .oid()
            .unwrap(),
        head_before
    );
    assert!(!iso.worktree.exists());
}

/// 격리 merge 가 끝나지 않았으면 반영하지 않는다 (해결 내용이 지워지지 않게)
#[tokio::test]
async fn isolated_apply_refuses_unfinished_merge() {
    let core = core().await;
    let repo = conflicting_repo();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let iso = core
        .isolated_merge(opened.session, "side", MergeMode::Default)
        .await
        .unwrap();
    assert_eq!(iso.outcome, OpOutcome::Conflicts);
    let (sink2, mut rx2) = collector();
    let wt = core.open_repo(&iso.worktree, sink2).await.unwrap();
    wait_finished(&mut rx2, wt.session).await;

    // 충돌을 해결하고 add 만 했다
    std::fs::write(iso.worktree.join("f.txt"), "resolved by hand\n").unwrap();
    core.stage(wt.session, &["f.txt".into()]).await.unwrap();

    let err = core.isolated_apply(wt.session).await.unwrap_err();
    assert!(matches!(err, mgit_core::CoreError::Invalid(_)), "{err:?}");
    assert_eq!(
        std::fs::read_to_string(iso.worktree.join("f.txt")).unwrap(),
        "resolved by hand\n",
        "해결 내용이 남아 있다"
    );
}

/// 미커밋 변경이 있으면 반영하지 않는다 (워크트리를 --force 로 지우기 때문)
#[tokio::test]
async fn isolated_apply_refuses_uncommitted_changes() {
    let core = core().await;
    let repo = conflicting_repo();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let iso = core
        .isolated_merge(opened.session, "add", MergeMode::Default)
        .await
        .unwrap();
    assert_eq!(iso.outcome, OpOutcome::Clean);
    let (sink2, mut rx2) = collector();
    let wt = core.open_repo(&iso.worktree, sink2).await.unwrap();
    wait_finished(&mut rx2, wt.session).await;
    std::fs::write(iso.worktree.join("note.txt"), "keep me\n").unwrap();

    let err = core.isolated_apply(wt.session).await.unwrap_err();
    assert!(matches!(err, mgit_core::CoreError::Invalid(_)), "{err:?}");
    assert!(iso.worktree.join("note.txt").exists());
}

/// 메인 워크트리가 다른 브랜치로 옮겨 갔으면 그 브랜치에 반영하지 않는다
#[tokio::test]
async fn isolated_apply_refuses_when_main_worktree_moved_to_other_branch() {
    let core = core().await;
    let mut repo = conflicting_repo();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let iso = core
        .isolated_merge(opened.session, "add", MergeMode::Default)
        .await
        .unwrap();
    let (sink2, mut rx2) = collector();
    let wt = core.open_repo(&iso.worktree, sink2).await.unwrap();
    wait_finished(&mut rx2, wt.session).await;

    // main 은 격리 브랜치의 조상이다. side2 를 main 에서 만들어 ff-only 가 성공할 수 있게 한다
    repo.git_ok(["switch", "-q", "-c", "side2", "main"]);
    let before = repo.head();

    let err = core.isolated_apply(wt.session).await.unwrap_err();

    assert!(
        matches!(&err, mgit_core::CoreError::Invalid(m) if m.contains("main")),
        "{err:?}"
    );
    assert_eq!(
        repo.head(),
        before,
        "다른 브랜치가 fast-forward 되면 안 된다"
    );
    assert!(iso.worktree.exists(), "격리 워크트리는 남는다");

    // 원래 브랜치로 돌아오면 반영된다
    repo.git_ok(["switch", "-q", "main"]);
    core.isolated_apply(wt.session).await.unwrap();
    assert!(repo.path().join("new.txt").exists());
    assert!(!iso.worktree.exists());
    assert!(
        repo.git_ok(["config", "--list"])
            .lines()
            .all(|l| !l.contains("mgitisolatedbase")),
        "시작 브랜치 기록은 격리 브랜치와 함께 사라진다"
    );
}

/// 링크된 워크트리에서 시작한 격리 병합은 메인 워크트리의 브랜치에 반영하지 않는다
#[tokio::test]
async fn isolated_apply_refuses_merge_started_from_linked_worktree() {
    let core = core().await;
    let mut repo = conflicting_repo();
    let linked = repo.add_worktree("linked", Some("feature"));
    let main_before = repo.head();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(&linked, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let iso = core
        .isolated_merge(opened.session, "add", MergeMode::Default)
        .await
        .unwrap();
    let (sink2, mut rx2) = collector();
    let wt = core.open_repo(&iso.worktree, sink2).await.unwrap();
    wait_finished(&mut rx2, wt.session).await;

    let err = core.isolated_apply(wt.session).await.unwrap_err();

    assert!(matches!(err, mgit_core::CoreError::Invalid(_)), "{err:?}");
    assert_eq!(repo.head(), main_before);
    core.isolated_discard(wt.session).await.unwrap();
}

/// 시작한 브랜치가 없으면 격리 병합을 시작하지 않는다
#[tokio::test]
async fn isolated_merge_refuses_detached_head() {
    let core = core().await;
    let mut repo = conflicting_repo();
    repo.checkout("HEAD~1");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let err = core
        .isolated_merge(opened.session, "add", MergeMode::Default)
        .await
        .unwrap_err();
    assert!(matches!(err, mgit_core::CoreError::Invalid(_)), "{err:?}");
}
