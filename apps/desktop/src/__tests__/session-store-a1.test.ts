import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);

/** undo·백업·힌트를 흉내 내는 클라이언트 */
function client(): IpcClient {
  let undone = false;
  return {
    ...createNullClient(),
    undoState: vi.fn(async () => ({
      entries: undone ? [] : [{ id: 1, label: 'reset --hard', at: 1, changed: 1 }],
      redoCount: undone ? 1 : 0,
    })),
    undo: vi.fn(async () => {
      undone = true;
      return { entry: { id: 1, label: 'reset --hard', at: 1, changed: 1 }, skipped: [] };
    }),
    backups: vi.fn(async () => [
      { name: 'refs/mgit/backup/main/1', branch: 'main', oid: HEAD, createdAt: 1 },
    ]),
    stashPush: vi.fn(async () => {}),
    commit: vi.fn(async () => {
      throw {
        kind: 'gitFailed',
        args: ['commit'],
        status: 1,
        stderr: 'pre-commit hook failed',
        hint: { kind: 'hookFailed' },
      };
    }),
    push: vi.fn(async () => {
      throw {
        kind: 'gitFailed',
        args: ['push'],
        status: 128,
        stderr: 'has no upstream branch',
        hint: { kind: 'noUpstream' },
      };
    }),
    reflog: vi.fn(async (_s, reference: string | null) => [
      { selector: `${reference ?? 'HEAD'}@{0}`, oid: HEAD, subject: 'commit: x', time: 1 },
    ]),
  };
}

/** 스토어 */
function setup() {
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
  const c = client();
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, c, cache), client: c };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SessionStore (A1 안전장치)', () => {
  it('열면 undo 스택·백업을 읽고, undo 뒤 다시 읽는다', async () => {
    const { store, client: c } = setup();
    await flush();
    expect(store.getState().undoState.entries[0]?.label).toBe('reset --hard');
    expect(store.getState().backups[0]?.branch).toBe('main');
    await store.getState().undo();
    expect(c.undo).toHaveBeenCalledWith(1);
    expect(store.getState().undoState.entries).toEqual([]);
    expect(store.getState().undoState.redoCount).toBe(1);
  });

  it('호출자가 다루지 않은 힌트는 기본 대화상자로 간다 (SF-05)', async () => {
    const { store } = setup();
    await store.getState().push();
    expect(store.getState().pendingHint).toMatchObject({ kind: 'noUpstream' });
    expect(store.getState().actionError).toBeNull();
    store.getState().dismissHint();
    store.getState().setCommitMessage('msg');
    await store.getState().commit();
    // commit 은 run() 을 거치지 않아 commitError 로 간다 (힌트 대화상자는 HintDialogs 가 hook 재시도)
    expect(store.getState().commitError).toContain('hook');
  });

  it('stash 는 staged 만 옵션을 넘기고, reflog 는 ref 를 넘긴다', async () => {
    const { store, client: c } = setup();
    await store.getState().stashPush('m', false, true, []);
    expect(c.stashPush).toHaveBeenCalledWith(1, 'm', false, true, []);
    store.getState().setReflogOpen(true);
    await flush();
    expect(store.getState().reflog[0]?.selector).toBe('HEAD@{0}');
    await store.getState().loadReflog('main');
    expect(c.reflog).toHaveBeenLastCalledWith(1, 'main', 500);
  });
});
