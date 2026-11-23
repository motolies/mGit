//! askpass 서비스 (AU-01·03): 키체인 우선, 없으면 대화상자, "기억" 이면 저장
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::{collector, core, core_with, wait_finished};
use mgit_core::{
    AskpassService, BatchOp, CloneSpec, CoreConfig, CoreEvent, CredentialOutcome, CredentialPrompt,
    CredentialReply, CredentialRequest, MemoryVault, PromptKind, SecretVault, vault_key,
};
use mgit_testkit::{Scenario, TestRepo, build};

/// 헬퍼 클라이언트로 프롬프트를 보낸다
async fn ask(s: &AskpassService, p: &str) -> Option<String> {
    mgit_helper::request(s.socket(), s.token(), p).await
}

/// 호출을 세고 정해진 답을 주는 가짜 대화상자
struct FakePrompt {
    calls: AtomicUsize,
    seen: Mutex<Vec<CredentialRequest>>,
    reply: Mutex<Option<CredentialReply>>,
}

impl CredentialPrompt for FakePrompt {
    fn ask(
        &self,
        request: CredentialRequest,
    ) -> Pin<Box<dyn Future<Output = Option<CredentialReply>> + Send>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(request);
        let reply = self.reply.lock().unwrap().clone();
        Box::pin(async move { reply })
    }
}

#[tokio::test]
async fn vault_first_then_prompt_and_remember() {
    let vault = Arc::new(MemoryVault::default());
    let prompt = Arc::new(FakePrompt {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(Vec::new()),
        reply: Mutex::new(Some(CredentialReply {
            secret: Some("tok".into()),
            remember: true,
        })),
    });
    let service = AskpassService::start(vault.clone(), prompt.clone()).unwrap();

    // 처음: 대화상자 → 저장
    assert_eq!(
        ask(&service, "Password for 'https://u@github.com': ")
            .await
            .as_deref(),
        Some("tok")
    );
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 1);
    let seen = prompt.seen.lock().unwrap().clone();
    assert_eq!(seen[0].kind, PromptKind::Password);
    assert_eq!(seen[0].target, "https://u@github.com");

    // 두 번째: 키체인에서 바로 (대화상자 호출 없음)
    assert_eq!(
        ask(&service, "Password for 'https://u@github.com': ")
            .await
            .as_deref(),
        Some("tok")
    );
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 1);

    // 다른 대상·종류는 다시 묻는다; 기억 안 하면 저장되지 않는다
    *prompt.reply.lock().unwrap() = Some(CredentialReply {
        secret: Some("me".into()),
        remember: false,
    });
    assert_eq!(
        ask(&service, "Username for 'https://x': ").await.as_deref(),
        Some("me")
    );
    assert_eq!(
        ask(&service, "Username for 'https://x': ").await.as_deref(),
        Some("me")
    );
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 3);

    // 취소 → None (헬퍼는 1 로 종료)
    *prompt.reply.lock().unwrap() = None;
    assert_eq!(ask(&service, "Enter passphrase for key '/k': ").await, None);

    // forget 뒤에는 다시 묻는다
    service.forget("https://u@github.com");
    *prompt.reply.lock().unwrap() = Some(CredentialReply {
        secret: Some("new".into()),
        remember: false,
    });
    assert_eq!(
        ask(&service, "Password for 'https://u@github.com': ")
            .await
            .as_deref(),
        Some("new")
    );
    let vars = service.env_vars(std::path::Path::new("/app"));
    assert!(vars.iter().any(|(k, _)| k == "MGIT_HELPER_TOKEN"));
}

/// 묻지 않는 요청(자동 fetch): 키체인에 있으면 그 값을 주고, 없으면 대화상자를 띄우지 않고 취소한다
#[tokio::test]
async fn silent_request_never_prompts_but_uses_the_vault() {
    let vault = Arc::new(MemoryVault::default());
    let prompt = fake_prompt("typed", true);
    let service = AskpassService::start(vault.clone(), prompt.clone()).unwrap();
    let silent = |p: &'static str| {
        mgit_helper::request_with(
            service.socket(),
            service.token(),
            p,
            Some("bg".into()),
            true,
        )
    };

    assert_eq!(silent(PASSWORD).await, None, "키체인에 없으면 취소");
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 0, "대화상자를 띄웠다");
    assert_eq!(
        vault.get(&vault_key(PromptKind::Password, "https://u@github.com")),
        None,
        "묻지 않았으니 저장할 것도 없다"
    );

    vault
        .set(
            &vault_key(PromptKind::Password, "https://u@github.com"),
            "stored",
        )
        .unwrap();
    assert_eq!(silent(PASSWORD).await.as_deref(), Some("stored"));
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 0);

    // 같은 서비스에서 묻는 요청은 그대로 대화상자로 간다
    assert_eq!(
        ask(&service, "Username for 'https://x': ").await.as_deref(),
        Some("typed")
    );
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 1);
}

/// 태그를 붙여 프롬프트를 보낸다
async fn ask_tagged(s: &AskpassService, p: &str, tag: &str) -> Option<String> {
    mgit_helper::request_tagged(s.socket(), s.token(), p, Some(tag.to_string())).await
}

/// 정해진 답을 주는 가짜 대화상자
fn fake_prompt(secret: &str, remember: bool) -> Arc<FakePrompt> {
    Arc::new(FakePrompt {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(Vec::new()),
        reply: Mutex::new(Some(CredentialReply {
            secret: Some(secret.into()),
            remember,
        })),
    })
}

const PASSWORD: &str = "Password for 'https://u@github.com': ";

/// 저장된 비밀로 한 인증이 거부되면 그 비밀을 지우고 다음에 다시 묻는다
#[tokio::test]
async fn rejected_cached_secret_is_forgotten_and_asked_again() {
    let vault = Arc::new(MemoryVault::default());
    let key = vault_key(PromptKind::Password, "https://u@github.com");
    vault.set(&key, "old").unwrap();
    let prompt = fake_prompt("new", false);
    let service = AskpassService::start(vault.clone(), prompt.clone()).unwrap();

    assert_eq!(
        ask_tagged(&service, PASSWORD, "t1").await.as_deref(),
        Some("old")
    );
    service.outcome().rejected("t1");
    assert_eq!(vault.get(&key), None, "거부된 비밀은 지운다");
    assert_eq!(
        ask_tagged(&service, PASSWORD, "t2").await.as_deref(),
        Some("new")
    );
    assert_eq!(prompt.calls.load(Ordering::SeqCst), 1);
}

/// 거부가 아니면 비밀을 남기고, 다른 명령의 거부도 영향을 주지 않는다
#[tokio::test]
async fn only_the_rejected_command_loses_its_secret() {
    let vault = Arc::new(MemoryVault::default());
    let key = vault_key(PromptKind::Password, "https://u@github.com");
    let other = vault_key(PromptKind::Password, "https://v@gitlab.com");
    vault.set(&key, "a").unwrap();
    vault.set(&other, "b").unwrap();
    let service = AskpassService::start(vault.clone(), fake_prompt("x", false)).unwrap();

    ask_tagged(&service, PASSWORD, "ok").await;
    ask_tagged(&service, "Password for 'https://v@gitlab.com': ", "bad").await;
    service.outcome().finished("ok");
    service.outcome().rejected("ok");
    assert_eq!(vault.get(&key).as_deref(), Some("a"), "끝난 태그는 비었다");
    service.outcome().rejected("bad");
    assert_eq!(vault.get(&other), None);
    assert_eq!(vault.get(&key).as_deref(), Some("a"));
}

/// 대화상자에서 기억하기로 한 비밀도 그 명령이 거부되면 남기지 않는다 (오타가 굳지 않게)
#[tokio::test]
async fn mistyped_remembered_secret_does_not_stick() {
    let vault = Arc::new(MemoryVault::default());
    let key = vault_key(PromptKind::Password, "https://u@github.com");
    let service = AskpassService::start(vault.clone(), fake_prompt("typo", true)).unwrap();

    ask_tagged(&service, PASSWORD, "t").await;
    assert_eq!(vault.get(&key).as_deref(), Some("typo"));
    service.outcome().rejected("t");
    assert_eq!(vault.get(&key), None);
}

/// 대상 하나를 지우면 짝이 되는 사용자 이름·비밀번호와 기타 프롬프트도 함께 지운다
#[tokio::test]
async fn forget_clears_both_sides_and_other_prompts() {
    let vault = Arc::new(MemoryVault::default());
    let user = vault_key(PromptKind::Username, "https://github.com");
    // git 은 사용자 이름을 퍼센트 인코딩해 비밀번호 프롬프트에 넣는다
    let pass = vault_key(PromptKind::Password, "https://a%40b.com@github.com");
    vault.set(&user, "a@b.com").unwrap();
    vault.set(&pass, "p").unwrap();
    let service = AskpassService::start(vault.clone(), fake_prompt("x", false)).unwrap();

    // 사용자 이름 프롬프트 쪽 대상으로 지워도 비밀번호가 남지 않는다
    service.forget("https://github.com");
    assert_eq!(vault.get(&user), None);
    assert_eq!(vault.get(&pass), None);

    // 비밀번호 프롬프트 쪽 대상으로 지워도 사용자 이름이 남지 않는다
    vault.set(&user, "a@b.com").unwrap();
    vault.set(&pass, "p").unwrap();
    service.forget("https://a%40b.com@github.com");
    assert_eq!(vault.get(&user), None);
    assert_eq!(vault.get(&pass), None);

    // 기타 프롬프트 (`(git@h) Password` 등)
    let other = vault_key(PromptKind::Other, "(git@h) Password");
    vault.set(&other, "p").unwrap();
    service.forget("(git@h) Password");
    assert_eq!(vault.get(&other), None);
}

/// 코어가 보내는 인증 결과를 모은다 (태그, 거부 여부)
#[derive(Default)]
struct Recorder(Mutex<Vec<(String, bool)>>);

impl CredentialOutcome for Recorder {
    /// 거부 기록
    fn rejected(&self, tag: &str) {
        self.0.lock().unwrap().push((tag.to_string(), true));
    }

    /// 거부 아님 기록
    fn finished(&self, tag: &str) {
        self.0.lock().unwrap().push((tag.to_string(), false));
    }
}

const REJECTED: &str = "git@h: Permission denied (publickey).";
const LEAK: &str = "SECRETTOKEN";
const UNREACHABLE: &str = "ssh: connect to host h port 22: Connection refused";

/// 받은 태그를 파일에 남기고 `stderr` 를 내며 실패하는 가짜 ssh. (스크립트, 태그 파일) 경로를 돌려준다
#[cfg(unix)]
fn fake_ssh(dir: &std::path::Path, stderr: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("fake-ssh.sh");
    let tag = dir.join("tag.txt");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s' \"$MGIT_HELPER_TAG\" > '{}'\necho '{stderr}' >&2\nexit 255\n",
            tag.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, tag)
}

/// 가짜 ssh 를 쓰는 원격을 가진 저장소
#[cfg(unix)]
fn repo_with_fake_ssh(script: &std::path::Path) -> TestRepo {
    let mut repo = build(Scenario::Linear(1));
    repo.git_ok([
        "remote",
        "add",
        "origin",
        "ssh://git@example.invalid/o/r.git",
    ]);
    repo.git_ok(["config", "core.sshCommand", &script.to_string_lossy()]);
    repo
}

/// 서버 거부면 그 명령의 태그로 거부를, 연결 실패면 거부 아님을 알린다
#[cfg(unix)]
#[tokio::test]
async fn core_reports_rejection_by_command_tag() {
    for (stderr, rejected) in [(REJECTED, true), (UNREACHABLE, false)] {
        let dir = tempfile::tempdir().unwrap();
        let (script, tag_file) = fake_ssh(dir.path(), stderr);
        let repo = repo_with_fake_ssh(&script);
        let core = core().await;
        let recorder = Arc::new(Recorder::default());
        core.set_credential_outcome(recorder.clone());
        let (sink, mut rx) = collector();
        let opened = core.open_repo(repo.path(), sink).await.unwrap();
        wait_finished(&mut rx, opened.session).await;

        assert!(
            core.fetch(opened.session, Some("origin"), false, None)
                .await
                .is_err()
        );
        let tag = std::fs::read_to_string(&tag_file).unwrap();
        assert!(!tag.is_empty(), "명령에 태그가 붙어야 한다");
        assert_eq!(*recorder.0.lock().unwrap(), vec![(tag, rejected)]);
    }
}

/// 쓰기 큐를 거치지 않는 폴더 일괄 fetch 도 알린다
#[cfg(unix)]
#[tokio::test]
async fn folder_batch_reports_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let (script, tag_file) = fake_ssh(dir.path(), REJECTED);
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let mut repo = TestRepo::at(&root.join("a"));
    std::fs::create_dir(repo.path()).unwrap();
    repo.git_ok(["init", "-q", "-b", "main"]);
    repo.write_file("a.txt", "a");
    repo.stage(&["a.txt"]);
    repo.commit_staged("a");
    repo.git_ok([
        "remote",
        "add",
        "origin",
        "ssh://git@example.invalid/o/r.git",
    ]);
    repo.git_ok(["config", "core.sshCommand", &script.to_string_lossy()]);

    let core = core().await;
    let recorder = Arc::new(Recorder::default());
    core.set_credential_outcome(recorder.clone());
    let (sink, _rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();
    let r = core
        .folder_batch(opened.session, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(r.failed, 1, "{r:?}");
    let tag = std::fs::read_to_string(&tag_file).unwrap();
    assert_eq!(*recorder.0.lock().unwrap(), vec![(tag, true)]);
}

/// 일괄 작업 결과 메시지에도 URL 토큰을 싣지 않는다
#[cfg(unix)]
#[tokio::test]
async fn folder_batch_message_masks_url_token() {
    let dir = tempfile::tempdir().unwrap();
    let (script, _) = fake_ssh(dir.path(), "see https://SECRETTOKEN@h/x");
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let mut repo = TestRepo::at(&root.join("a"));
    std::fs::create_dir(repo.path()).unwrap();
    repo.git_ok(["init", "-q", "-b", "main"]);
    repo.write_file("a.txt", "a");
    repo.stage(&["a.txt"]);
    repo.commit_staged("a");
    repo.git_ok([
        "remote",
        "add",
        "origin",
        "ssh://git@example.invalid/o/r.git",
    ]);
    repo.git_ok(["config", "core.sshCommand", &script.to_string_lossy()]);
    let core = core().await;
    let (sink, _rx) = collector();
    let opened = core.open_folder(&root, sink).await.unwrap();
    let r = core
        .folder_batch(opened.session, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    let text = format!("{r:?}");
    assert!(text.contains("https://***@h/x"), "{text}");
    assert!(!text.contains(LEAK), "{text}");
}

/// 실패한 명령의 인자·stderr 와 이벤트·명령 로그에 URL 토큰을 남기지 않는다
#[cfg(unix)]
#[tokio::test]
async fn failed_commands_mask_url_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let (script, _) = fake_ssh(dir.path(), "remote: see https://SECRETTOKEN@h/x");
    let repo = repo_with_fake_ssh(&script);
    let core = core().await;
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    // stderr 경로 (op 를 달아 이벤트로도 흘린다)
    let op = core.begin_operation(id, "fetch", "fetch").unwrap();
    let from_stderr = core
        .fetch(id, Some("origin"), false, Some(op))
        .await
        .unwrap_err();
    // 인자 경로: 같은 이름의 원격을 다시 넣어 실패시킨다
    let url = "https://SECRETTOKEN@h/a.git";
    core.remote_add(id, "x", url).await.unwrap();
    let from_args = core.remote_add(id, "x", url).await.unwrap_err();

    let errors = format!("{from_stderr:?} {from_args:?}");
    assert!(errors.contains("https://***@h/a.git"), "{errors}");
    assert!(!errors.contains(LEAK), "{errors}");
    let log = format!("{:?}", core.command_log_recent(100));
    assert!(!log.contains(LEAK), "{log}");
    while let Ok(e) = rx.try_recv() {
        if matches!(
            e,
            CoreEvent::OperationOutput { .. }
                | CoreEvent::OperationProgress { .. }
                | CoreEvent::OperationFinished { .. }
                | CoreEvent::CommandLogged { .. }
        ) {
            let text = format!("{e:?}");
            assert!(!text.contains(LEAK), "{text}");
        }
    }
}

/// clone 실패 오류에 URL 토큰을 남기지 않는다 (닫힌 로컬 포트라 나가는 요청이 없다)
#[tokio::test]
async fn clone_failure_masks_url_token() {
    let dir = tempfile::tempdir().unwrap();
    let core = core().await;
    let (sink, _rx) = collector();
    let spec = CloneSpec {
        url: "http://SECRETTOKEN@127.0.0.1:1/o/r.git".into(),
        dest: dir.path().join("dest"),
        branch: None,
        recurse_submodules: false,
        depth: None,
        blobless: false,
        single_branch: false,
    };
    let err = format!("{:?}", core.clone_repo(spec, sink).await.unwrap_err());
    assert!(!err.contains(LEAK), "{err}");
}

/// clone 도 같은 경로를 탄다
#[cfg(unix)]
#[tokio::test]
async fn clone_reports_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let (script, tag_file) = fake_ssh(dir.path(), REJECTED);
    let core = core_with(CoreConfig {
        git_config_overrides: vec![("core.sshCommand".into(), script.display().to_string())],
        ..CoreConfig::default()
    })
    .await;
    let recorder = Arc::new(Recorder::default());
    core.set_credential_outcome(recorder.clone());
    let (sink, _rx) = collector();
    let spec = CloneSpec {
        url: "ssh://git@example.invalid/o/r.git".into(),
        dest: dir.path().join("dest"),
        branch: None,
        recurse_submodules: false,
        depth: None,
        blobless: false,
        single_branch: false,
    };
    assert!(core.clone_repo(spec, sink).await.is_err());
    let tag = std::fs::read_to_string(&tag_file).unwrap();
    assert_eq!(*recorder.0.lock().unwrap(), vec![(tag, true)]);
}
