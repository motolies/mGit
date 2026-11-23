//! 파일 감시 (`mgit-model::Watcher` 구현).
//!
//! 명세 3.2 `.git` 감시 규칙:
//! - 파일이 아니라 디렉터리를 감시한다 (`*.lock` 뒤 rename 으로 교체되므로)
//! - `$GIT_DIR`·`$GIT_COMMON_DIR` 은 비재귀, `refs/` 는 재귀 (reftable 이면 `reftable/`)
//! - `*.lock` 이벤트는 무시하고 경로로 종류를 분류해 100~200ms 디바운스 후 한 번만 알린다.
//!   변경이 끊이지 않으면 최대 대기 시간마다 알리고, 무시되는 이벤트는 디바운스 타이머를 건드리지 않는다
//! - 작업 트리 전체 감시는 탭으로 연 저장소에만 건다

mod classify;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mgit_model::{ChangeKind, ChangeSet, OnChange, WatchError, WatchHandle, WatchSpec, Watcher};
use notify::{Config, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher as _};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

pub use classify::classify_path;

/// notify 기반 감시자. tokio 런타임 안에서 `watch` 를 불러야 한다
#[derive(Clone, Debug)]
pub struct NotifyWatcher {
    /// 마지막 이벤트 뒤 이 시간 동안 조용하면 묶음을 보낸다
    pub debounce: Duration,
    /// 변경이 끊이지 않아도 첫 변경 뒤 이 시간이 지나면 묶음을 보낸다
    pub max_wait: Duration,
    /// 폴링 대체 경로의 간격
    pub poll_interval: Duration,
}

impl Default for NotifyWatcher {
    fn default() -> Self {
        NotifyWatcher {
            debounce: Duration::from_millis(150),
            max_wait: Duration::from_secs(2),
            poll_interval: Duration::from_secs(2),
        }
    }
}

/// 감시 핸들: notify 감시자와 디바운스 태스크. 드롭하면 둘 다 멈춘다
struct NotifyHandle {
    /// `Sync` 가 아닌 notify 감시자를 `Mutex` 로 감싸 핸들을 스레드 간에 공유할 수 있게 한다
    _watcher: std::sync::Mutex<Box<dyn notify::Watcher + Send>>,
    task: JoinHandle<()>,
}

impl Drop for NotifyHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl WatchHandle for NotifyHandle {}

/// 원시 이벤트에서 뽑은 경로 묶음
type RawPaths = Vec<PathBuf>;

impl NotifyWatcher {
    /// 감시 대상 디렉터리와 재귀 모드를 결정한다
    fn targets(spec: &WatchSpec) -> Vec<(PathBuf, RecursiveMode)> {
        let mut v = vec![(spec.git_dir.clone(), RecursiveMode::NonRecursive)];
        if spec.common_dir != spec.git_dir {
            v.push((spec.common_dir.clone(), RecursiveMode::NonRecursive));
        }
        let reftable = spec.common_dir.join("reftable");
        if reftable.is_dir() {
            v.push((reftable, RecursiveMode::Recursive));
        } else {
            v.push((spec.common_dir.join("refs"), RecursiveMode::Recursive));
        }
        if let Some(wt) = &spec.work_tree {
            v.push((wt.clone(), RecursiveMode::Recursive));
        }
        v
    }

    /// notify 감시자를 만들고 대상 경로를 등록한다. 실패하면 폴링으로 대체한다
    fn create(
        &self,
        spec: &WatchSpec,
        tx: mpsc::UnboundedSender<RawPaths>,
    ) -> Result<Box<dyn notify::Watcher + Send>, WatchError> {
        let handler = move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev.paths);
            }
        };
        let targets = Self::targets(spec);
        if !spec.poll
            && let Ok(mut w) = RecommendedWatcher::new(handler.clone(), Config::default())
        {
            let mut ok = true;
            for (path, mode) in &targets {
                if path.exists() && w.watch(path, *mode).is_err() {
                    ok = false;
                    break;
                }
            }
            if ok {
                return Ok(Box::new(w));
            }
            tracing::warn!(?spec.git_dir, "notify 감시 등록 실패, 폴링으로 대체");
        }
        let mut w = PollWatcher::new(
            handler,
            Config::default().with_poll_interval(self.poll_interval),
        )
        .map_err(|e| WatchError::Init(e.to_string()))?;
        for (path, mode) in &targets {
            if path.exists() {
                w.watch(path, *mode)
                    .map_err(|e| WatchError::Init(e.to_string()))?;
            }
        }
        Ok(Box::new(w))
    }
}

impl Watcher for NotifyWatcher {
    /// 감시를 시작한다. 디바운스 태스크가 분류·합산해 콜백을 부른다
    fn watch(
        &self,
        spec: WatchSpec,
        on_change: OnChange,
    ) -> Result<Box<dyn WatchHandle>, WatchError> {
        let (tx, rx) = mpsc::unbounded_channel::<RawPaths>();
        let watcher = self.create(&spec, tx)?;
        let handle = tokio::runtime::Handle::try_current().map_err(outside_runtime)?;
        let task = handle.spawn(debounce_loop(
            spec,
            rx,
            on_change,
            self.debounce,
            self.max_wait,
        ));
        Ok(Box::new(NotifyHandle {
            _watcher: std::sync::Mutex::new(watcher),
            task,
        }))
    }

    /// 디렉터리 비재귀 감시 (MR-10). 어떤 이벤트든 디바운스 뒤 한 번 알린다
    fn watch_dir(
        &self,
        dir: PathBuf,
        on_change: OnChange,
    ) -> Result<Box<dyn WatchHandle>, WatchError> {
        let (tx, rx) = mpsc::unbounded_channel::<RawPaths>();
        let handler = move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev.paths);
            }
        };
        let mut w = RecommendedWatcher::new(handler, Config::default())
            .map_err(|e| WatchError::Init(e.to_string()))?;
        w.watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| WatchError::Init(e.to_string()))?;
        let handle = tokio::runtime::Handle::try_current().map_err(outside_runtime)?;
        let task = handle.spawn(dir_debounce_loop(
            rx,
            on_change,
            self.debounce,
            self.max_wait,
        ));
        Ok(Box::new(NotifyHandle {
            _watcher: std::sync::Mutex::new(Box::new(w)),
            task,
        }))
    }
}

/// 디바운스 창: 마지막 변경 뒤 `debounce` 동안 조용하면 끝나고, 변경이 끊이지 않아도 첫 변경 뒤
/// `max_wait` 가 지나면 끝난다
struct DebounceWindow {
    debounce: Duration,
    max_wait: Duration,
    quiet_at: Option<Instant>,
    limit_at: Option<Instant>,
}

impl DebounceWindow {
    /// 빈 창
    fn new(debounce: Duration, max_wait: Duration) -> Self {
        DebounceWindow {
            debounce,
            max_wait,
            quiet_at: None,
            limit_at: None,
        }
    }

    /// 변경을 기록해 조용한 시간을 다시 잰다. 상한은 첫 변경 기준으로 고정한다
    fn touch(&mut self) {
        let now = Instant::now();
        self.quiet_at = Some(now + self.debounce);
        self.limit_at.get_or_insert(now + self.max_wait);
    }

    /// 묶음을 보낼 시각. 기록된 변경이 없으면 `None`
    fn deadline(&self) -> Option<Instant> {
        Some(self.quiet_at?.min(self.limit_at?))
    }

    /// 묶음을 보낸 뒤 비운다
    fn reset(&mut self) {
        self.quiet_at = None;
        self.limit_at = None;
    }
}

/// tokio 런타임 밖에서 감시를 시작하려 한 오류 (지금 언어)
fn outside_runtime(error: tokio::runtime::TryCurrentError) -> WatchError {
    WatchError::Init(mgit_l10n::tr!(
        "tokio 런타임 밖: {error}",
        "Outside the tokio runtime: {error}"
    ))
}

/// 디렉터리 감시용 디바운스: 조용해지거나 최대 대기 시간이 지나면 한 번 보낸다
async fn dir_debounce_loop(
    mut rx: mpsc::UnboundedReceiver<RawPaths>,
    on_change: OnChange,
    debounce: Duration,
    max_wait: Duration,
) {
    let mut window = DebounceWindow::new(debounce, max_wait);
    while let Some(first) = rx.recv().await {
        let mut set = ChangeSet::default();
        set.add(ChangeKind::WorkTree);
        set.sample_paths.extend(first.into_iter().take(8));
        window.touch();
        while let Some(at) = window.deadline() {
            match tokio::time::timeout_at(at, rx.recv()).await {
                Ok(Some(more)) => {
                    window.touch();
                    for p in more {
                        if set.sample_paths.len() < 8 {
                            set.sample_paths.push(p);
                        }
                    }
                }
                Ok(None) => return,
                Err(_) => window.reset(),
            }
        }
        on_change(set);
    }
}

/// 원시 이벤트를 분류·합산하고, 조용해지거나 최대 대기 시간이 지나면 묶음을 한 번 보낸다.
/// 분류되지 않는 이벤트(빌드 산출물 등)는 타이머를 건드리지 않아 알림을 밀지 못한다
async fn debounce_loop(
    spec: WatchSpec,
    mut rx: mpsc::UnboundedReceiver<RawPaths>,
    on_change: OnChange,
    debounce: Duration,
    max_wait: Duration,
) {
    let mut pending = ChangeSet::default();
    let mut window = DebounceWindow::new(debounce, max_wait);
    loop {
        let next = match window.deadline() {
            None => rx.recv().await,
            Some(at) => match tokio::time::timeout_at(at, rx.recv()).await {
                Ok(v) => v,
                Err(_) => {
                    window.reset();
                    let batch = std::mem::take(&mut pending);
                    on_change(batch);
                    continue;
                }
            },
        };
        let Some(paths) = next else {
            break; // 송신자(notify 감시자)가 드롭됨
        };
        for p in paths {
            if let Some(kind) = classify_path(&p, &spec) {
                pending.add(kind);
                window.touch();
                if pending.sample_paths.len() < 8 {
                    pending.sample_paths.push(p);
                }
            }
        }
    }
}

/// 테스트·외부 도구용: 감시 없이 경로 하나를 분류해 본다
pub fn classify(path: &Path, spec: &WatchSpec) -> Option<mgit_model::ChangeKind> {
    classify_path(path, spec)
}

/// 기본 설정 감시자를 `Arc<dyn Watcher>` 로
pub fn default_watcher() -> Arc<dyn Watcher> {
    Arc::new(NotifyWatcher::default())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod dir_tests {
    use super::*;
    use std::sync::Mutex;

    /// 디렉터리 감시: 하위 폴더가 생기면 한 번 알린다 (MR-10)
    #[tokio::test]
    async fn watch_dir_reports_new_subdir() {
        let root = std::env::temp_dir().join(format!("mgit-watchdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let h2 = Arc::clone(&hits);
        let on_change: OnChange = Arc::new(move |_set| {
            *h2.lock().unwrap() += 1;
        });
        let watcher = NotifyWatcher {
            debounce: Duration::from_millis(100),
            ..NotifyWatcher::default()
        };
        let _handle = watcher.watch_dir(root.clone(), on_change).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::create_dir_all(root.join("newrepo")).unwrap();
        std::fs::write(root.join("newrepo").join("x"), b"x").unwrap();
        let mut waited = 0;
        while *hits.lock().unwrap() == 0 && waited < 6000 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            waited += 100;
        }
        assert!(
            *hits.lock().unwrap() >= 1,
            "디렉터리 생성 이벤트를 받지 못했다"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod debounce_tests {
    use super::*;
    use std::sync::Mutex;

    /// 테스트용 spec
    fn spec() -> WatchSpec {
        WatchSpec::new(
            PathBuf::from("/r/.git"),
            PathBuf::from("/r/.git"),
            Some(PathBuf::from("/r")),
        )
    }

    /// 콜백 횟수를 세는 `OnChange`
    fn counter() -> (Arc<Mutex<u32>>, OnChange) {
        let hits = Arc::new(Mutex::new(0u32));
        let h = Arc::clone(&hits);
        let on_change: OnChange = Arc::new(move |_set| {
            *h.lock().unwrap() += 1;
        });
        (hits, on_change)
    }

    /// 밀리초
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// 분류되는 변경이 끊이지 않아도 최대 대기 시간이 지나면 알린다
    #[tokio::test]
    async fn continuous_changes_flush_at_max_wait() {
        let (tx, rx) = mpsc::unbounded_channel::<RawPaths>();
        let (hits, on_change) = counter();
        let task = tokio::spawn(debounce_loop(spec(), rx, on_change, ms(100), ms(300)));
        for _ in 0..40 {
            tx.send(vec![PathBuf::from("/r/src/a.rs")]).unwrap();
            tokio::time::sleep(ms(25)).await;
        }
        assert!(
            *hits.lock().unwrap() >= 1,
            "이벤트가 이어지는 동안에도 알려야 한다"
        );
        task.abort();
    }

    /// 무시되는 이벤트는 디바운스 타이머를 다시 시작하지 않는다
    #[tokio::test]
    async fn ignored_events_do_not_extend_quiet_period() {
        let (tx, rx) = mpsc::unbounded_channel::<RawPaths>();
        let (hits, on_change) = counter();
        // 상한을 크게 잡아 상한이 아니라 조용한 시간으로 끝나는지 본다
        let task = tokio::spawn(debounce_loop(spec(), rx, on_change, ms(100), ms(60_000)));
        tx.send(vec![PathBuf::from("/r/.git/HEAD")]).unwrap();
        for _ in 0..30 {
            tx.send(vec![PathBuf::from("/r/target/debug/x")]).unwrap();
            tokio::time::sleep(ms(25)).await;
        }
        assert_eq!(
            *hits.lock().unwrap(),
            1,
            "무시 이벤트가 알림을 밀면 안 된다"
        );
        task.abort();
    }

    /// 폴더 루트 디바운스도 이벤트가 이어지는 동안 알린다
    #[tokio::test]
    async fn dir_debounce_flushes_at_max_wait() {
        let (tx, rx) = mpsc::unbounded_channel::<RawPaths>();
        let (hits, on_change) = counter();
        let task = tokio::spawn(dir_debounce_loop(rx, on_change, ms(100), ms(300)));
        for _ in 0..40 {
            tx.send(vec![PathBuf::from("/r/new")]).unwrap();
            tokio::time::sleep(ms(25)).await;
        }
        assert!(*hits.lock().unwrap() >= 1);
        task.abort();
    }
}
