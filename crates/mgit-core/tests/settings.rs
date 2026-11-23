//! 비밀 스캔(CHG-09)·서명(CHG-08)·저장소 설정(REPO-07)·최적화(AD-07)·얕은 복제(REPO-03)
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{CloneSpec, CommitSpec, SecretIgnore};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn scan_staged_secrets_finds_tokens_and_honors_ignores() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(
        core.scan_staged_secrets(opened.session)
            .await
            .unwrap()
            .is_empty()
    );

    let token = format!("ghp_{}", "a".repeat(36));
    repo.write_file(
        "src/config.js",
        &format!(
            "const a = 1;\nconst token = \"{token}\";\nconst ok = \"{token}\"; // gitleaks:allow\n"
        ),
    );
    repo.stage(&["src/config.js"]);
    let hits = core.scan_staged_secrets(opened.session).await.unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].path, "src/config.js");
    assert_eq!(hits[0].line, 2);
    assert_eq!(hits[0].rule, "github-pat");
    assert!(hits[0].snippet.starts_with("ghp_") && !hits[0].snippet.contains(&token));

    repo.write_file("fixtures/aws.txt", "AKIAABCDEFGHIJKLMNOP\n");
    repo.stage(&["fixtures/aws.txt"]);
    assert_eq!(
        core.scan_staged_secrets(opened.session)
            .await
            .unwrap()
            .len(),
        2
    );

    // 규칙 무시
    core.set_secret_ignores(&[SecretIgnore {
        rule: Some("github-pat".into()),
        path: None,
    }])
    .unwrap();
    let hits = core.scan_staged_secrets(opened.session).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rule, "aws-access-token");
    // 경로 무시
    core.set_secret_ignores(&[SecretIgnore {
        rule: None,
        path: Some("fixtures/**".into()),
    }])
    .unwrap();
    let hits = core.scan_staged_secrets(opened.session).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rule, "github-pat");
    assert_eq!(core.secret_ignores().len(), 1);
    core.set_secret_ignores(&[]).unwrap();
    assert_eq!(
        core.scan_staged_secrets(opened.session)
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn repo_settings_user_gitignore_perf_and_signature() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(2));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.set_user(opened.session, "Kim", "k@x.io")
        .await
        .unwrap();
    let s = core.repo_settings(opened.session).await.unwrap();
    assert_eq!(s.local_user_name.as_deref(), Some("Kim"));
    assert_eq!(s.local_user_email.as_deref(), Some("k@x.io"));
    assert_eq!(s.user_name.as_deref(), Some("Kim"));
    assert!(s.hooks.is_empty(), "샘플 hook 은 제외: {:?}", s.hooks);
    assert!(s.gitignore.is_none());
    assert!(!s.shallow);
    assert!(s.perf.tracked_files >= 2);
    assert!(!s.perf.suggested);
    assert_eq!(s.signing.format, "openpgp");
    assert!(!s.signing.commit_sign);

    core.set_user(opened.session, "", "").await.unwrap();
    let s = core.repo_settings(opened.session).await.unwrap();
    assert!(s.local_user_name.is_none());

    core.write_gitignore(opened.session, "*.log\nbuild/\n")
        .await
        .unwrap();
    let s = core.repo_settings(opened.session).await.unwrap();
    assert_eq!(s.gitignore.as_deref(), Some("*.log\nbuild/\n"));

    // hook 하나 (실행 가능)
    let hook = repo.path().join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let s = core.repo_settings(opened.session).await.unwrap();
    assert_eq!(s.hooks.len(), 1);
    assert_eq!(s.hooks[0].name, "pre-commit");
    assert!(s.hooks[0].executable);

    // 서명 없는 커밋의 검증 코드는 N, --no-gpg-sign 커밋도 된다
    let head = core
        .repo_state(opened.session)
        .unwrap()
        .refs
        .head
        .oid()
        .unwrap();
    let sig = core.commit_signature(opened.session, &head).await.unwrap();
    assert_eq!(sig.code, "N");
    repo.write_file("n.txt", "n");
    repo.stage(&["n.txt"]);
    core.commit(
        opened.session,
        CommitSpec {
            message: "unsigned".into(),
            amend: false,
            no_verify: false,
            allow_empty: false,
            sign: Some(false),
            allow_conflict_markers: false,
        },
        None,
    )
    .await
    .unwrap();

    // 최적화 켜기 → 설정 반영
    core.enable_perf(opened.session).await.unwrap();
    let p = core.perf_status(opened.session).await.unwrap();
    assert!(p.fsmonitor && p.untracked_cache);
    let _ = repo.git_ok(["config", "--local", "--unset", "core.fsmonitor"]);
}

#[tokio::test]
async fn shallow_clone_then_unshallow() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(3));
    let remote = repo.add_bare_remote();
    repo.git_ok(["push", "-q", "origin", "main"]);
    let dest = std::env::temp_dir().join(format!("mgit-shallow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    let (sink, _rx) = collector();
    core.clone_repo(
        CloneSpec {
            url: format!("file://{}", remote.display()),
            dest: dest.clone(),
            branch: None,
            recurse_submodules: false,
            depth: Some(1),
            blobless: false,
            single_branch: true,
        },
        sink,
    )
    .await
    .unwrap();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(&dest, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    assert!(opened.info.shallow, "depth=1 이면 얕은 복제");
    assert!(core.is_shallow(opened.session).unwrap());
    let still = core.unshallow(opened.session).await.unwrap();
    assert!(!still, "unshallow 뒤에는 전체 이력");
    assert!(!core.is_shallow(opened.session).unwrap());
    let _ = core.close_repo(opened.session);
    let _ = std::fs::remove_dir_all(&dest);
}
