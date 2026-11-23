//! 폴더의 브랜치 목록 (PF-03, BT-06·08). 통합 타임라인과 무관하게 저장소마다 HEAD 와 ref 만 읽어
//! 이름으로 합친다. `git log` 를 돌리지 않으므로 타임라인을 열기 전에도, 로드가 끝나기 전에도 답한다

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use mgit_model::{HeadState, RefKind, RefLabel};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::SessionId;
use crate::folder::{FolderRepo, read_head_refs, repo_name};

/// 동시에 ref 를 읽는 저장소 수
const READ_CONCURRENCY: usize = 8;

/// 브랜치 목록을 읽은 저장소 하나 (워크트리는 원 저장소에 흡수된다)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranchRepo {
    pub path: PathBuf,
    pub name: String,
    /// 저장소 색 번호 (요약·타임라인과 같은 값)
    pub color: u8,
    /// HEAD: 현재 브랜치, detached(커밋), 또는 커밋 없음. 읽지 못했으면 `None`
    pub head: Option<HeadState>,
    /// ref 를 읽지 못한 이유
    pub error: Option<String>,
}

/// 브랜치를 가진 저장소 하나와 그 저장소에서의 상태
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranchIn {
    pub path: PathBuf,
    pub color: u8,
    /// 이 저장소에서 현재 브랜치인지
    pub current: bool,
    /// 업스트림의 짧은 이름 (`origin/main`). 로컬 브랜치에만 있다
    pub upstream: Option<String>,
    /// 업스트림 대비 앞선·뒤처진 커밋 수 (업스트림이 없거나 사라졌으면 `None`)
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// 업스트림 ref 가 사라졌는지
    pub gone: bool,
}

/// 저장소들을 이름으로 합친 브랜치 하나
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranch {
    /// 짧은 이름 (`main`, `origin/main`)
    pub name: String,
    pub remote: bool,
    /// 원격 브랜치면 그 원격의 이름 (`origin`)
    pub remote_name: Option<String>,
    /// 이 브랜치를 가진 저장소 (순번순)
    pub repos: Vec<FolderBranchIn>,
}

/// `folder_branches` 응답. 부분집합을 요청했으면 그 저장소만 들어 있다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderBranches {
    /// 읽은 저장소 (순번순). 읽기에 실패한 저장소도 `error` 와 함께 남는다
    pub repos: Vec<FolderBranchRepo>,
    /// 이름으로 합친 브랜치 (로컬 먼저, 이름순)
    pub branches: Vec<FolderBranch>,
}

/// 업스트림 전체 이름을 짧은 이름으로 (`refs/remotes/origin/main` → `origin/main`)
fn short_upstream(full: &str) -> String {
    full.strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .unwrap_or(full)
        .to_string()
}

/// 저장소 하나의 HEAD 와 ref 를 읽는다. 실패해도 저장소 줄은 남긴다 (`error` 에 이유)
async fn read_repo(inner: &CoreInner, repo: FolderRepo) -> (FolderBranchRepo, Vec<RefLabel>) {
    let mut out = FolderBranchRepo {
        name: repo_name(&repo.found.path),
        color: repo.color(),
        path: repo.found.path,
        head: None,
        error: None,
    };
    match read_head_refs(inner, &out.path).await {
        Ok((_, head, labels)) => {
            out.head = Some(head);
            (out, labels)
        }
        Err(e) => {
            out.error = Some(e.to_string());
            (out, Vec::new())
        }
    }
}

/// 저장소별 ref 라벨을 이름으로 합친다. 태그·스태시는 뺀다. 입력은 순번순이어야 한다
fn merge_branches(read: Vec<(FolderBranchRepo, Vec<RefLabel>)>) -> FolderBranches {
    let mut by_name: HashMap<(bool, String), FolderBranch> = HashMap::new();
    let mut repos = Vec::with_capacity(read.len());
    for (repo, labels) in read {
        for l in labels {
            let remote_name = match &l.kind {
                RefKind::LocalBranch => None,
                RefKind::RemoteBranch { remote } => Some(remote.clone()),
                RefKind::Tag { .. } | RefKind::Stash => continue,
            };
            let remote = remote_name.is_some();
            let branch = by_name
                .entry((remote, l.short_name.clone()))
                .or_insert_with(|| FolderBranch {
                    name: l.short_name.clone(),
                    remote,
                    remote_name: remote_name.filter(|r| !r.is_empty()),
                    repos: Vec::new(),
                });
            branch.repos.push(FolderBranchIn {
                path: repo.path.clone(),
                color: repo.color,
                current: l.is_current,
                upstream: l.upstream.as_deref().map(short_upstream),
                ahead: l.ahead,
                behind: l.behind,
                gone: l.upstream_gone,
            });
        }
        repos.push(repo);
    }
    let mut branches: Vec<FolderBranch> = by_name.into_values().collect();
    branches.sort_by(|a, b| (a.remote, &a.name).cmp(&(b.remote, &b.name)));
    FolderBranches { repos, branches }
}

impl Core {
    /// 폴더의 브랜치 목록 (PF-03). 저장소마다 HEAD 와 ref 만 읽어(동시 8개) 이름으로 합친다.
    /// `repos` 가 비어 있으면 전부, 아니면 그 저장소(워크트리면 원 저장소)만 읽는다 (PF-02).
    /// 목록에 없는 경로는 거부한다
    pub async fn folder_branches(
        &self,
        session: SessionId,
        repos: &[PathBuf],
    ) -> Result<FolderBranches, CoreError> {
        let inner = self.inner_arc();
        let folder = inner.folders_get(session)?;
        let sem = Arc::new(Semaphore::new(READ_CONCURRENCY));
        let mut set = JoinSet::new();
        for (i, repo) in folder.select_groups(repos)?.into_iter().enumerate() {
            let inner = Arc::clone(&inner);
            let sem = Arc::clone(&sem);
            set.spawn(async move {
                let _permit = sem.acquire().await;
                (i, read_repo(&inner, repo).await)
            });
        }
        let mut read = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok(one) = r {
                read.push(one);
            }
        }
        read.sort_by_key(|(i, _)| *i);
        Ok(merge_branches(
            read.into_iter().map(|(_, one)| one).collect(),
        ))
    }
}
