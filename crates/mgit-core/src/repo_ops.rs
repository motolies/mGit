//! 저장소 관리 (REPO-02 clone, REPO-04 init, REPO-05 최근 목록, REPO-06 폴더 스캔, 탭 복원)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mgit_git::cmd::scan_repos;
use mgit_l10n::{pick, tr};
use mgit_model::{
    CloneSpec, EnvProfile, FoundRepo, GitError, GitRequest, GitignoreTemplate, RecentEntry,
    RecentKind, redact_args, redact_text,
};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::{CoreEvent, EventSink, SessionId};
use crate::folder::SCAN_DEPTH;
use crate::messages;
use crate::ops::LineEventSink;

/// (id, 표시 이름 (한국어, 영어), 본문). 사용자가 고르는 `.gitignore` 템플릿 (REPO-04)
const TEMPLATES: &[(&str, (&str, &str), &str)] = &[
    (
        "node",
        ("Node", "Node"),
        "node_modules/\ndist/\nbuild/\n.next/\ncoverage/\n*.log\n.env\n.env.*\n!.env.example\n.DS_Store\n",
    ),
    (
        "rust",
        ("Rust", "Rust"),
        "target/\n**/*.rs.bk\n*.pdb\n.DS_Store\n",
    ),
    (
        "java",
        ("Java / Gradle", "Java / Gradle"),
        "build/\n.gradle/\nout/\n*.class\n*.jar\n*.war\n.idea/\n*.iml\n.DS_Store\n",
    ),
    (
        "python",
        ("Python", "Python"),
        "__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.pytest_cache/\n.mypy_cache/\ndist/\nbuild/\n*.egg-info/\n.env\n.DS_Store\n",
    ),
    (
        "os",
        ("macOS / Windows", "macOS / Windows"),
        ".DS_Store\n.AppleDouble\n.LSOverride\n._*\nThumbs.db\nehthumbs.db\nDesktop.ini\n$RECYCLE.BIN/\n",
    ),
    ("empty", ("빈 파일", "Empty file"), ""),
];

/// 템플릿 목록 (표시 이름은 지금 언어)
pub fn gitignore_templates() -> Vec<GitignoreTemplate> {
    TEMPLATES
        .iter()
        .map(|&(id, (ko, en), _)| GitignoreTemplate {
            id: id.to_string(),
            label: pick(ko, en).to_string(),
        })
        .collect()
}

/// 템플릿 본문
pub fn gitignore_body(id: &str) -> Option<&'static str> {
    TEMPLATES
        .iter()
        .find(|(i, _, _)| *i == id)
        .map(|(_, _, body)| *body)
}

/// 옵션으로 오해될 수 없는 값인지
pub(crate) fn check_arg(v: &str) -> Result<(), CoreError> {
    if v.is_empty() || v.starts_with('-') || v.contains('\0') {
        return Err(CoreError::Invalid(messages::bad_value(v)));
    }
    Ok(())
}

/// 경로 마지막 요소
fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `git clone` 인자 (단일·일괄 clone 공용, REPO-02·03): 진행률, 브랜치, 서브모듈, 경량 복제 옵션 뒤에
/// `--end-of-options <url> <dest>`. URL·브랜치가 옵션으로 오해될 수 있으면 거부한다
pub(crate) fn clone_args(spec: &CloneSpec) -> Result<Vec<String>, CoreError> {
    check_arg(&spec.url)?;
    let mut args: Vec<String> = vec!["clone".into(), "--progress".into()];
    if let Some(b) = &spec.branch {
        check_arg(b)?;
        args.push("--branch".into());
        args.push(b.clone());
    }
    if spec.recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    // 경량 복제 (REPO-03)
    if let Some(d) = spec.depth {
        args.push(format!("--depth={}", d.max(1)));
    }
    if spec.blobless {
        args.push("--filter=blob:none".into());
    }
    if spec.single_branch || spec.depth.is_some() {
        args.push("--single-branch".into());
    }
    args.push("--end-of-options".into());
    args.push(spec.url.clone());
    args.push(spec.dest.to_string_lossy().into_owned());
    Ok(args)
}

impl Core {
    /// clone (REPO-02). 진행률·출력은 `sink` 로 세션 0 의 operation 이벤트로 흘리고, 취소는
    /// `cancel_operation(op_id)`. 성공하면 최근 목록에 넣고 작업 트리 경로를 돌려준다
    pub async fn clone_repo(
        &self,
        spec: CloneSpec,
        sink: Arc<dyn EventSink>,
    ) -> Result<PathBuf, CoreError> {
        check_arg(&spec.url)?;
        if spec.dest.exists() {
            return Err(CoreError::Invalid(tr!(
                "이미 존재하는 경로입니다: {}",
                "Path already exists: {}",
                spec.dest.display()
            )));
        }
        let parent = spec
            .dest
            .parent()
            .filter(|p| p.is_dir())
            .ok_or_else(|| {
                CoreError::Invalid(
                    pick(
                        "대상 폴더의 상위 폴더가 없습니다",
                        "The destination's parent folder does not exist",
                    )
                    .into(),
                )
            })?
            .to_path_buf();
        let args = clone_args(&spec)?;

        let inner = self.inner_arc();
        let op = inner.ops.begin(SessionId(0));
        sink.emit(CoreEvent::OperationStarted {
            session: SessionId(0),
            op_id: op.id,
            kind: "clone".into(),
            label: format!("clone {}", name_of(&spec.dest)),
        });
        let ls = Arc::new(LineEventSink::new(
            Arc::clone(&sink),
            SessionId(0),
            op.id,
            true,
        ));
        let auth_tag = inner.auth_tag();
        let mut req = GitRequest::new(&parent, args)
            .with_env(EnvProfile::Network)
            .with_env_var(mgit_helper::ENV_TAG, &auth_tag)
            .with_cancel(op.cancel.clone());
        for (k, v) in &inner.cfg.git_config_overrides {
            req = req.with_config(k, v);
        }
        let display = redact_args(&req.display_args());
        let result = inner.runner().run_observed(req, ls.clone()).await;
        ls.flush();
        inner.ops.end(op.id);
        let failed_stderr = match &result {
            Ok(out) if !out.exit.success() => out.exit.stderr.as_str(),
            _ => "",
        };
        inner.report_auth(&auth_tag, failed_stderr).await;
        let finish = |ok: bool, cancelled: bool, message: String| {
            sink.emit(CoreEvent::OperationFinished {
                session: SessionId(0),
                op_id: op.id,
                ok,
                cancelled,
                message,
                lock_left: false,
            });
        };
        match result {
            Ok(out) if out.exit.success() => {
                finish(true, false, String::new());
                let _ =
                    self.store()
                        .recent_touch(&spec.dest, RecentKind::Repo, &name_of(&spec.dest));
                Ok(spec.dest)
            }
            Ok(out) => {
                let hint = mgit_model::classify_stderr(&out.exit.stderr);
                let stderr = redact_text(&out.exit.stderr);
                finish(false, false, stderr.clone());
                Err(CoreError::CommandFailed {
                    args: display,
                    status: out.exit.status,
                    hint,
                    stderr,
                })
            }
            Err(GitError::Cancelled) => {
                finish(false, true, messages::cancelled().into());
                Err(CoreError::Cancelled)
            }
            Err(e) => {
                finish(false, false, redact_text(&e.to_string()));
                Err(e.into())
            }
        }
    }

    /// 새 저장소 초기화 (REPO-04): `git init -b <branch>` + 템플릿 `.gitignore`
    pub async fn init_repo(
        &self,
        path: &Path,
        default_branch: &str,
        template: Option<&str>,
    ) -> Result<PathBuf, CoreError> {
        check_arg(default_branch)?;
        if path.join(".git").exists() {
            return Err(CoreError::Invalid(tr!(
                "이미 저장소입니다: {}",
                "Already a repository: {}",
                path.display()
            )));
        }
        std::fs::create_dir_all(path)?;
        let req = GitRequest::new(
            path,
            ["init", "-q", "-b", default_branch, "--end-of-options", "."],
        )
        .with_env(EnvProfile::Write);
        let args = req.display_args();
        let out = self.inner_arc().runner().run(req).await?;
        if !out.exit.success() {
            return Err(CoreError::CommandFailed {
                args,
                status: out.exit.status,
                stderr: out.exit.stderr,
                hint: None,
            });
        }
        if let Some(id) = template {
            let body = gitignore_body(id).ok_or_else(|| {
                CoreError::Invalid(tr!(
                    "알 수 없는 템플릿입니다: {id}",
                    "Unknown template: {id}"
                ))
            })?;
            std::fs::write(path.join(".gitignore"), body)?;
        }
        let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let _ = self
            .store()
            .recent_touch(&canon, RecentKind::Repo, &name_of(&canon));
        Ok(canon)
    }

    /// 최근 저장소·폴더 (고정 먼저, 최근 순)
    pub fn recent_list(&self) -> Result<Vec<RecentEntry>, CoreError> {
        Ok(self.store().recent_list()?)
    }

    /// 고정 토글
    pub fn recent_pin(&self, path: &Path, pinned: bool) -> Result<(), CoreError> {
        Ok(self.store().recent_pin(path, pinned)?)
    }

    /// 최근 목록에서 제거
    pub fn recent_remove(&self, path: &Path) -> Result<(), CoreError> {
        Ok(self.store().recent_remove(path)?)
    }

    /// 폴더를 스캔해 찾은 저장소를 최근 목록에 넣는다 (REPO-06)
    pub fn scan_and_register(&self, root: &Path) -> Result<Vec<FoundRepo>, CoreError> {
        let repos = scan_repos(root, SCAN_DEPTH);
        for r in &repos {
            let _ = self
                .store()
                .recent_touch(&r.path, RecentKind::Repo, &name_of(&r.path));
        }
        Ok(repos)
    }

    /// 마지막으로 열려 있던 탭 경로
    pub fn open_tabs_get(&self) -> Result<Vec<PathBuf>, CoreError> {
        Ok(self.store().open_tabs_get()?)
    }

    /// 열린 탭 경로를 저장한다 (콜드 스타트 복원)
    pub fn open_tabs_set(&self, paths: &[PathBuf]) -> Result<(), CoreError> {
        Ok(self.store().open_tabs_set(paths)?)
    }
}
