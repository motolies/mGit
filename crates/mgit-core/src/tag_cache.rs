//! 원격 tag 상태 캐시 (TG-08 ②, D6). 저장소(canonical `common_dir`)마다, 원격마다 메모리에만 둔다 — 같은 저장소의
//! 워크트리 탭끼리 공유하고 마지막 세션을 닫으면 지운다. 명시적인 "원격 확인"(전체 조회)만 채우고, 앱의 push·삭제·조회
//! 결과는 ref 단위로 고친다(네트워크 없이 표시가 바뀐다). 표시용이며 원격 삭제의 lease 근거로 쓰지 않는다 (D7).
//!
//! 무효화 (4절 표): 로컬 tag 집합을 바꾼 fetch·pull, follow-tags push, 결과를 알 수 없는 작업은 `stale` 로 표시한다.
//! 원격 이름·URL 이 바뀐 것은 읽을 때 지금 원격 목록과 비교해 버린다. 조회가 도는 동안 쓰기 결과가 반영됐으면
//! (`mutated_at > 조회 시작`) 그 조회 결과는 `stale` 로 둔다

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use mgit_model::{RemoteInfo, RemoteTag, TagLookupError};

/// 원격 하나의 캐시
#[derive(Clone, Debug)]
pub(crate) struct RemoteTagCache {
    /// 원격 tag 표 (이름 → 원격 tag)
    pub tags: HashMap<String, RemoteTag>,
    /// 결과를 알 수 없는 작업 뒤라 상태를 모르는 이름
    pub unknown: HashSet<String>,
    /// 마지막으로 성공한 전체 조회 시각 (epoch 밀리초). 실패만 있었으면 `None`
    pub checked_at: Option<i64>,
    pub stale: bool,
    pub last_error: Option<TagLookupError>,
    /// 조회 때의 fetch URL. 지금 URL 과 다르면 캐시를 버린다
    pub fetch_url: String,
    /// 마지막으로 쓰기 결과·무효화가 반영된 때 (늦게 끝난 조회 판정)
    pub mutated_at: Option<Instant>,
}

impl RemoteTagCache {
    /// 빈 캐시 (조회 실패를 처음 기록할 때)
    fn empty(fetch_url: &str) -> Self {
        RemoteTagCache {
            tags: HashMap::new(),
            unknown: HashSet::new(),
            checked_at: None,
            stale: false,
            last_error: None,
            fetch_url: fetch_url.to_string(),
            mutated_at: None,
        }
    }

    /// 원격 tag 표를 이름순 목록으로
    pub fn tag_list(&self) -> Vec<RemoteTag> {
        let mut list: Vec<RemoteTag> = self.tags.values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }
}

/// 저장소별·원격별 캐시 모음
#[derive(Debug, Default)]
pub(crate) struct TagCache {
    repos: Mutex<HashMap<PathBuf, HashMap<String, RemoteTagCache>>>,
}

/// 쓰기 잠금과 같은 규칙의 키 (워크트리 세션들이 같은 키를 쓴다)
fn key(common_dir: &Path) -> PathBuf {
    common_dir
        .canonicalize()
        .unwrap_or_else(|_| common_dir.to_path_buf())
}

impl TagCache {
    /// 잠금을 쥐고 저장소의 원격별 캐시를 본다
    fn with_repo<R>(
        &self,
        common_dir: &Path,
        f: impl FnOnce(&mut HashMap<String, RemoteTagCache>) -> R,
    ) -> R {
        let mut repos = self.repos.lock().unwrap_or_else(PoisonError::into_inner);
        let repo = repos.entry(key(common_dir)).or_default();
        f(repo)
    }

    /// 지금 원격 목록과 맞지 않는 캐시(사라진 원격, URL 이 바뀐 원격)를 버리고 `remote` 의 사본을 준다
    pub fn view(
        &self,
        common_dir: &Path,
        remotes: &[RemoteInfo],
        remote: &str,
    ) -> Option<RemoteTagCache> {
        self.with_repo(common_dir, |repo| {
            repo.retain(|name, cache| {
                remotes
                    .iter()
                    .any(|r| r.name == *name && r.fetch_url == cache.fetch_url)
            });
            repo.get(remote).cloned()
        })
    }

    /// 이 저장소에 캐시가 하나라도 있는지 (없으면 무효화 계산을 건너뛴다)
    pub fn has_repo(&self, common_dir: &Path) -> bool {
        self.repos
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key(common_dir))
            .is_some_and(|r| !r.is_empty())
    }

    /// 이 원격의 캐시가 있는지
    pub fn has_remote(&self, common_dir: &Path, remote: &str) -> bool {
        self.repos
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key(common_dir))
            .is_some_and(|r| r.contains_key(remote))
    }

    /// 전체 조회 결과로 바꾼다. 조회가 도는 동안(`started` 뒤) 쓰기 결과가 반영됐으면 `stale`
    pub fn replace(
        &self,
        common_dir: &Path,
        remote: &str,
        fetch_url: &str,
        tags: Vec<RemoteTag>,
        checked_at: i64,
        started: Instant,
    ) {
        self.with_repo(common_dir, |repo| {
            let late = repo
                .get(remote)
                .and_then(|c| c.mutated_at)
                .is_some_and(|m| m > started);
            repo.insert(
                remote.to_string(),
                RemoteTagCache {
                    tags: tags.into_iter().map(|t| (t.name.clone(), t)).collect(),
                    unknown: HashSet::new(),
                    checked_at: Some(checked_at),
                    stale: late,
                    last_error: None,
                    fetch_url: fetch_url.to_string(),
                    mutated_at: None,
                },
            );
        });
    }

    /// 조회 실패를 남긴다. 이전 값은 그대로 둔다 (없으면 빈 캐시에 오류만)
    pub fn record_error(
        &self,
        common_dir: &Path,
        remote: &str,
        fetch_url: &str,
        error: TagLookupError,
    ) {
        self.with_repo(common_dir, |repo| {
            let cache = repo
                .entry(remote.to_string())
                .or_insert_with(|| RemoteTagCache::empty(fetch_url));
            cache.last_error = Some(error);
        });
    }

    /// 이름 몇 개의 조회 결과(단일 조회)를 반영한다: 찾은 것은 넣고 없는 것은 뺀다. 캐시가 없으면 만들지 않는다
    /// (일부 이름만으로는 원격 전체를 알 수 없다)
    pub fn apply_lookup(
        &self,
        common_dir: &Path,
        remote: &str,
        names: &[String],
        found: &HashMap<String, RemoteTag>,
    ) {
        self.with_repo(common_dir, |repo| {
            let Some(cache) = repo.get_mut(remote) else {
                return;
            };
            for name in names {
                match found.get(name) {
                    Some(t) => {
                        cache.tags.insert(name.clone(), t.clone());
                    }
                    None => {
                        cache.tags.remove(name);
                    }
                }
                cache.unknown.remove(name);
            }
        });
    }

    /// 쓰기 결과를 반영한다 (캐시가 있을 때만). 반영한 때를 남겨 그 전에 시작한 조회를 `stale` 로 만든다
    pub fn patch(&self, common_dir: &Path, remote: &str, f: impl FnOnce(&mut RemoteTagCache)) {
        self.with_repo(common_dir, |repo| {
            if let Some(cache) = repo.get_mut(remote) {
                f(cache);
                cache.mutated_at = Some(Instant::now());
            }
        });
    }

    /// 원격 하나를 오래됨으로
    pub fn mark_stale(&self, common_dir: &Path, remote: &str) {
        self.patch(common_dir, remote, |c| c.stale = true);
    }

    /// 저장소의 모든 원격을 오래됨으로
    pub fn mark_stale_all(&self, common_dir: &Path) {
        self.with_repo(common_dir, |repo| {
            let now = Instant::now();
            for cache in repo.values_mut() {
                cache.stale = true;
                cache.mutated_at = Some(now);
            }
        });
    }

    /// 저장소의 캐시를 지운다 (마지막 세션을 닫을 때)
    pub fn remove_repo(&self, common_dir: &Path) {
        self.repos
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key(common_dir));
    }
}

#[cfg(test)]
mod tests {
    use mgit_model::{Oid, TagLookupErrorKind};

    use super::*;

    /// 글자 하나로 만든 oid
    fn o(c: char) -> Oid {
        Oid::from_hex(c.to_string().repeat(40).as_bytes()).unwrap_or_else(|_| unreachable!())
    }

    /// 원격 정보
    fn info(name: &str, url: &str) -> RemoteInfo {
        RemoteInfo {
            name: name.into(),
            fetch_url: url.into(),
            push_url: None,
        }
    }

    /// 경량 원격 tag
    fn tag(name: &str, c: char) -> RemoteTag {
        RemoteTag {
            name: name.into(),
            object: o(c),
            peeled: None,
        }
    }

    #[test]
    fn view_drops_renamed_or_moved_remotes() {
        let cache = TagCache::default();
        let dir = Path::new("/nonexistent/mgit-tag-cache");
        let started = Instant::now();
        cache.replace(dir, "origin", "u1", vec![tag("v1", 'a')], 1, started);
        cache.replace(dir, "upstream", "u2", vec![], 1, started);
        assert!(cache.view(dir, &[info("origin", "u1")], "origin").is_some());
        // URL 이 바뀌면 버린다
        assert!(cache.view(dir, &[info("origin", "u9")], "origin").is_none());
        // 이름이 바뀌면(원격 목록에 없으면) 버린다
        assert!(!cache.has_remote(dir, "upstream"));
    }

    #[test]
    fn late_lookup_is_stale_and_patch_needs_cache() {
        let cache = TagCache::default();
        let dir = Path::new("/nonexistent/mgit-tag-cache-2");
        // 캐시가 없으면 패치는 아무것도 만들지 않는다
        cache.patch(dir, "origin", |c| c.stale = true);
        assert!(!cache.has_repo(dir));
        let first = Instant::now();
        cache.replace(dir, "origin", "u", vec![], 1, first);
        let started = Instant::now();
        cache.patch(dir, "origin", |c| {
            c.tags.insert("v1".into(), tag("v1", 'a'));
        });
        cache.replace(dir, "origin", "u", vec![], 2, started);
        let view = cache.view(dir, &[info("origin", "u")], "origin");
        assert!(view.as_ref().is_some_and(|c| c.stale), "{view:?}");
        // 실패 기록은 이전 값을 지우지 않는다
        cache.record_error(
            dir,
            "origin",
            "u",
            TagLookupError {
                kind: TagLookupErrorKind::Network,
                at: 3,
                message: "x".into(),
            },
        );
        let view = cache.view(dir, &[info("origin", "u")], "origin");
        assert_eq!(view.as_ref().and_then(|c| c.checked_at), Some(2));
        assert!(view.and_then(|c| c.last_error).is_some());
        cache.remove_repo(dir);
        assert!(!cache.has_repo(dir));
    }
}
