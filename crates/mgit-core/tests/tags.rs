//! tag 관리 (BR-06, TG-01~18) 관문 테스트 — 로컬 bare 원격으로 실제 git 동작을 확인한다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, core_with, wait_finished, wait_for};
use mgit_core::{
    Core, CoreConfig, CoreError, CoreEvent, GitHint, Oid, PushSpec, SessionId, TagDeleteItem,
    TagLeaseItem, TagRefResult, TagRefStatus, WriteSpec,
};
use mgit_model::{TagLookupErrorKind, TagSyncState};
use mgit_testkit::{Scenario, TestRepo, build};
use tokio::sync::mpsc::UnboundedReceiver;

/// bare 원격에 실행 권한이 있는 hook 을 설치한다 (`<remote>/hooks/<name>`)
#[cfg(unix)]
fn install_remote_hook(remote: &Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hooks = remote.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let path = hooks.join(name);
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// main 을 push 한 bare 원격 하나를 둔 저장소 (repo, 원격 경로)
fn repo_with_remote() -> (TestRepo, PathBuf) {
    let mut repo = build(Scenario::Linear(2));
    let remote = repo.add_bare_remote();
    repo.git_ok(["push", "-q", "-u", "origin", "main"]);
    (repo, remote)
}

/// 원격 bare 저장소를 둔 두 clone (origin 을 가진 a, 원격 경로, 같은 원격의 b). `tests/sync.rs` 의 것과 같다
fn two_clones() -> (TestRepo, PathBuf, TestRepo) {
    let (a, remote) = repo_with_remote();
    let mut b = TestRepo::init();
    let remote_str = remote.to_string_lossy().into_owned();
    b.git_ok(["remote", "add", "origin", &remote_str]);
    b.git_ok(["fetch", "-q", "origin"]);
    b.git_ok(["checkout", "-q", "-b", "main", "--track", "origin/main"]);
    (a, remote, b)
}

/// 로컬 ref 가 있는지
fn has_ref(repo: &mut TestRepo, full: &str) -> bool {
    repo.git(["rev-parse", "-q", "--verify", full])
        .status
        .success()
}

/// G15: `fetch.pruneTags=true` 여도 자동 fetch 는 원격에 없는 로컬 tag 를 지우지 않는다 (TG-16).
/// 같은 설정에서 수동 fetch(`--prune`)는 설정대로 지운다 — 설정이 실제로 효과가 있음을 함께 확인한다
#[tokio::test]
async fn g15_auto_fetch_keeps_unpushed_tags_under_prune_tags() {
    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(Duration::from_millis(150)),
        ..CoreConfig::default()
    })
    .await;
    let (mut a, _remote, mut b) = two_clones();
    a.tag("local-only", false);
    a.git_ok(["config", "fetch.pruneTags", "true"]);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(a.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // 원격이 바뀐 뒤 자동 fetch 가 그것을 받아 올 때까지 기다린다 (그 fetch 는 반드시 한 번 이상 돌았다)
    let pushed = b.commit("from b");
    b.git_ok(["push", "-q", "origin", "main"]);
    // push 보다 먼저 돈 자동 fetch 도 AutoFetched 를 보낼 수 있다: git 2.48+ 는 첫 fetch 에서 origin/HEAD 를 만든다.
    // 그 이벤트에서 풀리지 않도록 origin/main 을 받아 온 바퀴까지 기다린다
    wait_for(&mut rx, Duration::from_secs(10), |e| {
        matches!(e, CoreEvent::AutoFetched { refs, .. } if refs.iter().any(|r| r == "origin/main"))
    })
    .await;
    assert_eq!(
        a.git_ok(["rev-parse", "refs/remotes/origin/main"]).trim(),
        pushed.to_hex()
    );
    assert!(
        has_ref(&mut a, "refs/tags/local-only"),
        "자동 fetch 가 push 하지 않은 tag 를 지웠다"
    );

    // 수동 fetch 는 사용자 설정(pruneTags)을 따른다
    core.fetch(opened.session, Some("origin"), true, None)
        .await
        .unwrap();
    assert!(
        !has_ref(&mut a, "refs/tags/local-only"),
        "수동 fetch --prune 은 fetch.pruneTags 를 따라야 한다"
    );
}

/// G17: pre-receive hook 거부는 branch push·tag push 모두 `RemoteRejected` (강제 push 를 권하지 않는다)
#[cfg(unix)]
#[tokio::test]
async fn g17_pre_receive_rejection_is_remote_rejected_for_branch_and_tag() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    install_remote_hook(
        &remote,
        "pre-receive",
        "#!/bin/sh\necho 'protected by policy' >&2\nexit 1\n",
    );
    repo.commit("local only");
    repo.tag("v1", true);
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    // branch push (코어 경로)
    let err = core
        .push(opened.session, PushSpec::default(), None)
        .await
        .unwrap_err();
    assert_eq!(
        err.hint(),
        Some(&GitHint::RemoteRejected {
            reason: "pre-receive hook declined".into()
        }),
        "{err:?}"
    );

    // tag push: 실제 git 이 내는 stderr 를 분류한다
    let out = repo.git(["push", "origin", "refs/tags/v1:refs/tags/v1"]);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        mgit_model::classify_stderr(&stderr),
        Some(GitHint::RemoteRejected {
            reason: "pre-receive hook declined".into()
        }),
        "{stderr}"
    );
}

/// G17: 원격에 같은 이름의 다른 tag 가 있으면 `RemoteTagExists`. 로컬 `tag … already exists` 는 None
#[tokio::test]
async fn g17_remote_tag_exists_and_local_duplicate_is_none() {
    let (mut repo, _remote) = repo_with_remote();
    repo.tag("v1", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1:refs/tags/v1"]);
    // 로컬에서 다른 commit 으로 다시 만든 뒤 push 하면 원격이 거부한다
    repo.commit("moved");
    repo.git_ok(["tag", "-f", "v1"]);
    let out = repo.git(["push", "origin", "refs/tags/v1:refs/tags/v1"]);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        mgit_model::classify_stderr(&stderr),
        Some(GitHint::RemoteTagExists),
        "{stderr}"
    );

    // 같은 이름으로 로컬 tag 를 다시 만들면 원격 충돌이 아니다
    let out = repo.git(["tag", "v1"]);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("already exists"), "{stderr}");
    assert_eq!(mgit_model::classify_stderr(&stderr), None, "{stderr}");
}

/// bare 원격(경로)에서 ref 가 가리키는 객체. 없으면 `None`
fn remote_ref(remote: &Path, full: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(remote)
        .args(["rev-parse", "-q", "--verify", full])
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 저장소를 코어로 열고 로드가 끝날 때까지 기다린다
async fn open(core: &Core, repo: &TestRepo) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    (opened.session, rx)
}

/// 이름 목록
fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

/// 결과에서 이름별 상태
fn status_of(results: &[TagRefResult], name: &str) -> Option<TagRefStatus> {
    results.iter().find(|r| r.name == name).map(|r| r.status)
}

/// 지금까지 쌓인 이벤트를 비운다
fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// K3: `push.followTags=true` 여도 `--no-follow-tags` 가 요청하지 않은 annotated tag 를 막는다.
/// 같은 설정에서 일반 push 는 다른 tag 를 따라 보낸다는 것을 두 번째 원격으로 함께 확인한다
#[tokio::test]
async fn k3_no_follow_tags_blocks_other_tags_under_follow_tags_config() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    let check = repo.add_bare_remote_named("check");
    repo.git_ok(["push", "-q", "check", "main"]);
    repo.git_ok(["config", "push.followTags", "true"]);
    repo.commit("unpushed");
    repo.tag("v1", true);
    repo.tag("other", true);

    // 대조군: 설정만으로는 요청하지 않은 tag 도 따라간다
    repo.git_ok(["push", "-q", "check", "refs/tags/v1:refs/tags/v1"]);
    assert!(
        remote_ref(&check, "refs/tags/other").is_some(),
        "대조군 전제"
    );

    let (session, _rx) = open(&core, &repo).await;
    let results = core
        .push_tags(session, "origin", &names(&["v1"]), None)
        .await
        .unwrap();
    assert_eq!(status_of(&results, "v1"), Some(TagRefStatus::Pushed));
    assert!(remote_ref(&remote, "refs/tags/v1").is_some());
    assert!(
        remote_ref(&remote, "refs/tags/other").is_none(),
        "--no-follow-tags 인데 다른 tag 가 따라갔다"
    );
}

/// G1·G4: push porcelain 형식. 결과 표는 stdout(`*`·`=`·`!`, `[new tag]`·`[up to date]`·`(already exists)`·
/// `[remote rejected]`, 전체 ref 이름)이고 stderr 와 섞이지 않으며, 일부 거부면 종료 코드 1 이다.
/// `keep_failed_output` 은 실패해도 stdout·status 를 주고, 기본 호출은 그대로 `CommandFailed` 다
#[cfg(unix)]
#[tokio::test]
async fn g1_g4_push_porcelain_format_and_keep_failed_output() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("same", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/same"]);
    repo.tag("moved", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/moved"]);
    repo.commit("next");
    repo.git_ok(["tag", "-f", "moved"]);
    repo.tag("fresh", true);
    repo.tag("blocked", false);
    // 이름이 blocked 인 ref 만 서버가 거부한다
    install_remote_hook(
        &remote,
        "pre-receive",
        "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = refs/tags/blocked ]; then echo no >&2; exit 1; fi\ndone\nexit 0\n",
    );
    let (session, _rx) = open(&core, &repo).await;

    // 거부 hook 이 있으면 한 명령의 다른 ref 도 함께 거부되므로 blocked 는 따로 보낸다
    let args = |refs: &[&str]| {
        let mut a: Vec<String> = names(&[
            "push",
            "--porcelain",
            "--no-follow-tags",
            "--end-of-options",
            "origin",
        ]);
        a.extend(refs.iter().map(|r| format!("refs/tags/{r}:refs/tags/{r}")));
        a
    };
    let out = core
        .run_write(
            session,
            WriteSpec::new(args(&["fresh", "same", "moved"]))
                .network()
                .no_undo()
                .keep_failed_output(),
        )
        .await
        .unwrap();
    assert_eq!(out.status, Some(1), "일부 거부면 종료 코드 1");
    let stdout = out.stdout_lossy();
    assert!(
        stdout.contains("*\trefs/tags/fresh:refs/tags/fresh\t[new tag]"),
        "{stdout}"
    );
    assert!(
        stdout.contains("=\trefs/tags/same:refs/tags/same\t[up to date]"),
        "{stdout}"
    );
    assert!(
        stdout.contains("!\trefs/tags/moved:refs/tags/moved\t[rejected] (already exists)"),
        "{stdout}"
    );
    // 결과 표는 stderr 로 가지 않는다
    assert!(!out.stderr.contains("[new tag]"), "{}", out.stderr);

    let out = core
        .run_write(
            session,
            WriteSpec::new(args(&["blocked"]))
                .network()
                .no_undo()
                .keep_failed_output(),
        )
        .await
        .unwrap();
    assert!(!out.success());
    assert!(
        out.stdout_lossy().contains(
            "!\trefs/tags/blocked:refs/tags/blocked\t[remote rejected] (pre-receive hook declined)"
        ),
        "{}",
        out.stdout_lossy()
    );

    // G4: 기본 호출부는 예전처럼 오류 (힌트 포함)
    let err = core
        .run_write(
            session,
            WriteSpec::new(args(&["blocked"])).network().no_undo(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::CommandFailed { .. }), "{err:?}");
}

/// G2: 로컬에만·같음·다름을 섞은 일괄 push 는 tag 별 결과를 주고, atomic 이 아니라 성공한 것은 올라간다
#[tokio::test]
async fn g2_mixed_batch_push_reports_per_tag_and_is_not_atomic() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("same", true);
    repo.tag("diff", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/same", "refs/tags/diff"]);
    repo.commit("later");
    repo.git_ok(["tag", "-f", "diff"]);
    repo.tag("local", false);
    let (session, _rx) = open(&core, &repo).await;

    let results = core
        .push_tags(session, "origin", &names(&["local", "same", "diff"]), None)
        .await
        .unwrap();
    // 요청 순서 그대로
    assert_eq!(
        results.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["local", "same", "diff"]
    );
    assert_eq!(status_of(&results, "local"), Some(TagRefStatus::Pushed));
    assert_eq!(status_of(&results, "same"), Some(TagRefStatus::UpToDate));
    assert_eq!(
        status_of(&results, "diff"),
        Some(TagRefStatus::RejectedExists)
    );
    assert_eq!(results[2].message.as_deref(), Some("already exists"));
    assert!(
        remote_ref(&remote, "refs/tags/local").is_some(),
        "atomic 이 아니다"
    );
}

/// G19: 같은 이름의 branch 가 있어도 refs/tags 만 push 된다
#[tokio::test]
async fn g19_same_named_branch_is_not_pushed() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.commit("branch tip");
    repo.branch("v1");
    repo.checkout("HEAD~1");
    repo.tag("v1", false);
    repo.checkout("main");
    let (session, _rx) = open(&core, &repo).await;

    let results = core
        .push_tags(session, "origin", &names(&["v1"]), None)
        .await
        .unwrap();
    assert_eq!(status_of(&results, "v1"), Some(TagRefStatus::Pushed));
    let tag_target = repo.git_ok(["rev-parse", "refs/tags/v1"]);
    assert_eq!(
        remote_ref(&remote, "refs/tags/v1").as_deref(),
        Some(tag_target.trim())
    );
    assert!(remote_ref(&remote, "refs/heads/v1").is_none());
}

/// 이름·원격 검사: 등록되지 않은 원격, refspec 을 깨는 이름은 git 을 돌리지 않고 거부하고 op 를 닫는다
#[tokio::test]
async fn push_tags_rejects_unknown_remote_and_bad_names() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    repo.tag("v1", false);
    let (session, mut rx) = open(&core, &repo).await;
    let op = core.begin_operation(session, "push", "push tags").unwrap();
    let op_id = op.id;
    let err = core
        .push_tags(session, "nope", &names(&["v1"]), Some(op))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(drain(&mut rx).iter().any(|e| matches!(
        e,
        CoreEvent::OperationFinished { op_id: id, ok: false, .. } if *id == op_id
    )));
    for bad in ["v1:refs/heads/main", "v*", "-v", "a b"] {
        let err = core
            .push_tags(session, "origin", &names(&[bad]), None)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad}: {err:?}");
    }
    // 빈 목록은 아무것도 하지 않는다
    assert!(
        core.push_tags(session, "origin", &[], None)
            .await
            .unwrap()
            .is_empty()
    );
}

/// 첫 청크가 결과 표 없이 통째로 실패하면(연결 불가) 오류로 돌려준다
#[tokio::test]
async fn push_tags_whole_failure_is_an_error() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.git_ok(["remote", "add", "origin", "/nonexistent/mgit-remote.git"]);
    repo.tag("v1", false);
    let (session, _rx) = open(&core, &repo).await;
    let err = core
        .push_tags(session, "origin", &names(&["v1"]), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::CommandFailed { .. }), "{err:?}");
}

/// G5: 예산을 주입하면 청크로 나눠 돌고(ref 1개씩 → push 3번), op 시작·끝은 한 쌍이다
#[tokio::test]
async fn g5_chunks_share_one_operation() {
    let core = core_with(CoreConfig {
        tag_chunk_refs: 1,
        ..CoreConfig::default()
    })
    .await;
    let (mut repo, remote) = repo_with_remote();
    for n in ["c1", "c2", "c3"] {
        repo.tag(n, false);
    }
    let (session, mut rx) = open(&core, &repo).await;
    drain(&mut rx);
    let op = core.begin_operation(session, "push", "push tags").unwrap();
    let op_id = op.id;
    let results = core
        .push_tags(session, "origin", &names(&["c1", "c2", "c3"]), Some(op))
        .await
        .unwrap();
    assert!(
        results.iter().all(|r| r.status == TagRefStatus::Pushed),
        "{results:?}"
    );
    for n in ["c1", "c2", "c3"] {
        assert!(remote_ref(&remote, &format!("refs/tags/{n}")).is_some());
    }
    let pushes = core
        .command_log_recent(50)
        .iter()
        .filter(|r| r.args.iter().any(|a| a == "push") && r.args.iter().any(|a| a == "--porcelain"))
        .count();
    assert_eq!(pushes, 3, "청크마다 push 한 번");
    let events = drain(&mut rx);
    let started = events
        .iter()
        .filter(|e| matches!(e, CoreEvent::OperationStarted { op_id: id, .. } if *id == op_id))
        .count();
    let finished: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, CoreEvent::OperationFinished { op_id: id, .. } if *id == op_id))
        .collect();
    assert_eq!(started, 1, "{events:#?}");
    assert_eq!(finished.len(), 1, "{events:#?}");
    assert!(matches!(
        finished[0],
        CoreEvent::OperationFinished {
            ok: true,
            cancelled: false,
            ..
        }
    ));
}

/// G5: 청크 사이에서 취소하면 끝난 청크 결과는 남고, 실행 중·남은 ref 는 unknown 이다
#[cfg(unix)]
#[tokio::test]
async fn g5_cancel_between_chunks_leaves_rest_unknown() {
    let core = core_with(CoreConfig {
        tag_chunk_refs: 1,
        ..CoreConfig::default()
    })
    .await;
    let (mut repo, remote) = repo_with_remote();
    for n in ["c1", "c2", "c3"] {
        repo.tag(n, false);
    }
    // 두 번째 push 의 hook 이 표시 파일을 만든 뒤 풀어 줄 때까지(최대 10초) 붙잡는다
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    install_remote_hook(
        &remote,
        "pre-receive",
        &format!(
            "#!/bin/sh\nn=$(cat '{d}/count' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '{d}/count'\nif [ \"$n\" -eq 2 ]; then\n  touch '{d}/started'\n  i=0\n  while [ ! -f '{d}/release' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n  exit 1\nfi\nexit 0\n"
        ),
    );
    let (session, mut rx) = open(&core, &repo).await;
    drain(&mut rx);
    let op = core.begin_operation(session, "push", "push tags").unwrap();
    let op_id = op.id;
    let started = dir.path().join("started");
    let release = dir.path().join("release");
    let cancel = async {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("두 번째 청크가 시작되지 않음");
        assert!(core.cancel_operation(op_id));
        std::fs::write(&release, "").unwrap();
    };
    let list = names(&["c1", "c2", "c3"]);
    let (results, ()) = tokio::join!(core.push_tags(session, "origin", &list, Some(op)), cancel);
    let results = results.unwrap();
    assert_eq!(status_of(&results, "c1"), Some(TagRefStatus::Pushed));
    assert_eq!(status_of(&results, "c2"), Some(TagRefStatus::Unknown));
    assert_eq!(status_of(&results, "c3"), Some(TagRefStatus::Unknown));
    assert!(
        remote_ref(&remote, "refs/tags/c3").is_none(),
        "취소 뒤 남은 청크를 돌렸다"
    );
    let events = drain(&mut rx);
    let finished: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, CoreEvent::OperationFinished { op_id: id, .. } if *id == op_id))
        .collect();
    assert_eq!(finished.len(), 1, "{events:#?}");
    assert!(matches!(
        finished[0],
        CoreEvent::OperationFinished {
            ok: false,
            cancelled: true,
            ..
        }
    ));
}

/// 원격 삭제 요청 (기대값 없음)
fn del(list: &[&str]) -> Vec<TagDeleteItem> {
    list.iter()
        .map(|n| TagDeleteItem {
            name: (*n).to_string(),
            expected_remote: None,
        })
        .collect()
}

/// 로컬 ref 가 가리키는 객체 hex
fn local_ref(repo: &mut TestRepo, full: &str) -> String {
    repo.git_ok(["rev-parse", full]).trim().to_string()
}

/// lease 를 건 원격 삭제 명령 (raw). `leases` 는 (tag 이름, 기대 oid)
async fn raw_delete(
    core: &Core,
    session: SessionId,
    leases: &[(&str, &str)],
    refs: &[&str],
) -> mgit_core::WriteResult {
    let mut args = names(&["push", "--porcelain", "--no-follow-tags", "--delete"]);
    for (n, oid) in leases {
        args.push(format!("--force-with-lease=refs/tags/{n}:{oid}"));
    }
    args.push("--end-of-options".into());
    args.push("origin".into());
    args.extend(refs.iter().map(|r| format!("refs/tags/{r}")));
    core.run_write(
        session,
        WriteSpec::new(args)
            .network()
            .no_undo()
            .keep_failed_output(),
    )
    .await
    .unwrap()
}

/// K1: 삭제에도 lease 가 적용된다. 값이 다르거나 원격에 없으면 stale 이고 원격은 그대로다
#[tokio::test]
async fn k1_lease_applies_to_delete() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("v1", true);
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1"]);
    let v1 = local_ref(&mut repo, "refs/tags/v1");
    let head = local_ref(&mut repo, "HEAD");
    let (session, _rx) = open(&core, &repo).await;

    // 값이 다르면 stale, 원격 그대로
    let out = raw_delete(&core, session, &[("v1", &head)], &["v1"]).await;
    assert!(!out.success());
    assert!(
        out.stdout_lossy()
            .contains("!\t(delete):refs/tags/v1\t[rejected] (stale info)"),
        "{}",
        out.stdout_lossy()
    );
    assert_eq!(
        remote_ref(&remote, "refs/tags/v1").as_deref(),
        Some(v1.as_str())
    );

    // 원격에 없는데 lease 를 걸면 stale
    let out = raw_delete(&core, session, &[("gone", &head)], &["gone"]).await;
    assert!(!out.success());
    assert!(
        out.stdout_lossy()
            .contains("!\t(delete):refs/tags/gone\t[rejected] (stale info)"),
        "{} / {}",
        out.stdout_lossy(),
        out.stderr
    );

    // 값이 맞으면 지워지고 `-` 줄이 나온다
    let out = raw_delete(&core, session, &[("v1", &v1)], &["v1"]).await;
    assert!(out.success(), "{}", out.stderr);
    assert!(
        out.stdout_lossy().contains("-\t:refs/tags/v1\t[deleted]"),
        "{}",
        out.stdout_lossy()
    );
    assert!(remote_ref(&remote, "refs/tags/v1").is_none());
}

/// G3: 한 명령에 lease 여러 개를 걸면 ref 마다 따로 적용된다 — 하나만 stale 이면 나머지는 지워진다.
/// 같은 이름의 원격 branch 는 그대로다
#[tokio::test]
async fn g3_leases_apply_per_ref() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    for n in ["a", "b", "c"] {
        repo.tag(n, false);
    }
    repo.git_ok([
        "push",
        "-q",
        "origin",
        "refs/tags/a",
        "refs/tags/b",
        "refs/tags/c",
    ]);
    repo.git_ok(["push", "-q", "origin", "HEAD:refs/heads/a"]);
    let a = local_ref(&mut repo, "refs/tags/a");
    let c = local_ref(&mut repo, "refs/tags/c");
    let wrong = local_ref(&mut repo, "HEAD~1");
    let (session, _rx) = open(&core, &repo).await;

    let out = raw_delete(
        &core,
        session,
        &[("a", &a), ("b", &wrong), ("c", &c)],
        &["a", "b", "c"],
    )
    .await;
    let stdout = out.stdout_lossy();
    assert_eq!(out.status, Some(1), "{stdout}");
    assert!(stdout.contains("-\t:refs/tags/a\t[deleted]"), "{stdout}");
    // 거부된 삭제 줄의 보낸 쪽은 빈 문자열이 아니라 `(delete)` 다
    assert!(
        stdout.contains("!\t(delete):refs/tags/b\t[rejected] (stale info)"),
        "{stdout}"
    );
    assert!(stdout.contains("-\t:refs/tags/c\t[deleted]"), "{stdout}");
    assert!(remote_ref(&remote, "refs/tags/a").is_none());
    assert!(remote_ref(&remote, "refs/tags/b").is_some());
    assert!(remote_ref(&remote, "refs/tags/c").is_none());
    assert!(
        remote_ref(&remote, "refs/heads/a").is_some(),
        "같은 이름 branch 는 그대로"
    );
}

/// G6: 단일 조회는 `refs/tags/<n>`·`refs/tags/<n>^{}` 두 패턴으로 벗긴 줄까지 받고, 비슷한 이름은 걸리지 않는다
#[tokio::test]
async fn g6_single_lookup_peels_and_matches_exact_names() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    repo.tag("v1", true);
    for n in ["xv1", "release/v1", "v1.0", "v10", "light"] {
        repo.tag(n, false);
    }
    repo.git_ok(["push", "-q", "origin", "--tags"]);
    repo.git_ok(["push", "-q", "origin", "HEAD:refs/heads/v1"]);
    let v1_obj = local_ref(&mut repo, "refs/tags/v1");
    let v1_commit = local_ref(&mut repo, "refs/tags/v1^{}");
    let (session, _rx) = open(&core, &repo).await;

    // 단일 조회가 실제로 두 패턴을 넘기는지 명령 로그로 확인한다
    let found = core
        .lookup_remote_tags(session, "origin", &names(&["v1", "light", "missing"]), None)
        .await
        .unwrap();
    assert_eq!(
        found.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["v1", "light"]
    );
    assert_eq!(found[0].object.to_hex(), v1_obj);
    assert_eq!(found[0].peeled.map(|o| o.to_hex()), Some(v1_commit.clone()));
    assert_eq!(found[1].peeled, None);
    let ls = core
        .command_log_recent(20)
        .into_iter()
        .find(|r| r.args.iter().any(|a| a == "ls-remote"))
        .unwrap();
    assert!(
        ls.args.iter().any(|a| a == "refs/tags/v1^{}"),
        "{:?}",
        ls.args
    );

    // 패턴만으로 조회해도 비슷한 이름은 나오지 않는다 (raw)
    let out = core
        .run_write(
            session,
            WriteSpec::new(names(&[
                "ls-remote",
                "--tags",
                "--end-of-options",
                "origin",
                "refs/tags/v1",
                "refs/tags/v1^{}",
            ]))
            .network()
            .no_undo(),
        )
        .await
        .unwrap();
    let refs: Vec<String> = out
        .stdout_lossy()
        .lines()
        .filter_map(|l| l.split_once('\t').map(|(_, r)| r.to_string()))
        .collect();
    assert_eq!(refs, ["refs/tags/v1", "refs/tags/v1^{}"], "{refs:?}");
}

/// G18: 원격 경량과 로컬 annotated 가 같은 commit 이면 객체가 달라 삭제가 `diverged` 를 돌려준다.
/// 그때 본 원격 객체를 `expected_remote` 로 다시 부르면 지워진다. 그 사이 또 바뀌었으면 `rejectedStale`
#[tokio::test]
async fn g18_diverged_then_delete_with_expected_remote() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("v1", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1"]);
    repo.git_ok(["tag", "-d", "v1"]);
    repo.tag("v1", true);
    let commit = local_ref(&mut repo, "HEAD");
    let (session, _rx) = open(&core, &repo).await;

    let r = core
        .delete_remote_tags(session, "origin", &del(&["v1"]), None)
        .await
        .unwrap();
    assert_eq!(r[0].status, TagRefStatus::Diverged);
    assert_eq!(r[0].remote_oid.map(|o| o.to_hex()), Some(commit.clone()));
    assert_eq!(r[0].remote_commit.map(|o| o.to_hex()), Some(commit.clone()));
    assert!(
        remote_ref(&remote, "refs/tags/v1").is_some(),
        "diverged 는 지우지 않는다"
    );

    // 기대값이 지금 원격과 다르면(확인한 뒤 또 바뀜) 지우지 않고 stale
    let stale_expect = Oid::from_hex(local_ref(&mut repo, "refs/tags/v1").as_bytes()).unwrap();
    let stale = core
        .delete_remote_tags(
            session,
            "origin",
            &[TagDeleteItem {
                name: "v1".into(),
                expected_remote: Some(stale_expect),
            }],
            None,
        )
        .await
        .unwrap();
    assert_eq!(stale[0].status, TagRefStatus::RejectedStale);
    assert!(stale[0].message.is_some());
    assert!(remote_ref(&remote, "refs/tags/v1").is_some());

    let r = core
        .delete_remote_tags(
            session,
            "origin",
            &[TagDeleteItem {
                name: "v1".into(),
                expected_remote: r[0].remote_oid,
            }],
            None,
        )
        .await
        .unwrap();
    assert_eq!(r[0].status, TagRefStatus::Deleted);
    assert!(remote_ref(&remote, "refs/tags/v1").is_none());
    // 로컬은 건드리지 않는다
    assert!(has_ref(&mut repo, "refs/tags/v1"));
}

/// G18 (확인 전에는 아무것도 지우지 않음): diverged 가 섞인 다건 호출은 원격을 하나도 바꾸지 않고 diverged·notRun 을
/// 돌려준다. diverged 를 빼고 다시 부르면 나머지만, `expected_remote` 를 채워 부르면 전부 지워진다
#[tokio::test]
async fn g18_mixed_call_deletes_nothing_until_confirmed() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    for n in ["d1", "same", "keep", "later"] {
        repo.tag(n, false);
    }
    repo.tag("remote-only", false);
    repo.git_ok([
        "push",
        "-q",
        "origin",
        "refs/tags/d1",
        "refs/tags/same",
        "refs/tags/keep",
        "refs/tags/later",
        "refs/tags/remote-only",
    ]);
    repo.git_ok(["tag", "-d", "remote-only", "d1"]);
    // d1 은 로컬 annotated 로 다시 만들어 원격(경량)과 객체가 다르다
    repo.tag("d1", true);
    let remote_before: Vec<Option<String>> = ["d1", "same", "keep", "later", "remote-only"]
        .iter()
        .map(|n| remote_ref(&remote, &format!("refs/tags/{n}")))
        .collect();
    let (session, mut rx) = open(&core, &repo).await;
    drain(&mut rx);

    let op = core.begin_operation(session, "push", "delete").unwrap();
    let r = core
        .delete_remote_tags(
            session,
            "origin",
            &del(&["same", "d1", "remote-only", "absent"]),
            Some(op),
        )
        .await
        .unwrap();
    assert_eq!(
        r.iter()
            .map(|x| (x.name.as_str(), x.status))
            .collect::<Vec<_>>(),
        [
            ("same", TagRefStatus::NotRun),
            ("d1", TagRefStatus::Diverged),
            ("remote-only", TagRefStatus::NotRun),
            ("absent", TagRefStatus::NotRun),
        ]
    );
    assert!(r[1].remote_oid.is_some() && r[1].remote_commit.is_some());
    assert!(!TagRefStatus::NotRun.is_success());
    let remote_after: Vec<Option<String>> = ["d1", "same", "keep", "later", "remote-only"]
        .iter()
        .map(|n| remote_ref(&remote, &format!("refs/tags/{n}")))
        .collect();
    assert_eq!(
        remote_before, remote_after,
        "확인 전에는 원격이 하나도 바뀌지 않는다"
    );
    // 삭제 명령은 돌지 않았다 (조회만)
    assert!(
        !core
            .command_log_recent(usize::MAX)
            .iter()
            .any(|c| c.args.iter().any(|a| a == "--delete")),
        "삭제 명령이 돌았다"
    );

    // [다른 tag 는 건너뛰고 삭제]: diverged 를 빼고 다시 부르면 나머지만 지워진다 (원격에만 있는 tag 는 비교 없이)
    let r = core
        .delete_remote_tags(session, "origin", &del(&["same", "remote-only"]), None)
        .await
        .unwrap();
    assert_eq!(status_of(&r, "same"), Some(TagRefStatus::Deleted));
    assert_eq!(status_of(&r, "remote-only"), Some(TagRefStatus::Deleted));
    assert!(remote_ref(&remote, "refs/tags/d1").is_some());

    // [그래도 원격에서 삭제]: diverged 항목에 expected_remote 를 채우면 섞여 있어도 전부 지워진다
    let probe = core
        .delete_remote_tags(session, "origin", &del(&["d1", "keep"]), None)
        .await
        .unwrap();
    assert_eq!(status_of(&probe, "keep"), Some(TagRefStatus::NotRun));
    let d1_remote = probe
        .iter()
        .find(|x| x.name == "d1")
        .and_then(|x| x.remote_oid);
    let r = core
        .delete_remote_tags(
            session,
            "origin",
            &[
                TagDeleteItem {
                    name: "d1".into(),
                    expected_remote: d1_remote,
                },
                TagDeleteItem {
                    name: "keep".into(),
                    expected_remote: None,
                },
                TagDeleteItem {
                    name: "later".into(),
                    expected_remote: None,
                },
            ],
            None,
        )
        .await
        .unwrap();
    assert!(r.iter().all(|x| x.status == TagRefStatus::Deleted), "{r:?}");
    for n in ["d1", "keep", "later"] {
        assert!(remote_ref(&remote, &format!("refs/tags/{n}")).is_none());
    }
}

/// 원격 삭제 결과 묶음: 같은 객체면 지우고, 원격에 없으면 alreadyAbsent, 원격에만 있으면 비교 없이 지운다.
/// op 는 조회와 삭제를 합쳐 한 번 닫힌다
#[tokio::test]
async fn delete_remote_tags_mixed_results() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("same", true);
    repo.tag("remote-only", false);
    repo.git_ok([
        "push",
        "-q",
        "origin",
        "refs/tags/same",
        "refs/tags/remote-only",
    ]);
    repo.git_ok(["tag", "-d", "remote-only"]);
    repo.tag("local-only", false);
    let (session, mut rx) = open(&core, &repo).await;
    drain(&mut rx);
    let op = core
        .begin_operation(session, "push", "delete tags")
        .unwrap();
    let op_id = op.id;
    let r = core
        .delete_remote_tags(
            session,
            "origin",
            &del(&["same", "local-only", "remote-only"]),
            Some(op),
        )
        .await
        .unwrap();
    assert_eq!(status_of(&r, "same"), Some(TagRefStatus::Deleted));
    assert_eq!(
        status_of(&r, "local-only"),
        Some(TagRefStatus::AlreadyAbsent)
    );
    assert_eq!(status_of(&r, "remote-only"), Some(TagRefStatus::Deleted));
    assert!(remote_ref(&remote, "refs/tags/same").is_none());
    assert!(remote_ref(&remote, "refs/tags/remote-only").is_none());
    let events = drain(&mut rx);
    let finished: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, CoreEvent::OperationFinished { op_id: id, .. } if *id == op_id))
        .collect();
    assert_eq!(finished.len(), 1, "{events:#?}");
    assert!(matches!(
        finished[0],
        CoreEvent::OperationFinished { ok: true, .. }
    ));
    // 원격 삭제는 undo 대상이 아니다
    assert!(core.undo_entries(session).unwrap().0.is_empty());
}

/// G10: 로컬 일괄 삭제는 원자적이고(하나라도 지울 수 없으면 아무것도 안 지움), undo 하나로 annotated 객체까지
/// 전부 복구되고, 라벨이 `tag -d a b c (+N)` 이다
#[tokio::test]
async fn g10_local_batch_delete_is_atomic_with_one_undo() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    for (n, annotated) in [("a", true), ("b", false), ("c", true), ("d", false)] {
        repo.tag(n, annotated);
    }
    let before: Vec<String> = ["a", "b", "c", "d"]
        .iter()
        .map(|n| local_ref(&mut repo, &format!("refs/tags/{n}")))
        .collect();
    let (session, _rx) = open(&core, &repo).await;
    let all = names(&["a", "b", "c", "d"]);

    // b 를 잠가 두면 트랜잭션 전체가 실패한다
    let lock = repo.path().join(".git/refs/tags/b.lock");
    std::fs::write(&lock, "").unwrap();
    let err = core.delete_local_tags(session, &all).await.unwrap_err();
    assert!(matches!(err, CoreError::CommandFailed { .. }), "{err:?}");
    for n in ["a", "b", "c", "d"] {
        assert!(
            has_ref(&mut repo, &format!("refs/tags/{n}")),
            "{n} 이 지워졌다"
        );
    }
    assert!(core.undo_entries(session).unwrap().0.is_empty());
    std::fs::remove_file(&lock).unwrap();

    // 없는 이름이 섞이면 git 을 돌리지 않고 거부한다
    let err = core
        .delete_local_tags(session, &names(&["a", "nope"]))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert!(has_ref(&mut repo, "refs/tags/a"));

    core.delete_local_tags(session, &all).await.unwrap();
    for n in ["a", "b", "c", "d"] {
        assert!(!has_ref(&mut repo, &format!("refs/tags/{n}")));
    }
    let (entries, _) = core.undo_entries(session).unwrap();
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].label, "tag -d a b c (+1)");

    let undone = core.undo(session).await.unwrap().unwrap();
    assert!(undone.skipped.is_empty(), "{undone:?}");
    let after: Vec<String> = ["a", "b", "c", "d"]
        .iter()
        .map(|n| local_ref(&mut repo, &format!("refs/tags/{n}")))
        .collect();
    assert_eq!(before, after, "annotated 객체까지 그대로 복구");
    assert_eq!(repo.git_ok(["cat-file", "-t", "refs/tags/a"]).trim(), "tag");
}

/// K2 (수동 fetch): 로컬에서만 지운 tag 는 수동 fetch 로 다시 생긴다 (annotated·경량 모두).
/// 원격에서도 지우면 다시 생기지 않는다
#[tokio::test]
async fn k2_local_only_delete_comes_back_on_manual_fetch() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    repo.tag("ann", true);
    repo.tag("light", false);
    repo.tag("both", true);
    repo.git_ok([
        "push",
        "-q",
        "origin",
        "refs/tags/ann",
        "refs/tags/light",
        "refs/tags/both",
    ]);
    let (session, _rx) = open(&core, &repo).await;

    core.delete_local_tags(session, &names(&["ann", "light", "both"]))
        .await
        .unwrap();
    let r = core
        .delete_remote_tags(session, "origin", &del(&["both"]), None)
        .await
        .unwrap();
    assert_eq!(r[0].status, TagRefStatus::Deleted);
    core.fetch(session, Some("origin"), false, None)
        .await
        .unwrap();
    assert!(
        has_ref(&mut repo, "refs/tags/ann"),
        "annotated tag 가 다시 생겨야 한다"
    );
    assert!(
        has_ref(&mut repo, "refs/tags/light"),
        "경량 tag 가 다시 생겨야 한다"
    );
    assert!(
        !has_ref(&mut repo, "refs/tags/both"),
        "두 쪽 다 지운 tag 는 생기지 않는다"
    );
}

/// K2 (자동 fetch): 로컬에서만 지운 tag 는 자동 fetch 로도 다시 생긴다. 그 뒤 삭제의 undo 는
/// - 같은 객체로 돌아온 tag 는 이미 삭제 전 값이므로 할 일이 없다 (건너뛰기도 아님)
/// - 원격 것이 다른 객체였으면 그 객체로 생기고, undo 는 그 tag 를 건너뛰기로 보고한다
#[tokio::test]
async fn k2_local_only_delete_comes_back_on_auto_fetch_and_undo_reports() {
    let core = core_with(CoreConfig {
        auto_fetch_interval: Some(Duration::from_millis(150)),
        ..CoreConfig::default()
    })
    .await;
    let (mut repo, _remote) = repo_with_remote();
    repo.tag("same", true);
    repo.git_ok(["push", "-q", "origin", "refs/tags/same"]);
    // 원격은 경량, 로컬은 같은 이름의 annotated (객체가 다르다)
    repo.tag("diff", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/diff"]);
    let remote_diff = local_ref(&mut repo, "refs/tags/diff");
    repo.git_ok(["tag", "-d", "diff"]);
    repo.tag("diff", true);
    let same = local_ref(&mut repo, "refs/tags/same");
    let (session, _rx) = open(&core, &repo).await;

    core.delete_local_tags(session, &names(&["same", "diff"]))
        .await
        .unwrap();
    // 자동 fetch 는 원격 추적 ref 가 바뀔 때만 알리므로 tag 가 생길 때까지 본다
    tokio::time::timeout(Duration::from_secs(10), async {
        while !(has_ref(&mut repo, "refs/tags/same") && has_ref(&mut repo, "refs/tags/diff")) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("자동 fetch 로 다시 생기지 않음");
    assert_eq!(local_ref(&mut repo, "refs/tags/same"), same);
    assert_eq!(
        local_ref(&mut repo, "refs/tags/diff"),
        remote_diff,
        "원격 것으로 생긴다"
    );

    let undone = core.undo(session).await.unwrap().unwrap();
    assert_eq!(undone.entry.label, "tag -d same diff");
    assert_eq!(undone.skipped, ["refs/tags/diff"]);
    // 아무것도 되돌리지 못했으므로 redo 도 없다
    assert_eq!(core.undo_entries(session).unwrap().1, 0);
    assert_eq!(local_ref(&mut repo, "refs/tags/diff"), remote_diff);
}

/// 원격 tag 상태 보고서를 조회한다 (조회 op 없이)
async fn check(core: &Core, session: SessionId, remote: &str) -> mgit_model::TagSyncReport {
    core.remote_tags(session, Some(remote), true, None)
        .await
        .unwrap()
}

/// 네트워크 없이 캐시로 만든 보고서
async fn cached(core: &Core, session: SessionId, remote: &str) -> mgit_model::TagSyncReport {
    core.remote_tags(session, Some(remote), false, None)
        .await
        .unwrap()
}

/// 지금까지 돈 `ls-remote` 명령 수
fn ls_remote_runs(core: &Core) -> usize {
    core.command_log_recent(usize::MAX)
        .iter()
        .filter(|r| r.args.iter().any(|a| a == "ls-remote"))
        .count()
}

/// 보고서 항목의 상태
fn state_of(report: &mgit_model::TagSyncReport, name: &str) -> Option<TagSyncState> {
    report
        .entries
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.state)
}

/// 상태 다섯 가지 분류와 G18(같은 commit 다른 객체): 확인 전에는 비어 있고, 확인하면 개수와 "같음"이 아닌 항목만 온다
#[tokio::test]
async fn remote_tags_classifies_five_states() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    repo.tag("same", true);
    repo.tag("diff", false);
    repo.tag("same-commit", false);
    repo.tag("remote-only", false);
    repo.git_ok([
        "push",
        "-q",
        "origin",
        "refs/tags/same",
        "refs/tags/diff",
        "refs/tags/same-commit",
        "refs/tags/remote-only",
    ]);
    repo.git_ok(["tag", "-d", "remote-only", "same-commit"]);
    repo.tag("same-commit", true);
    repo.commit("moved");
    repo.git_ok(["tag", "-f", "diff"]);
    repo.tag("local-only", false);
    let (session, _rx) = open(&core, &repo).await;

    let before = cached(&core, session, "origin").await;
    assert_eq!(before.checked_at, None);
    assert!(before.entries.is_empty());

    let r = check(&core, session, "origin").await;
    assert!(r.checked_at.is_some());
    assert!(!r.stale);
    assert_eq!(
        (
            r.counts.local_only,
            r.counts.remote_only,
            r.counts.same,
            r.counts.diverged
        ),
        (1, 1, 1, 2),
        "{r:#?}"
    );
    assert_eq!(state_of(&r, "same"), None, "같음은 항목에 싣지 않는다");
    assert_eq!(state_of(&r, "local-only"), Some(TagSyncState::LocalOnly));
    assert_eq!(state_of(&r, "remote-only"), Some(TagSyncState::RemoteOnly));
    assert_eq!(
        state_of(&r, "diff"),
        Some(TagSyncState::Diverged { same_commit: false })
    );
    assert_eq!(
        state_of(&r, "same-commit"),
        Some(TagSyncState::Diverged { same_commit: true })
    );
    // 원격을 고르지 않으면 업스트림의 원격(origin)
    let default = core.remote_tags(session, None, false, None).await.unwrap();
    assert_eq!(default.remote, "origin");
    assert_eq!(default.counts, r.counts);
}

/// G7: bare 원격 tag 5천 개를 한 번에 조회해 센다
#[tokio::test]
async fn g7_five_thousand_remote_tags() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    let head = local_ref(&mut repo, "HEAD");
    let script: String = (0..5_000)
        .map(|i| format!("create refs/tags/bulk/{i:05} {head}\n"))
        .collect();
    let out = repo.git_with_stdin(["update-ref", "--stdin"], Some(script.as_bytes()));
    assert!(out.status.success());
    repo.git_ok(["push", "-q", "origin", "--tags"]);
    let (session, _rx) = open(&core, &repo).await;
    let r = check(&core, session, "origin").await;
    assert_eq!(r.counts.same, 5_000, "{:?}", r.counts);
    assert!(r.entries.is_empty());
}

/// G12: 앱의 push·삭제는 네트워크 없이 캐시를 고치고, tag 를 받아 온 fetch 만 오래됨으로 만든다.
/// CLI 로 원격 URL·이름을 바꾸면 캐시가 없어진다
#[tokio::test]
async fn g12_invalidation_rules() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    a.tag("local", false);
    let (session, _rx) = open(&core, &a).await;
    let first = check(&core, session, "origin").await;
    assert_eq!(state_of(&first, "local"), Some(TagSyncState::LocalOnly));
    let runs = ls_remote_runs(&core);

    // push 결과가 네트워크 없이 반영된다
    core.push_tags(session, "origin", &names(&["local"]), None)
        .await
        .unwrap();
    let after_push = cached(&core, session, "origin").await;
    assert_eq!(state_of(&after_push, "local"), None, "{after_push:#?}");
    assert_eq!(after_push.counts.same, 1);
    assert_eq!(
        ls_remote_runs(&core),
        runs,
        "push 반영에 조회를 쓰지 않는다"
    );

    // 원격 삭제 결과도 반영된다 (삭제는 실행 직전 단일 조회를 쓴다)
    core.delete_remote_tags(session, "origin", &del(&["local"]), None)
        .await
        .unwrap();
    let after_delete = cached(&core, session, "origin").await;
    assert_eq!(
        state_of(&after_delete, "local"),
        Some(TagSyncState::LocalOnly)
    );
    assert!(!after_delete.stale);

    // tag 없는 fetch 는 오래됨으로 만들지 않는다
    b.commit("plain");
    b.git_ok(["push", "-q", "origin", "main"]);
    core.fetch(session, Some("origin"), false, None)
        .await
        .unwrap();
    assert!(!cached(&core, session, "origin").await.stale);

    // tag 를 받아 온 fetch 는 오래됨
    b.commit("tagged");
    b.tag("from-b", false);
    b.git_ok(["push", "-q", "origin", "main", "refs/tags/from-b"]);
    core.fetch(session, Some("origin"), false, None)
        .await
        .unwrap();
    assert!(has_ref(&mut a, "refs/tags/from-b"));
    assert!(cached(&core, session, "origin").await.stale);
    // 다시 확인하면 풀린다
    assert!(!check(&core, session, "origin").await.stale);

    // 그냥 branch push 는 그대로, follow-tags push 는 그 원격을 오래됨으로 (main 은 원격보다 뒤라 새 브랜치로 보낸다)
    a.checkout_new("topic");
    a.commit("mine");
    core.refresh(session).await.unwrap();
    core.push(session, PushSpec::default(), None).await.unwrap();
    assert!(!cached(&core, session, "origin").await.stale);
    a.commit("mine again");
    core.refresh(session).await.unwrap();
    core.push(
        session,
        PushSpec {
            tags: true,
            ..PushSpec::default()
        },
        None,
    )
    .await
    .unwrap();
    assert!(cached(&core, session, "origin").await.stale);

    // CLI 로 URL 을 바꾸면 캐시가 없어진다
    check(&core, session, "origin").await;
    let url = a.git_ok(["remote", "get-url", "origin"]).trim().to_string();
    a.git_ok(["remote", "set-url", "origin", &format!("{url}/")]);
    core.refresh(session).await.unwrap();
    assert_eq!(cached(&core, session, "origin").await.checked_at, None);

    // 이름을 바꾸면 새 이름에는 캐시가 없고 옛 이름은 원격이 아니다
    check(&core, session, "origin").await;
    a.git_ok(["remote", "rename", "origin", "renamed"]);
    core.refresh(session).await.unwrap();
    assert_eq!(cached(&core, session, "renamed").await.checked_at, None);
    let err = core
        .remote_tags(session, Some("origin"), false, None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
}

/// G13: 같은 common_dir 를 쓰는 워크트리 세션 둘이 캐시를 함께 보고, 마지막 세션을 닫으면 캐시가 지워진다.
/// 기록용: lease 가 맞으면 `--force` 없이도 원격의 다른 tag 를 덮는다 (`(already exists)` 를 넘는다)
#[tokio::test]
async fn g13_worktree_sessions_share_cache() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("v1", false);
    let wt = repo.add_worktree("wt", Some("feature"));
    let (main, _rx) = open(&core, &repo).await;
    let wt_repo = TestRepo::at(&wt);
    let (side, _rx2) = open(&core, &wt_repo).await;

    let r = check(&core, main, "origin").await;
    let shared = cached(&core, side, "origin").await;
    assert_eq!(shared.checked_at, r.checked_at);
    assert_eq!(shared.counts, r.counts);
    core.close_repo(main).unwrap();
    assert_eq!(cached(&core, side, "origin").await.checked_at, r.checked_at);
    core.close_repo(side).unwrap();
    let (again, _rx3) = open(&core, &repo).await;
    assert_eq!(cached(&core, again, "origin").await.checked_at, None);

    // 기록용: 원격 v1 이 다른 객체일 때 lease 일치만으로 덮어쓰기
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1"]);
    let old = local_ref(&mut repo, "refs/tags/v1");
    repo.commit("moved");
    repo.git_ok(["tag", "-f", "v1"]);
    let out = core
        .run_write(
            again,
            WriteSpec::new(names(&[
                "push",
                "--porcelain",
                "--no-follow-tags",
                &format!("--force-with-lease=refs/tags/v1:{old}"),
                "--end-of-options",
                "origin",
                "refs/tags/v1:refs/tags/v1",
            ]))
            .network()
            .no_undo()
            .keep_failed_output(),
        )
        .await
        .unwrap();
    assert!(out.success(), "{} / {}", out.stdout_lossy(), out.stderr);
    assert!(
        out.stdout_lossy().contains("+\trefs/tags/v1:refs/tags/v1"),
        "{}",
        out.stdout_lossy()
    );
    assert_eq!(
        remote_ref(&remote, "refs/tags/v1"),
        Some(local_ref(&mut repo, "refs/tags/v1"))
    );
}

/// G14: 오프라인이면 이전 항목을 지우지 않고 `last_error` 를 남긴다. 다시 연결되면 지워진다
#[tokio::test]
async fn g14_offline_keeps_previous_entries() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("local", false);
    let (session, mut rx) = open(&core, &repo).await;
    let good = check(&core, session, "origin").await;
    assert!(good.last_error.is_none());

    let moved = remote.with_extension("away");
    std::fs::rename(&remote, &moved).unwrap();
    drain(&mut rx);
    let op = core
        .begin_operation(session, "fetch", "check tags")
        .unwrap();
    let op_id = op.id;
    let offline = core
        .remote_tags(session, Some("origin"), true, Some(op))
        .await
        .unwrap();
    let err = offline.last_error.clone().unwrap();
    assert_eq!(err.kind, TagLookupErrorKind::Network, "{err:?}");
    assert!(!err.message.is_empty());
    assert_eq!(offline.checked_at, good.checked_at);
    assert_eq!(offline.counts, good.counts);
    assert_eq!(offline.entries, good.entries);
    assert!(drain(&mut rx).iter().any(|e| matches!(
        e,
        CoreEvent::OperationFinished { op_id: id, ok: false, .. } if *id == op_id
    )));

    std::fs::rename(&moved, &remote).unwrap();
    let back = check(&core, session, "origin").await;
    assert!(back.last_error.is_none());
}

/// 원격의 tag 들을 b 에서 만들어 올린다 (a 는 아직 모른다)
fn remote_tags_from_b(b: &mut TestRepo, list: &[(&str, bool)]) {
    for (name, annotated) in list {
        b.tag(name, *annotated);
    }
    let mut args = vec!["push".to_string(), "-q".into(), "origin".into()];
    args.extend(list.iter().map(|(n, _)| format!("refs/tags/{n}")));
    b.git_ok(args);
}

/// G8: 명시 tag fetch 는 지정한 것만 받는다(`--no-tags`). `+` 가 없으면 로컬의 다른 tag 를 덮지 않고(`!`),
/// 있으면 교체한다. 원격에 없는 이름이 하나라도 섞이면 전체가 멈춘다
#[tokio::test]
async fn g8_explicit_tag_fetch() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    b.commit("b only");
    b.git_ok(["push", "-q", "origin", "main"]);
    remote_tags_from_b(
        &mut b,
        &[("want", true), ("other", false), ("clash", false)],
    );
    // a 에는 같은 이름의 다른 clash 가 있다
    a.tag("clash", false);
    let local_clash = local_ref(&mut a, "refs/tags/clash");
    let remote_clash = local_ref(&mut b, "refs/tags/clash");
    let (session, _rx) = open(&core, &a).await;

    let r = core
        .fetch_tags(session, "origin", &names(&["want"]), false, None)
        .await
        .unwrap();
    assert_eq!(status_of(&r, "want"), Some(TagRefStatus::Fetched));
    assert!(has_ref(&mut a, "refs/tags/want"));
    assert!(
        !has_ref(&mut a, "refs/tags/other"),
        "--no-tags 인데 다른 tag 가 따라왔다"
    );
    assert_eq!(
        r[0].remote_commit.map(|o| o.to_hex()),
        Some(local_ref(&mut b, "refs/tags/want^{}"))
    );

    // 다시 받으면 같다
    let r = core
        .fetch_tags(session, "origin", &names(&["want"]), false, None)
        .await
        .unwrap();
    assert_eq!(status_of(&r, "want"), Some(TagRefStatus::UpToDate));

    // `+` 없이 다른 tag 는 덮지 않는다 — 원격 객체를 알려 준다
    let r = core
        .fetch_tags(session, "origin", &names(&["clash"]), false, None)
        .await
        .unwrap();
    assert_eq!(status_of(&r, "clash"), Some(TagRefStatus::RejectedExists));
    assert_eq!(
        r[0].remote_oid.map(|o| o.to_hex()),
        Some(remote_clash.clone())
    );
    assert_eq!(local_ref(&mut a, "refs/tags/clash"), local_clash);

    // `+` 면 교체한다
    let r = core
        .fetch_tags(session, "origin", &names(&["clash"]), true, None)
        .await
        .unwrap();
    assert_eq!(status_of(&r, "clash"), Some(TagRefStatus::Fetched));
    assert_eq!(local_ref(&mut a, "refs/tags/clash"), remote_clash);

    // 원격에 없는 이름이 섞이면 전체가 멈춘다 (other 도 받지 않는다)
    let err = core
        .fetch_tags(
            session,
            "origin",
            &names(&["other", "missing"]),
            false,
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::CommandFailed { .. }), "{err:?}");
    assert!(!has_ref(&mut a, "refs/tags/other"));
}

/// G9: `fetch.prune=true` 여도 명시 tag fetch 는 다른 ref(원격에 없는 로컬 tag·지워진 원격 브랜치)를 지우지 않는다
#[tokio::test]
async fn g9_explicit_fetch_ignores_fetch_prune() {
    let core = core().await;
    let (mut a, _remote, mut b) = two_clones();
    b.git_ok(["push", "-q", "origin", "HEAD:refs/heads/gone"]);
    a.git_ok(["fetch", "-q", "origin"]);
    b.git_ok(["push", "-q", "origin", "--delete", "gone"]);
    remote_tags_from_b(&mut b, &[("want", false)]);
    a.tag("mine", false);
    a.git_ok(["config", "fetch.prune", "true"]);
    a.git_ok(["config", "fetch.pruneTags", "true"]);
    let (session, _rx) = open(&core, &a).await;
    core.fetch_tags(session, "origin", &names(&["want"]), false, None)
        .await
        .unwrap();
    assert!(has_ref(&mut a, "refs/tags/want"));
    assert!(has_ref(&mut a, "refs/tags/mine"), "로컬 tag 가 지워졌다");
    assert!(
        has_ref(&mut a, "refs/remotes/origin/gone"),
        "원격 추적 ref 가 지워졌다"
    );
}

/// G11: `+` 교체는 undo 항목을 하나 만들고(`fetch +tag clash`), undo 하면 옛 객체로 돌아온다. 여럿을 청크로 받아도
/// undo 는 하나다
#[tokio::test]
async fn g11_overwrite_fetch_is_undoable() {
    let core = core_with(CoreConfig {
        tag_chunk_refs: 1,
        ..CoreConfig::default()
    })
    .await;
    let (mut a, _remote, mut b) = two_clones();
    b.commit("b only");
    b.git_ok(["push", "-q", "origin", "main"]);
    remote_tags_from_b(&mut b, &[("clash", true), ("n1", false), ("n2", false)]);
    a.tag("clash", true);
    let old = local_ref(&mut a, "refs/tags/clash");
    let (session, _rx) = open(&core, &a).await;

    core.fetch_tags(session, "origin", &names(&["clash"]), true, None)
        .await
        .unwrap();
    assert_ne!(local_ref(&mut a, "refs/tags/clash"), old);
    let (entries, _) = core.undo_entries(session).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].label, "fetch +tag clash");
    let undone = core.undo(session).await.unwrap().unwrap();
    assert!(undone.skipped.is_empty());
    assert_eq!(
        local_ref(&mut a, "refs/tags/clash"),
        old,
        "옛 tag 객체로 돌아온다"
    );

    // 청크 둘(예산 1개씩)이어도 undo 는 하나이고, 지운 뒤 상태 이벤트 순서가 맞도록 마지막에 다시 읽는다
    let r = core
        .fetch_tags(session, "origin", &names(&["n1", "n2"]), false, None)
        .await
        .unwrap();
    assert!(r.iter().all(|x| x.status == TagRefStatus::Fetched), "{r:?}");
    let (entries, _) = core.undo_entries(session).unwrap();
    assert_eq!(entries[0].label, "fetch tags n1 n2");
    let st = core.repo_state(session).unwrap();
    assert!(st.refs.labels.iter().any(|l| l.full_name == "refs/tags/n2"));
    core.undo(session).await.unwrap();
    assert!(!has_ref(&mut a, "refs/tags/n1"));
    assert!(!has_ref(&mut a, "refs/tags/n2"));
}

/// G16: tag 목록은 종류·만든 시각·commit 제목·tag 제목·tagger 를 준다. 경량은 tagger·tag 제목이 없다
#[tokio::test]
async fn g16_tag_list_fields() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    repo.commit("feat: 마지막 기능");
    repo.tag("v1", true);
    repo.tag("light", false);
    let (session, _rx) = open(&core, &repo).await;
    let list = core.tag_list(session).await.unwrap();
    assert_eq!(
        list.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["light", "v1"]
    );
    let v1 = &list[1];
    assert!(v1.annotated);
    assert_eq!(v1.object.to_hex(), local_ref(&mut repo, "refs/tags/v1"));
    assert_eq!(v1.commit.to_hex(), local_ref(&mut repo, "HEAD"));
    assert_eq!(v1.commit_subject, "feat: 마지막 기능");
    assert_eq!(v1.tag_subject.as_deref(), Some("v1"));
    assert_eq!(v1.tagger.as_deref(), Some("mGit Test <test@mgit.invalid>"));
    assert!(v1.date.is_some());
    let light = &list[0];
    assert!(!light.annotated);
    assert_eq!(light.commit, light.object);
    assert_eq!(light.commit_subject, "feat: 마지막 기능");
    assert_eq!(light.tag_subject, None);
    assert_eq!(light.tagger, None);
    assert!(light.date.is_some());
}

/// 가져오기 결과가 원격 tag 캐시에 반영된다 (네트워크 없이 원격에만 → 같음)
#[tokio::test]
async fn fetch_tags_updates_remote_cache() {
    let core = core().await;
    let (a, _remote, mut b) = two_clones();
    remote_tags_from_b(&mut b, &[("rt", true)]);
    let (session, _rx) = open(&core, &a).await;
    let r = check(&core, session, "origin").await;
    assert_eq!(state_of(&r, "rt"), Some(TagSyncState::RemoteOnly));
    let runs = ls_remote_runs(&core);
    core.fetch_tags(session, "origin", &names(&["rt"]), false, None)
        .await
        .unwrap();
    let after = cached(&core, session, "origin").await;
    assert_eq!(state_of(&after, "rt"), None, "{after:#?}");
    assert_eq!(after.counts.same, 1);
    assert!(!after.stale);
    assert_eq!(ls_remote_runs(&core), runs);
}

/// 덮어쓰기 요청
fn lease(name: &str, expected: &str) -> TagLeaseItem {
    TagLeaseItem {
        name: name.into(),
        expected_remote: Oid::from_hex(expected.as_bytes()).unwrap(),
    }
}

/// C2b: 원격 tag 를 로컬 것으로 lease push 한 번에 덮어쓴다. 그 사이 원격이 바뀌었으면 stale 이고 원격은 그대로,
/// 같은 이름의 원격 branch 는 무관하다. `--force` 단독 인자는 쓰지 않는다. 확인한 원격 상태도 네트워크 없이 고친다
#[tokio::test]
async fn replace_remote_tags_with_lease() {
    let core = core().await;
    let (mut repo, remote) = repo_with_remote();
    repo.tag("v1", false);
    repo.tag("v2", false);
    repo.git_ok(["push", "-q", "origin", "refs/tags/v1", "refs/tags/v2"]);
    repo.git_ok(["push", "-q", "origin", "HEAD:refs/heads/v1"]);
    let old = local_ref(&mut repo, "refs/tags/v1");
    let branch = remote_ref(&remote, "refs/heads/v1");
    repo.commit("moved");
    repo.git_ok(["tag", "-f", "v1"]);
    repo.git_ok(["tag", "-d", "v2"]);
    repo.tag("v2", true);
    let (session, _rx) = open(&core, &repo).await;
    let before = check(&core, session, "origin").await;
    assert_eq!(before.counts.diverged, 2);

    // 그 사이 바뀐 것으로 치는 잘못된 기대값: 거부되고 원격 그대로
    let head = local_ref(&mut repo, "HEAD");
    let stale = core
        .replace_remote_tags(session, "origin", &[lease("v1", &head)], None)
        .await
        .unwrap();
    assert_eq!(stale[0].status, TagRefStatus::RejectedStale);
    assert_eq!(remote_ref(&remote, "refs/tags/v1"), Some(old.clone()));

    let r = core
        .replace_remote_tags(
            session,
            "origin",
            &[lease("v1", &old), lease("v2", &old)],
            None,
        )
        .await
        .unwrap();
    assert!(r.iter().all(|x| x.status == TagRefStatus::Pushed), "{r:?}");
    assert_eq!(
        remote_ref(&remote, "refs/tags/v1"),
        Some(local_ref(&mut repo, "refs/tags/v1"))
    );
    assert_eq!(
        remote_ref(&remote, "refs/tags/v2"),
        Some(local_ref(&mut repo, "refs/tags/v2"))
    );
    assert_eq!(
        remote_ref(&remote, "refs/heads/v1"),
        branch,
        "같은 이름 branch 는 그대로"
    );

    let log = core.command_log_recent(usize::MAX);
    let push = log
        .iter()
        .find(|c| {
            c.args
                .iter()
                .any(|a| a.starts_with("--force-with-lease=refs/tags/v1:"))
        })
        .expect("lease push 명령");
    assert!(
        !push.args.iter().any(|a| a == "--force" || a == "-f"),
        "{:?}",
        push.args
    );

    // 확인한 원격 상태가 네트워크 없이 바뀐다 (stale 거부로 모름이 된 v1 도 덮어쓴 뒤에는 같음)
    let after = cached(&core, session, "origin").await;
    assert_eq!(after.counts.diverged, 0, "{after:#?}");
    assert_eq!(after.counts.unknown, 0, "{after:#?}");
    assert_eq!(after.counts.same, 2);
}

/// C2c: 이름 4개까지는 이름 패턴으로, 5개부터는 전체 조회로 찾는다 (B4 실측 손익분기). 결과는 같다
#[tokio::test]
async fn lookup_switches_to_full_listing_above_four_names() {
    let core = core().await;
    let (mut repo, _remote) = repo_with_remote();
    for n in ["a", "b", "c", "d", "e", "other"] {
        repo.tag(n, false);
    }
    repo.git_ok(["push", "-q", "origin", "--tags"]);
    let (session, _rx) = open(&core, &repo).await;

    /// 마지막 ls-remote 명령의 원격 뒤 인자 (패턴)
    fn last_patterns(core: &Core) -> Vec<String> {
        let rec = core
            .command_log_recent(usize::MAX)
            .into_iter()
            .find(|r| r.args.iter().any(|a| a == "ls-remote"))
            .unwrap();
        let at = rec.args.iter().position(|a| a == "origin").unwrap();
        rec.args[at + 1..].to_vec()
    }

    let four = core
        .lookup_remote_tags(session, "origin", &names(&["a", "b", "c", "d"]), None)
        .await
        .unwrap();
    assert_eq!(four.len(), 4);
    assert_eq!(last_patterns(&core).len(), 8, "4개는 이름마다 패턴 두 개");

    let five = core
        .lookup_remote_tags(session, "origin", &names(&["a", "b", "c", "d", "e"]), None)
        .await
        .unwrap();
    assert_eq!(
        five.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["a", "b", "c", "d", "e"],
        "전체 조회여도 요청한 것만"
    );
    assert!(last_patterns(&core).is_empty(), "5개는 전체 조회");

    // 원격 삭제의 실행 직전 조회도 같은 기준이다
    core.delete_remote_tags(session, "origin", &del(&["a", "b", "c", "d", "e"]), None)
        .await
        .unwrap();
    assert!(last_patterns(&core).is_empty());
}

/// C2d: 폴더 일괄 fetch 도 수동 fetch 경로다. tag 를 받아 왔으면 열린 저장소 세션의 원격 tag 보고서가 오래됨이고,
/// tag 가 바뀌지 않았으면 그대로다
#[tokio::test]
async fn folder_batch_fetch_marks_tag_cache_stale_only_when_tags_change() {
    let core = core().await;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("a");
    std::fs::create_dir_all(&path).unwrap();
    let mut a = TestRepo::at(&path);
    a.git_ok(["init", "-q", "-b", "main"]);
    a.commit("first");
    let remote = a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    let mut b = TestRepo::init();
    b.git_ok(["remote", "add", "origin", &remote.to_string_lossy()]);
    b.git_ok(["fetch", "-q", "origin"]);
    b.git_ok(["checkout", "-q", "-b", "main", "--track", "origin/main"]);

    let (session, _rx) = open(&core, &a).await;
    let (fsink, _frx) = collector();
    let folder = core.open_folder(root.path(), fsink).await.unwrap().session;
    assert!(!check(&core, session, "origin").await.stale);

    // tag 없는 변경만 받은 일괄 fetch: 그대로
    b.commit("plain");
    b.git_ok(["push", "-q", "origin", "main"]);
    let r = core
        .folder_batch(folder, mgit_core::BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert!(r.results.iter().all(|x| x.ok), "{r:?}");
    assert!(!cached(&core, session, "origin").await.stale);

    // tag 를 받아 온 일괄 fetch: 오래됨
    b.commit("tagged");
    b.tag("from-b", false);
    b.git_ok(["push", "-q", "origin", "main", "refs/tags/from-b"]);
    let r = core
        .folder_batch(folder, mgit_core::BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert!(r.results.iter().all(|x| x.ok), "{r:?}");
    assert!(
        has_ref(&mut a, "refs/tags/from-b"),
        "일괄 fetch 가 tag 를 받아 와야 한다"
    );
    assert!(cached(&core, session, "origin").await.stale);
}
