use crate::oid::Oid;

/// `git log` 한 레코드. 파서 출력 단위이며 그래프 테이블에 들어가기 전 형태다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitRecord {
    pub oid: Oid,
    /// 중복 제거, 순서 유지
    pub parents: Vec<Oid>,
    /// UTF-8 lossy. NFC/NFD 정규화하지 않는다
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
}
