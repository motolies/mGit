//! 일반 파일 편집: 경로 검증은 파일 조회와 공유하고 저장은 revision 비교 후 원자 교체한다.
use std::io::Write;
use std::sync::PoisonError;

use mgit_git::cmd::discover;
use mgit_model::GitError;
use sha2::{Digest, Sha256};

use super::*;
use crate::events::CoreEvent;
use crate::refresh::RefreshScope;

/// 편집 가능한 줄바꿈 형식이다. 개행 없는 파일은 LF로 시작한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsLineEnding {
    Lf,
    Crlf,
}

/// 원문의 줄 끝 종류별 개수. 편집 가능 판정과 줄 끝 통일 확인 안내가 같은 세기를 쓴다
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FsLineEndingCounts {
    /// `\n` (앞에 `\r` 이 없는 것)
    pub lf: u32,
    /// `\r\n`
    pub crlf: u32,
    /// 뒤에 `\n` 이 없는 단독 `\r`
    pub cr: u32,
}

impl FsLineEndingCounts {
    /// 원문의 줄 끝을 센다. `\r\n` 은 CRLF 하나로, 뒤에 `\n` 이 없는 `\r` 은 단독 CR 로 센다
    pub fn of(text: &str) -> Self {
        let mut counts = Self::default();
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                    counts.crlf += 1;
                    i += 2;
                    continue;
                }
                b'\r' => counts.cr += 1,
                b'\n' => counts.lf += 1,
                _ => {}
            }
            i += 1;
        }
        counts
    }

    /// 한 가지 줄 끝만 쓰면 그 형식 (줄 끝이 없으면 LF). LF·CRLF 가 섞였거나 단독 CR 이 있으면 None
    pub fn uniform(self) -> Option<FsLineEnding> {
        match (self.lf > 0, self.crlf > 0, self.cr > 0) {
            (_, _, true) | (true, true, _) => None,
            (false, true, false) => Some(FsLineEnding::Crlf),
            _ => Some(FsLineEnding::Lf),
        }
    }
}

/// 편집 조회 결과. 원문은 `encoding` 으로 디코드한 글자열이고 BOM(맨 앞 U+FEFF)과 줄 끝을 그대로 품는다. `guessed` 는
/// BOM 이 없고 UTF-8 이 아니어서 후보 중에서 고른 인코딩이라는 뜻이다 (R2)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsEditableFile {
    Text {
        text: String,
        size: u64,
        file_key: String,
        revision: String,
        line_ending: FsLineEnding,
        bom: bool,
        encoding: FsEncoding,
        guessed: bool,
    },
    Unavailable(FsFile),
    /// 줄 끝이 섞였거나 단독 CR 이 있어 편집기로 열 수 없다. 원문은 읽기 전용으로 보이고, revision 은 줄 끝 통일
    /// 저장(`fs_normalize_line_endings`)의 비교 기준이다
    MixedLineEndings {
        text: String,
        size: u64,
        revision: String,
        counts: FsLineEndingCounts,
        encoding: FsEncoding,
        guessed: bool,
    },
    /// 같은 인코딩으로 다시 쓰면 원래 바이트와 달라져 편집할 수 없다 (R2). 원문은 읽기 전용으로 보인다. `malformed` 면
    /// 고른 인코딩으로 읽을 수 없는 바이트가 있어 U+FFFD 로 보이고, 아니면 같은 글자를 다른 바이트로 쓰게 된다
    Lossy {
        text: String,
        size: u64,
        encoding: FsEncoding,
        guessed: bool,
        malformed: bool,
    },
}

/// 저장할 원문: 편집기가 만든 원문, 또는 지금 디스크 원문의 줄 끝을 한 형식으로 통일한 것
pub(super) enum SaveContent {
    Text(String),
    Normalize(FsLineEnding),
}

/// 저장은 새 파일을 만들지 않으며 비교 실패 시 기존 디스크와 초안을 그대로 둔다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsSaveResult {
    Saved { revision: String },
    Conflict,
    Failed { message: String },
}

impl Core {
    /// 편집 원문과 실제 경로 식별 키, 메타데이터·원문을 묶은 revision을 조회한다. 인코딩은 BOM·UTF-8·후보 차례로 정한다
    pub async fn fs_read_editable_file(
        &self,
        session: SessionId,
        path: &str,
    ) -> Result<FsEditableFile, CoreError> {
        self.fs_read_editable_file_as(session, path, None).await
    }

    /// `fs_read_editable_file` 의 인코딩 지정 판 (R2): `encoding` 이 있으면 그 인코딩으로만 읽는다 (사용자가 고른 인코딩).
    /// 그 인코딩으로 읽을 수 없는 바이트가 있거나 다시 쓰면 바이트가 달라지면 `Lossy` (읽기 전용)
    pub async fn fs_read_editable_file_as(
        &self,
        session: SessionId,
        path: &str,
        encoding: Option<FsEncoding>,
    ) -> Result<FsEditableFile, CoreError> {
        let (root, path) = self.fs_space(session)?.locate(path)?.into_under(path)?;
        run_blocking(move || read_editable_at(&root, &path, encoding)).await
    }

    /// 열린 편집기의 주기 검사용 표지 (N6): 원문을 읽지 않고 파일 메타데이터만 묶은 값을 경로마다 돌려준다. 원문이
    /// 바뀌는 쓰기는 수정·변경 시각을 바꾸므로 표지도 바뀐다 — 표지가 같으면 다시 읽지 않아도 된다. 경로 확인은 편집
    /// 조회와 같고, 없거나·막혔거나·일반 파일이 아니거나·경로가 잘못됐으면 그 자리는 None 이다
    pub async fn fs_file_stamps(
        &self,
        session: SessionId,
        paths: &[String],
    ) -> Result<Vec<Option<String>>, CoreError> {
        let space = self.fs_space(session)?;
        let paths = paths.to_vec();
        run_blocking(move || {
            // 경로 하나가 잘못됐으면 그 자리만 None 이다 (나누기 실패·그룹 맨 위도 같다)
            Ok(paths
                .iter()
                .map(|p| {
                    let (root, rest) = space.locate(p).ok()?.into_under(p).ok()?;
                    stamp_at(&root, &rest)
                })
                .collect())
        })
        .await
    }

    /// 저장소 쓰기 큐와 실제 파일 단위 잠금을 잡은 뒤 revision을 재검증하여 UTF-8 로 저장한다.
    pub async fn fs_save_file(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        text: &str,
    ) -> Result<FsSaveResult, CoreError> {
        self.fs_save_file_as(session, path, expected_revision, text, FsEncoding::Utf8)
            .await
    }

    /// `fs_save_file` 의 인코딩 지정 판 (R2): 원문을 `encoding` 으로 다시 써서 저장한다. revision 은 같은 인코딩으로 읽은
    /// 조회의 것이어야 하고, 그 인코딩으로 쓸 수 없는 글자가 있으면 쓰지 않고 `Failed` 다
    pub async fn fs_save_file_as(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        text: &str,
        encoding: FsEncoding,
    ) -> Result<FsSaveResult, CoreError> {
        self.fs_write_checked(
            session,
            path,
            expected_revision,
            SaveContent::Text(text.to_owned()),
            encoding,
        )
        .await
    }

    /// 줄 끝이 섞인 파일을 사용자가 고른 형식 하나로 통일해 저장한다. 원문은 코어가 잠금 안에서 다시 읽어 바꾸므로
    /// 줄 끝 밖의 바이트(BOM 포함)와 마지막 줄 끝의 유무는 그대로다. 단독 CR 도 줄 끝으로 바꾼다. 저장 경로·revision
    /// 검사·갱신은 `fs_save_file` 과 같다 (읽은 뒤 바뀌었으면 `Conflict`)
    pub async fn fs_normalize_line_endings(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        line_ending: FsLineEnding,
    ) -> Result<FsSaveResult, CoreError> {
        self.fs_normalize_line_endings_as(
            session,
            path,
            expected_revision,
            line_ending,
            FsEncoding::Utf8,
        )
        .await
    }

    /// `fs_normalize_line_endings` 의 인코딩 지정 판 (R2): 지금 원문을 `encoding` 으로 읽어 줄 끝을 통일한 뒤 같은
    /// 인코딩으로 다시 쓴다
    pub async fn fs_normalize_line_endings_as(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        line_ending: FsLineEnding,
        encoding: FsEncoding,
    ) -> Result<FsSaveResult, CoreError> {
        self.fs_write_checked(
            session,
            path,
            expected_revision,
            SaveContent::Normalize(line_ending),
            encoding,
        )
        .await
    }

    /// 저장 공용 경로: 경로 확인 → 저장소 쓰기 큐·파일 잠금 → revision 재검증 후 원자 교체 → 세션·폴더 갱신.
    /// 편집기 저장·줄 끝 통일·여러 파일 바꾸기(`replace`)가 함께 쓴다. 원문은 `encoding` 으로 읽고 다시 쓴다
    pub(super) async fn fs_write_checked(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        content: SaveContent,
        encoding: FsEncoding,
    ) -> Result<FsSaveResult, CoreError> {
        let _mutation_guard = super::FS_MUTATION_LOCK.lock().await;
        let (result, written) = self
            .fs_write_unrefreshed(session, path, expected_revision, content, encoding)
            .await?;
        self.refresh_after_writes(written.as_slice()).await;
        Ok(result)
    }

    /// `fs_write_checked` 에서 갱신만 뺀 것. 호출자가 `FS_MUTATION_LOCK` 을 쥐고 부르며, 저장했으면 돌려준 대상을
    /// `refresh_after_writes` 로 갱신한다 — 여러 파일을 쓰는 쪽(바꾸기)이 세션마다 한 번만 다시 읽게 한다
    pub(super) async fn fs_write_unrefreshed(
        &self,
        session: SessionId,
        path: &str,
        expected_revision: &str,
        content: SaveContent,
        encoding: FsEncoding,
    ) -> Result<(FsSaveResult, Option<Written>), CoreError> {
        let (root, rest) = self.fs_space(session)?.locate(path)?.into_under(path)?;
        let path = rest.as_str();
        let parsed = parse(path)?;
        let root_for_resolve = root.clone();
        let request = path.to_owned();
        let resolved =
            run_blocking(move || resolve(&root_for_resolve, parsed.components(), &request)).await?;
        let Resolved::Found(target) = resolved else {
            return Ok((FsSaveResult::Conflict, None));
        };
        if !target.meta.is_file() || target.meta.file_type().is_symlink() {
            return Ok((FsSaveResult::Conflict, None));
        }
        let inner = self.inner_arc();
        // 폴더로 연 저장소 파일도 git 작업과 동일한 큐를 사용한다. 판별 오류를 일반 폴더로 숨기지 않는다.
        let repo = match discover(inner.runner(), target.path.parent().unwrap_or(&root)).await {
            Ok(repo) => Some(repo),
            Err(GitError::NotARepository(_)) => None,
            Err(error) => return Err(error.into()),
        };
        let repo_lock = repo.as_ref().map(|r| inner.write_lock_for(&r.common_dir));
        let _repo_guard = match &repo_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        let file_lock = inner.write_lock_for(&target.path);
        let _file_guard = file_lock.lock().await;
        let expected = expected_revision.to_owned();
        let request = path.to_owned();
        let result =
            run_blocking(move || save_at(&root, &request, &expected, &content, encoding)).await?;
        drop(_file_guard);
        drop(_repo_guard);
        let written = matches!(result, FsSaveResult::Saved { .. }).then(|| Written {
            target: target.path,
            repo: repo.map(|r| r.work_tree),
        });
        Ok((result, written))
    }

    /// 저장한 파일을 품은 세션은 상태를 한 번씩 다시 읽고, 그 파일을 품은 폴더에는 저장소마다 한 번씩 알린다. 기존
    /// 갱신 파이프라인에 연결할 뿐 인덱스를 바꾸는 명령은 실행하지 않는다
    pub(super) async fn refresh_after_writes(&self, written: &[Written]) {
        if written.is_empty() {
            return;
        }
        let inner = self.inner_arc();
        let sessions: Vec<_> = inner
            .sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for opened in sessions {
            if written
                .iter()
                .any(|w| w.target.starts_with(&opened.info.work_tree))
            {
                inner
                    .refresh_session(
                        &opened,
                        RefreshScope {
                            status: true,
                            ..RefreshScope::default()
                        },
                    )
                    .await;
            }
        }
        let folders: Vec<_> = inner
            .folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for folder in folders {
            let mut repos: Vec<Option<PathBuf>> = Vec::new();
            for w in written.iter().filter(|w| folder.contains(&w.target)) {
                if !repos.contains(&w.repo) {
                    repos.push(w.repo.clone());
                }
            }
            for repo in repos {
                folder.sink.emit(CoreEvent::FolderChanged {
                    session: folder.id,
                    refs: false,
                    repo,
                });
            }
        }
    }
}

/// 저장한 파일 하나: 실제 경로와 그 파일을 품은 저장소의 작업 트리 (쓰기 뒤 갱신 대상)
pub(super) struct Written {
    target: PathBuf,
    repo: Option<PathBuf>,
}

/// 줄 끝 혼합이나 단독 CR은 편집기 정규화로 훼손될 수 있으므로 거부한다.
fn line_ending(text: &str) -> Option<FsLineEnding> {
    FsLineEndingCounts::of(text).uniform()
}

/// 모든 줄 끝(LF·CRLF·단독 CR)을 `target` 하나로 바꾼다. 줄 끝이 아닌 바이트(BOM·UTF-8 글자)와 마지막 줄 끝의 유무는
/// 그대로다. `\r\r\n` 은 단독 CR 과 CRLF 라서 줄 끝 둘이 된다 — 파일 보기가 줄을 나누는 방식과 같다
fn normalize_line_endings(text: &str, target: FsLineEnding) -> String {
    let eol = match target {
        FsLineEnding::Lf => "\n",
        FsLineEnding::Crlf => "\r\n",
    };
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len() + text.len() / 16);
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let width = match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => 2,
            b'\r' | b'\n' => 1,
            _ => {
                i += 1;
                continue;
            }
        };
        // `\r`·`\n` 은 ASCII 라 그 앞뒤는 늘 글자 경계다
        out.push_str(&text[start..i]);
        out.push_str(eol);
        i += width;
        start = i;
    }
    out.push_str(&text[start..]);
    out
}

/// 저장할 수 없는 원문이면 실패 결과 (NUL·줄 끝 혼합). 저장할 수 있으면 None. 크기 상한은 인코딩한 바이트로 본다
/// (`oversized` — EUC-KR 한글은 UTF-8 글자열보다 바이트가 적다)
fn unsavable(text: &str) -> Option<FsSaveResult> {
    if text.contains('\0') || line_ending(text).is_none() {
        return Some(FsSaveResult::Failed {
            message: pick("지원하지 않는 텍스트 형식입니다", "Unsupported text format").into(),
        });
    }
    None
}

/// 인코딩한 바이트가 1 MiB 를 넘으면 실패 결과
fn oversized(bytes: &[u8]) -> Option<FsSaveResult> {
    (bytes.len() as u64 > FS_READ_MAX_BYTES).then(|| FsSaveResult::Failed {
        message: pick("파일이 1 MiB를 초과합니다", "File exceeds 1 MiB").into(),
    })
}

/// 원문을 파일의 인코딩으로 다시 쓴다. 그 인코딩으로 쓸 수 없는 글자가 있으면 그 글자를 알리는 실패 결과
fn encode_for_save(text: &str, encoding: FsEncoding) -> Result<Vec<u8>, FsSaveResult> {
    encoding.encode(text).map_err(|ch| FsSaveResult::Failed {
        message: tr!(
            "이 파일의 인코딩({name})으로 쓸 수 없는 글자가 있습니다: {ch} (U+{code:04X})",
            "Contains a character that this file's encoding ({name}) can't store: {ch} (U+{code:04X})",
            name = encoding.label(),
            code = u32::from(ch),
        ),
    })
}

/// 편집 조회 결과의 revision 과 원문. 줄 끝이 섞인 파일도 revision 을 가진다 (통일 저장의 비교 기준). 텍스트가 아니거나
/// 그 인코딩으로 다시 쓸 수 없으면(`Lossy`) None
fn checked_revision(file: FsEditableFile) -> Option<(String, String)> {
    match file {
        FsEditableFile::Text { revision, text, .. }
        | FsEditableFile::MixedLineEndings { revision, text, .. } => Some((revision, text)),
        FsEditableFile::Unavailable(_) | FsEditableFile::Lossy { .. } => None,
    }
}

/// 원문 바이트와 정밀 수정 시각·파일 식별자를 묶어 외부 교체와 동일 길이 수정을 감지한다. UTF-8 파일은 원문 바이트가
/// 글자열 바이트와 같아 인코딩을 들이기 전의 revision 과 같다
fn revision(target: &Target, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(target.path.as_os_str().as_encoded_bytes());
    hash.update(bytes);
    hash.update(format!("{:?}", target.meta.modified()).as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(target.meta.dev().to_le_bytes());
        hash.update(target.meta.ino().to_le_bytes());
        hash.update(target.meta.mode().to_le_bytes());
        hash.update(target.meta.ctime().to_le_bytes());
        hash.update(target.meta.ctime_nsec().to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// 원문 없이 메타데이터만 묶은 표지 (`fs_file_stamps`). `revision` 에서 원문 대신 크기를 넣은 것이다
fn stamp(target: &Target) -> String {
    let mut hash = Sha256::new();
    hash.update(target.path.as_os_str().as_encoded_bytes());
    hash.update(target.meta.len().to_le_bytes());
    hash.update(format!("{:?}", target.meta.modified()).as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(target.meta.dev().to_le_bytes());
        hash.update(target.meta.ino().to_le_bytes());
        hash.update(target.meta.mode().to_le_bytes());
        hash.update(target.meta.ctime().to_le_bytes());
        hash.update(target.meta.ctime_nsec().to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// 경로 하나의 표지. 편집 조회와 같은 경로 확인을 거치고, 일반 파일(링크 아님)이 아니면 None
fn stamp_at(root: &Path, request: &str) -> Option<String> {
    let rel = parse(request).ok()?;
    match resolve(root, rel.components(), request).ok()? {
        Resolved::Found(target) if target.meta.is_file() => Some(stamp(&target)),
        _ => None,
    }
}

/// 기존 경로 안전성 검사와 제한을 적용하고 원문 읽기 전후 revision이 같을 때만 반환한다. 원문 바이트는 인코딩 규칙
/// (`encoding::decode` — `choice` 가 있으면 그 인코딩, 없으면 BOM·UTF-8·후보)으로 디코드한다 (R2). 바이너리 판정(앞부분의
/// NUL)은 UTF-16 으로 읽을 때 하지 않는다 — 글자의 반이 NUL 이다
pub(super) fn read_editable_at(
    root: &Path,
    request: &str,
    choice: Option<FsEncoding>,
) -> Result<FsEditableFile, CoreError> {
    let rel = parse(request)?;
    let target = match resolve(root, rel.components(), request)? {
        Resolved::Found(target) => target,
        Resolved::Missing => return Ok(FsEditableFile::Unavailable(FsFile::Missing)),
        Resolved::Denied => return Ok(FsEditableFile::Unavailable(FsFile::Denied)),
    };
    let bytes = match read_target_bytes(&target, request)? {
        RawFile::Bytes { bytes, stat_size } => match too_large(bytes.len() as u64, stat_size) {
            Some(large) => return Ok(FsEditableFile::Unavailable(large)),
            None => bytes,
        },
        RawFile::Other(file) => return Ok(FsEditableFile::Unavailable(file)),
    };
    let size = bytes.len() as u64;
    if !choice.or_else(|| sniff_bom(&bytes)).is_some_and(is_utf16) && has_nul_in_probe(&bytes) {
        return Ok(FsEditableFile::Unavailable(FsFile::Binary { size }));
    }
    let Some(decoded) = decode(&bytes, choice) else {
        return Ok(FsEditableFile::Unavailable(FsFile::NotUtf8 { size }));
    };
    let (text, encoding, guessed) = (decoded.text, decoded.encoding, decoded.guessed);
    if text.contains('\0') {
        return Ok(FsEditableFile::Unavailable(FsFile::Binary { size }));
    }
    let now = match resolve(root, rel.components(), request)? {
        Resolved::Found(now) => now,
        _ => return Ok(FsEditableFile::Unavailable(FsFile::Missing)),
    };
    if revision(&target, &bytes) != revision(&now, &bytes) {
        return Err(rejected(request, CHANGED_REASON));
    }
    if !decoded.lossless {
        return Ok(FsEditableFile::Lossy {
            text,
            size,
            encoding,
            guessed,
            malformed: decoded.malformed,
        });
    }
    let counts = FsLineEndingCounts::of(&text);
    let Some(line_ending) = counts.uniform() else {
        return Ok(FsEditableFile::MixedLineEndings {
            revision: revision(&target, &bytes),
            text,
            size,
            counts,
            encoding,
            guessed,
        });
    };
    Ok(FsEditableFile::Text {
        revision: revision(&target, &bytes),
        file_key: format!(
            "{:x}",
            Sha256::digest(target.path.as_os_str().as_encoded_bytes())
        ),
        bom: text.starts_with('\u{feff}'),
        text,
        size,
        line_ending,
        encoding,
        guessed,
    })
}

/// 임시 파일에 권한과 원문을 기록하고 교체 직전에 경로·revision을 다시 검사한다. 줄 끝 통일은 revision 이 맞은
/// 지금 원문을 바꾼 것을 쓴다. 원문은 `encoding` 으로 읽고(같은 인코딩으로 읽은 조회의 revision 과 견준다) 같은 인코딩으로
/// 다시 쓴다 — BOM 은 글자열 맨 앞의 U+FEFF 라 그대로 돌아온다
fn save_at(
    root: &Path,
    request: &str,
    expected: &str,
    content: &SaveContent,
    encoding: FsEncoding,
) -> Result<FsSaveResult, CoreError> {
    let failed = |message: &str| FsSaveResult::Failed {
        message: message.into(),
    };
    if let SaveContent::Text(text) = content
        && let Some(result) = unsavable(text)
    {
        return Ok(result);
    }
    let Some((current, current_text)) =
        checked_revision(read_editable_at(root, request, Some(encoding))?)
    else {
        return Ok(FsSaveResult::Conflict);
    };
    if current != expected {
        return Ok(FsSaveResult::Conflict);
    }
    let normalized;
    let text = match content {
        SaveContent::Text(text) => text.as_str(),
        SaveContent::Normalize(target) => {
            normalized = normalize_line_endings(&current_text, *target);
            if let Some(result) = unsavable(&normalized) {
                return Ok(result);
            }
            normalized.as_str()
        }
    };
    let bytes = match encode_for_save(text, encoding) {
        Ok(bytes) => bytes,
        Err(result) => return Ok(result),
    };
    if let Some(result) = oversized(&bytes) {
        return Ok(result);
    }
    let rel = parse(request)?;
    let Resolved::Found(target) = resolve(root, rel.components(), request)? else {
        return Ok(FsSaveResult::Conflict);
    };
    if target.meta.permissions().readonly() {
        return Ok(failed(pick("읽기 전용 파일입니다", "File is read-only")));
    }
    let save = || -> Result<FsSaveResult, CoreError> {
        let parent = target
            .path
            .parent()
            .ok_or_else(|| rejected(request, OUTSIDE_REASON))?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".mgit-save-")
            .tempfile_in(parent)?;
        temporary
            .as_file()
            .set_permissions(target.meta.permissions())?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        let Some((latest, _)) = checked_revision(read_editable_at(root, request, Some(encoding))?)
        else {
            return Ok(FsSaveResult::Conflict);
        };
        if latest != expected {
            return Ok(FsSaveResult::Conflict);
        }
        temporary
            .persist(&target.path)
            .map_err(|error| CoreError::Io(error.error))?;
        let meta = std::fs::symlink_metadata(&target.path)?;
        Ok(FsSaveResult::Saved {
            revision: revision(
                &Target {
                    path: target.path.clone(),
                    meta,
                },
                &bytes,
            ),
        })
    };
    match save() {
        Ok(result) => Ok(result),
        Err(CoreError::Io(error)) => Ok(FsSaveResult::Failed {
            message: error.kind().to_string(),
        }),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// 줄 끝 세기: CRLF 는 하나로, 뒤에 LF 가 없는 CR 은 단독 CR 로 센다. 한 가지만 쓰면 그 형식이다
    #[test]
    fn counts_line_endings_and_judges_uniformity() {
        let counts = FsLineEndingCounts::of("a\nb\r\nc\rd\r\r\n");
        assert_eq!(
            counts,
            FsLineEndingCounts {
                lf: 1,
                crlf: 2,
                cr: 2
            }
        );
        assert_eq!(counts.uniform(), None);
        assert_eq!(
            FsLineEndingCounts::of("a\r\nb\r\n").uniform(),
            Some(FsLineEnding::Crlf)
        );
        assert_eq!(
            FsLineEndingCounts::of("a\nb").uniform(),
            Some(FsLineEnding::Lf)
        );
        assert_eq!(FsLineEndingCounts::of("").uniform(), Some(FsLineEnding::Lf));
        assert_eq!(FsLineEndingCounts::of("a\rb").uniform(), None);
        assert_eq!(FsLineEndingCounts::of("a\nb\r\n").uniform(), None);
    }

    /// 통일: 모든 줄 끝을 한 형식으로 바꾸고 BOM·글자·마지막 줄 끝의 유무는 그대로다
    #[test]
    fn normalizes_every_line_ending_and_keeps_other_bytes() {
        let mixed = "\u{feff}한글😀\r\nb\nc\rd\r\r\ne";
        assert_eq!(
            normalize_line_endings(mixed, FsLineEnding::Lf),
            "\u{feff}한글😀\nb\nc\nd\n\ne"
        );
        assert_eq!(
            normalize_line_endings(mixed, FsLineEnding::Crlf),
            "\u{feff}한글😀\r\nb\r\nc\r\nd\r\n\r\ne"
        );
        assert_eq!(
            normalize_line_endings("a\r\nb\n", FsLineEnding::Lf),
            "a\nb\n"
        );
        assert_eq!(normalize_line_endings("a\nb", FsLineEnding::Crlf), "a\r\nb");
        assert_eq!(normalize_line_endings("", FsLineEnding::Crlf), "");
        assert_eq!(normalize_line_endings("\r", FsLineEnding::Lf), "\n");
    }

    /// 큐 대기 중 checkout에 해당하는 외부 교체가 일어나면 잠금 뒤 재검증으로 덮어쓰기를 막는다.
    #[tokio::test]
    #[allow(clippy::unwrap_used)]
    async fn save_revision_is_checked_after_repository_queue() {
        let runner = mgit_git::TokioGitRunner::new(mgit_git::RunnerConfig::default())
            .await
            .unwrap();
        let core = Core::new(Arc::new(runner), crate::CoreConfig::default());
        let mut repo = mgit_testkit::build(mgit_testkit::Scenario::Linear(1));
        repo.write_file("f1.txt", "displayed\n");
        let opened = core
            .open_repo(repo.path(), Arc::new(|_: CoreEvent| {}))
            .await
            .unwrap();
        let session = core.inner().get(opened.session).unwrap();
        let FsEditableFile::Text { revision, .. } = core
            .fs_read_editable_file(opened.session, "f1.txt")
            .await
            .unwrap()
        else {
            panic!("텍스트여야 한다");
        };
        let lock = core.inner().write_lock_for(&session.info.common_dir);
        let held = lock.lock().await;
        let pending = core.fs_save_file(opened.session, "f1.txt", &revision, "mine");
        tokio::pin!(pending);
        tokio::select! {
            _ = &mut pending => panic!("쓰기 큐 잠금을 기다려야 한다"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(30)) => {}
        }
        repo.git_ok(["checkout", "--", "f1.txt"]);
        drop(held);
        assert_eq!(pending.await.unwrap(), FsSaveResult::Conflict);
        assert!(repo.git_ok(["diff", "--cached", "--name-only"]).is_empty());
    }
}
