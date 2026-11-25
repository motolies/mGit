//! OS 파일 clipboard와 휴지통. 경로 권한·작업 실행은 코어가 담당한다.
use std::path::Path;

pub struct NativeTrash;
impl mgit_core::FsTrash for NativeTrash {
    /// OS 휴지통으로만 이동하며 실패 시 파일을 영구 삭제하지 않는다.
    fn trash(&self, path: &Path) -> Result<(), String> {
        trash(path)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSFileManager, NSString, NSURL};
    use std::path::Path;
    const MARKER: &str = "dev.mgit.project-files";

    /// 파일 URL만 읽는다. 일반 텍스트 및 URL은 파일 경로로 해석하지 않는다.
    pub fn read() -> Result<(Vec<String>, Option<String>, i64), String> {
        let board = NSPasteboard::generalPasteboard();
        let count = board.changeCount() as i64;
        let marker = board
            .stringForType(&NSString::from_str(MARKER))
            .map(|s| s.to_string());
        let mut paths = Vec::new();
        if let Some(items) = board.pasteboardItems() {
            for item in items.iter() {
                if let Some(value) = item.stringForType(&NSString::from_str("public.file-url"))
                    && let Some(url) = NSURL::URLWithString(&value)
                    && url.isFileURL()
                    && let Some(path) = url.path()
                {
                    paths.push(path.to_string());
                }
            }
        }
        Ok((paths, marker, count))
    }
    /// OS clipboard에 파일 URL과 앱 내부 이동 여부를 식별하는 불투명 토큰을 함께 쓴다.
    pub fn write(paths: &[String], marker: &str) -> Result<i64, String> {
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if paths.is_empty() {
            return Ok(board.changeCount() as i64);
        }
        let mut items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
        for path in paths {
            let item = NSPasteboardItem::new();
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let value = url
                .absoluteString()
                .ok_or_else(|| "파일 URL을 만들지 못했습니다".to_string())?;
            if !item.setString_forType(&value, &NSString::from_str("public.file-url"))
                || !item.setString_forType(&NSString::from_str(marker), &NSString::from_str(MARKER))
            {
                return Err("파일 clipboard를 기록하지 못했습니다".into());
            }
            items.push(ProtocolObject::from_retained(item));
        }
        if !board.writeObjects(&NSArray::from_retained_slice(&items)) {
            return Err("파일 clipboard를 기록하지 못했습니다".into());
        }
        Ok(board.changeCount() as i64)
    }
    /// Foundation의 휴지통 API를 사용해 Finder에서 복구할 수 있게 한다.
    pub fn trash(path: &Path) -> Result<(), String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|e| e.to_string())
    }
}
#[cfg(target_os = "macos")]
pub use mac::{read, trash, write};

#[cfg(not(target_os = "macos"))]
/// 아직 지원하지 않는 플랫폼은 데이터를 바꾸지 않고 이유를 반환한다.
pub fn trash(_path: &Path) -> Result<(), String> {
    Err("휴지통은 현재 macOS에서 지원합니다".into())
}
#[cfg(not(target_os = "macos"))]
/// 파일 clipboard를 지원하지 않는 플랫폼에서는 비어 있는 결과를 반환한다.
pub fn read() -> Result<(Vec<String>, Option<String>, i64), String> {
    Ok((vec![], None, 0))
}
#[cfg(not(target_os = "macos"))]
/// 지원하지 않는 OS clipboard를 텍스트 clipboard로 대체하지 않는다.
pub fn write(_paths: &[String], _marker: &str) -> Result<i64, String> {
    Err("파일 clipboard는 현재 macOS에서 지원합니다".into())
}
