use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use mgit_model::{
    CancelToken, CommitFilter, EnvProfile, GitError, GitRequest, GitRunner, GraphQuery, GraphRevs,
    GraphSort,
};

use super::contains::CANCEL_SETTLE;

/// 그래프 로드용 `git log` 포맷 (명세 2.3). 필드는 `%x00`, 레코드는 `-z` 로 NUL 종료
pub const GRAPH_LOG_FORMAT: &str = "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s";

/// 작성자 후보 조회 포맷: 이름·이메일(.mailmap 적용). `-z` 와 함께 커밋마다 `이름 NUL 이메일 NUL`
pub const AUTHOR_LOG_FORMAT: &str = "--format=%aN%x00%aE";

/// POSIX 확장 정규식(ERE)에서 뜻을 갖는 글자. `]`·`}` 는 대괄호·구간 밖에서는 평범한 글자라 두고,
/// 나머지는 앞에 `\` 를 붙여 글자 그대로 맞춘다 (git 2.54 에서 확인)
const ERE_SPECIAL: &[char] = &['\\', '.', '[', '(', ')', '*', '+', '?', '{', '|', '^', '$'];

/// 글자를 ERE 에서 글자 그대로 맞는 패턴으로 바꾼다
fn ere_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if ERE_SPECIAL.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// 작성자 이메일 하나를 `--author` 패턴으로 바꾼다: `<이메일>` 전체가 같아야 맞고(이름의 부분 문자열이나
/// `kim@x` 와 `akim@x` 처럼 이메일의 일부로는 맞지 않는다), ASCII 글자는 `[Kk]` 로 대소문자를 무시한다.
/// `-i` 를 텍스트 필터에만 쓰기 위해 작성자 쪽 대소문자 무시는 패턴으로 낸다 (`-i` 는 모든 패턴에 걸린다)
fn author_pattern(email: &str) -> String {
    let mut out = String::with_capacity(email.len() * 4 + 2);
    out.push('<');
    for c in email.chars() {
        if c.is_ascii_alphabetic() {
            out.push('[');
            out.push(c.to_ascii_uppercase());
            out.push(c.to_ascii_lowercase());
            out.push(']');
        } else {
            if ERE_SPECIAL.contains(&c) {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out.push('>');
    out
}

/// 시각 하나를 git 날짜 인자로: `@<epoch> +0000` (git 객체 헤더와 같은 꼴이라 로캘·시간대와 무관하다).
/// 음수는 0 으로 맞춘다 (git 은 1970 이전 커밋 시각을 갖지 않는다)
fn date_arg(option: &str, epoch: i64) -> String {
    format!("{option}=@{} +0000", epoch.max(0))
}

/// 커밋 필터 → `git log` 인자 (단일 저장소 그래프·통합 타임라인·필터 검증 공용). 필터가 없으면 빈 목록이다.
///
/// - 패턴이 하나라도 있으면 `-E`(ERE): 글자 그대로의 텍스트도 직접 이스케이프해 같은 문법으로 맞춘다.
///   `-F`(글자 그대로)는 `--author` 패턴까지 글자 그대로로 바꿔 이메일 전체 일치를 낼 수 없어 쓰지 않는다.
/// - 텍스트가 있고 대소문자를 구분하지 않으면 `-i` (작성자 패턴은 스스로 대소문자를 무시한다).
/// - 작성자: `--use-mailmap` + `--author=<이메일>` 여럿. 여럿은 OR, 텍스트와는 AND 다 (git 규칙).
///   `--use-mailmap` 은 사용자의 `log.mailmap` 설정과 무관하게 후보 목록(`%aE`, 늘 .mailmap 적용)과 맞춘다.
/// - 텍스트: `--grep=<패턴>` 한 개 (`=` 로 붙여 `-` 로 시작해도 옵션으로 읽히지 않는다). 본문까지 찾는다.
/// - 날짜: `--since-as-filter`(커밋 시각 하한, 포함)·`--until`(상한, 포함). `--since` 는 커밋 시각이
///   어긋난 커밋을 만나면 거기서 걷기를 멈춰 그 아래의 맞는 커밋을 놓치므로 쓰지 않는다
pub fn filter_args(filter: &CommitFilter) -> Vec<String> {
    let mut args = Vec::new();
    let text = filter.has_text();
    if text || !filter.authors.is_empty() {
        args.push("-E".to_string());
    }
    if text && !filter.text.match_case {
        args.push("-i".to_string());
    }
    if !filter.authors.is_empty() {
        args.push("--use-mailmap".to_string());
        for email in &filter.authors {
            args.push(format!("--author={}", author_pattern(email)));
        }
    }
    if text {
        let pattern = if filter.text.regex {
            filter.text.pattern.clone()
        } else {
            ere_escape(&filter.text.pattern)
        };
        args.push(format!("--grep={pattern}"));
    }
    if let Some(since) = filter.since {
        args.push(date_arg("--since-as-filter", since));
    }
    if let Some(until) = filter.until {
        args.push(date_arg("--until", until));
    }
    args
}

/// 토폴로지 순서 로그 요청. notes·백업·replace ref 는 제외하고 `query` 로 ref·원격·경로 범위를 좁힌다 (GRAPH-08, MOD-03).
/// `refs/replace/*` 는 대체 객체를 가리킬 뿐이라 팁으로 넣으면 ref 없는 유령 행이 생긴다 (대체 자체는 그대로 적용된다).
/// `overrides` 는 `-c key=value` 로 앞에 붙는다 (벤치에서 `core.commitGraph=false` 등)
pub fn graph_log_request(
    work_tree: &Path,
    overrides: &[(String, String)],
    query: &GraphQuery,
) -> GitRequest {
    graph_log_request_with(work_tree, overrides, query, None)
}

/// `graph_log_request` 에 개수 상한(`--max-count`)을 더한 것. 통합 타임라인(MR-12)이 저장소마다 쓴다
pub fn graph_log_request_with(
    work_tree: &Path,
    overrides: &[(String, String)],
    query: &GraphQuery,
    max_count: Option<u32>,
) -> GitRequest {
    // 옵션은 모두 `--end-of-options` 앞에, ref 는 그 뒤에, 경로는 `--` 뒤에 둔다.
    // `--` 는 경로가 없어도 붙인다. 없으면 작업 트리 폴더와 이름이 같은 브랜치를 git 이 모호하다고 거부한다
    let mut args: Vec<String> = [
        "log",
        "--exclude=refs/notes/*",
        "--exclude=refs/mgit/*",
        "--exclude=refs/replace/*",
        match query.sort {
            GraphSort::Topo => "--topo-order",
            GraphSort::Date => "--date-order",
        },
        "--no-show-signature",
        "--no-color",
        "--encoding=UTF-8",
        "-z",
        GRAPH_LOG_FORMAT,
    ]
    .map(String::from)
    .to_vec();
    if let Some(n) = max_count {
        args.push(format!("--max-count={n}"));
    }
    if query.first_parent {
        args.push("--first-parent".into());
    }
    if query.no_merges {
        args.push("--no-merges".into());
    }
    if query.hide_remotes {
        args.push("--exclude=refs/remotes/*".into());
    }
    if !query.path_scope.is_empty() {
        // 경로 범위: 부모를 재작성해(--parents) 범위 밖 커밋을 건너뛴 조상으로 잇는다
        args.push("--full-history".into());
        args.push("--parents".into());
    }
    // 커밋 필터 (필터가 없으면 아무것도 붙지 않아 인자가 필터 이전과 같다)
    args.extend(filter_args(&query.filter));
    match &query.revs {
        GraphRevs::All => args.push("--all".into()),
        GraphRevs::Branches { names } => {
            args.push("--end-of-options".into());
            args.extend(names.iter().cloned());
        }
        GraphRevs::Solo { name } => {
            args.push("--end-of-options".into());
            args.push(name.clone());
        }
        // HEAD 가 없으면(unborn) git 이 거부한다. 호출자가 먼저 걸러야 한다
        GraphRevs::Head => {
            args.push("--end-of-options".into());
            args.push("HEAD".into());
        }
    }
    args.push("--".into());
    args.extend(query.path_scope.iter().cloned());
    let mut req = GitRequest::new(work_tree, args);
    // 경로 범위는 사용자가 입력하는 읽기 전용 필터라 글롭을 그대로 쓴다 (글자 그대로의 경로도 맞는다)
    if !query.path_scope.is_empty() {
        req = req.with_env_var("GIT_LITERAL_PATHSPECS", "0");
    }
    for (k, v) in overrides {
        req = req.with_config(k, v);
    }
    req
}

/// git 이 필터의 패턴을 받아들이는지 미리 본다: `git log --max-count=0 --all <필터 인자>` 는 커밋을 하나도
/// 걷지 않고 패턴만 컴파일한다(잘못된 정규식이면 종료 코드 128, `fatal: command line, '(': …`).
/// 거부하면 git 의 문구(`fatal: ` 를 뗀 첫 줄)를 돌려준다. git 을 실행하지 못했으면 `None` — 판단을 미루고
/// 실제 로드가 원인을 알려 준다
pub async fn filter_rejection(
    runner: &dyn GitRunner,
    work_tree: &Path,
    filter: &CommitFilter,
) -> Option<String> {
    let mut args = vec!["log".to_string(), "--max-count=0".to_string()];
    args.extend(filter_args(filter));
    args.push("--all".to_string());
    args.push("--".to_string());
    let req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadInteractive);
    let out = runner.run(req).await.ok()?;
    if out.exit.success() {
        return None;
    }
    let first = out.exit.stderr.lines().next().unwrap_or_default().trim();
    Some(first.strip_prefix("fatal: ").unwrap_or(first).to_string())
}

/// 작성자 하나의 커밋 수 (이름·이메일이 글자 그대로 같은 것끼리)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorCount {
    pub name: String,
    pub email: String,
    pub commits: u32,
}

/// 작성자 후보 조회 요청: 그래프와 같은 범위(모든 ref, notes·백업·replace 제외)의 커밋 작성자.
/// `max_count` 가 있으면 최신 커밋부터 그만큼만(`--date-order`, 통합 타임라인의 저장소당 범위와 같다)
pub fn author_log_request(
    work_tree: &Path,
    overrides: &[(String, String)],
    max_count: Option<u32>,
) -> GitRequest {
    let mut args: Vec<String> = [
        "log",
        "--exclude=refs/notes/*",
        "--exclude=refs/mgit/*",
        "--exclude=refs/replace/*",
        "--all",
        "--no-show-signature",
        "--no-color",
        "--encoding=UTF-8",
        "-z",
        AUTHOR_LOG_FORMAT,
    ]
    .map(String::from)
    .to_vec();
    if let Some(n) = max_count {
        args.push("--date-order".into());
        args.push(format!("--max-count={n}"));
    }
    args.push("--".into());
    let mut req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadInteractive);
    for (k, v) in overrides {
        req = req.with_config(k, v);
    }
    req
}

/// `AUTHOR_LOG_FORMAT` + `-z` 출력을 (이름, 이메일) 별 커밋 수로 센다. 순서는 처음 나온 차례다
pub fn parse_author_log(output: &[u8]) -> Vec<AuthorCount> {
    // 커밋마다 `이름 NUL 이메일 NUL` 이다. 끝의 NUL 을 떼고 나누면 이름·이메일이 번갈아 나온다
    let body = output.strip_suffix(&[0]).unwrap_or(output);
    if body.is_empty() {
        return Vec::new();
    }
    let fields: Vec<&[u8]> = body.split(|&b| b == 0).collect();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    let mut out: Vec<AuthorCount> = Vec::new();
    let (pairs, _) = fields.as_chunks::<2>();
    for &[name, email] in pairs {
        let key = (
            String::from_utf8_lossy(name).into_owned(),
            String::from_utf8_lossy(email).into_owned(),
        );
        match index.get(&key) {
            Some(&i) => out[i].commits += 1,
            None => {
                index.insert(key.clone(), out.len());
                out.push(AuthorCount {
                    name: key.0,
                    email: key.1,
                    commits: 1,
                });
            }
        }
    }
    out
}

/// 작성자 후보를 읽는다 (`author_log_request`). `limit` 안에 끝나지 않으면 프로세스를 끝내고 `Ok(None)`
/// (포함 브랜치와 같은 시간 상한·취소 방식). 커밋이 없는 저장소는 빈 목록이다
pub async fn log_authors(
    runner: &dyn GitRunner,
    work_tree: &Path,
    overrides: &[(String, String)],
    max_count: Option<u32>,
    limit: Duration,
) -> Result<Option<Vec<AuthorCount>>, GitError> {
    let cancel = CancelToken::new();
    let req = author_log_request(work_tree, overrides, max_count).with_cancel(cancel.clone());
    let work = async move {
        let display = req.display_args();
        let stdout = runner.run(req).await?.ok(&display)?;
        Ok::<_, GitError>(parse_author_log(&stdout))
    };
    tokio::pin!(work);
    tokio::select! {
        done = &mut work => done.map(Some),
        () = tokio::time::sleep(limit) => {
            cancel.cancel();
            // 러너가 프로세스를 끝내고 거둘 때까지 기다린다. 취소 직전에 끝났으면 그 결과를 쓴다
            match tokio::time::timeout(CANCEL_SETTLE, &mut work).await {
                Ok(Ok(found)) => Ok(Some(found)),
                _ => Ok(None),
            }
        }
    }
}

/// rev 표현이 지금 저장소에서 풀리는지 (`a..b` 같은 범위도 받는다). git 을 실행하지 못했으면 판단을
/// 미루고 `true` 를 돌려준다. 실제 원인은 뒤따르는 `git log` 가 알려 준다
pub async fn rev_resolves(runner: &dyn GitRunner, work_tree: &Path, rev: &str) -> bool {
    let req = GitRequest::new(
        work_tree,
        ["rev-list", "--max-count=0", "--end-of-options", rev, "--"],
    );
    match runner.run(req).await {
        Ok(out) => out.exit.success(),
        Err(_) => true,
    }
}
