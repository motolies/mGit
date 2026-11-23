use std::collections::HashMap;

use mgit_model::{Oid, RefKind, RefLabel};

/// 커밋 → 라벨 목록 색인
#[derive(Debug, Default)]
pub struct RefIndex {
    by_target: HashMap<Oid, Vec<RefLabel>>,
}

impl RefIndex {
    /// 라벨 목록으로 색인을 만든다. 같은 커밋의 라벨은 현재 브랜치 → 로컬 → 원격 → 태그 순
    pub fn new(labels: Vec<RefLabel>) -> Self {
        let mut by_target: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
        for l in labels {
            by_target.entry(l.target).or_default().push(l);
        }
        for v in by_target.values_mut() {
            v.sort_by_key(|l| (kind_order(l), l.short_name.clone()));
        }
        RefIndex { by_target }
    }

    /// 커밋에 붙은 라벨
    pub fn labels_for(&self, oid: &Oid) -> &[RefLabel] {
        self.by_target.get(oid).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// 표시 순서: 현재 브랜치, 로컬, 원격, 태그
fn kind_order(l: &RefLabel) -> u8 {
    match (&l.kind, l.is_current) {
        (RefKind::LocalBranch, true) => 0,
        (RefKind::LocalBranch, false) => 1,
        (RefKind::RemoteBranch { .. }, _) => 2,
        (RefKind::Tag { .. }, _) => 3,
        (RefKind::Stash, _) => 4,
    }
}
