//! 충돌 블록 모델 (CF-06~10, CF-23). `git merge-file --zdiff3` 출력을 블록으로 나누고,
//! 블록별 해결을 적용해 다시 바이트로 렌더한다. git 을 호출하지 않는 순수 코드

use mgit_l10n::tr;
use serde::{Deserialize, Serialize};

pub mod classify;
pub use classify::{AutoSuggestion, BlockClass, classify, classify_doc, similarity};

/// 줄 끝 종류. 렌더 시 원본을 따른다. 모든 줄바꿈이 CRLF 일 때만 `CrLf` 이고, LF 와 섞인 파일은
/// `Lf` 로 두고 CRLF 줄의 `\r` 을 줄 내용에 남겨 줄마다 원본 그대로 렌더한다
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Eol {
    Lf,
    CrLf,
}

impl Eol {
    /// 줄 끝 문자열
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::CrLf => "\r\n",
        }
    }
}

/// 블록 하나. 줄에는 줄 끝이 없다 (줄끝이 섞인 파일의 CRLF 줄만 끝에 `\r` 이 남는다)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Block {
    Clean {
        lines: Vec<String>,
    },
    Conflict {
        ours: Vec<String>,
        base: Vec<String>,
        theirs: Vec<String>,
        /// 마커에 붙은 라벨 (`<<<<<<< ours` 의 `ours`)
        labels: [String; 3],
    },
}

/// 파싱 결과 문서
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDoc {
    pub blocks: Vec<Block>,
    pub eol: Eol,
    /// 원본이 줄 끝으로 끝났는지
    pub trailing_newline: bool,
}

impl ConflictDoc {
    /// 충돌 블록 수
    pub fn conflict_count(&self) -> usize {
        self.blocks
            .iter()
            .filter(|b| matches!(b, Block::Conflict { .. }))
            .count()
    }
}

/// 충돌 블록 하나의 해결 (CF-08·09)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Resolution {
    Unresolved,
    Ours,
    Theirs,
    Base,
    BothOursFirst,
    BothTheirsFirst,
    /// 사용자가 편집한 줄
    Custom {
        lines: Vec<String>,
    },
}

/// 파싱 오류
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    /// 마커 순서가 어긋남 (`=======` 전에 `>>>>>>>` 등)
    UnexpectedMarker { line: usize, marker: char },
    /// 끝까지 닫히지 않은 충돌 블록
    Unterminated { start_line: usize },
}

impl std::fmt::Display for ParseError {
    /// 사람이 읽을 메시지
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::UnexpectedMarker { line, marker } => f.write_str(&tr!(
                "{line}번째 줄: 예상 밖의 마커 '{marker}'",
                "Line {line}: unexpected marker '{marker}'"
            )),
            ParseError::Unterminated { start_line } => f.write_str(&tr!(
                "{start_line}번째 줄에서 시작한 충돌 블록이 닫히지 않음",
                "Conflict block starting at line {start_line} is not closed"
            )),
        }
    }
}

impl std::error::Error for ParseError {}

/// 줄 끝과 끝 줄바꿈을 알아낸다. 모든 줄바꿈이 CRLF 일 때만 `CrLf`
fn detect_eol(text: &str) -> (Eol, bool) {
    let newlines = text.matches('\n').count();
    let eol = if newlines > 0 && newlines == text.matches("\r\n").count() {
        Eol::CrLf
    } else {
        Eol::Lf
    };
    let trailing = text.ends_with('\n');
    (eol, trailing)
}

/// `eol` 로 나눈 줄 목록 (마지막 빈 조각은 끝 줄바꿈의 산물이라 버린다).
/// 줄끝이 섞인 파일은 `eol` 이 `Lf` 라 CRLF 줄의 `\r` 이 내용으로 남는다
fn split_lines(text: &str, eol: Eol) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split(eol.as_str()).collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// 줄이 `size` 개의 `ch` 로 시작하는 마커인지. 마커 뒤는 공백 또는 라벨이어야 한다.
/// 줄끝이 섞인 파일의 줄 끝 `\r` 은 마커 판정에서 뺀다
fn marker(line: &str, ch: char, size: usize) -> Option<&str> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let bytes = line.as_bytes();
    if bytes.len() < size || !bytes[..size].iter().all(|&b| b == ch as u8) {
        return None;
    }
    let rest = &line[size..];
    if rest.is_empty() {
        return Some("");
    }
    if let Some(after) = rest.strip_prefix(' ') {
        return Some(after.trim_end());
    }
    None
}

/// `git merge-file --zdiff3` (또는 작업 트리의 diff3/merge 스타일) 출력을 블록으로 나눈다.
/// `|||||||` 가 없는 2-way 마커도 받는다 (base 는 빈 목록)
pub fn parse_markers(bytes: &[u8], marker_size: usize) -> Result<ConflictDoc, ParseError> {
    let text = String::from_utf8_lossy(bytes);
    let (eol, trailing_newline) = detect_eol(&text);
    let lines = split_lines(&text, eol);

    #[derive(PartialEq)]
    enum St {
        Clean,
        Ours,
        Base,
        Theirs,
    }
    let mut blocks = Vec::new();
    let mut clean: Vec<String> = Vec::new();
    let mut ours = Vec::new();
    let mut base = Vec::new();
    let mut theirs = Vec::new();
    let mut labels = [String::new(), String::new(), String::new()];
    let mut state = St::Clean;
    let mut start_line = 0;

    for (idx, line) in lines.iter().enumerate() {
        let no = idx + 1;
        match state {
            St::Clean => {
                if let Some(label) = marker(line, '<', marker_size) {
                    if !clean.is_empty() {
                        blocks.push(Block::Clean {
                            lines: std::mem::take(&mut clean),
                        });
                    }
                    labels = [label.to_string(), String::new(), String::new()];
                    start_line = no;
                    state = St::Ours;
                } else {
                    clean.push((*line).to_string());
                }
            }
            St::Ours => {
                if let Some(label) = marker(line, '|', marker_size) {
                    labels[1] = label.to_string();
                    state = St::Base;
                } else if marker(line, '=', marker_size).is_some() {
                    state = St::Theirs;
                } else if marker(line, '<', marker_size).is_some()
                    || marker(line, '>', marker_size).is_some()
                {
                    return Err(ParseError::UnexpectedMarker {
                        line: no,
                        marker: line.chars().next().unwrap_or('?'),
                    });
                } else {
                    ours.push((*line).to_string());
                }
            }
            St::Base => {
                if marker(line, '=', marker_size).is_some() {
                    state = St::Theirs;
                } else if marker(line, '<', marker_size).is_some()
                    || marker(line, '>', marker_size).is_some()
                    || marker(line, '|', marker_size).is_some()
                {
                    return Err(ParseError::UnexpectedMarker {
                        line: no,
                        marker: line.chars().next().unwrap_or('?'),
                    });
                } else {
                    base.push((*line).to_string());
                }
            }
            St::Theirs => {
                if let Some(label) = marker(line, '>', marker_size) {
                    labels[2] = label.to_string();
                    blocks.push(Block::Conflict {
                        ours: std::mem::take(&mut ours),
                        base: std::mem::take(&mut base),
                        theirs: std::mem::take(&mut theirs),
                        labels: std::mem::take(&mut labels),
                    });
                    state = St::Clean;
                } else if marker(line, '<', marker_size).is_some()
                    || marker(line, '=', marker_size).is_some()
                    || marker(line, '|', marker_size).is_some()
                {
                    return Err(ParseError::UnexpectedMarker {
                        line: no,
                        marker: line.chars().next().unwrap_or('?'),
                    });
                } else {
                    theirs.push((*line).to_string());
                }
            }
        }
    }
    if state != St::Clean {
        return Err(ParseError::Unterminated { start_line });
    }
    if !clean.is_empty() {
        blocks.push(Block::Clean { lines: clean });
    }
    Ok(ConflictDoc {
        blocks,
        eol,
        trailing_newline,
    })
}

/// 해결을 적용해 최종 바이트를 만든다. `resolutions` 는 충돌 블록 순서대로.
/// `Unresolved` 블록은 7자 표준 마커로 남긴다 (저장 전 검사가 잡는다)
pub fn render(doc: &ConflictDoc, resolutions: &[Resolution]) -> Vec<u8> {
    let mut out: Vec<String> = Vec::new();
    let mut idx = 0;
    for block in &doc.blocks {
        match block {
            Block::Clean { lines } => out.extend(lines.iter().cloned()),
            Block::Conflict {
                ours,
                base,
                theirs,
                labels,
            } => {
                let r = resolutions.get(idx).unwrap_or(&Resolution::Unresolved);
                idx += 1;
                match r {
                    Resolution::Ours => out.extend(ours.iter().cloned()),
                    Resolution::Theirs => out.extend(theirs.iter().cloned()),
                    Resolution::Base => out.extend(base.iter().cloned()),
                    Resolution::BothOursFirst => {
                        out.extend(ours.iter().cloned());
                        out.extend(theirs.iter().cloned());
                    }
                    Resolution::BothTheirsFirst => {
                        out.extend(theirs.iter().cloned());
                        out.extend(ours.iter().cloned());
                    }
                    Resolution::Custom { lines } => out.extend(lines.iter().cloned()),
                    Resolution::Unresolved => {
                        out.push(format!("<<<<<<< {}", labels[0]).trim_end().to_string());
                        out.extend(ours.iter().cloned());
                        out.push(format!("||||||| {}", labels[1]).trim_end().to_string());
                        out.extend(base.iter().cloned());
                        out.push("=======".to_string());
                        out.extend(theirs.iter().cloned());
                        out.push(format!(">>>>>>> {}", labels[2]).trim_end().to_string());
                    }
                }
            }
        }
    }
    let mut text = out.join(doc.eol.as_str());
    if doc.trailing_newline && !out.is_empty() {
        text.push_str(doc.eol.as_str());
    }
    text.into_bytes()
}

/// 충돌 마커가 남아 있는 줄 번호 (1부터). 마커 뒤는 공백·라벨만 허용 (CF-23).
/// `=======`·`|||||||` 단독은 제목 밑줄이나 표 구분선일 수 있어 세지 않는다
pub fn conflict_marker_lines(bytes: &[u8], marker_size: usize) -> Vec<usize> {
    let text = String::from_utf8_lossy(bytes);
    let (eol, _) = detect_eol(&text);
    split_lines(&text, eol)
        .iter()
        .enumerate()
        .filter(|(_, l)| {
            marker(l, '<', marker_size).is_some() || marker(l, '>', marker_size).is_some()
        })
        .map(|(i, _)| i + 1)
        .collect()
}

/// 충돌 마커가 남아 있는지
pub fn has_conflict_markers(bytes: &[u8], marker_size: usize) -> bool {
    !conflict_marker_lines(bytes, marker_size).is_empty()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const SAMPLE: &str =
        "a\n<<<<<<< ours\nb-ours\n||||||| base\nb\n=======\nb-theirs\n>>>>>>> theirs\nc\n";

    #[test]
    fn parses_zdiff3_and_renders_each_resolution() {
        let doc = parse_markers(SAMPLE.as_bytes(), 7).unwrap();
        assert_eq!(doc.blocks.len(), 3);
        assert_eq!(doc.conflict_count(), 1);
        assert_eq!(doc.eol, Eol::Lf);
        assert!(doc.trailing_newline);
        let s = |r: Resolution| String::from_utf8(render(&doc, &[r])).unwrap();
        assert_eq!(s(Resolution::Ours), "a\nb-ours\nc\n");
        assert_eq!(s(Resolution::Theirs), "a\nb-theirs\nc\n");
        assert_eq!(s(Resolution::Base), "a\nb\nc\n");
        assert_eq!(s(Resolution::BothOursFirst), "a\nb-ours\nb-theirs\nc\n");
        assert_eq!(s(Resolution::BothTheirsFirst), "a\nb-theirs\nb-ours\nc\n");
        assert_eq!(
            s(Resolution::Custom {
                lines: vec!["x".into()]
            }),
            "a\nx\nc\n"
        );
        assert_eq!(s(Resolution::Unresolved), SAMPLE);
    }

    #[test]
    fn two_way_markers_crlf_and_no_trailing_newline() {
        let text = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> other\r\nz";
        let doc = parse_markers(text.as_bytes(), 7).unwrap();
        assert_eq!(doc.eol, Eol::CrLf);
        assert!(!doc.trailing_newline);
        match &doc.blocks[1] {
            Block::Conflict { base, labels, .. } => {
                assert!(base.is_empty());
                assert_eq!(labels[0], "HEAD");
                assert_eq!(labels[2], "other");
            }
            _ => panic!("충돌 블록이어야 한다"),
        }
        assert_eq!(render(&doc, &[Resolution::Ours]), b"a\r\nx\r\nz");
    }

    #[test]
    fn mixed_line_endings_are_kept_per_line() {
        // 첫 줄이 LF 여도 뒤의 CRLF 줄은 그대로 남는다
        let text =
            "first\nsecond\r\nthird\r\n<<<<<<< o\r\nx\r\n=======\r\ny\r\n>>>>>>> t\r\nlast\n";
        let doc = parse_markers(text.as_bytes(), 7).unwrap();
        assert_eq!(doc.conflict_count(), 1);
        assert_eq!(
            String::from_utf8(render(&doc, &[Resolution::Ours])).unwrap(),
            "first\nsecond\r\nthird\r\nx\r\nlast\n"
        );
        // 첫 줄이 CRLF 여도 뒤의 LF 줄은 CRLF 로 바뀌지 않는다
        let text = "first\r\nsecond\n<<<<<<< o\nx\n=======\ny\n>>>>>>> t\r\nlast\n";
        let doc = parse_markers(text.as_bytes(), 7).unwrap();
        assert_eq!(doc.conflict_count(), 1);
        assert_eq!(
            String::from_utf8(render(&doc, &[Resolution::Theirs])).unwrap(),
            "first\r\nsecond\ny\nlast\n"
        );
        // 마커 검사도 CRLF 줄의 마커를 찾는다
        assert_eq!(conflict_marker_lines(b"a\n<<<<<<< x\r\nb\n", 7), vec![2]);
    }

    #[test]
    fn marker_like_content_with_wider_markers_is_not_a_marker() {
        // 마커 크기 32 로 만든 출력에서는 7자 마커 모양의 본문이 그대로 내용이다
        let m32 = "<".repeat(32);
        let e32 = "=".repeat(32);
        let g32 = ">".repeat(32);
        let text = format!(
            "{m32} ours\n<<<<<<< not a marker\n=======\n{e32}\n>>>>>>> nope\n{g32} theirs\n"
        );
        let doc = parse_markers(text.as_bytes(), 32).unwrap();
        match &doc.blocks[0] {
            Block::Conflict { ours, theirs, .. } => {
                assert_eq!(
                    ours,
                    &vec!["<<<<<<< not a marker".to_string(), "=======".to_string()]
                );
                assert_eq!(theirs, &vec![">>>>>>> nope".to_string()]);
            }
            _ => panic!(),
        }
        assert!(has_conflict_markers(&render(&doc, &[Resolution::Ours]), 7));
        assert!(
            !has_conflict_markers(b"<<<<<<<< eight\n", 7),
            "8개는 마커가 아니다"
        );
        assert!(
            !has_conflict_markers(b"<<<<<<<x\n", 7),
            "뒤에 공백이 없으면 마커가 아니다"
        );
        assert_eq!(
            conflict_marker_lines(b"a\n=======\nb\n>>>>>>> x\n", 7),
            vec![4]
        );
    }

    #[test]
    fn equals_and_pipes_alone_are_not_conflict_markers() {
        // 7자 제목 밑줄·표 구분선은 정상 문서다
        assert!(!has_conflict_markers(b"Install\n=======\n\nrun\n", 7));
        assert!(!has_conflict_markers(b"||||||| table\n", 7));
        assert!(has_conflict_markers(b"<<<<<<< ours\n", 7));
        assert!(has_conflict_markers(b">>>>>>> theirs\n", 7));
    }

    #[test]
    fn errors_on_broken_markers() {
        assert!(matches!(
            parse_markers(b"<<<<<<< a\nx\n", 7),
            Err(ParseError::Unterminated { start_line: 1 })
        ));
        assert!(matches!(
            parse_markers(b"<<<<<<< a\n>>>>>>> b\n", 7),
            Err(ParseError::UnexpectedMarker {
                line: 2,
                marker: '>'
            })
        ));
    }

    /// 임의 줄 (마커 모양 제외)
    fn arb_line() -> impl Strategy<Value = String> {
        "[a-z0-9 ]{0,12}".prop_filter("마커 금지", |s| {
            !s.starts_with('<') && !s.starts_with('=')
        })
    }

    proptest! {
        /// 임의 3버전 블록을 마커로 만들고 다시 파싱하면 같다. 렌더 결과엔 마커가 없고 줄 수가 맞다
        #[test]
        fn roundtrip_and_render_has_no_markers(
            blocks in proptest::collection::vec(
                (proptest::collection::vec(arb_line(), 0..4),
                 proptest::collection::vec(arb_line(), 0..4),
                 proptest::collection::vec(arb_line(), 0..4),
                 proptest::collection::vec(arb_line(), 0..4)), 1..5),
            crlf in any::<bool>(),
            trailing in any::<bool>(),
        ) {
            let eol = if crlf { "\r\n" } else { "\n" };
            let mut lines: Vec<String> = Vec::new();
            let mut expected_conflicts = 0;
            for (clean, ours, base, theirs) in &blocks {
                lines.extend(clean.iter().cloned());
                lines.push("<<<<<<< ours".into());
                lines.extend(ours.iter().cloned());
                lines.push("||||||| base".into());
                lines.extend(base.iter().cloned());
                lines.push("=======".into());
                lines.extend(theirs.iter().cloned());
                lines.push(">>>>>>> theirs".into());
                expected_conflicts += 1;
            }
            let mut text = lines.join(eol);
            if trailing { text.push_str(eol); }
            let doc = parse_markers(text.as_bytes(), 7).unwrap();
            prop_assert_eq!(doc.conflict_count(), expected_conflicts);
            let unresolved = vec![Resolution::Unresolved; expected_conflicts];
            prop_assert_eq!(String::from_utf8(render(&doc, &unresolved)).unwrap(), text);
            let ours = vec![Resolution::Ours; expected_conflicts];
            let out = render(&doc, &ours);
            prop_assert!(!has_conflict_markers(&out, 7));
            // Ours 만 고른 결과는 clean+ours 줄을 그대로 이은 것과 바이트 단위로 같다
            let expected_lines: Vec<String> = blocks.iter().flat_map(|(c, o, _, _)| c.iter().chain(o.iter()).cloned()).collect();
            let mut expected = expected_lines.join(eol);
            if trailing && !expected_lines.is_empty() { expected.push_str(eol); }
            prop_assert_eq!(String::from_utf8(out).unwrap(), expected);
        }
    }
}
