//! 폴더 화면의 stage·unstage (W14 ①, 계획 부록 "W14 진행 방식"). 폴더 세션 id + 저장소 경로로 index 를 쓴다:
//! 세션용과 같은 결과, 디렉터리·전부·빈 목록, 충돌 경로 보호, 소속·경로 검사, 워크트리·unborn·하위 저장소,
//! 쓰기 잠금, `FolderChanged`. 일괄 커밋(`folder_commit`)의 "stage 된 것만" 동작도 여기서 고정한다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::{collector, core_with};
use mgit_core::{
    CommandLogRecord, CommitSpec, Core, CoreConfig, CoreError, CoreEvent, GitError, IndexTarget,
    IndexWriteResult, SessionId, SkipReason, SkippedPath,
};
use mgit_testkit::TestRepo;
use tokio::sync::mpsc::UnboundedReceiver;

/// 폴더 안 경로에 커밋 하나(`a.txt`)짜리 저장소를 만든다
fn repo_at(path: &Path) -> TestRepo {
    let mut r = init_at(path);
    r.write_file("a.txt", "a\n");
    r.stage(&["a.txt"]);
    r.commit_staged("first");
    r
}

/// 폴더 안 경로에 커밋 없는 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 정규화한 임시 폴더 루트 (macOS 의 `/var` → `/private/var` 를 흡수해 세션 경로와 비교할 수 있게)
fn root_of(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().unwrap()
}

/// 감시 없는 코어 (이벤트는 코어가 직접 보낸 것만 온다)
async fn core() -> Core {
    core_with(CoreConfig::default()).await
}

/// 폴더를 연다 (이벤트 수신기 포함)
async fn open_folder(core: &Core, root: &Path) -> (SessionId, UnboundedReceiver<CoreEvent>) {
    let (sink, rx) = collector();
    (core.open_folder(root, sink).await.unwrap().session, rx)
}

/// 가벼운 세션을 연다 (세션용 API 와 비교할 때)
async fn open_light(core: &Core, folder: SessionId, repo: &Path) -> SessionId {
    let (sink, _rx) = collector();
    core.folder_open_repo_session(folder, repo, sink)
        .await
        .unwrap()
        .session
}

/// 경로 목록 대상
fn paths(list: &[&str]) -> IndexTarget {
    IndexTarget::Paths(list.iter().map(|p| (*p).to_string()).collect())
}

/// 문자열 목록
fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_string()).collect()
}

/// 충돌로 건너뛴 경로 목록
fn unmerged(list: &[&str]) -> Vec<SkippedPath> {
    list.iter()
        .map(|p| SkippedPath {
            path: (*p).to_string(),
            reason: SkipReason::Unmerged,
        })
        .collect()
}

/// `status --porcelain=v1 -z` 를 (XY, 경로) 목록으로 (git 의 순서). 이름 변경은 `새 경로 <- 옛 경로`
fn porcelain(repo: &mut TestRepo) -> Vec<(String, String)> {
    let out = repo.git_bytes(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let mut records = out
        .split(|&b| b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8_lossy(r).into_owned());
    let mut rows = Vec::new();
    while let Some(record) = records.next() {
        let (xy, path) = record.split_at(3);
        let xy = xy[..2].to_string();
        let path = if xy.starts_with('R') || xy.starts_with('C') {
            format!("{path} <- {}", records.next().unwrap())
        } else {
            path.to_string()
        };
        rows.push((xy, path));
    }
    rows
}

/// 기대하는 (XY, 경로) 목록 (순서 무관 비교용으로 정렬)
fn rows(list: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = list
        .iter()
        .map(|(xy, p)| ((*xy).to_string(), (*p).to_string()))
        .collect();
    v.sort();
    v
}

/// 정렬한 사본
fn sorted(mut v: Vec<(String, String)>) -> Vec<(String, String)> {
    v.sort();
    v
}

/// 지금까지 쌓인 명령 로그 (시간순)
fn command_log(core: &Core) -> Vec<CommandLogRecord> {
    let mut log = core.command_log_recent(usize::MAX);
    log.reverse();
    log
}

/// 그 작업 트리에서 돈 명령 중 인자에 `arg` 가 있는 것
fn commands_with(core: &Core, cwd: &Path, arg: &str) -> Vec<CommandLogRecord> {
    command_log(core)
        .into_iter()
        .filter(|r| r.cwd == cwd && r.args.iter().any(|a| a == arg))
        .collect()
}

/// 받은 이벤트를 다 꺼낸다
fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// 그 저장소의 `FolderChanged` 수
fn folder_changed_for(events: &[CoreEvent], repo: &Path) -> Vec<bool> {
    events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::FolderChanged {
                refs,
                repo: Some(r),
                ..
            } if r.as_path() == repo => Some(*refs),
            _ => None,
        })
        .collect()
}

/// 지금 epoch 밀리초
fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// 파일이 생길 때까지 기다린다 (시간 상한)
async fn wait_file(path: &Path, limit: Duration) {
    let deadline = tokio::time::Instant::now() + limit;
    while !path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{} 이(가) 생기지 않았다",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 커밋 명세
fn commit_spec(message: &str) -> CommitSpec {
    CommitSpec {
        message: message.into(),
        amend: false,
        no_verify: false,
        allow_empty: false,
        sign: None,
        allow_conflict_markers: false,
    }
}

/// `dir/c.txt` 가 merge 충돌로 멈춘 상태를 만든다 (main 이 체크아웃된 채 `other` 를 merge)
fn conflict_in_dir(r: &mut TestRepo) {
    r.write_file("dir/c.txt", "1\n2\n3\n");
    r.stage(&["dir/c.txt"]);
    r.commit_staged("base");
    r.checkout_new("other");
    r.write_file("dir/c.txt", "1\nTHEIRS\n3\n");
    r.stage(&["dir/c.txt"]);
    r.commit_staged("theirs");
    r.checkout("main");
    r.write_file("dir/c.txt", "1\nOURS\n3\n");
    r.stage(&["dir/c.txt"]);
    r.commit_staged("ours");
    let out = r.git(["merge", "--no-edit", "other"]);
    assert!(!out.status.success(), "충돌이 나야 한다");
}

/// 이름 변경으로 잡힐 만큼 긴 내용
const LONG: &str = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n";

// ── 세션용과 같은 결과 ─────────────────────────────────────────────────────────

/// 수정·삭제·이름 변경(옛·새 경로)·untracked 파일과 폴더·공백·한글·`-` 시작 이름을 경로로 stage·unstage 한다.
/// 같은 저장소에 세션용 `stage`·`unstage` 를 같은 경로로 적용하면 index 가 같다. 폴더용 호출은 저장소 세션을
/// 만들지 않는다
#[tokio::test]
async fn folder_stage_and_unstage_match_the_session_for_each_kind_of_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    for (p, body) in [
        ("mod.txt", "m\n"),
        ("del.txt", "d\n"),
        ("old.txt", LONG),
        ("공백 있는 파일.txt", "k\n"),
        ("-dash.txt", "-\n"),
        ("dir/x.txt", "x\n"),
    ] {
        a.write_file(p, body);
    }
    a.git_ok(["add", "-A"]);
    a.commit_staged("seed");
    a.write_file("mod.txt", "m2\n");
    a.remove_file("del.txt");
    std::fs::rename(path_a.join("old.txt"), path_a.join("new.txt")).unwrap();
    a.write_file("untracked.txt", "u\n");
    a.write_file("newdir/a.txt", "na\n");
    a.write_file("newdir/b/c.txt", "nc\n");
    a.write_file("공백 있는 파일.txt", "k2\n");
    a.write_file("-dash.txt", "-2\n");
    a.write_file("dir/x.txt", "x2\n");
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;
    let before = porcelain(&mut a);
    let targets = [
        "mod.txt",
        "del.txt",
        "old.txt",
        "new.txt",
        "untracked.txt",
        "newdir",
        "공백 있는 파일.txt",
        "-dash.txt",
    ];

    let r = core
        .folder_stage(fid, &path_a, &paths(&targets))
        .await
        .unwrap();
    assert_eq!(
        r,
        IndexWriteResult {
            ran: true,
            skipped: vec![]
        }
    );
    let staged = porcelain(&mut a);
    assert_eq!(
        sorted(staged.clone()),
        rows(&[
            ("M ", "-dash.txt"),
            ("D ", "del.txt"),
            (" M", "dir/x.txt"),
            ("M ", "mod.txt"),
            ("R ", "new.txt <- old.txt"),
            ("A ", "newdir/a.txt"),
            ("A ", "newdir/b/c.txt"),
            ("A ", "untracked.txt"),
            ("M ", "공백 있는 파일.txt"),
        ])
    );
    let r = core
        .folder_unstage(fid, &path_a, &paths(&targets))
        .await
        .unwrap();
    assert!(r.ran && r.skipped.is_empty(), "{r:?}");
    assert_eq!(porcelain(&mut a), before, "unstage 하면 처음으로 돌아간다");
    assert!(
        core.sessions().is_empty(),
        "폴더용 호출은 저장소 세션을 만들지 않는다"
    );

    // 같은 저장소에 세션용을 적용하면 같은 index 가 된다
    let s = open_light(&core, fid, &path_a).await;
    core.stage(s, &strings(&targets)).await.unwrap();
    assert_eq!(porcelain(&mut a), staged, "세션용 stage 와 같은 결과");
    core.unstage(s, &strings(&targets)).await.unwrap();
    assert_eq!(porcelain(&mut a), before, "세션용 unstage 와 같은 결과");
}

/// 이름 변경은 옛 경로와 새 경로를 함께 넘겨야 하나의 rename 으로 오간다. 새 경로만 넘기면 세션용과 같이
/// 그 경로만 움직인다 (stage: 새 파일 추가만, unstage: 옛 경로의 삭제가 stage 된 채 남는다)
#[tokio::test]
async fn renames_move_only_the_paths_that_were_named() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.write_file("old.txt", LONG);
    a.stage(&["old.txt"]);
    a.commit_staged("seed");
    std::fs::rename(path_a.join("old.txt"), path_a.join("new.txt")).unwrap();
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;

    core.folder_stage(fid, &path_a, &paths(&["new.txt"]))
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[("A ", "new.txt"), (" D", "old.txt")])
    );
    core.folder_stage(fid, &path_a, &paths(&["old.txt"]))
        .await
        .unwrap();
    assert_eq!(porcelain(&mut a), rows(&[("R ", "new.txt <- old.txt")]));
    core.folder_unstage(fid, &path_a, &paths(&["new.txt"]))
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[("D ", "old.txt"), ("??", "new.txt")])
    );
}

// ── 디렉터리·전부·빈 목록·멱등 ─────────────────────────────────────────────────

/// 디렉터리 경로는 그 아래 전부(수정·삭제·untracked·하위 폴더)를 stage 하고, 무시된 파일은 넣지 않는다.
/// 경로는 글자 그대로라 `d[1]` 이 `d1` 을 끌어오지 않는다. 전부(`All`)는 저장소 전체, unstage 도 같다.
/// 무시된 파일을 직접 가리키면 git 처럼 실패한다
#[tokio::test]
async fn directories_and_all_follow_git_pathspecs_literally() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    for (p, body) in [
        (".gitignore", "*.log\n"),
        ("dir/x.txt", "x\n"),
        ("dir/gone.txt", "g\n"),
        ("dir/sub/y.txt", "y\n"),
        ("top.txt", "t\n"),
        ("d[1]/in.txt", "1\n"),
        ("d1/in.txt", "1\n"),
    ] {
        a.write_file(p, body);
    }
    a.git_ok(["add", "-A"]);
    a.commit_staged("seed");
    a.write_file("dir/x.txt", "x2\n");
    a.remove_file("dir/gone.txt");
    a.write_file("dir/sub/y.txt", "y2\n");
    a.write_file("dir/new.txt", "n\n");
    a.write_file("dir/build.log", "log\n");
    a.write_file("top.txt", "t2\n");
    a.write_file("d[1]/in.txt", "2\n");
    a.write_file("d1/in.txt", "2\n");
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;

    core.folder_stage(fid, &path_a, &paths(&["dir"]))
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[
            (" M", "d1/in.txt"),
            (" M", "d[1]/in.txt"),
            ("D ", "dir/gone.txt"),
            ("A ", "dir/new.txt"),
            ("M ", "dir/sub/y.txt"),
            ("M ", "dir/x.txt"),
            (" M", "top.txt"),
        ])
    );
    assert!(
        a.git_ok(["ls-files", "--", "dir/build.log"]).is_empty(),
        "무시된 파일은 넣지 않는다"
    );
    assert!(path_a.join("dir/build.log").exists());

    core.folder_stage(fid, &path_a, &paths(&["d[1]"]))
        .await
        .unwrap();
    let now = sorted(porcelain(&mut a));
    assert!(
        now.contains(&("M ".into(), "d[1]/in.txt".into())),
        "{now:?}"
    );
    assert!(
        now.contains(&(" M".into(), "d1/in.txt".into())),
        "글롭이 아니다: {now:?}"
    );

    // 끝에 `/` 를 붙여도 같은 디렉터리다
    core.folder_unstage(fid, &path_a, &paths(&["dir/"]))
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[
            (" M", "d1/in.txt"),
            ("M ", "d[1]/in.txt"),
            (" D", "dir/gone.txt"),
            (" M", "dir/sub/y.txt"),
            (" M", "dir/x.txt"),
            (" M", "top.txt"),
            ("??", "dir/new.txt"),
        ])
    );

    let err = core
        .folder_stage(fid, &path_a, &paths(&["dir/build.log"]))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::CommandFailed { .. }), "{err:?}");

    core.folder_stage(fid, &path_a, &IndexTarget::All)
        .await
        .unwrap();
    assert!(
        porcelain(&mut a)
            .iter()
            .all(|(xy, _)| !xy.ends_with('M') && !xy.ends_with('D') && xy != "??"),
        "전부 stage 된다: {:?}",
        porcelain(&mut a)
    );
    assert!(a.git_ok(["ls-files", "--", "dir/build.log"]).is_empty());
    core.folder_unstage(fid, &path_a, &IndexTarget::All)
        .await
        .unwrap();
    assert!(
        a.git_ok(["diff", "--cached", "--name-only"]).is_empty(),
        "전부 unstage 된다"
    );
}

/// 빈 경로 목록은 "전부" 가 아니라 아무것도 하지 않는다: git 을 돌리지 않고 이벤트도 없다. 이미 그 상태인
/// 경로(stage 된 파일을 다시 stage, 작업 트리만 바뀐 파일을 unstage, 변경 없는 파일)는 오류 없이 그대로다
#[tokio::test]
async fn empty_targets_do_nothing_and_repeated_writes_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.write_file("s.txt", "s\n");
    a.stage(&["s.txt"]);
    a.write_file("a.txt", "a2\n");
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;
    let before = porcelain(&mut a);

    let commands = core.command_log_recent(usize::MAX).len();
    for op in [true, false] {
        let r = if op {
            core.folder_stage(fid, &path_a, &paths(&[])).await
        } else {
            core.folder_unstage(fid, &path_a, &paths(&[])).await
        }
        .unwrap();
        assert_eq!(r, IndexWriteResult::default());
    }
    assert_eq!(core.command_log_recent(usize::MAX).len(), commands);
    assert!(drain(&mut rx).is_empty(), "빈 대상은 이벤트도 없다");
    assert_eq!(porcelain(&mut a), before);

    for _ in 0..2 {
        core.folder_stage(fid, &path_a, &paths(&["s.txt"]))
            .await
            .unwrap();
        core.folder_unstage(fid, &path_a, &paths(&["a.txt"]))
            .await
            .unwrap();
    }
    a.write_file("clean.txt", "c\n");
    a.stage(&["clean.txt"]);
    a.commit_staged("clean");
    let before = porcelain(&mut a);
    let r = core
        .folder_stage(fid, &path_a, &paths(&["clean.txt"]))
        .await
        .unwrap();
    assert!(r.ran);
    assert_eq!(porcelain(&mut a), before);
}

// ── 충돌 경로 보호 ──────────────────────────────────────────────────────────────

/// 충돌 중인 저장소: 충돌 파일을 직접 가리키든, 그 파일을 품은 디렉터리든, 전부든 충돌 파일은 unmerged 로
/// 남고(충돌 목록 그대로) 나머지(수정·삭제·untracked)만 stage·unstage 된다. 결과에 건너뜀이 보인다. 직접 가리킨
/// 것뿐이면 git 쓰기를 돌리지 않는다. 디렉터리·전부는 그 안의 변경 경로로 풀어 stdin(`--pathspec-from-file`)으로
/// 넘긴다. 대조군: 보호 없는 `git add -A -- dir` 은 충돌을 해결된 것으로 바꾼다
#[tokio::test]
async fn unmerged_paths_are_never_staged_or_unstaged() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.write_file("dir/m.txt", "m\n");
    a.write_file("dir/gone.txt", "g\n");
    a.stage(&["dir/m.txt", "dir/gone.txt"]);
    a.commit_staged("seed");
    conflict_in_dir(&mut a);
    a.write_file("dir/m.txt", "m2\n");
    a.remove_file("dir/gone.txt");
    a.write_file("dir/n.txt", "n\n");
    a.write_file("t.txt", "t\n");
    let conflicts = a.git_ok(["ls-files", "-u"]);
    assert!(!conflicts.is_empty());
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;

    // 직접 가리킴: git 쓰기 없음
    for stage in [true, false] {
        let target = paths(&["dir/c.txt"]);
        let r = if stage {
            core.folder_stage(fid, &path_a, &target).await
        } else {
            core.folder_unstage(fid, &path_a, &target).await
        }
        .unwrap();
        assert_eq!(
            r,
            IndexWriteResult {
                ran: false,
                skipped: unmerged(&["dir/c.txt"])
            }
        );
    }
    assert!(commands_with(&core, &path_a, "add").is_empty());
    assert!(commands_with(&core, &path_a, "restore").is_empty());
    assert!(drain(&mut rx).is_empty(), "쓰지 않았으면 이벤트도 없다");

    // 디렉터리: 같은 디렉터리의 다른 파일만
    let r = core
        .folder_stage(fid, &path_a, &paths(&["dir"]))
        .await
        .unwrap();
    assert_eq!(
        r,
        IndexWriteResult {
            ran: true,
            skipped: unmerged(&["dir/c.txt"])
        }
    );
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[
            ("UU", "dir/c.txt"),
            ("D ", "dir/gone.txt"),
            ("M ", "dir/m.txt"),
            ("A ", "dir/n.txt"),
            ("??", "t.txt"),
        ])
    );
    let add = commands_with(&core, &path_a, "add").pop().unwrap();
    assert!(
        add.args.iter().any(|x| x == "--pathspec-from-file=-"),
        "{:?}",
        add.args
    );

    // 전부
    let r = core
        .folder_stage(fid, &path_a, &IndexTarget::All)
        .await
        .unwrap();
    assert_eq!(r.skipped, unmerged(&["dir/c.txt"]));
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[
            ("UU", "dir/c.txt"),
            ("D ", "dir/gone.txt"),
            ("M ", "dir/m.txt"),
            ("A ", "dir/n.txt"),
            ("A ", "t.txt"),
        ])
    );
    let r = core
        .folder_unstage(fid, &path_a, &IndexTarget::All)
        .await
        .unwrap();
    assert_eq!(r.skipped, unmerged(&["dir/c.txt"]));
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[
            ("UU", "dir/c.txt"),
            (" D", "dir/gone.txt"),
            (" M", "dir/m.txt"),
            ("??", "dir/n.txt"),
            ("??", "t.txt"),
        ])
    );
    // 디렉터리 unstage 도 같다 (stage 한 뒤 되돌린다)
    core.folder_stage(fid, &path_a, &paths(&["dir"]))
        .await
        .unwrap();
    let r = core
        .folder_unstage(fid, &path_a, &paths(&["dir"]))
        .await
        .unwrap();
    assert!(r.ran && r.skipped == unmerged(&["dir/c.txt"]), "{r:?}");
    assert_eq!(
        sorted(porcelain(&mut a)),
        rows(&[
            ("UU", "dir/c.txt"),
            (" D", "dir/gone.txt"),
            (" M", "dir/m.txt"),
            ("??", "dir/n.txt"),
            ("??", "t.txt"),
        ])
    );
    assert_eq!(a.git_ok(["ls-files", "-u"]), conflicts, "충돌 목록 그대로");

    // 대조군: 보호 없이 디렉터리를 stage 하면 충돌이 사라진다
    a.git_ok(["add", "-A", "--", "dir"]);
    assert!(a.git_ok(["ls-files", "-u"]).is_empty());
}

/// 진행 중인 merge 에서 충돌을 다 해결했으면(unmerged 없음) 다른 파일의 stage 는 막지 않는다. 일괄 커밋은
/// 그 저장소를 건너뛴다 (`folder_commit` 의 기존 규칙: 진행 중 작업이 있으면 건드리지 않는다)
#[tokio::test]
async fn staging_is_allowed_during_a_merge_but_folder_commit_skips_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    conflict_in_dir(&mut a);
    a.write_file("dir/c.txt", "1\nRESOLVED\n3\n");
    a.stage(&["dir/c.txt"]);
    a.write_file("extra.txt", "e\n");
    let head = a.head();
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;

    let r = core
        .folder_stage(fid, &path_a, &paths(&["extra.txt"]))
        .await
        .unwrap();
    assert!(r.ran && r.skipped.is_empty());
    assert!(porcelain(&mut a).contains(&("A ".into(), "extra.txt".into())));

    let result = core.folder_commit(fid, &[], "merge?", false).await.unwrap();
    let ra = &result.results[0];
    assert_eq!(
        ra.skipped.as_deref(),
        Some("진행 중인 작업이 있음"),
        "{ra:?}"
    );
    assert_eq!(a.head(), head);
    assert!(path_a.join(".git/MERGE_HEAD").exists());
}

// ── 소속·경로 검사 ─────────────────────────────────────────────────────────────

/// 폴더의 저장소 목록에 없는 경로(폴더 밖, 없는 경로, 폴더 자신, 저장소 안의 하위 폴더)와 작업 트리 밖을
/// 가리키는 경로(`..`, 절대 경로)·저장소 루트 자체(`.`)는 git 을 돌리기 전에 거부한다. 섞여 있으면 아무것도
/// stage 하지 않는다. 모르는 폴더 id 는 `SessionNotFound`
#[tokio::test]
async fn membership_and_paths_are_checked_before_git() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.write_file("src/ok.txt", "ok\n");
    let outside_dir = tempfile::tempdir().unwrap();
    let outside = root_of(&outside_dir).join("x");
    let _x = repo_at(&outside);
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;

    let before = core.command_log_recent(usize::MAX).len();
    for bad in [
        outside.clone(),
        root.join("nope"),
        root.clone(),
        path_a.join("src"),
    ] {
        let err = core
            .folder_stage(fid, &bad, &paths(&["ok.txt"]))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad:?}: {err:?}");
        let err = core
            .folder_unstage(fid, &bad, &IndexTarget::All)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad:?}: {err:?}");
    }
    for bad in ["../x", "/etc/hosts", "src/../../x", ".", "./", ""] {
        let err = core
            .folder_stage(fid, &path_a, &paths(&[bad]))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{bad:?}: {err:?}");
    }
    let err = core
        .folder_stage(fid, &path_a, &paths(&["src/ok.txt", "../x"]))
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        before,
        "거부는 git 을 돌리기 전이어야 한다"
    );
    assert!(a.git_ok(["diff", "--cached", "--name-only"]).is_empty());
    assert!(matches!(
        core.folder_stage(SessionId(9999), &path_a, &IndexTarget::All)
            .await,
        Err(CoreError::SessionNotFound(SessionId(9999)))
    ));
    assert!(core.sessions().is_empty());
}

/// 목록에 있던 경로가 더는 저장소 최상위가 아니면 상위 저장소에 쓰지 않는다: `.git` 이 지워졌으면 git 을 돌리지
/// 않고, 빈 `.git` 이 남아 git 이 상위 저장소를 잡으면 판별(읽기 1회) 뒤 쓰기 전에 거부한다
#[tokio::test]
async fn stale_roster_entry_never_writes_to_the_parent_repo() {
    let dir = tempfile::tempdir().unwrap();
    let outer = root_of(&dir);
    let mut parent = repo_at(&outer);
    let root = outer.join("repos");
    let path_a = root.join("a");
    let path_b = root.join("b");
    let _a = repo_at(&path_a);
    let _b = repo_at(&path_b);
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;
    // 폴더를 연 뒤 `.git` 이 사라진다 (재스캔 전이라 목록에는 남아 있다)
    std::fs::remove_dir_all(path_a.join(".git")).unwrap();
    std::fs::remove_dir_all(path_b.join(".git")).unwrap();
    std::fs::create_dir(path_b.join(".git")).unwrap();

    let before = core.command_log_recent(usize::MAX).len();
    let err = core
        .folder_stage(fid, &path_a, &IndexTarget::All)
        .await
        .unwrap_err();
    assert!(
        matches!(err, CoreError::Git(GitError::NotARepository(_))),
        "{err:?}"
    );
    assert_eq!(
        core.command_log_recent(usize::MAX).len(),
        before,
        "`.git` 이 없으면 git 을 돌리지 않는다"
    );
    let err = core
        .folder_stage(fid, &path_b, &paths(&["a.txt"]))
        .await
        .unwrap_err();
    assert!(
        matches!(err, CoreError::Git(GitError::NotARepository(_))),
        "{err:?}"
    );
    let ran: Vec<String> = command_log(&core)
        .into_iter()
        .skip(before)
        .map(|r| r.args.first().cloned().unwrap_or_default())
        .collect();
    assert_eq!(
        ran,
        vec!["rev-parse".to_string()],
        "판별만 돌고 쓰지 않는다"
    );
    assert!(
        parent
            .git_ok(["diff", "--cached", "--name-only"])
            .is_empty(),
        "상위 저장소의 index 는 그대로"
    );
}

// ── 워크트리·unborn·하위 저장소 ───────────────────────────────────────────────

/// 워크트리 저장소는 원 저장소가 아니라 그 워크트리 자신의 index 에 쓴다
#[tokio::test]
async fn worktree_entries_write_their_own_index() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let path_wt = root.join("a-wt");
    a.git_ok([
        "worktree",
        "add",
        "-q",
        "-b",
        "wt",
        &path_wt.to_string_lossy(),
    ]);
    let mut wt = TestRepo::at(&path_wt);
    a.write_file("w.txt", "main\n");
    wt.write_file("w.txt", "worktree\n");
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;

    core.folder_stage(fid, &path_wt, &paths(&["w.txt"]))
        .await
        .unwrap();
    assert_eq!(porcelain(&mut wt), rows(&[("A ", "w.txt")]));
    assert_eq!(porcelain(&mut a), rows(&[("??", "w.txt")]));
    core.folder_unstage(fid, &path_wt, &IndexTarget::All)
        .await
        .unwrap();
    assert_eq!(porcelain(&mut wt), rows(&[("??", "w.txt")]));
}

/// 커밋이 없는 저장소: stage 는 같고 unstage 는 `rm --cached` 로 untracked 로 되돌린다 (경로·전부)
#[tokio::test]
async fn unborn_repos_unstage_with_rm_cached() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_u = root.join("u");
    let mut u = init_at(&path_u);
    u.write_file("x.txt", "x\n");
    u.write_file("dir/y.txt", "y\n");
    let core = core().await;
    let (fid, _rx) = open_folder(&core, &root).await;

    core.folder_stage(fid, &path_u, &paths(&["x.txt"]))
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut u)),
        rows(&[("A ", "x.txt"), ("??", "dir/y.txt")])
    );
    core.folder_unstage(fid, &path_u, &paths(&["x.txt"]))
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut u)),
        rows(&[("??", "dir/y.txt"), ("??", "x.txt")])
    );
    assert!(!commands_with(&core, &path_u, "--cached").is_empty());
    core.folder_stage(fid, &path_u, &IndexTarget::All)
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut u)),
        rows(&[("A ", "dir/y.txt"), ("A ", "x.txt")])
    );
    core.folder_unstage(fid, &path_u, &IndexTarget::All)
        .await
        .unwrap();
    assert_eq!(
        sorted(porcelain(&mut u)),
        rows(&[("??", "dir/y.txt"), ("??", "x.txt")])
    );
}

/// 체크한 디렉터리 아래에 `.git` 을 품은 미등록 폴더가 있으면 아무것도 하지 않고 `NestedRepos` 다 (gitlink 로
/// 들어가지 않게 — 세션은 지정한 경로 자체만 보지만 폴더는 대상 아래 untracked 폴더도 본다). 등록된 서브모듈
/// 경로는 gitlink 변경을 세션용과 같이 stage·unstage 한다
#[tokio::test]
async fn nested_repos_are_refused_and_submodules_stage_like_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_p = root.join("p");
    let mut p = repo_at(&path_p);
    let _lib = repo_at(&path_p.join("vendor/lib"));
    let core = core().await;

    let source = {
        let mut s = TestRepo::init();
        s.commit("s1");
        s
    };
    let path_q = root.join("q");
    let mut q = repo_at(&path_q);
    q.add_submodule("sub", source.path());
    TestRepo::at(&path_q.join("sub")).commit("s2");
    let (fid, _rx) = open_folder(&core, &root).await;

    for target in [paths(&["vendor"]), IndexTarget::All] {
        let err = core.folder_stage(fid, &path_p, &target).await.unwrap_err();
        assert!(
            matches!(&err, CoreError::NestedRepos { paths } if paths == &vec!["vendor/lib".to_string()]),
            "{err:?}"
        );
    }
    assert!(p.git_ok(["ls-files", "-s", "--", "vendor"]).is_empty());
    assert!(commands_with(&core, &path_p, "add").is_empty());

    let before = porcelain(&mut q);
    assert_eq!(before, rows(&[(" M", "sub")]));
    core.folder_stage(fid, &path_q, &paths(&["sub"]))
        .await
        .unwrap();
    assert_eq!(porcelain(&mut q), rows(&[("M ", "sub")]));
    let gitlink = q.git_ok(["ls-files", "-s", "--", "sub"]);
    core.folder_unstage(fid, &path_q, &paths(&["sub"]))
        .await
        .unwrap();
    assert_eq!(porcelain(&mut q), before);
    let s = open_light(&core, fid, &path_q).await;
    core.stage(s, &strings(&["sub"])).await.unwrap();
    assert_eq!(q.git_ok(["ls-files", "-s", "--", "sub"]), gitlink);
}

// ── 이벤트 ─────────────────────────────────────────────────────────────────────

/// 쓰기를 돌린 호출마다 그 저장소의 `FolderChanged{refs: false}` 가 한 번 온다 (감시 없는 코어 — 코어가 직접
/// 보낸 것). index 가 그대로인 멱등 호출도 온다. 쓰지 않은 호출(빈 대상·충돌만)에는 없다
#[tokio::test]
async fn folder_changed_follows_each_write() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let path_b = root.join("b");
    let mut a = repo_at(&path_a);
    let _b = repo_at(&path_b);
    a.write_file("w.txt", "w\n");
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;
    drain(&mut rx);

    core.folder_stage(fid, &path_a, &paths(&["w.txt"]))
        .await
        .unwrap();
    let events = drain(&mut rx);
    assert_eq!(folder_changed_for(&events, &path_a), vec![false]);
    assert!(folder_changed_for(&events, &path_b).is_empty());

    core.folder_stage(fid, &path_a, &paths(&["w.txt"]))
        .await
        .unwrap();
    assert_eq!(
        folder_changed_for(&drain(&mut rx), &path_a),
        vec![false],
        "index 가 그대로여도 온다"
    );
    core.folder_unstage(fid, &path_a, &IndexTarget::All)
        .await
        .unwrap();
    assert_eq!(folder_changed_for(&drain(&mut rx), &path_a), vec![false]);
}

// ── 쓰기 잠금 ──────────────────────────────────────────────────────────────────

/// 폴더 stage 는 그 저장소의 쓰기 잠금을 잡는다: 세션의 쓰기(느린 pre-commit 훅이 도는 commit)가 끝난 뒤에야
/// 폴더 stage 의 상태 읽기·`add` 가 돈다
#[cfg(unix)]
#[tokio::test]
async fn folder_stage_waits_for_a_session_write_on_the_same_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let started = root.join("hook.started");
    a.install_hook(
        "pre-commit",
        &format!("#!/bin/sh\ntouch '{}'\nsleep 1\n", started.display()),
    );
    a.write_file("x.txt", "x\n");
    a.write_file("y.txt", "y\n");
    let core = Arc::new(core().await);
    let (fid, _rx) = open_folder(&core, &root).await;
    let s = open_light(&core, fid, &path_a).await;
    core.stage(s, &strings(&["x.txt"])).await.unwrap();
    let commit = {
        let core = Arc::clone(&core);
        tokio::spawn(async move { core.commit(s, commit_spec("slow"), None).await })
    };
    wait_file(&started, Duration::from_secs(10)).await;
    let called_at = now_ms();
    tokio::time::timeout(
        Duration::from_secs(20),
        core.folder_stage(fid, &path_a, &paths(&["y.txt"])),
    )
    .await
    .expect("교착 없이 끝나야 한다")
    .unwrap();
    commit.await.unwrap().unwrap();

    let commit_cmd = commands_with(&core, &path_a, "commit").pop().unwrap();
    let commit_end = commit_cmd.started_at + i64::from(commit_cmd.elapsed_ms);
    assert!(
        called_at < commit_end,
        "폴더 stage 는 commit 이 도는 중에 불렸다"
    );
    let mine = commands_with(&core, &path_a, "y.txt");
    assert_eq!(mine.len(), 2, "상태 읽기와 add: {mine:?}");
    assert!(
        mine.iter().all(|r| r.started_at >= commit_end),
        "폴더 stage 가 세션 쓰기와 겹쳤다: commit 끝 {commit_end}, {mine:?}"
    );
}

/// 반대 방향: 폴더 stage 가 잠금을 쥔 동안(느린 post-index-change 훅) 세션의 stage 는 기다린다
#[cfg(unix)]
#[tokio::test]
async fn session_write_waits_for_a_folder_stage_on_the_same_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    a.write_file("f.txt", "f\n");
    a.write_file("s.txt", "s\n");
    let core = Arc::new(core().await);
    let (fid, _rx) = open_folder(&core, &root).await;
    let s = open_light(&core, fid, &path_a).await;
    let started = root.join("hook.started");
    a.install_hook(
        "post-index-change",
        &format!("#!/bin/sh\ntouch '{}'\nsleep 1\n", started.display()),
    );
    let folder_stage = {
        let core = Arc::clone(&core);
        let path_a = path_a.clone();
        tokio::spawn(async move { core.folder_stage(fid, &path_a, &paths(&["f.txt"])).await })
    };
    wait_file(&started, Duration::from_secs(10)).await;
    let called_at = now_ms();
    tokio::time::timeout(Duration::from_secs(20), core.stage(s, &strings(&["s.txt"])))
        .await
        .expect("교착 없이 끝나야 한다")
        .unwrap();
    folder_stage.await.unwrap().unwrap();

    let folder_add = commands_with(&core, &path_a, "f.txt")
        .into_iter()
        .find(|r| r.args.iter().any(|x| x == "add"))
        .unwrap();
    let folder_end = folder_add.started_at + i64::from(folder_add.elapsed_ms);
    assert!(
        called_at < folder_end,
        "세션 stage 는 폴더 stage 가 도는 중에 불렸다"
    );
    let session_add = commands_with(&core, &path_a, "s.txt").pop().unwrap();
    assert!(
        session_add.started_at >= folder_end,
        "세션 쓰기가 폴더 stage 와 겹쳤다: 폴더 add 끝 {folder_end}, 세션 add {}",
        session_add.started_at
    );
}

/// 일괄 커밋이 그 저장소의 잠금을 쥔 동안(느린 pre-commit 훅) 폴더 stage 는 기다린다
#[cfg(unix)]
#[tokio::test]
async fn folder_stage_waits_for_a_folder_commit_on_the_same_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let path_a = root.join("a");
    let mut a = repo_at(&path_a);
    let started = root.join("hook.started");
    a.install_hook(
        "pre-commit",
        &format!("#!/bin/sh\ntouch '{}'\nsleep 1\n", started.display()),
    );
    a.write_file("x.txt", "x\n");
    a.stage(&["x.txt"]);
    a.write_file("z.txt", "z\n");
    let core = Arc::new(core().await);
    let (fid, _rx) = open_folder(&core, &root).await;
    let commit = {
        let core = Arc::clone(&core);
        tokio::spawn(async move { core.folder_commit(fid, &[], "batch", false).await })
    };
    wait_file(&started, Duration::from_secs(10)).await;
    let called_at = now_ms();
    tokio::time::timeout(
        Duration::from_secs(20),
        core.folder_stage(fid, &path_a, &paths(&["z.txt"])),
    )
    .await
    .expect("교착 없이 끝나야 한다")
    .unwrap();
    let result = commit.await.unwrap().unwrap();
    assert_eq!(result.succeeded, 1, "{result:?}");

    let commit_cmd = commands_with(&core, &path_a, "commit").pop().unwrap();
    let commit_end = commit_cmd.started_at + i64::from(commit_cmd.elapsed_ms);
    assert!(called_at < commit_end);
    let mine = commands_with(&core, &path_a, "z.txt");
    assert!(
        !mine.is_empty() && mine.iter().all(|r| r.started_at >= commit_end),
        "폴더 stage 가 일괄 커밋과 겹쳤다: commit 끝 {commit_end}, {mine:?}"
    );
    assert!(
        a.git_ok(["show", "--name-only", "--format=", "HEAD"])
            .lines()
            .all(|l| l != "z.txt"),
        "커밋 뒤에 stage 됐다"
    );
}

// ── 일괄 커밋 (stage 된 것만) ──────────────────────────────────────────────────

/// `folder_commit(…, stage_all = false)` 조사표: stage 된 변경만 커밋하고(작업 트리 변경·untracked 는 남는다),
/// stage 된 것이 없으면 "stage 된 변경 없음", 충돌·진행 중 작업이면 "진행 중인 작업이 있음" 으로 건너뛰고, 훅이
/// 실패하거나 충돌 마커가 stage 됐으면 실패로 남긴다. 커밋 없는 저장소는 첫 커밋이 된다. 모든 대상 저장소에
/// `FolderChanged{refs: true}` 가 온다
#[tokio::test]
async fn folder_commit_with_staged_only_commits_the_index_and_reports_skips() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_of(&dir);
    let _clean = repo_at(&root.join("clean"));
    let mut unstaged = repo_at(&root.join("unstaged"));
    unstaged.write_file("a.txt", "changed\n");
    unstaged.write_file("new.txt", "n\n");
    let mut staged = repo_at(&root.join("staged"));
    staged.write_file("s.txt", "s\n");
    staged.stage(&["s.txt"]);
    staged.write_file("a.txt", "unstaged change\n");
    staged.write_file("loose.txt", "l\n");
    let mut conflict = repo_at(&root.join("conflict"));
    conflict.prepare_conflict();
    conflict.begin_merge_conflict();
    let mut merging = repo_at(&root.join("merging"));
    merging.prepare_conflict();
    merging.begin_merge_conflict();
    merging.write_file("conflict.txt", "resolved\n");
    merging.stage(&["conflict.txt"]);
    let mut hook = repo_at(&root.join("hook"));
    hook.install_hook("pre-commit", "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
    hook.write_file("h.txt", "h\n");
    hook.stage(&["h.txt"]);
    let mut markers = repo_at(&root.join("markers"));
    markers.write_file("m.txt", "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n");
    markers.stage(&["m.txt"]);
    let mut unborn = init_at(&root.join("unborn"));
    unborn.write_file("u.txt", "u\n");
    unborn.stage(&["u.txt"]);
    let heads: Vec<_> = [&mut conflict, &mut merging, &mut hook, &mut markers]
        .into_iter()
        .map(|r| r.head())
        .collect();
    let core = core().await;
    let (fid, mut rx) = open_folder(&core, &root).await;
    drain(&mut rx);

    let r = core
        .folder_commit(fid, &[], "일괄 제목\n\n본문 줄", false)
        .await
        .unwrap();
    let by = |name: &str| r.results.iter().find(|x| x.name == name).unwrap();
    let outcome = |name: &str| {
        let x = by(name);
        (x.ok, x.skipped.clone())
    };
    let none = Some("stage 된 변경 없음".to_string());
    let busy = Some("진행 중인 작업이 있음".to_string());
    assert_eq!(outcome("clean"), (true, none.clone()));
    assert_eq!(outcome("unstaged"), (true, none));
    assert_eq!(outcome("staged"), (true, None));
    assert_eq!(outcome("conflict"), (true, busy.clone()));
    assert_eq!(outcome("merging"), (true, busy));
    assert_eq!(outcome("hook"), (false, None));
    assert!(
        by("hook").message.contains("hook says no"),
        "{:?}",
        by("hook")
    );
    assert_eq!(outcome("markers"), (false, None));
    assert!(
        by("markers").message.contains("m.txt"),
        "{:?}",
        by("markers")
    );
    assert_eq!(outcome("unborn"), (true, None));
    assert_eq!((r.succeeded, r.skipped, r.failed), (2, 4, 2), "{r:?}");

    assert_eq!(
        staged.git_ok(["log", "-1", "--format=%B"]).trim_end(),
        "일괄 제목\n\n본문 줄"
    );
    assert_eq!(
        sorted(porcelain(&mut staged)),
        rows(&[(" M", "a.txt"), ("??", "loose.txt")]),
        "stage 된 것만 커밋된다"
    );
    assert_eq!(
        sorted(porcelain(&mut unstaged)),
        rows(&[(" M", "a.txt"), ("??", "new.txt")])
    );
    assert_eq!(unborn.git_ok(["rev-list", "--count", "HEAD"]).trim(), "1");
    let after: Vec<_> = [&mut conflict, &mut merging, &mut hook, &mut markers]
        .into_iter()
        .map(|r| r.head())
        .collect();
    assert_eq!(after, heads, "건너뛰거나 실패한 저장소의 HEAD 는 그대로");
    assert!(!conflict.git_ok(["ls-files", "-u"]).is_empty());
    assert!(porcelain(&mut hook).contains(&("A ".into(), "h.txt".into())));

    let events = drain(&mut rx);
    for x in &r.results {
        assert_eq!(
            folder_changed_for(&events, &x.path),
            vec![true],
            "{}",
            x.name
        );
    }
}
