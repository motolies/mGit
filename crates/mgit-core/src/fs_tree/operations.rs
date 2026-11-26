//! Project 파일 작업: 준비 결과를 재검증하고 항목별로 게시한다. 전체 묶음의 원자성은 약속하지 않는다.

use super::{FS_MUTATION_LOCK, Resolved, is_dot_git, parse, resolve, run_blocking};
use crate::refresh::RefreshScope;
use crate::{Core, CoreError, CoreEvent, SessionId};
use mgit_git::cmd::discover;
use mgit_model::GitError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FsOperationKind {
    CreateFile,
    CreateDirectory,
    Rename,
    Copy,
    Move,
    Trash,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsLocation {
    pub session: u32,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FsSource {
    Session { session: u32, path: String },
    External { token: String, index: u32 },
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationRequest {
    pub kind: FsOperationKind,
    pub sources: Vec<FsSource>,
    pub destination: Option<FsLocation>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FsConflictKind {
    None,
    File,
    Directory,
    Type,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationItem {
    pub id: String,
    pub source: Option<String>,
    pub destination: Option<String>,
    pub directory: bool,
    pub conflict: FsConflictKind,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_mtime_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_mtime_ms: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationProgress {
    pub completed: u32,
    pub total: u32,
    pub current_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationPlan {
    pub id: String,
    pub kind: FsOperationKind,
    pub items: Vec<FsOperationItem>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FsDecisionAction {
    Overwrite,
    Merge,
    Rename,
    Skip,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationDecision {
    pub item_id: String,
    pub action: FsDecisionAction,
    pub name: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FsOutcomeStatus {
    Committed,
    Skipped,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationOutcome {
    pub source: Option<String>,
    pub destination: Option<String>,
    pub status: FsOutcomeStatus,
    pub error: Option<String>,
    pub directory: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsOperationResult {
    pub id: String,
    pub items: Vec<FsOperationOutcome>,
}

/// OS 휴지통은 셸이 주입한다. 실패 시 영구 삭제로 바꾸지 않는다.
pub trait FsTrash: Send + Sync {
    fn trash(&self, path: &Path) -> Result<(), String>;
}
#[derive(Clone)]
struct Node {
    item: FsOperationItem,
    source: Option<PathBuf>,
    destination: Option<PathBuf>,
    source_root: Option<PathBuf>,
    destination_root: Option<PathBuf>,
    source_stamp: Option<String>,
    destination_stamp: Option<String>,
    children: Vec<Node>,
}
#[derive(Clone)]
struct Prepared {
    plan: FsOperationPlan,
    nodes: Vec<Node>,
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    progress: Arc<Mutex<FsOperationProgress>>,
}
struct Grant {
    paths: Vec<PathBuf>,
    movable: bool,
}

/// 준비 계획·외부 입력 권한은 앱 수명 동안만 보관하고 실행 결과는 journal로 복구한다.
pub struct FsOperations {
    plans: Mutex<HashMap<String, Prepared>>,
    progresses: Mutex<HashMap<String, Arc<Mutex<FsOperationProgress>>>>,
    grants: Mutex<HashMap<String, Grant>>,
    journal_dir: PathBuf,
    trash: Arc<dyn FsTrash>,
}
struct PlanLease<'a> {
    plans: &'a Mutex<HashMap<String, Prepared>>,
    id: String,
    cancel: Arc<AtomicBool>,
}
impl Drop for PlanLease<'_> {
    /// 오류·취소·응답 중단 시에도 대기 슬롯을 돌려주고 남은 복사를 중단한다.
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        self.plans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 프로세스 재시작에도 임시 이름이 충돌하지 않게 시각·프로세스·순번을 합친다.
fn next_id() -> String {
    format!(
        "{}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
/// 안전 검사 실패를 공통 코어 오류로 만든다.
fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::Invalid(message.into())
}
/// 절대 경로를 UI의 영향 문서 식별용 문자열로 옮긴다.
fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
/// 심볼릭 링크·Git 관리 경로·특수 파일을 포함한 트리는 통째로 거부한다.
fn inspect(path: &Path, budget: &mut usize) -> Result<String, CoreError> {
    if *budget == 0 {
        return Err(invalid("파일 작업은 한 번에 50,000개 항목까지 지원합니다"));
    }
    *budget -= 1;
    if path.file_name().is_some_and(is_dot_git) {
        return Err(invalid(".git 및 저장소를 포함한 폴더는 변경할 수 없습니다"));
    }
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
        return Err(invalid("심볼릭 링크와 특수 파일은 지원하지 않습니다"));
    }
    let mut hash = Sha256::new();
    hash.update(format!(
        "{:?}:{:?}:{}",
        meta.modified(),
        meta.created(),
        meta.len()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(format!(
            "{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec()
        ));
    }
    if meta.is_dir() {
        let mut children: Vec<_> = fs::read_dir(path)?.collect::<Result<_, _>>()?;
        children.sort_by_key(|e| e.file_name());
        for entry in children {
            hash.update(entry.file_name().as_encoded_bytes());
            hash.update(inspect(&entry.path(), budget)?);
        }
    } else {
        let mut file = open_read(path)?;
        let mut bytes = [0; 64 * 1024];
        loop {
            let n = file.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            hash.update(&bytes[..n]);
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// 존재하지 않는 대상은 None이며 그 밖의 오류는 숨기지 않는다.
fn stamp(path: &Path) -> Result<Option<String>, CoreError> {
    match fs::symlink_metadata(path) {
        Ok(_) => inspect(path, &mut 50_000).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
/// 정규 파일을 링크를 따라가지 않고 읽는다.
fn open_read(path: &Path) -> Result<File, CoreError> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    Ok(opts.open(path)?)
}
/// 세션 루트와 상대 경로를 검사하고 아직 없는 마지막 이름도 안전하게 결합한다.
fn checked(root: &Path, relative: &str, allow_root: bool) -> Result<PathBuf, CoreError> {
    if relative.is_empty() {
        return if allow_root {
            Ok(root.canonicalize()?)
        } else {
            Err(invalid("프로젝트 루트는 변경할 수 없습니다"))
        };
    }
    let parsed = parse(relative)?;
    let mut parts = parsed.components().to_vec();
    let name = parts.pop().ok_or_else(|| invalid("파일 이름이 없습니다"))?;
    let parent = match resolve(root, &parts, relative)? {
        Resolved::Found(target)
            if target.meta.is_dir() && !target.meta.file_type().is_symlink() =>
        {
            target.path
        }
        _ => return Err(invalid("대상 폴더가 없거나 접근할 수 없습니다")),
    };
    let path = parent.join(name);
    if fs::symlink_metadata(&path).is_ok() {
        let Resolved::Found(target) = resolve(root, parsed.components(), relative)? else {
            return Err(invalid("경로가 변경되었습니다"));
        };
        if target.meta.file_type().is_symlink() {
            return Err(invalid("심볼릭 링크는 변경할 수 없습니다"));
        }
        // 요청 철자를 유지해야 대소문자만 바꾸는 rename이 실제로 적용된다.
        return Ok(path);
    }
    Ok(path)
}
/// 작업 직전에도 경로 경계를 다시 검사한다. 부모가 아직 없는 경우 가장 가까운 부모까지 확인한다.
fn recheck(root: &Path, path: &Path) -> Result<(), CoreError> {
    let root_meta = fs::symlink_metadata(root)?;
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() || root.canonicalize()? != root {
        return Err(invalid("프로젝트 루트가 변경되었습니다"));
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| invalid("루트 밖의 경로입니다"))?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else {
            return Err(invalid("잘못된 경로입니다"));
        };
        if is_dot_git(name) {
            return Err(invalid(".git 경로는 보호됩니다"));
        }
        current.push(name);
        if let Ok(meta) = fs::symlink_metadata(&current)
            && meta.file_type().is_symlink()
        {
            return Err(invalid("경로가 심볼릭 링크로 변경되었습니다"));
        }
    }
    Ok(())
}

impl FsOperations {
    /// 복구 기록 위치와 OS 휴지통 구현을 연결한다.
    pub fn new(journal_dir: PathBuf, trash: Arc<dyn FsTrash>) -> Self {
        Self {
            plans: Mutex::new(HashMap::new()),
            progresses: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashMap::new()),
            journal_dir,
            trash,
        }
    }
    /// 네이티브에서 직접 받은 경로만 외부 입력 토큰으로 등록한다.
    pub fn grant(&self, paths: Vec<PathBuf>, movable: bool) -> Result<String, CoreError> {
        if paths.is_empty() || paths.len() > 1000 {
            return Err(invalid("파일을 1~1,000개 선택해 주세요"));
        }
        let mut resolved = Vec::new();
        for path in paths {
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() {
                return Err(invalid("심볼릭 링크는 가져올 수 없습니다"));
            }
            resolved.push(path.canonicalize()?);
        }
        let id = next_id();
        let mut grants = self.grants.lock().unwrap_or_else(PoisonError::into_inner);
        if grants.len() >= 64 {
            grants.clear();
        }
        grants.insert(
            id.clone(),
            Grant {
                paths: resolved,
                movable,
            },
        );
        Ok(id)
    }
    /// 셸이 clipboard로 보낼 세션 경로를 같은 코어 경계로 확인한다.
    pub fn source_path(
        &self,
        core: &Core,
        source: &FsSource,
        moving: bool,
    ) -> Result<PathBuf, CoreError> {
        match source {
            FsSource::Session { session, path } => {
                checked(&core.fs_root(SessionId(*session))?, path, false)
            }
            FsSource::External { token, index } => {
                let grants = self.grants.lock().unwrap_or_else(PoisonError::into_inner);
                let grant = grants
                    .get(token)
                    .ok_or_else(|| invalid("파일 입력이 만료되었습니다. 다시 복사해 주세요"))?;
                if moving && !grant.movable {
                    return Err(invalid("외부 파일은 복사로만 가져올 수 있습니다"));
                }
                grant
                    .paths
                    .get(*index as usize)
                    .cloned()
                    .ok_or_else(|| invalid("잘못된 파일 입력입니다"))
            }
        }
    }
    /// 계획은 읽기만 수행한다. 실패한 항목도 UI에 돌려주어 나머지를 실행할 수 있다.
    pub async fn prepare(
        &self,
        core: &Core,
        request: FsOperationRequest,
    ) -> Result<FsOperationPlan, CoreError> {
        let id = next_id();
        let kind = request.kind;
        let destination = request
            .destination
            .as_ref()
            .map(|d| {
                let root = core.fs_root(SessionId(d.session))?.canonicalize()?;
                let path = checked(
                    &root,
                    &d.path,
                    matches!(kind, FsOperationKind::Copy | FsOperationKind::Move),
                )?;
                Ok::<_, CoreError>((root, path))
            })
            .transpose()?;
        if !matches!(kind, FsOperationKind::Trash) && destination.is_none() {
            return Err(invalid("목적지가 필요합니다"));
        }
        if matches!(
            kind,
            FsOperationKind::CreateFile | FsOperationKind::CreateDirectory
        ) && !request.sources.is_empty()
        {
            return Err(invalid("생성 작업에는 원본이 없습니다"));
        }
        if matches!(kind, FsOperationKind::Rename) && request.sources.len() != 1 {
            return Err(invalid("이름은 한 항목씩 변경합니다"));
        }
        let mut sources = Vec::new();
        for source in &request.sources {
            let path = self.source_path(
                core,
                source,
                matches!(
                    kind,
                    FsOperationKind::Move | FsOperationKind::Rename | FsOperationKind::Trash
                ),
            )?;
            let root = match source {
                FsSource::Session { session, .. } => {
                    core.fs_root(SessionId(*session))?.canonicalize()?
                }
                _ => path
                    .parent()
                    .ok_or_else(|| invalid("루트는 변경할 수 없습니다"))?
                    .to_path_buf(),
            };
            sources.push((root, path));
        }
        sources.sort_by(|a, b| a.1.cmp(&b.1));
        sources.dedup_by(|a, b| a.1 == b.1);
        let mut unique: Vec<(PathBuf, PathBuf)> = Vec::new();
        for source in sources {
            if !unique.iter().any(|(_, p)| source.1.starts_with(p)) {
                unique.push(source);
            }
        }
        let plan_id = id.clone();
        let nodes = run_blocking(move || {
            if matches!(
                kind,
                FsOperationKind::CreateFile | FsOperationKind::CreateDirectory
            ) {
                let (root, dest) = destination.ok_or_else(|| invalid("목적지가 필요합니다"))?;
                return Ok(vec![build_node(
                    "0".into(),
                    None,
                    Some(dest),
                    None,
                    Some(root),
                    kind == FsOperationKind::CreateDirectory,
                    false,
                )?]);
            }
            if unique.is_empty() {
                return Err(invalid("선택한 파일이 없습니다"));
            }
            let mut nodes = Vec::new();
            for (i, (root, source)) in unique.into_iter().enumerate() {
                let dest = destination.as_ref().map(|(_, path)| {
                    if matches!(kind, FsOperationKind::Copy | FsOperationKind::Move) {
                        path.join(source.file_name().unwrap_or_default())
                    } else {
                        path.clone()
                    }
                });
                let directory = source.is_dir();
                let result = if dest
                    .as_ref()
                    .is_some_and(|d| directory && d != &source && d.starts_with(&source))
                {
                    Err(invalid("폴더를 자기 하위로 옮기거나 복사할 수 없습니다"))
                } else {
                    build_node(
                        i.to_string(),
                        Some(source.clone()),
                        dest.clone(),
                        Some(root.clone()),
                        destination.as_ref().map(|d| d.0.clone()),
                        directory,
                        true,
                    )
                };
                nodes.push(match result {
                    Ok(n) => n,
                    Err(e) => Node {
                        item: FsOperationItem {
                            id: i.to_string(),
                            source: Some(display(&source)),
                            destination: dest.as_deref().map(display),
                            directory,
                            conflict: FsConflictKind::None,
                            error: Some(e.to_string()),
                            source_size: None,
                            destination_size: None,
                            source_mtime_ms: None,
                            destination_mtime_ms: None,
                        },
                        source: Some(source),
                        destination: dest,
                        source_root: Some(root),
                        destination_root: destination.as_ref().map(|d| d.0.clone()),
                        source_stamp: None,
                        destination_stamp: None,
                        children: vec![],
                    },
                });
            }
            Ok(nodes)
        })
        .await?;
        let mut items = Vec::new();
        for node in &nodes {
            flatten(node, &mut items);
        }
        let plan = FsOperationPlan {
            id: plan_id,
            kind,
            items,
        };
        let mut plans = self.plans.lock().unwrap_or_else(PoisonError::into_inner);
        if plans.len() >= 64 {
            return Err(invalid("대기 중인 파일 작업이 너무 많습니다"));
        }
        let progress = Arc::new(Mutex::new(FsOperationProgress {
            completed: 0,
            total: plan.items.len() as u32,
            current_path: None,
        }));
        let mut progresses = self
            .progresses
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if progresses.len() >= 128 {
            progresses.retain(|key, _| plans.contains_key(key));
        }
        progresses.insert(id.clone(), progress.clone());
        plans.insert(
            id,
            Prepared {
                plan: plan.clone(),
                nodes,
                cancel: Arc::new(AtomicBool::new(false)),
                running: Arc::new(AtomicBool::new(false)),
                progress,
            },
        );
        Ok(plan)
    }
    /// 진행률은 완료 이후에도 최근 작업에 대해 조회할 수 있다.
    pub fn progress(&self, id: &str) -> FsOperationProgress {
        self.progresses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .map(|value| value.lock().unwrap_or_else(PoisonError::into_inner).clone())
            .unwrap_or_default()
    }
    /// 대기 중 작업은 제거하고 실행 중 작업에는 협력 취소 신호를 보낸다.
    pub fn cancel(&self, id: &str) {
        let mut plans = self.plans.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(plan) = plans.get(id) {
            plan.cancel.store(true, Ordering::Release);
            if !plan.running.load(Ordering::Acquire) {
                plans.remove(id);
            }
        }
    }
    /// 저장·구조 변경은 같은 큐를 사용하고 관련 저장소 잠금은 일정한 순서로 잡는다.
    pub async fn execute(
        &self,
        core: Arc<Core>,
        id: &str,
        decisions: Vec<FsOperationDecision>,
    ) -> Result<FsOperationResult, CoreError> {
        let prepared = self
            .plans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("파일 작업 계획이 만료되었습니다"))?;
        if prepared.running.swap(true, Ordering::AcqRel) {
            return Err(invalid("파일 작업이 이미 실행 중입니다"));
        }
        let _lease = PlanLease {
            plans: &self.plans,
            id: id.to_owned(),
            cancel: prepared.cancel.clone(),
        };
        let _mutation = FS_MUTATION_LOCK.lock().await;
        let paths: Vec<PathBuf> = prepared
            .nodes
            .iter()
            .flat_map(|n| [n.source.clone(), n.destination.clone()])
            .flatten()
            .collect();
        let inner = core.inner_arc();
        let mut repo_dirs = Vec::new();
        for path in &paths {
            let mut parent = path.parent().unwrap_or(path);
            while !parent.exists() {
                parent = parent
                    .parent()
                    .ok_or_else(|| invalid("상위 폴더가 없습니다"))?;
            }
            match discover(inner.runner(), parent).await {
                Ok(repo) => repo_dirs.push(repo.common_dir),
                Err(GitError::NotARepository(_)) => {}
                Err(error) => return Err(error.into()),
            }
        }
        repo_dirs.sort();
        repo_dirs.dedup();
        let mut guards = Vec::new();
        for path in repo_dirs {
            guards.push(inner.write_lock_for(&path).lock_owned().await);
        }
        let journal_dir = self.journal_dir.clone();
        let trash = self.trash.clone();
        let operation_id = id.to_owned();
        let result = run_blocking(move || {
            let mut run = Execution {
                kind: prepared.plan.kind,
                decisions: decisions
                    .into_iter()
                    .map(|d| (d.item_id.clone(), d))
                    .collect(),
                cancelled: prepared.cancel,
                progress: prepared.progress.clone(),
                trash,
                journal_dir,
                outcomes: vec![],
            };
            for node in &prepared.nodes {
                run.node(node, None);
            }
            {
                let mut progress = prepared
                    .progress
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                progress.completed = progress.total;
                progress.current_path = None;
            }
            Ok(FsOperationResult {
                id: operation_id,
                items: run.outcomes,
            })
        })
        .await;
        self.plans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        drop(guards);
        drop(_mutation);
        core.refresh_file_operations(&paths).await;
        result
    }
    /// 미완료 기록은 목적지와 복구본의 상태를 확인하며 복구한다. 원본 삭제를 자동 재개하지 않는다.
    pub fn recover(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        let Ok(entries) = fs::read_dir(&self.journal_dir) else {
            return warnings;
        };
        for entry in entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
        {
            let result = (|| -> Result<(), CoreError> {
                let record: Journal = serde_json::from_reader(File::open(entry.path())?)
                    .map_err(|e| invalid(e.to_string()))?;
                if let Some(root) = &record.destination_root {
                    recheck(root, &record.destination)?;
                }
                if record.stage.parent() != record.destination.parent()
                    || record.backup.parent() != record.destination.parent()
                    || !record
                        .stage
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with(".mgit-fs-stage-"))
                    || !record
                        .backup
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with(".mgit-fs-backup-"))
                {
                    return Err(invalid("복구 기록의 경로가 올바르지 않습니다"));
                }
                if record.backup.exists() && !record.destination.exists() {
                    rename_exclusive(&record.backup, &record.destination)?;
                }
                if record.backup.exists() {
                    return Err(invalid(format!(
                        "복구본을 보존했습니다: {}",
                        display(&record.backup)
                    )));
                }
                if let Some(cleanup) = &record.source_cleanup
                    && cleanup.exists()
                {
                    return Err(invalid(format!(
                        "원본 복구본을 보존했습니다: {}",
                        display(cleanup)
                    )));
                }
                if record.stage.exists() {
                    if record.stage_stamp.is_none() || stamp(&record.stage)? != record.stage_stamp {
                        return Err(invalid(format!(
                            "미완료 파일을 보존했습니다: {}",
                            display(&record.stage)
                        )));
                    }
                    if record.stage.is_dir() {
                        fs::remove_dir_all(&record.stage)?;
                    } else {
                        fs::remove_file(&record.stage)?;
                    }
                }
                fs::remove_file(entry.path())?;
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(error.to_string());
            }
        }
        warnings
    }
}

impl Core {
    /// 파일 시스템 변경이 겹치는 모든 저장소·폴더의 상태를 갱신한다.
    async fn refresh_file_operations(&self, paths: &[PathBuf]) {
        let inner = self.inner_arc();
        let sessions: Vec<_> = inner
            .sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for session in sessions {
            if paths.iter().any(|p| p.starts_with(&session.info.work_tree)) {
                inner
                    .refresh_session(
                        &session,
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
            if paths.iter().any(|p| p.starts_with(&folder.path)) {
                folder.sink.emit(CoreEvent::FolderChanged {
                    session: folder.id,
                    refs: false,
                    repo: None,
                });
            }
        }
    }
}

/// 하위 항목도 별도 충돌 선택을 받을 수 있게 결정 목록을 만든다.
fn build_node(
    id: String,
    source: Option<PathBuf>,
    destination: Option<PathBuf>,
    source_root: Option<PathBuf>,
    destination_root: Option<PathBuf>,
    directory: bool,
    recurse: bool,
) -> Result<Node, CoreError> {
    let source_stamp = source.as_deref().map(stamp).transpose()?.flatten();
    if source.is_some() && source_stamp.is_none() {
        return Err(invalid("원본 파일이 없습니다"));
    }
    let destination_stamp = destination.as_deref().map(stamp).transpose()?.flatten();
    let conflict = if destination_stamp.is_none() {
        FsConflictKind::None
    } else if destination.as_ref().is_some_and(|d| d.is_dir()) {
        if directory {
            FsConflictKind::Directory
        } else {
            FsConflictKind::Type
        }
    } else if directory {
        FsConflictKind::Type
    } else {
        FsConflictKind::File
    };
    let mut children = Vec::new();
    if recurse
        && directory
        && let Some(src) = &source
    {
        let mut entries: Vec<_> = fs::read_dir(src)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for (i, entry) in entries.into_iter().enumerate() {
            children.push(build_node(
                format!("{id}/{i}"),
                Some(entry.path()),
                destination.as_ref().map(|d| d.join(entry.file_name())),
                source_root.clone(),
                destination_root.clone(),
                entry.file_type()?.is_dir(),
                true,
            )?);
        }
    }
    Ok(Node {
        item: FsOperationItem {
            id,
            source: source.as_deref().map(display),
            destination: destination.as_deref().map(display),
            directory,
            conflict,
            error: None,
            source_size: metadata_values(source.as_deref()).0,
            source_mtime_ms: metadata_values(source.as_deref()).1,
            destination_size: metadata_values(destination.as_deref()).0,
            destination_mtime_ms: metadata_values(destination.as_deref()).1,
        },
        source,
        destination,
        source_root,
        destination_root,
        source_stamp,
        destination_stamp,
        children,
    })
}
/// 계획을 트리 순서로 내보낸다.
fn flatten(node: &Node, out: &mut Vec<FsOperationItem>) {
    out.push(node.item.clone());
    for child in &node.children {
        flatten(child, out);
    }
}

#[derive(Serialize, Deserialize)]
struct Journal {
    stage: PathBuf,
    backup: PathBuf,
    destination: PathBuf,
    destination_root: Option<PathBuf>,
    phase: String,
    #[serde(default)]
    stage_stamp: Option<String>,
    #[serde(default)]
    source_cleanup: Option<PathBuf>,
}
struct Execution {
    kind: FsOperationKind,
    decisions: HashMap<String, FsOperationDecision>,
    cancelled: Arc<AtomicBool>,
    progress: Arc<Mutex<FsOperationProgress>>,
    trash: Arc<dyn FsTrash>,
    journal_dir: PathBuf,
    outcomes: Vec<FsOperationOutcome>,
}
impl Execution {
    /// 항목 결과를 누적하며 실패한 원본의 경로는 그대로 유지한다.
    fn outcome(
        &mut self,
        node: &Node,
        destination: Option<&Path>,
        status: FsOutcomeStatus,
        error: Option<String>,
    ) {
        self.outcomes.push(FsOperationOutcome {
            source: node.item.source.clone(),
            destination: destination.map(display),
            status,
            error,
            directory: node.item.directory,
        });
    }
    /// 하나의 파일·폴더는 실패를 국소화하고 다음 선택 항목 처리를 계속한다.
    fn node(&mut self, node: &Node, relocated: Option<&Path>) {
        let before = {
            let mut progress = self.progress.lock().unwrap_or_else(PoisonError::into_inner);
            progress.current_path = node
                .item
                .source
                .clone()
                .or_else(|| node.item.destination.clone());
            progress.completed
        };
        self.run_node(node, relocated);
        let mut progress = self.progress.lock().unwrap_or_else(PoisonError::into_inner);
        progress.completed = progress
            .completed
            .max(before.saturating_add(node_count(node)))
            .min(progress.total);
    }
    /// 실제 항목 실행은 진척도 갱신과 분리해 오류·건너뛰기도 처리 수에 포함한다.
    fn run_node(&mut self, node: &Node, relocated: Option<&Path>) {
        let dest = relocated
            .map(Path::to_path_buf)
            .or_else(|| node.destination.clone());
        if self.cancelled.load(Ordering::Acquire) {
            self.outcome(node, dest.as_deref(), FsOutcomeStatus::Cancelled, None);
            return;
        }
        if let Some(error) = &node.item.error {
            self.outcome(
                node,
                dest.as_deref(),
                FsOutcomeStatus::Failed,
                Some(error.clone()),
            );
            return;
        }
        if let Err(error) = self.apply(node, dest.as_deref()) {
            self.outcome(
                node,
                dest.as_deref(),
                if self.cancelled.load(Ordering::Acquire) {
                    FsOutcomeStatus::Cancelled
                } else {
                    FsOutcomeStatus::Failed
                },
                Some(error.to_string()),
            );
        }
    }
    /// 사용자 결정과 준비 시점의 상태가 일치할 때만 파일을 바꾼다.
    fn apply(&mut self, node: &Node, destination: Option<&Path>) -> Result<(), CoreError> {
        let decision = self.decisions.get(&node.item.id).cloned();
        if decision
            .as_ref()
            .is_some_and(|d| d.action == FsDecisionAction::Skip)
        {
            self.outcome(node, destination, FsOutcomeStatus::Skipped, None);
            return Ok(());
        }
        if let (Some(root), Some(source)) = (&node.source_root, &node.source) {
            recheck(root, source)?;
            if stamp(source)? != node.source_stamp {
                return Err(invalid("원본이 변경되었습니다. 다시 시도해 주세요"));
            }
        }
        if self.kind == FsOperationKind::Trash {
            let source = node
                .source
                .as_ref()
                .ok_or_else(|| invalid("원본이 없습니다"))?;
            self.trash.trash(source).map_err(invalid)?;
            self.outcome(node, None, FsOutcomeStatus::Committed, None);
            return Ok(());
        }
        let mut dest = destination
            .ok_or_else(|| invalid("목적지가 없습니다"))?
            .to_path_buf();
        let renamed = decision
            .as_ref()
            .is_some_and(|d| d.action == FsDecisionAction::Rename);
        if renamed {
            let name = decision
                .as_ref()
                .and_then(|d| d.name.as_deref())
                .ok_or_else(|| invalid("새 이름이 필요합니다"))?;
            let parsed = parse(name)?;
            if parsed.components().len() != 1 {
                return Err(invalid("새 이름에는 경로 구분자를 사용할 수 없습니다"));
            }
            dest = dest
                .parent()
                .ok_or_else(|| invalid("루트는 변경할 수 없습니다"))?
                .join(name);
        }
        if let Some(root) = &node.destination_root {
            recheck(root, &dest)?;
        }
        let same = node.source.as_ref().is_some_and(|src| src == &dest);
        if same && matches!(self.kind, FsOperationKind::Move | FsOperationKind::Rename) {
            self.outcome(node, Some(&dest), FsOutcomeStatus::Skipped, None);
            return Ok(());
        }
        if node
            .source
            .as_ref()
            .is_some_and(|src| node.item.directory && dest.starts_with(src))
        {
            return Err(invalid("폴더를 자기 안에 복사하거나 이동할 수 없습니다"));
        }
        let expected = if renamed || node.destination.as_deref() != Some(dest.as_path()) {
            None
        } else {
            node.destination_stamp.clone()
        };
        let current = stamp(&dest)?;
        if current != expected {
            return Err(invalid(
                "목적지가 변경되었습니다. 충돌을 다시 확인해 주세요",
            ));
        }
        // 대소문자만 바꾸는 이름 변경은 기존 파일과 동일한 객체인지 확인한다.
        if self.kind == FsOperationKind::Rename
            && node
                .source
                .as_ref()
                .is_some_and(|s| s.canonicalize().ok() == dest.canonicalize().ok())
        {
            fs::rename(
                node.source
                    .as_ref()
                    .ok_or_else(|| invalid("원본이 없습니다"))?,
                &dest,
            )?;
            self.outcome(node, Some(&dest), FsOutcomeStatus::Committed, None);
            return Ok(());
        }
        if current.is_some()
            && !matches!(
                decision.as_ref().map(|d| d.action),
                Some(FsDecisionAction::Overwrite | FsDecisionAction::Merge)
            )
        {
            return Err(invalid(
                "같은 이름의 항목이 있습니다. 덮어쓰기·병합·새 이름·건너뛰기를 선택해 주세요",
            ));
        }
        let merging = current.is_some()
            && dest.is_dir()
            && node.item.directory
            && decision
                .as_ref()
                .is_some_and(|d| d.action == FsDecisionAction::Merge);
        if decision
            .as_ref()
            .is_some_and(|d| d.action == FsDecisionAction::Merge)
            && !merging
        {
            return Err(invalid("폴더끼리만 병합할 수 있습니다"));
        }
        if merging {
            let start = self.outcomes.len();
            for child in &node.children {
                let child_dest = dest.join(
                    child
                        .source
                        .as_ref()
                        .and_then(|p| p.file_name())
                        .unwrap_or_default(),
                );
                self.node(child, Some(&child_dest));
            }
            let success = self.outcomes[start..]
                .iter()
                .all(|r| r.status == FsOutcomeStatus::Committed);
            if success
                && matches!(self.kind, FsOperationKind::Move | FsOperationKind::Rename)
                && let Some(source) = &node.source
            {
                fs::remove_dir(source)?;
            }
            if success {
                self.outcome(node, Some(&dest), FsOutcomeStatus::Committed, None);
            }
            return Ok(());
        }
        let warning = self.publish(node, &dest, current.is_some())?;
        self.outcome(node, Some(&dest), FsOutcomeStatus::Committed, warning);
        Ok(())
    }
    /// 목적지와 같은 파일시스템에 완성본을 만들고 복구 기록을 남긴 뒤 게시한다.
    fn publish(
        &self,
        node: &Node,
        dest: &Path,
        overwrite: bool,
    ) -> Result<Option<String>, CoreError> {
        let parent = dest
            .parent()
            .ok_or_else(|| invalid("목적지 부모가 없습니다"))?;
        // 같은 파일시스템의 이동은 inode·권한·확장 속성을 유지하며 원자적으로 수행한다.
        if !overwrite
            && matches!(self.kind, FsOperationKind::Move | FsOperationKind::Rename)
            && let Some(source) = &node.source
        {
            match rename_exclusive(source, dest) {
                Ok(()) => {
                    return Ok(sync_parent(parent)
                        .err()
                        .map(|e| format!("이동은 완료됐지만 동기화 확인에 실패했습니다: {e}")));
                }
                Err(error) if error.raw_os_error() == Some(18) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let id = next_id();
        let stage = parent.join(format!(".mgit-fs-stage-{id}"));
        let backup = parent.join(format!(".mgit-fs-backup-{id}"));
        fs::create_dir_all(&self.journal_dir)?;
        let journal_path = self.journal_dir.join(format!("{id}.json"));
        let mut record = Journal {
            stage: stage.clone(),
            backup: backup.clone(),
            destination: dest.to_path_buf(),
            destination_root: node.destination_root.clone(),
            phase: "prepared".into(),
            stage_stamp: None,
            source_cleanup: None,
        };
        write_journal(&journal_path, &record)?;
        let mut published = false;
        let mut source_removed = false;
        let prepared = (|| -> Result<(), CoreError> {
            if let Some(source) = &node.source {
                copy_tree(source, &stage, &self.cancelled, &self.progress)?;
                if stamp(source)? != node.source_stamp {
                    return Err(invalid("복사 중 원본이 변경되었습니다"));
                }
            } else if node.item.directory {
                fs::create_dir(&stage)?;
            } else {
                File::create(&stage)?.sync_all()?;
            }
            record.stage_stamp = stamp(&stage)?;
            write_journal(&journal_path, &record)?;
            if self.cancelled.load(Ordering::Acquire) {
                return Err(invalid("파일 작업이 취소되었습니다"));
            }
            if let Some(root) = &node.destination_root {
                recheck(root, dest)?;
            }
            if stamp(dest)?
                != if overwrite {
                    node.destination_stamp.clone()
                } else {
                    None
                }
            {
                return Err(invalid("게시 전에 목적지가 변경되었습니다"));
            }
            if overwrite {
                rename_exclusive(dest, &backup)?;
            }
            if let Err(error) = rename_exclusive(&stage, dest) {
                if backup.exists() {
                    rename_exclusive(&backup, dest)?;
                }
                return Err(error.into());
            }
            published = true;
            sync_parent(parent)?;
            record.phase = "destinationCommitted".into();
            write_journal(&journal_path, &record)?;
            if matches!(self.kind, FsOperationKind::Move | FsOperationKind::Rename) {
                let source = node
                    .source
                    .as_ref()
                    .ok_or_else(|| invalid("원본이 없습니다"))?;
                if let Some(root) = &node.source_root {
                    recheck(root, source)?;
                }
                if stamp(source)? != node.source_stamp {
                    return Err(invalid(
                        "목적지 복사는 완료됐지만 원본이 변경되어 보존했습니다",
                    ));
                }
                // 복사된 디렉터리를 부분 삭제하지 않고 원본 이름을 먼저 원자적으로 비운다.
                let cleanup = source
                    .parent()
                    .ok_or_else(|| invalid("원본 부모가 없습니다"))?
                    .join(format!(".mgit-fs-source-{id}"));
                record.source_cleanup = Some(cleanup.clone());
                write_journal(&journal_path, &record)?;
                rename_exclusive(source, &cleanup)?;
                source_removed = true;
                sync_parent(
                    source
                        .parent()
                        .ok_or_else(|| invalid("원본 부모가 없습니다"))?,
                )?;
                self.trash.trash(&cleanup).map_err(|e| {
                    invalid(format!(
                        "이동은 완료됐지만 원본 복구본을 보존했습니다 ({}): {e}",
                        display(&cleanup)
                    ))
                })?;
            }
            record.phase = "completed".into();
            write_journal(&journal_path, &record)?;
            if backup.exists() {
                self.trash.trash(&backup).map_err(|e| {
                    invalid(format!(
                        "교체는 완료됐지만 복구본을 보존했습니다 ({}): {e}",
                        display(&backup)
                    ))
                })?;
            }
            fs::remove_file(&journal_path)?;
            Ok(())
        })();
        if prepared.is_err() && record.phase == "prepared" && !backup.exists() {
            if stage.is_dir() {
                let _ = fs::remove_dir_all(&stage);
            } else {
                let _ = fs::remove_file(&stage);
            }
            let _ = fs::remove_file(&journal_path);
        }
        match prepared {
            Ok(()) => Ok(None),
            Err(error)
                if published
                    && (!matches!(self.kind, FsOperationKind::Move | FsOperationKind::Rename)
                        || source_removed) =>
            {
                Ok(Some(error.to_string()))
            }
            Err(error) if published => Err(invalid(format!(
                "목적지 복사는 완료됐지만 원본을 보존했습니다: {error}"
            ))),
            Err(error) => Err(error),
        }
    }
}
/// 복사 도중 원본을 따라가지 않으며 파일 권한을 보존한다.
fn copy_tree(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    progress: &Mutex<FsOperationProgress>,
) -> Result<(), CoreError> {
    if cancel.load(Ordering::Acquire) {
        return Err(invalid("파일 작업이 취소되었습니다"));
    }
    {
        let mut p = progress.lock().unwrap_or_else(PoisonError::into_inner);
        p.current_path = Some(display(source));
    }
    let meta = fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() || source.file_name().is_some_and(is_dot_git) {
        return Err(invalid("심볼릭 링크 및 .git은 복사하지 않습니다"));
    }
    if meta.is_dir() {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(
                &entry.path(),
                &destination.join(entry.file_name()),
                cancel,
                progress,
            )?;
        }
        fs::set_permissions(destination, meta.permissions())?;
        sync_parent(destination)?;
    } else if meta.is_file() {
        let mut input = open_read(source)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let mut bytes = [0; 64 * 1024];
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(invalid("파일 작업이 취소되었습니다"));
            }
            let n = input.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            output.write_all(&bytes[..n])?;
        }
        output.set_permissions(meta.permissions())?;
        output.sync_all()?;
    } else {
        return Err(invalid("특수 파일은 복사하지 않습니다"));
    }
    {
        let mut p = progress.lock().unwrap_or_else(PoisonError::into_inner);
        p.completed = p.completed.saturating_add(1).min(p.total);
        p.current_path = Some(display(source));
    }
    Ok(())
}
/// journal 교체도 원자적으로 수행하고 디렉터리까지 디스크에 반영한다.
fn write_journal(path: &Path, record: &Journal) -> Result<(), CoreError> {
    let temp = path.with_extension("pending");
    let mut file = File::create(&temp)?;
    serde_json::to_writer(&mut file, record).map_err(|e| invalid(e.to_string()))?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    sync_parent(
        path.parent()
            .ok_or_else(|| invalid("기록 위치가 없습니다"))?,
    )
}
/// macOS·Unix에서 rename을 포함하는 부모 디렉터리 변경을 동기화한다.
fn sync_parent(path: &Path) -> Result<(), CoreError> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    Ok(())
}

/// 경쟁 작업이 만든 목적지를 절대 덮어쓰지 않는 이름 변경이다.
fn rename_exclusive(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            source,
            rustix::fs::CWD,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(Into::into)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (source, destination);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "이 플랫폼의 안전한 이름 변경은 지원하지 않습니다",
        ))
    }
}

/// 앱이 만든 작업 임시 이름만 Project 목록에서 숨긴다.
pub(super) fn is_operation_temporary(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    [".mgit-fs-stage-", ".mgit-fs-backup-", ".mgit-fs-source-"]
        .iter()
        .any(|prefix| {
            name.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.split('-').count() == 3
                    && suffix
                        .split('-')
                        .all(|piece| !piece.is_empty() && piece.bytes().all(|b| b.is_ascii_digit()))
            })
        })
}

/// 충돌 대화상자에 필요한 파일 크기·수정 시각만 조회한다.
fn metadata_values(path: Option<&Path>) -> (Option<f64>, Option<f64>) {
    let Some(meta) = path.and_then(|p| fs::symlink_metadata(p).ok()) else {
        return (None, None);
    };
    (
        meta.is_file().then_some(meta.len() as f64),
        meta.modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as f64),
    )
}
/// 트리 전체 처리 항목 수를 센다.
fn node_count(node: &Node) -> u32 {
    1 + node.children.iter().map(node_count).sum::<u32>()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    struct TestTrash {
        root: PathBuf,
        fail: bool,
    }
    impl FsTrash for TestTrash {
        /// 테스트 휴지통은 파일을 별도 폴더로 옮겨 복구 가능성을 검증한다.
        fn trash(&self, path: &Path) -> Result<(), String> {
            if self.fail {
                return Err("휴지통 실패".into());
            }
            fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
            fs::rename(path, self.root.join(next_id())).map_err(|e| e.to_string())
        }
    }
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        other: PathBuf,
        journal: PathBuf,
        trash: Arc<TestTrash>,
    }
    impl Fixture {
        /// 실제 파일시스템의 독립된 두 Project 루트를 만든다.
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().canonicalize().unwrap();
            let root = path.join("source");
            let other = path.join("target");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&other).unwrap();
            Self {
                root,
                other,
                journal: path.join("journal"),
                trash: Arc::new(TestTrash {
                    root: path.join("trash"),
                    fail: false,
                }),
                _temp: temp,
            }
        }
        /// 계획에 사용할 원본과 목적지 상태를 캡처한다.
        fn node(&self, source: Option<&str>, destination: &str, directory: bool) -> Node {
            build_node(
                "0".into(),
                source.map(|p| self.root.join(p)),
                Some(self.other.join(destination)),
                Some(self.root.clone()),
                Some(self.other.clone()),
                directory,
                source.is_some(),
            )
            .unwrap()
        }
        /// OS·Git 의존성이 없는 실제 파일 실행 단위를 검증한다.
        fn run(
            &self,
            kind: FsOperationKind,
            node: &Node,
            decisions: Vec<FsOperationDecision>,
        ) -> Vec<FsOperationOutcome> {
            let mut execution = Execution {
                kind,
                decisions: decisions
                    .into_iter()
                    .map(|d| (d.item_id.clone(), d))
                    .collect(),
                cancelled: Arc::new(AtomicBool::new(false)),
                progress: Arc::new(Mutex::new(FsOperationProgress {
                    completed: 0,
                    total: node_count(node),
                    current_path: None,
                })),
                trash: self.trash.clone(),
                journal_dir: self.journal.clone(),
                outcomes: vec![],
            };
            execution.node(node, None);
            execution.outcomes
        }
    }
    /// 같은 이름의 항목을 생성할 때 승인 없이 덮어쓰지 않는다.
    #[test]
    fn create_file_and_directory_and_collision() {
        let f = Fixture::new();
        let node = f.node(None, "new.txt", false);
        assert_eq!(
            f.run(FsOperationKind::CreateFile, &node, vec![])[0].status,
            FsOutcomeStatus::Committed
        );
        assert_eq!(fs::read(f.other.join("new.txt")).unwrap(), b"");
        let node = f.node(None, "new.txt", false);
        assert_eq!(node.item.conflict, FsConflictKind::File);
        assert_eq!(
            f.run(FsOperationKind::CreateFile, &node, vec![])[0].status,
            FsOutcomeStatus::Failed
        );
        let node = f.node(None, "empty", true);
        assert_eq!(
            f.run(FsOperationKind::CreateDirectory, &node, vec![])[0].status,
            FsOutcomeStatus::Committed
        );
        assert!(f.other.join("empty").is_dir());
    }
    /// 다른 Project에 복사한 뒤 이동하면 원본과 목적지 결과가 구분된다.
    #[test]
    fn copy_and_move_between_roots() {
        let f = Fixture::new();
        fs::write(f.root.join("file.txt"), "안녕하세요").unwrap();
        let node = f.node(Some("file.txt"), "copy.txt", false);
        assert_eq!(
            f.run(FsOperationKind::Copy, &node, vec![])[0].status,
            FsOutcomeStatus::Committed
        );
        assert!(f.root.join("file.txt").exists());
        let node = f.node(Some("file.txt"), "move.txt", false);
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(f.root.join("file.txt")).unwrap().ino()
        };
        assert_eq!(
            f.run(FsOperationKind::Move, &node, vec![])[0].status,
            FsOutcomeStatus::Committed
        );
        assert!(!f.root.join("file.txt").exists());
        assert_eq!(
            fs::read_to_string(f.other.join("move.txt")).unwrap(),
            "안녕하세요"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(f.other.join("move.txt")).unwrap().ino(), inode);
        }
    }
    /// 계획 이후 외부 변경을 발견하면 원본과 목적지를 유지한다.
    #[test]
    fn stale_source_and_destination_are_not_overwritten() {
        let f = Fixture::new();
        fs::write(f.root.join("file"), "before").unwrap();
        let node = f.node(Some("file"), "file", false);
        fs::write(f.root.join("file"), "after").unwrap();
        assert_eq!(
            f.run(FsOperationKind::Move, &node, vec![])[0].status,
            FsOutcomeStatus::Failed
        );
        assert!(!f.other.join("file").exists());
        let node = f.node(Some("file"), "file", false);
        fs::write(f.other.join("file"), "external").unwrap();
        assert_eq!(
            f.run(FsOperationKind::Copy, &node, vec![])[0].status,
            FsOutcomeStatus::Failed
        );
        assert_eq!(
            fs::read_to_string(f.other.join("file")).unwrap(),
            "external"
        );
    }
    /// 폴더 병합의 일부 건너뛰기는 원본 폴더를 유지하고 성공한 파일만 이동한다.
    #[test]
    fn merge_partial_move_keeps_skipped_sources() {
        let f = Fixture::new();
        fs::create_dir(f.root.join("dir")).unwrap();
        fs::create_dir(f.other.join("dir")).unwrap();
        fs::write(f.root.join("dir/a"), "new-a").unwrap();
        fs::write(f.root.join("dir/b"), "new-b").unwrap();
        fs::write(f.other.join("dir/a"), "old-a").unwrap();
        let node = f.node(Some("dir"), "dir", true);
        let result = f.run(
            FsOperationKind::Move,
            &node,
            vec![
                FsOperationDecision {
                    item_id: "0".into(),
                    action: FsDecisionAction::Merge,
                    name: None,
                },
                FsOperationDecision {
                    item_id: "0/0".into(),
                    action: FsDecisionAction::Skip,
                    name: None,
                },
            ],
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].status, FsOutcomeStatus::Skipped);
        assert_eq!(result[1].status, FsOutcomeStatus::Committed);
        assert!(f.root.join("dir/a").exists());
        assert!(!f.root.join("dir/b").exists());
        assert_eq!(fs::read_to_string(f.other.join("dir/a")).unwrap(), "old-a");
        assert_eq!(fs::read_to_string(f.other.join("dir/b")).unwrap(), "new-b");
    }
    /// 기존 목적지 복구본 정리 실패도 완료된 이동을 실패로 되돌리지 않는다.
    #[test]
    fn completed_move_reports_cleanup_warning_as_committed() {
        let mut f = Fixture::new();
        f.trash = Arc::new(TestTrash {
            root: f.trash.root.clone(),
            fail: true,
        });
        fs::write(f.root.join("file"), "new").unwrap();
        fs::write(f.other.join("file"), "old").unwrap();
        let node = f.node(Some("file"), "file", false);
        let result = f.run(
            FsOperationKind::Move,
            &node,
            vec![FsOperationDecision {
                item_id: "0".into(),
                action: FsDecisionAction::Overwrite,
                name: None,
            }],
        );
        assert_eq!(result[0].status, FsOutcomeStatus::Committed);
        assert!(result[0].error.is_some());
        assert!(!f.root.join("file").exists());
        assert_eq!(fs::read_to_string(f.other.join("file")).unwrap(), "new");
        assert!(
            !FsOperations::new(f.journal.clone(), f.trash.clone())
                .recover()
                .is_empty()
        );
    }
    /// 승인한 덮어쓰기는 예전 목적지 파일을 휴지통으로 보존한다.
    #[test]
    fn overwrite_preserves_previous_destination_in_trash() {
        let f = Fixture::new();
        fs::write(f.root.join("file"), "new").unwrap();
        fs::write(f.other.join("file"), "old").unwrap();
        let node = f.node(Some("file"), "file", false);
        let result = f.run(
            FsOperationKind::Copy,
            &node,
            vec![FsOperationDecision {
                item_id: "0".into(),
                action: FsDecisionAction::Overwrite,
                name: None,
            }],
        );
        assert_eq!(result[0].status, FsOutcomeStatus::Committed);
        let old = fs::read_dir(&f.trash.root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read_to_string(old).unwrap(), "old");
        assert!(f.root.join("file").exists());
    }
    /// 이름 변경 선택은 같은 디렉터리의 새 이름에만 적용한다.
    #[test]
    fn conflict_rename_cannot_escape_or_overwrite() {
        let f = Fixture::new();
        fs::write(f.root.join("file"), "new").unwrap();
        fs::write(f.other.join("file"), "old").unwrap();
        let node = f.node(Some("file"), "file", false);
        let decision = |name: &str| {
            vec![FsOperationDecision {
                item_id: "0".into(),
                action: FsDecisionAction::Rename,
                name: Some(name.into()),
            }]
        };
        assert_eq!(
            f.run(FsOperationKind::Copy, &node, decision("../escape"))[0].status,
            FsOutcomeStatus::Failed
        );
        let result = f.run(FsOperationKind::Copy, &node, decision("renamed"));
        assert_eq!(result[0].status, FsOutcomeStatus::Committed);
        assert_eq!(
            result[0].destination.as_deref(),
            Some(display(&f.other.join("renamed")).as_str())
        );
        assert_eq!(fs::read_to_string(f.other.join("file")).unwrap(), "old");
    }
    /// 직접 .git 경로뿐 아니라 저장소를 포함하는 폴더도 거부한다.
    #[test]
    fn protected_nested_repositories_and_root_are_rejected() {
        let f = Fixture::new();
        fs::create_dir_all(f.root.join("folder/repo")).unwrap();
        fs::write(f.root.join("folder/repo/.git"), "gitdir: somewhere").unwrap();
        assert!(stamp(&f.root.join("folder")).is_err());
        assert!(checked(&f.root, "", false).is_err());
        assert!(checked(&f.root, "../escape", false).is_err());
        assert!(checked(&f.root, ".git", false).is_err());
    }
    /// 링크를 거친 목적지와 트리 내부의 링크를 모두 거부한다.
    #[cfg(unix)]
    #[test]
    fn symlink_source_and_destination_are_rejected() {
        let f = Fixture::new();
        std::os::unix::fs::symlink(&f.other, f.root.join("link")).unwrap();
        assert!(checked(&f.root, "link/file", false).is_err());
        assert!(stamp(&f.root.join("link")).is_err());
    }
    /// 계획 취소를 반복해도 대기 계획 슬롯이 남지 않는다.
    #[test]
    fn cancelling_preparations_releases_all_slots() {
        let f = Fixture::new();
        let operations = FsOperations::new(f.journal, f.trash);
        for index in 0..100 {
            let id = index.to_string();
            operations.plans.lock().unwrap().insert(
                id.clone(),
                Prepared {
                    plan: FsOperationPlan {
                        id: id.clone(),
                        kind: FsOperationKind::Copy,
                        items: vec![],
                    },
                    nodes: vec![],
                    cancel: Arc::new(AtomicBool::new(false)),
                    running: Arc::new(AtomicBool::new(false)),
                    progress: Arc::new(Mutex::new(FsOperationProgress::default())),
                },
            );
            operations.cancel(&id);
        }
        assert!(operations.plans.lock().unwrap().is_empty());
    }
    /// 게시 이전 중단에서 목적지가 비어 있으면 원래 파일을 복구한다.
    #[test]
    fn recovery_restores_backup_without_deleting_changed_stage() {
        let f = Fixture::new();
        fs::create_dir_all(&f.journal).unwrap();
        let record = Journal {
            stage: f.other.join(".mgit-fs-stage-test"),
            backup: f.other.join(".mgit-fs-backup-test"),
            destination: f.other.join("file"),
            destination_root: Some(f.other.clone()),
            phase: "prepared".into(),
            stage_stamp: None,
            source_cleanup: None,
        };
        fs::write(&record.backup, "old").unwrap();
        fs::write(&record.stage, "partial").unwrap();
        write_journal(&f.journal.join("test.json"), &record).unwrap();
        let warnings = FsOperations::new(f.journal, f.trash).recover();
        assert_eq!(fs::read_to_string(f.other.join("file")).unwrap(), "old");
        assert!(record.stage.exists());
        assert_eq!(warnings.len(), 1);
    }
    /// 공개 코어 계약은 생성·진행률·단일 실행과 Git 인덱스 보존을 함께 보장한다.
    #[tokio::test]
    async fn public_operation_contract_preserves_git_index() {
        let runner = mgit_git::TokioGitRunner::new(mgit_git::RunnerConfig::default())
            .await
            .unwrap();
        let core = Arc::new(Core::new(Arc::new(runner), crate::CoreConfig::default()));
        let mut repo = mgit_testkit::build(mgit_testkit::Scenario::Linear(1));
        let opened = core
            .open_repo(repo.path(), Arc::new(|_: CoreEvent| {}))
            .await
            .unwrap();
        let f = Fixture::new();
        let operations = FsOperations::new(f.journal, f.trash);
        let plan = operations
            .prepare(
                &core,
                FsOperationRequest {
                    kind: FsOperationKind::CreateFile,
                    sources: vec![],
                    destination: Some(FsLocation {
                        session: opened.session.0,
                        path: "created.txt".into(),
                    }),
                },
            )
            .await
            .unwrap();
        assert_eq!(operations.progress(&plan.id).total, 1);
        let result = operations
            .execute(core.clone(), &plan.id, vec![])
            .await
            .unwrap();
        assert_eq!(result.items[0].status, FsOutcomeStatus::Committed);
        assert_eq!(operations.progress(&plan.id).completed, 1);
        assert!(
            operations
                .execute(core.clone(), &plan.id, vec![])
                .await
                .is_err()
        );
        assert!(repo.git_ok(["diff", "--cached", "--name-only"]).is_empty());
        assert!(repo.path().join("created.txt").exists());
    }
    /// APFS 대소문자 비구분 볼륨에서도 요청한 파일명 철자를 적용한다.
    #[cfg(target_os = "macos")]
    #[test]
    fn case_only_rename_keeps_contents() {
        let f = Fixture::new();
        fs::write(f.root.join("lower.txt"), "body").unwrap();
        let node = build_node(
            "0".into(),
            Some(f.root.join("lower.txt")),
            Some(f.root.join("LOWER.txt")),
            Some(f.root.clone()),
            Some(f.root.clone()),
            false,
            true,
        )
        .unwrap();
        let result = f.run(FsOperationKind::Rename, &node, vec![]);
        assert_eq!(result[0].status, FsOutcomeStatus::Committed);
        assert!(
            fs::read_dir(&f.root)
                .unwrap()
                .any(|e| e.unwrap().file_name() == "LOWER.txt")
        );
        assert_eq!(
            fs::read_to_string(f.root.join("LOWER.txt")).unwrap(),
            "body"
        );
    }
}
