use serde::Serialize;

use crate::oid::Oid;

/// `git status --porcelain=v2` 의 X·Y 한 글자 상태
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
    Untracked,
    Ignored,
}

impl FileState {
    /// porcelain 글자를 상태로. 모르는 글자는 `Modified` 로 본다
    pub fn from_byte(c: u8) -> Self {
        match c {
            b'.' | b' ' => FileState::Unmodified,
            b'M' => FileState::Modified,
            b'T' => FileState::TypeChanged,
            b'A' => FileState::Added,
            b'D' => FileState::Deleted,
            b'R' => FileState::Renamed,
            b'C' => FileState::Copied,
            b'U' => FileState::Unmerged,
            b'?' => FileState::Untracked,
            b'!' => FileState::Ignored,
            _ => FileState::Modified,
        }
    }

    /// 변경 목록에 표시할 한 글자
    pub fn letter(self) -> char {
        match self {
            FileState::Unmodified => ' ',
            FileState::Modified => 'M',
            FileState::TypeChanged => 'T',
            FileState::Added => 'A',
            FileState::Deleted => 'D',
            FileState::Renamed => 'R',
            FileState::Copied => 'C',
            FileState::Unmerged => 'U',
            FileState::Untracked => '?',
            FileState::Ignored => '!',
        }
    }
}

/// 미병합 항목의 충돌 유형 (`u` 레코드의 XY 조합)
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// UU
    BothModified,
    /// AA
    BothAdded,
    /// DD
    BothDeleted,
    /// AU
    AddedByUs,
    /// UA
    AddedByThem,
    /// DU
    DeletedByUs,
    /// UD
    DeletedByThem,
}

impl ConflictKind {
    /// XY 두 글자로 유형을 판별한다. 충돌 조합이 아니면 `None`
    pub fn from_xy(x: u8, y: u8) -> Option<Self> {
        Some(match (x, y) {
            (b'U', b'U') => ConflictKind::BothModified,
            (b'A', b'A') => ConflictKind::BothAdded,
            (b'D', b'D') => ConflictKind::BothDeleted,
            (b'A', b'U') => ConflictKind::AddedByUs,
            (b'U', b'A') => ConflictKind::AddedByThem,
            (b'D', b'U') => ConflictKind::DeletedByUs,
            (b'U', b'D') => ConflictKind::DeletedByThem,
            _ => return None,
        })
    }
}

/// 서브모듈 항목의 추가 상태 (`S<C><M><U>`)
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleState {
    /// 기록된 커밋과 체크아웃된 커밋이 다름
    pub commit_changed: bool,
    /// 서브모듈 안에 추적 파일 변경이 있음
    pub tracked_changes: bool,
    /// 서브모듈 안에 untracked 파일이 있음
    pub untracked_changes: bool,
}

/// 작업 트리 상태 항목 하나 (경로 단위)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// 현재 경로 (이름 변경이면 새 경로)
    pub path: String,
    /// 이름 변경·복사의 원래 경로
    pub orig_path: Option<String>,
    /// index(staged) 쪽 상태
    pub index: FileState,
    /// 작업 트리 쪽 상태. untracked 는 `Untracked`
    pub worktree: FileState,
    pub submodule: Option<SubmoduleState>,
    /// 미병합이면 충돌 유형
    pub conflict: Option<ConflictKind>,
    /// 이름 변경·복사 유사도 (0..=100)
    pub rename_score: Option<u8>,
}

impl StatusEntry {
    /// index 에 변경이 있는지 (Staged 영역)
    pub fn is_staged(&self) -> bool {
        self.conflict.is_none()
            && !matches!(
                self.index,
                FileState::Unmodified | FileState::Untracked | FileState::Ignored
            )
    }

    /// 작업 트리에 변경이 있는지 (Unstaged 영역, untracked 제외)
    pub fn is_unstaged(&self) -> bool {
        self.conflict.is_none()
            && !matches!(
                self.worktree,
                FileState::Unmodified | FileState::Untracked | FileState::Ignored
            )
    }

    /// untracked 파일인지
    pub fn is_untracked(&self) -> bool {
        self.worktree == FileState::Untracked
    }
}

/// `--branch` 헤더
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchHeader {
    /// HEAD 커밋. unborn 이면 `None`
    pub oid: Option<Oid>,
    /// 짧은 브랜치명. detached 면 `None`
    pub head: Option<String>,
    /// 업스트림 짧은 이름 (`origin/main`)
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// `git status --porcelain=v2 -z --branch --show-stash` 결과
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkTreeStatus {
    pub branch: BranchHeader,
    pub stash_count: u32,
    pub entries: Vec<StatusEntry>,
}

/// 상태 바·툴바용 집계
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub ahead: u32,
    pub behind: u32,
    pub stash_count: u32,
    pub upstream: Option<String>,
}

impl StatusSummary {
    /// 작업 트리나 index 에 변경이 하나라도 있는지 (WIP 행 표시 조건)
    pub fn has_changes(&self) -> bool {
        self.staged + self.unstaged + self.untracked + self.conflicted > 0
    }
}

impl WorkTreeStatus {
    /// 항목을 영역별로 센다
    pub fn summary(&self) -> StatusSummary {
        let mut s = StatusSummary {
            ahead: self.branch.ahead,
            behind: self.branch.behind,
            stash_count: self.stash_count,
            upstream: self.branch.upstream.clone(),
            ..StatusSummary::default()
        };
        for e in &self.entries {
            if e.conflict.is_some() {
                s.conflicted += 1;
                continue;
            }
            if e.is_staged() {
                s.staged += 1;
            }
            if e.is_untracked() {
                s.untracked += 1;
            } else if e.is_unstaged() {
                s.unstaged += 1;
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 항목 하나를 만든다
    fn entry(index: u8, worktree: u8) -> StatusEntry {
        let x = FileState::from_byte(index);
        let y = FileState::from_byte(worktree);
        StatusEntry {
            path: "f".into(),
            orig_path: None,
            index: x,
            worktree: y,
            submodule: None,
            conflict: ConflictKind::from_xy(index, worktree),
            rename_score: None,
        }
    }

    #[test]
    fn summary_counts_each_area_once() {
        let st = WorkTreeStatus {
            branch: BranchHeader {
                ahead: 2,
                ..BranchHeader::default()
            },
            stash_count: 1,
            entries: vec![
                entry(b'M', b'.'),
                entry(b'M', b'M'),
                entry(b'.', b'D'),
                entry(b'?', b'?'),
                entry(b'U', b'U'),
            ],
        };
        let s = st.summary();
        assert_eq!(
            (s.staged, s.unstaged, s.untracked, s.conflicted),
            (2, 2, 1, 1)
        );
        assert_eq!(s.ahead, 2);
        assert_eq!(s.stash_count, 1);
        assert!(s.has_changes());
    }

    #[test]
    fn conflict_kinds_cover_all_unmerged_combinations() {
        assert_eq!(
            ConflictKind::from_xy(b'U', b'D'),
            Some(ConflictKind::DeletedByThem)
        );
        assert_eq!(ConflictKind::from_xy(b'M', b'M'), None);
    }
}
