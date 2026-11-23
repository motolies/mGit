//! 호스팅 계정(AU-05)·프로필(AU-06)·SSH 키(AU-04)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use httpmock::prelude::*;
use mgit_core::{HostKind, HostingClient, OauthConfig, Profile};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn account_add_list_remove_with_memory_vault() {
    let core = core().await;
    assert!(core.hosting_accounts().is_empty());
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/user").header("authorization", "Bearer ghp_x");
            then.status(200)
                .json_body(serde_json::json!({"login": "Kim", "name": "Kim N", "html_url": "https://github.com/Kim"}));
        })
        .await;
    let client = HostingClient::with_bases(
        HostKind::GitHub,
        server.base_url(),
        server.base_url(),
        Some("ghp_x".into()),
    )
    .unwrap();
    let acc = core
        .hosting_add_with_client(HostKind::GitHub, "https://GitHub.com/", "ghp_x", &client)
        .await
        .unwrap();
    assert_eq!(acc.id, "github:github.com:kim");
    assert_eq!(acc.host, "github.com");
    assert_eq!(acc.user, "Kim");
    assert_eq!(acc.name.as_deref(), Some("Kim N"));
    let list = core.hosting_accounts();
    assert_eq!(list.len(), 1);
    // 토큰은 금고에 있어 클라이언트를 만들 수 있다
    assert!(core.hosting_client(&acc.id).is_ok());
    // 같은 계정을 다시 넣으면 덮어쓴다
    core.hosting_add_with_client(HostKind::GitHub, "github.com", "ghp_x", &client)
        .await
        .unwrap();
    assert_eq!(core.hosting_accounts().len(), 1);
    // 빈 토큰·잘못된 호스트 거부
    assert!(
        core.hosting_add_with_client(HostKind::GitHub, "github.com", "  ", &client)
            .await
            .is_err()
    );
    assert!(
        core.hosting_add_pat(HostKind::GitLab, "bad host/x", "t")
            .await
            .is_err()
    );
    core.hosting_remove(&acc.id).unwrap();
    assert!(core.hosting_accounts().is_empty());
    assert!(core.hosting_client(&acc.id).is_err());

    // OAuth 설정이 없으면 디바이스 플로우는 안내 오류
    assert!(
        core.hosting_device_start(HostKind::GitHub, "github.com")
            .await
            .is_err()
    );
    core.set_hosting_oauth(&OauthConfig {
        github_client_id: Some("app".into()),
        gitlab_client_id: None,
    })
    .unwrap();
    assert_eq!(
        core.hosting_oauth().github_client_id.as_deref(),
        Some("app")
    );
}

#[tokio::test]
async fn profiles_apply_to_repo() {
    let core = core().await;
    let repo = build(Scenario::Linear(1));
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;

    core.set_profiles(&[
        Profile {
            id: String::new(),
            name: "회사".into(),
            user_name: "Kim".into(),
            user_email: "kim@corp.io".into(),
            signing_key: Some("ABCD1234".into()),
            hosting_account: None,
        },
        Profile {
            id: "home".into(),
            name: "개인".into(),
            user_name: "nw".into(),
            user_email: "nw@home.io".into(),
            signing_key: None,
            hosting_account: None,
        },
    ])
    .unwrap();
    let list = core.profiles();
    assert_eq!(list.len(), 2);
    assert!(!list[0].id.is_empty(), "빈 id 는 채운다");
    assert_eq!(list[1].id, "home");
    assert!(
        core.set_profiles(&[Profile {
            id: String::new(),
            name: "  ".into(),
            user_name: String::new(),
            user_email: String::new(),
            signing_key: None,
            hosting_account: None,
        }])
        .is_err()
    );

    core.apply_profile(opened.session, &list[0].id)
        .await
        .unwrap();
    let s = core.repo_settings(opened.session).await.unwrap();
    assert_eq!(s.local_user_name.as_deref(), Some("Kim"));
    assert_eq!(s.local_user_email.as_deref(), Some("kim@corp.io"));
    assert_eq!(s.signing.signing_key.as_deref(), Some("ABCD1234"));

    core.apply_profile(opened.session, "home").await.unwrap();
    let s = core.repo_settings(opened.session).await.unwrap();
    assert_eq!(s.local_user_name.as_deref(), Some("nw"));
    assert!(
        s.signing.signing_key.is_none(),
        "키 없는 프로필은 signingKey 를 지운다"
    );
    assert!(core.apply_profile(opened.session, "nope").await.is_err());
}

#[tokio::test]
async fn ssh_keygen_in_temp_dir() {
    let dir = std::env::temp_dir().join(format!("mgit-ssh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    assert!(mgit_core::Core::ssh_keys_in(&dir).is_empty());
    let key = mgit_core::Core::ssh_keygen_in(&dir, "id_mgit", "nw@mgit", "")
        .await
        .unwrap();
    assert_eq!(key.kind, "ssh-ed25519");
    assert_eq!(key.comment, "nw@mgit");
    assert!(key.public_key.starts_with("ssh-ed25519 "));
    assert!(key.path.exists() && key.path.with_extension("pub").exists());
    let listed = mgit_core::Core::ssh_keys_in(&dir);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, key.path);
    // 같은 이름·잘못된 이름 거부
    assert!(
        mgit_core::Core::ssh_keygen_in(&dir, "id_mgit", "c", "")
            .await
            .is_err()
    );
    assert!(
        mgit_core::Core::ssh_keygen_in(&dir, "../x", "c", "")
            .await
            .is_err()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 암호를 준 키는 그 암호로만 열리고, 임시 askpass 파일을 남기지 않는다
#[tokio::test]
async fn ssh_keygen_with_passphrase() {
    let dir = tempfile::tempdir().unwrap();
    let pass = "dummy pass 'with quotes";
    let key = mgit_core::Core::ssh_keygen_in(dir.path(), "id_pass", "c", pass)
        .await
        .unwrap();
    let opens = |p: &str| {
        std::process::Command::new("ssh-keygen")
            .args(["-y", "-P", p, "-f"])
            .arg(&key.path)
            .output()
            .unwrap()
            .status
            .success()
    };
    assert!(opens(pass));
    assert!(!opens("wrong"));
    let leftovers = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(&format!("mgit-keygen-{}-", std::process::id()))
        })
        .count();
    assert_eq!(leftovers, 0);
}
