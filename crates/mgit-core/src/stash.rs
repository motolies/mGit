//! 스태시 (ST-01·03·04). 모든 쓰기는 큐를 지난다

use mgit_git::cmd::{commit_files, commit_meta};
use mgit_model::{ChangedFile, Oid, RecentKind, StashInfo};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::write::WriteSpec;

impl Core {
    /// 스태시 목록 (워크트리 출처 포함: mGit 이 만든 것만 store 에서 찾는다)
    pub fn stashes(
        &self,
        session: SessionId,
    ) -> Result<Vec<(StashInfo, Option<String>)>, CoreError> {
        let s = self.inner().get(session)?;
        let list = s.state().refs.stashes.clone();
        Ok(list
            .into_iter()
            .map(|st| {
                let origin = self
                    .store()
                    .stash_origin_get(&s.info.common_dir, &st.oid)
                    .ok()
                    .flatten()
                    .map(|p| p.display().to_string());
                (st, origin)
            })
            .collect())
    }

    /// 스태시 저장 (ST-01). `paths` 가 비어 있지 않으면 그 경로만 (ST-02 부분 저장)
    pub async fn stash_push(
        &self,
        session: SessionId,
        message: Option<&str>,
        include_untracked: bool,
        staged_only: bool,
        paths: &[String],
    ) -> Result<(), CoreError> {
        let s = self.inner().get(session)?;
        let mut args: Vec<String> = vec!["stash".into(), "push".into()];
        if staged_only {
            // ST-02: stage 된 변경만 (untracked 옵션과 함께 쓰지 않는다)
            args.push("--staged".into());
        } else if include_untracked {
            args.push("-u".into());
        }
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.push("-m".into());
            args.push(m.into());
        }
        if !paths.is_empty() {
            // stash 는 리터럴 env 를 쓰지 못하므로 경로마다 매직으로 글롭을 끈다
            args.push("--".into());
            args.extend(paths.iter().map(|p| format!(":(literal){p}")));
        }
        self.run_write(session, WriteSpec::new(args)).await?;
        // 방금 만든 stash@{0} 의 워크트리를 기록한다
        let top = s.state().refs.stashes.first().map(|st| st.oid);
        if let Some(oid) = top {
            let _ = self
                .store()
                .stash_origin_set(&s.info.common_dir, &oid, &s.info.work_tree);
            let _ = self.store().recent_touch(
                &s.info.work_tree,
                RecentKind::Repo,
                &s.info
                    .work_tree
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
        }
        Ok(())
    }

    /// 스태시 적용 (ST-03). 충돌은 `CommandFailed{hint: Conflicts}`
    pub async fn stash_apply(&self, session: SessionId, index: u32) -> Result<(), CoreError> {
        self.run_write(
            session,
            WriteSpec::new(["stash", "apply", &format!("stash@{{{index}}}")]),
        )
        .await?;
        Ok(())
    }

    /// 스태시 꺼내기 (적용 후 삭제). 충돌이 나면 git 이 스태시를 남긴다
    pub async fn stash_pop(&self, session: SessionId, index: u32) -> Result<(), CoreError> {
        self.run_write(
            session,
            WriteSpec::new(["stash", "pop", &format!("stash@{{{index}}}")]),
        )
        .await?;
        Ok(())
    }

    /// 스태시 삭제
    pub async fn stash_drop(&self, session: SessionId, index: u32) -> Result<(), CoreError> {
        self.run_write(
            session,
            WriteSpec::new(["stash", "drop", &format!("stash@{{{index}}}")]),
        )
        .await?;
        Ok(())
    }

    /// 스태시 내용 (ST-04): 바꾼 파일 목록. untracked 커밋(세 번째 부모)의 파일도 합친다
    pub async fn stash_files(
        &self,
        session: SessionId,
        oid: &Oid,
    ) -> Result<Vec<ChangedFile>, CoreError> {
        let s = self.inner().get(session)?;
        let runner = self.inner().runner();
        let meta = commit_meta(runner, &s.info.work_tree, oid).await?;
        let mut files =
            commit_files(runner, &s.info.work_tree, oid, !meta.parents.is_empty()).await?;
        if let Some(untracked) = meta.parents.get(2) {
            let extra = commit_files(runner, &s.info.work_tree, untracked, false).await?;
            files.extend(extra);
        }
        Ok(files)
    }
}
