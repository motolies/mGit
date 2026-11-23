import {
  createNullClient,
  type FolderBranch,
  type FolderBranches,
  type FolderBranchIn,
  type FolderBranchRepo,
  type IpcClient,
  type RepoChanges,
  type RepoSummary,
  type TimelineInfo,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderStore, mergeByRepo, mergeFolderBranches } from '../store/folder-store';

const ID = 7;
const pathOf = (name: string) => `/f/${name}`;
const REPOS = ['a', 'b', 'c'].map((name) => ({
  path: pathOf(name),
  kind: 'standalone' as const,
}));

/** 요약 한 줄 */
function summary(name: string, changed = 0): RepoSummary {
  return {
    path: pathOf(name),
    name,
    kind: 'standalone',
    color: ['a', 'b', 'c'].indexOf(name),
    branch: 'main',
    detached: false,
    changed,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
  };
}

/** 변경이 있는 저장소 한 줄 */
function changes(name: string): RepoChanges {
  return {
    path: pathOf(name),
    name,
    branch: 'main',
    entries: [],
    summary: {
      staged: 1,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0,
      stashCount: 0,
      upstream: null,
    },
  };
}

/** 브랜치 목록의 저장소 한 줄 */
function branchRepo(name: string, branch = 'main'): FolderBranchRepo {
  return {
    path: pathOf(name),
    name,
    color: ['a', 'b', 'c'].indexOf(name),
    head: { state: 'attached', branch, oid: '0'.repeat(40) },
    error: null,
  };
}

/** 브랜치가 있는 저장소 하나 */
function at(name: string, extra: Partial<FolderBranchIn> = {}): FolderBranchIn {
  return {
    path: pathOf(name),
    color: ['a', 'b', 'c'].indexOf(name),
    current: false,
    upstream: null,
    ahead: null,
    behind: null,
    gone: false,
    ...extra,
  };
}

/** 브랜치 하나 */
function branch(name: string, ...repos: FolderBranchIn[]): FolderBranch {
  const remote = name.startsWith('origin/');
  return { name, remote, remoteName: remote ? 'origin' : null, repos };
}

/** 브랜치 목록을 (이름 → 저장소 이름들) 로 줄인다 */
const shape = (list: FolderBranches | null) =>
  (list?.branches ?? []).map((b) => [b.name, b.repos.map((r) => r.path.slice(3)).join(',')]);

/** 처음 전부 읽을 때의 브랜치 목록: a·b 에 main, a 에 topic, b 에 origin/main */
const ALL_BRANCHES: FolderBranches = {
  repos: [branchRepo('a'), branchRepo('b'), branchRepo('c')],
  branches: [
    branch('main', at('a', { current: true }), at('b', { current: true }), at('c')),
    branch('topic', at('a')),
    branch('origin/main', at('b')),
  ],
};

describe('mergeByRepo', () => {
  it('물어본 저장소의 줄만 바꾸고, 받은 것이 없는 저장소는 뺀다. 경로순을 지킨다', () => {
    const prev = [summary('a', 1), summary('b', 2), summary('c', 3)];
    expect(
      mergeByRepo(prev, [summary('b', 9)], [pathOf('b')]).map((s) => [s.name, s.changed]),
    ).toEqual([
      ['a', 1],
      ['b', 9],
      ['c', 3],
    ]);
    // 변경 목록: 물어본 저장소에 변경이 없어져 응답에 없으면 빠진다
    expect(mergeByRepo(prev, [], [pathOf('a')]).map((s) => s.name)).toEqual(['b', 'c']);
    // 새로 생긴 줄은 경로순 자리에 들어간다
    expect(mergeByRepo([summary('c')], [summary('a')], [pathOf('a')]).map((s) => s.name)).toEqual([
      'a',
      'c',
    ]);
  });
});

describe('mergeFolderBranches', () => {
  it('처음이면 받은 목록을 그대로 쓴다', () => {
    expect(mergeFolderBranches(null, ALL_BRANCHES)).toBe(ALL_BRANCHES);
  });

  it('다시 읽은 저장소의 정보만 바꾼다: 사라진 브랜치는 빠지고 새 브랜치는 들어온다', () => {
    // b 를 다시 읽었다: main 은 남고(이제 현재가 아님), origin/main 은 사라지고, feature 가 생겼다
    const part: FolderBranches = {
      repos: [branchRepo('b', 'feature')],
      branches: [branch('feature', at('b', { current: true })), branch('main', at('b'))],
    };
    const merged = mergeFolderBranches(ALL_BRANCHES, part);
    expect(shape(merged)).toEqual([
      ['feature', 'b'],
      ['main', 'a,b,c'],
      ['topic', 'a'],
    ]);
    const main = merged.branches.find((b) => b.name === 'main');
    expect(main?.repos.map((r) => r.current)).toEqual([true, false, false]);
    // 저장소 줄(HEAD)도 그 저장소만 바뀌고 순서는 그대로다
    expect(
      merged.repos.map((r) => [r.name, r.head?.state === 'attached' && r.head.branch]),
    ).toEqual([
      ['a', 'main'],
      ['b', 'feature'],
      ['c', 'main'],
    ]);
  });

  it('로컬 먼저 이름순이고, 읽지 못한 저장소는 브랜치가 모두 빠진 채 사유와 함께 남는다', () => {
    const part: FolderBranches = {
      repos: [{ ...branchRepo('a'), head: null, error: '읽기 실패' }],
      branches: [],
    };
    const merged = mergeFolderBranches(ALL_BRANCHES, part);
    expect(shape(merged)).toEqual([
      ['main', 'b,c'],
      ['origin/main', 'b'],
    ]);
    expect(merged.repos[0]).toMatchObject({ name: 'a', error: '읽기 실패' });
  });
});

/** 호출을 기록하는 클라이언트. 요약·브랜치·변경의 응답은 물어본 저장소에 맞춰 준다 */
function recordingClient(overrides: Partial<IpcClient> = {}) {
  const subset = <T extends { path: string }>(rows: readonly T[], repos?: readonly string[]) =>
    repos && repos.length > 0 ? rows.filter((row) => repos.includes(row.path)) : [...rows];
  const folderSummaries = vi.fn<IpcClient['folderSummaries']>(async (_id, repos) =>
    subset([summary('a'), summary('b'), summary('c')], repos),
  );
  const folderBranches = vi.fn<IpcClient['folderBranches']>(async (_id, repos) => ({
    repos: subset(ALL_BRANCHES.repos, repos),
    branches: ALL_BRANCHES.branches.flatMap((b) => {
      const own = subset(b.repos, repos);
      return own.length > 0 ? [{ ...b, repos: own }] : [];
    }),
  }));
  const folderChanges = vi.fn<IpcClient['folderChanges']>(async (_id, repos) =>
    subset([changes('a'), changes('b')], repos),
  );
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries,
    folderBranches,
    folderChanges,
    ...overrides,
  };
  return { client, folderSummaries, folderBranches, folderChanges };
}

/** 폴더 스토어를 만들고 처음 읽기까지 끝낸다 */
async function opened(overrides: Partial<IpcClient> = {}) {
  const rec = recordingClient(overrides);
  const store = createFolderStore({ session: ID, path: '/f', repos: REPOS }, rec.client);
  await vi.advanceTimersByTimeAsync(0);
  return { store, ...rec };
}

/** 감시 이벤트 */
const changed = (repo: string | null, refs = false) =>
  ({
    type: 'folderChanged',
    session: ID,
    refs,
    repo: repo === null ? null : pathOf(repo),
  }) as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('브랜치 목록은 타임라인과 따로 읽는다 (PF-03, BT-06)', () => {
  it('폴더를 열면 타임라인을 열지 않아도 브랜치 목록이 채워진다', async () => {
    const folderTimelineOpen = vi.fn<IpcClient['folderTimelineOpen']>();
    const { store, folderBranches } = await opened({ folderTimelineOpen });
    expect(folderBranches).toHaveBeenCalledWith(ID, []);
    expect(folderTimelineOpen).not.toHaveBeenCalled();
    expect(store.getState().timeline.opened).toBe(false);
    expect(shape(store.getState().branches)).toEqual([
      ['main', 'a,b,c'],
      ['topic', 'a'],
      ['origin/main', 'b'],
    ]);
  });

  it('타임라인 로드가 끝나기 전에도 브랜치 목록은 이미 있다', async () => {
    // 타임라인 열기는 응답하지 않는다 (로드가 오래 걸리는 폴더)
    const pending: TimelineInfo = {
      generation: 0,
      rows: 0,
      finished: false,
      maxPerRepo: 10000,
      repos: [],
      scoped: false,
    };
    const { store } = await opened({ folderTimelineOpen: async () => pending });
    await store.getState().openTimeline();
    expect(store.getState().timeline.loadState).toBe('loading');
    // 타임라인 정보에는 아무 저장소도 없지만(브랜치 목록은 W28 에서 타임라인 정보에서 뺐다) 브랜치 목록은 따로 와 있다
    expect(store.getState().timeline.info?.repos).toEqual([]);
    expect(store.getState().branches?.branches).toHaveLength(3);
  });

  it('브랜치 목록을 읽지 못해도 "읽는 중" 으로 남지 않고 사유를 남긴다', async () => {
    const { store } = await opened({
      folderBranches: async () => {
        throw new Error('ref 읽기 실패');
      },
    });
    expect(store.getState().branches).toEqual({ repos: [], branches: [] });
    expect(store.getState().error).toBe('ref 읽기 실패');
    // 요약은 따로 읽혀 그대로 들어온다
    expect(store.getState().summaries).toHaveLength(3);
  });
});

describe('folderChanged 의 부분 갱신 (PF-02)', () => {
  it('저장소가 실려 오면 그 저장소의 요약·브랜치만 다시 읽어 기존 목록에 합친다', async () => {
    const { store, folderSummaries, folderBranches, folderChanges } = await opened();
    folderSummaries.mockImplementation(async () => [summary('b', 5)]);
    folderBranches.mockImplementation(async () => ({
      repos: [branchRepo('b', 'feature')],
      branches: [branch('feature', at('b', { current: true })), branch('main', at('b'))],
    }));

    store.getState().applyEvent(changed('b'));
    await vi.advanceTimersByTimeAsync(400);

    expect(folderSummaries).toHaveBeenLastCalledWith(ID, [pathOf('b')]);
    expect(folderBranches).toHaveBeenLastCalledWith(ID, [pathOf('b')]);
    expect(folderSummaries).toHaveBeenCalledTimes(2);
    // 변경 목록은 읽어 둔 적이 없으므로 묻지 않는다 (반쪽 목록을 만들지 않는다)
    expect(folderChanges).not.toHaveBeenCalled();
    expect(store.getState().summaries.map((s) => [s.name, s.changed])).toEqual([
      ['a', 0],
      ['b', 5],
      ['c', 0],
    ]);
    expect(shape(store.getState().branches)).toEqual([
      ['feature', 'b'],
      ['main', 'a,b,c'],
      ['topic', 'a'],
    ]);
    expect(store.getState().loading).toBe(false);
  });

  it('여러 저장소가 짧은 시간에 바뀌면 디바운스 안에서 모아 한 번에 읽는다', async () => {
    const { store, folderSummaries, folderBranches } = await opened();
    store.getState().applyEvent(changed('a'));
    await vi.advanceTimersByTimeAsync(200);
    store.getState().applyEvent(changed('c'));
    await vi.advanceTimersByTimeAsync(200);
    store.getState().applyEvent(changed('a'));
    // 마지막 이벤트 뒤 디바운스가 지나기 전에는 읽지 않는다
    await vi.advanceTimersByTimeAsync(399);
    expect(folderSummaries).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(folderSummaries).toHaveBeenCalledTimes(2);
    expect(folderSummaries).toHaveBeenLastCalledWith(ID, [pathOf('a'), pathOf('c')]);
    expect(folderBranches).toHaveBeenLastCalledWith(ID, [pathOf('a'), pathOf('c')]);
  });

  it('어느 저장소인지 모르는 이벤트가 섞이면 전부 다시 읽는다', async () => {
    const { store, folderSummaries, folderBranches } = await opened();
    store.getState().applyEvent(changed('b'));
    store.getState().applyEvent(changed(null));
    await vi.advanceTimersByTimeAsync(400);
    expect(folderSummaries).toHaveBeenCalledTimes(2);
    expect(folderSummaries).toHaveBeenLastCalledWith(ID, []);
    expect(folderBranches).toHaveBeenLastCalledWith(ID, []);
  });

  it('변경 목록을 읽어 둔 뒤에는 변경도 그 저장소만 다시 읽고, 변경이 없어진 저장소는 뺀다', async () => {
    const { store, folderChanges } = await opened();
    await store.getState().loadChanges();
    expect(store.getState().changes.map((c) => c.name)).toEqual(['a', 'b']);

    // a 를 커밋해 변경이 없어졌다
    folderChanges.mockImplementation(async () => []);
    store.getState().applyEvent(changed('a'));
    await vi.advanceTimersByTimeAsync(400);
    expect(folderChanges).toHaveBeenLastCalledWith(ID, [pathOf('a')]);
    expect(store.getState().changes.map((c) => c.name)).toEqual(['b']);

    // c 에 변경이 생겼다
    folderChanges.mockImplementation(async () => [changes('c')]);
    store.getState().applyEvent(changed('c'));
    await vi.advanceTimersByTimeAsync(400);
    expect(store.getState().changes.map((c) => c.name)).toEqual(['b', 'c']);
  });

  it('읽는 중에 온 이벤트는 놓치지 않고, 그 읽기가 끝난 뒤 이어서 읽는다', async () => {
    const { store, folderSummaries } = await opened();
    let release: (rows: RepoSummary[]) => void = () => {};
    folderSummaries.mockImplementationOnce(
      () =>
        new Promise<RepoSummary[]>((resolve) => {
          release = resolve;
        }),
    );
    const full = store.getState().refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().loading).toBe(true);

    store.getState().applyEvent(changed('b'));
    await vi.advanceTimersByTimeAsync(400);
    // 전부 읽기가 아직 돌고 있다: 겹쳐 읽지 않는다
    expect(folderSummaries).toHaveBeenCalledTimes(2);

    release([summary('a'), summary('b'), summary('c')]);
    await full;
    expect(folderSummaries).toHaveBeenCalledTimes(3);
    expect(folderSummaries).toHaveBeenLastCalledWith(ID, [pathOf('b')]);
    expect(store.getState().loading).toBe(false);
  });

  it('전부 읽는 중에 다시 전부 읽으라고 하면 한 번 더 읽지 않고 그 읽기를 기다린다', async () => {
    const { store, folderSummaries } = await opened();
    const first = store.getState().refresh();
    const second = store.getState().refresh();
    await Promise.all([first, second]);
    expect(folderSummaries).toHaveBeenCalledTimes(2);
  });

  it('목록에 없는 저장소의 이벤트로는 읽지 않고, 부분 읽기가 실패하면 전부 다시 읽어 맞춘다', async () => {
    const { store, folderSummaries, folderBranches } = await opened();
    store.getState().applyEvent(changed('gone'));
    await vi.advanceTimersByTimeAsync(400);
    expect(folderSummaries).toHaveBeenCalledTimes(1);

    // 그사이 코어가 재스캔해 b 가 사라졌다: 부분 읽기는 거부되고, 전부 읽기로 맞춘다
    folderSummaries.mockImplementationOnce(async () => {
      throw new Error('이 폴더의 저장소가 아닙니다: /f/b');
    });
    store.getState().applyEvent(changed('b'));
    await vi.advanceTimersByTimeAsync(400);
    expect(folderSummaries.mock.calls.slice(1).map((call) => call[1])).toEqual([[pathOf('b')], []]);
    expect(folderBranches).toHaveBeenLastCalledWith(ID, []);
    expect(store.getState().error).toBeNull();
    expect(store.getState().summaries).toHaveLength(3);
  });

  it('ref 가 바뀐 이벤트는 저장소가 실려 와도 타임라인을 전체로 다시 읽는다 (열어 둔 때만)', async () => {
    const folderTimelineReload = vi.fn<IpcClient['folderTimelineReload']>(async () => {});
    const { store } = await opened({ folderTimelineReload });
    store.getState().applyEvent(changed('b', true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(folderTimelineReload).not.toHaveBeenCalled();

    await store.getState().openTimeline();
    store.getState().applyEvent(changed('b', true));
    store.getState().applyEvent(changed('a', true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(folderTimelineReload).toHaveBeenCalledTimes(1);
    expect(folderTimelineReload).toHaveBeenCalledWith(ID);
  });

  it('닫은 뒤에는 모아 둔 이벤트로 읽지 않는다', async () => {
    const { store, folderSummaries } = await opened();
    store.getState().applyEvent(changed('b'));
    store.getState().dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(folderSummaries).toHaveBeenCalledTimes(1);
  });
});
