//! 로컬 tag 목록 파서 (`for-each-ref refs/tags` 한 번, `TAG_LIST_FORMAT`). 필드는 NUL 로 나누고 레코드도 NUL 로
//! 끝낸다 — 제목에 무엇이 와도 레코드 경계가 흔들리지 않는다 (레코드 사이의 개행은 다음 refname 앞에서 버린다)

use mgit_model::{LocalTag, Oid};

/// `for-each-ref` 포맷: refname, objecttype, objectname, *objectname, creatordate(unix), subject, *subject,
/// taggername, taggeremail. 끝에 레코드 종료 NUL
pub const TAG_LIST_FORMAT: &str = "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(creatordate:unix)%00%(subject)%00%(*subject)%00%(taggername)%00%(taggeremail)%00";

/// 레코드 하나의 필드 수
const FIELDS: usize = 9;

/// 출력 전체를 tag 목록으로. 깨진 레코드는 건너뛴다
pub fn parse_tag_list(output: &[u8]) -> Vec<LocalTag> {
    let fields: Vec<&[u8]> = output.split(|&b| b == 0).collect();
    fields
        .chunks_exact(FIELDS)
        .filter_map(parse_record)
        .collect()
}

/// 레코드 하나
fn parse_record(f: &[&[u8]]) -> Option<LocalTag> {
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let refname = text(f[0]);
    let name = refname
        .trim_start_matches(['\n', '\r'])
        .strip_prefix("refs/tags/")?
        .to_string();
    let annotated = f[1] == b"tag";
    let object = Oid::from_hex(f[2]).ok()?;
    let commit = if annotated {
        Oid::from_hex(f[3]).ok()?
    } else {
        object
    };
    let date = text(f[4]).trim().parse::<i64>().ok();
    let (commit_subject, tag_subject, tagger) = if annotated {
        let name = text(f[7]);
        let email = text(f[8]);
        let tagger = match (name.is_empty(), email.is_empty()) {
            (true, true) => None,
            (false, true) => Some(name),
            (true, false) => Some(email),
            (false, false) => Some(format!("{name} {email}")),
        };
        (text(f[6]), Some(text(f[5])), tagger)
    } else {
        (text(f[5]), None, None)
    };
    Some(LocalTag {
        name,
        annotated,
        object,
        commit,
        date,
        commit_subject,
        tag_subject,
        tagger,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 40자 hex
    fn h(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[test]
    fn parses_annotated_and_lightweight() {
        let out = format!(
            "refs/tags/v1\0tag\0{t}\0{c}\01700000000\0Release v1\0feat: 첫 기능\0Kim\0<k@x>\0\nrefs/tags/light\0commit\0{c}\0\01700000060\0fix: 고침\0\0\0\0\n",
            t = h('a'),
            c = h('c'),
        );
        let tags = parse_tag_list(out.as_bytes());
        assert_eq!(tags.len(), 2, "{tags:#?}");
        assert_eq!(tags[0].name, "v1");
        assert!(tags[0].annotated);
        assert_eq!(tags[0].object.to_hex(), h('a'));
        assert_eq!(tags[0].commit.to_hex(), h('c'));
        assert_eq!(tags[0].date, Some(1_700_000_000));
        assert_eq!(tags[0].tag_subject.as_deref(), Some("Release v1"));
        assert_eq!(tags[0].commit_subject, "feat: 첫 기능");
        assert_eq!(tags[0].tagger.as_deref(), Some("Kim <k@x>"));
        assert_eq!(tags[1].name, "light");
        assert!(!tags[1].annotated);
        assert_eq!(tags[1].commit, tags[1].object);
        assert_eq!(tags[1].commit_subject, "fix: 고침");
        assert_eq!(tags[1].tag_subject, None);
        assert_eq!(tags[1].tagger, None);
    }
}
