import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  IpcClientError,
  type RepoOpened,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore, DEFAULT_LAYOUT_PREFS } from '../store/session-store';

const A = 'a'.repeat(40);
const SESSION = 31;

/** 생성 때 읽기(13개 — W23 이 스태시 목록을 더했다)가 부르는 IPC 메서드 */
const STARTUP_METHODS = [
  'undoState',
  'backups',
  'commitTemplates',
  'submodules',
  'signingInfo',
  'perfStatus',
  'hostingRemoteProject',
  'modules',
  'moduleScope',
  'conflictRadar',
  'isolatedInfo',
  'mergeToolName',
  'verifyCommand',
  'worktreeInitCommand',
  // 스태시 목록: 저장소 탭 Commit 도구 창의 Stash 탭 (W23 — 옛 사이드바는 마운트될 때 읽었다)
  'listStashes',
] as const satisfies readonly (keyof IpcClient)[];

/**
 * 가벼운 프로필에서도 생성 때 도는 읽기 (`STARTUP_LOADS` 의 `light: true`): 폴더 탭의 충돌 편집기 탭(W15)이 머리줄에
 * 쓰는 머지 도구 이름
 */
const LIGHT_STARTUP_METHODS: readonly string[] = ['mergeToolName'];

/** 그래프 API (코어가 가벼운 세션에서 `graphUnavailable` 로 거부하는 것) */
const GRAPH_METHODS = [
  'graphWindow',
  'findRow',
  'reloadGraph',
  'searchCommits',
  'searchAdvanced',
  'setGraphQuery',
  'setGraphLayoutPrefs',
] as const satisfies readonly (keyof IpcClient)[];

/**
 * 호출을 기록하는 클라이언트. 그래프 API 는 코어처럼 `graphUnavailable` 로 거부한다 (부르면 안 되지만, 불렀다면
 * 오류가 어디로 새는지도 함께 드러나게). 모듈은 기억한 범위가 있어 전체 프로필이면 그래프 질의를 바꾸려 한다
 */
function recordingClient() {
  const base = createNullClient();
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const client: IpcClient = { ...base };
  const target = client as unknown as Record<string, (...args: unknown[]) => unknown>;
  const source = base as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of STARTUP_METHODS) {
    target[name] = (...args: unknown[]) => {
      count(name);
      return source[name]?.(...args);
    };
  }
  for (const name of GRAPH_METHODS) {
    target[name] = async () => {
      count(name);
      throw new IpcClientError({ kind: 'graphUnavailable', session: SESSION });
    };
  }
  client.moduleScope = async () => {
    count('moduleScope');
    return 'services/api';
  };
  client.fileHistory = vi.fn(async (_s, path) => [
    { oid: A, subject: 's', authorName: 'a', authorTime: 0, path },
  ]);
  client.blame = vi.fn(async () => []);
  client.openDifftool = vi.fn(async () => {});
  return { client, calls };
}

/** 가벼운(또는 전체) 프로필의 스토어 */
function setup(profile: 'light' | 'full') {
  const { client, calls } = recordingClient();
  const head = { state: 'attached' as const, branch: 'main', oid: A };
  const opened: RepoOpened = {
    session: SESSION,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '/f/api',
      gitDir: '/f/api/.git',
      commonDir: '/f/api/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState(head),
    profile,
  };
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(opened, client, cache, { profile });
  return { store, client, calls };
}

/** 그래프 API 를 부른 수 */
const graphCalls = (calls: Record<string, number>) =>
  GRAPH_METHODS.reduce((n, name) => n + (calls[name] ?? 0), 0);

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  // 저장된 레이아웃 설정이 기본값이 아니면 전체 프로필은 생성 때 코어에 알린다
  localStorage.setItem(
    'mgit.graphLayout',
    JSON.stringify({ ...DEFAULT_LAYOUT_PREFS, pinHead: false }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('세션 스토어 프로필 (W13)', () => {
  it('전체 프로필은 지금처럼 생성 때 읽기 13개와 레이아웃 설정 동기화를 돈다', async () => {
    const { store, calls } = setup('full');
    await flush();
    for (const name of STARTUP_METHODS) {
      expect(calls[name], name).toBe(1);
    }
    expect(calls.setGraphLayoutPrefs).toBe(1);
    // 기억한 모듈 범위가 그래프 질의에 들어간다 (전체 프로필만)
    expect(calls.setGraphQuery).toBe(1);
    expect(store.getState().profile).toBe('full');
  });

  it('가벼운 프로필은 생성 때 읽기 중 폴더 탭 기능이 쓰는 것(W15: 머지 도구 이름)만 돌고 그래프 API 는 부르지 않는다', async () => {
    const { store, calls } = setup('light');
    await flush();
    expect(store.getState().profile).toBe('light');
    for (const name of STARTUP_METHODS) {
      expect(calls[name] ?? 0, name).toBe(LIGHT_STARTUP_METHODS.includes(name) ? 1 : 0);
    }
    expect(graphCalls(calls)).toBe(0);
  });

  it('가벼운 프로필에서 히스토리·blame·외부 도구와 ref·상태 이벤트를 거쳐도 graphUnavailable 이 한 번도 나지 않는다', async () => {
    vi.useFakeTimers();
    const { store, client, calls } = setup('light');
    await store.getState().openFileHistory('src/a.ts');
    await store.getState().openBlame('src/a.ts', null);
    await store.getState().openBlame('src/a.ts', A);
    await store.getState().openDifftool({ kind: 'commit', oid: A, path: 'src/a.ts' });
    // blame 옵션을 바꾸면 열린 blame 을 다시 읽는다 (그래프와 무관)
    store.getState().setDiffOptions({ ignoreWhitespace: true });
    const head = { state: 'attached' as const, branch: 'main', oid: A };
    store.getState().applyEvent({
      type: 'refsChanged',
      session: SESSION,
      refs: emptyRepoState(head).refs,
    });
    store.getState().applyEvent({
      type: 'statusChanged',
      session: SESSION,
      status: emptyRepoState(head).status,
      op: null,
    });
    // ref 변경 1.5초 뒤의 충돌 레이더도 가벼운 세션은 계산하지 않는다
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.fileHistory).toHaveBeenCalledWith(SESSION, 'src/a.ts', expect.any(Number));
    expect(client.blame).toHaveBeenCalledTimes(3);
    expect(client.openDifftool).toHaveBeenCalledTimes(1);
    expect(graphCalls(calls)).toBe(0);
    expect(calls.conflictRadar ?? 0).toBe(0);
    expect(store.getState().actionError).toBeNull();
    expect(store.getState().blame?.error ?? null).toBeNull();
  });

  it('승격하면 건너뛴 읽기와 레이아웃 설정 동기화가 한 번씩 돌고, 다시 승격해도 되풀이하지 않는다', async () => {
    const { store, calls } = setup('light');
    await flush();
    store.getState().promote();
    await flush();
    expect(store.getState().profile).toBe('full');
    for (const name of STARTUP_METHODS) {
      expect(calls[name], name).toBe(1);
    }
    expect(calls.setGraphLayoutPrefs).toBe(1);
    expect(calls.setGraphQuery).toBe(1);
    store.getState().promote();
    await flush();
    expect(calls.undoState).toBe(1);
    expect(calls.setGraphLayoutPrefs).toBe(1);
  });

  it('승격 뒤의 그래프 이벤트는 그 스토어의 로드 상태를 움직인다 (같은 스토어가 전체 프로필로 산다)', async () => {
    const { store } = setup('light');
    store.getState().promote();
    store.getState().applyEvent({ type: 'graphLoadStarted', session: SESSION, generation: 1 });
    store.getState().applyEvent({
      type: 'graphLoadFinished',
      session: SESSION,
      generation: 1,
      rows: 42,
      laneCount: 2,
      elapsedMs: 1,
      commitGraphSuggested: false,
    });
    expect(store.getState().loadState).toBe('complete');
    expect(store.getState().totalRows).toBe(42);
  });
});
