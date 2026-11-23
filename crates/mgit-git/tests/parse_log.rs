//! `git log -z` 파서 테스트. fixture 는 testkit 으로 만든 실제 출력이며
//! `MGIT_REGEN_FIXTURES=1 cargo test -p mgit-git --test parse_log -- --ignored` 로 재생성한다.
#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use mgit_git::parse::LogParser;
use mgit_model::{CommitRecord, ParseError};
use mgit_testkit::{GRAPH_LOG_ARGS, Scenario, build};
use proptest::prelude::*;

/// fixture 디렉터리
fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/log")
}

/// fixture 이름 → 시나리오
const FIXTURES: &[(&str, Scenario)] = &[
    ("linear", Scenario::Linear(3)),
    ("branch_merge", Scenario::BranchMerge),
    ("octopus", Scenario::Octopus),
    ("orphan", Scenario::Orphan),
    ("korean", Scenario::Korean),
    ("empty_message", Scenario::EmptyMessage),
];

/// 전체를 한 번에 파싱한다
fn parse_all(bytes: &[u8]) -> Result<Vec<CommitRecord>, ParseError> {
    let mut p = LogParser::new();
    let recs = p.feed(bytes)?;
    p.finish()?;
    Ok(recs)
}

/// fixture 를 읽는다. 없으면 안내 메시지와 함께 실패
fn load(name: &str) -> Vec<u8> {
    let path = fixture_dir().join(format!("{name}.bin"));
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "fixture 없음: {}. MGIT_REGEN_FIXTURES=1 로 --ignored 테스트를 실행해 생성",
            path.display()
        )
    })
}

#[test]
#[ignore = "fixture 재생성 전용"]
fn regenerate_fixtures() {
    if std::env::var("MGIT_REGEN_FIXTURES").is_err() {
        return;
    }
    std::fs::create_dir_all(fixture_dir()).unwrap();
    for (name, scenario) in FIXTURES {
        let mut repo = build(*scenario);
        let bytes = repo.git_bytes(GRAPH_LOG_ARGS);
        std::fs::write(fixture_dir().join(format!("{name}.bin")), bytes).unwrap();
    }
}

#[test]
fn fixtures_snapshot() {
    for (name, _) in FIXTURES {
        let recs = parse_all(&load(name)).unwrap();
        insta::assert_debug_snapshot!(*name, recs);
    }
}

#[test]
fn record_count_matches_nul_count() {
    // 레코드 = NUL 7개 (실측 근거)
    let bytes = load("branch_merge");
    let nuls = bytes.iter().filter(|&&b| b == 0).count();
    let recs = parse_all(&bytes).unwrap();
    assert_eq!(nuls, recs.len() * 7);
    assert_eq!(recs.len(), 4);
}

#[test]
fn root_commit_has_no_parents_and_octopus_has_three() {
    let recs = parse_all(&load("octopus")).unwrap();
    assert_eq!(recs[0].parents.len(), 3);
    assert!(recs.last().unwrap().parents.is_empty());
}

#[test]
fn empty_message_is_kept_as_empty_field() {
    let recs = parse_all(&load("empty_message")).unwrap();
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[0].subject, "");
    assert_eq!(recs[1].subject, "first");
}

#[test]
fn korean_is_preserved_without_normalization() {
    let recs = parse_all(&load("korean")).unwrap();
    let nfd = recs
        .iter()
        .find(|r| r.subject.contains('\u{1112}'))
        .unwrap();
    assert!(nfd.subject.starts_with("\u{1112}\u{1161}\u{11AB}글"));
    assert!(recs.iter().any(|r| r.subject == "첫 커밋 (NFC 한글)"));
}

#[test]
fn format_without_terminator_is_truncated() {
    // `--pretty=format:` 처럼 마지막 종료자가 없으면 Truncated
    let mut bytes = load("linear");
    bytes.pop();
    let mut p = LogParser::new();
    p.feed(&bytes).unwrap();
    assert!(matches!(
        p.finish(),
        Err(ParseError::Truncated { fields_seen: 6 })
    ));
}

#[test]
fn bad_hash_is_desync() {
    let mut bytes = load("linear");
    bytes[0] = b'z';
    assert!(matches!(
        parse_all(&bytes),
        Err(ParseError::Desync { record: 0 })
    ));
}

/// 날짜가 비정상인 커밋 하나로 그래프 전체가 실패하면 안 되므로 그 값만 0 으로 둔다
#[test]
fn bad_timestamps_become_zero() {
    let rec = b"ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901\0\0A\0a@x\0notanumber\x001\0msg\0";
    let recs = parse_all(rec).unwrap();
    assert_eq!((recs[0].author_time, recs[0].commit_time), (0, 1));

    // 날짜가 없는 author 줄(빈 값)과 i64 를 넘는 값
    let rec = b"ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901\0\0A\0a@x\0\099999999999999999999\0msg\0";
    let recs = parse_all(rec).unwrap();
    assert_eq!((recs[0].author_time, recs[0].commit_time), (0, 0));
}

#[test]
fn duplicate_parents_are_removed() {
    let rec = b"ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901\0\
0000000000000000000000000000000000000001 0000000000000000000000000000000000000001\0\
A\0a@x\x001\x002\0msg\0";
    let recs = parse_all(rec).unwrap();
    assert_eq!(recs[0].parents.len(), 1);
}

#[test]
fn latin1_author_is_lossy() {
    let rec = b"ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901\0\0J\xf6rg\0j@x\x001\x002\0msg\0";
    let recs = parse_all(rec).unwrap();
    assert_eq!(recs[0].author_name, "J\u{FFFD}rg");
}

proptest! {
    /// 임의 분할로 feed 해도 일괄 파싱과 같다
    #[test]
    fn any_split_equals_whole(cuts in proptest::collection::vec(0usize..2000, 0..10)) {
        let bytes = load("branch_merge");
        let whole = parse_all(&bytes).unwrap();
        let mut sorted = cuts;
        sorted.sort_unstable();
        let mut p = LogParser::new();
        let mut out = Vec::new();
        let mut prev = 0;
        for c in sorted {
            let c = c.min(bytes.len()).max(prev);
            out.extend(p.feed(&bytes[prev..c]).unwrap());
            prev = c;
        }
        out.extend(p.feed(&bytes[prev..]).unwrap());
        p.finish().unwrap();
        prop_assert_eq!(out, whole);
    }
}
