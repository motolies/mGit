import {
  createNullClient,
  emptyRepoState,
  type IpcClient,
  type RepoOpened,
  type SessionEvent,
} from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import { readPref, removePref, writePref } from '../store/prefs';
import { clearSessionRegistry, getFolderStore } from '../store/session-registry';
import { PREF_TAB_PARENTS } from '../store/tab-order';

const HEAD = 'a'.repeat(40);

/** 경로별 응답을 정하는 가짜 클라이언트. `fail` 의 경로는 열기에 실패한다 */
function client(
  opts: { folders?: string[]; tabs?: string[]; startup?: string[]; fail?: string[] } = {},
) {
  let next = 1;
  const opened = (path: string): RepoOpened => ({
    session: next++,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: path,
      gitDir: `${path}/.git`,
      commonDir: `${path}/.git`,
      objectFormat: 'sha1',
      head: { state: 'attached', branch: 'main', oid: HEAD },
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState({ state: 'attached', branch: 'main', oid: HEAD }),
  });
  let cloneEvents: ((e: SessionEvent) => void) | null = null;
  const c: IpcClient & { cloneEvents: () => (e: SessionEvent) => void } = {
    ...createNullClient(),
    gitVersion: async () => ({ version: '2.54.0', path: '/usr/bin/git' }),
    openRepo: vi.fn(async (path: string) => {
      if (opts.fail?.includes(path)) {
        throw new Error(`cannot open ${path}`);
      }
      if (opts.folders?.includes(path)) {
        throw { kind: 'multiRepoFolder', path, repos: [`${path}/a`, `${path}/b`] };
      }
      return opened(path);
    }),
    openFolder: vi.fn(async (path: string) => ({
      session: next++,
      path,
      repos: [
        { path: `${path}/a`, kind: 'standalone' as const },
        { path: `${path}/b`, kind: 'worktree' as const },
      ],
    })),
    folderSummaries: vi.fn(async () => []),
    closeFolder: vi.fn(async () => {}),
    closeRepo: vi.fn(async () => {}),
    openTabsGet: vi.fn(async () => opts.tabs ?? []),
    openTabsSet: vi.fn(async () => {}),
    takeStartupPaths: vi.fn(async () => opts.startup ?? []),
    cloneRepo: vi.fn(async (req: { dest: string }, onEvent: (e: SessionEvent) => void) => {
      cloneEvents = onEvent;
      onEvent({ type: 'operationStarted', session: 0, opId: 9, kind: 'clone', label: 'clone x' });
      onEvent({
        type: 'operationProgress',
        session: 0,
        opId: 9,
        phase: 'Receiving objects',
        percent: 40,
        message: '',
      });
      onEvent({
        type: 'operationFinished',
        session: 0,
        opId: 9,
        ok: true,
        cancelled: false,
        message: '',
        lockLeft: false,
      });
      return req.dest;
    }),
    cloneEvents: () => cloneEvents ?? (() => {}),
  };
  return c;
}

/** 스토어 */
function setup(opts?: Parameters<typeof client>[0]) {
  const c = client(opts);
  const store = createAppStore({ client: c, pickDirectory: async () => null });
  return { store, client: c };
}

afterEach(() => {
  clearSessionRegistry();
  removePref(PREF_TAB_PARENTS);
});

describe('AppStore (S5)', () => {
  it('멀티 저장소 폴더는 폴더 탭으로 열리고, 닫으면 하위 탭도 닫힌다', async () => {
    const { store, client: c } = setup({ folders: ['/f'] });
    await store.getState().openRepositoryAt('/f');
    const folderId = store.getState().activeSessionId;
    expect(folderId).not.toBeNull();
    expect(store.getState().sessions[folderId ?? -1]?.kind).toBe('folder');
    expect(getFolderStore(folderId ?? -1)).toBeDefined();
    expect(c.openFolder).toHaveBeenCalledWith('/f', expect.any(Function));

    await store.getState().openRepositoryAt('/f/a', folderId);
    const childId = store.getState().activeSessionId;
    expect(store.getState().sessions[childId ?? -1]?.parent).toBe(folderId);
    expect(c.openTabsSet).toHaveBeenLastCalledWith(['/f', '/f/a']);

    await store.getState().closeSession(folderId ?? -1);
    expect(store.getState().sessionOrder).toEqual([]);
    expect(c.closeRepo).toHaveBeenCalledWith(childId);
    expect(c.closeFolder).toHaveBeenCalledWith(folderId);
    expect(getFolderStore(folderId ?? -1)).toBeUndefined();
  });

  it('bootstrap 이 저장된 탭과 시작 인자를 차례로 연다', async () => {
    const { store, client: c } = setup({ tabs: ['/r1', '/r2'], startup: ['/r3'] });
    await store.getState().bootstrap();
    const paths = store.getState().sessionOrder.map((id) => store.getState().sessions[id]?.path);
    expect(paths).toEqual(['/r1', '/r2', '/r3']);
    expect(c.subscribeAppEvents).toBeDefined();
  });

  it('clone 은 진행 이벤트를 cloneOp 로 보여 주고 끝나면 연다', async () => {
    const { store } = setup();
    const seen: (number | null)[] = [];
    const unsub = store.subscribe((s) => {
      if (s.cloneOp) {
        seen.push(s.cloneOp.percent);
      }
    });
    const ok = await store.getState().cloneRepository({
      url: 'u',
      dest: '/dest',
      branch: null,
      recurseSubmodules: false,
      depth: null,
      blobless: false,
      singleBranch: false,
    });
    unsub();
    expect(ok).toBe(true);
    expect(seen).toContain(40);
    expect(store.getState().cloneOp).toBeNull();
    const id = store.getState().activeSessionId;
    expect(store.getState().sessions[id ?? -1]?.path).toBe('/dest');
  });
});

describe('저장소 탭 세트 (순서·재시작 유지)', () => {
  /** 열린 탭의 경로를 순서대로 */
  const pathsOf = (store: ReturnType<typeof setup>['store']) =>
    store.getState().sessionOrder.map((id) => store.getState().sessions[id]?.path);
  /** 경로로 탭 메타를 찾는다 */
  const metaOf = (store: ReturnType<typeof setup>['store'], path: string) =>
    Object.values(store.getState().sessions).find((m) => m.path === path);

  it('폴더 → 독립 저장소 → 폴더의 하위 저장소 순으로 열면 하위 탭이 폴더 세트 끝에 붙어 저장된다', async () => {
    const { store, client: c } = setup({ folders: ['/f'] });
    await store.getState().openRepositoryAt('/f');
    const folderId = store.getState().activeSessionId;
    await store.getState().openRepositoryAt('/r');
    await store.getState().openRepositoryAt('/f/a', folderId);
    expect(pathsOf(store)).toEqual(['/f', '/f/a', '/r']);
    expect(c.openTabsSet).toHaveBeenLastCalledWith(['/f', '/f/a', '/r']);
    expect(readPref(PREF_TAB_PARENTS, {})).toEqual({ '/f/a': '/f' });

    // 닫으면 맵을 지금 열린 탭으로 새로 써서 지난 항목이 남지 않는다
    await store.getState().closeSession(folderId ?? -1);
    expect(pathsOf(store)).toEqual(['/r']);
    expect(readPref(PREF_TAB_PARENTS, {})).toEqual({});
  });

  it('콜드 스타트 복원에서 하위 탭의 parent 가 부모 폴더 탭의 세션으로 이어진다', async () => {
    writePref(PREF_TAB_PARENTS, { '/f/a': '/f' });
    const { store } = setup({ folders: ['/f'], tabs: ['/f', '/f/a', '/r'] });
    await store.getState().bootstrap();
    expect(pathsOf(store)).toEqual(['/f', '/f/a', '/r']);
    const folder = metaOf(store, '/f');
    expect(folder?.kind).toBe('folder');
    expect(metaOf(store, '/f/a')?.parent).toBe(folder?.id);
    expect(metaOf(store, '/r')?.parent).toBeNull();
  });

  it('부모 경로를 열지 못하면 하위 탭은 독립 탭으로 복원된다', async () => {
    writePref(PREF_TAB_PARENTS, { '/f/a': '/f' });
    const { store } = setup({ fail: ['/f'], tabs: ['/f', '/f/a', '/r'] });
    await store.getState().bootstrap();
    expect(pathsOf(store)).toEqual(['/f/a', '/r']);
    expect(metaOf(store, '/f/a')?.parent).toBeNull();
  });

  it('시작 인자는 저장된 부모 맵이 있어도 독립 탭으로 연다', async () => {
    writePref(PREF_TAB_PARENTS, { '/f/b': '/f' });
    const { store } = setup({ folders: ['/f'], tabs: ['/f'], startup: ['/f/b'] });
    await store.getState().bootstrap();
    expect(pathsOf(store)).toEqual(['/f', '/f/b']);
    expect(metaOf(store, '/f/b')?.parent).toBeNull();
  });
});
