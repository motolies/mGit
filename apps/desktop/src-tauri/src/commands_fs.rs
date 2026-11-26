//! 파일 트리·파일 보기 커맨드 (W10, FS-01~10). 얇은 래퍼다 — 루트는 세션 id 로만 정하고 경계 검사
//! (어휘 검증·구성요소 확인·정규화 재검사·열기 대조)는 모두 코어(`mgit-core` 의 `fs_tree.rs`)가 한다.
//! 거부는 `IpcError::Internal`, 없음·권한 없음 등 정상 상태는 결과의 `kind` 로 나간다

use mgit_core::{
    FsEditableFile, FsEncoding, FsEntry, FsEntryKind, FsFile, FsImage, FsLineEnding, FsListing,
    FsSaveResult, SessionId,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// 항목 종류. 심볼릭 링크는 종류만 알린다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FsEntryKindDto {
    Dir,
    File,
    Symlink,
    /// FIFO·소켓·장치 등
    Other,
}

impl From<FsEntryKind> for FsEntryKindDto {
    /// 코어 → wire
    fn from(kind: FsEntryKind) -> Self {
        match kind {
            FsEntryKind::Dir => FsEntryKindDto::Dir,
            FsEntryKind::File => FsEntryKindDto::File,
            FsEntryKind::Symlink => FsEntryKindDto::Symlink,
            FsEntryKind::Other => FsEntryKindDto::Other,
        }
    }
}

/// 디렉터리 항목 하나
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsEntryDto {
    pub name: String,
    pub kind: FsEntryKindDto,
    /// 정규 파일의 크기(바이트). 다른 종류이거나 읽지 못했으면 null
    #[specta(type = f64)]
    pub size: Option<u64>,
    /// 수정 시각(유닉스 밀리초). 읽지 못했으면 null
    #[specta(type = f64)]
    pub mtime_ms: Option<i64>,
    /// 파일 보기로 열 수 있는지 (정규 파일이고 이름이 255 바이트 이하일 때만 참)
    pub openable: bool,
}

impl From<FsEntry> for FsEntryDto {
    /// 코어 → wire
    fn from(e: FsEntry) -> Self {
        FsEntryDto {
            name: e.name,
            kind: e.kind.into(),
            size: e.size,
            mtime_ms: e.mtime_ms,
            openable: e.openable,
        }
    }
}

/// 디렉터리 나열 결과
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsDirListingDto {
    /// 디렉터리 먼저 대소문자 무시 이름순으로 정렬한 뒤 앞에서 `limit` 개. `total` 은 자르기 전 수
    /// (`.git`·UTF-8 아닌 이름 제외), `nonUtf8Names` 는 이름이 UTF-8 이 아니어서 뺀 항목 수
    Listed {
        entries: Vec<FsEntryDto>,
        total: u32,
        truncated: bool,
        non_utf8_names: u32,
    },
    /// 디렉터리가 없다 (지워졌거나 디렉터리가 아니다)
    Missing,
    /// 권한이 없어 읽지 못했다
    Denied,
}

impl From<FsListing> for FsDirListingDto {
    /// 코어 → wire
    fn from(listing: FsListing) -> Self {
        match listing {
            FsListing::Listed {
                entries,
                total,
                truncated,
                non_utf8_names,
            } => FsDirListingDto::Listed {
                entries: entries.into_iter().map(Into::into).collect(),
                total,
                truncated,
                non_utf8_names,
            },
            FsListing::Missing => FsDirListingDto::Missing,
            FsListing::Denied => FsDirListingDto::Denied,
        }
    }
}

/// 파일 읽기 결과. 본문은 `text` 일 때만 있다
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsFileDto {
    /// UTF-8 텍스트 (BOM·CRLF 그대로)
    Text {
        text: String,
        #[specta(type = specta_typescript::Number)]
        size: u64,
    },
    /// 앞 8,000 바이트 안에 NUL 이 있다
    Binary {
        #[specta(type = specta_typescript::Number)]
        size: u64,
    },
    /// UTF-8 이 아니다
    NotUtf8 {
        #[specta(type = specta_typescript::Number)]
        size: u64,
    },
    /// 크기가 `limit` 을 넘는다
    TooLarge {
        #[specta(type = specta_typescript::Number)]
        size: u64,
        #[specta(type = specta_typescript::Number)]
        limit: u64,
    },
    /// 정규 파일이 아니다 (디렉터리·심볼릭 링크·FIFO 등)
    Unsupported { file_kind: FsEntryKindDto },
    /// 파일이 없다 (지워졌다)
    Missing,
    /// 권한이 없어 읽지 못했다
    Denied,
}

impl From<FsFile> for FsFileDto {
    /// 코어 → wire. 본문은 옮기기만 한다 (복사하지 않음)
    fn from(file: FsFile) -> Self {
        match file {
            FsFile::Text { text, size } => FsFileDto::Text { text, size },
            FsFile::Binary { size } => FsFileDto::Binary { size },
            FsFile::NotUtf8 { size } => FsFileDto::NotUtf8 { size },
            FsFile::TooLarge { size, limit } => FsFileDto::TooLarge { size, limit },
            FsFile::Unsupported { kind } => FsFileDto::Unsupported {
                file_kind: kind.into(),
            },
            FsFile::Missing => FsFileDto::Missing,
            FsFile::Denied => FsFileDto::Denied,
        }
    }
}

/// 로컬 이미지 조회 결과. SVG도 앱 DOM 대신 이미지 문맥에서만 사용한다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsImageDto {
    Image {
        mime: String,
        data_url: String,
        #[specta(type = specta_typescript::Number)]
        size: u64,
    },
    Missing,
    Denied,
    Unsupported,
    TooLarge {
        #[specta(type = specta_typescript::Number)]
        size: u64,
        #[specta(type = specta_typescript::Number)]
        limit: u64,
    },
}

impl From<FsImage> for FsImageDto {
    /// 코어 이미지 결과를 wire 형식으로 옮긴다.
    fn from(image: FsImage) -> Self {
        match image {
            FsImage::Image {
                mime,
                data_url,
                size,
            } => Self::Image {
                mime,
                data_url,
                size,
            },
            FsImage::Missing => Self::Missing,
            FsImage::Denied => Self::Denied,
            FsImage::Unsupported => Self::Unsupported,
            FsImage::TooLarge { size, limit } => Self::TooLarge { size, limit },
        }
    }
}

/// 세션 루트의 이미지를 정규 파일과 5 MiB 상한 안에서 읽는다.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_image(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<FsImageDto, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_read_image(SessionId(session), &path)
        .await?
        .into())
}

/// 텍스트 파일 인코딩 (R2). 편집 조회 결과가 알리고, 사용자가 골라 다시 읽거나 저장할 때 보낸다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FsEncodingDto {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// 표준 EUC-KR 표 (CP949 를 품는다)
    EucKr,
    ShiftJis,
    EucJp,
    Gb18030,
    Big5,
    Windows1252,
}

impl From<FsEncodingDto> for FsEncoding {
    /// wire → 코어
    fn from(encoding: FsEncodingDto) -> Self {
        match encoding {
            FsEncodingDto::Utf8 => Self::Utf8,
            FsEncodingDto::Utf16Le => Self::Utf16Le,
            FsEncodingDto::Utf16Be => Self::Utf16Be,
            FsEncodingDto::EucKr => Self::EucKr,
            FsEncodingDto::ShiftJis => Self::ShiftJis,
            FsEncodingDto::EucJp => Self::EucJp,
            FsEncodingDto::Gb18030 => Self::Gb18030,
            FsEncodingDto::Big5 => Self::Big5,
            FsEncodingDto::Windows1252 => Self::Windows1252,
        }
    }
}

impl From<FsEncoding> for FsEncodingDto {
    /// 코어 → wire
    fn from(encoding: FsEncoding) -> Self {
        match encoding {
            FsEncoding::Utf8 => Self::Utf8,
            FsEncoding::Utf16Le => Self::Utf16Le,
            FsEncoding::Utf16Be => Self::Utf16Be,
            FsEncoding::EucKr => Self::EucKr,
            FsEncoding::ShiftJis => Self::ShiftJis,
            FsEncoding::EucJp => Self::EucJp,
            FsEncoding::Gb18030 => Self::Gb18030,
            FsEncoding::Big5 => Self::Big5,
            FsEncoding::Windows1252 => Self::Windows1252,
        }
    }
}

/// 원문 편집 조회 결과를 전달한다. 편집 불가 상태는 기존 파일 조회와 같은 태그다. 원문은 `encoding` 으로 디코드한
/// 글자열이고(BOM 은 맨 앞 U+FEFF), `guessed` 는 BOM 없이 UTF-8 이 아니어서 후보 중에서 고른 인코딩이라는 뜻이다 (R2 —
/// 예전 응답과 맞게 둘 다 선택 필드다: 없으면 UTF-8)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsEditableFileDto {
    Text {
        text: String,
        #[specta(type = specta_typescript::Number)]
        size: u64,
        file_key: String,
        revision: String,
        line_ending: FsLineEndingDto,
        bom: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        encoding: Option<FsEncodingDto>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        guessed: Option<bool>,
    },
    Binary {
        #[specta(type = specta_typescript::Number)]
        size: u64,
    },
    NotUtf8 {
        #[specta(type = specta_typescript::Number)]
        size: u64,
    },
    TooLarge {
        #[specta(type = specta_typescript::Number)]
        size: u64,
        #[specta(type = specta_typescript::Number)]
        limit: u64,
    },
    Unsupported {
        file_kind: FsEntryKindDto,
    },
    Missing,
    Denied,
    /// 줄 끝이 섞였거나 단독 CR 이 있어 편집할 수 없다. 원문은 읽기 전용으로 보이고, revision 은 줄 끝 통일
    /// 저장(`fs_normalize_line_endings`)의 비교 기준이다. `lf`·`crlf`·`cr` 은 줄 끝 종류별 개수다
    MixedLineEndings {
        text: String,
        #[specta(type = specta_typescript::Number)]
        size: u64,
        revision: String,
        lf: u32,
        crlf: u32,
        cr: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        encoding: Option<FsEncodingDto>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        guessed: Option<bool>,
    },
    /// 같은 인코딩으로 다시 쓰면 원래 바이트와 달라져 편집할 수 없다 (R2). 원문은 읽기 전용으로 보인다. `malformed` 면
    /// 그 인코딩으로 읽을 수 없는 바이트가 U+FFFD 로 보이고, 아니면 같은 글자를 다른 바이트로 쓰게 된다
    Lossy {
        text: String,
        #[specta(type = specta_typescript::Number)]
        size: u64,
        encoding: FsEncodingDto,
        guessed: bool,
        malformed: bool,
    },
}

/// 저장할 줄 끝 형식이다.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum FsLineEndingDto {
    Lf,
    Crlf,
}

impl From<FsLineEndingDto> for FsLineEnding {
    /// wire → 코어
    fn from(line_ending: FsLineEndingDto) -> Self {
        match line_ending {
            FsLineEndingDto::Lf => FsLineEnding::Lf,
            FsLineEndingDto::Crlf => FsLineEnding::Crlf,
        }
    }
}

impl From<FsEditableFile> for FsEditableFileDto {
    /// 코어의 원문과 상태를 손실 없이 wire 형태로 옮긴다.
    fn from(file: FsEditableFile) -> Self {
        match file {
            FsEditableFile::Text {
                text,
                size,
                file_key,
                revision,
                line_ending,
                bom,
                encoding,
                guessed,
            } => Self::Text {
                text,
                size,
                file_key,
                revision,
                line_ending: match line_ending {
                    FsLineEnding::Lf => FsLineEndingDto::Lf,
                    FsLineEnding::Crlf => FsLineEndingDto::Crlf,
                },
                bom,
                encoding: Some(encoding.into()),
                guessed: Some(guessed),
            },
            FsEditableFile::MixedLineEndings {
                text,
                size,
                revision,
                counts,
                encoding,
                guessed,
            } => Self::MixedLineEndings {
                text,
                size,
                revision,
                lf: counts.lf,
                crlf: counts.crlf,
                cr: counts.cr,
                encoding: Some(encoding.into()),
                guessed: Some(guessed),
            },
            FsEditableFile::Lossy {
                text,
                size,
                encoding,
                guessed,
                malformed,
            } => Self::Lossy {
                text,
                size,
                encoding: encoding.into(),
                guessed,
                malformed,
            },
            FsEditableFile::Unavailable(file) => match file {
                FsFile::Binary { size } => Self::Binary { size },
                FsFile::NotUtf8 { size } => Self::NotUtf8 { size },
                FsFile::TooLarge { size, limit } => Self::TooLarge { size, limit },
                FsFile::Unsupported { kind } => Self::Unsupported {
                    file_kind: kind.into(),
                },
                FsFile::Missing => Self::Missing,
                FsFile::Denied => Self::Denied,
                FsFile::Text { .. } => unreachable!("편집 가능한 텍스트는 Text로 반환한다"),
            },
        }
    }
}

/// 저장 응답에는 본문을 싣지 않아 늦은 응답이 새 초안을 덮어쓰지 않는다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsSaveResultDto {
    Saved { revision: String },
    Conflict,
    Failed { message: String },
}

impl From<FsSaveResult> for FsSaveResultDto {
    /// 코어 저장 결과를 wire로 옮긴다.
    fn from(result: FsSaveResult) -> Self {
        match result {
            FsSaveResult::Saved { revision } => Self::Saved { revision },
            FsSaveResult::Conflict => Self::Conflict,
            FsSaveResult::Failed { message } => Self::Failed { message },
        }
    }
}

/// 안전한 원문 편집 조회를 세션 루트에 한정한다. `encoding` 을 주면 그 인코딩으로만 읽는다 (사용자가 고른 인코딩, R2).
/// 없으면 BOM·UTF-8·후보 차례로 정한다
#[tauri::command]
#[specta::specta]
pub async fn fs_read_editable_file(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    encoding: Option<FsEncodingDto>,
) -> Result<FsEditableFileDto, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_read_editable_file_as(SessionId(session), &path, encoding.map(Into::into))
        .await?
        .into())
}

/// 열린 편집기의 주기 검사용 표지 (원문을 읽지 않는 메타데이터 묶음). 경로마다 하나, 일반 파일이 아니면 null
#[tauri::command]
#[specta::specta]
pub async fn fs_file_stamps(
    state: State<'_, AppState>,
    session: u32,
    paths: Vec<String>,
) -> Result<Vec<Option<String>>, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_file_stamps(SessionId(session), &paths)
        .await?)
}

/// expected revision과 현재 파일이 같을 때만 원문을 저장한다. 원문은 `encoding`(없으면 UTF-8)으로 다시 써서 저장하고,
/// revision 은 같은 인코딩으로 읽은 조회의 것이어야 한다 (R2)
#[tauri::command]
#[specta::specta]
pub async fn fs_save_file(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    expected_revision: String,
    text: String,
    encoding: Option<FsEncodingDto>,
) -> Result<FsSaveResultDto, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_save_file_as(
            SessionId(session),
            &path,
            &expected_revision,
            &text,
            encoding.map_or(FsEncoding::Utf8, Into::into),
        )
        .await?
        .into())
}

/// 줄 끝이 섞인 파일을 `line_ending` 하나로 통일해 저장한다. expected revision 과 현재 파일이 같을 때만 쓴다. 원문은
/// `encoding`(없으면 UTF-8)으로 읽고 같은 인코딩으로 다시 쓴다 (R2)
#[tauri::command]
#[specta::specta]
pub async fn fs_normalize_line_endings(
    state: State<'_, AppState>,
    session: u32,
    path: String,
    expected_revision: String,
    line_ending: FsLineEndingDto,
    encoding: Option<FsEncodingDto>,
) -> Result<FsSaveResultDto, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_normalize_line_endings_as(
            SessionId(session),
            &path,
            &expected_revision,
            line_ending.into(),
            encoding.map_or(FsEncoding::Utf8, Into::into),
        )
        .await?
        .into())
}

/// 세션 루트 기준 상대 디렉터리 하나의 항목 (FS-01~05·09). `dir` 이 빈 문자열이면 루트, `limit` 이 없으면
/// 2,000 (1~50,000 으로 맞춘다). 루트 밖·`..`·절대 경로·`.git`·링크 나열·경로 중간의 링크는 거부한다
#[tauri::command]
#[specta::specta]
pub async fn fs_list_dir(
    state: State<'_, AppState>,
    session: u32,
    dir: String,
    limit: Option<u32>,
) -> Result<FsDirListingDto, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_list_dir(SessionId(session), &dir, limit)
        .await?
        .into())
}

/// 세션 루트 기준 상대 경로의 파일 하나를 텍스트로 읽는다 (FS-01~08). 상한은 1 MiB
#[tauri::command]
#[specta::specta]
pub async fn fs_read_file(
    state: State<'_, AppState>,
    session: u32,
    path: String,
) -> Result<FsFileDto, IpcError> {
    Ok(state
        .core()?
        .core
        .fs_read_file(SessionId(session), &path)
        .await?
        .into())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use mgit_core::CoreError;

    /// wire 모양: 태그는 `kind`, 필드는 camelCase. 링크 읽기는 `unsupported` + `fileKind`
    #[test]
    fn fs_dtos_serialize_with_kind_tags() {
        let listing = FsDirListingDto::from(FsListing::Listed {
            entries: vec![FsEntry {
                name: "a.txt".into(),
                kind: FsEntryKind::File,
                size: Some(3),
                mtime_ms: Some(1_700_000_000_000),
                openable: true,
            }],
            total: 5,
            truncated: true,
            non_utf8_names: 1,
        });
        assert_eq!(
            serde_json::to_value(listing).unwrap(),
            serde_json::json!({
                "kind": "listed",
                "entries": [{"name": "a.txt", "kind": "file", "size": 3, "mtimeMs": 1_700_000_000_000_i64, "openable": true}],
                "total": 5,
                "truncated": true,
                "nonUtf8Names": 1,
            })
        );
        assert_eq!(
            serde_json::to_value(FsDirListingDto::from(FsListing::Denied)).unwrap(),
            serde_json::json!({"kind": "denied"})
        );
        let cases = [
            (
                FsFile::Text {
                    text: "hi".into(),
                    size: 2,
                },
                serde_json::json!({"kind": "text", "text": "hi", "size": 2}),
            ),
            (
                FsFile::NotUtf8 { size: 4 },
                serde_json::json!({"kind": "notUtf8", "size": 4}),
            ),
            (
                FsFile::TooLarge { size: 9, limit: 8 },
                serde_json::json!({"kind": "tooLarge", "size": 9, "limit": 8}),
            ),
            (
                FsFile::Unsupported {
                    kind: FsEntryKind::Symlink,
                },
                serde_json::json!({"kind": "unsupported", "fileKind": "symlink"}),
            ),
            (FsFile::Missing, serde_json::json!({"kind": "missing"})),
        ];
        for (file, want) in cases {
            assert_eq!(serde_json::to_value(FsFileDto::from(file)).unwrap(), want);
        }
    }

    /// 편집 조회 (R2): 인코딩과 추정 여부를 싣고, 다시 쓸 수 없는 파일은 `lossy` 다. 인코딩 이름은 camelCase 다
    #[test]
    fn editable_dto_carries_encoding() {
        let text = FsEditableFile::Text {
            text: "한".into(),
            size: 2,
            file_key: "k".into(),
            revision: "r".into(),
            line_ending: FsLineEnding::Crlf,
            bom: false,
            encoding: FsEncoding::EucKr,
            guessed: true,
        };
        assert_eq!(
            serde_json::to_value(FsEditableFileDto::from(text)).unwrap(),
            serde_json::json!({"kind": "text", "text": "한", "size": 2, "fileKey": "k", "revision": "r",
                "lineEnding": "crlf", "bom": false, "encoding": "eucKr", "guessed": true})
        );
        let lossy = FsEditableFile::Lossy {
            text: "\u{fffd}".into(),
            size: 1,
            encoding: FsEncoding::Utf16Le,
            guessed: false,
            malformed: true,
        };
        assert_eq!(
            serde_json::to_value(FsEditableFileDto::from(lossy)).unwrap(),
            serde_json::json!({"kind": "lossy", "text": "\u{fffd}", "size": 1, "encoding": "utf16Le",
                "guessed": false, "malformed": true})
        );
        let chosen: FsEncodingDto = serde_json::from_value(serde_json::json!("shiftJis")).unwrap();
        assert_eq!(FsEncoding::from(chosen), FsEncoding::ShiftJis);
    }

    /// 이미지 응답은 camelCase 필드와 상태 태그를 유지한다.
    #[test]
    fn image_dto_preserves_payload_and_failure_states() {
        assert_eq!(
            serde_json::to_value(FsImageDto::from(FsImage::Image {
                mime: "image/png".into(),
                data_url: "data:image/png;base64,AA==".into(),
                size: 1,
            }))
            .unwrap(),
            serde_json::json!({"kind":"image", "mime":"image/png", "dataUrl":"data:image/png;base64,AA==", "size":1})
        );
        assert_eq!(
            serde_json::to_value(FsImageDto::from(FsImage::Unsupported)).unwrap(),
            serde_json::json!({"kind":"unsupported"})
        );
        assert_eq!(
            serde_json::to_value(FsImageDto::from(FsImage::TooLarge { size: 8, limit: 7 }))
                .unwrap(),
            serde_json::json!({"kind":"tooLarge", "size":8, "limit":7})
        );
    }

    /// 거부(코어 `Invalid`)는 wire 에서 `internal` 이고 문구는 그대로다 (절대 경로 없음은 코어가 지킨다)
    #[test]
    fn rejections_cross_the_wire_as_internal() {
        let error = IpcError::from(CoreError::Invalid(
            "파일 경로를 거부했습니다 (루트 밖입니다): \"../x\"".into(),
        ));
        let IpcError::Internal { message } = error else {
            panic!("Internal 이어야 한다");
        };
        assert!(message.ends_with("\"../x\""), "{message}");
    }
}
