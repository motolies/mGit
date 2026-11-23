import {
  createNullClient,
  emptyRepoState,
  type IpcClient,
  type RepoOpened,
  type SessionEvent,
} from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import { clearSessionRegistry, getFolderStore } from '../store/session-registry';

const HEAD = 'a'.repeat(40);

/** 경로별 응답을 정하는 가짜 클라이언트 */
function client(opts: { folders?: string[]; tabs?: string[]; startup?: string[] } = {}) {
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
