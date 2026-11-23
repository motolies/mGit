import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type PushSpec,
  type RepoOpened,
  type StashEntry,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const STASH = 'c'.repeat(40);

const ENTRY: StashEntry = {
  info: {
    index: 0,
    oid: STASH,
    base: HEAD,
    message: 'WIP on main: 작업 중',
    time: 1,
    includesUntracked: true,
    branch: 'main',
  },
  origin: '/r',
};

/** 동기화·스태시·워크트리 호출을 기록하는 가짜 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    push: vi.fn(async (_s, spec: PushSpec) => {
      if (!spec.forceWithLease) {
        throw {
          kind: 'gitFailed',
          args: ['push'],
          status: 1,
          stderr: 'rejected',
          hint: { kind: 'nonFastForward' },
        };
      }
    }),
    pull: vi.fn(async () => {}),
    listStashes: vi.fn(async () => [ENTRY]),
    stashFiles: vi.fn(async () => [
      { path: 'f.txt', oldPath: null, change: { kind: 'modified' as const } },
    ]),
    worktreeAdd: vi.fn(async (_s, path: string) => path),
    worktreeRemoveCheck: vi.fn(async (_s, path: string) => ({
      path,
      branch: 'feat',
      dirty: true,
      unpushed: 2,
      isMain: false,
    })),
  };
}

/** 스토어 하나 */
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

describe('SessionStore (S4)', () => {
  it('push 가 non-fast-forward 로 거부되면 힌트 대화상자로, force-with-lease 면 통과', async () => {
    const { store, client: c } = setup();
    await store.getState().push();
    expect(store.getState().pendingHint).toMatchObject({ kind: 'nonFastForward' });
    expect(store.getState().actionError).toBeNull();
    store.getState().dismissHint();
    await store.getState().push({ forceWithLease: true });
    expect(c.push).toHaveBeenLastCalledWith(1, {
      remote: null,
      setUpstream: false,
      tags: false,
      forceWithLease: true,
      confirmUpstreamMismatch: false,
      rememberUpstreamMismatch: false,
    });
    expect(store.getState().pendingHint).toBeNull();

    // 원격을 고르면 그대로 코어에 전달한다 (RM-04 원격 선택)
    await store.getState().push({ remote: 'fork', setUpstream: true });
    expect(c.push).toHaveBeenLastCalledWith(1, {
      remote: 'fork',
      setUpstream: true,
      tags: false,
      forceWithLease: false,
      confirmUpstreamMismatch: false,
      rememberUpstreamMismatch: false,
    });
  });

  it('pull 은 고른 모드로 호출된다', async () => {
    const { store, client: c } = setup();
    store.getState().setPullMode('rebase');
    await store.getState().pull();
    expect(c.pull).toHaveBeenCalledWith(1, 'rebase');
  });

  it('refsChanged 가 stash 목록을 다시 읽고, selectStash 가 파일을 읽는다. 스태시 보기와 로그 선택은 서로를 비우지 않는다 (W23)', async () => {
    const { store, client: c } = setup();
    const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
    store.getState().applyEvent({
      type: 'refsChanged',
      session: 1,
      refs: emptyRepoState(head).refs,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.listStashes).toHaveBeenCalled();
    expect(store.getState().stashes).toEqual([ENTRY]);

    // W23 전에는 스태시를 고르면 커밋 선택이, 커밋·WIP 를 고르면 스태시 보기가 비었다 (같은 상세 칸을 번갈아 썼다).
    // 스태시 상세가 Commit 도구 창의 Stash 탭으로 옮겨 가 둘은 독립이다
    store.getState().selectCommit(HEAD);
    await store.getState().selectStash(ENTRY);
    expect(store.getState().selectedCommit).toBe(HEAD);
    expect(store.getState().stashView?.files.map((f) => f.path)).toEqual(['f.txt']);
    store.getState().selectWip();
    expect(store.getState().wipSelected).toBe(true);
    expect(store.getState().stashView?.entry).toEqual(ENTRY);
    store.getState().selectCommit(HEAD);
    expect(store.getState().stashView?.entry).toEqual(ENTRY);
  });

  it('워크트리 생성·삭제 검사 결과를 돌려준다', async () => {
    const { store } = setup();
    const created = await store
      .getState()
      .worktreeAdd('/w/x', { kind: 'newBranch', name: 'x', start: null });
    expect(created).toBe('/w/x');
    const check = await store.getState().worktreeRemoveCheck('/w/x');
    expect(check?.dirty).toBe(true);
    expect(check?.unpushed).toBe(2);
    expect(store.getState().busy).toBe(false);
  });
});
