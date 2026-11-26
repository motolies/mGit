import { settingsStorage } from '@mgit/storage';
import type { IpcClient } from '../client';
import { IpcClientError } from '../client';
import { EMPTY_COMMIT_FILTER, isEmptyCommitFilter } from '../commit-filter';
import type {
  ContainingRefs,
  FileDiff,
  GraphQuery,
  HeadState,
  IndexTarget,
  IndexWriteResult,
  InProgressOp,
  ModuleOverrides,
  OpOutcome,
  RefLabel,
  RepoOpened,
  RepoSessionRelease,
  RepoState,
  SessionEvent,
  SessionId,
  SessionProfile,
  StatusEntry,
  TagRefResult,
} from '../types';
import {
  mockBranchDeleteTarget,
  mockDeleteBranches,
  mockFolderDeleteTargets,
} from './mock-branch-delete';
import {
  applyMockBatchMoves,
  applyMockBatchRenames,
  createMockRecorder,
  type MockCommand,
  mockBatchLabel,
  mockCommitCommands,
  mockFolderBatch,
  mockIndexCommand,
  mockOpCommand,
  mockResolveCommands,
  mockUnresolveCommand,
  mockUpdateLocalBranch,
} from './mock-console';
import { mockDiffDocument } from './mock-diff-document';
import { createMockFileOperations } from './mock-file-operations';
import { compileMockFilter, filterMockGraph, mockAuthors } from './mock-filter';
import { MockGraphSource, windowOfGraph } from './mock-graph-source';
import { pick } from './mock-l10n';
import { mockWorkspaceSearch } from './mock-search';
import {
  MockGitFailure,
  type MockTagFail,
  mockDefaultTagRemote,
  mockDeleteLocalTags,
  mockDeleteRemoteTags,
  mockFetchLabel,
  mockFetchTags,
  mockLookupError,
  mockLookupRemoteTags,
  mockPushTags,
  mockReplaceRemoteTags,
  mockTagList,
  mockTagNameError,
  mockTagNamesLabel,
  mockTagOpMessage,
  mockTagReport,
  mockUnknownRemote,
  readMockTagFail,
  recordMockTagCheck,
} from './mock-tags';
import {
  abandonMockOp,
  applyMockIndexWrite,
  buildMockTimeline,
  commitMockStaged,
  createMockScene,
  hasMockConflictMarkers,
  type MockFolderData,
  type MockHostingMode,
  type MockRepoData,
  type MockScale,
  type MockSceneName,
  type MockTimeline,
  mockBlame,
  mockCommitDetail,
  mockCommitFileDiff,
  mockContainingRefs,
  mockFileHistory,
  mockFolderCommit,
  mockFolderCommitDetail,
  mockFolderCommitFileDiff,
  mockFolderContainingRefs,
  mockFolderEntries,
  mockIndexPathError,
  mockModules,
  mockPullRequests,
  mockRemoteProject,
  mockRollback,
  mockStatusWith,
  mockWorkTreeDiff,
  parseMockHosting,
  relabelGraph,
  resolveMockConflict,
  setMockFolderEntries,
  setMockFolderOp,
  unresolveMockConflict,
} from './mock-workspace';
import { createNullClient } from './null-client';

/** 목 모드에서는 스테이징·커밋·브랜치 작업을 지원하지 않는다 (빈 구현) */
function stubChanges() {
  const {
    gitVersion: _gv,
    openRepo: _or,
    graphWindow: _gw,
    findRow: _fr,
    repoState: _rs,
    refreshRepo: _rr,
    reloadGraph: _rg,
    cancelOperation: _co,
    commandLogRecent: _cl,
    closeRepo: _cr,
    searchCommits: _sc,
    searchAdvanced: _sa,
    graphQuery: _gq,
    setGraphQuery: _sq,
    graphAuthors: _ga,
    setGraphLayoutPrefs: _sp,
    ...rest
  } = createNullClient();
  return rest;
}

export interface MockClientOptions {
  rows: number;
  seed?: number;
  /** 스트리밍 흉내: 이 간격(ms)마다 Progress 를 보낸다. 0 이면 즉시 완료 */
  progressIntervalMs?: number;
  /** Progress 한 번에 늘어나는 행 수 */
  progressStep?: number;
  /** 장면 (`VITE_MGIT_MOCK_SCENE`). 없으면 단일 저장소의 합성 그래프만 준다 */
  scene?: MockSceneName | null;
  /**
   * 통합 타임라인의 첫 로드에 걸리는 시간 (ms). 0 이면 열자마자 끝난 정보를 준다. 0 보다 크면 코어처럼
   * 끝나지 않은 정보를 먼저 주고 그 시간 뒤에 `graphLoadFinished` 를 보낸다. 주지 않으면
   * `localStorage['mgit.mock.timelineDelayMs']` 를 본다 (브라우저에서 "브랜치 트리가 로그보다 먼저
   * 뜬다"를 눈으로 확인할 때 쓴다)
   */
  timelineDelayMs?: number;
  /**
   * 포함 브랜치(`commitContainingRefs`·`folderCommitContainingRefs`) 응답 지연 (ms). 주지 않으면 부를
   * 때마다 `localStorage['mgit.mock.containingDelayMs']` 를 본다 (브라우저에서 "읽는 중" 을 볼 때 쓴다)
   */
  containingDelayMs?: number;
  /**
   * 참이면 포함 브랜치가 코어의 시간 초과처럼 `timedOut: true` 로 온다 (지연 뒤). 주지 않으면 부를 때마다
   * `localStorage['mgit.mock.containingTimeout'] === '1'` 을 본다 — 켠 채 "다시 시도" 를 누르면 다시 시간
   * 초과이고, 끈 뒤 누르면 읽힌다
   */
  containingTimeout?: boolean;
  /**
   * 폴더 장면에서 진행 중인 작업이 있는 저장소를 몇 개 더할지 (W15 작업 띠를 여러 줄로 볼 때). 주지 않으면
   * `localStorage['mgit.mock.folderOps']` 를 본다 (기본 0 — rebase 중인 catalog-service 하나)
   */
  folderOps?: number;
  /**
   * 화면 측정용 크기 조절값 (W18 ②, 폴더 장면). 주지 않으면 `localStorage['mgit.mock.<이름>']` 을 본다 — 이름은
   * `MockScale` 의 키(`repos`·`remoteBranches`·`commitFiles`·`dirEntries`·`authors`·`worktreeChanges`·`bigFileKiB`). 장면은
   * 클라이언트를 만들 때 한 번 만들므로 바꾼 뒤에는 페이지를 다시 읽는다. 기본은 모두 꺼짐
   */
  scale?: MockScale;
  /**
   * 호스팅 응답 (W24 Pull Requests 도구 창: 원격 프로젝트·PR 목록). 주지 않으면 부를 때마다
   * `localStorage['mgit.mock.hosting']` 을 본다 — `github`(기본)·`none`·`noAccount`·`empty`·`error`·`gitlab`
   * (`MockHostingMode`). 원격 프로젝트는 세션을 열 때 한 번 읽으므로 바꾼 뒤에는 페이지를 다시 읽는다
   */
  hosting?: MockHostingMode;
  /**
   * 참이면 저장소 장면의 storefront-web 이 서브모듈로 열린다 — `openRepo().superproject` 에 장면의 상위 저장소 경로를 싣는다
   * (W25 Project 트리의 상위 저장소 링크). 주지 않으면 세션을 열 때 `localStorage['mgit.mock.superproject'] === '1'` 을 본다
   * (바꾼 뒤에는 페이지를 다시 읽는다). 기본은 꺼짐
   */
  superproject?: boolean;
  /**
   * 저장소마다 더할 합성 tag 수 (tag 수천 개 화면 측정, B3). 주지 않으면 `VITE_MGIT_MOCK_TAGS`, 그것도 없으면
   * `localStorage['mgit.mock.tags']` 를 본다 (장면은 클라이언트를 만들 때 한 번 만들므로 바꾼 뒤에는 페이지를 다시 읽는다).
   * 기본 0
   */
  tags?: number;
}

/** 목 전용 조절값을 두는 저장 키 */
const TIMELINE_DELAY_KEY = 'mgit.mock.timelineDelayMs';
const CONTAINING_DELAY_KEY = 'mgit.mock.containingDelayMs';
const CONTAINING_TIMEOUT_KEY = 'mgit.mock.containingTimeout';
const FOLDER_OPS_KEY = 'mgit.mock.folderOps';
const HOSTING_KEY = 'mgit.mock.hosting';
const SUPERPROJECT_KEY = 'mgit.mock.superproject';
/** 합성 tag 수 (`MockClientOptions.tags`) */
const TAGS_KEY = 'mgit.mock.tags';
/** 상태 바에 보일 git 버전 글자 (매뉴얼 그림용). 없으면 `DEFAULT_GIT_VERSION` */
const GIT_VERSION_KEY = 'mgit.mock.gitVersion';
const DEFAULT_GIT_VERSION = '2.54.0 (mock)';
/** 크기 조절값의 이름들 (저장 키는 `mgit.mock.<이름>`) */
const SCALE_NAMES = [
  'repos',
  'remoteBranches',
  'commitFiles',
  'dirEntries',
  'authors',
  'worktreeChanges',
  'bigFileKiB',
] as const satisfies readonly (keyof MockScale)[];

/** 저장해 둔 조절값 문자열. 없거나 읽을 수 없으면 null */
function storedValue(key: string): string | null {
  try {
    return settingsStorage.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 저장해 둔 양수 (지연 ms·개수). 없거나 숫자가 아니거나 0 이하면 0 */
function storedNumber(key: string): number {
  const n = Number(storedValue(key) ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 합성 tag 수: 옵션 → `VITE_MGIT_MOCK_TAGS` → 저장 키 (숫자가 아니거나 0 이하면 0) */
function mockTagCount(option: number | undefined): number {
  if (option !== undefined) {
    return Math.max(0, Math.floor(option));
  }
  const env = Number(import.meta.env?.VITE_MGIT_MOCK_TAGS ?? 0);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : storedNumber(TAGS_KEY);
}

/** 저장해 둔 크기 조절값 (켠 것만) */
function storedScale(): MockScale {
  return Object.fromEntries(
    SCALE_NAMES.flatMap((name) => {
      const n = storedNumber(`mgit.mock.${name}`);
      return n > 0 ? [[name, n]] : [];
    }),
  );
}

/**
 * 목 메서드 호출 수 (브라우저 확인용: 개발 도구에서 `globalThis.__mgitMockCalls` 로 읽는다). 지금은 포함
 * 브랜치 두 메서드(로그를 빠르게 훑는 동안 요청이 쌓이지 않는지)와 파일 API 두 메서드(펼칠 때 그 디렉터리만
 * 읽는지, 다시 읽기가 펼친 디렉터리 수만큼만 나가는지), 폴더 일괄 작업(툴바·트리 메뉴가 어느 저장소로 부르는지),
 * 가벼운 세션(W13: 열기·놓기, 파일 히스토리·blame·외부 도구, light 세션의 그래프 API 거부 `graphUnavailable`),
 * 폴더 stage·unstage·일괄 commit(W14: `folderStage`·`folderUnstage`·`folderCommit`), 세션의 줄 단위 stage·되돌리기
 * (W14 작업 트리 diff 탭: `stageLines`·`discardLines`), 호스팅(W24: `pullRequests`·`createPullRequest`·`checkoutPullRequest`·
 * `openUrl`), 모듈·서브모듈 쓰기(W25: `moduleScopeSet`·`moduleOverridesSet`·`submodule*`)를 센다. 나열한 디렉터리는
 * 차례로 `globalThis.__mgitMockFsDirs` 에, 일괄 작업의 인자는 `globalThis.__mgitMockBatches` 에 남는다 — 일괄 작업은
 * `{op, repos}`, W14 메서드는 `{method, repo, target}`·`{method, repos, message, stageAll}` 꼴이다
 */
function countMockCall(method: string): void {
  const g = globalThis as { __mgitMockCalls?: Record<string, number> };
  g.__mgitMockCalls ??= {};
  g.__mgitMockCalls[method] = (g.__mgitMockCalls[method] ?? 0) + 1;
}

/** 쓰기 메서드의 인자를 `globalThis.__mgitMockBatches` 에 남긴다 */
function recordMockWrite(args: Record<string, unknown>): void {
  const g = globalThis as { __mgitMockBatches?: unknown[] };
  g.__mgitMockBatches ??= [];
  g.__mgitMockBatches.push(args);
}

/** 요청한 저장소의 줄만 남긴다. 요청이 없거나 비면 전부 (코어의 부분집합 조회 흉내) */
function onlyRepos<T extends { path: string }>(rows: readonly T[], repos?: readonly string[]): T[] {
  return repos && repos.length > 0 ? rows.filter((row) => repos.includes(row.path)) : [...rows];
}

interface MockSession {
  path: string;
  source: MockGraphSource;
  /** 지금 그래프 질의. 커밋 필터만 실제로 적용한다 (나머지 옵션은 받아 두기만 한다) */
  query: GraphQuery;
  timer: ReturnType<typeof setTimeout> | null;
  /** 장면 데이터. 장면이 없으면 null */
  data: MockRepoData | null;
  /** 코어 `SessionProfile` 흉내: 탭 = full, 폴더가 연 세션 = light (그래프 메서드 거부, 그래프 이벤트 없음) */
  profile: SessionProfile;
  /** light 세션을 잡은 폴더 세션들. full 이면 비어 있다 */
  holders: SessionId[];
  /** 세션 이벤트를 보낼 곳. 승격하면 탭이 넘긴 것으로 바뀐다 */
  emit: (event: SessionEvent) => void;
  /**
   * 모듈 범위·수동 보정 (W25): 코어는 작업 트리별로 저장하지만 목은 세션에 둔다 (`moduleScopeSet`·`moduleOverridesSet` 이
   * 바꾸고, `moduleScope`·`modules` 가 읽는다)
   */
  moduleScope: string | null;
  moduleOverrides: ModuleOverrides;
}

/** 폴더 하나가 잡을 수 있는 가벼운 세션 수 (코어 `LIGHT_SESSIONS_PER_FOLDER`) */
const LIGHT_SESSIONS_PER_FOLDER = 3;

/** 장면의 폴더 세션 */
interface MockFolderSession {
  data: MockFolderData;
  emit: (event: SessionEvent) => void;
  query: GraphQuery;
  /** 타임라인 저장소 범위 (원 저장소 경로). 비면 전부 */
  scope: string[];
  generation: number;
  /** 현재 질의로 만든 타임라인. 처음 쓸 때 만든다 */
  timeline: MockTimeline | null;
  /**
   * 질의로 거르지 않은 전체 타임라인 (검색·커밋 상세·포함 브랜치·작성자의 재료). 처음 쓸 때 한 번 만든다 — 재료(저장소
   * 표·행 수)가 바뀌지 않으므로 늘 같은 값이고, 행이 수십만 개일 때 상세를 열 때마다 다시 만드는 목 비용이 화면 측정에
   * 섞이지 않게 한다
   */
  allHistory: MockTimeline | null;
  /** 지연 로드 중인 첫 타임라인의 타이머 */
  timelineTimer: ReturnType<typeof setTimeout> | null;
}

/** 통합 타임라인의 기본 질의: 날짜순 전체 (코어 기본값과 같다) */
const TIMELINE_QUERY: GraphQuery = {
  revs: { kind: 'all' },
  hideRemotes: false,
  pathScope: [],
  sort: 'date',
  firstParent: false,
  noMerges: false,
  filter: EMPTY_COMMIT_FILTER,
};

/** 저장소 탭의 기본 질의: 토폴로지 순 전체 (코어 기본값과 같다) */
const GRAPH_QUERY: GraphQuery = { ...TIMELINE_QUERY, sort: 'topo' };

/** 변경 없는 깨끗한 저장소 상태 (목·테스트용) */
export function emptyRepoState(head: HeadState): RepoState {
  const branch = head.state === 'detached' ? null : head.branch;
  return {
    refs: { head, labels: [], stashes: [], worktrees: [], remotes: [] },
    status: {
      branch: {
        oid: head.state === 'unborn' ? null : head.oid,
        head: branch,
        upstream: null,
        ahead: 0,
        behind: 0,
      },
      stashCount: 0,
      entries: [],
      summary: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        ahead: 0,
        behind: 0,
        stashCount: 0,
        upstream: null,
      },
    },
    op: null,
  };
}

/**
 * 코어 없이 동작하는 목 클라이언트. `VITE_MGIT_MOCK=<행 수>` 로 켠다.
 * 브라우저(Safari)에서 PoC-2 렌더링 측정을 할 때 쓴다. `scene` 을 주면 폴더·저장소·충돌 화면까지
 * 채운 장면 데이터(`mock-workspace.ts`)로 열린다
 */
export function createMockClient(opts: MockClientOptions): IpcClient {
  const sessions = new Map<SessionId, MockSession>();
  const folders = new Map<SessionId, MockFolderSession>();
  const scene = opts.scene
    ? createMockScene(opts.scene, opts.seed, {
        folderOps: opts.folderOps ?? storedNumber(FOLDER_OPS_KEY),
        scale: opts.scale ?? storedScale(),
        tags: mockTagCount(opts.tags),
      })
    : null;
  /** 저장소 경로 → 해결한 충돌의 원래 항목 (W15 `unresolve` 가 되돌린다) */
  const resolvedConflicts = new Map<string, Map<string, StatusEntry>>();
  /** 저장소 경로 → 충돌 마커를 남긴 채 저장한 경로 (계속할 때 코어처럼 거부한다) */
  const markerPaths = new Map<string, Set<string>>();
  /** 쓰기 명령 기록을 만든다 (W19 ② 폴더 콘솔 — 번호는 장면의 탭 기록과 겹치지 않는다) */
  const recordCommand = createMockRecorder();
  let nextId = 1;
  let nextPty = 1;
  /** 일괄 작업의 진행 이벤트 번호 */
  let nextOpId = 1;
  let startupTaken = false;
  const interval = opts.progressIntervalMs ?? 40;
  const timelineDelay = opts.timelineDelayMs ?? storedNumber(TIMELINE_DELAY_KEY);
  /** 지금 호스팅 조절값 (주지 않았으면 부를 때마다 저장한 값을 본다) */
  const hostingMode = (): MockHostingMode =>
    opts.hosting ?? parseMockHosting(storedValue(HOSTING_KEY));

  /**
   * 포함 브랜치 응답: 호출을 세고, 지연을 둔 뒤, 시간 초과 흉내가 켜져 있으면 `timedOut` 을, 아니면
   * `compute` 의 결과를 준다 (없는 커밋이면 `compute` 가 던진 오류로 거부)
   */
  const containingReply = async (
    method: string,
    compute: () => ContainingRefs,
  ): Promise<ContainingRefs> => {
    countMockCall(method);
    const delay = opts.containingDelayMs ?? storedNumber(CONTAINING_DELAY_KEY);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const timedOut = opts.containingTimeout ?? storedValue(CONTAINING_TIMEOUT_KEY) === '1';
    return timedOut ? { timedOut: true, head: false, branches: [] } : compute();
  };
  const step = opts.progressStep ?? Math.max(500, Math.floor(opts.rows / 20));

  /** 세션을 찾는다. 없으면 sessionNotFound */
  const entryOf = (session: SessionId): MockSession => {
    const entry = sessions.get(session);
    if (!entry) {
      throw new IpcClientError({ kind: 'sessionNotFound', session });
    }
    return entry;
  };

  /** 세션의 저장소 상태: 장면 데이터가 있으면 그것, 없으면 변경 없는 `main` */
  const stateOf = (entry: MockSession): RepoState =>
    entry.data?.repoState ??
    emptyRepoState({
      state: 'attached',
      branch: 'main',
      oid: entry.source.graph.rows[0]?.oid ?? '',
    });

  /** `open_repo`·`folder_open_repo_session` 응답을 만든다 */
  const openedOf = (
    session: SessionId,
    entry: MockSession,
    alreadyOpen: boolean,
    promoted = false,
  ): RepoOpened => {
    const state = stateOf(entry);
    // 상위 저장소는 조절값이 켜졌을 때만 싣는다 (W25 — 기본은 서브모듈이 아닌 저장소)
    const superproject =
      (opts.superproject ?? storedValue(SUPERPROJECT_KEY) === '1')
        ? (entry.data?.superproject ?? null)
        : null;
    return {
      session,
      alreadyOpen,
      nestedRepos: entry.data?.nestedRepos ?? [],
      superproject,
      info: {
        workTree: entry.path,
        gitDir: `${entry.path}/.git`,
        commonDir: `${entry.path}/.git`,
        objectFormat: 'sha1',
        head: state.refs.head,
        commitGraph: { present: true },
        shallow: false,
      },
      state,
      profile: entry.profile,
      promoted,
    };
  };

  /**
   * light 세션이면 코어처럼 graphUnavailable 로 거부한다 (그 밖의 세션 검사는 하지 않는다). 거부한 수를
   * `__mgitMockCalls.graphUnavailable` 로 센다 (가벼운 세션이 그래프 API 를 부르지 않는지 브라우저에서 확인)
   */
  const rejectLight = (session: SessionId) => {
    if (sessions.get(session)?.profile === 'light') {
      countMockCall('graphUnavailable');
      throw new IpcClientError({ kind: 'graphUnavailable', session });
    }
  };

  /** 그래프 메서드용 세션 조회. 없으면 sessionNotFound, light 세션이면 graphUnavailable */
  const graphEntryOf = (session: SessionId): MockSession => {
    const entry = entryOf(session);
    rejectLight(session);
    return entry;
  };

  /** 폴더가 잡은 light 세션들 (id 순). `except` 는 세지 않는다 */
  const lightHolds = (folder: SessionId, except?: SessionId): SessionId[] =>
    [...sessions]
      .filter(([id, e]) => id !== except && e.profile === 'light' && e.holders.includes(folder))
      .map(([id]) => id)
      .sort((a, b) => a - b);

  /** 한 개 더 잡아도 되는지. 상한이면 코어처럼 lightSessionLimit (지금 잡은 세션 목록과 함께) */
  const checkLightLimit = (folder: SessionId, except?: SessionId) => {
    const held = lightHolds(folder, except);
    if (held.length >= LIGHT_SESSIONS_PER_FOLDER) {
      throw new IpcClientError({
        kind: 'lightSessionLimit',
        limit: LIGHT_SESSIONS_PER_FOLDER,
        sessions: held,
      });
    }
  };

  /** 세션을 지운다 (진행 중인 그래프 로드 타이머도 멈춘다) */
  const dropSession = (session: SessionId) => {
    const timer = sessions.get(session)?.timer;
    if (timer) {
      clearTimeout(timer);
    }
    sessions.delete(session);
  };

  /** 폴더의 잡음을 푼다. 마지막 잡음이 풀린 light 세션은 닫는다 (코어 `release_hold` 흉내) */
  const releaseHold = (folder: SessionId, session: SessionId): RepoSessionRelease => {
    const entry = sessions.get(session);
    if (!entry) {
      return { released: false, profile: null };
    }
    if (entry.profile === 'full') {
      return { released: false, profile: 'full' };
    }
    const before = entry.holders.length;
    entry.holders = entry.holders.filter((h) => h !== folder);
    const released = entry.holders.length !== before;
    if (entry.holders.length > 0) {
      return { released, profile: 'light' };
    }
    dropSession(session);
    return { released, profile: null };
  };

  /**
   * 그래프 로드를 흉내 낸다: 첫 묶음 → (간격마다 진행) → 완료 이벤트. 새 탭과 승격이 함께 쓴다.
   * 이벤트는 그때그때 `entry.emit` 으로 보낸다 (승격하면 새 채널)
   */
  const startGraphLoad = (session: SessionId, entry: MockSession) => {
    const { source } = entry;
    const total = source.shown.rows.length;
    const emit = (event: SessionEvent) => entry.emit(event);
    const first = Math.min(500, total);
    source.setLoadedRows(first);
    emit({ type: 'graphLoadStarted', session, generation: 1 });
    emit({ type: 'graphFirstChunk', session, generation: 1, rows: first });

    const startedAt = Date.now();
    const finish = () => {
      source.setLoadedRows(total);
      emit({
        type: 'graphLoadFinished',
        session,
        generation: 1,
        rows: total,
        laneCount: source.shown.laneCount,
        elapsedMs: Date.now() - startedAt,
        commitGraphSuggested: total >= 20_000,
      });
    };
    if (interval <= 0 || first >= total) {
      finish();
      return;
    }
    let loaded = first;
    const tick = () => {
      if (!sessions.has(session)) {
        return;
      }
      loaded = Math.min(total, loaded + step);
      source.setLoadedRows(loaded);
      if (loaded >= total) {
        finish();
        entry.timer = null;
      } else {
        emit({ type: 'graphProgress', session, generation: 1, rows: loaded });
        entry.timer = setTimeout(tick, interval);
      }
    };
    entry.timer = setTimeout(tick, interval);
  };

  /** 장면 세션의 데이터. 장면 없이 연 세션이면 sessionNotFound */
  const dataOf = (session: SessionId): MockRepoData => {
    const data = entryOf(session).data;
    if (!data) {
      throw new IpcClientError({ kind: 'sessionNotFound', session });
    }
    return data;
  };

  /** 폴더 세션을 찾는다. 없으면 sessionNotFound */
  const folderOf = (session: SessionId): MockFolderSession => {
    const folder = folders.get(session);
    if (!folder) {
      throw new IpcClientError({ kind: 'sessionNotFound', session });
    }
    return folder;
  };

  /**
   * 파일 API 의 루트 (코어 `fs_root` 흉내): 세션 id 로만 정한다 — 폴더 세션은 폴더 경로, 저장소 세션은 연
   * 경로(작업 트리). 둘 다 아니면 sessionNotFound
   */
  const fsRootOf = (session: SessionId): string => {
    const root = folders.get(session)?.data.path ?? sessions.get(session)?.path;
    if (root === undefined) {
      throw new IpcClientError({ kind: 'sessionNotFound', session });
    }
    return root;
  };

  const editedFiles = new Map<string, { before: string; after: string }>();
  /** 저장한 목 원문은 작업 트리 diff에 반영하고 staged diff 재료는 그대로 둔다. */
  const editedDiff = (session: SessionId, path: string): FileDiff | undefined => {
    const edit = editedFiles.get(`${fsRootOf(session)}/${path}`);
    if (!edit) return undefined;
    const linesOf = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
    const old = linesOf(edit.before);
    const next = linesOf(edit.after);
    return {
      oldPath: path,
      newPath: path,
      change: { kind: 'modified' },
      binary: null,
      truncated: false,
      totalLines: old.length + next.length,
      nonUtf8: false,
      hunks: [
        {
          oldStart: old.length ? 1 : 0,
          oldLines: old.length,
          newStart: next.length ? 1 : 0,
          newLines: next.length,
          section: '',
          lines: [
            ...old.map((text, i) => ({
              kind: 'del' as const,
              oldNo: i + 1,
              newNo: null,
              text,
              noNewline: i === old.length - 1 && !edit.before.endsWith('\n'),
            })),
            ...next.map((text, i) => ({
              kind: 'add' as const,
              oldNo: null,
              newNo: i + 1,
              text,
              noNewline: i === next.length - 1 && !edit.after.endsWith('\n'),
            })),
          ],
        },
      ],
    };
  };

  /** 파일 내용 (blame 재료). 장면이 없거나 텍스트가 아니면 null */
  const textOf = (session: SessionId, path: string): string | null => {
    if (!scene) {
      return null;
    }
    const file = scene.fs.read(fsRootOf(session), path);
    return file.kind === 'text' ? file.text : null;
  };

  /** 폴더의 타임라인을 현재 질의·저장소 범위로 다시 만들고 세대를 올린다 */
  const rebuildTimeline = (folder: MockFolderSession): MockTimeline => {
    folder.generation += 1;
    folder.timeline = buildMockTimeline(
      folder.data,
      opts.rows,
      folder.query,
      folder.generation,
      opts.seed,
      folder.scope,
    );
    return folder.timeline;
  };

  /** 폴더의 현재 타임라인 (없으면 만든다) */
  const timelineOf = (folder: MockFolderSession): MockTimeline =>
    folder.timeline ?? rebuildTimeline(folder);

  /** 질의로 거르지 않은 전체 타임라인 (검색·커밋 상세는 지금 질의와 무관하게 전체 이력에서 찾는다) */
  const allHistoryOf = (folder: MockFolderSession): MockTimeline => {
    folder.allHistory ??= buildMockTimeline(folder.data, opts.rows, TIMELINE_QUERY, 0, opts.seed);
    return folder.allHistory;
  };

  /** 폴더 하위 저장소는 통합 로그와 같은 이력을 쓴다. 탭 열기·가벼운 세션 승격 모두 같은 해시를 찾게 한다. */
  const createRepoSource = (
    path: string,
  ): { source: MockGraphSource; data: MockRepoData | null } => {
    const folderData = scene?.folder;
    const index = folderData?.folderTimeline.findIndex((repo) => repo.path === path) ?? -1;
    if (!folderData || index < 0) {
      const source = new MockGraphSource({ rows: opts.rows, seed: opts.seed });
      return { source, data: scene ? scene.repo(path, source.graph) : null };
    }
    const folder = [...folders.values()].find((entry) => entry.data === folderData);
    const history = folder
      ? allHistoryOf(folder)
      : buildMockTimeline(folderData, opts.rows, TIMELINE_QUERY, 0, opts.seed);
    const rows = history.graph.rows
      .filter((row) => row.repo === index)
      .map((row, at) => ({ ...row, row: at, lane: 0, repo: null }));
    const source = new MockGraphSource({ rows: 0, seed: opts.seed });
    Object.assign(source.graph, {
      rows: rows.map((row) => ({ ...row })),
      segments:
        rows.length > 0
          ? [{ lane: 0, start: 0, end: rows.length - 1, color: rows[0]?.color ?? 0 }]
          : [],
      edges: [],
      stubs: [],
      laneCount: rows.length > 0 ? 1 : 0,
    });
    const data = scene?.repo(path, source.graph) ?? null;
    // 저장소 장면의 일반 ref 배치 대신 통합 로그의 실제 branch·tag·HEAD를 복원한다.
    source.graph.rows = rows;
    source.setShown(null);
    if (data) {
      const headRow = rows.find((row) => row.isHead);
      const head = data.repoState.refs.head;
      if (headRow && head.state !== 'unborn') {
        data.repoState.refs.head = { ...head, oid: headRow.oid };
        data.repoState.status.branch.oid = headRow.oid;
      }
      data.repoState.refs.labels = rows.flatMap((row) => row.refs);
    }
    return { source, data };
  };

  /** 타임라인을 다시 만들고 코어처럼 폴더 세션 id 로 `graphReloaded` 를 보낸다 */
  const reloadTimeline = (session: SessionId) => {
    const folder = folderOf(session);
    const { graph, info } = rebuildTimeline(folder);
    folder.emit({
      type: 'graphReloaded',
      session,
      generation: info.generation,
      rows: graph.rows.length,
      laneCount: graph.laneCount,
    });
  };

  /**
   * 폴더 쓰기 뒤 그 저장소를 연 세션(탭·가벼운 세션)의 상태를 폴더 변경 표에 맞추고 `statusChanged` 를 보낸다
   * (코어에서는 그 세션의 감시가 index 변경을 보고 다시 읽는다). `committed` 면 ahead 도 오른다. `op` 를 주면 세션의
   * 진행 중 작업도 그 값으로 바꾼다 (W15: 계속·건너뛰기·중단으로 끝나면 null)
   */
  const syncRepoSessions = (
    data: MockFolderData,
    repo: string,
    committed: boolean,
    op?: InProgressOp | null,
  ) => {
    const entries = mockFolderEntries(data, repo);
    for (const [id, entry] of sessions) {
      if (entry.path !== repo || !entry.data) {
        continue;
      }
      const state = mockStatusWith(entry.data.repoState, entries, committed);
      entry.data.repoState = op === undefined ? state : { ...state, op };
      entry.emit({
        type: 'statusChanged',
        session: id,
        status: entry.data.repoState.status,
        op: entry.data.repoState.op ?? null,
      });
    }
  };

  /**
   * 세션의 충돌 흐름 쓰기 (W15)가 폴더 장면 저장소의 상태를 바꾼다: 변경 표·요약(충돌 수, 끝났으면 작업 종류)을 바꾸고,
   * 그 저장소를 연 세션들에 `statusChanged`(작업 포함), 그 저장소를 품은 폴더 세션들에 `folderChanged` 를 보낸다
   * (`refs` 는 커밋·HEAD 이동이 있을 때). `op` 가 undefined 면 작업은 그대로다
   */
  const applySessionWrite = (
    repo: string,
    entries: StatusEntry[],
    change: { committed?: boolean; op?: InProgressOp | null; refs?: boolean } = {},
  ) => {
    const data = scene?.folder;
    if (!data) {
      return;
    }
    setMockFolderEntries(data, repo, entries, change.committed ?? false);
    if (change.op !== undefined) {
      setMockFolderOp(data, repo, change.op?.kind ?? null);
    }
    syncRepoSessions(data, repo, change.committed ?? false, change.op);
    for (const [id, folder] of folders) {
      if (folder.data.openFolder.some((r) => r.path === repo)) {
        folder.emit({ type: 'folderChanged', session: id, refs: change.refs ?? false, repo });
      }
    }
  };

  /**
   * 목이 돌린 것으로 치는 쓰기 명령을 코어처럼 알린다 (W19 ② 폴더 콘솔): 그 작업 트리를 연 세션들에 `commandLogged`,
   * 그 저장소를 목록에 품은 폴더 세션들에 `folderCommandLogged`. 폴더 이벤트의 `repo` 는 목록의 대표 경로다 — 워크트리에서
   * 돈 명령이면 원 저장소(타임라인 번호가 같은 저장소), 실제 작업 디렉터리는 기록의 `cwd`
   */
  const logCommand = (cwd: string, command: MockCommand) => {
    const record = recordCommand(cwd, command);
    for (const [id, entry] of sessions) {
      if (entry.path === cwd) {
        entry.emit({ type: 'commandLogged', session: id, record });
      }
    }
    for (const [id, folder] of folders) {
      if (!folder.data.openFolder.some((r) => r.path === cwd)) {
        continue;
      }
      const index = folder.data.folderCommitDetail.repoIndex[cwd];
      const repo = index === undefined ? cwd : (folder.data.folderTimeline[index]?.path ?? cwd);
      folder.emit({ type: 'folderCommandLogged', session: id, repo, record });
    }
  };

  /**
   * 세션이 폴더 장면의 저장소면 그 저장소 경로와 지금 항목 (W15 충돌 흐름은 폴더 장면에서만 상태를 바꾼다). 아니면 null
   */
  const folderRepoOf = (session: SessionId) => {
    const path = entryOf(session).path;
    const data = scene?.folder;
    if (!data?.openFolder.some((r) => r.path === path)) {
      return null;
    }
    return { repo: path, entries: mockFolderEntries(data, path) };
  };

  /** 세션의 지금 진행 중 작업 (없으면 null) */
  const opOf = (session: SessionId) => sessions.get(session)?.data?.repoState.op ?? null;

  /**
   * 충돌 하나를 해결한다 (`resolveFile`·`resolveSide`·`resolveDelete` 공용): 충돌 항목이 아니면 코어처럼 거부하고, 원래
   * 항목을 되돌리기용으로 기억한 뒤 돌린 명령(`commands`)을 기록하고 상태를 바꾼다
   */
  const resolveIn = (
    session: SessionId,
    path: string,
    keep: boolean,
    commands: readonly MockCommand[],
  ) => {
    const target = folderRepoOf(session);
    if (!target) {
      return;
    }
    const next = resolveMockConflict(target.entries, path, keep);
    const original = target.entries.find((e) => e.path === path);
    if (next === null || !original) {
      throw new IpcClientError({
        kind: 'internal',
        message: pick(`충돌 파일이 아닙니다: ${path}`, `Not a conflicted file: ${path}`),
      });
    }
    const remembered = resolvedConflicts.get(target.repo) ?? new Map<string, StatusEntry>();
    remembered.set(path, original);
    resolvedConflicts.set(target.repo, remembered);
    for (const command of commands) {
      logCommand(target.repo, command);
    }
    applySessionWrite(target.repo, next);
  };

  /** 작업을 건너뛰거나 중단해 끝낸다: 그 명령을 기록하고, 이 작업의 변경이 사라지고 작업이 없어진다 */
  const abandonIn = (session: SessionId, action: 'skip' | 'abort') => {
    const target = folderRepoOf(session);
    if (!target) {
      return;
    }
    const op = opOf(session);
    if (op === null) {
      throw new IpcClientError({
        kind: 'internal',
        message: pick('진행 중인 작업이 없습니다', 'No operation in progress'),
      });
    }
    resolvedConflicts.delete(target.repo);
    markerPaths.delete(target.repo);
    logCommand(target.repo, mockOpCommand(op.kind, action));
    applySessionWrite(target.repo, abandonMockOp(target.entries), { op: null, refs: true });
  };

  /**
   * 폴더 stage·unstage (코어 `folder_stage`·`folder_unstage` 흉내). 검사 순서도 코어와 같다: 폴더 → 저장소 소속 →
   * 경로 → 빈 대상 → 상태 읽기(요약에 실패한 저장소는 그 사유로 실패). 썼으면 변경 표·요약·세션 상태를 바꾸고
   * 그 저장소의 `folderChanged`(`refs: false`)를 보낸다
   */
  const folderIndexWrite = (
    method: 'folderStage' | 'folderUnstage',
    session: SessionId,
    repo: string,
    target: IndexTarget,
  ): IndexWriteResult => {
    countMockCall(method);
    recordMockWrite({ method, repo, target });
    const folder = folderOf(session);
    if (!folder.data.openFolder.some((r) => r.path === repo)) {
      throw new IpcClientError({
        kind: 'internal',
        message: pick(
          `이 폴더의 저장소가 아닙니다: ${repo}`,
          `Not a repository in this folder: ${repo}`,
        ),
      });
    }
    for (const path of target.kind === 'paths' ? target.paths : []) {
      const refused = mockIndexPathError(path);
      if (refused) {
        throw new IpcClientError({ kind: 'internal', message: refused });
      }
    }
    if (target.kind === 'paths' && target.paths.length === 0) {
      return { ran: false, skipped: [] };
    }
    const failed = folder.data.folderSummaries.find((s) => s.path === repo)?.error;
    if (failed) {
      throw new IpcClientError({ kind: 'internal', message: failed });
    }
    const op = method === 'folderStage' ? 'stage' : 'unstage';
    const { entries, result } = applyMockIndexWrite(
      mockFolderEntries(folder.data, repo),
      op,
      target,
    );
    const command = mockIndexCommand(op, target, result);
    if (command) {
      logCommand(repo, command);
    }
    if (result.ran) {
      setMockFolderEntries(folder.data, repo, entries);
      syncRepoSessions(folder.data, repo, false);
      folder.emit({ type: 'folderChanged', session, refs: false, repo });
    }
    return result;
  };

  /**
   * tag 원격 작업(push·원격 삭제) 흉내의 공통 차례 (코어·셸과 같다): `operationStarted`(kind `push`) → 검사(원격 등록·tag
   * 이름) → 인증 실패 주입이면 명령 기록(코드 128)·`operationFinished`(실패) 뒤 `gitFailed`(hint `authFailed`) 거부 → 아니면
   * `run` 의 결과로 명령 기록(모두 성공이면 0, 아니면 1)·`operationFinished`(모두 성공이면 ok, 아니면 요약 문구)
   */
  const runTagOp = (
    session: SessionId,
    remote: string,
    names: readonly string[],
    label: string,
    args: string[],
    run: (fail: MockTagFail) => TagRefResult[],
    options: { lookupFirst?: boolean; kind?: 'push' | 'fetch' } = {},
  ): TagRefResult[] => {
    const lookupFirst = options.lookupFirst ?? false;
    const entry = entryOf(session);
    const data = dataOf(session);
    const opId = nextOpId++;
    entry.emit({ type: 'operationStarted', session, opId, kind: options.kind ?? 'push', label });
    const finish = (ok: boolean, message: string) =>
      entry.emit({
        type: 'operationFinished',
        session,
        opId,
        ok,
        cancelled: false,
        message,
        lockLeft: false,
      });
    const invalid =
      (data.repoState.refs.remotes.some((r) => r.name === remote)
        ? null
        : mockUnknownRemote(remote)) ??
      names.map(mockTagNameError).find((e) => e !== null) ??
      null;
    if (invalid !== null) {
      finish(false, invalid);
      throw new IpcClientError({ kind: 'internal', message: invalid });
    }
    const fail = readMockTagFail();
    // 인증 실패는 모든 원격 명령, 연결 실패(오프라인)는 실행 직전 조회가 있는 원격 삭제만 통째로 거부된다
    const lookupError = mockLookupError(fail, remote);
    if (lookupError && (lookupError.kind === 'auth' || lookupFirst)) {
      const stderr = lookupError.message;
      logCommand(entry.path, { args, status: 128, stderr, elapsedMs: 120 });
      finish(false, stderr);
      throw new IpcClientError({
        kind: 'gitFailed',
        args,
        status: 128,
        stderr,
        hint: lookupError.kind === 'auth' ? { kind: 'authFailed' } : null,
      });
    }
    let results: TagRefResult[];
    try {
      results = run(fail);
    } catch (e) {
      // 명령 전체 실패 흉내 (가져오기에서 원격에 없는 이름): 코어처럼 op 를 실패로 닫고 gitFailed
      if (!(e instanceof MockGitFailure)) {
        throw e;
      }
      logCommand(entry.path, { args, status: 128, stderr: e.message, elapsedMs: 120 });
      finish(false, e.message);
      throw new IpcClientError({
        kind: 'gitFailed',
        args,
        status: 128,
        stderr: e.message,
        hint: null,
      });
    }
    const message = mockTagOpMessage(results);
    logCommand(entry.path, { args, status: message === '' ? 0 : 1, stderr: '', elapsedMs: 300 });
    finish(message === '', message);
    return results;
  };

  /**
   * tag 쓰기가 바꾼 라벨을 세션에 넣는다: 상태의 라벨·그래프 행 라벨을 바꾸고 코어처럼 `refsChanged`·`graphReloaded` 를
   * 보낸다 (로컬 삭제·가져오기 공용)
   */
  const applyMockLabels = (session: SessionId, labels: RefLabel[]) => {
    const entry = entryOf(session);
    const data = dataOf(session);
    data.repoState = { ...data.repoState, refs: { ...data.repoState.refs, labels } };
    relabelGraph(entry.source.graph, labels);
    entry.source.generation += 1;
    entry.emit({ type: 'refsChanged', session, refs: data.repoState.refs });
    entry.emit({
      type: 'graphReloaded',
      session,
      generation: entry.source.generation,
      rows: entry.source.shown.rows.length,
      laneCount: entry.source.shown.laneCount,
    });
  };

  /** 장면이 채우는 메서드. 아래에서 널 스텁 위에 덮어쓴다 (장면이 없으면 비어 있다) */
  const sceneMethods: Partial<IpcClient> = scene
    ? {
        // 시작 인자처럼 한 번만 돌려준다
        async takeStartupPaths() {
          const paths = startupTaken ? [] : scene.startupPaths;
          startupTaken = true;
          return paths;
        },

        // 저장소 세션: 메시지 수정도 상세와 같은 전체 메시지를 읽는다.
        commitMessage: async (session, oid) =>
          mockCommitDetail(entryOf(session).source.graph, dataOf(session).commitDetail, oid)
            .message,
        commitDetail: async (session, oid) =>
          mockCommitDetail(entryOf(session).source.graph, dataOf(session).commitDetail, oid),
        commitFileDiff: async (session, _oid, path, oldPath) =>
          mockCommitFileDiff(dataOf(session).commitDetail, path, oldPath),
        commitContainingRefs: (session, oid) =>
          containingReply('commitContainingRefs', () =>
            mockContainingRefs(entryOf(session).source.graph, dataOf(session).repoState.refs, oid),
          ),
        workTreeDiff: async (session, path, staged) =>
          (!staged ? editedDiff(session, path) : undefined) ??
          mockWorkTreeDiff(dataOf(session), path, staged),
        listStashes: async (session) => dataOf(session).listStashes,
        stashFiles: async (session) => dataOf(session).stashFiles,
        // 충돌 레이더·백업 ref (W22 브랜치 트리의 배지·Backups). 목은 계산하지 않고 장면 값을 준다
        conflictRadar: async (session) => dataOf(session).conflictRadar,
        backups: async (session) => dataOf(session).backups,
        // tag 관리 (BR-06): 장면의 tag 표(`MockRepoData.tags`)를 실제로 바꾼다 — 원격 표는 그 세션이 닫힐 때까지 남는다.
        // 실패 주입은 `globalThis.__mgitMockTagFail` (`MockTagFail`), 호출 인자는 `__mgitMockBatches` 에 `{method, …}` 로 남는다
        async pushTags(session, remote, names) {
          countMockCall('pushTags');
          recordMockWrite({ method: 'pushTags', session, remote, names: [...names] });
          return runTagOp(
            session,
            remote,
            names,
            `push ${remote} ${mockTagNamesLabel(names)}`,
            [
              'push',
              '--porcelain',
              '--progress',
              '--no-follow-tags',
              '--end-of-options',
              remote,
              ...names.map((n) => `refs/tags/${n}:refs/tags/${n}`),
            ],
            (fail) => {
              const data = dataOf(session);
              return mockPushTags(data.tags, data.repoState.refs.labels, remote, names, fail);
            },
          );
        },
        async deleteRemoteTags(session, remote, items) {
          countMockCall('deleteRemoteTags');
          recordMockWrite({ method: 'deleteRemoteTags', session, remote, items: [...items] });
          const names = items.map((i) => i.name);
          return runTagOp(
            session,
            remote,
            names,
            `push ${remote} --delete ${mockTagNamesLabel(names)}`,
            [
              'push',
              '--porcelain',
              '--no-follow-tags',
              '--delete',
              '--end-of-options',
              remote,
              ...names.map((n) => `refs/tags/${n}`),
            ],
            (fail) => mockDeleteRemoteTags(dataOf(session).tags, remote, items, fail),
            { lookupFirst: true },
          );
        },
        /**
         * 가져오기 (C2): 원격 표의 tag 를 로컬 라벨·객체 표에 넣고(덮어쓰기면 바꾸고) 코어처럼 `refsChanged`·`graphReloaded`
         * 를 보낸다. kind `fetch` op. 원격에 없는 이름이 섞이면 전체가 멈춘다(`gitFailed`). 연결 실패 주입(`lookup`·`auth`)이면
         * 거부. 목에는 undo 가 없다
         */
        async fetchTags(session, remote, names, overwrite) {
          countMockCall('fetchTags');
          recordMockWrite({ method: 'fetchTags', session, remote, names: [...names], overwrite });
          const plus = overwrite ? '+' : '';
          return runTagOp(
            session,
            remote,
            names,
            mockFetchLabel(remote, names, overwrite),
            [
              'fetch',
              '--porcelain',
              '--verbose',
              '--progress',
              '--no-tags',
              '--no-prune',
              '--no-write-fetch-head',
              '--end-of-options',
              remote,
              ...names.map((n) => `${plus}refs/tags/${n}:refs/tags/${n}`),
            ],
            () => {
              const data = dataOf(session);
              const { results, labels } = mockFetchTags(
                data.tags,
                data.repoState.refs.labels,
                remote,
                names,
                overwrite,
              );
              if (labels) {
                applyMockLabels(session, labels);
              }
              return results;
            },
            { lookupFirst: true, kind: 'fetch' },
          );
        },
        /** 로컬 tag 목록 (C2): 라벨과 그래프 행으로 만든다 (`mockTagList`) */
        async tagList(session) {
          countMockCall('tagList');
          const data = dataOf(session);
          return mockTagList(
            data.tags,
            data.repoState.refs.labels,
            entryOf(session).source.graph.rows,
          );
        },
        /**
         * 원격 tag 상태 보고서 (B3): 확인(`refresh`)이면 kind `tagCheck` op 를 열고 닫는다 — 조회 실패 주입(`lookup`·`auth`)이면
         * 이전 값을 두고 `lastError` 를 남긴다(거부하지 않는다). 확인 전이면 `checkedAt: null` 인 빈 보고서
         */
        async remoteTags(session, remote, refresh) {
          countMockCall('remoteTags');
          const entry = entryOf(session);
          const data = dataOf(session);
          const { remotes, labels } = data.repoState.refs;
          const name = remote ?? mockDefaultTagRemote(labels, remotes);
          const info = remotes.find((r) => r.name === name);
          if (!info) {
            throw new IpcClientError({
              kind: 'internal',
              message:
                name === null
                  ? pick(
                      '원격이 없습니다. 먼저 원격을 추가하세요',
                      'No remotes. Add a remote first',
                    )
                  : mockUnknownRemote(name),
            });
          }
          const fail = readMockTagFail();
          if (refresh) {
            const opId = nextOpId++;
            entry.emit({
              type: 'operationStarted',
              session,
              opId,
              kind: 'tagCheck',
              label: `ls-remote --tags ${info.name}`,
            });
            const error = mockLookupError(fail, info.name);
            recordMockTagCheck(data.tags, info.name, error);
            logCommand(entry.path, {
              args: ['ls-remote', '--tags', '--end-of-options', info.name],
              status: error ? 128 : 0,
              stderr: error?.message ?? '',
              elapsedMs: 180,
            });
            entry.emit({
              type: 'operationFinished',
              session,
              opId,
              ok: error === null,
              cancelled: false,
              message: error?.message ?? '',
              lockLeft: false,
            });
          }
          return mockTagReport(data.tags, labels, info, fail);
        },
        /** 단일 조회 (B3): kind `tagCheck` op. 조회 실패 주입이면 `gitFailed` 로 거부한다 */
        async lookupRemoteTags(session, remote, names) {
          countMockCall('lookupRemoteTags');
          const entry = entryOf(session);
          const data = dataOf(session);
          const opId = nextOpId++;
          entry.emit({
            type: 'operationStarted',
            session,
            opId,
            kind: 'tagCheck',
            label: `ls-remote --tags ${remote} ${mockTagNamesLabel(names)}`,
          });
          const finish = (ok: boolean, message: string) =>
            entry.emit({
              type: 'operationFinished',
              session,
              opId,
              ok,
              cancelled: false,
              message,
              lockLeft: false,
            });
          const invalid = data.repoState.refs.remotes.some((r) => r.name === remote)
            ? (names.map(mockTagNameError).find((e) => e !== null) ?? null)
            : mockUnknownRemote(remote);
          if (invalid !== null) {
            finish(false, invalid);
            throw new IpcClientError({ kind: 'internal', message: invalid });
          }
          const error = mockLookupError(readMockTagFail(), remote);
          if (error) {
            finish(false, error.message);
            throw new IpcClientError({
              kind: 'gitFailed',
              args: ['ls-remote', '--tags', '--end-of-options', remote],
              status: 128,
              stderr: error.message,
              hint: error.kind === 'auth' ? { kind: 'authFailed' } : null,
            });
          }
          finish(true, '');
          return mockLookupRemoteTags(data.tags, remote, names);
        },
        /**
         * 로컬 것으로 덮어쓰기 (C2b, lease push 한 번): 지금 원격이 기대값이면 로컬 것으로 바꾼다. 아니면 `rejectedStale`.
         * kind `push` op
         */
        async replaceRemoteTags(session, remote, items) {
          countMockCall('replaceRemoteTags');
          recordMockWrite({ method: 'replaceRemoteTags', session, remote, items: [...items] });
          const names = items.map((i) => i.name);
          return runTagOp(
            session,
            remote,
            names,
            `push ${remote} --force-with-lease ${mockTagNamesLabel(names)}`,
            [
              'push',
              '--porcelain',
              '--progress',
              '--no-follow-tags',
              ...items.map((i) => `--force-with-lease=refs/tags/${i.name}:${i.expectedRemote}`),
              '--end-of-options',
              remote,
              ...names.map((n) => `refs/tags/${n}:refs/tags/${n}`),
            ],
            () => {
              const data = dataOf(session);
              return mockReplaceRemoteTags(data.tags, data.repoState.refs.labels, remote, items);
            },
          );
        },
        /**
         * 로컬 tag 일괄 삭제 (한 트랜잭션): 라벨·그래프 라벨에서 빼고 코어처럼 `refsChanged`·`graphReloaded` 를 보낸다. 없는
         * 이름이 섞이면 아무것도 지우지 않고 거부한다 (목에는 undo 가 없다)
         */
        async deleteLocalTags(session, names) {
          countMockCall('deleteLocalTags');
          recordMockWrite({ method: 'deleteLocalTags', session, names: [...names] });
          const entry = entryOf(session);
          const data = dataOf(session);
          let labels: RefLabel[];
          try {
            labels = mockDeleteLocalTags(data.tags, data.repoState.refs.labels, names);
          } catch (e) {
            throw new IpcClientError({
              kind: 'internal',
              message: e instanceof Error ? e.message : String(e),
            });
          }
          if (names.length === 0) {
            return;
          }
          logCommand(entry.path, {
            args: ['update-ref', '--stdin'],
            status: 0,
            stderr: '',
            elapsedMs: 15,
          });
          applyMockLabels(session, labels);
        },
        /**
         * branch 업데이트 (BR-09): 라벨의 ahead·behind 로 결과를 정하고, 옮겼으면 라벨을 업스트림 커밋으로 옮겨 ↓ 를 0 으로
         * 둔 뒤 코어처럼 `refsChanged`·`graphReloaded` 를 보낸다. 현재 branch 면 상태의 behind 도 0 이다. 진행 표시는
         * 흉내 내지 않는다 (fetch 단계의 op)
         */
        async updateBranch(session, name) {
          countMockCall('updateBranch');
          recordMockWrite({ method: 'updateBranch', session, name });
          const entry = entryOf(session);
          const data = dataOf(session);
          let outcome: ReturnType<typeof mockUpdateLocalBranch>;
          try {
            outcome = mockUpdateLocalBranch(data.repoState.refs.labels, name);
          } catch (e) {
            throw new IpcClientError({
              kind: 'internal',
              message: e instanceof Error ? e.message : String(e),
            });
          }
          for (const command of outcome.commands) {
            logCommand(entry.path, command);
          }
          const moved = outcome.result;
          if (outcome.labels && moved.kind === 'updated') {
            const status = data.repoState.status;
            const head = data.repoState.refs.head;
            if (head.state === 'attached' && head.branch === name) {
              data.repoState = {
                ...data.repoState,
                refs: { ...data.repoState.refs, head: { ...head, oid: moved.to } },
                status: { ...status, branch: { ...status.branch, oid: moved.to, behind: 0 } },
              };
            }
            applyMockLabels(session, outcome.labels);
          }
          return moved;
        },
        // 호스팅 (W24 Pull Requests 도구 창): 장면 값을 조절값(`hosting`)에 맞춰 준다. 만들기·체크아웃은 상태를 바꾸지
        // 않고 인자만 남긴다 (`__mgitMockBatches` 의 `{method, session, …}`)
        hostingRemoteProject: async (session) => mockRemoteProject(dataOf(session), hostingMode()),
        async pullRequests(session) {
          countMockCall('pullRequests');
          return mockPullRequests(dataOf(session), hostingMode());
        },
        prTemplates: async (session) => dataOf(session).prTemplates,
        async createPullRequest(session, spec) {
          countMockCall('createPullRequest');
          recordMockWrite({ method: 'createPullRequest', session, spec });
          const { hostingRemoteProject: project, pullRequests } = dataOf(session);
          const number = Math.max(0, ...pullRequests.map((p) => p.number ?? 0)) + 1;
          return {
            number,
            title: spec.title,
            draft: spec.draft,
            author: project.accountId?.split(':').pop() ?? '',
            authorAvatar: null,
            headRef: spec.head,
            headSha: '',
            baseRef: spec.base,
            headRepo: null,
            crossRepo: false,
            webUrl: `https://${project.host}/${project.project}/pull/${number}`,
            updatedAt: null,
            review: null,
            checks: null,
            mergeable: null,
            labels: [],
          };
        },
        async checkoutPullRequest(session, number, worktree) {
          countMockCall('checkoutPullRequest');
          recordMockWrite({ method: 'checkoutPullRequest', session, number, worktree });
          return `pr/${number}`;
        },
        // 웹 주소 열기 (PR 의 "브라우저에서 열기"·더블클릭 등): 목은 열지 않고 주소만 남긴다 (`{method: 'openUrl', url}`)
        async openUrl(url) {
          countMockCall('openUrl');
          recordMockWrite({ method: 'openUrl', url });
        },
        // 모듈 (W25 Project 트리): 범위·수동 보정은 세션에 남아 화면에서 범위를 좁히고 풀고, 숨기고, 직접 추가할 수 있다
        // (코어처럼 목록은 보정을 적용해 경로순). 그래프는 경로 범위로 걸러지지 않는다 (목은 커밋 필터만 적용한다)
        modules: async (session) =>
          mockModules(dataOf(session).modules, entryOf(session).moduleOverrides),
        moduleOverrides: async (session) => entryOf(session).moduleOverrides,
        async moduleOverridesSet(session, overrides) {
          countMockCall('moduleOverridesSet');
          recordMockWrite({ method: 'moduleOverridesSet', session, overrides });
          entryOf(session).moduleOverrides = overrides;
        },
        moduleScope: async (session) => entryOf(session).moduleScope,
        async moduleScopeSet(session, path) {
          countMockCall('moduleScopeSet');
          recordMockWrite({ method: 'moduleScopeSet', session, path });
          entryOf(session).moduleScope = path;
        },
        // 서브모듈 (W25): 목록은 장면 값이고, 쓰기는 상태를 바꾸지 않고 인자만 남긴다 (`{method, session, …}`)
        submodules: async (session) => dataOf(session).submodules,
        async submoduleUpdate(session, recursive) {
          countMockCall('submoduleUpdate');
          recordMockWrite({ method: 'submoduleUpdate', session, recursive });
        },
        async submoduleSync(session) {
          countMockCall('submoduleSync');
          recordMockWrite({ method: 'submoduleSync', session });
        },
        async submoduleAdd(session, url, path, branch) {
          countMockCall('submoduleAdd');
          recordMockWrite({ method: 'submoduleAdd', session, url, path, branch });
        },
        async submoduleRemove(session, path) {
          countMockCall('submoduleRemove');
          recordMockWrite({ method: 'submoduleRemove', session, path });
        },
        async submoduleSetBranch(session, path, branch) {
          countMockCall('submoduleSetBranch');
          recordMockWrite({ method: 'submoduleSetBranch', session, path, branch });
        },
        async submoduleUpdateRemote(session, path, mode) {
          countMockCall('submoduleUpdateRemote');
          recordMockWrite({ method: 'submoduleUpdateRemote', session, path, mode });
        },
        async submoduleBatch(session, op, paths) {
          countMockCall('submoduleBatch');
          recordMockWrite({ method: 'submoduleBatch', session, op, paths });
          return {
            label: mockBatchLabel(op),
            results: [],
            succeeded: dataOf(session).submodules.length,
            skipped: 0,
            failed: 0,
          };
        },
        conflicts: async (session) => dataOf(session).conflicts,
        async conflictFile(session, path) {
          const payload = dataOf(session).conflictFile[path];
          if (!payload) {
            throw new IpcClientError({ kind: 'internal', message: `no conflict at ${path}` });
          }
          return payload;
        },
        // 파일 히스토리·blame (W13): 세션 그래프의 커밋과 파일 트리의 내용으로 만든다 (그래프를 읽지 않는
        // light 세션에서도 된다 — 코어도 git 으로 따로 읽는다)
        async fileHistory(session, path, limit) {
          countMockCall('fileHistory');
          return mockFileHistory(entryOf(session).source.graph, path, limit);
        },
        async blame(session, path) {
          countMockCall('blame');
          return mockBlame(entryOf(session).source.graph, path, textOf(session, path));
        },
        // 외부 diff 도구: 목은 띄울 도구가 없다. 부른 수만 센다 (응답은 널 클라이언트 그대로)
        openDifftool(session, target) {
          countMockCall('openDifftool');
          return createNullClient().openDifftool(session, target);
        },
        // 세션의 hunk·줄 stage·unstage·되돌리기 (W14 작업 트리 diff 탭): 목은 상태를 바꾸지 않는다. 어느 세션·어느
        // 경로로 불렀는지만 남긴다 (`__mgitMockBatches` 의 `{method, session, path, …}`)
        stageLines(session, path, selection, unstage, options) {
          countMockCall('stageLines');
          recordMockWrite({ method: 'stageLines', session, path, selection, unstage });
          return createNullClient().stageLines(session, path, selection, unstage, options);
        },
        discardLines(session, path, selection, options) {
          countMockCall('discardLines');
          recordMockWrite({ method: 'discardLines', session, path, selection });
          return createNullClient().discardLines(session, path, selection, options);
        },
        // 파일 메뉴 Rollback (HEAD 기준 되돌리기): 세션 상태에서 고른 항목을 빼고, 디스크에서도 사라지는 파일
        // (untracked·추가)은 목 파일 트리에서 지운다. 폴더 장면 저장소면 폴더 변경 표·폴더 세션 이벤트도 맞춘다.
        // 백업 id 는 주지 않는다 (목에는 백업 영역이 없다). 호출은 `__mgitMockBatches` 의 `{method, session, paths}`
        async rollbackPaths(session, paths) {
          countMockCall('rollbackPaths');
          recordMockWrite({ method: 'rollbackPaths', session, paths: [...paths] });
          const entry = entryOf(session);
          const data = dataOf(session);
          const target = folderRepoOf(session);
          const { entries, removed, error } = mockRollback(
            target ? target.entries : data.repoState.status.entries,
            paths,
            data.repoState.op ?? null,
          );
          if (error !== null) {
            throw new IpcClientError({ kind: 'internal', message: error });
          }
          for (const path of removed) {
            scene.fs.remove(fsRootOf(session), path);
          }
          if (target) {
            applySessionWrite(target.repo, entries);
            return [];
          }
          data.repoState = mockStatusWith(data.repoState, entries);
          entry.emit({
            type: 'statusChanged',
            session,
            status: data.repoState.status,
            op: data.repoState.op ?? null,
          });
          return [];
        },

        // 세션의 충돌 흐름 (W15): 폴더 장면 저장소의 세션이면 상태를 바꾸고 이벤트를 낸다 (그 밖의 장면은 널 스텁
        // 그대로). 어느 세션·어느 경로로 불렀는지 `__mgitMockBatches` 의 `{method, session, …}` 로 남긴다
        async mergeToolName(session) {
          countMockCall('mergeToolName');
          // 폴더 장면의 세션은 머지 도구가 설정된 것처럼 답한다 (가벼운 세션에서 이 읽기가 도는지 보인다)
          return folderRepoOf(session) ? 'meld' : null;
        },
        async resolveFile(session, path, content, allowConflictMarkers) {
          countMockCall('resolveFile');
          recordMockWrite({ method: 'resolveFile', session, path, allowConflictMarkers });
          const target = folderRepoOf(session);
          if (!target) {
            return;
          }
          if (hasMockConflictMarkers(content)) {
            if (!allowConflictMarkers) {
              throw new IpcClientError({ kind: 'conflictMarkers', files: [path] });
            }
            const marked = markerPaths.get(target.repo) ?? new Set<string>();
            markerPaths.set(target.repo, marked.add(path));
          }
          resolveIn(session, path, true, mockResolveCommands(path, { kind: 'file' }));
        },
        async resolveSide(session, path, side) {
          countMockCall('resolveSide');
          recordMockWrite({ method: 'resolveSide', session, path, side });
          resolveIn(session, path, true, mockResolveCommands(path, { kind: 'side', side }));
        },
        async resolveDelete(session, path, keep) {
          countMockCall('resolveDelete');
          recordMockWrite({ method: 'resolveDelete', session, path, keep });
          resolveIn(session, path, keep, mockResolveCommands(path, { kind: 'delete', keep }));
        },
        async unresolve(session, path, mode) {
          countMockCall('unresolve');
          recordMockWrite({ method: 'unresolve', session, path, mode });
          const target = folderRepoOf(session);
          const original = target ? resolvedConflicts.get(target.repo)?.get(path) : undefined;
          if (!target) {
            return;
          }
          if (!original) {
            throw new IpcClientError({
              kind: 'internal',
              message: pick(`되돌릴 충돌이 없습니다: ${path}`, `No conflict to undo: ${path}`),
            });
          }
          resolvedConflicts.get(target.repo)?.delete(path);
          markerPaths.get(target.repo)?.delete(path);
          logCommand(target.repo, mockUnresolveCommand(path, mode));
          applySessionWrite(target.repo, unresolveMockConflict(target.entries, original));
        },
        async opContinue(session, allowConflictMarkers): Promise<OpOutcome> {
          countMockCall('opContinue');
          recordMockWrite({ method: 'opContinue', session, allowConflictMarkers });
          const target = folderRepoOf(session);
          if (!target) {
            return 'clean';
          }
          const op = opOf(session);
          if (op === null) {
            throw new IpcClientError({
              kind: 'internal',
              message: pick('진행 중인 작업이 없습니다', 'No operation in progress'),
            });
          }
          // 코어 `op_continue` 의 검사 순서: 남은 충돌 → stage 된 충돌 마커 (둘 다 git 을 돌리기 전이라 기록이 없다)
          if (target.entries.some((e) => e.conflict !== null && e.conflict !== undefined)) {
            throw new IpcClientError({
              kind: 'internal',
              message: pick(
                '해결하지 않은 충돌 파일이 남아 있습니다',
                'Unresolved conflict files remain',
              ),
            });
          }
          const marked = [...(markerPaths.get(target.repo) ?? [])];
          if (marked.length > 0 && !allowConflictMarkers) {
            throw new IpcClientError({ kind: 'conflictMarkers', files: marked });
          }
          // 남은 단계 없이 끝난다 (흉내 내지 않는 것: rebase 의 다음 단계)
          resolvedConflicts.delete(target.repo);
          markerPaths.delete(target.repo);
          logCommand(target.repo, mockOpCommand(op.kind, 'continue'));
          applySessionWrite(target.repo, commitMockStaged(target.entries), {
            committed: true,
            op: null,
            refs: true,
          });
          return 'clean';
        },
        async opSkip(session): Promise<OpOutcome> {
          countMockCall('opSkip');
          recordMockWrite({ method: 'opSkip', session });
          const kind = opOf(session)?.kind;
          if (
            folderRepoOf(session) &&
            kind !== 'rebase' &&
            kind !== 'cherryPick' &&
            kind !== 'revert'
          ) {
            throw new IpcClientError({
              kind: 'internal',
              message: pick('건너뛸 수 없는 작업입니다', 'This operation cannot be skipped'),
            });
          }
          abandonIn(session, 'skip');
          return 'clean';
        },
        async opAbort(session) {
          countMockCall('opAbort');
          recordMockWrite({ method: 'opAbort', session });
          abandonIn(session, 'abort');
        },

        // 폴더 세션. 같은 폴더를 다시 열면 코어처럼 기존 세션을 돌려준다
        async openFolder(path, onEvent) {
          const data = scene.folder;
          if (!data || path !== data.path) {
            throw new IpcClientError({
              kind: 'internal',
              message: pick(`폴더가 아닙니다: ${path}`, `Not a folder: ${path}`),
            });
          }
          for (const [session, folder] of folders) {
            if (folder.data.path === path) {
              return { session, path, repos: data.openFolder };
            }
          }
          const session = nextId++;
          folders.set(session, {
            data,
            emit: onEvent,
            query: TIMELINE_QUERY,
            scope: [],
            generation: 0,
            timeline: null,
            allHistory: null,
            timelineTimer: null,
          });
          return { session, path, repos: data.openFolder };
        },
        async closeFolder(session) {
          const timer = folders.get(session)?.timelineTimer;
          if (timer) {
            clearTimeout(timer);
          }
          folders.delete(session);
          // 코어 안전망 흉내: 이 폴더만 잡고 있던 light 세션을 함께 닫는다 (승격된 세션은 남는다)
          for (const id of [...sessions.keys()]) {
            releaseHold(session, id);
          }
        },
        // 가벼운 세션 (W13): 폴더의 저장소 경로로 연다. 그래프 이벤트는 내지 않는다
        async folderOpenRepoSession(session, repo, onEvent) {
          countMockCall('folderOpenRepoSession');
          const folder = folderOf(session);
          if (!folder.data.openFolder.some((r) => r.path === repo)) {
            throw new IpcClientError({
              kind: 'internal',
              message: pick(
                `이 폴더의 저장소가 아닙니다: ${repo}`,
                `Not a repository in this folder: ${repo}`,
              ),
            });
          }
          for (const [open, entry] of sessions) {
            if (entry.path !== repo) {
              continue;
            }
            // 탭의 세션은 잡지 않고 빌려 준다. light 면 이 폴더도 잡는다 (상한 검사)
            if (entry.profile === 'light' && !entry.holders.includes(session)) {
              checkLightLimit(session, open);
              entry.holders.push(session);
            }
            return openedOf(open, entry, true);
          }
          checkLightLimit(session);
          // 요약에 실패한 저장소는 코어처럼 상태 읽기에서 실패한다 (같은 사유)
          const failed = folder.data.folderSummaries.find((s) => s.path === repo)?.error;
          if (failed) {
            throw new IpcClientError({ kind: 'internal', message: failed });
          }
          const id = nextId++;
          const { source, data } = createRepoSource(repo);
          if (!data) throw new Error('Missing mock repository data');
          const entry: MockSession = {
            path: repo,
            source,
            query: GRAPH_QUERY,
            timer: null,
            data,
            profile: 'light',
            holders: [session],
            emit: onEvent,
            moduleScope: null,
            moduleOverrides: data.moduleOverrides,
          };
          sessions.set(id, entry);
          return openedOf(id, entry, false);
        },
        async folderReleaseRepoSession(session, repoSession) {
          countMockCall('folderReleaseRepoSession');
          return releaseHold(session, repoSession);
        },
        folderSummaries: async (session, repos) =>
          onlyRepos(folderOf(session).data.folderSummaries, repos),
        folderRescan: async (session) => folderOf(session).data.openFolder,
        folderChanges: async (session, repos) =>
          onlyRepos(folderOf(session).data.folderChanges, repos),
        // 브랜치 목록은 타임라인을 만들지 않고 답한다
        async inspectFolderRemoteBranchDeletion(session, remote, name) {
          const folder = folderOf(session);
          return mockFolderDeleteTargets(folder.data.folderBranches, remote, name, []);
        },
        async inspectRemoteBranchDeletion(session, remote, name) {
          const entry = entryOf(session);
          return mockBranchDeleteTarget(entry.path, remote, name, stateOf(entry).refs.labels);
        },
        async deleteRemoteBranchWithLocals(session, target, deleteLocal) {
          const entry = entryOf(session);
          const result = mockDeleteBranches(target, deleteLocal, false);
          const state = stateOf(entry);
          const removed = new Set(
            result.locals
              .filter((local) => local.status === 'deleted')
              .map((local) => `refs/heads/${local.name}`),
          );
          if (result.remote.status === 'deleted')
            removed.add(`refs/remotes/${target.remote}/${target.name}`);
          state.refs.labels = state.refs.labels.filter((label) => !removed.has(label.fullName));
          entry.emit({ type: 'refsChanged', session, refs: state.refs });
          return result;
        },
        async forceDeleteLocalBranches(session, target) {
          const entry = entryOf(session);
          const result = mockDeleteBranches(target, true, true);
          const state = stateOf(entry);
          const removed = new Set(
            result.locals
              .filter((local) => local.status === 'deleted')
              .map((local) => `refs/heads/${local.name}`),
          );
          state.refs.labels = state.refs.labels.filter((label) => !removed.has(label.fullName));
          entry.emit({ type: 'refsChanged', session, refs: state.refs });
          return result;
        },
        async folderBranches(session, repos) {
          const all = folderOf(session).data.folderBranches;
          const kept = onlyRepos(all.repos, repos);
          const paths = new Set(kept.map((repo) => repo.path));
          return {
            repos: kept,
            branches: all.branches.flatMap((branch) => {
              const own = branch.repos.filter((repo) => paths.has(repo.path));
              return own.length > 0 ? [{ ...branch, repos: own }] : [];
            }),
          };
        },
        // 커밋 상세·diff: 저장소 세션 없이 폴더 세션 + 저장소 경로로 답한다 (CD-05)
        async folderCommitDetail(session, repo, oid) {
          const folder = folderOf(session);
          // 타임라인을 아직 만들지 않았으면 만들지 않는다 (코어처럼 그래프 필드만 빈다)
          return mockFolderCommitDetail(
            allHistoryOf(folder),
            folder.timeline,
            folder.data.folderCommitDetail,
            repo,
            oid,
          );
        },
        folderCommitFileDiff: async (session, repo, _oid, path, oldPath) =>
          mockFolderCommitFileDiff(folderOf(session).data.folderCommitDetail, repo, path, oldPath),
        // 포함 브랜치: 지금 질의와 무관하게 전체 이력에서 그 저장소의 커밋을 찾는다 (CD-03)
        folderCommitContainingRefs: (session, repo, oid) =>
          containingReply('folderCommitContainingRefs', () => {
            const folder = folderOf(session);
            return mockFolderContainingRefs(allHistoryOf(folder), folder.data, repo, oid);
          }),
        async folderTimelineOpen(session) {
          const folder = folderOf(session);
          if (folder.timeline || timelineDelay <= 0) {
            return timelineOf(folder).info;
          }
          // 코어처럼: 끝나지 않은 빈 정보를 먼저 주고, 로드가 끝나면 이벤트로 알린다
          if (!folder.timelineTimer) {
            folder.emit({ type: 'graphLoadStarted', session, generation: 1 });
            folder.timelineTimer = setTimeout(() => {
              folder.timelineTimer = null;
              if (!folders.has(session)) {
                return;
              }
              // 그사이 질의가 바뀌어 이미 만들어졌으면 그 타임라인으로 끝났다고 알린다
              const { graph, info } = timelineOf(folder);
              folder.emit({
                type: 'graphLoadFinished',
                session,
                generation: info.generation,
                rows: graph.rows.length,
                laneCount: graph.laneCount,
                elapsedMs: timelineDelay,
                commitGraphSuggested: false,
              });
            }, timelineDelay);
          }
          return {
            generation: 0,
            rows: 0,
            finished: false,
            maxPerRepo: 0,
            repos: [],
            scoped: false,
          };
        },
        folderTimelineInfo: async (session) => timelineOf(folderOf(session)).info,
        async folderTimelineWindow(session, start, count) {
          const { graph, info } = timelineOf(folderOf(session));
          return windowOfGraph(graph, graph.rows.length, info.generation, start, count);
        },
        async folderTimelineFindRow(session, repo, oid) {
          const rows = timelineOf(folderOf(session)).graph.rows;
          const idx = rows.findIndex((r) => r.repo === repo && r.oid === oid);
          return idx >= 0 ? idx : null;
        },
        // 잘못된 필터면 코어처럼 질의를 바꾸지 않고 invalidFilter
        async folderTimelineQuerySet(session, query) {
          const folder = folderOf(session);
          compileMockFilter(query.filter);
          folder.query = query;
          reloadTimeline(session);
        },
        /**
         * 저장소 범위 (코어 `folder_timeline_scope_set` 흉내): 빈 목록 = 전부, 워크트리 경로는 원 저장소로,
         * 이 폴더의 저장소가 아닌 경로는 범위를 바꾸지 않고 internal 오류. 범위 밖 저장소는 번호·색을 둔 채 행만 빠진다
         */
        async folderTimelineScopeSet(session, repos) {
          const folder = folderOf(session);
          const index = folder.data.folderCommitDetail.repoIndex;
          const scope: string[] = [];
          for (const path of repos) {
            const at = index[path];
            const primary = at === undefined ? undefined : folder.data.folderTimeline[at]?.path;
            if (primary === undefined) {
              throw new IpcClientError({
                kind: 'internal',
                message: pick(
                  `이 폴더의 저장소가 아닙니다: ${path}`,
                  `Not a repository in this folder: ${path}`,
                ),
              });
            }
            if (!scope.includes(primary)) {
              scope.push(primary);
            }
          }
          folder.scope = scope;
          reloadTimeline(session);
        },
        // 작성자 후보: 범위에 든 저장소들의 필터 없는 이력에서
        async folderTimelineAuthors(session) {
          const folder = folderOf(session);
          const all = allHistoryOf(folder);
          const inScope = new Set(
            all.info.repos
              .filter((r) => folder.scope.length === 0 || folder.scope.includes(r.path))
              .map((r) => r.index),
          );
          return mockAuthors(all.graph.rows.filter((r) => inScope.has(r.repo ?? -1)));
        },
        async folderTimelineReload(session) {
          reloadTimeline(session);
        },

        ...createMockFileOperations(scene.fs, fsRootOf, (items) => {
          for (const [id, entry] of sessions) {
            if (!entry.data) continue;
            let entries = [...entry.data.repoState.status.entries];
            for (const item of items) {
              if (item.status !== 'committed' || item.directory) continue;
              for (const absolute of [item.source, item.destination]) {
                if (!absolute?.startsWith(`${entry.path}/`)) continue;
                const relative = absolute.slice(entry.path.length + 1);
                const exists = scene.fs.kind(entry.path, relative) !== null;
                const found = entries.find((e) => e.path === relative);
                entries = entries.filter((e) => e.path !== relative);
                if (exists)
                  entries.push({
                    path: relative,
                    index: found?.index ?? 'unmodified',
                    worktree: found ? 'modified' : 'untracked',
                  });
                else if (found?.worktree !== 'untracked')
                  entries.push({
                    path: relative,
                    index: found?.index ?? 'unmodified',
                    worktree: 'deleted',
                  });
              }
            }
            entry.data.repoState = mockStatusWith(entry.data.repoState, entries);
            entry.emit({
              type: 'statusChanged',
              session: id,
              status: entry.data.repoState.status,
              op: entry.data.repoState.op ?? null,
            });
          }
          for (const [id, folder] of folders)
            folder.emit({ type: 'folderChanged', session: id, refs: false, repo: null });
        }),
        // 파일 트리·파일 보기 (W10): 폴더·저장소 세션 모두. 거부는 코어처럼 internal 오류
        async workspaceSearch(session, _request, query) {
          const root = fsRootOf(session);
          const result = mockWorkspaceSearch(scene.fs, root, query);
          for (const hit of result.hits) {
            const absolute = `${root}/${hit.path}`;
            const repo = scene.folder?.openFolder
              .filter((r) => absolute.startsWith(`${r.path}/`))
              .sort((a, b) => b.path.length - a.path.length)[0];
            hit.repo = repo
              ? repo.path === root
                ? ''
                : repo.path.slice(root.length + 1)
              : sessions.has(session)
                ? ''
                : null;
          }
          return result;
        },
        async fsListDir(session, dir, limit) {
          countMockCall('fsListDir');
          const g = globalThis as { __mgitMockFsDirs?: string[] };
          g.__mgitMockFsDirs ??= [];
          g.__mgitMockFsDirs.push(dir);
          return scene.fs.list(fsRootOf(session), dir, limit);
        },
        async fsReadFile(session, path) {
          countMockCall('fsReadFile');
          return scene.fs.read(fsRootOf(session), path);
        },
        async fsReadImage(session, path) {
          countMockCall('fsReadImage');
          return scene.fs.readImage(fsRootOf(session), path);
        },
        async fsReadEditableFile(session, path) {
          countMockCall('fsReadEditableFile');
          return scene.fs.readEditable(fsRootOf(session), path);
        },
        async fsSaveFile(session, path, expectedRevision, text) {
          countMockCall('fsSaveFile');
          const root = fsRootOf(session);
          const before = scene.fs.read(root, path);
          const result = scene.fs.save(root, path, expectedRevision, text);
          if (result.kind !== 'saved' || before.kind !== 'text') return result;
          const absolute = `${root}/${path}`;
          editedFiles.set(absolute, {
            before: editedFiles.get(absolute)?.before ?? before.text,
            after: text,
          });
          /** 저장된 경로의 작업 트리 상태만 바꾸고 index 값은 보존한다. */
          const changed = (entries: StatusEntry[], relative: string): StatusEntry[] => {
            const found = entries.find((entry) => entry.path === relative);
            if (!found)
              return [...entries, { path: relative, index: 'unmodified', worktree: 'modified' }];
            return entries.map((entry) =>
              entry !== found
                ? entry
                : { ...entry, worktree: entry.worktree === 'untracked' ? 'untracked' : 'modified' },
            );
          };
          for (const [id, entry] of sessions) {
            if (!entry.data || !absolute.startsWith(`${entry.path}/`)) continue;
            const relative = absolute.slice(entry.path.length + 1);
            entry.data.repoState = mockStatusWith(
              entry.data.repoState,
              changed(entry.data.repoState.status.entries, relative),
            );
            entry.emit({
              type: 'statusChanged',
              session: id,
              status: entry.data.repoState.status,
              op: entry.data.repoState.op ?? null,
            });
          }
          for (const [id, folder] of folders) {
            for (const repo of folder.data.openFolder) {
              if (!absolute.startsWith(`${repo.path}/`)) continue;
              const relative = absolute.slice(repo.path.length + 1);
              setMockFolderEntries(
                folder.data,
                repo.path,
                changed(mockFolderEntries(folder.data, repo.path), relative),
                false,
              );
              folder.emit({ type: 'folderChanged', session: id, refs: false, repo: repo.path });
            }
          }
          return result;
        },

        /**
         * 폴더 일괄 작업 (W19 ②): 저장소 상태는 바꾸지 않고, 코어의 건너뜀 규칙대로 결과를 만들어 코어와 같은 차례로
         * 이벤트를 낸다 — 진행 시작 → 저장소마다 (돌린 명령의 기록 → 진행) → 끝 → 저장소마다 `folderChanged`(refs).
         * 실패 사례: push 는 갈라진 `web-console` 이 거부되고, 요약에 실패한 `infra-scripts` 는 명령 없이 실패한다.
         * 호출 인자는 `__mgitMockBatches` 에 `{op, repos}` 로 남는다
         */
        async folderBatch(session, op, repos) {
          countMockCall('folderBatch');
          recordMockWrite({ op, repos: [...repos] });
          const folder = folderOf(session);
          const { result, commands } = mockFolderBatch(folder.data, op, repos);
          // pull·branch 업데이트가 옮긴 branch 는 ↓ 를 0 으로 (BR-09) — 아래 folderChanged 로 다시 읽으면 보인다
          applyMockBatchMoves(folder.data, result.results);
          // 이름을 바꾼 branch 는 브랜치 목록·요약에서 새 이름으로 — 아래 folderChanged 로 다시 읽으면 보인다
          applyMockBatchRenames(folder.data, op, result.results);
          const opId = nextOpId++;
          const total = result.results.length;
          folder.emit({
            type: 'operationStarted',
            session,
            opId,
            kind: 'batch',
            label: result.label,
          });
          result.results.forEach((r, i) => {
            for (const c of commands) {
              if (c.cwd === r.path) {
                logCommand(c.cwd, c.command);
              }
            }
            folder.emit({
              type: 'operationProgress',
              session,
              opId,
              phase: r.name,
              percent: Math.floor(((i + 1) * 100) / total),
              message: r.ok ? '' : r.message,
            });
          });
          folder.emit({
            type: 'operationFinished',
            session,
            opId,
            ok: result.failed === 0,
            cancelled: false,
            message: pick(
              `성공 ${result.succeeded} · 건너뜀 ${result.skipped} · 실패 ${result.failed}`,
              `${result.succeeded} succeeded · ${result.skipped} skipped · ${result.failed} failed`,
            ),
            lockLeft: false,
          });
          for (const r of result.results) {
            folder.emit({ type: 'folderChanged', session, refs: true, repo: r.path });
          }
          return result;
        },
        // 폴더 stage·unstage·일괄 commit (W14): 목도 상태를 바꾼다 (Commit 도구 창의 체크가 움직이는 것을 브라우저에서
        // 볼 수 있게). 새로고침하면 처음 상태로 돌아간다
        folderStage: async (session, repo, target) =>
          folderIndexWrite('folderStage', session, repo, target),
        folderUnstage: async (session, repo, target) =>
          folderIndexWrite('folderUnstage', session, repo, target),
        async folderCommit(session, repos, message, stageAll) {
          countMockCall('folderCommit');
          recordMockWrite({ method: 'folderCommit', repos: [...repos], message, stageAll });
          const folder = folderOf(session);
          const { result, committed } = mockFolderCommit(folder.data, repos, message, stageAll);
          for (const { cwd, command } of mockCommitCommands(result, stageAll)) {
            logCommand(cwd, command);
          }
          for (const repo of committed) {
            syncRepoSessions(folder.data, repo, true);
          }
          // 코어처럼 대상 저장소마다 (건너뛴 것도) `folderChanged`(refs) 를 보낸다
          for (const r of result.results) {
            folder.emit({ type: 'folderChanged', session, refs: true, repo: r.path });
          }
          return result;
        },
      }
    : {};

  return {
    /** git 버전. 부를 때마다 `localStorage['mgit.mock.gitVersion']` 을 보고, 없으면 목 표시가 붙은 기본값 */
    async gitVersion() {
      return { version: storedValue(GIT_VERSION_KEY) || DEFAULT_GIT_VERSION, path: 'mock' };
    },

    async openRepo(path, onEvent) {
      if (scene) {
        // 폴더 경로는 실제 코어처럼 거부한다. 앱이 이 오류를 받아 폴더 탭으로 넘어간다
        if (scene.folder && path === scene.folder.path) {
          throw new IpcClientError({
            kind: 'multiRepoFolder',
            path,
            repos: scene.folder.openFolder.map((r) => r.path),
          });
        }
        for (const [open, entry] of sessions) {
          if (entry.path !== path) {
            continue;
          }
          if (entry.profile === 'full') {
            // 실제 코어처럼 재연결한 화면으로 현재 상태와 이후 이벤트를 보낸다.
            entry.emit = onEvent;
            const snapshot = await entry.source.fetchWindow(0, 0);
            onEvent(
              snapshot.finished
                ? {
                    type: 'graphLoadFinished',
                    session: open,
                    generation: snapshot.generation,
                    rows: snapshot.totalRows,
                    laneCount: snapshot.laneCount,
                    elapsedMs: 0,
                    commitGraphSuggested: snapshot.totalRows >= 20_000,
                  }
                : {
                    type: 'graphFirstChunk',
                    session: open,
                    generation: snapshot.generation,
                    rows: snapshot.totalRows,
                  },
            );
            return openedOf(open, entry, true);
          }
          // 코어처럼 같은 id 를 전체 프로필로 올린다: 잡음이 사라지고, 이벤트는 이 호출의 채널로 가며,
          // 그래프 로드가 시작된다
          entry.profile = 'full';
          entry.holders = [];
          entry.emit = onEvent;
          startGraphLoad(open, entry);
          return openedOf(open, entry, true, true);
        }
      }
      const session = nextId++;
      const { source, data } = createRepoSource(path);
      const entry: MockSession = {
        path,
        source,
        query: GRAPH_QUERY,
        timer: null,
        data,
        profile: 'full',
        holders: [],
        emit: onEvent,
        moduleScope: null,
        moduleOverrides: data?.moduleOverrides ?? { added: [], hidden: [] },
      };
      sessions.set(session, entry);
      startGraphLoad(session, entry);
      // 장면의 git 명령 기록을 코어처럼 이벤트로 보낸다 (콘솔 탭)
      for (const record of entry.data?.commandLogged ?? []) {
        entry.emit({ type: 'commandLogged', session, record });
      }

      return openedOf(session, entry, false);
    },

    graphWindow(session, start, count) {
      return graphEntryOf(session).source.fetchWindow(start, count);
    },

    // 지금 보이는(필터로 걸러진) 행에서 찾는다. 걸러져 빠진 커밋이면 null
    async findRow(session, oid) {
      const rows = graphEntryOf(session).source.shown.rows;
      const idx = rows.findIndex((r) => r.oid === oid);
      return idx >= 0 ? idx : null;
    },

    async repoState(session) {
      return stateOf(entryOf(session));
    },

    async refreshRepo(session) {
      entryOf(session);
    },

    async reloadGraph(session) {
      graphEntryOf(session);
    },

    // 그래프에 기대는 메서드: light 세션이면 코어처럼 graphUnavailable, 아니면 널 스텁 그대로
    async searchCommits(session, query, fields, limit) {
      rejectLight(session);
      return createNullClient().searchCommits(session, query, fields, limit);
    },
    async searchAdvanced(session, query, limit) {
      rejectLight(session);
      return createNullClient().searchAdvanced(session, query, limit);
    },
    // 코어 `graph_query` 처럼 가벼운 세션도 받아 둔 질의(기본값)를 준다
    async graphQuery(session) {
      return entryOf(session).query;
    },
    /**
     * 커밋 필터만 코어 규칙대로 적용한다 (`mock-filter.ts`): 잘못된 정규식이면 질의를 바꾸지 않고 `invalidFilter`,
     * 아니면 걸러진 행으로 바꾸고 `graphReloaded`. 나머지 옵션(ref 범위·정렬 등)은 받아 두기만 한다
     */
    async setGraphQuery(session, query) {
      const entry = graphEntryOf(session);
      compileMockFilter(query.filter);
      entry.query = query;
      const { source } = entry;
      source.setShown(
        isEmptyCommitFilter(query.filter) ? null : filterMockGraph(source.graph, query, () => 0),
      );
      source.generation += 1;
      entry.emit({
        type: 'graphReloaded',
        session,
        generation: source.generation,
        rows: source.shown.rows.length,
        laneCount: source.shown.laneCount,
      });
    },
    // 작성자 후보: 필터와 무관하게 전체 이력에서
    async graphAuthors(session) {
      return mockAuthors(graphEntryOf(session).source.graph.rows);
    },
    async setGraphLayoutPrefs(session, prefs) {
      rejectLight(session);
      return createNullClient().setGraphLayoutPrefs(session, prefs);
    },

    async cancelOperation() {
      return false;
    },

    async commandLogRecent() {
      return [];
    },

    ...stubChanges(),
    ...sceneMethods,
    /** 목 앱도 자동 fetch 설정은 환경별로 보존하며 첫 실행에는 꺼 둔다. */
    async autoFetchGet() {
      const minutes = Number(settingsStorage.getItem('mgit.mock.autoFetch') ?? 0);
      return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : 0;
    },
    async autoFetchSet(minutes) {
      settingsStorage.setItem('mgit.mock.autoFetch', String(minutes));
    },
    /** 목 비교도 브랜치 이름을 고정하고 편집 초안을 독립 원문으로 표시한다. */
    async resolveRevision(session, rev) {
      const state = stateOf(entryOf(session));
      const label = state.refs.labels.find((r) => r.fullName === rev || r.shortName === rev);
      if (label) return label.target;
      if (rev === 'HEAD' && state.refs.head.state !== 'unborn') return state.refs.head.oid;
      if (/^[a-f0-9]{7,40}$/i.test(rev)) return rev;
      throw new Error(`Unknown revision: ${rev}`);
    },
    async revisionFileContent(session, _rev, path) {
      return editedFiles.get(`${fsRootOf(session)}/${path}`)?.before ?? textOf(session, path);
    },
    async blameContents(session, path, text) {
      return mockBlame(entryOf(session).source.graph, path, text).map((line, i) => {
        const before = textOf(session, path)?.split('\n')[i];
        return before === line.text
          ? line
          : { ...line, oid: '0'.repeat(40), author: '', summary: '' };
      });
    },
    async compareLocalFiles(session, base, drafts) {
      const paths = new Set([
        ...stateOf(entryOf(session)).status.entries.map((f) => f.path),
        ...drafts.map(([p]) => p),
      ]);
      return {
        base: await this.resolveRevision(session, base),
        files: [...paths].map((path) => ({
          path,
          oldPath: null,
          change: { kind: 'modified' as const },
        })),
      };
    },
    async compareLocalDocument(session, base, path, draft, _options, _full) {
      const old = (await this.revisionFileContent(session, base, path)) ?? '';
      const next = draft ?? textOf(session, path) ?? '';
      const doc = mockDiffDocument(null, base, 'LOCAL');
      const oldLines = old.split('\n'),
        newLines = next.split('\n');
      doc.diff.oldPath = path;
      doc.diff.newPath = path;
      doc.old = { path, label: base, content: old, lineCount: oldLines.length };
      doc.new = { path, label: 'LOCAL', content: next, lineCount: newLines.length };
      doc.diff.hunks =
        old === next
          ? []
          : [
              {
                oldStart: 1,
                newStart: 1,
                oldLines: oldLines.length,
                newLines: newLines.length,
                section: '',
                lines: [
                  ...oldLines.map((text, i) => ({
                    kind: 'del' as const,
                    oldNo: i + 1,
                    newNo: null,
                    text,
                    noNewline: false,
                  })),
                  ...newLines.map((text, i) => ({
                    kind: 'add' as const,
                    oldNo: null,
                    newNo: i + 1,
                    text,
                    noNewline: false,
                  })),
                ],
              },
            ];
      return doc;
    },
    async workTreeDiffDocument(session, path, staged, full, options) {
      return mockDiffDocument(
        await this.workTreeDiff(session, path, staged, full, options),
        staged ? 'HEAD' : 'Index',
        staged ? 'Index' : 'Working tree',
      );
    },
    async commitFileDiffDocument(session, oid, path, oldPath, full, options) {
      return mockDiffDocument(
        await this.commitFileDiff(session, oid, path, oldPath, full, options),
        `${oid}^`,
        oid,
      );
    },
    async compareFileDiffDocument(session, a, b, threeDot, path, options, full) {
      return mockDiffDocument(
        await this.compareFileDiff(session, a, b, threeDot, path, options, full),
        a,
        b,
      );
    },
    async folderCommitFileDiffDocument(session, repo, oid, path, oldPath, full, options) {
      return mockDiffDocument(
        await this.folderCommitFileDiff(session, repo, oid, path, oldPath, full, options),
        `${oid}^`,
        oid,
      );
    },

    // 화면 언어 (다국어 L3): OS 로캘 대신 브라우저 언어를 준다. `setLanguage` 는 Rust 가 없으니 빈 구현(위 stubChanges)
    async systemLocale() {
      return (typeof navigator === 'undefined' ? '' : navigator.language) || null;
    },

    // 터미널: 셸이 없으므로 탭마다 안내 한 줄만 보내고 입력은 버린다 (PTY 번호로 뷰가 다시 열렸는지 알 수 있다)
    async ptyOpen(cwd, _cols, _rows, onEvent) {
      const id = nextPty++;
      onEvent({ kind: 'data', id, data: `[mock pty ${id}] ${cwd}\r\n` });
      return id;
    },

    // 프로필 무관하게 닫는다 (잡은 폴더가 있어도). 모르는 id 면 코어처럼 sessionNotFound
    async closeRepo(session) {
      entryOf(session);
      dropSession(session);
    },
  };
}
