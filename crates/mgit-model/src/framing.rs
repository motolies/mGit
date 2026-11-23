/// 구분 바이트 기준 증분 레코드 분할기. 청크 경계에서 잘린 레코드를 이어 붙인다.
#[derive(Debug, Default)]
pub struct DelimFramer<const DELIM: u8> {
    carry: Vec<u8>,
}

/// NUL(`\0`) 종료 레코드 분할기 (`git log -z` 등)
pub type NulFramer = DelimFramer<0>;
/// 개행(`\n`) 종료 레코드 분할기 (`git for-each-ref` 등). `\r` 은 제거하지 않는다
pub type LineFramer = DelimFramer<b'\n'>;

impl<const DELIM: u8> DelimFramer<DELIM> {
    /// 빈 분할기
    pub fn new() -> Self {
        Self { carry: Vec::new() }
    }

    /// 청크를 넣고 완성된 레코드마다 `f` 를 호출한다 (구분자는 제외). 잔여는 보관한다
    pub fn feed(&mut self, chunk: &[u8], mut f: impl FnMut(&[u8])) {
        let mut rest = chunk;
        while let Some(pos) = rest.iter().position(|&b| b == DELIM) {
            if self.carry.is_empty() {
                f(&rest[..pos]);
            } else {
                self.carry.extend_from_slice(&rest[..pos]);
                f(&self.carry);
                self.carry.clear();
            }
            rest = &rest[pos + 1..];
        }
        self.carry.extend_from_slice(rest);
    }

    /// 종료자 없이 남은 바이트. 없으면 `None`
    pub fn finish(self) -> Option<Vec<u8>> {
        if self.carry.is_empty() {
            None
        } else {
            Some(self.carry)
        }
    }

    /// 아직 종료자를 못 본 잔여 바이트 수
    pub fn pending_len(&self) -> usize {
        self.carry.len()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// 청크 분할과 무관하게 같은 레코드 목록이 나오는지 비교한다
    fn collect_split(data: &[u8], cuts: &[usize]) -> (Vec<Vec<u8>>, Option<Vec<u8>>) {
        let mut framer = NulFramer::new();
        let mut out = Vec::new();
        let mut prev = 0;
        for &c in cuts {
            let c = c.min(data.len()).max(prev);
            framer.feed(&data[prev..c], |r| out.push(r.to_vec()));
            prev = c;
        }
        framer.feed(&data[prev..], |r| out.push(r.to_vec()));
        (out, framer.finish())
    }

    #[test]
    fn splits_on_nul_and_keeps_empty_records() {
        let (recs, rest) = collect_split(b"a\0\0bc\0d", &[]);
        assert_eq!(recs, vec![b"a".to_vec(), b"".to_vec(), b"bc".to_vec()]);
        assert_eq!(rest, Some(b"d".to_vec()));
    }

    #[test]
    fn line_framer_keeps_carriage_return() {
        let mut framer = LineFramer::new();
        let mut out = Vec::new();
        framer.feed(b"x\r\ny\n", |r| out.push(r.to_vec()));
        assert_eq!(out, vec![b"x\r".to_vec(), b"y".to_vec()]);
        assert!(framer.finish().is_none());
    }

    proptest! {
        #[test]
        fn any_split_equals_whole(data in proptest::collection::vec(any::<u8>(), 0..200),
                                  cuts in proptest::collection::vec(0usize..200, 0..8)) {
            let mut sorted = cuts.clone();
            sorted.sort_unstable();
            let whole = collect_split(&data, &[]);
            let split = collect_split(&data, &sorted);
            prop_assert_eq!(whole, split);
        }
    }
}
