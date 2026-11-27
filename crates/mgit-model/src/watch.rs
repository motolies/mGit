use std::path::PathBuf;
use std::sync::Arc;

/// 감시 대상 지정. 명세 3.2 `.git` 감시 규칙
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchSpec {
    /// 워크트리 전용 디렉터리 (`HEAD`, `index`, 진행 중 작업 파일)
    pub git_dir: PathBuf,
    /// 공유 디렉터리 (`refs/`, `packed-refs`, `config`)
    pub common_dir: PathBuf,
    /// 작업 트리. `None` 이면 `.git` 만 감시한다 (폴더 대시보드)
    pub work_tree: Option<PathBuf>,
    /// 작업 트리 감시에서 제외할 디렉터리 이름
    pub ignore_dirs: Vec<String>,
    /// 이벤트 대신 stat 폴링을 쓴다 (네트워크 드라이브)
    pub poll: bool,
}

impl WatchSpec {
    /// 작업 트리 감시에서 기본으로 제외하는 디렉터리
    pub const DEFAULT_IGNORE_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "build",
        "dist",
        ".gradle",
        ".idea",
        ".next",
        "__pycache__",
        ".venv",
    ];

    /// 기본 제외 목록으로 만든다
    pub fn new(git_dir: PathBuf, common_dir: PathBuf, work_tree: Option<PathBuf>) -> Self {
        WatchSpec {
            git_dir,
            common_dir,
            work_tree,
            ignore_dirs: Self::DEFAULT_IGNORE_DIRS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            poll: false,
        }
    }
}

/// 변경 종류. 경로로 분류한다
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ChangeKind {
    /// `index`
    Index,
    /// `HEAD`, `ORIG_HEAD`
    Head,
    /// `FETCH_HEAD`. fetch 는 받은 것이 없어도 다시 쓴다. 실제로 ref 가 바뀌었으면 `Refs`·`PackedRefs`(reftable 이면
    /// `reftable/` → `Refs`)가 함께 오므로 이것만으로는 ref 를 다시 읽지 않는다 (G6)
    FetchHead,
    /// `refs/**`, `logs/**` 제외
    Refs,
    /// `packed-refs`
    PackedRefs,
    /// `MERGE_HEAD`, `rebase-merge/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `sequencer/`, `BISECT_LOG`
    Op,
    /// `config`
    Config,
    /// 작업 트리 파일
    WorkTree,
}

/// 디바운스 뒤 한 번에 전달되는 변경 묶음
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChangeSet {
    /// 정렬·중복 제거된 종류 목록
    pub kinds: Vec<ChangeKind>,
    /// 디버그용 경로 샘플 (최대 몇 개)
    pub sample_paths: Vec<PathBuf>,
}

impl ChangeSet {
    /// 종류를 추가한다 (정렬 유지, 중복 무시)
    pub fn add(&mut self, kind: ChangeKind) {
        if let Err(pos) = self.kinds.binary_search(&kind) {
            self.kinds.insert(pos, kind);
        }
    }

    /// 종류가 들어 있는지
    pub fn has(&self, kind: ChangeKind) -> bool {
        self.kinds.binary_search(&kind).is_ok()
    }

    /// 비었는지
    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }

    /// 다른 묶음을 합친다
    pub fn merge(&mut self, other: &ChangeSet) {
        for k in &other.kinds {
            self.add(*k);
        }
        for p in &other.sample_paths {
            if self.sample_paths.len() < 8 {
                self.sample_paths.push(p.clone());
            }
        }
    }
}

/// 감시 핸들. 드롭하면 감시가 멈춘다
pub trait WatchHandle: Send + Sync {}

/// 변경 콜백
pub type OnChange = Arc<dyn Fn(ChangeSet) + Send + Sync>;

/// 감시 오류
#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("{}", crate::messages::watch_init(.0))]
    Init(String),
}

/// 파일 감시 포트. `mgit-watch` 가 notify 로 구현한다
pub trait Watcher: Send + Sync + 'static {
    /// 디렉터리 하나를 비재귀로 감시한다 (폴더 루트의 저장소 추가·삭제, MR-10). 기본 구현은 미지원
    fn watch_dir(
        &self,
        _dir: PathBuf,
        _on_change: OnChange,
    ) -> Result<Box<dyn WatchHandle>, WatchError> {
        Err(WatchError::Init(
            mgit_l10n::pick(
                "디렉터리 감시를 지원하지 않습니다",
                "Directory watching is not supported",
            )
            .into(),
        ))
    }

    /// 감시를 시작한다. 콜백은 디바운스된 묶음마다 한 번 불린다
    fn watch(
        &self,
        spec: WatchSpec,
        on_change: OnChange,
    ) -> Result<Box<dyn WatchHandle>, WatchError>;
}

/// 아무것도 감시하지 않는 구현 (벤치·단위 테스트)
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopWatcher;

/// `NoopWatcher` 의 핸들
struct NoopHandle;

impl WatchHandle for NoopHandle {}

impl Watcher for NoopWatcher {
    /// 항상 성공하고 아무 이벤트도 내지 않는다
    fn watch(
        &self,
        _spec: WatchSpec,
        _on_change: OnChange,
    ) -> Result<Box<dyn WatchHandle>, WatchError> {
        Ok(Box::new(NoopHandle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_set_keeps_kinds_sorted_and_unique() {
        let mut cs = ChangeSet::default();
        cs.add(ChangeKind::WorkTree);
        cs.add(ChangeKind::Index);
        cs.add(ChangeKind::Index);
        assert_eq!(cs.kinds, vec![ChangeKind::Index, ChangeKind::WorkTree]);
        assert!(cs.has(ChangeKind::Index));
        assert!(!cs.has(ChangeKind::Refs));
    }
}
