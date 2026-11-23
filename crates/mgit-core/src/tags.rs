//! tag 관리 (BR-06, TG-01~18): 고른 원격으로 tag push, 원격·로컬 tag 삭제, 원격 tag 상태 보고서.
//!
//! 원격 쓰기는 tag 별 결과가 필요하므로 `--porcelain` 결과 표를 읽는다. 결과 표는 실패해도 stdout 에 있으므로
//! `keep_failed_output` 으로 받는다. 많은 tag 는 인자 예산(`CoreConfig::tag_chunk_*`)으로 나눠 여러 명령을 돌리되
//! op 는 하나로 잇고(`keep_op_open`), 마지막에 결과 요약으로 한 번 닫는다. `--atomic` 은 쓰지 않는다 (D9)

use std::collections::{HashMap, HashSet};

use std::time::Instant;

use mgit_git::cmd::tag_objects;
use mgit_git::parse::{
    FetchFlag, PushFlag, PushRefLine, parse_fetch_porcelain, parse_ls_remote_tags,
    parse_push_porcelain,
};
use mgit_model::{
    GitHint, LocalTag, LocalTagRef, Oid, RefKind, RefLabel, RemoteInfo, RemoteTag, TagLookupError,
    TagLookupErrorKind, TagRefResult, TagRefStatus, TagSyncReport, compare_tags, now_millis,
};

use crate::core::{Core, CoreInner};
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;
use crate::ops::OpHandle;
use crate::refname::check_tag_name;
use crate::session::RepoSession;
use crate::state::RepoRefs;
use crate::sync::split_upstream;
use crate::tag_cache::RemoteTagCache;
use crate::write::WriteSpec;

/// tag ref 접두
const TAGS_PREFIX: &str = "refs/tags/";

/// 청크로 나눠 돌릴 ref 하나
#[derive(Clone, Debug)]
pub(crate) struct RefItem {
    /// tag 이름 (`refs/tags/` 뒤)
    pub name: String,
    /// `--end-of-options` 앞에 붙는 그 ref 만의 옵션 (원격 삭제의 `--force-with-lease=…`)
    pub opts: Vec<String>,
    /// 원격 이름 뒤에 붙는 refspec
    pub refspec: String,
}

impl RefItem {
    /// 인자 예산에서 차지하는 바이트 (인자마다 구분자 1바이트)
    fn cost(&self) -> usize {
        self.opts.iter().map(|o| o.len() + 1).sum::<usize>() + self.refspec.len() + 1
    }
}

/// 인자 예산에 맞춰 차례대로 나눈다. 하나가 예산을 넘어도 그것만 담은 청크를 만든다
pub(crate) fn chunk_items(items: &[RefItem], max_bytes: usize, max_refs: usize) -> Vec<&[RefItem]> {
    let max_refs = max_refs.max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (i, item) in items.iter().enumerate() {
        let cost = item.cost();
        let count = i - start;
        if count > 0 && (count >= max_refs || bytes + cost > max_bytes) {
            chunks.push(&items[start..i]);
            start = i;
            bytes = 0;
        }
        bytes += cost;
    }
    if start < items.len() {
        chunks.push(&items[start..]);
    }
    chunks
}

/// 청크로 돌릴 원격 ref 명령 (push·원격 삭제·가져오기가 함께 쓴다)
pub(crate) struct ChunkedCommand<'a> {
    /// 서브커맨드와 공통 옵션 (`push --porcelain …`)
    pub prefix: Vec<String>,
    pub remote: &'a str,
    pub items: Vec<RefItem>,
    /// 청크 하나의 결과 표(stdout)를 tag 이름별 결과로 해석한다
    pub parse: fn(&str) -> HashMap<String, TagRefResult>,
    /// 진행률 줄을 op 진행률로 바꿀지 (객체를 보내는 push·fetch)
    pub progress: bool,
    /// 로컬 ref 를 바꾸는 명령이면 undo 라벨. 청크가 여럿이어도 전후 스냅샷으로 undo 항목을 하나만 쌓는다
    pub undo_label: Option<String>,
}

/// 청크 실행 결과. `cancelled` 면 끝나지 않은 ref 는 `unknown` 으로 채워져 있다
#[derive(Debug, Default)]
pub(crate) struct ChunkOutcome {
    pub results: Vec<TagRefResult>,
    pub cancelled: bool,
}

/// 원격 삭제 요청 하나 (TG-04)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagDeleteItem {
    /// tag 이름 (`refs/tags/` 뒤)
    pub name: String,
    /// `Diverged` 를 확인한 뒤 다시 부를 때 넘기는, 그때 본 원격 객체(`TagRefResult::remote_oid`). 있으면 로컬 대신
    /// 이 값과 비교한다 — 그 사이 원격이 또 바뀌었으면 다시 `Diverged`
    pub expected_remote: Option<Oid>,
}

/// 원격 tag 를 로컬 것으로 덮어쓰는 요청 하나 (TG-15 "로컬 것으로 맞추기")
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagLeaseItem {
    /// tag 이름 (`refs/tags/` 뒤)
    pub name: String,
    /// 확인한 원격 객체 (`Diverged`·`RejectedExists` 결과나 원격 상태의 `remote_oid`). 지금 원격이 이 값일 때만 덮어쓴다
    pub expected_remote: Oid,
}

/// 이 수를 넘으면 이름별 패턴 대신 전체를 조회한다 (TG-04 ①, 원격 삭제의 실행 직전 조회도 같다).
/// `ls-remote` 의 이름 패턴은 원격이 광고한 ref 전체에 대해 클라이언트가 맞춰 보므로 비용이 패턴 수 × ref 수다.
/// B4 실측(릴리스, 중앙값, tag 5만 개 원격): 이름 1개 139ms, 패턴 50개 557ms, 전체 165ms — 손익분기가 약 4개
const LOOKUP_ALL_ABOVE: usize = 4;

impl Core {
    /// 고른 원격으로 tag 들을 push 한다 (TG-01). 하나도 같은 경로다 (D8).
    ///
    /// `push --porcelain --progress --no-follow-tags --end-of-options <원격> refs/tags/<n>:refs/tags/<n>…` 를 청크로 돈다.
    /// `push.followTags=true` 여도, 같은 이름의 branch 가 있어도 요청한 tag 만 간다. 결과는 이름 순서 그대로
    /// tag 마다 `pushed / upToDate / rejectedExists / rejectedStale / rejectedRemote / failed / unknown` 중 하나다.
    /// undo 항목은 만들지 않는다. 첫 청크가 결과 표 없이 통째로 실패하면(인증·연결) `CommandFailed` 로 돌려준다.
    /// `op` 는 끝에 한 번 닫는다 (모두 성공이면 `ok`, 아니면 요약 문구)
    pub async fn push_tags(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
        op: Option<OpHandle>,
    ) -> Result<Vec<TagRefResult>, CoreError> {
        let outcome = self
            .push_tags_inner(session, remote, names, op.as_ref())
            .await;
        self.close_tag_op(session, op.as_ref(), outcome)
    }

    /// `push_tags` 본체 (op 닫기 전)
    async fn push_tags_inner(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
        op: Option<&OpHandle>,
    ) -> Result<ChunkOutcome, CoreError> {
        let names = self.validate_tag_request(session, remote, names)?;
        let items = names
            .into_iter()
            .map(|name| RefItem {
                refspec: format!("{TAGS_PREFIX}{name}:{TAGS_PREFIX}{name}"),
                name,
                opts: Vec::new(),
            })
            .collect();
        let cmd = ChunkedCommand {
            prefix: vec![
                "push".into(),
                "--porcelain".into(),
                "--progress".into(),
                "--no-follow-tags".into(),
            ],
            remote,
            items,
            parse: parse_push_results,
            progress: true,
            undo_label: None,
        };
        let outcome = self.run_chunked(session, op, cmd).await?;
        self.patch_after_push(session, remote, &outcome.results);
        Ok(outcome)
    }

    /// 원격 tag 를 로컬 것으로 덮어쓴다 (TG-15 "로컬 것으로 맞추기"). 항목마다 확인한 원격 값으로 lease 를 건 push 한 번이다:
    /// `push --porcelain --progress --no-follow-tags --force-with-lease=refs/tags/<n>:<expected> --end-of-options <원격>
    /// refs/tags/<n>:refs/tags/<n>…` (청크). lease 가 맞으면 `--force` 없이도 덮어쓴다(관문 G13 기록). 삭제 뒤 push 두
    /// 단계와 달리 사이에서 실패해 원격 tag 가 사라진 채 남는 일이 없다. `--force` 단독 경로는 없다.
    ///
    /// 결과는 tag 마다 `pushed`(덮어씀) / `upToDate`(이미 로컬과 같음) / `rejectedStale`(그 사이 원격이 바뀜 — 원격 그대로) /
    /// `rejectedRemote` / `failed` / `unknown`. undo 항목은 없다. 첫 청크가 통째로 실패하면 `CommandFailed`
    pub async fn replace_remote_tags(
        &self,
        session: SessionId,
        remote: &str,
        items: &[TagLeaseItem],
        op: Option<OpHandle>,
    ) -> Result<Vec<TagRefResult>, CoreError> {
        let outcome = self
            .replace_remote_inner(session, remote, items, op.as_ref())
            .await;
        self.close_tag_op(session, op.as_ref(), outcome)
    }

    /// `replace_remote_tags` 본체 (op 닫기 전)
    async fn replace_remote_inner(
        &self,
        session: SessionId,
        remote: &str,
        items: &[TagLeaseItem],
        op: Option<&OpHandle>,
    ) -> Result<ChunkOutcome, CoreError> {
        let requested: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
        let names = self.validate_tag_request(session, remote, &requested)?;
        // 같은 이름이 여러 번 오면 처음 것의 기대값을 쓴다
        let mut expected: HashMap<&str, Oid> = HashMap::new();
        for item in items {
            expected
                .entry(item.name.as_str())
                .or_insert(item.expected_remote);
        }
        let lease_items = names
            .into_iter()
            .filter_map(|name| {
                let oid = expected.get(name.as_str())?.to_hex();
                Some(RefItem {
                    opts: vec![format!("--force-with-lease={TAGS_PREFIX}{name}:{oid}")],
                    refspec: format!("{TAGS_PREFIX}{name}:{TAGS_PREFIX}{name}"),
                    name,
                })
            })
            .collect::<Vec<_>>();
        if lease_items.is_empty() {
            return Ok(ChunkOutcome::default());
        }
        let cmd = ChunkedCommand {
            prefix: vec![
                "push".into(),
                "--porcelain".into(),
                "--progress".into(),
                "--no-follow-tags".into(),
            ],
            remote,
            items: lease_items,
            parse: parse_push_results,
            progress: true,
            undo_label: None,
        };
        let outcome = self.run_chunked(session, op, cmd).await?;
        self.patch_after_push(session, remote, &outcome.results);
        Ok(outcome)
    }

    /// 고른 원격에서 tag 들을 지운다 (TG-04). 원격은 아무것도 되돌릴 수 없으므로 실행 직전에 요청한 이름을 모두 조회하고,
    /// **확인 전에는 아무것도 지우지 않는다**.
    ///
    /// - `expected_remote` 없이 원격 객체가 로컬 tag 객체와 다른 항목이 하나라도 있으면 이 호출에서는 원격을 하나도 지우지
    ///   않는다: 그 항목은 `diverged` + `remote_oid`·`remote_commit`, 나머지는 `notRun`. 프런트는 확인 결과에 따라 diverged 를
    ///   빼거나 `expected_remote`(= 받은 `remote_oid`)를 채워 다시 부른다 (다시 부르면 다시 조회한다)
    /// - 로컬에 없는 tag(원격에만 있음)는 비교할 대상이 없으므로 diverged 로 보지 않는다
    /// - `expected_remote` 가 있는 항목은 조회값이 그것과 같을 때만 그 값으로 지우고, 다르면 `rejectedStale`
    /// - 원격에 없으면 `alreadyAbsent` (성공으로 친다)
    /// - 지울 것은 조회한 객체로 `--force-with-lease=refs/tags/<n>:<oid>` 를 걸고 전체 ref 이름으로 `--delete` 한다.
    ///   그 사이 바뀌었으면 `rejectedStale` 이고 원격은 그대로다. 캐시는 lease 근거로 쓰지 않는다 (D7)
    ///
    /// undo 항목은 없다. 조회가 실패·취소되면 아무것도 바뀌지 않았으므로 오류로 돌려준다
    pub async fn delete_remote_tags(
        &self,
        session: SessionId,
        remote: &str,
        items: &[TagDeleteItem],
        op: Option<OpHandle>,
    ) -> Result<Vec<TagRefResult>, CoreError> {
        let outcome = self
            .delete_remote_inner(session, remote, items, op.as_ref())
            .await;
        self.close_tag_op(session, op.as_ref(), outcome)
    }

    /// `delete_remote_tags` 본체 (op 닫기 전)
    async fn delete_remote_inner(
        &self,
        session: SessionId,
        remote: &str,
        items: &[TagDeleteItem],
        op: Option<&OpHandle>,
    ) -> Result<ChunkOutcome, CoreError> {
        let requested: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
        let names = self.validate_tag_request(session, remote, &requested)?;
        if names.is_empty() {
            return Ok(ChunkOutcome::default());
        }
        // 같은 이름이 여러 번 오면 처음 것의 기대값을 쓴다
        let mut expected: HashMap<&str, Oid> = HashMap::new();
        for item in items {
            if let Some(oid) = item.expected_remote {
                expected.entry(item.name.as_str()).or_insert(oid);
            }
        }
        let s = self.inner().get(session)?;
        let local = tag_objects(self.inner().runner(), &s.info.work_tree).await?;
        let found = self.lookup_remote(session, remote, &names, op).await?;

        let mut fixed: HashMap<String, TagRefResult> = HashMap::new();
        let mut to_delete = Vec::new();
        let mut unconfirmed = false;
        for name in &names {
            let Some(rt) = found.get(name) else {
                fixed.insert(
                    name.clone(),
                    TagRefResult::new(name, TagRefStatus::AlreadyAbsent),
                );
                continue;
            };
            match expected.get(name.as_str()) {
                // 확인한 값으로 다시 불렀는데 그 사이 또 바뀌었다
                Some(exp) if *exp != rt.object => {
                    fixed.insert(
                        name.clone(),
                        with_remote(
                            TagRefResult::new(name, TagRefStatus::RejectedStale)
                                .with_message(messages::tag_remote_changed()),
                            rt,
                        ),
                    );
                    continue;
                }
                Some(_) => {}
                None => {
                    if local.get(name).is_some_and(|l| *l != rt.object) {
                        fixed.insert(
                            name.clone(),
                            with_remote(TagRefResult::new(name, TagRefStatus::Diverged), rt),
                        );
                        unconfirmed = true;
                        continue;
                    }
                }
            }
            to_delete.push(RefItem {
                name: name.clone(),
                opts: vec![format!(
                    "--force-with-lease={TAGS_PREFIX}{name}:{}",
                    rt.object.to_hex()
                )],
                refspec: format!("{TAGS_PREFIX}{name}"),
            });
        }
        if unconfirmed {
            // 확인 전에는 아무것도 지우지 않는다: diverged 는 그대로, 나머지는 실행하지 않음
            let results = names
                .iter()
                .map(|name| match fixed.remove(name) {
                    Some(r) if r.status == TagRefStatus::Diverged => r,
                    _ => {
                        let r = TagRefResult::new(name, TagRefStatus::NotRun);
                        match found.get(name) {
                            Some(rt) => with_remote(r, rt),
                            None => r,
                        }
                    }
                })
                .collect();
            return Ok(ChunkOutcome {
                results,
                cancelled: false,
            });
        }
        let chunk = if to_delete.is_empty() {
            ChunkOutcome::default()
        } else {
            let cmd = ChunkedCommand {
                prefix: vec![
                    "push".into(),
                    "--porcelain".into(),
                    "--no-follow-tags".into(),
                    "--delete".into(),
                ],
                remote,
                items: to_delete,
                parse: parse_push_results,
                progress: false,
                undo_label: None,
            };
            self.run_chunked(session, op, cmd).await?
        };
        // 캐시: 조회 결과(있음·없음·다름)는 조회가 이미 반영했고, 실제로 돈 삭제만 더 고친다
        self.patch_after_delete(&s, remote, &chunk.results);
        let mut ran: HashMap<String, TagRefResult> = chunk
            .results
            .into_iter()
            .map(|r| (r.name.clone(), r))
            .collect();
        let results = names
            .iter()
            .map(|name| {
                if let Some(r) = fixed.remove(name) {
                    return r;
                }
                let r = ran.remove(name).unwrap_or_else(|| {
                    TagRefResult::new(name, TagRefStatus::Unknown)
                        .with_message(messages::tag_result_unknown())
                });
                // 지운 것·거부된 것도 조회한 원격 값을 함께 준다 (화면이 원격 상태를 고칠 때)
                match found.get(name) {
                    Some(rt) => with_remote(r, rt),
                    None => r,
                }
            })
            .collect::<Vec<_>>();
        Ok(ChunkOutcome {
            results,
            cancelled: chunk.cancelled,
        })
    }

    /// 로컬 tag 들을 한 트랜잭션으로 지운다 (TG-06). `update-ref --stdin` 에 지금 객체 값을 함께 넘겨, 하나라도 그 사이
    /// 바뀌었거나 지울 수 없으면 아무것도 지우지 않는다. undo 항목은 하나이고 라벨은 `tag -d v1 v2 v3 (+N)` 이다.
    /// 로컬에 없는 이름이 섞이면 git 을 돌리지 않고 거부한다
    pub async fn delete_local_tags(
        &self,
        session: SessionId,
        names: &[String],
    ) -> Result<(), CoreError> {
        let mut seen = HashSet::new();
        let mut list = Vec::with_capacity(names.len());
        for name in names {
            check_tag_name(name)?;
            if seen.insert(name.as_str()) {
                list.push(name.clone());
            }
        }
        if list.is_empty() {
            return Ok(());
        }
        let s = self.inner().get(session)?;
        let local = tag_objects(self.inner().runner(), &s.info.work_tree).await?;
        let mut script = String::new();
        for name in &list {
            let oid = local
                .get(name)
                .ok_or_else(|| CoreError::Invalid(messages::tag_not_found(name)))?;
            script.push_str(&format!("delete {TAGS_PREFIX}{name} {}\n", oid.to_hex()));
        }
        self.run_write(
            session,
            WriteSpec::new(["update-ref", "--stdin"])
                .with_stdin(script.into_bytes())
                .label(delete_label(&list)),
        )
        .await?;
        Ok(())
    }

    /// 원격 tag 몇 개를 조회한다 (단일 조회, TG-04 ①과 같은 경로 — 4개 이하는 이름 패턴, 넘으면 전체 조회). 원격에 있는 것만 요청 순서대로 돌려준다.
    /// 쓰기 잠금·세션 busy 와 무관하게 돌고, `op` 가 있으면 취소할 수 있으며 끝에 닫는다
    pub async fn lookup_remote_tags(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
        op: Option<OpHandle>,
    ) -> Result<Vec<RemoteTag>, CoreError> {
        let res = async {
            let names = self.validate_tag_request(session, remote, names)?;
            if names.is_empty() {
                return Ok(Vec::new());
            }
            let mut found = self
                .lookup_remote(session, remote, &names, op.as_ref())
                .await?;
            Ok(names.iter().filter_map(|n| found.remove(n)).collect())
        }
        .await;
        if let Some(op) = &op {
            let (cancelled, message) = match &res {
                Ok(_) => (false, String::new()),
                Err(CoreError::Cancelled) => (true, messages::cancelled().to_string()),
                Err(e) => (false, e.to_string()),
            };
            match self.inner().get(session) {
                Ok(s) => self
                    .inner()
                    .end_op(&s, op, res.is_ok(), cancelled, &message),
                Err(_) => self.inner().ops.end(op.id),
            }
        }
        res
    }

    /// 원격 tag 를 조회한다 (실행 직전 확인). 이름이 `LOOKUP_ALL_ABOVE`(4개) 이하면 이름마다 `refs/tags/<n>` 과
    /// `refs/tags/<n>^{}` 패턴으로, 넘으면 전체를 받는다. 요청한 이름만 돌려준다. 쓰기 잠금 없이 돌고 출력은 op 로
    /// 흘리지 않는다 (취소만 붙는다)
    pub(crate) async fn lookup_remote(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
        op: Option<&OpHandle>,
    ) -> Result<HashMap<String, RemoteTag>, CoreError> {
        let s = self.inner().get(session)?;
        let mut args: Vec<String> = vec![
            "ls-remote".into(),
            "--tags".into(),
            "--end-of-options".into(),
            remote.into(),
        ];
        if names.len() <= LOOKUP_ALL_ABOVE {
            for name in names {
                args.push(format!("{TAGS_PREFIX}{name}"));
                args.push(format!("{TAGS_PREFIX}{name}^{{}}"));
            }
        }
        let mut spec = WriteSpec::new(args).network().quiet().keep_op_open();
        if let Some(op) = op {
            spec = spec.with_op(op.clone());
        }
        let out = self.inner().run_network_read(&s, &spec).await?;
        let wanted: HashSet<&str> = names.iter().map(String::as_str).collect();
        let found: HashMap<String, RemoteTag> = parse_ls_remote_tags(&out.stdout)
            .into_iter()
            .filter(|t| wanted.contains(t.name.as_str()))
            .map(|t| (t.name.clone(), t))
            .collect();
        // 확인한 원격 상태가 있으면 그 이름들만 고친다 (네트워크 없이 표시가 바뀐다)
        self.inner()
            .tag_cache
            .apply_lookup(&s.info.common_dir, remote, names, &found);
        Ok(found)
    }

    /// 원격 tag 를 받아 온다 (TG-11, TG-15 "원격 것으로 맞추기"). `fetch --porcelain --verbose --progress --no-tags --no-prune
    /// --no-write-fetch-head --end-of-options <원격> refs/tags/<n>:refs/tags/<n>…`(`overwrite` 면 refspec 앞에 `+`)를 청크로
    /// 돈다. `--no-tags` 로 지정한 것만 받고, `--no-prune` 으로 `fetch.prune` 설정이 다른 ref 를 지우지 못하게 한다.
    ///
    /// 결과는 tag 마다 `fetched`(새로·덮어써 받음) / `upToDate` / `rejectedExists`(로컬에 다른 tag 가 있고 덮어쓰기 아님,
    /// `remote_oid` 는 원격 객체) / `unknown`. undo 항목은 하나(`fetch tag v1` / `fetch tags v1 v2 v3 (+N)`, 덮어쓰기면
    /// `fetch +tag …`). 원격에 없는 이름이 섞이면 git 이 전체를 멈추므로 첫 청크면 `CommandFailed`(다시 확인 후 재시도)
    pub async fn fetch_tags(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
        overwrite: bool,
        op: Option<OpHandle>,
    ) -> Result<Vec<TagRefResult>, CoreError> {
        let outcome = self
            .fetch_tags_inner(session, remote, names, overwrite, op.as_ref())
            .await;
        self.close_tag_op(session, op.as_ref(), outcome)
    }

    /// `fetch_tags` 본체 (op 닫기 전)
    async fn fetch_tags_inner(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
        overwrite: bool,
        op: Option<&OpHandle>,
    ) -> Result<ChunkOutcome, CoreError> {
        let names = self.validate_tag_request(session, remote, names)?;
        if names.is_empty() {
            return Ok(ChunkOutcome::default());
        }
        let plus = if overwrite { "+" } else { "" };
        let label = fetch_label(&names, overwrite);
        let items = names
            .into_iter()
            .map(|name| RefItem {
                refspec: format!("{plus}{TAGS_PREFIX}{name}:{TAGS_PREFIX}{name}"),
                name,
                opts: Vec::new(),
            })
            .collect();
        let cmd = ChunkedCommand {
            prefix: vec![
                "fetch".into(),
                "--porcelain".into(),
                // 이미 같은 ref 도 `=` 줄로 보고하게 한다 (없으면 줄이 생략된다)
                "--verbose".into(),
                "--progress".into(),
                "--no-tags".into(),
                "--no-prune".into(),
                "--no-write-fetch-head".into(),
            ],
            remote,
            items,
            parse: parse_fetch_results,
            progress: true,
            undo_label: Some(label),
        };
        let mut outcome = self.run_chunked(session, op, cmd).await?;
        // 받아 온 tag 는 지금 로컬 값이 곧 원격 값이다 (벗긴 commit 을 채운다)
        if let Ok(s) = self.inner().get(session) {
            let local: HashMap<String, LocalTagRef> = local_tag_refs(&s.state().refs.labels)
                .into_iter()
                .map(|l| (l.name.clone(), l))
                .collect();
            for r in &mut outcome.results {
                if matches!(r.status, TagRefStatus::Fetched | TagRefStatus::UpToDate)
                    && let Some(l) = local.get(&r.name)
                {
                    r.remote_oid = Some(l.object);
                    r.remote_commit = Some(l.commit);
                }
            }
        }
        // 원격 tag 캐시: 받은 것은 같음으로 확정, 덮어쓰지 못한 것은 다름(값을 모르면 모름) — push 와 같은 규칙
        self.patch_after_push(session, remote, &outcome.results);
        Ok(outcome)
    }

    /// 로컬 tag 목록 (TG-10 열·툴팁): `for-each-ref` 한 번으로 종류·날짜·commit 제목·tag 제목·tagger. 이름순
    pub async fn tag_list(&self, session: SessionId) -> Result<Vec<LocalTag>, CoreError> {
        let s = self.inner().get(session)?;
        Ok(mgit_git::cmd::tag_list(self.inner().runner(), &s.info.work_tree).await?)
    }

    /// 원격 tag 상태 보고서 (TG-08). `remote` 가 없으면 현재 브랜치 업스트림의 원격 → `origin` → 첫 원격이다.
    ///
    /// `refresh` 면 `ls-remote --tags <원격>` 전체를 조회해 캐시를 바꾼다 — 쓰기 잠금·세션 busy 없이 돌고 `op` 로 취소할 수
    /// 있다. 아니면 네트워크 없이 캐시와 지금 로컬 tag 로만 만든다(확인한 적이 없으면 `checked_at` 이 `None`).
    /// 조회가 실패하면(오프라인·인증) 이전 값을 지우지 않고 `last_error` 를 남긴 보고서를 돌려준다. 취소면 `Cancelled`.
    /// 보고서는 개수와 "같음"이 아닌 항목만 싣는다
    pub async fn remote_tags(
        &self,
        session: SessionId,
        remote: Option<&str>,
        refresh: bool,
        op: Option<OpHandle>,
    ) -> Result<TagSyncReport, CoreError> {
        let res = self
            .remote_tags_inner(session, remote, refresh, op.as_ref())
            .await;
        if let Some(op) = &op {
            let (ok, cancelled, message) = match &res {
                Ok((_, None)) => (true, false, String::new()),
                Ok((_, Some(failure))) => (false, false, failure.clone()),
                Err(CoreError::Cancelled) => (false, true, messages::cancelled().to_string()),
                Err(e) => (false, false, e.to_string()),
            };
            match self.inner().get(session) {
                Ok(s) => self.inner().end_op(&s, op, ok, cancelled, &message),
                Err(_) => self.inner().ops.end(op.id),
            }
        }
        res.map(|(report, _)| report)
    }

    /// `remote_tags` 본체. 보고서와 이번 조회의 실패 문구(있으면)를 돌려준다
    async fn remote_tags_inner(
        &self,
        session: SessionId,
        remote: Option<&str>,
        refresh: bool,
        op: Option<&OpHandle>,
    ) -> Result<(TagSyncReport, Option<String>), CoreError> {
        let s = self.inner().get(session)?;
        let info = {
            let st = s.state();
            let name = match remote {
                Some(r) => r.to_string(),
                None => tag_default_remote(&st.refs)?,
            };
            st.refs
                .remotes
                .iter()
                .find(|r| r.name == name)
                .cloned()
                .ok_or_else(|| CoreError::Invalid(messages::unknown_remote(&name)))?
        };
        let cache = &self.inner().tag_cache;
        let mut failure = None;
        if refresh {
            let started = Instant::now();
            let mut spec = WriteSpec::new(["ls-remote", "--tags", "--end-of-options", &info.name])
                .network()
                .quiet()
                .keep_op_open();
            if let Some(op) = op {
                spec = spec.with_op(op.clone());
            }
            match self.inner().run_network_read(&s, &spec).await {
                Ok(out) => cache.replace(
                    &s.info.common_dir,
                    &info.name,
                    &info.fetch_url,
                    parse_ls_remote_tags(&out.stdout),
                    now_millis(),
                    started,
                ),
                Err(CoreError::Cancelled) => return Err(CoreError::Cancelled),
                Err(e) => {
                    let error = lookup_error(&e);
                    failure = Some(error.message.clone());
                    cache.record_error(&s.info.common_dir, &info.name, &info.fetch_url, error);
                }
            }
        }
        // 조회하는 동안 로컬 tag 가 바뀌었을 수 있으므로 지금 상태로 비교한다
        let (local, remotes) = {
            let st = s.state();
            (local_tag_refs(&st.refs.labels), st.refs.remotes.clone())
        };
        let view = cache.view(&s.info.common_dir, &remotes, &info.name);
        Ok((build_report(&info, view.as_ref(), &local), failure))
    }

    /// push·덮어쓰기·가져오기 결과를 원격 tag 캐시에 반영한다 (확인한 원격 상태가 있을 때만): 올라갔거나 받았거나 이미
    /// 같으면 로컬 값으로, 이름 충돌인데 캐시가 그렇게 보지 않았으면 모름, lease 거부면 모름, 결과를 모르면 모름 + 오래됨
    fn patch_after_push(&self, session: SessionId, remote: &str, results: &[TagRefResult]) {
        let Ok(s) = self.inner().get(session) else {
            return;
        };
        let cache = &self.inner().tag_cache;
        if !cache.has_remote(&s.info.common_dir, remote) {
            return;
        }
        let local: HashMap<String, LocalTagRef> = local_tag_refs(&s.state().refs.labels)
            .into_iter()
            .map(|l| (l.name.clone(), l))
            .collect();
        cache.patch(&s.info.common_dir, remote, |c| {
            for r in results {
                match r.status {
                    TagRefStatus::Pushed | TagRefStatus::UpToDate | TagRefStatus::Fetched => {
                        if let Some(l) = local.get(&r.name) {
                            c.tags.insert(r.name.clone(), remote_of_local(l));
                            c.unknown.remove(&r.name);
                        }
                    }
                    TagRefStatus::RejectedExists => {
                        let local_object = local.get(&r.name).map(|l| l.object);
                        let known_diff = c
                            .tags
                            .get(&r.name)
                            .is_some_and(|t| Some(t.object) != local_object);
                        if !known_diff {
                            c.unknown.insert(r.name.clone());
                        }
                    }
                    // lease 덮어쓰기가 거부됐다: 그 사이 원격이 바뀌었으니 값을 모른다
                    TagRefStatus::RejectedStale => {
                        c.unknown.insert(r.name.clone());
                    }
                    TagRefStatus::Unknown => {
                        c.unknown.insert(r.name.clone());
                        c.stale = true;
                    }
                    _ => {}
                }
            }
        });
    }

    /// 실제로 돈 원격 삭제 명령의 결과를 반영한다 (확인한 원격 상태가 있을 때만): 지웠으면 뺀다, lease 거부·결과 모름은
    /// 모름. 조회로 알게 된 것(없음·다름)은 조회가 이미 반영했다
    fn patch_after_delete(&self, s: &RepoSession, remote: &str, results: &[TagRefResult]) {
        self.inner()
            .tag_cache
            .patch(&s.info.common_dir, remote, |c| {
                for r in results {
                    match r.status {
                        TagRefStatus::Deleted | TagRefStatus::AlreadyAbsent => {
                            c.tags.remove(&r.name);
                            c.unknown.remove(&r.name);
                        }
                        TagRefStatus::RejectedStale => {
                            c.unknown.insert(r.name.clone());
                        }
                        TagRefStatus::Unknown => {
                            c.unknown.insert(r.name.clone());
                            c.stale = true;
                        }
                        _ => {}
                    }
                }
            });
    }

    /// 원격은 등록된 것이어야 하고(D17), tag 이름은 refspec 을 깨지 않아야 한다. 중복을 빼고 순서를 지킨 이름을 돌려준다
    pub(crate) fn validate_tag_request(
        &self,
        session: SessionId,
        remote: &str,
        names: &[String],
    ) -> Result<Vec<String>, CoreError> {
        let s = self.inner().get(session)?;
        if !s.state().refs.remotes.iter().any(|r| r.name == remote) {
            return Err(CoreError::Invalid(messages::unknown_remote(remote)));
        }
        let mut seen = HashSet::new();
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            check_tag_name(name)?;
            if seen.insert(name.as_str()) {
                out.push(name.clone());
            }
        }
        Ok(out)
    }

    /// tag 작업의 op 를 한 번 닫는다: 모두 성공이면 `ok`, 일부 실패면 요약, 취소면 취소, 오류면 그 문구
    pub(crate) fn close_tag_op(
        &self,
        session: SessionId,
        op: Option<&OpHandle>,
        outcome: Result<ChunkOutcome, CoreError>,
    ) -> Result<Vec<TagRefResult>, CoreError> {
        if let Some(op) = op {
            let (ok, cancelled, message) = match &outcome {
                Ok(o) => {
                    let failed = o.results.iter().filter(|r| !r.status.is_success()).count();
                    let message = if o.cancelled {
                        messages::cancelled().to_string()
                    } else if failed > 0 {
                        messages::tag_results_failed(failed, o.results.len())
                    } else {
                        String::new()
                    };
                    (!o.cancelled && failed == 0, o.cancelled, message)
                }
                Err(CoreError::Cancelled) => (false, true, messages::cancelled().to_string()),
                Err(e) => (false, false, e.to_string()),
            };
            match self.inner().get(session) {
                Ok(s) => self.inner().end_op(&s, op, ok, cancelled, &message),
                Err(_) => self.inner().ops.end(op.id),
            }
        }
        outcome.map(|o| o.results)
    }

    /// 청크마다 명령을 돌려 tag 별 결과를 모은다. op 는 닫지 않는다 (`close_tag_op`).
    /// - 청크 사이에 취소되면, 또는 실행 중 취소되면 그 청크와 남은 ref 는 `unknown`
    /// - 결과 표에 없는 ref 는 `unknown` (실패로 단정하지 않는다)
    /// - 첫 청크가 결과 표 없이 통째로 실패하면 아무것도 바뀌지 않은 것이므로 `CommandFailed`
    pub(crate) async fn run_chunked(
        &self,
        session: SessionId,
        op: Option<&OpHandle>,
        cmd: ChunkedCommand<'_>,
    ) -> Result<ChunkOutcome, CoreError> {
        let budget = (
            self.inner().cfg.tag_chunk_bytes,
            self.inner().cfg.tag_chunk_refs,
        );
        let chunks = chunk_items(&cmd.items, budget.0, budget.1);
        let s = self.inner().get(session)?;
        // 로컬 ref 를 바꾸는 명령: 청크마다 undo 를 쌓지 않고 전후 스냅샷으로 하나만 쌓은 뒤 한 번 다시 읽는다
        let before = match cmd.undo_label {
            Some(_) => self.inner().snapshot(&s).await,
            None => None,
        };
        let mut results: Vec<TagRefResult> = Vec::with_capacity(cmd.items.len());
        let mut cancelled = false;
        let mut done = 0;
        for (i, chunk) in chunks.iter().enumerate() {
            if op.is_some_and(|o| o.cancel.is_cancelled()) {
                cancelled = true;
                break;
            }
            let mut args = cmd.prefix.clone();
            args.extend(chunk.iter().flat_map(|it| it.opts.iter().cloned()));
            args.push("--end-of-options".into());
            args.push(cmd.remote.to_string());
            args.extend(chunk.iter().map(|it| it.refspec.clone()));
            let mut spec = WriteSpec::new(args)
                .network()
                .no_undo()
                .keep_failed_output()
                .keep_op_open();
            if let Some(op) = op {
                spec = spec.with_op(op.clone());
                if cmd.progress {
                    spec = spec.progress();
                }
            }
            // 원격 ref 만 바뀌므로 중간 청크 뒤에는 다시 읽지 않는다 (undo 를 쌓는 명령은 끝에서 한 번)
            if cmd.undo_label.is_some() || i + 1 < chunks.len() {
                spec = spec.skip_refresh();
            }
            match self.run_write(session, spec.clone()).await {
                Ok(out) => {
                    let mut parsed = (cmd.parse)(&out.stdout_lossy());
                    if !out.success() && parsed.is_empty() && results.is_empty() {
                        return Err(spec.failure(&out));
                    }
                    let fallback = (!out.success()).then(|| failure_line(&out.stderr));
                    for item in chunk.iter() {
                        let r = parsed.remove(&item.name).unwrap_or_else(|| {
                            TagRefResult::new(&item.name, TagRefStatus::Unknown).with_message(
                                fallback
                                    .clone()
                                    .unwrap_or_else(|| messages::tag_result_unknown().into()),
                            )
                        });
                        results.push(r);
                    }
                    done += chunk.len();
                }
                Err(CoreError::Cancelled) => {
                    cancelled = true;
                    break;
                }
                Err(e) => {
                    if results.is_empty() {
                        return Err(e);
                    }
                    let msg = e.to_string();
                    for item in &cmd.items[done..] {
                        results.push(
                            TagRefResult::new(&item.name, TagRefStatus::Unknown)
                                .with_message(msg.clone()),
                        );
                    }
                    done = cmd.items.len();
                    break;
                }
            }
        }
        if done < cmd.items.len() {
            let msg = if cancelled {
                messages::cancelled()
            } else {
                messages::tag_result_unknown()
            };
            for item in &cmd.items[done..] {
                results
                    .push(TagRefResult::new(&item.name, TagRefStatus::Unknown).with_message(msg));
            }
        }
        if let Some(label) = &cmd.undo_label {
            if let Some(before) = before
                && let Some(after) = self.inner().snapshot(&s).await
                && before != after
            {
                s.undo
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(label.clone(), before, after, self.inner().cfg.undo_capacity);
            }
            self.inner().refresh_after_write(&s).await;
        }
        Ok(ChunkOutcome { results, cancelled })
    }
}

/// 결과에 조회한 원격 값(객체·벗긴 commit)을 붙인다
fn with_remote(mut r: TagRefResult, rt: &RemoteTag) -> TagRefResult {
    r.remote_oid = Some(rt.object);
    r.remote_commit = Some(rt.commit());
    r
}

/// ref 라벨에서 로컬 tag 비교 재료를 뽑는다 (git 을 새로 실행하지 않는다)
pub(crate) fn local_tag_refs(labels: &[RefLabel]) -> Vec<LocalTagRef> {
    labels
        .iter()
        .filter(|l| matches!(l.kind, RefKind::Tag { .. }))
        .filter_map(|l| {
            Some(LocalTagRef {
                name: l.full_name.strip_prefix(TAGS_PREFIX)?.to_string(),
                object: l.tag_object.unwrap_or(l.target),
                commit: l.target,
            })
        })
        .collect()
}

/// 로컬 tag 를 원격에 올린 뒤의 원격 값
fn remote_of_local(l: &LocalTagRef) -> RemoteTag {
    RemoteTag {
        name: l.name.clone(),
        object: l.object,
        peeled: (l.object != l.commit).then_some(l.commit),
    }
}

/// 원격을 고르지 않았을 때의 비교 대상 (TG-10 ②): 현재 브랜치 업스트림의 원격 → `origin` → 첫 원격
fn tag_default_remote(refs: &RepoRefs) -> Result<String, CoreError> {
    let names: Vec<&str> = refs.remotes.iter().map(|r| r.name.as_str()).collect();
    let Some(first) = names.first() else {
        return Err(CoreError::Invalid(messages::no_remotes().into()));
    };
    let upstream = refs
        .head
        .branch()
        .and_then(|b| refs.labels.iter().find(|l| l.full_name == b))
        .and_then(|l| l.upstream.as_deref())
        .and_then(|u| split_upstream(u, names.iter().copied()))
        .map(|(r, _)| r)
        .filter(|r| names.contains(&r.as_str()));
    Ok(upstream.unwrap_or_else(|| {
        if names.contains(&"origin") {
            "origin".to_string()
        } else {
            (*first).to_string()
        }
    }))
}

/// 캐시와 로컬 tag 로 보고서를 만든다. 확인에 성공한 적이 없으면 개수·항목이 비어 있다
fn build_report(
    info: &RemoteInfo,
    cache: Option<&RemoteTagCache>,
    local: &[LocalTagRef],
) -> TagSyncReport {
    let mut report = TagSyncReport {
        remote: info.name.clone(),
        checked_at: None,
        stale: false,
        last_error: None,
        counts: Default::default(),
        entries: Vec::new(),
        push_url_differs: info.push_url.as_ref().is_some_and(|p| *p != info.fetch_url),
    };
    let Some(cache) = cache else {
        return report;
    };
    report.last_error = cache.last_error.clone();
    if let Some(at) = cache.checked_at {
        let (counts, entries) = compare_tags(local, &cache.tag_list(), &cache.unknown);
        report.checked_at = Some(at);
        report.stale = cache.stale;
        report.counts = counts;
        report.entries = entries;
    }
    report
}

/// 조회 실패를 종류·한 줄 문구로 (TG-08 ⑤)
fn lookup_error(e: &CoreError) -> TagLookupError {
    let (kind, message) = match e {
        CoreError::CommandFailed { hint, stderr, .. } => {
            let kind = if *hint == Some(GitHint::AuthFailed) {
                TagLookupErrorKind::Auth
            } else if is_network_error(stderr) {
                TagLookupErrorKind::Network
            } else {
                TagLookupErrorKind::Other
            };
            (kind, failure_line(stderr))
        }
        other => (TagLookupErrorKind::Other, other.to_string()),
    };
    TagLookupError {
        kind,
        at: now_millis(),
        message,
    }
}

/// 연결 불가·원격 저장소 없음으로 보이는 stderr 인지
fn is_network_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    [
        "could not resolve host",
        "unable to access",
        "could not read from remote repository",
        "does not appear to be a git repository",
        "connection refused",
        "connection timed out",
        "network is unreachable",
        "operation timed out",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

impl CoreInner {
    /// fetch·pull 전 로컬 tag 지문 (이 저장소에 원격 tag 캐시가 있을 때만 — 없으면 무효화할 것도 없다)
    pub(crate) fn tag_marks(&self, session: &RepoSession) -> Option<Vec<(String, Oid)>> {
        if !self.tag_cache.has_repo(&session.info.common_dir) {
            return None;
        }
        let mut marks: Vec<(String, Oid)> = local_tag_refs(&session.state().refs.labels)
            .into_iter()
            .map(|l| (l.name, l.object))
            .collect();
        marks.sort();
        Some(marks)
    }

    /// fetch·pull 뒤: 로컬 tag 집합이 바뀌었으면(원격에서 tag 를 받아 왔으면) 원격 tag 캐시를 오래됨으로 (4절 표).
    /// 자동 fetch 가 5분마다 돌므로 무조건 오래됨으로 두지 않는다
    pub(crate) fn after_fetch(&self, session: &RepoSession, before: Option<Vec<(String, Oid)>>) {
        let after = self.tag_marks(session);
        self.stale_if_tags_changed(&session.info.common_dir, before, after);
    }

    /// 세션 없이 도는 fetch·pull(폴더 일괄) 전후의 로컬 tag 지문. 이 저장소에 원격 tag 캐시가 있을 때만 `for-each-ref`
    /// 한 번으로 읽는다 (세션 지문 `tag_marks` 와 같은 모양 — 이름, ref 가 가리키는 객체, 이름순)
    pub(crate) async fn tag_marks_at(
        &self,
        common_dir: &std::path::Path,
        work_tree: &std::path::Path,
    ) -> Option<Vec<(String, Oid)>> {
        if !self.tag_cache.has_repo(common_dir) {
            return None;
        }
        let mut marks: Vec<(String, Oid)> = tag_objects(self.runner(), work_tree)
            .await
            .ok()?
            .into_iter()
            .collect();
        marks.sort();
        Some(marks)
    }

    /// 전후 지문이 다르면 그 저장소의 원격 tag 캐시를 모두 오래됨으로 (세션 fetch·pull·자동 fetch·폴더 일괄 공용).
    /// 앞 지문이 없으면(캐시가 없었으면) 아무것도 하지 않는다
    pub(crate) fn stale_if_tags_changed(
        &self,
        common_dir: &std::path::Path,
        before: Option<Vec<(String, Oid)>>,
        after: Option<Vec<(String, Oid)>>,
    ) {
        if let (Some(before), Some(after)) = (before, after)
            && before != after
        {
            self.tag_cache.mark_stale_all(common_dir);
        }
    }
}

impl Core {
    /// branch push 뒤: follow-tags(`tags` 또는 `push.followTags`)였으면 그 원격의 tag 캐시를 오래됨으로 (4절 표)
    pub(crate) async fn after_branch_push(&self, session: SessionId, remote: &str, tags: bool) {
        let Ok(s) = self.inner().get(session) else {
            return;
        };
        let cache = &self.inner().tag_cache;
        if !cache.has_remote(&s.info.common_dir, remote) {
            return;
        }
        let follow = tags
            || mgit_git::cmd::config_get(
                self.inner().runner(),
                &s.info.work_tree,
                "push.followTags",
            )
            .await
            .is_some_and(|v| {
                matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1")
            });
        if follow {
            cache.mark_stale(&s.info.common_dir, remote);
        }
    }
}

/// 라벨에 넣을 tag 이름: `v1` / `v1 v2 v3 (+N)` (앞 셋)
fn names_head(names: &[String]) -> String {
    const SHOWN: usize = 3;
    let head = names
        .iter()
        .take(SHOWN)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    if names.len() > SHOWN {
        format!("{head} (+{})", names.len() - SHOWN)
    } else {
        head
    }
}

/// 로컬 삭제 undo 라벨: `tag -d v1` / `tag -d v1 v2 v3 (+N)`
fn delete_label(names: &[String]) -> String {
    format!("tag -d {}", names_head(names))
}

/// 가져오기 undo 라벨: `fetch tag v1` / `fetch tags v1 v2 v3 (+N)`, 덮어쓰기면 `fetch +tag v1`
fn fetch_label(names: &[String], overwrite: bool) -> String {
    let plus = if overwrite { "+" } else { "" };
    let noun = if names.len() == 1 { "tag" } else { "tags" };
    format!("fetch {plus}{noun} {}", names_head(names))
}

/// fetch 결과 표를 tag 이름별 결과로. `remote_oid` 는 원격에서 받은 객체
pub(crate) fn parse_fetch_results(stdout: &str) -> HashMap<String, TagRefResult> {
    parse_fetch_porcelain(stdout)
        .into_iter()
        .filter_map(|line| {
            let name = line.local_ref.strip_prefix(TAGS_PREFIX)?.to_string();
            let mut r = match line.flag {
                FetchFlag::New
                | FetchFlag::Forced
                | FetchFlag::TagUpdate
                | FetchFlag::FastForward => TagRefResult::new(&name, TagRefStatus::Fetched),
                FetchFlag::UpToDate => TagRefResult::new(&name, TagRefStatus::UpToDate),
                FetchFlag::Rejected => TagRefResult::new(&name, TagRefStatus::RejectedExists)
                    .with_message("would clobber existing tag"),
                FetchFlag::Pruned => TagRefResult::new(&name, TagRefStatus::Unknown),
            };
            r.remote_oid = Some(line.new);
            Some((name, r))
        })
        .collect()
}

/// 실패한 명령 stderr 에서 보일 한 줄 (`error:`·`fatal:` 줄 우선, 없으면 마지막 줄)
fn failure_line(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let line = lines
        .iter()
        .find(|l| l.starts_with("fatal:"))
        .or_else(|| lines.iter().find(|l| l.starts_with("error:")))
        .or(lines.last())
        .copied()
        .unwrap_or("");
    mgit_model::redact_text(line)
}

/// push 결과 표를 tag 이름별 결과로 (push·원격 삭제 공용)
pub(crate) fn parse_push_results(stdout: &str) -> HashMap<String, TagRefResult> {
    parse_push_porcelain(stdout)
        .iter()
        .filter_map(|line| {
            let name = line.to.strip_prefix(TAGS_PREFIX)?;
            Some((name.to_string(), push_line_result(name, line)))
        })
        .collect()
}

/// 결과 표 한 줄을 tag 결과로. 분기는 flag 와 summary 대괄호, 사유의 고정 문구로만 한다
fn push_line_result(name: &str, line: &PushRefLine) -> TagRefResult {
    let status = match line.flag {
        PushFlag::New | PushFlag::FastForward | PushFlag::Forced => TagRefStatus::Pushed,
        PushFlag::UpToDate => TagRefStatus::UpToDate,
        PushFlag::Deleted => TagRefStatus::Deleted,
        PushFlag::Rejected => match (line.summary.as_str(), line.reason.as_deref()) {
            ("[remote rejected]", _) => TagRefStatus::RejectedRemote,
            // 서버가 받은 뒤 결과를 알리지 못했다 — 반영됐을 수도 있다
            ("[remote failure]", _) => TagRefStatus::Unknown,
            ("[rejected]", Some("already exists")) => TagRefStatus::RejectedExists,
            ("[rejected]", Some("stale info")) => TagRefStatus::RejectedStale,
            _ => TagRefStatus::Failed,
        },
    };
    let mut r = TagRefResult::new(name, status);
    let reason = line.reason.clone().filter(|r| !r.is_empty());
    if status != TagRefStatus::Pushed
        && status != TagRefStatus::UpToDate
        && status != TagRefStatus::Deleted
    {
        r.message = reason.or_else(|| Some(line.summary.clone()));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 이름만 다른 push 항목
    fn items(names: &[&str]) -> Vec<RefItem> {
        names
            .iter()
            .map(|n| RefItem {
                name: (*n).into(),
                opts: Vec::new(),
                refspec: format!("refs/tags/{n}:refs/tags/{n}"),
            })
            .collect()
    }

    #[test]
    fn chunking_respects_bytes_and_ref_count() {
        let all = items(&["a", "b", "c", "d", "e"]);
        // ref 수 상한 2
        let c = chunk_items(&all, usize::MAX, 2);
        assert_eq!(c.iter().map(|c| c.len()).collect::<Vec<_>>(), [2, 2, 1]);
        // 바이트 상한: "refs/tags/a:refs/tags/a" 23 + 1 = 24 바이트씩 → 50 이면 둘씩
        let c = chunk_items(&all, 50, 1_000);
        assert_eq!(c.iter().map(|c| c.len()).collect::<Vec<_>>(), [2, 2, 1]);
        // 하나가 예산보다 커도 혼자 한 청크
        let c = chunk_items(&all, 1, 1_000);
        assert_eq!(c.len(), 5);
        // 옵션도 예산에 든다
        let mut with_opts = items(&["a", "b"]);
        with_opts[0].opts.push("x".repeat(40));
        let c = chunk_items(&with_opts, 70, 1_000);
        assert_eq!(c.len(), 2);
        assert!(chunk_items(&[], 10, 10).is_empty());
    }

    #[test]
    fn push_results_map_by_tag_name() {
        let out = "To /r.git\n\
*\trefs/tags/v1:refs/tags/v1\t[new tag]\n\
=\trefs/tags/v2:refs/tags/v2\t[up to date]\n\
!\trefs/tags/v3:refs/tags/v3\t[rejected] (already exists)\n\
!\trefs/tags/v4:refs/tags/v4\t[remote rejected] (pre-receive hook declined)\n\
!\t(delete):refs/tags/v5\t[rejected] (stale info)\n\
-\t:refs/tags/v6\t[deleted]\n\
!\trefs/tags/v7:refs/tags/v7\t[remote failure] (remote failed to report status)\n\
*\trefs/heads/v8:refs/heads/v8\t[new branch]\n";
        let m = parse_push_results(out);
        let st = |n: &str| m.get(n).map(|r| r.status);
        assert_eq!(st("v1"), Some(TagRefStatus::Pushed));
        assert_eq!(st("v2"), Some(TagRefStatus::UpToDate));
        assert_eq!(st("v3"), Some(TagRefStatus::RejectedExists));
        assert_eq!(st("v4"), Some(TagRefStatus::RejectedRemote));
        assert_eq!(
            m["v4"].message.as_deref(),
            Some("pre-receive hook declined")
        );
        assert_eq!(st("v5"), Some(TagRefStatus::RejectedStale));
        assert_eq!(st("v6"), Some(TagRefStatus::Deleted));
        assert_eq!(st("v7"), Some(TagRefStatus::Unknown));
        // branch 줄은 tag 결과가 아니다
        assert_eq!(st("v8"), None);
        assert!(m["v1"].message.is_none());
    }

    #[test]
    fn fetch_label_and_results() {
        let n = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(fetch_label(&n(&["v1"]), false), "fetch tag v1");
        assert_eq!(fetch_label(&n(&["v1"]), true), "fetch +tag v1");
        assert_eq!(
            fetch_label(&n(&["a", "b", "c", "d"]), false),
            "fetch tags a b c (+1)"
        );
        let z = "0".repeat(40);
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let out = format!(
            "* {z} {a} refs/tags/new\n= {a} {a} refs/tags/same\n! {a} {b} refs/tags/clash\n+ {a} {b} refs/tags/forced\n  {a} {b} refs/remotes/origin/main\n"
        );
        let m = parse_fetch_results(&out);
        assert_eq!(m.len(), 4);
        assert_eq!(m["new"].status, TagRefStatus::Fetched);
        assert_eq!(m["same"].status, TagRefStatus::UpToDate);
        assert_eq!(m["clash"].status, TagRefStatus::RejectedExists);
        assert_eq!(m["clash"].remote_oid.map(|o| o.to_hex()), Some(b.clone()));
        assert_eq!(m["forced"].status, TagRefStatus::Fetched);
    }

    #[test]
    fn delete_label_shows_three_names() {
        let n = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(delete_label(&n(&["v1"])), "tag -d v1");
        assert_eq!(delete_label(&n(&["a", "b", "c"])), "tag -d a b c");
        assert_eq!(
            delete_label(&n(&["a", "b", "c", "d", "e"])),
            "tag -d a b c (+2)"
        );
    }

    #[test]
    fn failure_line_prefers_fatal() {
        assert_eq!(
            failure_line("hint: x\nfatal: could not read from remote\nerror: y\n"),
            "fatal: could not read from remote"
        );
        assert_eq!(failure_line("a\nb\n"), "b");
    }
}
