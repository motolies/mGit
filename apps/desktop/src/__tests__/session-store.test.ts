import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type GraphWindow,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore, headBranchOf, opLabel } from '../store/session-store';

/** 빈 창을 돌려주는 가짜 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    gitVersion: vi.fn(async () => ({ version: '2.54.0', path: 'git' })),
    openRepo: vi.fn(),
    graphWindow: vi.fn(
      async (_s, start): Promise<GraphWindow> => ({
        generation: 1,
        start,
        totalRows: 0,
        finished: true,
        laneCount: 0,
        rows: [],
        segments: [],
        edges: [],
        stubs: [],
      }),
    ),
    findRow: vi.fn(async (_s, oid: string) => (oid === 'x'.repeat(40) ? 7 : null)),
    repoState: vi.fn(),
    refreshRepo: vi.fn(async () => {}),
    reloadGraph: vi.fn(async () => {}),
    cancelOperation: vi.fn(async (id: number) => id === 1),
    commandLogRecent: vi.fn(async () => []),
    closeRepo: vi.fn(async () => {}),
  };
}

/** 세션 스토어 하나 */
function setup() {
  const head = { state: 'attached' as const, branch: 'main', oid: 'a'.repeat(40) };
  const opened: RepoOpened = {
    session: 3,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '/tmp/repo',
      gitDir: '/tmp/repo/.git',
      commonDir: '/tmp/repo/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState(head),
  };
  const c = client();
  const cache = new GraphRangeCache({ fetchWindow: (s, n) => c.graphWindow(3, s, n) });
  const store = createSessionStore(opened, c, cache);
  return { store, cache, client: c };
}

describe('SessionStore', () => {
  it('초기 상태는 open_repo 응답에서 온다', () => {
    const { store } = setup();
    const s = store.getState();
    expect(s.id).toBe(3);
    expect(s.name).toBe('repo');
    expect(headBranchOf(s.refs)).toBe('main');
    expect(s.loadState).toBe('opening');
    expect(s.op).toBeNull();
  });

  it('graphReloaded 는 캐시 세대를 올리고 reloading 을 끝낸다', () => {
    const { store, cache } = setup();
    const invalidated = vi.fn();
    cache.subscribeInvalidation(invalidated);
    store.getState().applyEvent({ type: 'graphLoadStarted', session: 3, generation: 1 });
    store.getState().applyEvent({
      type: 'graphLoadFinished',
      session: 3,
      generation: 1,
      rows: 10,
      laneCount: 1,
      elapsedMs: 1,
      commitGraphSuggested: false,
    });
    expect(invalidated).toHaveBeenCalledTimes(1);
    // 로드가 끝난 뒤의 Progress 는 재로드 중 세대 혼선을 막기 위해 무시한다
    store.getState().applyEvent({ type: 'graphProgress', session: 3, generation: 2, rows: 3 });
    expect(store.getState().totalRows).toBe(10);

    void store.getState().reloadGraph();
    expect(store.getState().reloading).toBe(true);
    store.getState().applyEvent({
      type: 'graphReloaded',
      session: 3,
      generation: 2,
      rows: 11,
      laneCount: 2,
    });
    expect(store.getState().reloading).toBe(false);
    expect(store.getState().generation).toBe(2);
    expect(store.getState().totalRows).toBe(11);
    expect(cache.getTotalRows()).toBe(11);
    expect(cache.getGeneration()).toBe(2);
    expect(invalidated).toHaveBeenCalledTimes(2);

    store.getState().applyEvent({ type: 'graphReloadFailed', session: 3, message: 'boom' });
    expect(store.getState().reloadError).toContain('boom');
  });

  it('status·refs 이벤트와 진행 중 작업 라벨', () => {
    const { store } = setup();
    const status = emptyRepoState({
      state: 'attached',
      branch: 'main',
      oid: 'a'.repeat(40),
    }).status;
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 3,
      status: { ...status, summary: { ...status.summary, staged: 2 } },
      op: {
        kind: 'rebase',
        interactive: false,
        headName: 'feature',
        onto: null,
        step: 1,
        total: 3,
      },
    });
    expect(store.getState().status.summary.staged).toBe(2);
    expect(opLabel(store.getState().op)).toBe('REBASING 2/3');
    expect(opLabel({ kind: 'merge', head: 'b'.repeat(40) })).toBe('MERGING');
    expect(opLabel(null)).toBeNull();

    store.getState().applyEvent({
      type: 'refsChanged',
      session: 3,
      refs: {
        head: { state: 'detached', oid: 'c'.repeat(40) },
        labels: [],
        stashes: [],
        worktrees: [],
        remotes: [],
      },
    });
    expect(headBranchOf(store.getState().refs)).toBeNull();
  });

  it('장시간 명령 이벤트와 명령 로그', async () => {
    const { store, client: c } = setup();
    store.getState().applyEvent({
      type: 'operationStarted',
      session: 3,
      opId: 1,
      kind: 'fetch',
      label: 'fetch origin',
    });
    store.getState().applyEvent({
      type: 'operationProgress',
      session: 3,
      opId: 1,
      phase: 'Receiving objects',
      percent: 42,
      message: '',
    });
    store.getState().applyEvent({
      type: 'operationOutput',
      session: 3,
      opId: 1,
      stderr: true,
      text: 'remote: hi',
    });
    expect(store.getState().operations[1]?.percent).toBe(42);
    expect(store.getState().operations[1]?.output).toEqual(['!remote: hi']);
    expect(await store.getState().cancelOperation(1)).toBe(true);
    expect(c.cancelOperation).toHaveBeenCalledWith(1);
    store.getState().applyEvent({
      type: 'operationFinished',
      session: 3,
      opId: 1,
      ok: false,
      cancelled: true,
      message: '',
      lockLeft: false,
    });
    expect(store.getState().operations[1]?.done).toBe(true);
    expect(store.getState().operations[1]?.cancelled).toBe(true);
    store.getState().dismissOperation(1);
    expect(store.getState().operations[1]).toBeUndefined();
    expect(store.getState().operationOrder).toEqual([]);

    for (let i = 0; i < 505; i++) {
      store.getState().applyEvent({
        type: 'commandLogged',
        session: 3,
        record: {
          id: i,
          args: ['status'],
          cwd: '/tmp/repo',
          startedAt: i,
          elapsedMs: 1,
          status: 0,
          stderrTail: '',
          isWrite: false,
          cancelled: false,
        },
      });
    }
    expect(store.getState().log).toHaveLength(500);
    expect(store.getState().log[0]?.id).toBe(504);
  });

  it('resolveRow 는 실패해도 null 을 돌려준다', async () => {
    const { store } = setup();
    expect(await store.getState().resolveRow('x'.repeat(40))).toBe(7);
    expect(await store.getState().resolveRow('nope')).toBeNull();
  });
});

describe('취소 가능한 커밋 이동', () => {
  it('대상 부재와 조회 실패를 구분하고 필터를 바꾸지 않는다', async () => {
    const { store, client } = setup();
    const query = store.getState().graphQuery;
    expect(await store.getState().jumpToCommit('missing')).toBe('missing');
    vi.mocked(client.findRow).mockRejectedValueOnce(new Error('offline'));
    expect(await store.getState().jumpToCommit('missing')).toBe('failed');
    expect(store.getState().graphQuery).toBe(query);
  });

  it('늦은 조회가 완료돼도 취소된 이동은 선택과 스크롤을 바꾸지 않는다', async () => {
    const { store, client } = setup();
    let finish!: (row: number) => void;
    vi.mocked(client.findRow).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const result = store.getState().jumpToCommit('target', controller.signal);
    controller.abort();
    finish(3);
    expect(await result).toBe('cancelled');
    expect(store.getState().selectedCommit).toBeNull();
    expect(store.getState().scrollToRow).toBeNull();
  });
});

describe('원격 커밋 메시지 수정 보호', () => {
  const oid = 'a'.repeat(40);
  const published = {
    timedOut: false,
    head: true,
    branches: [
      { name: 'refs/remotes/other/main', shortName: 'other/main', remote: true, current: false },
    ],
  };

  it('다른 원격 브랜치에 포함된 조상 커밋도 쓰기 호출 전에 차단한다', async () => {
    const { store, client } = setup();
    client.commitContainingRefs = vi.fn(async () => published);
    client.rewordCommit = vi.fn(async () => 'clean' as const);
    await store.getState().rewordCommit(oid, 'changed');
    expect(client.rewordCommit).not.toHaveBeenCalled();
    expect(store.getState().actionError).toBe(S.shortcuts.rewordPublished);
  });

  it('창을 연 뒤 원격 상태가 바뀌어도 제출 때 새로 조회한다', async () => {
    const { store, client } = setup();
    client.commitContainingRefs = vi
      .fn()
      .mockResolvedValueOnce({ timedOut: false, head: true, branches: [] })
      .mockResolvedValueOnce(published);
    client.rewordCommit = vi.fn(async () => 'clean' as const);
    expect(await store.getState().checkRewordAllowed(oid)).toBe(true);
    await store.getState().rewordCommit(oid, 'changed');
    expect(client.commitContainingRefs).toHaveBeenCalledTimes(2);
    expect(client.rewordCommit).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'error'])(
    '원격 포함 조회 %s는 미발행으로 취급하지 않는다',
    async (failure) => {
      const { store, client } = setup();
      client.commitContainingRefs =
        failure === 'error'
          ? vi.fn(async () => {
              throw new Error('offline');
            })
          : vi.fn(async () => ({ timedOut: true, head: false, branches: [] }));
      client.rewordCommit = vi.fn(async () => 'clean' as const);
      await store.getState().rewordCommit(oid, 'changed');
      expect(client.rewordCommit).not.toHaveBeenCalled();
      expect(store.getState().actionError).toBe(S.shortcuts.rewordRemoteUnknown);
    },
  );

  it('로컬 브랜치에만 포함된 미발행 커밋은 허용한다', async () => {
    const { store, client } = setup();
    client.commitContainingRefs = vi.fn(async () => ({
      timedOut: false,
      head: true,
      branches: [{ name: 'refs/heads/main', shortName: 'main', remote: false, current: true }],
    }));
    expect(await store.getState().checkRewordAllowed(oid)).toBe(true);
  });
});
