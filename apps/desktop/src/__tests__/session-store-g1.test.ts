import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changedViewOptions } from '../features/graph/repo-log-filter';
import {
  createSessionStore,
  DEFAULT_GRAPH_QUERY,
  DEFAULT_LAYOUT_PREFS,
  isDefaultGraphQuery,
  isDefaultLayoutPrefs,
} from '../store/session-store';

const A = 'a'.repeat(40);

/** 레이아웃 설정 IPC 를 기록하는 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    setGraphQuery: vi.fn(async () => {}),
    setGraphLayoutPrefs: vi.fn(async () => {}),
  };
}

/** 스토어 */
function setup(c = client()) {
  const head = { state: 'attached' as const, branch: 'main', oid: A };
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
  return { store: createSessionStore(opened, c, cache), client: c };
}

/** 마이크로태스크 비우기 */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // jsdom 밖
  }
});

describe('그래프 레이아웃·보기 설정 (G1)', () => {
  it('기본값이면 코어에 설정을 보내지 않고, 바꾸면 저장 후 IPC 로 보낸다', async () => {
    const { store, client: c } = setup();
    await tick();
    expect(isDefaultLayoutPrefs(store.getState().layoutPrefs)).toBe(true);
    expect(c.setGraphLayoutPrefs).not.toHaveBeenCalled();

    await store.getState().setGraphLayoutPrefs({ ...DEFAULT_LAYOUT_PREFS, pinHead: false });
    expect(c.setGraphLayoutPrefs).toHaveBeenCalledWith(1, {
      pinHead: false,
      refColors: true,
      collapseLongEdges: true,
    });
    expect(store.getState().layoutPrefs.pinHead).toBe(false);
    expect(JSON.parse(localStorage.getItem('mgit.graphLayout') ?? '{}').pinHead).toBe(false);
  });

  it('저장된 설정이 기본값이 아니면 세션을 만들 때 코어에 알린다', async () => {
    localStorage.setItem(
      'mgit.graphLayout',
      JSON.stringify({ pinHead: true, refColors: false, collapseLongEdges: true }),
    );
    const { client: c } = setup();
    await tick();
    expect(c.setGraphLayoutPrefs).toHaveBeenCalledWith(1, {
      pinHead: true,
      refColors: false,
      collapseLongEdges: true,
    });
  });

  it('보기 설정(흐리게)은 IPC 없이 저장만 한다', () => {
    const { store, client: c } = setup();
    expect(store.getState().graphView.dimOffHead).toBe(true);
    store.getState().setGraphViewPrefs({ dimOffHead: false });
    expect(store.getState().graphView.dimOffHead).toBe(false);
    expect(c.setGraphLayoutPrefs).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('mgit.graphView') ?? '{}').dimOffHead).toBe(false);
  });

  it('정렬·첫 부모·머지 제외는 질의에 들어가 기본값 판정과 요약(필터 바 보기 옵션의 이름)에 반영된다', async () => {
    const { store, client: c } = setup();
    expect(isDefaultGraphQuery(DEFAULT_GRAPH_QUERY)).toBe(true);
    expect(changedViewOptions(DEFAULT_GRAPH_QUERY)).toEqual([]);
    const q = {
      ...DEFAULT_GRAPH_QUERY,
      revs: { kind: 'solo' as const, name: 'main' },
      hideRemotes: true,
      sort: 'date' as const,
      firstParent: true,
    };
    await store.getState().setGraphQuery(q);
    expect(c.setGraphQuery).toHaveBeenCalledWith(1, q);
    expect(isDefaultGraphQuery(q)).toBe(false);
    // ref 범위(main 만)는 보기 옵션이 아니라 branch 드롭다운이 보인다
    expect(changedViewOptions(q)).toEqual(['날짜순', '원격 숨김', '첫 부모만']);
    expect(changedViewOptions({ ...DEFAULT_GRAPH_QUERY, noMerges: true })).toEqual(['머지 제외']);
  });
});
