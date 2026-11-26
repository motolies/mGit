//! 서브모듈 (SUB-01~11)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::cmd::list_submodules;
use mgit_l10n::{pick, tr};
use mgit_model::{
    EnvProfile, FoundRepo, GitRequest, Oid, RepoKind, SubmoduleInfo, SubmoduleStatus,
};
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::folder_batch::{BatchOp, BatchResult, FolderSettings};
use crate::ops::OpHandle;
use crate::write::WriteSpec;

/// 서브모듈 안의 commit 요약 (SUB-04·10)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleCommit {
    pub oid: Oid,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

/// 포인터 변경 사이의 commit 들 (SUB-04)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePointerLog {
    /// 새 포인터까지의 commit (최신 먼저). `reversed` 면 되돌린 범위
    pub commits: Vec<SubmoduleCommit>,
    /// 새 포인터가 옛 포인터의 조상 (되돌림)
    pub reversed: bool,
    /// 어느 한쪽 commit 이 서브모듈에 없어 목록을 못 만들었다
    pub missing: bool,
}

/// push 되지 않은 commit 이 있는 서브모듈 (SUB-09)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleUnpushed {
    pub path: String,
    pub count: u32,
}

/// 포인터 충돌의 양쪽 commit (SUB-10)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleSides {
    pub base: Option<SubmoduleCommit>,
    pub ours: Option<SubmoduleCommit>,
    pub theirs: Option<SubmoduleCommit>,
}

/// 옵션으로 오해될 수 없는 경로인지
fn check_path(path: &str) -> Result<(), CoreError> {
    if path.is_empty()
        || path.starts_with('-')
        || path.contains('\0')
        || path.contains("..")
        || Path::new(path).is_absolute()
    {
        return Err(CoreError::Invalid(tr!(
            "잘못된 서브모듈 경로: {path:?}",
            "Invalid submodule path: {path:?}"
        )));
    }
    Ok(())
}

/// 옵션으로 읽힐 수 있는 브랜치 이름 (지금 언어)
fn bad_branch(branch: &str) -> String {
    tr!(
        "올바르지 않은 브랜치입니다: {branch:?}",
        "Invalid branch: {branch:?}"
    )
}

/// `.gitmodules` 의 이름은 저장소가 정하는 값이다. `.git/modules` 밖을 가리킬 수 있으면 쓰지 않는다
fn is_safe_module_name(name: &str) -> bool {
    !name.is_empty()
        && !Path::new(name).is_absolute()
        && !name.split(['/', '\\']).any(|part| part == "..")
}

/// 서브모듈의 `<common_dir>/modules/<이름>` 실제 경로. 없으면 `None`, `modules` 밖이면 거부한다
fn modules_dir_of(common_dir: &Path, name: &str) -> Result<Option<PathBuf>, CoreError> {
    let modules = common_dir.join("modules");
    let dir = modules.join(name);
    if dir.symlink_metadata().is_err() {
        return Ok(None);
    }
    let root = modules.canonicalize()?;
    let real = dir.canonicalize()?;
    if real == root || !real.starts_with(&root) {
        return Err(CoreError::Invalid(tr!(
            "서브모듈 저장소가 .git/modules 밖에 있어 제거를 거부합니다: {}",
            "Refusing to remove: the submodule repository is outside .git/modules: {}",
            real.display()
        )));
    }
    Ok(Some(real))
}

/// 서브모듈 작업 트리에서 commit 하나의 요약
async fn commit_info(
    runner: &dyn mgit_model::GitRunner,
    sub_wt: &Path,
    oid: &Oid,
) -> Option<SubmoduleCommit> {
    let req = GitRequest::new(
        sub_wt,
        [
            "log",
            "-1",
            "--format=%H%x00%s%x00%aN%x00%at",
            "--end-of-options",
            &oid.to_hex(),
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let out = runner.run(req).await.ok()?;
    if !out.exit.success() {
        return None;
    }
    let text = out.stdout_lossy();
    let mut f = text.trim_end().split('\0');
    let (h, subject, author, time) = (f.next()?, f.next()?, f.next()?, f.next()?);
    Some(SubmoduleCommit {
        oid: Oid::from_hex(h.trim().as_bytes()).ok()?,
        subject: subject.to_string(),
        author: author.to_string(),
        time: time.trim().parse().unwrap_or(0),
    })
}

impl Core {
    /// 서브모듈 목록 (SUB-01). `submodule status` 의 접두에 status v2 의 `S` 필드(안쪽 변경)를 합친다
    pub async fn submodules(&self, session: SessionId) -> Result<Vec<SubmoduleInfo>, CoreError> {
        let s = self.inner_arc().get(session)?;
        let mut list = list_submodules(self.inner_arc().runner(), &s.info.work_tree).await?;
        let status = s.state().status.clone();
        for sm in &mut list {
            if sm.status != SubmoduleStatus::Clean {
                continue;
            }
            let entry = status
                .entries
                .iter()
                .find(|e| e.path.trim_end_matches('/') == sm.path);
            if let Some(sub) = entry.and_then(|e| e.submodule.as_ref()) {
                if sub.commit_changed {
                    sm.status = SubmoduleStatus::Mismatch;
                } else if sub.tracked_changes || sub.untracked_changes {
                    sm.status = SubmoduleStatus::Dirty;
                }
            }
        }
        Ok(list)
    }

    /// 서브모듈 초기화·업데이트 (SUB-02): `submodule update --init [--recursive]`. 네트워크 명령
    pub async fn submodule_update(
        &self,
        session: SessionId,
        recursive: bool,
        op: Option<OpHandle>,
    ) -> Result<(), CoreError> {
        let mut args: Vec<String> = vec![
            "submodule".into(),
            "update".into(),
            "--init".into(),
            "--progress".into(),
        ];
        if recursive {
            args.push("--recursive".into());
        }
        let mut spec = WriteSpec::new(args).network();
        if let Some(op) = op {
            spec = spec.with_op(op).progress();
        }
        self.run_write(session, spec).await?;
        Ok(())
    }

    /// `.gitmodules` 에 등록된 (경로 → 이름)
    pub async fn submodule_names(
        &self,
        session: SessionId,
    ) -> Result<Vec<(String, String)>, CoreError> {
        let s = self.inner_arc().get(session)?;
        self.submodule_names_at(&s.info.work_tree).await
    }

    /// 작업 트리 경로로 `.gitmodules` 에 등록된 (경로 → 이름)을 읽는다 (저장소 세션·폴더 공용)
    pub(crate) async fn submodule_names_at(
        &self,
        work_tree: &Path,
    ) -> Result<Vec<(String, String)>, CoreError> {
        let inner = self.inner_arc();
        if !work_tree.join(".gitmodules").is_file() {
            return Ok(Vec::new());
        }
        let req = GitRequest::new(
            work_tree,
            [
                "config",
                "-f",
                ".gitmodules",
                "-z",
                "--get-regexp",
                r"^submodule\..*\.path$",
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        if !out.exit.success() {
            return Ok(Vec::new());
        }
        // `-z` 출력: `<키>\n<값>\0`. 이름·경로에 공백이 있을 수 있다
        Ok(out
            .stdout
            .split(|&b| b == 0)
            .filter_map(|record| {
                let record = String::from_utf8_lossy(record);
                let (key, path) = record.split_once('\n')?;
                let name = key
                    .strip_prefix("submodule.")?
                    .strip_suffix(".path")?
                    .to_string();
                Some((path.trim().to_string(), name))
            })
            .collect())
    }

    /// 포인터 변경 사이의 commit 들 (SUB-04). `old` 가 없으면(새로 추가) 새 포인터부터 20개
    pub async fn submodule_pointer_log(
        &self,
        session: SessionId,
        path: &str,
        old: Option<Oid>,
        new: Oid,
    ) -> Result<SubmodulePointerLog, CoreError> {
        check_path(path)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let sub_wt = s.info.work_tree.join(path);
        if !sub_wt.join(".git").exists() {
            return Err(CoreError::Invalid(tr!(
                "서브모듈이 초기화되지 않았습니다: {path}",
                "Submodule is not initialized: {path}"
            )));
        }
        let runner = inner.runner();
        /// `--format` 로 받은 줄들을 commit 목록으로
        fn parse(text: &str) -> Vec<SubmoduleCommit> {
            text.lines()
                .filter_map(|l| {
                    let mut f = l.split('\0');
                    let (h, subject, author, time) = (f.next()?, f.next()?, f.next()?, f.next()?);
                    Some(SubmoduleCommit {
                        oid: Oid::from_hex(h.trim().as_bytes()).ok()?,
                        subject: subject.to_string(),
                        author: author.to_string(),
                        time: time.trim().parse().unwrap_or(0),
                    })
                })
                .collect()
        }
        let range = |a: &str, b: &str| format!("{a}..{b}");
        let fmt = "--format=%H%x00%s%x00%aN%x00%at";
        let sub_dir: &Path = &sub_wt;
        let run = |args: Vec<String>| async move {
            let req = GitRequest::new(sub_dir, args).with_env(EnvProfile::ReadInteractive);
            runner.run(req).await
        };
        let Some(old) = old else {
            let out = run(vec![
                "log".into(),
                "-n20".into(),
                fmt.into(),
                "--end-of-options".into(),
                new.to_hex(),
            ])
            .await?;
            return Ok(SubmodulePointerLog {
                commits: if out.exit.success() {
                    parse(&out.stdout_lossy())
                } else {
                    Vec::new()
                },
                reversed: false,
                missing: !out.exit.success(),
            });
        };
        let forward = run(vec![
            "log".into(),
            fmt.into(),
            "--end-of-options".into(),
            range(&old.to_hex(), &new.to_hex()),
        ])
        .await?;
        if !forward.exit.success() {
            return Ok(SubmodulePointerLog {
                commits: Vec::new(),
                reversed: false,
                missing: true,
            });
        }
        let commits = parse(&forward.stdout_lossy());
        if !commits.is_empty() {
            return Ok(SubmodulePointerLog {
                commits,
                reversed: false,
                missing: false,
            });
        }
        let backward = run(vec![
            "log".into(),
            fmt.into(),
            "--end-of-options".into(),
            range(&new.to_hex(), &old.to_hex()),
        ])
        .await?;
        Ok(SubmodulePointerLog {
            commits: if backward.exit.success() {
                parse(&backward.stdout_lossy())
            } else {
                Vec::new()
            },
            reversed: true,
            missing: false,
        })
    }

    /// 서브모듈 추가 (SUB-05): `submodule add [-b <branch>] <url> <path>`. 네트워크 명령
    pub async fn submodule_add(
        &self,
        session: SessionId,
        url: &str,
        path: &str,
        branch: Option<&str>,
        op: Option<OpHandle>,
    ) -> Result<(), CoreError> {
        check_path(path)?;
        if url.trim().is_empty() || url.starts_with('-') {
            return Err(CoreError::Invalid(
                pick("URL을 입력하세요.", "Enter a URL").into(),
            ));
        }
        let mut args: Vec<String> = vec!["submodule".into(), "add".into(), "--progress".into()];
        if let Some(b) = branch.map(str::trim).filter(|b| !b.is_empty()) {
            if b.starts_with('-') {
                return Err(CoreError::Invalid(bad_branch(b)));
            }
            args.push("-b".into());
            args.push(b.into());
        }
        args.push("--".into());
        args.push(url.trim().into());
        args.push(path.into());
        let mut spec = WriteSpec::new(args)
            .network()
            .label(format!("submodule add {path}"));
        if let Some(op) = op {
            spec = spec.with_op(op).progress();
        }
        self.run_write(session, spec).await?;
        Ok(())
    }

    /// 이미 clone 된 하위 저장소를 서브모듈로 등록한다 (SUB-11). 그 저장소의 origin URL 을 쓴다
    pub async fn submodule_adopt(&self, session: SessionId, path: &str) -> Result<(), CoreError> {
        check_path(path)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let sub_wt = s.info.work_tree.join(path);
        let req = GitRequest::new(&sub_wt, ["remote", "get-url", "origin"])
            .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        if !out.exit.success() {
            return Err(CoreError::Invalid(tr!(
                "{path}에 origin 원격 저장소가 없어 서브모듈로 등록할 수 없습니다",
                "Cannot register {path} as a submodule because it has no origin remote"
            )));
        }
        let url = out.stdout_lossy().trim().to_string();
        self.run_write(
            session,
            WriteSpec::new(["submodule", "add", "--", &url, path])
                .network()
                .label(format!("submodule add {path}")),
        )
        .await?;
        Ok(())
    }

    /// 서브모듈 제거 (SUB-05): `deinit -f` → `rm -f` → `.git/modules/<name>` 삭제. 제거는 stage 되고 commit 은 사용자가
    pub async fn submodule_remove(&self, session: SessionId, path: &str) -> Result<(), CoreError> {
        check_path(path)?;
        let names = self.submodule_names(session).await?;
        let candidates: Vec<String> = names
            .into_iter()
            .filter(|(p, _)| p == path)
            .map(|(_, n)| n)
            .collect();
        if candidates.is_empty() {
            return Err(CoreError::Invalid(tr!(
                "등록된 서브모듈이 아닙니다: {path}",
                "Not a registered submodule: {path}"
            )));
        }
        // 같은 경로에 항목이 여럿일 수 있다. git 이 무시하는 이름 대신 정상 항목을 고른다
        let name = candidates
            .into_iter()
            .find(|n| is_safe_module_name(n))
            .ok_or_else(|| {
                CoreError::Invalid(tr!("서브모듈 이름이 올바르지 않아 제거할 수 없습니다. .gitmodules를 확인하세요: {path}", "Refusing to remove: the submodule name is unsafe. Check .gitmodules: {path}"))
            })?;
        let common_dir = self.inner_arc().get(session)?.info.common_dir.clone();
        // git 을 실행하기 전에 한 번, 지우기 직전에 한 번 확인한다
        modules_dir_of(&common_dir, &name)?;
        self.run_write(
            session,
            WriteSpec::new(["submodule", "deinit", "-f", "--", path])
                .label(format!("submodule deinit {path}"))
                .skip_refresh(),
        )
        .await?;
        self.run_write(
            session,
            WriteSpec::new(["rm", "-f", "--", path]).label(format!("rm {path}")),
        )
        .await?;
        if let Some(dir) = modules_dir_of(&common_dir, &name)? {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    /// 추적 branch 지정·해제 (SUB-06): `submodule set-branch -b <branch> | -d`
    pub async fn submodule_set_branch(
        &self,
        session: SessionId,
        path: &str,
        branch: Option<&str>,
    ) -> Result<(), CoreError> {
        check_path(path)?;
        let mut args: Vec<String> = vec!["submodule".into(), "set-branch".into()];
        match branch.map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) if b.starts_with('-') => {
                return Err(CoreError::Invalid(bad_branch(b)));
            }
            Some(b) => {
                args.push("-b".into());
                args.push(b.into());
            }
            None => args.push("-d".into()),
        }
        args.push("--".into());
        args.push(path.into());
        self.run_write(session, WriteSpec::new(args).no_undo())
            .await?;
        Ok(())
    }

    /// 추적 branch 의 최신으로 (SUB-06): `submodule update --remote [--merge|--rebase] [-- <path>]`
    pub async fn submodule_update_remote(
        &self,
        session: SessionId,
        path: Option<&str>,
        mode: Option<&str>,
        op: Option<OpHandle>,
    ) -> Result<(), CoreError> {
        let mut args: Vec<String> = vec![
            "submodule".into(),
            "update".into(),
            "--remote".into(),
            "--init".into(),
            "--progress".into(),
        ];
        match mode {
            Some("merge") => args.push("--merge".into()),
            Some("rebase") => args.push("--rebase".into()),
            _ => {}
        }
        if let Some(p) = path {
            check_path(p)?;
            args.push("--".into());
            args.push(p.into());
        }
        let mut spec = WriteSpec::new(args).network();
        if let Some(op) = op {
            spec = spec.with_op(op).progress();
        }
        self.run_write(session, spec).await?;
        Ok(())
    }

    /// `.gitmodules` 의 URL 을 설정에 반영 (SUB-07): `submodule sync --recursive`
    pub async fn submodule_sync(&self, session: SessionId) -> Result<(), CoreError> {
        self.run_write(
            session,
            WriteSpec::new(["submodule", "sync", "--recursive"]).no_undo(),
        )
        .await?;
        Ok(())
    }

    /// 초기화된 서브모듈 각각을 저장소로 보고 일괄 작업 (SUB-08). `paths` 가 비면 전부
    pub async fn submodule_batch(
        &self,
        session: SessionId,
        op: BatchOp,
        paths: &[String],
    ) -> Result<BatchResult, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let list = self.submodules(session).await?;
        let targets: Vec<FoundRepo> = list
            .into_iter()
            .filter(|sm| sm.status != SubmoduleStatus::NotInitialized)
            .filter(|sm| paths.is_empty() || paths.iter().any(|p| p == &sm.path))
            .map(|sm| FoundRepo {
                path: s.info.work_tree.join(&sm.path),
                kind: RepoKind::Submodule,
            })
            .collect();
        if targets.is_empty() {
            return Err(CoreError::Invalid(
                pick("대상 서브모듈이 없습니다", "No target submodules").into(),
            ));
        }
        let result = self
            .batch_run(
                session,
                Arc::clone(&s.sink),
                targets,
                op,
                FolderSettings::default(),
            )
            .await?;
        self.refresh(session).await?;
        Ok(result)
    }

    /// push 되지 않은 commit 이 있는 서브모듈 (SUB-09): `rev-list --count @{u}..HEAD`
    pub async fn submodule_unpushed(
        &self,
        session: SessionId,
    ) -> Result<Vec<SubmoduleUnpushed>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let mut out = Vec::new();
        for sm in self.submodules(session).await? {
            if sm.status == SubmoduleStatus::NotInitialized {
                continue;
            }
            let sub_wt = s.info.work_tree.join(&sm.path);
            let req = GitRequest::new(&sub_wt, ["rev-list", "--count", "@{upstream}..HEAD"])
                .with_env(EnvProfile::ReadInteractive);
            let Ok(r) = inner.runner().run(req).await else {
                continue;
            };
            if !r.exit.success() {
                continue;
            }
            let count: u32 = r.stdout_lossy().trim().parse().unwrap_or(0);
            if count > 0 {
                out.push(SubmoduleUnpushed {
                    path: sm.path,
                    count,
                });
            }
        }
        Ok(out)
    }

    /// 포인터 충돌의 양쪽 commit 요약 (SUB-10)
    pub async fn submodule_sides(
        &self,
        session: SessionId,
        path: &str,
        stages: [Option<Oid>; 3],
    ) -> SubmoduleSides {
        let Ok(s) = self.inner_arc().get(session) else {
            return SubmoduleSides::default();
        };
        let sub_wt = s.info.work_tree.join(path);
        let runner = self.inner_arc();
        let runner = runner.runner();
        let mut sides = SubmoduleSides::default();
        if let Some(o) = &stages[0] {
            sides.base = commit_info(runner, &sub_wt, o).await;
        }
        if let Some(o) = &stages[1] {
            sides.ours = commit_info(runner, &sub_wt, o).await;
        }
        if let Some(o) = &stages[2] {
            sides.theirs = commit_info(runner, &sub_wt, o).await;
        }
        sides
    }

    /// 후보 경로 중 `.git` 을 품은 미등록 하위 저장소 (SUB-11)
    pub async fn nested_repo_dirs(
        &self,
        session: SessionId,
        candidates: &[String],
    ) -> Result<Vec<String>, CoreError> {
        let s = self.inner_arc().get(session)?;
        self.nested_repo_dirs_at(&s.info.work_tree, candidates)
            .await
    }

    /// 작업 트리 경로로 후보 중 `.git` 을 품은 미등록 하위 저장소를 찾는다 (저장소 세션·폴더 공용)
    pub(crate) async fn nested_repo_dirs_at(
        &self,
        work_tree: &Path,
        candidates: &[String],
    ) -> Result<Vec<String>, CoreError> {
        let registered: Vec<String> = self
            .submodule_names_at(work_tree)
            .await?
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        let mut out = Vec::new();
        for c in candidates {
            let rel = c.trim_end_matches('/');
            if rel.is_empty() || rel == "." || registered.iter().any(|r| r == rel) {
                continue;
            }
            let dir: PathBuf = work_tree.join(rel);
            if dir.is_dir() && dir.join(".git").exists() {
                out.push(rel.to_string());
            }
        }
        Ok(out)
    }
}
