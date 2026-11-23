//! 실제 git 으로 러너·명령을 검증한다
#![allow(clippy::unwrap_used)]

use std::time::Duration;

use mgit_git::cmd::{detect_commit_graph, discover, graph_log_request, head_state, list_refs};
use mgit_git::parse::LogParser;
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::{EnvProfile, GitError, GitRequest, GitRunner, HeadState, ObjectFormat};
use mgit_testkit::{Scenario, build};

/// 기본 설정 러너
async fn runner() -> TokioGitRunner {
    TokioGitRunner::new(RunnerConfig::default()).await.unwrap()
}

#[tokio::test]
async fn version_meets_minimum() {
    let r = runner().await;
    assert!(r.version().meets_minimum(), "{:?}", r.version());
}

#[tokio::test]
async fn discover_finds_toplevel_from_subdir() {
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("sub/dir/x.txt", "x");
    let r = runner().await;
    let d = discover(&r, &repo.path().join("sub/dir")).await.unwrap();
    assert_eq!(
        d.work_tree.canonicalize().unwrap(),
        repo.path().canonicalize().unwrap()
    );
    assert!(d.git_dir.is_absolute() && d.common_dir.is_absolute());
    assert_eq!(d.object_format, ObjectFormat::Sha1);
    assert!(!detect_commit_graph(&d.common_dir).present);
}

#[tokio::test]
async fn discover_rejects_non_repo() {
    let dir = tempfile::tempdir().unwrap();
    let r = runner().await;
    let err = discover(&r, dir.path()).await.unwrap_err();
    assert!(matches!(err, GitError::NotARepository(_)), "{err}");
}

#[tokio::test]
async fn head_state_attached_detached_unborn() {
    let r = runner().await;

    let mut repo = build(Scenario::Linear(2));
    let head = repo.head();
    assert_eq!(
        head_state(&r, repo.path()).await.unwrap(),
        HeadState::Attached {
            branch: "refs/heads/main".into(),
            oid: head
        }
    );

    repo.checkout("HEAD~1");
    assert!(matches!(
        head_state(&r, repo.path()).await.unwrap(),
        HeadState::Detached { .. }
    ));

    let empty = build(Scenario::Empty);
    assert_eq!(
        head_state(&r, empty.path()).await.unwrap(),
        HeadState::Unborn {
            branch: "refs/heads/main".into()
        }
    );
}

#[tokio::test]
async fn list_refs_matches_testkit() {
    let r = runner().await;
    let mut repo = build(Scenario::BranchMerge);
    let head = head_state(&r, repo.path()).await.unwrap();
    let labels = list_refs(&r, repo.path(), &head).await.unwrap();
    let names: Vec<&str> = labels.iter().map(|l| l.short_name.as_str()).collect();
    assert_eq!(names, vec!["feature", "main", "v0.1", "v1.0"]);
    assert_eq!(labels[1].target, repo.head());
}

#[tokio::test]
async fn log_stream_parses_all_commits() {
    let r = runner().await;
    let mut repo = build(Scenario::Octopus);
    let expected = repo.rev_list_count();
    let mut stream = r
        .stream(graph_log_request(
            repo.path(),
            &[],
            &mgit_model::GraphQuery::default(),
        ))
        .await
        .unwrap();
    let mut parser = LogParser::new();
    let mut recs = Vec::new();
    while let Some(chunk) = stream.next_chunk().await.unwrap() {
        recs.extend(parser.feed(&chunk).unwrap());
    }
    parser.finish().unwrap();
    let exit = stream.finish().await.unwrap();
    assert!(exit.success());
    assert_eq!(recs.len() as u32, expected);
    assert_eq!(recs[0].parents.len(), 3);
}

#[tokio::test]
async fn config_override_is_applied() {
    let r = runner().await;
    let repo = build(Scenario::Linear(1));
    let req = GitRequest::new(repo.path(), ["config", "--get", "mgit.probe"])
        .with_config("mgit.probe", "yes");
    let out = r.run(req).await.unwrap();
    assert_eq!(out.stdout_lossy().trim(), "yes");
}

#[tokio::test]
async fn env_policy_is_applied() {
    let r = runner().await;
    let repo = build(Scenario::Linear(1));
    // `git var` 는 환경 변수를 그대로 보여주지 않으므로 pager 설정으로 확인한다
    let out = r
        .run(
            GitRequest::new(repo.path(), ["var", "GIT_PAGER"])
                .with_env(EnvProfile::ReadInteractive),
        )
        .await
        .unwrap();
    assert_eq!(out.stdout_lossy().trim(), "cat");
}

#[tokio::test]
async fn dropping_stream_kills_process_and_releases_permit() {
    let r = TokioGitRunner::new(RunnerConfig {
        max_concurrent_reads: 1,
        ..RunnerConfig::default()
    })
    .await
    .unwrap();
    let repo = build(Scenario::Linear(1));
    // stdin 을 열어 두면 cat-file 이 입력을 기다리며 종료하지 않는다
    let mut req = GitRequest::new(repo.path(), ["cat-file", "--batch"]);
    req.stdin = Some(Vec::new());
    let stream = r.stream(req).await.unwrap();
    drop(stream);
    // permit 이 돌아와야 다음 run 이 1초 안에 끝난다
    let res = tokio::time::timeout(
        Duration::from_secs(5),
        r.run(GitRequest::new(repo.path(), ["rev-parse", "HEAD"])),
    )
    .await;
    assert!(res.is_ok(), "permit 이 반납되지 않음");
    assert!(res.unwrap().unwrap().exit.success());
}

#[tokio::test]
async fn exit_error_carries_stderr_and_args() {
    let r = runner().await;
    let repo = build(Scenario::Linear(1));
    let req = GitRequest::new(repo.path(), ["rev-parse", "--verify", "nope"]);
    let args = req.display_args();
    let err = r.run(req).await.unwrap().ok(&args).unwrap_err();
    match err {
        GitError::Exit { status, args, .. } => {
            assert_eq!(status, Some(128));
            assert_eq!(args[0], "rev-parse");
        }
        other => panic!("{other}"),
    }
}

/// 경로 인자는 글롭이 아니라 글자 그대로다 (읽기·쓰기 프로파일 모두)
#[tokio::test]
async fn pathspecs_are_literal_in_every_profile() {
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("a[bc].txt", "x");
    repo.write_file("ab.txt", "y");
    repo.write_file(":memory:", "z");
    repo.git_ok(["add", "-A"]);
    repo.git_ok(["commit", "-q", "-m", "files"]);
    let r = runner().await;
    for profile in [
        EnvProfile::ReadBackground,
        EnvProfile::ReadInteractive,
        EnvProfile::Write,
        EnvProfile::Network,
    ] {
        let req = GitRequest::new(repo.path(), ["ls-files", "--", "a[bc].txt"]).with_env(profile);
        let out = r.run(req).await.unwrap();
        assert_eq!(out.stdout_lossy().trim(), "a[bc].txt", "{profile:?}");
        let req = GitRequest::new(repo.path(), ["ls-files", "--", ":memory:"]).with_env(profile);
        let out = r.run(req).await.unwrap();
        assert!(out.exit.success(), "{}", out.exit.stderr);
        assert_eq!(out.stdout_lossy().trim(), ":memory:", "{profile:?}");
    }
    // `.` 은 리터럴에서도 저장소 전체다 (stage_all·unstage_all 이 쓴다)
    let req = GitRequest::new(repo.path(), ["ls-files", "--", "."]);
    assert!(r.run(req).await.unwrap().stdout_lossy().contains("ab.txt"));
}

/// 리터럴 설정이 훅으로 새지 않는다. 훅 안의 글롭 pathspec 은 평소처럼 동작해야 한다
#[tokio::test]
async fn hooks_keep_glob_pathspecs() {
    let mut repo = build(Scenario::Linear(1));
    let hook = repo.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(
        &hook,
        "#!/bin/sh\ngit diff --cached --name-only -- '*.txt' > hook-out\n",
    )
    .unwrap();
    // Windows 의 git 은 실행 비트를 보지 않고 훅을 자체 sh 로 돌린다
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&hook).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&hook, perm).unwrap();
    }
    repo.write_file("n.txt", "n");
    repo.stage(&["n.txt"]);
    let r = runner().await;
    let req = GitRequest::new(repo.path(), ["commit", "-q", "-m", "x"])
        .with_config("user.name", "t")
        .with_config("user.email", "t@example.invalid")
        .with_env(EnvProfile::Write);
    let out = r.run(req).await.unwrap();
    assert!(out.exit.success(), "{}", out.exit.stderr);
    assert_eq!(repo.read_file("hook-out").trim(), "n.txt");
}

/// 자식이 남긴 백그라운드 프로세스가 파이프를 쥐고 있어도 명령은 끝난다 (훅의 `daemon &` 등)
#[tokio::test]
async fn background_process_holding_pipes_does_not_block_completion() {
    let repo = build(Scenario::Linear(1));
    let r = runner().await;
    let req =
        GitRequest::new(repo.path(), ["bg"]).with_config("alias.bg", "!sleep 8 & echo started");
    let started = std::time::Instant::now();
    let out = tokio::time::timeout(Duration::from_secs(30), r.run(req))
        .await
        .unwrap()
        .unwrap();
    assert!(out.exit.success(), "{}", out.exit.stderr);
    assert_eq!(out.stdout_lossy().trim(), "started");
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "파이프 EOF 를 기다렸다: {:?}",
        started.elapsed()
    );
}

/// 원격 이름에 `/` 가 있어도 등록된 원격 기준으로 나눈다
#[tokio::test]
async fn remote_with_slash_is_split_by_registered_remotes() {
    let mut repo = build(Scenario::Linear(1));
    let head = repo.head().to_hex();
    repo.git_ok([
        "remote",
        "add",
        "team/fork",
        "https://example.invalid/x.git",
    ]);
    repo.git_ok(["update-ref", "refs/remotes/team/fork/main", &head]);
    let r = runner().await;
    let state = head_state(&r, repo.path()).await.unwrap();
    let labels = list_refs(&r, repo.path(), &state).await.unwrap();
    let label = labels
        .iter()
        .find(|l| l.full_name == "refs/remotes/team/fork/main")
        .unwrap();
    assert_eq!(
        label.kind,
        mgit_model::RefKind::RemoteBranch {
            remote: "team/fork".into()
        }
    );
}

/// 그래프 경로 범위는 사용자가 입력하는 읽기 전용 필터라 글롭을 그대로 쓴다
#[tokio::test]
async fn graph_path_scope_keeps_globs() {
    let mut repo = build(Scenario::Linear(2));
    repo.write_file("src/a.rs", "a");
    repo.commit("rust file");
    let r = runner().await;
    let query = mgit_model::GraphQuery {
        path_scope: vec!["*.rs".into()],
        ..mgit_model::GraphQuery::default()
    };
    let req = graph_log_request(repo.path(), &[], &query);
    let out = r.run(req).await.unwrap();
    assert!(out.exit.success(), "{}", out.exit.stderr);
    assert!(out.stdout_lossy().contains("rust file"));
}

/// HEAD 범위(BT-03)는 HEAD 에서 닿는 커밋만 준다. detached 여도 되고 다른 브랜치·`--all` 은 섞이지 않는다
#[tokio::test]
async fn graph_head_revs_follow_head_only() {
    let mut repo = build(Scenario::Linear(2));
    repo.checkout_new("feature");
    repo.commit("feature only");
    repo.checkout("main");
    let main_tip = repo.commit("main tip");
    let r = runner().await;
    let query = mgit_model::GraphQuery {
        revs: mgit_model::GraphRevs::Head,
        ..mgit_model::GraphQuery::default()
    };
    let req = graph_log_request(repo.path(), &[], &query);
    let args = req.display_args();
    assert_eq!(
        &args[args.len() - 3..],
        ["--end-of-options", "HEAD", "--"],
        "{args:?}"
    );
    assert!(!args.iter().any(|a| a == "--all"), "{args:?}");
    let out = r.run(req).await.unwrap();
    assert!(out.exit.success(), "{}", out.exit.stderr);
    let text = out.stdout_lossy();
    assert!(text.contains("main tip") && !text.contains("feature only"));

    // detached: HEAD 가 가리키는 커밋에서 닿는 것만
    repo.git_ok(["checkout", "-q", "--detach", "HEAD~1"]);
    let out = r
        .run(graph_log_request(repo.path(), &[], &query))
        .await
        .unwrap();
    assert!(out.exit.success(), "{}", out.exit.stderr);
    let text = out.stdout_lossy();
    assert!(!text.contains("main tip") && !text.contains(&main_tip.to_hex()));
    assert!(!text.contains("feature only"));
    assert!(
        text.contains("commit 2") && text.contains("commit 1"),
        "{text:?}"
    );
}

/// 고급 검색의 경로 조건도 글롭을 그대로 쓴다
#[tokio::test]
async fn advanced_search_path_keeps_globs() {
    let mut repo = build(Scenario::Linear(2));
    repo.write_file("src/a.rs", "a");
    let oid = repo.commit("rust file");
    let r = runner().await;
    let query = mgit_model::AdvancedSearch {
        path: Some("*.rs".into()),
        ..mgit_model::AdvancedSearch::default()
    };
    let hits = mgit_git::cmd::advanced_search(&r, repo.path(), &query, 10)
        .await
        .unwrap();
    assert_eq!(hits, vec![oid]);
}

/// git 메시지는 영어로 고정한다 (힌트 분류가 영어 패턴이다). LC_ALL 은 건드리지 않아 훅의 UTF-8 처리가 그대로다
#[tokio::test]
async fn messages_are_fixed_to_english_without_touching_lc_all() {
    let repo = build(Scenario::Linear(1));
    let r = runner().await;
    for profile in [
        EnvProfile::ReadBackground,
        EnvProfile::ReadInteractive,
        EnvProfile::Write,
        EnvProfile::Network,
    ] {
        let req = GitRequest::new(repo.path(), ["show-lang"])
            .with_config("alias.show-lang", "!printf '%s' \"$LANGUAGE\"")
            .with_env(profile);
        let out = r.run(req).await.unwrap();
        assert_eq!(out.stdout_lossy(), "en", "{profile:?}");
    }
    for profile in [EnvProfile::Write, EnvProfile::Network] {
        let req = GitRequest::new(repo.path(), ["show-lc"])
            .with_config("alias.show-lc", "!printf '%s' \"${LC_ALL-unset}\"")
            .with_env(profile);
        let out = r.run(req).await.unwrap();
        let expected = std::env::var("LC_ALL").unwrap_or_else(|_| "unset".into());
        assert_eq!(out.stdout_lossy(), expected, "{profile:?}");
    }
}
