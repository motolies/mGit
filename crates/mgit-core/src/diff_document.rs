//! 전체 파일 비교 원문과 쓰기 검증용 revision. 패치의 hunk 번호는 그대로 유지한다.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use mgit_git::cmd::compare_files;
use mgit_model::{DiffChange, DiffOptions, FileDiff, GitRequest, GitRunner, Oid};
use sha2::{Digest, Sha256};

use crate::{Core, CoreError, SessionId};

/// 비교 한쪽의 확정된 원문. 없는 파일은 빈 문자열, 표시할 수 없는 원문은 None이다.
#[derive(Clone, Debug)]
pub struct DiffDocumentSide {
    pub path: Option<String>,
    pub label: String,
    pub content: Option<String>,
    pub line_count: u32,
}

/// 패치와 원문을 함께 전달하며 원문 제한과 패치 잘림을 구분한다.
#[derive(Clone, Debug)]
pub struct DiffDocument {
    pub diff: FileDiff,
    pub old: DiffDocumentSide,
    pub new: DiffDocumentSide,
    pub revision: String,
    pub limit_reason: Option<String>,
}

#[derive(Default)]
struct Source {
    path: Option<String>,
    bytes: Vec<u8>,
    mode: u32,
}

/// 초안 확인 `ls-files` 한 번에 넘길 경로 인자의 바이트 상한. Windows 명령 줄(32K 글자)보다 넉넉히 작게 잡는다
const DRAFT_ARG_BYTES: usize = 16 * 1024;
/// `cat-file --batch` 한 번에 읽을 blob 의 누적 바이트 상한. 넘으면 다음 프로세스로 나눠 한때 쥐는 메모리를 묶어 둔다
/// (blob 하나가 상한보다 크면 그것만 한 묶음이다)
const BLOB_BATCH_BYTES: u64 = 32 * 1024 * 1024;

/// 파일 경로는 pathspec 문법으로 해석하지 않고 조회 실패는 누락 파일과 구분한다.
async fn git(runner: &dyn GitRunner, wt: &Path, args: &[&str]) -> Result<Vec<u8>, CoreError> {
    run_literal(runner, GitRequest::new(wt, args.iter().copied())).await
}

/// `git` 과 같되 입력을 stdin 으로 넘긴다 (oid 목록처럼 인자로 늘어놓으면 길이 상한에 걸리는 것)
async fn git_input(
    runner: &dyn GitRunner,
    wt: &Path,
    args: &[&str],
    input: Vec<u8>,
) -> Result<Vec<u8>, CoreError> {
    run_literal(
        runner,
        GitRequest::new(wt, args.iter().copied()).with_stdin(input),
    )
    .await
}

/// pathspec 을 글자 그대로 해석하게 하고 실패를 오류로 돌려준다 (`git`·`git_input` 공용)
async fn run_literal(runner: &dyn GitRunner, mut req: GitRequest) -> Result<Vec<u8>, CoreError> {
    req.global_args.push("--literal-pathspecs".into());
    let display = req.display_args();
    Ok(runner.run(req).await?.ok(&display)?)
}

/// ref 이름을 먼저 확정해 조회 도중 브랜치가 이동해도 비교 기준을 유지한다.
async fn resolve(runner: &dyn GitRunner, wt: &Path, name: &str) -> Result<String, CoreError> {
    crate::history::check_ref(name)?;
    Ok(String::from_utf8_lossy(
        &git(
            runner,
            wt,
            &["rev-parse", "--verify", "--end-of-options", name],
        )
        .await?,
    )
    .trim()
    .into())
}

/// 일반 파일(blob) 모드인지. 링크(120000)·서브모듈(160000)·트리(040000)는 내용을 읽지 않는다
fn is_regular(mode: u32) -> bool {
    mode & 0o170000 == 0o100000
}

/// `ls-tree`·`ls-files --stage` 항목 하나의 탭 앞에서 모드와 객체 id(`oid_at` 번째 칸)를 읽는다.
/// 경로 하나짜리 조회(`source`)와 일괄 조회(`tree_entries`)가 같은 규칙을 쓴다
fn entry_meta(entry: &[u8], oid_at: usize) -> (u32, String) {
    let meta = String::from_utf8_lossy(entry.split(|b| *b == b'\t').next().unwrap_or_default());
    let fields: Vec<_> = meta.split_whitespace().collect();
    let mode = fields
        .first()
        .and_then(|m| u32::from_str_radix(m, 8).ok())
        .unwrap_or_default();
    (mode, fields.get(oid_at).copied().unwrap_or("").to_owned())
}

/// 트리 또는 인덱스의 경로를 조회하고 blob만 읽는다. 링크·서브모듈은 내용을 따라가지 않는다.
async fn source(
    runner: &dyn GitRunner,
    wt: &Path,
    revision: Option<&str>,
    path: &str,
) -> Result<Source, CoreError> {
    let entries = match revision {
        Some(rev) => git(runner, wt, &["ls-tree", "-z", rev, "--", path]).await?,
        None => git(runner, wt, &["ls-files", "--stage", "-z", "--", path]).await?,
    };
    let Some(entry) = entries.split(|b| *b == 0).find(|e| !e.is_empty()) else {
        return Ok(Source::default());
    };
    let (mode, blob) = entry_meta(entry, if revision.is_some() { 2 } else { 1 });
    let bytes = if is_regular(mode) {
        git(runner, wt, &["cat-file", "blob", &blob]).await?
    } else {
        Vec::new()
    };
    Ok(Source {
        path: Some(path.into()),
        bytes,
        mode,
    })
}

/// git 이 pathspec 인자로 받을 때 글자를 바꾸지 않아 출력과 바이트로 견줄 수 있는 경로인지.
/// - `/` 로 끝나는 경로(`ls-files --others` 가 미추적 하위 저장소를 `dir/` 로 낸다)는 `ls-tree -- dir/` 가 그 안을 나열한다
/// - Windows 의 git 은 `\` 를 `/` 로 바꿔 해석한다
/// - macOS 의 git 은 인자를 NFC 로 합친다(`core.precomposeUnicode`). 합쳐질 수 있는 글자(결합 문자·한글 자모 등)가 없다고
///   확실한 글자만 받는다 — ASCII, 라틴 문자(U+00A0~02FF), 완성형 한글, CJK 한자, 가나
///
/// 아니면 경로 하나짜리 조회로 그대로 묻는다 (결과가 지금과 같게)
fn literal_in_output(path: &str) -> bool {
    if path.ends_with('/') || (cfg!(windows) && path.contains('\\')) {
        return false;
    }
    !cfg!(target_os = "macos")
        || path.chars().all(|c| {
            c.is_ascii()
                || matches!(c,
                    '\u{00A0}'..='\u{02FF}'
                    | '\u{3041}'..='\u{3096}'
                    | '\u{30A1}'..='\u{30FA}'
                    | '\u{4E00}'..='\u{9FFF}'
                    | '\u{AC00}'..='\u{D7A3}')
        })
}

/// 기준 트리에서 찾은 항목 (`ls-tree` 한 줄의 모드와 객체 id)
struct TreeEntry {
    mode: u32,
    oid: String,
}

/// 기준 트리 전체를 한 번 나열해(`ls-tree -r -t`) `wanted` 와 글자 그대로 같은 경로의 항목만 남긴다. 트리·서브모듈·링크도
/// 항목으로 나오므로 경로 하나짜리 `ls-tree <rev> -- <경로>`(`source`)의 첫 항목과 같다. 경로를 인자로 늘어놓지 않아 인자
/// 길이 상한에 걸리지 않는다
async fn tree_entries(
    runner: &dyn GitRunner,
    wt: &Path,
    rev: &str,
    wanted: &HashSet<&str>,
) -> Result<HashMap<String, TreeEntry>, CoreError> {
    let listing = git(runner, wt, &["ls-tree", "-r", "-t", "-z", rev]).await?;
    let mut found = HashMap::new();
    for entry in listing.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let Some(tab) = entry.iter().position(|b| *b == b'\t') else {
            continue;
        };
        let Ok(path) = std::str::from_utf8(&entry[tab + 1..]) else {
            continue;
        };
        if wanted.contains(path) {
            let (mode, oid) = entry_meta(entry, 2);
            found.insert(path.to_owned(), TreeEntry { mode, oid });
        }
    }
    Ok(found)
}

/// `cat-file --batch`·`--batch-check` 의 머리줄(`<oid> <종류> <크기>`)에서 blob 의 oid 와 크기를 읽는다. blob 이 아니거나
/// 없는 객체면 경로 하나짜리 `cat-file blob` 처럼 실패다
fn blob_header(line: &[u8]) -> Result<(String, u64), CoreError> {
    let text = String::from_utf8_lossy(line);
    let mut fields = text.split(' ');
    match (fields.next(), fields.next(), fields.next().map(str::parse)) {
        (Some(oid), Some("blob"), Some(Ok(size))) => Ok((oid.to_owned(), size)),
        _ => Err(CoreError::Invalid(format!("Cannot read blob: {text}"))),
    }
}

/// 객체 id 를 한 줄에 하나씩 stdin 입력으로 만든다
fn oid_lines<'a>(oids: impl IntoIterator<Item = &'a str>) -> Vec<u8> {
    let mut input = Vec::new();
    for oid in oids {
        input.extend_from_slice(oid.as_bytes());
        input.push(b'\n');
    }
    input
}

/// blob 크기를 한 프로세스로 묻는다 (`cat-file --batch-check`, oid 는 stdin)
async fn blob_sizes(
    runner: &dyn GitRunner,
    wt: &Path,
    oids: &BTreeSet<&str>,
) -> Result<HashMap<String, u64>, CoreError> {
    let out = git_input(
        runner,
        wt,
        &["cat-file", "--batch-check"],
        oid_lines(oids.iter().copied()),
    )
    .await?;
    out.split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(blob_header)
        .collect()
}

/// 한 프로세스로 읽은 blob 원문들. 출력 버퍼 하나를 그대로 쥐고 oid 별 구간만 기억한다
struct BlobBatch {
    data: Vec<u8>,
    at: HashMap<String, std::ops::Range<usize>>,
}

impl BlobBatch {
    /// blob 원문을 한 프로세스로 읽는다 (`cat-file --batch`). 호출자가 누적 크기를 `BLOB_BATCH_BYTES` 안으로 묶어 부른다
    async fn read(
        runner: &dyn GitRunner,
        wt: &Path,
        oids: &[&str],
    ) -> Result<BlobBatch, CoreError> {
        let data = git_input(
            runner,
            wt,
            &["cat-file", "--batch"],
            oid_lines(oids.iter().copied()),
        )
        .await?;
        let truncated = || CoreError::Invalid("Truncated cat-file output".into());
        let mut at = HashMap::new();
        let mut pos = 0;
        while pos < data.len() {
            let end = data[pos..]
                .iter()
                .position(|b| *b == b'\n')
                .ok_or_else(truncated)?;
            let (oid, size) = blob_header(&data[pos..pos + end])?;
            let start = pos + end + 1;
            let stop = usize::try_from(size)
                .ok()
                .and_then(|size| start.checked_add(size))
                .filter(|stop| *stop < data.len())
                .ok_or_else(truncated)?;
            at.insert(oid, start..stop);
            pos = stop + 1;
        }
        Ok(BlobBatch { data, at })
    }

    /// oid 의 원문
    fn get(&self, oid: &str) -> Option<&[u8]> {
        self.at.get(oid).map(|range| &self.data[range.clone()])
    }
}

/// 원문 바이트·있음 여부·모드 중 하나라도 다르면 바뀐 파일이고, 그 종류를 돌려준다 (로컬 비교의 판정)
fn local_change(
    old_present: bool,
    old_mode: u32,
    old_bytes: &[u8],
    new: &Source,
) -> Option<DiffChange> {
    (old_bytes != new.bytes.as_slice() || old_present != new.path.is_some() || old_mode != new.mode)
        .then(|| {
            if !old_present {
                DiffChange::Added
            } else if new.path.is_none() {
                DiffChange::Deleted
            } else {
                DiffChange::Modified
            }
        })
}

/// 작업 파일을 읽고 초안이 있으면 그 원문으로 바꾼다. 초안의 모드는 작업 파일 → 기준 → 일반 파일 차례로 정한다
fn local_source(
    wt: &Path,
    path: &str,
    draft: Option<&str>,
    old_present: bool,
    old_mode: u32,
) -> Result<Source, CoreError> {
    let mut new = work_source(wt, path)?;
    if let Some(text) = draft {
        new = Source {
            path: Some(path.into()),
            bytes: text.as_bytes().to_vec(),
            mode: if new.path.is_some() {
                new.mode
            } else if old_present {
                old_mode
            } else {
                0o100644
            },
        };
    }
    Ok(new)
}

/// 기준 쪽이 일반 파일이고 있음 여부·모드가 같아 내용으로 가려야 하는 경로
struct PendingBlob<'a> {
    /// `paths` 안의 순번
    index: usize,
    path: &'a str,
    mode: u32,
}

/// 경로마다 기준(`base`)과 디스크·초안을 견줘 바뀐 것만 경로 순으로 돌려준다. 기준 쪽은 트리 나열 한 번과 blob 일괄 조회로
/// 읽어 git 프로세스 수가 경로 수와 무관하다(blob 원문은 누적 `batch_limit` 바이트 묶음마다 하나). 판정은 경로 하나씩 읽던
/// 때와 같다: 원문 바이트·있음 여부·모드를 견주고, 링크는 대상 문자열, 서브모듈·디렉터리는 내용 없이 모드로 본다. 크기가
/// 다르면 원문을 읽지 않고 바뀐 것으로 본다(바이트가 다르므로 같은 판정이다). 글자 그대로 견줄 수 없는 경로
/// (`literal_in_output`)만 예전처럼 경로 하나씩 묻는다
async fn local_changes(
    runner: &dyn GitRunner,
    wt: &Path,
    base: &str,
    paths: &BTreeSet<String>,
    drafts: &HashMap<&str, &str>,
    batch_limit: u64,
) -> Result<Vec<mgit_model::ChangedFile>, CoreError> {
    let wanted: HashSet<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|p| literal_in_output(p))
        .collect();
    let entries = if wanted.is_empty() {
        HashMap::new()
    } else {
        tree_entries(runner, wt, base, &wanted).await?
    };
    let mut verdicts = Vec::with_capacity(paths.len());
    // blob oid → 그 blob 과 내용을 견줄 경로들, 그리고 작업 쪽 크기
    let mut pending: BTreeMap<&str, Vec<(PendingBlob, usize)>> = BTreeMap::new();
    for (index, path) in paths.iter().enumerate() {
        let draft = drafts.get(path.as_str()).copied();
        if !wanted.contains(path.as_str()) {
            let old = source(runner, wt, Some(base), path).await?;
            let new = local_source(wt, path, draft, old.path.is_some(), old.mode)?;
            verdicts.push(local_change(old.path.is_some(), old.mode, &old.bytes, &new));
            continue;
        }
        let entry = entries.get(path.as_str());
        let (present, mode) = entry.map_or((false, 0), |e| (true, e.mode));
        let new = local_source(wt, path, draft, present, mode)?;
        match entry {
            Some(e) if is_regular(e.mode) && new.path.is_some() && new.mode == e.mode => {
                verdicts.push(None);
                pending
                    .entry(e.oid.as_str())
                    .or_default()
                    .push((PendingBlob { index, path, mode }, new.bytes.len()));
            }
            // 기준 쪽 원문이 없거나(없는 경로·트리·서브모듈·링크) 있음 여부·모드가 달라 내용과 무관하게 정해진다
            _ => verdicts.push(local_change(present, mode, &[], &new)),
        }
    }
    if pending.is_empty() {
        return Ok(changed_files(paths, verdicts));
    }
    let sizes = blob_sizes(runner, wt, &pending.keys().copied().collect()).await?;
    // 크기가 같은 것만 원문을 읽는다. 누적 크기가 상한을 넘기 전까지 한 프로세스로 묶는다
    let mut batches: Vec<Vec<(&str, Vec<PendingBlob>)>> = vec![Vec::new()];
    let mut batch_bytes = 0u64;
    for (oid, waiting) in pending {
        let size = *sizes
            .get(oid)
            .ok_or_else(|| CoreError::Invalid(format!("Cannot read blob: {oid}")))?;
        let mut same_size = Vec::new();
        for (blob, len) in waiting {
            if size != len as u64 {
                verdicts[blob.index] = Some(DiffChange::Modified);
            } else if size > 0 {
                same_size.push(blob);
            }
        }
        if same_size.is_empty() {
            continue;
        }
        if batch_bytes > 0 && batch_bytes + size > batch_limit {
            batches.push(Vec::new());
            batch_bytes = 0;
        }
        batch_bytes += size;
        if let Some(batch) = batches.last_mut() {
            batch.push((oid, same_size));
        }
    }
    for batch in batches.into_iter().filter(|b| !b.is_empty()) {
        let oids: Vec<&str> = batch.iter().map(|(oid, _)| *oid).collect();
        let blobs = BlobBatch::read(runner, wt, &oids).await?;
        for (oid, waiting) in batch {
            let old = blobs
                .get(oid)
                .ok_or_else(|| CoreError::Invalid(format!("Cannot read blob: {oid}")))?;
            for blob in waiting {
                // 작업 원문은 크기를 견줄 때 버렸으므로 다시 읽는다 (경로마다 원문을 한꺼번에 쥐지 않는다)
                let draft = drafts.get(blob.path).copied();
                let new = local_source(wt, blob.path, draft, true, blob.mode)?;
                verdicts[blob.index] = local_change(true, blob.mode, old, &new);
            }
        }
    }
    Ok(changed_files(paths, verdicts))
}

/// 경로 순 판정에서 바뀐 것만 변경 파일로 만든다
fn changed_files(
    paths: &BTreeSet<String>,
    verdicts: Vec<Option<DiffChange>>,
) -> Vec<mgit_model::ChangedFile> {
    paths
        .iter()
        .zip(verdicts)
        .filter_map(|(path, change)| {
            change.map(|change| mgit_model::ChangedFile {
                path: path.clone(),
                old_path: None,
                change,
            })
        })
        .collect()
}

/// 글자 그대로 pathspec `spec` 이 항목 `entry` 와 맞는지: 같거나 그 디렉터리 아래 (`ls-files -- <spec>` 의 일치 규칙)
fn under_pathspec(entry: &[u8], spec: &[u8]) -> bool {
    entry == spec
        || (entry.len() > spec.len() && entry.starts_with(spec) && entry[spec.len()] == b'/')
}

/// 초안 경로가 git 이 아는 경로(추적 중이거나 무시되지 않은 미추적)인지 하나씩 가린다. 초안마다 `ls-files -- <경로>` 를
/// 띄우던 것을 인자 길이 상한까지 한 번에 묶는다. 묶은 출력에 그 경로와 같거나 그 아래인 항목이 있으면 아는 경로다. 그런
/// 항목이 없거나 경로가 출력과 바이트로 견줄 수 없는 꼴이면(`literal_in_output`) 그 경로만 따로 다시 묻는다 — 묶음에서
/// "안다"는 판정만 믿고 "모른다"는 판정은 원래 명령으로 확인해 결과가 지금과 같다
async fn known_drafts(
    runner: &dyn GitRunner,
    wt: &Path,
    drafts: &[(String, String)],
) -> Result<Vec<bool>, CoreError> {
    const LS_FILES: [&str; 6] = [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
    ];
    let batched: Vec<&str> = drafts
        .iter()
        .map(|(path, _)| path.as_str())
        .filter(|path| literal_in_output(path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut listed: Vec<Vec<u8>> = Vec::new();
    let mut start = 0;
    while start < batched.len() {
        let mut end = start;
        let mut bytes = 0;
        while end < batched.len() && (end == start || bytes + batched[end].len() < DRAFT_ARG_BYTES)
        {
            bytes += batched[end].len() + 1;
            end += 1;
        }
        let mut args = LS_FILES.to_vec();
        args.extend_from_slice(&batched[start..end]);
        let out = git(runner, wt, &args).await?;
        listed.extend(
            out.split(|b| *b == 0)
                .filter(|e| !e.is_empty())
                .map(<[u8]>::to_vec),
        );
        start = end;
    }
    let mut known = Vec::with_capacity(drafts.len());
    for (path, _) in drafts {
        let hit = literal_in_output(path)
            && listed
                .iter()
                .any(|entry| under_pathspec(entry, path.as_bytes()));
        known.push(if hit {
            true
        } else {
            let mut args = LS_FILES.to_vec();
            args.push(path);
            !git(runner, wt, &args).await?.is_empty()
        });
    }
    Ok(known)
}

/// 작업 파일을 읽되 중간 링크·특수 파일을 따라가지 않는다.
fn work_source(wt: &Path, path: &str) -> Result<Source, CoreError> {
    if !crate::changes::is_safe_rel_path(path) {
        return Err(CoreError::Invalid("Invalid diff path".into()));
    }
    let mut full = wt.to_path_buf();
    let components: Vec<_> = Path::new(path).components().collect();
    for (index, part) in components.iter().enumerate() {
        full.push(part);
        let meta = match full.symlink_metadata() {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Source::default()),
            Err(e) => return Err(CoreError::Invalid(e.to_string())),
        };
        if meta.file_type().is_symlink() {
            if index + 1 != components.len() {
                return Err(CoreError::Invalid(
                    "Diff path contains a symbolic link".into(),
                ));
            }
            return Ok(Source {
                path: Some(path.into()),
                bytes: std::fs::read_link(&full)
                    .map_err(|e| CoreError::Invalid(e.to_string()))?
                    .as_os_str()
                    .as_encoded_bytes()
                    .to_vec(),
                mode: 0o120000,
            });
        }
        if index + 1 == components.len() {
            if !meta.is_file() {
                return Ok(Source {
                    path: Some(path.into()),
                    bytes: Vec::new(),
                    mode: 0o160000,
                });
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            use std::io::Read;
            let mut file = options
                .open(&full)
                .map_err(|e| CoreError::Invalid(e.to_string()))?;
            if !file
                .metadata()
                .map_err(|e| CoreError::Invalid(e.to_string()))?
                .is_file()
            {
                return Err(CoreError::Invalid("Diff target changed".into()));
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|e| CoreError::Invalid(e.to_string()))?;
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                if file
                    .metadata()
                    .map_err(|e| CoreError::Invalid(e.to_string()))?
                    .permissions()
                    .mode()
                    & 0o111
                    != 0
                {
                    0o100755
                } else {
                    0o100644
                }
            };
            #[cfg(not(unix))]
            let mode = 0o100644;
            return Ok(Source {
                path: Some(path.into()),
                bytes,
                mode,
            });
        }
    }
    Ok(Source::default())
}

/// HEAD·인덱스·작업 원문의 지문은 공백 무시와 무관하게 실제 변경을 감지한다.
pub(crate) async fn work_revision(
    runner: &dyn GitRunner,
    wt: &Path,
    path: &str,
    staged: bool,
    opts: DiffOptions,
) -> Result<String, CoreError> {
    let mut hash = Sha256::new();
    hash.update(path.as_bytes());
    hash.update(format!("{staged}:{opts:?}"));
    let head = runner
        .run(GitRequest::new(wt, ["rev-parse", "--verify", "-q", "HEAD"]))
        .await?;
    hash.update(&head.stdout);
    hash.update(git(runner, wt, &["ls-files", "--stage", "-z"]).await?);
    if !staged {
        let work = work_source(wt, path)?;
        hash.update(work.mode.to_le_bytes());
        hash.update(work.bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// 원문이 지원되지 않는 이유를 정하고 줄 수 제한을 양쪽에 같이 적용한다.
#[allow(clippy::too_many_arguments)]
fn document(
    patch: Option<FileDiff>,
    old: Source,
    new: Source,
    old_label: String,
    new_label: String,
    revision: String,
    max: u32,
    full: bool,
) -> DiffDocument {
    let mut diff = patch.unwrap_or_else(|| FileDiff {
        old_path: old.path.clone(),
        new_path: new.path.clone(),
        change: if old.path.is_none() {
            DiffChange::Added
        } else if new.path.is_none() {
            DiffChange::Deleted
        } else {
            DiffChange::Modified
        },
        old_mode: Some(old.mode),
        new_mode: Some(new.mode),
        old_blob: None,
        new_blob: None,
        binary: None,
        hunks: Vec::new(),
        truncated: false,
        total_lines: 0,
        non_utf8: false,
    });
    let mut reason = None;
    let mut side = |src: Source, label| {
        let lines = if src.bytes.is_empty() {
            0
        } else {
            src.bytes.iter().filter(|b| **b == b'\n').count() as u32
                + u32::from(!src.bytes.ends_with(b"\n"))
        };
        let content = if src.path.is_some() && src.mode & 0o170000 != 0o100000 {
            reason = Some("unsupported-file-type".into());
            None
        } else if src.bytes.contains(&0) {
            reason = Some("binary".into());
            None
        } else {
            match String::from_utf8(src.bytes) {
                Ok(text) => Some(text),
                Err(_) => {
                    diff.non_utf8 = true;
                    reason = Some("non-utf8".into());
                    None
                }
            }
        };
        DiffDocumentSide {
            path: src.path,
            label,
            content,
            line_count: lines,
        }
    };
    let mut old = side(old, old_label);
    let mut new = side(new, new_label);
    if reason.is_none() && !full && (old.line_count > max || new.line_count > max) {
        reason = Some("line-limit".into());
        old.content = None;
        new.content = None;
    }
    if !full && reason.is_some() {
        diff.truncate_to(max);
    }
    DiffDocument {
        diff,
        old,
        new,
        revision,
        limit_reason: reason,
    }
}

impl Core {
    /// 작업 트리 비교는 조회 전후 revision이 일치할 때만 반환한다.
    pub async fn work_tree_diff_document(
        &self,
        session: SessionId,
        path: &str,
        staged: bool,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        for _ in 0..3 {
            let revision = work_revision(runner, wt, path, staged, opts).await?;
            let patch = self
                .work_tree_diff_opts(session, path, staged, true, opts)
                .await?;
            let old_path = patch
                .as_ref()
                .and_then(|d| d.old_path.as_deref())
                .unwrap_or(path);
            let old = if staged {
                let head = runner
                    .run(GitRequest::new(wt, ["rev-parse", "--verify", "-q", "HEAD"]))
                    .await?;
                if head.exit.success() {
                    source(
                        runner,
                        wt,
                        Some(String::from_utf8_lossy(&head.stdout).trim()),
                        old_path,
                    )
                    .await?
                } else {
                    Source::default()
                }
            } else {
                source(runner, wt, None, old_path).await?
            };
            let new = if staged {
                source(runner, wt, None, path).await?
            } else {
                work_source(wt, path)?
            };
            if revision == work_revision(runner, wt, path, staged, opts).await? {
                return Ok(document(
                    patch,
                    old,
                    new,
                    if staged { "HEAD" } else { "Index" }.into(),
                    if staged { "Index" } else { "Working tree" }.into(),
                    revision,
                    self.config().diff_max_lines,
                    full,
                ));
            }
        }
        Err(CoreError::Invalid(
            "File changed while loading the diff; reload and try again".into(),
        ))
    }

    /// 스태시는 OID로 고정하고 미추적 파일의 세 번째 부모를 별도로 읽는다.
    pub async fn stash_file_diff_document(
        &self,
        session: SessionId,
        oid: &Oid,
        path: &str,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let runner = self.inner().runner();
        let meta = mgit_git::cmd::commit_meta(runner, &s.info.work_tree, oid).await?;
        if meta.parents.len() < 2 {
            return Err(CoreError::Invalid(
                mgit_l10n::pick("스태시 커밋이 아닙니다", "Not a stash commit").into(),
            ));
        }
        if let Some(untracked) = meta.parents.get(2) {
            let target = untracked.to_hex();
            if source(runner, &s.info.work_tree, Some(&target), path)
                .await?
                .path
                .is_some()
            {
                let mut result = self
                    .compare_file_diff_document(
                        session,
                        crate::history::EMPTY_TREE,
                        &target,
                        false,
                        path,
                        opts,
                        full,
                    )
                    .await?;
                result.revision = format!("stash:{}:{}", oid.to_hex(), result.revision);
                return Ok(result);
            }
        }
        let files = self.stash_files(session, oid).await?;
        let file = files.iter().find(|file| file.path == path).ok_or_else(|| {
            CoreError::Invalid(
                mgit_l10n::pick(
                    "스태시에 해당 변경 파일이 없습니다",
                    "Changed file is not in this stash",
                )
                .into(),
            )
        })?;
        self.commit_file_diff_document_at(
            &s.info.work_tree,
            oid,
            path,
            file.old_path.as_deref(),
            full,
            opts,
        )
        .await
    }

    /// 커밋 비교는 기존 첫 부모·루트 규칙을 사용한다.
    pub async fn commit_file_diff_document(
        &self,
        session: SessionId,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let s = self.inner().get(session)?;
        self.commit_file_diff_document_at(&s.info.work_tree, oid, path, old_path, full, opts)
            .await
    }

    /// 폴더와 저장소 세션의 커밋 원문 조회를 공유한다.
    pub(crate) async fn commit_file_diff_document_at(
        &self,
        wt: &Path,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let runner = self.inner().runner();
        let oid = oid.to_hex();
        let parents = git(runner, wt, &["rev-list", "--parents", "-n1", &oid]).await?;
        let parents = String::from_utf8_lossy(&parents);
        let parent = parents.split_whitespace().nth(1);
        let parsed_oid =
            Oid::from_hex(oid.as_bytes()).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let patch = self
            .commit_file_diff_at(wt, &parsed_oid, path, old_path, true, opts)
            .await?;
        let old_path = patch
            .as_ref()
            .and_then(|d| d.old_path.as_deref())
            .or(old_path)
            .unwrap_or(path);
        let old = if let Some(parent) = parent {
            source(runner, wt, Some(parent), old_path).await?
        } else {
            Source::default()
        };
        let new = source(runner, wt, Some(&oid), path).await?;
        Ok(document(
            patch,
            old,
            new,
            parent.unwrap_or("Empty tree").into(),
            oid.clone(),
            oid,
            self.config().diff_max_lines,
            full,
        ))
    }

    /// 폴더 소속 저장소만 조회하고 새 저장소 세션은 만들지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub async fn folder_commit_file_diff_document(
        &self,
        session: SessionId,
        repo: &Path,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<DiffDocument, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let primary = folder.group_of(repo)?;
        self.commit_file_diff_document_at(&primary.found.path, oid, path, old_path, full, opts)
            .await
    }

    /// three-dot은 실제 merge base를 고정하고 rename의 양쪽 경로를 함께 조회한다.
    #[allow(clippy::too_many_arguments)]
    pub async fn compare_file_diff_document(
        &self,
        session: SessionId,
        a: &str,
        b: &str,
        three_dot: bool,
        path: &str,
        opts: DiffOptions,
        full: bool,
    ) -> Result<DiffDocument, CoreError> {
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        let mut a = resolve(runner, wt, a).await?;
        let b = resolve(runner, wt, b).await?;
        if three_dot {
            a = String::from_utf8_lossy(&git(runner, wt, &["merge-base", &a, &b]).await?)
                .trim()
                .into();
        }
        let files = compare_files(runner, wt, &a, &b, false).await?;
        let old_path = files
            .iter()
            .find(|f| f.path == path)
            .and_then(|f| f.old_path.as_deref())
            .unwrap_or(path);
        let mut args = vec![
            "diff".into(),
            "--no-color".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "-M".into(),
        ];
        args.extend(mgit_git::cmd::diff_option_args(&opts));
        args.extend([a.clone(), b.clone(), "--".into(), old_path.into()]);
        if old_path != path {
            args.push(path.into());
        }
        let refs: Vec<_> = args.iter().map(String::as_str).collect();
        let patches = mgit_git::parse::parse_diff(&git(runner, wt, &refs).await?);
        let patch = patches.into_iter().find(|d| d.path() == path);
        let old = source(runner, wt, Some(&a), old_path).await?;
        let new = source(runner, wt, Some(&b), path).await?;
        Ok(document(
            patch,
            old,
            new,
            a.clone(),
            b.clone(),
            format!("{a}:{b}"),
            self.config().diff_max_lines,
            full,
        ))
    }
}

/// 화면과 현재 파일이 다르면 다시 읽고 선택하도록 안내한다.
pub(crate) fn stale_diff_error() -> CoreError {
    CoreError::Invalid(
        mgit_l10n::pick(
            "화면에 표시한 이후 파일이 변경되었습니다. 다시 불러온 뒤 선택하세요.",
            "The file changed after it was displayed. Reload and select the changes again",
        )
        .into(),
    )
}

impl Core {
    /// 비교 입력을 이동하지 않는 객체 식별자로 확정한다.
    pub async fn resolve_revision(
        &self,
        session: SessionId,
        rev: &str,
    ) -> Result<String, CoreError> {
        let s = self.inner().get(session)?;
        resolve(self.inner().runner(), &s.info.work_tree, rev).await
    }

    /// 편집기에서 사용할 특정 커밋의 파일 원문을 읽는다. 없는 경로는 None이다.
    pub async fn revision_file_content(
        &self,
        session: SessionId,
        rev: &str,
        path: &str,
    ) -> Result<Option<String>, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let runner = self.inner().runner();
        let rev = resolve(runner, &s.info.work_tree, rev).await?;
        let src = source(runner, &s.info.work_tree, Some(&rev), path).await?;
        Ok(if src.path.is_some() && src.mode & 0o170000 == 0o100000 {
            String::from_utf8(src.bytes).ok()
        } else {
            None
        })
    }

    /// 미저장 원문을 stdin으로 전달하므로 작업 파일과 인덱스를 변경하지 않는다.
    pub async fn blame_contents(
        &self,
        session: SessionId,
        path: &str,
        text: &str,
        ignore_whitespace: bool,
    ) -> Result<Vec<mgit_model::BlameLine>, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let mut args = vec!["blame", "--line-porcelain", "--contents", "-"];
        if ignore_whitespace {
            args.push("-w");
        }
        args.extend(["--", path]);
        let req = GitRequest::new(&s.info.work_tree, args).with_stdin(text.as_bytes().to_vec());
        let display = req.display_args();
        let out = self.inner().runner().run(req).await?.ok(&display)?;
        Ok(mgit_git::cmd::parse_blame_porcelain(
            &String::from_utf8_lossy(&out),
        ))
    }

    /// 기준 커밋을 고정하고 디스크와 초안을 합친 최종 상태의 변경 파일을 찾는다. git 프로세스 수는 경로 수와 무관하다
    /// (`local_changes`·`known_drafts`).
    pub async fn compare_local_files(
        &self,
        session: SessionId,
        base: &str,
        drafts: &[(String, String)],
    ) -> Result<(String, Vec<mgit_model::ChangedFile>), CoreError> {
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        let base = resolve(runner, wt, base).await?;
        let raw = git(
            runner,
            wt,
            &["diff", "--no-renames", "--name-only", "-z", &base, "--"],
        )
        .await?;
        let untracked = git(
            runner,
            wt,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )
        .await?;
        let mut paths = BTreeSet::new();
        for bytes in [&raw, &untracked] {
            for p in bytes.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                if let Ok(p) = std::str::from_utf8(p) {
                    paths.insert(p.to_owned());
                }
            }
        }
        for (path, _) in drafts {
            mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        }
        for ((path, _), known) in drafts.iter().zip(known_drafts(runner, wt, drafts).await?) {
            if known {
                paths.insert(path.clone());
            }
        }
        // 같은 경로의 초안이 여럿이면 앞의 것을 쓴다
        let mut first_drafts = HashMap::new();
        for (path, text) in drafts {
            first_drafts
                .entry(path.as_str())
                .or_insert_with(|| text.as_str());
        }
        let mut files =
            local_changes(runner, wt, &base, &paths, &first_drafts, BLOB_BATCH_BYTES).await?;
        let renames = mgit_git::cmd::parse_name_status(
            &git(
                runner,
                wt,
                &["diff", "--name-status", "-M", "-z", &base, "--"],
            )
            .await?,
        );
        for rename in renames.into_iter().filter(|f| f.old_path.is_some()) {
            let old_path = rename.old_path.as_deref().unwrap_or_default();
            if files
                .iter()
                .any(|f| f.path == old_path && f.change == DiffChange::Deleted)
                && files
                    .iter()
                    .any(|f| f.path == rename.path && f.change == DiffChange::Added)
            {
                files.retain(|f| f.path != old_path && f.path != rename.path);
                files.push(rename);
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok((base, files))
    }

    /// 임시 원문 두 개의 패치만 계산하고 실제 저장소에는 쓰지 않는다.
    pub async fn compare_local_document(
        &self,
        session: SessionId,
        base: &str,
        path: &str,
        draft: Option<&str>,
        opts: DiffOptions,
        full: bool,
    ) -> Result<DiffDocument, CoreError> {
        mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = self.inner().runner();
        let base = resolve(runner, wt, base).await?;
        let renames = mgit_git::cmd::parse_name_status(
            &git(
                runner,
                wt,
                &["diff", "--name-status", "-M", "-z", &base, "--"],
            )
            .await?,
        );
        let rename = renames
            .iter()
            .find(|f| f.path == path && f.old_path.is_some());
        let old_path = rename.and_then(|f| f.old_path.as_deref()).unwrap_or(path);
        let old = source(runner, wt, Some(&base), old_path).await?;
        let new = local_source(wt, path, draft, old.path.is_some(), old.mode)?;
        let temp = tempfile::tempdir().map_err(|e| CoreError::Invalid(e.to_string()))?;
        let a = temp.path().join("before");
        let b = temp.path().join("after");
        std::fs::write(&a, &old.bytes).map_err(|e| CoreError::Invalid(e.to_string()))?;
        std::fs::write(&b, &new.bytes).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let mut args = vec![
            "diff".to_string(),
            "--no-index".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--no-color".into(),
        ];
        args.extend(mgit_git::cmd::diff_option_args(&opts));
        args.extend([
            "--".into(),
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ]);
        let req = GitRequest::new(wt, args);
        let display = req.display_args();
        let out = runner.run(req).await?;
        let output = if out.exit.status == Some(1) {
            out.stdout
        } else {
            out.ok(&display)?
        };
        let patch = mgit_git::parse::parse_diff(&output)
            .into_iter()
            .next()
            .map(|mut d| {
                d.old_path = old.path.clone();
                d.new_path = new.path.clone();
                d.change = if old.path.is_none() {
                    DiffChange::Added
                } else if new.path.is_none() {
                    DiffChange::Deleted
                } else {
                    rename.map(|f| f.change).unwrap_or(DiffChange::Modified)
                };
                d
            });
        let revision = format!("{}:{:x}", base, Sha256::digest(&new.bytes));
        let mut doc = document(
            patch,
            old,
            new,
            base,
            "LOCAL".into(),
            revision,
            self.config().diff_max_lines,
            full,
        );
        if let Some(rename) = rename {
            doc.diff.change = rename.change;
        }
        Ok(doc)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use mgit_model::ChangedFile;
    use mgit_testkit::TestRepo;
    use std::sync::Arc;

    /// 고치기 전(`0250828`) `compare_local_files` 를 그대로 옮긴 기준 구현. 경로마다 `source`(`ls-tree` + `cat-file blob`)를,
    /// 초안마다 `ls-files` 를 띄운다. 일괄 조회가 이것과 같은 결과를 내는지 견준다
    async fn per_path_reference(
        core: &Core,
        session: SessionId,
        base: &str,
        drafts: &[(String, String)],
    ) -> Result<(String, Vec<ChangedFile>), CoreError> {
        let s = core.inner().get(session)?;
        let wt = &s.info.work_tree;
        let runner = core.inner().runner();
        let base = resolve(runner, wt, base).await?;
        let raw = git(
            runner,
            wt,
            &["diff", "--no-renames", "--name-only", "-z", &base, "--"],
        )
        .await?;
        let untracked = git(
            runner,
            wt,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )
        .await?;
        let mut paths = std::collections::BTreeSet::new();
        for bytes in [&raw, &untracked] {
            for p in bytes.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                if let Ok(p) = std::str::from_utf8(p) {
                    paths.insert(p.to_owned());
                }
            }
        }
        for (path, _) in drafts {
            mgit_model::RelPath::parse(path).map_err(|e| CoreError::Invalid(e.to_string()))?;
            let listed = git(
                runner,
                wt,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    path,
                ],
            )
            .await?;
            if !listed.is_empty() {
                paths.insert(path.clone());
            }
        }
        let mut files = Vec::new();
        for path in paths {
            let old = source(runner, wt, Some(&base), &path).await?;
            let mut new = work_source(wt, &path)?;
            if let Some((_, text)) = drafts.iter().find(|(p, _)| *p == path) {
                new = Source {
                    path: Some(path.clone()),
                    bytes: text.as_bytes().to_vec(),
                    mode: if new.path.is_some() {
                        new.mode
                    } else if old.path.is_some() {
                        old.mode
                    } else {
                        0o100644
                    },
                };
            }
            if old.bytes != new.bytes
                || old.path.is_some() != new.path.is_some()
                || old.mode != new.mode
            {
                files.push(ChangedFile {
                    path,
                    old_path: None,
                    change: if old.path.is_none() {
                        DiffChange::Added
                    } else if new.path.is_none() {
                        DiffChange::Deleted
                    } else {
                        DiffChange::Modified
                    },
                });
            }
        }
        let renames = mgit_git::cmd::parse_name_status(
            &git(
                runner,
                wt,
                &["diff", "--name-status", "-M", "-z", &base, "--"],
            )
            .await?,
        );
        for rename in renames.into_iter().filter(|f| f.old_path.is_some()) {
            let old_path = rename.old_path.as_deref().unwrap_or_default();
            if files
                .iter()
                .any(|f| f.path == old_path && f.change == DiffChange::Deleted)
                && files
                    .iter()
                    .any(|f| f.path == rename.path && f.change == DiffChange::Added)
            {
                files.retain(|f| f.path != old_path && f.path != rename.path);
                files.push(rename);
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok((base, files))
    }

    /// 감시 없는 코어로 저장소를 연다
    async fn open(repo: &TestRepo) -> (Core, SessionId) {
        let runner = mgit_git::TokioGitRunner::new(mgit_git::RunnerConfig::default())
            .await
            .unwrap();
        let core = Core::new(Arc::new(runner), crate::CoreConfig::default());
        let opened = core
            .open_repo(repo.path(), Arc::new(|_: crate::CoreEvent| {}))
            .await
            .unwrap();
        (core, opened.session)
    }

    /// 실행 권한을 켠다
    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(path, perm).unwrap();
    }

    /// 판정이 갈리기 쉬운 경로를 모은 저장소. 기준 커밋(HEAD) 뒤 디스크·index 를 고쳐 둔다. 디렉터리가 파일로 바뀐 경우는
    /// 두 구현 모두 실패하므로 따로 본다(`replaced_parent_fails_like_reference`)
    fn tricky_repo() -> TestRepo {
        let mut repo = TestRepo::init();
        for (path, body) in [
            (".gitignore", "*.log\n"),
            ("same.txt", "same\n"),
            ("same-size.txt", "aaaa\n"),
            ("grown.txt", "a\n"),
            ("mode.sh", "echo\n"),
            ("deleted.txt", "gone\n"),
            ("empty.txt", ""),
            ("empty-to-text.txt", ""),
            ("text-to-empty.txt", "x\n"),
            ("crlf.txt", "a\r\nb\r\n"),
            ("a[1].txt", "brackets\n"),
            ("a1.txt", "plain\n"),
            (":(glob)*.txt", "magic\n"),
            ("name with space.txt", "space\n"),
            ("한글.txt", "한글\n"),
            ("file-to-dir", "file\n"),
            ("kept.txt", "kept\n"),
            ("before.txt", "rename me\n"),
            ("Case.txt", "case\n"),
            ("bin.dat", "\0\u{1}\u{2}\u{3}"),
            ("sub/x.txt", "x\n"),
            ("same-content.txt", "touched\n"),
        ] {
            repo.write_file(path, body);
        }
        for i in 0..40 {
            repo.write_file(&format!("bulk/{i:02}.txt"), &format!("bulk {i:02}\n"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink("target-a", repo.path().join("link")).unwrap();
            symlink("content", repo.path().join("link-to-file")).unwrap();
            repo.write_file("file-to-link.txt", "elsewhere");
        }
        let first = repo.commit("base");
        // 서브모듈 자리(gitlink) 두 개: 하나는 가리키는 커밋을 바꾸고 하나는 디렉터리를 지운다
        for name in ["gl-kept", "gl-gone"] {
            repo.git_ok([
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{},{name}", first.to_hex()),
            ]);
            std::fs::create_dir_all(repo.path().join(name)).unwrap();
        }
        let second = repo.commit_staged("gitlinks");

        // 여기부터 기준(HEAD) 뒤의 로컬 변경
        for (path, body) in [
            ("same-size.txt", "bbbb\n"),
            ("grown.txt", "abc\n"),
            ("empty-to-text.txt", "t"),
            ("text-to-empty.txt", ""),
            ("crlf.txt", "a\nb\n"),
            ("a[1].txt", "brackets!\n"),
            (":(glob)*.txt", "magic!\n"),
            ("name with space.txt", "space!\n"),
            ("한글.txt", "한글!\n"),
            ("bin.dat", "\0\u{1}\u{2}\u{4}"),
            ("same-content.txt", "touched\n"),
            ("untracked.txt", "new\n"),
            ("ignored.log", "ignored\n"),
            ("staged-new.txt", "staged\n"),
        ] {
            repo.write_file(path, body);
        }
        for i in 0..40 {
            let body = match i % 3 {
                0 => format!("BULK {i:02}\n"),
                1 => format!("bulk {i:02} grown\n"),
                _ => format!("bulk {i:02}\n"),
            };
            repo.write_file(&format!("bulk/{i:02}.txt"), &body);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            make_executable(&repo.path().join("mode.sh"));
            std::fs::remove_file(repo.path().join("link")).unwrap();
            symlink("target-b", repo.path().join("link")).unwrap();
            std::fs::remove_file(repo.path().join("link-to-file")).unwrap();
            repo.write_file("link-to-file", "content");
            std::fs::remove_file(repo.path().join("file-to-link.txt")).unwrap();
            symlink("elsewhere", repo.path().join("file-to-link.txt")).unwrap();
        }
        repo.remove_file("deleted.txt");
        repo.remove_file("file-to-dir");
        repo.write_file("file-to-dir/new.txt", "under\n");
        repo.git_ok(["rm", "-q", "--cached", "kept.txt"]);
        repo.git_ok(["mv", "before.txt", "after.txt"]);
        repo.git_ok(["mv", "Case.txt", "case.txt"]);
        repo.stage(&["staged-new.txt"]);
        std::fs::remove_dir_all(repo.path().join("gl-gone")).unwrap();
        repo.git_ok([
            "update-index",
            "--cacheinfo",
            &format!("160000,{},gl-kept", second.to_hex()),
        ]);
        // 미추적 하위 저장소: `ls-files --others` 가 `nested/` 로 낸다
        let nested = repo.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let mut inner = TestRepo::at(&nested);
        inner.git_ok(["init", "-q", "-b", "main"]);
        inner.write_file("inner.txt", "inner\n");
        repo
    }

    /// 열린 편집기의 초안들: 추적·미추적·무시·없는 파일, 디렉터리 이름, 하위 저장소 안, 지운 파일, 중복, 한글(완성형·자모)
    fn tricky_drafts() -> Vec<(String, String)> {
        [
            ("same.txt", "draft\n"),
            ("same-size.txt", "aaaa\n"),
            ("grown.txt", "zz\n"),
            ("untracked.txt", "untracked draft\n"),
            ("ignored.log", "x"),
            ("missing.txt", "nothing\n"),
            ("sub", "dir draft"),
            ("a1.txt", "plain\n"),
            ("a[1].txt", "brackets\n"),
            ("한글.txt", "초안 한글\n"),
            (
                "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.txt",
                "자모 초안\n",
            ),
            ("nested/inner.txt", "inner draft\n"),
            ("deleted.txt", "back\n"),
            ("empty.txt", ""),
            ("bulk/02.txt", "bulk 02\n"),
            ("same.txt", "second draft\n"),
        ]
        .into_iter()
        .map(|(p, t)| (p.to_owned(), t.to_owned()))
        .collect()
    }

    /// 일괄 조회(트리 나열 한 번 + blob 일괄 읽기 + 초안 묶음 확인)가 경로마다 묻던 기준 구현과 같은 목록을 낸다
    #[tokio::test]
    async fn batched_local_comparison_matches_per_path_reference() {
        let repo = tricky_repo();
        let (core, session) = open(&repo).await;
        for drafts in [Vec::new(), tricky_drafts()] {
            let batched = core
                .compare_local_files(session, "HEAD", &drafts)
                .await
                .unwrap();
            let reference = per_path_reference(&core, session, "HEAD", &drafts)
                .await
                .unwrap();
            assert_eq!(batched, reference, "초안 {}개", drafts.len());
        }
        // 견준 목록이 비어 있지 않고 갈리기 쉬운 경로가 실제로 들어 있는지 (둘 다 틀린 채 같지 않게)
        let (_, files) = core
            .compare_local_files(session, "HEAD", &tricky_drafts())
            .await
            .unwrap();
        let change = |path: &str| files.iter().find(|f| f.path == path).map(|f| f.change);
        assert_eq!(change("same-size.txt"), None, "초안이 기준으로 되돌림");
        assert_eq!(change("same.txt"), Some(DiffChange::Modified), "첫 초안");
        assert_eq!(change("grown.txt"), Some(DiffChange::Modified));
        assert_eq!(change("bin.dat"), Some(DiffChange::Modified));
        assert_eq!(
            change("deleted.txt"),
            Some(DiffChange::Modified),
            "초안으로 되살림"
        );
        assert_eq!(change("kept.txt"), None, "index 에서만 뺀 같은 파일");
        assert_eq!(change("same-content.txt"), None);
        assert_eq!(change("untracked.txt"), Some(DiffChange::Added));
        assert_eq!(change("ignored.log"), None);
        assert_eq!(change("missing.txt"), None);
        assert_eq!(change("gl-gone"), Some(DiffChange::Deleted));
        assert_eq!(change("gl-kept"), None, "서브모듈은 내용 없이 모드로 본다");
        assert_eq!(change("bulk/00.txt"), Some(DiffChange::Modified));
        assert_eq!(change("bulk/01.txt"), Some(DiffChange::Modified));
        assert_eq!(change("bulk/02.txt"), None);
        assert!(
            files
                .iter()
                .any(|f| f.old_path.as_deref() == Some("before.txt"))
        );
        #[cfg(unix)]
        {
            assert_eq!(change("mode.sh"), Some(DiffChange::Modified), "모드만 바뀜");
            assert_eq!(change("link"), Some(DiffChange::Modified), "링크 대상");
            assert_eq!(change("link-to-file"), Some(DiffChange::Modified));
            assert_eq!(change("file-to-link.txt"), Some(DiffChange::Modified));
        }
    }

    /// blob 원문 묶음을 아주 작게 나눠도(경로마다 프로세스 하나) 판정이 같다
    #[tokio::test]
    async fn blob_batches_split_by_size_keep_results() {
        let mut repo = tricky_repo();
        let (core, session) = open(&repo).await;
        let s = core.inner().get(session).unwrap();
        let wt = &s.info.work_tree;
        let runner = core.inner().runner();
        let base = resolve(runner, wt, "HEAD").await.unwrap();
        let paths: BTreeSet<String> = repo
            .git_ok(["ls-files", "--cached", "--others", "--exclude-standard"])
            .lines()
            .map(str::to_owned)
            .collect();
        let drafts = HashMap::from([("same.txt", "draft\n"), ("bulk/03.txt", "BULK 03\n")]);
        let whole = local_changes(runner, wt, &base, &paths, &drafts, u64::MAX)
            .await
            .unwrap();
        let split = local_changes(runner, wt, &base, &paths, &drafts, 1)
            .await
            .unwrap();
        assert_eq!(whole, split);
        assert!(!whole.is_empty());
    }

    /// 기준의 디렉터리 자리가 디스크에서 파일·심볼릭 링크로 바뀌면 그 아래 경로를 작업 쪽에서 읽지 못해 두 구현 모두 같은
    /// 이유로 실패한다 (지금 동작 그대로 — 판정을 바꾸지 않는다)
    #[tokio::test]
    async fn replaced_parent_fails_like_reference() {
        for link in [false, true] {
            if link && !cfg!(unix) {
                continue;
            }
            let mut repo = TestRepo::init();
            repo.write_file("real/f.txt", "f\n");
            repo.write_file("other/g.txt", "g\n");
            repo.commit("base");
            std::fs::remove_dir_all(repo.path().join("real")).unwrap();
            #[cfg(unix)]
            if link {
                std::os::unix::fs::symlink("other", repo.path().join("real")).unwrap();
            }
            if !link {
                repo.write_file("real", "now a file\n");
            }
            let (core, session) = open(&repo).await;
            let batched = core.compare_local_files(session, "HEAD", &[]).await;
            let reference = per_path_reference(&core, session, "HEAD", &[]).await;
            assert!(batched.is_err(), "링크 {link}");
            assert_eq!(
                batched.map_err(|e| e.to_string()),
                reference.map_err(|e| e.to_string())
            );
        }
    }
}
