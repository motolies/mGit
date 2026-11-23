use mgit_model::{CommitRecord, NulFramer, Oid, ParseError};

/// 레코드 하나를 이루는 필드 수: `%H %P %aN %aE %at %ct %s`
pub const FIELDS_PER_RECORD: usize = 7;

/// `git log -z --format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s` 출력의 증분 파서.
///
/// `--format=`(tformat) 은 레코드마다 종료자 NUL 을 붙이므로 **레코드 = NUL 종료 필드 7개**다.
/// 빈 필드(루트 커밋의 `%P`, 빈 메시지의 `%s`)도 하나로 센다.
#[derive(Debug, Default)]
pub struct LogParser {
    framer: NulFramer,
    fields: Vec<Vec<u8>>,
    records_done: usize,
}

impl LogParser {
    /// 빈 파서
    pub fn new() -> Self {
        Self::default()
    }

    /// 청크를 넣고 완성된 레코드를 돌려준다. 오류가 나면 그 이후는 신뢰할 수 없다
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<CommitRecord>, ParseError> {
        let Self {
            framer,
            fields,
            records_done,
        } = self;
        let mut out = Vec::new();
        let mut err: Option<ParseError> = None;
        framer.feed(chunk, |field| {
            if err.is_some() {
                return;
            }
            fields.push(field.to_vec());
            if fields.len() == FIELDS_PER_RECORD {
                match build_record(fields, *records_done) {
                    Ok(rec) => out.push(rec),
                    Err(e) => err = Some(e),
                }
                fields.clear();
                *records_done += 1;
            }
        });
        match err {
            Some(e) => Err(e),
            None => Ok(out),
        }
    }

    /// 스트림 끝. 잔여 바이트나 미완성 레코드가 있으면 `Truncated`
    pub fn finish(self) -> Result<(), ParseError> {
        let pending = self.framer.pending_len();
        if pending > 0 || !self.fields.is_empty() {
            Err(ParseError::Truncated {
                fields_seen: self.fields.len(),
            })
        } else {
            Ok(())
        }
    }

    /// 지금까지 완성한 레코드 수
    pub fn records_done(&self) -> usize {
        self.records_done
    }
}

/// 필드 7개로 레코드를 조립한다
fn build_record(fields: &[Vec<u8>], record: usize) -> Result<CommitRecord, ParseError> {
    let oid = Oid::from_hex(&fields[0]).map_err(|_| ParseError::Desync { record })?;
    let mut parents: Vec<Oid> = Vec::new();
    for piece in fields[1].split(|&b| b == b' ').filter(|p| !p.is_empty()) {
        let p = Oid::from_hex(piece).map_err(|_| ParseError::BadField { record, field: 1 })?;
        if !parents.contains(&p) {
            parents.push(p);
        }
    }
    let author_time = parse_date(&fields[4]);
    let commit_time = parse_date(&fields[5]);
    Ok(CommitRecord {
        oid,
        parents,
        author_name: lossy(&fields[2]),
        author_email: lossy(&fields[3]),
        author_time,
        commit_time,
        subject: lossy(&fields[6]),
    })
}

/// 커밋 시각(ASCII 십진수, 음수 허용). 날짜가 없거나 i64 를 넘는 커밋은 fsck 오류지만 오래된 저장소에
/// 실제로 있고 `git log` 도 보여 주므로, 커밋 하나로 그래프 전체를 잃지 않게 0 으로 둔다
fn parse_date(bytes: &[u8]) -> i64 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// UTF-8 lossy 문자열. 정규화하지 않는다
fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
