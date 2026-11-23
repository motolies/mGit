//! PR/MR (HO-02·03·04): 원격 프로젝트 판별·템플릿·원격 ref 체크아웃
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use common::{collector, core, wait_finished};
use httpmock::prelude::*;
use mgit_core::{HostKind, HostingClient};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn remote_project_and_templates() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.git_ok(["remote", "add", "origin", "git@github.com:kim/app.git"]);
    repo.write_file(".github/PULL_REQUEST_TEMPLATE.md", "## 요약\n");
    repo.write_file(".github/PULL_REQUEST_TEMPLATE/bugfix.md", "## 버그\n");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let p = core.remote_project(opened.session).unwrap().unwrap();
    assert_eq!(p.host, "github.com");
    assert_eq!(p.project, "kim/app");
    assert_eq!(p.kind, HostKind::GitHub);
    assert_eq!(p.remote, "origin");
    assert!(p.account_id.is_none(), "계정이 없으면 None");
    assert!(
        core.pull_requests(opened.session).await.is_err(),
        "계정 없이는 PR 목록 불가"
    );

    let t = core.pr_templates(opened.session).unwrap();
    assert_eq!(t.len(), 2);
    assert_eq!(t[0].name, "default");
    assert_eq!(t[0].body, "## 요약\n");
    assert_eq!(t[1].name, "bugfix");

    // 같은 호스트의 계정을 넣으면 연결된다
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/user");
            then.status(200)
                .json_body(serde_json::json!({"login": "kim"}));
        })
        .await;
    let client = HostingClient::with_bases(
        HostKind::GitHub,
        server.base_url(),
        server.base_url(),
        Some("t".into()),
    )
    .unwrap();
    core.hosting_add_with_client(HostKind::GitHub, "github.com", "t", &client)
        .await
        .unwrap();
    let p = core.remote_project(opened.session).unwrap().unwrap();
    assert_eq!(p.account_id.as_deref(), Some("github:github.com:kim"));
}

/// GitLab 계정 하나를 가짜 서버로 추가한다
async fn add_gitlab_account(core: &mgit_core::Core, host: &str) {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/user");
            then.status(200)
                .json_body(serde_json::json!({"username": "kim"}));
        })
        .await;
    let client = HostingClient::with_bases(
        HostKind::GitLab,
        server.base_url(),
        server.base_url(),
        Some("t".into()),
    )
    .unwrap();
    core.hosting_add_with_client(HostKind::GitLab, host, "t", &client)
        .await
        .unwrap();
}

/// 포트가 있는 자체 호스팅: 웹 URL 은 포트까지, SSH URL 은 호스트 이름으로 계정을 찾고
/// GitLab 은 하위 그룹 전체 경로, GitHub 는 owner/repo 만 쓴다
#[tokio::test]
async fn remote_project_matches_port_and_full_gitlab_path() {
    let core = core().await;
    add_gitlab_account(&core, "gitlab.corp:8443").await;
    let mut repo = build(Scenario::Linear(1));
    repo.git_ok([
        "remote",
        "add",
        "origin",
        "https://gitlab.corp:8443/grp/sub/app.git",
    ]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let p = core.remote_project(opened.session).unwrap().unwrap();
    assert_eq!(p.host, "gitlab.corp:8443");
    assert_eq!(p.project, "grp/sub/app");
    assert_eq!(p.kind, HostKind::GitLab);
    assert_eq!(p.account_id.as_deref(), Some("gitlab:gitlab.corp:8443:kim"));

    // SSH 포트는 웹 포트가 아니다: 호스트 이름이 같은 계정을 쓴다
    repo.git_ok([
        "remote",
        "set-url",
        "origin",
        "ssh://git@gitlab.corp:2222/grp/sub/app.git",
    ]);
    core.refresh(opened.session).await.unwrap();
    let p = core.remote_project(opened.session).unwrap().unwrap();
    assert_eq!(p.host, "gitlab.corp");
    assert_eq!(p.account_id.as_deref(), Some("gitlab:gitlab.corp:8443:kim"));

    // GitHub 는 저장소가 두 단계뿐이다
    repo.git_ok([
        "remote",
        "set-url",
        "origin",
        "https://github.com/kim/app/extra.git",
    ]);
    core.refresh(opened.session).await.unwrap();
    assert_eq!(
        core.remote_project(opened.session)
            .unwrap()
            .unwrap()
            .project,
        "kim/app"
    );
}

/// 저장소의 심볼릭 링크로 저장소 밖 파일을 PR 본문에 끌어오지 못한다
#[cfg(unix)]
#[tokio::test]
async fn pr_templates_do_not_follow_symlinks() {
    use std::os::unix::fs::symlink;
    let core = core().await;
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "PRIVATE KEY").unwrap();
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("docs/.keep", "");
    // 파일 링크, 템플릿 폴더 안의 링크, 폴더 자체가 링크인 경우
    std::fs::create_dir_all(repo.path().join(".github/PULL_REQUEST_TEMPLATE")).unwrap();
    symlink(
        &secret,
        repo.path().join(".github/PULL_REQUEST_TEMPLATE.md"),
    )
    .unwrap();
    symlink(
        &secret,
        repo.path().join(".github/PULL_REQUEST_TEMPLATE/leak.md"),
    )
    .unwrap();
    symlink(
        outside.path(),
        repo.path().join("docs/PULL_REQUEST_TEMPLATE"),
    )
    .unwrap();
    std::fs::write(outside.path().join("dirleak.md"), "PRIVATE KEY").unwrap();
    repo.write_file(".github/PULL_REQUEST_TEMPLATE/ok.md", "## 정상\n");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    let t = core.pr_templates(opened.session).unwrap();
    assert_eq!(t.len(), 1, "{t:?}");
    assert_eq!(t[0].name, "ok");
}

/// PR head 를 원격에 올린다
fn push_pr_head(repo: &mut mgit_testkit::TestRepo, file: &str) -> mgit_core::Oid {
    repo.write_file(file, file);
    repo.stage(&[file]);
    let tip = repo.commit_staged(file);
    repo.git_ok(["push", "-q", "-f", "origin", "HEAD:refs/pull/5/head"]);
    tip
}

/// 다시 체크아웃하면 fast-forward 로 갱신하고, 로컬에만 있는 커밋은 덮지 않는다
#[tokio::test]
async fn checkout_remote_ref_fast_forwards_and_keeps_local_commits() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main"]);
    repo.checkout_new("feature");
    let first = push_pr_head(&mut repo, "one.txt");
    repo.checkout("main");
    repo.git_ok(["branch", "-m", "feature", "upstream-pr"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    core.checkout_remote_ref(id, "origin", "pull/5/head", "pr/5", None)
        .await
        .unwrap();
    assert_eq!(core.repo_state(id).unwrap().refs.head.oid(), Some(first));

    // pr/5 위에서 다시: 원격이 앞서면 fast-forward
    repo.git_ok(["worktree", "add", "-q", "../side", "upstream-pr"]);
    let mut side = mgit_testkit::TestRepo::at(&repo.path().parent().unwrap().join("side"));
    let second = push_pr_head(&mut side, "two.txt");
    core.checkout_remote_ref(id, "origin", "pull/5/head", "pr/5", None)
        .await
        .unwrap();
    let head = &core.repo_state(id).unwrap().refs.head;
    assert_eq!(head.branch(), Some("refs/heads/pr/5"));
    assert_eq!(head.oid(), Some(second));

    // 다른 브랜치에서 다시: 역시 fast-forward
    core.checkout(id, mgit_core::CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    let third = push_pr_head(&mut side, "three.txt");
    core.checkout_remote_ref(id, "origin", "pull/5/head", "pr/5", None)
        .await
        .unwrap();
    assert_eq!(core.repo_state(id).unwrap().refs.head.oid(), Some(third));

    // 로컬 커밋이 있으면 어디서든 덮지 않는다
    repo.write_file("mine.txt", "mine");
    repo.stage(&["mine.txt"]);
    let mine = repo.commit_staged("로컬 수정");
    core.refresh(id).await.unwrap();
    let err = core
        .checkout_remote_ref(id, "origin", "pull/5/head", "pr/5", None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("pr/5"), "{err}");
    core.checkout(id, mgit_core::CheckoutTarget::Branch("main".into()), false)
        .await
        .unwrap();
    let err = core
        .checkout_remote_ref(id, "origin", "pull/5/head", "pr/5", None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("pr/5"), "{err}");
    let tip = repo.git_ok(["rev-parse", "pr/5"]);
    assert_eq!(tip.trim(), mine.to_hex(), "로컬 커밋이 살아 있다");
    let leftovers = repo.git_ok(["for-each-ref", "refs/mgit/fetch"]);
    assert!(leftovers.trim().is_empty(), "{leftovers}");
    let _ = std::fs::remove_dir_all(repo.path().parent().unwrap().join("side"));
}

#[tokio::test]
async fn checkout_remote_ref_into_branch_and_worktree() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let remote = repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main"]);
    // 원격에 PR head 처럼 보이는 ref 를 만든다
    repo.checkout_new("feature");
    repo.write_file("pr.txt", "pr");
    repo.stage(&["pr.txt"]);
    let tip = repo.commit_staged("pr commit");
    repo.git_ok(["push", "-q", "origin", "feature:refs/pull/5/head"]);
    repo.checkout("main");
    repo.git_ok(["branch", "-D", "feature"]);
    let _ = remote;
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.checkout_remote_ref(opened.session, "origin", "pull/5/head", "pr/5", None)
        .await
        .unwrap();
    let st = core.repo_state(opened.session).unwrap();
    assert_eq!(st.refs.head.branch(), Some("refs/heads/pr/5"));
    assert_eq!(st.refs.head.oid(), Some(tip));

    // 새 워크트리로
    core.checkout(
        opened.session,
        mgit_core::CheckoutTarget::Branch("main".into()),
        false,
    )
    .await
    .unwrap();
    repo.git_ok(["branch", "-D", "pr/5"]);
    let wt = repo.path().parent().unwrap().join(format!(
        "{}-pr5",
        repo.path().file_name().unwrap().to_string_lossy()
    ));
    core.checkout_remote_ref(opened.session, "origin", "pull/5/head", "pr/5", Some(&wt))
        .await
        .unwrap();
    assert!(wt.join("pr.txt").exists());
    assert!(
        core.checkout_remote_ref(opened.session, "-x", "a", "b", None)
            .await
            .is_err()
    );
    let _ = std::fs::remove_dir_all(&wt);
}
