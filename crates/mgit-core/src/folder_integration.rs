//! 일괄 병합·리베이스의 읽기 사전 확인과 잠금 안 실행을 분리한다.
use crate::{
    Core, CoreError, SessionId,
    core::CoreInner,
    folder::repo_name,
    folder_batch::{FolderSettings, RepoResult, run_git_env_cancel},
    refname::check_ref_name,
};
use mgit_git::cmd::{discover, in_progress_op, list_unmerged, scanned_repo_status};
use mgit_l10n::{pick, tr};
use mgit_model::{CancelToken, EnvProfile, GitRequest, GitRunner, Oid};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BatchMergeMode {
    Default,
    NoFf,
    FfOnly,
    Squash,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationOutcome {
    Clean,
    Conflicts,
    Squashed,
}
/// 확인창이 승인한 저장소·현재 브랜치·양쪽 커밋 스냅샷이다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationTarget {
    pub path: String,
    pub current_branch: String,
    pub head: String,
    pub source_oid: String,
}
/// 실행 불가도 행으로 반환해 확인창에서 제외 이유를 보인다.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPreview {
    pub path: String,
    pub name: String,
    pub current_branch: Option<String>,
    pub head: Option<String>,
    pub source_oid: Option<String>,
    pub reason: Option<String>,
}

/// 브랜치 전체 이름만 받으며 옵션·리비전 식·태그를 허용하지 않는다.
pub(crate) fn validate(reference: &str, targets: &[IntegrationTarget]) -> Result<(), CoreError> {
    check_ref_name(reference)?;
    if !(reference.starts_with("refs/heads/") || reference.starts_with("refs/remotes/")) {
        return Err(CoreError::Invalid(
            pick(
                "브랜치 전체 이름이 필요합니다",
                "A fully qualified branch reference is required",
            )
            .into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for target in targets {
        if !seen.insert(&target.path) {
            return Err(CoreError::Invalid("Duplicate integration target".into()));
        }
        check_ref_name(&target.current_branch)?;
        for oid in [&target.head, &target.source_oid] {
            Oid::from_hex(oid.as_bytes()).map_err(|e| CoreError::Invalid(e.to_string()))?;
        }
    }
    Ok(())
}
/// 사전 확인과 실행 직전이 같은 방식으로 현재 상태를 판정한다.
async fn inspect(
    runner: &dyn GitRunner,
    path: &Path,
    reference: &str,
    settings: &FolderSettings,
) -> Result<IntegrationPreview, CoreError> {
    let d = discover(runner, path).await?;
    let status = scanned_repo_status(runner, &d.work_tree).await?;
    let mut row = IntegrationPreview {
        path: path.to_string_lossy().into_owned(),
        name: repo_name(path),
        current_branch: status.branch.head.clone(),
        head: status.branch.oid.map(|oid| oid.to_hex()),
        source_oid: None,
        reason: None,
    };
    let req = GitRequest::new(
        &d.work_tree,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?;
    if out.exit.success() {
        row.source_oid = Some(out.stdout_lossy().trim().into());
    } else if out.exit.status != Some(1) {
        // 없는 ref(1)와 저장소 읽기 실패를 구분한다. 실패한 확인을 실행 가능으로 다루지 않는다.
        out.ok(&display)?;
    }
    let summary = status.summary();
    row.reason = if settings.excludes(&row.name) {
        Some(pick("제외됨 (폴더 설정)", "Excluded (folder settings)").into())
    } else if row.current_branch.is_none() || row.head.is_none() {
        Some(
            pick(
                "현재 브랜치의 커밋이 필요합니다 (분리된 HEAD 또는 빈 저장소)",
                "A committed current branch is required (detached or unborn HEAD)",
            )
            .into(),
        )
    } else if row.source_oid.is_none() {
        Some(pick("해당 브랜치가 없습니다", "No such branch").into())
    } else if row
        .current_branch
        .as_ref()
        .is_some_and(|b| reference == format!("refs/heads/{b}"))
    {
        Some(
            pick(
                "현재 브랜치와 같은 브랜치입니다",
                "The selected branch is the current branch",
            )
            .into(),
        )
    } else if in_progress_op(runner, &d.git_dir, &d.common_dir, &d.work_tree)
        .await?
        .is_some()
        || summary.conflicted > 0
    {
        Some(
            pick(
                "진행 중인 작업이나 충돌이 있습니다",
                "Operation or conflicts in progress",
            )
            .into(),
        )
    } else if summary.staged + summary.unstaged + summary.untracked > 0 {
        Some(pick("커밋하지 않은 변경이 있습니다", "Uncommitted changes").into())
    } else {
        None
    };
    Ok(row)
}
impl Core {
    /// 선택된 실제 작업 트리마다 현재 브랜치와 비교 기준을 읽는다. 쓰기나 자동 저장은 하지 않는다.
    pub async fn folder_integration_preview(
        &self,
        session: SessionId,
        reference: &str,
        repos: &[PathBuf],
    ) -> Result<Vec<IntegrationPreview>, CoreError> {
        validate(reference, &[])?;
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let settings = self.folder_settings(session)?;
        let mut rows = Vec::new();
        for repo in folder.select(repos)? {
            let path = repo.found.path;
            rows.push(
                match inspect(inner.runner(), &path, reference, &settings).await {
                    Ok(row) => row,
                    Err(error) => IntegrationPreview {
                        name: repo_name(&path),
                        path: path.to_string_lossy().into_owned(),
                        current_branch: None,
                        head: None,
                        source_oid: None,
                        reason: Some(error.to_string()),
                    },
                },
            );
        }
        Ok(rows)
    }
}
/// 호출자가 common_dir 쓰기 잠금을 쥐며, 이 함수는 중복으로 큐를 잠그지 않는다.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute(
    inner: &Arc<CoreInner>,
    path: &Path,
    reference: &str,
    target: &IntegrationTarget,
    mode: Option<BatchMergeMode>,
    settings: &FolderSettings,
    cancel: CancelToken,
    mut result: RepoResult,
) -> RepoResult {
    let row = match inspect(inner.runner(), path, reference, settings).await {
        Ok(row) => row,
        Err(error) => {
            result.message = error.to_string();
            return result;
        }
    };
    if let Some(reason) = row.reason {
        result.skip(&reason);
        return result;
    }
    if row.current_branch.as_deref() != Some(&target.current_branch)
        || row.head.as_deref() != Some(&target.head)
        || row.source_oid.as_deref() != Some(&target.source_oid)
    {
        result.skip(pick(
            "확인 이후 브랜치 또는 커밋이 변경되었습니다. 다시 확인하세요.",
            "Branch or commit changed after confirmation. Preview again.",
        ));
        return result;
    }
    if cancel.is_cancelled() {
        result.cancel();
        return result;
    }
    if mode.is_none() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let seq = crate::safety::BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
        let backup = format!(
            "{}{}{timestamp}-{seq:06}",
            crate::safety::BACKUP_NS,
            format_args!("{}/", target.current_branch)
        );
        let args = vec![
            "update-ref".into(),
            "--create-reflog".into(),
            "-m".into(),
            "mgit backup: rebase".into(),
            backup,
            target.head.clone(),
            "0".repeat(40),
        ];
        let (ok, message) =
            run_git_env_cancel(inner, path, &args, false, &[], Some(cancel.clone())).await;
        if !ok {
            result.message = tr!(
                "리베이스 백업을 만들지 못했습니다: {message}",
                "Could not create rebase backup: {message}"
            );
            return result;
        }
    }
    if cancel.is_cancelled() {
        result.cancel();
        return result;
    }
    let mut args: Vec<String> = match mode {
        Some(_) => vec!["merge".into(), "--no-edit".into(), "--no-autostash".into()],
        None => vec![
            "rebase".into(),
            "--no-autostash".into(),
            "--no-update-refs".into(),
        ],
    };
    match mode {
        Some(BatchMergeMode::NoFf) => args.push("--no-ff".into()),
        Some(BatchMergeMode::FfOnly) => args.push("--ff-only".into()),
        Some(BatchMergeMode::Squash) => args.push("--squash".into()),
        _ => {}
    }
    if matches!(mode, Some(BatchMergeMode::Default | BatchMergeMode::NoFf)) {
        match crate::merge_ops::default_merge_message(
            inner.runner(),
            path,
            reference,
            Some(&target.current_branch),
        )
        .await
        {
            Ok(message) => args.extend(["-m".into(), message]),
            Err(error) => {
                result.message = error.to_string();
                return result;
            }
        }
    }
    args.extend(["--end-of-options".into(), target.source_oid.clone()]);
    let (ok, message) = run_git_env_cancel(
        inner,
        path,
        &args,
        false,
        &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")],
        Some(cancel),
    )
    .await;
    result.ok = ok;
    result.message = message;
    if ok {
        let squashed = if mode == Some(BatchMergeMode::Squash) {
            match scanned_repo_status(inner.runner(), path).await {
                Ok(status) => status.summary().staged > 0,
                Err(error) => {
                    result.ok = false;
                    result.message = tr!(
                        "명령은 완료되었으나 결과 상태를 확인하지 못했습니다: {error}",
                        "Command completed but the resulting status could not be read: {error}"
                    );
                    return result;
                }
            }
        } else {
            false
        };
        result.integration = Some(if squashed {
            result.message = pick(
                "스쿼시 병합을 준비했습니다. 변경 내용을 확인한 뒤 커밋하세요.",
                "Squash merge prepared. Review the changes and commit them.",
            )
            .into();
            IntegrationOutcome::Squashed
        } else {
            IntegrationOutcome::Clean
        });
    } else if let Ok(unmerged) = list_unmerged(inner.runner(), path).await
        && !unmerged.is_empty()
    {
        result.integration = Some(IntegrationOutcome::Conflicts);
    }
    result
}
