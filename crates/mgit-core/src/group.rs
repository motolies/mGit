//! 가상 그룹 (MR-13): 서로 다른 위치에 흩어진 저장소를 묶어 폴더 탭처럼 쓰는 정의. 정의·검증·별칭·저장을 맡는다.
//! 그룹을 연 세션은 폴더 세션의 그룹 원천(`FolderSource::Group`, `folder.rs`)이고, 로스터만 쓰는 폴더 기능(일괄 작업·
//! 타임라인·브랜치 목록 등)은 원천을 모른 채 그대로 쓴다.
//!
//! - 저장: 코어 설정 키 `groups` 에 `{"version":1,"groups":[…]}`. 읽고-고치고-쓰기는 `CoreInner::groups_lock` 안에서 한다
//! - 멤버: 저장소 최상위 하나. 경로는 등록할 때 정규화한 절대 경로이고, 사라져도 정의는 남는다(상태 `Missing`)
//! - 별칭: 그룹 파일 경로의 첫 구성요소(`api/src/main.rs`). 그룹 안에서 대소문자 무시 유일하고 `RelPath` 구성요소 규칙을
//!   따른다. 멤버 위치를 옮겨도(위치 다시 지정) 별칭은 그대로라 화면의 경로 키가 유지된다
//! - 열린 그룹을 고치면 그 세션에 그 자리에서 반영한다(이름·멤버·별칭·위치, M4). 열린 그룹은 지우지 않는다
//! - 그룹을 지우면 그 그룹의 폴더 설정(`folder:mgit-group:<id>`)도 지운다

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use mgit_git::cmd::{classify_repo_dir, scan_repos};
use mgit_l10n::{pick, tr};
use mgit_model::{FoundRepo, REL_PATH_COMPONENT_MAX_BYTES, RelPath, RepoKind, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::folder::SCAN_DEPTH;
use crate::messages;

/// 그룹 정의를 담는 코어 설정 키
pub const GROUPS_SETTING_KEY: &str = "groups";
/// 그룹 세션 키(탭·편집기 탭·최근 파일·폴더 설정 키)의 접두. 뒤에 그룹 id 가 붙는다
pub const GROUP_KEY_PREFIX: &str = "mgit-group:";
/// 그룹 이름 길이 상한 (글자)
pub const GROUP_NAME_MAX_CHARS: usize = 80;
/// 저장 형식 버전
const GROUPS_VERSION: u32 = 1;
/// 그룹 id 의 16진 자리 수 (`g` 뒤)
const GROUP_ID_HEX: usize = 12;
/// 별칭을 정하지 못할 때 쓰는 이름
const FALLBACK_ALIAS: &str = "repo";

/// 그룹 식별자: `g` + 소문자 16진 12자리. 만들 때 시각·프로세스·순번을 해시해 정하고, 밖에서 받은 값은 `parse` 로 검사한다
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GroupId(String);

impl GroupId {
    /// 밖에서 받은 id 를 검사한다. 꼴이 다르면 `Invalid`
    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let well_formed = raw.len() == GROUP_ID_HEX + 1
            && raw.starts_with('g')
            && raw[1..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if well_formed {
            Ok(GroupId(raw.to_owned()))
        } else {
            Err(CoreError::Invalid(tr!(
                "그룹 id 가 올바르지 않습니다: {raw:?}",
                "Invalid group id: {raw:?}"
            )))
        }
    }

    /// 문자열 꼴
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 새 id: 시각(나노초)·프로세스 id·프로세스 안 순번을 해시해 앞 6바이트를 16진으로 적는다
    fn generate() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut hash = Sha256::new();
        hash.update(nanos.to_le_bytes());
        hash.update(std::process::id().to_le_bytes());
        hash.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
        let digest = hash.finalize();
        let hex: String = digest[..GROUP_ID_HEX / 2]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        GroupId(format!("g{hex}"))
    }
}

/// 그룹 세션 키 `mgit-group:<id>`
pub fn group_key(id: &GroupId) -> String {
    format!("{GROUP_KEY_PREFIX}{}", id.as_str())
}

/// 그룹 멤버 하나: 별칭과 저장소 최상위의 정규화한 절대 경로
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMember {
    pub alias: String,
    pub path: PathBuf,
}

/// 저장된 그룹 정의
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDef {
    pub id: GroupId,
    pub name: String,
    pub members: Vec<GroupMember>,
    #[serde(default)]
    pub pinned: bool,
    /// 마지막으로 연 시각 (epoch 밀리초, 연 적 없으면 0)
    #[serde(default)]
    pub last_opened_at: i64,
}

/// 저장 형식
#[derive(Debug, Serialize, Deserialize)]
struct GroupsDoc {
    version: u32,
    groups: Vec<GroupDef>,
}

/// 멤버의 지금 상태 (열 때·재스캔할 때 디스크로 다시 본다)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberState {
    /// 저장소 최상위가 그 자리에 있다
    Present(RepoKind),
    /// 경로가 없다 (지워졌거나 옮겨졌다)
    Missing,
    /// 경로는 있으나 저장소 최상위가 아니다 (디렉터리가 아님·심볼릭 링크로 바뀜 포함)
    NotRepo,
}

/// 세션이 보는 멤버 하나: 정의의 별칭·경로와 지금 상태. 파일 경로 공간(`FsSpace::Group`)과 화면 표시가 쓴다
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMount {
    pub alias: String,
    pub path: PathBuf,
    pub state: MemberState,
}

impl GroupMount {
    /// 정의 쪽 멤버 (상태를 뺀 것). 고치기(`GroupUpdate::members`)의 재료다
    pub fn member(&self) -> GroupMember {
        GroupMember {
            alias: self.alias.clone(),
            path: self.path.clone(),
        }
    }
}

/// 열린 그룹의 모습: 이름과 멤버별 상태 (`FolderOpened.group`, `GroupChanged`)
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: GroupId,
    pub name: String,
    pub members: Vec<GroupMount>,
}

/// 그룹 목록 한 줄: 모습과 고정·마지막 연 시각
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupSummary {
    pub group: GroupView,
    pub pinned: bool,
    pub last_opened_at: i64,
}

/// 그룹 고치기. `None` 인 항목은 그대로 둔다. `members` 는 바뀐 뒤의 전체 목록이다 (추가·빼기·순서·위치 다시 지정)
#[derive(Clone, Debug, Default)]
pub struct GroupUpdate {
    pub name: Option<String>,
    pub members: Option<Vec<GroupMember>>,
    pub pinned: Option<bool>,
}

/// 멤버 후보를 받아들이지 않은 이유
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathIssue {
    /// 경로가 없다
    Missing,
    /// 저장소도, 저장소를 품은 폴더도, 저장소 안의 폴더도 아니다
    NotRepo,
    /// 이미 멤버인 저장소다 (같은 정규 경로 또는 같은 장치·inode)
    Duplicate,
    /// 다른 멤버 안에 있거나 다른 멤버를 품는다
    Nested,
}

/// 경로 확인 결과 한 줄. 고른 경로 하나가 저장소 여럿(폴더에서 추가)으로 펼쳐지면 줄도 여럿이다
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupPathCheck {
    /// 사용자가 고른 경로
    pub input: PathBuf,
    /// 멤버가 될 저장소 최상위 (정규화). 저장소를 찾지 못했으면 `input` 그대로
    pub path: PathBuf,
    pub kind: Option<RepoKind>,
    /// 받아들이면 붙을 별칭. 거부면 `None`
    pub alias: Option<String>,
    /// 거부 이유. 받아들이면 `None`
    pub issue: Option<PathIssue>,
}

/// 별칭이 파일 경로의 구성요소 하나로 쓸 수 있는 이름인지 (`RelPath` 규칙: 비어 있지 않음·255바이트·`.`·`..`·`.git`·구분자·
/// NUL 없음)
pub(crate) fn valid_alias(alias: &str) -> bool {
    RelPath::parse(alias).is_ok_and(|p| p.components().len() == 1)
}

/// 문자열을 `max` 바이트 안으로 글자 경계에서 자른다
fn truncate_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// 경로 이름 하나를 별칭 재료로: 손실 변환하고 구성요소 상한으로 자른다. 구성요소로 쓸 수 없으면 None
fn alias_part(name: Option<&std::ffi::OsStr>) -> Option<String> {
    let lossy = name?.to_string_lossy();
    let cut = truncate_bytes(&lossy, REL_PATH_COMPONENT_MAX_BYTES);
    valid_alias(cut).then(|| cut.to_owned())
}

/// `stem` 뒤에 `suffix` 를 붙이되 구성요소 상한을 넘지 않게 `stem` 을 줄인다
fn with_suffix(stem: &str, suffix: &str) -> String {
    let room = REL_PATH_COMPONENT_MAX_BYTES.saturating_sub(suffix.len());
    let joined = format!("{}{suffix}", truncate_bytes(stem, room));
    truncate_bytes(&joined, REL_PATH_COMPONENT_MAX_BYTES).to_owned()
}

/// 새 멤버의 별칭 (순수): 폴더 이름 → 겹치면 `이름-<상위 폴더 이름>` → 그래도 겹치면 그 뒤에 `-2`, `-3`… 겹침은 대소문자를
/// 무시한다. 폴더 이름을 쓸 수 없으면(`.git` 등) `repo` 에서 시작한다. 결과는 늘 `valid_alias` 다
pub(crate) fn assign_alias(taken: &[String], path: &Path) -> String {
    let taken: Vec<String> = taken.iter().map(|t| t.to_lowercase()).collect();
    let free = |candidate: &str| !taken.contains(&candidate.to_lowercase());
    let base = alias_part(path.file_name()).unwrap_or_else(|| FALLBACK_ALIAS.to_owned());
    if free(&base) {
        return base;
    }
    let mut stem = base.clone();
    if let Some(parent) = alias_part(path.parent().and_then(Path::file_name)) {
        let qualified = with_suffix(&base, &format!("-{parent}"));
        if free(&qualified) && valid_alias(&qualified) {
            return qualified;
        }
        stem = qualified;
    }
    let mut n = 2u64;
    loop {
        let candidate = with_suffix(&stem, &format!("-{n}"));
        if free(&candidate) && valid_alias(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// 이미 있는 멤버에 후보 저장소들을 더하는 계획 (순수): 앞에서부터 하나씩, 같은 경로면 `Duplicate`, 한쪽이 다른 쪽 안이면
/// (구성요소 단위) `Nested` 로 거부하고, 받아들인 후보에는 `assign_alias` 로 별칭을 붙인다. 앞에서 받아들인 후보도 뒤
/// 후보의 비교 대상이다. 둘째 값은 `add` 와 같은 자리의 거부 이유(받아들였으면 None)이고, 첫째 값은 기존 멤버 뒤에 받아들인
/// 후보를 차례로 붙인 목록이다. 장치·inode 로 같은 저장소를 찾는 것은 디스크를 보는 호출자가 앞서 한다
pub(crate) fn plan_members(
    existing: &[GroupMember],
    add: &[PathBuf],
) -> (Vec<GroupMember>, Vec<Option<PathIssue>>) {
    let mut members = existing.to_vec();
    let mut issues = Vec::with_capacity(add.len());
    for path in add {
        let issue = if members.iter().any(|m| m.path == *path) {
            Some(PathIssue::Duplicate)
        } else if members
            .iter()
            .any(|m| m.path.starts_with(path) || path.starts_with(&m.path))
        {
            Some(PathIssue::Nested)
        } else {
            None
        };
        if issue.is_none() {
            let taken: Vec<String> = members.iter().map(|m| m.alias.clone()).collect();
            members.push(GroupMember {
                alias: assign_alias(&taken, path),
                path: path.clone(),
            });
        }
        issues.push(issue);
    }
    (members, issues)
}

/// 멤버 경로의 지금 상태. 링크를 따라가지 않는다 — 등록한 경로는 정규화한 것이라 링크로 바뀌었으면 저장소로 보지 않는다
pub(crate) fn member_state(path: &Path) -> MemberState {
    match std::fs::symlink_metadata(path) {
        Err(_) => MemberState::Missing,
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => MemberState::NotRepo,
        Ok(_) => match classify_repo_dir(path) {
            Some(kind) => MemberState::Present(kind),
            None => MemberState::NotRepo,
        },
    }
}

/// 정의의 멤버들을 지금 상태로 다시 본다 (열기·재스캔·목록). 디스크만 보고 git 은 돌리지 않는다
pub(crate) fn mounts_of(members: &[GroupMember]) -> Vec<GroupMount> {
    members
        .iter()
        .map(|m| GroupMount {
            alias: m.alias.clone(),
            path: m.path.clone(),
            state: member_state(&m.path),
        })
        .collect()
}

/// 로스터에 들 저장소: 있는 멤버만, 멤버 순서대로. 없거나 저장소가 아닌 멤버는 빠진다 (일괄 작업은 `select` 가 거부한다)
pub(crate) fn present_repos(mounts: &[GroupMount]) -> Vec<FoundRepo> {
    mounts
        .iter()
        .filter_map(|m| match m.state {
            MemberState::Present(kind) => Some(FoundRepo {
                path: m.path.clone(),
                kind,
            }),
            MemberState::Missing | MemberState::NotRepo => None,
        })
        .collect()
}

/// 디렉터리의 식별자 (unix: 장치·inode). 읽지 못하면 None
#[cfg(unix)]
fn dir_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

/// unix 가 아니면 안정된 식별자가 없어 정규 경로 비교만 한다 (미검증)
#[cfg(not(unix))]
fn dir_identity(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// 고른 경로를 멤버 후보 저장소로 바꾼다 (권고 기본값): 저장소 최상위면 그 저장소, 아래에 저장소가 있으면(스캔 깊이까지)
/// 그 저장소들, 저장소 안의 폴더면 그 최상위. 셋 다 아니면 `NotRepo`, 없으면(상대 경로 포함) `Missing`. 결과는 정규화했다
fn expand_input(input: &Path) -> Result<Vec<(PathBuf, RepoKind)>, PathIssue> {
    if !input.is_absolute() {
        return Err(PathIssue::Missing);
    }
    let canon = input.canonicalize().map_err(|_| PathIssue::Missing)?;
    if !canon.is_dir() {
        return Err(PathIssue::NotRepo);
    }
    if let Some(kind) = classify_repo_dir(&canon) {
        return Ok(vec![(canon, kind)]);
    }
    let below = scan_repos(&canon, SCAN_DEPTH);
    if !below.is_empty() {
        return Ok(below.into_iter().map(|r| (r.path, r.kind)).collect());
    }
    canon
        .ancestors()
        .skip(1)
        .find_map(|dir| classify_repo_dir(dir).map(|kind| (dir.to_path_buf(), kind)))
        .map(|top| vec![top])
        .ok_or(PathIssue::NotRepo)
}

/// 고른 경로들을 기존 멤버에 견주어 판정한다: 펼친 뒤 같은 장치·inode 를 `Duplicate` 로 먼저 거르고 나머지를
/// `plan_members` 로 계획한다. 줄 순서는 고른 순서(펼친 저장소는 경로순)다
fn check_paths(existing: &[GroupMember], inputs: &[PathBuf]) -> Vec<GroupPathCheck> {
    let mut checks: Vec<GroupPathCheck> = Vec::new();
    for input in inputs {
        match expand_input(input) {
            Ok(found) => checks.extend(found.into_iter().map(|(path, kind)| GroupPathCheck {
                input: input.clone(),
                path,
                kind: Some(kind),
                alias: None,
                issue: None,
            })),
            Err(issue) => checks.push(GroupPathCheck {
                input: input.clone(),
                path: input.clone(),
                kind: None,
                alias: None,
                issue: Some(issue),
            }),
        }
    }
    // 정규 경로가 달라도 같은 디렉터리면(대소문자만 다른 경로 등) 같은 저장소다
    let mut seen: Vec<(u64, u64)> = existing
        .iter()
        .filter_map(|m| dir_identity(&m.path))
        .collect();
    let mut pending: Vec<usize> = Vec::new();
    for (i, check) in checks.iter_mut().enumerate() {
        if check.issue.is_some() {
            continue;
        }
        match dir_identity(&check.path) {
            Some(id) if seen.contains(&id) => check.issue = Some(PathIssue::Duplicate),
            Some(id) => {
                seen.push(id);
                pending.push(i);
            }
            None => pending.push(i),
        }
    }
    let add: Vec<PathBuf> = pending.iter().map(|&i| checks[i].path.clone()).collect();
    let (members, issues) = plan_members(existing, &add);
    let mut accepted = members[existing.len()..].iter();
    for (&i, issue) in pending.iter().zip(issues) {
        match issue {
            Some(issue) => checks[i].issue = Some(issue),
            None => checks[i].alias = accepted.next().map(|m| m.alias.clone()),
        }
    }
    checks
}

/// 거부 이유의 문구 (경로 포함)
fn issue_message(path: &Path, issue: PathIssue) -> String {
    let path = path.display();
    match issue {
        PathIssue::Missing => tr!("경로가 없습니다: {path}", "Path not found: {path}"),
        PathIssue::NotRepo => tr!(
            "저장소나 저장소를 품은 폴더가 아닙니다: {path}",
            "Not a repository or a folder containing repositories: {path}"
        ),
        PathIssue::Duplicate => tr!(
            "이미 그룹에 있는 저장소입니다: {path}",
            "Repository is already in the group: {path}"
        ),
        PathIssue::Nested => tr!(
            "다른 멤버 안에 있거나 다른 멤버를 품은 저장소입니다: {path}",
            "Repository is inside another member or contains one: {path}"
        ),
    }
}

/// 그룹 이름 검사: 앞뒤 공백을 떼고 1~80글자, 제어 문자 없음
fn valid_group_name(name: &str) -> Result<String, CoreError> {
    let name = name.trim();
    let count = name.chars().count();
    if count == 0 || count > GROUP_NAME_MAX_CHARS || name.chars().any(char::is_control) {
        return Err(CoreError::Invalid(tr!(
            "그룹 이름은 1~{GROUP_NAME_MAX_CHARS}자여야 합니다",
            "Group names must be 1–{GROUP_NAME_MAX_CHARS} characters"
        )));
    }
    Ok(name.to_owned())
}

/// 같은 이름(대소문자 무시)의 다른 그룹이 있으면 거부한다
fn ensure_unique_name(
    groups: &[GroupDef],
    name: &str,
    except: Option<&GroupId>,
) -> Result<(), CoreError> {
    let lower = name.to_lowercase();
    if groups
        .iter()
        .any(|g| Some(&g.id) != except && g.name.to_lowercase() == lower)
    {
        return Err(CoreError::Invalid(tr!(
            "같은 이름의 그룹이 있습니다: {name}",
            "A group with this name already exists: {name}"
        )));
    }
    Ok(())
}

/// 고친 멤버 목록 검사: 하나 이상, 별칭은 구성요소 규칙·대소문자 무시 유일, 기존 멤버 경로는(지금 없어도) 그대로 두고 새
/// 경로는 정규화해 저장소 최상위여야 한다. 그 뒤 전체에서 같은 저장소(경로·장치·inode)·중첩을 거부한다
fn validate_members(
    current: &[GroupMember],
    next: Vec<GroupMember>,
) -> Result<Vec<GroupMember>, CoreError> {
    if next.is_empty() {
        return Err(no_members());
    }
    let mut out: Vec<GroupMember> = Vec::with_capacity(next.len());
    for member in next {
        if !valid_alias(&member.alias) {
            return Err(CoreError::Invalid(tr!(
                "별칭으로 쓸 수 없는 이름입니다: {:?}",
                "Invalid alias: {:?}",
                member.alias
            )));
        }
        let lower = member.alias.to_lowercase();
        if out.iter().any(|m| m.alias.to_lowercase() == lower) {
            return Err(CoreError::Invalid(tr!(
                "별칭이 겹칩니다: {}",
                "Duplicate alias: {}",
                member.alias
            )));
        }
        let path = if current.iter().any(|c| c.path == member.path) {
            member.path
        } else {
            new_member_path(&member.path)?
        };
        out.push(GroupMember {
            alias: member.alias,
            path,
        });
    }
    for (i, a) in out.iter().enumerate() {
        for b in &out[i + 1..] {
            let same = a.path == b.path
                || dir_identity(&a.path).is_some_and(|id| dir_identity(&b.path) == Some(id));
            let issue = if same {
                Some(PathIssue::Duplicate)
            } else if a.path.starts_with(&b.path) || b.path.starts_with(&a.path) {
                Some(PathIssue::Nested)
            } else {
                None
            };
            if let Some(issue) = issue {
                return Err(CoreError::Invalid(issue_message(&b.path, issue)));
            }
        }
    }
    Ok(out)
}

/// 새로 들일 멤버 경로: 절대 경로를 정규화해 저장소 최상위인지 본다
fn new_member_path(path: &Path) -> Result<PathBuf, CoreError> {
    let issue = |issue| CoreError::Invalid(issue_message(path, issue));
    if !path.is_absolute() {
        return Err(issue(PathIssue::Missing));
    }
    let canon = path.canonicalize().map_err(|_| issue(PathIssue::Missing))?;
    if !canon.is_dir() || classify_repo_dir(&canon).is_none() {
        return Err(issue(PathIssue::NotRepo));
    }
    Ok(canon)
}

/// 멤버 없음 오류
fn no_members() -> CoreError {
    CoreError::Invalid(
        pick(
            "그룹에는 저장소가 하나 이상 있어야 합니다",
            "A group needs at least one repository",
        )
        .into(),
    )
}

/// 모르는 그룹 오류
pub(crate) fn not_found(id: &GroupId) -> CoreError {
    CoreError::Invalid(tr!(
        "그룹을 찾을 수 없습니다: {}",
        "Group not found: {}",
        id.as_str()
    ))
}

/// 정의 목록에서 그룹 하나를 고친다 (그룹 잠금 안, `edit_groups`): 멤버는 `validate_members`(디스크 확인), 이름은 겹침
/// 검사를 거친다. 고친 정의와, 이름·멤버(별칭·위치 포함)가 바뀌었는지(열린 세션에 반영할지)를 돌려준다
fn edited(
    groups: &mut [GroupDef],
    id: &GroupId,
    name: Option<String>,
    update: GroupUpdate,
) -> Result<(GroupDef, bool), CoreError> {
    let at = groups
        .iter()
        .position(|g| g.id == *id)
        .ok_or_else(|| not_found(id))?;
    let current = groups[at].clone();
    let members = update
        .members
        .map(|m| validate_members(&current.members, m))
        .transpose()?;
    let reshaped = name.as_ref().is_some_and(|n| *n != current.name)
        || members.as_ref().is_some_and(|m| *m != current.members);
    if let Some(name) = &name {
        ensure_unique_name(groups, name, Some(id))?;
    }
    let def = &mut groups[at];
    if let Some(name) = name {
        def.name = name;
    }
    if let Some(members) = members {
        def.members = members;
    }
    if let Some(pinned) = update.pinned {
        def.pinned = pinned;
    }
    Ok((def.clone(), reshaped))
}

/// 열린 그룹을 지우려 할 때의 오류
fn group_is_open() -> CoreError {
    CoreError::Invalid(
        pick(
            "열려 있는 그룹은 지울 수 없습니다. 그룹 탭을 닫은 뒤 다시 시도하세요",
            "An open group cannot be deleted. Close the group tab and try again",
        )
        .into(),
    )
}

/// 저장된 정의 하나를 쓸 수 있는 꼴로 거른다: id 가 틀리면 버리고, 별칭이 규칙에 맞지 않거나 겹치는 멤버·상대 경로 멤버를
/// 뺀다 (손으로 고친 설정이 파일 경로 공간을 흐리지 않게)
fn sanitize(mut def: GroupDef) -> Option<GroupDef> {
    if GroupId::parse(def.id.as_str()).is_err() {
        tracing::warn!(id = def.id.as_str(), "그룹 id 가 올바르지 않아 건너뜀");
        return None;
    }
    let mut kept: Vec<GroupMember> = Vec::with_capacity(def.members.len());
    for member in def.members {
        let lower = member.alias.to_lowercase();
        let usable = valid_alias(&member.alias)
            && member.path.is_absolute()
            && !kept.iter().any(|k| k.alias.to_lowercase() == lower);
        if usable {
            kept.push(member);
        } else {
            tracing::warn!(alias = %member.alias, "그룹 멤버가 올바르지 않아 건너뜀");
        }
    }
    def.members = kept;
    Some(def)
}

/// 저장된 그룹 정의들. 없으면 빈 목록, 읽을 수 없거나 모르는 버전이면 오류 (덮어써 잃지 않게)
pub(crate) fn load_groups(store: &dyn Store) -> Result<Vec<GroupDef>, CoreError> {
    let Some(json) = store.setting_get(GROUPS_SETTING_KEY)? else {
        return Ok(Vec::new());
    };
    let doc: GroupsDoc = serde_json::from_str(&json).map_err(|e| {
        CoreError::Invalid(tr!(
            "저장된 그룹 정의를 읽지 못했습니다: {e}",
            "Failed to read saved groups: {e}"
        ))
    })?;
    if doc.version != GROUPS_VERSION {
        return Err(CoreError::Invalid(tr!(
            "모르는 그룹 정의 형식입니다 (버전 {})",
            "Unknown group definition format (version {})",
            doc.version
        )));
    }
    Ok(doc.groups.into_iter().filter_map(sanitize).collect())
}

/// 그룹 정의들을 저장한다
pub(crate) fn save_groups(store: &dyn Store, groups: &[GroupDef]) -> Result<(), CoreError> {
    let doc = GroupsDoc {
        version: GROUPS_VERSION,
        groups: groups.to_vec(),
    };
    let json = serde_json::to_string(&doc)
        .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
    store.setting_set(GROUPS_SETTING_KEY, &json)?;
    Ok(())
}

/// 지금 시각 (epoch 밀리초)
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// 정의 → 목록 한 줄 (멤버 상태를 디스크로 다시 본다)
fn summary_of(def: &GroupDef) -> GroupSummary {
    GroupSummary {
        group: GroupView {
            id: def.id.clone(),
            name: def.name.clone(),
            members: mounts_of(&def.members),
        },
        pinned: def.pinned,
        last_opened_at: def.last_opened_at,
    }
}

impl CoreInner {
    /// 그룹 정의를 읽고-고치고-쓰는 구간. `edit` 가 `Ok` 면 저장한다. 잠금 순서는 그룹 잠금 → 폴더 목록이다
    fn edit_groups<T>(
        &self,
        edit: impl FnOnce(&mut Vec<GroupDef>) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let _guard = self
            .groups_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut groups = load_groups(self.store.as_ref())?;
        let out = edit(&mut groups)?;
        save_groups(self.store.as_ref(), &groups)?;
        Ok(out)
    }

    /// 그룹 정의 하나 (잠금 안에서 읽는다)
    pub(crate) fn group_def(&self, id: &GroupId) -> Result<GroupDef, CoreError> {
        let _guard = self
            .groups_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        load_groups(self.store.as_ref())?
            .into_iter()
            .find(|g| g.id == *id)
            .ok_or_else(|| not_found(id))
    }
}

impl Core {
    /// 그룹 목록: 고정 먼저, 그다음 최근에 연 순(같으면 이름순). 멤버 상태는 디스크로 다시 본다
    pub fn groups_list(&self) -> Result<Vec<GroupSummary>, CoreError> {
        let groups = {
            let inner = self.inner();
            let _guard = inner
                .groups_lock
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            load_groups(inner.store.as_ref())?
        };
        let mut out: Vec<GroupSummary> = groups.iter().map(summary_of).collect();
        out.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.last_opened_at.cmp(&a.last_opened_at))
                .then_with(|| {
                    a.group
                        .name
                        .to_lowercase()
                        .cmp(&b.group.name.to_lowercase())
                })
        });
        Ok(out)
    }

    /// 고른 경로들을 멤버 후보로 판정한다 (저장하지 않음). `group` 을 주면 그 그룹의 지금 멤버에 견주고(추가), 없으면 빈
    /// 그룹에 견준다(새 그룹). 받아들일 줄에는 별칭이, 거부할 줄에는 이유가 붙는다
    pub fn group_check_paths(
        &self,
        group: Option<&GroupId>,
        paths: &[PathBuf],
    ) -> Result<Vec<GroupPathCheck>, CoreError> {
        let existing = match group {
            Some(id) => self.inner().group_def(id)?.members,
            None => Vec::new(),
        };
        Ok(check_paths(&existing, paths))
    }

    /// 새 그룹을 만든다. 고른 경로는 `group_check_paths` 와 같이 펼치고, 거부할 경로가 하나라도 있거나 저장소가 없으면
    /// 만들지 않는다. 이름은 1~80자, 다른 그룹과 대소문자 무시로 달라야 한다
    pub fn group_create(&self, name: &str, paths: &[PathBuf]) -> Result<GroupSummary, CoreError> {
        let name = valid_group_name(name)?;
        let checks = check_paths(&[], paths);
        if let Some(bad) = checks.iter().find(|c| c.issue.is_some()) {
            let issue = bad.issue.unwrap_or(PathIssue::NotRepo);
            return Err(CoreError::Invalid(issue_message(&bad.path, issue)));
        }
        let members: Vec<GroupMember> = checks
            .into_iter()
            .filter_map(|c| {
                c.alias.map(|alias| GroupMember {
                    alias,
                    path: c.path,
                })
            })
            .collect();
        if members.is_empty() {
            return Err(no_members());
        }
        let def = self.inner().edit_groups(|groups| {
            ensure_unique_name(groups, &name, None)?;
            let id = loop {
                let id = GroupId::generate();
                if !groups.iter().any(|g| g.id == id) {
                    break id;
                }
            };
            let def = GroupDef {
                id,
                name,
                members,
                pinned: false,
                last_opened_at: 0,
            };
            groups.push(def.clone());
            Ok(def)
        })?;
        Ok(summary_of(&def))
    }

    /// 그룹을 고친다. 멤버는 `validate_members` 로 검사한다(디스크를 보므로 블로킹 스레드에서 검사·저장한다). 열린 그룹이고
    /// 이름·멤버(별칭·위치 포함)가 바뀌었으면 저장한 뒤 그 세션에 그 자리에서 반영한다 (M4 — 탭을 닫지 않는다): 멤버
    /// 상태·로스터·감시를 다시 걸고 `FolderRescanned` → `GroupChanged` 를 보낸다. 고정만 바뀌면 세션은 그대로다
    pub async fn group_update(
        &self,
        id: &GroupId,
        update: GroupUpdate,
    ) -> Result<GroupSummary, CoreError> {
        let name = update.name.as_deref().map(valid_group_name).transpose()?;
        let inner = self.inner_arc();
        let editor = Arc::clone(&inner);
        let target = id.clone();
        let (def, reshaped) = crate::fs_tree::run_blocking(move || {
            editor.edit_groups(|groups| edited(groups, &target, name, update))
        })
        .await?;
        // 그룹 잠금을 놓은 뒤 반영한다 (반영은 await 하고, 그 안에서 정의를 다시 읽는다). 그사이 닫혔으면 할 일이 없다
        if reshaped && let Some(folder) = inner.folders_find_group(id) {
            match self.reload_group_session(folder.id).await {
                Ok(_) | Err(CoreError::SessionNotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(summary_of(&def))
    }

    /// 그룹을 지운다. 열린 그룹은 지우지 않는다 (탭을 먼저 닫는다). 지우면 그 그룹의 폴더 설정(`folder:mgit-group:<id>`)도
    /// 지운다 — 설정 지우기에 실패해도 그룹은 지운 것이다 (남은 설정은 쓰이지 않는다)
    pub fn group_delete(&self, id: &GroupId) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        inner.edit_groups(|groups| {
            let at = groups
                .iter()
                .position(|g| g.id == *id)
                .ok_or_else(|| not_found(id))?;
            if inner.folders_find_group(id).is_some() {
                return Err(group_is_open());
            }
            groups.remove(at);
            Ok(())
        })?;
        let key = crate::folder_batch::settings_key(&group_key(id));
        if let Err(e) = inner.store.setting_delete(&key) {
            tracing::warn!(error = %e, "지운 그룹의 폴더 설정을 지우지 못함");
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 멤버 하나
    fn member(alias: &str, path: &str) -> GroupMember {
        GroupMember {
            alias: alias.into(),
            path: PathBuf::from(path),
        }
    }

    /// 문자열 목록
    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// 그룹 id 는 `g` + 소문자 16진 12자리만 받고, 만든 id 는 늘 그 꼴이며 서로 다르다
    #[test]
    fn group_ids_are_g_plus_twelve_lowercase_hex() {
        for ok in ["g0123456789ab", "gffffffffffff", "g000000000000"] {
            assert_eq!(GroupId::parse(ok).unwrap().as_str(), ok);
        }
        for bad in [
            "",
            "g",
            "g0123456789a",
            "g0123456789abc",
            "G0123456789ab",
            "h0123456789ab",
            "g0123456789AB",
            "g0123456789ag",
            "../g0123456789",
            "g01234567/9ab",
        ] {
            assert!(GroupId::parse(bad).is_err(), "{bad:?}");
        }
        let a = GroupId::generate();
        let b = GroupId::generate();
        assert_ne!(a, b);
        assert!(GroupId::parse(a.as_str()).is_ok());
        assert_eq!(group_key(&a), format!("mgit-group:{}", a.as_str()));
    }

    /// 별칭 규칙: 폴더 이름 → 겹치면 `-상위폴더` → 그래도 겹치면 `-2`, `-3`… 겹침은 대소문자 무시다
    #[test]
    fn assign_alias_prefers_folder_then_parent_then_counter() {
        assert_eq!(assign_alias(&[], Path::new("/a/x/api")), "api");
        assert_eq!(
            assign_alias(&names(&["api"]), Path::new("/b/y/api")),
            "api-y"
        );
        assert_eq!(
            assign_alias(&names(&["API"]), Path::new("/b/y/api")),
            "api-y"
        );
        assert_eq!(
            assign_alias(&names(&["api", "api-y"]), Path::new("/c/y/api")),
            "api-y-2"
        );
        assert_eq!(
            assign_alias(&names(&["api", "Api-Y", "api-y-2"]), Path::new("/d/y/api")),
            "api-y-3"
        );
        // 상위 폴더가 없으면(루트 바로 아래) 숫자로 간다
        assert_eq!(assign_alias(&names(&["api"]), Path::new("/api")), "api-2");
        // 한글·공백 이름도 그대로 쓴다
        assert_eq!(assign_alias(&[], Path::new("/w/작업 폴더")), "작업 폴더");
    }

    /// 폴더 이름을 구성요소로 쓸 수 없으면(`.git`·`..`·루트) `repo` 에서 시작하고, 긴 이름은 255바이트 안으로 자른다.
    /// 결과는 늘 `valid_alias` 다
    #[test]
    fn assign_alias_always_returns_a_valid_component() {
        assert_eq!(assign_alias(&[], Path::new("/w/.git")), "repo");
        assert_eq!(assign_alias(&[], Path::new("/")), "repo");
        assert_eq!(assign_alias(&names(&["repo"]), Path::new("/")), "repo-2");
        let long = "가".repeat(100);
        let alias = assign_alias(&[], &Path::new("/w").join(&long));
        assert!(
            alias.len() <= REL_PATH_COMPONENT_MAX_BYTES,
            "{}",
            alias.len()
        );
        assert!(valid_alias(&alias));
        let taken = vec![alias.clone()];
        let parent = "나".repeat(100);
        let next = assign_alias(&taken, &Path::new("/").join(&parent).join(&long));
        assert!(valid_alias(&next) && next != alias, "{next}");
        let taken = vec![alias, next.clone()];
        let third = assign_alias(&taken, &Path::new("/").join(&parent).join(&long));
        assert!(valid_alias(&third) && third != next, "{third}");
        assert!(third.ends_with("-2"), "{third}");
    }

    /// 별칭으로 쓸 수 있는 이름: `RelPath` 구성요소 하나
    #[test]
    fn valid_alias_follows_rel_path_component_rules() {
        for ok in [
            "api",
            "작업 폴더",
            "a.b",
            ".hidden",
            "x".repeat(255).as_str(),
        ] {
            assert!(valid_alias(ok), "{ok:?}");
        }
        for bad in [
            "",
            ".",
            "..",
            ".git",
            ".GIT",
            "a/b",
            "/a",
            "a\0b",
            "x".repeat(256).as_str(),
        ] {
            assert!(!valid_alias(bad), "{bad:?}");
        }
    }

    /// 계획: 같은 경로는 `Duplicate`, 한쪽이 다른 쪽 안이면(구성요소 단위) `Nested`, 이름만 앞이 같은 형제는 괜찮다.
    /// 앞에서 받아들인 후보도 비교 대상이고, 별칭은 기존·앞 후보와 겹치지 않는다
    #[test]
    fn plan_members_rejects_duplicates_and_nesting_and_assigns_aliases() {
        let existing = vec![member("api", "/a/x/api"), member("web", "/b/web")];
        let add: Vec<PathBuf> = [
            "/a/x/api",
            "/a/x/api/vendor/lib",
            "/b",
            "/c/y/api",
            "/b/webapp",
            "/c/y/api",
            "/d/api",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        let (members, issues) = plan_members(&existing, &add);
        assert_eq!(
            issues,
            vec![
                Some(PathIssue::Duplicate),
                Some(PathIssue::Nested),
                Some(PathIssue::Nested),
                None,
                None,
                Some(PathIssue::Duplicate),
                None,
            ]
        );
        assert_eq!(
            members,
            vec![
                member("api", "/a/x/api"),
                member("web", "/b/web"),
                member("api-y", "/c/y/api"),
                member("webapp", "/b/webapp"),
                member("api-d", "/d/api"),
            ]
        );
    }

    /// 이름 검사: 앞뒤 공백을 떼고 1~80글자(바이트가 아니라 글자), 제어 문자 거부
    #[test]
    fn group_names_are_trimmed_and_bounded_by_characters() {
        assert_eq!(valid_group_name("  backend  ").unwrap(), "backend");
        assert_eq!(
            valid_group_name(&"가".repeat(80)).unwrap().chars().count(),
            80
        );
        for bad in ["", "   ", "a\nb", "tab\there"] {
            assert!(valid_group_name(bad).is_err(), "{bad:?}");
        }
        assert!(valid_group_name(&"가".repeat(81)).is_err());
        let groups = vec![GroupDef {
            id: GroupId::parse("g000000000001").unwrap(),
            name: "Backend".into(),
            members: Vec::new(),
            pinned: false,
            last_opened_at: 0,
        }];
        assert!(ensure_unique_name(&groups, "backend", None).is_err());
        assert!(ensure_unique_name(&groups, "backend", Some(&groups[0].id)).is_ok());
        assert!(ensure_unique_name(&groups, "front", None).is_ok());
    }

    /// 저장 형식: 버전 1 의 문서를 왕복하고, 손으로 고친 잘못된 id·별칭·상대 경로·겹치는 별칭은 걸러 읽는다. 모르는
    /// 버전·깨진 JSON 은 오류다 (덮어쓰지 않게)
    #[test]
    fn stored_groups_round_trip_and_bad_entries_are_dropped() {
        let store = mgit_model::MemoryStore::new();
        assert!(load_groups(&store).unwrap().is_empty());
        let def = GroupDef {
            id: GroupId::parse("g0123456789ab").unwrap(),
            name: "작업".into(),
            members: vec![member("api", "/a/api"), member("web", "/b/web")],
            pinned: true,
            last_opened_at: 42,
        };
        save_groups(&store, std::slice::from_ref(&def)).unwrap();
        let raw = store.setting_get(GROUPS_SETTING_KEY).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["groups"][0]["lastOpenedAt"], 42);
        assert_eq!(value["groups"][0]["members"][0]["alias"], "api");
        assert_eq!(load_groups(&store).unwrap(), vec![def]);

        store
            .setting_set(
                GROUPS_SETTING_KEY,
                r#"{"version":1,"groups":[
                    {"id":"bad","name":"x","members":[]},
                    {"id":"g000000000002","name":"y","members":[
                        {"alias":"ok","path":"/a/ok"},
                        {"alias":"..","path":"/a/up"},
                        {"alias":"rel","path":"a/rel"},
                        {"alias":"OK","path":"/a/ok2"}
                    ]}
                ]}"#,
            )
            .unwrap();
        let loaded = load_groups(&store).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].members, vec![member("ok", "/a/ok")]);
        assert!(!loaded[0].pinned);
        assert_eq!(loaded[0].last_opened_at, 0);

        store
            .setting_set(GROUPS_SETTING_KEY, r#"{"version":2,"groups":[]}"#)
            .unwrap();
        assert!(load_groups(&store).is_err());
        store.setting_set(GROUPS_SETTING_KEY, "{oops").unwrap();
        assert!(load_groups(&store).is_err());
    }
}
