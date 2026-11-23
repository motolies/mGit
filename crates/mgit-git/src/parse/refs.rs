use std::path::PathBuf;

use mgit_model::{HeadState, LineFramer, Oid, RefKind, RefLabel, matching_remote};

/// `git for-each-ref` 의 필드 수:
/// refname, objectname, objecttype, *objectname, upstream, symref, upstream:track, worktreepath, HEAD
const FIELDS: usize = 9;

/// `--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(upstream)%00%(symref)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(HEAD)`
/// 출력을 라벨 목록으로 바꾼다. 레코드는 `\n` 종료, 필드는 NUL 구분.
///
/// - symref(`refs/remotes/origin/HEAD`)는 생략
/// - annotated 태그는 peeled 커밋을 target 으로 쓰고, peeled 가 없으면 생략
/// - 형식이 깨진 줄은 조용히 건너뛴다 (ref 이름에는 개행·NUL 이 올 수 없다)
pub fn parse_refs(output: &[u8], head: &HeadState) -> Vec<RefLabel> {
    let mut labels = Vec::new();
    let mut framer = LineFramer::new();
    framer.feed(output, |line| {
        if let Some(label) = parse_line(line, head) {
            labels.push(label);
        }
    });
    if let Some(rest) = framer.finish()
        && let Some(label) = parse_line(&rest, head)
    {
        labels.push(label);
    }
    labels
}

/// 원격 브랜치 라벨의 원격 이름을 등록된 원격 기준으로 고친다. `parse_refs` 는 ref 이름만 보므로
/// 첫 조각을 원격으로 가정한다 (`team/fork/main` 의 `team`). 맞는 원격이 없으면 그대로 둔다
pub fn assign_remotes(labels: &mut [RefLabel], remotes: &[String]) {
    for label in labels {
        if let RefKind::RemoteBranch { remote } = &mut label.kind
            && let Some(name) =
                matching_remote(&label.short_name, remotes.iter().map(String::as_str))
        {
            *remote = name.to_string();
        }
    }
}

/// `%(upstream:track,nobracket)` → (ahead, behind, gone). 동기 상태는 빈 문자열이다
fn parse_track(field: &[u8], has_upstream: bool) -> (Option<u32>, Option<u32>, bool) {
    let text = String::from_utf8_lossy(field);
    let text = text.trim();
    if text == "gone" {
        return (None, None, true);
    }
    if !has_upstream {
        return (None, None, false);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in text.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (Some(ahead), Some(behind), false)
}

/// 한 줄을 라벨로. 조건에 안 맞으면 `None`
fn parse_line(line: &[u8], head: &HeadState) -> Option<RefLabel> {
    let fields: Vec<&[u8]> = line.split(|&b| b == 0).collect();
    if fields.len() != FIELDS {
        return None;
    }
    let full_name = String::from_utf8_lossy(fields[0]).into_owned();
    let object_type = fields[2];
    let symref = fields[5];
    if !symref.is_empty() {
        return None;
    }
    let upstream = (!fields[4].is_empty()).then(|| String::from_utf8_lossy(fields[4]).into_owned());

    let mut tag_object = None;
    let (kind, short_name, target) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
        (
            RefKind::LocalBranch,
            name.to_string(),
            Oid::from_hex(fields[1]).ok()?,
        )
    } else if let Some(rest) = full_name.strip_prefix("refs/remotes/") {
        let remote = rest.split('/').next()?.to_string();
        (
            RefKind::RemoteBranch { remote },
            rest.to_string(),
            Oid::from_hex(fields[1]).ok()?,
        )
    } else if full_name == "refs/stash" {
        (
            RefKind::Stash,
            "stash".to_string(),
            Oid::from_hex(fields[1]).ok()?,
        )
    } else {
        // 남은 경우는 태그뿐이다. 다른 네임스페이스(refs/notes 등)는 조회하지 않는다
        let name = full_name.strip_prefix("refs/tags/")?;
        let annotated = object_type == b"tag";
        let target_field = if annotated {
            fields[3]
        } else if object_type == b"commit" {
            fields[1]
        } else {
            return None; // 블롭·트리를 가리키는 태그는 그래프에 붙일 수 없다
        };
        let target = Oid::from_hex(target_field).ok()?;
        if annotated {
            tag_object = Some(Oid::from_hex(fields[1]).ok()?);
        }
        (RefKind::Tag { annotated }, name.to_string(), target)
    };

    let (ahead, behind, upstream_gone) = parse_track(fields[6], upstream.is_some());
    let worktree_path =
        (!fields[7].is_empty()).then(|| PathBuf::from(String::from_utf8_lossy(fields[7]).as_ref()));
    let is_current =
        matches!(kind, RefKind::LocalBranch) && head.branch() == Some(full_name.as_str());
    Some(RefLabel {
        full_name,
        short_name,
        kind,
        target,
        is_current,
        upstream,
        ahead,
        behind,
        upstream_gone,
        worktree_path,
        tag_object,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_field_forms() {
        assert_eq!(parse_track(b"", true), (Some(0), Some(0), false));
        assert_eq!(parse_track(b"", false), (None, None, false));
        assert_eq!(parse_track(b"gone", true), (None, None, true));
        assert_eq!(
            parse_track(b"ahead 3, behind 2", true),
            (Some(3), Some(2), false)
        );
        assert_eq!(parse_track(b"behind 7", true), (Some(0), Some(7), false));
    }
}
