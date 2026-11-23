//! 커밋 서명 (CHG-08): 설정 읽기와 검증. 서명 자체는 `commit -S`·`tag -s` 가 한다

use mgit_git::cmd::{commit_signature, config_get, config_get_bool};
use mgit_model::{Oid, SignatureStatus, SigningInfo};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;

impl Core {
    /// 서명 설정 (`gpg.format`·`user.signingKey`·`commit.gpgSign`·`tag.gpgSign`)
    pub async fn signing_info(&self, session: SessionId) -> Result<SigningInfo, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let wt = &s.info.work_tree;
        let runner = inner.runner();
        Ok(SigningInfo {
            format: config_get(runner, wt, "gpg.format")
                .await
                .unwrap_or_else(|| "openpgp".into()),
            signing_key: config_get(runner, wt, "user.signingKey").await,
            commit_sign: config_get_bool(runner, wt, "commit.gpgSign")
                .await
                .unwrap_or(false),
            tag_sign: config_get_bool(runner, wt, "tag.gpgSign")
                .await
                .unwrap_or(false),
        })
    }

    /// 커밋 서명 검증 (`%G?`)
    pub async fn commit_signature(
        &self,
        session: SessionId,
        oid: &Oid,
    ) -> Result<SignatureStatus, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        Ok(commit_signature(inner.runner(), &s.info.work_tree, &oid.to_hex()).await?)
    }
}
