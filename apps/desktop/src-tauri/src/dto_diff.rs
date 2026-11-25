//! diff·백업 관련 DTO (S2). `dto.rs` 와 같은 규칙으로 `From<mgit_core::…>` 변환한다

use serde::{Deserialize, Serialize};

use crate::dto::narrow_u64;

/// 파일 수준 변경 종류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
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

impl From<mgit_core::DiffChange> for DiffChange {
    /// 코어 열거형과 1:1
    fn from(c: mgit_core::DiffChange) -> Self {
        use mgit_core::DiffChange as D;
        match c {
            D::Added => DiffChange::Added,
            D::Deleted => DiffChange::Deleted,
            D::Modified => DiffChange::Modified,
            D::Renamed { similarity } => DiffChange::Renamed { similarity },
            D::Copied { similarity } => DiffChange::Copied { similarity },
            D::TypeChanged => DiffChange::TypeChanged,
        }
    }
}

/// 바이너리 크기 변화
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BinaryInfo {
    pub old_size: Option<u32>,
    pub new_size: Option<u32>,
}

impl From<mgit_core::BinaryInfo> for BinaryInfo {
    /// u64 크기를 u32 로 좁힌다 (4GB 이상은 포화)
    fn from(b: mgit_core::BinaryInfo) -> Self {
        Self {
            old_size: b.old_size.map(narrow_u64),
            new_size: b.new_size.map(narrow_u64),
        }
    }
}

/// diff 줄 종류
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

impl From<mgit_core::LineKind> for LineKind {
    /// 코어 열거형과 1:1
    fn from(k: mgit_core::LineKind) -> Self {
        match k {
            mgit_core::LineKind::Context => LineKind::Context,
            mgit_core::LineKind::Add => LineKind::Add,
            mgit_core::LineKind::Del => LineKind::Del,
        }
    }
}

/// diff 한 줄
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
    pub no_newline: bool,
}

impl From<mgit_core::DiffLine> for DiffLine {
    /// 코어 구조체와 1:1
    fn from(l: mgit_core::DiffLine) -> Self {
        Self {
            kind: l.kind.into(),
            old_no: l.old_no,
            new_no: l.new_no,
            text: l.text,
            no_newline: l.no_newline,
        }
    }
}

/// hunk 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub section: String,
    pub lines: Vec<DiffLine>,
}

impl From<mgit_core::Hunk> for Hunk {
    /// 줄 벡터를 변환한다
    fn from(h: mgit_core::Hunk) -> Self {
        Self {
            old_start: h.old_start,
            old_lines: h.old_lines,
            new_start: h.new_start,
            new_lines: h.new_lines,
            section: h.section,
            lines: h.lines.into_iter().map(Into::into).collect(),
        }
    }
}

/// 파일 하나의 diff
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub change: DiffChange,
    pub binary: Option<BinaryInfo>,
    pub hunks: Vec<Hunk>,
    pub truncated: bool,
    pub total_lines: u32,
    /// hunk 에 UTF-8 이 아닌 줄이 있다. 줄 단위 stage·discard 는 거부된다
    pub non_utf8: bool,
}

impl From<mgit_core::FileDiff> for FileDiff {
    /// 모드·blob id 는 프런트에 필요 없어 뺀다
    fn from(d: mgit_core::FileDiff) -> Self {
        Self {
            old_path: d.old_path,
            new_path: d.new_path,
            change: d.change.into(),
            binary: d.binary.map(Into::into),
            hunks: d.hunks.into_iter().map(Into::into).collect(),
            truncated: d.truncated,
            total_lines: d.total_lines,
            non_utf8: d.non_utf8,
        }
    }
}

/// 부분 스테이징 선택 (프런트 → 코어)
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LineSelection {
    pub hunk: u32,
    pub lines: Vec<u32>,
}

impl From<LineSelection> for mgit_core::LineSelection {
    /// wire → 코어
    fn from(s: LineSelection) -> Self {
        mgit_core::LineSelection {
            hunk: s.hunk,
            lines: s.lines,
        }
    }
}

/// 충돌 마커 위치
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkerHit {
    pub path: String,
    pub line: u32,
}

impl From<mgit_core::MarkerHit> for MarkerHit {
    /// 코어 구조체와 1:1
    fn from(m: mgit_core::MarkerHit) -> Self {
        Self {
            path: m.path,
            line: m.line,
        }
    }
}

/// discard 백업 항목
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: u32,
    pub rel_path: String,
    #[specta(type = specta_typescript::Number)]
    pub saved_at: i64,
    pub reason: String,
}

impl From<mgit_core::BackupRecord> for BackupRecord {
    /// 경로·id 를 wire 형식으로
    fn from(b: mgit_core::BackupRecord) -> Self {
        Self {
            id: narrow_u64(b.id),
            rel_path: b.rel_path,
            saved_at: b.saved_at,
            reason: b.reason,
        }
    }
}

/// 커밋 옵션 (프런트 → 코어)
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSpec {
    pub message: String,
    pub amend: bool,
    pub no_verify: bool,
    /// 서명 여부 (None 이면 설정대로)
    pub sign: Option<bool>,
    /// 충돌 마커가 남아 있어도 커밋한다 ("그래도 커밋")
    pub allow_conflict_markers: bool,
}

impl From<CommitSpec> for mgit_core::CommitSpec {
    /// wire → 코어
    fn from(s: CommitSpec) -> Self {
        mgit_core::CommitSpec {
            message: s.message,
            amend: s.amend,
            no_verify: s.no_verify,
            allow_empty: false,
            sign: s.sign,
            allow_conflict_markers: s.allow_conflict_markers,
        }
    }
}

/// 전체 비교 화면의 한쪽 원문과 확정된 비교 레이블.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocumentSide {
    pub path: Option<String>,
    pub label: String,
    pub content: Option<String>,
    pub line_count: u32,
}

impl From<mgit_core::DiffDocumentSide> for DiffDocumentSide {
    /// 원문과 줄 수를 그대로 전달한다.
    fn from(side: mgit_core::DiffDocumentSide) -> Self {
        Self {
            path: side.path,
            label: side.label,
            content: side.content,
            line_count: side.line_count,
        }
    }
}

/// 원래 Git 패치와 양쪽 파일 원문, 읽기 제한 및 쓰기 검증 지문.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocument {
    pub diff: FileDiff,
    pub old: DiffDocumentSide,
    pub new: DiffDocumentSide,
    pub revision: String,
    pub limit_reason: Option<String>,
}

impl From<mgit_core::DiffDocument> for DiffDocument {
    /// 원문 제한 상태를 패치의 잘림 상태와 별도로 전달한다.
    fn from(doc: mgit_core::DiffDocument) -> Self {
        Self {
            diff: doc.diff.into(),
            old: doc.old.into(),
            new: doc.new.into(),
            revision: doc.revision,
            limit_reason: doc.limit_reason,
        }
    }
}
