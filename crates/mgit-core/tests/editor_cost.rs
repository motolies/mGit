//! 편집기 부가 기능의 비용 측정 (셋째 묶음 N6). 측정은 기본 실행에서 빠진다 (`#[ignore]`). 돌리는 법:
//! `cargo test --release -p mgit-core --test editor_cost -- --ignored --nocapture --test-threads=1`
//!
//! - 인라인 Blame: 편집기가 입력이 0.5초 멈출 때마다 부르는 `blame_contents`(`git blame --line-porcelain --contents -`)
//! - 변경 표시: 같은 때 부르는 `revision_file_content(HEAD)` (`rev-parse` → `ls-tree` → `cat-file`)
//! - 2초 검사: 열린 파일마다 `fs_read_editable_file` (원문 전체 읽기 + SHA-256 여러 번) 과 메타데이터 표지만 보는 경우
//!   (`fs_file_stamps`)
//! - git 프로세스 하나의 생성 비용
//! - 편집기 저장 한 번 뒤 코어가 띄우는 git 명령 (반응성 개선 M4). 이것만은 기본 실행에 들어가는 기준선 테스트다
//!   (`editor_save_once_git_commands`)
//!
//! 합성 저장소는 `git fast-import` 로 한 파일을 여러 commit 에 걸쳐 고친 이력을 만든다 (commit 마다 5줄을 바꾼다).
//! 결과는 표로 stderr 에 찍는다 (p50·p95, 밀리초)

#![allow(clippy::unwrap_used)]

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{collector, core, core_watching, ran_since, wait_commands_quiet, wait_finished};
use mgit_core::{Core, FsEditableFile, FsSaveResult, SessionId};
use mgit_git::{RunnerConfig, TokioGitRunner};
use mgit_model::{GitRequest, GitRunner};
use mgit_testkit::TestRepo;

/// 걸린 시간들의 p50·p95 (밀리초)
fn percentiles(mut samples: Vec<Duration>) -> (f64, f64) {
    samples.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let at = |q: f64| {
        let index = ((samples.len() as f64 * q).ceil() as usize).clamp(1, samples.len()) - 1;
        ms(samples[index])
    };
    (at(0.5), at(0.95))
}

/// `f` 를 `n` 번 돌려 걸린 시간을 모은다 (처음 한 번은 데우기로 버린다)
async fn sample<F, Fut, T>(n: usize, mut f: F) -> Vec<Duration>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let _ = f().await;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let start = Instant::now();
        let _ = f().await;
        out.push(start.elapsed());
    }
    out
}

/// 줄 `j` 를 `rev` 판으로 쓴 한 줄 (약 30바이트)
fn line_text(j: usize, rev: usize) -> String {
    format!("const value_{j:06} = compute({rev}, \"x\");\n")
}

/// `lines` 줄짜리 `big.txt` 를 `commits` 번 고친 이력의 저장소. commit 마다 5줄을 바꾼다
fn synthetic_repo(lines: usize, commits: usize) -> TestRepo {
    let mut repo = TestRepo::init();
    let mut revs = vec![0usize; lines];
    let mut stream: Vec<u8> = Vec::new();
    for c in 1..=commits {
        let start = (c * 37) % lines;
        for k in 0..5 {
            revs[(start + k) % lines] = c;
        }
        let content: String = revs
            .iter()
            .enumerate()
            .map(|(j, r)| line_text(j, *r))
            .collect();
        let message = format!("change {c}");
        stream.extend_from_slice(b"commit refs/heads/main\n");
        stream.extend_from_slice(format!("mark :{c}\n").as_bytes());
        stream.extend_from_slice(
            format!(
                "committer Bench <bench@example.com> {} +0000\n",
                1_600_000_000 + c * 60
            )
            .as_bytes(),
        );
        stream.extend_from_slice(format!("data {}\n{message}\n", message.len()).as_bytes());
        if c > 1 {
            stream.extend_from_slice(format!("from :{}\n", c - 1).as_bytes());
        }
        stream.extend_from_slice(b"M 100644 inline big.txt\n");
        stream.extend_from_slice(format!("data {}\n", content.len()).as_bytes());
        stream.extend_from_slice(content.as_bytes());
        stream.extend_from_slice(b"\n");
    }
    let out = repo.git_with_stdin(["fast-import", "--quiet"], Some(&stream));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    repo.git_ok(["reset", "-q", "--hard", "main"]);
    repo
}

/// 저장소를 탭으로 열고 첫 로드를 기다린다
async fn open(core: &Core, path: &Path) -> SessionId {
    let (sink, mut rx) = collector();
    let opened = core.open_repo(path, sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    opened.session
}

/// 한 줄을 고친 초안 (타이핑 중인 원문 흉내)
fn edited(text: &str) -> String {
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    let middle = lines.len() / 2;
    let replaced = "let typed = 1; // 입력 중\n";
    if let Some(slot) = lines.get_mut(middle) {
        *slot = replaced;
    }
    lines.concat()
}

/// 한 파일의 blame·HEAD 원문 비용을 재서 표 한 줄로 찍는다
async fn measure_file(
    core: &Core,
    session: SessionId,
    label: &str,
    rel: &str,
    root: &Path,
    n: usize,
) {
    let text = edited(&std::fs::read_to_string(root.join(rel)).unwrap());
    let blame = sample(n, || core.blame_contents(session, rel, &text, false)).await;
    let lines = core
        .blame_contents(session, rel, &text, false)
        .await
        .unwrap();
    let payload = serde_json::to_vec(&lines).unwrap().len();
    let head = sample(n, || core.revision_file_content(session, "HEAD", rel)).await;
    let (b50, b95) = percentiles(blame);
    let (h50, h95) = percentiles(head);
    eprintln!(
        "| {label} | {} | {:.0} KiB | {b50:.1} | {b95:.1} | {h50:.1} | {h95:.1} | {:.0} KiB |",
        lines.len(),
        text.len() as f64 / 1024.0,
        payload as f64 / 1024.0
    );
}

/// (a) 0.5초 멈춤마다 부르는 blame·HEAD 원문 1회 비용: 합성 이력 (줄 수 × 그 파일을 고친 commit 수) 과 이 저장소의 실제 파일
#[tokio::test]
#[ignore = "측정용: --ignored 로 돌린다"]
async fn blame_and_head_cost() {
    let core = core().await;
    eprintln!(
        "\n| 대상 | 줄 | 크기 | blame p50 | blame p95 | HEAD 원문 p50 | HEAD 원문 p95 | blame 응답(JSON) |"
    );
    eprintln!("|---|---|---|---|---|---|---|---|");
    for (lines, commits) in [
        (1_000, 30),
        (1_000, 300),
        (1_000, 1_000),
        (5_000, 30),
        (5_000, 300),
        (5_000, 1_000),
        (20_000, 30),
        (20_000, 300),
    ] {
        let repo = synthetic_repo(lines, commits);
        let session = open(&core, repo.path()).await;
        let n = if lines * commits >= 5_000_000 { 7 } else { 15 };
        measure_file(
            &core,
            session,
            &format!("합성 {lines}줄 × commit {commits}"),
            "big.txt",
            repo.path(),
            n,
        )
        .await;
        core.close_repo(session).unwrap();
    }
    // 이 저장소 (워크트리) 의 실제 파일
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let session = open(&core, &root).await;
    for rel in [
        "apps/desktop/src/store/session-store.ts",
        "crates/mgit-core/src/folder_batch.rs",
        "apps/desktop/src/features/workspace/FileEditor.tsx",
    ] {
        measure_file(&core, session, &format!("mGit `{rel}`"), rel, &root, 15).await;
    }
}

/// (d) git 프로세스 하나의 비용: 가장 가벼운 명령 (`rev-parse --git-dir`, `version`)
#[tokio::test]
#[ignore = "측정용: --ignored 로 돌린다"]
async fn git_spawn_cost() {
    let runner = TokioGitRunner::new(RunnerConfig::default()).await.unwrap();
    let repo = synthetic_repo(10, 2);
    eprintln!("\n| 명령 | p50 | p95 |");
    eprintln!("|---|---|---|");
    for args in [
        vec!["version"],
        vec!["rev-parse", "--git-dir"],
        vec!["rev-parse", "--verify", "HEAD"],
    ] {
        let samples = sample(40, || {
            let req = GitRequest::new(repo.path(), args.clone());
            runner.run(req)
        })
        .await;
        let (p50, p95) = percentiles(samples);
        eprintln!("| git {} | {p50:.1} | {p95:.1} |", args.join(" "));
    }
}

/// (c) 2초 검사 1회 비용: 열린 파일 1·10·30개 × 파일 크기. 원문 읽기·해시 + 응답 직렬화와, 메타데이터 표지만 보는 방식
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "측정용: --ignored 로 돌린다"]
async fn editor_refresh_tick_cost() {
    let core = Arc::new(core().await);
    let mut repo = TestRepo::init();
    repo.commit("init");
    // 한 줄이 약 40바이트다. 가장 큰 것은 편집기가 여는 상한(1 MiB) 아래로 둔다
    let sizes = [
        (10 * 1024, "10 KiB"),
        (100 * 1024, "100 KiB"),
        (900 * 1024, "900 KiB"),
    ];
    for (bytes, _) in sizes {
        for i in 0..30 {
            let lines = bytes / 40;
            let body: String = (0..lines).map(|j| line_text(j, i)).collect();
            repo.write_file(&format!("f{bytes}/{i}.ts"), &body);
        }
    }
    let session = open(&core, repo.path()).await;
    eprintln!(
        "\n| 열린 파일 | 크기 | 원문 읽기 p50 | p95 | 응답 직렬화 p50 | 표지(fs_file_stamps) p50 | 표지 p95 |"
    );
    eprintln!("|---|---|---|---|---|---|---|");
    for (bytes, label) in sizes {
        for count in [1, 10, 30] {
            let paths: Vec<String> = (0..count).map(|i| format!("f{bytes}/{i}.ts")).collect();
            // 프런트처럼 파일마다 동시에 부른다 (`Promise.all`)
            let read = sample(15, || read_all(&core, session, &paths)).await;
            let texts = read_all(&core, session, &paths).await;
            let serialize =
                sample(15, || async { serde_json::to_vec(&texts).unwrap().len() }).await;
            // 바꾼 방식: 메타데이터 표지만 (경로 확인 포함, 한 번에 묶어 부른다)
            let stat = sample(15, || core.fs_file_stamps(session, &paths)).await;
            let (r50, r95) = percentiles(read);
            let (s50, _) = percentiles(serialize);
            let (t50, t95) = percentiles(stat);
            eprintln!(
                "| {count} | {label} | {r50:.2} | {r95:.2} | {s50:.2} | {t50:.3} | {t95:.3} |"
            );
        }
    }
}

/// 열린 파일들을 동시에 편집용으로 읽는다 (2초 검사 한 번). 원문들을 돌려준다
async fn read_all(core: &Arc<Core>, session: SessionId, paths: &[String]) -> Vec<String> {
    let mut set = tokio::task::JoinSet::new();
    for (i, p) in paths.iter().enumerate() {
        let core = Arc::clone(core);
        let p = p.clone();
        set.spawn(async move { (i, core.fs_read_editable_file(session, &p).await) });
    }
    let mut texts = vec![String::new(); paths.len()];
    while let Some(joined) = set.join_next().await {
        let (i, file) = joined.unwrap();
        if let Ok(mgit_core::FsEditableFile::Text { text, .. }) = file {
            texts[i] = text;
        }
    }
    texts
}

/// 편집기 저장 한 번 뒤 코어가 띄우는 git 명령 (반응성 개선 M4 기준선 → G1 뒤의 값).
/// 화면의 저장 흐름(`FileViewDoc.tsx` `afterSave`)을 코어 호출로 옮겨 단계마다 센다:
///
/// 1. `fs_save_file`: 저장 + 그 안의 저장소 판별과 status 갱신(`refresh_after_writes`, 배경 읽기)
/// 2. 감시: 같은 저장(작업 파일)과 1의 status 가 고친 `.git/index` 를 보고 status 를 다시 읽는 것
///
/// G1 전에는 화면이 저장마다 전체 범위 갱신(`refresh`)을 한 번 더 불러 ref 읽기 7개가 붙었다(저장 2 + 새로고침 7 + 감시 1~2).
/// 파일 저장은 ref 를 바꾸지 않으므로 G1 이 그 호출을 뺐고, 저장 한 번은 이제 저장 2 + 감시 1~2 다. 화면은 저장 전에 깨끗하던
/// 파일의 status 가 3초 안에 바뀌지 않을 때만(감시도 1의 status 갱신도 닿지 않은 경우) 대체 경로로 전체 갱신을 부른다 —
/// 그 구성은 아래 3에서 따로 고정한다(명시적 새로고침과 같은 호출이다).
///
/// 3. `refresh`: 대체 경로·사용자 새로고침의 전체 범위 갱신(`refresh_repo`, interactive 읽기)
///
/// 파일 트리 다시 읽기(`fs_list_dir`)는 git 을 띄우지 않아 뺐다. 화면이 조건에 따라 더 부르는 diff 조회(선택한 파일이 같을 때)도
/// 넣지 않았다.
///
/// 1·3 은 결정적이라 명령 구성을 그대로 고정한다. 2 는 감시 이벤트가 debounce 창 안에서 하나로 묶이느냐에 따라 1번 또는
/// 2번(작업 파일 변경, index 다시 쓰기) 돈다 — 그래서 "status 만, 1~2번"으로 고정한다
#[tokio::test]
async fn editor_save_once_git_commands() {
    let core = core_watching().await;
    let mut repo = TestRepo::init();
    repo.write_file("note.txt", "before\n");
    repo.commit("base");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    // 여는 동안 띄운 명령과 그 감시 이벤트가 끝날 때까지 기다린다
    wait_commands_quiet(&core, Duration::from_millis(800), Duration::from_secs(20)).await;
    let FsEditableFile::Text { revision, .. } = core
        .fs_read_editable_file(opened.session, "note.txt")
        .await
        .unwrap()
    else {
        panic!("편집할 수 있는 텍스트가 아님");
    };

    let start = core.command_log_recent(usize::MAX).len();
    let saved = core
        .fs_save_file(opened.session, "note.txt", &revision, "after\n")
        .await
        .unwrap();
    assert!(matches!(saved, FsSaveResult::Saved { .. }), "{saved:?}");
    let save = ran_since(&core, start);
    let after_save = start + save.len();
    // 감시가 띄운 status 가 하나라도 나올 때까지(최대 10초) 기다린 뒤 잦아들 때까지 모은다
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ran_since(&core, after_save).iter().any(|c| c == "status") {
        assert!(Instant::now() < deadline, "감시가 status 를 다시 읽지 않음");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let end = wait_commands_quiet(&core, Duration::from_millis(800), Duration::from_secs(20)).await;
    let watch = ran_since(&core, after_save);
    eprintln!(
        "저장 한 번: 저장 {save:?} / 감시 {watch:?} → 합계 {}",
        end - start
    );

    assert_eq!(
        save,
        ["rev-parse", "status"],
        "저장(저장소 판별) + status 갱신"
    );
    assert!(
        (1..=2).contains(&watch.len()) && watch.iter().all(|c| c == "status"),
        "감시는 status 만 1~2번: {watch:?}"
    );
    assert!(
        (3..=4).contains(&(end - start)),
        "저장 한 번은 저장 2 + 감시 1~2 다 (G1 전에는 전체 갱신 7개가 더 붙었다): {}",
        end - start
    );

    // 대체 경로·사용자 새로고침의 전체 범위 갱신. 이어지는 감시의 status(전체 갱신이 고친 index)는 세지 않는다
    core.refresh(opened.session).await.unwrap();
    let refresh = ran_since(&core, end);
    eprintln!("전체 갱신(대체 경로·새로고침): {refresh:?}");
    // ref 읽기의 네 갈래(라벨·stash·worktree·remote)는 동시에 돌아 로그 순서가 바뀔 수 있어 정렬해 견준다
    let mut refresh_sorted = refresh.clone();
    refresh_sorted.sort();
    assert_eq!(
        refresh_sorted,
        [
            "for-each-ref",
            "remote",
            "rev-parse",
            "stash",
            "status",
            "symbolic-ref",
            "worktree"
        ],
        "전체 범위 갱신(HEAD·ref·status): {refresh:?}"
    );
    core.close_repo(opened.session).unwrap();
}
