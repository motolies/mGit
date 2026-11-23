//! 파일 트리·파일 보기 API (W10: FS-01~10, PT-01·03·09, ED-04). 세션의 루트 아래만 읽는다 — 저장소
//! 세션은 작업 트리, 폴더 세션은 폴더 경로이고, API 는 루트·절대 경로를 받지 않는다 (FS-01).
//! git 을 실행하지 않고 파일을 만들거나 고치지 않는다 (FS-10). 파일 시스템 호출은 블로킹이므로
//! `spawn_blocking` 에서 돈다 (항목이 수만 개인 디렉터리도 비동기 런타임을 막지 않는다).
//!
//! 경로 하나는 이 순서로 다룬다:
//! 1. 어휘 검증 `RelPath::parse` (FS-02·03) — NUL·절대 경로·`..`·`.`·빈 구성요소·`.git`·길이 초과 거부.
//!    나열의 빈 문자열은 루트다
//! 2. 구성요소 확인 (FS-04, `resolve`) — 정규화한 루트에서 한 단계씩 내려가며 링크를 따라가지 않는
//!    메타데이터(`symlink_metadata`)로 본다. 중간 구성요소가 심볼릭 링크면 거부, 디렉터리가 아니면 "없음"
//! 3. 정규화 재검사 (FS-05, `check_inside`) — `canonicalize` 한 경로가 정규화한 루트의 하위이고, 그 아래에
//!    `.git` 구성요소(ASCII 대소문자 무시)가 없고, 구성요소 수가 요청과 같은지. 어휘 검증이 못 막는 이름
//!    변형(파일 시스템이 `.git` 과 같은 이름으로 취급하는 다른 철자)과 2단계 뒤의 경합을 막는 2차 방어다.
//!    끝이 링크면 링크를 따라가지 않도록 부모를 정규화한다
//! 4. 열기 (FS-06, `read_target`·`list_target`) — 읽기는 링크를 따라가지 않고 막히지 않게 열고
//!    (unix: `O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`), 연 핸들의 메타데이터가 2단계에서 본 파일과 같은지
//!    (장치·inode) 대조한다. 나열은 항목 메타데이터까지 다 읽은 뒤 경로가 아직 같은 디렉터리인지 다시 본다
//!
//! 남는 한계: 검사가 경로 기준이라 "확인한 뒤 바꿔치기"를 완전히 닫지는 못한다. 중간 디렉터리가 링크로
//! 한 번 바뀌거나 바뀐 채 남는 경우는 4단계의 대조가 막지만, 루트 안에 쓸 수 있는 로컬 프로세스가
//! 2단계 도중에 바꾸고 → 3단계 전에 되돌리고 → 4단계 직전에 다시 바꾸는 세 번의 교체를 맞추면 기록한
//! 파일과 연 파일이 같아져 루트 밖 파일이 읽힐 수 있다. 웹뷰가 보내는 요청이나 저장소 내용만으로는 만들
//! 수 없는 조건이라 받아들였다. 닫으려면 디렉터리 핸들 기준으로 한 단계씩 여는 방식(`openat` 사슬)으로
//! 바꿔야 한다. 루트 안에 만들어 둔 하드 링크도 구분하지 못한다
//!
//! 거부(어휘 위반·루트 밖·`.git`·경로 중간의 링크·링크 나열·확인 사이에 바뀐 경로)는 `CoreError::Invalid`
//! 이고, 정상 사용 중에 만날 수 있는 파일 시스템 상태(없음·권한 없음·정규 파일 아님·큼·바이너리·
//! UTF-8 아님)는 결과의 상태다. 거부 문구에는 요청이 보낸 상대 경로까지만 싣는다 (절대 경로·파일 내용 없음)

use std::ffi::OsStr;
use std::fs::{File, FileType, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use mgit_l10n::{pick, tr};
use mgit_model::{REL_PATH_COMPONENT_MAX_BYTES, RelPath};

use crate::conflict::has_nul_in_probe;
use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;

/// 나열 항목 수의 기본 상한 (FS-09, PT-03)
pub const FS_LIST_DEFAULT_LIMIT: u32 = 2_000;
/// 나열 항목 수 상한으로 받을 수 있는 최댓값 ("더 보기"로 올려 다시 부를 때). 넘으면 이 값으로 줄인다
pub const FS_LIST_MAX_LIMIT: u32 = 50_000;
/// 파일 보기로 읽는 크기 상한 (바이트, FS-07). 충돌 편집기·diff 에는 바이트 상한이 없어(diff 는 줄 수
/// 상한 `diff_max_lines`) 1 MiB 로 정했다
pub const FS_READ_MAX_BYTES: u64 = 1024 * 1024;

/// 거부 문구에 되돌려 싣는 요청 경로의 최대 글자 수
const ECHO_MAX_CHARS: usize = 200;
/// 거부 사유 (한국어, 영어). 거부 문구를 만들 때 지금 언어의 것을 고른다
type Reason = (&'static str, &'static str);
/// `.git` 거부 사유 (어휘 검증의 문구와 같다)
const DOT_GIT_REASON: Reason = (
    "`.git` 안은 다루지 않습니다",
    "Paths inside `.git` are not allowed",
);
/// 루트 밖 거부 사유
const OUTSIDE_REASON: Reason = ("루트 밖입니다", "Outside the root");
/// 확인과 열기 사이에 경로가 바뀐 경우의 사유
const CHANGED_REASON: Reason = (
    "확인하는 사이 경로가 바뀌었습니다",
    "The path changed while it was being checked",
);

/// 항목 종류. 심볼릭 링크는 종류만 알리고 대상을 보지 않는다 (FS-04)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsEntryKind {
    Dir,
    File,
    Symlink,
    /// FIFO·소켓·장치 등
    Other,
}

/// 디렉터리 항목 하나
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    pub kind: FsEntryKind,
    /// 정규 파일의 크기(바이트). 다른 종류이거나 읽지 못했으면 `None`
    pub size: Option<u64>,
    /// 수정 시각(유닉스 밀리초, 링크면 링크 자신의 것). 읽지 못했으면 `None`
    pub mtime_ms: Option<i64>,
    /// 파일 보기로 열 수 있는지 (정규 파일이고 이름이 다시 요청할 수 있는 길이일 때만 참)
    pub openable: bool,
}

/// 디렉터리 나열 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsListing {
    /// 디렉터리 먼저 이름순으로 정렬한 뒤 앞에서 `limit` 개 (PT-01·03). `total` 은 자르기 전 수,
    /// `.git` 과 UTF-8 이 아닌 이름은 둘 다에 들지 않는다. `non_utf8_names` 는 이름이 UTF-8 이 아니어서
    /// 뺀 항목 수 — 손실 변환한 이름으로 다시 요청하면 다른 파일을 가리킬 수 있어 싣지 않는다
    Listed {
        entries: Vec<FsEntry>,
        total: u32,
        truncated: bool,
        non_utf8_names: u32,
    },
    /// 디렉터리가 없다 (지워졌거나 디렉터리가 아닌 것으로 바뀌었다)
    Missing,
    /// 권한이 없어 읽지 못했다
    Denied,
}

/// 파일 읽기 결과 (FS-06~08). 본문은 텍스트일 때만 싣는다
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsFile {
    /// UTF-8 텍스트. BOM·줄 끝(CRLF)은 바꾸지 않는다
    Text { text: String, size: u64 },
    /// 앞 `BINARY_PROBE`(8,000) 바이트 안에 NUL 이 있다
    Binary { size: u64 },
    /// UTF-8 이 아니다 (손실 변환본을 보내지 않는다)
    NotUtf8 { size: u64 },
    /// 크기가 `limit` 을 넘는다. 본문은 읽지 않거나 상한+1 바이트까지만 읽고 버린다
    TooLarge { size: u64, limit: u64 },
    /// 정규 파일이 아니다 (디렉터리·심볼릭 링크·FIFO 등). 링크면 대상을 읽지 않는다
    Unsupported { kind: FsEntryKind },
    /// 파일이 없다 (지워졌다)
    Missing,
    /// 권한이 없어 읽지 못했다
    Denied,
}

impl Core {
    /// 루트 기준 상대 디렉터리 하나의 항목 (FS-01~05·09). `dir` 이 빈 문자열이면 루트이고 재귀하지
    /// 않는다. `limit` 은 돌려줄 항목 수 상한 — 없으면 `FS_LIST_DEFAULT_LIMIT`, 1~`FS_LIST_MAX_LIMIT` 로
    /// 맞춘다. 모르는 세션은 `SessionNotFound`, 거부는 `Invalid`, 예상하지 못한 입출력 오류는 `Io`
    pub async fn fs_list_dir(
        &self,
        session: SessionId,
        dir: &str,
        limit: Option<u32>,
    ) -> Result<FsListing, CoreError> {
        let root = self.fs_root(session)?;
        let dir = dir.to_owned();
        let limit = limit
            .unwrap_or(FS_LIST_DEFAULT_LIMIT)
            .clamp(1, FS_LIST_MAX_LIMIT) as usize;
        run_blocking(move || list_dir_at(&root, &dir, limit)).await
    }

    /// 루트 기준 상대 경로의 파일 하나를 텍스트로 읽는다 (FS-01~08). 모르는 세션은 `SessionNotFound`,
    /// 거부는 `Invalid`, 예상하지 못한 입출력 오류는 `Io`
    pub async fn fs_read_file(&self, session: SessionId, path: &str) -> Result<FsFile, CoreError> {
        let root = self.fs_root(session)?;
        let path = path.to_owned();
        run_blocking(move || read_file_at(&root, &path)).await
    }

    /// 세션 id 로 정한 루트 (FS-01). 저장소 세션과 폴더 세션은 id 공간을 공유하므로(`alloc_session_id`)
    /// 한 id 는 둘 중 하나만 가리킨다
    fn fs_root(&self, session: SessionId) -> Result<PathBuf, CoreError> {
        let inner = self.inner_arc();
        if let Ok(repo) = inner.get(session) {
            return Ok(repo.info.work_tree.clone());
        }
        Ok(inner.folders_get(session)?.path.clone())
    }
}

/// 블로킹 파일 시스템 작업을 전용 스레드에서 돌린다. 작업이 패닉하면 입출력 오류로 바꾼다
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    tokio::task::spawn_blocking(work).await.map_err(|_| {
        CoreError::Io(io::Error::other(pick(
            "파일 작업이 중단되었습니다",
            "File operation was interrupted",
        )))
    })?
}

/// 확인을 마친 대상
struct Target {
    /// 정규화한 경로 (루트 아래). 끝이 심볼릭 링크면 정규화한 부모에 링크 이름을 붙인 것
    path: PathBuf,
    /// 끝 구성요소의 메타데이터 (링크를 따라가지 않음)
    meta: Metadata,
}

/// 2·3단계의 결과
enum Resolved {
    Found(Target),
    Missing,
    Denied,
}

/// 정상 사용 중에 만날 수 있는 입출력 오류의 분류
enum FsState {
    Missing,
    Denied,
}

impl From<FsState> for Resolved {
    /// 분류 → 2·3단계 결과
    fn from(state: FsState) -> Self {
        match state {
            FsState::Missing => Resolved::Missing,
            FsState::Denied => Resolved::Denied,
        }
    }
}

impl From<FsState> for FsListing {
    /// 분류 → 나열 결과
    fn from(state: FsState) -> Self {
        match state {
            FsState::Missing => FsListing::Missing,
            FsState::Denied => FsListing::Denied,
        }
    }
}

impl From<FsState> for FsFile {
    /// 분류 → 읽기 결과
    fn from(state: FsState) -> Self {
        match state {
            FsState::Missing => FsFile::Missing,
            FsState::Denied => FsFile::Denied,
        }
    }
}

/// 입출력 오류를 상태로 분류한다. 없음(경로 중간이 디렉터리가 아님 포함)·권한 없음만 상태이고
/// 나머지는 오류다. macOS 의 EPERM(보호된 폴더)도 권한 없음이다
fn fs_state(error: io::Error) -> Result<FsState, CoreError> {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => Ok(FsState::Missing),
        io::ErrorKind::PermissionDenied => Ok(FsState::Denied),
        _ => Err(CoreError::Io(error)),
    }
}

/// 나열 본체 (블로킹): 1단계 어휘 검증 → `resolve` → `list_target`
fn list_dir_at(root: &Path, dir: &str, limit: usize) -> Result<FsListing, CoreError> {
    let parsed;
    let rel: &[String] = if dir.is_empty() {
        &[]
    } else {
        parsed = parse(dir)?;
        parsed.components()
    };
    match resolve(root, rel, dir)? {
        Resolved::Found(target) => list_target(&target, dir, limit),
        Resolved::Missing => Ok(FsListing::Missing),
        Resolved::Denied => Ok(FsListing::Denied),
    }
}

/// 읽기 본체 (블로킹): 1단계 어휘 검증 → `resolve` → `read_target`
fn read_file_at(root: &Path, path: &str) -> Result<FsFile, CoreError> {
    let rel = parse(path)?;
    match resolve(root, rel.components(), path)? {
        Resolved::Found(target) => read_target(&target, path),
        Resolved::Missing => Ok(FsFile::Missing),
        Resolved::Denied => Ok(FsFile::Denied),
    }
}

/// 1단계 (FS-02·03): `RelPath` 의 어휘 검증. 거부 사유는 그 검증의 문구를 쓴다
fn parse(request: &str) -> Result<RelPath, CoreError> {
    RelPath::parse(request).map_err(|e| rejected_with(request, &e.to_string()))
}

/// 2·3단계 (FS-04·05): 정규화한 루트에서 구성요소를 하나씩 링크를 따라가지 않고 확인한 뒤, 정규화한
/// 경로로 루트 포함 관계와 `.git` 을 다시 본다. `rel` 은 어휘 검증을 마친 구성요소(루트면 비어 있다).
/// 끝 구성요소가 링크면 그대로 돌려준다 — 나열은 거부하고 읽기는 "지원 안 함"으로 답한다
fn resolve(root: &Path, rel: &[String], request: &str) -> Result<Resolved, CoreError> {
    let canon_root = match root.canonicalize() {
        Ok(path) => path,
        Err(e) => return fs_state(e).map(Into::into),
    };
    let mut path = canon_root.clone();
    let mut meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) => return fs_state(e).map(Into::into),
    };
    for (i, name) in rel.iter().enumerate() {
        path.push(name);
        meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) => return fs_state(e).map(Into::into),
        };
        if i + 1 < rel.len() {
            if meta.file_type().is_symlink() {
                return Err(rejected(
                    request,
                    (
                        "경로 중간에 심볼릭 링크가 있습니다",
                        "Symbolic link in the middle of the path",
                    ),
                ));
            }
            if !meta.is_dir() {
                return Ok(Resolved::Missing);
            }
        }
    }
    // 끝이 링크면 따라가지 않도록 부모를 정규화해 확인하고 링크 이름을 다시 붙인다
    let link_name = rel.last().filter(|_| meta.file_type().is_symlink());
    let (checked, depth) = match link_name {
        Some(_) => (path.parent().unwrap_or(canon_root.as_path()), rel.len() - 1),
        None => (path.as_path(), rel.len()),
    };
    let canon = match checked.canonicalize() {
        Ok(canon) => canon,
        Err(e) => return fs_state(e).map(Into::into),
    };
    check_inside(&canon_root, &canon, depth, request)?;
    let path = match link_name {
        Some(name) => canon.join(name),
        None => canon,
    };
    Ok(Resolved::Found(Target { path, meta }))
}

/// 3단계 (FS-05): 정규화한 경로가 정규화한 루트의 하위이고, 그 아래 구성요소가 모두 평범한 이름이며
/// `.git`(ASCII 대소문자 무시)이 없고, 개수가 요청과 같은지. 개수가 다르면 확인하는 사이에 경로가
/// 바뀐 것이다(링크로 바뀐 중간 구성요소 등)
fn check_inside(
    canon_root: &Path,
    canon: &Path,
    depth: usize,
    request: &str,
) -> Result<(), CoreError> {
    let below = canon
        .strip_prefix(canon_root)
        .map_err(|_| rejected(request, OUTSIDE_REASON))?;
    let mut count = 0usize;
    for part in below.components() {
        match part {
            Component::Normal(name) if is_dot_git(name) => {
                return Err(rejected(request, DOT_GIT_REASON));
            }
            Component::Normal(_) => count += 1,
            _ => return Err(rejected(request, OUTSIDE_REASON)),
        }
    }
    if count != depth {
        return Err(rejected(request, CHANGED_REASON));
    }
    Ok(())
}

/// 이름이 `.git` 인지 (ASCII 대소문자 무시, FS-03). UTF-8 이 아닌 이름도 바이트로 비교한다.
/// 충돌 편집기의 저장 경로 검사(`conflict.rs`)도 함께 쓴다
pub(crate) fn is_dot_git(name: &OsStr) -> bool {
    name.as_encoded_bytes().eq_ignore_ascii_case(b".git")
}

/// 정렬 열쇠 (PT-01). 필드 순서가 곧 비교 순서다: 디렉터리(링크 아님) 먼저 → 유니코드 소문자로 바꾼
/// 이름 → 원래 이름의 바이트 순서(소문자로 같으면 대문자가 앞: `README` < `readme`). 숫자를 수로 보지
/// 않는다 (`a10` < `a2`). 한 디렉터리의 이름은 서로 달라 순서가 하나로 정해진다
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SortKey {
    not_dir: bool,
    lower: String,
    name: String,
}

impl SortKey {
    /// 항목 종류와 이름으로 열쇠를 만든다
    fn new(kind: FsEntryKind, name: String) -> Self {
        SortKey {
            not_dir: kind != FsEntryKind::Dir,
            lower: name.to_lowercase(),
            name,
        }
    }
}

/// 정렬·자르기 전의 항목. 크기·수정 시각은 돌려줄 항목만 나중에 읽는다 (FS-09)
struct Named {
    key: SortKey,
    kind: FsEntryKind,
    entry: std::fs::DirEntry,
}

impl Named {
    /// 돌려줄 항목: 링크를 따라가지 않는 메타데이터로 크기·수정 시각을 채운다 (읽지 못하면 비운다).
    /// 이름이 어휘 검증의 구성요소 상한(255 바이트)을 넘으면 그 이름으로 다시 요청할 수 없으므로 열 수 없다
    /// (APFS 는 255 "글자"까지 허용해 한글 86자 이상이면 생긴다)
    fn into_entry(self) -> FsEntry {
        let meta = self.entry.metadata().ok();
        let file = self.kind == FsEntryKind::File;
        let requestable = self.key.name.len() <= REL_PATH_COMPONENT_MAX_BYTES;
        FsEntry {
            size: meta.as_ref().filter(|_| file).map(Metadata::len),
            mtime_ms: meta.as_ref().and_then(mtime_ms),
            openable: file && requestable,
            kind: self.kind,
            name: self.key.name,
        }
    }
}

/// 4단계 나열 (FS-03·04·09): 링크는 나열하지 않는다. `.git` 과 UTF-8 이 아닌 이름을 빼고, 정렬한 뒤
/// 자르고, 남은 항목만 메타데이터를 읽는다. 끝으로 경로가 아직 처음 확인한 그 디렉터리인지 다시 본다
/// — 읽는 사이 경로가 링크 너머를 가리키게 됐다면 결과를 버린다
fn list_target(target: &Target, dir: &str, limit: usize) -> Result<FsListing, CoreError> {
    if target.meta.file_type().is_symlink() {
        return Err(rejected(
            dir,
            (
                "심볼릭 링크는 나열하지 않습니다",
                "Symbolic links are not listed",
            ),
        ));
    }
    if !target.meta.is_dir() {
        return Ok(FsListing::Missing);
    }
    let read = match std::fs::read_dir(&target.path) {
        Ok(read) => read,
        Err(e) => return fs_state(e).map(Into::into),
    };
    let mut named = Vec::new();
    let mut non_utf8_names = 0u32;
    for item in read {
        let entry = match item {
            Ok(entry) => entry,
            Err(e) => return fs_state(e).map(Into::into),
        };
        let name = entry.file_name();
        if is_dot_git(&name) {
            continue;
        }
        let Ok(name) = name.into_string() else {
            non_utf8_names = non_utf8_names.saturating_add(1);
            continue;
        };
        // 종류는 링크를 따라가지 않고 본다. 그사이 지워진 항목은 뺀다
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let kind = kind_of(file_type);
        named.push(Named {
            key: SortKey::new(kind, name),
            kind,
            entry,
        });
    }
    named.sort_unstable_by(|a, b| a.key.cmp(&b.key));
    let total = named.len();
    named.truncate(limit);
    let entries: Vec<FsEntry> = named.into_iter().map(Named::into_entry).collect();
    match std::fs::symlink_metadata(&target.path) {
        Ok(now) if same_file(&target.meta, &now) => {}
        Ok(_) => return Err(rejected(dir, CHANGED_REASON)),
        Err(e) => return fs_state(e).map(Into::into),
    }
    Ok(FsListing::Listed {
        entries,
        total: u32::try_from(total).unwrap_or(u32::MAX),
        truncated: total > limit,
        non_utf8_names,
    })
}

/// 4단계 읽기 (FS-06·07·08): 정규 파일만 연다. 연 핸들이 정규 파일이 아니면 "지원 안 함", 확인한 그
/// 파일이 아니면(장치·inode 가 다르면) 거부한다. 크기가 상한을 넘으면 읽지 않고, 아니면 상한+1
/// 바이트까지만 읽는다 (그사이 커졌을 수 있다)
fn read_target(target: &Target, request: &str) -> Result<FsFile, CoreError> {
    let kind = kind_of(target.meta.file_type());
    if kind != FsEntryKind::File {
        return Ok(FsFile::Unsupported { kind });
    }
    let file = match open_no_follow(&target.path) {
        Ok(file) => file,
        // 확인 뒤 끝 구성요소가 링크로 바뀌었다: 대상을 읽지 않는다
        Err(e) if is_link_refusal(&e) => {
            return Ok(FsFile::Unsupported {
                kind: FsEntryKind::Symlink,
            });
        }
        Err(e) => return fs_state(e).map(Into::into),
    };
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Ok(FsFile::Unsupported {
            kind: kind_of(opened.file_type()),
        });
    }
    if !same_file(&target.meta, &opened) {
        return Err(rejected(request, CHANGED_REASON));
    }
    if opened.len() > FS_READ_MAX_BYTES {
        return Ok(FsFile::TooLarge {
            size: opened.len(),
            limit: FS_READ_MAX_BYTES,
        });
    }
    let capacity = usize::try_from(opened.len()).unwrap_or(0).saturating_add(1);
    let mut bytes = Vec::with_capacity(capacity);
    (&file)
        .take(FS_READ_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(classify(bytes, opened.len()))
}

/// 읽은 바이트를 결과로 (FS-07·08): 상한을 넘으면 본문 없이 "너무 큼"(크기는 읽은 양과 메타데이터 중
/// 큰 값), 앞 8,000 바이트에 NUL 이 있으면 바이너리, UTF-8 이 아니면 그 사실만 — 손실 변환본을 만들지
/// 않는다. 텍스트는 바이트 그대로다 (BOM·CRLF 유지)
fn classify(bytes: Vec<u8>, stat_size: u64) -> FsFile {
    let read = bytes.len() as u64;
    if read > FS_READ_MAX_BYTES {
        return FsFile::TooLarge {
            size: read.max(stat_size),
            limit: FS_READ_MAX_BYTES,
        };
    }
    if has_nul_in_probe(&bytes) {
        return FsFile::Binary { size: read };
    }
    match String::from_utf8(bytes) {
        Ok(text) => FsFile::Text { text, size: read },
        Err(_) => FsFile::NotUtf8 { size: read },
    }
}

/// 링크를 따라가지 않는 파일 종류 → 항목 종류
fn kind_of(file_type: FileType) -> FsEntryKind {
    if file_type.is_symlink() {
        FsEntryKind::Symlink
    } else if file_type.is_dir() {
        FsEntryKind::Dir
    } else if file_type.is_file() {
        FsEntryKind::File
    } else {
        FsEntryKind::Other
    }
}

/// 수정 시각 (유닉스 밀리초). 1970 년 이전이면 음수
fn mtime_ms(meta: &Metadata) -> Option<i64> {
    let modified = meta.modified().ok()?;
    match modified.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).ok(),
        Err(before) => i64::try_from(before.duration().as_millis())
            .ok()
            .map(|ms| -ms),
    }
}

/// 두 메타데이터가 같은 파일인지 (unix: 장치·inode)
#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// 두 메타데이터가 같은 파일인지. unix 가 아닌 플랫폼은 안정된 파일 식별자가 없어 종류만 본다 (미검증)
#[cfg(not(unix))]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.file_type() == b.file_type()
}

/// 읽기용으로 연다: 끝 구성요소가 링크면 실패하고(ELOOP), FIFO·장치여도 막히지 않으며, 터미널이어도
/// 제어 터미널로 삼지 않는다
#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
}

/// 읽기용으로 연다. unix 가 아닌 플랫폼은 링크를 따라갈 수 있으나 연 뒤 종류를 다시 본다 (미검증)
#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> io::Result<File> {
    File::open(path)
}

/// `O_NOFOLLOW` 가 끝 구성요소의 링크를 거부한 오류인지
#[cfg(unix)]
fn is_link_refusal(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

/// unix 가 아닌 플랫폼에는 해당 오류가 없다
#[cfg(not(unix))]
fn is_link_refusal(_error: &io::Error) -> bool {
    false
}

/// 거부 오류. 요청이 보낸 상대 경로(앞 `ECHO_MAX_CHARS` 글자)와 사유만 싣는다. 사유는 지금 언어로 고른다
fn rejected(request: &str, (ko, en): Reason) -> CoreError {
    rejected_with(request, pick(ko, en))
}

/// 이미 지금 언어로 만든 사유(어휘 검증 오류 문구 등)로 거부 오류를 만든다
fn rejected_with(request: &str, reason: &str) -> CoreError {
    let shown: String = request.chars().take(ECHO_MAX_CHARS).collect();
    CoreError::Invalid(tr!(
        "파일 경로를 거부했습니다 ({reason}): {shown:?}",
        "Rejected file path ({reason}): {shown:?}"
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#[cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]
mod tests {
    use super::*;
    use crate::conflict::BINARY_PROBE;
    use proptest::prelude::*;
    use proptest::test_runner::{Config, TestRunner};

    /// 부모 디렉터리까지 만들고 파일을 쓴다
    fn write(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// 시험용 루트 `tmp/root` 와 루트 밖 `tmp/outside`. 루트 안 파일 내용은 `MARK:<상대 경로>`,
    /// `.git` 안은 `SECRET-DOTGIT`, 루트 밖은 `SECRET-OUTSIDE` 다
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    /// 시험용 트리를 만든다 (unix 에서는 링크도)
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        for rel in ["a/b/c.txt", "a/d.txt", "top.txt"] {
            write(&root.join(rel), format!("MARK:{rel}").as_bytes());
        }
        write(&root.join(".git/config"), b"SECRET-DOTGIT");
        write(&root.join("a/.git/HEAD"), b"SECRET-DOTGIT");
        write(&outside.join("secret.txt"), b"SECRET-OUTSIDE");
        write(&outside.join("b/c.txt"), b"SECRET-OUTSIDE");
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, root.join("out-dir")).unwrap();
            symlink(outside.join("secret.txt"), root.join("out-file")).unwrap();
            symlink("a", root.join("in-dir")).unwrap();
            symlink("top.txt", root.join("in-file")).unwrap();
            symlink(".git", root.join("git-link")).unwrap();
            symlink("nowhere", root.join("broken")).unwrap();
        }
        Fixture {
            _dir: dir,
            root,
            outside,
        }
    }

    /// 거부 오류인지
    fn is_rejected<T>(r: &Result<T, CoreError>) -> bool {
        matches!(r, Err(CoreError::Invalid(_)))
    }

    /// 확인을 마친 대상. 없거나 거부면 panic (경합 시험은 unix 에서만 돈다)
    #[cfg(unix)]
    fn found(root: &Path, request: &str) -> Target {
        let rel = parse(request).unwrap();
        match resolve(root, rel.components(), request).unwrap() {
            Resolved::Found(target) => target,
            _ => panic!("대상이 없다: {request}"),
        }
    }

    /// FS-05: 정규화 뒤 검사는 루트 밖·`.git` 구성요소(대소문자 무시)·개수 불일치를 거부한다.
    /// 어휘 검증을 통과한 이름이 파일 시스템에서 `.git` 으로 풀리는 경우를 꾸며 본다
    #[test]
    fn check_inside_rejects_escape_dot_git_and_changed_depth() {
        let root = Path::new("/r/root");
        let ok = [("/r/root", 0), ("/r/root/a", 1), ("/r/root/a/b.txt", 2)];
        for (path, depth) in ok {
            assert!(
                check_inside(root, Path::new(path), depth, "x").is_ok(),
                "{path}"
            );
        }
        let bad = [
            ("/r/other/a", 1),
            ("/r", 0),
            ("/r/root/.git/config", 2),
            ("/r/root/a/.GIT", 2),
            ("/r/root/sub/.Git/HEAD", 3),
            ("/r/root/a", 2),
            ("/r/root/a/b", 1),
        ];
        for (path, depth) in bad {
            assert!(
                is_rejected(&check_inside(root, Path::new(path), depth, "x")),
                "{path}"
            );
        }
    }

    /// FS-03: `.git` 판정은 ASCII 대소문자만 무시하고 비슷한 이름은 통과시킨다
    #[test]
    fn dot_git_names_match_ascii_case_insensitively() {
        for name in [".git", ".GIT", ".Git", ".gIt"] {
            assert!(is_dot_git(OsStr::new(name)), "{name}");
        }
        for name in [".gitignore", ".git2", "git", ".git ", "a.git", ".gi"] {
            assert!(!is_dot_git(OsStr::new(name)), "{name}");
        }
    }

    /// PT-01: 디렉터리 먼저, 대소문자 무시 이름순, 같으면 원래 이름의 바이트 순서(대문자 먼저),
    /// 숫자는 글자로 본다
    #[test]
    fn sort_key_orders_dirs_first_then_case_insensitive_names() {
        let mut items = vec![
            (FsEntryKind::File, "readme"),
            (FsEntryKind::File, "README"),
            (FsEntryKind::Dir, "src"),
            (FsEntryKind::File, "a10"),
            (FsEntryKind::File, "a2"),
            (FsEntryKind::Symlink, "Docs-link"),
            (FsEntryKind::Dir, ".claude"),
            (FsEntryKind::Dir, "Build"),
            (FsEntryKind::File, "가나.txt"),
            (FsEntryKind::Other, "b.sock"),
            (FsEntryKind::File, "Ärger.txt"),
        ];
        items.sort_by(|a, b| {
            SortKey::new(a.0, a.1.to_string()).cmp(&SortKey::new(b.0, b.1.to_string()))
        });
        let names: Vec<&str> = items.iter().map(|(_, n)| *n).collect();
        assert_eq!(
            names,
            [
                ".claude",
                "Build",
                "src",
                "a10",
                "a2",
                "b.sock",
                "Docs-link",
                "README",
                "readme",
                "Ärger.txt",
                "가나.txt",
            ]
        );
    }

    /// FS-07: 상한 경계. 상한까지는 본문이 있고 상한+1 부터는 본문 없이 "너무 큼"
    #[test]
    fn classify_size_boundaries() {
        let max = FS_READ_MAX_BYTES as usize;
        for len in [max - 1, max] {
            let FsFile::Text { text, size } = classify(vec![b'a'; len], len as u64) else {
                panic!("{len} 은 텍스트여야 한다");
            };
            assert_eq!((text.len(), size), (len, len as u64));
        }
        assert_eq!(
            classify(vec![b'a'; max + 1], max as u64 + 1),
            FsFile::TooLarge {
                size: max as u64 + 1,
                limit: FS_READ_MAX_BYTES
            }
        );
        // 메타데이터가 더 크면 그 값을 알린다 (읽는 사이 커진 파일)
        assert_eq!(
            classify(vec![b'a'; max + 1], 5_000_000),
            FsFile::TooLarge {
                size: 5_000_000,
                limit: FS_READ_MAX_BYTES
            }
        );
    }

    /// FS-08: NUL 위치(앞 8,000 바이트 안/밖), 잘못된 UTF-8, BOM, 빈 내용, CRLF
    #[test]
    fn classify_binary_utf8_bom_crlf_and_empty() {
        let mut inside = vec![b'a'; BINARY_PROBE];
        inside[BINARY_PROBE - 1] = 0;
        assert_eq!(
            classify(inside, 0),
            FsFile::Binary {
                size: BINARY_PROBE as u64
            }
        );
        // 8,000 바이트 뒤의 NUL 은 바이너리가 아니다. NUL 은 올바른 UTF-8 이므로 텍스트로 온다
        let mut after = vec![b'a'; BINARY_PROBE + 1];
        after[BINARY_PROBE] = 0;
        let FsFile::Text { text, .. } = classify(after, 0) else {
            panic!("앞부분 밖의 NUL 은 텍스트");
        };
        assert!(text.ends_with('\0'));
        assert_eq!(
            classify(b"caf\xe9".to_vec(), 0),
            FsFile::NotUtf8 { size: 4 }
        );
        assert_eq!(
            classify("\u{feff}안녕".as_bytes().to_vec(), 0),
            FsFile::Text {
                text: "\u{feff}안녕".into(),
                size: 9
            }
        );
        assert_eq!(
            classify(Vec::new(), 0),
            FsFile::Text {
                text: String::new(),
                size: 0
            }
        );
        assert_eq!(
            classify(b"a\r\nb\r\n".to_vec(), 0),
            FsFile::Text {
                text: "a\r\nb\r\n".into(),
                size: 6
            }
        );
    }

    /// 거부 문구에는 요청한 상대 경로와 사유만 있고, 긴 요청은 잘린다
    #[test]
    fn rejection_message_echoes_only_the_request() {
        let CoreError::Invalid(message) = rejected("../x", OUTSIDE_REASON) else {
            panic!("Invalid 여야 한다");
        };
        assert_eq!(
            message,
            "파일 경로를 거부했습니다 (루트 밖입니다): \"../x\""
        );
        let long = "a".repeat(10_000);
        let CoreError::Invalid(message) = rejected(&long, OUTSIDE_REASON) else {
            panic!("Invalid 여야 한다");
        };
        assert!(message.len() < ECHO_MAX_CHARS + 100, "{}", message.len());
    }

    /// FS-02·05 불변식: 어떤 입력이든 2·3단계를 통과한 대상의 실제 경로는 정규화한 루트의 하위이고
    /// `.git` 구성요소가 없으며(끝이 링크가 아니면 이미 정규화된 경로), 읽은 본문·나열 이름에 루트 밖과
    /// `.git` 의 내용이 없다
    #[test]
    fn resolved_paths_stay_under_the_canonical_root() {
        let fx = fixture();
        let canon_root = fx.root.canonicalize().unwrap();
        let part = proptest::sample::select(vec![
            "a",
            "b",
            "c.txt",
            "d.txt",
            "top.txt",
            ".git",
            ".GIT",
            "config",
            "HEAD",
            "..",
            ".",
            "",
            "out-dir",
            "out-file",
            "in-dir",
            "in-file",
            "git-link",
            "broken",
            "secret.txt",
            "a\\b",
            "\0",
        ]);
        let joined = proptest::collection::vec(part, 0..5)
            .prop_map(|parts| parts.join("/"))
            .boxed();
        let strategy = prop_oneof![
            joined.clone(),
            joined.prop_map(|p| format!("/{p}")),
            "\\PC{0,24}",
        ];
        let mut runner = TestRunner::new(Config {
            cases: 512,
            failure_persistence: None,
            ..Config::default()
        });
        runner
            .run(&strategy, |request| {
                if let Ok(rel) = RelPath::parse(&request)
                    && let Ok(Resolved::Found(t)) = resolve(&fx.root, rel.components(), &request)
                {
                    prop_assert!(t.path.starts_with(&canon_root), "{:?}", t.path);
                    let below = t.path.strip_prefix(&canon_root).unwrap();
                    prop_assert!(!below.components().any(|c| is_dot_git(c.as_os_str())));
                    if !t.meta.file_type().is_symlink() {
                        prop_assert_eq!(&t.path.canonicalize().unwrap(), &t.path);
                    }
                }
                if let Ok(FsFile::Text { text, .. }) = read_file_at(&fx.root, &request) {
                    prop_assert!(text.starts_with("MARK:"), "{text}");
                }
                if let Ok(FsListing::Listed { entries, .. }) = list_dir_at(&fx.root, &request, 100)
                {
                    for e in entries {
                        prop_assert!(!is_dot_git(OsStr::new(&e.name)));
                        prop_assert!(e.name != "secret.txt", "{request:?}");
                    }
                }
                Ok(())
            })
            .unwrap();
        // 루트 밖 디렉터리는 실제로 있다 (불변식이 빈 고정물에서 공짜로 성립한 것이 아니다)
        assert!(fx.outside.join("secret.txt").is_file());
    }

    /// FS-06 (unix): FIFO 를 열어도 막히지 않는다 — 확인 뒤 정규 파일이 FIFO 로 바뀌는 경합 대비
    #[cfg(unix)]
    #[test]
    fn fifo_opens_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        let (tx, rx) = std::sync::mpsc::channel();
        let path = fifo.clone();
        std::thread::spawn(move || {
            let opened =
                open_no_follow(&path).map(|f| f.metadata().map(|m| kind_of(m.file_type())));
            let _ = tx.send(opened.ok().and_then(Result::ok));
        });
        let got = rx.recv_timeout(std::time::Duration::from_secs(5));
        if got.is_err() {
            // 막혔다면 쓰는 쪽을 열어 풀어 주고 실패시킨다
            let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
            panic!("FIFO 열기가 막혔다");
        }
        assert_eq!(got.unwrap(), Some(FsEntryKind::Other));
    }

    /// FS-06 (unix): 확인한 뒤 같은 이름의 다른 파일로 바뀌면(장치·inode 가 다르면) 읽지 않고 거부한다
    #[cfg(unix)]
    #[test]
    fn file_replaced_after_check_is_refused() {
        let fx = fixture();
        let target = found(&fx.root, "top.txt");
        std::fs::copy(fx.outside.join("secret.txt"), fx.root.join("swap")).unwrap();
        std::fs::rename(fx.root.join("swap"), fx.root.join("top.txt")).unwrap();
        assert!(is_rejected(&read_target(&target, "top.txt")));
    }

    /// FS-04·06 (unix): 확인한 뒤 끝 구성요소가 루트 밖을 가리키는 링크로 바뀌면 대상을 읽지 않는다
    #[cfg(unix)]
    #[test]
    fn final_component_swapped_to_link_is_not_followed() {
        let fx = fixture();
        let target = found(&fx.root, "top.txt");
        std::fs::remove_file(fx.root.join("top.txt")).unwrap();
        std::os::unix::fs::symlink(fx.outside.join("secret.txt"), fx.root.join("top.txt")).unwrap();
        assert_eq!(
            read_target(&target, "top.txt").unwrap(),
            FsFile::Unsupported {
                kind: FsEntryKind::Symlink
            }
        );
    }

    /// FS-04·06 (unix): 확인한 뒤 경로 중간이 루트 밖을 가리키는 링크로 바뀌면, 링크 너머에 같은 이름의
    /// 파일이 있어도 다른 파일이므로 거부한다
    #[cfg(unix)]
    #[test]
    fn middle_component_swapped_to_link_is_refused_for_reading() {
        let fx = fixture();
        let target = found(&fx.root, "a/b/c.txt");
        std::fs::rename(fx.root.join("a"), fx.root.join("a-moved")).unwrap();
        std::os::unix::fs::symlink(&fx.outside, fx.root.join("a")).unwrap();
        assert!(is_rejected(&read_target(&target, "a/b/c.txt")));
    }

    /// FS-04 (unix): 확인한 뒤 나열할 디렉터리가 루트 밖을 가리키는 링크로 바뀌면 결과를 버리고 거부한다
    #[cfg(unix)]
    #[test]
    fn directory_swapped_to_link_is_refused_for_listing() {
        let fx = fixture();
        let target = found(&fx.root, "a/b");
        std::fs::rename(fx.root.join("a/b"), fx.root.join("a/b-moved")).unwrap();
        std::os::unix::fs::symlink(fx.outside.join("b"), fx.root.join("a/b")).unwrap();
        assert!(is_rejected(&list_target(&target, "a/b", 100)));
    }

    /// 나열 (unix): UTF-8 이 아닌 이름은 결과·`total` 에서 빠지고 수만 센다. macOS(APFS)는 그런 이름을
    /// 만들 수 없어 건너뛴다
    #[cfg(unix)]
    #[test]
    fn non_utf8_names_are_counted_not_listed() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("ok.txt"), b"x");
        let odd = dir.path().join(OsStr::from_bytes(b"caf\xe9.txt"));
        if std::fs::write(&odd, b"x").is_err() {
            eprintln!("이 파일 시스템은 UTF-8 이 아닌 이름을 만들 수 없어 건너뛴다");
            return;
        }
        let FsListing::Listed {
            entries,
            total,
            non_utf8_names,
            ..
        } = list_dir_at(dir.path(), "", 100).unwrap()
        else {
            panic!("나열돼야 한다");
        };
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!((names, total, non_utf8_names), (vec!["ok.txt"], 1, 1));
    }

    /// 나열: 이름이 구성요소 상한(255 바이트)을 넘는 파일은 보이되 열 수 없다고 알린다 — 그 이름으로 읽기를
    /// 요청하면 어휘 검증에서 거부되기 때문이다. 255 바이트를 넘는 이름을 못 만드는 파일 시스템이면 건너뛴다
    #[test]
    fn over_long_names_are_listed_but_not_openable() {
        let dir = tempfile::tempdir().unwrap();
        let long = "가".repeat(86);
        assert!(long.len() > REL_PATH_COMPONENT_MAX_BYTES);
        let edge = "가".repeat(85);
        assert_eq!(edge.len(), REL_PATH_COMPONENT_MAX_BYTES);
        write(&dir.path().join(&edge), b"MARK");
        if std::fs::write(dir.path().join(&long), b"MARK").is_err() {
            eprintln!("이 파일 시스템은 255 바이트를 넘는 이름을 만들 수 없어 건너뛴다");
            return;
        }
        let FsListing::Listed { entries, .. } = list_dir_at(dir.path(), "", 100).unwrap() else {
            panic!("나열돼야 한다");
        };
        let openable = |name: &str| entries.iter().find(|e| e.name == name).map(|e| e.openable);
        assert_eq!(openable(&edge), Some(true));
        assert_eq!(openable(&long), Some(false));
        assert!(matches!(
            read_file_at(dir.path(), &edge),
            Ok(FsFile::Text { .. })
        ));
        assert!(is_rejected(&read_file_at(dir.path(), &long)));
    }
}
