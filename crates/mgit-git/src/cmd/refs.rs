use std::path::Path;

use mgit_model::{GitError, GitRequest, GitRunner, HeadState, RefKind, RefLabel};

use crate::parse::{assign_remotes, parse_refs};

/// `for-each-ref` 포맷. 필드 구분은 NUL, 레코드는 개행.
/// `upstream:track,nobracket` 은 동기 상태면 빈 문자열, `gone`, 아니면 `ahead N, behind M`
pub const REFS_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(upstream)%00%(symref)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(HEAD)";

/// 로컬·원격 브랜치와 태그 라벨을 읽는다
pub async fn list_refs(
    runner: &dyn GitRunner,
    work_tree: &Path,
    head: &HeadState,
) -> Result<Vec<RefLabel>, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "for-each-ref",
            REFS_FORMAT,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
        ],
    );
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    let mut labels = parse_refs(&out, head);
    if labels
        .iter()
        .any(|l| matches!(l.kind, RefKind::RemoteBranch { .. }))
    {
        assign_remotes(&mut labels, &remote_names(runner, work_tree).await);
    }
    Ok(labels)
}

/// 등록된 원격 이름 (`git remote`). 실패하면 빈 목록
async fn remote_names(runner: &dyn GitRunner, work_tree: &Path) -> Vec<String> {
    match runner.run(GitRequest::new(work_tree, ["remote"])).await {
        Ok(out) if out.exit.success() => out.stdout_lossy().lines().map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// 로컬 tag 이름(`refs/tags/` 뒤) → 그 ref 가 가리키는 객체(annotated 면 tag 객체). 원격 tag 와 비교·삭제 검증에 쓴다
pub async fn tag_objects(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<std::collections::HashMap<String, mgit_model::Oid>, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            "refs/tags",
        ],
    );
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    let mut map = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out).lines() {
        if let Some((name, oid)) = line.split_once('\0')
            && let Some(tag) = name.strip_prefix("refs/tags/")
            && let Ok(oid) = mgit_model::Oid::from_hex(oid.trim().as_bytes())
        {
            map.insert(tag.to_string(), oid);
        }
    }
    Ok(map)
}

/// 로컬 tag 목록 (TG-10 열·툴팁): `for-each-ref` 한 번으로 종류·날짜·commit 제목·tag 제목·tagger 를 읽는다
pub async fn tag_list(
    runner: &dyn GitRunner,
    work_tree: &Path,
) -> Result<Vec<mgit_model::LocalTag>, GitError> {
    let req = GitRequest::new(
        work_tree,
        ["for-each-ref", crate::parse::TAG_LIST_FORMAT, "refs/tags"],
    );
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    Ok(crate::parse::parse_tag_list(&out))
}
