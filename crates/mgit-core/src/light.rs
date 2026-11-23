//! 폴더 화면의 가벼운 저장소 세션 (계획 5.1절 "읽기와 쓰기를 다른 길로", 결정 11·13번, FS-11·12).
//!
//! 폴더 화면의 읽기(로그·상세·diff·파일 트리)는 폴더 세션 id + 저장소 경로로 돌고 세션을 만들지 않는다.
//! 쓰기와 상태가 있는 기능(작업 트리 diff, stage, commit, 충돌 편집, 히스토리·blame)은 기존 저장소 세션
//! API 를 그대로 쓰기 위해, 필요한 순간에 그 저장소의 `Light` 세션을 연다. `Light` 는 커밋 그래프를 읽지
//! 않고 자동 fetch 를 돌리지 않으며 status 는 fsmonitor 를 끄고 돈다. 감시·쓰기 큐·상태 이벤트는 같다.
//!
//! 수명 규칙 (`session::Life`):
//! - 폴더가 열면 그 폴더가 잡는다(`holders`). 같은 작업 트리의 세션이 있으면 새로 만들지 않는다 — 가벼운
//!   세션이면 잡은 폴더에 더하고, 탭(`Full`)의 세션이면 잡지 않고 빌려 준다.
//! - 한 폴더가 잡은 가벼운 세션은 `LIGHT_SESSIONS_PER_FOLDER` 개까지. 넘으면 `LightSessionLimit`.
//! - `open_repo`(탭)로 같은 작업 트리를 열면 같은 id 로 `Full` 이 되고 잡음은 모두 사라진다.
//! - 폴더는 `folder_release_repo_session` 으로 잡음을 푼다. 마지막 잡음이 풀린 `Light` 세션은 닫힌다.
//!   `close_folder` 는 그 폴더의 잡음을 모두 푼다. 탭은 기존 `close_repo` 로 닫는다(프로필 무관)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::cmd::{Discovered, discover};
use mgit_model::{GitError, GitRunner};
use serde::Serialize;

use crate::config::LIGHT_SESSIONS_PER_FOLDER;
use crate::core::{Core, OpenAs, OpenedRepo};
use crate::error::CoreError;
use crate::events::{EventSink, SessionId};
use crate::folder::FolderSession;
use crate::messages;
use crate::session::{Life, RepoSession, SessionProfile};

/// `folder_release_repo_session` 결과. 이미 닫혔거나 그 폴더가 잡고 있지 않아도 오류가 아니라 이 모양이다
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSessionRelease {
    /// 이 호출로 그 폴더의 잡음이 풀렸는지 (잡고 있지 않았거나, 승격됐거나, 이미 닫혔으면 거짓)
    pub released: bool,
    /// 세션이 아직 열려 있으면 그 프로필. 닫혔으면(이 호출로든 그 전에든) `None`
    pub profile: Option<SessionProfile>,
}

/// 두 경로가 같은 디렉터리인지 (정규화 뒤 비교)
fn same_dir(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

/// 폴더 화면이 쓰기·상태 기능을 돌릴 저장소의 경로를 정한다 (FS-11, git 을 돌리기 전). 이 폴더의 저장소
/// 목록에 있는 경로만 받고(폴더 밖·폴더 자신·저장소 안의 하위 폴더·없는 경로는 거부), 워크트리는 원 저장소가
/// 아니라 **그 워크트리 자신**의 경로다 — status·index 는 작업 트리마다 다르다 (폴더 읽기 API 의 `group_of` 와 다르다).
/// 가벼운 세션 열기와 폴더 stage·unstage 가 함께 쓴다
pub(crate) fn folder_member(folder: &FolderSession, repo: &Path) -> Result<PathBuf, CoreError> {
    let entry = folder
        .select(&[repo.to_path_buf()])?
        .pop()
        .ok_or_else(|| CoreError::Invalid(messages::not_folder_repo(repo)))?;
    Ok(entry.found.path)
}

/// 목록의 저장소 경로를 판별하고, 그 경로가 여전히 작업 트리 최상위인지 확인한다. 목록에 있던 경로가 더는
/// 저장소 최상위가 아니면(`.git` 이 지워져 상위 저장소가 잡히는 등) 엉뚱한 저장소에 쓰지 않게 `NotARepository`
/// 다. 그 경로에 `.git` 이 아예 없으면 git 을 돌리지 않고 거부한다 (빈 `.git` 디렉터리처럼 있어도 저장소가 아닌
/// 경우는 판별 뒤의 비교가 막는다). `folder_member` 뒤에 부른다
pub(crate) async fn discover_member(
    runner: &dyn GitRunner,
    path: &Path,
) -> Result<Discovered, CoreError> {
    if !path.join(".git").exists() {
        return Err(GitError::NotARepository(path.to_path_buf()).into());
    }
    let found = discover(runner, path).await?;
    if !same_dir(path, &found.work_tree) {
        return Err(GitError::NotARepository(path.to_path_buf()).into());
    }
    Ok(found)
}

impl Core {
    /// 폴더 저장소의 가벼운 세션을 연다 (계획 5.1절). `repo` 는 이 폴더의 저장소 목록에 있는 경로여야
    /// 하고(FS-11, git 을 돌리기 전에 확인), 워크트리는 원 저장소가 아니라 **그 워크트리 자신**의 작업
    /// 트리로 연다 (status·stage·commit 은 작업 트리마다 다르다 — 폴더 읽기 API 가 원 저장소로 읽는 것과 다르다).
    ///
    /// 그 작업 트리의 세션이 이미 있으면 새로 만들지 않고 그것을 돌려준다(`already_open`). 가벼운 세션이면
    /// 이 폴더도 잡고(`profile = Light`), 탭의 세션이면 잡지 않고 빌려 준다(`profile = Full`, 상한에 세지 않음).
    /// 이 폴더가 이미 상한만큼 잡고 있으면 열지 않고 `LightSessionLimit` 이다. 목록에 있던 경로가 더는 저장소
    /// 최상위가 아니면(지워져 상위 저장소가 잡히는 등) 엉뚱한 저장소에 쓰지 않게 `NotARepository` 다.
    /// 세션 이벤트는 `sink` 로 간다 (이미 있던 세션이면 처음 연 쪽의 sink 가 그대로다)
    pub async fn folder_open_repo_session(
        &self,
        folder: SessionId,
        repo: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<OpenedRepo, CoreError> {
        let inner = self.inner_arc();
        let f = inner.folders_get(folder)?;
        let path = folder_member(&f, repo)?;
        // 같은 폴더의 열기는 줄을 세워 상한 검사와 잡기가 엇갈리지 않게 한다 (다른 폴더는 막지 않는다)
        let _serial = f.light_open.lock().await;
        // git 을 돌리기 전에 상한을 미리 본다. 이미 이 폴더가 잡았거나 탭의 세션이면 세지 않는다
        let reusable = self
            .find_by_work_tree(&path)
            .is_some_and(|s| match &*s.life() {
                Life::Full => true,
                Life::Light { holders } => holders.contains(&folder),
                Life::Closed => false,
            });
        if !reusable {
            self.check_light_limit(folder, None)?;
        }
        let found = discover_member(inner.runner(), &path).await?;
        let opened = self
            .open_session(found, sink, OpenAs::Light { folder })
            .await?;
        // 여는 동안 폴더가 닫혔으면 `close_folder` 가 이 잡음을 못 봤을 수 있다. 풀고 거부한다
        if inner.folders_get(folder).is_err() {
            self.folder_release_repo_session(folder, opened.session);
            return Err(CoreError::SessionNotFound(folder));
        }
        Ok(opened)
    }

    /// 폴더가 가벼운 세션의 잡음을 푼다. 아직 `Light` 이고 잡은 폴더가 더 없으면 세션을 닫는다(`close_repo` 와
    /// 같은 정리: 등록된 장시간 명령 취소, 감시·로드 중단). 다른 폴더가 잡고 있으면 열어 둔다. 승격된(`Full`)
    /// 세션·잡지 않은 세션·이미 닫힌 세션·모르는 id 는 아무것도 하지 않는다 — 오류 없이 같은 모양으로 답한다.
    /// 폴더 세션이 이미 닫혔어도 된다 (`close_folder` 가 잡음을 먼저 풀었으면 할 일이 없다)
    pub fn folder_release_repo_session(
        &self,
        folder: SessionId,
        session: SessionId,
    ) -> RepoSessionRelease {
        match self.inner().get(session) {
            Ok(s) => self.release_hold(folder, &s),
            Err(_) => RepoSessionRelease {
                released: false,
                profile: None,
            },
        }
    }

    /// 세션 하나에서 폴더의 잡음을 푼다. 마지막 잡음이면 닫힘으로 바꾸고 목록에서 뺀 뒤(같은 `life` 구간)
    /// 잠금 밖에서 남은 일을 멈춘다
    fn release_hold(&self, folder: SessionId, s: &RepoSession) -> RepoSessionRelease {
        let released = {
            let mut life = s.life();
            let Life::Light { holders } = &mut *life else {
                let profile = match &*life {
                    Life::Full => Some(SessionProfile::Full),
                    _ => None,
                };
                return RepoSessionRelease {
                    released: false,
                    profile,
                };
            };
            let before = holders.len();
            holders.retain(|h| *h != folder);
            let released = holders.len() != before;
            if !holders.is_empty() {
                return RepoSessionRelease {
                    released,
                    profile: Some(SessionProfile::Light),
                };
            }
            self.inner().mark_closed(&mut life, s.id);
            released
        };
        self.inner().stop_session(s);
        RepoSessionRelease {
            released,
            profile: None,
        }
    }

    /// 폴더를 닫을 때: 그 폴더가 잡은 가벼운 세션의 잡음을 모두 풀고, 잡은 폴더가 더 없는 것은 닫는다.
    /// 승격된 세션과 다른 폴더도 잡은 세션은 그대로 둔다. 이미 닫힌 세션이 섞여 있어도 된다
    pub(crate) fn release_folder_holds(&self, folder: SessionId) {
        for s in self.inner().all_sessions() {
            self.release_hold(folder, &s);
        }
    }

    /// 폴더가 지금 잡고 있는 가벼운 세션들 (id 순). `except` 는 세지 않는다.
    /// 세션 목록 사본을 뜬 뒤 하나씩 `life` 를 잠깐 잡는다 (`sessions` 를 쥔 채 `life` 를 잡지 않는다)
    pub(crate) fn light_holds(
        &self,
        folder: SessionId,
        except: Option<SessionId>,
    ) -> Vec<SessionId> {
        let mut held: Vec<SessionId> = self
            .inner()
            .all_sessions()
            .into_iter()
            .filter(|s| Some(s.id) != except)
            .filter(|s| matches!(&*s.life(), Life::Light { holders } if holders.contains(&folder)))
            .map(|s| s.id)
            .collect();
        held.sort();
        held
    }

    /// 새 가벼운 세션을 하나 더 잡아도 되는지. 상한이면 지금 잡은 세션 목록과 함께 거부한다
    pub(crate) fn check_light_limit(
        &self,
        folder: SessionId,
        except: Option<SessionId>,
    ) -> Result<(), CoreError> {
        let held = self.light_holds(folder, except);
        if held.len() >= LIGHT_SESSIONS_PER_FOLDER {
            return Err(CoreError::LightSessionLimit {
                limit: LIGHT_SESSIONS_PER_FOLDER,
                sessions: held,
            });
        }
        Ok(())
    }
}
