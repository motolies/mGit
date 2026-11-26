//! 텍스트 파일 인코딩 (R2). 원문 바이트를 글자로 바꾸는 규칙과 편집 허용 판정을 한곳에 둔다. 표준(WHATWG) 인코딩 표는
//! `encoding_rs` 를 쓴다.
//!
//! - 읽는 차례: BOM(UTF-8·UTF-16 LE/BE)이 있으면 그 인코딩으로 확정한다. 없으면 UTF-8, 그다음 `GUESSES`(EUC-KR → Shift_JIS)
//!   를 차례로 엄격하게(바꿀 수 없는 바이트가 하나라도 있으면 실패) 디코드해 처음 되는 것을 "추정"으로 쓴다. 모두 안 되면
//!   UTF-8 아님이다. 한국어 사용자의 옛 파일은 대부분 CP949(표준 EUC-KR 표가 CP949 를 품는다)라 EUC-KR 을 먼저 본다 —
//!   Shift_JIS 의 두 번째 바이트(`0x40`·`0x5B~0x60`·`0x7B~0x7E`)와 반각 가나 한 바이트(`0xA1~0xDF` 단독)는 CP949 로 읽을 수
//!   없어, 일본어 파일 대부분은 EUC-KR 시도에서 떨어지고 Shift_JIS 로 간다. 추정이 틀리면 사용자가 인코딩을 고른다
//! - 사용자가 인코딩을 고르면 그 인코딩으로만 읽는다. 바꿀 수 없는 바이트는 U+FFFD 로 보이고 편집은 막는다
//! - 편집 허용: 디코드한 글자를 같은 인코딩으로 다시 쓴 바이트가 원본과 완전히 같을 때만 (`Decoded::lossless`)
//! - 글자열은 BOM 을 U+FEFF 한 글자로 맨 앞에 둔다 — 같은 인코딩으로 다시 쓰면 BOM 바이트가 그대로 돌아온다 (UTF-8 BOM 의
//!   기존 규칙과 같다)
//! - 인코드는 그 인코딩으로 쓸 수 없는 글자가 있으면 실패한다 (HTML 문자 참조 같은 대체본을 쓰지 않는다)

use std::borrow::Cow;

use encoding_rs::Encoding;

/// 텍스트 파일 인코딩. 화면이 고를 수 있는 것은 이 목록이다
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FsEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// 표준 EUC-KR 표 (CP949·UHC 를 품는다)
    EucKr,
    /// 표준 Shift_JIS 표 (Windows-31J 에 가깝다)
    ShiftJis,
    EucJp,
    Gb18030,
    Big5,
    Windows1252,
}

/// BOM 이 없고 UTF-8 이 아닐 때 차례로 시도하는 후보 (오류 없이 디코드되는 첫 후보)
const GUESSES: [FsEncoding; 2] = [FsEncoding::EucKr, FsEncoding::ShiftJis];

impl FsEncoding {
    /// 표준 인코딩 표
    fn standard(self) -> &'static Encoding {
        match self {
            Self::Utf8 => encoding_rs::UTF_8,
            Self::Utf16Le => encoding_rs::UTF_16LE,
            Self::Utf16Be => encoding_rs::UTF_16BE,
            Self::EucKr => encoding_rs::EUC_KR,
            Self::ShiftJis => encoding_rs::SHIFT_JIS,
            Self::EucJp => encoding_rs::EUC_JP,
            Self::Gb18030 => encoding_rs::GB18030,
            Self::Big5 => encoding_rs::BIG5,
            Self::Windows1252 => encoding_rs::WINDOWS_1252,
        }
    }

    /// 문구에 쓰는 표준 이름 (`UTF-8`·`UTF-16LE`·`EUC-KR`·`Shift_JIS` …)
    pub fn label(self) -> &'static str {
        self.standard().name()
    }

    /// 엄격한 디코드: 바꿀 수 없는 바이트가 있으면 None. BOM 은 떼지 않고 U+FEFF 글자로 남는다
    fn decode_strict(self, bytes: &[u8]) -> Option<String> {
        self.standard()
            .decode_without_bom_handling_and_without_replacement(bytes)
            .map(Cow::into_owned)
    }

    /// 바꿀 수 없는 바이트를 U+FFFD 로 바꾼 디코드 (사용자가 고른 인코딩으로 읽기 전용으로 볼 때)
    fn decode_lossy(self, bytes: &[u8]) -> String {
        self.standard()
            .decode_without_bom_handling(bytes)
            .0
            .into_owned()
    }

    /// 글자열을 이 인코딩의 바이트로 쓴다. 쓸 수 없는 글자가 있으면 그 첫 글자를 돌려준다. UTF-16 은 표준 인코더가 없어
    /// (표준은 UTF-16 으로 쓰지 않는다) 직접 쓴다
    pub fn encode(self, text: &str) -> Result<Vec<u8>, char> {
        match self {
            Self::Utf8 => Ok(text.as_bytes().to_vec()),
            Self::Utf16Le => Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect()),
            Self::Utf16Be => Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect()),
            _ => {
                let standard = self.standard();
                let (bytes, _, unmappable) = standard.encode(text);
                if !unmappable {
                    return Ok(bytes.into_owned());
                }
                // 실패 문구에 쓸 첫 글자를 찾는다 (실패할 때만 한 글자씩 다시 본다)
                let mut buf = [0u8; 4];
                Err(text
                    .chars()
                    .find(|c| standard.encode(c.encode_utf8(&mut buf)).2)
                    .unwrap_or(char::REPLACEMENT_CHARACTER))
            }
        }
    }
}

/// BOM 으로 정해지는 인코딩. UTF-8 BOM 을 먼저 본다
pub(crate) fn sniff_bom(bytes: &[u8]) -> Option<FsEncoding> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some(FsEncoding::Utf8)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some(FsEncoding::Utf16Le)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some(FsEncoding::Utf16Be)
    } else {
        None
    }
}

/// UTF-16 인지 (글자의 반이 NUL 이라 바이너리 판정을 하지 않는다)
pub(crate) fn is_utf16(encoding: FsEncoding) -> bool {
    matches!(encoding, FsEncoding::Utf16Le | FsEncoding::Utf16Be)
}

/// 원문 바이트를 글자로 바꾼 결과
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Decoded {
    /// 글자열 (BOM 이 있으면 맨 앞에 U+FEFF)
    pub(crate) text: String,
    pub(crate) encoding: FsEncoding,
    /// BOM 이 없고 UTF-8 이 아니어서 후보 중에서 고른 인코딩이다
    pub(crate) guessed: bool,
    /// 같은 인코딩으로 다시 쓰면 원본 바이트와 완전히 같다 (편집 허용 조건)
    pub(crate) lossless: bool,
    /// 바꿀 수 없는 바이트가 있어 U+FFFD 로 바꿨다 (고른 인코딩으로 읽을 때만)
    pub(crate) malformed: bool,
}

/// 원문 바이트를 글자로 바꾼다. `choice` 가 있으면 그 인코딩으로만 읽고(바꿀 수 없는 바이트는 U+FFFD), 없으면 BOM →
/// UTF-8 → 후보 차례다. 고르지 않았고 아무것도 맞지 않으면 None (UTF-8 아님). BOM 이 있는데 그 인코딩으로 읽을 수 없으면
/// (홀수 길이 UTF-16 등) 다른 후보를 보지 않고 None 이다
pub(crate) fn decode(bytes: &[u8], choice: Option<FsEncoding>) -> Option<Decoded> {
    if let Some(encoding) = choice {
        return Some(match encoding.decode_strict(bytes) {
            Some(text) => decoded(bytes, text, encoding, false),
            None => Decoded {
                text: encoding.decode_lossy(bytes),
                encoding,
                guessed: false,
                lossless: false,
                malformed: true,
            },
        });
    }
    if let Some(encoding) = sniff_bom(bytes) {
        return encoding
            .decode_strict(bytes)
            .map(|text| decoded(bytes, text, encoding, false));
    }
    if let Some(text) = FsEncoding::Utf8.decode_strict(bytes) {
        return Some(decoded(bytes, text, FsEncoding::Utf8, false));
    }
    GUESSES.iter().find_map(|&encoding| {
        encoding
            .decode_strict(bytes)
            .map(|text| decoded(bytes, text, encoding, true))
    })
}

/// 오류 없이 디코드한 글자열의 결과. 다시 써서 원본과 같은지 본다 (UTF-8 은 늘 같다)
fn decoded(bytes: &[u8], text: String, encoding: FsEncoding, guessed: bool) -> Decoded {
    let lossless =
        encoding == FsEncoding::Utf8 || encoding.encode(&text).is_ok_and(|again| again == bytes);
    Decoded {
        text,
        encoding,
        guessed,
        lossless,
        malformed: false,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// "한글" 의 EUC-KR(CP949) 바이트
    const HANGUL_EUC_KR: &[u8] = &[0xC7, 0xD1, 0xB1, 0xDB];
    /// "日本語" 의 Shift_JIS 바이트
    const NIHONGO_SJIS: &[u8] = &[0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA];

    /// BOM: UTF-8·UTF-16 LE/BE 를 알아보고 글자열 맨 앞에 U+FEFF 를 남긴다. 같은 인코딩으로 다시 쓰면 BOM 이 돌아온다
    #[test]
    fn bom_decides_encoding_and_round_trips() {
        let le = [0xFF, 0xFE, b'a', 0, 0x5C, 0xD5];
        let got = decode(&le, None).unwrap();
        assert_eq!(got.encoding, FsEncoding::Utf16Le);
        assert_eq!(got.text, "\u{feff}a한");
        assert!(got.lossless && !got.guessed && !got.malformed);
        assert_eq!(FsEncoding::Utf16Le.encode(&got.text).unwrap(), le);

        let be = [0xFE, 0xFF, 0, b'a', 0xD5, 0x5C];
        let got = decode(&be, None).unwrap();
        assert_eq!(
            (got.encoding, got.text.as_str()),
            (FsEncoding::Utf16Be, "\u{feff}a한")
        );
        assert_eq!(FsEncoding::Utf16Be.encode(&got.text).unwrap(), be);

        let utf8 = "\u{feff}한".as_bytes();
        assert_eq!(decode(utf8, None).unwrap().encoding, FsEncoding::Utf8);
        // BOM 은 UTF-16 인데 홀수 길이면 다른 후보를 보지 않는다
        assert_eq!(decode(&[0xFF, 0xFE, b'a'], None), None);
    }

    /// BOM 이 없으면 UTF-8 → EUC-KR → Shift_JIS 차례로 엄격하게 시도한다
    #[test]
    fn guesses_euc_kr_then_shift_jis() {
        assert_eq!(
            decode("가".as_bytes(), None).unwrap().encoding,
            FsEncoding::Utf8
        );
        let kr = decode(HANGUL_EUC_KR, None).unwrap();
        assert_eq!((kr.encoding, kr.text.as_str()), (FsEncoding::EucKr, "한글"));
        assert!(kr.guessed && kr.lossless);
        // Shift_JIS 의 두 번째 바이트 0x7B 는 CP949 로 읽을 수 없어 Shift_JIS 로 간다
        let jp = decode(NIHONGO_SJIS, None).unwrap();
        assert_eq!(
            (jp.encoding, jp.text.as_str()),
            (FsEncoding::ShiftJis, "日本語")
        );
        assert!(jp.guessed && jp.lossless);
        // 어느 후보로도 읽을 수 없으면 UTF-8 아님
        assert_eq!(decode(&[0xFF, 0xFF, 0xFF], None), None);
    }

    /// 고른 인코딩: 그 인코딩으로만 읽고, 바꿀 수 없는 바이트는 U+FFFD 로 보이며 편집할 수 없다
    #[test]
    fn chosen_encoding_is_lossy_when_malformed() {
        let got = decode(HANGUL_EUC_KR, Some(FsEncoding::ShiftJis)).unwrap();
        assert_eq!(got.encoding, FsEncoding::ShiftJis);
        assert!(!got.guessed);
        let utf8 = decode(HANGUL_EUC_KR, Some(FsEncoding::Utf8)).unwrap();
        assert!(utf8.malformed && !utf8.lossless);
        assert!(utf8.text.contains(char::REPLACEMENT_CHARACTER));
        let chosen = decode(HANGUL_EUC_KR, Some(FsEncoding::EucKr)).unwrap();
        assert!(chosen.lossless && !chosen.guessed && !chosen.malformed);
    }

    /// 다시 쓰면 바이트가 달라지는 파일은 편집할 수 없다: Shift_JIS 에서 같은 글자가 두 자리에 있으면 표준 인코더는 NEC
    /// 선정 IBM 확장(`0xED40~0xEEFC`)을 건너뛰고 IBM 확장 자리로 쓴다
    #[test]
    fn irreversible_bytes_are_not_lossless() {
        // 0xEE 0xEF (ⅰ, NEC 선정 IBM 확장) 는 다시 쓰면 0xFA 0x40 (IBM 확장) 이 된다
        let got = decode(&[0xEE, 0xEF], Some(FsEncoding::ShiftJis)).unwrap();
        assert_eq!(got.text, "ⅰ");
        assert!(!got.malformed);
        assert_eq!(
            FsEncoding::ShiftJis.encode(&got.text).unwrap(),
            [0xFA, 0x40]
        );
        assert!(!got.lossless);
        // 반대쪽 바이트는 그대로 돌아온다
        assert!(
            decode(&[0xFA, 0x40], Some(FsEncoding::ShiftJis))
                .unwrap()
                .lossless
        );
    }

    /// 인코드: 쓸 수 없는 글자가 있으면 그 첫 글자를 돌려준다 (대체본을 쓰지 않는다)
    #[test]
    fn encode_refuses_unmappable_characters() {
        assert_eq!(FsEncoding::EucKr.encode("한글").unwrap(), HANGUL_EUC_KR);
        assert_eq!(FsEncoding::EucKr.encode("a😀b"), Err('😀'));
        assert_eq!(FsEncoding::ShiftJis.encode("한"), Err('한'));
        assert_eq!(
            FsEncoding::Utf16Le.encode("😀").unwrap(),
            [0x3D, 0xD8, 0x00, 0xDE]
        );
        assert_eq!(FsEncoding::EucKr.label(), "EUC-KR");
        assert_eq!(FsEncoding::ShiftJis.label(), "Shift_JIS");
    }
}
