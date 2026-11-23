import {
  type AuthorList,
  createNullClient,
  emptyRepoState,
  type GraphQuery,
  GraphRangeCache,
  type IpcClient,
  IpcClientError,
  type RepoOpened,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { clearedQuery, withPaths, withText } from '../features/filter-bar/filter-model';
import { DEFAULT_GRAPH_QUERY } from '../store';
import { createSessionStore } from '../store/session-store';

// 세션 스토어의 W26 몫: 그래프 질의의 `invalidFilter` 되돌림, 작성자 후보, 범위의 두 출처(모듈 범위·경로 범위) 맞추기

const HEAD = 'a'.repeat(40);
const MODS = [
  { name: 'cart', path: 'src/features/cart', kind: 'manual' as const },
  { name: 'ui', path: 'packages/ui', kind: 'manual' as const },
];
const invalid = () => new IpcClientError({ kind: 'invalidFilter', message: '잘못된 정규식: (' });
const LIST: AuthorList = {
  authors: [{ name: '서하린', email: 'harin@x', commits: 3 }],
  total: 1,
  truncated: false,
  timedOut: false,
};

/** 응답을 밖에서 정하는 약속 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 정규식이 `(` 면 코어처럼 `invalidFilter` 로 거부하는 클라이언트 */
function client(scope: string | null = null) {
  const c: IpcClient = {
    ...createNullClient(),
    modules: vi.fn(async () => MODS),
    moduleScope: vi.fn(async () => scope),
    moduleScopeSet: vi.fn(async () => {}),
    setGraphQuery: vi.fn(async (_s: number, q: GraphQuery) => {
      if (q.filter?.text?.pattern === '(') {
        throw invalid();
      }
    }),
    graphAuthors: vi.fn(async () => LIST),
  };
  return c;
}

/** 스토어 (모듈 읽기 등 생성 때 읽기가 끝날 때까지 기다린다) */
async function setup(c: IpcClient = client(), profile: 'full' | 'light' = 'full') {
  const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
  const opened: RepoOpened = {
    session: 1,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '/r',
      gitDir: '/r/.git',
      commonDir: '/r/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState(head),
  };
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(opened, c, cache, { profile });
  await tick();
  await tick();
  return { store, client: c, head };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const text = (pattern: string) =>
  withText(DEFAULT_GRAPH_QUERY, { pattern, regex: true, matchCase: false });

describe('setGraphQuery 의 invalidFilter 되돌림 (W26)', () => {
  it('코어가 거부하면 받아들여진 질의를 그대로 두고 filterError 를 세운다 (알림·busy 는 남지 않는다)', async () => {
    const { store, client: c } = await setup();
    await store.getState().setGraphQuery(text('fix'));
    expect(store.getState().graphQuery).toEqual(text('fix'));
    await store.getState().setGraphQuery(text('('));
    expect(c.setGraphQuery).toHaveBeenLastCalledWith(1, text('('));
    expect(store.getState().graphQuery).toEqual(text('fix'));
    expect(store.getState().filterError).toBe('잘못된 정규식: (');
    expect(store.getState().actionError).toBeNull();
    expect(store.getState().busy).toBe(false);
    // 입력을 고치면 지운다
    store.getState().clearFilterError();
    expect(store.getState().filterError).toBeNull();
  });

  it('가장 나중 요청이 받아들여지면 오류가 빈다. 늦게 실패한 옛 요청은 무시한다', async () => {
    const c = client();
    const { store } = await setup(c);
    await store.getState().setGraphQuery(text('('));
    expect(store.getState().filterError).not.toBeNull();
    await store.getState().setGraphQuery(text('ok'));
    expect(store.getState().filterError).toBeNull();
    // 옛 요청(잘못된 정규식)이 새 요청보다 늦게 실패한다
    const slow = deferred<void>();
    c.setGraphQuery = vi.fn(async (_s: number, q: GraphQuery) => {
      if (q.filter?.text?.pattern === '(') {
        await slow.promise;
        throw invalid();
      }
    });
    const first = store.getState().setGraphQuery(text('('));
    await store.getState().setGraphQuery(text('next'));
    slow.resolve();
    await first;
    expect(store.getState().filterError).toBeNull();
    expect(store.getState().graphQuery).toEqual(text('next'));
  });

  it('다른 실패(없는 ref 등)는 지금처럼 알림(actionError)이고 filterError 는 세우지 않는다', async () => {
    const c = client();
    c.setGraphQuery = vi.fn(async () => {
      throw new IpcClientError({ kind: 'internal', message: '찾을 수 없는 참조: nope' });
    });
    const { store } = await setup(c);
    const q = { ...DEFAULT_GRAPH_QUERY, revs: { kind: 'solo' as const, name: 'nope' } };
    await store.getState().setGraphQuery(q);
    expect(store.getState().graphQuery).toEqual(DEFAULT_GRAPH_QUERY);
    expect(store.getState().actionError).toContain('찾을 수 없는 참조');
    expect(store.getState().filterError).toBeNull();
  });

  it('다른 호출처의 동작은 그대로다: 브랜치 트리의 solo, 모듈 고르기가 질의를 바꾸고 범위 선택을 비운다', async () => {
    const { store, client: c } = await setup();
    const solo = { ...DEFAULT_GRAPH_QUERY, revs: { kind: 'solo' as const, name: 'origin/main' } };
    await store.getState().setGraphQuery(solo);
    expect(store.getState().graphQuery).toEqual(solo);
    expect(store.getState().range).toBeNull();
    await store.getState().selectModule('packages/ui');
    expect(c.moduleScopeSet).toHaveBeenLastCalledWith(1, 'packages/ui');
    expect(store.getState().graphQuery).toEqual({ ...solo, pathScope: ['packages/ui'] });
    expect(store.getState().moduleScope).toBe('packages/ui');
  });
});

describe('범위의 두 출처 맞추기 (W26)', () => {
  it('모듈 범위가 걸린 채 경로를 풀거나 바꾸면 모듈 범위도 풀린다 (코어에 기억한 범위도)', async () => {
    const { store, client: c } = await setup();
    await store.getState().selectModule('src/features/cart');
    expect(store.getState().moduleScope).toBe('src/features/cart');
    // 다른 조건만 바꾸면(경로는 그대로) 모듈 범위가 남는다
    await store.getState().setGraphQuery(
      withText(store.getState().graphQuery, {
        pattern: 'fix',
        regex: false,
        matchCase: false,
      }),
    );
    expect(store.getState().moduleScope).toBe('src/features/cart');
    // 경로를 고친다 (모듈 경로 + 다른 경로)
    await store
      .getState()
      .setGraphQuery(withPaths(store.getState().graphQuery, ['src/features/cart', 'docs']));
    expect(store.getState().moduleScope).toBeNull();
    expect(c.moduleScopeSet).toHaveBeenLastCalledWith(1, null);
  });

  it('모두 지우기·필터·옵션 초기화(경로를 비움)도 모듈 범위를 푼다. 모듈을 다시 고르면 경로 범위가 그 모듈이다', async () => {
    const { store, client: c } = await setup();
    await store.getState().selectModule('src/features/cart');
    await store.getState().setGraphQuery(clearedQuery(store.getState().graphQuery));
    expect(store.getState().moduleScope).toBeNull();
    await store.getState().selectModule('packages/ui');
    expect(store.getState().graphQuery.pathScope).toEqual(['packages/ui']);
    await store.getState().setGraphQuery(DEFAULT_GRAPH_QUERY);
    expect(store.getState().moduleScope).toBeNull();
    expect(c.moduleScopeSet).toHaveBeenLastCalledWith(1, null);
  });

  it('잘못된 정규식으로 거부된 질의는 모듈 범위를 건드리지 않는다', async () => {
    const { store } = await setup();
    await store.getState().selectModule('src/features/cart');
    await store.getState().setGraphQuery(withPaths(text('('), []));
    expect(store.getState().moduleScope).toBe('src/features/cart');
  });

  it('모듈을 고르는 사이 먼저 보낸 다른 질의가 받아들여져도 방금 고른 모듈을 풀지 않는다', async () => {
    const c = client();
    const { store } = await setup(c);
    const slow = deferred<void>();
    c.setGraphQuery = vi.fn(async (_s: number, q: GraphQuery) => {
      if (q.filter?.text?.pattern === 'slow') {
        await slow.promise;
      }
    });
    const earlier = store.getState().setGraphQuery(text('slow'));
    const picking = store.getState().selectModule('packages/ui');
    slow.resolve();
    await earlier;
    await picking;
    expect(store.getState().moduleScope).toBe('packages/ui');
    expect(store.getState().graphQuery.pathScope).toEqual(['packages/ui']);
  });

  it('열 때 기억한 범위: 질의가 기본값이면 적용한다(MOD-05 그대로). 다른 질의면 띠에 보이지 않고 코어의 기억도 지우지 않는다', async () => {
    const applied = await setup(client('src/features/cart'));
    expect(applied.store.getState().moduleScope).toBe('src/features/cart');
    expect(applied.store.getState().graphQuery.pathScope).toEqual(['src/features/cart']);

    const c = client(null);
    const { store } = await setup(c);
    await store.getState().setGraphQuery({ ...DEFAULT_GRAPH_QUERY, hideRemotes: true });
    c.moduleScope = vi.fn(async () => 'src/features/cart');
    await store.getState().loadModules();
    expect(store.getState().moduleScope).toBeNull();
    expect(store.getState().graphQuery.pathScope).toEqual([]);
    expect(c.moduleScopeSet).not.toHaveBeenCalled();
  });
});

describe('작성자 후보 (W26)', () => {
  it('열 때 한 번 읽고, 읽은 뒤에는 다시 읽지 않으며 force 면 다시 읽는다', async () => {
    const { store, client: c } = await setup();
    expect(store.getState().graphAuthors.state).toBe('idle');
    store.getState().loadGraphAuthors(false);
    expect(store.getState().graphAuthors.state).toBe('loading');
    await tick();
    expect(store.getState().graphAuthors).toEqual({ state: 'ready', list: LIST, error: null });
    store.getState().loadGraphAuthors(false);
    expect(c.graphAuthors).toHaveBeenCalledTimes(1);
    store.getState().loadGraphAuthors(true);
    await tick();
    expect(c.graphAuthors).toHaveBeenCalledTimes(2);
  });

  it('최신 요청의 응답만 받는다. 실패는 사유와 함께 error', async () => {
    const c = client();
    const first = deferred<AuthorList>();
    const second = deferred<AuthorList>();
    c.graphAuthors = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { store } = await setup(c);
    store.getState().loadGraphAuthors(false);
    store.getState().loadGraphAuthors(true);
    second.reject(new IpcClientError({ kind: 'internal', message: '실패' }));
    await tick();
    first.resolve(LIST);
    await tick();
    expect(store.getState().graphAuthors.state).toBe('error');
    expect(store.getState().graphAuthors.error).toBe('실패');
  });

  it('ref 가 바뀌면 낡은 것으로 본다 (목록은 남기고 다음에 열 때 다시 읽는다)', async () => {
    const { store, client: c, head } = await setup();
    store.getState().loadGraphAuthors(false);
    await tick();
    store
      .getState()
      .applyEvent({ type: 'refsChanged', session: 1, refs: emptyRepoState(head).refs });
    expect(store.getState().graphAuthors).toEqual({ state: 'idle', list: LIST, error: null });
    store.getState().loadGraphAuthors(false);
    await tick();
    expect(c.graphAuthors).toHaveBeenCalledTimes(2);
  });

  it('가벼운 세션(그래프 없음)은 읽지 않는다', async () => {
    const { store, client: c } = await setup(client(), 'light');
    store.getState().loadGraphAuthors(true);
    await tick();
    expect(c.graphAuthors).not.toHaveBeenCalled();
    expect(store.getState().graphAuthors.state).toBe('idle');
  });
});
