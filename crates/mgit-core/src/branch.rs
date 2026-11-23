//! 브랜치·태그 작업 (BR-02~06). 모두 쓰기 큐를 지난다

use mgit_l10n::pick;
use mgit_model::{EnvProfile, GitHint, GitRequest, Oid, RefKind};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::write::WriteSpec;

/// checkout 대상
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckoutTarget {
    /// 로컬 브랜치
    Branch(String),
    /// 원격 브랜치: 추적 브랜치를 만들며 체크아웃. 로컬 이름은 `local` 이 없으면 `name`.
    /// 그 로컬 브랜치가 이미 `remote/name` 을 추적하면 전환만 하고, 다른 곳을 추적하거나
    /// 업스트림이 없으면 `CoreError::LocalBranchTracksOther` 로 거부한다. `local` 이 없고
    /// 다른 이름의 로컬 브랜치가 `remote/name` 을 추적하면 그 브랜치로 전환한다
    RemoteBranch {
        remote: String,
        name: String,
        local: Option<String>,
    },
    /// 커밋 (detached)
    Commit(Oid),
    /// 새 브랜치를 만들며 체크아웃. `start` 가 없으면 HEAD
    NewBranch { name: String, start: Option<String> },
}

/// ref 이름이 옵션으로 오해될 수 없는지
fn check_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_name(name)));
    }
    Ok(())
}

impl Core {
    /// 체크아웃한다 (BR-02). `stash_first` 면 로컬 변경을 stash 하고 전환한 뒤 다시 적용한다 (BR-03).
    /// 실패 시 `CommandFailed.hint` 로 더티 작업 트리·다른 워크트리 체크아웃을 구분할 수 있다
    pub async fn checkout(
        &self,
        session: SessionId,
        target: CheckoutTarget,
        stash_first: bool,
    ) -> Result<(), CoreError> {
        let mut args: Vec<String> = vec!["switch".into()];
        match &target {
            CheckoutTarget::Branch(name) => {
                check_name(name)?;
                args.push("--end-of-options".into());
                args.push(name.clone());
            }
            CheckoutTarget::RemoteBranch {
                remote,
                name,
                local,
            } => {
                check_name(remote)?;
                check_name(name)?;
                let local_name = local.as_deref().unwrap_or(name);
                check_name(local_name)?;
                let wanted = format!("refs/remotes/{remote}/{name}");
                let s = self.inner().get(session)?;
                let (existing, tracking) = {
                    let st = s.state();
                    let labels = &st.refs.labels;
                    let existing = labels
                        .iter()
                        .find(|l| l.full_name == format!("refs/heads/{local_name}"))
                        .map(|l| l.upstream.clone());
                    // 로컬 이름을 정하지 않았으면 이미 이 원격 브랜치를 추적하는 브랜치로 간다
                    let tracking = local
                        .is_none()
                        .then(|| {
                            labels.iter().find(|l| {
                                matches!(l.kind, RefKind::LocalBranch)
                                    && l.upstream.as_deref() == Some(wanted.as_str())
                            })
                        })
                        .flatten()
                        .map(|l| l.short_name.clone());
                    (existing, tracking)
                };
                match (existing, tracking) {
                    (Some(upstream), _) if upstream.as_deref() == Some(wanted.as_str()) => {
                        args.push("--end-of-options".into());
                        args.push(local_name.to_string());
                    }
                    (_, Some(other)) => {
                        args.push("--end-of-options".into());
                        args.push(other);
                    }
                    // 전체 ref 로 가리켜 `origin/x` 라는 로컬 브랜치가 있어도 모호하지 않게 한다
                    (None, None) => {
                        args.push("--track".into());
                        args.push("-c".into());
                        args.push(local_name.to_string());
                        args.push("--end-of-options".into());
                        args.push(wanted);
                    }
                    // 같은 이름의 로컬이 다른 원격을 추적하거나 업스트림이 없다. 어느 것을
                    // 원하는지 알 수 없으므로 git 을 실행하지 않고 호출자에게 묻는다
                    (Some(upstream), None) => {
                        return Err(CoreError::LocalBranchTracksOther {
                            local: local_name.to_string(),
                            remote: remote.clone(),
                            name: name.clone(),
                            upstream,
                        });
                    }
                }
            }
            CheckoutTarget::Commit(oid) => {
                args.push("--detach".into());
                args.push("--end-of-options".into());
                args.push(oid.to_hex());
            }
            CheckoutTarget::NewBranch { name, start } => {
                check_name(name)?;
                args.push("-c".into());
                args.push(name.clone());
                if let Some(start) = start {
                    check_name(start)?;
                    args.push("--end-of-options".into());
                    args.push(start.clone());
                }
            }
        }
        if stash_first {
            let before = self.stash_top(session).await?;
            self.run_write(
                session,
                WriteSpec::new([
                    "stash",
                    "push",
                    "-u",
                    "-m",
                    pick("mGit: 브랜치 전환", "mGit: switch branch"),
                ])
                .skip_refresh(),
            )
            .await?;
            // 치울 변경이 없으면 stash 가 만들어지지 않는다. 이때 pop 하면 예전 stash 를 꺼내게 된다
            let stashed = self.stash_top(session).await? != before;
            if !stashed {
                self.run_write(session, WriteSpec::new(args)).await?;
                return Ok(());
            }
            let switched = self
                .run_write(session, WriteSpec::new(args).skip_refresh())
                .await;
            // 전환 성공 여부와 관계없이 stash 를 되돌린다 (실패 시 변경은 stash 에 남는다)
            let popped = self
                .run_write(session, WriteSpec::new(["stash", "pop"]))
                .await;
            switched?;
            popped?;
            return Ok(());
        }
        self.run_write(session, WriteSpec::new(args)).await?;
        Ok(())
    }

    /// 지금 맨 위 stash 의 oid. 없으면 `None`
    async fn stash_top(&self, session: SessionId) -> Result<Option<String>, CoreError> {
        let s = self.inner().get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            ["rev-parse", "-q", "--verify", "refs/stash"],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = self.inner().runner().run(req).await?;
        Ok(out
            .exit
            .success()
            .then(|| out.stdout_lossy().trim().to_string()))
    }

    /// 브랜치를 만든다. `checkout` 이면 바로 전환한다
    pub async fn create_branch(
        &self,
        session: SessionId,
        name: &str,
        start: Option<&str>,
        checkout: bool,
    ) -> Result<(), CoreError> {
        check_name(name)?;
        if checkout {
            return self
                .checkout(
                    session,
                    CheckoutTarget::NewBranch {
                        name: name.to_string(),
                        start: start.map(str::to_string),
                    },
                    false,
                )
                .await;
        }
        let mut args: Vec<String> = vec!["branch".into(), "--end-of-options".into(), name.into()];
        if let Some(start) = start {
            check_name(start)?;
            args.push(start.into());
        }
        self.run_write(session, WriteSpec::new(args)).await?;
        Ok(())
    }

    /// 브랜치 이름을 바꾼다 (BR-04)
    pub async fn rename_branch(
        &self,
        session: SessionId,
        old: &str,
        new: &str,
    ) -> Result<(), CoreError> {
        check_name(old)?;
        check_name(new)?;
        self.run_write(
            session,
            WriteSpec::new(["branch", "-m", "--end-of-options", old, new]),
        )
        .await?;
        Ok(())
    }

    /// 로컬 브랜치를 지운다. 병합되지 않은 브랜치는 `force` 가 아니면 `NotFullyMerged` 힌트로 거부된다 (BR-04)
    pub async fn delete_branch(
        &self,
        session: SessionId,
        name: &str,
        force: bool,
    ) -> Result<(), CoreError> {
        check_name(name)?;
        let flag = if force { "-D" } else { "-d" };
        // SF-04: 지우기 전 백업 ref
        let _ = self.backup_ref(session, name, "branch delete").await;
        self.run_write(
            session,
            WriteSpec::new(["branch", flag, "--end-of-options", name])
                .label(format!("branch {flag} {name}")),
        )
        .await?;
        Ok(())
    }

    /// 원격 브랜치를 지운다 (`git push <remote> --delete <name>`)
    pub async fn delete_remote_branch(
        &self,
        session: SessionId,
        remote: &str,
        name: &str,
    ) -> Result<(), CoreError> {
        check_name(remote)?;
        check_name(name)?;
        self.run_write(
            session,
            WriteSpec::new([
                "push",
                "--delete",
                "--end-of-options",
                remote,
                // 짧은 이름이면 원격의 같은 이름 태그가 지워질 수 있다
                &format!("refs/heads/{name}"),
            ])
            .network(),
        )
        .await?;
        Ok(())
    }

    /// 업스트림을 지정(`Some`)하거나 해제(`None`)한다 (BR-05)
    pub async fn set_upstream(
        &self,
        session: SessionId,
        branch: &str,
        upstream: Option<&str>,
    ) -> Result<(), CoreError> {
        check_name(branch)?;
        let args: Vec<String> = match upstream {
            Some(up) => {
                check_name(up)?;
                vec![
                    "branch".into(),
                    format!("--set-upstream-to={up}"),
                    "--end-of-options".into(),
                    branch.into(),
                ]
            }
            None => vec![
                "branch".into(),
                "--unset-upstream".into(),
                "--end-of-options".into(),
                branch.into(),
            ],
        };
        self.run_write(session, WriteSpec::new(args)).await?;
        Ok(())
    }

    /// 태그를 만든다. `message` 가 있으면 annotated (BR-06)
    pub async fn create_tag(
        &self,
        session: SessionId,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
        sign: bool,
    ) -> Result<(), CoreError> {
        check_name(name)?;
        let mut args: Vec<String> = vec!["tag".into()];
        let mut spec_stdin = None;
        // 서명 태그(-s)는 메시지가 필요하다. 없으면 이름을 쓴다 (CHG-08)
        let msg = message.or(if sign { Some(name) } else { None });
        if let Some(msg) = msg {
            args.push(if sign { "-s".into() } else { "-a".into() });
            args.push("-F".into());
            args.push("-".into());
            spec_stdin = Some(msg.as_bytes().to_vec());
        }
        args.push("--end-of-options".into());
        args.push(name.into());
        if let Some(target) = target {
            check_name(target)?;
            args.push(target.into());
        }
        let mut spec = WriteSpec::new(args);
        if let Some(stdin) = spec_stdin {
            spec = spec.with_stdin(stdin);
        }
        self.run_write(session, spec).await?;
        Ok(())
    }

    /// 태그를 지운다
    pub async fn delete_tag(&self, session: SessionId, name: &str) -> Result<(), CoreError> {
        check_name(name)?;
        self.run_write(
            session,
            WriteSpec::new(["tag", "-d", "--end-of-options", name]),
        )
        .await?;
        Ok(())
    }
}

/// 삭제 거부가 "병합되지 않음" 때문인지
pub fn is_not_fully_merged(err: &CoreError) -> bool {
    matches!(err.hint(), Some(GitHint::NotFullyMerged))
}
