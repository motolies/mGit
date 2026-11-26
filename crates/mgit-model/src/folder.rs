use std::path::PathBuf;

use serde::Serialize;

use crate::{Oid, OpKind};

/// 폴더 스캔으로 찾은 저장소의 종류 (`.git` 파일의 `gitdir:` 로 판별)
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoKind {
    Standalone,
    Worktree,
    Submodule,
}

/// 폴더 스캔 결과 하나
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    pub path: PathBuf,
    pub kind: RepoKind,
}

/// 멀티 저장소 대시보드 한 줄 (MR-02)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: PathBuf,
    pub name: String,
    pub kind: RepoKind,
    /// 저장소 색 번호 (LF-09). 폴더 세션이 매긴 순번에서 나오며 브랜치 목록·타임라인과 같은 값이다
    pub color: u16,
    /// 현재 브랜치. detached 면 `None`
    pub branch: Option<String>,
    pub detached: bool,
    /// staged + unstaged + untracked + 충돌
    pub changed: u32,
    pub conflicted: u32,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub op: Option<OpKind>,
    /// `FETCH_HEAD` 수정 시각 (epoch 밀리초). 한 번도 fetch 안 했으면 `None`
    pub last_fetch: Option<i64>,
    /// 상태를 못 읽었으면 그 이유
    pub error: Option<String>,
    /// 등록된 원격 이름. 업스트림이 없는 branch 에서만 읽는다 — 일괄 push 가 새 업스트림을 둘 원격을 미리 보일 때 쓴다.
    /// 업스트림이 있거나 분리 HEAD 이거나 원격 목록을 읽지 못했으면 `None` (빈 목록은 원격이 하나도 없다는 뜻)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remotes: Option<Vec<String>>,
    /// stash 항목 수. 요약이 이미 돌리는 `git status --show-stash` 의 `# stash <N>` 머리를 그대로 쓴다 (명령을 더 돌리지
    /// 않는다). git 이 `refs/stash` 의 reflog 항목을 세는 값이라 `git stash list` 의 줄 수와 같고, 워크트리끼리는 함께
    /// 쓰는 목록이라 같은 수가 나온다. 상태를 못 읽었으면 0
    pub stash_count: u32,
}

/// 서브모듈 상태 (`git submodule status` 접두 + status v2 의 `S` 필드)
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleStatus {
    /// `-`: 초기화되지 않음
    NotInitialized,
    /// ` `: 기록된 커밋과 같고 변경 없음
    Clean,
    /// `+`: 기록된 커밋과 다른 커밋이 체크아웃됨
    Mismatch,
    /// 커밋은 같지만 안에 변경이 있음
    Dirty,
    /// `U`: 병합 충돌
    Conflict,
}

/// 서브모듈 하나 (SUB-01)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    /// 상위 저장소 기준 상대 경로
    pub path: String,
    /// 체크아웃된(또는 기록된) 커밋
    pub oid: Oid,
    pub status: SubmoduleStatus,
    /// `git describe` 결과 (있으면)
    pub describe: Option<String>,
}

/// clone 옵션 (REPO-02)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneSpec {
    pub url: String,
    /// 만들 디렉터리 (없어야 함). 부모는 있어야 한다
    pub dest: PathBuf,
    pub branch: Option<String>,
    pub recurse_submodules: bool,
    /// `--depth=<n>` (REPO-03). 자동으로 `--single-branch`
    pub depth: Option<u32>,
    /// `--filter=blob:none` (REPO-03)
    pub blobless: bool,
    /// `--single-branch`
    pub single_branch: bool,
}

/// `.gitignore` 템플릿 (REPO-04)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreTemplate {
    pub id: String,
    pub label: String,
}
