//! 안전장치 (SF-03 Undo/Redo, SF-04 백업 ref, AD-02 reflog, CHG-07 템플릿, CHG-10 ignore)

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use mgit_git::cmd::{commit_template, head_state, list_reflog, list_worktrees, ref_snapshot};
use mgit_l10n::{pick, tr};
use mgit_model::{
    BackupRef, CommitTemplate, EnvProfile, GitRequest, HeadRef, Oid, RefRollback, RefSnapshot,
    ReflogEntry, UndoEntryInfo, UndoResult,
};

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::SessionId;
use crate::merge_ops::ResetMode;
use crate::messages;
use crate::session::RepoSession;
use crate::write::WriteSpec;

/// 백업 ref 네임스페이스
pub const BACKUP_NS: &str = "refs/mgit/backup/";
/// 백업 이름 일련번호
pub(crate) static BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);
/// 설정 키: 앱 커밋 템플릿 목록
const TEMPLATES_KEY: &str = "commitTemplates";

/// undo 항목: 쓰기 명령 전후 스냅샷
#[derive(Clone, Debug)]
pub struct UndoEntry {
    pub id: u64,
    pub label: String,
    pub at: i64,
    pub before: RefSnapshot,
    pub after: RefSnapshot,
}

impl UndoEntry {
    /// 바뀐 ref 수 (HEAD 포함)
    fn changed(&self) -> u32 {
        let script = RefSnapshot::transition_script(&self.before, &self.after);
        let n = script.lines().count() as u32;
        if self.before.head != self.after.head {
            n + 1
        } else {
            n
        }
    }

    /// 표시용
    fn info(&self) -> UndoEntryInfo {
        UndoEntryInfo {
            id: self.id,
            label: self.label.clone(),
            at: self.at,
            changed: self.changed(),
        }
    }
}

/// 세션별 undo/redo 스택 (메모리)
#[derive(Debug, Default)]
pub struct UndoStack {
    undo: VecDeque<UndoEntry>,
    redo: Vec<UndoEntry>,
    next_id: u64,
}

impl UndoStack {
    /// 새 항목을 쌓는다 (redo 는 비운다)
    pub fn push(&mut self, label: String, before: RefSnapshot, after: RefSnapshot, cap: usize) {
        self.next_id += 1;
        self.undo.push_back(UndoEntry {
            id: self.next_id,
            label,
            at: now_millis(),
            before,
            after,
        });
        while self.undo.len() > cap {
            self.undo.pop_front();
        }
        self.redo.clear();
    }

    /// 최근 순 목록
    pub fn entries(&self) -> Vec<UndoEntryInfo> {
        self.undo.iter().rev().map(UndoEntry::info).collect()
    }

    /// redo 가능 수
    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }
}

/// epoch 밀리초
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// epoch 초
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 옵션으로 오해될 수 없는 값인지
fn check_arg(v: &str) -> Result<(), CoreError> {
    if v.is_empty() || v.starts_with('-') || v.contains('\0') || v.contains("..") {
        return Err(CoreError::Invalid(messages::bad_value(v)));
    }
    Ok(())
}

impl CoreInner {
    /// 현재 ref 스냅샷
    pub(crate) async fn snapshot(&self, session: &RepoSession) -> Option<RefSnapshot> {
        ref_snapshot(self.runner(), &session.info.work_tree)
            .await
            .ok()
    }

    /// 한 작업의 변경을 되돌린다 (undo/redo 공용): 그 작업이 `from` → `to` 로 바꾼 ref 중 지금 값이
    /// `from` 그대로인 것만 옮긴다. 그 사이 외부에서 바뀐 ref 는 건너뛰고 결과에 담는다
    async fn roll_refs(
        self: &Arc<Self>,
        session: &Arc<RepoSession>,
        from: &RefSnapshot,
        to: &RefSnapshot,
    ) -> Result<RefRollback, CoreError> {
        let current = self.snapshot(session).await.ok_or_else(|| {
            CoreError::Invalid(
                pick("ref 상태를 읽지 못했습니다", "Could not read ref state").into(),
            )
        })?;
        let plan = RefSnapshot::rollback_plan(from, to, &current);
        if !plan.script.is_empty() {
            self.run_write(
                session,
                WriteSpec::new(["update-ref", "--stdin"])
                    .with_stdin(plan.script.clone().into_bytes())
                    .no_undo()
                    .skip_refresh(),
            )
            .await?;
        }
        if let Some(head) = &plan.head {
            let spec = match head {
                HeadRef::Symbolic { target } => {
                    WriteSpec::new(["symbolic-ref", "HEAD", target.as_str()])
                }
                HeadRef::Detached { oid } => {
                    WriteSpec::new(["update-ref", "--no-deref", "HEAD", oid.to_hex().as_str()])
                }
            };
            self.run_write(session, spec.no_undo().skip_refresh())
                .await?;
        }
        self.refresh_session(session, crate::refresh::RefreshScope::all(true))
            .await;
        Ok(plan)
    }
}

impl Core {
    /// undo 목록 (최근 순)
    pub fn undo_entries(
        &self,
        session: SessionId,
    ) -> Result<(Vec<UndoEntryInfo>, usize), CoreError> {
        let s = self.inner_arc().get(session)?;
        let stack = s.undo.lock().unwrap_or_else(PoisonError::into_inner);
        Ok((stack.entries(), stack.redo_len()))
    }

    /// 직전 작업의 ref 변경을 되돌린다 (SF-03). 작업 트리·인덱스는 그대로 둔다.
    /// 그 작업 뒤에 외부에서 바뀐 ref 는 건너뛰고 `skipped` 로 알린다
    pub async fn undo(&self, session: SessionId) -> Result<Option<UndoResult>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let entry = {
            let mut stack = s.undo.lock().unwrap_or_else(PoisonError::into_inner);
            stack.undo.pop_back()
        };
        let Some(entry) = entry else {
            return Ok(None);
        };
        let rolled = inner.roll_refs(&s, &entry.after, &entry.before).await;
        let info = entry.info();
        let mut stack = s.undo.lock().unwrap_or_else(PoisonError::into_inner);
        match rolled {
            Ok(plan) => {
                // 아무것도 되돌리지 못했으면 다시 실행할 것도 없다
                if !plan.is_empty() {
                    stack.redo.push(entry);
                }
                Ok(Some(UndoResult {
                    entry: info,
                    skipped: plan.skipped,
                }))
            }
            Err(e) => {
                stack.undo.push_back(entry);
                Err(e)
            }
        }
    }

    /// 되돌린 작업을 다시 적용한다. undo 뒤에 외부에서 바뀐 ref 는 건너뛴다
    pub async fn redo(&self, session: SessionId) -> Result<Option<UndoResult>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let entry = {
            let mut stack = s.undo.lock().unwrap_or_else(PoisonError::into_inner);
            stack.redo.pop()
        };
        let Some(entry) = entry else {
            return Ok(None);
        };
        let rolled = inner.roll_refs(&s, &entry.before, &entry.after).await;
        let info = entry.info();
        let mut stack = s.undo.lock().unwrap_or_else(PoisonError::into_inner);
        match rolled {
            Ok(plan) => {
                if !plan.is_empty() {
                    stack.undo.push_back(entry);
                }
                Ok(Some(UndoResult {
                    entry: info,
                    skipped: plan.skipped,
                }))
            }
            Err(e) => {
                stack.redo.push(entry);
                Err(e)
            }
        }
    }

    /// 파괴적 작업 전 백업 ref 를 만든다 (SF-04). `branch` 의 현재 oid 를 `refs/mgit/backup/<branch>/<ts>-<seq>` 에
    pub async fn backup_ref(
        &self,
        session: SessionId,
        branch: &str,
        reason: &str,
    ) -> Result<Option<BackupRef>, CoreError> {
        self.backup_ref_guarded(session, branch, reason, None).await
    }

    /// 메시지 수정은 백업 ref를 쓰기 직전에도 원격 게시 여부를 검사한다. 호출자는 검사 실패를 무시하지 않는다.
    pub(crate) async fn backup_ref_guarded(
        &self,
        session: SessionId,
        branch: &str,
        reason: &str,
        unpublished_commit: Option<Oid>,
    ) -> Result<Option<BackupRef>, CoreError> {
        check_arg(branch)?;
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let full = format!("refs/heads/{branch}");
        let oid = {
            let st = s.state();
            st.refs
                .labels
                .iter()
                .find(|l| l.full_name == full)
                .map(|l| l.target)
        };
        let Some(oid) = oid else {
            return Ok(None);
        };
        let ts = now_secs();
        // 같은 초의 백업이 서로를 덮지 않게 일련번호를 붙인다
        let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
        let name = format!("{BACKUP_NS}{branch}/{ts}-{seq:06}");
        let msg = format!("mgit backup: {reason}");
        let hex = oid.to_hex();
        self.run_write(
            session,
            WriteSpec::new([
                "update-ref",
                "-m",
                msg.as_str(),
                name.as_str(),
                hex.as_str(),
            ])
            .guard_unpublished(unpublished_commit)
            .no_undo()
            .skip_refresh(),
        )
        .await?;
        Ok(Some(BackupRef {
            name,
            branch: branch.to_string(),
            oid,
            created_at: ts,
            reason: reason.to_string(),
        }))
    }

    /// 백업 ref 목록 (최근 순)
    pub async fn backup_refs(&self, session: SessionId) -> Result<Vec<BackupRef>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let req = GitRequest::new(
            &s.info.work_tree,
            [
                "for-each-ref",
                "--format=%(refname)%00%(objectname)%00%(contents:subject)",
                BACKUP_NS.trim_end_matches('/'),
            ],
        )
        .with_env(EnvProfile::ReadInteractive);
        let out = inner.runner().run(req).await?;
        let mut list: Vec<BackupRef> = out
            .stdout_lossy()
            .lines()
            .filter_map(|line| {
                let mut f = line.split('\0');
                let name = f.next()?.to_string();
                let oid = Oid::from_hex(f.next()?.trim().as_bytes()).ok()?;
                let rest = name.strip_prefix(BACKUP_NS)?;
                let (branch, stamp) = rest.rsplit_once('/')?;
                // `<초>-<일련번호>`. 일련번호가 없는 옛 이름도 읽는다
                let ts = stamp.split('-').next()?;
                Some(BackupRef {
                    name: name.clone(),
                    branch: branch.to_string(),
                    oid,
                    created_at: ts.parse().ok()?,
                    reason: String::new(),
                })
            })
            .collect();
        list.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.name.cmp(&a.name))
        });
        Ok(list)
    }

    /// 백업을 브랜치로 되살린다 (`branch <name> <oid>`), 또는 `name` 이 없으면 원래 브랜치를 그 지점으로
    /// 되돌린다. 체크아웃된 브랜치면 `reset --hard`, 다른 워크트리에 체크아웃돼 있으면 거부한다
    pub async fn backup_restore(
        &self,
        session: SessionId,
        backup: &str,
        new_branch: Option<&str>,
    ) -> Result<(), CoreError> {
        let b = self
            .backup_refs(session)
            .await?
            .into_iter()
            .find(|b| b.name == backup)
            .ok_or_else(|| {
                CoreError::Invalid(tr!(
                    "백업이 없습니다: {backup}",
                    "Backup not found: {backup}"
                ))
            })?;
        match new_branch {
            Some(name) => {
                check_arg(name)?;
                self.run_write(
                    session,
                    WriteSpec::new(["branch", "--end-of-options", name, b.oid.to_hex().as_str()])
                        .label(format!("backup restore → {name}")),
                )
                .await?;
            }
            None => {
                let full = format!("refs/heads/{}", b.branch);
                let inner = self.inner_arc();
                let s = inner.get(session)?;
                let wt = &s.info.work_tree;
                // 체크아웃된 브랜치를 update-ref 로 옮기면 작업 트리·index 가 어긋난다
                if head_state(inner.runner(), wt).await?.branch() == Some(full.as_str()) {
                    return self.reset(session, &b.oid.to_hex(), ResetMode::Hard).await;
                }
                let elsewhere = list_worktrees(inner.runner(), wt)
                    .await?
                    .into_iter()
                    .find(|w| w.prunable.is_none() && w.branch.as_deref() == Some(full.as_str()));
                if let Some(w) = elsewhere {
                    return Err(CoreError::Invalid(tr!(
                        "다른 워크트리에 체크아웃된 브랜치는 되돌릴 수 없습니다: {} ({})",
                        "Cannot restore a branch checked out in another worktree: {} ({})",
                        b.branch,
                        w.path.display()
                    )));
                }
                self.run_write(
                    session,
                    WriteSpec::new(["update-ref", full.as_str(), b.oid.to_hex().as_str()])
                        .label(format!("backup restore {}", b.branch)),
                )
                .await?;
            }
        }
        Ok(())
    }

    /// 백업 ref 삭제
    pub async fn backup_delete(&self, session: SessionId, backup: &str) -> Result<(), CoreError> {
        if !backup.starts_with(BACKUP_NS) {
            return Err(CoreError::Invalid(
                pick("백업 ref 가 아닙니다", "Not a backup ref").into(),
            ));
        }
        self.run_write(
            session,
            WriteSpec::new(["update-ref", "-d", backup]).no_undo(),
        )
        .await?;
        Ok(())
    }

    /// 보관 기간이 지난 백업을 지운다 (세션 열 때). 지운 수를 돌려준다
    pub async fn prune_backups(&self, session: SessionId) -> Result<usize, CoreError> {
        let keep = self.config().backup_keep_days;
        let cutoff = now_secs() - i64::from(keep) * 86_400;
        let old: Vec<BackupRef> = self
            .backup_refs(session)
            .await?
            .into_iter()
            .filter(|b| b.created_at < cutoff)
            .collect();
        if old.is_empty() {
            return Ok(0);
        }
        let script: String = old.iter().map(|b| format!("delete {}\n", b.name)).collect();
        self.run_write(
            session,
            WriteSpec::new(["update-ref", "--stdin"])
                .with_stdin(script.into_bytes())
                .no_undo()
                .skip_refresh(),
        )
        .await?;
        Ok(old.len())
    }

    /// reflog (AD-02). `reference` 가 없으면 HEAD
    pub async fn reflog(
        &self,
        session: SessionId,
        reference: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ReflogEntry>, CoreError> {
        if let Some(r) = reference {
            check_arg(r)?;
        }
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        Ok(list_reflog(
            inner.runner(),
            &s.info.work_tree,
            reference,
            limit.clamp(1, 5000),
        )
        .await?)
    }

    /// reflog 항목에서 브랜치를 되살린다
    pub async fn reflog_restore(
        &self,
        session: SessionId,
        oid: &Oid,
        new_branch: &str,
    ) -> Result<(), CoreError> {
        check_arg(new_branch)?;
        self.run_write(
            session,
            WriteSpec::new([
                "branch",
                "--end-of-options",
                new_branch,
                oid.to_hex().as_str(),
            ])
            .label(format!("reflog restore → {new_branch}")),
        )
        .await?;
        Ok(())
    }

    /// `.gitignore` 에 패턴을 추가한다 (CHG-10). 이미 있으면 건너뛴다
    pub async fn ignore_add(
        &self,
        session: SessionId,
        patterns: &[String],
    ) -> Result<(), CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let path = s.info.work_tree.join(".gitignore");
        // 인코딩을 모르므로 바이트로 다룬다. 읽기 실패를 빈 파일로 보면 기존 내용을 덮어쓰게 된다
        let existing = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let have: std::collections::HashSet<&[u8]> = existing
            .split(|&b| b == b'\n')
            .map(<[u8]>::trim_ascii)
            .collect();
        let mut out = existing.clone();
        if !out.is_empty() && !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        let mut added = 0;
        for p in patterns {
            let p = p.trim();
            if p.is_empty() || have.contains(p.as_bytes()) {
                continue;
            }
            out.extend_from_slice(p.as_bytes());
            out.push(b'\n');
            added += 1;
        }
        if added > 0 {
            std::fs::write(&path, out)?;
            inner
                .refresh_session(&s, crate::refresh::RefreshScope::all(true))
                .await;
        }
        Ok(())
    }

    /// 커밋 메시지 템플릿 목록 (CHG-07): git `commit.template` + 앱 템플릿(설정)
    pub async fn commit_templates(
        &self,
        session: SessionId,
    ) -> Result<Vec<CommitTemplate>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let mut list = Vec::new();
        if let Some(t) = commit_template(inner.runner(), &s.info.work_tree).await {
            list.push(t);
        }
        if let Ok(Some(json)) = self.store().setting_get(TEMPLATES_KEY)
            && let Ok(mut app) = serde_json::from_str::<Vec<CommitTemplate>>(&json)
        {
            list.append(&mut app);
        }
        Ok(list)
    }

    /// 앱 템플릿 저장
    pub fn set_app_commit_templates(&self, templates: &[CommitTemplate]) -> Result<(), CoreError> {
        let json = serde_json::to_string(templates).map_err(|e| {
            CoreError::Invalid(tr!(
                "템플릿 직렬화 실패: {e}",
                "Failed to serialize templates: {e}"
            ))
        })?;
        self.store().setting_set(TEMPLATES_KEY, &json)?;
        Ok(())
    }

    /// 앱 템플릿만 (설정)
    pub fn app_commit_templates(&self) -> Vec<CommitTemplate> {
        self.store()
            .setting_get(TEMPLATES_KEY)
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default()
    }
}

impl Core {
    /// HEAD 브랜치의 짧은 이름 (detached 면 None)
    pub(crate) fn head_branch_name(&self, session: SessionId) -> Option<String> {
        let s = self.inner_arc().get(session).ok()?;
        let st = s.state();
        st.refs
            .head
            .branch()
            .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
    }
}

impl Core {
    /// 남은 `index.lock` 을 지운다 (SF-05). 1분 안에 만들어진 파일은 다른 git 이 쓰는 중일 수 있어 거부한다
    pub fn remove_index_lock(&self, session: SessionId) -> Result<bool, CoreError> {
        let s = self.inner_arc().get(session)?;
        let lock = s.info.git_dir.join("index.lock");
        let Ok(meta) = std::fs::metadata(&lock) else {
            return Ok(false);
        };
        let age = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .unwrap_or_default();
        if age.as_secs() < 60 {
            return Err(CoreError::Invalid(
                pick(
                    "index.lock 이 방금 만들어졌습니다. 다른 git 명령이 끝나길 기다리세요",
                    "index.lock was just created. Wait for the other git command to finish",
                )
                .into(),
            ));
        }
        std::fs::remove_file(&lock)?;
        Ok(true)
    }
}
