//! 부분 스테이징용 패치 생성 (CHG-03).
//!
//! 사용자가 고른 줄만 담은 패치를 만들어 `git apply --cached --recount` 로 적용한다.
//! 고르지 않은 변경은 "패치를 적용할 쪽"에 이미 있는 모습으로 바꾼다:
//! - 정방향(old → new 로 적용, stage): 미선택 `-` 는 컨텍스트, 미선택 `+` 는 제거
//! - 역방향(new 쪽에 `-R` 로 적용, unstage·discard): 미선택 `+` 는 컨텍스트, 미선택 `-` 는 제거
//!
//! `--recount` 는 줄 수만 다시 세므로 hunk 시작 위치는 여기서 맞춘다 (`hunk_starts`)

use std::collections::HashSet;

use mgit_model::{DiffChange, FileDiff, Hunk, LineKind, LineSelection};

/// 패치 머리의 시작 위치 (`-` 쪽, `+` 쪽). `git apply` 는 정방향이면 `+` 쪽, `-R` 이면 `-` 쪽 시작을
/// 탐색 위치로 쓰고, 앞 hunk 를 적용한 뒤의 줄 번호로 해석한다. 내용이 반복되는 파일에서는 이 위치가
/// 어긋나면 다른 곳에 적용되므로, 대상 쪽 번호에 앞서 적용한 hunk 의 줄 수 차이(`shift`)를 더한다
fn hunk_starts(
    hunk: &Hunk,
    old_count: u32,
    new_count: u32,
    shift: i64,
    reverse: bool,
) -> (u32, u32) {
    if reverse {
        // 추가된 파일 전체를 되돌릴 때만 `-` 쪽이 0 이다
        let old = if old_count == 0 && hunk.old_start == 0 {
            0
        } else {
            search_position(hunk.new_start, new_count, shift)
        };
        (old, hunk.new_start)
    } else {
        // 삭제된 파일 전체를 적용할 때만 `+` 쪽이 0 이다
        let new = if new_count == 0 && hunk.new_start == 0 {
            0
        } else {
            search_position(hunk.old_start, old_count, shift)
        };
        (hunk.old_start, new)
    }
}

/// 탐색 위치. 줄 수가 0 인 쪽의 시작은 "그 줄 뒤"를 뜻하므로 1을 더해 실제 위치로 맞춘다
fn search_position(start: u32, count: u32, shift: i64) -> u32 {
    let anchor = i64::from(start) + i64::from(count == 0);
    (anchor + shift).max(1) as u32
}

/// 선택한 줄만 담은 unified diff 를 만든다. 고른 hunk 가 하나도 없으면 `None`.
/// `reverse` 가 true 면 `git apply -R` 로 적용할 패치(역방향 규칙)를 만든다
pub fn build_partial_patch(
    diff: &FileDiff,
    selection: &[LineSelection],
    reverse: bool,
) -> Option<Vec<u8>> {
    let old_path = diff.old_path.as_deref();
    let new_path = diff.new_path.as_deref();
    let path = diff.path();
    if path.is_empty() || diff.binary.is_some() {
        return None;
    }
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{path} b/{path}\n"));
    match diff.change {
        DiffChange::Added => out.push_str(&format!(
            "new file mode {:o}\n",
            diff.new_mode.unwrap_or(0o100644)
        )),
        DiffChange::Deleted => out.push_str(&format!(
            "deleted file mode {:o}\n",
            diff.old_mode.unwrap_or(0o100644)
        )),
        _ => {}
    }
    out.push_str(&format!(
        "--- {}\n",
        old_path
            .map(|p| format!("a/{p}"))
            .unwrap_or_else(|| "/dev/null".into())
    ));
    out.push_str(&format!(
        "+++ {}\n",
        new_path
            .map(|p| format!("b/{p}"))
            .unwrap_or_else(|| "/dev/null".into())
    ));

    let mut wrote_hunk = false;
    // 앞서 적용한 hunk 들이 만든 줄 수 차이. 고르지 않은 hunk 는 적용되지 않으므로 세지 않는다
    let mut shift = 0i64;
    let mut sorted: Vec<&LineSelection> = selection.iter().collect();
    sorted.sort_by_key(|s| s.hunk);
    sorted.dedup_by_key(|s| s.hunk);
    for sel in sorted {
        let Some(hunk) = diff.hunks.get(sel.hunk as usize) else {
            continue;
        };
        let chosen: HashSet<u32> = sel.lines.iter().copied().collect();
        let all = sel.lines.is_empty();
        let mut body = String::new();
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        let mut any_change = false;
        for (i, line) in hunk.lines.iter().enumerate() {
            let selected = all || chosen.contains(&(i as u32));
            let emitted: Option<char> = match (line.kind, selected, reverse) {
                (LineKind::Context, _, _) => Some(' '),
                (LineKind::Add, true, _) | (LineKind::Del, true, _) => {
                    any_change = true;
                    Some(if line.kind == LineKind::Add { '+' } else { '-' })
                }
                // 미선택 변경: 적용 대상 쪽의 모습으로
                (LineKind::Del, false, false) => Some(' '),
                (LineKind::Add, false, false) => None,
                (LineKind::Add, false, true) => Some(' '),
                (LineKind::Del, false, true) => None,
            };
            let Some(prefix) = emitted else {
                continue;
            };
            match prefix {
                ' ' => {
                    old_count += 1;
                    new_count += 1;
                }
                '+' => new_count += 1,
                '-' => old_count += 1,
                _ => {}
            }
            body.push(prefix);
            body.push_str(&line.text);
            body.push('\n');
            if line.no_newline {
                body.push_str("\\ No newline at end of file\n");
            }
        }
        if !any_change {
            continue;
        }
        let (old_start, new_start) = hunk_starts(hunk, old_count, new_count, shift, reverse);
        shift += if reverse {
            i64::from(old_count) - i64::from(new_count)
        } else {
            i64::from(new_count) - i64::from(old_count)
        };
        out.push_str(&format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
        ));
        out.push_str(&body);
        wrote_hunk = true;
    }
    wrote_hunk.then(|| out.into_bytes())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::parse::parse_diff;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n-c\n+C\n d\n";

    #[test]
    fn forward_partial_converts_unselected_del_to_context_and_drops_unselected_add() {
        let diff = &parse_diff(SAMPLE.as_bytes())[0];
        // 줄 인덱스: 0 a, 1 -b, 2 +B, 3 -c, 4 +C, 5 d  → b→B 만 선택
        let patch = build_partial_patch(
            diff,
            &[LineSelection {
                hunk: 0,
                lines: vec![1, 2],
            }],
            false,
        )
        .unwrap();
        let text = String::from_utf8(patch).unwrap();
        assert!(
            text.contains("@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n"),
            "{text}"
        );
    }

    #[test]
    fn reverse_partial_converts_unselected_add_to_context_and_drops_unselected_del() {
        let diff = &parse_diff(SAMPLE.as_bytes())[0];
        let patch = build_partial_patch(
            diff,
            &[LineSelection {
                hunk: 0,
                lines: vec![1, 2],
            }],
            true,
        )
        .unwrap();
        let text = String::from_utf8(patch).unwrap();
        assert!(
            text.contains("@@ -1,4 +1,4 @@\n a\n-b\n+B\n C\n d\n"),
            "{text}"
        );
    }

    /// 앞 hunk 는 위에 6줄 추가, 뒤 hunk 는 한 줄 수정
    const TWO_HUNKS: &str = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,8 @@\n+n1\n+n2\n+n3\n+n4\n+n5\n+n6\n a\n b\n@@ -24,3 +30,3 @@\n x\n-y\n+Y\n z\n";

    /// 고른 hunk 들로 패치를 만들어 문자열로
    fn patch_of(sample: &str, hunks: &[u32], reverse: bool) -> String {
        let diff = &parse_diff(sample.as_bytes())[0];
        let selection: Vec<LineSelection> = hunks
            .iter()
            .map(|&hunk| LineSelection {
                hunk,
                lines: vec![],
            })
            .collect();
        String::from_utf8(build_partial_patch(diff, &selection, reverse).unwrap()).unwrap()
    }

    #[test]
    fn skipped_hunk_does_not_shift_forward_target_position() {
        // index 에는 앞 hunk 가 없으므로 뒤 hunk 의 위치는 old 쪽 번호 그대로다
        let text = patch_of(TWO_HUNKS, &[1], false);
        assert!(text.contains("@@ -24,3 +24,3 @@\n"), "{text}");
    }

    #[test]
    fn skipped_hunk_does_not_shift_reverse_target_position() {
        // -R 은 `-` 쪽 시작을 탐색 위치로 쓰므로 대상(new 쪽) 번호를 넣어야 한다
        let text = patch_of(TWO_HUNKS, &[1], true);
        assert!(text.contains("@@ -30,3 +30,3 @@\n"), "{text}");
    }

    #[test]
    fn applied_hunks_accumulate_offset_in_both_directions() {
        let forward = patch_of(TWO_HUNKS, &[0, 1], false);
        assert!(forward.contains("@@ -1,2 +1,8 @@\n"), "{forward}");
        assert!(forward.contains("@@ -24,3 +30,3 @@\n"), "{forward}");
        // 역방향: 앞 hunk 를 되돌리면 6줄 줄어든 뒤의 위치에서 찾는다
        let reverse = patch_of(TWO_HUNKS, &[0, 1], true);
        assert!(reverse.contains("@@ -1,2 +1,8 @@\n"), "{reverse}");
        assert!(reverse.contains("@@ -24,3 +30,3 @@\n"), "{reverse}");
    }

    #[test]
    fn zero_context_hunks_keep_insert_and_delete_positions() {
        let insert =
            "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -3,0 +4,2 @@\n+p\n+q\n";
        assert!(
            patch_of(insert, &[0], false).contains("@@ -3,0 +4,2 @@\n"),
            "{}",
            patch_of(insert, &[0], false)
        );
        assert!(
            patch_of(insert, &[0], true).contains("@@ -4,0 +4,2 @@\n"),
            "{}",
            patch_of(insert, &[0], true)
        );
        let delete = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -5 +4,0 @@\n-x\n";
        assert!(
            patch_of(delete, &[0], false).contains("@@ -5,1 +5,0 @@\n"),
            "{}",
            patch_of(delete, &[0], false)
        );
        assert!(
            patch_of(delete, &[0], true).contains("@@ -5,1 +4,0 @@\n"),
            "{}",
            patch_of(delete, &[0], true)
        );
    }

    #[test]
    fn whole_hunk_when_lines_empty_and_none_when_nothing_selected() {
        let diff = &parse_diff(SAMPLE.as_bytes())[0];
        let whole = build_partial_patch(
            diff,
            &[LineSelection {
                hunk: 0,
                lines: vec![],
            }],
            false,
        )
        .unwrap();
        assert!(
            String::from_utf8(whole)
                .unwrap()
                .contains("-b\n+B\n-c\n+C\n")
        );
        assert!(
            build_partial_patch(
                diff,
                &[LineSelection {
                    hunk: 0,
                    lines: vec![0]
                }],
                false
            )
            .is_none(),
            "컨텍스트만 고르면 변경이 없다"
        );
        assert!(build_partial_patch(diff, &[], false).is_none());
    }
}
