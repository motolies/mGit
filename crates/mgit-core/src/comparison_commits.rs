//! 양쪽 이력 차이를 제한된 목록으로 조회한다.
use crate::{Core, CoreError, SessionId};
use mgit_model::{GitRequest, Oid};

impl Core {
    /// include에만 있고 exclude에는 없는 커밋을 반환하며 상한 초과를 명시한다.
    pub async fn comparison_commits(
        &self,
        session: SessionId,
        include: &str,
        exclude: &str,
    ) -> Result<(Vec<(String, String, String)>, bool), CoreError> {
        // 확정된 커밋 해시만 받아 조회 도중 브랜치 이동과 옵션 주입을 막는다.
        let include =
            Oid::from_hex(include.as_bytes()).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let exclude =
            Oid::from_hex(exclude.as_bytes()).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let s = self.inner().get(session)?;
        let range = format!("{}..{}", exclude.to_hex(), include.to_hex());
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "log",
                "--no-color",
                "--no-show-signature",
                "--encoding=UTF-8",
                "-z",
                "--format=%H%x00%s%x00%aN",
                "-201",
                &range,
                "--",
            ],
        );
        let display = req.display_args();
        let bytes = self.inner().runner().run(req).await?.ok(&display)?;
        let fields: Vec<_> = bytes.split(|b| *b == 0).collect();
        let mut rows: Vec<_> = fields
            .chunks_exact(3)
            .filter(|c| !c[0].is_empty())
            .map(|c| {
                (
                    String::from_utf8_lossy(c[0]).into_owned(),
                    String::from_utf8_lossy(c[1]).into_owned(),
                    String::from_utf8_lossy(c[2]).into_owned(),
                )
            })
            .collect();
        let truncated = rows.len() > 200;
        rows.truncate(200);
        Ok((rows, truncated))
    }
}
