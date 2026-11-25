//! 폴더 커밋 상세·diff 계약 (W7: CD-05, FS-11). 저장소 세션 없이 폴더 세션 id + 저장소 경로로 읽고,
//! 결과는 저장소 세션의 `commit_detail`·`commit_file_diff_opts` 와 같아야 한다.
//! 그래프에 묶인 필드(행·자식·라벨)는 통합 타임라인 기준이다
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, core_with, wait_finished, wait_for};
use mgit_core::{
    CommitDetail, Core, CoreConfig, CoreError, CoreEvent, DiffChange, DiffOptions, GitError,
    GraphQuery, GraphRevs, Oid, SessionId, TimelineInfo,
};
use mgit_testkit::TestRepo;
use tokio::sync::mpsc::UnboundedReceiver;

/// 첫 판 `src/lib.rs`
const LIB_V1: &str = "fn a() {\n    one();\n}\n\nfn b() {\n    two();\n}\n";
/// 둘째 판: `one();` 의 들여쓰기만 탭으로(공백 변경) + `two` → `three`(실제 변경)
const LIB_V2: &str = "fn a() {\n\tone();\n}\n\nfn b() {\n    three();\n}\n";
/// 이름만 바꿀 파일 (rename 탐지용으로 여러 줄)
const MOVED_BODY: &str = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
/// 바이너리 파일 두 판 (NUL 포함, 크기가 다르다)
const BIN_V1: &[u8] = b"\x00\x01\x02\x03bin-v1\x00";
const BIN_V2: &[u8] = b"\x00\x01\x02\x03bin-v2 is longer than the first\x00\xff\xfe";

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 테스트마다 따로 쓰는 임시 루트. 일부러 정규화하지 않는다 — macOS 의 `/var` → `/private/var` 처럼
/// 스캔 결과(정규화됨)와 꼴이 다른 요청 경로도 같은 저장소로 받는지 함께 본다
fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mgit-inspect-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// 시험용 폴더: 저장소 a(여러 변경 종류·머지·태그), a 의 워크트리 a-wt, 저장소 b, a 를 클론한 c,
/// 저장소가 아닌 폴더 plain
struct Fixture {
    root: PathBuf,
    a: PathBuf,
    wt: PathBuf,
    b: PathBuf,
    c: PathBuf,
    /// a 의 루트 커밋 (README·lib·이동할 파일·지울 파일·바이너리 추가)
    c1: Oid,
    /// 수정·rename·삭제·추가·바이너리 수정이 섞인 커밋. 태그 v1
    c2: Oid,
    /// feature 브랜치의 커밋
    f1: Oid,
    /// main 의 커밋
    c3: Oid,
    /// feature 를 main 에 합친 머지 커밋 (main 의 HEAD)
    merge: Oid,
    b_head: Oid,
    _repos: Vec<TestRepo>,
}

impl Fixture {
    /// a 의 모든 커밋 (루트·혼합·브랜치·머지)
    fn a_commits(&self) -> [Oid; 5] {
        [self.c1, self.c2, self.f1, self.c3, self.merge]
    }
}

/// 시험용 폴더를 만든다
fn fixture(tag: &str) -> Fixture {
    let root = temp_root(tag);
    let mut a = init_at(&root.join("a"));
    a.write_file("README.md", "# a\n");
    a.write_file("src/lib.rs", LIB_V1);
    a.write_file("old/name.txt", MOVED_BODY);
    a.write_file("gone.txt", "bye\n");
    std::fs::write(a.path().join("bin.dat"), BIN_V1).unwrap();
    a.stage(&["."]);
    let c1 = a.commit_staged("c1 root\n\n첫 커밋 본문\n둘째 줄");

    a.write_file("src/lib.rs", LIB_V2);
    std::fs::create_dir_all(a.path().join("new/dir")).unwrap();
    a.git_ok(["mv", "old/name.txt", "new/dir/name.txt"]);
    a.git_ok(["rm", "-q", "gone.txt"]);
    a.write_file("docs/guide/intro.md", "intro\n");
    std::fs::write(a.path().join("bin.dat"), BIN_V2).unwrap();
    a.stage(&["."]);
    let c2 = a.commit_staged("c2 mixed");
    a.tag("v1", false);

    a.checkout_new("feature");
    a.write_file("feature.txt", "f\n");
    a.stage(&["feature.txt"]);
    let f1 = a.commit_staged("f1 feature");
    a.checkout("main");
    a.write_file("README.md", "# a\nmore\n");
    a.stage(&["README.md"]);
    let c3 = a.commit_staged("c3 main");
    let merge = a.merge(&["feature"], "merge feature");

    let wt = root.join("a-wt");
    a.git_ok([
        "worktree",
        "add",
        "-q",
        &wt.display().to_string(),
        "-b",
        "wt",
    ]);
    let c = root.join("c");
    a.git_ok([
        "clone",
        "-q",
        &root.join("a").display().to_string(),
        &c.display().to_string(),
    ]);

    let mut b = init_at(&root.join("b"));
    b.advance_clock(30);
    b.commit("b1");
    let b_head = b.commit("b2");

    std::fs::create_dir_all(root.join("plain")).unwrap();
    std::fs::write(root.join("plain/readme.txt"), "not a repo\n").unwrap();

    Fixture {
        a: root.join("a"),
        b: root.join("b"),
        root,
        wt,
        c,
        c1,
        c2,
        f1,
        c3,
        merge,
        b_head,
        _repos: vec![a, b],
    }
}

/// 폴더만 연다 (타임라인은 열지 않는다)
async fn open_only(core: &Core, root: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, rx) = collector();
    let fid = core.open_folder(root, sink).await.unwrap().session;
    (fid, rx)
}

/// 폴더를 열고 타임라인 첫 로드가 끝날 때까지 기다린다
async fn open_with_timeline(core: &Core, root: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (fid, mut rx) = open_only(core, root).await;
    core.folder_timeline_open(fid).unwrap();
    wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphLoadFinished { session, .. } if *session == fid),
    )
    .await;
    (fid, rx)
}

/// 타임라인 재로드가 끝날 때까지 기다린다
async fn wait_reloaded(rx: &mut UnboundedReceiver<CoreEvent>, fid: SessionId) {
    wait_for(
        rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphReloaded { session, .. } if *session == fid),
    )
    .await;
}

/// 저장소 세션을 열고 그래프 로드가 끝날 때까지 기다린다
async fn open_session(core: &Core, path: &Path) -> SessionId {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(path, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    opened.session
}

/// 지금까지 코어가 돌린 git 명령 수
fn command_count(core: &Core) -> usize {
    core.command_log_recent(usize::MAX).len()
}

/// `before` 개 이후에 돈 git 명령의 작업 폴더 (오래된 것부터)
fn cwds_since(core: &Core, before: usize) -> Vec<PathBuf> {
    core.command_log_recent(usize::MAX)
        .into_iter()
        .rev()
        .skip(before)
        .map(|r| r.cwd)
        .collect()
}

/// 그래프에 묶인 필드(행·자식·라벨)를 비운 상세. 두 길의 그래프는 다르므로 나머지만 비교한다
fn without_graph(d: &CommitDetail) -> CommitDetail {
    CommitDetail {
        row: None,
        children: Vec::new(),
        refs: Vec::new(),
        ..d.clone()
    }
}

/// 타임라인 정보에서 경로의 저장소 번호
fn index_of(info: &TimelineInfo, path: &Path) -> u16 {
    let canon = path.canonicalize().unwrap();
    info.repos
        .iter()
        .find(|r| r.path == canon)
        .unwrap_or_else(|| panic!("{} 이 타임라인에 없다: {info:?}", canon.display()))
        .index
}

/// 상세가 바꾼 파일 하나를 경로로 찾는다
fn file<'a>(d: &'a CommitDetail, path: &str) -> &'a mgit_core::ChangedFile {
    d.files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("{path} 없음: {:?}", d.files))
}

/// 같은 커밋의 상세는 폴더 API 와 저장소 세션 API 가 같다 (그래프 필드 제외, 라벨은 같은 ref 를 읽으므로
/// 같다). 폴더 API 는 저장소 세션을 만들지 않는다 (CD-05)
#[tokio::test]
async fn folder_detail_matches_session_detail_without_a_repo_session() {
    let fx = fixture("detail");
    let core = core().await;
    let (fid, _rx) = open_with_timeline(&core, &fx.root).await;
    assert!(core.sessions().is_empty());

    let mut folder = Vec::new();
    for oid in fx.a_commits() {
        folder.push(core.folder_commit_detail(fid, &fx.a, &oid).await.unwrap());
    }
    assert!(
        core.sessions().is_empty(),
        "폴더 API 가 저장소 세션을 열었다"
    );

    // 그래프와 무관한 필드의 뜻 (세션 API 의 동작과 같은지는 아래에서 비교한다)
    let [root, mixed, _, _, merge] = folder.as_slice() else {
        unreachable!()
    };
    assert!(root.parents.is_empty());
    assert_eq!(root.message, "c1 root\n\n첫 커밋 본문\n둘째 줄");
    assert_eq!(
        (root.author_name.as_str(), root.committer_email.as_str()),
        ("mGit Test", "test@mgit.invalid")
    );
    assert!(root.files.iter().all(|f| f.change == DiffChange::Added));
    assert_eq!(root.files.len(), 5);
    assert_eq!(mixed.parents, vec![fx.c1]);
    assert_eq!(file(mixed, "src/lib.rs").change, DiffChange::Modified);
    assert_eq!(file(mixed, "bin.dat").change, DiffChange::Modified);
    assert_eq!(file(mixed, "gone.txt").change, DiffChange::Deleted);
    assert_eq!(file(mixed, "docs/guide/intro.md").change, DiffChange::Added);
    let moved = file(mixed, "new/dir/name.txt");
    assert_eq!(moved.change, DiffChange::Renamed { similarity: 100 });
    assert_eq!(moved.old_path.as_deref(), Some("old/name.txt"));
    // 머지 커밋은 첫 부모 기준: feature 쪽 파일만 바뀐 것으로 보인다
    assert_eq!(merge.parents, vec![fx.c3, fx.f1]);
    assert_eq!(merge.files.len(), 1);
    assert_eq!(file(merge, "feature.txt").change, DiffChange::Added);

    let session = open_session(&core, &fx.a).await;
    for f in &folder {
        let s = core.commit_detail(session, &f.oid).await.unwrap();
        assert_eq!(without_graph(f), without_graph(&s), "{}", s.message);
        assert_eq!(f.refs, s.refs, "{}: 같은 ref 를 읽는다", s.message);
    }
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// diff 는 바뀐 파일마다, 옵션 변형마다 두 API 가 같다: 수정·추가·삭제·rename·바이너리·루트·머지,
/// 잘림(`full`)·공백 무시·문맥 줄 수. 저장소 세션의 diff 는 이 시험 전에 직접 다루는 시험이 없었으므로
/// 뜻(잘림·공백 무시·바이너리 크기 등)도 함께 고정한다
#[tokio::test]
async fn folder_diff_matches_session_diff_for_every_change_kind_and_option() {
    let fx = fixture("diff");
    // 잘림을 보려고 상한을 낮춘다
    let core = core_with(CoreConfig {
        diff_max_lines: 4,
        ..CoreConfig::default()
    })
    .await;
    let (fid, _rx) = open_only(&core, &fx.root).await;
    let variants = [
        (false, DiffOptions::default()),
        (true, DiffOptions::default()),
        (
            true,
            DiffOptions {
                ignore_whitespace: true,
                context: 0,
            },
        ),
    ];

    // 폴더 쪽을 먼저 다 읽는다 (그동안 저장소 세션이 생기지 않는다). 파일마다 새 경로만, 이름이 바뀐
    // 파일은 옛 경로를 함께 넘긴 것과 옛 경로만 넘긴 것도 묻는다
    let mut asked = Vec::new();
    for oid in fx.a_commits() {
        let detail = core.folder_commit_detail(fid, &fx.a, &oid).await.unwrap();
        let mut queries: Vec<(String, Option<String>)> = Vec::new();
        for f in &detail.files {
            queries.push((f.path.clone(), None));
            if let Some(old) = &f.old_path {
                queries.push((f.path.clone(), Some(old.clone())));
                queries.push((old.clone(), None));
            }
        }
        for (path, old) in queries {
            for (full, opts) in variants {
                let diff = core
                    .folder_commit_file_diff(fid, &fx.a, &oid, &path, old.as_deref(), full, opts)
                    .await
                    .unwrap();
                asked.push((oid, path.clone(), old.clone(), full, opts, diff));
            }
        }
    }
    assert!(core.sessions().is_empty());

    // 뜻: 잘림, 공백 무시, 바이너리 크기, 이름 변경, 머지(첫 부모 기준)
    let find = |oid: Oid, path: &str, old: Option<&str>, full: bool, ws: bool| {
        asked
            .iter()
            .find(|(o, p, op, f, opts, _)| {
                *o == oid
                    && p == path
                    && op.as_deref() == old
                    && *f == full
                    && opts.ignore_whitespace == ws
            })
            .map(|(.., d)| d.clone())
            .unwrap_or_else(|| panic!("{path} 을 묻지 않았다"))
    };
    let get = |oid: Oid, path: &str, full: bool, ws: bool| {
        find(oid, path, None, full, ws).unwrap_or_else(|| panic!("{path} 의 diff 가 없다"))
    };
    let cut = get(fx.c2, "src/lib.rs", false, false);
    let whole = get(fx.c2, "src/lib.rs", true, false);
    let ws = get(fx.c2, "src/lib.rs", true, true);
    assert!(cut.truncated && !whole.truncated);
    let changed = |d: &mgit_core::FileDiff| {
        d.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind != mgit_core::LineKind::Context)
            .count()
    };
    assert_eq!(changed(&whole), 4, "공백 변경 1쌍 + 실제 변경 1쌍");
    assert_eq!(changed(&ws), 2, "공백 무시면 실제 변경만");
    let bin = get(fx.c2, "bin.dat", true, false);
    let info = bin.binary.unwrap();
    assert_eq!(
        (info.old_size, info.new_size),
        (Some(BIN_V1.len() as u64), Some(BIN_V2.len() as u64))
    );
    // 이름 변경: 새 경로만 물으면 git 이 경로로 먼저 걸러 짝이 없으므로 "추가", 옛 경로만이면 "삭제"
    // (옛 경로를 모를 때의 동작은 그대로). 옛 경로를 함께 넘기면 rename 이고 순수 rename 이라 hunk 가 없다
    assert_eq!(
        get(fx.c2, "new/dir/name.txt", true, false).change,
        DiffChange::Added
    );
    assert_eq!(
        get(fx.c2, "old/name.txt", true, false).change,
        DiffChange::Deleted
    );
    let paired = find(fx.c2, "new/dir/name.txt", Some("old/name.txt"), true, false).unwrap();
    assert_eq!(paired.change, DiffChange::Renamed { similarity: 100 });
    assert_eq!(
        (paired.old_path.as_deref(), paired.new_path.as_deref()),
        (Some("old/name.txt"), Some("new/dir/name.txt"))
    );
    assert!(paired.hunks.is_empty());
    assert_eq!(
        get(fx.c2, "gone.txt", true, false).change,
        DiffChange::Deleted
    );
    assert_eq!(
        get(fx.c1, "README.md", true, false).change,
        DiffChange::Added
    );
    // 머지 커밋: 상세의 파일 목록과 같은 첫 부모 기준이라 feature 쪽 파일의 diff 가 나온다
    let merge_diffs: Vec<_> = asked.iter().filter(|(o, ..)| *o == fx.merge).collect();
    assert_eq!(merge_diffs.len(), variants.len());
    for (.., diff) in &merge_diffs {
        let diff = diff.as_ref().expect("머지 커밋의 diff 가 비었다");
        assert_eq!(diff.change, DiffChange::Added);
        assert_eq!(diff.new_path.as_deref(), Some("feature.txt"));
    }

    let session = open_session(&core, &fx.a).await;
    for (oid, path, old, full, opts, folder_diff) in &asked {
        let session_diff = core
            .commit_file_diff_opts(session, oid, path, old.as_deref(), *full, *opts)
            .await
            .unwrap();
        assert_eq!(
            folder_diff, &session_diff,
            "{path} (옛 경로 {old:?}) full={full} {opts:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 이 폴더의 저장소가 아닌 경로는 git 을 돌리기 전에 거부한다 (FS-11)
#[tokio::test]
async fn folder_inspect_rejects_strangers_before_running_git() {
    let fx = fixture("strangers");
    let core = core().await;
    let (fid, _rx) = open_only(&core, &fx.root).await;
    let outside = tempfile::tempdir().unwrap();
    let before = command_count(&core);

    for stranger in [
        outside.path().to_path_buf(),
        fx.root.clone(),
        fx.root.join("plain"),
        fx.a.join("src"),
        fx.a.join(".git"),
        fx.root.join("missing"),
        PathBuf::from("a"),
        PathBuf::new(),
    ] {
        let name = stranger.display().to_string();
        assert!(
            matches!(
                core.folder_commit_detail(fid, &stranger, &fx.c2).await,
                Err(CoreError::Invalid(_))
            ),
            "상세: {name}"
        );
        assert!(
            matches!(
                core.folder_commit_file_diff(
                    fid,
                    &stranger,
                    &fx.c2,
                    "src/lib.rs",
                    None,
                    true,
                    DiffOptions::default()
                )
                .await,
                Err(CoreError::Invalid(_))
            ),
            "diff: {name}"
        );
        assert!(
            matches!(
                core.folder_timeline_find_row_at(fid, &stranger, &fx.c2),
                Err(CoreError::Invalid(_))
            ),
            "행 찾기: {name}"
        );
    }
    assert_eq!(command_count(&core), before, "거부한 요청에 git 이 돌았다");

    // 없는 폴더 세션
    let ghost = SessionId(9_999);
    assert!(matches!(
        core.folder_commit_detail(ghost, &fx.a, &fx.c2).await,
        Err(CoreError::SessionNotFound(_))
    ));
    assert!(core.sessions().is_empty());
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 없는 커밋·잘못된 diff 경로는 저장소 세션과 같은 오류(또는 같은 빈 결과)다
#[tokio::test]
async fn unknown_commits_and_bad_diff_paths_fail_like_the_session() {
    let fx = fixture("errors");
    let core = core().await;
    let (fid, _rx) = open_only(&core, &fx.root).await;
    // 다른 저장소(b)에만 있는 커밋, 어디에도 없는 커밋
    let nowhere = Oid::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
    let mut folder = Vec::new();
    for oid in [fx.b_head, nowhere] {
        let err = core
            .folder_commit_detail(fid, &fx.a, &oid)
            .await
            .unwrap_err();
        match &err {
            CoreError::Git(GitError::Exit { stderr, .. }) => {
                assert!(stderr.contains("bad object"), "{stderr}")
            }
            other => panic!("git 오류여야 한다: {other:?}"),
        }
        let diff_err = core
            .folder_commit_file_diff(
                fid,
                &fx.a,
                &oid,
                "README.md",
                None,
                true,
                DiffOptions::default(),
            )
            .await
            .unwrap_err();
        folder.push((oid, err.to_string(), diff_err.to_string()));
    }
    let bad_paths = ["../escape.txt", "", "/etc/hosts"];
    let mut folder_paths = Vec::new();
    for path in bad_paths {
        let e = core
            .folder_commit_file_diff(fid, &fx.a, &fx.c2, path, None, true, DiffOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(e, CoreError::Git(_)), "{path}: {e:?}");
        folder_paths.push(e.to_string());
    }
    // 커밋 트리에 없는 경로는 오류가 아니라 "변경 없음"
    assert!(
        core.folder_commit_file_diff(
            fid,
            &fx.a,
            &fx.c2,
            "no/such/file",
            None,
            true,
            DiffOptions::default()
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(core.sessions().is_empty());

    let session = open_session(&core, &fx.a).await;
    for (oid, detail_err, diff_err) in &folder {
        assert_eq!(
            &core
                .commit_detail(session, oid)
                .await
                .unwrap_err()
                .to_string(),
            detail_err
        );
        assert_eq!(
            &core
                .commit_file_diff_opts(
                    session,
                    oid,
                    "README.md",
                    None,
                    true,
                    DiffOptions::default()
                )
                .await
                .unwrap_err()
                .to_string(),
            diff_err
        );
    }
    for (path, folder_err) in bad_paths.iter().zip(&folder_paths) {
        let e = core
            .commit_file_diff_opts(session, &fx.c2, path, None, true, DiffOptions::default())
            .await
            .unwrap_err();
        assert_eq!(&e.to_string(), folder_err, "{path}");
    }
    assert!(
        core.commit_file_diff_opts(
            session,
            &fx.c2,
            "no/such/file",
            None,
            true,
            DiffOptions::default()
        )
        .await
        .unwrap()
        .is_none()
    );
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 행·자식·라벨은 통합 타임라인 기준이다. 타임라인을 열기 전에는 셋 다 비고(ref 를 따로 읽지 않는다),
/// 열린 뒤에는 그 저장소의 행·같은 저장소 안의 자식·그 저장소의 라벨이다. 브랜치 필터로 커밋이 빠지면
/// 행·자식만 빈다
#[tokio::test]
async fn folder_detail_graph_fields_follow_the_timeline() {
    let fx = fixture("graph");
    let core = core().await;
    let (fid, mut rx) = open_only(&core, &fx.root).await;

    // 타임라인 전: 상세 자체는 답하고 그래프 필드는 비어 있다 (c2 에는 태그 v1 이 있지만 싣지 않는다)
    let early = core.folder_commit_detail(fid, &fx.a, &fx.c2).await.unwrap();
    assert_eq!(
        (early.row, early.children.len(), early.refs.len()),
        (None, 0, 0)
    );
    assert_eq!(early.files.len(), 5);
    assert_eq!(
        core.folder_timeline_find_row_at(fid, &fx.a, &fx.c2)
            .unwrap(),
        None
    );

    core.folder_timeline_open(fid).unwrap();
    wait_for(
        &mut rx,
        Duration::from_secs(10),
        |e| matches!(e, CoreEvent::GraphLoadFinished { session, .. } if *session == fid),
    )
    .await;
    let info = core.folder_timeline_info(fid).unwrap();
    let window = core.folder_timeline_window(fid, 0, 1000).unwrap();
    let (ia, ic) = (index_of(&info, &fx.a), index_of(&info, &fx.c));

    // 각 저장소의 커밋마다 타임라인 창과 맞춘다. c 는 a 의 클론이라 같은 커밋이 행 둘로 있다
    for (repo, idx) in [(&fx.a, ia), (&fx.c, ic)] {
        for oid in fx.a_commits() {
            let d = core.folder_commit_detail(fid, repo, &oid).await.unwrap();
            let row = window
                .rows
                .iter()
                .find(|r| r.repo == Some(idx) && r.oid == oid)
                .unwrap();
            assert_eq!(d.row, Some(row.row));
            assert_eq!(
                core.folder_timeline_find_row_at(fid, repo, &oid).unwrap(),
                Some(row.row)
            );
            let mut children: Vec<Oid> = window
                .rows
                .iter()
                .filter(|r| r.repo == Some(idx) && r.parents.contains(&oid))
                .map(|r| r.oid)
                .collect();
            let mut got = d.children.clone();
            children.sort();
            got.sort();
            assert_eq!(got, children, "같은 저장소 안의 자식만");
            assert_eq!(d.refs, row.refs, "라벨은 그 저장소의 것");
        }
    }
    let in_a = core.folder_commit_detail(fid, &fx.a, &fx.c2).await.unwrap();
    let in_c = core.folder_commit_detail(fid, &fx.c, &fx.c2).await.unwrap();
    assert_ne!(in_a.row, in_c.row, "같은 커밋이라도 저장소마다 행이 다르다");
    assert_eq!(in_a.children.len(), 2, "c2 의 자식은 f1 과 c3");
    let names = |d: &CommitDetail| {
        d.refs
            .iter()
            .map(|l| l.short_name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&in_a), vec!["v1"]);
    // 머지 커밋: 현재 브랜치 main 과 워크트리를 만들며 생긴 wt (현재 → 로컬 순)
    assert_eq!(
        names(
            &core
                .folder_commit_detail(fid, &fx.a, &fx.merge)
                .await
                .unwrap()
        ),
        vec!["main", "wt"]
    );

    // 브랜치 필터: feature 의 이력만 남는다. 빠진 커밋은 행·자식이 비고 라벨은 남는다
    core.folder_timeline_query_set(
        fid,
        GraphQuery {
            revs: GraphRevs::Solo {
                name: "feature".into(),
            },
            ..GraphQuery::default()
        },
    )
    .await
    .unwrap();
    wait_reloaded(&mut rx, fid).await;
    let filtered = core
        .folder_commit_detail(fid, &fx.a, &fx.merge)
        .await
        .unwrap();
    assert_eq!((filtered.row, filtered.children.len()), (None, 0));
    assert_eq!(names(&filtered), vec!["main", "wt"]);
    assert_eq!(
        core.folder_timeline_find_row_at(fid, &fx.a, &fx.merge)
            .unwrap(),
        None
    );
    let c2 = core.folder_commit_detail(fid, &fx.a, &fx.c2).await.unwrap();
    assert!(c2.row.is_some());
    assert_eq!(c2.children, vec![fx.f1], "c3 는 필터로 빠졌다");
    assert_eq!(
        without_graph(&c2),
        without_graph(&in_a),
        "그래프 밖 필드는 질의와 무관하다"
    );
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 워크트리 경로는 원 저장소(같은 순번 묶음의 대표)로 읽는다: 결과가 원 저장소 경로로 물은 것과
/// 같고, git 은 원 저장소에서 돈다
#[tokio::test]
async fn worktree_path_reads_the_primary_repo() {
    let fx = fixture("worktree");
    let core = core().await;
    let (fid, _rx) = open_with_timeline(&core, &fx.root).await;
    let before = command_count(&core);
    let via_wt = core
        .folder_commit_detail(fid, &fx.wt, &fx.merge)
        .await
        .unwrap();
    let ran = cwds_since(&core, before);
    let via_a = core
        .folder_commit_detail(fid, &fx.a, &fx.merge)
        .await
        .unwrap();
    assert_eq!(via_wt, via_a);
    assert!(via_wt.row.is_some());
    let primary = fx.a.canonicalize().unwrap();
    assert!(!ran.is_empty());
    assert!(ran.iter().all(|cwd| *cwd == primary), "{ran:?}");
    assert_eq!(
        core.folder_timeline_find_row_at(fid, &fx.wt, &fx.merge)
            .unwrap(),
        core.folder_timeline_find_row_at(fid, &fx.a, &fx.merge)
            .unwrap()
    );
    let opts = DiffOptions::default();
    assert_eq!(
        core.folder_commit_file_diff(fid, &fx.wt, &fx.c2, "src/lib.rs", None, true, opts)
            .await
            .unwrap(),
        core.folder_commit_file_diff(fid, &fx.a, &fx.c2, "src/lib.rs", None, true, opts)
            .await
            .unwrap()
    );
    assert!(core.sessions().is_empty());
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 경로로 찾은 행은 재스캔으로 저장소 번호가 밀려도 같은 커밋을 가리킨다. 옛 번호는 다른 저장소가 된다
#[tokio::test]
async fn row_by_path_survives_a_rescan_that_shifts_repo_numbers() {
    let fx = fixture("rescan");
    let core = core().await;
    let (fid, mut rx) = open_with_timeline(&core, &fx.root).await;
    let old_index = index_of(&core.folder_timeline_info(fid).unwrap(), &fx.b);
    let row = core
        .folder_timeline_find_row_at(fid, &fx.b, &fx.b_head)
        .unwrap();
    assert_eq!(
        core.folder_timeline_find_row(fid, old_index, &fx.b_head)
            .unwrap(),
        row
    );
    assert!(row.is_some());

    // 경로순으로 b 앞에 저장소가 끼고, 그 커밋이 가장 최근이라 행도 밀린다
    let mut aa = init_at(&fx.root.join("aa"));
    aa.advance_clock(100_000);
    aa.commit("aa1");
    core.folder_rescan(fid).await.unwrap();
    wait_reloaded(&mut rx, fid).await;

    let info = core.folder_timeline_info(fid).unwrap();
    let new_index = index_of(&info, &fx.b);
    assert_eq!(new_index, old_index + 1);
    let moved = core
        .folder_timeline_find_row_at(fid, &fx.b, &fx.b_head)
        .unwrap()
        .unwrap();
    assert_ne!(Some(moved), row, "행이 밀렸다");
    let window = core.folder_timeline_window(fid, moved, 1).unwrap();
    assert_eq!(
        (window.rows[0].oid, window.rows[0].repo),
        (fx.b_head, Some(new_index))
    );
    assert_eq!(
        core.folder_commit_detail(fid, &fx.b, &fx.b_head)
            .await
            .unwrap()
            .row,
        Some(moved)
    );
    // 옛 번호로는 더 이상 그 커밋을 찾지 못한다 (그 번호는 이제 aa 다)
    assert_eq!(
        core.folder_timeline_find_row(fid, old_index, &fx.b_head)
            .unwrap(),
        None
    );
    assert_eq!(info.repos[usize::from(old_index)].name, "aa");
    let _ = std::fs::remove_dir_all(&fx.root);
}

// ───────────── 커밋 파일 diff 의 기준 (머지 첫 부모, rename 짝, 글자 그대로의 경로) ─────────────

/// diff 기준 시험용 폴더: 저장소 r 하나
struct DiffFixture {
    root: PathBuf,
    repo: PathBuf,
    /// 루트 커밋 (이름에 `*` 가 든 파일 포함)
    first: Oid,
    /// 내용 그대로 이름만 바꾼 커밋 (`pure/a.txt` → `pure/b/a.txt`)
    pure: Oid,
    /// 이름을 바꾸며 한 줄 고친 커밋 (`moved/old.txt` → `moved/new.txt`)
    edited: Oid,
    /// `a.txt`·`sub/b.txt` 만 고친 일반 커밋
    plain: Oid,
    /// side 를 합친 머지. 두 부모 모두 바뀐 것이 있고 conflict.txt 는 손으로 해결(양쪽과 다른 내용)
    merge: Oid,
    _repo: TestRepo,
}

/// diff 기준 시험용 폴더를 만든다
fn diff_fixture(tag: &str) -> DiffFixture {
    let root = temp_root(tag);
    let repo = root.join("r");
    let mut r = init_at(&repo);
    r.write_file("conflict.txt", "base\n");
    r.write_file("shared.txt", "s1\ns2\ns3\ns4\ns5\n");
    r.write_file("keep.txt", "k1\nk2\nk3\nk4\nk5\nk6\n");
    r.write_file("pure/a.txt", "p1\np2\np3\np4\np5\n");
    r.write_file("moved/old.txt", "m1\nm2\nm3\nm4\nm5\nm6\n");
    r.write_file("a.txt", "a\n");
    r.write_file("sub/b.txt", "b\n");
    r.write_file("*.txt", "star\n");
    r.stage(&["."]);
    let first = r.commit_staged("first");

    std::fs::create_dir_all(repo.join("pure/b")).unwrap();
    r.git_ok(["mv", "pure/a.txt", "pure/b/a.txt"]);
    let pure = r.commit_staged("pure rename");
    r.git_ok(["mv", "moved/old.txt", "moved/new.txt"]);
    r.write_file("moved/new.txt", "m1\nm2\nM3\nm4\nm5\nm6\n");
    r.stage(&["."]);
    let edited = r.commit_staged("rename with edit");
    r.write_file("a.txt", "a2\n");
    r.write_file("sub/b.txt", "b2\n");
    r.stage(&["."]);
    let plain = r.commit_staged("plain");

    r.checkout_new("side");
    r.write_file("conflict.txt", "side\n");
    r.write_file("side.txt", "from side\n");
    r.write_file("shared.txt", "S1\ns2\ns3\ns4\ns5\n");
    std::fs::create_dir_all(repo.join("kept")).unwrap();
    r.git_ok(["mv", "keep.txt", "kept/keep.txt"]);
    r.stage(&["."]);
    r.commit_staged("side work");
    r.checkout("main");
    r.write_file("conflict.txt", "main\n");
    r.write_file("main.txt", "from main\n");
    r.write_file("shared.txt", "s1\ns2\ns3\ns4\nS5\n");
    r.stage(&["."]);
    r.commit_staged("main work");
    let out = r.git(["merge", "--no-ff", "-m", "merge side", "side"]);
    assert!(!out.status.success(), "conflict.txt 가 충돌해야 한다");
    r.write_file("conflict.txt", "resolved by hand\n");
    r.stage(&["conflict.txt"]);
    let merge = r.commit_staged("merge side");
    DiffFixture {
        root,
        repo,
        first,
        pure,
        edited,
        plain,
        merge,
        _repo: r,
    }
}

/// 세션·폴더 두 API 로 같은 diff 를 묻고 같은지 확인한 뒤 돌려준다
async fn both_diffs(
    core: &Core,
    session: SessionId,
    fid: SessionId,
    repo: &Path,
    oid: &Oid,
    path: &str,
    old: Option<&str>,
) -> Option<mgit_core::FileDiff> {
    let opts = DiffOptions::default();
    let s = core
        .commit_file_diff_opts(session, oid, path, old, true, opts)
        .await
        .unwrap();
    let f = core
        .folder_commit_file_diff(fid, repo, oid, path, old, true, opts)
        .await
        .unwrap();
    assert_eq!(s, f, "{path} (옛 경로 {old:?}): 세션과 폴더가 다르다");
    s
}

/// diff 의 바뀐 줄 (`-`·`+` 접두)
fn changed_lines(d: &mgit_core::FileDiff) -> Vec<String> {
    d.hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter_map(|l| match l.kind {
            mgit_core::LineKind::Add => Some(format!("+{}", l.text)),
            mgit_core::LineKind::Del => Some(format!("-{}", l.text)),
            mgit_core::LineKind::Context => None,
        })
        .collect()
}

/// 머지 커밋의 diff 는 상세의 파일 목록과 같은 첫 부모 기준이다: 목록의 모든 파일에 diff 가 있고 변경
/// 종류가 같다. 손으로 해결한 충돌 파일은 첫 부모 내용 → 해결한 내용으로, 첫 부모 쪽에서만 바뀐 파일은
/// 목록에도 diff 에도 없다
#[tokio::test]
async fn merge_commit_diffs_follow_the_first_parent_like_the_file_list() {
    let fx = diff_fixture("merge-diff");
    let core = core().await;
    let (fid, _rx) = open_only(&core, &fx.root).await;
    let session = open_session(&core, &fx.repo).await;

    let detail = core
        .folder_commit_detail(fid, &fx.repo, &fx.merge)
        .await
        .unwrap();
    assert_eq!(detail.parents.len(), 2);
    let mut listed: Vec<(&str, &DiffChange)> = detail
        .files
        .iter()
        .map(|f| (f.path.as_str(), &f.change))
        .collect();
    listed.sort_by_key(|(path, _)| *path);
    assert_eq!(
        listed,
        vec![
            ("conflict.txt", &DiffChange::Modified),
            ("kept/keep.txt", &DiffChange::Renamed { similarity: 100 }),
            ("shared.txt", &DiffChange::Modified),
            ("side.txt", &DiffChange::Added),
        ],
        "두 번째 부모(side)에서 온 변경과 손으로 해결한 파일"
    );
    for f in &detail.files {
        let diff = both_diffs(
            &core,
            session,
            fid,
            &fx.repo,
            &fx.merge,
            &f.path,
            f.old_path.as_deref(),
        )
        .await
        .unwrap_or_else(|| panic!("{} 의 diff 가 없다 (목록에는 있다)", f.path));
        assert_eq!(
            diff.change, f.change,
            "{}: 목록과 diff 의 기준이 다르다",
            f.path
        );
    }
    let resolved = both_diffs(
        &core,
        session,
        fid,
        &fx.repo,
        &fx.merge,
        "conflict.txt",
        None,
    )
    .await
    .unwrap();
    assert_eq!(changed_lines(&resolved), vec!["-main", "+resolved by hand"]);
    let shared = both_diffs(&core, session, fid, &fx.repo, &fx.merge, "shared.txt", None)
        .await
        .unwrap();
    assert_eq!(changed_lines(&shared), vec!["-s1", "+S1"], "side 쪽 변경만");
    // 첫 부모(main)에서만 바뀐 파일
    assert!(
        both_diffs(&core, session, fid, &fx.repo, &fx.merge, "main.txt", None)
            .await
            .is_none()
    );
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 이름이 바뀐 파일은 옛 경로를 함께 넘기면 rename 으로 짝지어진다: 순수 rename 은 hunk 없이, 내용이
/// 바뀐 rename 은 바뀐 줄만. 옛 경로를 넘기지 않으면 지금처럼 "추가"다
#[tokio::test]
async fn rename_diffs_pair_with_the_old_path() {
    let fx = diff_fixture("rename-diff");
    let core = core().await;
    let (fid, _rx) = open_only(&core, &fx.root).await;
    let session = open_session(&core, &fx.repo).await;
    let diff = |oid: Oid, path: &'static str, old: Option<&'static str>| {
        let core = &core;
        let repo = fx.repo.clone();
        async move {
            both_diffs(core, session, fid, &repo, &oid, path, old)
                .await
                .unwrap()
        }
    };

    // 순수 rename
    let pure = diff(fx.pure, "pure/b/a.txt", Some("pure/a.txt")).await;
    assert_eq!(pure.change, DiffChange::Renamed { similarity: 100 });
    assert_eq!(
        (pure.old_path.as_deref(), pure.new_path.as_deref()),
        (Some("pure/a.txt"), Some("pure/b/a.txt"))
    );
    assert!(pure.hunks.is_empty());
    // 내용이 바뀐 rename: 바뀐 줄만 (파일 전체가 추가로 보이지 않는다)
    let edited = diff(fx.edited, "moved/new.txt", Some("moved/old.txt")).await;
    assert!(matches!(edited.change, DiffChange::Renamed { similarity } if similarity < 100));
    assert_eq!(edited.old_path.as_deref(), Some("moved/old.txt"));
    assert_eq!(changed_lines(&edited), vec!["-m3", "+M3"]);
    // 상세의 목록과 같은 종류다
    let detail = core.commit_detail(session, &fx.edited).await.unwrap();
    let listed = detail
        .files
        .iter()
        .find(|f| f.path == "moved/new.txt")
        .unwrap();
    assert_eq!(listed.change, edited.change);
    // 옛 경로를 모르면 지금과 같다: 새 경로는 전체 추가
    let alone = diff(fx.edited, "moved/new.txt", None).await;
    assert_eq!(alone.change, DiffChange::Added);
    assert_eq!(changed_lines(&alone).len(), 6);
    // 옛 경로가 새 경로와 같으면 옛 경로가 없는 것과 같다
    assert_eq!(
        diff(fx.edited, "moved/new.txt", Some("moved/new.txt")).await,
        alone
    );
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 경로는 글자 그대로다: 러너가 `GIT_LITERAL_PATHSPECS=1` 을 붙이므로 `*`·`:(glob)` 이 다른 파일을 끌어오지
/// 않는다 (옛 경로도 같다)
#[tokio::test]
async fn diff_paths_are_taken_literally() {
    let fx = diff_fixture("literal");
    let core = core().await;
    let (fid, _rx) = open_only(&core, &fx.root).await;
    let session = open_session(&core, &fx.repo).await;
    let ask = |oid: Oid, path: &'static str, old: Option<&'static str>| {
        let core = &core;
        let repo = fx.repo.clone();
        async move { both_diffs(core, session, fid, &repo, &oid, path, old).await }
    };

    // plain 은 a.txt·sub/b.txt 만 바꿨다. 글롭이었다면 셋 다 그 파일을 찾는다
    for pattern in ["*.txt", ":(glob)**/b.txt", "sub/*", "?.txt"] {
        assert!(ask(fx.plain, pattern, None).await.is_none(), "{pattern}");
    }
    assert_eq!(
        ask(fx.plain, "sub/b.txt", None)
            .await
            .unwrap()
            .new_path
            .as_deref(),
        Some("sub/b.txt")
    );
    // 이름이 `*.txt` 인 파일은 그 파일 하나만
    let star = ask(fx.first, "*.txt", None).await.unwrap();
    assert_eq!(star.new_path.as_deref(), Some("*.txt"));
    assert_eq!(changed_lines(&star), vec!["+star"]);
    // 옛 경로도 글자 그대로: 짝지을 파일이 없으면 옛 경로가 없는 것과 같다
    assert_eq!(
        ask(fx.plain, "a.txt", Some("*")).await,
        ask(fx.plain, "a.txt", None).await
    );
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 루트·일반·rename(옛 경로 없이) 커밋의 diff 는 바꾸기 전 명령(`diff-tree -p … <oid>^!`)의 결과와 같다
#[tokio::test]
async fn root_and_regular_commit_diffs_are_unchanged() {
    let mut fx = diff_fixture("regression");
    let core = core().await;
    let session = open_session(&core, &fx.repo).await;
    for oid in [fx.first, fx.pure, fx.edited, fx.plain] {
        let detail = core.commit_detail(session, &oid).await.unwrap();
        for f in &detail.files {
            let now = core
                .commit_file_diff_opts(session, &oid, &f.path, None, true, DiffOptions::default())
                .await
                .unwrap();
            let raw = fx._repo.git_bytes([
                "--literal-pathspecs",
                "-c",
                "core.quotepath=false",
                "diff-tree",
                "-p",
                "-r",
                "-M",
                "--root",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                &format!("{}^!", oid.to_hex()),
                "--",
                &f.path,
            ]);
            let before = mgit_git::parse::parse_diff(&raw).into_iter().next();
            assert!(before.is_some(), "{}", f.path);
            assert_eq!(now, before, "{} @ {}", f.path, detail.message);
        }
    }
    let _ = std::fs::remove_dir_all(&fx.root);
}

/// 스태시 커밋도 머지 커밋(부모: HEAD, index[, untracked])이라 같은 기준을 탄다: 스태시 파일 목록의 추적
/// 파일은 첫 부모(HEAD) 기준 diff 가 나온다. untracked 파일은 셋째 부모에 있어 이 diff 에 없다 (현재 한계)
#[tokio::test]
async fn stash_file_diffs_follow_the_first_parent() {
    let mut r = TestRepo::init();
    r.write_file("f.txt", "one\n");
    r.stage(&["f.txt"]);
    r.commit_staged("base");
    r.write_file("f.txt", "two\n");
    r.write_file("u.txt", "untracked\n");
    r.stash_push("wip", true);
    let stash = Oid::from_hex(r.git_ok(["rev-parse", "stash@{0}"]).trim().as_bytes()).unwrap();
    let core = core().await;
    let session = open_session(&core, r.path()).await;

    let files = core.stash_files(session, &stash).await.unwrap();
    let mut listed: Vec<(&str, &DiffChange)> =
        files.iter().map(|f| (f.path.as_str(), &f.change)).collect();
    listed.sort_by_key(|(path, _)| *path);
    assert_eq!(
        listed,
        vec![
            ("f.txt", &DiffChange::Modified),
            ("u.txt", &DiffChange::Added)
        ]
    );
    let tracked = core
        .commit_file_diff_opts(session, &stash, "f.txt", None, true, DiffOptions::default())
        .await
        .unwrap()
        .expect("스태시의 추적 파일 diff");
    assert_eq!(changed_lines(&tracked), vec!["-one", "+two"]);
    assert!(
        core.commit_file_diff_opts(session, &stash, "u.txt", None, true, DiffOptions::default())
            .await
            .unwrap()
            .is_none(),
        "untracked 파일은 셋째 부모에 있다"
    );
}

/// 폴더 문서도 저장소 세션을 만들지 않고 원문과 첫 부모 기준을 제공한다.
#[tokio::test]
async fn folder_diff_document_has_originals_without_repo_session() {
    let core = core().await;
    let fx = fixture("document");
    let (fid, _rx) = open_only(&core, &fx.root).await;
    let doc = core
        .folder_commit_file_diff_document(
            fid,
            &fx.a,
            &fx.c2,
            "src/lib.rs",
            None,
            false,
            DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(doc.old.content.as_deref(), Some(LIB_V1));
    assert_eq!(doc.new.content.as_deref(), Some(LIB_V2));
    assert_eq!(doc.old.label, fx.c1.to_hex());
    assert!(core.sessions().is_empty());
}
