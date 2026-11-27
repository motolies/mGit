//! 묶음 읽기 표시 (반응성 슬라이스 12): 폴더 전체를 훑는 배경 읽기(요약·브랜치·변경·타임라인 로드·작성자 후보)는 러너의
//! 묶음 읽기 범위(`mgit_git::bulk_reads`) 안에서 돌아 따로 둔 작은 한도를 쓰고, 사용자가 누른 읽기(폴더 커밋 상세)와 저장소
//! 탭의 읽기는 범위 밖이라 전체 한도를 쓴다. 러너를 감싸 명령마다 범위 안인지를 적어 확인한다
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{collector, core_on, wait_finished};
use mgit_core::{Core, CoreEvent, SessionId};
use mgit_git::{RunnerConfig, TokioGitRunner, in_bulk_reads};
use mgit_model::{
    BoxFuture, GitError, GitOutput, GitRequest, GitRunner, GitStream, GitVersion, OutputSink,
};
use mgit_testkit::TestRepo;

/// 명령마다 (묶음 읽기 범위 안인지, 하위 명령)을 적고 진짜 러너로 넘기는 러너
#[derive(Debug)]
struct Watching {
    inner: TokioGitRunner,
    seen: Mutex<Vec<(bool, String)>>,
}

impl Watching {
    /// 적어 둔 것을 꺼내고 비운다
    fn take(&self) -> Vec<(bool, String)> {
        std::mem::take(&mut *self.seen.lock().unwrap())
    }

    /// 요청 하나를 적는다 (`-c` 설정 뒤의 첫 인자가 하위 명령)
    fn note(&self, req: &GitRequest) {
        let sub = req
            .args
            .first()
            .map(|a| a.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.seen.lock().unwrap().push((in_bulk_reads(), sub));
    }
}

impl GitRunner for Watching {
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

/// 감시하는 러너와 그 러너를 쓰는 코어
async fn watched_core() -> (Core, Arc<Watching>) {
    let watching = Arc::new(Watching {
        inner: TokioGitRunner::new(RunnerConfig::default()).await.unwrap(),
        seen: Mutex::new(Vec::new()),
    });
    let core = core_on(Arc::clone(&watching) as Arc<dyn GitRunner>);
    (core, watching)
}

/// 커밋 둘이 있는 저장소 둘(a·b, b 는 작업 트리 변경 있음)이 든 폴더
fn fixture(tag: &str) -> (PathBuf, TestRepo) {
    let root = std::env::temp_dir().join(format!("mgit-bulk-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let mut a = init_at(&root.join("a"));
    a.commit("a1");
    a.commit("a2");
    let mut b = init_at(&root.join("b"));
    b.commit("b1");
    b.write_file("dirty.txt", "x");
    (root, a)
}

/// 경로에 빈 저장소를 만든다
fn init_at(path: &Path) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r
}

/// 적힌 명령이 있고 모두 범위 안(`bulk`)이거나 모두 밖인지 확인한다
fn assert_all(seen: &[(bool, String)], bulk: bool, what: &str) {
    assert!(!seen.is_empty(), "{what}: git 을 돌리지 않음");
    let wrong: Vec<&String> = seen
        .iter()
        .filter(|(b, _)| *b != bulk)
        .map(|(_, s)| s)
        .collect();
    assert!(
        wrong.is_empty(),
        "{what}: 묶음 읽기 표시가 {}여야 하는 명령 {wrong:?}",
        if bulk { "있어" } else { "없어" }
    );
}

/// 폴더를 연다 (여는 동안의 명령은 버린다)
async fn open(
    core: &Core,
    watching: &Watching,
    root: &Path,
) -> (SessionId, tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) {
    let (sink, rx) = collector();
    let id = core.open_folder(root, sink).await.unwrap().session;
    watching.take();
    (id, rx)
}

#[tokio::test]
async fn folder_sweeps_run_as_bulk_reads() {
    let (root, _a) = fixture("sweeps");
    let (core, watching) = watched_core().await;
    let (id, mut rx) = open(&core, &watching, &root).await;

    core.folder_summaries(id, &[]).await.unwrap();
    assert_all(&watching.take(), true, "요약 전부");
    core.folder_summaries(id, &[root.join("a")]).await.unwrap();
    assert_all(&watching.take(), true, "요약 부분");
    core.folder_branches(id, &[]).await.unwrap();
    assert_all(&watching.take(), true, "브랜치 목록");
    let changes = core.folder_changes(id, &[]).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_all(&watching.take(), true, "변경 목록");
    // 타임라인을 열기 전이라 작성자 후보는 git 으로 읽는다
    core.folder_timeline_authors(id).await.unwrap();
    assert_all(&watching.take(), true, "작성자 후보");
    core.folder_timeline_open(id).unwrap();
    wait_finished(&mut rx, id).await;
    assert_all(&watching.take(), true, "타임라인 로드");
    // 하루 한 번 백업 정리 (폴더를 연 뒤 화면이 부른다)
    core.folder_prune_backups_daily(id).await.unwrap();
    assert_all(&watching.take(), true, "백업 정리");
}

#[tokio::test]
async fn interactive_reads_are_not_bulk() {
    let (root, mut a) = fixture("interactive");
    let (core, watching) = watched_core().await;
    let (id, mut rx) = open(&core, &watching, &root).await;
    core.folder_timeline_open(id).unwrap();
    wait_finished(&mut rx, id).await;
    watching.take();

    // 폴더에서 커밋을 누른 상세
    let head = a.head();
    core.folder_commit_detail(id, &root.join("a"), &head)
        .await
        .unwrap();
    assert_all(&watching.take(), false, "폴더 커밋 상세");

    // 저장소 탭: 열기·새로고침·커밋 상세
    let (sink, mut rx) = collector();
    let repo = core.open_repo(a.path(), sink).await.unwrap().session;
    wait_finished(&mut rx, repo).await;
    core.refresh(repo).await.unwrap();
    core.commit_detail(repo, &head).await.unwrap();
    assert_all(&watching.take(), false, "저장소 탭");
    tokio::time::sleep(Duration::from_millis(50)).await;
}
