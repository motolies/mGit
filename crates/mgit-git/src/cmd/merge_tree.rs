//! `git merge-tree --write-tree` (CF-01~04): 작업 트리를 건드리지 않고 병합 결과를 계산한다

use std::path::Path;

use mgit_model::{EnvProfile, GitError, GitRequest, GitRunner, Oid};

/// merge-tree 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeTreeResult {
    /// 병합 결과 tree (충돌 파일은 마커가 든 내용)
    pub tree: Oid,
    pub clean: bool,
    /// 충돌 파일 경로
    pub conflicts: Vec<String>,
    /// 안내 메시지 (`CONFLICT (content): …` 등)
    pub messages: Vec<String>,
}

/// `-z --name-only` 출력 파서. 형식: `<tree>NUL` + (충돌이면) `<path>NUL…NUL` + `<N>NUL<path>…NUL<type>NUL<msg>NUL…`
pub fn parse_merge_tree(stdout: &[u8], clean: bool) -> Option<MergeTreeResult> {
    let text = String::from_utf8_lossy(stdout);
    let mut segs = text.split('\0');
    let tree = Oid::from_hex(segs.next()?.trim().as_bytes()).ok()?;
    if clean {
        return Some(MergeTreeResult {
            tree,
            clean: true,
            conflicts: Vec::new(),
            messages: Vec::new(),
        });
    }
    let mut conflicts = Vec::new();
    for seg in segs.by_ref() {
        if seg.is_empty() {
            break;
        }
        conflicts.push(seg.to_string());
    }
    // 메시지 레코드: N, N개 경로, 종류, 메시지
    let rest: Vec<&str> = segs.collect();
    let mut messages = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let Ok(n) = rest[i].trim().parse::<usize>() else {
            i += 1;
            continue;
        };
        let msg_idx = i + 1 + n + 1;
        if msg_idx < rest.len() {
            let m = rest[msg_idx].trim();
            if !m.is_empty() && !m.starts_with("Auto-merging") {
                messages.push(m.to_string());
            }
        }
        i = msg_idx + 1;
    }
    conflicts.sort();
    conflicts.dedup();
    Some(MergeTreeResult {
        tree,
        clean: false,
        conflicts,
        messages,
    })
}

/// 두 commit 의 병합 결과를 tree 로 계산한다. `base` 가 있으면 그 commit 을 merge-base 로 쓴다(cherry-pick 흉내).
/// `strategy` 는 `-X` 옵션 값들 (호출자가 검증)
pub async fn merge_tree(
    runner: &dyn GitRunner,
    work_tree: &Path,
    base: Option<&str>,
    ours: &str,
    theirs: &str,
    strategy: &[String],
) -> Result<MergeTreeResult, GitError> {
    let mut args: Vec<String> = vec![
        "merge-tree".into(),
        "--write-tree".into(),
        "--name-only".into(),
        "-z".into(),
    ];
    if let Some(b) = base {
        args.push(format!("--merge-base={b}"));
    }
    for s in strategy {
        args.push(format!("-X{s}"));
    }
    args.push("--end-of-options".into());
    args.push(ours.into());
    args.push(theirs.into());
    let req = GitRequest::new(work_tree, args).with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?;
    let clean = match out.exit.status {
        Some(0) => true,
        Some(1) => false,
        _ => {
            return Err(GitError::Exit {
                status: out.exit.status,
                stderr: out.exit.stderr,
                args: display,
            });
        }
    };
    parse_merge_tree(&out.stdout, clean).ok_or_else(|| GitError::Exit {
        status: out.exit.status,
        stderr: mgit_l10n::pick(
            "merge-tree 출력을 해석할 수 없습니다",
            "Cannot parse merge-tree output",
        )
        .into(),
        args: display,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_and_conflict_output() {
        let tree = "a".repeat(40);
        let clean = parse_merge_tree(format!("{tree}\0").as_bytes(), true).unwrap();
        assert!(clean.clean && clean.conflicts.is_empty());
        let out = format!(
            "{tree}\0f\0g\0\x001\0f\0Auto-merging\0Auto-merging f\n\x001\0f\0CONFLICT (contents)\0CONFLICT (content): Merge conflict in f\n\x002\0g\0h\0CONFLICT (rename/delete)\0CONFLICT (rename/delete): g\n\0"
        );
        let r = parse_merge_tree(out.as_bytes(), false).unwrap();
        assert!(!r.clean);
        assert_eq!(r.conflicts, vec!["f", "g"]);
        assert_eq!(
            r.messages,
            vec![
                "CONFLICT (content): Merge conflict in f",
                "CONFLICT (rename/delete): g"
            ]
        );
    }
}
