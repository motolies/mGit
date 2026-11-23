//! 충돌 해결 보조 (CF-16~19·27~29): 이름 변경 충돌·출처·경로별 규칙·외부 병합 도구·
//! 해결 내역 리뷰·해결 보관(Abort 보호)·rerere 가시화

use std::path::Path;

use mgit_git::cmd::{config_get_bool, list_unmerged, show_stage};
use mgit_l10n::{pick, tr};
use mgit_merge::similarity;
use mgit_model::{ConflictKind, ConflictSide, EnvProfile, GitRequest, Oid};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::secrets::glob_match;
use crate::write::WriteSpec;

/// 이름 변경 짝으로 묶는 최소 유사도
const RENAME_SIMILARITY: f32 = 0.5;
/// 보관 ref 접두
pub const KEEP_REF_PREFIX: &str = "refs/mgit/conflict/";
/// 출처 commit 최대 수 (한쪽)
const ORIGIN_LIMIT: &str = "100";

/// 이름 변경 충돌 묶음 (CF-16): base 의 한 파일이 양쪽에서 다른 이름이 됐다
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameConflict {
    pub base_path: String,
    pub ours_path: String,
    pub theirs_path: String,
}

/// 출처 commit 요약 (CF-17)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OriginCommit {
    pub oid: Oid,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

/// 충돌 파일을 건드린 양쪽 commit (CF-17)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConflictOrigins {
    pub ours: Vec<OriginCommit>,
    pub theirs: Vec<OriginCommit>,
    /// rebase·cherry-pick·revert 에서 지금 적용 중인 commit
    pub current: Option<OriginCommit>,
}

/// 경로별 해결 규칙의 동작 (CF-18)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuleAction {
    Ours,
    Theirs,
    /// `merge-file --union`
    Union,
    /// 셸 명령 (`MGIT_PATH` 환경 변수로 경로 전달). 0 으로 끝나면 그 파일을 stage
    Command {
        cmd: String,
    },
}

/// 경로별 해결 규칙
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRule {
    pub glob: String,
    pub action: RuleAction,
}

/// 규칙 적용 결과 한 줄
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleResult {
    pub path: String,
    pub glob: String,
    pub ok: bool,
    pub message: String,
}

/// 해결 내역 리뷰 (CF-27): git 자동 병합 결과 vs 사용자가 저장한 결과
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionReview {
    pub path: String,
    pub auto: String,
    pub resolved: String,
    /// `git diff <auto> <resolved>` 통합 diff
    pub diff: String,
    pub auto_had_conflicts: bool,
}

/// 보관된 해결 (CF-28)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeptResolution {
    pub path: String,
    /// 진행 중 작업 식별자 (MERGE_HEAD 등 상대 commit, 없으면 `none`)
    pub op_key: String,
    pub stages: [Option<Oid>; 3],
    pub resolved: Oid,
    pub time: i64,
    /// 지금 진행 중인 작업과 같은 상대 commit 인지
    pub matches_current: bool,
}

/// rerere 상태 (CF-29)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RerereStatus {
    pub enabled: bool,
    pub autoupdate: bool,
    /// 이전 해결로 자동 해결된(아직 stage 는 안 된) 경로
    pub resolved_paths: Vec<String>,
}

/// 보관 commit 메시지에 넣는 메타
#[derive(Serialize, Deserialize)]
struct KeepMeta {
    path: String,
    op_key: String,
    stages: [Option<String>; 3],
    resolved: String,
    time: i64,
}

/// 옵션으로 오해될 수 없는 경로인지
fn check_path(path: &str) -> Result<(), CoreError> {
    if path.is_empty() || path.starts_with('-') || path.contains('\0') || path.contains("..") {
        return Err(CoreError::Invalid(messages::bad_path(path)));
    }
    Ok(())
}

/// 스테이지 blob 을 문자열로 (없으면 None)
async fn stage_text(
    runner: &dyn mgit_model::GitRunner,
    work_tree: &Path,
    stage: u8,
    path: &str,
) -> Option<String> {
    show_stage(runner, work_tree, stage, path)
        .await
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// 규칙 설정 키
fn rules_key(work_tree: &Path) -> String {
    format!("conflict-rules:{}", work_tree.display())
}

/// 경로 → 보관 ref 조각
fn path_hash(path: &str) -> String {
    format!("{:x}", Sha256::digest(path.as_bytes()))[..16].to_string()
}

/// `log` 한 줄(`%H%x00%s%x00%an%x00%ct`) 파싱
fn parse_origin(line: &str) -> Option<OriginCommit> {
    let mut f = line.split('\0');
    let oid = Oid::from_hex(f.next()?.trim().as_bytes()).ok()?;
    Some(OriginCommit {
        oid,
        subject: f.next().unwrap_or("").to_string(),
        author: f.next().unwrap_or("").to_string(),
        time: f.next().and_then(|t| t.trim().parse().ok()).unwrap_or(0),
    })
}

impl Core {
    /// 진행 중 작업의 상대 commit 이름과 oid (MERGE_HEAD → CHERRY_PICK_HEAD → REVERT_HEAD → REBASE_HEAD)
    async fn other_head(&self, session: SessionId) -> Option<(&'static str, Oid)> {
        let inner = self.inner_arc();
        let s = inner.get(session).ok()?;
        for name in [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "REBASE_HEAD",
        ] {
            let req = GitRequest::new(&s.info.work_tree, ["rev-parse", "-q", "--verify", name])
                .with_env(EnvProfile::ReadInteractive);
            if let Ok(out) = inner.runner().run(req).await
                && out.exit.success()
                && let Ok(oid) = Oid::from_hex(out.stdout_lossy().trim().as_bytes())
            {
                return Some((name, oid));
            }
        }
        None
    }

    /// 진행 중 작업 식별자
    async fn op_key(&self, session: SessionId) -> String {
        match self.other_head(session).await {
            Some((_, oid)) => oid.to_hex(),
            None => "none".into(),
        }
    }

    /// 경로의 현재 스테이지 blob (unmerged 가 아니면 모두 None)
    pub(crate) async fn stage_oids(&self, session: SessionId, path: &str) -> [Option<Oid>; 3] {
        let Ok(s) = self.inner_arc().get(session) else {
            return [None, None, None];
        };
        let Ok(entries) = list_unmerged(self.inner_arc().runner(), &s.info.work_tree).await else {
            return [None, None, None];
        };
        entries
            .into_iter()
            .find(|e| e.path == path)
            .map(|e| {
                [
                    e.stages[0].map(|x| x.1),
                    e.stages[1].map(|x| x.1),
                    e.stages[2].map(|x| x.1),
                ]
            })
            .unwrap_or([None, None, None])
    }

    /// 이름 변경 충돌 묶음 (CF-16): base 에만 있는 경로와 ours/theirs 에만 있는 경로를 내용 유사도로 짝짓는다
    pub async fn rename_conflicts(
        &self,
        session: SessionId,
    ) -> Result<Vec<RenameConflict>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let files = self.conflicts(session).await?;
        let mut bases = Vec::new();
        let mut ours = Vec::new();
        let mut theirs = Vec::new();
        for f in &files {
            if f.binary || f.submodule {
                continue;
            }
            match f.stages {
                [Some(_), None, None] => {
                    if let Some(t) = stage_text(runner, &s.info.work_tree, 1, &f.path).await {
                        bases.push((f.path.clone(), t));
                    }
                }
                [None, Some(_), None] => {
                    if let Some(t) = stage_text(runner, &s.info.work_tree, 2, &f.path).await {
                        ours.push((f.path.clone(), t));
                    }
                }
                [None, None, Some(_)] => {
                    if let Some(t) = stage_text(runner, &s.info.work_tree, 3, &f.path).await {
                        theirs.push((f.path.clone(), t));
                    }
                }
                _ => {}
            }
        }
        let mut out = Vec::new();
        let mut used_o = std::collections::HashSet::new();
        let mut used_t = std::collections::HashSet::new();
        for (bp, bt) in &bases {
            let best = |cands: &[(String, String)], used: &std::collections::HashSet<String>| {
                cands
                    .iter()
                    .filter(|(p, _)| !used.contains(p))
                    .map(|(p, t)| (p.clone(), similarity(bt, t)))
                    .filter(|(_, sim)| *sim >= RENAME_SIMILARITY)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(p, _)| p)
            };
            let (Some(op), Some(tp)) = (best(&ours, &used_o), best(&theirs, &used_t)) else {
                continue;
            };
            used_o.insert(op.clone());
            used_t.insert(tp.clone());
            out.push(RenameConflict {
                base_path: bp.clone(),
                ours_path: op,
                theirs_path: tp,
            });
        }
        Ok(out)
    }

    /// 이름 변경 충돌 해결 (CF-16): 고른 경로 하나에 3스테이지를 모으고 나머지 경로를 치운다.
    /// 그 경로는 보통의 양쪽 수정 충돌이 되어 편집기로 연다
    pub async fn resolve_rename(
        &self,
        session: SessionId,
        rc: &RenameConflict,
        keep: ConflictSide,
    ) -> Result<String, CoreError> {
        for p in [&rc.base_path, &rc.ours_path, &rc.theirs_path] {
            check_path(p)?;
        }
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let entries = list_unmerged(inner.runner(), &s.info.work_tree).await?;
        let find = |path: &str, stage: usize| {
            entries
                .iter()
                .find(|e| e.path == path)
                .and_then(|e| e.stages[stage])
                .ok_or_else(|| {
                    CoreError::Invalid(tr!(
                        "충돌 스테이지가 없습니다: {path}",
                        "No conflict stage: {path}"
                    ))
                })
        };
        let base = find(&rc.base_path, 0)?;
        let ours = find(&rc.ours_path, 1)?;
        let theirs = find(&rc.theirs_path, 2)?;
        let keep_path = match keep {
            ConflictSide::Ours => rc.ours_path.clone(),
            ConflictSide::Theirs => rc.theirs_path.clone(),
        };
        let other_path = match keep {
            ConflictSide::Ours => rc.theirs_path.clone(),
            ConflictSide::Theirs => rc.ours_path.clone(),
        };
        let info = format!(
            "{:06o} {} 1\t{keep_path}\n{:06o} {} 2\t{keep_path}\n{:06o} {} 3\t{keep_path}\n",
            base.0,
            base.1.to_hex(),
            ours.0,
            ours.1.to_hex(),
            theirs.0,
            theirs.1.to_hex()
        );
        let mut remove: Vec<String> = vec![other_path.clone()];
        if rc.base_path != keep_path && rc.base_path != other_path {
            remove.push(rc.base_path.clone());
        }
        let mut rm_args: Vec<String> =
            vec!["rm".into(), "--cached".into(), "-q".into(), "--".into()];
        rm_args.extend(remove.iter().cloned());
        self.run_write(session, WriteSpec::new(rm_args).skip_refresh())
            .await?;
        self.run_write(
            session,
            WriteSpec::new(["update-index", "--index-info"])
                .with_stdin(info.into_bytes())
                .skip_refresh(),
        )
        .await?;
        let other_full = s.info.work_tree.join(&other_path);
        if other_path != keep_path && other_full.is_file() {
            std::fs::remove_file(&other_full)?;
        }
        self.run_write(
            session,
            WriteSpec::new(["checkout", "-m", "--", &keep_path]),
        )
        .await?;
        Ok(keep_path)
    }

    /// 충돌 파일을 건드린 양쪽 commit (CF-17): `log --left-right HEAD...<other> -- path`
    pub async fn conflict_origins(
        &self,
        session: SessionId,
        path: &str,
    ) -> Result<ConflictOrigins, CoreError> {
        check_path(path)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let Some((name, _)) = self.other_head(session).await else {
            return Ok(ConflictOrigins::default());
        };
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "log",
                "--left-right",
                "--max-count",
                ORIGIN_LIMIT,
                "--format=%m%x00%H%x00%s%x00%an%x00%ct",
                "--end-of-options",
                &format!("HEAD...{name}"),
                "--",
                path,
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = inner.runner().run(req).await?.ok(&display)?;
        let mut origins = ConflictOrigins::default();
        for line in String::from_utf8_lossy(&out).lines() {
            let Some((mark, rest)) = line.split_once('\0') else {
                continue;
            };
            let Some(c) = parse_origin(rest) else {
                continue;
            };
            match mark {
                "<" => origins.ours.push(c),
                ">" => origins.theirs.push(c),
                _ => {}
            }
        }
        if name != "MERGE_HEAD" {
            let req = GitRequest::new(
                &s.info.work_tree,
                [
                    "log",
                    "-1",
                    "--format=%H%x00%s%x00%an%x00%ct",
                    "--end-of-options",
                    name,
                ],
            )
            .with_env(EnvProfile::ReadInteractive);
            if let Ok(out) = inner.runner().run(req).await
                && out.exit.success()
            {
                origins.current = parse_origin(out.stdout_lossy().trim());
            }
        }
        Ok(origins)
    }

    /// 경로별 해결 규칙 (CF-18)
    pub fn conflict_rules(&self, session: SessionId) -> Result<Vec<ConflictRule>, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(self
            .store()
            .setting_get(&rules_key(&s.info.work_tree))
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default())
    }

    /// 규칙 저장
    pub fn set_conflict_rules(
        &self,
        session: SessionId,
        rules: &[ConflictRule],
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get(session)?;
        let cleaned: Vec<ConflictRule> = rules
            .iter()
            .filter(|r| !r.glob.trim().is_empty())
            .cloned()
            .collect();
        let json = serde_json::to_string(&cleaned)
            .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
        self.store()
            .setting_set(&rules_key(&s.info.work_tree), &json)?;
        Ok(())
    }

    /// 규칙을 지금 충돌 중인 텍스트 파일에 적용한다 (CF-18). 경로마다 첫 번째로 맞는 규칙만
    pub async fn apply_conflict_rules(
        &self,
        session: SessionId,
    ) -> Result<Vec<RuleResult>, CoreError> {
        let rules = self.conflict_rules(session)?;
        if rules.is_empty() {
            return Ok(Vec::new());
        }
        let files = self.conflicts(session).await?;
        let mut out = Vec::new();
        for f in files {
            if f.binary || f.submodule {
                continue;
            }
            let Some(rule) = rules.iter().find(|r| glob_match(&r.glob, &f.path)) else {
                continue;
            };
            let r = match &rule.action {
                RuleAction::Ours | RuleAction::Theirs => {
                    let side = if matches!(rule.action, RuleAction::Ours) {
                        ConflictSide::Ours
                    } else {
                        ConflictSide::Theirs
                    };
                    let has = match side {
                        ConflictSide::Ours => f.stages[1].is_some(),
                        ConflictSide::Theirs => f.stages[2].is_some(),
                    };
                    if has {
                        self.resolve_side(session, &f.path, side).await
                    } else {
                        self.resolve_delete(session, &f.path, false).await
                    }
                }
                RuleAction::Union => self.resolve_union(session, &f.path, &f.stages).await,
                RuleAction::Command { cmd } => self.resolve_command(session, &f.path, cmd).await,
            };
            out.push(RuleResult {
                path: f.path.clone(),
                glob: rule.glob.clone(),
                ok: r.is_ok(),
                message: match r {
                    Ok(()) => String::new(),
                    Err(e) => e.to_string(),
                },
            });
        }
        Ok(out)
    }

    /// `merge-file --union` 결과로 해결
    async fn resolve_union(
        &self,
        session: SessionId,
        path: &str,
        stages: &[Option<Oid>; 3],
    ) -> Result<(), CoreError> {
        if stages[1].is_none() || stages[2].is_none() {
            return Err(CoreError::Invalid(
                pick(
                    "양쪽 내용이 있는 충돌만 union 할 수 있습니다",
                    "Only conflicts with content on both sides can be unioned",
                )
                .into(),
            ));
        }
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let empty = self.empty_blob(session).await?;
        let base = stages[0]
            .map(|o| o.to_hex())
            .unwrap_or_else(|| empty.clone());
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "merge-file",
                "-p",
                "--union",
                "--object-id",
                &stages[1].map(|o| o.to_hex()).unwrap_or_default(),
                &base,
                &stages[2].map(|o| o.to_hex()).unwrap_or_default(),
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        if !matches!(out.exit.status, Some(0..=127)) {
            return Err(CoreError::Invalid(messages::merge_file_failed(
                out.exit.stderr.trim(),
            )));
        }
        self.resolve_file(session, path, &out.stdout, false).await
    }

    /// 셸 명령으로 해결: `sh -c <cmd>` (작업 트리에서, `MGIT_PATH` 전달). 0 이면 stage.
    /// 검증 명령과 같은 PATH·시간 제한을 쓴다
    async fn resolve_command(
        &self,
        session: SessionId,
        path: &str,
        cmd: &str,
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get(session)?;
        let envs = crate::verify::command_env(self, &[("MGIT_PATH", path.to_string())]);
        let out = mgit_git::run_shell_command(
            &s.info.work_tree,
            cmd,
            &envs,
            self.config().command_timeout,
        )
        .await?
        .ok_or_else(|| {
            CoreError::Invalid(tr!("명령 시간 초과: {cmd}", "Command timed out: {cmd}"))
        })?;
        if !out.status.success() {
            return Err(CoreError::Invalid(tr!(
                "명령 실패 ({}): {}",
                "Command failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        let stages = self.stage_oids(session, path).await;
        self.run_write(session, WriteSpec::new(["add", "--", path]))
            .await?;
        self.keep_resolution(session, path, stages).await;
        Ok(())
    }

    /// 빈 blob 의 oid (base 가 없는 충돌의 3-way 입력용)
    async fn empty_blob(&self, session: SessionId) -> Result<String, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(&s.info.work_tree, ["hash-object", "-w", "--stdin"])
            .with_env(EnvProfile::Write)
            .with_stdin(Vec::new());
        let display = req.display_args();
        let out = inner.runner().run(req).await?.ok(&display)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }

    /// 설정된 외부 병합 도구 이름 (`merge.tool`)
    pub async fn merge_tool_name(&self, session: SessionId) -> Result<Option<String>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(&s.info.work_tree, ["config", "--get", "merge.tool"])
            .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        Ok(if out.exit.success() {
            Some(out.stdout_lossy().trim().to_string()).filter(|t| !t.is_empty())
        } else {
            None
        })
    }

    /// 외부 병합 도구 열기 (CF-19): `git mergetool --no-prompt -- <path>`. 도구가 성공하면 git 이 stage 한다
    pub async fn open_mergetool(&self, session: SessionId, path: &str) -> Result<(), CoreError> {
        check_path(path)?;
        if self.merge_tool_name(session).await?.is_none() {
            return Err(CoreError::Invalid(pick("merge.tool 이 설정돼 있지 않습니다. `git config --global merge.tool <이름>` 으로 지정하세요", "merge.tool is not set. Set it with `git config --global merge.tool <name>`").into()));
        }
        let stages = self.stage_oids(session, path).await;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(&s.info.work_tree, ["mergetool", "--no-prompt", "--", path])
            .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let r = inner.runner().run(req).await?.ok(&display);
        self.refresh(session).await?;
        r?;
        // 도구가 stage 까지 했으면 보관
        if self.stage_oids(session, path).await == [None, None, None] {
            self.keep_resolution(session, path, stages).await;
        }
        Ok(())
    }

    /// 해결을 보관한다 (CF-28): 스테이지 blob 과 결과 blob 을 tree 로 묶어 `refs/mgit/conflict/<op>/<path>` 에.
    /// 실패해도 해결 자체는 유효하므로 로그만 남긴다
    pub(crate) async fn keep_resolution(
        &self,
        session: SessionId,
        path: &str,
        stages: [Option<Oid>; 3],
    ) {
        if stages.iter().all(Option::is_none) {
            return;
        }
        if let Err(e) = self.keep_resolution_inner(session, path, stages).await {
            tracing::warn!(error = %e, path, "해결 보관 실패");
        }
    }

    /// `keep_resolution` 본체
    async fn keep_resolution_inner(
        &self,
        session: SessionId,
        path: &str,
        stages: [Option<Oid>; 3],
    ) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let wt = &s.info.work_tree;
        // stage 0 의 blob
        let req = GitRequest::new(wt, ["ls-files", "-s", "--", path])
            .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = runner.run(req).await?.ok(&display)?;
        let text = String::from_utf8_lossy(&out);
        let resolved = text
            .lines()
            .filter_map(|l| {
                let mut f = l.split_whitespace();
                let _mode = f.next()?;
                let oid = f.next()?;
                let stage = f.next()?;
                (stage == "0")
                    .then(|| Oid::from_hex(oid.as_bytes()).ok())
                    .flatten()
            })
            .next()
            .ok_or_else(|| {
                CoreError::Invalid(pick("stage 된 결과가 없습니다", "No staged result").into())
            })?;
        let mut tree_in = String::new();
        for (name, oid) in [
            ("base", stages[0]),
            ("ours", stages[1]),
            ("theirs", stages[2]),
            ("resolved", Some(resolved)),
        ] {
            if let Some(o) = oid {
                tree_in.push_str(&format!("100644 blob {}\t{name}\n", o.to_hex()));
            }
        }
        let req = GitRequest::new(wt, ["mktree"])
            .with_env(EnvProfile::Write)
            .with_stdin(tree_in.into_bytes());
        let display = req.display_args();
        let tree = String::from_utf8_lossy(&runner.run(req).await?.ok(&display)?)
            .trim()
            .to_string();
        let op_key = self.op_key(session).await;
        let meta = KeepMeta {
            path: path.to_string(),
            op_key: op_key.clone(),
            stages: [
                stages[0].map(|o| o.to_hex()),
                stages[1].map(|o| o.to_hex()),
                stages[2].map(|o| o.to_hex()),
            ],
            resolved: resolved.to_hex(),
            time: mgit_model::now_millis(),
        };
        let msg = serde_json::to_string(&meta).map_err(|e| {
            CoreError::Invalid(tr!("직렬화 실패: {e}", "Serialization failed: {e}"))
        })?;
        let req =
            GitRequest::new(wt, ["commit-tree", &tree, "-m", &msg]).with_env(EnvProfile::Write);
        let display = req.display_args();
        let commit = String::from_utf8_lossy(&runner.run(req).await?.ok(&display)?)
            .trim()
            .to_string();
        let refname = format!("{KEEP_REF_PREFIX}{op_key}/{}", path_hash(path));
        let req =
            GitRequest::new(wt, ["update-ref", &refname, &commit]).with_env(EnvProfile::Write);
        let display = req.display_args();
        runner.run(req).await?.ok(&display)?;
        Ok(())
    }

    /// 보관된 해결 목록 (CF-28)
    pub async fn kept_resolutions(
        &self,
        session: SessionId,
    ) -> Result<Vec<KeptResolution>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let current = self.op_key(session).await;
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "for-each-ref",
                "--format=%(refname)%00%(objectname)",
                KEEP_REF_PREFIX,
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = runner.run(req).await?.ok(&display)?;
        let mut list = Vec::new();
        for line in String::from_utf8_lossy(&out).lines() {
            let Some((_, commit)) = line.split_once('\0') else {
                continue;
            };
            let req = GitRequest::new(&s.info.work_tree, ["cat-file", "-p", commit.trim()])
                .with_env(EnvProfile::ReadInteractive);
            let Ok(o) = runner.run(req).await else {
                continue;
            };
            let body = o.stdout_lossy();
            let Some((_, msg)) = body.split_once("\n\n") else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<KeepMeta>(msg.trim()) else {
                continue;
            };
            let oid =
                |x: &Option<String>| x.as_ref().and_then(|h| Oid::from_hex(h.as_bytes()).ok());
            let Ok(resolved) = Oid::from_hex(meta.resolved.as_bytes()) else {
                continue;
            };
            list.push(KeptResolution {
                path: meta.path,
                matches_current: meta.op_key == current,
                op_key: meta.op_key,
                stages: [
                    oid(&meta.stages[0]),
                    oid(&meta.stages[1]),
                    oid(&meta.stages[2]),
                ],
                resolved,
                time: meta.time,
            });
        }
        list.sort_by_key(|k| std::cmp::Reverse(k.time));
        Ok(list)
    }

    /// 보관된 해결을 다시 적용한다 (CF-28): 같은 작업·같은 스테이지의 충돌 경로에 결과 blob 을 쓰고 stage.
    /// 적용한 수를 돌려준다
    pub async fn reapply_resolutions(&self, session: SessionId) -> Result<u32, CoreError> {
        let kept = self.kept_resolutions(session).await?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let entries = list_unmerged(inner.runner(), &s.info.work_tree).await?;
        let mut n = 0;
        for k in kept.into_iter().filter(|k| k.matches_current) {
            let Some(e) = entries.iter().find(|e| e.path == k.path) else {
                continue;
            };
            let cur = [
                e.stages[0].map(|x| x.1),
                e.stages[1].map(|x| x.1),
                e.stages[2].map(|x| x.1),
            ];
            if cur != k.stages {
                continue;
            }
            let req = GitRequest::new(
                &s.info.work_tree,
                ["cat-file", "blob", &k.resolved.to_hex()],
            )
            .with_env(EnvProfile::ReadInteractive);
            let display = req.display_args();
            let bytes = inner.runner().run(req).await?.ok(&display)?;
            let full = s.info.work_tree.join(&k.path);
            // 심볼릭 링크로 쓰면 링크 대상 파일이 바뀐다
            if full
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                continue;
            }
            std::fs::write(&full, &bytes)?;
            self.run_write(
                session,
                WriteSpec::new(["add", "--", &k.path]).skip_refresh(),
            )
            .await?;
            n += 1;
        }
        self.refresh(session).await?;
        Ok(n)
    }

    /// 보관된 해결을 모두 지운다
    pub async fn kept_clear(&self, session: SessionId) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            ["for-each-ref", "--format=%(refname)", KEEP_REF_PREFIX],
        )
        .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = inner.runner().run(req).await?.ok(&display)?;
        for name in String::from_utf8_lossy(&out).lines() {
            let req = GitRequest::new(&s.info.work_tree, ["update-ref", "-d", name.trim()])
                .with_env(EnvProfile::Write);
            let _ = inner.runner().run(req).await;
        }
        Ok(())
    }

    /// 해결 내역 리뷰 (CF-27): 보관된 스테이지로 git 자동 병합을 다시 만들어 저장한 결과와 비교
    pub async fn resolution_review(
        &self,
        session: SessionId,
        path: &str,
    ) -> Result<ResolutionReview, CoreError> {
        check_path(path)?;
        let kept = self
            .kept_resolutions(session)
            .await?
            .into_iter()
            .find(|k| k.path == path)
            .ok_or_else(|| {
                CoreError::Invalid(tr!(
                    "보관된 해결이 없습니다: {path}",
                    "No kept resolution: {path}"
                ))
            })?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let wt = &s.info.work_tree;
        let empty = self.empty_blob(session).await?;
        let hex = |o: Option<Oid>| o.map(|x| x.to_hex()).unwrap_or_else(|| empty.clone());
        let req = GitRequest::new(
            wt,
            [
                "merge-file",
                "--object-id",
                "--diff-algorithm=histogram",
                &hex(kept.stages[1]),
                &hex(kept.stages[0]),
                &hex(kept.stages[2]),
            ],
        )
        .with_env(EnvProfile::Write);
        let out = runner.run(req).await?;
        let auto_had_conflicts = match out.exit.status {
            Some(0) => false,
            Some(1..=127) => true,
            _ => {
                return Err(CoreError::Invalid(messages::merge_file_failed(
                    out.exit.stderr.trim(),
                )));
            }
        };
        let auto_oid = out.stdout_lossy().trim().to_string();
        let cat = |oid: String| async move {
            let req = GitRequest::new(wt, ["cat-file", "blob", &oid])
                .with_env(EnvProfile::ReadInteractive);
            let display = req.display_args();
            runner
                .run(req)
                .await?
                .ok(&display)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .map_err(CoreError::from)
        };
        let auto = cat(auto_oid.clone()).await?;
        let resolved = cat(kept.resolved.to_hex()).await?;
        let req = GitRequest::new(
            wt,
            [
                "diff",
                "--no-color",
                "--end-of-options",
                &auto_oid,
                &kept.resolved.to_hex(),
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = runner.run(req).await?;
        let diff = if matches!(out.exit.status, Some(0 | 1)) {
            out.stdout_lossy()
        } else {
            String::new()
        };
        Ok(ResolutionReview {
            path: path.to_string(),
            auto,
            resolved,
            diff,
            auto_had_conflicts,
        })
    }

    /// 머지 commit 의 해결 diff (CF-27): `show --remerge-diff`
    pub async fn remerge_diff(&self, session: SessionId, oid: &Oid) -> Result<String, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "show",
                "--remerge-diff",
                "--format=",
                "--no-color",
                "--end-of-options",
                &oid.to_hex(),
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let display = req.display_args();
        let out = inner.runner().run(req).await?.ok(&display)?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// rerere 상태 (CF-29): 설정과, 이전 해결로 자동 해결된 경로(unmerged − `rerere remaining`)
    pub async fn rerere_status(&self, session: SessionId) -> Result<RerereStatus, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let runner = inner.runner();
        let enabled = config_get_bool(runner, &s.info.work_tree, "rerere.enabled")
            .await
            .unwrap_or(false);
        let autoupdate = config_get_bool(runner, &s.info.work_tree, "rerere.autoupdate")
            .await
            .unwrap_or(false);
        let mut status = RerereStatus {
            enabled,
            autoupdate,
            resolved_paths: Vec::new(),
        };
        if !enabled {
            return Ok(status);
        }
        let unmerged: Vec<String> = list_unmerged(runner, &s.info.work_tree)
            .await?
            .into_iter()
            .map(|e| e.path)
            .collect();
        if unmerged.is_empty() {
            return Ok(status);
        }
        let req = GitRequest::new(&s.info.work_tree, ["rerere", "remaining"])
            .with_env(EnvProfile::ReadInteractive);
        let out = runner.run(req).await?;
        if !out.exit.success() {
            return Ok(status);
        }
        let remaining: std::collections::HashSet<String> = out
            .stdout_lossy()
            .lines()
            .map(|l| l.trim().to_string())
            .collect();
        let mut seen = std::collections::HashSet::new();
        status.resolved_paths = unmerged
            .into_iter()
            .filter(|p| !remaining.contains(p) && seen.insert(p.clone()))
            .collect();
        Ok(status)
    }

    /// rerere 켜기/끄기 (저장소 로컬 설정)
    pub async fn rerere_set(
        &self,
        session: SessionId,
        enabled: bool,
        autoupdate: bool,
    ) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        for (key, value) in [
            ("rerere.enabled", enabled),
            ("rerere.autoupdate", autoupdate),
        ] {
            let req = GitRequest::new(
                &s.info.work_tree,
                [
                    "config",
                    "--local",
                    key,
                    if value { "true" } else { "false" },
                ],
            )
            .with_env(EnvProfile::Write);
            let display = req.display_args();
            inner.runner().run(req).await?.ok(&display)?;
        }
        Ok(())
    }

    /// 이 경로의 rerere 기록을 잊는다 (CF-29). 작업 트리는 자동 병합 결과로 다시 만든다
    pub async fn rerere_forget(&self, session: SessionId, path: &str) -> Result<(), CoreError> {
        check_path(path)?;
        self.run_write(session, WriteSpec::new(["rerere", "forget", "--", path]))
            .await?;
        Ok(())
    }
}

/// 충돌 종류가 텍스트 3-way 로 다룰 수 있는지
pub fn is_three_way(kind: ConflictKind) -> bool {
    matches!(kind, ConflictKind::BothModified | ConflictKind::BothAdded)
}
