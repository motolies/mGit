//! 해결 검증 (CF-25)·검증 명령·워크트리 초기화 (WT-07)·LFS (AD-01)
#![allow(clippy::unwrap_used)]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{collector, core, core_with, wait_finished};
use mgit_core::{Core, CoreConfig, WorktreeSource};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::{
    BoxFuture, EnvProfile, GitError, GitOutput, GitRequest, GitRunner, GitStream, GitVersion,
    OutputSink,
};
use mgit_testkit::{Scenario, build};

/// 사용자 명령에 넘길 PATH 를 지정한 코어 설정
fn with_path(path: &str) -> CoreConfig {
    CoreConfig {
        command_path: Some(path.to_string()),
        ..CoreConfig::default()
    }
}

/// 검증·워크트리 초기화·충돌 규칙 명령은 로그인 셸의 PATH 로 돈다 (Finder 실행 대비)
#[tokio::test]
async fn user_commands_get_login_path() {
    let core = core_with(with_path("/mgit/login/bin:/usr/bin:/bin")).await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    core.set_verify_command(id, Some("printf %s \"$PATH\""))
        .unwrap();
    let r = core.run_verify(id).await.unwrap();
    assert_eq!(r.output, "/mgit/login/bin:/usr/bin:/bin");

    core.set_worktree_init_command(id, Some("printf %s \"$PATH\""))
        .unwrap();
    let r = core
        .run_worktree_init(id, repo.path())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.output, "/mgit/login/bin:/usr/bin:/bin");

    let conflict = core.conflicts(id).await.unwrap().remove(0).path;
    core.set_conflict_rules(
        id,
        &[mgit_core::ConflictRule {
            glob: "**".into(),
            action: mgit_core::RuleAction::Command {
                cmd: "printf %s \"$PATH\" > \"$MGIT_PATH\"".into(),
            },
        }],
    )
    .unwrap();
    core.apply_conflict_rules(id).await.unwrap();
    assert_eq!(repo.read_file(&conflict), "/mgit/login/bin:/usr/bin:/bin");
}

/// 시간 초과면 자식까지 실제로 끝낸다: `sh` 만 죽고 뒤의 명령이 살아남으면 안 된다
#[tokio::test]
async fn verify_timeout_kills_the_whole_command() {
    let core = core_with(CoreConfig {
        command_timeout: Duration::from_millis(300),
        ..CoreConfig::default()
    })
    .await;
    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    let marker = repo.path().join("late.txt");
    // 백그라운드 자식은 `sh` 만 죽여서는 끝나지 않는다
    core.set_verify_command(id, Some("(sleep 1; touch late.txt) & wait"))
        .unwrap();
    let r = core.run_verify(id).await.unwrap();
    assert!(r.timed_out && !r.ok, "{r:?}");
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert!(!marker.exists(), "시간 초과 뒤에도 명령이 계속 돌았다");
}

/// 충돌 규칙 명령도 시간 제한이 있다
#[tokio::test]
async fn conflict_rule_command_times_out() {
    let core = core_with(CoreConfig {
        command_timeout: Duration::from_millis(300),
        ..CoreConfig::default()
    })
    .await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;
    core.set_conflict_rules(
        id,
        &[mgit_core::ConflictRule {
            glob: "**".into(),
            action: mgit_core::RuleAction::Command {
                cmd: "sleep 30".into(),
            },
        }],
    )
    .unwrap();
    let results = tokio::time::timeout(Duration::from_secs(5), core.apply_conflict_rules(id))
        .await
        .expect("규칙 명령이 시간 제한 없이 돈다")
        .unwrap();
    assert!(!results[0].ok, "{results:?}");
}

/// 요청의 인자·프로파일을 기록하는 러너
struct SpyRunner {
    inner: TokioGitRunner,
    seen: Arc<Mutex<Vec<(String, EnvProfile)>>>,
}

impl SpyRunner {
    /// 요청을 적는다
    fn note(&self, req: &GitRequest) {
        self.seen
            .lock()
            .unwrap()
            .push((req.display_args().join(" "), req.env));
    }
}

impl GitRunner for SpyRunner {
    fn version(&self) -> &GitVersion {
        self.inner.version()
    }

    fn run<'a>(&'a self, req: GitRequest) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        self.note(&req);
        self.inner.run(req)
    }

    fn run_observed<'a>(
        &'a self,
        req: GitRequest,
        sink: Arc<dyn OutputSink>,
    ) -> BoxFuture<'a, Result<GitOutput, GitError>> {
        self.note(&req);
        self.inner.run_observed(req, sink)
    }

    fn stream<'a>(
        &'a self,
        req: GitRequest,
    ) -> BoxFuture<'a, Result<Box<dyn GitStream>, GitError>> {
        self.note(&req);
        self.inner.stream(req)
    }
}

/// LFS 잠금은 서버와 통신하므로 askpass 가 붙는 Network 프로파일로 돈다
#[tokio::test]
async fn lfs_lock_commands_use_network_profile() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let runner = SpyRunner {
        inner: TokioGitRunner::new(RunnerConfig::default()).await.unwrap(),
        seen: Arc::clone(&seen),
    };
    let core = Core::new(Arc::new(runner), CoreConfig::default());
    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 원격이 없어 실패해도 된다. 어떤 프로파일로 돌았는지만 본다
    let _ = core.lfs_lock(opened.session, "a.bin").await;
    let _ = core.lfs_unlock(opened.session, "a.bin", false).await;
    let seen = seen.lock().unwrap();
    for needle in ["lfs lock", "lfs unlock"] {
        let (_, profile) = seen
            .iter()
            .find(|(args, _)| args.contains(needle))
            .unwrap_or_else(|| panic!("{needle} 를 실행하지 않았다"));
        assert_eq!(*profile, EnvProfile::Network, "{needle}");
    }
}

#[tokio::test]
async fn syntax_compare_verify_command_and_worktree_init() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    // JSON 충돌: base {"a":1} / ours {"a":2} / theirs {"a":3}
    repo.write_file("a.json", "{\"a\": 1}\n");
    repo.stage(&["a.json"]);
    repo.commit_staged("base json");
    repo.checkout_new("side");
    repo.write_file("a.json", "{\"a\": 3}\n");
    repo.stage(&["a.json"]);
    repo.commit_staged("side json");
    repo.checkout("main");
    repo.write_file("a.json", "{\"a\": 2}\n");
    repo.stage(&["a.json"]);
    repo.commit_staged("main json");
    let out = repo.git(["merge", "--no-edit", "side"]);
    assert!(!out.status.success());
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    let bad = core
        .syntax_compare(id, "a.json", b"{\"a\": }\n")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bad.language, "json");
    assert!(bad.new_errors && bad.result_errors > 0);
    assert_eq!(bad.ours_errors, Some(0));
    assert_eq!(bad.theirs_errors, Some(0));
    assert_eq!(bad.first_error_line, Some(1));
    let good = core
        .syntax_compare(id, "a.json", b"{\"a\": 5}\n")
        .await
        .unwrap()
        .unwrap();
    assert!(!good.new_errors && good.result_errors == 0);
    assert!(
        core.syntax_compare(id, "README.md", b"x")
            .await
            .unwrap()
            .is_none()
    );

    // 검증 명령
    assert!(core.verify_command(id).unwrap().is_none());
    assert!(core.run_verify(id).await.is_err());
    core.set_verify_command(
        id,
        Some("printf 'checked %s' \"$(basename \"$PWD\")\"; exit 3"),
    )
    .unwrap();
    let r = core.run_verify(id).await.unwrap();
    assert!(!r.ok && r.status == Some(3) && !r.timed_out, "{r:?}");
    assert!(r.output.starts_with("checked "), "{}", r.output);
    core.set_verify_command(id, Some("  ")).unwrap();
    assert!(core.verify_command(id).unwrap().is_none());

    // 워크트리 초기화 명령 (WT-07): 새 워크트리에서 돌고 환경 변수를 받는다
    repo.git_ok(["merge", "--abort"]);
    core.refresh(id).await.unwrap();
    assert!(
        core.run_worktree_init(id, repo.path())
            .await
            .unwrap()
            .is_none()
    );
    core.set_worktree_init_command(
        id,
        Some("printf '%s|%s' \"$MGIT_WORKTREE\" \"$MGIT_MAIN\" > init.txt"),
    )
    .unwrap();
    let wt = repo.path().join("..").join("wt-init");
    let created = core
        .worktree_add(
            id,
            &wt,
            WorktreeSource::NewBranch {
                name: "wt-init".into(),
                start: None,
            },
        )
        .await
        .unwrap();
    let r = core.run_worktree_init(id, &created).await.unwrap().unwrap();
    assert!(r.ok, "{r:?}");
    let marker = std::fs::read_to_string(created.join("init.txt")).unwrap();
    let (w, m) = marker.split_once('|').unwrap();
    assert_eq!(
        std::path::Path::new(w).canonicalize().unwrap(),
        created.canonicalize().unwrap()
    );
    assert_eq!(
        std::path::Path::new(m).canonicalize().unwrap(),
        repo.path().canonicalize().unwrap()
    );
    assert!(
        core.run_worktree_init(id, std::path::Path::new("/nonexistent/x"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn lfs_track_status_untrack() {
    if !std::process::Command::new("git")
        .args(["lfs", "version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        eprintln!("git-lfs 가 없어 건너뜀");
        return;
    }
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    let st = core.lfs_status(id).await.unwrap();
    assert!(st.installed);
    assert!(st.version.is_some());
    assert!(st.patterns.is_empty() && st.files.is_empty());

    core.lfs_install(id).await.unwrap();
    core.lfs_track(id, "*.bin").await.unwrap();
    let st = core.lfs_status(id).await.unwrap();
    assert!(st.configured);
    assert_eq!(st.patterns, vec!["*.bin"]);
    assert!(
        repo.read_file(".gitattributes")
            .contains("*.bin filter=lfs")
    );

    repo.write_file("big.bin", "0123456789abcdef");
    repo.stage(&[".gitattributes", "big.bin"]);
    repo.commit_staged("add lfs file");
    let st = core.lfs_status(id).await.unwrap();
    assert_eq!(st.files.len(), 1, "{st:?}");
    assert_eq!(st.files[0].path, "big.bin");
    assert!(st.files[0].full);
    assert!(st.locks.is_empty());

    assert!(core.lfs_track(id, "--evil").await.is_err());
    core.lfs_untrack(id, "*.bin").await.unwrap();
    assert!(core.lfs_status(id).await.unwrap().patterns.is_empty());
}
