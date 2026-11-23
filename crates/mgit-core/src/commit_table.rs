use std::collections::HashMap;

use mgit_model::{CommitRecord, Oid};

/// 컬럼형 커밋 테이블. 행 번호 = 로드 순서(`--topo-order`·`--date-order`).
/// 작성자 `(name, email)` 은 인터닝해 100k 커밋 기준 수십 MB 안에 들어가게 한다.
/// 키는 `(저장소 인덱스, Oid)` 라 통합 타임라인(MR-12)에서 같은 커밋을 가진 저장소가 섞여도 충돌하지 않는다
#[derive(Debug, Default)]
pub struct CommitTable {
    oids: Vec<Oid>,
    /// 행의 저장소 인덱스 (단일 저장소는 0)
    repo: Vec<u16>,
    /// `parents[parent_off[r]..parent_off[r+1]]` 가 행 r 의 부모. 길이 n+1
    parent_off: Vec<u32>,
    parents: Vec<Oid>,
    author: Vec<u32>,
    authors: Vec<(String, String)>,
    author_index: HashMap<(String, String), u32>,
    author_time: Vec<i64>,
    commit_time: Vec<i64>,
    subject: Vec<String>,
    /// HEAD(그 저장소의 현재 브랜치)에서 닿는 커밋인지. 알 수 없는 범위면 모두 참
    in_head: Vec<bool>,
    by_key: HashMap<(u16, Oid), u32>,
    /// 자식 색인 (CSR). `build_children` 뒤에만 채워진다
    child_off: Vec<u32>,
    children: Vec<u32>,
    children_built: bool,
}

impl CommitTable {
    /// 빈 테이블
    pub fn new() -> Self {
        CommitTable {
            parent_off: vec![0],
            ..Self::default()
        }
    }

    /// 레코드를 다음 행에 넣고 행 번호를 돌려준다 (저장소 0)
    pub fn push(&mut self, rec: &CommitRecord, in_head: bool) -> u32 {
        self.push_in(0, rec, in_head)
    }

    /// 저장소 `repo` 의 레코드를 다음 행에 넣고 행 번호를 돌려준다
    pub fn push_in(&mut self, repo: u16, rec: &CommitRecord, in_head: bool) -> u32 {
        let row = self.oids.len() as u32;
        self.oids.push(rec.oid);
        self.repo.push(repo);
        self.parents.extend_from_slice(&rec.parents);
        self.parent_off.push(self.parents.len() as u32);
        let key = (rec.author_name.clone(), rec.author_email.clone());
        let author = match self.author_index.get(&key) {
            Some(&i) => i,
            None => {
                let i = self.authors.len() as u32;
                self.authors.push(key.clone());
                self.author_index.insert(key, i);
                i
            }
        };
        self.author.push(author);
        self.author_time.push(rec.author_time);
        self.commit_time.push(rec.commit_time);
        self.subject.push(rec.subject.clone());
        self.in_head.push(in_head);
        self.by_key.insert((repo, rec.oid), row);
        row
    }

    /// 행 수
    pub fn len(&self) -> usize {
        self.oids.len()
    }

    /// 비었는지
    pub fn is_empty(&self) -> bool {
        self.oids.is_empty()
    }

    /// 행의 커밋 id
    pub fn oid(&self, row: u32) -> Oid {
        self.oids[row as usize]
    }

    /// 행의 저장소 인덱스
    pub fn repo(&self, row: u32) -> u16 {
        self.repo[row as usize]
    }

    /// 행의 부모 목록
    pub fn parents(&self, row: u32) -> &[Oid] {
        let r = row as usize;
        &self.parents[self.parent_off[r] as usize..self.parent_off[r + 1] as usize]
    }

    /// 행의 작성자 `(name, email)`
    pub fn author(&self, row: u32) -> (&str, &str) {
        let (n, e) = &self.authors[self.author[row as usize] as usize];
        (n, e)
    }

    /// 행의 작성 시각
    pub fn author_time(&self, row: u32) -> i64 {
        self.author_time[row as usize]
    }

    /// 행의 커밋 시각
    pub fn commit_time(&self, row: u32) -> i64 {
        self.commit_time[row as usize]
    }

    /// 행의 제목
    pub fn subject(&self, row: u32) -> &str {
        &self.subject[row as usize]
    }

    /// 행이 HEAD 에서 닿는지
    pub fn in_head(&self, row: u32) -> bool {
        self.in_head[row as usize]
    }

    /// 저장소 `repo` 의 모든 행을 HEAD 에서 닿는 것으로 표시한다. 도달성을 알 수 없을 때 전 행이 흐려지지 않게 한다
    pub fn mark_in_head(&mut self, repo: u16) {
        for (flag, r) in self.in_head.iter_mut().zip(&self.repo) {
            if *r == repo {
                *flag = true;
            }
        }
    }

    /// 커밋 id 의 행 번호 (저장소 0)
    pub fn row_of(&self, oid: &Oid) -> Option<u32> {
        self.row_of_in(0, oid)
    }

    /// 저장소 `repo` 의 커밋 id 의 행 번호
    pub fn row_of_in(&self, repo: u16, oid: &Oid) -> Option<u32> {
        self.by_key.get(&(repo, *oid)).copied()
    }

    /// 인터닝된 작성자 수
    pub fn author_count(&self) -> usize {
        self.authors.len()
    }

    /// 자식 색인이 만들어졌는지
    pub fn children_built(&self) -> bool {
        self.children_built
    }

    /// 부모 목록을 뒤집어 자식 색인을 만든다 (로드가 끝난 뒤 1회). O(n+e)
    pub fn build_children(&mut self) {
        let n = self.oids.len();
        let mut counts = vec![0u32; n + 1];
        for child in 0..n {
            let repo = self.repo[child];
            for p in self.parents(child as u32) {
                if let Some(&pr) = self.by_key.get(&(repo, *p)) {
                    counts[pr as usize + 1] += 1;
                }
            }
        }
        for i in 1..=n {
            counts[i] += counts[i - 1];
        }
        let mut fill = counts.clone();
        let mut children = vec![0u32; counts[n] as usize];
        for child in 0..n {
            let repo = self.repo[child];
            for p in self.parents(child as u32) {
                if let Some(&pr) = self.by_key.get(&(repo, *p)) {
                    let slot = fill[pr as usize] as usize;
                    children[slot] = child as u32;
                    fill[pr as usize] += 1;
                }
            }
        }
        self.child_off = counts;
        self.children = children;
        self.children_built = true;
    }

    /// 행의 자식 행 목록 (로드 순서, 색인이 없으면 빈 슬라이스)
    pub fn children_of(&self, row: u32) -> &[u32] {
        if !self.children_built {
            return &[];
        }
        let r = row as usize;
        &self.children[self.child_off[r] as usize..self.child_off[r + 1] as usize]
    }
}
