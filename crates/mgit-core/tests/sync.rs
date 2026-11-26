//! 원격·fetch·pull·push (RM-01~06) — 로컬 bare 원격으로 왕복한다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::time::Duration;

use common::{collector, core, core_with, wait_finished, wait_for};
use mgit_core::{CoreConfig, CoreError, CoreEvent, GitHint, PullMode, PushSpec};
use mgit_testkit::{Scenario, TestRepo, build};

/// 원격 bare 저장소를 둔 두 개의 clone 을 만든다: (origin 을 가진 repo, 같은 원격의 두 번째 clone)
fn two_clones() -> (TestRepo, std::path::PathBuf, TestRepo) {
    let mut a = build(Scenario::Linear(2));
    let remote = a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    let mut b = TestRepo::init();
    let remote_str = remote.to_string_lossy().into_owned();
    b.git_ok(["remote", "add", "origin", &remote_str]);
    b.git_ok(["fetch", "-q", "origin"]);
    b.git_ok(["checkout", "-q", "-b", "main", "--track", "origin/main"]);
    (a, remote, b)
}

#[tokio::test]
async fn remotes_crud_and_state() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let remote = repo.add_bare_remote();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let remotes = core.remotes(opened.session).unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(remotes[0].fetch_url, remote.to_string_lossy());

    core.remote_add(opened.session, "fork", "https://example.invalid/x.git")
        .await
        .unwrap();
    core.remote_rename(opened.session, "fork", "upstream")
        .await
        .unwrap();
    core.remote_set_url(opened.session, "upstream", "https://example.invalid/y.git")
        .await
        .unwrap();
    let remotes = core.remotes(opened.session).unwrap();
    let up = remotes.iter().find(|r| r.name == "upstream").unwrap();
    assert_eq!(up.fetch_url, "https://example.invalid/y.git");
    core.remote_remove(opened.session, "upstream")
        .await
        .unwrap();
    assert_eq!(core.remotes(opened.session).unwrap().len(), 1);
    assert!(matches!(
        core.remote_add(opened.session, "-x", "u").await,
        Err(CoreError::Invalid(_))
    ));
}

#[tokio::test]
async fn fetch_pull_push_round_trip_with_progress() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // b 가 커밋을 push → a 가 fetch 하면 behind 1
    b.write_file("from-b.txt", "b");
    b.commit("from b");
    b.git_ok(["push", "-q", "origin", "main"]);
    let op = core
        .begin_operation(opened.session, "fetch", "fetch")
        .unwrap();
    let op_id = op.id;
    core.fetch(opened.session, Some("origin"), true, Some(op))
        .await
        .unwrap();
    let events = wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, ok: true, .. } if *id == op_id),
    )
    .await;
    // 재조회는 명령 종료 이벤트 뒤에 돌므로 RefsChanged 가 아직 안 왔을 수 있다
    if !events
        .iter()
        .any(|e| matches!(e, CoreEvent::RefsChanged { .. }))
    {
        wait_for(&mut rx, Duration::from_secs(5), |e| {
            matches!(e, CoreEvent::RefsChanged { .. })
        })
        .await;
    }
    let st = core.repo_state(opened.session).unwrap();
    let main = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "main")
        .unwrap();
    assert_eq!((main.ahead, main.behind), (Some(0), Some(1)));

    // pull (ff-only) → 같은 커밋
    core.pull(opened.session, PullMode::FfOnly, None)
        .await
        .unwrap();
    assert_eq!(
        a.git_ok(["rev-parse", "HEAD"]),
        b.git_ok(["rev-parse", "HEAD"])
    );

    // a 가 커밋 → push (업스트림 있음) → 원격 반영
    a.write_file("from-a.txt", "a");
    let head = a.commit("from a");
    core.refresh(opened.session).await.unwrap();
    let op = core
        .begin_operation(opened.session, "push", "push")
        .unwrap();
    let op_id = op.id;
    core.push(opened.session, PushSpec::default(), Some(op))
        .await
        .unwrap();
    let events = wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, ok: true, .. } if *id == op_id),
    )
    .await;
    // 로컬 bare 원격에도 "Writing objects" 진행률 줄이 나온다
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CoreEvent::OperationProgress { op_id: id, .. } if *id == op_id)),
        "{events:#?}"
    );
    assert_eq!(a.git_ok(["rev-parse", "origin/main"]).trim(), head.to_hex());
    let st = core.repo_state(opened.session).unwrap();
    let main = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "main")
        .unwrap();
    assert_eq!((main.ahead, main.behind), (Some(0), Some(0)));

    // b 가 다른 커밋을 push 한 뒤 a 가 또 커밋하고 push → non-fast-forward 힌트
    b.git_ok(["pull", "-q", "--ff-only", "origin", "main"]);
    b.write_file("b2.txt", "b2");
    b.commit("b2");
    b.git_ok(["push", "-q", "origin", "main"]);
    a.write_file("a2.txt", "a2");
    a.commit("a2");
    core.refresh(opened.session).await.unwrap();
    let err = core
        .push(opened.session, PushSpec::default(), None)
        .await
        .unwrap_err();
    assert_eq!(err.hint(), Some(&GitHint::NonFastForward), "{err:?}");

    // pull --rebase 로 정리한 뒤 force-with-lease 없이도 push 된다
    core.pull(opened.session, PullMode::Rebase, None)
        .await
        .unwrap();
    core.push(opened.session, PushSpec::default(), None)
        .await
        .unwrap();
    assert_eq!(a.git_ok(["rev-list", "--count", "origin/main"]).trim(), "6");
}

/// 로컬 이름과 다른 업스트림으로는 확인 없이 보내지 않는다 (RM-04)
#[tokio::test]
async fn push_asks_before_updating_upstream_with_a_different_name() {
    let core = core().await;
    let (a, remote, _b) = two_clones();
    let mut a = a;
    let remote_str = remote.to_string_lossy().into_owned();
    a.git_ok(["switch", "-q", "-c", "other-main", "--track", "origin/main"]);
    a.write_file("o.txt", "o");
    let head = a.commit("on other-main");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let before = a.git_ok(["ls-remote", "--heads", &remote_str]);

    let err = core
        .push(opened.session, PushSpec::default(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(
            &err,
            CoreError::PushUpstreamMismatch { local, remote, upstream }
                if local == "other-main" && remote == "origin" && upstream == "main"
        ),
        "{err:?}"
    );
    assert_eq!(
        a.git_ok(["ls-remote", "--heads", &remote_str]),
        before,
        "확인 전에는 아무것도 보내지 않는다"
    );

    core.push(
        opened.session,
        PushSpec {
            confirm_upstream_mismatch: true,
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();

    let heads = a.git_ok(["ls-remote", "--heads", &remote_str]);
    assert!(
        !heads.contains("refs/heads/other-main"),
        "원격에 로컬 이름의 브랜치가 생기면 안 된다: {heads}"
    );
    assert!(heads.contains("refs/heads/main"));
    let st = core.repo_state(opened.session).unwrap();
    let origin_main = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/remotes/origin/main")
        .unwrap();
    assert_eq!(
        origin_main.target, head,
        "업스트림 브랜치가 HEAD 로 갱신된다"
    );
    let other = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/heads/other-main")
        .unwrap();
    assert_eq!(other.upstream.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!((other.ahead, other.behind), (Some(0), Some(0)));
}

/// 묻기 위해 멈춘 push 도 진행 표시가 남지 않게 끝 이벤트를 보낸다
#[tokio::test]
async fn refused_push_finishes_its_operation() {
    let core = core().await;
    let (a, _remote, _b) = two_clones();
    let mut a = a;
    a.git_ok(["switch", "-q", "-c", "other-main", "--track", "origin/main"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let op = core
        .begin_operation(opened.session, "push", "push")
        .unwrap();
    let op_id = op.id;

    let result = core
        .push(opened.session, PushSpec::default(), Some(op))
        .await;

    assert!(matches!(
        result,
        Err(CoreError::PushUpstreamMismatch { .. })
    ));
    wait_for(
        &mut rx,
        Duration::from_secs(5),
        |e| matches!(e, CoreEvent::OperationFinished { op_id: id, ok: false, .. } if *id == op_id),
    )
    .await;
}

/// 기억하면 같은 브랜치·업스트림 조합은 다시 묻지 않고, 조합이 바뀌면 다시 묻는다
#[tokio::test]
async fn push_remembers_confirmed_upstream_per_branch() {
    let core = core().await;
    let (a, _remote, _b) = two_clones();
    let mut a = a;
    a.git_ok(["push", "-q", "origin", "main:release"]);
    a.git_ok(["switch", "-q", "-c", "other-main", "--track", "origin/main"]);
    a.commit("one");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.push(
        opened.session,
        PushSpec {
            confirm_upstream_mismatch: true,
            remember_upstream_mismatch: true,
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();

    a.commit("two");
    core.refresh(opened.session).await.unwrap();
    core.push(opened.session, PushSpec::default(), None)
        .await
        .unwrap();

    // 업스트림이 바뀌면 기억은 맞지 않는다
    a.git_ok(["branch", "--set-upstream-to=origin/release", "other-main"]);
    core.refresh(opened.session).await.unwrap();
    assert!(matches!(
        core.push(opened.session, PushSpec::default(), None).await,
        Err(CoreError::PushUpstreamMismatch { .. })
    ));
}

/// 다른 원격을 직접 고르면 업스트림이 없어도 `-u` 를 강제하지 않는다
#[tokio::test]
async fn push_to_chosen_remote_does_not_imply_set_upstream() {
    let core = core().await;
    let (a, _remote, _b) = two_clones();
    let mut a = a;
    a.add_bare_remote_named("fork");
    a.checkout_new("topic");
    a.commit("topic");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.push(
        opened.session,
        PushSpec {
            remote: Some("fork".into()),
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();

    let st = core.repo_state(opened.session).unwrap();
    let topic = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "topic")
        .unwrap();
    assert_eq!(topic.upstream, None);
}

/// 원격을 고르지 않고 업스트림도 없으면: 하나뿐인 원격 → 그것, origin → origin
#[tokio::test]
async fn push_falls_back_to_the_only_remote_or_origin() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let fork = repo.add_bare_remote_named("fork");
    let fork_str = fork.to_string_lossy().into_owned();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.push(opened.session, PushSpec::default(), None)
        .await
        .unwrap();
    assert!(
        repo.git_ok(["ls-remote", "--heads", &fork_str])
            .contains("refs/heads/main"),
        "origin 이 없어도 하나뿐인 원격으로 보낸다"
    );
    let st = core.repo_state(opened.session).unwrap();
    let main = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/heads/main")
        .unwrap();
    assert_eq!(main.upstream.as_deref(), Some("refs/remotes/fork/main"));

    // 원격이 여럿이고 origin 이 있으면 origin
    let mut repo = build(Scenario::Linear(1));
    let origin = repo.add_bare_remote();
    repo.add_bare_remote_named("fork");
    let origin_str = origin.to_string_lossy().into_owned();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    core.push(opened.session, PushSpec::default(), None)
        .await
        .unwrap();
    assert!(
        repo.git_ok(["ls-remote", "--heads", &origin_str])
            .contains("refs/heads/main")
    );
}

/// origin 없이 원격이 여럿이면 고를 수 없으니 오류, 원격이 없어도 오류
#[tokio::test]
async fn push_without_a_clear_remote_is_an_error() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.add_bare_remote_named("one");
    repo.add_bare_remote_named("two");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let err = core
        .push(opened.session, PushSpec::default(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("원격")),
        "{err:?}"
    );

    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let err = core
        .push(opened.session, PushSpec::default(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("원격")),
        "{err:?}"
    );
}

/// 자동 fetch 가 추적 ref 만 올려도 본 적 없는 동료 커밋을 강제 push 로 덮지 않는다
#[tokio::test]
async fn force_with_lease_refuses_commits_seen_only_by_background_fetch() {
    let core = core().await;
    let (mut a, remote, mut b) = two_clones();
    let remote_str = remote.to_string_lossy().into_owned();
    b.commit("from b");
    b.git_ok(["push", "-q", "origin", "main"]);
    let theirs = b.head();
    a.commit("from a");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 자동 fetch 와 같은 동작
    core.fetch(opened.session, None, true, None).await.unwrap();
    let err = core
        .push(
            opened.session,
            PushSpec {
                force_with_lease: true,
                ..PushSpec::default()
            },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.hint(), Some(&GitHint::StaleInfo), "{err:?}");
    let heads = a.git_ok(["ls-remote", "--heads", &remote_str]);
    assert!(heads.contains(&theirs.to_hex()), "{heads}");

    // 원격 커밋을 받아 통합한 뒤에는 강제 push 가 된다
    core.pull(opened.session, PullMode::Rebase, None)
        .await
        .unwrap();
    core.push(opened.session, PushSpec::default(), None)
        .await
        .unwrap();
    // reflog 시각을 코어와 맞추려고 코어로 amend 한다 (테스트 저장소의 시계는 고정이다)
    core.commit(
        opened.session,
        mgit_core::CommitSpec {
            message: "from a amended".into(),
            amend: true,
            ..mgit_core::CommitSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    core.push(
        opened.session,
        PushSpec {
            force_with_lease: true,
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();
}

/// 고른 원격으로는 같은 이름으로 보내고, 업스트림은 요청할 때만 바꾼다 (RM-04 원격 선택)
#[tokio::test]
async fn push_to_chosen_remote_keeps_or_sets_upstream() {
    let core = core().await;
    let (a, _remote, _b) = two_clones();
    let mut a = a;
    let fork = a.add_bare_remote_named("fork");
    let fork_str = fork.to_string_lossy().into_owned();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.push(
        opened.session,
        PushSpec {
            remote: Some("fork".into()),
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    assert!(
        a.git_ok(["ls-remote", "--heads", &fork_str])
            .contains("refs/heads/main")
    );
    let st = core.repo_state(opened.session).unwrap();
    let main = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/heads/main")
        .unwrap();
    assert_eq!(
        main.upstream.as_deref(),
        Some("refs/remotes/origin/main"),
        "set_upstream 없이는 업스트림이 그대로"
    );

    core.push(
        opened.session,
        PushSpec {
            remote: Some("fork".into()),
            set_upstream: true,
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    let main = st
        .refs
        .labels
        .iter()
        .find(|l| l.full_name == "refs/heads/main")
        .unwrap();
    assert_eq!(main.upstream.as_deref(), Some("refs/remotes/fork/main"));
}

#[tokio::test]
async fn push_new_branch_sets_upstream() {
    let core = core().await;
    let (a, _remote, _b) = two_clones();
    let mut a = a;
    a.checkout_new("topic");
    a.commit("topic");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    core.push(
        opened.session,
        PushSpec {
            set_upstream: true,
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    let topic = st
        .refs
        .labels
        .iter()
        .find(|l| l.short_name == "topic")
        .unwrap();
    assert_eq!(topic.upstream.as_deref(), Some("refs/remotes/origin/topic"));
}

#[tokio::test]
async fn push_from_detached_head_is_rejected() {
    let core = core().await;
    let (mut a, _remote, _b) = two_clones();
    a.checkout("HEAD~1");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(matches!(
        core.push(opened.session, PushSpec::default(), None).await,
        Err(CoreError::Invalid(_))
    ));
}

/// 자동 fetch 는 사용자 작업이 아니다: 태그를 받아도 undo 항목을 만들지 않고 redo 를 비우지 않는다
#[tokio::test]
async fn auto_fetch_leaves_undo_stack_alone() {
    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(Duration::from_millis(200)),
        ..CoreConfig::default()
    })
    .await;
    let (a, _remote, mut b) = two_clones();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    core.create_branch(opened.session, "op", None, false)
        .await
        .unwrap();
    core.undo(opened.session).await.unwrap();
    assert_eq!(core.undo_entries(opened.session).unwrap().1, 1);

    b.commit("from b");
    b.tag("v9", false);
    // tag 를 먼저, main 을 나중에 올린다. 새 main 을 본 자동 fetch 는 이미 자리 잡은 tag 도 함께 받는다
    // (--atomic 한 번으로는 부족하다: files ref 저장소는 ref 목록을 한 시점에 읽지 않는다). tag 만 올라간 동안의
    // 자동 fetch 는 tag 가 가리키는 커밋이 없어 tag 를 따라 받지 않으므로 아무것도 바뀌지 않는다
    b.git_ok(["push", "-q", "origin", "refs/tags/v9"]);
    b.git_ok(["push", "-q", "origin", "main"]);
    // push 보다 먼저 돈 자동 fetch 도 AutoFetched 를 보낼 수 있다: git 2.48+ 는 첫 fetch 에서 origin/HEAD 를 만든다.
    // 그 이벤트에서 풀리지 않도록 origin/main 을 받아 온 바퀴까지 기다린다
    wait_for(&mut rx, Duration::from_secs(10), |e| {
        matches!(e, CoreEvent::AutoFetched { refs, .. } if refs.iter().any(|r| r == "origin/main"))
    })
    .await;

    let mut a = a;
    assert!(
        a.git(["rev-parse", "--verify", "refs/tags/v9"])
            .status
            .success(),
        "태그가 함께 받아졌다"
    );
    let (entries, redo) = core.undo_entries(opened.session).unwrap();
    assert!(entries.is_empty(), "{entries:?}");
    assert_eq!(redo, 1, "redo 가 살아 있다");
}

/// 자동 fetch 는 저장소 로컬의 `core.sshCommand` 를 실행하지 않는다. 수동 fetch 는 그대로 쓴다
#[cfg(unix)]
#[tokio::test]
async fn auto_fetch_skips_repo_local_ssh_command() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("ssh.sh");
    let marker = dir.path().join("ran");
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(Duration::from_millis(100)),
        ..CoreConfig::default()
    })
    .await;
    let mut repo = build(Scenario::Linear(1));
    repo.git_ok([
        "remote",
        "add",
        "origin",
        "ssh://git@example.invalid/o/r.git",
    ]);
    repo.git_ok(["config", "core.sshCommand", &script.to_string_lossy()]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        !marker.exists(),
        "자동 fetch 가 저장소 설정의 ssh 를 실행했다"
    );
    assert!(
        core.fetch(opened.session, Some("origin"), false, None)
            .await
            .is_err()
    );
    assert!(marker.exists(), "수동 fetch 는 사용자의 설정을 따른다");
}

/// 지금까지 받은 이벤트를 비운다
fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// 자동 fetch 간격은 실행 중에 바꾼다: 꺼져 있던 탭도 켜면 곧바로 돌고, 다시 끄면 멈추고, 긴 간격에서 짧은 간격으로
/// 바꾸면 이전 타이머를 기다리지 않는다
#[tokio::test]
async fn auto_fetch_interval_changes_apply_to_open_tabs() {
    let core = core().await;
    assert_eq!(core.auto_fetch_interval(), None);
    let (mut a, _remote, mut b) = two_clones();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let auto_fetched = |e: &CoreEvent| matches!(e, CoreEvent::AutoFetched { .. });

    // 꺼져 있으면 원격이 바뀌어도 돌지 않는다
    b.commit("one");
    b.git_ok(["push", "-q", "origin", "main"]);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!drain(&mut rx).iter().any(auto_fetched));

    // 켜면 열린 탭에 곧바로 걸린다
    core.set_auto_fetch_interval(Some(Duration::from_millis(150)));
    assert_eq!(core.auto_fetch_interval(), Some(Duration::from_millis(150)));
    wait_for(&mut rx, Duration::from_secs(10), auto_fetched).await;

    // 끄면 멈춘다 (돌던 바퀴의 늦은 이벤트는 버린다)
    core.set_auto_fetch_interval(None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    drain(&mut rx);
    let pushed = b.commit("two");
    b.git_ok(["push", "-q", "origin", "main"]);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!drain(&mut rx).iter().any(auto_fetched), "끈 뒤에 돌았다");
    assert_ne!(
        a.git_ok(["rev-parse", "refs/remotes/origin/main"]).trim(),
        pushed.to_hex()
    );

    // 긴 간격으로 켰다가 짧게 바꾸면 긴 타이머를 기다리지 않는다
    core.set_auto_fetch_interval(Some(Duration::from_secs(3600)));
    core.set_auto_fetch_interval(Some(Duration::from_millis(150)));
    wait_for(&mut rx, Duration::from_secs(10), auto_fetched).await;
    assert_eq!(
        a.git_ok(["rev-parse", "refs/remotes/origin/main"]).trim(),
        pushed.to_hex()
    );
}
