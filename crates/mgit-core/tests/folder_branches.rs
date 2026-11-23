//! 폴더 계약 기반 (W6): 브랜치 목록(PF-03), 저장소 순번·색(LF-09), 부분집합 조회(PF-02, FS-11)
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{collector, core, wait_for};
use mgit_core::{
    Core, CoreError, CoreEvent, FolderBranch, FolderBranchIn, FolderBranches, HeadState, SessionId,
};
use mgit_testkit::TestRepo;

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 테스트마다 따로 쓰는 임시 루트 (정규화된 경로)
fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mgit-branches-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root.canonicalize().unwrap()
}

/// 이름으로 브랜치를 찾는다
fn branch<'a>(list: &'a FolderBranches, name: &str, remote: bool) -> &'a FolderBranch {
    list.branches
        .iter()
        .find(|b| b.name == name && b.remote == remote)
        .unwrap_or_else(|| panic!("{name} 없음: {:#?}", list.branches))
}

/// 브랜치의 저장소별 상태를 경로로 찾는다
fn in_repo<'a>(b: &'a FolderBranch, path: &Path) -> &'a FolderBranchIn {
    b.repos
        .iter()
        .find(|r| r.path == path)
        .unwrap_or_else(|| panic!("{} 에 {} 없음", path.display(), b.name))
}

/// 지금까지 코어가 돌린 git 명령의 (작업 폴더, 인자) 목록. 최신 순
fn commands(core: &Core) -> Vec<(PathBuf, Vec<String>)> {
    core.command_log_recent(usize::MAX)
        .into_iter()
        .map(|r| (r.cwd, r.args))
        .collect()
}

/// 인자에 그 하위 명령이 있는지
fn runs(args: &[String], sub: &str) -> bool {
    args.iter().any(|a| a == sub)
}

/// 저장소 a(원격 origin: main 은 ahead 1·behind 1, `old` 는 업스트림이 사라짐, `local-only`,
/// 워크트리 `a-wt` 의 `wt`), 저장소 b(분리 HEAD)
fn branch_fixture(tag: &str) -> (PathBuf, TestRepo, TestRepo) {
    let root = temp_root(tag);
    let mut a = init_at(&root.join("a"));
    a.commit("a1");
    a.commit("a2");
    a.add_bare_remote();
    a.git_ok(["push", "-q", "-u", "origin", "main"]);
    // main: 원격보다 하나 뒤로 물린 뒤 새 커밋 → ahead 1, behind 1
    a.git_ok(["reset", "-q", "--hard", "HEAD~1"]);
    a.commit("a2-local");
    // old: 추적하던 원격 브랜치가 사라졌다
    a.git_ok(["push", "-q", "origin", "main:old"]);
    a.git_ok(["branch", "-q", "--track", "old", "origin/old"]);
    a.git_ok(["update-ref", "-d", "refs/remotes/origin/old"]);
    a.git_ok(["branch", "-q", "local-only"]);
    a.tag("v1", false);
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
    b.commit("b1");
    b.commit("b2");
    b.git_ok(["checkout", "-q", "--detach", "HEAD~1"]);
    (root, a, b)
}

/// 브랜치 목록은 타임라인 없이 답하고(`log` 를 돌리지 않는다) 저장소별 추적 상태를 싣는다
#[tokio::test]
async fn branches_merge_repos_with_tracking_state_without_timeline() {
    let (root, mut a, mut b) = branch_fixture("list");
    let (path_a, path_b) = (root.join("a"), root.join("b"));
    let core = core().await;
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;

    let list = core.folder_branches(fid, &[]).await.unwrap();

    // 타임라인은 열지 않았고 git log 도 돌지 않았다
    assert!(!core.folder_timeline_info(fid).unwrap().finished);
    assert!(
        commands(&core).iter().all(|(_, args)| !runs(args, "log")),
        "{:?}",
        commands(&core)
    );

    // 저장소: 워크트리는 원 저장소에 흡수된다. 색은 순번
    let repos: Vec<(&str, u8)> = list
        .repos
        .iter()
        .map(|r| (r.name.as_str(), r.color))
        .collect();
    assert_eq!(repos, vec![("a", 0), ("b", 1)]);
    assert!(list.repos.iter().all(|r| r.error.is_none()), "{list:#?}");
    assert_eq!(
        list.repos[0].head,
        Some(HeadState::Attached {
            branch: "refs/heads/main".into(),
            oid: a.head(),
        })
    );
    assert_eq!(
        list.repos[1].head,
        Some(HeadState::Detached { oid: b.head() })
    );

    // main: 두 저장소에 있다. a 에서는 현재 브랜치고 ahead 1·behind 1, b 는 분리 HEAD 라 현재가 아니다
    let main = branch(&list, "main", false);
    assert_eq!(main.remote_name, None);
    let paths: Vec<&Path> = main.repos.iter().map(|r| r.path.as_path()).collect();
    assert_eq!(paths, vec![path_a.as_path(), path_b.as_path()]);
    let main_a = in_repo(main, &path_a);
    assert!(main_a.current);
    assert_eq!(main_a.color, 0);
    assert_eq!(main_a.upstream.as_deref(), Some("origin/main"));
    assert_eq!(
        (main_a.ahead, main_a.behind, main_a.gone),
        (Some(1), Some(1), false)
    );
    let main_b = in_repo(main, &path_b);
    assert!(!main_b.current);
    assert_eq!(main_b.color, 1);
    assert_eq!(
        (main_b.upstream.as_deref(), main_b.ahead, main_b.behind),
        (None, None, None)
    );

    // 업스트림이 사라진 브랜치
    let old = in_repo(branch(&list, "old", false), &path_a);
    assert_eq!(old.upstream.as_deref(), Some("origin/old"));
    assert!(old.gone);
    assert_eq!((old.ahead, old.behind), (None, None));

    // 업스트림 없는 브랜치, 워크트리에서 체크아웃한 브랜치(이 저장소의 현재 브랜치는 아니다)
    let local_only = in_repo(branch(&list, "local-only", false), &path_a);
    assert_eq!(
        (local_only.upstream.as_deref(), local_only.gone),
        (None, false)
    );
    assert!(!in_repo(branch(&list, "wt", false), &path_a).current);

    // 원격 브랜치: 원격 이름이 따로 온다
    let origin_main = branch(&list, "origin/main", true);
    assert_eq!(origin_main.remote_name.as_deref(), Some("origin"));
    assert_eq!(origin_main.repos.len(), 1);
    assert_eq!(origin_main.repos[0].path, path_a);
    assert!(!origin_main.repos[0].current);

    // 로컬 먼저, 이름순
    let order: Vec<(bool, &str)> = list
        .branches
        .iter()
        .map(|b| (b.remote, b.name.as_str()))
        .collect();
    let mut sorted = order.clone();
    sorted.sort();
    assert_eq!(order, sorted);
    assert!(
        list.branches.iter().all(|b| b.name != "v1"),
        "태그는 싣지 않는다"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 부분집합 조회는 그 저장소만 읽고, 폴더의 저장소 목록에 없는 경로는 거부한다 (FS-11)
#[tokio::test]
async fn subset_queries_read_only_the_asked_repos_and_reject_strangers() {
    let (root, _a, mut b) = branch_fixture("subset");
    let (path_a, path_wt, path_b) = (root.join("a"), root.join("a-wt"), root.join("b"));
    b.write_file("dirty.txt", "x");
    let core = core().await;
    let (sink, _rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    let before = commands(&core).len();

    // b 만: 요약·변경·브랜치 모두 b 에서만 git 이 돈다
    let only_b = std::slice::from_ref(&path_b);
    let summaries = core.folder_summaries(fid, only_b).await.unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].path, path_b);
    let changes = core.folder_changes(fid, only_b).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, path_b);
    let branches = core.folder_branches(fid, only_b).await.unwrap();
    assert_eq!(branches.repos.len(), 1);
    assert_eq!(branches.repos[0].path, path_b);
    assert!(
        branches
            .branches
            .iter()
            .all(|br| br.repos.iter().all(|r| r.path == path_b))
    );
    let ran: Vec<(PathBuf, Vec<String>)> = commands(&core).into_iter().rev().skip(before).collect();
    assert!(!ran.is_empty());
    assert!(
        ran.iter().all(|(cwd, _)| cwd.starts_with(&path_b)),
        "다른 저장소에서 git 이 돌았다: {ran:?}"
    );
    assert!(ran.iter().any(|(_, args)| runs(args, "status")));

    // 변경이 없는 저장소만 물으면 변경 목록은 비어 있다
    assert!(
        core.folder_changes(fid, std::slice::from_ref(&path_a))
            .await
            .unwrap()
            .is_empty()
    );
    // 워크트리를 물으면 요약은 워크트리 것, 브랜치는 원 저장소 것이 온다
    let wt_summary = core
        .folder_summaries(fid, std::slice::from_ref(&path_wt))
        .await
        .unwrap();
    assert_eq!(wt_summary[0].path, path_wt);
    let wt_branches = core
        .folder_branches(fid, std::slice::from_ref(&path_wt))
        .await
        .unwrap();
    assert_eq!(wt_branches.repos.len(), 1);
    assert_eq!(wt_branches.repos[0].path, path_a);

    // 목록에 없는 경로: 폴더 밖, 폴더 자신, 저장소 안의 하위 폴더
    let outside = tempfile::tempdir().unwrap();
    for stranger in [
        outside.path().to_path_buf(),
        root.clone(),
        path_b.join(".git"),
    ] {
        let asked = [path_b.clone(), stranger.clone()];
        assert!(
            matches!(
                core.folder_summaries(fid, &asked).await,
                Err(CoreError::Invalid(_))
            ),
            "{}",
            stranger.display()
        );
        assert!(matches!(
            core.folder_changes(fid, &asked).await,
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            core.folder_branches(fid, &asked).await,
            Err(CoreError::Invalid(_))
        ));
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// 타임라인 로드가 끝날 때까지 기다린다 (처음이면 완료, 이후면 재로드)
async fn wait_timeline(rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>, fid: SessionId) {
    wait_for(rx, Duration::from_secs(10), |e| {
        matches!(
            e,
            CoreEvent::GraphLoadFinished { session, .. } | CoreEvent::GraphReloaded { session, .. }
                if *session == fid
        )
    })
    .await;
}

/// 저장소 경로 → 색을 요약·브랜치 목록·타임라인 정보·레인 색에서 각각 읽어 서로 같은지 확인하고 돌려준다
async fn agreed_colors(core: &Core, fid: SessionId) -> Vec<(String, u8)> {
    let summaries = core.folder_summaries(fid, &[]).await.unwrap();
    let branches = core.folder_branches(fid, &[]).await.unwrap();
    let info = core.folder_timeline_info(fid).unwrap();
    let window = core.folder_timeline_window(fid, 0, 1000).unwrap();
    // 타임라인 저장소(묶음의 대표)마다: 요약 색 = 브랜치 목록 색 = 타임라인 색 = 그 저장소 행의 레인 색
    for repo in &info.repos {
        let summary = summaries.iter().find(|s| s.path == repo.path).unwrap();
        assert_eq!(summary.color, repo.color, "요약과 타임라인: {}", repo.name);
        let listed = branches.repos.iter().find(|r| r.path == repo.path).unwrap();
        assert_eq!(
            listed.color, repo.color,
            "브랜치 목록과 타임라인: {}",
            repo.name
        );
        for b in &branches.branches {
            for r in b.repos.iter().filter(|r| r.path == repo.path) {
                assert_eq!(r.color, repo.color, "브랜치 {} 의 저장소 색", b.name);
            }
        }
        let rows: Vec<_> = window
            .rows
            .iter()
            .filter(|r| r.repo == Some(repo.index))
            .collect();
        assert!(!rows.is_empty(), "{} 의 행이 없다", repo.name);
        assert!(
            rows.iter().all(|r| r.color == repo.color),
            "레인 색: {}",
            repo.name
        );
    }
    assert_eq!(info.repos.len(), branches.repos.len());
    summaries.into_iter().map(|s| (s.name, s.color)).collect()
}

/// 저장소 색의 출처는 코어 하나다 (LF-09): 요약·브랜치·타임라인·레인이 같은 색을 쓰고, 워크트리는
/// 원 저장소와 같다. 재로드·재스캔으로는 바뀌지 않고 저장소 집합이 바뀔 때만 밀린다
#[tokio::test]
async fn repo_colors_agree_everywhere_and_shift_only_when_the_set_changes() {
    let (root, mut a, _b) = branch_fixture("colors");
    let core = core().await;
    let (sink, mut rx) = collector();
    let fid = core.open_folder(&root, sink).await.unwrap().session;
    core.folder_timeline_open(fid).unwrap();
    wait_timeline(&mut rx, fid).await;

    let first = agreed_colors(&core, fid).await;
    assert_eq!(
        first,
        vec![
            ("a".to_string(), 0),
            ("a-wt".to_string(), 0),
            ("b".to_string(), 1)
        ],
        "워크트리는 원 저장소와 같은 색"
    );

    // 재로드로는 바뀌지 않는다
    a.commit("a-more");
    core.folder_timeline_reload(fid).unwrap();
    wait_timeline(&mut rx, fid).await;
    assert_eq!(agreed_colors(&core, fid).await, first);

    // 저장소 집합이 같은 재스캔으로도 바뀌지 않는다
    core.folder_rescan(fid).await.unwrap();
    wait_timeline(&mut rx, fid).await;
    assert_eq!(agreed_colors(&core, fid).await, first);

    // 경로순으로 b 앞에 저장소가 끼면 b 의 순번이 밀리고, 세 곳이 함께 바뀐다
    let mut aa = init_at(&root.join("aa"));
    aa.commit("aa1");
    core.folder_rescan(fid).await.unwrap();
    wait_timeline(&mut rx, fid).await;
    assert_eq!(
        agreed_colors(&core, fid).await,
        vec![
            ("a".to_string(), 0),
            ("a-wt".to_string(), 0),
            ("aa".to_string(), 1),
            ("b".to_string(), 2),
        ]
    );
    let _ = std::fs::remove_dir_all(&root);
}
