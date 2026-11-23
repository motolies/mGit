//! 폴더 커밋 상세·diff·포함 브랜치 (CD-05, CD-03, FS-11). 폴더 세션 id + 저장소 경로로 읽고 저장소 세션을 만들지 않는다
//! (세션을 열면 그래프 전체 로드·작업 트리 감시·자동 fetch 가 따라온다).
//!
//! git 은 저장소 세션의 상세·diff 와 같은 함수(`commit_detail_at`·`commit_file_diff_at`)로 돌리므로
//! 메타데이터·파일 목록·diff 와 오류는 두 길에서 같다. 다른 것은 그래프에 묶인 필드(행·자식·라벨)의
//! 출처뿐이다 — 여기서는 통합 타임라인에서 채운다 (`TimelineState::place_of`).
//!
//! 저장소 경로는 이 폴더의 저장소 목록과 맞을 때만 받는다(`FolderSession::group_of`, git 을 돌리기 전).
//! 워크트리 경로는 원 저장소(묶음의 대표)로 읽으므로 원 저장소 경로로 물은 것과 결과가 같다

use std::path::Path;

use mgit_model::{DiffOptions, FileDiff, Oid};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::inspect::{CONTAINING_TIMEOUT, CommitDetail, ContainingRefs};

impl Core {
    /// 폴더 저장소의 커밋 상세 (CD-05). `oid`·`parents`·작성자·커미터·`message`·`files` 는 저장소 세션의
    /// `commit_detail` 과 같고, `row`·`children`·`refs` 는 통합 타임라인 기준이다:
    /// 타임라인에 그 저장소가 없으면(아직 열지 않았거나 첫 로드 중) 셋 다 비고 — ref 를 따로 읽지 않는다 —
    /// 지금 질의(브랜치 필터 등)에 그 커밋이 없으면 행·자식만 빈다.
    /// 이 폴더의 저장소가 아닌 경로는 `CoreError::Invalid`, 그 저장소에 없는 커밋은 `CoreError::Git`
    pub async fn folder_commit_detail(
        &self,
        session: SessionId,
        repo: &Path,
        oid: &Oid,
    ) -> Result<CommitDetail, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let primary = folder.group_of(repo)?;
        let detail = self.commit_detail_at(&primary.found.path, oid).await?;
        // git 을 돈 뒤 그 시점의 타임라인에서 복사해 온다 (잠금을 쥔 채 await 하지 않는다)
        Ok(detail.placed(folder.timeline.place_of(&primary.found.path, oid)))
    }

    /// 폴더 저장소의 커밋 하나에서 파일 하나의 diff (CD-05). 결과·오류와 경로 처리(`path`·`old_path`
    /// 모두 글자 그대로, 머지는 첫 부모 기준, `old_path` 를 주면 rename 으로 짝지음)는 저장소 세션의
    /// `commit_file_diff_opts` 와 같다. 변경이 없으면 `None`
    #[allow(clippy::too_many_arguments)]
    pub async fn folder_commit_file_diff(
        &self,
        session: SessionId,
        repo: &Path,
        oid: &Oid,
        path: &str,
        old_path: Option<&str>,
        full: bool,
        opts: DiffOptions,
    ) -> Result<Option<FileDiff>, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let primary = folder.group_of(repo)?;
        self.commit_file_diff_at(&primary.found.path, oid, path, old_path, full, opts)
            .await
    }

    /// 폴더 저장소의 커밋을 포함하는 브랜치와 HEAD 포함 여부 (CD-03). 결과·오류·시간 상한은 저장소 세션의
    /// `commit_containing_refs` 와 같다. 워크트리 경로는 원 저장소로 읽으므로 HEAD 도 원 저장소의 HEAD 다.
    /// 같은 폴더의 다음 요청이 오면(저장소가 달라도) 이 요청의 git 을 끝내고 `CoreError::Cancelled` 다
    pub async fn folder_commit_containing_refs(
        &self,
        session: SessionId,
        repo: &Path,
        oid: &Oid,
    ) -> Result<ContainingRefs, CoreError> {
        let folder = self.inner_arc().folders_get(session)?;
        let primary = folder.group_of(repo)?;
        self.containing_refs_at(session, &primary.found.path, oid, CONTAINING_TIMEOUT)
            .await
    }
}
