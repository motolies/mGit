//! 충돌 블록 분류·자동 결합 (CF-15)·내용 유사도 (CF-16).
//! git 과 같은 histogram diff(imara-diff)로 base↔ours·base↔theirs 의 hunk 를 비교한다

use std::ops::Range;

use imara_diff::{Algorithm, Diff, InternedInput};
use serde::{Deserialize, Serialize};

use crate::{Block, ConflictDoc, Resolution};

/// 충돌 블록의 성격
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlockClass {
    /// 양쪽이 같은 내용 (라벨만 다르거나 git 이 못 합친 경우)
    Identical,
    /// theirs 는 base 그대로, ours 만 바꿈
    OursOnly,
    /// ours 는 base 그대로, theirs 만 바꿈
    TheirsOnly,
    /// 공백·빈 줄만 다름
    WhitespaceOnly,
    /// 서로 다른 줄을 바꿔 겹치지 않음 (양쪽 변경을 순서대로 합칠 수 있음)
    Adjacent,
    /// 같은 줄을 다르게 바꿈 — 사람이 봐야 한다
    Real,
}

/// 블록 하나의 분류와 제안 해결
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoSuggestion {
    /// 충돌 블록 순번 (0부터)
    pub index: usize,
    pub class: BlockClass,
    /// `Real` 이면 None
    pub resolution: Option<Resolution>,
}

/// 공백을 전부 뗀 줄 목록 (빈 줄 제외)
fn squash_ws(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|l| l.split_whitespace().collect::<String>())
        .filter(|l| !l.is_empty())
        .collect()
}

/// base→side 의 hunk 목록: (base 줄 범위, side 줄 범위)
fn hunks(base: &[String], side: &[String]) -> Vec<(Range<u32>, Range<u32>)> {
    let b = base.join("\n");
    let s = side.join("\n");
    let input = InternedInput::new(b.as_str(), s.as_str());
    let diff = Diff::compute(Algorithm::Histogram, &input);
    diff.hunks().map(|h| (h.before, h.after)).collect()
}

/// 두 hunk 집합이 base 에서 겹치지 않는지. 같은 자리의 삽입(빈 범위가 같은 위치)도 겹치는 것으로 본다
fn disjoint(a: &[(Range<u32>, Range<u32>)], b: &[(Range<u32>, Range<u32>)]) -> bool {
    for (x, _) in a {
        for (y, _) in b {
            let apart = x.end <= y.start || y.end <= x.start;
            let same_insert = x.start == x.end && y.start == y.end && x.start == y.start;
            if !apart || same_insert {
                return false;
            }
        }
    }
    true
}

/// 겹치지 않는 양쪽 hunk 를 base 에 순서대로 적용한 줄 목록
fn apply_both(
    base: &[String],
    ours: &[String],
    theirs: &[String],
    ho: &[(Range<u32>, Range<u32>)],
    ht: &[(Range<u32>, Range<u32>)],
) -> Vec<String> {
    let mut all: Vec<(&Range<u32>, &[String], &Range<u32>)> = ho
        .iter()
        .map(|(b, s)| (b, ours, s))
        .chain(ht.iter().map(|(b, s)| (b, theirs, s)))
        .collect();
    all.sort_by_key(|(b, _, _)| (b.start, b.end));
    let mut out = Vec::new();
    let mut pos = 0usize;
    for (b, side, s) in all {
        let start = b.start as usize;
        if start > pos {
            out.extend(base[pos..start].iter().cloned());
        }
        out.extend(side[s.start as usize..s.end as usize].iter().cloned());
        pos = b.end as usize;
    }
    out.extend(base[pos.min(base.len())..].iter().cloned());
    out
}

/// 충돌 블록을 분류하고 자동 해결을 제안한다
pub fn classify(
    ours: &[String],
    base: &[String],
    theirs: &[String],
) -> (BlockClass, Option<Resolution>) {
    if ours == theirs {
        return (BlockClass::Identical, Some(Resolution::Ours));
    }
    if theirs == base {
        return (BlockClass::OursOnly, Some(Resolution::Ours));
    }
    if ours == base {
        return (BlockClass::TheirsOnly, Some(Resolution::Theirs));
    }
    if squash_ws(ours) == squash_ws(theirs) {
        // 공백만 다르면 base 에서 실제로 달라진 쪽(공백 무시)을 고른다. 둘 다 달라졌으면 ours
        let side = if squash_ws(ours) == squash_ws(base) {
            Resolution::Theirs
        } else {
            Resolution::Ours
        };
        return (BlockClass::WhitespaceOnly, Some(side));
    }
    let ho = hunks(base, ours);
    let ht = hunks(base, theirs);
    if !ho.is_empty() && !ht.is_empty() && disjoint(&ho, &ht) {
        let lines = apply_both(base, ours, theirs, &ho, &ht);
        return (BlockClass::Adjacent, Some(Resolution::Custom { lines }));
    }
    (BlockClass::Real, None)
}

/// 문서의 충돌 블록 전부를 분류한다 (충돌 블록 순번 기준)
pub fn classify_doc(doc: &ConflictDoc) -> Vec<AutoSuggestion> {
    doc.blocks
        .iter()
        .filter_map(|b| match b {
            Block::Conflict {
                ours, base, theirs, ..
            } => Some((ours, base, theirs)),
            Block::Clean { .. } => None,
        })
        .enumerate()
        .map(|(index, (o, b, t))| {
            let (class, resolution) = classify(o, b, t);
            AutoSuggestion {
                index,
                class,
                resolution,
            }
        })
        .collect()
}

/// 두 텍스트의 줄 단위 유사도 0.0~1.0 (이름 변경 짝 찾기용, CF-16)
pub fn similarity(a: &str, b: &str) -> f32 {
    let la = a.lines().count() as f32;
    let lb = b.lines().count() as f32;
    if la + lb == 0.0 {
        return 1.0;
    }
    let input = InternedInput::new(a, b);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    let changed = (diff.count_removals() + diff.count_additions()) as f32;
    (1.0 - changed / (la + lb)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| (*x).to_string()).collect()
    }

    #[test]
    fn classifies_five_kinds() {
        let base = v(&["a", "b", "c", "d", "e"]);
        // 동일
        let (c, r) = classify(&v(&["x"]), &base, &v(&["x"]));
        assert_eq!(c, BlockClass::Identical);
        assert_eq!(r, Some(Resolution::Ours));
        // 한쪽만
        assert_eq!(classify(&v(&["x"]), &base, &base).0, BlockClass::OursOnly);
        assert_eq!(
            classify(&base, &base, &v(&["y"])),
            (BlockClass::TheirsOnly, Some(Resolution::Theirs))
        );
        // 공백만: theirs 가 실제 변경, ours 는 공백만
        let (c, r) = classify(
            &v(&["a", " b", "c", "d", "e"]),
            &base,
            &v(&["a", "b", "c", "d", "e", ""]),
        );
        assert_eq!(c, BlockClass::WhitespaceOnly);
        assert_eq!(r, Some(Resolution::Theirs));
        // 인접 비중첩: ours 는 첫 줄, theirs 는 마지막 줄
        let (c, r) = classify(
            &v(&["A", "b", "c", "d", "e"]),
            &base,
            &v(&["a", "b", "c", "d", "E"]),
        );
        assert_eq!(c, BlockClass::Adjacent);
        assert_eq!(
            r,
            Some(Resolution::Custom {
                lines: v(&["A", "b", "c", "d", "E"])
            })
        );
        // 진짜 충돌: 같은 줄
        assert_eq!(
            classify(
                &v(&["X", "b", "c", "d", "e"]),
                &base,
                &v(&["Y", "b", "c", "d", "e"])
            )
            .0,
            BlockClass::Real
        );
        // 같은 자리 삽입도 진짜 충돌
        assert_eq!(
            classify(
                &v(&["a", "1", "b", "c", "d", "e"]),
                &base,
                &v(&["a", "2", "b", "c", "d", "e"])
            )
            .0,
            BlockClass::Real
        );
    }

    #[test]
    fn adjacent_merge_handles_insert_and_delete() {
        let base = v(&["a", "b", "c", "d"]);
        let ours = v(&["a", "b", "c", "d", "tail"]);
        let theirs = v(&["b", "c", "d"]);
        let (c, r) = classify(&ours, &base, &theirs);
        assert_eq!(c, BlockClass::Adjacent);
        assert_eq!(
            r,
            Some(Resolution::Custom {
                lines: v(&["b", "c", "d", "tail"])
            })
        );
    }

    #[test]
    fn similarity_scores() {
        assert_eq!(similarity("", ""), 1.0);
        assert!(similarity("a\nb\nc\n", "a\nb\nc\n") > 0.99);
        assert!(similarity("a\nb\nc\nd\n", "a\nb\nc\nx\n") >= 0.7);
        assert!(similarity("a\nb\n", "x\ny\n") < 0.1);
    }
}
