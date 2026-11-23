//! 커밋을 포함하는 브랜치 (W9: CD-03). 세션용 `commit_containing_refs` 와 폴더용
//! `folder_commit_containing_refs` 는 같은 내부 함수로 읽으므로 결과·오류가 같아야 한다.
//! 폴더용은 저장소 세션을 만들지 않고, 폴더 밖 경로는 git 을 돌리기 전에 거부한다
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};

use common::{collector, core, wait_finished};
use mgit_core::{ContainingRefs, Core, CoreError, GitError, Oid, SessionId};
use mgit_testkit::TestRepo;

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 테스트마다 따로 쓰는 임시 루트 (정규화하지 않는다 — 요청 경로의 꼴이 달라도 같은 저장소로 받는지 본다)
fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mgit-contains-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// 시험용 폴더: 저장소 a(갈라진 브랜치·머지된 브랜치·한글 이름·원격 추적·원격 HEAD·태그만 닿는 커밋), a 의
/// 워크트리 a-wt(브랜치 wt), 저장소 b, 저장소가 아닌 폴더 plain
struct Fixture {
    root: PathBuf,
    a: PathBuf,
    wt: PathBuf,
    b: PathBuf,
    /// main 의 첫 커밋. 모든 브랜치가 품는다
    c1: Oid,
    /// feature 에만 있는 커밋 (main 과 갈라졌다). origin/feature 도 품는다
    f1: Oid,
    /// merged 의 커밋. main 에 머지됐다
    m1: Oid,
    /// main 의 둘째 커밋. `기능/한글-브랜치`·origin/main 이 여기 있다
    c2: Oid,
    /// merged 를 합친 머지 커밋 (main 의 HEAD, 워크트리 wt 도 여기서 시작)
    merge: Oid,
    /// 브랜치를 지워 태그(only-tag)로만 닿는 커밋
    tag_only: Oid,
    b_head: Oid,
    _repos: Vec<TestRepo>,
}

/// 시험용 폴더를 만든다
fn fixture(tag: &str) -> Fixture {
    let root = temp_root(tag);
    let mut a = init_at(&root.join("a"));
    let c1 = a.commit("c1");
    a.checkout_new("feature");
    let f1 = a.commit("f1");
    a.checkout("main");
    a.checkout_new("merged");
    let m1 = a.commit("m1");
    a.checkout("main");
    let c2 = a.commit("c2");
    a.branch("기능/한글-브랜치");
    let merge = a.merge(&["merged"], "merge merged");
    a.tag("v-main", true);
    a.git_ok(["update-ref", "refs/remotes/origin/main", &c2.to_hex()]);
    a.git_ok(["update-ref", "refs/remotes/origin/feature", &f1.to_hex()]);
    a.git_ok([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    a.checkout_new("tmp");
    let tag_only = a.commit("tag only");
    a.tag("only-tag", false);
    a.checkout("main");
    a.git_ok(["branch", "-q", "-D", "tmp"]);
    let wt = root.join("a-wt");
    a.git_ok([
        "worktree",
        "add",
        "-q",
        &wt.display().to_string(),
        "-b",
        "wt",
    ]);

    let mut b = init_at(&root.join("b"));
    let b_head = b.commit("b1");
    std::fs::create_dir_all(root.join("plain")).unwrap();

    Fixture {
        a: root.join("a"),
        b: root.join("b"),
        root,
        wt,
        c1,
        f1,
        m1,
        c2,
        merge,
        tag_only,
        b_head,
        _repos: vec![a, b],
    }
}

impl Fixture {
    /// a 의 모든 커밋
    fn a_commits(&self) -> [Oid; 6] {
        [
            self.c1,
            self.f1,
            self.m1,
            self.c2,
            self.merge,
            self.tag_only,
        ]
    }
}

/// 폴더만 연다 (타임라인 없이)
async fn open_folder(core: &Core, root: &Path) -> SessionId {
    let (sink, _rx) = collector();
    core.open_folder(root, sink).await.unwrap().session
}

/// 저장소 세션을 열고 그래프 로드가 끝날 때까지 기다린다
async fn open_session(core: &Core, path: &Path) -> SessionId {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(path, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    opened.session
}

/// 결과를 `(HEAD 포함, [(짧은 이름, 원격, 현재)])` 로 줄인다
fn shape(r: &ContainingRefs) -> (bool, Vec<(&str, bool, bool)>) {
    assert!(!r.timed_out, "{r:?}");
    (
        r.head,
        r.branches
            .iter()
            .map(|b| (b.short_name.as_str(), b.remote, b.current))
            .collect(),
    )
}

/// 지금까지 코어가 돌린 git 명령 수
fn command_count(core: &Core) -> usize {
    core.command_log_recent(usize::MAX).len()
}

/// `before` 개 이후에 돈 git 명령 (오래된 것부터)
fn commands_since(core: &Core, before: usize) -> Vec<mgit_core::CommandLogRecord> {
    core.command_log_recent(usize::MAX)
        .into_iter()
        .rev()
        .skip(before)
        .collect()
}

/// 로컬·원격 포함/미포함(갈라진 브랜치, 머지된 브랜치), HEAD 포함, 원격 HEAD·태그 제외, 이름에 `/`·한글,
/// 정렬(현재 → 로컬 → 원격, 각각 이름순), 전체 ref 이름
#[tokio::test]
async fn branches_containing_each_commit() {
    let fx = fixture("each");
    let core = core().await;
    let fid = open_folder(&core, &fx.root).await;
    let ask = |oid: Oid| {
        let core = &core;
        let a = fx.a.clone();
        async move {
            core.folder_commit_containing_refs(fid, &a, &oid)
                .await
                .unwrap()
        }
    };

    let c1 = ask(fx.c1).await;
    assert_eq!(
        shape(&c1),
        (
            true,
            vec![
                ("main", false, true),
                ("feature", false, false),
                ("merged", false, false),
                ("wt", false, false),
                ("기능/한글-브랜치", false, false),
                ("origin/feature", true, false),
                ("origin/main", true, false),
            ]
        ),
        "원격 HEAD(심볼릭)·태그는 빠진다"
    );
    let names: Vec<&str> = c1.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names[0], "refs/heads/main");
    assert!(names.contains(&"refs/heads/기능/한글-브랜치"));
    assert_eq!(names[6], "refs/remotes/origin/main");

    // 갈라진 브랜치의 커밋: main(HEAD)에서 닿지 않는다
    assert_eq!(
        shape(&ask(fx.f1).await),
        (
            false,
            vec![("feature", false, false), ("origin/feature", true, false)]
        )
    );
    // 머지된 브랜치의 커밋: 그 브랜치와 머지한 쪽(main, 거기서 시작한 wt)이 품는다
    assert_eq!(
        shape(&ask(fx.m1).await),
        (
            true,
            vec![
                ("main", false, true),
                ("merged", false, false),
                ("wt", false, false),
            ]
        )
    );
    assert_eq!(
        shape(&ask(fx.c2).await),
        (
            true,
            vec![
                ("main", false, true),
                ("wt", false, false),
                ("기능/한글-브랜치", false, false),
                ("origin/main", true, false),
            ]
        )
    );
    assert_eq!(
        shape(&ask(fx.merge).await),
        (true, vec![("main", false, true), ("wt", false, false)])
    );
    // 태그로만 닿는 커밋: 어느 브랜치에도 없고 HEAD 에서도 닿지 않는다
    assert_eq!(shape(&ask(fx.tag_only).await), (false, vec![]));
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// HEAD 포함 판정: 현재 브랜치가 목록에 있으면 git 1회(`for-each-ref`), 없으면 HEAD 확인
/// (`merge-base --is-ancestor`)까지 2회. 분리 HEAD 도 HEAD 에서 닿는지로 정하고, unborn HEAD 는 닿지 않는다
#[tokio::test]
async fn head_containment_and_git_call_count() {
    let fx = fixture("head");
    let core = core().await;
    let fid = open_folder(&core, &fx.root).await;

    let before = command_count(&core);
    let on_branch = core
        .folder_commit_containing_refs(fid, &fx.a, &fx.c1)
        .await
        .unwrap();
    let ran = commands_since(&core, before);
    assert!(on_branch.head);
    assert_eq!(ran.len(), 1, "{ran:?}");
    assert_eq!(ran[0].args[0], "for-each-ref");
    assert!(
        ran[0]
            .args
            .contains(&format!("--contains={}", fx.c1.to_hex()))
    );

    let before = command_count(&core);
    let off_branch = core
        .folder_commit_containing_refs(fid, &fx.a, &fx.f1)
        .await
        .unwrap();
    let ran = commands_since(&core, before);
    assert!(!off_branch.head);
    assert_eq!(
        ran.iter().map(|r| r.args[0].as_str()).collect::<Vec<_>>(),
        vec!["for-each-ref", "merge-base"]
    );

    // 분리 HEAD (feature 의 f1): 현재 브랜치가 없어 언제나 2회. HEAD 에서 닿는 것만 포함이다
    let mut a = TestRepo::at(&fx.a);
    a.git_ok(["checkout", "-q", "--detach", &fx.f1.to_hex()]);
    for (oid, reaches) in [(fx.f1, true), (fx.c1, true), (fx.c2, false), (fx.m1, false)] {
        let r = core
            .folder_commit_containing_refs(fid, &fx.a, &oid)
            .await
            .unwrap();
        assert_eq!(r.head, reaches, "{oid:?}");
        assert!(
            r.branches.iter().all(|b| !b.current),
            "분리 HEAD 면 현재 브랜치가 없다"
        );
    }

    // unborn HEAD (고아 브랜치): HEAD 를 풀 수 없으면 닿지 않는다. 브랜치 목록은 그대로다
    a.git_ok(["checkout", "-q", "--orphan", "empty"]);
    let unborn = core
        .folder_commit_containing_refs(fid, &fx.a, &fx.c1)
        .await
        .unwrap();
    assert!(!unborn.head);
    assert!(unborn.branches.iter().any(|b| b.short_name == "main"));
    assert!(unborn.branches.iter().all(|b| !b.current));
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 세션용과 폴더용은 같은 결과다. 폴더용은 저장소 세션을 만들지 않는다
#[tokio::test]
async fn session_and_folder_agree_without_a_repo_session() {
    let fx = fixture("agree");
    let core = core().await;
    let fid = open_folder(&core, &fx.root).await;
    let mut folder = Vec::new();
    for oid in fx.a_commits() {
        folder.push(
            core.folder_commit_containing_refs(fid, &fx.a, &oid)
                .await
                .unwrap(),
        );
    }
    assert!(
        core.sessions().is_empty(),
        "폴더 API 가 저장소 세션을 열었다"
    );
    let session = open_session(&core, &fx.a).await;
    for (oid, f) in fx.a_commits().iter().zip(&folder) {
        assert_eq!(
            &core.commit_containing_refs(session, oid).await.unwrap(),
            f,
            "{oid:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 워크트리 경로는 원 저장소로 읽는다: 결과(HEAD 도 원 저장소의 HEAD)가 원 저장소 경로로 물은 것과 같고
/// git 은 원 저장소에서 돈다
#[tokio::test]
async fn worktree_path_reads_the_primary_repo() {
    let fx = fixture("worktree");
    let core = core().await;
    let fid = open_folder(&core, &fx.root).await;
    let before = command_count(&core);
    let via_wt = core
        .folder_commit_containing_refs(fid, &fx.wt, &fx.c1)
        .await
        .unwrap();
    let ran = commands_since(&core, before);
    let via_a = core
        .folder_commit_containing_refs(fid, &fx.a, &fx.c1)
        .await
        .unwrap();
    assert_eq!(via_wt, via_a);
    // 원 저장소의 현재 브랜치(main)가 현재로 표시된다 (워크트리의 wt 가 아니다)
    let current: Vec<&str> = via_wt
        .branches
        .iter()
        .filter(|b| b.current)
        .map(|b| b.short_name.as_str())
        .collect();
    assert_eq!(current, vec!["main"]);
    let primary = fx.a.canonicalize().unwrap();
    assert!(!ran.is_empty());
    assert!(ran.iter().all(|r| r.cwd == primary), "{ran:?}");
    assert!(core.sessions().is_empty());
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 이 폴더의 저장소가 아닌 경로는 git 을 돌리기 전에 거부한다 (FS-11). 없는 폴더 세션은 SessionNotFound
#[tokio::test]
async fn folder_rejects_strangers_before_running_git() {
    let fx = fixture("strangers");
    let core = core().await;
    let fid = open_folder(&core, &fx.root).await;
    let outside = tempfile::tempdir().unwrap();
    let before = command_count(&core);
    for stranger in [
        outside.path().to_path_buf(),
        fx.root.clone(),
        fx.root.join("plain"),
        fx.a.join(".git"),
        fx.root.join("missing"),
        PathBuf::from("a"),
        PathBuf::new(),
    ] {
        assert!(
            matches!(
                core.folder_commit_containing_refs(fid, &stranger, &fx.c1)
                    .await,
                Err(CoreError::Invalid(_))
            ),
            "{}",
            stranger.display()
        );
    }
    assert_eq!(command_count(&core), before, "거부한 요청에 git 이 돌았다");
    assert!(matches!(
        core.folder_commit_containing_refs(SessionId(9_999), &fx.a, &fx.c1)
            .await,
        Err(CoreError::SessionNotFound(_))
    ));
    assert!(core.sessions().is_empty());
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 그 저장소에 없는 커밋(다른 저장소의 커밋, 어디에도 없는 커밋)은 시간 초과가 아니라 git 오류이고,
/// 세션용과 폴더용의 오류가 같다
#[tokio::test]
async fn unknown_commits_fail_like_the_session() {
    let fx = fixture("unknown");
    let core = core().await;
    let fid = open_folder(&core, &fx.root).await;
    let nowhere = Oid::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
    let mut folder = Vec::new();
    for oid in [fx.b_head, nowhere] {
        let err = core
            .folder_commit_containing_refs(fid, &fx.a, &oid)
            .await
            .unwrap_err();
        match &err {
            CoreError::Git(GitError::Exit { stderr, .. }) => {
                assert!(stderr.contains("no such commit"), "{stderr}")
            }
            other => panic!("git 오류여야 한다: {other:?}"),
        }
        folder.push((oid, err.to_string()));
    }
    // b 의 커밋은 b 경로로 물으면 읽힌다
    let in_b = core
        .folder_commit_containing_refs(fid, &fx.b, &fx.b_head)
        .await
        .unwrap();
    assert_eq!(shape(&in_b), (true, vec![("main", false, true)]));

    let session = open_session(&core, &fx.a).await;
    for (oid, folder_err) in &folder {
        assert_eq!(
            &core
                .commit_containing_refs(session, oid)
                .await
                .unwrap_err()
                .to_string(),
            folder_err
        );
    }
    let _ = std::fs::remove_dir_all(&fx.root);
}
