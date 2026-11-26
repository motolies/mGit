//! 미리보기 이미지도 파일 조회의 경로·핸들 경계를 그대로 사용한다.
use super::*;
use base64::Engine;
use quick_xml::{Reader, events::Event};

/// 로컬 이미지 크기 상한 (5 MiB).
pub const FS_IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 이미지 읽기 결과. 성공한 이미지에만 본문을 포함한다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsImage {
    Image {
        mime: String,
        data_url: String,
        size: u64,
    },
    Missing,
    Denied,
    Unsupported,
    TooLarge {
        size: u64,
        limit: u64,
    },
}

impl Core {
    /// 세션 루트 안의 정규 이미지를 내용으로 판별하고 data URL로 반환한다.
    pub async fn fs_read_image(
        &self,
        session: SessionId,
        path: &str,
    ) -> Result<FsImage, CoreError> {
        let root = self.fs_root(session)?;
        let path = path.to_owned();
        run_blocking(move || read_image_at(&root, &path)).await
    }
}

impl From<FsState> for FsImage {
    /// 기존 파일 시스템 상태를 이미지 조회 결과로 옮긴다.
    fn from(state: FsState) -> Self {
        match state {
            FsState::Missing => Self::Missing,
            FsState::Denied => Self::Denied,
        }
    }
}

/// 경로 검증과 루트 경계 확인 후 이미지를 읽는다.
fn read_image_at(root: &Path, path: &str) -> Result<FsImage, CoreError> {
    let rel = parse(path)?;
    match resolve(root, rel.components(), path)? {
        Resolved::Found(target) => read_image_target(&target, path),
        Resolved::Missing => Ok(FsImage::Missing),
        Resolved::Denied => Ok(FsImage::Denied),
    }
}

/// 링크를 따르지 않고 연 핸들의 동일성·종류·크기를 확인해 제한된 바이트만 읽는다.
fn read_image_target(target: &Target, request: &str) -> Result<FsImage, CoreError> {
    if !target.meta.is_file() {
        return Ok(FsImage::Unsupported);
    }
    let file = match open_no_follow(&target.path) {
        Ok(file) => file,
        Err(e) if is_link_refusal(&e) => return Ok(FsImage::Unsupported),
        Err(e) => return fs_state(e).map(Into::into),
    };
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Ok(FsImage::Unsupported);
    }
    if !same_file(&target.meta, &opened) {
        return Err(rejected(request, CHANGED_REASON));
    }
    if opened.len() > FS_IMAGE_MAX_BYTES {
        return Ok(FsImage::TooLarge {
            size: opened.len(),
            limit: FS_IMAGE_MAX_BYTES,
        });
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize + 1);
    if let Err(e) = (&file).take(FS_IMAGE_MAX_BYTES + 1).read_to_end(&mut bytes) {
        return fs_state(e).map(Into::into);
    }
    let size = bytes.len() as u64;
    if size > FS_IMAGE_MAX_BYTES {
        return Ok(FsImage::TooLarge {
            size: size.max(opened.len()),
            limit: FS_IMAGE_MAX_BYTES,
        });
    }
    let Some(mime) = image_mime(&bytes) else {
        return Ok(FsImage::Unsupported);
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(FsImage::Image {
        mime: mime.into(),
        data_url: format!("data:{mime};base64,{encoded}"),
        size,
    })
}

/// 확장자를 신뢰하지 않고 이미지 시그니처 또는 SVG XML 루트를 확인한다.
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.get(12..16) == Some(b"IHDR")
        && bytes.len() >= 33
    {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") && bytes.len() >= 4 {
        Some("image/jpeg")
    } else if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.len() >= 13 {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") && bytes.len() >= 20 {
        Some("image/webp")
    } else if is_svg(bytes) {
        Some("image/svg+xml")
    } else {
        None
    }
}

/// SVG는 UTF-8 XML의 유일한 루트가 svg일 때만 허용하며 외부 엔티티는 해석하지 않는다.
fn is_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut reader = Reader::from_str(text.trim_start_matches('\u{feff}'));
    reader.config_mut().check_end_names = true;
    let mut depth = 0usize;
    let mut root_seen = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                if tag.attributes().any(|attribute| attribute.is_err()) {
                    return false;
                }
                if depth == 0 {
                    if root_seen || tag.name().as_ref() != "svg" {
                        return false;
                    }
                    root_seen = true;
                }
                depth += 1;
            }
            Ok(Event::Empty(tag)) => {
                if tag.attributes().any(|attribute| attribute.is_err()) {
                    return false;
                }
                if depth == 0 {
                    if root_seen || tag.name().as_ref() != "svg" {
                        return false;
                    }
                    root_seen = true;
                }
            }
            Ok(Event::End(_)) => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            Ok(Event::Eof) => return root_seen && depth == 0,
            Ok(Event::DocType(_)) => return false,
            Ok(Event::Text(t)) if depth == 0 => {
                if !t.as_ref().chars().all(|c| c.is_ascii_whitespace()) {
                    return false;
                }
            }
            Err(_) => return false,
            _ => {}
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 확장자 대신 내용을 판별하고 SVG의 XML 경계도 확인한다.
    #[test]
    fn detects_supported_content_and_rejects_disguised_files() {
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        assert_eq!(image_mime(&png), Some("image/png"));
        assert_eq!(image_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a\x01\0\x01\0\0\0\0"), Some("image/gif"));
        assert_eq!(
            image_mime(b"RIFF\x0c\0\0\0WEBPVP8 \0\0\0\0"),
            Some("image/webp")
        );
        for svg in [
            "<svg/>",
            "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>",
            "\u{feff}<!-- 한글 --><svg></svg>",
        ] {
            assert_eq!(image_mime(svg.as_bytes()), Some("image/svg+xml"), "{svg}");
        }
        for invalid in [
            "hello.png",
            "<html><svg/></html>",
            "<svg>",
            "<svg/><svg/>",
            "<svg><path></svg>",
            "text<svg/>",
        ] {
            assert_eq!(image_mime(invalid.as_bytes()), None, "{invalid}");
        }
    }

    /// 한글·공백 이름과 상태·크기 상한, 경로 경계를 실제 파일로 검증한다.
    #[test]
    fn reads_image_and_enforces_size_and_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("한글 그림.bin");
        std::fs::write(&path, b"<svg/>").unwrap();
        assert_eq!(
            read_image_at(dir.path(), "한글 그림.bin").unwrap(),
            FsImage::Image {
                mime: "image/svg+xml".into(),
                data_url: "data:image/svg+xml;base64,PHN2Zy8+".into(),
                size: 6,
            }
        );
        assert_eq!(
            read_image_at(dir.path(), "missing.png").unwrap(),
            FsImage::Missing
        );
        std::fs::write(dir.path().join("fake.png"), b"plain text").unwrap();
        assert_eq!(
            read_image_at(dir.path(), "fake.png").unwrap(),
            FsImage::Unsupported
        );
        std::fs::create_dir(dir.path().join("folder")).unwrap();
        assert_eq!(
            read_image_at(dir.path(), "folder").unwrap(),
            FsImage::Unsupported
        );
        let mut at_limit = b"<svg/>".to_vec();
        at_limit.resize(FS_IMAGE_MAX_BYTES as usize, b' ');
        std::fs::write(dir.path().join("limit.svg"), at_limit).unwrap();
        assert!(matches!(
            read_image_at(dir.path(), "limit.svg").unwrap(),
            FsImage::Image {
                size: FS_IMAGE_MAX_BYTES,
                ..
            }
        ));
        let oversized = File::create(dir.path().join("huge.png")).unwrap();
        oversized.set_len(FS_IMAGE_MAX_BYTES + 1).unwrap();
        assert_eq!(
            read_image_at(dir.path(), "huge.png").unwrap(),
            FsImage::TooLarge {
                size: FS_IMAGE_MAX_BYTES + 1,
                limit: FS_IMAGE_MAX_BYTES
            }
        );
        for invalid in [
            "../secret.svg",
            "/tmp/secret.svg",
            ".git/config",
            "folder/.GIT/config",
        ] {
            assert!(matches!(
                read_image_at(dir.path(), invalid),
                Err(CoreError::Invalid(_))
            ));
        }
    }

    /// 링크와 조회 후 파일 교체를 기존 핸들 검증으로 거부한다.
    #[cfg(unix)]
    #[test]
    fn refuses_links_and_replaced_handles() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.svg"), b"<svg/>").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.svg"),
            dir.path().join("link.svg"),
        )
        .unwrap();
        assert_eq!(
            read_image_at(dir.path(), "link.svg").unwrap(),
            FsImage::Unsupported
        );
        std::os::unix::fs::symlink(outside.path(), dir.path().join("middle")).unwrap();
        assert!(matches!(
            read_image_at(dir.path(), "middle/secret.svg"),
            Err(CoreError::Invalid(_))
        ));
        std::fs::write(dir.path().join("file.svg"), b"<svg/>").unwrap();
        let Resolved::Found(target) =
            resolve(dir.path(), &["file.svg".into()], "file.svg").unwrap()
        else {
            panic!("파일 없음")
        };
        std::fs::write(dir.path().join("replacement"), b"<svg/>").unwrap();
        std::fs::rename(dir.path().join("replacement"), dir.path().join("file.svg")).unwrap();
        assert!(matches!(
            read_image_target(&target, "file.svg"),
            Err(CoreError::Invalid(_))
        ));
    }

    /// 읽기 권한이 없으면 본문 대신 denied 상태를 반환한다.
    #[cfg(unix)]
    #[test]
    fn reports_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private.svg");
        std::fs::write(&path, b"<svg/>").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o0)).unwrap();
        // root 계정에서는 권한 비트가 읽기를 막지 않으므로 해당 환경만 건너뛴다.
        if File::open(&path).is_err() {
            assert_eq!(
                read_image_at(dir.path(), "private.svg").unwrap(),
                FsImage::Denied
            );
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}
