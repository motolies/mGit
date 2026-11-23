//! `for-each-ref` 파서 테스트
#![allow(clippy::unwrap_used)]

use mgit_git::parse::parse_refs;
use mgit_model::{HeadState, Oid, RefKind};
use mgit_testkit::{REFS_ARGS, Scenario, build};

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T: &str = "cccccccccccccccccccccccccccccccccccccccc";

/// 손으로 만든 출력 한 줄 (9필드)
#[allow(clippy::too_many_arguments)]
fn line(
    refname: &str,
    obj: &str,
    ty: &str,
    peeled: &str,
    upstream: &str,
    symref: &str,
    track: &str,
    worktree: &str,
    head: &str,
) -> Vec<u8> {
    format!("{refname}\0{obj}\0{ty}\0{peeled}\0{upstream}\0{symref}\0{track}\0{worktree}\0{head}\n")
        .into_bytes()
}

#[test]
fn classifies_local_remote_and_tags() {
    let mut out = Vec::new();
    out.extend(line(
        "refs/heads/main",
        A,
        "commit",
        "",
        "refs/remotes/origin/main",
        "",
        "ahead 1, behind 2",
        "/work/main",
        "*",
    ));
    out.extend(line(
        "refs/heads/기능/한글",
        B,
        "commit",
        "",
        "",
        "",
        "",
        "",
        " ",
    ));
    out.extend(line(
        "refs/heads/stale",
        B,
        "commit",
        "",
        "refs/remotes/origin/stale",
        "",
        "gone",
        "",
        " ",
    ));
    out.extend(line(
        "refs/remotes/origin/HEAD",
        A,
        "commit",
        "",
        "",
        "refs/remotes/origin/main",
        "",
        "",
        " ",
    ));
    out.extend(line(
        "refs/remotes/origin/main",
        A,
        "commit",
        "",
        "",
        "",
        "",
        "",
        " ",
    ));
    out.extend(line("refs/tags/v1.0", T, "tag", B, "", "", "", "", " "));
    out.extend(line(
        "refs/tags/light",
        A,
        "commit",
        "",
        "",
        "",
        "",
        "",
        " ",
    ));
    out.extend(line(
        "refs/tags/blob-tag",
        T,
        "blob",
        "",
        "",
        "",
        "",
        "",
        " ",
    ));

    let head = HeadState::Attached {
        branch: "refs/heads/main".into(),
        oid: Oid::from_hex(A.as_bytes()).unwrap(),
    };
    let labels = parse_refs(&out, &head);
    insta::assert_debug_snapshot!(labels);

    let main = labels
        .iter()
        .find(|l| l.full_name == "refs/heads/main")
        .unwrap();
    assert!(main.is_current);
    assert_eq!(main.upstream.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!((main.ahead, main.behind), (Some(1), Some(2)));
    assert_eq!(
        main.worktree_path.as_deref(),
        Some(std::path::Path::new("/work/main"))
    );
    let stale = labels.iter().find(|l| l.short_name == "stale").unwrap();
    assert!(stale.upstream_gone);
    assert_eq!(stale.ahead, None);
    let korean = labels.iter().find(|l| l.short_name == "기능/한글").unwrap();
    assert_eq!(korean.ahead, None);
    assert!(
        !labels
            .iter()
            .any(|l| l.full_name == "refs/remotes/origin/HEAD")
    );
    let remote = labels
        .iter()
        .find(|l| l.short_name == "origin/main")
        .unwrap();
    assert_eq!(
        remote.kind,
        RefKind::RemoteBranch {
            remote: "origin".into()
        }
    );
    let tag = labels.iter().find(|l| l.short_name == "v1.0").unwrap();
    assert_eq!(tag.kind, RefKind::Tag { annotated: true });
    assert_eq!(tag.target, Oid::from_hex(B.as_bytes()).unwrap());
    assert!(!labels.iter().any(|l| l.short_name == "blob-tag"));
}

#[test]
fn real_output_from_testkit() {
    let mut repo = build(Scenario::BranchMerge);
    let out = repo.git_bytes(REFS_ARGS);
    let head = HeadState::Attached {
        branch: "refs/heads/main".into(),
        oid: repo.head(),
    };
    let labels = parse_refs(&out, &head);
    let names: Vec<&str> = labels.iter().map(|l| l.short_name.as_str()).collect();
    assert_eq!(names, vec!["feature", "main", "v0.1", "v1.0"]);
    let v10 = labels.iter().find(|l| l.short_name == "v1.0").unwrap();
    assert_eq!(v10.kind, RefKind::Tag { annotated: true });
    assert_eq!(v10.target, repo.head());
    let main = labels.iter().find(|l| l.short_name == "main").unwrap();
    assert!(main.is_current);
    // 체크아웃된 브랜치는 워크트리 경로가 채워진다
    assert_eq!(
        main.worktree_path.as_ref().unwrap().canonicalize().unwrap(),
        repo.path().canonicalize().unwrap()
    );
    assert!(labels.iter().all(|l| l.ahead.is_none()));
}
