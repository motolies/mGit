/// `git rev-parse --local-env-vars` 가 돌려주는 변수들. hook 이나 터미널에서 앱을 띄우면
/// 상속되어 엉뚱한 저장소를 건드리므로 모든 명령에서 제거한다.
pub const LOCAL_ENV_VARS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

/// `GIT_LITERAL_PATHSPECS` 를 붙이지 않는 명령. mGit 은 이 명령들에 pathspec 을 넘기지 않으며, 붙이면
/// 오히려 깨진다.
/// - 사용자 훅을 돌리는 명령: 설정이 훅으로 상속되어 훅 안의 `git diff -- '*.ts'` 가 조용히 빈 결과가 된다
/// - `stash`: `-u` 가 내부에서 `git clean :/` 을 돌린다. 리터럴이면 untracked 가 지워지지 않는다.
///   경로는 `:(literal)` 접두로 넘긴다
/// - `lfs`: 패턴 인자가 글롭이다
pub const NON_LITERAL_COMMANDS: &[&str] = &[
    "commit",
    "merge",
    "rebase",
    "pull",
    "push",
    "cherry-pick",
    "revert",
    "am",
    "switch",
    "worktree",
    "stash",
    "lfs",
];

/// 명령 용도별 환경 변수 프로파일 (명세 2.3 실행 환경 표)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvProfile {
    /// 백그라운드 파싱 읽기: `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`
    ReadBackground,
    /// 사용자 새로고침 읽기: `LC_ALL=C`, `GIT_NO_LAZY_FETCH=1` (`GIT_OPTIONAL_LOCKS` 미설정)
    ReadInteractive,
    /// 쓰기(commit, merge, checkout …): `LC_ALL` 없음(hook 의 한글 출력 보호),
    /// 편집기는 `true` 로 대체해 메시지 입력 대기를 막는다
    Write,
    /// 네트워크(fetch, push, clone …): `Write` + askpass 헬퍼 (러너가 런타임에 추가)
    Network,
}

impl EnvProfile {
    /// 모든 프로파일에 공통으로 설정하는 변수
    pub const COMMON: &[(&str, &str)] = &[
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_PAGER", "cat"),
        // 경로 인자는 항상 글자 그대로다. 글롭이면 `app/[id]/x` 가 `app/i/x` 까지 건드린다
        ("GIT_LITERAL_PATHSPECS", "1"),
        // 힌트 분류가 영어 메시지 패턴이다. 메시지 언어만 고정하고 `LC_ALL` 은 건드리지 않는다
        // (쓰기 명령은 훅의 UTF-8 처리를 위해 사용자 로캘을 유지한다)
        ("LANGUAGE", "en"),
    ];

    /// 이 프로파일에서 추가로 설정하는 변수
    pub fn vars(self) -> &'static [(&'static str, &'static str)] {
        match self {
            EnvProfile::ReadBackground => &[
                ("LC_ALL", "C"),
                ("GIT_OPTIONAL_LOCKS", "0"),
                ("GIT_NO_LAZY_FETCH", "1"),
            ],
            EnvProfile::ReadInteractive => &[("LC_ALL", "C"), ("GIT_NO_LAZY_FETCH", "1")],
            EnvProfile::Write | EnvProfile::Network => {
                &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")]
            }
        }
    }

    /// 저장소 상태를 바꾸는 프로파일인지 (명령 로그 영속화·쓰기 큐 대상)
    pub fn is_write(self) -> bool {
        matches!(self, EnvProfile::Write | EnvProfile::Network)
    }
}
