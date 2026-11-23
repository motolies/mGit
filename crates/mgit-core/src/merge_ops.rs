//! 병합·이력 수정 (MRG-01~05)과 commit-graph 생성 (AD-03). 모두 쓰기 큐를 지난다

use mgit_l10n::{pick, tr};
use mgit_model::{EnvProfile, GitHint, GitRequest, InProgressOp, Oid};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::write::WriteSpec;

/// merge 방식
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeMode {
    /// git 기본 (fast-forward 가능하면 ff)
    Default,
    NoFf,
    FfOnly,
    Squash,
}

/// reset 방식
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// 병합류 명령의 결과
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpOutcome {
    /// 충돌 없이 끝났다
    Clean,
    /// 충돌이 나서 멈췄다. 상태의 충돌 파일과 진행 중 작업을 보여 준다
    Conflicts,
}

/// ref 이름이 옵션으로 오해될 수 없는지
fn check_ref(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(tr!(
            "잘못된 ref: {name:?}",
            "Invalid ref: {name:?}"
        )));
    }
    Ok(())
}

impl Core {
    /// 충돌 힌트가 붙은 실패를 `Conflicts` 결과로 바꾼다. 다른 실패는 그대로 오류
    pub(crate) fn outcome(
        &self,
        result: Result<crate::write::WriteResult, CoreError>,
    ) -> Result<OpOutcome, CoreError> {
        match result {
            Ok(_) => Ok(OpOutcome::Clean),
            Err(e) if matches!(e.hint(), Some(GitHint::Conflicts)) => Ok(OpOutcome::Conflicts),
            Err(e) => Err(e),
        }
    }

    /// merge (MRG-01). 편집기는 열지 않는다
    pub async fn merge(
        &self,
        session: SessionId,
        reference: &str,
        mode: MergeMode,
    ) -> Result<OpOutcome, CoreError> {
        check_ref(reference)?;
        let mut args: Vec<String> = vec!["merge".into(), "--no-edit".into()];
        match mode {
            MergeMode::Default => {}
            MergeMode::NoFf => args.push("--no-ff".into()),
            MergeMode::FfOnly => args.push("--ff-only".into()),
            MergeMode::Squash => args.push("--squash".into()),
        }
        args.push("--end-of-options".into());
        args.push(reference.into());
        let r = self.run_write(session, WriteSpec::new(args)).await;
        self.outcome(r)
    }

    /// rebase (MRG-02)
    pub async fn rebase(
        &self,
        session: SessionId,
        onto: &str,
        autostash: bool,
    ) -> Result<OpOutcome, CoreError> {
        check_ref(onto)?;
        let mut args: Vec<String> = vec!["rebase".into()];
        if autostash {
            args.push("--autostash".into());
        }
        args.push("--end-of-options".into());
        args.push(onto.into());
        // SF-04: rebase 전 현재 브랜치를 백업한다
        if let Some(b) = self.head_branch_name(session) {
            let _ = self.backup_ref(session, &b, "rebase").await;
        }
        let r = self
            .run_write(
                session,
                WriteSpec::new(args).label(format!("rebase onto {onto}")),
            )
            .await;
        self.outcome(r)
    }

    /// cherry-pick (MRG-03). 여러 커밋은 순서대로 적용된다
    pub async fn cherry_pick(
        &self,
        session: SessionId,
        oids: &[Oid],
    ) -> Result<OpOutcome, CoreError> {
        if oids.is_empty() {
            return Err(CoreError::Invalid(messages::choose_commits().into()));
        }
        let mut args: Vec<String> = vec!["cherry-pick".into(), "--end-of-options".into()];
        args.extend(oids.iter().map(Oid::to_hex));
        let r = self.run_write(session, WriteSpec::new(args)).await;
        self.outcome(r)
    }

    /// revert (MRG-03)
    pub async fn revert(&self, session: SessionId, oids: &[Oid]) -> Result<OpOutcome, CoreError> {
        if oids.is_empty() {
            return Err(CoreError::Invalid(messages::choose_commits().into()));
        }
        let mut args: Vec<String> = vec![
            "revert".into(),
            "--no-edit".into(),
            "--end-of-options".into(),
        ];
        args.extend(oids.iter().map(Oid::to_hex));
        let r = self.run_write(session, WriteSpec::new(args)).await;
        self.outcome(r)
    }

    /// reset (MRG-04). hard 는 호출자가 확인을 받은 뒤 부른다 (SF-02)
    pub async fn reset(
        &self,
        session: SessionId,
        target: &str,
        mode: ResetMode,
    ) -> Result<(), CoreError> {
        check_ref(target)?;
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        if mode != ResetMode::Soft
            && let Some(b) = self.head_branch_name(session)
        {
            let _ = self.backup_ref(session, &b, "reset").await;
        }
        self.run_write(
            session,
            WriteSpec::new(["reset", flag, "--end-of-options", target])
                .label(format!("reset {flag} {target}")),
        )
        .await?;
        Ok(())
    }

    /// 진행 중 작업을 계속한다 (MRG-05). 충돌 파일이 남았으면 거부하고, 마커가 있으면
    /// `allow_conflict_markers` 가 아닌 한 거부한다 (CF-24)
    pub async fn op_continue(
        &self,
        session: SessionId,
        allow_conflict_markers: bool,
    ) -> Result<OpOutcome, CoreError> {
        let op = self.current_op(session)?;
        let s = self.inner().get(session)?;
        if s.state().status.summary().conflicted > 0 {
            return Err(CoreError::Invalid(
                pick(
                    "해결하지 않은 충돌 파일이 남아 있습니다",
                    "Unresolved conflict files remain",
                )
                .into(),
            ));
        }
        if !allow_conflict_markers {
            let markers = self.verify_staged(session).await?;
            if !markers.is_empty() {
                let mut files: Vec<String> = markers.into_iter().map(|m| m.path).collect();
                files.dedup();
                return Err(CoreError::ConflictMarkers { files });
            }
        }
        let args: &[&str] = match op {
            InProgressOp::Merge { .. } => &["merge", "--continue"],
            InProgressOp::Rebase { .. } => &["rebase", "--continue"],
            InProgressOp::CherryPick { .. } => &["cherry-pick", "--continue"],
            InProgressOp::Revert { .. } => &["revert", "--continue"],
            InProgressOp::Am => &["am", "--continue"],
            InProgressOp::Bisect => {
                return Err(CoreError::Invalid(
                    pick("bisect 는 계속할 수 없습니다", "bisect cannot be continued").into(),
                ));
            }
        };
        let r = self
            .run_write(session, WriteSpec::new(args.iter().copied()))
            .await;
        self.outcome(r)
    }

    /// 현재 커밋을 건너뛴다 (rebase·cherry-pick·revert)
    pub async fn op_skip(&self, session: SessionId) -> Result<OpOutcome, CoreError> {
        let op = self.current_op(session)?;
        let args: &[&str] = match op {
            InProgressOp::Rebase { .. } => &["rebase", "--skip"],
            InProgressOp::CherryPick { .. } => &["cherry-pick", "--skip"],
            InProgressOp::Revert { .. } => &["revert", "--skip"],
            InProgressOp::Am => &["am", "--skip"],
            _ => {
                return Err(CoreError::Invalid(
                    pick(
                        "건너뛸 수 없는 작업입니다",
                        "This operation cannot be skipped",
                    )
                    .into(),
                ));
            }
        };
        let r = self
            .run_write(session, WriteSpec::new(args.iter().copied()))
            .await;
        self.outcome(r)
    }

    /// 진행 중 작업을 중단한다
    pub async fn op_abort(&self, session: SessionId) -> Result<(), CoreError> {
        let op = self.current_op(session)?;
        let args: &[&str] = match op {
            InProgressOp::Merge { .. } => &["merge", "--abort"],
            InProgressOp::Rebase { .. } => &["rebase", "--abort"],
            InProgressOp::CherryPick { .. } => &["cherry-pick", "--abort"],
            InProgressOp::Revert { .. } => &["revert", "--abort"],
            InProgressOp::Am => &["am", "--abort"],
            InProgressOp::Bisect => &["bisect", "reset"],
        };
        self.run_write(session, WriteSpec::new(args.iter().copied()))
            .await?;
        Ok(())
    }

    /// commit-graph 를 만든다 (AD-03). 부분 클론이면 `--changed-paths` 를 뺀다
    pub async fn commit_graph_write(&self, session: SessionId) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        let probe = self
            .inner()
            .runner()
            .run(
                GitRequest::new(
                    &s.info.work_tree,
                    ["config", "--get-regexp", r"^remote\..*\.promisor$"],
                )
                .with_env(EnvProfile::ReadInteractive),
            )
            .await?;
        let promisor = probe.exit.success() && probe.stdout_lossy().contains("true");
        let mut args: Vec<&str> = vec!["commit-graph", "write", "--reachable"];
        if !promisor {
            args.push("--changed-paths");
        }
        self.run_write(session, WriteSpec::new(args)).await?;
        Ok(())
    }

    /// 진행 중 작업. 없으면 오류
    fn current_op(&self, session: SessionId) -> Result<InProgressOp, CoreError> {
        let s = self.inner().get(session)?;
        let op = s.state().op.clone();
        op.ok_or_else(|| {
            CoreError::Invalid(pick("진행 중인 작업이 없습니다", "No operation in progress").into())
        })
    }
}
