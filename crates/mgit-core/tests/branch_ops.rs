//! 브랜치·태그 작업 (BR-02~06)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{CheckoutTarget, CoreError, GitHint, RefKind, is_not_fully_merged};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn create_checkout_rename_delete_branch() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.create_branch(opened.session, "feature", None, false)
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(st.refs.labels.iter().any(|l| l.short_name == "feature"));
    assert_eq!(st.refs.head.branch(), Some("refs/heads/main"));

    core.checkout(
        opened.session,
        CheckoutTarget::Branch("feature".into()),
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        core.repo_state(opened.session).unwrap().refs.head.branch(),
        Some("refs/heads/feature")
    );
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "feature"
    );

    core.rename_branch(opened.session, "feature", "renamed")
        .await
        .unwrap();
    assert_eq!(
        core.repo_state(opened.session).unwrap().refs.head.branch(),
        Some("refs/heads/renamed")
    );

    // 커밋을 하나 얹은 뒤 main 으로 돌아가 지우면 병합되지 않아 거부된다
    repo.write_file("x.txt", "x");
    repo.commit("on renamed");
    core.checkout(opened.session, CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    let err = core
        .delete_branch(opened.session, "renamed", false)
        .await
        .unwrap_err();
    assert!(is_not_fully_merged(&err), "{err:?}");
    core.delete_branch(opened.session, "renamed", true)
        .await
        .unwrap();
    assert!(
        !core
            .repo_state(opened.session)
            .unwrap()
            .refs
            .labels
            .iter()
            .any(|l| l.short_name == "renamed")
    );

    // 새 브랜치를 만들며 전환 + detached 체크아웃
    core.checkout(
        opened.session,
        CheckoutTarget::NewBranch {
            name: "topic".into(),
            start: Some("main".into()),
        },
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "topic"
    );
    let head = repo.head();
    core.checkout(opened.session, CheckoutTarget::Commit(head), false)
        .await
        .unwrap();
    assert!(matches!(
        core.repo_state(opened.session).unwrap().refs.head,
        mgit_core::HeadState::Detached { .. }
    ));

    assert!(matches!(
        core.create_branch(opened.session, "-bad", None, false)
            .await,
        Err(CoreError::Invalid(_))
    ));
}

#[tokio::test]
async fn dirty_checkout_fails_with_hint_and_stash_policy_carries_changes() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    repo.write_file("conflict.txt", "local edit\n");
    core.refresh(opened.session).await.unwrap();
    let err = core
        .checkout(
            opened.session,
            CheckoutTarget::Branch("other".into()),
            false,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err.hint(), Some(GitHint::DirtyWorkTree { .. })),
        "{err:?}"
    );

    // stash 후 전환: 전환은 되고 변경은 stash pop 으로 돌아오려다 충돌한다 (같은 파일)
    let res = core
        .checkout(opened.session, CheckoutTarget::Branch("other".into()), true)
        .await;
    assert_eq!(
        core.repo_state(opened.session).unwrap().refs.head.branch(),
        Some("refs/heads/other")
    );
    assert!(res.is_err(), "같은 파일을 고쳤으므로 pop 에서 충돌한다");
    assert!(
        core.repo_state(opened.session)
            .unwrap()
            .status
            .summary()
            .conflicted
            >= 1
    );
}

#[tokio::test]
async fn stash_policy_without_conflict_restores_changes() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.branch("side");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    repo.write_file("f1.txt", "edited\n");
    core.refresh(opened.session).await.unwrap();
    core.checkout(opened.session, CheckoutTarget::Branch("side".into()), true)
        .await
        .unwrap();
    assert_eq!(repo.read_file("f1.txt"), "edited\n");
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.head.branch(), Some("refs/heads/side"));
    assert_eq!(st.status.summary().unstaged, 1);
    assert!(st.refs.stashes.is_empty(), "pop 된 stash 는 사라진다");
}

#[tokio::test]
async fn remote_branch_checkout_creates_tracking_branch_and_upstream_toggle() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main:feature"]);
    repo.git_ok(["fetch", "-q", "origin"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.checkout(
        opened.session,
        CheckoutTarget::RemoteBranch {
            remote: "origin".into(),
            name: "feature".into(),
            local: None,
        },
        false,
    )
    .await
    .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    let feature = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "feature")
        .unwrap();
    assert_eq!(
        feature.upstream.as_deref(),
        Some("refs/remotes/origin/feature")
    );
    assert_eq!((feature.ahead, feature.behind), (Some(0), Some(0)));
    assert!(feature.is_current);

    core.set_upstream(opened.session, "feature", None)
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(
        st.refs
            .labels
            .iter()
            .find(|l| l.short_name == "feature")
            .unwrap()
            .upstream
            .is_none()
    );
    core.set_upstream(opened.session, "feature", Some("origin/feature"))
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert!(
        st.refs
            .labels
            .iter()
            .find(|l| l.short_name == "feature")
            .unwrap()
            .upstream
            .is_some()
    );

    // 이미 같은 원격을 추적하는 로컬이 있으면 그 브랜치로 전환만 한다
    core.checkout(opened.session, CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    core.checkout(
        opened.session,
        CheckoutTarget::RemoteBranch {
            remote: "origin".into(),
            name: "feature".into(),
            local: None,
        },
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "feature"
    );

    core.delete_remote_branch(opened.session, "origin", "feature")
        .await
        .unwrap();
    assert!(
        !core
            .repo_state(opened.session)
            .unwrap()
            .refs
            .labels
            .iter()
            .any(|l| l.short_name == "origin/feature")
    );
}

/// 원격이 둘이고 둘 다 같은 이름의 브랜치를 가질 때: 로컬이 다른 원격을 추적하면 묻고,
/// 다른 로컬 이름을 주면 그 이름의 추적 브랜치를 만든다 (BR-02)
#[tokio::test]
async fn remote_branch_checkout_with_same_name_on_other_remote() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.add_bare_remote();
    repo.add_bare_remote_named("fork");
    // fork/main 은 첫 커밋, origin/main 은 그 뒤 커밋. 로컬 main 은 origin/main 을 추적한다
    repo.git_ok(["push", "-q", "fork", "main"]);
    repo.write_file("later.txt", "later");
    repo.commit("later");
    repo.git_ok(["push", "-q", "-u", "origin", "main"]);
    repo.git_ok(["fetch", "-q", "--all"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let head_before = repo.head();
    let fork_main = repo.git_ok(["rev-parse", "fork/main"]);
    assert_ne!(
        fork_main.trim(),
        head_before.to_hex(),
        "두 원격의 main 은 달라야 한다"
    );

    // (a) 로컬 main 이 origin/main 을 추적하므로 fork/main 체크아웃은 git 을 돌리지 않고 거부한다
    let target = CheckoutTarget::RemoteBranch {
        remote: "fork".into(),
        name: "main".into(),
        local: None,
    };
    let err = core
        .checkout(opened.session, target.clone(), false)
        .await
        .unwrap_err();
    match err {
        CoreError::LocalBranchTracksOther {
            local,
            remote,
            name,
            upstream,
        } => {
            assert_eq!(
                (local.as_str(), remote.as_str(), name.as_str()),
                ("main", "fork", "main")
            );
            assert_eq!(upstream.as_deref(), Some("refs/remotes/origin/main"));
        }
        other => panic!("예상 밖 오류: {other:?}"),
    }
    assert_eq!(repo.head(), head_before, "HEAD 는 움직이지 않는다");
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "main"
    );

    // (b) 다른 로컬 이름을 주면 그 이름으로 추적 브랜치를 만들며 전환한다
    core.checkout(
        opened.session,
        CheckoutTarget::RemoteBranch {
            remote: "fork".into(),
            name: "main".into(),
            local: Some("fork-main".into()),
        },
        false,
    )
    .await
    .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.head.branch(), Some("refs/heads/fork-main"));
    let label = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/heads/fork-main")
        .unwrap();
    assert_eq!(label.upstream.as_deref(), Some("refs/remotes/fork/main"));
    assert_eq!(repo.head().to_hex(), fork_main.trim());

    // (c) 추적이 맞는 로컬이 이미 있으면 전환만 한다
    core.checkout(opened.session, CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    core.checkout(
        opened.session,
        CheckoutTarget::RemoteBranch {
            remote: "fork".into(),
            name: "main".into(),
            local: Some("fork-main".into()),
        },
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "fork-main"
    );

    // (d) 같은 이름의 로컬에 업스트림이 없어도, 이미 추적하는 다른 로컬이 있으면 그리로 간다
    core.checkout(opened.session, CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    core.set_upstream(opened.session, "main", None)
        .await
        .unwrap();
    core.checkout(opened.session, target.clone(), false)
        .await
        .unwrap();
    assert_eq!(
        repo.git_ok(["symbolic-ref", "--short", "HEAD"]).trim(),
        "fork-main"
    );

    // (e) 추적하는 로컬이 없으면 업스트림 없는 로컬은 어느 원격 것인지 알 수 없으므로 거부한다
    core.checkout(opened.session, CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    core.delete_branch(opened.session, "fork-main", true)
        .await
        .unwrap();
    let err = core
        .checkout(opened.session, target, false)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            CoreError::LocalBranchTracksOther { upstream: None, .. }
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn tags_lightweight_and_annotated() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.create_tag(opened.session, "light", None, None, false)
        .await
        .unwrap();
    core.create_tag(
        opened.session,
        "v1",
        Some("HEAD~1"),
        Some("릴리스 1\n\n본문"),
        false,
    )
    .await
    .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    let light = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "light")
        .unwrap();
    assert_eq!(light.kind, RefKind::Tag { annotated: false });
    assert_eq!(light.target, repo.head());
    let v1 = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "v1")
        .unwrap();
    assert_eq!(v1.kind, RefKind::Tag { annotated: true });
    assert_ne!(v1.target, repo.head());
    assert!(repo.git_ok(["tag", "-l", "-n1", "v1"]).contains("릴리스 1"));

    core.delete_tag(opened.session, "light").await.unwrap();
    assert!(
        !core
            .repo_state(opened.session)
            .unwrap()
            .refs
            .labels
            .iter()
            .any(|l| l.short_name == "light")
    );
}

/// 낡은 추적 브랜치를 지워도 원격의 같은 이름 태그는 건드리지 않는다
#[tokio::test]
async fn delete_remote_branch_never_touches_same_named_tag() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let remote = repo.add_bare_remote();
    let remote_str = remote.to_string_lossy().into_owned();
    repo.git_ok(["push", "-q", "origin", "main"]);
    repo.tag("v1", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1"]);
    let head = repo.head().to_hex();
    // 브랜치는 원격에서 이미 지워졌고 추적 ref 만 남았다
    repo.git_ok(["update-ref", "refs/remotes/origin/v1", &head]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 없는 브랜치를 전체 이름으로 지우면 git 은 경고만 낸다. 지켜야 할 것은 태그다
    let _ = core
        .delete_remote_branch(opened.session, "origin", "v1")
        .await;

    assert!(
        repo.git_ok(["ls-remote", "--tags", &remote_str])
            .contains("refs/tags/v1")
    );
}

/// 치울 변경이 없으면 예전 stash 를 꺼내지 않는다
#[tokio::test]
async fn stash_first_without_changes_keeps_older_stash() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.branch("b2");
    repo.write_file("f1.txt", "wip\n");
    repo.stash_push("오래된 작업", false);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.checkout(opened.session, CheckoutTarget::Branch("b2".into()), true)
        .await
        .unwrap();

    assert_eq!(
        repo.git_ok(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "b2"
    );
    assert_eq!(repo.git_ok(["stash", "list"]).lines().count(), 1);
    assert!(repo.git_ok(["status", "--porcelain"]).is_empty());
}

/// 이미 그 원격 브랜치를 추적하는 다른 이름의 로컬 브랜치가 있으면 그리로 전환한다
#[tokio::test]
async fn remote_checkout_switches_to_local_branch_already_tracking_it() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main:feature"]);
    repo.git_ok(["fetch", "-q", "origin"]);
    repo.git_ok(["branch", "--track", "wip", "origin/feature"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.checkout(
        opened.session,
        CheckoutTarget::RemoteBranch {
            remote: "origin".into(),
            name: "feature".into(),
            local: None,
        },
        false,
    )
    .await
    .unwrap();

    assert_eq!(
        repo.git_ok(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "wip"
    );
    assert!(
        !repo
            .git(["rev-parse", "--verify", "refs/heads/feature"])
            .status
            .success(),
        "같은 원격을 추적하는 브랜치를 또 만들지 않는다"
    );
}

/// `origin/feature` 라는 로컬 브랜치가 있어도 원격 브랜치를 전체 ref 로 가리켜 모호하지 않다
#[tokio::test]
async fn remote_checkout_is_not_ambiguous_with_local_branch_of_same_short_name() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.add_bare_remote();
    let remote_tip = repo.head();
    repo.git_ok(["push", "-q", "origin", "main:feature"]);
    repo.git_ok(["fetch", "-q", "origin"]);
    repo.git_ok(["branch", "origin/feature", "HEAD~1"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.checkout(
        opened.session,
        CheckoutTarget::RemoteBranch {
            remote: "origin".into(),
            name: "feature".into(),
            local: None,
        },
        false,
    )
    .await
    .unwrap();

    assert_eq!(repo.head(), remote_tip);
    let st = core.repo_state(opened.session).unwrap();
    let feature = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/heads/feature")
        .unwrap();
    assert_eq!(
        feature.upstream.as_deref(),
        Some("refs/remotes/origin/feature")
    );
}
