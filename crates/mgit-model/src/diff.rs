use serde::{Deserialize, Serialize};

/// 파일 수준 변경 종류
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiffChange {
    Added,
    Deleted,
    Modified,
    Renamed { similarity: u8 },
    Copied { similarity: u8 },
    TypeChanged,
}

/// 바이너리 파일의 크기 변화 (DIFF-02). 모르면 `None`
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinaryInfo {
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

/// diff 줄 종류
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

/// diff 한 줄
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// 이전 파일에서의 줄 번호 (추가 줄은 `None`)
    pub old_no: Option<u32>,
    /// 새 파일에서의 줄 번호 (삭제 줄은 `None`)
    pub new_no: Option<u32>,
    /// 줄 내용 (접두 문자·줄바꿈 제외, lossy UTF-8)
    pub text: String,
    /// 이 줄 뒤에 `\ No newline at end of file` 이 붙었는지
    pub no_newline: bool,
}

/// hunk 하나
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// `@@ … @@` 뒤의 함수 이름 등
    pub section: String,
    pub lines: Vec<DiffLine>,
}

/// 파일 하나의 diff
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// 이전 경로. 새 파일이면 `None`
    pub old_path: Option<String>,
    /// 새 경로. 삭제된 파일이면 `None`
    pub new_path: Option<String>,
    pub change: DiffChange,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    /// `index <old>..<new>` 의 (축약) blob id
    pub old_blob: Option<String>,
    pub new_blob: Option<String>,
    /// 바이너리면 크기 정보. 텍스트면 `None`
    pub binary: Option<BinaryInfo>,
    pub hunks: Vec<Hunk>,
    /// 크기 임계를 넘어 앞부분만 담았는지
    pub truncated: bool,
    /// 잘리기 전 전체 줄 수 (hunk 줄 합계)
    pub total_lines: u32,
    /// hunk 에 UTF-8 이 아닌 줄이 있다. 줄 내용이 lossy 라 패치로 되돌릴 수 없다
    pub non_utf8: bool,
}

impl FileDiff {
    /// 표시 경로 (새 경로 우선)
    pub fn path(&self) -> &str {
        self.new_path
            .as_deref()
            .or(self.old_path.as_deref())
            .unwrap_or("")
    }

    /// hunk 줄 수 합계
    pub fn line_count(&self) -> u32 {
        self.hunks.iter().map(|h| h.lines.len() as u32).sum()
    }

    /// 줄 수 상한을 넘으면 앞부분만 남기고 `truncated` 를 켠다
    pub fn truncate_to(&mut self, max_lines: u32) {
        let total = self.line_count();
        self.total_lines = total;
        if total <= max_lines {
            return;
        }
        let mut budget = max_lines;
        let mut kept = Vec::new();
        for mut h in self.hunks.drain(..) {
            if budget == 0 {
                break;
            }
            if h.lines.len() as u32 > budget {
                h.lines.truncate(budget as usize);
                budget = 0;
            } else {
                budget -= h.lines.len() as u32;
            }
            kept.push(h);
        }
        self.hunks = kept;
        self.truncated = true;
    }
}

/// 부분 스테이징 선택: hunk 번호와 그 안에서 고른 줄 번호(`Hunk.lines` 인덱스, Add·Del 줄만 의미 있음).
/// `lines` 가 비어 있으면 hunk 전체
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineSelection {
    pub hunk: u32,
    pub lines: Vec<u32>,
}

/// `git diff --cached --check` 가 찾은 충돌 마커 (CF-24)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarkerHit {
    pub path: String,
    pub line: u32,
}

/// 커밋이 바꾼 파일 하나 (`git diff-tree --name-status`)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// 이름 변경·복사의 원래 경로
    pub old_path: Option<String>,
    pub change: DiffChange,
}
