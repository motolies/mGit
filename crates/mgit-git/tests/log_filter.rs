//! 커밋 필터(LG-06) → `git log` 인자와 그 인자의 실제 git 동작을 임시 저장소로 고정한다.
//! 확인한 git: 2.54.0 (Apple Git-157). 최소 지원 2.45 에서는 돌려 보지 않았다
#![allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#![cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mgit_git::cmd::{
    AuthorCount, filter_args, filter_rejection, graph_log_request, graph_log_request_with,
    log_authors,
};
use mgit_git::parse::LogParser;
use mgit_git::{LocateConfig, RunnerConfig, TokioGitRunner};
use mgit_model::{
    CommitFilter, CommitRecord, GitRequest, GitRunner, GraphQuery, GraphRevs, GraphSort, TextFilter,
};
use mgit_testkit::TestRepo;

/// 기본 설정 러너
async fn runner() -> TokioGitRunner {
    TokioGitRunner::new(RunnerConfig::default()).await.unwrap()
}

/// 작성자·작성 시각을 지정해 빈 커밋을 만든다. 커밋 시각은 저장소 시계(+60초)다
fn commit_as(repo: &mut TestRepo, msg: &str, author: &str, author_date: Option<i64>) {
    repo.advance_clock(60);
    let mut args: Vec<String> = vec![
        "commit".into(),
        "-q".into(),
        "--allow-empty".into(),
        "-F".into(),
        "-".into(),
        format!("--author={author}"),
    ];
    if let Some(d) = author_date {
        args.push(format!("--date=@{d} +0000"));
    }
    let out = repo.git_with_stdin(&args, Some(msg.as_bytes()));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// 텍스트 필터만 있는 필터
fn text(pattern: &str, regex: bool, match_case: bool) -> CommitFilter {
    CommitFilter {
        text: TextFilter {
            pattern: pattern.into(),
            regex,
            match_case,
        },
        ..CommitFilter::default()
    }
}

/// 작성자 필터만 있는 필터
fn authors(emails: &[&str]) -> CommitFilter {
    CommitFilter {
        authors: emails.iter().map(|e| (*e).to_string()).collect(),
        ..CommitFilter::default()
    }
}

/// 필터를 건 그래프 로그를 돌려 레코드로 읽는다 (파서가 필터 결과에서도 동작하는지 함께 본다)
async fn records_with(
    r: &TokioGitRunner,
    path: &Path,
    filter: CommitFilter,
    env: &[(&str, &str)],
) -> Vec<CommitRecord> {
    let query = GraphQuery {
        filter,
        ..GraphQuery::default()
    };
    let mut req = graph_log_request(path, &[], &query);
    for (k, v) in env {
        req = req.with_env_var(k, v);
    }
    let out = r.run(req).await.unwrap();
    assert!(out.exit.success(), "{}", out.exit.stderr);
    let mut p = LogParser::new();
    let recs = p.feed(&out.stdout).unwrap();
    p.finish().unwrap();
    recs
}

/// 필터를 건 그래프 로그의 제목 목록 (로그 순서)
async fn subjects(r: &TokioGitRunner, path: &Path, filter: CommitFilter) -> Vec<String> {
    records_with(r, path, filter, &[])
        .await
        .into_iter()
        .map(|c| c.subject)
        .collect()
}

/// 텍스트 필터 실험용 저장소
fn text_repo() -> TestRepo {
    let mut r = TestRepo::init();
    commit_as(
        &mut r,
        "fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back",
        "Kim <kim@x.com>",
        None,
    );
    commit_as(
        &mut r,
        "feat: 한글 메시지 테스트",
        "Kimberly <kimberly@x.com>",
        None,
    );
    commit_as(
        &mut r,
        "Upper CASE word\n\nbody has secret-word",
        "Lee <Lee@X.com>",
        None,
    );
    commit_as(&mut r, "-leading dash", "lee <lee@x.com>", None);
    commit_as(&mut r, "axb literal dot test", "Akim <akim@x.com>", None);
    r
}

// ── 인자 ────────────────────────────────────────────────────────────────────────

/// 필터가 없는 질의의 인자는 필터 이전과 글자 하나까지 같다
#[test]
fn no_filter_keeps_the_previous_args() {
    let req = graph_log_request(Path::new("/r"), &[], &GraphQuery::default());
    assert_eq!(
        req.display_args(),
        [
            "log",
            "--exclude=refs/notes/*",
            "--exclude=refs/mgit/*",
            "--exclude=refs/replace/*",
            "--topo-order",
            "--no-show-signature",
            "--no-color",
            "--encoding=UTF-8",
            "-z",
            "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s",
            "--all",
            "--",
        ]
    );
    // 옵션을 모두 켜도 필터가 없으면 이전 순서 그대로다 (빈 검색어는 조건이 아니다)
    let query = GraphQuery {
        revs: GraphRevs::Head,
        hide_remotes: true,
        path_scope: vec!["src".into()],
        sort: GraphSort::Date,
        first_parent: true,
        no_merges: true,
        filter: text("", true, true),
    };
    let req = graph_log_request_with(Path::new("/r"), &[], &query, Some(11));
    assert_eq!(
        req.display_args(),
        [
            "log",
            "--exclude=refs/notes/*",
            "--exclude=refs/mgit/*",
            "--exclude=refs/replace/*",
            "--date-order",
            "--no-show-signature",
            "--no-color",
            "--encoding=UTF-8",
            "-z",
            "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s",
            "--max-count=11",
            "--first-parent",
            "--no-merges",
            "--exclude=refs/remotes/*",
            "--full-history",
            "--parents",
            "--end-of-options",
            "HEAD",
            "--",
            "src",
        ]
    );
}

/// 필터마다의 인자 (순서: -E, -i, --use-mailmap, --author…, --grep, --since-as-filter, --until)
#[test]
fn filter_args_snapshot() {
    // 글자 그대로 + 대소문자 무시: ERE 특수문자를 \ 로 막는다 (] } 는 그대로)
    assert_eq!(
        filter_args(&text("a.b(c) [x] {y}+?|^$\\", false, false)),
        [
            "-E",
            "-i",
            "--grep=a\\.b\\(c\\) \\[x] \\{y}\\+\\?\\|\\^\\$\\\\"
        ]
    );
    // 정규식 + 대소문자 구분: 패턴 그대로, -i 없음
    assert_eq!(
        filter_args(&text("^fix(es)?:", true, true)),
        ["-E", "--grep=^fix(es)?:"]
    );
    // `-` 로 시작해도 `=` 로 붙어 옵션이 되지 않는다
    assert_eq!(filter_args(&text("-x", false, true)), ["-E", "--grep=-x"]);
    // 작성자: 이메일 전체를 <> 로 감싸고 ASCII 글자는 [Xx] 로 대소문자 무시, 특수문자는 \ 로
    assert_eq!(
        filter_args(&authors(&["Kim.A+1@X.com", "lee@y"])),
        [
            "-E",
            "--use-mailmap",
            "--author=<[Kk][Ii][Mm]\\.[Aa]\\+1@[Xx]\\.[Cc][Oo][Mm]>",
            "--author=<[Ll][Ee][Ee]@[Yy]>",
        ]
    );
    // 날짜: 커밋 시각, `@<epoch> +0000`, 음수는 0
    assert_eq!(
        filter_args(&CommitFilter {
            since: Some(1_700_000_000),
            until: Some(-5),
            ..CommitFilter::default()
        }),
        ["--since-as-filter=@1700000000 +0000", "--until=@0 +0000"]
    );
    // 모두: 작성자 패턴은 -i 와 무관하게 대소문자를 무시하므로 -i 는 텍스트를 위한 것이다
    let all = CommitFilter {
        text: TextFilter {
            pattern: "fix".into(),
            regex: false,
            match_case: false,
        },
        authors: vec!["a@b".into()],
        since: Some(10),
        until: Some(20),
    };
    assert_eq!(
        filter_args(&all),
        [
            "-E",
            "-i",
            "--use-mailmap",
            "--author=<[Aa]@[Bb]>",
            "--grep=fix",
            "--since-as-filter=@10 +0000",
            "--until=@20 +0000",
        ]
    );
    // 질의 안에서는 범위(ref) 앞, 다른 옵션 뒤에 붙는다
    let query = GraphQuery {
        revs: GraphRevs::Solo {
            name: "main".into(),
        },
        filter: all,
        ..GraphQuery::default()
    };
    let args = graph_log_request(Path::new("/r"), &[], &query).display_args();
    let tail: Vec<&str> = args[args.len() - 10..].iter().map(String::as_str).collect();
    assert_eq!(
        tail,
        [
            "-E",
            "-i",
            "--use-mailmap",
            "--author=<[Aa]@[Bb]>",
            "--grep=fix",
            "--since-as-filter=@10 +0000",
            "--until=@20 +0000",
            "--end-of-options",
            "main",
            "--",
        ]
    );
}

// ── 텍스트 ──────────────────────────────────────────────────────────────────────

/// 글자 그대로는 정규식 특수문자가 뜻을 갖지 않고, 정규식은 ERE 로 읽힌다
#[tokio::test]
async fn literal_and_regex_text() {
    let repo = text_repo();
    let r = runner().await;
    let p = repo.path();
    let special = "a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back";
    assert_eq!(
        subjects(&r, p, text(special, false, false)).await,
        ["fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back"]
    );
    // 글자 그대로의 `a.b` 는 `axb` 에 맞지 않는다. 정규식이면 맞는다
    assert_eq!(
        subjects(&r, p, text("a.b", false, false)).await,
        ["fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back"]
    );
    assert_eq!(
        subjects(&r, p, text("a.b", true, false)).await,
        [
            "axb literal dot test",
            "fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back"
        ]
    );
    // 정규식의 ERE 문법(+, ?, |, 묶음)과 줄 머리 `^`
    assert_eq!(
        subjects(&r, p, text("^(fix|feat): ", true, true)).await,
        [
            "feat: 한글 메시지 테스트",
            "fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back"
        ]
    );
    // 글자 그대로의 `(` 는 잘못된 정규식이 아니다
    assert_eq!(subjects(&r, p, text("(c)", false, true)).await.len(), 1);
}

/// 대소문자: 꺼지면 ASCII 대소문자 무시(-i), 켜지면 구분. 한글은 대소문자가 없어 어느 쪽이든 맞는다
#[tokio::test]
async fn case_korean_dash_body_and_spaces() {
    let repo = text_repo();
    let r = runner().await;
    let p = repo.path();
    assert_eq!(
        subjects(&r, p, text("upper case", false, false)).await,
        ["Upper CASE word"]
    );
    assert!(
        subjects(&r, p, text("upper case", false, true))
            .await
            .is_empty()
    );
    assert_eq!(
        subjects(&r, p, text("^upper", true, false)).await,
        ["Upper CASE word"]
    );
    assert!(subjects(&r, p, text("^upper", true, true)).await.is_empty());
    for match_case in [false, true] {
        assert_eq!(
            subjects(&r, p, text("한글", false, match_case)).await,
            ["feat: 한글 메시지 테스트"]
        );
    }
    // `-` 로 시작하는 검색어
    assert_eq!(
        subjects(&r, p, text("-leading", false, true)).await,
        ["-leading dash"]
    );
    // 본문까지 찾는다
    assert_eq!(
        subjects(&r, p, text("secret-word", false, false)).await,
        ["Upper CASE word"]
    );
    // 공백도 글자다 (공백만인 검색어는 공백이 든 메시지에 맞는다 — 다듬기는 화면의 몫)
    assert_eq!(subjects(&r, p, text(" ", false, false)).await.len(), 5);
    // C 로캘(LC_ALL=C)이라 정규식 `.` 은 한 바이트다: 한글 한 글자(UTF-8 3바이트)에는 `...` 이 맞는다
    assert!(
        subjects(&r, p, text("한. 메", true, false))
            .await
            .is_empty()
    );
    assert_eq!(
        subjects(&r, p, text("한... 메", true, false)).await,
        ["feat: 한글 메시지 테스트"]
    );
}

/// 잘못된 정규식은 git 이 거부한다 (`log --max-count=0` 로 커밋을 걷지 않고 미리 본다)
#[tokio::test]
async fn invalid_regex_is_rejected_before_walking() {
    let repo = text_repo();
    let r = runner().await;
    let reason = filter_rejection(&r, repo.path(), &text("(", true, false))
        .await
        .unwrap();
    assert!(reason.contains("parentheses not balanced"), "{reason}");
    assert!(!reason.starts_with("fatal:"), "{reason}");
    let reason = filter_rejection(&r, repo.path(), &text("[a", true, true))
        .await
        .unwrap();
    assert!(reason.contains("brackets"), "{reason}");
    assert_eq!(
        filter_rejection(&r, repo.path(), &text("(", false, false)).await,
        None
    );
    assert_eq!(
        filter_rejection(&r, repo.path(), &text("fix(es)?", true, false)).await,
        None
    );
    // 커밋이 없는 저장소에서도 검사된다 (`--all` 이 비어도 패턴은 컴파일된다)
    let empty = TestRepo::init();
    assert!(
        filter_rejection(&r, empty.path(), &text("(", true, false))
            .await
            .is_some()
    );
}

// ── 작성자 ──────────────────────────────────────────────────────────────────────

/// 이메일 전체가 같아야 맞는다: `kim@x.com` 이 `kimberly@`·`akim@` 에 걸리지 않는다. 여럿은 OR, 대소문자 무시
#[tokio::test]
async fn authors_match_whole_email_case_insensitively() {
    let repo = text_repo();
    let r = runner().await;
    let p = repo.path();
    assert_eq!(
        subjects(&r, p, authors(&["kim@x.com"])).await,
        ["fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back"]
    );
    // `Lee@X.com` 과 `lee@x.com` 은 같은 사람으로 본다
    assert_eq!(
        subjects(&r, p, authors(&["LEE@x.COM"])).await,
        ["-leading dash", "Upper CASE word"]
    );
    assert_eq!(
        subjects(&r, p, authors(&["kim@x.com", "kimberly@x.com"])).await,
        [
            "feat: 한글 메시지 테스트",
            "fix: a.b(c) [x] {y} 1+1=2? $HOME ^start | pipe \\ back"
        ]
    );
    // 이름으로는 맞지 않는다
    assert!(subjects(&r, p, authors(&["Kim"])).await.is_empty());
}

/// 이메일 안의 `.`·`+` 는 글자 그대로다
#[tokio::test]
async fn author_email_special_characters_are_literal() {
    let mut repo = TestRepo::init();
    commit_as(&mut repo, "dot", "A <kim.a+1@x.com>", None);
    commit_as(&mut repo, "other", "B <kimxa+1@x.com>", None);
    commit_as(&mut repo, "plus", "C <kim.aa1@x.com>", None);
    let r = runner().await;
    assert_eq!(
        subjects(&r, repo.path(), authors(&["kim.a+1@x.com"])).await,
        ["dot"]
    );
}

/// .mailmap 을 따른다: 정본 이메일로 고르면 별칭 이메일의 커밋도 든다. 사용자가 `log.mailmap=false` 여도
/// (`--use-mailmap`) 후보 목록(`%aE`)과 같은 값으로 맞춘다. 별칭 이메일로는 더 이상 맞지 않는다
#[tokio::test]
async fn authors_follow_mailmap_even_when_log_mailmap_is_off() {
    let mut repo = TestRepo::init();
    commit_as(&mut repo, "old", "Kim <kim@old.com>", None);
    commit_as(&mut repo, "new", "Kim <kim@x.com>", None);
    commit_as(&mut repo, "other", "Other <o@x.com>", None);
    repo.write_file(".mailmap", "Kim <kim@x.com> <kim@old.com>\n");
    repo.git_ok(["config", "log.mailmap", "false"]);
    let r = runner().await;
    let recs = records_with(&r, repo.path(), authors(&["kim@x.com"]), &[]).await;
    let got: Vec<(&str, &str)> = recs
        .iter()
        .map(|c| (c.subject.as_str(), c.author_email.as_str()))
        .collect();
    assert_eq!(got, [("new", "kim@x.com"), ("old", "kim@x.com")]);
    assert!(
        subjects(&r, repo.path(), authors(&["kim@old.com"]))
            .await
            .is_empty()
    );
}

/// 텍스트·작성자·날짜는 AND, 작성자 여럿은 OR (`--all-match` 없이)
#[tokio::test]
async fn text_authors_and_dates_combine_with_and() {
    let repo = text_repo();
    let r = runner().await;
    let p = repo.path();
    let both = CommitFilter {
        text: TextFilter {
            pattern: "fe".into(),
            regex: false,
            match_case: false,
        },
        authors: vec!["kim@x.com".into(), "kimberly@x.com".into()],
        ..CommitFilter::default()
    };
    assert_eq!(
        subjects(&r, p, both.clone()).await,
        ["feat: 한글 메시지 테스트"]
    );
    // 날짜가 그 커밋(커밋 시각 1_700_000_120)을 빼면 빈 결과
    let later = CommitFilter {
        since: Some(1_700_000_121),
        ..both.clone()
    };
    assert!(subjects(&r, p, later).await.is_empty());
    let exact = CommitFilter {
        since: Some(1_700_000_120),
        until: Some(1_700_000_120),
        ..both
    };
    assert_eq!(subjects(&r, p, exact).await, ["feat: 한글 메시지 테스트"]);
}

// ── 날짜 ────────────────────────────────────────────────────────────────────────

/// 날짜 필터의 기준은 커밋 시각이고 경계는 양쪽 다 포함, 시간대(TZ)와 무관하다
#[tokio::test]
async fn dates_use_committer_time_inclusive_and_ignore_time_zone() {
    let mut repo = TestRepo::init();
    // 커밋 시각: 1_700_000_060, …120, …180, …240. 작성 시각은 c1 이 과거, c3 이 미래
    commit_as(&mut repo, "c1", "Kim <kim@x.com>", Some(1_600_000_000));
    commit_as(&mut repo, "c2", "Kim <kim@x.com>", None);
    commit_as(&mut repo, "c3", "Kim <kim@x.com>", Some(1_800_000_000));
    commit_as(&mut repo, "c4", "Kim <kim@x.com>", None);
    let r = runner().await;
    let p = repo.path();
    let range = |since: Option<i64>, until: Option<i64>| CommitFilter {
        since,
        until,
        ..CommitFilter::default()
    };
    assert_eq!(
        subjects(&r, p, range(Some(1_700_000_120), None)).await,
        ["c4", "c3", "c2"]
    );
    assert_eq!(
        subjects(&r, p, range(None, Some(1_700_000_120))).await,
        ["c2", "c1"]
    );
    // 작성 시각(1.6e9)은 하한보다 이르지만 커밋 시각이 늦어 든다
    assert_eq!(
        subjects(&r, p, range(Some(1_650_000_000), Some(1_700_000_060))).await,
        ["c1"]
    );
    // 작성 시각(1.8e9)은 상한보다 늦지만 커밋 시각이 일러 든다
    assert_eq!(
        subjects(&r, p, range(Some(1_700_000_180), Some(1_700_000_180))).await,
        ["c3"]
    );
    // 하한이 상한보다 늦으면 빈 결과 (오류가 아니다)
    assert!(
        subjects(&r, p, range(Some(1_700_000_200), Some(1_700_000_100)))
            .await
            .is_empty()
    );
    // 시간대가 달라도 같다
    for tz in ["Asia/Seoul", "America/Los_Angeles", "UTC"] {
        let got: Vec<String> = records_with(&r, p, range(Some(1_700_000_120), None), &[("TZ", tz)])
            .await
            .into_iter()
            .map(|c| c.subject)
            .collect();
        assert_eq!(got, ["c4", "c3", "c2"], "TZ={tz}");
    }
}

/// 커밋 시각이 어긋난 커밋이 중간에 있어도 그 아래의 맞는 커밋을 놓치지 않는다 (`--since-as-filter`).
/// 같은 하한을 `--since` 로 주면 git 이 그 커밋에서 걷기를 멈춰 아래 커밋이 빠진다 — 그래서 쓰지 않는다
#[tokio::test]
async fn since_does_not_stop_at_a_skewed_commit() {
    let mut repo = TestRepo::init();
    repo.commit("s1");
    repo.commit("s2");
    repo.advance_clock(60);
    // s3 의 커밋 시각을 1970 년 근처로 (amend 에 날짜를 직접 준다)
    let out = std::process::Command::new("git")
        .args(["commit", "-q", "--allow-empty", "-m", "s3 skewed"])
        .current_dir(repo.path())
        .env("GIT_CONFIG_GLOBAL", &repo.env().config_global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@x")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@x")
        .env("GIT_COMMITTER_DATE", "@1000 +0000")
        .env("GIT_AUTHOR_DATE", "@1000 +0000")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    repo.commit("s4");
    repo.commit("s5");
    let r = runner().await;
    let since = CommitFilter {
        since: Some(1_700_000_000),
        ..CommitFilter::default()
    };
    assert_eq!(
        subjects(&r, repo.path(), since).await,
        ["s5", "s4", "s2", "s1"]
    );
    // 대조: --since 는 s3 에서 멈춘다
    let out = r
        .run(GitRequest::new(
            repo.path(),
            ["log", "--format=%s", "--since=@1700000000 +0000"],
        ))
        .await
        .unwrap();
    assert_eq!(out.stdout_lossy().lines().collect::<Vec<_>>(), ["s5", "s4"]);
}

/// 필터 결과는 흩어진 커밋이라 부모가 결과에 없을 수 있다. 파서는 실제 부모를 그대로 준다
#[tokio::test]
async fn parser_keeps_real_parents_of_scattered_commits() {
    let repo = text_repo();
    let r = runner().await;
    // 2번째(부모 = Kim 의 1번째)와 5번째(부모 = lee 의 4번째) 커밋
    let recs = records_with(
        &r,
        repo.path(),
        authors(&["kimberly@x.com", "akim@x.com"]),
        &[],
    )
    .await;
    assert_eq!(recs.len(), 2);
    let oids: HashSet<_> = recs.iter().map(|c| c.oid).collect();
    for c in &recs {
        assert_eq!(c.parents.len(), 1);
        assert!(!oids.contains(&c.parents[0]), "부모는 걸러진 커밋이다");
    }
}

// ── 작성자 후보 ─────────────────────────────────────────────────────────────────

/// (이름, 이메일) 별 커밋 수. .mailmap 을 따르고, 상한이 있으면 최신부터 그만큼만 본다
#[tokio::test]
async fn author_counts_follow_mailmap_and_cap() {
    let mut repo = TestRepo::init();
    commit_as(&mut repo, "1", "Kim <kim@old.com>", None);
    commit_as(&mut repo, "2", "Kim <kim@x.com>", None);
    commit_as(&mut repo, "3", "Lee <lee@x.com>", None);
    commit_as(&mut repo, "4", "Kim <kim@x.com>", None);
    repo.write_file(".mailmap", "Kim <kim@x.com> <kim@old.com>\n");
    let r = runner().await;
    let sorted = |mut v: Vec<AuthorCount>| {
        v.sort_by(|a, b| a.email.cmp(&b.email));
        v.into_iter()
            .map(|a| (a.name, a.email, a.commits))
            .collect::<Vec<_>>()
    };
    let all = log_authors(&r, repo.path(), &[], None, Duration::from_secs(10))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        sorted(all),
        [
            ("Kim".to_string(), "kim@x.com".to_string(), 3),
            ("Lee".to_string(), "lee@x.com".to_string(), 1)
        ]
    );
    let newest = log_authors(&r, repo.path(), &[], Some(2), Duration::from_secs(10))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        sorted(newest),
        [
            ("Kim".to_string(), "kim@x.com".to_string(), 1),
            ("Lee".to_string(), "lee@x.com".to_string(), 1)
        ]
    );
    // 커밋이 없는 저장소는 빈 목록 (오류가 아니다)
    let empty = TestRepo::init();
    assert_eq!(
        log_authors(&r, empty.path(), &[], None, Duration::from_secs(10))
            .await
            .unwrap(),
        Some(Vec::new())
    );
}

/// 작성자 조회만 오래 잠드는 가짜 git. 나머지는 진짜 git 으로 넘긴다
fn slow_author_git(dir: &Path, real: &Path, pid_file: &Path) -> PathBuf {
    let script = dir.join("git");
    let body = format!(
        "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    --format=%aN%x00%aE) echo $$ > '{}'; exec sleep 30 ;;\n  esac\ndone\nexec '{}' \"$@\"\n",
        pid_file.display(),
        real.display()
    );
    std::fs::write(&script, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    script
}

/// 시간 상한이 지나면 `None` 이고 잠든 git 은 끝나고 거두어진다 (포함 브랜치와 같은 방식)
#[cfg(unix)]
#[tokio::test]
async fn author_list_times_out_and_reaps_the_process() {
    let mut repo = TestRepo::init();
    repo.commit("x");
    let real = runner().await.git_path().clone();
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let fake = slow_author_git(dir.path(), &real, &pid_file);
    let slow = TokioGitRunner::new(RunnerConfig {
        locate: LocateConfig {
            configured_path: Some(fake),
        },
        ..RunnerConfig::default()
    })
    .await
    .unwrap();
    let started = Instant::now();
    let got = log_authors(&slow, repo.path(), &[], None, Duration::from_millis(300))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(got, None);
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(3),
        "{elapsed:?}"
    );
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    let alive = std::process::Command::new("kill")
        .args(["-0", pid.trim()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(!alive, "시간 초과 뒤 git({}) 이 남아 돈다", pid.trim());
}
