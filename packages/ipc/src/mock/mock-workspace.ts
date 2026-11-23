// 목 장면 데이터. `VITE_MGIT_MOCK_SCENE=folder|repo|conflict` 로 고른다.
//
// 구조는 "장면 → 메서드별 데이터"다. `MockFolderData`·`MockRepoData` 의 키는 `IpcClient` 메서드 이름과
// 맞춰 두었고, `mock-client.ts` 가 세션에 맞는 데이터를 찾아 그 키를 돌려준다. IPC 메서드를 새로 추가하는
// 슬라이스는 ① 여기 인터페이스에 키를 더하고 ② `folderData`·`repoData` 에서 값을 채우고
// ③ `mock-client.ts` 의 장면 메서드에 한 줄을 더하면 된다.
//
// 사람 이름·이메일·저장소 이름은 모두 지어낸 것이다.

import { IpcClientError } from '../client';
import type {
  AutoSuggestion,
  BackupRef,
  BatchResult,
  BlameLine,
  ChangedFile,
  CommandLogRecord,
  CommitDetail,
  ConflictDoc,
  ConflictFile,
  ConflictKind,
  ConflictPayload,
  ContainingBranch,
  ContainingRefs,
  DiffChange,
  DiffLine,
  FileDiff,
  FileState,
  FolderBranch,
  FolderBranches,
  FoundRepo,
  GraphQuery,
  GraphRow,
  HeadState,
  HistoryEntry,
  IndexTarget,
  IndexWriteResult,
  Module,
  ModuleOverrides,
  OpKind,
  PrTemplate,
  PullRequest,
  RadarEntry,
  RefLabel,
  RemoteProject,
  RepoChanges,
  RepoKind,
  RepoRefs,
  RepoResult,
  RepoState,
  RepoSummary,
  SkippedPath,
  StashEntry,
  StatusEntry,
  StatusSummary,
  SubmoduleInfo,
  TimelineInfo,
} from '../types';
import { filterMockGraph } from './mock-filter';
import { createMockFs, type MockFs, type MockFsLayout } from './mock-fs';
import { type MockGraph, mulberry32, oidOf } from './mock-graph-source';
import { mockReason, pick } from './mock-l10n';

/** 목 장면 이름 */
export type MockSceneName = 'folder' | 'repo' | 'conflict';

/** `VITE_MGIT_MOCK_SCENE` 값을 장면 이름으로 바꾼다. 비었거나 모르는 값이면 null */
export function parseMockScene(raw: string | null | undefined): MockSceneName | null {
  return raw === 'folder' || raw === 'repo' || raw === 'conflict' ? raw : null;
}

/** 폴더 세션의 메서드별 데이터. 키는 `IpcClient` 메서드 이름과 같다 */
export interface MockFolderData {
  path: string;
  /** `openFolder().repos`·`folderRescan` */
  openFolder: FoundRepo[];
  folderSummaries: RepoSummary[];
  folderChanges: RepoChanges[];
  /** 브랜치 목록 (타임라인과 따로 읽는다). 저장소 색은 요약·타임라인과 같다 */
  folderBranches: FolderBranches;
  /** `folderTimeline*` 의 재료: 타임라인에 드는 저장소와 ref 배치 */
  folderTimeline: MockTimelineRepo[];
  /** 타임라인 커밋 작성자 [이름, 이메일] (기본 5명, 크기 조절값 `authors` 로 늘린다) */
  authors: [string, string][];
  /** `folderCommitDetail`·`folderCommitFileDiff` 의 재료 */
  folderCommitDetail: MockFolderCommits;
}

/** 폴더 커밋 상세·diff 의 재료 */
export interface MockFolderCommits {
  /** 변경 파일 후보. 커밋마다 연속한 4~6개를 고른다 (어느 구간이든 추가·rename·삭제가 섞인다) */
  files: ChangedFile[];
  /** 커밋 하나의 변경 파일 수. null 이면 4~6개 (크기 조절값 `commitFiles` 면 그 수 — 후보 전부) */
  perCommit: number | null;
  /** 저장소 경로 → 타임라인 번호. 워크트리는 원 저장소 번호다 (코어처럼 원 저장소로 읽는다) */
  repoIndex: Record<string, number>;
}

/** 통합 타임라인에 드는 저장소 하나 */
export interface MockTimelineRepo {
  name: string;
  path: string;
  /** 저장소 색 번호 (코어의 순번 % 10 흉내) */
  color: number;
  /** 현재 브랜치. 분리 HEAD 면 null */
  headBranch: string | null;
  /** HEAD 가 그 저장소의 위에서 몇 번째 커밋인지 */
  headDepth: number;
  /** 브랜치 끝의 위치: [짧은 이름, 위에서 몇 번째 커밋]. 원격은 `origin/` 으로 시작한다 */
  refs: [string, number][];
  /** 태그의 위치: [이름, 위에서 몇 번째 커밋]. 브랜치 목록·포함 브랜치에는 들지 않는다 */
  tags: [string, number][];
}

/** 저장소 세션의 메서드별 데이터. 키는 `IpcClient` 메서드 이름과 같다 */
export interface MockRepoData {
  /** `openRepo().state`·`repoState` */
  repoState: RepoState;
  listStashes: StashEntry[];
  /** 어느 스태시를 골라도 같은 목록을 준다 */
  stashFiles: ChangedFile[];
  /** `commitDetail().files` 의 후보. 커밋마다 일부를 잘라 쓴다 */
  commitDetail: ChangedFile[];
  conflicts: ConflictFile[];
  /** 경로 → 3-way 편집기 자료 */
  conflictFile: Record<string, ConflictPayload>;
  /** 세션을 열 때 `commandLogged` 이벤트로 흘려보내는 git 명령 기록 (실행한 순서). 콘솔 탭이 보여 준다 */
  commandLogged: CommandLogRecord[];
  /** 충돌 레이더 결과 (`conflictRadar`): 로컬 브랜치 둘 — 깨끗한 것 하나, 충돌 나는 것 하나 (W22 배지) */
  conflictRadar: RadarEntry[];
  /** 백업 ref (`backups`): 현재 브랜치의 것과 다른 브랜치의 것 (W22 브랜치 트리 Backups) */
  backups: BackupRef[];
  /**
   * 원격 프로젝트 (`hostingRemoteProject`, W24 Pull Requests 도구 창): GitHub, 계정 연결됨. 조절값(`MockHostingMode`)이
   * 응답을 바꾼다 — 없음·계정 없음·GitLab (`mockRemoteProject`)
   */
  hostingRemoteProject: RemoteProject;
  /**
   * 열린 PR (`pullRequests`, W24): 배지 조합이 다 보이게 — draft, 리뷰 셋(승인·변경 요청·리뷰 필요), 검사 셋(성공·실패·
   * 진행 중), 충돌(`mergeable: false`), 긴 제목, 배지 없음. 조절값이 빈 목록·오류·GitLab 주소로 바꾼다 (`mockPullRequests`)
   */
  pullRequests: PullRequest[];
  /** PR 본문 템플릿 (`prTemplates`): 하나라 "PR 만들기"가 템플릿 고르기 없이 바로 입력 대화상자를 연다 */
  prTemplates: PrTemplate[];
  /**
   * 감지된 빌드 모듈 (`modules` 의 재료, W25 Project 트리): 얕은 것·깊은 것·이름이 디렉터리 이름과 다른 것·변경이 든 것·
   * 서브모듈과 겹치는 것. 응답은 클라이언트가 수동 보정(`moduleOverrides`)을 코어처럼 적용해 만든다 (`mockModules`).
   * 저장소 장면의 storefront-web 에만 있다
   */
  modules: Module[];
  /** 모듈 수동 보정의 처음 값 (`moduleOverrides`): 직접 추가한 모듈 하나 (kind manual) */
  moduleOverrides: ModuleOverrides;
  /** 서브모듈 (`submodules`): 상태 다섯 가지(깨끗함·commit 다름·변경 있음·미초기화·충돌)가 다 보이게. storefront-web 에만 */
  submodules: SubmoduleInfo[];
  /** 추적되지 않는 하위 저장소의 절대 경로 (`openRepo().nestedRepos`). storefront-web 에만 */
  nestedRepos: string[];
  /**
   * 상위 저장소 경로 (`openRepo().superproject`) 의 후보. 클라이언트가 조절값(`mgit.mock.superproject`)이 켜졌을 때만 싣는다 —
   * 기본은 서브모듈이 아닌 저장소다. storefront-web 에만 있고 나머지는 null
   */
  superproject: string | null;
}

/** 통합 타임라인 한 벌 (`folderTimelineOpen`·`folderTimelineInfo` 응답 + 윈도의 원본 그래프) */
export interface MockTimeline {
  info: TimelineInfo;
  graph: MockGraph;
}

/** 장면 하나 */
export interface MockScene {
  name: MockSceneName;
  /** `takeStartupPaths` 가 돌려줄 경로. 개발 서버가 뜨자마자 이 탭이 열린다 */
  startupPaths: string[];
  /** 폴더 세션 데이터. 이 경로를 `openRepo` 로 열면 `multiRepoFolder` 오류가 난다 */
  folder: MockFolderData | null;
  /** 저장소 세션 데이터를 만든다. 그 세션 그래프의 ref 라벨도 장면 것으로 바꾼다 */
  repo(path: string, graph: MockGraph): MockRepoData;
  /**
   * 파일 트리·파일 보기(`fsListDir`·`fsReadFile`)의 재료. 루트는 세션이 정한 경로(폴더 또는 작업 트리)다.
   * 폴더 장면의 저장소 디렉터리는 요약·타임라인의 저장소 경로와 같고, 그 저장소를 탭으로 열면 같은 트리를 본다
   */
  fs: MockFs;
}

/** 장면 데이터의 기준 시각 (초). 합성 그래프의 첫 행과 같다 */
const BASE_TIME = 1_761_600_000;
/** 타임라인의 저장소당 커밋 상한 (코어 기본값 흉내) */
const TIMELINE_MAX_PER_REPO = 10_000;
/** 그래프에 없는 객체(스태시·blob)의 oid 를 만들 때 쓰는 행 번호 시작점 */
const EXTRA_OID_BASE = 5_000_000;

const FOLDER_PATH = '/mock/acme-platform';
const REPO_PATH = '/mock/storefront-web';
const CONFLICT_PATH = '/mock/checkout-service';

/** 타임라인 커밋 작성자 (지어낸 이름) */
const AUTHORS: [string, string][] = [
  ['한도윤', 'doyun.han@example.com'],
  ['서하린', 'harin.seo@example.com'],
  ['Jamie Park', 'jamie.park@example.com'],
  ['윤채아', 'chaea.yoon@example.com'],
  ['Noah Lindqvist', 'noah.lindqvist@example.com'],
];

/** 타임라인 커밋 제목 */
const SUBJECTS = [
  'feat: 주문 목록에 기간 필터 추가',
  'fix: 토큰 만료 시 재시도가 두 번 도는 문제',
  'refactor: 결제 금액 계산을 money 모듈로 이동',
  'chore: 의존성 버전 올림',
  'test: 로그인 횟수 제한 경계값 테스트',
  'fix: 검색 facet 개수가 0 으로 나오는 문제',
  'docs: 배포 절차 갱신',
  'feat: 디자인 토큰 대비 기준 적용',
  'perf: 카탈로그 색인 배치 크기 조정',
  'fix: 장바구니 합계 반올림 오차',
];

// ── 공용 조립 도구 ─────────────────────────────────────────────────────────────

/** 상태 항목 하나를 만든다 */
function entry(
  path: string,
  index: FileState,
  worktree: FileState,
  extra: { origPath?: string; conflict?: ConflictKind; renameScore?: number } = {},
): StatusEntry {
  return {
    path,
    origPath: extra.origPath ?? null,
    index,
    worktree,
    submodule: null,
    conflict: extra.conflict ?? null,
    renameScore: extra.renameScore ?? null,
  };
}

/** 상태 항목을 코어 `WorkTreeStatus::summary` 와 같은 규칙으로 센다 */
function summarize(
  entries: readonly StatusEntry[],
  branch: { upstream: string | null; ahead: number; behind: number },
  stashCount: number,
): StatusSummary {
  const idle: FileState[] = ['unmodified', 'untracked', 'ignored'];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const e of entries) {
    if (e.conflict) {
      conflicted += 1;
      continue;
    }
    if (!idle.includes(e.index)) {
      staged += 1;
    }
    if (e.worktree === 'untracked') {
      untracked += 1;
    } else if (!idle.includes(e.worktree)) {
      unstaged += 1;
    }
  }
  return { staged, unstaged, untracked, conflicted, ...branch, stashCount };
}

/** 커밋이 바꾼 파일 하나를 만든다 */
function changed(path: string, change: DiffChange, oldPath: string | null = null): ChangedFile {
  return { path, oldPath, change };
}

/** 로컬 브랜치 라벨 */
function localLabel(
  name: string,
  target: string,
  extra: {
    isCurrent?: boolean;
    upstream?: string | null;
    ahead?: number | null;
    behind?: number | null;
    upstreamGone?: boolean;
    worktreePath?: string | null;
  } = {},
): RefLabel {
  return {
    fullName: `refs/heads/${name}`,
    shortName: name,
    kind: { kind: 'localBranch' },
    target,
    isCurrent: extra.isCurrent ?? false,
    upstream: extra.upstream ?? null,
    ahead: extra.ahead ?? null,
    behind: extra.behind ?? null,
    upstreamGone: extra.upstreamGone ?? false,
    worktreePath: extra.worktreePath ?? null,
  };
}

/** 원격 브랜치 라벨. `shortName` 은 `origin/main` 꼴이다 */
function remoteLabel(shortName: string, target: string): RefLabel {
  return {
    fullName: `refs/remotes/${shortName}`,
    shortName,
    kind: { kind: 'remoteBranch', remote: shortName.split('/')[0] ?? '' },
    target,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    worktreePath: null,
  };
}

/** 태그 라벨 */
function tagLabel(name: string, target: string, annotated: boolean): RefLabel {
  return {
    fullName: `refs/tags/${name}`,
    shortName: name,
    kind: { kind: 'tag', annotated },
    target,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    worktreePath: null,
  };
}

// ── 폴더 장면 ──────────────────────────────────────────────────────────────────

/** 폴더 장면의 저장소 하나. 요약·변경·타임라인을 모두 이 표에서 만든다 (서로 어긋나지 않게) */
interface FolderRepoSpec {
  name: string;
  kind: RepoKind;
  /** 현재 브랜치. 분리 HEAD 면 null */
  branch: string | null;
  /** [ahead, behind]. 업스트림이 없으면 null */
  sync: [number, number] | null;
  op: OpKind | null;
  /** 마지막 fetch 가 기준 시각보다 몇 분 전인지. 한 번도 안 했으면 null */
  fetchedMinutesAgo: number | null;
  /** 요약 실패 사유 */
  error: string | null;
  entries: StatusEntry[];
  /** 통합 타임라인에 드는지. 워크트리는 원 저장소에 흡수되므로 빠진다 */
  timeline: boolean;
  /** 워크트리면 원 저장소의 이름. 순번(색)을 원 저장소와 같이 쓴다 */
  worktreeOf?: string;
  headDepth: number;
  refs: [string, number][];
  /** 태그 [이름, 위에서 몇 번째 커밋]. 태그로만 닿는 커밋은 포함 브랜치가 0개다 */
  tags?: [string, number][];
}

/**
 * 폴더 장면의 저장소 8개. 성격이 겹치지 않게 골랐다:
 * behind 54 / feature 브랜치 / 분리 HEAD / rebase 중 충돌 / 깨끗함 / 워크트리 / 요약 실패 / 변경 많음
 */
const FOLDER_REPOS: FolderRepoSpec[] = [
  {
    name: 'api-gateway',
    kind: 'standalone',
    branch: 'development',
    sync: [0, 54],
    op: null,
    fetchedMinutesAgo: 12,
    error: null,
    entries: [],
    timeline: true,
    headDepth: 54,
    // 원격 브랜치가 많은 저장소: 오래된 커밋일수록 포함 브랜치가 늘어 10개를 넘는다 (CD-03 접기)
    refs: [
      ['origin/development', 0],
      ['origin/feature/SHOP-311-order-export', 6],
      ['origin/feature/SHOP-307-gateway-retry-budget-with-a-very-long-descriptive-name', 12],
      ['origin/feature/SHOP-303-event-outbox', 20],
      ['origin/hotfix/2026.11.2', 28],
      ['origin/feature/SHOP-298-tenant-routing', 36],
      ['origin/release/2026.11', 44],
      ['development', 54],
      ['staging', 61],
      ['origin/staging', 61],
      ['origin/feature/SHOP-280-rate-limit-headers', 70],
      ['origin/release/2026.10', 80],
      ['main', 90],
      ['origin/main', 90],
    ],
  },
  {
    name: 'auth-service',
    kind: 'standalone',
    branch: 'feature/login-rate-limit',
    sync: [3, 0],
    op: null,
    fetchedMinutesAgo: 47,
    error: null,
    entries: [
      entry('src/main/java/com/acme/auth/login/RateLimiter.java', 'added', 'unmodified'),
      entry('src/main/java/com/acme/auth/login/LoginController.java', 'modified', 'modified'),
      entry('src/main/resources/config/rate-limit.yaml', 'unmodified', 'modified'),
      entry('src/test/java/com/acme/auth/login/RateLimiterTest.java', 'untracked', 'untracked'),
    ],
    timeline: true,
    headDepth: 0,
    refs: [
      ['feature/login-rate-limit', 0],
      ['origin/feature/login-rate-limit', 3],
      ['development', 5],
      ['origin/development', 5],
      ['main', 30],
      ['origin/main', 30],
    ],
  },
  {
    name: 'billing-service',
    kind: 'standalone',
    branch: null,
    sync: null,
    op: null,
    fetchedMinutesAgo: 190,
    error: null,
    entries: [],
    timeline: true,
    headDepth: 14,
    refs: [
      ['development', 0],
      ['origin/development', 0],
      ['staging', 8],
      ['origin/staging', 8],
      ['origin/release/2026.11', 14],
      ['main', 40],
      ['origin/main', 40],
    ],
  },
  {
    name: 'catalog-service',
    kind: 'standalone',
    branch: null,
    sync: null,
    op: 'rebase',
    fetchedMinutesAgo: 5,
    error: null,
    entries: [
      entry('src/search/facets/FacetBuilder.kt', 'unmerged', 'unmerged', {
        conflict: 'bothModified',
      }),
      entry('src/search/facets/FacetQuery.kt', 'modified', 'unmodified'),
      entry('src/search/index/IndexMapping.kt', 'modified', 'unmodified'),
    ],
    timeline: true,
    headDepth: 0,
    refs: [
      ['development', 2],
      ['origin/development', 2],
      ['feature/search-facets', 9],
      ['main', 25],
      ['origin/main', 25],
    ],
  },
  {
    name: 'design-system',
    kind: 'standalone',
    branch: 'development',
    sync: [0, 0],
    op: null,
    fetchedMinutesAgo: 3,
    error: null,
    entries: [],
    timeline: true,
    headDepth: 2,
    refs: [
      ['hotfix/token-contrast', 0],
      ['development', 2],
      ['origin/development', 2],
      ['main', 20],
      ['origin/main', 20],
    ],
  },
  {
    name: 'design-system-hotfix',
    kind: 'worktree',
    worktreeOf: 'design-system',
    branch: 'hotfix/token-contrast',
    sync: null,
    op: null,
    fetchedMinutesAgo: 3,
    error: null,
    entries: [
      entry('tokens/color/semantic.json', 'unmodified', 'modified'),
      entry('packages/react/src/components/Button/Button.module.css', 'unmodified', 'modified'),
    ],
    timeline: false,
    headDepth: 0,
    refs: [],
  },
  {
    name: 'infra-scripts',
    kind: 'standalone',
    branch: 'main',
    sync: null,
    op: null,
    fetchedMinutesAgo: null,
    error: 'git status 실패 (종료 코드 128): fatal: index file smaller than expected',
    entries: [],
    timeline: true,
    headDepth: 2,
    refs: [
      ['main', 2],
      ['origin/main', 2],
    ],
    // 지운 브랜치에서 찍은 태그: 맨 위 두 커밋은 태그로만 닿는다 (어느 branch 에도 없음)
    tags: [['v0.9.0-rc.1', 0]],
  },
  {
    name: 'web-console',
    kind: 'standalone',
    branch: 'staging',
    sync: [1, 2],
    op: null,
    fetchedMinutesAgo: 26,
    error: null,
    entries: [
      entry('apps/console/src/pages/orders/OrderTable.tsx', 'modified', 'unmodified'),
      entry('apps/console/src/pages/orders/OrderExport.tsx', 'renamed', 'unmodified', {
        origPath: 'apps/console/src/pages/orders/Export.tsx',
        renameScore: 88,
      }),
      entry('apps/console/src/pages/orders/filters/DateRangeFilter.tsx', 'added', 'unmodified'),
      entry('apps/console/src/pages/orders/filters/StatusFilter.tsx', 'modified', 'modified'),
      entry('apps/console/src/shared/api/orders.ts', 'unmodified', 'modified'),
      entry('apps/console/src/shared/i18n/ko.json', 'unmodified', 'modified'),
      entry('packages/ui-kit/src/Table/Table.stories.tsx', 'unmodified', 'deleted'),
      entry(
        'apps/console/src/pages/orders/filters/__tests__/DateRangeFilter.test.tsx',
        'untracked',
        'untracked',
      ),
    ],
    timeline: true,
    headDepth: 0,
    refs: [
      ['staging', 0],
      ['origin/staging', 1],
      ['development', 4],
      ['origin/development', 4],
      ['main', 33],
      ['origin/main', 33],
    ],
  },
];

/**
 * 진행 중인 작업이 여럿인 모양을 브라우저에서 볼 때 더하는 작업 (W15 작업 띠). 조절값(`folderOps`, 개발 서버에서는
 * `localStorage['mgit.mock.folderOps']`)이 N 이면 앞에서 N 개를 그 저장소에 덮어쓴다 — 기본 0 이라 장면은 그대로다.
 * merge 는 텍스트 충돌 + 삭제 충돌(한쪽 고르기), cherry-pick 은 충돌 없이 멈춤(Continue 가 켜진 줄), revert 는 충돌 하나
 */
const EXTRA_FOLDER_OPS: { name: string; op: OpKind; entries: StatusEntry[] }[] = [
  {
    name: 'billing-service',
    op: 'merge',
    entries: [
      entry('src/invoice/InvoiceTotals.kt', 'unmerged', 'unmerged', { conflict: 'bothModified' }),
      entry('docs/billing-limits.md', 'unmerged', 'deleted', { conflict: 'deletedByThem' }),
      entry('src/invoice/TaxRules.kt', 'modified', 'unmodified'),
    ],
  },
  {
    name: 'design-system',
    op: 'cherryPick',
    entries: [entry('tokens/color/base.json', 'modified', 'unmodified')],
  },
  {
    name: 'api-gateway',
    op: 'revert',
    entries: [
      entry('src/routes/orders/handlers/create-order.ts', 'unmerged', 'unmerged', {
        conflict: 'bothModified',
      }),
    ],
  },
];

/**
 * 장면의 저장소 표: 기본 표에 더할 작업(`EXTRA_FOLDER_OPS` 의 앞 `extra` 개)을 덮어쓰고, 크기 조절값(`scale`)이 있으면
 * 저장소·원격 브랜치·작업 트리 변경을 늘린 사본. 조절값이 없으면 기본 표와 이름·순서·내용이 같다
 */
function folderRepos(extra: number, scale: MockScale = {}): FolderRepoSpec[] {
  const picked = EXTRA_FOLDER_OPS.slice(0, Math.max(0, Math.floor(extra)));
  const base = FOLDER_REPOS.map((spec) => {
    const over = picked.find((p) => p.name === spec.name);
    return over ? { ...spec, op: over.op, entries: over.entries } : spec;
  });
  const specs = [...base, ...scaledRepos(countOf(scale.repos) - base.length)];
  return withScaledChanges(
    withScaledRemotes(specs, countOf(scale.remoteBranches)),
    countOf(scale.worktreeChanges),
  );
}

// ── 크기 조절값 (W18 ② 화면 성능 측정) ──────────────────────────────────────────
//
// 기본은 모두 꺼져 있다(0). 켜면 폴더 장면의 해당 자료만 그 크기로 늘린다 — 화면이 "항목이 아주 많을 때"를 재는 용도라
// 이름·경로는 규칙적으로 만든다. 개발 서버·미리보기에서는 `localStorage['mgit.mock.<이름>']` 으로 켠다 (`mock-client.ts`).

/** 화면 측정용 크기 조절값. 값이 없거나 0 이하면 그 항목은 기본 장면 그대로다 */
export interface MockScale {
  /** 폴더 장면의 저장소 수. 기본 8개보다 크면 `service-NN` 저장소를 더해 이 수로 맞춘다 */
  repos?: number;
  /** 폴더 장면에 더할 원격 브랜치 수 (`origin/feature/SHOP-NNNN-…`, 타임라인 저장소에 1~2개씩 나눠 둔다) */
  remoteBranches?: number;
  /** 폴더 커밋 하나의 변경 파일 수 (3단계 디렉터리 아래에 고르게, 모든 커밋이 같은 목록) */
  commitFiles?: number;
  /** 폴더 루트 `logs/` 디렉터리의 항목 수 (기본 2,400) */
  dirEntries?: number;
  /** 통합 타임라인의 작성자 수 (기본 5명) */
  authors?: number;
  /** `web-console` 에 더할 작업 트리 변경 수 (staged·unstaged·양쪽·untracked 가 차례로) */
  worktreeChanges?: number;
  /** 폴더 `samples/` 에 둘 큰 텍스트 파일의 크기 (KiB, 최대 1,024 = 읽기 상한) */
  bigFileKiB?: number;
}

/** 조절값 → 개수. 없거나 숫자가 아니거나 0 이하면 0 */
function countOf(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 0 을 채운 번호 */
function padNo(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** 더할 저장소 `count` 개: 깨끗한 main 저장소들 (기본 8개 뒤에 이름순으로 붙는다) */
function scaledRepos(count: number): FolderRepoSpec[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({
    name: `service-${padNo(i + 1, 2)}`,
    kind: 'standalone' as const,
    branch: 'main',
    sync: [0, i % 7] as [number, number],
    op: null,
    fetchedMinutesAgo: 10 + i,
    error: null,
    entries: [],
    timeline: true,
    headDepth: i % 7,
    refs: [
      ['main', i % 7],
      ['origin/main', 0],
    ] as [string, number][],
  }));
}

/** 더할 원격 브랜치 이름의 주제 */
const SCALED_TOPICS = [
  'order-export',
  'retry-budget',
  'tenant-routing',
  'rate-limit-headers',
  'search-facets',
  'token-contrast',
  'invoice-tax',
  'login-audit',
];

/**
 * 원격 브랜치 `count` 개를 타임라인 저장소에 나눠 단다: i 번째는 (i mod 저장소 수) 번째 저장소에, 세 개 중 하나는 다음
 * 저장소에도 (여러 저장소에 걸친 브랜치). 위치는 위에서 0~119 번째 커밋 (이력이 짧으면 마지막 커밋)
 */
function withScaledRemotes(specs: FolderRepoSpec[], count: number): FolderRepoSpec[] {
  const owners = specs.filter((spec) => spec.timeline);
  if (count <= 0 || owners.length === 0) {
    return specs;
  }
  const added = new Map<string, [string, number][]>();
  for (let i = 0; i < count; i += 1) {
    const name = `origin/feature/SHOP-${4000 + i}-${SCALED_TOPICS[i % SCALED_TOPICS.length]}`;
    const at = (i * 7) % 120;
    const homes = i % 3 === 0 ? [i, i + 1] : [i];
    for (const k of homes) {
      const owner = owners[k % owners.length];
      if (owner) {
        const list = added.get(owner.name) ?? [];
        list.push([name, at]);
        added.set(owner.name, list);
      }
    }
  }
  return specs.map((spec) => {
    const more = added.get(spec.name);
    return more ? { ...spec, refs: [...spec.refs, ...more] } : spec;
  });
}

/** 작업 트리 변경 `count` 개 (`apps/console/src/generated/mod-NN/part-N/ItemNNNNN.tsx`) */
function scaledEntries(count: number): StatusEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const path = `apps/console/src/generated/mod-${padNo(i % 50, 2)}/part-${Math.floor(i / 50) % 10}/Item${padNo(i, 5)}.tsx`;
    switch (i % 4) {
      case 0:
        return entry(path, 'modified', 'unmodified');
      case 1:
        return entry(path, 'unmodified', 'modified');
      case 2:
        return entry(path, 'modified', 'modified');
      default:
        return entry(path, 'untracked', 'untracked');
    }
  });
}

/** `web-console` 에 작업 트리 변경 `count` 개를 더한다 */
function withScaledChanges(specs: FolderRepoSpec[], count: number): FolderRepoSpec[] {
  if (count <= 0) {
    return specs;
  }
  return specs.map((spec) =>
    spec.name === 'web-console'
      ? { ...spec, entries: [...spec.entries, ...scaledEntries(count)] }
      : spec,
  );
}

/**
 * 커밋 변경 파일 `count` 개: `src/module-NN/pkg-NN/sub-N/FileNNNNN.ts` (모듈 20 × 패키지 10 × 하위 5 = 디렉터리 1,000 개에
 * 고르게). 8개마다 수정 5·추가·삭제·rename 이다
 */
function scaledCommitFiles(count: number): ChangedFile[] {
  return Array.from({ length: count }, (_, i) => {
    const dir = `src/module-${padNo(i % 20, 2)}/pkg-${padNo(Math.floor(i / 20) % 10, 2)}/sub-${Math.floor(i / 200) % 5}`;
    const path = `${dir}/File${padNo(i, 5)}.ts`;
    switch (i % 8) {
      case 5:
        return changed(path, { kind: 'added' });
      case 6:
        return changed(path, { kind: 'deleted' });
      case 7:
        return changed(path, { kind: 'renamed', similarity: 90 }, `${dir}/Old${padNo(i, 5)}.ts`);
      default:
        return changed(path, { kind: 'modified' });
    }
  });
}

/** 작성자 `count` 명 (지어낸 이름) */
function scaledAuthors(count: number): [string, string][] {
  return Array.from({ length: count }, (_, i) => [
    `Dev ${padNo(i + 1, 4)}`,
    `dev${padNo(i + 1, 4)}@example.com`,
  ]);
}

/** 팔레트 크기 (코어 `PALETTE_SIZE`) */
const PALETTE_SIZE = 10;

/** 타임라인 저장소의 `depth` 번째 커밋 oid (질의가 바뀌어도 같은 커밋은 같은 oid) */
function timelineCommitOid(repo: number, depth: number, seed: number): string {
  return oidOf((repo + 1) * 1_000_003 + depth, seed);
}

/**
 * 저장소 이름 → 순번 (코어의 폴더 세션 흉내): 타임라인에 드는 저장소가 차례로 번호를 받고
 * 워크트리는 원 저장소의 번호를 쓴다. 색은 순번 % 10 이고 요약·브랜치·타임라인이 같은 값을 쓴다
 */
function folderOrdinals(specs: readonly FolderRepoSpec[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  for (const spec of specs) {
    if (spec.timeline) {
      ordinals.set(spec.name, ordinals.size);
    }
  }
  for (const spec of specs) {
    const origin = spec.worktreeOf === undefined ? undefined : ordinals.get(spec.worktreeOf);
    if (origin !== undefined) {
      ordinals.set(spec.name, origin);
    }
  }
  return ordinals;
}

/**
 * 로컬 브랜치의 업스트림 대비 [ahead, behind]. 현재 브랜치는 요약의 값(`sync`)을 쓰고, 그 밖에는 선형
 * 이력에서의 위치 차이로 정한다 (위에서 몇 번째 커밋인지: 작을수록 최신)
 */
function mockTrack(spec: FolderRepoSpec, name: string, depth: number, upstreamDepth: number) {
  if (name === spec.branch && spec.sync) {
    return spec.sync;
  }
  return [Math.max(0, upstreamDepth - depth), Math.max(0, depth - upstreamDepth)] as const;
}

/** 폴더 장면의 브랜치 목록 (코어 `folder_branches` 흉내): 타임라인에 드는 저장소의 ref 를 이름으로 합친다 */
function folderBranches(
  repos: readonly FolderRepoSpec[],
  pathOf: (spec: FolderRepoSpec) => string,
  colorOf: (spec: FolderRepoSpec) => number,
  seed: number,
): FolderBranches {
  const specs = repos.filter((spec) => spec.timeline);
  const byKey = new Map<string, FolderBranch>();
  specs.forEach((spec) => {
    for (const [name, depth] of spec.refs) {
      const remote = name.startsWith('origin/');
      const key = `${remote ? 'r' : 'l'}:${name}`;
      const branch = byKey.get(key) ?? {
        name,
        remote,
        remoteName: remote ? 'origin' : null,
        repos: [],
      };
      byKey.set(key, branch);
      const upstream = remote ? undefined : spec.refs.find(([other]) => other === `origin/${name}`);
      const [ahead, behind] = upstream ? mockTrack(spec, name, depth, upstream[1]) : [null, null];
      branch.repos.push({
        path: pathOf(spec),
        color: colorOf(spec),
        current: !remote && name === spec.branch,
        upstream: upstream ? upstream[0] : null,
        ahead,
        behind,
        gone: false,
      });
    }
  });
  return {
    repos: specs.map((spec, index) => {
      const oid = timelineCommitOid(index, spec.headDepth, seed);
      return {
        path: pathOf(spec),
        name: spec.name,
        color: colorOf(spec),
        head:
          spec.branch === null
            ? { state: 'detached' as const, oid }
            : { state: 'attached' as const, branch: spec.branch, oid },
        error: null,
      };
    }),
    branches: [...byKey.values()].sort(
      (a, b) => Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name),
    ),
  };
}

/**
 * 폴더 장면의 메서드별 데이터를 저장소 표에서 만든다 (`repos` 는 `folderRepos` 의 표 — 조절값이 없으면 이름·순서는 기본
 * 표와 같다). 커밋 변경 파일·작성자는 조절값(`scale`)이 있으면 그 크기로 만든다
 */
function folderData(
  seed: number,
  repos: readonly FolderRepoSpec[],
  scale: MockScale = {},
): MockFolderData {
  const pathOf = (spec: FolderRepoSpec) => `${FOLDER_PATH}/${spec.name}`;
  const ordinals = folderOrdinals(repos);
  const commitFiles = countOf(scale.commitFiles);
  const authors = countOf(scale.authors);
  const colorOf = (spec: FolderRepoSpec) => (ordinals.get(spec.name) ?? 0) % PALETTE_SIZE;
  /** 저장소 하나의 집계. 요약과 변경 보기가 같은 수를 쓴다 */
  const summaryOf = (spec: FolderRepoSpec) =>
    summarize(
      spec.entries,
      {
        upstream: spec.sync && spec.branch ? `origin/${spec.branch}` : null,
        ahead: spec.sync?.[0] ?? 0,
        behind: spec.sync?.[1] ?? 0,
      },
      0,
    );
  return {
    path: FOLDER_PATH,
    openFolder: repos.map((spec) => ({ path: pathOf(spec), kind: spec.kind })),
    // 코어와 같이 요약에 실패한 줄은 상태 칸을 비우고 사유만 남긴다
    folderSummaries: repos.map((spec) => {
      const s = summaryOf(spec);
      const failed = spec.error !== null;
      return {
        path: pathOf(spec),
        name: spec.name,
        kind: spec.kind,
        color: colorOf(spec),
        branch: failed ? null : spec.branch,
        detached: !failed && spec.branch === null,
        changed: s.staged + s.unstaged + s.untracked + s.conflicted,
        conflicted: s.conflicted,
        ahead: spec.sync?.[0] ?? null,
        behind: spec.sync?.[1] ?? null,
        op: spec.op,
        lastFetch:
          spec.fetchedMinutesAgo === null
            ? null
            : BASE_TIME * 1000 - spec.fetchedMinutesAgo * 60_000,
        error: spec.error,
      };
    }),
    folderChanges: repos
      .filter((spec) => spec.entries.length > 0)
      .map((spec) => ({
        path: pathOf(spec),
        name: spec.name,
        branch: spec.branch,
        entries: spec.entries,
        summary: summaryOf(spec),
      })),
    folderBranches: folderBranches(repos, pathOf, colorOf, seed),
    folderTimeline: repos
      .filter((spec) => spec.timeline)
      .map((spec) => ({
        name: spec.name,
        path: pathOf(spec),
        color: colorOf(spec),
        headBranch: spec.branch,
        headDepth: spec.headDepth,
        refs: spec.refs,
        tags: spec.tags ?? [],
      })),
    authors: authors > 0 ? scaledAuthors(authors) : AUTHORS,
    folderCommitDetail: {
      files: commitFiles > 0 ? scaledCommitFiles(commitFiles) : FOLDER_COMMIT_FILES,
      perCommit: commitFiles > 0 ? commitFiles : null,
      repoIndex: Object.fromEntries(
        repos.flatMap((spec) => {
          const ordinal = ordinals.get(spec.name);
          return ordinal === undefined ? [] : [[pathOf(spec), ordinal]];
        }),
      ),
    },
  };
}

// ── 폴더 stage·unstage·일괄 commit (W14, WS-23) ────────────────────────────────
//
// 코어 `folder_stage`·`folder_unstage`·`folder_commit` 흉내. 폴더 장면의 변경 표(`folderChanges`)가 저장소마다의
// 상태이고, 쓰기는 그 표·요약·브랜치 목록을 새 객체로 바꾼다 (앞서 돌려준 응답은 그대로 둔다). 같은 저장소를 연
// 세션(탭·가벼운 세션)의 상태도 `mockStatusWith` 로 맞춘다 (`mock-client.ts`). git 의 규칙 중 흉내 내지 않는 것:
// 이름 변경 감지(삭제 + 추가를 stage 해도 rename 으로 합치지 않는다), 없는 경로의 오류, 커밋 없는 저장소, 무시 파일

/** 상태 항목의 두 쪽을 바꾼 사본 */
function withStates(e: StatusEntry, index: FileState, worktree: FileState): StatusEntry {
  return { ...e, index, worktree };
}

/** 대상이 그 경로를 덮는지 (코어처럼 글자 그대로: 같은 경로이거나 그 디렉터리 아래, 전부면 늘) */
function covers(target: IndexTarget, path: string | null | undefined): boolean {
  if (path === null || path === undefined) {
    return false;
  }
  if (target.kind === 'all') {
    return true;
  }
  return target.paths.some((p) => {
    const dir = p.replace(/\/+$/, '');
    return path === dir || path.startsWith(`${dir}/`);
  });
}

/**
 * 대상 경로 하나의 거부 사유 (코어 `check_target_path`: 빈 경로·절대 경로·`..`·저장소 루트 자체). 받으면 null
 */
export function mockIndexPathError(path: string): string | null {
  const parts = path.split('/');
  const bad =
    path === '' ||
    path.startsWith('/') ||
    parts.includes('..') ||
    parts.every((part) => part === '.' || part === '');
  const shown = JSON.stringify(path);
  return bad ? pick(`잘못된 경로: ${shown}`, `Invalid path: ${shown}`) : null;
}

/** `git add -A` 한 항목: 작업 트리 쪽 변경을 index 로 옮긴다. 남는 항목들 (없어지면 빈 배열) */
function stagedEntry(e: StatusEntry): StatusEntry[] {
  switch (e.worktree) {
    case 'untracked':
      return [withStates(e, 'added', 'unmodified')];
    case 'modified':
      return [withStates(e, e.index === 'unmodified' ? 'modified' : e.index, 'unmodified')];
    case 'typeChanged':
      return [withStates(e, 'typeChanged', 'unmodified')];
    case 'deleted':
      if (e.index === 'added') {
        return [];
      }
      // 이름을 바꾼 뒤 새 경로를 지웠다: 옛 경로의 삭제만 남는다
      if (e.index === 'renamed' && e.origPath) {
        return [{ ...withStates(e, 'deleted', 'unmodified'), path: e.origPath, origPath: null }];
      }
      return [withStates(e, 'deleted', 'unmodified')];
    default:
      return [e];
  }
}

/**
 * `git restore --staged` 한 항목. 이름 변경은 덮인 쪽만 푼다: 새 경로를 풀면 untracked 가 되고(옛 경로가 덮이지
 * 않았으면 그 삭제는 stage 된 채), 옛 경로를 풀면 작업 트리에서 지워진 것으로 돌아간다
 */
function unstagedEntry(e: StatusEntry, target: IndexTarget): StatusEntry[] {
  const untracked = (): StatusEntry[] =>
    e.worktree === 'deleted'
      ? []
      : [{ ...withStates(e, 'untracked', 'untracked'), origPath: null, renameScore: null }];
  switch (e.index) {
    case 'added':
    case 'copied':
      return covers(target, e.path) ? untracked() : [e];
    case 'renamed': {
      const oldSide = e.origPath ?? '';
      const newCovered = covers(target, e.path);
      const oldCovered = covers(target, oldSide);
      const oldEntry = (index: FileState, worktree: FileState): StatusEntry => ({
        ...withStates(e, index, worktree),
        path: oldSide,
        origPath: null,
        renameScore: null,
      });
      if (newCovered && oldCovered) {
        return [oldEntry('unmodified', 'deleted'), ...untracked()];
      }
      if (newCovered) {
        return [oldEntry('deleted', 'unmodified'), ...untracked()];
      }
      return [
        oldEntry('unmodified', 'deleted'),
        { ...withStates(e, 'added', e.worktree), origPath: null, renameScore: null },
      ];
    }
    case 'modified':
      return [withStates(e, 'unmodified', e.worktree === 'unmodified' ? 'modified' : e.worktree)];
    case 'typeChanged':
      return [
        withStates(e, 'unmodified', e.worktree === 'unmodified' ? 'typeChanged' : e.worktree),
      ];
    case 'deleted':
      return [withStates(e, 'unmodified', 'deleted')];
    default:
      return [e];
  }
}

/** 두 쪽 모두 바뀐 것이 없는 항목은 status 에 나오지 않는다 */
function isListed(e: StatusEntry): boolean {
  return e.index !== 'unmodified' || e.worktree !== 'unmodified';
}

/** stage 된 변경이 있는 항목인지 (코어 `StatusEntry::is_staged`) */
function isStaged(e: StatusEntry): boolean {
  return !e.conflict && !['unmodified', 'untracked', 'ignored'].includes(e.index);
}

/**
 * 저장소 하나의 변경 항목에 폴더 stage·unstage 를 적용한다 (코어와 같은 결과 모양). 대상이 덮는 충돌 항목은
 * 그대로 두고 `skipped` 로 알린다. `ran` 은 코어가 git 쓰기를 돌리는지와 같다: 대상에 충돌이 없으면 빈 목록이
 * 아닌 한 늘 참이고, 충돌이 있으면 바뀔 항목이 하나라도 있을 때만 참이다
 */
export function applyMockIndexWrite(
  entries: readonly StatusEntry[],
  op: 'stage' | 'unstage',
  target: IndexTarget,
): { entries: StatusEntry[]; result: IndexWriteResult } {
  if (target.kind === 'paths' && target.paths.length === 0) {
    return { entries: [...entries], result: { ran: false, skipped: [] } };
  }
  const inTarget = (e: StatusEntry) =>
    covers(target, e.path) || (op === 'unstage' && covers(target, e.origPath));
  const skipped: SkippedPath[] = entries
    .filter((e) => e.conflict && inTarget(e))
    .map((e) => ({ path: e.path, reason: 'unmerged' as const }));
  const changes = (e: StatusEntry) =>
    !e.conflict && inTarget(e) && (op === 'stage' ? e.worktree !== 'unmodified' : isStaged(e));
  const ran = skipped.length === 0 || entries.some(changes);
  const next = entries.flatMap((e) => {
    if (!changes(e)) {
      return [e];
    }
    return op === 'stage' ? stagedEntry(e) : unstagedEntry(e, target);
  });
  return {
    entries: ran ? next.filter(isListed) : [...entries],
    result: { ran, skipped },
  };
}

/** stage 된 변경을 커밋한 뒤의 항목: index 쪽은 깨끗해지고 작업 트리 쪽 변경·untracked 는 남는다 */
export function commitMockStaged(entries: readonly StatusEntry[]): StatusEntry[] {
  return entries.flatMap((e) => {
    if (!isStaged(e)) {
      return [e];
    }
    if (e.index === 'deleted') {
      return [];
    }
    const kept: StatusEntry = {
      ...withStates(e, 'unmodified', e.worktree),
      origPath: null,
      renameScore: null,
    };
    return isListed(kept) ? [kept] : [];
  });
}

/** 폴더 장면 저장소의 지금 변경 항목 (변경이 없으면 빈 배열) */
export function mockFolderEntries(data: MockFolderData, repo: string): StatusEntry[] {
  return [...(data.folderChanges.find((row) => row.path === repo)?.entries ?? [])];
}

/** 요약 줄에서 그 저장소의 업스트림 상태 (요약·변경 줄·세션 상태가 같은 수를 쓴다) */
function trackOf(row: RepoSummary | undefined) {
  const ahead = row?.ahead ?? null;
  return {
    upstream: ahead !== null && row?.branch ? `origin/${row.branch}` : null,
    ahead: ahead ?? 0,
    behind: row?.behind ?? 0,
  };
}

/**
 * 폴더 장면 저장소 하나의 변경 항목을 바꾼다: 변경 줄(없어지면 빼고 새로 생기면 경로순으로 넣는다)·요약 줄의
 * 변경 수·충돌 수를 같은 규칙으로 다시 센다. `committed` 면 업스트림이 있는 저장소의 ahead 를 하나 올린다
 * (요약·브랜치 목록의 현재 브랜치). 모두 새 객체·새 배열로 바꾼다
 */
export function setMockFolderEntries(
  data: MockFolderData,
  repo: string,
  entries: readonly StatusEntry[],
  committed = false,
): void {
  const at = data.folderSummaries.findIndex((row) => row.path === repo);
  const before = data.folderSummaries[at];
  if (!before) {
    return;
  }
  const bump = committed && before.ahead !== null && before.ahead !== undefined;
  const row: RepoSummary = bump ? { ...before, ahead: (before.ahead ?? 0) + 1 } : { ...before };
  const summary = summarize(entries, trackOf(row), 0);
  row.changed = summary.staged + summary.unstaged + summary.untracked + summary.conflicted;
  row.conflicted = summary.conflicted;
  data.folderSummaries = data.folderSummaries.map((r, i) => (i === at ? row : r));
  const rest = data.folderChanges.filter((r) => r.path !== repo);
  data.folderChanges =
    entries.length === 0
      ? rest
      : [
          ...rest,
          {
            path: repo,
            name: row.name,
            branch: row.branch ?? null,
            entries: [...entries],
            summary,
          },
        ].sort((a, b) => a.path.localeCompare(b.path));
  if (bump) {
    data.folderBranches = {
      ...data.folderBranches,
      branches: data.folderBranches.branches.map((branch) =>
        branch.remote
          ? branch
          : {
              ...branch,
              repos: branch.repos.map((r) =>
                r.path === repo && r.current && r.upstream
                  ? { ...r, ahead: (r.ahead ?? 0) + 1 }
                  : r,
              ),
            },
      ),
    };
  }
}

/** 세션 상태를 변경 항목에 맞춘 사본 (`committed` 면 업스트림이 있을 때 ahead +1). 세션 상태 이벤트에 싣는다 */
export function mockStatusWith(
  state: RepoState,
  entries: readonly StatusEntry[],
  committed = false,
): RepoState {
  const status = state.status;
  const ahead = committed && status.branch.upstream ? status.branch.ahead + 1 : status.branch.ahead;
  const branch = { ...status.branch, ahead };
  return {
    ...state,
    status: {
      ...status,
      branch,
      entries: [...entries],
      summary: summarize(
        entries,
        { upstream: branch.upstream ?? null, ahead, behind: branch.behind },
        status.stashCount,
      ),
    },
  };
}

/**
 * 폴더 일괄 commit (`folderCommit`) 흉내. 저장소 목록 순서로 돌며 코어의 건너뜀·실패 규칙을 따른다: 요약에 실패한
 * 저장소(코어는 `ls-files -u` 실패를 충돌로 본다)·충돌·진행 중 작업 → "진행 중인 작업이 있음", `stageAll` 이면
 * 전부 stage 한 뒤, stage 된 것이 없으면 "stage 된 변경 없음". 커밋한 저장소는 stage 된 변경이 빠지고 ahead 가
 * 오른다. 바뀐 저장소 경로를 `committed` 로 알린다 (호출자가 세션 상태·이벤트를 맞춘다). 훅·서명·충돌 마커
 * 실패는 흉내 내지 않는다. 빈 `repos` 는 전부, 목록 밖 경로는 코어처럼 조용히 빠진다
 */
export function mockFolderCommit(
  data: MockFolderData,
  repos: readonly string[],
  message: string,
  stageAll: boolean,
): { result: BatchResult; committed: string[] } {
  if (message.trim() === '') {
    throw new IpcClientError({
      kind: 'internal',
      message: pick('커밋 메시지를 입력하세요', 'Enter a commit message'),
    });
  }
  const targets = data.openFolder.filter((r) => repos.length === 0 || repos.includes(r.path));
  const committed: string[] = [];
  const results: RepoResult[] = targets.map(({ path }) => {
    const summary = data.folderSummaries.find((row) => row.path === path);
    const name = summary?.name ?? path.split('/').pop() ?? path;
    const skip = (why: string): RepoResult => ({ path, name, ok: true, skipped: why, message: '' });
    let entries = mockFolderEntries(data, path);
    if (summary?.error || summary?.op || entries.some((e) => e.conflict)) {
      return skip(mockReason.inProgress());
    }
    if (stageAll) {
      entries = applyMockIndexWrite(entries, 'stage', { kind: 'all' }).entries;
    }
    if (!entries.some(isStaged)) {
      return skip(mockReason.nothingStaged());
    }
    setMockFolderEntries(data, path, commitMockStaged(entries), true);
    committed.push(path);
    return { path, name, ok: true, skipped: null, message: '' };
  });
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return {
    result: {
      label: pick('일괄 commit', 'Batch commit'),
      results,
      succeeded: results.length - skipped - failed,
      skipped,
      failed,
    },
    committed,
  };
}

// ── 세션의 충돌 흐름 (W15, WS-23) ─────────────────────────────────────────────
//
// 코어 `resolve_file`·`resolve_side`·`resolve_delete`·`unresolve`·`op_continue`·`op_skip`·`op_abort` 흉내 (폴더 장면의
// 저장소 세션만). 위의 변경 표·요약을 같은 규칙으로 바꾼다 — 폴더 stage·커밋이 보는 표와 같은 표다. 흉내 내지 않는 것:
// rebase 의 다음 단계(계속·건너뛰기는 남은 단계 없이 바로 끝난다), rerere·보관한 해결, hook, 실제 파일 내용

/** 폴더 장면 저장소의 진행 중 작업 종류를 바꾼다 (요약 줄, 새 배열). 끝나거나 중단되면 null */
export function setMockFolderOp(data: MockFolderData, repo: string, op: OpKind | null): void {
  data.folderSummaries = data.folderSummaries.map((row) =>
    row.path === repo ? { ...row, op } : row,
  );
}

/** 충돌 항목인지 (unmerged) */
function isConflictEntry(e: StatusEntry): boolean {
  return e.conflict !== null && e.conflict !== undefined;
}

/** 내용에 충돌 마커(줄 맨 앞의 `<<<<<<<`)가 남았는지 (코어 `resolve_file`·`op_continue` 의 검사 흉내) */
export function hasMockConflictMarkers(text: string): boolean {
  return /^<{7}(?: |$)/m.test(text);
}

/**
 * 충돌 파일 하나를 해결한 뒤의 항목들 (`resolve_file`·`resolve_side`·`resolve_delete`). `keep` 이 거짓이면 파일을 지운다
 * (`git rm`): 추가 충돌(양쪽 추가·한쪽 추가)이면 항목이 없어지고, 그 밖은 삭제가 stage 된다. 남기면 결과가 stage 된다
 * (추가 충돌은 added, 그 밖은 modified). 그 경로가 충돌 항목이 아니면 null
 */
export function resolveMockConflict(
  entries: readonly StatusEntry[],
  path: string,
  keep = true,
): StatusEntry[] | null {
  const found = entries.find((e) => e.path === path && isConflictEntry(e));
  if (!found) {
    return null;
  }
  const added =
    found.conflict === 'bothAdded' ||
    found.conflict === 'addedByUs' ||
    found.conflict === 'addedByThem';
  const resolved: StatusEntry[] = keep
    ? [{ ...withStates(found, added ? 'added' : 'modified', 'unmodified'), conflict: null }]
    : added
      ? []
      : [{ ...withStates(found, 'deleted', 'unmodified'), conflict: null }];
  return entries.flatMap((e) => (e === found ? resolved : [e]));
}

/**
 * 해결한 파일을 원래 충돌 항목으로 되돌린 항목들 (`unresolve`). 해결 때 지워진 항목이면 다시 넣는다 (경로순)
 */
export function unresolveMockConflict(
  entries: readonly StatusEntry[],
  original: StatusEntry,
): StatusEntry[] {
  const rest = entries.filter((e) => e.path !== original.path);
  return [...rest, original].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 작업을 건너뛰거나 중단한 뒤의 항목들: 이 작업이 만든 변경(충돌·stage 된 것·작업 트리 수정)이 사라지고 untracked 만
 * 남는다 — git 은 작업 트리가 깨끗해야 merge·rebase 등을 시작하므로 "작업을 시작하기 전" 이 곧 이 모양이다
 */
export function abandonMockOp(entries: readonly StatusEntry[]): StatusEntry[] {
  return entries.filter((e) => e.index === 'untracked' && e.worktree === 'untracked');
}

/** 질의가 고른 ref 이름들. 전체면 null */
function wantedRefs(query: GraphQuery): string[] | null {
  switch (query.revs.kind) {
    case 'solo':
      return [query.revs.name];
    case 'branches':
      return query.revs.names;
    default:
      return null;
  }
}

/**
 * 통합 타임라인을 만든다. 실제 코어처럼 저장소마다 선형 이력 한 줄(레인)을 두고, 행은 저장소가
 * 1~6행씩 구간으로 섞이게 배정한다. 레인 색은 저장소 색이다. `rows` 는 전체 ref 기준 행 수이고,
 * 질의가 ref 를 고르면 그 ref 가 없는 저장소의 행이 빠져 줄어든다 (남은 커밋의 oid·제목은 그대로다).
 * HEAD 범위(`head`)면 저장소마다 HEAD 보다 위(최신)의 커밋이 빠진다 — HEAD 에서 닿는 커밋만 남는다.
 * `scope`(저장소 경로, 비면 전부) 밖 저장소는 번호·색을 둔 채 행만 빠지고, 커밋 필터는 `filterMockGraph` 로
 * 코어 규칙대로 거른다 (텍스트·작성자면 목록 모드, 레인 색은 그대로 저장소 색)
 */
export function buildMockTimeline(
  folder: MockFolderData,
  rows: number,
  query: GraphQuery,
  generation: number,
  seed = 42,
  scope: readonly string[] = [],
): MockTimeline {
  const repos = folder.folderTimeline;
  const wanted = wantedRefs(query);
  const headOnly = query.revs.kind === 'head';
  const inScope = (index: number) => scope.length === 0 || scope.includes(repos[index]?.path ?? '');
  const included = repos
    .map((_, index) => index)
    .filter(
      (index) =>
        inScope(index) &&
        (wanted === null || repos[index]?.refs.some(([name]) => wanted.includes(name))),
    );
  const slots = repos.length === 0 ? 0 : Math.max(0, Math.floor(rows));
  const rng = mulberry32(seed + 7);

  // 전체 저장소 기준으로 자리를 구간 단위로 나눈다. 저장소별로 자리를 차례로 세면 그 순번이 곧
  // "위에서 몇 번째 커밋"이라 질의가 바뀌어도 같은 커밋을 가리킨다
  const includedSet = new Set(included);
  const slotRepos: number[] = [];
  const fullLength = new Map<number, number>();
  for (let slot = 0; slot < slots; ) {
    const repo = Math.floor(rng() * repos.length);
    const run = 1 + Math.floor(rng() * 6);
    for (let k = 0; k < run && slot < slots; k++, slot++) {
      if (includedSet.has(repo)) {
        slotRepos.push(repo);
        fullLength.set(repo, (fullLength.get(repo) ?? 0) + 1);
      }
    }
  }
  /** 저장소의 HEAD 깊이. ref 는 이력이 짧으면 마지막 커밋에 붙인다 */
  const clampTo = (repo: number, depth: number) => Math.min(depth, (fullLength.get(repo) ?? 1) - 1);
  // HEAD 범위면 저장소마다 HEAD 위의 커밋을 건너뛴다. 질의에 든 자리만 행으로 당겨 채운다
  const firstDepth = (repo: number) => (headOnly ? clampTo(repo, repos[repo]?.headDepth ?? 0) : 0);
  const rowsOfRepo = new Map<number, number[]>(included.map((repo) => [repo, []]));
  const seen = new Map<number, number>();
  let total = 0;
  for (const repo of slotRepos) {
    const depth = seen.get(repo) ?? 0;
    seen.set(repo, depth + 1);
    if (depth >= firstDepth(repo)) {
      rowsOfRepo.get(repo)?.push(total);
      total += 1;
    }
  }

  const graphRows = new Array<GraphRow>(total);
  const segments: MockGraph['segments'] = [];
  let lane = 0;
  for (const repo of included) {
    const spec = repos[repo];
    const own = rowsOfRepo.get(repo) ?? [];
    const first = own[0];
    const last = own[own.length - 1];
    if (!spec || first === undefined || last === undefined) {
      continue;
    }
    const color = spec.color;
    segments.push({ lane, start: first, end: last, color });
    const length = fullLength.get(repo) ?? own.length;
    const offset = firstDepth(repo);
    const headDepth = clampTo(repo, spec.headDepth);
    const ownLane = lane;
    // 깊이 → 그 커밋에 붙는 브랜치·태그 (행마다 ref 표 전체를 훑지 않게 한 번 묶는다 — 크기 조절값으로 ref 가 수천 개일 때)
    const refsAt = new Map<number, string[]>();
    for (const [name, at] of spec.refs) {
      if (!isHiddenRemote(name, query)) {
        const depth = clampTo(repo, at);
        refsAt.set(depth, [...(refsAt.get(depth) ?? []), name]);
      }
    }
    const tagsAt = new Map<number, string[]>();
    for (const [name, at] of spec.tags) {
      const depth = clampTo(repo, at);
      tagsAt.set(depth, [...(tagsAt.get(depth) ?? []), name]);
    }
    const authors = folder.authors;
    own.forEach((row, i) => {
      const depth = offset + i;
      const oid = timelineCommitOid(repo, depth, seed);
      const author = authors[(repo + depth) % authors.length];
      const time = BASE_TIME - row * 1800;
      graphRows[row] = {
        row,
        oid,
        parents: depth + 1 < length ? [timelineCommitOid(repo, depth + 1, seed)] : [],
        authorName: author?.[0] ?? '',
        authorEmail: author?.[1] ?? '',
        authorTime: time,
        commitTime: time,
        subject: `${SUBJECTS[(repo * 3 + depth) % SUBJECTS.length]} (#${length - depth})`,
        lane: ownLane,
        color,
        refs: [
          ...(refsAt.get(depth) ?? []).map((name) =>
            name.startsWith('origin/')
              ? remoteLabel(name, oid)
              : localLabel(name, oid, { isCurrent: name === spec.headBranch }),
          ),
          ...(tagsAt.get(depth) ?? []).map((name) => tagLabel(name, oid, true)),
        ],
        isHead: depth === headDepth,
        inHead: depth >= headDepth,
        repo,
      };
    });
    lane += 1;
  }

  const graph = filterMockGraph(
    { rows: graphRows, segments, edges: [], stubs: [], laneCount: segments.length },
    query,
    (row) => repos[row.repo ?? -1]?.color ?? 0,
  );
  return {
    info: {
      generation,
      rows: graph.rows.length,
      finished: true,
      maxPerRepo: TIMELINE_MAX_PER_REPO,
      repos: repos.map((spec, index) => ({
        index,
        name: spec.name,
        path: spec.path,
        color: spec.color,
        // 코어처럼 범위 밖 저장소는 읽지 않아 현재 브랜치를 모른다
        headBranch: inScope(index) ? spec.headBranch : null,
        truncated: false,
        error: null,
        inScope: inScope(index),
      })),
      scoped: repos.some((_, index) => !inScope(index)),
    },
    graph,
  };
}

/** 질의가 원격 브랜치를 숨기는데 이 이름이 원격인지 */
function isHiddenRemote(name: string, query: GraphQuery): boolean {
  return query.hideRemotes && name.startsWith('origin/');
}

// ── 저장소·충돌 장면 ───────────────────────────────────────────────────────────

/** 저장소 장면의 로컬 브랜치. `row` 는 라벨을 붙일 그래프 행 */
const REPO_LOCALS: {
  name: string;
  row: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  gone?: boolean;
  /** 이 브랜치를 체크아웃한 다른 워크트리의 경로 접미사 */
  worktree?: string;
}[] = [
  { name: 'main', row: 0, upstream: 'origin/main', ahead: 2, behind: 0 },
  { name: 'development', row: 6, upstream: 'origin/development', ahead: 0, behind: 12 },
  {
    name: 'feature/checkout-redesign',
    row: 11,
    upstream: 'origin/feature/checkout-redesign',
    ahead: 3,
    behind: 1,
  },
  { name: 'feature/search-filters', row: 17 },
  { name: 'fix/cart-rounding', row: 24, upstream: 'origin/fix/cart-rounding', gone: true },
  {
    name: 'hotfix/payment-timeout',
    row: 31,
    upstream: 'origin/hotfix/payment-timeout',
    ahead: 1,
    behind: 0,
    worktree: '-hotfix',
  },
  { name: 'release/2026.11', row: 45, upstream: 'origin/release/2026.11', ahead: 0, behind: 0 },
  { name: 'staging', row: 38, upstream: 'origin/staging', ahead: 0, behind: 4 },
];

/** 저장소 장면의 원격 브랜치 (원격 2개): [짧은 이름, 그래프 행] */
const REPO_REMOTES: [string, number][] = [
  ['origin/main', 3],
  ['origin/development', 5],
  ['origin/feature/checkout-redesign', 13],
  ['origin/hotfix/payment-timeout', 32],
  ['origin/release/2026.11', 45],
  ['origin/staging', 36],
  ['upstream/main', 8],
  ['upstream/development', 5],
  ['upstream/release/2026.10', 140],
];

/** 저장소 장면의 태그: [이름, 그래프 행, annotated] */
const REPO_TAGS: [string, number, boolean][] = [
  ['v2.4.0', 45, true],
  ['v2.3.1', 96, true],
  ['v2.3.0', 140, false],
  ['v2.2.0', 310, true],
];

/** 저장소 장면의 스태시. 마지막 것은 mGit 이 다른 워크트리에서 만든 것(출처 표시)이다 */
const REPO_STASHES: {
  message: string;
  branch: string;
  /** 스태시를 만든 커밋의 그래프 행 */
  baseRow: number;
  minutesAgo: number;
  includesUntracked: boolean;
  /** 출처 워크트리의 경로 접미사 */
  origin: string | null;
}[] = [
  {
    message: 'WIP on main: 장바구니 합계 반올림 실험',
    branch: 'main',
    baseRow: 0,
    minutesAgo: 30,
    includesUntracked: true,
    origin: null,
  },
  {
    message: 'On feature/checkout-redesign: 결제 단계 배치 임시 저장',
    branch: 'feature/checkout-redesign',
    baseRow: 11,
    minutesAgo: 1440,
    includesUntracked: false,
    origin: null,
  },
  {
    message: 'On hotfix/payment-timeout: 브랜치 전환 전 자동 보관',
    branch: 'hotfix/payment-timeout',
    baseRow: 31,
    minutesAgo: 4320,
    includesUntracked: false,
    origin: '-hotfix',
  },
];

/**
 * 폴더 장면의 커밋이 바꾼 파일 후보 (중첩 디렉터리 포함). 수정·추가·rename·삭제가 이 차례로 되풀이돼
 * 연속한 4개 이상을 고르면 어느 구간이든 추가·rename·삭제가 섞인다
 */
const FOLDER_COMMIT_FILES: ChangedFile[] = [
  changed('src/routes/orders/handlers/create-order.ts', { kind: 'modified' }),
  changed('src/routes/orders/schema/order.v2.json', { kind: 'added' }),
  changed('src/lib/http/retry-policy.ts', { kind: 'renamed', similarity: 91 }, 'src/lib/retry.ts'),
  changed('src/legacy/xml/OrderMapper.ts', { kind: 'deleted' }),
  changed('test/routes/orders/create-order.test.ts', { kind: 'modified' }),
  changed('docs/runbooks/orders/rollback.md', { kind: 'added' }),
  changed(
    'config/env/staging/limits.yaml',
    { kind: 'renamed', similarity: 100 },
    'config/staging-limits.yaml',
  ),
  changed('scripts/migrate/2025-10-orders.sql', { kind: 'deleted' }),
];

/** 커밋·스태시가 바꾼 파일 후보 (중첩 디렉터리 포함) */
const COMMIT_FILES: ChangedFile[] = [
  changed('src/features/cart/CartSummary.tsx', { kind: 'modified' }),
  changed('src/features/cart/hooks/useCartTotals.ts', { kind: 'added' }),
  changed('src/features/cart/__tests__/CartSummary.test.tsx', { kind: 'modified' }),
  changed('src/features/checkout/CheckoutPage.tsx', { kind: 'modified' }),
  changed('src/features/checkout/steps/PaymentStep.tsx', { kind: 'modified' }),
  changed('src/features/checkout/steps/ShippingStep.tsx', { kind: 'modified' }),
  changed('src/features/checkout/legacy/CardForm.tsx', { kind: 'deleted' }),
  changed('src/lib/money/round.ts', { kind: 'modified' }),
  changed(
    'src/lib/money/format.ts',
    { kind: 'renamed', similarity: 94 },
    'src/lib/format-money.ts',
  ),
  changed('docs/adr/0007-cart-rounding.md', { kind: 'added' }),
  changed('public/locales/ko/checkout.json', { kind: 'modified' }),
  changed('package.json', { kind: 'modified' }),
];

/** 저장소 장면의 작업 트리: staged·unstaged·untracked 가 섞여 있다 */
const REPO_ENTRIES: StatusEntry[] = [
  entry('src/features/cart/CartSummary.tsx', 'modified', 'unmodified'),
  entry('src/features/cart/hooks/useCartTotals.ts', 'added', 'unmodified'),
  entry('docs/adr/0007-cart-rounding.md', 'renamed', 'unmodified', {
    origPath: 'docs/adr/0007-rounding.md',
    renameScore: 92,
  }),
  entry('src/features/checkout/steps/PaymentStep.tsx', 'modified', 'modified'),
  entry('src/lib/money/round.ts', 'unmodified', 'modified'),
  entry('src/features/cart/__tests__/CartSummary.test.tsx', 'unmodified', 'deleted'),
  entry('package.json', 'unmodified', 'modified'),
  entry('src/features/cart/CartBadge.tsx', 'untracked', 'untracked'),
  entry('scripts/dev/seed-cart.mjs', 'untracked', 'untracked'),
];

/**
 * 저장소 장면(storefront-web)의 빌드 모듈 (W25): 감지된 넷 — 이름이 디렉터리 이름과 다른 얕은 것(`packages/ui`), 변경이
 * 든 깊은 것 둘(`src/features/cart` 변경 4·`src/features/checkout` 변경 1), 서브모듈과 겹치는 것(`vendor/design-system`).
 * 직접 추가한 모듈 하나(`tools`, 가장 얕다)는 수동 보정(`REPO_MODULE_OVERRIDES`)에 있다
 */
const REPO_MODULES: Module[] = [
  { name: '@acme/ui', path: 'packages/ui', kind: 'npm' },
  { name: 'cart', path: 'src/features/cart', kind: 'npm' },
  { name: 'checkout', path: 'src/features/checkout', kind: 'npm' },
  { name: '@acme/design-system', path: 'vendor/design-system', kind: 'npm' },
];

/** 저장소 장면의 모듈 수동 보정 처음 값: 직접 추가한 모듈 하나 */
const REPO_MODULE_OVERRIDES: ModuleOverrides = {
  added: [{ name: 'build-tools', path: 'tools', kind: 'manual' }],
  hidden: [],
};

/**
 * 저장소 장면의 서브모듈 (W25): 상태 다섯 가지가 다 보이게 — 깨끗함·commit 다름·변경 있음·미초기화(빈 디렉터리)·충돌.
 * 넷은 `vendor/` 아래(트리에서 접힌 디렉터리 안), 하나는 `libs/` 아래. oid 는 행 번호에서 만든다 (`[번호, 경로, 상태,
 * describe]`)
 */
const REPO_SUBMODULES: [number, string, SubmoduleInfo['status'], string | null][] = [
  [0, 'vendor/design-system', 'clean', 'v2.3.1'],
  [1, 'vendor/payment-sdk', 'mismatch', 'v1.8.0-4-g1a2b3c4'],
  [2, 'vendor/analytics', 'dirty', 'v0.9.2'],
  [3, 'vendor/legacy-theme', 'notInitialized', null],
  [4, 'libs/shared-proto', 'conflict', null],
];

/** 저장소 장면의 추적되지 않는 하위 저장소 (작업 트리 바로 아래 — 코어의 탐색 깊이 1) */
const REPO_NESTED = ['experiments', 'playground'];

/** 저장소 장면의 상위 저장소 후보 (조절값 `mgit.mock.superproject` 로 켠다) */
const REPO_SUPERPROJECT = '/mock/platform-monorepo';

/**
 * 모듈·서브모듈·하위 저장소 디렉터리에 까는 파일 (W25 — 트리에 그 디렉터리가 있어야 행이 보인다). 미초기화 서브모듈은
 * 빈 디렉터리라 여기 없고 `REPO_EMPTY_DIRS` 에 있다
 */
const REPO_MODULE_FILES = [
  'packages/ui/package.json',
  'packages/ui/src/Button.tsx',
  'src/features/cart/package.json',
  'src/features/checkout/package.json',
  'tools/README.md',
  'tools/release.mjs',
  'vendor/design-system/package.json',
  'vendor/design-system/README.md',
  'vendor/design-system/src/tokens.css',
  'vendor/payment-sdk/README.md',
  'vendor/payment-sdk/src/client.ts',
  'vendor/analytics/README.md',
  'vendor/analytics/index.ts',
  'libs/shared-proto/README.md',
  'libs/shared-proto/order.proto',
  'experiments/README.md',
  'experiments/package.json',
  'playground/README.md',
  'playground/index.html',
];

/** 저장소 장면의 빈 디렉터리 (미초기화 서브모듈) */
const REPO_EMPTY_DIRS = ['vendor/legacy-theme'];

/**
 * 모듈 목록 응답 (`modules`, 코어 `Core::modules` 흉내): 감지된 것에 직접 추가한 것(같은 경로가 없을 때만, kind 는
 * manual)을 더하고, 숨긴 경로를 빼고, 경로순으로 정렬한다
 */
export function mockModules(detected: readonly Module[], overrides: ModuleOverrides): Module[] {
  const list = [...detected];
  for (const m of overrides.added) {
    if (!list.some((x) => x.path === m.path)) {
      list.push({ ...m, kind: 'manual' });
    }
  }
  return list
    .filter((m) => !overrides.hidden.includes(m.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const CONFLICT_TEXT_PATH = 'src/features/checkout/steps/PaymentStep.tsx';
const CONFLICT_DELETE_PATH = 'src/features/checkout/legacy/CardForm.tsx';
const MERGING_BRANCH = 'feature/checkout-redesign';

/** 충돌 장면의 작업 트리: 충돌 2개 + merge 가 깨끗하게 합쳐 stage 한 파일 */
const CONFLICT_ENTRIES: StatusEntry[] = [
  entry(CONFLICT_TEXT_PATH, 'unmerged', 'unmerged', { conflict: 'bothModified' }),
  entry(CONFLICT_DELETE_PATH, 'unmerged', 'deleted', { conflict: 'deletedByThem' }),
  entry('src/features/checkout/CheckoutPage.tsx', 'modified', 'unmodified'),
  entry('src/features/checkout/steps/ShippingStep.tsx', 'modified', 'unmodified'),
  entry('src/features/checkout/api/createOrder.ts', 'added', 'unmodified'),
];

/** 3-way 편집기가 열리는 충돌 문서: 사람이 봐야 하는 블록 1개 + 자동 제안이 붙는 블록 1개 */
const CONFLICT_DOC: ConflictDoc = {
  eol: 'lf',
  trailingNewline: true,
  blocks: [
    {
      kind: 'clean',
      lines: [
        "import { useState } from 'react';",
        "import { formatMoney } from '../../../lib/money/format';",
        "import { MethodPicker } from './MethodPicker';",
        '',
        'export function PaymentStep({ order }: PaymentStepProps) {',
        '  const [method, setMethod] = useState(order.defaultMethod);',
      ],
    },
    {
      kind: 'conflict',
      labels: ['HEAD', 'base', MERGING_BRANCH],
      ours: [
        '  const total = roundHalfEven(order.subtotal + order.shipping);',
        '  const label = formatMoney(total, order.currency);',
      ],
      base: [
        '  const total = order.subtotal + order.shipping;',
        '  const label = formatMoney(total);',
      ],
      theirs: [
        '  const total = order.subtotal + order.shipping - order.discount;',
        '  const label = formatMoney(total, { currency: order.currency });',
      ],
    },
    {
      kind: 'clean',
      lines: ['', '  return (', '    <section className="payment">', '      <h2>결제 수단</h2>'],
    },
    {
      kind: 'conflict',
      labels: ['HEAD', 'base', MERGING_BRANCH],
      ours: ['      <MethodPicker value={method} onChange={setMethod} />'],
      base: ['      <MethodPicker value={method} onChange={setMethod} />'],
      theirs: ['      <MethodPicker value={method} onChange={setMethod} compact />'],
    },
    {
      kind: 'clean',
      lines: ['      <p className="total">{label}</p>', '    </section>', '  );', '}'],
    },
  ],
};

/** 위 문서의 블록 분류 (CF-15): 첫 블록은 직접 해결, 둘째는 theirs 제안 */
const CONFLICT_AUTO: AutoSuggestion[] = [
  { index: 0, class: 'real', resolution: null },
  { index: 1, class: 'theirsOnly', resolution: { kind: 'theirs' } },
];

/** 저장소를 열고 fetch·push 까지 해 본 것처럼 보이는 git 명령 기록: [인자, 쓰기 여부, 걸린 ms, 종료 코드, stderr 끝] */
const COMMAND_LOG: [string[], boolean, number, number, string][] = [
  [['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], false, 6, 0, ''],
  [['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/'], false, 11, 0, ''],
  [['status', '--porcelain=v2', '--branch', '--show-stash', '-z'], false, 23, 0, ''],
  [['log', '--date-order', '--max-count=10000', '--all'], false, 142, 0, ''],
  [['fetch', '--prune', '--progress', 'origin'], true, 1284, 0, ''],
  [['stash', 'push', '--include-untracked', '-m', 'WIP: 결제 단계 UI'], true, 58, 0, ''],
  [
    ['push', '--porcelain', 'origin', 'main'],
    true,
    912,
    1,
    [
      ' ! [rejected]        main -> main (fetch first)',
      "error: failed to push some refs to 'git@git.example.com:acme/storefront-web.git'",
      'hint: Updates were rejected because the remote contains work that you do not have locally.',
    ].join('\n'),
  ],
  [['diff', '--stat', 'HEAD'], false, 17, 0, ''],
];

/** 삭제/수정 충돌에서 남아 있는 쪽(ours)의 내용 */
const DELETED_FILE_TEXT = [
  "import { useState } from 'react';",
  '',
  '/** 카드 번호 입력 양식 (새 결제 단계로 대체 예정) */',
  'export function CardForm({ onSubmit }: CardFormProps) {',
  "  const [number, setNumber] = useState('');",
  '  return <input value={number} onChange={(e) => setNumber(e.target.value)} />;',
  '}',
  '',
].join('\n');

/** 충돌 문서에서 한쪽만 고른 전체 텍스트 */
function sideText(doc: ConflictDoc, side: 'ours' | 'base' | 'theirs'): string {
  const lines = doc.blocks.flatMap((b) => (b.kind === 'clean' ? b.lines : b[side]));
  return lines.join('\n') + (doc.trailingNewline ? '\n' : '');
}

/** 그래프의 ref 라벨을 장면 것으로 바꾼다 (생성기가 붙인 라벨은 지운다). 사이드바와 그래프가 같은 ref 를 보게 한다 */
function relabelGraph(graph: MockGraph, labels: readonly RefLabel[]): void {
  const byTarget = new Map<string, RefLabel[]>();
  for (const l of labels) {
    byTarget.set(l.target, [...(byTarget.get(l.target) ?? []), l]);
  }
  graph.rows.forEach((row, i) => {
    const own = byTarget.get(row.oid) ?? [];
    if (row.refs.length > 0 || own.length > 0) {
      graph.rows[i] = { ...row, refs: own };
    }
  });
}

/** 저장소 세션 상태의 모양: 현재 브랜치·업스트림 차이·작업 트리 변경·진행 중 작업 */
interface RepoShape {
  /** 현재 브랜치. 분리 HEAD 면 null */
  branch: string | null;
  /** [ahead, behind]. 업스트림(`origin/<branch>`)이 없으면 null */
  sync: [number, number] | null;
  entries: readonly StatusEntry[];
  /** 진행 중 작업. 충돌 항목(`conflict`)의 3-way 자료 라벨이 이것을 따른다 */
  op: ShapeOp | null;
}

/** 세션 모양이 흉내 내는 진행 중 작업 (bisect·am 은 장면에 없다) */
type ShapeOp = 'merge' | 'rebase' | 'cherryPick' | 'revert';

/** 요약의 작업 종류를 세션 모양의 작업으로 (장면에 없는 종류는 없음으로) */
function shapeOp(op: OpKind | null | undefined): ShapeOp | null {
  return op === 'merge' || op === 'rebase' || op === 'cherryPick' || op === 'revert' ? op : null;
}

/** 저장소 장면(storefront-web)의 모양: main, 2 ahead, 변경 몇 개 */
const REPO_SHAPE: RepoShape = { branch: 'main', sync: [2, 0], entries: REPO_ENTRIES, op: null };
/** 충돌 장면(checkout-service)의 모양: merge 가 충돌 2개로 멈춤 */
const CONFLICT_SHAPE: RepoShape = { ...REPO_SHAPE, entries: CONFLICT_ENTRIES, op: 'merge' };
/** 폴더 장면의 rebase 가 멈춘 저장소에서 다시 쌓고 있는 브랜치와 그 대상 */
const REBASING_BRANCH = 'feature/search-facets';
const REBASE_ONTO = 'development';

/**
 * 폴더 장면 저장소의 세션 모양: 요약·변경 보기와 같은 표에서 만든다 — 그 저장소의 세션(탭·가벼운 세션)이 폴더
 * 요약 줄과 어긋나 보이지 않게. 변경 항목·ahead·진행 중 작업은 폴더 데이터의 지금 값이다 (폴더 stage·commit, 세션의
 * 계속·중단 뒤에 연 세션도 같은 상태로 열린다). 폴더 장면의 저장소가 아니면 null
 */
function folderRepoShape(
  path: string,
  data: MockFolderData,
  specs: readonly FolderRepoSpec[],
): RepoShape | null {
  const spec = specs.find((s) => `${FOLDER_PATH}/${s.name}` === path);
  if (!spec) {
    return null;
  }
  const row = data.folderSummaries.find((s) => s.path === path);
  const ahead = row?.ahead ?? null;
  return {
    branch: spec.branch,
    sync: spec.sync && ahead !== null ? [ahead, row?.behind ?? 0] : spec.sync,
    entries: mockFolderEntries(data, path),
    op: shapeOp(row?.op),
  };
}

/**
 * 저장소 세션의 메서드별 데이터를 만든다. ref 대상은 `graph` 의 실제 커밋이라 사이드바에서 눌러
 * 이동할 수 있다. 현재 브랜치·작업 트리 변경·진행 중 작업은 `shape` 를 따르고, 충돌 항목마다 충돌 목록과
 * 3-way 자료를 만든다 (삭제 충돌은 한쪽 선택)
 */
function repoData(path: string, graph: MockGraph, seed: number, shape: RepoShape): MockRepoData {
  /** 그래프 행의 oid. 그래프가 짧으면 마지막 행 */
  const oidAt = (row: number) => graph.rows[Math.min(row, graph.rows.length - 1)]?.oid ?? '';
  const headOid = oidAt(0);
  const head: HeadState =
    graph.rows.length === 0
      ? { state: 'unborn', branch: shape.branch ?? 'main' }
      : shape.branch === null
        ? { state: 'detached', oid: headOid }
        : { state: 'attached', branch: shape.branch, oid: headOid };
  const upstream = shape.sync && shape.branch ? `origin/${shape.branch}` : null;
  /** 현재 브랜치 라벨은 상태의 업스트림 차이와 같은 수를 싣는다 */
  const current = (name: string, row: number) =>
    localLabel(name, oidAt(row), {
      isCurrent: true,
      upstream,
      ahead: shape.sync?.[0] ?? null,
      behind: shape.sync?.[1] ?? null,
    });
  const locals = REPO_LOCALS.map((b) =>
    b.name === shape.branch
      ? current(b.name, 0)
      : localLabel(b.name, oidAt(b.row), {
          upstream: b.upstream ?? null,
          ahead: b.gone ? null : (b.ahead ?? null),
          behind: b.gone ? null : (b.behind ?? null),
          upstreamGone: b.gone ?? false,
          worktreePath: b.worktree ? `${path}${b.worktree}` : null,
        }),
  );
  const extraCurrent =
    shape.branch !== null && !REPO_LOCALS.some((b) => b.name === shape.branch)
      ? [current(shape.branch, 0)]
      : [];
  const labels: RefLabel[] =
    graph.rows.length === 0
      ? []
      : [
          ...extraCurrent,
          ...locals,
          ...REPO_REMOTES.map(([name, row]) => remoteLabel(name, oidAt(row))),
          ...REPO_TAGS.map(([name, row, annotated]) => tagLabel(name, oidAt(row), annotated)),
        ];
  relabelGraph(graph, labels);

  const stashes: StashEntry[] = REPO_STASHES.map((st, index) => ({
    info: {
      index,
      oid: oidOf(EXTRA_OID_BASE + index, seed),
      base: oidAt(st.baseRow),
      message: st.message,
      time: BASE_TIME - st.minutesAgo * 60,
      includesUntracked: st.includesUntracked,
      branch: st.branch,
    },
    origin: st.origin ? `${path}${st.origin}` : null,
  }));

  const entries = [...shape.entries];
  const branch = { upstream, ahead: shape.sync?.[0] ?? 0, behind: shape.sync?.[1] ?? 0 };
  /** 충돌 파일 하나. stage blob 은 [base, ours, theirs] 이고 지운 쪽은 null 이다 */
  const conflictFile = (
    n: number,
    filePath: string,
    kind: ConflictKind,
    theirs: boolean,
  ): ConflictFile => ({
    path: filePath,
    kind,
    binary: false,
    submodule: false,
    stages: [
      oidOf(EXTRA_OID_BASE + 100 + n, seed),
      oidOf(EXTRA_OID_BASE + 200 + n, seed),
      theirs ? oidOf(EXTRA_OID_BASE + 300 + n, seed) : null,
    ],
  });
  // 명령 기록은 2초 간격으로 실행돼 마지막 것이 기준 시각에 시작한 것으로 본다 (시각은 밀리초)
  const commandLogged: CommandLogRecord[] = COMMAND_LOG.map(
    ([args, isWrite, elapsedMs, status, stderrTail], index) => ({
      id: index + 1,
      args,
      cwd: path,
      startedAt: (BASE_TIME - (COMMAND_LOG.length - 1 - index) * 2) * 1000,
      elapsedMs,
      status,
      stderrTail,
      isWrite,
      cancelled: false,
    }),
  );
  // 충돌 항목마다 충돌 목록 한 줄과 편집기 자료. 삭제 충돌은 한쪽 선택, 나머지는 같은 3-way 문서다.
  // rebase 는 ours = 다시 쌓는 대상, theirs = 다시 쌓는 브랜치 (git 의 rebase 중 라벨)
  const sideLabels =
    shape.op === 'rebase'
      ? { ours: REBASE_ONTO, base: 'base', theirs: REBASING_BRANCH }
      : {
          ours: shape.branch ?? 'HEAD',
          base: 'base',
          theirs:
            shape.op === 'cherryPick'
              ? 'CHERRY_PICK_HEAD'
              : shape.op === 'revert'
                ? 'REVERT_HEAD'
                : MERGING_BRANCH,
        };
  const conflicts = entries.flatMap((e, n) =>
    e.conflict ? [conflictFile(n, e.path, e.conflict, e.conflict !== 'deletedByThem')] : [],
  );
  const conflictPayloads: Record<string, ConflictPayload> = Object.fromEntries(
    conflicts.map((file): [string, ConflictPayload] =>
      file.stages[2] === null
        ? // 삭제/수정 충돌: 편집기 대신 "남기기/삭제" 선택 화면이 열린다
          [
            file.path,
            {
              file,
              labels: sideLabels,
              ours: DELETED_FILE_TEXT,
              base: DELETED_FILE_TEXT,
              theirs: null,
              doc: null,
              worktreeModified: false,
              worktree: null,
              submoduleSides: null,
              auto: [],
            },
          ]
        : // 텍스트 충돌: 3-way 편집기가 열린다
          [
            file.path,
            {
              file,
              labels: sideLabels,
              ours: sideText(CONFLICT_DOC, 'ours'),
              base: sideText(CONFLICT_DOC, 'base'),
              theirs: sideText(CONFLICT_DOC, 'theirs'),
              doc: CONFLICT_DOC,
              worktreeModified: false,
              worktree: null,
              submoduleSides: null,
              auto: CONFLICT_AUTO,
            },
          ],
    ),
  );
  const op: RepoState['op'] =
    shape.op === 'merge'
      ? { kind: 'merge', head: oidAt(11) }
      : shape.op === 'rebase'
        ? {
            kind: 'rebase',
            interactive: false,
            headName: `refs/heads/${REBASING_BRANCH}`,
            onto: oidAt(2),
            step: 2,
            total: 5,
          }
        : shape.op === 'cherryPick'
          ? { kind: 'cherryPick', head: oidAt(7), sequencer: false }
          : shape.op === 'revert'
            ? { kind: 'revert', head: oidAt(9), sequencer: false }
            : null;

  return {
    repoState: {
      refs: {
        head,
        labels,
        stashes: stashes.map((s) => s.info),
        worktrees: [
          {
            path,
            head: headOid,
            branch: shape.branch,
            detached: shape.branch === null,
            bare: false,
            locked: null,
            prunable: null,
            isMain: true,
          },
          {
            path: `${path}-hotfix`,
            head: oidAt(31),
            branch: 'hotfix/payment-timeout',
            detached: false,
            bare: false,
            locked: null,
            prunable: null,
            isMain: false,
          },
          {
            path: `${path}-review`,
            head: oidAt(60),
            branch: null,
            detached: true,
            bare: false,
            locked: '코드 리뷰 중',
            prunable: null,
            isMain: false,
          },
          // 폴더가 지워진 워크트리 (W22: 브랜치 트리 Worktrees 머리의 "정리" 단추가 보인다)
          {
            path: `${path}-spike`,
            head: oidAt(52),
            branch: null,
            detached: true,
            bare: false,
            locked: null,
            prunable: 'gitdir file points to non-existent location',
            isMain: false,
          },
        ],
        remotes: [
          {
            name: 'origin',
            fetchUrl: 'git@git.example.com:acme/storefront-web.git',
            pushUrl: null,
          },
          {
            name: 'upstream',
            fetchUrl: 'https://git.example.com/platform/storefront-web.git',
            pushUrl: null,
          },
        ],
      },
      status: {
        branch: { oid: headOid || null, head: shape.branch, ...branch },
        stashCount: stashes.length,
        entries,
        summary: summarize(entries, branch, stashes.length),
      },
      op,
    },
    listStashes: stashes,
    stashFiles: COMMIT_FILES.slice(0, 4),
    commitDetail: COMMIT_FILES,
    conflicts,
    conflictFile: conflictPayloads,
    commandLogged,
    // 충돌 레이더 (W22 배지): 지금 merge 해도 깨끗한 브랜치 하나, 충돌 나는 브랜치 하나 (파일 여섯 — 툴팁은 앞 다섯)
    conflictRadar: [
      { reference: 'development', kind: 'local', clean: true, conflicts: [], behind: 12, ahead: 0 },
      {
        reference: 'feature/checkout-redesign',
        kind: 'local',
        clean: false,
        conflicts: [
          'src/features/checkout/steps/PaymentStep.tsx',
          'src/features/checkout/steps/ShippingStep.tsx',
          'src/features/cart/CartSummary.tsx',
          'src/features/cart/hooks/useCartTotals.ts',
          'src/shared/money.ts',
          'package.json',
        ],
        behind: 1,
        ahead: 3,
      },
    ],
    // 백업 ref (W22 Backups): 현재 브랜치의 것(되돌리면 hard reset)과 다른 브랜치의 것
    backups: [
      {
        name: `refs/mgit/backup/${shape.branch ?? 'main'}/${BASE_TIME - 3_600}-000001`,
        branch: shape.branch ?? 'main',
        oid: oidAt(2),
        createdAt: BASE_TIME - 3_600,
      },
      {
        name: `refs/mgit/backup/staging/${BASE_TIME - 86_400}-000002`,
        branch: 'staging',
        oid: oidAt(40),
        createdAt: BASE_TIME - 86_400,
      },
    ],
    // 호스팅 (W24 Pull Requests 도구 창): 저장소 이름으로 프로젝트 경로를 만든다 (조절값은 클라이언트가 적용한다)
    ...mockHostingData(path.slice(path.lastIndexOf('/') + 1), oidAt),
    // 모듈·서브모듈·하위 저장소 (W25 Project 트리): 저장소 장면의 storefront-web 에만 있다 (다른 장면·폴더 장면의 하위
    // 저장소는 그 디렉터리가 트리에 없다)
    ...(path === REPO_PATH
      ? {
          modules: REPO_MODULES,
          moduleOverrides: REPO_MODULE_OVERRIDES,
          submodules: REPO_SUBMODULES.map(([n, smPath, status, describe]) => ({
            path: smPath,
            oid: oidOf(EXTRA_OID_BASE + 400 + n, seed),
            status,
            describe,
          })),
          nestedRepos: REPO_NESTED.map((name) => `${path}/${name}`),
          superproject: REPO_SUPERPROJECT,
        }
      : {
          modules: [],
          moduleOverrides: { added: [], hidden: [] },
          submodules: [],
          nestedRepos: [],
          superproject: null,
        }),
  };
}

/** 목 호스팅 계정의 사용자 이름 (지어낸 것) */
const MOCK_HOSTING_USER = 'mock-dev';

/**
 * 저장소 하나의 호스팅 자료 (W24): GitHub 프로젝트 `acme/<저장소>` + 계정 연결, 열린 PR 여섯, 본문 템플릿 하나. PR 은
 * 번호가 큰 것(최근)부터이고 배지 조합이 다 보인다 — 승인·검사 성공 / draft·리뷰 필요·검사 진행 중 / 변경 요청·검사
 * 실패·충돌·긴 제목 / 검사 성공만(봇) / 배지 없음 / 승인·검사 실패·충돌
 */
function mockHostingData(
  repo: string,
  oidAt: (row: number) => string,
): Pick<MockRepoData, 'hostingRemoteProject' | 'pullRequests' | 'prTemplates'> {
  const project = `acme/${repo}`;
  /** PR 하나 (지정하지 않은 값은 배지 없는 기본값) */
  const pr = (
    number: number,
    title: string,
    author: string,
    headRef: string,
    row: number,
    extra: Partial<PullRequest> = {},
  ): PullRequest => ({
    number,
    title,
    draft: false,
    author,
    authorAvatar: null,
    headRef,
    headSha: oidAt(row),
    baseRef: 'main',
    headRepo: null,
    crossRepo: false,
    webUrl: `https://github.com/${project}/pull/${number}`,
    updatedAt: null,
    review: null,
    checks: null,
    mergeable: null,
    labels: [],
    ...extra,
  });
  return {
    hostingRemoteProject: {
      accountId: `github:github.com:${MOCK_HOSTING_USER}`,
      kind: 'github',
      host: 'github.com',
      project,
      remote: 'origin',
    },
    pullRequests: [
      pr(128, 'Checkout: 결제 단계 오류 메시지 개선', 'hana-lee', 'feature/payment-errors', 3, {
        review: 'approved',
        checks: 'success',
        mergeable: true,
      }),
      pr(127, '장바구니 합계 계산을 서버로 옮기기', 'minjun-park', 'feature/server-totals', 8, {
        draft: true,
        review: 'review_required',
        checks: 'pending',
      }),
      pr(
        125,
        '검색 결과 페이지의 필터·정렬·페이지네이션 상태를 URL 쿼리로 동기화하고 뒤로 가기 동작을 정리',
        'seoyoon-choi',
        'feature/search-url-state',
        14,
        { review: 'changes_requested', checks: 'failure', mergeable: false },
      ),
      pr(
        121,
        'Bump react-router from 6.26.1 to 6.28.0',
        'dependabot[bot]',
        'deps/react-router',
        20,
        {
          checks: 'success',
          mergeable: true,
          crossRepo: true,
          headRepo: `dependabot/${repo}`,
        },
      ),
      pr(119, '배송지 폼 접근성 라벨 보강', 'jiwoo-kim', 'fix/shipping-labels', 26),
      pr(118, '결제 단계 컴포넌트 분리', 'hana-lee', 'refactor/payment-step', 33, {
        review: 'approved',
        checks: 'failure',
        mergeable: false,
      }),
    ],
    prTemplates: [
      {
        name: 'pull_request_template.md',
        body: '## 변경 내용\n\n## 확인 방법\n\n## 관련 이슈\n',
      },
    ],
  };
}

/**
 * 목의 호스팅 응답을 바꾸는 조절값 (W24 — 개발 서버에서는 `localStorage['mgit.mock.hosting']`). 기본 `github` = GitHub
 * 원격 프로젝트 + 계정 연결 + PR 목록. `none` = 원격 프로젝트 없음, `noAccount` = 계정 없음, `empty` = 열린 PR 없음,
 * `error` = 목록 읽기 실패, `gitlab` = GitLab 프로젝트(Merge Requests). 저장소 장면·충돌 장면·폴더 장면에서 탭으로 연
 * 저장소에 모두 걸린다
 */
export const MOCK_HOSTING_MODES = [
  'github',
  'none',
  'noAccount',
  'empty',
  'error',
  'gitlab',
] as const;
export type MockHostingMode = (typeof MOCK_HOSTING_MODES)[number];

/** 저장한 조절값을 호스팅 모드로 바꾼다. 비었거나 모르는 값이면 기본(`github`) */
export function parseMockHosting(raw: string | null | undefined): MockHostingMode {
  return MOCK_HOSTING_MODES.find((m) => m === raw) ?? 'github';
}

/** 조절값에 맞춘 원격 프로젝트 응답 (`hostingRemoteProject`) */
export function mockRemoteProject(data: MockRepoData, mode: MockHostingMode): RemoteProject | null {
  const project = data.hostingRemoteProject;
  switch (mode) {
    case 'none':
      return null;
    case 'noAccount':
      return { ...project, accountId: null };
    case 'gitlab':
      return {
        ...project,
        kind: 'gitlab',
        host: 'gitlab.com',
        accountId: `gitlab:gitlab.com:${MOCK_HOSTING_USER}`,
      };
    default:
      return project;
  }
}

/**
 * 조절값에 맞춘 PR 목록 응답 (`pullRequests`). `error` 면 코어의 호스팅 API 오류처럼 던진다. GitLab 이면 웹 주소가 MR
 * 주소다. 원격 프로젝트·계정이 없으면 빈 목록 (화면은 그때 부르지 않는다)
 */
export function mockPullRequests(data: MockRepoData, mode: MockHostingMode): PullRequest[] {
  switch (mode) {
    case 'none':
    case 'noAccount':
    case 'empty':
      return [];
    case 'error':
      throw new IpcClientError({
        kind: 'internal',
        message: pick(
          'GitHub API 요청이 실패했습니다 (401 Bad credentials)',
          'GitHub API request failed (401 Bad credentials)',
        ),
      });
    case 'gitlab':
      return data.pullRequests.map((pr) => ({
        ...pr,
        webUrl: `https://gitlab.com/${data.hostingRemoteProject.project}/-/merge_requests/${pr.number}`,
      }));
    default:
      return data.pullRequests;
  }
}

/** 후보 목록에서 `start` 부터 연속한 `count` 개를 고른다 (끝에서 처음으로 돈다, 후보 수를 넘지 않는다) */
function pickFiles(pool: readonly ChangedFile[], start: number, count: number): ChangedFile[] {
  return Array.from(
    { length: Math.min(pool.length, count) },
    (_, i) => pool[(start + i) % pool.length],
  ).filter((f) => f !== undefined);
}

/** 그래프 행에서 커밋 상세를 만든다. 그래프에 묶인 필드(행·자식)는 호출자가 정한다 */
function commitDetailOf(
  row: GraphRow,
  files: ChangedFile[],
  at: number | null,
  children: string[],
): CommitDetail {
  return {
    oid: row.oid,
    parents: row.parents,
    children,
    row: at,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    authorTime: row.authorTime,
    committerName: row.authorName,
    committerEmail: row.authorEmail,
    committerTime: row.commitTime,
    message: `${row.subject}\n\n변경 이유와 영향 범위를 정리했습니다. 기존 동작은 그대로이고 설정 변경은 없습니다.`,
    refs: row.refs,
    files,
  };
}

/** 그 커밋을 부모로 둔 행들의 oid */
function childrenIn(rows: readonly GraphRow[], oid: string): string[] {
  return rows.filter((r) => r.parents.includes(oid)).map((r) => r.oid);
}

/**
 * 커밋 상세를 그래프 행에서 만든다. 변경 파일은 후보 목록(`MockRepoData.commitDetail`)에서 행 번호에 따라
 * 2~6개를 고른다. 그래프에 없는 커밋이면 코어처럼 거부한다
 */
export function mockCommitDetail(
  graph: MockGraph,
  files: readonly ChangedFile[],
  oid: string,
): CommitDetail {
  const row = graph.rows.find((r) => r.oid === oid);
  if (!row) {
    throw new IpcClientError({ kind: 'internal', message: `unknown commit ${oid}` });
  }
  return commitDetailOf(
    row,
    pickFiles(files, row.row * 5, 2 + (row.row % 5)),
    row.row,
    childrenIn(graph.rows, oid),
  );
}

/** 폴더 장면의 저장소 경로 → 타임라인 번호. 이 폴더의 저장소가 아니면 코어처럼 거부한다 */
function folderRepoIndex(data: MockFolderCommits, repo: string): number {
  const index = data.repoIndex[repo];
  if (index === undefined) {
    throw new IpcClientError({
      kind: 'internal',
      message: pick(
        `이 폴더의 저장소가 아닙니다: ${repo}`,
        `Not a repository in this folder: ${repo}`,
      ),
    });
  }
  return index;
}

/**
 * 폴더 장면의 커밋 상세 (코어 `folder_commit_detail` 흉내). 커밋은 질의로 거르지 않은 전체 타임라인
 * (`all`)에서 그 저장소의 것만 찾고 — 없으면 거부 — 행·자식은 지금 타임라인(`current`)에서 채운다:
 * 지금 질의에 그 커밋이 없으면 둘 다 빈다. 라벨은 질의와 무관한 그 저장소의 것이다. 타임라인을 아직
 * 만들지 않았으면(`current` 가 null) 행·자식·라벨이 모두 빈다. 변경 파일은 전체 타임라인의 행 번호로
 * 4~6개를 골라 질의가 바뀌어도 같은 커밋은 같은 파일을 준다
 */
export function mockFolderCommitDetail(
  all: MockTimeline,
  current: MockTimeline | null,
  data: MockFolderCommits,
  repo: string,
  oid: string,
): CommitDetail {
  const index = folderRepoIndex(data, repo);
  const own = (timeline: MockTimeline) => timeline.graph.rows.filter((r) => r.repo === index);
  const source = own(all).find((r) => r.oid === oid);
  if (!source) {
    throw new IpcClientError({ kind: 'internal', message: `unknown commit ${oid}` });
  }
  const files =
    data.perCommit === null
      ? pickFiles(data.files, source.row * 3, 4 + (source.row % 3))
      : data.files.slice(0, data.perCommit);
  if (current === null) {
    return { ...commitDetailOf(source, files, null, []), refs: [] };
  }
  const shownRows = own(current);
  const shown = shownRows.find((r) => r.oid === oid);
  return commitDetailOf(source, files, shown?.row ?? null, shown ? childrenIn(shownRows, oid) : []);
}

/** 포함 브랜치 하나 (짧은 이름 → 전체 ref 이름) */
function containingBranch(shortName: string, remote: boolean, current: boolean): ContainingBranch {
  return {
    name: `refs/${remote ? 'remotes' : 'heads'}/${shortName}`,
    shortName,
    remote,
    current,
  };
}

/** 코어와 같은 순서: 현재 브랜치 → 로컬 → 원격, 각각 이름순 */
function containingResult(head: boolean, branches: ContainingBranch[]): ContainingRefs {
  const rank = (b: ContainingBranch) => (b.remote ? 2 : b.current ? 0 : 1);
  const sorted = [...branches].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0),
  );
  return { timedOut: false, head, branches: sorted };
}

/**
 * 폴더 장면의 포함 브랜치 (코어 `folder_commit_containing_refs` 흉내). 저장소마다 이력이 선형이라 ref 가 그
 * 커밋과 같거나 더 위(최신)에 있으면 품는다. HEAD 도 같다. 태그는 보지 않으므로 태그로만 닿는 맨 위 커밋은
 * 0개다. 커밋은 질의로 거르지 않은 전체 타임라인(`all`)에서 그 저장소의 것만 찾는다 — 없으면 거부한다
 */
export function mockFolderContainingRefs(
  all: MockTimeline,
  folder: MockFolderData,
  repo: string,
  oid: string,
): ContainingRefs {
  const index = folderRepoIndex(folder.folderCommitDetail, repo);
  const spec = folder.folderTimeline[index];
  const own = all.graph.rows.filter((r) => r.repo === index);
  const depth = own.findIndex((r) => r.oid === oid);
  if (!spec || depth < 0) {
    throw new IpcClientError({ kind: 'internal', message: `no such commit ${oid}` });
  }
  /** 이력이 짧으면 ref 는 마지막 커밋에 붙는다 (타임라인과 같은 규칙) */
  const clamp = (at: number) => Math.min(at, own.length - 1);
  const branches = spec.refs
    .filter(([, at]) => clamp(at) <= depth)
    .map(([name]) => {
      const remote = name.startsWith('origin/');
      return containingBranch(name, remote, !remote && name === spec.headBranch);
    });
  return containingResult(clamp(spec.headDepth) <= depth, branches);
}

/**
 * 저장소 장면의 포함 브랜치 (코어 `commit_containing_refs` 흉내): 그래프의 부모를 따라 각 브랜치·HEAD 에서
 * 그 커밋에 닿는지 본다. 그래프에 없는 커밋이면 거부한다
 */
export function mockContainingRefs(graph: MockGraph, refs: RepoRefs, oid: string): ContainingRefs {
  const rowOf = new Map(graph.rows.map((r) => [r.oid, r]));
  const target = rowOf.get(oid);
  if (!target) {
    throw new IpcClientError({ kind: 'internal', message: `no such commit ${oid}` });
  }
  /** `from` 에서 부모를 따라 목표에 닿는지. 부모는 늘 아래 행이므로 목표보다 아래로 내려가면 멈춘다 */
  const reaches = (from: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (at === oid) {
        return true;
      }
      const row = rowOf.get(at);
      if (!row || row.row > target.row || seen.has(at)) {
        continue;
      }
      seen.add(at);
      stack.push(...row.parents);
    }
    return false;
  };
  const branches = refs.labels.flatMap((label) => {
    const kind = label.kind.kind;
    if ((kind !== 'localBranch' && kind !== 'remoteBranch') || !reaches(label.target)) {
      return [];
    }
    return [
      {
        name: label.fullName,
        shortName: label.shortName,
        remote: kind === 'remoteBranch',
        current: label.isCurrent,
      },
    ];
  });
  const head = refs.head.state !== 'unborn' && reaches(refs.head.oid);
  return containingResult(head, branches);
}

/** 폴더 장면의 커밋 파일 diff (코어 `folder_commit_file_diff` 흉내). 이 폴더의 저장소가 아니면 거부한다 */
export function mockFolderCommitFileDiff(
  data: MockFolderCommits,
  repo: string,
  path: string,
  oldPath: string | null,
): FileDiff | null {
  folderRepoIndex(data, repo);
  return mockCommitFileDiff(data.files, path, oldPath);
}

/** 변경 종류에 맞는 hunk 하나짜리 diff 를 만든다 */
function mockDiff(path: string, oldPath: string | null, change: DiffChange): FileDiff {
  const body = [`// ${path}`, 'export function example() {', '  return compute();', '}'];
  /** 줄 하나 */
  const line = (kind: DiffLine['kind'], oldNo: number | null, newNo: number | null, text: string) =>
    ({ kind, oldNo, newNo, text, noNewline: false }) satisfies DiffLine;
  let lines: DiffLine[];
  if (change.kind === 'added') {
    lines = body.map((text, i) => line('add', null, i + 1, text));
  } else if (change.kind === 'deleted') {
    lines = body.map((text, i) => line('del', i + 1, null, text));
  } else {
    lines = [
      line('context', 1, 1, body[0] ?? ''),
      line('context', 2, 2, body[1] ?? ''),
      line('del', 3, null, '  return compute();'),
      line('add', null, 3, '  const value = compute();'),
      line('add', null, 4, '  return roundHalfEven(value);'),
      line('context', 4, 5, body[3] ?? ''),
    ];
  }
  const oldLines = lines.filter((l) => l.kind !== 'add').length;
  const newLines = lines.filter((l) => l.kind !== 'del').length;
  return {
    oldPath: change.kind === 'added' ? null : (oldPath ?? path),
    newPath: change.kind === 'deleted' ? null : path,
    change,
    binary: null,
    hunks: [
      {
        oldStart: oldLines === 0 ? 0 : 1,
        oldLines,
        newStart: newLines === 0 ? 0 : 1,
        newLines,
        section: '',
        lines,
      },
    ],
    truncated: false,
    totalLines: lines.length,
    nonUtf8: false,
  };
}

/**
 * 커밋·스태시 파일의 diff. 후보 목록에 없는 경로면 null. 코어처럼 이름이 바뀐 파일은 옛 경로(`oldPath`)를
 * 함께 받아야 rename 으로 나오고, 받지 못하면 파일 전체가 추가된 diff 다
 */
export function mockCommitFileDiff(
  files: readonly ChangedFile[],
  path: string,
  oldPath: string | null,
): FileDiff | null {
  const file = files.find((f) => f.path === path);
  if (!file) {
    return null;
  }
  const paired = file.change.kind !== 'renamed' || (oldPath !== null && oldPath === file.oldPath);
  return paired
    ? mockDiff(file.path, file.oldPath ?? null, file.change)
    : mockDiff(file.path, null, { kind: 'added' });
}

/** 작업 트리 파일의 diff. 그 영역(staged/unstaged)에 변경이 없는 경로면 null */
export function mockWorkTreeDiff(
  data: MockRepoData,
  path: string,
  staged: boolean,
): FileDiff | null {
  const found = data.repoState.status.entries.find((e) => e.path === path);
  const state = found ? (staged ? found.index : found.worktree) : 'unmodified';
  if (!found || found.conflict || state === 'unmodified' || state === 'ignored') {
    return null;
  }
  if (staged && state === 'untracked') {
    return null;
  }
  const change: DiffChange =
    state === 'added' || state === 'untracked'
      ? { kind: 'added' }
      : state === 'deleted'
        ? { kind: 'deleted' }
        : state === 'renamed'
          ? { kind: 'renamed', similarity: found.renameScore ?? 100 }
          : { kind: 'modified' };
  return mockDiff(path, found.origPath ?? null, change);
}

/**
 * 파일 API 목의 배치. 작업 트리에 지금 있는 파일만 깐다 — 커밋 변경 파일(W8 목) 중 삭제가 아닌 것과 작업
 * 트리 변경의 경로를 합치고, 작업 트리에서 지워졌거나 이름이 바뀌어 떠난 경로는 뺀다. 폴더 장면은 저장소마다
 * 같은 커밋 파일 후보에 그 저장소의 변경을 더한다
 */
function fsLayout(folderSpecs: readonly FolderRepoSpec[], scale: MockScale = {}): MockFsLayout {
  const committed = (files: readonly ChangedFile[]) =>
    files.filter((f) => f.change.kind !== 'deleted').map((f) => f.path);
  /** 커밋 후보 + 작업 트리 변경 − 작업 트리에서 사라진 경로 */
  const workTree = (files: readonly ChangedFile[], entries: readonly StatusEntry[]) => {
    const deleted = (e: StatusEntry) => e.index === 'deleted' || e.worktree === 'deleted';
    const gone = new Set([
      ...entries.filter(deleted).map((e) => e.path),
      ...entries.flatMap((e) => (e.origPath ? [e.origPath] : [])),
    ]);
    const paths = [...committed(files), ...entries.filter((e) => !deleted(e)).map((e) => e.path)];
    return paths.filter((path) => !gone.has(path));
  };
  return {
    folder: {
      path: FOLDER_PATH,
      repos: folderSpecs.map((spec) => ({
        name: spec.name,
        files: workTree(FOLDER_COMMIT_FILES, spec.entries),
      })),
      ...(countOf(scale.dirEntries) > 0 ? { logs: countOf(scale.dirEntries) } : {}),
      ...(countOf(scale.bigFileKiB) > 0 ? { bigFileKiB: countOf(scale.bigFileKiB) } : {}),
    },
    repos: [
      {
        path: REPO_PATH,
        files: [...workTree(COMMIT_FILES, REPO_ENTRIES), ...REPO_MODULE_FILES],
        dirs: REPO_EMPTY_DIRS,
      },
      { path: CONFLICT_PATH, files: workTree(COMMIT_FILES, CONFLICT_ENTRIES) },
    ],
    fallbackFiles: committed(COMMIT_FILES),
  };
}

/** 경로 글자로 정하는 작은 해시 (파일마다 히스토리 시작 행을 다르게) */
function pathHash(path: string): number {
  let h = 0;
  for (const ch of path) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return h;
}

/**
 * 파일 히스토리 (`fileHistory`). 그래프의 커밋 몇 개를 그 파일을 바꾼 커밋으로 삼는다 — 경로마다 시작 행과
 * 간격이 다르고 최신 순이다. 최대 12개(그리고 `limit`)
 */
export function mockFileHistory(graph: MockGraph, path: string, limit: number): HistoryEntry[] {
  const rows = graph.rows;
  if (rows.length === 0) {
    return [];
  }
  const h = pathHash(path);
  const stride = 3 + (h % 5);
  const first = h % Math.min(rows.length, 7);
  const out: HistoryEntry[] = [];
  for (let at = first; at < rows.length && out.length < Math.min(12, limit); at += stride) {
    const row = rows[at];
    if (row) {
      out.push({
        oid: row.oid,
        subject: row.subject,
        authorName: row.authorName,
        authorTime: row.authorTime,
        path,
      });
    }
  }
  return out;
}

/**
 * blame (`blame`). 파일 내용을 줄마다 나누고, 그 파일 히스토리의 커밋들에 몇 줄씩 묶어 돌려 준다 (최신 커밋이
 * 위쪽 블록). `text` 가 없으면(바이너리·없는 파일) git 처럼 거부한다
 */
export function mockBlame(graph: MockGraph, path: string, text: string | null): BlameLine[] {
  if (text === null) {
    throw new IpcClientError({
      kind: 'internal',
      message: `fatal: no such path '${path}' in HEAD`,
    });
  }
  const history = mockFileHistory(graph, path, 6);
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const rowOf = new Map(graph.rows.map((row) => [row.oid, row]));
  const blockSize = 1 + (pathHash(path) % 5);
  return lines.map((lineText, i) => {
    const commit = history[Math.floor(i / blockSize) % Math.max(1, history.length)];
    const row = commit ? rowOf.get(commit.oid) : undefined;
    return {
      oid: commit?.oid ?? '',
      origLine: i + 1,
      line: i + 1,
      author: row?.authorName ?? '',
      authorMail: row ? `<${row.authorEmail}>` : '',
      authorTime: row?.authorTime ?? null,
      summary: row?.subject ?? '',
      previousOid: null,
      previousPath: null,
      boundary: false,
      text: lineText,
    };
  });
}

/** 장면 조절값 */
export interface MockSceneOptions {
  /**
   * 폴더 장면에서 진행 중인 작업이 있는 저장소를 몇 개 더할지 (W15 작업 띠를 여러 줄로 볼 때, `EXTRA_FOLDER_OPS` 의 앞에서
   * 이만큼). 기본 0 — rebase 중인 catalog-service 하나
   */
  folderOps?: number;
  /** 화면 측정용 크기 조절값 (기본은 모두 꺼짐) */
  scale?: MockScale;
}

/** 장면을 만든다. `seed` 는 그래프에 없는 객체(스태시·blob)의 oid 에만 쓴다 */
export function createMockScene(
  name: MockSceneName,
  seed = 42,
  options: MockSceneOptions = {},
): MockScene {
  const specs = folderRepos(options.folderOps ?? 0, options.scale);
  const fs = createMockFs(fsLayout(specs, options.scale));
  switch (name) {
    case 'folder': {
      // 폴더의 저장소를 탭이나 가벼운 세션으로 열면 그 저장소의 요약 줄과 같은 브랜치·변경·진행 중 작업으로
      // 연다 (커밋 그래프와 ref 배치는 공통 합성 데이터라 타임라인과는 다르다)
      const folder = folderData(seed, specs, options.scale);
      return {
        name,
        startupPaths: [FOLDER_PATH],
        folder,
        repo: (path, graph) =>
          repoData(path, graph, seed, folderRepoShape(path, folder, specs) ?? REPO_SHAPE),
        fs,
      };
    }
    case 'repo':
      return {
        name,
        startupPaths: [REPO_PATH],
        folder: null,
        repo: (path, graph) => repoData(path, graph, seed, REPO_SHAPE),
        fs,
      };
    case 'conflict':
      return {
        name,
        startupPaths: [CONFLICT_PATH],
        folder: null,
        repo: (path, graph) =>
          repoData(path, graph, seed, path === CONFLICT_PATH ? CONFLICT_SHAPE : REPO_SHAPE),
        fs,
      };
  }
}
