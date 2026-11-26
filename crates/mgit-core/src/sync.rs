//! 원격·동기화 (RM-01~05). 네트워크 명령은 `Network` 프로파일 + `--progress` 로 실행하고
//! stderr 의 진행률을 `OperationProgress` 로 흘린다

use std::path::Path;

use mgit_l10n::pick;
use mgit_model::{PullMode, PushSpec, RemoteInfo, matching_remote};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::ops::OpHandle;
use crate::write::WriteSpec;

/// 이름이 옵션으로 오해될 수 없는지
fn check_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_name(name)));
    }
    Ok(())
}

impl Core {
    /// 원격 목록 (상태 스냅샷에서)
    pub fn remotes(&self, session: SessionId) -> Result<Vec<RemoteInfo>, CoreError> {
        Ok(self.inner().get(session)?.state().refs.remotes.clone())
    }

    /// 원격 추가 (RM-01)
    pub async fn remote_add(
        &self,
        session: SessionId,
        name: &str,
        url: &str,
    ) -> Result<(), CoreError> {
        check_name(name)?;
        check_name(url)?;
        self.run_write(
            session,
            WriteSpec::new(["remote", "add", "--end-of-options", name, url]),
        )
        .await?;
        Ok(())
    }

    /// 원격 이름 변경
    pub async fn remote_rename(
        &self,
        session: SessionId,
        old: &str,
        new: &str,
    ) -> Result<(), CoreError> {
        check_name(old)?;
        check_name(new)?;
        self.run_write(
            session,
            WriteSpec::new(["remote", "rename", "--end-of-options", old, new]),
        )
        .await?;
        Ok(())
    }

    /// 원격 제거
    pub async fn remote_remove(&self, session: SessionId, name: &str) -> Result<(), CoreError> {
        check_name(name)?;
        self.run_write(
            session,
            WriteSpec::new(["remote", "remove", "--end-of-options", name]),
        )
        .await?;
        Ok(())
    }

    /// 원격 URL 변경
    pub async fn remote_set_url(
        &self,
        session: SessionId,
        name: &str,
        url: &str,
    ) -> Result<(), CoreError> {
        check_name(name)?;
        check_name(url)?;
        self.run_write(
            session,
            WriteSpec::new(["remote", "set-url", "--end-of-options", name, url]),
        )
        .await?;
        Ok(())
    }

    /// fetch (RM-02). `remote` 가 없으면 `--all`. 진행률은 `op` 로 흘린다
    pub async fn fetch(
        &self,
        session: SessionId,
        remote: Option<&str>,
        prune: bool,
        op: Option<OpHandle>,
    ) -> Result<(), CoreError> {
        let mut args: Vec<String> = vec!["fetch".into(), "--progress".into()];
        if prune {
            args.push("--prune".into());
        }
        match remote {
            Some(r) => {
                check_name(r)?;
                args.push("--end-of-options".into());
                args.push(r.into());
            }
            None => args.push("--all".into()),
        }
        let mut spec = WriteSpec::new(args).network();
        if let Some(op) = op {
            spec = spec.with_op(op).progress();
        }
        let all = remote.is_none();
        self.run_write_tracking_tags(session, spec).await?;
        // 모든 원격을 받았으면 적어 두어 다른 탭의 자동 fetch 가 곧바로 다시 받지 않게 한다 (M5). 원격 하나만 받은 것은
        // 다른 원격을 대신하지 않으므로 적지 않는다
        // 그사이 세션이 닫혔으면 적지 않는다 (fetch 의 성공은 그대로)
        if all && let Ok(s) = self.inner().get(session) {
            self.inner().note_fetched(&s.info.common_dir);
        }
        Ok(())
    }

    /// fetch·pull 을 돌리고, 로컬 tag 집합이 바뀌었으면 원격 tag 캐시를 오래됨으로 둔다 (실패해도 일부 받았을 수 있다)
    pub(crate) async fn run_write_tracking_tags(
        &self,
        session: SessionId,
        spec: WriteSpec,
    ) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        let before = self.inner().tag_marks(&s);
        let res = self.run_write(session, spec).await;
        self.inner().after_fetch(&s, before);
        res.map(|_| ())
    }

    /// pull (RM-03). `Default` 는 플래그 없이 git 설정을 따른다. 충돌은 `CommandFailed{hint: Conflicts}`
    pub async fn pull(
        &self,
        session: SessionId,
        mode: PullMode,
        op: Option<OpHandle>,
    ) -> Result<(), CoreError> {
        let mut args: Vec<String> = vec!["pull".into(), "--progress".into(), "--no-edit".into()];
        match mode {
            PullMode::Default => {}
            PullMode::Merge => args.push("--no-rebase".into()),
            PullMode::Rebase => args.push("--rebase".into()),
            PullMode::FfOnly => args.push("--ff-only".into()),
        }
        let mut spec = WriteSpec::new(args).network();
        if let Some(op) = op {
            spec = spec.with_op(op).progress();
        }
        self.run_write_tracking_tags(session, spec).await
    }

    /// push (RM-04). 원격은 `spec.remote` → 업스트림의 원격 → 기본 원격 순으로 고른다.
    /// 업스트림의 원격으로 보내면 업스트림 브랜치를 갱신하고(`refs/heads/<local>:refs/heads/<upstream>`),
    /// 다른 원격이면 같은 이름으로 보낸다. 업스트림 브랜치 이름이 로컬과 다르면 확인 없이는 git 을
    /// 실행하지 않고 `PushUpstreamMismatch` 를 돌려준다. 원격을 고르지 않았고 업스트림이 없거나
    /// `set_upstream` 이면 `-u`
    pub async fn push(
        &self,
        session: SessionId,
        spec: PushSpec,
        op: Option<OpHandle>,
    ) -> Result<(), CoreError> {
        let target = match self.push_target(session, &spec) {
            Ok(target) => target,
            Err(e) => {
                self.abandon_operation(session, op.as_ref(), &e.to_string());
                return Err(e);
            }
        };
        let mut args: Vec<String> = vec!["push".into(), "--progress".into()];
        if spec.force_with_lease {
            // 자동 fetch 가 추적 ref 를 올려도 본 적 없는 커밋을 덮지 않도록 함께 쓴다
            args.push("--force-with-lease".into());
            args.push("--force-if-includes".into());
        }
        if spec.tags {
            args.push("--follow-tags".into());
        }
        if target.set_upstream {
            args.push("-u".into());
        }
        args.push("--end-of-options".into());
        args.push(target.remote.clone());
        args.push(format!(
            "refs/heads/{}:refs/heads/{}",
            target.branch, target.dst
        ));
        let mut write = WriteSpec::new(args).network();
        if let Some(op) = op {
            write = write.with_op(op).progress();
        }
        self.run_write(session, write).await?;
        self.after_branch_push(session, &target.remote, spec.tags)
            .await;
        if spec.remember_upstream_mismatch && target.branch != target.dst {
            let s = self.inner().get(session)?;
            let key = upstream_ok_key(&s.info.common_dir, &target.branch);
            let value = format!("{}/{}", target.remote, target.dst);
            if let Err(e) = self.store().setting_set(&key, &value) {
                tracing::warn!(error = %e, "push 확인 저장 실패");
            }
        }
        Ok(())
    }

    /// 상태 스냅샷으로 push 대상을 정한다. 묻거나 거부해야 하면 오류
    fn push_target(&self, session: SessionId, spec: &PushSpec) -> Result<PushTarget, CoreError> {
        let s = self.inner().get(session)?;
        let st = s.state();
        let branch = st
            .refs
            .head
            .branch()
            .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
            .ok_or_else(|| {
                CoreError::Invalid(
                    pick(
                        "분리된 HEAD 상태에서는 푸시할 수 없습니다",
                        "Cannot push from a detached HEAD",
                    )
                    .into(),
                )
            })?;
        let upstream_ref = st
            .refs
            .labels
            .iter()
            .find(|l| l.full_name == format!("refs/heads/{branch}"))
            .and_then(|l| l.upstream.clone());
        let remotes: Vec<&str> = st.refs.remotes.iter().map(|r| r.name.as_str()).collect();
        let upstream = upstream_ref
            .as_deref()
            .and_then(|u| split_upstream(u, remotes.iter().copied()));
        let remote = match spec
            .remote
            .clone()
            .or_else(|| upstream.as_ref().map(|(r, _)| r.clone()))
        {
            Some(remote) => remote,
            None => default_remote(&remotes)?,
        };
        check_name(&remote)?;
        // 업스트림의 원격으로 보내면 업스트림 브랜치를, 아니면 같은 이름의 브랜치를 갱신한다
        let dst = match &upstream {
            Some((r, b)) if *r == remote => b.clone(),
            _ => branch.clone(),
        };
        if dst != branch && !spec.confirm_upstream_mismatch {
            let key = upstream_ok_key(&s.info.common_dir, &branch);
            let remembered = self.store().setting_get(&key).ok().flatten();
            if remembered.as_deref() != Some(format!("{remote}/{dst}").as_str()) {
                return Err(CoreError::PushUpstreamMismatch {
                    local: branch,
                    remote,
                    upstream: dst,
                });
            }
        }
        let set_upstream = spec.set_upstream || (spec.remote.is_none() && upstream_ref.is_none());
        Ok(PushTarget {
            branch,
            remote,
            dst,
            set_upstream,
        })
    }
}

/// push 대상
struct PushTarget {
    branch: String,
    remote: String,
    /// 원격 쪽 브랜치 이름
    dst: String,
    set_upstream: bool,
}

/// 원격을 고르지 않았고 업스트림도 없을 때의 대상: 하나뿐이면 그것, 여럿이면 `origin`
fn default_remote(remotes: &[&str]) -> Result<String, CoreError> {
    match remotes {
        [] => Err(CoreError::Invalid(messages::no_remotes().into())),
        [only] => Ok((*only).to_string()),
        many if many.contains(&"origin") => Ok("origin".to_string()),
        _ => Err(CoreError::Invalid(
            pick(
                "원격 저장소가 여러 개입니다. 푸시할 원격 저장소를 선택하세요.",
                "There are multiple remotes, so the push target is ambiguous. Choose a remote",
            )
            .into(),
        )),
    }
}

/// 이름이 다른 업스트림으로의 push 확인을 기억하는 설정 키 (값은 `<원격>/<브랜치>`)
fn upstream_ok_key(common_dir: &Path, branch: &str) -> String {
    format!("push-upstream-ok:{}:{branch}", common_dir.display())
}

/// 업스트림 ref `refs/remotes/<원격>/<브랜치>` 를 (원격, 브랜치) 로 나눈다. 원격 이름에 `/` 가
/// 있을 수 있으므로 등록된 원격 중 가장 긴 접두를 고르고, 맞는 것이 없으면 첫 `/` 에서 나눈다
pub(crate) fn split_upstream<'a>(
    upstream: &str,
    remotes: impl IntoIterator<Item = &'a str>,
) -> Option<(String, String)> {
    let rest = upstream.strip_prefix("refs/remotes/")?;
    if let Some(name) = matching_remote(rest, remotes) {
        let branch = rest.strip_prefix(name)?.strip_prefix('/')?;
        return Some((name.to_string(), branch.to_string()));
    }
    rest.split_once('/')
        .map(|(r, b)| (r.to_string(), b.to_string()))
}

#[cfg(test)]
mod tests {
    use super::split_upstream;

    #[test]
    fn split_upstream_prefers_longest_known_remote() {
        let remotes = ["origin", "team", "team/fork"];
        assert_eq!(
            split_upstream("refs/remotes/origin/main", remotes),
            Some(("origin".into(), "main".into()))
        );
        assert_eq!(
            split_upstream("refs/remotes/origin/feature/login", remotes),
            Some(("origin".into(), "feature/login".into()))
        );
        // 원격 이름에 '/' 가 있으면 등록된 가장 긴 이름을 원격으로 본다
        assert_eq!(
            split_upstream("refs/remotes/team/fork/main", remotes),
            Some(("team/fork".into(), "main".into()))
        );
        assert_eq!(
            split_upstream("refs/remotes/team/main", remotes),
            Some(("team".into(), "main".into()))
        );
    }

    #[test]
    fn split_upstream_falls_back_to_first_slash() {
        assert_eq!(
            split_upstream("refs/remotes/gone/feature/x", ["origin"]),
            Some(("gone".into(), "feature/x".into()))
        );
        assert_eq!(split_upstream("refs/heads/local", ["origin"]), None);
        assert_eq!(split_upstream("refs/remotes/origin", ["origin"]), None);
    }
}
