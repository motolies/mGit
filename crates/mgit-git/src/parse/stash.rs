use mgit_model::{Oid, StashInfo};

/// 레코드 하나의 필드 수: `%gd %H %P %gs %s %ct`
const FIELDS: usize = 6;

/// `git stash list -z --format=%gd%x00%H%x00%P%x00%gs%x00%s%x00%ct` 출력을 파싱한다.
/// tformat 이라 레코드마다 종료자 NUL 이 붙어 **레코드 = NUL 종료 필드 6개**다
pub fn parse_stash_list(output: &[u8]) -> Vec<StashInfo> {
    let mut fields: Vec<&[u8]> = output.split(|&b| b == 0).collect();
    if fields.last().is_some_and(|f| f.is_empty()) {
        fields.pop();
    }
    // 끝에 남는 불완전한 레코드(필드 6개 미만)는 버린다
    let (records, _) = fields.as_chunks::<FIELDS>();
    records.iter().filter_map(parse_record).collect()
}

/// 필드 6개를 항목으로. 길이가 타입에 있어 인덱스가 범위를 벗어나지 않는다
fn parse_record(f: &[&[u8]; FIELDS]) -> Option<StashInfo> {
    let selector = std::str::from_utf8(f[0]).ok()?;
    let index = selector
        .strip_prefix("stash@{")?
        .strip_suffix('}')?
        .parse()
        .ok()?;
    let oid = Oid::from_hex(f[1]).ok()?;
    let parents: Vec<Oid> = f[2]
        .split(|&b| b == b' ')
        .filter(|p| !p.is_empty())
        .filter_map(|p| Oid::from_hex(p).ok())
        .collect();
    let message = String::from_utf8_lossy(f[3]).into_owned();
    let time = std::str::from_utf8(f[5]).ok()?.trim().parse().ok()?;
    Some(StashInfo {
        index,
        oid,
        base: parents.first().copied(),
        branch: StashInfo::branch_from_message(&message),
        message,
        time,
        includes_untracked: parents.len() >= 3,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_records_and_untracked_flag() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let d = "d".repeat(40);
        let out = format!(
            "stash@{{0}}\0{a}\0{b} {c} {d}\0WIP on main: {} x\0subj\01700000000\0stash@{{1}}\0{b}\0{c} {d}\0On feature: msg\0msg\01700000060\0",
            &b[..7]
        );
        let list = parse_stash_list(out.as_bytes());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert!(list[0].includes_untracked);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].base.map(|o| o.to_hex()), Some(b.clone()));
        assert!(!list[1].includes_untracked);
        assert_eq!(list[1].time, 1_700_000_060);
    }

    #[test]
    fn empty_output_has_no_entries() {
        assert!(parse_stash_list(b"").is_empty());
    }
}
