//! 원격 삭제와 추적 로컬 정리를 단일·폴더 세션에서 같은 검증으로 실행한다.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use mgit_git::cmd::discover;
use mgit_l10n::pick;
use mgit_model::CancelToken;
use serde::{Deserialize, Serialize};

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::SessionId;
use crate::folder_batch::{run_git_env, run_git_env_cancel};

/// 확인창에서 고정한 로컬 브랜치와 조회 당시 상태.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteLocalTarget {
    pub name: String,
    pub oid: String,
    pub upstream: String,
    pub checked_out: Option<String>,
}

/// 저장소별 삭제 범위. 실행 때 경로·설정·ref를 다시 검사한다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteTarget {
    pub path: PathBuf,
    pub remote: String,
    pub name: String,
    pub remote_oid: Option<String>,
    pub remote_url: String,
    pub locals: Vec<BranchDeleteLocalTarget>,
    pub error: Option<String>,
    pub excluded: bool,
}

/// 단계별 결과. 미병합만 명시적 강제 재시도 대상이다.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchDeletionStatus {
    Deleted,
    AlreadyAbsent,
    Failed,
    Unknown,
    NotRun,
    NotMerged,
    CheckedOut,
    Stale,
}

/// 원격 삭제 단계 결과.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeletionStep {
    pub status: BranchDeletionStatus,
    pub message: String,
}

/// 로컬별 결과와 강제 확인에서 재검증할 OID.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchDeletionResult {
    pub name: String,
    pub oid: String,
    pub status: BranchDeletionStatus,
    pub message: String,
}

/// 원격과 로컬 결과를 별도로 보존한다. 로컬 재시도는 원격을 다시 삭제하지 않는다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeletionResult {
    pub remote: BranchDeletionStep,
    pub locals: Vec<LocalBranchDeletionResult>,
}

impl BranchDeletionResult {
    /// 작업 기록의 요약 성공 여부. 부분 실패는 성공으로 숨기지 않는다.
    pub(crate) fn ok(&self) -> bool {
        use BranchDeletionStatus::*;
        (matches!(self.remote.status, Deleted | AlreadyAbsent)
            || (self.remote.status == NotRun
                && self.remote.message.is_empty()
                && !self.locals.is_empty()))
            && self
                .locals
                .iter()
                .all(|r| matches!(r.status, Deleted | AlreadyAbsent))
    }

    /// 단계와 대상 이름을 포함해 기존 일괄 결과에도 읽을 수 있는 출력을 남긴다.
    pub(crate) fn message(&self) -> String {
        std::iter::once(format!(
            "remote: {:?} {}",
            self.remote.status, self.remote.message
        ))
        .chain(
            self.locals
                .iter()
                .map(|r| format!("{}: {:?} {}", r.name, r.status, r.message)),
        )
        .collect::<Vec<_>>()
        .join("\n")
    }
}

/// 등록된 원격만 허용하고 URL·복수 push URL을 단일 삭제 대상으로 오해하지 않는다.
async fn push_url(inner: &CoreInner, path: &Path, remote: &str) -> Result<String, String> {
    if remote.is_empty() || remote.starts_with('-') || remote.contains(['\0', '\n', '\r']) {
        return Err(pick("잘못된 원격 이름입니다", "Invalid remote name").into());
    }
    let remotes = git(inner, path, &["remote"], false).await?;
    if !remotes.lines().any(|r| r == remote) {
        return Err(pick("등록된 원격이 아닙니다", "Remote is not registered").into());
    }
    let urls = git(
        inner,
        path,
        &["remote", "get-url", "--push", "--all", remote],
        false,
    )
    .await?;
    let lines: Vec<_> = urls.lines().collect();
    if lines.len() != 1 {
        return Err(pick(
            "푸시 URL이 여러 개인 원격 저장소에서는 브랜치를 삭제할 수 없습니다",
            "Multiple push URLs are not supported for branch deletion",
        )
        .into());
    }
    Ok(lines[0].into())
}

/// 전체 ref를 Git 규칙으로 검사해 revision·옵션·와일드카드가 삭제 인자로 들어가지 않게 한다.
async fn check_branch(inner: &CoreInner, path: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') {
        return Err(pick("잘못된 브랜치 이름입니다", "Invalid branch name").into());
    }
    git(
        inner,
        path,
        &["check-ref-format", &format!("refs/heads/{name}")],
        false,
    )
    .await?;
    Ok(())
}

/// 인증과 출력 비밀 가림을 기존 일괄 Git 실행과 공유한다.
async fn git(
    inner: &CoreInner,
    path: &Path,
    args: &[&str],
    network: bool,
) -> Result<String, String> {
    let args: Vec<String> = args.iter().map(|s| (*s).into()).collect();
    let (ok, output) = run_git_env(inner, path, &args, network, &[]).await;
    if ok { Ok(output) } else { Err(output) }
}

/// push URL에서 전체 원격 ref를 정확히 조회한다. 조회 실패를 부재로 바꾸지 않는다.
async fn remote_oid(
    inner: &CoreInner,
    path: &Path,
    url: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let full = format!("refs/heads/{name}");
    let out = git(
        inner,
        path,
        &["ls-remote", "--refs", "--", url, &full],
        true,
    )
    .await?;
    Ok(out
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .find(|(_, r)| *r == full)
        .map(|(oid, _)| oid.into()))
}

/// 로컬 추적 관계는 원격 삭제 전에 고정하며 삭제 후에도 설정된 upstream 전체 이름으로 재검증한다.
async fn local_targets(
    inner: &CoreInner,
    path: &Path,
    remote: &str,
    name: &str,
) -> Result<Vec<BranchDeleteLocalTarget>, String> {
    let out = git(inner, path, &["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(worktreepath)", "refs/heads/"], false).await?;
    let wanted = format!("refs/heads/{name}");
    Ok(out
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\0').collect();
            let [local, oid, upstream, own_remote, remote_ref, worktree] = fields[..] else {
                return None;
            };
            if own_remote != remote || remote_ref != wanted {
                return None;
            }
            Some(BranchDeleteLocalTarget {
                name: local.strip_prefix("refs/heads/")?.into(),
                oid: oid.into(),
                upstream: upstream.into(),
                checked_out: (!worktree.is_empty()).then(|| worktree.into()),
            })
        })
        .collect())
}

/// 사전 조회 실패도 대상별 오류로 보존하여 다른 저장소의 확인창을 열 수 있게 한다.
async fn inspect(inner: &CoreInner, path: PathBuf, remote: &str, name: &str) -> BranchDeleteTarget {
    let mut target = BranchDeleteTarget {
        path,
        remote: remote.into(),
        name: name.into(),
        remote_oid: None,
        remote_url: String::new(),
        locals: Vec::new(),
        error: None,
        excluded: false,
    };
    let result: Result<(), String> = async {
        check_branch(inner, &target.path, name).await?;
        target.remote_url = push_url(inner, &target.path, remote).await?;
        target.locals = local_targets(inner, &target.path, remote, name).await?;
        target.remote_oid = remote_oid(inner, &target.path, &target.remote_url, name).await?;
        Ok(())
    }
    .await;
    target.error = result.err();
    target
}

/// 삭제 후 추적 ref가 남으면 예상 OID와 일치하는 경우에만 제거한다.
async fn prune_tracking(inner: &CoreInner, target: &BranchDeleteTarget) {
    if let Some(oid) = &target.remote_oid {
        let full = format!("refs/remotes/{}/{}", target.remote, target.name);
        let _ = git(
            inner,
            &target.path,
            &["update-ref", "-d", &full, oid],
            false,
        )
        .await;
    }
}

/// 잠금을 이미 잡은 실행 경로에서 호출한다. 원격 실패 시 로컬은 그대로 남긴다.
pub(crate) async fn execute(
    inner: &CoreInner,
    target: &BranchDeleteTarget,
    delete_local: bool,
    force_local_only: bool,
    cancel: &CancelToken,
) -> BranchDeletionResult {
    use BranchDeletionStatus::*;
    let mut result = BranchDeletionResult {
        remote: BranchDeletionStep {
            status: NotRun,
            message: String::new(),
        },
        locals: if delete_local || force_local_only {
            target
                .locals
                .iter()
                .map(|local| LocalBranchDeletionResult {
                    name: local.name.clone(),
                    oid: local.oid.clone(),
                    status: NotRun,
                    message: pick(
                        "원격 삭제가 완료되지 않아 유지했습니다",
                        "Kept because remote deletion did not finish",
                    )
                    .into(),
                })
                .collect()
        } else {
            Vec::new()
        },
    };
    if cancel.is_cancelled() {
        result.remote.message = crate::messages::cancelled().into();
        return result;
    }
    let verified: Result<(), String> = async {
        check_branch(inner, &target.path, &target.name).await?;
        let url = push_url(inner, &target.path, &target.remote).await?;
        if url != target.remote_url {
            return Err(pick(
                "원격 저장소의 푸시 URL이 변경되었습니다. 다시 조회하세요.",
                "Remote push URL changed; inspect again",
            )
            .into());
        }
        if target.error.is_some() {
            return Err(pick(
                "삭제 대상 조회에 실패했습니다. 다시 조회하세요",
                "The deletion preview failed; inspect again",
            )
            .into());
        }
        for local in &target.locals {
            check_branch(inner, &target.path, &local.name).await?;
        }
        Ok(())
    }
    .await;
    if let Err(message) = verified {
        result.remote = BranchDeletionStep {
            status: Stale,
            message,
        };
        return result;
    }
    if !force_local_only {
        let current = match remote_oid(inner, &target.path, &target.remote_url, &target.name).await
        {
            Ok(oid) => oid,
            Err(message) => {
                result.remote = BranchDeletionStep {
                    status: Failed,
                    message,
                };
                return result;
            }
        };
        if current.is_none() {
            result.remote.status = AlreadyAbsent;
        } else if current != target.remote_oid {
            result.remote = BranchDeletionStep {
                status: Stale,
                message: pick(
                    "원격 브랜치가 변경되었습니다. 다시 조회하세요",
                    "Remote branch changed; inspect again",
                )
                .into(),
            };
            return result;
        } else if let Some(oid) = current {
            let full = format!("refs/heads/{}", target.name);
            let lease = format!("--force-with-lease={full}:{oid}");
            let refspec = format!(":{full}");
            let args = [
                "push",
                "--porcelain",
                "--no-follow-tags",
                &lease,
                "--end-of-options",
                &target.remote,
                &refspec,
            ]
            .map(str::to_owned);
            let (ok, message) =
                run_git_env_cancel(inner, &target.path, &args, true, &[], Some(cancel.clone()))
                    .await;
            match if ok { Ok(message) } else { Err(message) } {
                Ok(_) => result.remote.status = Deleted,
                Err(message) => {
                    // 네트워크 실패 뒤 부재가 확인될 때만 성공한 삭제로 취급한다.
                    result.remote =
                        match remote_oid(inner, &target.path, &target.remote_url, &target.name)
                            .await
                        {
                            Ok(None) => BranchDeletionStep {
                                status: Deleted,
                                message: String::new(),
                            },
                            Ok(Some(_)) => BranchDeletionStep {
                                status: Failed,
                                message,
                            },
                            Err(_) => BranchDeletionStep {
                                status: Unknown,
                                message,
                            },
                        };
                    if !matches!(result.remote.status, Deleted) {
                        return result;
                    }
                }
            }
        }
        prune_tracking(inner, target).await;
    }
    if (delete_local || force_local_only) && !cancel.is_cancelled() {
        for (index, local) in target.locals.iter().enumerate() {
            if cancel.is_cancelled() {
                break;
            }
            let (status, message) = delete_local_one(inner, target, local, force_local_only).await;
            result.locals[index].status = status;
            result.locals[index].message = message;
        }
    }
    if cancel.is_cancelled() {
        for local in &mut result.locals {
            if local.status == NotRun {
                local.message = crate::messages::cancelled().into();
            }
        }
    }
    result
}

/// 로컬 OID·추적 관계·모든 워크트리 checkout을 재검사하고 백업 성공 후에만 삭제한다.
async fn delete_local_one(
    inner: &CoreInner,
    target: &BranchDeleteTarget,
    local: &BranchDeleteLocalTarget,
    force: bool,
) -> (BranchDeletionStatus, String) {
    use BranchDeletionStatus::*;
    let live = match local_targets(inner, &target.path, &target.remote, &target.name).await {
        Ok(list) => list,
        Err(message) => return (Failed, message),
    };
    let Some(now) = live.iter().find(|r| r.name == local.name) else {
        return (
            Stale,
            pick(
                "로컬 브랜치 또는 추적 대상이 변경되었습니다",
                "Local branch or upstream changed",
            )
            .into(),
        );
    };
    if now.oid != local.oid || now.upstream != local.upstream {
        return (
            Stale,
            pick(
                "로컬 브랜치가 변경되었습니다. 다시 조회하세요",
                "Local branch changed; inspect again",
            )
            .into(),
        );
    }
    if let Some(path) = &now.checked_out {
        return (CheckedOut, path.clone());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup = format!(
        "refs/mgit/backup/{}/{timestamp}-{:06}",
        local.name,
        crate::safety::BACKUP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    if let Err(message) = git(
        inner,
        &target.path,
        &["update-ref", &backup, &local.oid, ""],
        false,
    )
    .await
    {
        return (Failed, message);
    }
    match git(
        inner,
        &target.path,
        &[
            "branch",
            if force { "-D" } else { "-d" },
            "--end-of-options",
            &local.name,
        ],
        false,
    )
    .await
    {
        Ok(_) => (Deleted, String::new()),
        Err(message) if !force && message.contains("not fully merged") => (NotMerged, message),
        Err(message) => (Failed, message),
    }
}

impl Core {
    /// 단일 저장소 확인창용 원격 및 로컬 스냅샷.
    pub async fn inspect_remote_branch_deletion(
        &self,
        session: SessionId,
        remote: &str,
        name: &str,
    ) -> Result<BranchDeleteTarget, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        Ok(inspect(&inner, s.info.work_tree.clone(), remote, name).await)
    }

    /// 표시 범위와 무관하게 원격 추적 ref를 가진 폴더의 모든 저장소를 조회한다.
    pub async fn inspect_folder_remote_branch_deletion(
        &self,
        session: SessionId,
        remote: &str,
        name: &str,
    ) -> Result<Vec<BranchDeleteTarget>, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let settings = self.folder_settings(session)?;
        let mut targets = Vec::new();
        for group in folder.groups() {
            let path = group.found.path;
            check_branch(&inner, &path, name)
                .await
                .map_err(CoreError::Invalid)?;
            let full = format!("refs/remotes/{remote}/{name}");
            let listed = git(
                &inner,
                &path,
                &["for-each-ref", "--format=%(refname)", &full],
                false,
            )
            .await;
            if listed
                .as_ref()
                .is_ok_and(|out| !out.lines().any(|line| line == full))
            {
                continue;
            }
            let excluded = settings.excludes(&crate::folder::repo_name(&path));
            let mut target = if excluded {
                BranchDeleteTarget {
                    path,
                    remote: remote.into(),
                    name: name.into(),
                    remote_oid: None,
                    remote_url: String::new(),
                    locals: Vec::new(),
                    error: None,
                    excluded: true,
                }
            } else {
                inspect(&inner, path, remote, name).await
            };
            if let Err(error) = listed {
                target.error = Some(error);
            }
            targets.push(target);
        }
        Ok(targets)
    }

    /// 단일 저장소 실행도 폴더와 같은 잠금·검증·결과를 사용한다.
    async fn execute_branch_deletion(
        &self,
        session: SessionId,
        target: &BranchDeleteTarget,
        delete_local: bool,
        force: bool,
    ) -> Result<BranchDeletionResult, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let d = discover(inner.runner(), &target.path).await?;
        if d.common_dir != s.info.common_dir || d.work_tree != s.info.work_tree {
            return Err(CoreError::Invalid(
                pick(
                    "삭제 대상 저장소가 변경되었습니다",
                    "Deletion repository changed",
                )
                .into(),
            ));
        }
        let op = self.begin_operation(
            session,
            "branchDelete",
            pick("브랜치 삭제", "Delete branch"),
        )?;
        let lock = inner.write_lock_for(&d.common_dir);
        let result = {
            let guard = tokio::select! { guard = lock.lock() => Some(guard), () = op.cancel.cancelled() => None };
            let result = execute(&inner, target, delete_local, force, &op.cancel).await;
            drop(guard);
            result
        };
        inner.end_op(
            &s,
            &op,
            result.ok(),
            op.cancel.is_cancelled(),
            &result.message(),
        );
        inner.refresh_after_write(&s).await;
        Ok(result)
    }

    /// 원격이 삭제되거나 이미 없음을 확인한 다음 추적 로컬만 일반 삭제한다.
    pub async fn delete_remote_branch_with_locals(
        &self,
        session: SessionId,
        target: &BranchDeleteTarget,
        delete_local: bool,
    ) -> Result<BranchDeletionResult, CoreError> {
        self.execute_branch_deletion(session, target, delete_local, false)
            .await
    }

    /// 추가 확인을 받은 로컬만 강제 삭제하며 원격 명령은 실행하지 않는다.
    pub async fn force_delete_local_branches(
        &self,
        session: SessionId,
        target: &BranchDeleteTarget,
    ) -> Result<BranchDeletionResult, CoreError> {
        self.execute_branch_deletion(session, target, true, true)
            .await
    }
}
