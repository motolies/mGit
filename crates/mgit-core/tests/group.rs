//! 가상 그룹 (MR-13 M1): 서로 다른 위치의 저장소를 묶은 그룹을 폴더 세션처럼 연다. 로스터를 쓰는 폴더 기능이 폴더 세션과
//! 같게 돌고, 파일 경로는 `별칭/…` 가상 공간이며 맨 위·멤버 루트·모르는 별칭은 거부하고, 사라진 멤버는 정의에 남되
//! 로스터에서 빠지며, 중복·중첩·저장소 아님을 거부하고, 폴더 설정 키가 그룹 키로 나뉜다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::{collector, core, wait_for};
use mgit_core::{
    BatchOp, Core, CoreError, CoreEvent, FolderSettings, FsEntryKind, FsFile, FsListing,
    FsLocation, FsOperationKind, FsOperationRequest, FsOperations, FsSource, FsTrash, GroupId,
    GroupMember, GroupUpdate, IndexTarget, MemberState, PathIssue, RepoKind, SessionId,
};
use mgit_testkit::TestRepo;
use tokio::sync::mpsc::UnboundedReceiver;

/// 경로에 커밋 하나(`a.txt`)짜리 저장소를 만든다
fn repo_at(path: &Path, first: &str) -> TestRepo {
    std::fs::create_dir_all(path).unwrap();
    let mut r = TestRepo::at(path);
    r.git_ok(["init", "-q", "-b", "main"]);
    r.write_file("a.txt", &format!("{first}\n"));
    r.stage(&["a.txt"]);
    r.commit_staged(first);
    r
}

/// 서로 다른 임시 폴더 두 곳의 저장소: `<A>/api`(bare 원격 + 업스트림), `<B>/team/web`(원격 없음)
struct Scattered {
    _a: tempfile::TempDir,
    _b: tempfile::TempDir,
    /// 정규화한 임시 폴더 A·B
    dir_a: PathBuf,
    dir_b: PathBuf,
    api: TestRepo,
    web: TestRepo,
}

impl Scattered {
    /// 저장소 두 개를 만든다
    fn new() -> Self {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let dir_a = a.path().canonicalize().unwrap();
        let dir_b = b.path().canonicalize().unwrap();
        let mut api = repo_at(&dir_a.join("api"), "api first");
        api.add_bare_remote();
        api.git_ok(["push", "-q", "-u", "origin", "main"]);
        let web = repo_at(&dir_b.join("team/web"), "web first");
        Scattered {
            _a: a,
            _b: b,
            dir_a,
            dir_b,
            api,
            web,
        }
    }

    /// api 저장소 경로 (정규화)
    fn api_path(&self) -> PathBuf {
        self.dir_a.join("api")
    }

    /// web 저장소 경로 (정규화)
    fn web_path(&self) -> PathBuf {
        self.dir_b.join("team/web")
    }
}

/// 그룹을 만들고 연다 (이벤트 수신기 포함)
async fn open_group(
    core: &Core,
    name: &str,
    paths: &[PathBuf],
) -> (GroupId, SessionId, UnboundedReceiver<CoreEvent>) {
    let summary = core.group_create(name, paths).unwrap();
    let id = summary.group.id.clone();
    let (sink, rx) = collector();
    let opened = core.open_group(&id, sink).await.unwrap();
    (id, opened.session, rx)
}

/// 거부(`Invalid`)인지
fn is_invalid<T: std::fmt::Debug>(r: &Result<T, CoreError>) -> bool {
    matches!(r, Err(CoreError::Invalid(_)))
}

/// 받은 이벤트를 다 꺼낸다
fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// 테스트 휴지통 (호출되면 안 된다 — 멤버 루트 휴지통은 준비에서 거부된다)
struct NoTrash;

impl FsTrash for NoTrash {
    /// 부르면 실패한다
    fn trash(&self, _path: &Path) -> Result<(), String> {
        Err("호출되면 안 된다".into())
    }
}

/// 인수 ①·⑤: 흩어진 두 저장소로 연 그룹의 요약·일괄 fetch·branch·push·통합 stage·commit·일괄 stash·타임라인·브랜치
/// 목록·콘솔 로그가 각 저장소를 폴더로 연 세션과 같다. 같은 그룹은 다시 열어도 같은 세션이고, 폴더 설정은
/// `folder:mgit-group:<id>` 로 폴더 세션 설정과 나뉜다
#[tokio::test]
async fn group_runs_folder_features_over_scattered_repos() {
    let core = core().await;
    let mut fx = Scattered::new();
    let (api, web) = (fx.api_path(), fx.web_path());
    let (id, gid, mut rx) = open_group(&core, "작업", &[api.clone(), web.clone()]).await;

    // 열기 응답: 경로는 세션 키, 멤버 순서의 저장소, 그룹 모습
    let (sink, _rx2) = collector();
    let again = core.open_group(&id, sink).await.unwrap();
    assert_eq!(again.session, gid);
    assert_eq!(
        again.path,
        PathBuf::from(format!("mgit-group:{}", id.as_str()))
    );
    let repos: Vec<&Path> = again.repos.iter().map(|r| r.path.as_path()).collect();
    assert_eq!(repos, vec![api.as_path(), web.as_path()]);
    let view = again.group.unwrap();
    assert_eq!(view.name, "작업");
    let aliases: Vec<&str> = view.members.iter().map(|m| m.alias.as_str()).collect();
    assert_eq!(aliases, vec!["api", "web"]);
    assert!(
        view.members
            .iter()
            .all(|m| m.state == MemberState::Present(RepoKind::Standalone))
    );
    assert!(core.groups_list().unwrap()[0].last_opened_at > 0);

    // 요약: 저장소마다 폴더 세션의 요약과 같다 (색은 세션의 순번이라 뺀다)
    let (sink_a, _ra) = collector();
    let folder_a = core.open_folder(&fx.dir_a, sink_a).await.unwrap().session;
    let (sink_b, _rb) = collector();
    let folder_b = core.open_folder(&fx.dir_b, sink_b).await.unwrap().session;
    let strip = |mut s: mgit_core::RepoSummary| {
        s.color = 0;
        s
    };
    let grouped = core.folder_summaries(gid, &[]).await.unwrap();
    assert_eq!(grouped.len(), 2);
    let mut alone = core.folder_summaries(folder_a, &[]).await.unwrap();
    alone.extend(core.folder_summaries(folder_b, &[]).await.unwrap());
    alone.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(
        grouped.into_iter().map(strip).collect::<Vec<_>>(),
        alone.into_iter().map(strip).collect::<Vec<_>>()
    );

    // 일괄 fetch (진행 이벤트 포함) → branch 만들기·checkout
    let r = core
        .folder_batch(gid, BatchOp::Fetch { prune: true }, &[])
        .await
        .unwrap();
    assert_eq!((r.results.len(), r.succeeded), (2, 2), "{r:?}");
    let r = core
        .folder_batch(
            gid,
            BatchOp::CreateBranch {
                name: "feature-x".into(),
                checkout: true,
                start_point: None,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    assert_eq!(
        fx.api.git_ok(["branch", "--show-current"]).trim(),
        "feature-x"
    );
    assert_eq!(
        fx.web.git_ok(["branch", "--show-current"]).trim(),
        "feature-x"
    );
    fx.api.git_ok(["checkout", "-q", "main"]);

    // 통합 stage → commit: web 만 stage 했으니 web 만 커밋되고 api 는 건너뛴다
    fx.web.write_file("b.txt", "web change\n");
    let staged = core
        .folder_stage(gid, &web, &IndexTarget::All)
        .await
        .unwrap();
    assert!(staged.ran);
    let r = core
        .folder_commit(gid, &[], "group commit", false)
        .await
        .unwrap();
    assert_eq!((r.succeeded, r.skipped), (1, 1), "{r:?}");
    assert_eq!(
        fx.web.git_ok(["log", "-1", "--format=%s"]).trim(),
        "group commit"
    );

    // push: api 에 새 커밋 → 업스트림으로 보낸다, web 은 업스트림이 없어 건너뛴다
    fx.api.write_file("c.txt", "api change\n");
    fx.api.stage(&["c.txt"]);
    fx.api.commit_staged("api second");
    let r = core
        .folder_batch(gid, BatchOp::Push { new_upstream: None }, &[])
        .await
        .unwrap();
    let api_row = r.results.iter().find(|x| x.path == api).unwrap();
    assert!(api_row.ok && api_row.skipped.is_none(), "{r:?}");
    assert_eq!(r.skipped, 1, "{r:?}");

    // 일괄 stash 저장 → 묶음 목록에 두 저장소
    fx.api.write_file("a.txt", "api dirty\n");
    fx.web.write_file("a.txt", "web dirty\n");
    let r = core
        .folder_batch(
            gid,
            BatchOp::StashPush {
                batch: "b1".into(),
                message: Some("그룹 stash".into()),
                include_untracked: false,
            },
            &[],
        )
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    let batches = core.folder_stash_batches(gid, &[]).await.unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].repos.len(), 2);

    // 브랜치 목록: 두 저장소의 main, feature-x 는 둘 다에
    let branches = core.folder_branches(gid, &[]).await.unwrap();
    assert_eq!(branches.repos.len(), 2);
    let feature = branches
        .branches
        .iter()
        .find(|b| b.name == "feature-x" && !b.remote)
        .unwrap();
    assert_eq!(feature.repos.len(), 2);

    // 타임라인: 두 저장소의 커밋이 저장소 번호 0·1 로 섞인다
    let mut seen = drain(&mut rx);
    core.folder_timeline_open(gid).unwrap();
    seen.extend(
        wait_for(
            &mut rx,
            Duration::from_secs(10),
            |e| matches!(e, CoreEvent::GraphLoadFinished { session, .. } if *session == gid),
        )
        .await,
    );
    let window = core.folder_timeline_window(gid, 0, 100).unwrap();
    let mut indices: Vec<u16> = window.rows.iter().filter_map(|r| r.repo).collect();
    indices.sort_unstable();
    indices.dedup();
    assert_eq!(indices, vec![0, 1]);
    assert!(window.rows.iter().any(|r| r.subject == "group commit"));
    assert!(window.rows.iter().any(|r| r.subject == "api second"));

    // 콘솔: 앞의 쓰기·네트워크 명령(stage·commit·push·stash·fetch)이 멤버 경로로 그룹 세션에 왔다
    core.folder_batch(gid, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    seen.extend(drain(&mut rx));
    let logged: Vec<PathBuf> = seen
        .into_iter()
        .filter_map(|e| match e {
            CoreEvent::FolderCommandLogged { session, repo, .. } if session == gid => Some(repo),
            _ => None,
        })
        .collect();
    assert!(logged.contains(&api) && logged.contains(&web), "{logged:?}");

    // 폴더 설정 키 분리 (⑤): 그룹 설정은 `folder:mgit-group:<id>`, 폴더 A 설정은 그대로
    let settings = FolderSettings {
        concurrency: 2,
        exclude: vec!["web".into()],
        ..FolderSettings::default()
    };
    core.set_folder_settings(gid, &settings).unwrap();
    let key = format!("folder:mgit-group:{}", id.as_str());
    let saved = core.store().setting_get(&key).unwrap().unwrap();
    assert!(saved.contains("\"concurrency\":2"), "{saved}");
    assert_eq!(core.folder_settings(gid).unwrap().concurrency, 2);
    assert_eq!(core.folder_settings(folder_a).unwrap().concurrency, 4);
    assert!(
        core.store()
            .setting_get(&format!("folder:{}", fx.dir_a.display()))
            .unwrap()
            .is_none()
    );
}

/// 인수 ②: 파일 경로는 `별칭/…` 가상 공간이다. 맨 위는 별칭만 나열하고 읽기·쓰기·대상은 거부, `alias/..`·모르는 별칭·
/// 대소문자가 다른 별칭·절대 경로·`.git` 은 거부, 멤버 루트의 이름 바꾸기·휴지통은 거부, 멤버 안은 폴더처럼 쓴다
#[tokio::test]
async fn group_paths_are_virtual_and_guarded() {
    let core = core().await;
    let fx = Scattered::new();
    std::fs::write(fx.dir_a.join("secret.txt"), "SECRET-OUTSIDE").unwrap();
    let (_id, gid, _rx) = open_group(&core, "작업", &[fx.api_path(), fx.web_path()]).await;

    // 맨 위: 별칭만, 디렉터리, 열 수 없음
    let FsListing::Listed { entries, total, .. } = core.fs_list_dir(gid, "", None).await.unwrap()
    else {
        panic!("맨 위가 나열돼야 한다");
    };
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!((names, total), (vec!["api", "web"], 2));
    assert!(
        entries
            .iter()
            .all(|e| e.kind == FsEntryKind::Dir && !e.openable)
    );
    let FsListing::Listed { entries, .. } = core.fs_list_dir(gid, "api", None).await.unwrap()
    else {
        panic!("멤버 루트가 나열돼야 한다");
    };
    assert!(entries.iter().any(|e| e.name == "a.txt"));
    assert!(!entries.iter().any(|e| e.name == ".git"));
    let FsFile::Text { text, .. } = core.fs_read_file(gid, "web/a.txt").await.unwrap() else {
        panic!("멤버 파일을 읽어야 한다");
    };
    assert_eq!(text, "web first\n");
    assert_eq!(
        core.fs_read_file(gid, "api/missing.txt").await.unwrap(),
        FsFile::Missing
    );

    // 거부: 맨 위 읽기, 탈출, 모르는 별칭, 대소문자, 절대 경로, `.git`
    let api_abs = fx.api_path().join("a.txt");
    for request in [
        "",
        "api/..",
        "api/../web/a.txt",
        "api/../../secret.txt",
        "..",
        "../secret.txt",
        "./api/a.txt",
        "/api/a.txt",
        api_abs.to_str().unwrap(),
        "nope/a.txt",
        "API/a.txt",
        "api//a.txt",
        "api/",
        ".git",
        "api/.git/config",
        "api/a\0.txt",
    ] {
        assert!(
            is_invalid(&core.fs_read_file(gid, request).await),
            "읽기 {request:?}"
        );
        assert!(
            is_invalid(&core.fs_read_editable_file(gid, request).await),
            "편집 읽기 {request:?}"
        );
        assert!(
            is_invalid(&core.fs_read_image(gid, request).await),
            "그림 {request:?}"
        );
        assert!(
            is_invalid(&core.fs_save_file(gid, request, "rev", "x").await),
            "저장 {request:?}"
        );
        if !request.is_empty() {
            assert!(
                is_invalid(&core.fs_list_dir(gid, request, None).await),
                "나열 {request:?}"
            );
        }
    }
    let stamps = core
        .fs_file_stamps(
            gid,
            &[
                "".into(),
                "api/a.txt".into(),
                "api/..".into(),
                "nope/x".into(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        stamps.iter().map(Option::is_some).collect::<Vec<_>>(),
        [false, true, false, false]
    );

    // 파일 작업: 맨 위 쓰기·멤버 루트 이름 바꾸기·휴지통·모르는 별칭 거부, 멤버 안은 허용
    let temp = tempfile::tempdir().unwrap();
    let ops = FsOperations::new(temp.path().join("journal"), Arc::new(NoTrash));
    let at = |path: &str| FsLocation {
        session: gid.0,
        path: path.into(),
    };
    let from = |path: &str| FsSource::Session {
        session: gid.0,
        path: path.into(),
    };
    let request =
        |kind, sources: Vec<FsSource>, destination: Option<FsLocation>| FsOperationRequest {
            kind,
            sources,
            destination,
        };
    let refused = [
        request(FsOperationKind::CreateFile, vec![], Some(at(""))),
        request(
            FsOperationKind::CreateDirectory,
            vec![],
            Some(at("new-dir")),
        ),
        request(FsOperationKind::CreateFile, vec![], Some(at("api"))),
        request(FsOperationKind::Copy, vec![from("api/a.txt")], Some(at(""))),
        request(FsOperationKind::Rename, vec![from("api")], Some(at("api2"))),
        request(
            FsOperationKind::Rename,
            vec![from("api")],
            Some(at("web/api")),
        ),
        request(FsOperationKind::Trash, vec![from("api")], None),
        request(FsOperationKind::Trash, vec![from("")], None),
        request(
            FsOperationKind::Move,
            vec![from("api/a.txt")],
            Some(at("nope")),
        ),
        request(
            FsOperationKind::Copy,
            vec![from("api/../web")],
            Some(at("web")),
        ),
    ];
    for r in refused {
        let label = format!("{:?} {:?}", r.kind, r.destination.as_ref().map(|d| &d.path));
        assert!(is_invalid(&ops.prepare(&core, r).await), "{label}");
    }
    let allowed = [
        request(FsOperationKind::CreateFile, vec![], Some(at("api/new.txt"))),
        request(
            FsOperationKind::Rename,
            vec![from("api/a.txt")],
            Some(at("api/b.txt")),
        ),
        request(
            FsOperationKind::Copy,
            vec![from("api/a.txt")],
            Some(at("web")),
        ),
    ];
    for r in allowed {
        let label = format!("{:?}", r.kind);
        assert!(ops.prepare(&core, r).await.is_ok(), "{label}");
    }
}

/// 내용 검색 질의 (범위·경로 거르기·초안을 줄 수 있다)
fn content_query(text: &str, scope: &str, path_filter: &str) -> mgit_core::WorkspaceSearchQuery {
    mgit_core::WorkspaceSearchQuery {
        text: text.into(),
        content: true,
        regex: false,
        case_sensitive: false,
        path_filter: path_filter.into(),
        scope: scope.into(),
        drafts: Vec::new(),
    }
}

/// 내용 검색의 (경로, 저장소) 목록 (정렬)
async fn search_paths(
    core: &Core,
    gid: SessionId,
    query: mgit_core::WorkspaceSearchQuery,
) -> Vec<(String, Option<String>)> {
    let found = core
        .workspace_search(gid, query, mgit_model::CancelToken::default())
        .await
        .unwrap();
    let mut out: Vec<_> = found.hits.into_iter().map(|h| (h.path, h.repo)).collect();
    out.sort();
    out.dedup();
    out
}

/// M3: 그룹의 내용 검색·⌘P 목록은 있는 멤버마다 훑어 결과 경로·저장소가 `별칭/…` 이고, 그 경로로 연 파일이 맞다.
/// 범위가 별칭이면 그 멤버만, 경로 거르기·이름 검색은 별칭 경로로 보고, 초안은 별칭 경로로 덮는다. 사라진 멤버·저장소가
/// 아니게 된 멤버는 건너뛴다
#[tokio::test]
async fn group_search_and_file_list_use_alias_paths() {
    let core = core().await;
    let mut fx = Scattered::new();
    let (api, web) = (fx.api_path(), fx.web_path());
    fx.api
        .write_file("src/main.rs", "fn main() { needle(); }\n");
    fx.web.write_file("docs/guide.md", "a needle here\n");
    let _lib = repo_at(&api.join("vendor/lib"), "lib first");
    std::fs::write(api.join("vendor/lib/lib.rs"), "// needle in nested repo\n").unwrap();
    let c = tempfile::tempdir().unwrap();
    let gone = c.path().canonicalize().unwrap().join("gone");
    let plain = c.path().canonicalize().unwrap().join("plain");
    let _gone = repo_at(&gone, "gone first");
    let _plain = repo_at(&plain, "plain first");
    std::fs::write(gone.join("x.txt"), "needle\n").unwrap();
    std::fs::write(plain.join("y.txt"), "needle\n").unwrap();
    let (_id, gid, _rx) = open_group(
        &core,
        "작업",
        &[api.clone(), web.clone(), gone.clone(), plain.clone()],
    )
    .await;
    // 사라진 멤버와 저장소가 아니게 된 멤버를 만든 뒤 재스캔한다
    std::fs::remove_dir_all(&gone).unwrap();
    std::fs::remove_dir_all(plain.join(".git")).unwrap();
    core.folder_rescan(gid).await.unwrap();

    let s = |p: &str, r: &str| (p.to_owned(), Some(r.to_owned()));
    assert_eq!(
        search_paths(&core, gid, content_query("needle", "", "")).await,
        vec![
            s("api/src/main.rs", "api"),
            s("api/vendor/lib/lib.rs", "api/vendor/lib"),
            s("web/docs/guide.md", "web"),
        ]
    );
    // 결과 경로로 연 파일이 맞다
    let FsFile::Text { text, .. } = core.fs_read_file(gid, "web/docs/guide.md").await.unwrap()
    else {
        panic!("결과 파일을 읽어야 한다");
    };
    assert!(text.contains("needle"));
    // 범위: 별칭이면 그 멤버만, `별칭/폴더` 면 그 아래만, 모르는·사라진 별칭이면 없음
    assert_eq!(
        search_paths(&core, gid, content_query("needle", "web", "")).await,
        vec![s("web/docs/guide.md", "web")]
    );
    assert_eq!(
        search_paths(&core, gid, content_query("needle", "api/vendor", "")).await,
        vec![s("api/vendor/lib/lib.rs", "api/vendor/lib")]
    );
    for scope in ["nope", "gone", "plain", "API"] {
        assert!(
            search_paths(&core, gid, content_query("needle", scope, ""))
                .await
                .is_empty(),
            "{scope}"
        );
    }
    assert!(is_invalid(
        &core
            .workspace_search(
                gid,
                content_query("needle", "web/..", ""),
                mgit_model::CancelToken::default()
            )
            .await
    ));
    // 경로 거르기·이름 검색은 별칭 경로로 본다
    assert_eq!(
        search_paths(&core, gid, content_query("needle", "", "web/")).await,
        vec![s("web/docs/guide.md", "web")]
    );
    let mut by_name = content_query("api/src", "", "");
    by_name.content = false;
    assert_eq!(
        search_paths(&core, gid, by_name).await,
        vec![s("api/src/main.rs", "api")]
    );
    // 초안은 별칭 경로로 덮는다
    let mut drafted = content_query("draftonly", "", "");
    drafted.drafts = vec![mgit_core::SearchDraft {
        path: "web/docs/guide.md".into(),
        text: "draftonly\n".into(),
    }];
    assert_eq!(
        search_paths(&core, gid, drafted).await,
        vec![s("web/docs/guide.md", "web")]
    );

    // ⌘P 목록: 있는 멤버의 파일·저장소가 별칭 경로로 정렬돼 온다
    let listed = core
        .workspace_files(gid, mgit_model::CancelToken::default())
        .await
        .unwrap();
    for file in [
        "api/a.txt",
        "api/src/main.rs",
        "web/a.txt",
        "web/docs/guide.md",
    ] {
        assert!(
            listed.files.contains(&file.to_owned()),
            "{file}: {:?}",
            listed.files
        );
    }
    assert!(
        listed
            .files
            .iter()
            .all(|f| f.starts_with("api/") || f.starts_with("web/")),
        "{:?}",
        listed.files
    );
    let mut sorted = listed.files.clone();
    sorted.sort();
    assert_eq!(listed.files, sorted);
    assert_eq!(listed.repos, ["api", "api/vendor/lib", "web"]);
    assert!(!listed.truncated && !listed.cancelled);
    // 목록의 파일을 그 경로로 연다
    assert!(matches!(
        core.fs_read_file(gid, "api/src/main.rs").await.unwrap(),
        FsFile::Text { .. }
    ));
}

/// M3: 결과 줄 상한(2,000)은 멤버들이 나눠 쓴다 — 두 멤버에 1,500줄씩 맞아도 합쳐 2,000줄에서 자르고 잘렸다고 알린다
#[tokio::test]
async fn group_search_shares_the_hit_limit_across_members() {
    let core = core().await;
    let mut fx = Scattered::new();
    let lines = "needle\n".repeat(1500);
    fx.api.write_file("many.txt", &lines);
    fx.web.write_file("many.txt", &lines);
    let (_id, gid, _rx) = open_group(&core, "작업", &[fx.api_path(), fx.web_path()]).await;
    let found = core
        .workspace_search(
            gid,
            content_query("needle", "", ""),
            mgit_model::CancelToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 2000);
    assert!(found.truncated);
    assert!(found.hits[..1500].iter().all(|h| h.path == "api/many.txt"));
    assert!(found.hits[1500..].iter().all(|h| h.path == "web/many.txt"));
}

/// 선택 저장소 git 명령 실행(N)과 저장소별 커밋 메시지(Q)도 그룹 세션에서 멤버(로스터)마다 돈다: 명령은 멤버 작업
/// 트리에서 실행하고 대상을 좁힐 수 있으며, 커밋은 저장소별 메시지가 있는 멤버만 그 메시지로, 나머지는 공통 메시지로 한다
#[tokio::test]
async fn group_runs_commands_and_per_repo_commit_messages() {
    let core = core().await;
    let mut fx = Scattered::new();
    let (api, web) = (fx.api_path(), fx.web_path());
    let (_id, gid, _rx) = open_group(&core, "작업", &[api.clone(), web.clone()]).await;
    let toplevel = || BatchOp::RunCommand {
        args: vec!["rev-parse".into(), "--show-toplevel".into()],
    };

    let r = core.folder_batch(gid, toplevel(), &[]).await.unwrap();
    assert_eq!((r.succeeded, r.failed), (2, 0), "{r:?}");
    let mut tops: Vec<PathBuf> = r
        .results
        .iter()
        .map(|x| {
            let out = x.command.as_ref().unwrap();
            assert_eq!(out.status, Some(0));
            PathBuf::from(out.stdout.trim()).canonicalize().unwrap()
        })
        .collect();
    tops.sort();
    let mut members = vec![api.clone(), web.clone()];
    members.sort();
    assert_eq!(tops, members);
    let only_web = core
        .folder_batch(gid, toplevel(), std::slice::from_ref(&web))
        .await
        .unwrap();
    assert_eq!(only_web.succeeded, 1, "{only_web:?}");

    fx.api.write_file("q.txt", "q\n");
    fx.api.stage(&["q.txt"]);
    fx.web.write_file("q.txt", "q\n");
    fx.web.stage(&["q.txt"]);
    let r = core
        .folder_commit_each(
            gid,
            &[],
            "공통 제목",
            &[mgit_core::RepoCommitMessage {
                path: api.clone(),
                message: "api 전용".into(),
            }],
            false,
        )
        .await
        .unwrap();
    assert_eq!(r.succeeded, 2, "{r:?}");
    assert_eq!(
        fx.api.git_ok(["log", "-1", "--format=%s"]).trim(),
        "api 전용"
    );
    assert_eq!(
        fx.web.git_ok(["log", "-1", "--format=%s"]).trim(),
        "공통 제목"
    );
}

/// 여러 파일 바꾸기 미리보기 질의 (글자 그대로, 대소문자 구분)
fn replace_query(text: &str, replacement: &str, scope: &str) -> mgit_core::ReplaceQuery {
    mgit_core::ReplaceQuery {
        pattern: replace_pattern(text, replacement),
        path_filter: String::new(),
        scope: scope.into(),
        drafts: Vec::new(),
    }
}

/// 찾기·바꾸기 (글자 그대로, 대소문자 구분)
fn replace_pattern(text: &str, replacement: &str) -> mgit_core::ReplacePattern {
    mgit_core::ReplacePattern {
        text: text.into(),
        regex: false,
        case_sensitive: true,
        replacement: replacement.into(),
    }
}

/// 그룹의 여러 파일 바꾸기는 내용 검색처럼 멤버마다 훑어 미리보기 경로·저장소가 `별칭/…` 이고(범위가 별칭이면 그 멤버만),
/// 적용·되돌리기가 그 경로를 멤버 루트로 나눠 두 멤버의 파일을 바꾸고 원문 바이트로 되살린다. 원문은 각 멤버 저장소의
/// 폐기 백업으로 남고, 맨 위·모르는 별칭 경로는 그 파일만 실패한다
#[tokio::test]
async fn group_replace_previews_applies_and_undoes_across_members() {
    use mgit_core::{ReplaceChoice, ReplaceOutcome, ReplacePlan, ReplaceUndo, ReplaceUndoOutcome};
    let core = core().await;
    let mut fx = Scattered::new();
    let main_rs = "fn main() { needle(); }\n";
    let guide = "a needle here\r\nneedle again\r\n";
    fx.api.write_file("src/main.rs", main_rs);
    fx.web.write_file("docs/guide.md", guide);
    let (api, web) = (fx.api_path(), fx.web_path());
    let (_id, gid, _rx) = open_group(&core, "작업", &[api.clone(), web.clone()]).await;
    let cancel = mgit_model::CancelToken::default;

    let preview = core
        .workspace_replace_preview(gid, replace_query("needle", "pin", ""), cancel())
        .await
        .unwrap();
    let mut files: Vec<_> = preview
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.repo.as_deref(), f.matches))
        .collect();
    files.sort_unstable();
    assert_eq!(
        files,
        [
            ("api/src/main.rs", Some("api"), 1),
            ("web/docs/guide.md", Some("web"), 2),
        ]
    );
    assert!(preview.excluded.is_empty() && !preview.truncated);
    // 범위가 별칭이면 그 멤버만 훑는다
    let scoped = core
        .workspace_replace_preview(gid, replace_query("needle", "pin", "web"), cancel())
        .await
        .unwrap();
    let paths: Vec<_> = scoped.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["web/docs/guide.md"]);

    let mut choices: Vec<_> = preview
        .files
        .iter()
        .map(|f| ReplaceChoice {
            path: f.path.clone(),
            revision: f.revision.clone(),
            excluded: Vec::new(),
        })
        .collect();
    // 맨 위·모르는 별칭은 그 파일만 실패한다
    for bad in ["", "nope/a.txt"] {
        choices.push(ReplaceChoice {
            path: bad.into(),
            revision: "r".into(),
            excluded: Vec::new(),
        });
    }
    let outcomes = core
        .workspace_replace_apply(
            gid,
            ReplacePlan {
                pattern: replace_pattern("needle", "pin"),
                files: choices,
            },
        )
        .await
        .unwrap();
    assert_eq!(outcomes.len(), 4);
    assert!(
        outcomes[..2]
            .iter()
            .all(|o| matches!(o, ReplaceOutcome::Applied { .. })),
        "{outcomes:?}"
    );
    assert!(
        outcomes[2..]
            .iter()
            .all(|o| matches!(o, ReplaceOutcome::Failed { .. })),
        "{outcomes:?}"
    );
    assert_eq!(
        std::fs::read_to_string(api.join("src/main.rs")).unwrap(),
        "fn main() { pin(); }\n"
    );
    assert_eq!(
        std::fs::read_to_string(web.join("docs/guide.md")).unwrap(),
        "a pin here\r\npin again\r\n"
    );
    // 원문은 각 멤버 저장소의 폐기 백업(`replace`)이다
    for (member, rel) in [(&api, "src/main.rs"), (&web, "docs/guide.md")] {
        let (sink, mut rx) = collector();
        let repo = core.open_repo(member, sink).await.unwrap().session;
        common::wait_finished(&mut rx, repo).await;
        let backups: Vec<_> = core
            .backups(repo, 10)
            .unwrap()
            .into_iter()
            .map(|b| (b.rel_path, b.reason))
            .collect();
        assert_eq!(backups, [(rel.to_owned(), "replace".to_owned())]);
    }

    let undo: Vec<_> = outcomes
        .iter()
        .filter_map(|o| match o {
            ReplaceOutcome::Applied {
                path,
                backup,
                revision,
                ..
            } => Some(ReplaceUndo {
                path: path.clone(),
                backup: *backup,
                revision: revision.clone(),
            }),
            _ => None,
        })
        .collect();
    let undone = core.workspace_replace_undo(gid, undo).await.unwrap();
    let mut restored: Vec<_> = undone
        .iter()
        .map(|o| match o {
            ReplaceUndoOutcome::Restored { path } => path.as_str(),
            other => panic!("되살려야 한다: {other:?}"),
        })
        .collect();
    restored.sort_unstable();
    assert_eq!(restored, ["api/src/main.rs", "web/docs/guide.md"]);
    assert_eq!(
        std::fs::read_to_string(api.join("src/main.rs")).unwrap(),
        main_rs
    );
    assert_eq!(
        std::fs::read(web.join("docs/guide.md")).unwrap(),
        guide.as_bytes()
    );
}

/// M3 회귀: 폴더 세션의 검색·목록 결과는 그룹을 들이기 전처럼 폴더 기준 경로다 (접두 없음, 폴더 자신의 저장소 `""` 없음)
#[tokio::test]
async fn folder_search_results_keep_root_relative_paths() {
    let core = core().await;
    let mut fx = Scattered::new();
    fx.api.write_file("src/main.rs", "needle\n");
    let (sink, _rx) = collector();
    let fid = core.open_folder(&fx.dir_a, sink).await.unwrap().session;
    assert_eq!(
        search_paths(&core, fid, content_query("needle", "", "")).await,
        vec![("api/src/main.rs".to_owned(), Some("api".to_owned()))]
    );
    assert_eq!(
        search_paths(&core, fid, content_query("needle", "api", "")).await,
        vec![("api/src/main.rs".to_owned(), Some("api".to_owned()))]
    );
    let listed = core
        .workspace_files(fid, mgit_model::CancelToken::default())
        .await
        .unwrap();
    assert!(listed.files.contains(&"api/src/main.rs".to_owned()));
    assert_eq!(listed.repos, ["api"]);
}

/// 인수 ③: 멤버를 지운 뒤 재스캔하면 정의는 남고 상태가 `Missing` 이 되며 로스터에서 빠진다. 재스캔은 `FolderRescanned`
/// 뒤에 `GroupChanged` 를 보내고, 그 경로를 대상으로 한 일괄 작업·요약은 거부되며, 그 별칭 아래는 "없음"이다
#[tokio::test]
async fn removed_member_stays_defined_but_leaves_the_roster() {
    let core = core().await;
    let fx = Scattered::new();
    let (api, web) = (fx.api_path(), fx.web_path());
    let (id, gid, mut rx) = open_group(&core, "작업", &[api.clone(), web.clone()]).await;
    drain(&mut rx);

    std::fs::remove_dir_all(&web).unwrap();
    let repos = core.folder_rescan(gid).await.unwrap();
    assert_eq!(
        repos.iter().map(|r| r.path.clone()).collect::<Vec<_>>(),
        vec![api.clone()]
    );
    let events = drain(&mut rx);
    let at = |pred: fn(&CoreEvent) -> bool| events.iter().position(pred);
    let rescanned = at(|e| matches!(e, CoreEvent::FolderRescanned { .. })).unwrap();
    let changed = at(|e| matches!(e, CoreEvent::GroupChanged { .. })).unwrap();
    assert!(rescanned < changed, "{events:?}");
    let CoreEvent::GroupChanged { group, .. } = &events[changed] else {
        unreachable!()
    };
    assert_eq!(group.members[1].alias, "web");
    assert_eq!(group.members[1].state, MemberState::Missing);

    // 로스터에서 빠진 경로는 거부, 나머지는 그대로
    assert!(is_invalid(
        &core
            .folder_batch(
                gid,
                BatchOp::Fetch { prune: false },
                std::slice::from_ref(&web)
            )
            .await
    ));
    assert!(is_invalid(
        &core.folder_summaries(gid, std::slice::from_ref(&web)).await
    ));
    let r = core
        .folder_batch(gid, BatchOp::Fetch { prune: false }, &[])
        .await
        .unwrap();
    assert_eq!(r.results.len(), 1);
    assert_eq!(core.folder_summaries(gid, &[]).await.unwrap().len(), 1);

    // 트리: 별칭 줄은 남고 그 안은 "없음"
    let FsListing::Listed { entries, .. } = core.fs_list_dir(gid, "", None).await.unwrap() else {
        panic!("맨 위");
    };
    assert_eq!(entries.len(), 2);
    assert_eq!(
        core.fs_list_dir(gid, "web", None).await.unwrap(),
        FsListing::Missing
    );
    assert_eq!(
        core.fs_read_file(gid, "web/a.txt").await.unwrap(),
        FsFile::Missing
    );

    // 정의는 남는다 (목록의 상태도 Missing)
    let listed = core.groups_list().unwrap();
    let members = &listed[0].group.members;
    assert_eq!(members.len(), 2);
    assert_eq!(members[1].state, MemberState::Missing);

    // 다시 열면 같은 세션(줄어든 로스터)이고, 수동 재스캔은 바뀐 것이 없어도 다시 알린다
    let (sink, _r) = collector();
    let reopened = core.open_group(&id, sink).await.unwrap();
    assert_eq!(reopened.repos.len(), 1);
    core.folder_rescan(gid).await.unwrap();
    assert!(
        drain(&mut rx)
            .iter()
            .any(|e| matches!(e, CoreEvent::GroupChanged { .. }))
    );

    // 다시 만들어지면 재스캔으로 돌아온다
    repo_at(&web, "web again");
    let repos = core.folder_rescan(gid).await.unwrap();
    assert_eq!(repos.len(), 2);
}

/// 인수 ④: 경로 확인은 폴더를 저장소들로 펼치고 저장소 안 폴더를 최상위로 고치며, 없음·저장소 아님·중복(링크로 간 같은
/// 저장소 포함)·중첩을 거부한다. 별칭은 폴더 이름 → `-상위폴더` → `-2` 다. 만들기·고치기는 거부할 경로가 있으면 실패한다
#[tokio::test]
async fn membership_rules_reject_duplicates_nesting_and_non_repos() {
    let core = core().await;
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let dir_a = a.path().canonicalize().unwrap();
    let dir_b = b.path().canonicalize().unwrap();
    let _api = repo_at(&dir_a.join("x/api"), "a");
    let _api2 = repo_at(&dir_b.join("y/api"), "b");
    let _api3 = repo_at(&dir_b.join("z/y/api"), "c");
    let _lib = repo_at(&dir_a.join("x/api/vendor/lib"), "lib");
    let _many1 = repo_at(&dir_b.join("many/one"), "one");
    let _many2 = repo_at(&dir_b.join("many/two"), "two");
    std::fs::create_dir_all(dir_a.join("plain")).unwrap();
    std::fs::create_dir_all(dir_a.join("x/api/src")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir_a.join("x/api"), dir_b.join("link")).unwrap();

    let checks = core
        .group_check_paths(
            None,
            &[
                dir_a.join("x/api"),
                dir_b.join("y/api"),
                dir_b.join("z/y/api"),
                dir_a.join("x/api/vendor/lib"),
                dir_a.join("x/api/src"),
                dir_b.join("many"),
                dir_a.join("plain"),
                dir_a.join("nowhere"),
                PathBuf::from("relative/path"),
                dir_b.join("y/api"),
            ],
        )
        .unwrap();
    let brief: Vec<(PathBuf, Option<String>, Option<PathIssue>)> = checks
        .iter()
        .map(|c| (c.path.clone(), c.alias.clone(), c.issue))
        .collect();
    assert_eq!(
        brief,
        vec![
            (dir_a.join("x/api"), Some("api".into()), None),
            (dir_b.join("y/api"), Some("api-y".into()), None),
            (dir_b.join("z/y/api"), Some("api-y-2".into()), None),
            (
                dir_a.join("x/api/vendor/lib"),
                None,
                Some(PathIssue::Nested)
            ),
            // 저장소 안 폴더 → 최상위로 고친 뒤 이미 고른 저장소라 중복
            (dir_a.join("x/api"), None, Some(PathIssue::Duplicate)),
            (dir_b.join("many/one"), Some("one".into()), None),
            (dir_b.join("many/two"), Some("two".into()), None),
            (dir_a.join("plain"), None, Some(PathIssue::NotRepo)),
            (dir_a.join("nowhere"), None, Some(PathIssue::Missing)),
            (
                PathBuf::from("relative/path"),
                None,
                Some(PathIssue::Missing)
            ),
            (dir_b.join("y/api"), None, Some(PathIssue::Duplicate)),
        ]
    );
    assert_eq!(checks[5].input, dir_b.join("many"));
    assert_eq!(checks[0].kind, Some(RepoKind::Standalone));
    #[cfg(unix)]
    {
        let link = core
            .group_check_paths(None, &[dir_a.join("x/api"), dir_b.join("link")])
            .unwrap();
        assert_eq!(link[1].issue, Some(PathIssue::Duplicate));
    }

    // 만들기: 거부할 경로가 있으면 실패, 이름 규칙
    assert!(is_invalid(
        &core.group_create("g", &[dir_a.join("x/api"), dir_a.join("plain")])
    ));
    assert!(is_invalid(&core.group_create("g", &[dir_a.join("plain")])));
    assert!(is_invalid(&core.group_create("g", &[])));
    assert!(is_invalid(&core.group_create("  ", &[dir_a.join("x/api")])));
    let created = core
        .group_create("Backend", &[dir_a.join("x/api"), dir_b.join("y/api")])
        .unwrap();
    let id = created.group.id.clone();
    assert!(is_invalid(
        &core.group_create("backend", &[dir_b.join("many")])
    ));

    // 기존 그룹에 견주기: 이미 있는 저장소는 중복, 새 저장소는 겹치지 않는 별칭
    let more = core
        .group_check_paths(Some(&id), &[dir_b.join("y/api"), dir_b.join("z/y/api")])
        .unwrap();
    assert_eq!(more[0].issue, Some(PathIssue::Duplicate));
    assert_eq!(more[1].alias.as_deref(), Some("api-y-2"));
    let unknown = GroupId::parse("g000000000000").unwrap();
    assert!(is_invalid(&core.group_check_paths(Some(&unknown), &[])));

    // 고치기: 중복·중첩·별칭 겹침·잘못된 별칭·저장소 아님·빈 목록 거부
    let member = |alias: &str, path: PathBuf| GroupMember {
        alias: alias.into(),
        path,
    };
    let current: Vec<GroupMember> = created.group.members.iter().map(|m| m.member()).collect();
    let with = |extra: GroupMember| {
        let mut list = current.clone();
        list.push(extra);
        GroupUpdate {
            members: Some(list),
            ..GroupUpdate::default()
        }
    };
    for bad in [
        with(member("again", dir_a.join("x/api"))),
        with(member("lib", dir_a.join("x/api/vendor/lib"))),
        with(member("API", dir_b.join("many/one"))),
        with(member("..", dir_b.join("many/one"))),
        with(member("a/b", dir_b.join("many/one"))),
        with(member("plain", dir_a.join("plain"))),
        with(member("src", dir_a.join("x/api/src"))),
        GroupUpdate {
            members: Some(Vec::new()),
            ..GroupUpdate::default()
        },
        GroupUpdate {
            name: Some(String::new()),
            ..GroupUpdate::default()
        },
    ] {
        assert!(
            is_invalid(&core.group_update(&id, bad.clone()).await),
            "{bad:?}"
        );
    }
    #[cfg(unix)]
    assert!(is_invalid(
        &core
            .group_update(&id, with(member("link", dir_b.join("link"))))
            .await
    ));
    let updated = core
        .group_update(&id, with(member("one", dir_b.join("many/one"))))
        .await
        .unwrap();
    assert_eq!(updated.group.members.len(), 3);

    // 위치 다시 지정: 같은 별칭, 새 경로
    let mut relocated = updated
        .group
        .members
        .iter()
        .map(|m| m.member())
        .collect::<Vec<_>>();
    relocated[2].path = dir_b.join("many/two");
    let moved = core
        .group_update(
            &id,
            GroupUpdate {
                members: Some(relocated),
                ..GroupUpdate::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(moved.group.members[2].alias, "one");
    assert_eq!(moved.group.members[2].path, dir_b.join("many/two"));

    // 열린 그룹: 이름 변경·고정은 열린 채 반영되고(M4), 지우기는 거부. 닫으면 지울 수 있다
    let (sink, _rx) = collector();
    let gid = core.open_group(&id, sink).await.unwrap().session;
    let renamed = core
        .group_update(
            &id,
            GroupUpdate {
                name: Some("Other".into()),
                ..GroupUpdate::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(renamed.group.name, "Other");
    assert!(is_invalid(&core.group_delete(&id)));
    let pinned = core
        .group_update(
            &id,
            GroupUpdate {
                pinned: Some(true),
                ..GroupUpdate::default()
            },
        )
        .await
        .unwrap();
    assert!(pinned.pinned);
    core.close_folder(gid).unwrap();
    core.group_delete(&id).unwrap();
    assert!(core.groups_list().unwrap().is_empty());
    assert!(is_invalid(&core.group_delete(&id)));
    let (sink, _rx) = collector();
    assert!(is_invalid(&core.open_group(&id, sink).await));
}

/// M4: 열린 그룹을 고치면 그 자리에서 반영된다 — 같은 세션 그대로 이름·별칭·멤버가 바뀌고, 이벤트는 `FolderRescanned`
/// 뒤에 `GroupChanged`, 로스터·일괄 대상·파일 경로 공간이 새 멤버를 따른다 (뺀 멤버·옛 별칭은 거부)
#[tokio::test]
async fn updating_an_open_group_applies_in_place() {
    let core = core().await;
    let fx = Scattered::new();
    let (api, web) = (fx.api_path(), fx.web_path());
    let c = tempfile::tempdir().unwrap();
    let third = c.path().canonicalize().unwrap().join("tools");
    let _tools = repo_at(&third, "tools first");
    let (id, gid, mut rx) = open_group(&core, "작업", &[api.clone(), web.clone()]).await;
    drain(&mut rx);

    let updated = core
        .group_update(
            &id,
            GroupUpdate {
                name: Some("바뀐 이름".into()),
                members: Some(vec![
                    GroupMember {
                        alias: "backend".into(),
                        path: api.clone(),
                    },
                    GroupMember {
                        alias: "tools".into(),
                        path: third.clone(),
                    },
                ]),
                pinned: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.group.name, "바뀐 이름");

    // 이벤트 순서: 목록 → 그룹 모습
    let events = drain(&mut rx);
    let rescanned = events
        .iter()
        .position(|e| matches!(e, CoreEvent::FolderRescanned { .. }))
        .unwrap();
    let changed = events
        .iter()
        .position(|e| matches!(e, CoreEvent::GroupChanged { .. }))
        .unwrap();
    assert!(rescanned < changed, "{events:?}");
    let CoreEvent::FolderRescanned { repos, .. } = &events[rescanned] else {
        unreachable!()
    };
    assert_eq!(
        repos.iter().map(|r| r.path.clone()).collect::<Vec<_>>(),
        vec![api.clone(), third.clone()]
    );
    let CoreEvent::GroupChanged { group, .. } = &events[changed] else {
        unreachable!()
    };
    assert_eq!(group.name, "바뀐 이름");
    let aliases: Vec<&str> = group.members.iter().map(|m| m.alias.as_str()).collect();
    assert_eq!(aliases, vec!["backend", "tools"]);

    // 같은 세션 (탭이 닫히지 않았다)
    let (sink, _r) = collector();
    let again = core.open_group(&id, sink).await.unwrap();
    assert_eq!(again.session, gid);
    assert_eq!(again.group.unwrap().name, "바뀐 이름");

    // 로스터·일괄 대상
    assert_eq!(core.folder_summaries(gid, &[]).await.unwrap().len(), 2);
    assert!(is_invalid(
        &core
            .folder_batch(
                gid,
                BatchOp::Fetch { prune: false },
                std::slice::from_ref(&web)
            )
            .await
    ));
    // 파일 경로 공간: 새 별칭은 읽히고, 옛 별칭·뺀 멤버는 거부
    assert!(matches!(
        core.fs_read_file(gid, "backend/a.txt").await.unwrap(),
        FsFile::Text { .. }
    ));
    assert!(matches!(
        core.fs_read_file(gid, "tools/a.txt").await.unwrap(),
        FsFile::Text { .. }
    ));
    for gone in ["api/a.txt", "web/a.txt"] {
        assert!(is_invalid(&core.fs_read_file(gid, gone).await), "{gone}");
    }
    let FsListing::Listed { entries, .. } = core.fs_list_dir(gid, "", None).await.unwrap() else {
        panic!("맨 위");
    };
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["backend", "tools"]);
    let listed = core
        .workspace_files(gid, mgit_model::CancelToken::default())
        .await
        .unwrap();
    assert!(
        listed
            .files
            .iter()
            .all(|f| f.starts_with("backend/") || f.starts_with("tools/")),
        "{:?}",
        listed.files
    );
}

/// M4: 열린 그룹을 여러 스레드에서 동시에 고치고(이름·별칭) 재스캔해도 잠금이 엇갈려 멈추지 않고, 세션에는 마지막으로
/// 저장된 정의가 남는다 (반영은 `rescan_lock` 안에서 정의를 다시 읽는다. 그룹 잠금은 반영 전에 놓는다)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_updates_and_rescans_leave_the_latest_definition() {
    let core = Arc::new(core().await);
    let fx = Scattered::new();
    let (api, web) = (fx.api_path(), fx.web_path());
    let (id, gid, _rx) = open_group(&core, "작업", &[api.clone(), web.clone()]).await;
    let mut tasks = Vec::new();
    for i in 0..8 {
        let (updater, id) = (Arc::clone(&core), id.clone());
        let members = vec![
            GroupMember {
                alias: format!("api-{i}"),
                path: api.clone(),
            },
            GroupMember {
                alias: "web".into(),
                path: web.clone(),
            },
        ];
        tasks.push(tokio::spawn(async move {
            updater
                .group_update(
                    &id,
                    GroupUpdate {
                        name: Some(format!("이름 {i}")),
                        members: Some(members),
                        pinned: None,
                    },
                )
                .await
                .map(|_| ())
        }));
        let rescanner = Arc::clone(&core);
        tasks.push(tokio::spawn(async move {
            rescanner.folder_rescan(gid).await.map(|_| ())
        }));
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        for task in tasks {
            task.await.unwrap().unwrap();
        }
    })
    .await
    .expect("고치기·재스캔이 잠금에서 멈췄다");
    let saved = core.groups_list().unwrap()[0].group.clone();
    let (sink, _r) = collector();
    let session = core.open_group(&id, sink).await.unwrap();
    assert_eq!(session.session, gid);
    let view = session.group.unwrap();
    assert_eq!(view.name, saved.name);
    assert_eq!(
        view.members
            .iter()
            .map(|m| m.alias.clone())
            .collect::<Vec<_>>(),
        saved
            .members
            .iter()
            .map(|m| m.alias.clone())
            .collect::<Vec<_>>()
    );
    // 파일 경로 공간도 마지막 별칭을 따른다
    let alias = &saved.members[0].alias;
    assert!(matches!(
        core.fs_read_file(gid, &format!("{alias}/a.txt"))
            .await
            .unwrap(),
        FsFile::Text { .. }
    ));
}

/// M4: 그룹을 지우면 그 그룹의 폴더 설정(`folder:mgit-group:<id>`)도 지운다. 다른 폴더의 설정은 그대로다
#[tokio::test]
async fn deleting_a_group_drops_its_folder_settings() {
    let core = core().await;
    let fx = Scattered::new();
    let (id, gid, _rx) = open_group(&core, "작업", &[fx.api_path(), fx.web_path()]).await;
    let (sink, _r) = collector();
    let folder = core.open_folder(&fx.dir_a, sink).await.unwrap().session;
    let settings = FolderSettings {
        concurrency: 2,
        ..FolderSettings::default()
    };
    core.set_folder_settings(gid, &settings).unwrap();
    core.set_folder_settings(folder, &settings).unwrap();
    let key = format!("folder:mgit-group:{}", id.as_str());
    assert!(core.store().setting_get(&key).unwrap().is_some());
    core.close_folder(gid).unwrap();
    core.group_delete(&id).unwrap();
    assert_eq!(core.store().setting_get(&key).unwrap(), None);
    assert_eq!(core.folder_settings(folder).unwrap().concurrency, 2);
}
