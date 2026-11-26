//! 여러 파일 한꺼번에 바꾸기 (P). 미리보기는 내용 검색과 같은 후보·같은 Rust 정규식 엔진으로 만들고, 적용은 파일마다
//! revision 을 다시 확인해 공용 저장 경로(`fs_write_checked` 의 쓰기 부분: 쓰기 큐·파일 잠금·원자 교체)로 쓴 뒤 세션마다
//! 한 번 다시 읽는다. 쓰기 직전 원문은
//! 폐기 백업(이유 `replace`)으로 남기고, 되돌리기는 그 사본을 같은 저장 경로로 다시 쓴다. 묶음 전체의 원자성은 없다 —
//! 파일마다 결과를 돌려준다.
//!
//! 바꾸기는 줄마다 한다. 검색이 줄 단위로 찾으므로 일치가 줄을 넘지 않는다. 줄 끝·마지막 줄 끝의 유무·BOM 은 그대로
//! 두고(BOM 은 첫 줄 본문에서 빼고 찾는다), 줄 끝이 섞인 파일·1 MiB 초과·바이너리·UTF-8 이 아닌 파일은 바꾸지 않는다
//! (편집기 저장과 같은 규칙). 경로는 세션의 파일 공간(`fs_space`/`locate`)을 거친다 — 가상 그룹은 미리보기가 검색처럼
//! 있는 멤버마다 훑어 결과 경로가 `별칭/…` 이고, 적용·되돌리기는 그 경로를 `locate` 로 멤버 루트에 나눈다

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use mgit_git::cmd::discover;
use mgit_l10n::{pick, tr};
use mgit_model::{CancelToken, GitError};
use serde::{Deserialize, Serialize};

use super::edit::{SaveContent, Written, read_editable_at};
use super::search::{SearchRoot, build_matcher, check_scope, walk_roots};
use super::{
    FsEditableFile, FsEncoding, FsFile, FsSaveResult, FsSpace, parse, read_file_at, run_blocking,
};
use crate::{Core, CoreError, SessionId};

/// 미리보기에 담는 파일 수 상한. 넘으면 나머지 파일은 싣지 않고(적용 대상도 아니다) `truncated` 로 알린다
pub const REPLACE_FILE_LIMIT: usize = 500;
/// 파일마다 자세히 보이는 바뀌는 줄 수. 나머지 줄의 일치는 파일 체크를 따른다
pub const REPLACE_PREVIEW_LINES: usize = 10;
/// 여러 파일 바꾸기가 남기는 폐기 백업의 이유
pub const REPLACE_BACKUP_REASON: &str = "replace";
/// 미리보기 줄의 최대 글자 수. 긴 줄은 첫 일치 앞 `LINE_LEAD` 글자부터 자른다
const LINE_WINDOW: usize = 300;
/// 긴 줄을 자를 때 첫 일치 앞에 남기는 글자 수
const LINE_LEAD: usize = 40;

/// 찾을 것과 바꿀 것. 미리보기와 적용이 같은 값을 보낸다
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePattern {
    pub text: String,
    pub regex: bool,
    pub case_sensitive: bool,
    /// 정규식이면 `$1`·`${name}` 을 묶음으로 펼친다 (일치 전체는 `$0`, 글자 `$` 는 `$$`). 아니면 글자 그대로
    pub replacement: String,
}

/// 미리보기 요청: 찾고 바꿀 것과 내용 검색의 범위·경로 필터
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceQuery {
    pub pattern: ReplacePattern,
    pub path_filter: String,
    pub scope: String,
    /// 편집기에 저장하지 않은 초안이 있는 파일 (공간 경로 — 루트 기준, 그룹은 `별칭/…`). 디스크 원문에 일치가 있으면
    /// 바꾸지 않고 사유를 남긴다
    pub drafts: Vec<String>,
}

/// 미리보기 줄의 일치 하나. 위치는 줄 `text` 안의 UTF-16 단위다
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceMatch {
    /// 파일 안 일치 순번 (0부터, 줄 순서). 적용에서 뺄 일치를 이 값으로 고른다
    pub index: u32,
    pub start: u32,
    pub end: u32,
    /// 이 일치 자리에 들어갈 글자 (묶음을 펼친 것)
    pub replacement: String,
}

/// 바뀌는 줄 하나 (줄 끝 제외)
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceLine {
    /// 1부터
    pub line: u32,
    pub text: String,
    /// 긴 줄이라 앞을 잘랐다
    pub cut_start: bool,
    /// 긴 줄이라 뒤를 잘랐다
    pub cut_end: bool,
    pub matches: Vec<ReplaceMatch>,
    /// 잘린 부분에 있어 보이지 않는 일치 수 (파일 체크를 따른다)
    pub hidden: u32,
}

/// 바꿀 파일 하나의 미리보기
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFilePreview {
    /// 공간 경로 (루트 기준, 그룹은 `별칭/…`) — 적용·되돌리기에 그대로 보낸다
    pub path: String,
    /// 파일을 품은 저장소 디렉터리 (루트 기준, 루트 자신은 "", 그룹 멤버 루트는 별칭)
    pub repo: Option<String>,
    /// 적용 때 다시 비교할 revision (편집 조회와 같은 값)
    pub revision: String,
    /// 파일 안 일치 수 (보이지 않는 것 포함)
    pub matches: u32,
    pub lines: Vec<ReplaceLine>,
    /// `REPLACE_PREVIEW_LINES` 를 넘어 보이지 않는 바뀌는 줄 수
    pub hidden_lines: u32,
}

/// 파일을 바꾸지 않은 사유
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceSkipReason {
    /// 편집기에 저장하지 않은 초안이 있다
    Draft,
    /// 줄 끝이 섞였거나 단독 CR 이 있다
    MixedLineEndings,
    /// Git 저장소 밖 파일이다 (되돌릴 사본을 맡길 저장소가 없다)
    OutsideRepository,
    /// 미리보기 뒤에 파일이 바뀌었다 (revision 불일치·지워짐)
    Changed,
    /// 고른 일치가 없거나 바꿔도 원문과 같다
    Unchanged,
}

/// 일치가 있지만 미리보기에서 뺀 파일
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceExcluded {
    pub path: String,
    pub reason: ReplaceSkipReason,
}

/// 미리보기 결과
#[derive(Default, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub files: Vec<ReplaceFilePreview>,
    pub excluded: Vec<ReplaceExcluded>,
    /// 텍스트로 읽지 못해 찾아보지 않은 파일 수 (1 MiB 초과·바이너리·UTF-8 아님·권한 없음)
    pub unreadable: u32,
    /// 파일 수 상한(`REPLACE_FILE_LIMIT`)이나 후보 상한에 걸렸다
    pub truncated: bool,
    pub cancelled: bool,
}

/// 적용할 파일 하나: 미리보기의 revision 과 뺄 일치 순번
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceChoice {
    pub path: String,
    pub revision: String,
    pub excluded: Vec<u32>,
}

/// 적용 요청. `pattern` 은 미리보기와 같아야 순번이 같은 일치를 가리킨다 (revision 이 같으면 원문도 같다)
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePlan {
    pub pattern: ReplacePattern,
    pub files: Vec<ReplaceChoice>,
}

/// 파일 하나의 적용 결과
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReplaceOutcome {
    /// 바꿨다. `backup` 은 원문을 담은 폐기 백업, `revision` 은 바꾼 뒤 파일의 것 (되돌리기의 비교 기준)
    Applied {
        path: String,
        replaced: u32,
        backup: u32,
        revision: String,
    },
    Skipped {
        path: String,
        reason: ReplaceSkipReason,
    },
    Failed {
        path: String,
        message: String,
    },
}

/// 되돌릴 파일 하나: 적용 결과의 백업과 바꾼 뒤 revision
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceUndo {
    pub path: String,
    pub backup: u32,
    pub revision: String,
}

/// 파일 하나의 되돌리기 결과
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReplaceUndoOutcome {
    Restored {
        path: String,
    },
    /// 바꾼 뒤 파일이 또 바뀌어 덮어쓰지 않았다 (사본은 폐기 백업에 남아 있다)
    Skipped {
        path: String,
        reason: ReplaceSkipReason,
    },
    Failed {
        path: String,
        message: String,
    },
}

/// 한 줄 안의 일치: 바이트 범위와 넣을 글자
#[derive(Debug)]
struct Hit {
    start: usize,
    end: usize,
    with: String,
}

/// 같은 엔진으로 찾고 바꾸는 도구. 정규식이면 묶음을 펼치고, 아니면 바꿀 글자를 그대로 넣는다
struct Replacer {
    regex: regex::Regex,
    expand: bool,
    replacement: String,
}

impl Replacer {
    /// 검색과 같은 규칙으로 정규식을 만든다. 찾을 내용이 비었으면 거부한다
    fn new(pattern: &ReplacePattern) -> Result<Self, CoreError> {
        if pattern.text.is_empty() {
            return Err(CoreError::Invalid(
                pick("찾을 내용을 입력하세요", "Enter the text to find").into(),
            ));
        }
        Ok(Self {
            regex: build_matcher(&pattern.text, pattern.regex, pattern.case_sensitive)?,
            expand: pattern.regex,
            replacement: pattern.replacement.clone(),
        })
    }

    /// 줄 본문(줄 끝 제외)의 일치를 차례로 돌려준다
    fn hits(&self, body: &str) -> Vec<Hit> {
        self.regex
            .captures_iter(body)
            .filter_map(|caps| {
                let m = caps.get(0)?;
                let with = if self.expand {
                    let mut out = String::new();
                    caps.expand(&self.replacement, &mut out);
                    out
                } else {
                    self.replacement.clone()
                };
                Some(Hit {
                    start: m.start(),
                    end: m.end(),
                    with,
                })
            })
            .collect()
    }

    /// 어느 줄에든 일치가 있는지
    fn has_match(&self, text: &str) -> bool {
        lines(text).any(|(body, _)| self.regex.is_match(body))
    }

    /// `excluded` 순번을 뺀 일치를 바꾼 원문과 바꾼 수. BOM·줄 끝은 그대로 둔다
    fn apply(&self, text: &str, excluded: &HashSet<u32>) -> (String, u32) {
        let mut out = String::with_capacity(text.len());
        if text.starts_with('\u{feff}') {
            out.push('\u{feff}');
        }
        let mut index = 0u32;
        let mut replaced = 0u32;
        for (body, eol) in lines(text) {
            let mut last = 0;
            for hit in self.hits(body) {
                if !excluded.contains(&index) {
                    out.push_str(&body[last..hit.start]);
                    out.push_str(&hit.with);
                    last = hit.end;
                    replaced += 1;
                }
                index += 1;
            }
            out.push_str(&body[last..]);
            out.push_str(eol);
        }
        (out, replaced)
    }

    /// 파일 하나의 미리보기. 일치가 없으면 None
    fn preview_file(
        &self,
        path: &str,
        repo: Option<String>,
        revision: String,
        text: &str,
    ) -> Option<ReplaceFilePreview> {
        let mut index = 0u32;
        let mut shown = Vec::new();
        let mut hidden_lines = 0u32;
        for (n, (body, _)) in lines(text).enumerate() {
            let hits = self.hits(body);
            if hits.is_empty() {
                continue;
            }
            if shown.len() < REPLACE_PREVIEW_LINES {
                shown.push(preview_line(n, body, &hits, index));
            } else {
                hidden_lines += 1;
            }
            index += hits.len() as u32;
        }
        (index > 0).then(|| ReplaceFilePreview {
            path: path.to_owned(),
            repo,
            revision,
            matches: index,
            lines: shown,
            hidden_lines,
        })
    }
}

/// 원문을 (줄 끝을 뺀 본문, 줄 끝) 으로 나눈다. 첫 줄 앞 BOM 은 본문에서 뺀다 (적용이 따로 붙인다)
fn lines(text: &str) -> impl Iterator<Item = (&str, &str)> {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .split_inclusive('\n')
        .map(|line| match line.strip_suffix('\n') {
            Some(rest) => match rest.strip_suffix('\r') {
                Some(body) => (body, "\r\n"),
                None => (rest, "\n"),
            },
            None => (line, ""),
        })
}

/// UTF-16 단위 길이 (편집기·검색 결과의 열과 같은 단위)
fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// 줄에서 보일 바이트 범위: 짧으면 줄 전체, 길면 첫 일치 앞 `LINE_LEAD` 글자부터 `LINE_WINDOW` 글자
fn window(body: &str, first: usize) -> (usize, usize) {
    if body.chars().count() <= LINE_WINDOW {
        return (0, body.len());
    }
    let skip = body[..first].chars().count().saturating_sub(LINE_LEAD);
    let from = body.char_indices().nth(skip).map_or(body.len(), |(i, _)| i);
    let to = body[from..]
        .char_indices()
        .nth(LINE_WINDOW)
        .map_or(body.len(), |(i, _)| from + i);
    (from, to)
}

/// 바뀌는 줄 하나의 미리보기. 보이는 범위 안에 온전히 든 일치만 위치를 싣고 나머지는 `hidden` 으로 센다
fn preview_line(n: usize, body: &str, hits: &[Hit], first_index: u32) -> ReplaceLine {
    let (from, to) = window(body, hits.first().map_or(0, |h| h.start));
    let mut matches = Vec::new();
    let mut hidden = 0;
    for (i, hit) in hits.iter().enumerate() {
        if hit.start >= from && hit.end <= to {
            let start = utf16_len(&body[from..hit.start]);
            matches.push(ReplaceMatch {
                index: first_index + i as u32,
                start,
                end: start + utf16_len(&body[hit.start..hit.end]),
                replacement: hit.with.clone(),
            });
        } else {
            hidden += 1;
        }
    }
    ReplaceLine {
        line: n as u32 + 1,
        text: body[from..to].to_owned(),
        cut_start: from > 0,
        cut_end: to < body.len(),
        matches,
        hidden,
    }
}

/// 후보를 내용 검색과 같은 순서·규칙(`walk_roots` — 그룹은 있는 멤버마다, 범위가 별칭이면 그 멤버만)으로 돌며 바꿀
/// 파일을 모은다. 결과·제외 경로와 초안 비교는 공간 경로(그룹은 `별칭/…`)이고, 파일 읽기는 그 루트 기준 경로로 한다
fn preview(
    roots: Vec<SearchRoot>,
    query: ReplaceQuery,
    cancel: CancelToken,
) -> Result<ReplacePreview, CoreError> {
    check_scope(&query.scope)?;
    let replacer = Replacer::new(&query.pattern)?;
    let drafts: HashSet<String> = query.drafts.into_iter().collect();
    let mut out = ReplacePreview::default();
    let walked = walk_roots(roots, &query.scope, &query.path_filter, &cancel, |c| {
        // 찾기는 가벼운 읽기로 하고, 일치가 있는 파일만 편집 조회(revision·줄 끝 판정)를 한다
        match read_file_at(c.root, c.path) {
            Ok(FsFile::Text { text, .. }) if replacer.has_match(&text) => {}
            Ok(FsFile::Text { .. }) => return true,
            _ => {
                out.unreadable += 1;
                return true;
            }
        }
        let excluded = |reason| ReplaceExcluded {
            path: c.shown.to_owned(),
            reason,
        };
        let repo = c.repo();
        if drafts.contains(c.shown) {
            out.excluded.push(excluded(ReplaceSkipReason::Draft));
            return true;
        }
        if repo.is_none() {
            out.excluded
                .push(excluded(ReplaceSkipReason::OutsideRepository));
            return true;
        }
        // UTF-8 로만 읽는다: 그사이 UTF-8 이 아니게 바뀌었으면 `Lossy` 라 읽지 못한 수에 든다 (R2 — 바꾸기는 UTF-8 만)
        match read_editable_at(c.root, c.path, Some(FsEncoding::Utf8)) {
            Ok(FsEditableFile::Text { text, revision, .. }) => {
                out.files
                    .extend(replacer.preview_file(c.shown, repo, revision, &text));
            }
            Ok(FsEditableFile::MixedLineEndings { .. }) => {
                out.excluded
                    .push(excluded(ReplaceSkipReason::MixedLineEndings));
            }
            Ok(FsEditableFile::Unavailable(_) | FsEditableFile::Lossy { .. }) | Err(_) => {
                out.unreadable += 1;
            }
        }
        if out.files.len() >= REPLACE_FILE_LIMIT {
            out.truncated = true;
            return false;
        }
        true
    });
    out.unreadable += walked.skipped;
    out.truncated |= walked.truncated;
    out.cancelled |= walked.cancelled;
    Ok(out)
}

/// 파일의 저장소 기준 상대 경로 (`/` 구분). 두 경로를 정규화해 비교한다 (macOS 의 `/var` → `/private/var` 등)
fn repo_rel(work_tree: &Path, file: &Path) -> Result<String, CoreError> {
    let base = std::fs::canonicalize(work_tree)?;
    let full = std::fs::canonicalize(file)?;
    let rel = full.strip_prefix(&base).map_err(|_| {
        CoreError::Invalid(
            pick("저장소 밖 파일입니다", "The file is outside the repository").into(),
        )
    })?;
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

impl Core {
    /// 여러 파일 바꾸기 미리보기: 내용 검색과 같은 후보에서 바뀌는 줄을 파일마다 모은다. 취소는 검색과 같은 토큰이다.
    /// 그룹은 검색처럼 범위에 드는 멤버마다 훑는다
    pub async fn workspace_replace_preview(
        &self,
        session: SessionId,
        query: ReplaceQuery,
        cancel: CancelToken,
    ) -> Result<ReplacePreview, CoreError> {
        let roots = self.search_roots(session, &query.scope, &cancel).await?;
        run_blocking(move || preview(roots, query, cancel)).await
    }

    /// 고른 파일을 차례로 바꾼다. 파일마다 revision 이 미리보기와 같을 때만 쓰고, 쓰기 직전 원문을 폐기 백업으로 남긴다.
    /// 한 파일의 실패가 나머지를 멈추지 않는다 (요청 전체가 잘못됐을 때만 오류)
    pub async fn workspace_replace_apply(
        &self,
        session: SessionId,
        plan: ReplacePlan,
    ) -> Result<Vec<ReplaceOutcome>, CoreError> {
        let replacer = Replacer::new(&plan.pattern)?;
        let space = self.fs_space(session)?;
        let mut repos = HashMap::new();
        let mut written = Vec::new();
        let mut out = Vec::with_capacity(plan.files.len());
        for choice in plan.files {
            let path = choice.path.clone();
            out.push(
                match self
                    .replace_one(session, &space, &replacer, choice, &mut repos, &mut written)
                    .await
                {
                    Ok(outcome) => outcome,
                    Err(error) => ReplaceOutcome::Failed {
                        path,
                        message: error.to_string(),
                    },
                },
            );
        }
        self.refresh_after_writes(&written).await;
        Ok(out)
    }

    /// 바꾼 파일을 백업 사본으로 되돌린다. 바꾼 뒤 파일이 또 바뀌었으면(revision 불일치) 덮어쓰지 않고 건너뛴다
    pub async fn workspace_replace_undo(
        &self,
        session: SessionId,
        items: Vec<ReplaceUndo>,
    ) -> Result<Vec<ReplaceUndoOutcome>, CoreError> {
        let space = self.fs_space(session)?;
        let mut written = Vec::new();
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let path = item.path.clone();
            out.push(
                match self.undo_one(session, &space, item, &mut written).await {
                    Ok(outcome) => outcome,
                    Err(error) => ReplaceUndoOutcome::Failed {
                        path,
                        message: error.to_string(),
                    },
                },
            );
        }
        self.refresh_after_writes(&written).await;
        Ok(out)
    }

    /// 공용 저장 경로로 쓰되 갱신은 미룬다. 변경 잠금은 파일마다 쥐었다 놓아 편집기 저장이 사이에 끼어들 수 있고,
    /// 저장한 대상은 `written` 에 모아 묶음 끝에 세션마다 한 번 다시 읽는다 (파일마다 `git status` 를 돌리지 않는다)
    async fn write_deferred(
        &self,
        session: SessionId,
        path: &str,
        revision: &str,
        text: String,
        written: &mut Vec<Written>,
    ) -> Result<FsSaveResult, CoreError> {
        let _mutation_guard = super::FS_MUTATION_LOCK.lock().await;
        // 바꾸기는 UTF-8 파일만 다룬다 (UTF-8 이 아닌 파일은 미리보기에서 빠진다, R2)
        let (result, done) = self
            .fs_write_unrefreshed(
                session,
                path,
                revision,
                SaveContent::Text(text),
                FsEncoding::Utf8,
            )
            .await?;
        written.extend(done);
        Ok(result)
    }

    /// 파일 하나 바꾸기: 편집 조회로 revision 확인 → 바꿀 원문 계산 → 저장소 확인·폐기 백업 → 공용 저장 경로. 저장하지
    /// 못했으면 쓰지 않은 백업을 지운다
    async fn replace_one(
        &self,
        session: SessionId,
        space: &FsSpace,
        replacer: &Replacer,
        choice: ReplaceChoice,
        repos: &mut HashMap<PathBuf, Option<PathBuf>>,
        written: &mut Vec<Written>,
    ) -> Result<ReplaceOutcome, CoreError> {
        let skipped = |reason| ReplaceOutcome::Skipped {
            path: choice.path.clone(),
            reason,
        };
        let (root, rest) = space.locate(&choice.path)?.into_under(&choice.path)?;
        let (read_root, read_rest) = (root.clone(), rest.clone());
        let text = match run_blocking(move || {
            read_editable_at(&read_root, &read_rest, Some(FsEncoding::Utf8))
        })
        .await?
        {
            FsEditableFile::Text { text, revision, .. } if revision == choice.revision => text,
            FsEditableFile::MixedLineEndings { revision, .. } if revision == choice.revision => {
                return Ok(skipped(ReplaceSkipReason::MixedLineEndings));
            }
            _ => return Ok(skipped(ReplaceSkipReason::Changed)),
        };
        let excluded: HashSet<u32> = choice.excluded.iter().copied().collect();
        let (next, replaced) = replacer.apply(&text, &excluded);
        if replaced == 0 || next == text {
            return Ok(skipped(ReplaceSkipReason::Unchanged));
        }
        let file = root.join(&rest);
        let Some(work_tree) = self.replace_repo(&file, repos).await? else {
            return Ok(skipped(ReplaceSkipReason::OutsideRepository));
        };
        let rel = repo_rel(&work_tree, &file)?;
        let backup = self.backup_text(&work_tree, &rel, REPLACE_BACKUP_REASON, &text)?;
        let saved = self
            .write_deferred(session, &choice.path, &choice.revision, next, written)
            .await;
        let outcome = match saved {
            Ok(FsSaveResult::Saved { revision }) => {
                return Ok(ReplaceOutcome::Applied {
                    path: choice.path,
                    replaced,
                    backup: u32::try_from(backup).unwrap_or(u32::MAX),
                    revision,
                });
            }
            Ok(FsSaveResult::Conflict) => skipped(ReplaceSkipReason::Changed),
            Ok(FsSaveResult::Failed { message }) => ReplaceOutcome::Failed {
                path: choice.path.clone(),
                message,
            },
            Err(error) => ReplaceOutcome::Failed {
                path: choice.path.clone(),
                message: error.to_string(),
            },
        };
        self.drop_backup(backup);
        Ok(outcome)
    }

    /// 파일을 품은 저장소의 작업 트리. 같은 디렉터리는 한 번만 묻는다. 저장소 밖이면 None
    async fn replace_repo(
        &self,
        file: &Path,
        cache: &mut HashMap<PathBuf, Option<PathBuf>>,
    ) -> Result<Option<PathBuf>, CoreError> {
        let dir = file.parent().unwrap_or(file).to_path_buf();
        if let Some(found) = cache.get(&dir) {
            return Ok(found.clone());
        }
        let found = match discover(self.inner().runner(), &dir).await {
            Ok(repo) => Some(repo.work_tree),
            Err(GitError::NotARepository(_)) => None,
            Err(error) => return Err(error.into()),
        };
        cache.insert(dir, found.clone());
        Ok(found)
    }

    /// 쓰지 않은 바꾸기 백업을 지운다. 못 지워도 보관 기간이 지나면 자동 정리가 지우므로 기록만 남긴다
    fn drop_backup(&self, id: u64) {
        let removed = match self.store().backup_get(id) {
            Ok(Some(rec)) => self.inner().delete_file_backup(&rec),
            Ok(None) => Ok(()),
            Err(error) => Err(error.into()),
        };
        if let Err(error) = removed {
            tracing::debug!(id, error = %error, "쓰지 않은 바꾸기 백업을 지우지 못했다");
        }
    }

    /// 파일 하나 되돌리기: 백업이 바꾸기의 것이고 같은 파일을 가리키는지 확인 → 사본 원문을 공용 저장 경로로 쓴다
    async fn undo_one(
        &self,
        session: SessionId,
        space: &FsSpace,
        item: ReplaceUndo,
        written: &mut Vec<Written>,
    ) -> Result<ReplaceUndoOutcome, CoreError> {
        let rec = self
            .store()
            .backup_get(u64::from(item.backup))?
            .filter(|rec| rec.reason == REPLACE_BACKUP_REASON)
            .ok_or_else(|| {
                CoreError::Invalid(tr!(
                    "백업을 찾을 수 없습니다: {}",
                    "Backup not found: {}",
                    item.backup
                ))
            })?;
        let (root, rest) = space.locate(&item.path)?.into_under(&item.path)?;
        parse(&rest)?;
        let Ok(current) = std::fs::canonicalize(root.join(&rest)) else {
            return Ok(ReplaceUndoOutcome::Skipped {
                path: item.path,
                reason: ReplaceSkipReason::Changed,
            });
        };
        if std::fs::canonicalize(rec.repo.join(&rec.rel_path)).ok() != Some(current) {
            return Err(CoreError::Invalid(
                pick(
                    "다른 파일의 백업입니다",
                    "This backup belongs to another file",
                )
                .into(),
            ));
        }
        let text = std::fs::read_to_string(&rec.blob_path)?;
        Ok(
            match self
                .write_deferred(session, &item.path, &item.revision, text, written)
                .await?
            {
                FsSaveResult::Saved { .. } => ReplaceUndoOutcome::Restored { path: item.path },
                FsSaveResult::Conflict => ReplaceUndoOutcome::Skipped {
                    path: item.path,
                    reason: ReplaceSkipReason::Changed,
                },
                FsSaveResult::Failed { message } => ReplaceUndoOutcome::Failed {
                    path: item.path,
                    message,
                },
            },
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 시험용 순회 루트 하나 (`prefix` 가 비면 디렉터리 공간, 아니면 그룹 멤버 별칭)
    fn only(root: &Path, prefix: &str) -> SearchRoot {
        SearchRoot {
            prefix: prefix.into(),
            root: root.to_path_buf(),
            repos: vec![],
            tracked: vec![],
        }
    }

    /// 시험용 찾기·바꾸기
    fn pattern(text: &str, regex: bool, replacement: &str) -> ReplacePattern {
        ReplacePattern {
            text: text.into(),
            regex,
            case_sensitive: true,
            replacement: replacement.into(),
        }
    }

    /// 정규식 묶음을 펼쳐 바꾸고, 미리보기의 일치 순번으로 뺀 일치는 그대로 둔다. BOM·CRLF·마지막 줄 끝 없음은 그대로다
    #[test]
    fn expands_captures_and_keeps_bom_and_line_endings() {
        let r = Replacer::new(&pattern(r"foo\((\d+)\)", true, "bar[$1]")).unwrap();
        let text = "\u{feff}foo(1)\r\nx foo(22) foo(3)\r\nend";
        let (all, n) = r.apply(text, &HashSet::new());
        assert_eq!(all, "\u{feff}bar[1]\r\nx bar[22] bar[3]\r\nend");
        assert_eq!(n, 3);
        let (some, n) = r.apply(text, &HashSet::from([1]));
        assert_eq!(some, "\u{feff}bar[1]\r\nx foo(22) bar[3]\r\nend");
        assert_eq!(n, 2);
        let file = r
            .preview_file("a.txt", Some(String::new()), "rev".into(), text)
            .unwrap();
        assert_eq!(file.matches, 3);
        assert_eq!(file.lines.len(), 2);
        // BOM 은 첫 줄 본문에서 빠지고 `^` 가 첫 줄에도 맞는다
        assert_eq!(file.lines[0].text, "foo(1)");
        assert_eq!(
            file.lines[1].matches,
            vec![
                ReplaceMatch {
                    index: 1,
                    start: 2,
                    end: 9,
                    replacement: "bar[22]".into()
                },
                ReplaceMatch {
                    index: 2,
                    start: 10,
                    end: 16,
                    replacement: "bar[3]".into()
                },
            ]
        );
        let anchored = Replacer::new(&pattern("^foo", true, "X")).unwrap();
        assert_eq!(
            anchored.apply(text, &HashSet::new()).0,
            "\u{feff}X(1)\r\nx foo(22) foo(3)\r\nend"
        );
    }

    /// 글자 그대로 모드는 `$1` 을 펼치지 않고 정규식 기호를 이스케이프한다. 대소문자 무시도 검색과 같다
    #[test]
    fn literal_mode_inserts_replacement_verbatim() {
        let mut p = pattern("a.b", false, "$1$$");
        p.case_sensitive = false;
        let r = Replacer::new(&p).unwrap();
        assert_eq!(r.apply("A.B axb\n", &HashSet::new()).0, "$1$$ axb\n");
        assert!(Replacer::new(&pattern("", false, "x")).is_err());
        assert!(Replacer::new(&pattern("(", true, "x")).is_err());
    }

    /// 한글·이모지 줄의 위치는 UTF-16 단위이고, 긴 줄은 첫 일치 앞에서 잘라 범위 밖 일치를 `hidden` 으로 센다
    #[test]
    fn preview_positions_are_utf16_and_long_lines_are_windowed() {
        let r = Replacer::new(&pattern("x", false, "y")).unwrap();
        let file = r.preview_file("a", None, "r".into(), "한😀x\n").unwrap();
        assert_eq!(file.lines[0].matches[0].start, 3);
        let long = format!("{}x{}x", "a".repeat(500), "b".repeat(400));
        let file = r.preview_file("a", None, "r".into(), &long).unwrap();
        let line = &file.lines[0];
        assert!(line.cut_start && line.cut_end);
        assert_eq!(line.text.chars().count(), LINE_WINDOW);
        assert_eq!(line.matches.len(), 1);
        assert_eq!(line.matches[0].start, LINE_LEAD as u32);
        assert_eq!(line.hidden, 1);
    }

    /// 파일마다 바뀌는 줄은 `REPLACE_PREVIEW_LINES` 까지만 싣고 나머지는 줄 수만 센다 (일치 수는 전체)
    #[test]
    fn preview_caps_lines_per_file() {
        let r = Replacer::new(&pattern("k", false, "v")).unwrap();
        let text = "k\n".repeat(REPLACE_PREVIEW_LINES + 5);
        let file = r.preview_file("a", None, "r".into(), &text).unwrap();
        assert_eq!(file.lines.len(), REPLACE_PREVIEW_LINES);
        assert_eq!(file.hidden_lines, 5);
        assert_eq!(file.matches as usize, REPLACE_PREVIEW_LINES + 5);
        assert!(r.preview_file("a", None, "r".into(), "none\n").is_none());
    }

    /// 제외 규칙: 줄 끝 혼합·초안·저장소 밖은 사유로, 1 MiB 초과·바이너리는 읽지 못한 수로 센다
    #[test]
    fn preview_excludes_with_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("repo/.git")).unwrap();
        std::fs::write(root.join("repo/a.txt"), "needle\n").unwrap();
        std::fs::write(root.join("repo/mixed.txt"), "needle\r\nx\n").unwrap();
        std::fs::write(root.join("repo/draft.txt"), "needle\n").unwrap();
        std::fs::write(root.join("repo/none.txt"), "nothing\n").unwrap();
        std::fs::write(root.join("repo/bin.dat"), b"needle\0").unwrap();
        let big = format!(
            "needle\n{}",
            "x".repeat(super::super::FS_READ_MAX_BYTES as usize)
        );
        std::fs::write(root.join("repo/big.txt"), big).unwrap();
        std::fs::write(root.join("loose.txt"), "needle\n").unwrap();
        let query = ReplaceQuery {
            pattern: pattern("needle", false, "pin"),
            path_filter: String::new(),
            scope: String::new(),
            drafts: vec!["repo/draft.txt".into()],
        };
        let found = preview(vec![only(root, "")], query, CancelToken::new()).unwrap();
        let files: Vec<_> = found.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, ["repo/a.txt"]);
        assert_eq!(found.files[0].repo.as_deref(), Some("repo"));
        let mut excluded: Vec<_> = found
            .excluded
            .iter()
            .map(|e| (e.path.as_str(), e.reason))
            .collect();
        excluded.sort_by_key(|e| e.0);
        assert_eq!(
            excluded,
            [
                ("loose.txt", ReplaceSkipReason::OutsideRepository),
                ("repo/draft.txt", ReplaceSkipReason::Draft),
                ("repo/mixed.txt", ReplaceSkipReason::MixedLineEndings),
            ]
        );
        assert_eq!(found.unreadable, 2);
    }

    /// 그룹 멤버 루트(별칭 접두)를 차례로 훑으면 결과·제외 경로와 저장소가 `별칭/…` 이고, 초안·경로 필터도 그 경로로 본다.
    /// 범위가 별칭이면 그 멤버만 훑는다
    #[test]
    fn preview_walks_member_roots_with_alias_paths() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for dir in [a.path(), b.path()] {
            std::fs::create_dir_all(dir.join(".git")).unwrap();
            std::fs::write(dir.join("x.txt"), "needle\n").unwrap();
        }
        std::fs::write(b.path().join("draft.txt"), "needle\n").unwrap();
        let roots = || vec![only(a.path(), "api"), only(b.path(), "web")];
        let query = |scope: &str, path_filter: &str| ReplaceQuery {
            pattern: pattern("needle", false, "pin"),
            path_filter: path_filter.into(),
            scope: scope.into(),
            drafts: vec!["web/draft.txt".into()],
        };
        let found = preview(roots(), query("", ""), CancelToken::new()).unwrap();
        let mut files: Vec<_> = found
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.repo.as_deref()))
            .collect();
        files.sort_unstable();
        assert_eq!(
            files,
            [("api/x.txt", Some("api")), ("web/x.txt", Some("web"))]
        );
        assert_eq!(
            found.excluded,
            [ReplaceExcluded {
                path: "web/draft.txt".into(),
                reason: ReplaceSkipReason::Draft
            }]
        );
        let scoped = preview(roots(), query("web", ""), CancelToken::new()).unwrap();
        let paths: Vec<_> = scoped.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["web/x.txt"]);
        let filtered = preview(roots(), query("", "API/"), CancelToken::new()).unwrap();
        let paths: Vec<_> = filtered.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["api/x.txt"]);
    }
}
