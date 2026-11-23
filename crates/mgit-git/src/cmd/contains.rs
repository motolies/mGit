//! 커밋을 포함하는 브랜치 (CD-03): `for-each-ref --contains` 와 HEAD 포함 여부.
//!
//! 브랜치·원격 브랜치 수가 많으면 느릴 수 있어 시간 상한을 둔다. 상한이 지나면 요청의 취소 토큰을
//! 취소하고, 러너가 프로세스(그룹)를 SIGTERM → (grace 뒤) SIGKILL 로 끝내고 거둘 때까지 기다린 뒤
//! "시간 초과"(`None`)를 돌려준다

use std::path::Path;
use std::time::Duration;

use mgit_model::{CancelToken, GitError, GitRequest, GitRunner, LineFramer, Oid};

/// `for-each-ref --contains` 포맷. 필드 구분은 NUL, 레코드는 개행 (ref 이름에는 둘 다 올 수 없다).
/// `%(HEAD)` 는 HEAD 가 가리키는 브랜치면 `*`, `%(symref)` 는 심볼릭 ref(`origin/HEAD`)의 대상이다
pub const CONTAINS_FORMAT: &str = "--format=%(refname)%00%(HEAD)%00%(symref)";

/// 상한이 지나 취소한 뒤 러너가 프로세스를 끝내고 거두기를 기다리는 상한. 러너의 기본 grace
/// (SIGTERM 뒤 SIGKILL 까지 2초)보다 길다. 읽기 permit 을 기다리던 중이라 프로세스가 아직 없으면
/// 이 시간 뒤 future 를 버린다
pub(super) const CANCEL_SETTLE: Duration = Duration::from_secs(3);

/// `for-each-ref` 레코드의 필드 수: refname, HEAD, symref
const FIELDS: usize = 3;

/// 커밋을 포함하는 브랜치 하나
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainingBranch {
    /// 전체 ref 이름 (`refs/heads/…`, `refs/remotes/…`)
    pub full_name: String,
    /// 화면용 짧은 이름: 로컬은 `refs/heads/` 뒤, 원격은 `refs/remotes/` 뒤(`origin/main`)
    pub short_name: String,
    /// 원격 추적 브랜치인지
    pub remote: bool,
    /// HEAD 가 가리키는 현재 브랜치인지 (이 작업 트리의 HEAD 기준)
    pub current: bool,
}

/// 포함 브랜치 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Containing {
    /// HEAD(브랜치든 분리 HEAD 든)에서 그 커밋에 닿는지
    pub head: bool,
    /// git 이 준 순서(ref 이름순)의 로컬·원격 브랜치. 원격 `HEAD` 같은 심볼릭 ref 는 뺀다
    pub branches: Vec<ContainingBranch>,
}

/// `CONTAINS_FORMAT` 출력을 브랜치 목록으로 바꾼다. 심볼릭 ref(`refs/remotes/origin/HEAD`)와 형식이
/// 깨진 줄, `refs/heads/`·`refs/remotes/` 밖의 ref 는 건너뛴다. 이름은 lossy UTF-8 로 읽는다
pub fn parse_containing(output: &[u8]) -> Vec<ContainingBranch> {
    let mut branches = Vec::new();
    let mut framer = LineFramer::new();
    framer.feed(output, |line| {
        if let Some(b) = parse_line(line) {
            branches.push(b);
        }
    });
    if let Some(rest) = framer.finish()
        && let Some(b) = parse_line(&rest)
    {
        branches.push(b);
    }
    branches
}

/// 한 줄을 브랜치로. 조건에 안 맞으면 `None`
fn parse_line(line: &[u8]) -> Option<ContainingBranch> {
    let fields: Vec<&[u8]> = line.split(|&b| b == 0).collect();
    if fields.len() != FIELDS || !fields[2].is_empty() {
        return None;
    }
    let full_name = String::from_utf8_lossy(fields[0]).into_owned();
    let (short_name, remote) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
        (name.to_string(), false)
    } else {
        (full_name.strip_prefix("refs/remotes/")?.to_string(), true)
    };
    if short_name.is_empty() {
        return None;
    }
    Some(ContainingBranch {
        current: !remote && fields[1] == b"*",
        full_name,
        short_name,
        remote,
    })
}

/// `oid` 를 포함하는 로컬·원격 브랜치와 HEAD 포함 여부를 읽는다. 태그는 보지 않는다.
/// `overrides` 는 요청마다 붙이는 `-c key=value` (벤치의 `core.commitGraph=false` 등).
///
/// git 은 `for-each-ref --contains` 한 번이고, 현재 브랜치가 목록에 없을 때만(HEAD 가 다른 브랜치·분리
/// HEAD·unborn) `merge-base --is-ancestor <oid> HEAD` 를 한 번 더 돈다. 둘을 합쳐 `limit` 안에 끝나지
/// 않으면 프로세스를 끝내고 `Ok(None)` 이다. 그 저장소에 없는 커밋은 git 오류(`no such commit`)다
pub async fn containing_branches(
    runner: &dyn GitRunner,
    work_tree: &Path,
    overrides: &[(String, String)],
    oid: &Oid,
    limit: Duration,
) -> Result<Option<Containing>, GitError> {
    containing_branches_with(
        runner,
        work_tree,
        overrides,
        oid,
        limit,
        &CancelToken::new(),
    )
    .await
}

/// `containing_branches` 에 호출자의 취소 토큰을 단 것 (W18: 같은 세션의 새 요청이 앞 요청을 끝낸다).
/// 두 요청 모두 이 토큰으로 돈다 — 호출자가 취소하면 러너가 도는 git 을 끝내고 거둔 뒤 `GitError::Cancelled` 다.
/// 시간 상한이 지나면 이 함수가 같은 토큰을 취소하고 `Ok(None)` 이다
pub async fn containing_branches_with(
    runner: &dyn GitRunner,
    work_tree: &Path,
    overrides: &[(String, String)],
    oid: &Oid,
    limit: Duration,
    cancel: &CancelToken,
) -> Result<Option<Containing>, GitError> {
    let work = read_containing(runner, work_tree, overrides, oid, cancel);
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

/// 취소 토큰을 단 두 요청으로 포함 브랜치와 HEAD 포함 여부를 읽는다
async fn read_containing(
    runner: &dyn GitRunner,
    work_tree: &Path,
    overrides: &[(String, String)],
    oid: &Oid,
    cancel: &CancelToken,
) -> Result<Containing, GitError> {
    let hex = oid.to_hex();
    // `--contains=<hex>` 로 붙여 써서 값이 옵션으로 읽힐 여지를 없앤다 (hex 는 `-` 로 시작하지 않는다)
    let req = with_overrides(
        GitRequest::new(
            work_tree,
            [
                "for-each-ref".to_string(),
                format!("--contains={hex}"),
                CONTAINS_FORMAT.to_string(),
                "refs/heads".to_string(),
                "refs/remotes".to_string(),
            ],
        ),
        overrides,
    )
    .with_cancel(cancel.clone());
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    let branches = parse_containing(&out);
    let head = branches.iter().any(|b| b.current)
        || head_reaches(runner, work_tree, overrides, &hex, cancel).await?;
    Ok(Containing { head, branches })
}

/// HEAD 에서 커밋에 닿는지 (`merge-base --is-ancestor`). 종료 코드 0 = 닿는다, 1 = 안 닿는다.
/// 그 밖(HEAD 를 풀 수 없는 unborn 등, 128)은 "안 닿는다"로 본다
async fn head_reaches(
    runner: &dyn GitRunner,
    work_tree: &Path,
    overrides: &[(String, String)],
    hex: &str,
    cancel: &CancelToken,
) -> Result<bool, GitError> {
    let req = with_overrides(
        GitRequest::new(work_tree, ["merge-base", "--is-ancestor", hex, "HEAD"]),
        overrides,
    )
    .with_cancel(cancel.clone());
    Ok(runner.run(req).await?.exit.success())
}

/// 요청에 `-c key=value` 를 붙인다
fn with_overrides(mut req: GitRequest, overrides: &[(String, String)]) -> GitRequest {
    for (k, v) in overrides {
        req = req.with_config(k, v);
    }
    req
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 손으로 만든 출력 한 줄
    fn line(refname: &str, head: &str, symref: &str) -> Vec<u8> {
        format!("{refname}\0{head}\0{symref}\n").into_bytes()
    }

    #[test]
    fn parses_locals_remotes_and_current() {
        let mut out = Vec::new();
        out.extend(line("refs/heads/main", "*", ""));
        out.extend(line("refs/heads/기능/한글 이름", " ", ""));
        out.extend(line("refs/remotes/origin/feature/x", " ", ""));
        let got = parse_containing(&out);
        assert_eq!(
            got,
            vec![
                ContainingBranch {
                    full_name: "refs/heads/main".into(),
                    short_name: "main".into(),
                    remote: false,
                    current: true,
                },
                ContainingBranch {
                    full_name: "refs/heads/기능/한글 이름".into(),
                    short_name: "기능/한글 이름".into(),
                    remote: false,
                    current: false,
                },
                ContainingBranch {
                    full_name: "refs/remotes/origin/feature/x".into(),
                    short_name: "origin/feature/x".into(),
                    remote: true,
                    current: false,
                },
            ]
        );
    }

    #[test]
    fn skips_symrefs_tags_and_broken_lines() {
        let mut out = Vec::new();
        out.extend(line(
            "refs/remotes/origin/HEAD",
            " ",
            "refs/remotes/origin/main",
        ));
        out.extend(line("refs/tags/v1", " ", ""));
        out.extend(b"refs/heads/only-one-field\n");
        out.extend(line("refs/heads/", " ", ""));
        // 마지막 줄은 개행 없이 끝나도 읽는다
        out.extend(b"refs/remotes/upstream/main\0 \0");
        let got = parse_containing(&out);
        assert_eq!(
            got.iter()
                .map(|b| b.short_name.as_str())
                .collect::<Vec<_>>(),
            vec!["upstream/main"]
        );
        assert!(got[0].remote && !got[0].current);
    }

    #[test]
    fn remote_refs_are_never_current() {
        // `%(HEAD)` 는 로컬 브랜치에만 붙지만, 붙어 와도 원격은 현재 브랜치로 보지 않는다
        let got = parse_containing(&line("refs/remotes/origin/main", "*", ""));
        assert!(!got[0].current);
    }

    #[test]
    fn empty_output_is_empty() {
        assert!(parse_containing(b"").is_empty());
    }
}
