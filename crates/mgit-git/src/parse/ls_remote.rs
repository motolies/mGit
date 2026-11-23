//! `git ls-remote --tags` 출력 파서. 한 줄은 `<oid>\t<ref>` 이고, annotated tag 는 `refs/tags/<n>^{}` 줄이
//! 벗긴 객체를 더 준다. 두 줄을 이름 하나로 합친다 (순서에 기대지 않는다). tag 가 아닌 줄·깨진 줄은 건너뛴다

use std::collections::HashMap;

use mgit_model::{Oid, RemoteTag};

/// tag 접두
const TAGS_PREFIX: &str = "refs/tags/";

/// 출력 전체를 원격 tag 목록으로. 처음 나온 순서를 지킨다
pub fn parse_ls_remote_tags(stdout: &[u8]) -> Vec<RemoteTag> {
    let text = String::from_utf8_lossy(stdout);
    let mut tags: Vec<RemoteTag> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    // `^{}` 줄이 먼저 오면 본 줄이 올 때까지 둔다
    let mut early_peeled: HashMap<String, Oid> = HashMap::new();
    for line in text.lines() {
        let Some((hex, refname)) = line.split_once('\t') else {
            continue;
        };
        let Ok(oid) = Oid::from_hex(hex.trim().as_bytes()) else {
            continue;
        };
        let Some(rest) = refname.trim_end().strip_prefix(TAGS_PREFIX) else {
            continue;
        };
        if let Some(name) = rest.strip_suffix("^{}") {
            match index.get(name) {
                Some(&i) => tags[i].peeled = Some(oid),
                None => {
                    early_peeled.insert(name.to_string(), oid);
                }
            }
            continue;
        }
        if index.contains_key(rest) {
            continue;
        }
        index.insert(rest.to_string(), tags.len());
        tags.push(RemoteTag {
            name: rest.to_string(),
            object: oid,
            peeled: early_peeled.remove(rest),
        });
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 40자 hex
    fn h(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[test]
    fn merges_peeled_lines() {
        let out = format!(
            "{a}\trefs/tags/v1\n{b}\trefs/tags/v1^{{}}\n{c}\trefs/tags/light\n{d}\trefs/heads/main\nbad line\n{e}\trefs/tags/x/y\n",
            a = h('a'),
            b = h('b'),
            c = h('c'),
            d = h('d'),
            e = h('e'),
        );
        let tags = parse_ls_remote_tags(out.as_bytes());
        assert_eq!(tags.len(), 3, "{tags:?}");
        assert_eq!(tags[0].name, "v1");
        assert_eq!(tags[0].object.to_hex(), h('a'));
        assert_eq!(tags[0].peeled.map(|o| o.to_hex()), Some(h('b')));
        assert_eq!(tags[0].commit().to_hex(), h('b'));
        assert_eq!(tags[1].name, "light");
        assert_eq!(tags[1].peeled, None);
        assert_eq!(tags[1].commit().to_hex(), h('c'));
        assert_eq!(tags[2].name, "x/y");
    }

    /// G7: 5만 줄(annotated 2만 개 = 4만 줄 + 경량 1만 개)을 정확히 합친다
    #[test]
    fn parses_fifty_thousand_lines() {
        let hex = |n: u32| format!("{n:040x}");
        let mut out = String::new();
        for i in 0..20_000u32 {
            out.push_str(&format!("{}\trefs/tags/a/{i}\n", hex(i)));
            out.push_str(&format!("{}\trefs/tags/a/{i}^{{}}\n", hex(1_000_000 + i)));
        }
        for i in 0..10_000u32 {
            out.push_str(&format!("{}\trefs/tags/l/{i}\n", hex(2_000_000 + i)));
        }
        assert_eq!(out.lines().count(), 50_000);
        let tags = parse_ls_remote_tags(out.as_bytes());
        assert_eq!(tags.len(), 30_000);
        assert_eq!(tags.iter().filter(|t| t.peeled.is_some()).count(), 20_000);
        let t = &tags[12_345];
        assert_eq!(t.name, "a/12345");
        assert_eq!(t.object.to_hex(), hex(12_345));
        assert_eq!(t.peeled.map(|o| o.to_hex()), Some(hex(1_012_345)));
        let l = &tags[29_999];
        assert_eq!(l.name, "l/9999");
        assert_eq!(l.commit().to_hex(), hex(2_009_999));
    }

    #[test]
    fn peeled_line_before_its_ref() {
        let out = format!(
            "{b}\trefs/tags/v1^{{}}\n{a}\trefs/tags/v1\n",
            a = h('a'),
            b = h('b')
        );
        let tags = parse_ls_remote_tags(out.as_bytes());
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].peeled.map(|o| o.to_hex()), Some(h('b')));
    }
}
