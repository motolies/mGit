use std::path::PathBuf;
use std::time::Duration;

/// 폴더 하나가 동시에 잡을 수 있는 가벼운 세션 수 (계획 5.1절·결정 13번, PF-05). 넘으면 열지 않고
/// `CoreError::LightSessionLimit` 을 돌려준다 — 무엇을 내려놓을지는 초안·실행 중 작업을 아는 프런트가 정한다.
/// 승격된(탭) 세션은 세지 않는다
pub const LIGHT_SESSIONS_PER_FOLDER: usize = 3;

/// 코어 동작 설정
#[derive(Clone, Debug)]
pub struct CoreConfig {
    /// 모든 git 명령 앞에 붙는 `-c key=value` (벤치에서 `core.commitGraph=false` 등)
    pub git_config_overrides: Vec<(String, String)>,
    /// 이 행 수에 도달하면 `GraphFirstChunk` 를 보낸다
    pub first_chunk_rows: u32,
    /// `GraphProgress` 최소 간격
    pub progress_interval: Duration,
    /// `graph_window` 의 `count` 상한 (clamp)
    pub max_window_rows: u32,
    /// commit-graph 가 없고 커밋이 이 수 이상이면 생성을 제안한다 (AD-03)
    pub commit_graph_suggest_threshold: u32,
    /// 탭으로 연 저장소의 작업 트리를 재귀 감시할지 (폴더 대시보드는 `.git` 만)
    pub watch_work_tree: bool,
    /// 작업 트리 감시에서 제외할 디렉터리 이름 (기본 목록에 더한다)
    pub extra_ignore_dirs: Vec<String>,
    /// `index.lock` 충돌 시 재시도 횟수와 간격 (명세 2.3 동시성)
    pub index_lock_retries: u32,
    pub index_lock_retry_delay: Duration,
    /// 메모리에 보관하는 명령 로그 수 (SF-01)
    pub command_log_capacity: usize,
    /// discard 백업 사본을 둘 디렉터리 (CHG-04). `None` 이면 임시 디렉터리
    pub backup_dir: Option<PathBuf>,
    /// diff 를 한 번에 보내는 줄 수 상한 (DIFF-02). 넘으면 앞부분만 보내고 `truncated` 를 켠다
    pub diff_max_lines: u32,
    /// 자동 fetch 간격의 처음 값 (RM-02, 저장소 탭·폴더 공용). `None` 이면 끔. 실행 중에는
    /// `Core::set_auto_fetch_interval` 로 바꾸고 `Core::auto_fetch_interval` 로 읽는다 (이 값은 바뀌지 않는다)
    pub auto_fetch_interval: Option<Duration>,
    /// 백업 ref 보관 일수 (SF-04)
    pub backup_keep_days: u32,
    /// 세션별 undo 스택 크기 (SF-03)
    pub undo_capacity: usize,
    /// 긴 엣지 접기 거리(행). 부모가 이보다 멀면 레인 대신 스텁으로 그린다
    pub graph_long_edge_rows: u32,
    /// 통합 타임라인(MR-12)에서 저장소마다 읽는 최근 커밋 수 상한
    pub timeline_max_per_repo: u32,
    /// 사용자 셸 명령(검증·워크트리 초기화·충돌 규칙)에 줄 PATH. Finder 로 띄우면 앱의 PATH 가
    /// 빈약하므로 셸이 로그인 셸의 PATH 를 넣는다. `None` 이면 상속
    pub command_path: Option<String>,
    /// 사용자 셸 명령의 최대 실행 시간
    pub command_timeout: Duration,
    /// tag push·원격 삭제·가져오기에서 git 명령 하나에 넣는 refspec 인자 바이트 상한 (청크 예산, D9)
    pub tag_chunk_bytes: usize,
    /// 위와 같은 청크의 ref 개수 상한
    pub tag_chunk_refs: usize,
}

impl Default for CoreConfig {
    fn default() -> Self {
        CoreConfig {
            git_config_overrides: Vec::new(),
            first_chunk_rows: 500,
            progress_interval: Duration::from_millis(250),
            max_window_rows: 2_000,
            commit_graph_suggest_threshold: 20_000,
            watch_work_tree: true,
            extra_ignore_dirs: Vec::new(),
            index_lock_retries: 5,
            index_lock_retry_delay: Duration::from_millis(200),
            command_log_capacity: 500,
            backup_dir: None,
            diff_max_lines: 10_000,
            auto_fetch_interval: None,
            backup_keep_days: 30,
            undo_capacity: 20,
            graph_long_edge_rows: 40,
            timeline_max_per_repo: 10_000,
            command_path: None,
            command_timeout: Duration::from_secs(600),
            tag_chunk_bytes: 256 * 1024,
            tag_chunk_refs: 1_000,
        }
    }
}
