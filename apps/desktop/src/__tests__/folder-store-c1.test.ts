import {
  type AutoFetchedRepo,
  type BatchResult,
  createNullClient,
  type IpcClient,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendAutoFetch,
  createFolderStore,
  TASK_HISTORY_CAPACITY,
  type TaskEntry,
} from '../store/folder-store';
import { type Notice, notifyHub } from '../store/notify';

const RESULT: BatchResult = {
  label: '일괄 fetch',
  results: [
    { path: '/f/a', name: 'a', ok: true, skipped: null, message: '' },
    { path: '/f/b', name: 'b', ok: true, skipped: '제외됨', message: '' },
  ],
  succeeded: 1,
  skipped: 1,
  failed: 0,
};

/** 일괄 작업·설정 호출을 기록하는 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    folderSummaries: vi.fn(async () => []),
    folderBatch: vi.fn(async () => RESULT),
    folderCommit: vi.fn(async () => RESULT),
    folderChanges: vi.fn(async () => []),
    folderSettings: vi.fn(async () => ({
      exclude: ['b'],
      pullMode: 'rebase' as const,
      concurrency: 2,
      autoRefreshSecs: 0,
      worktreeRoot: null,
    })),
    folderSettingsSet: vi.fn(async () => {}),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('FolderStore (C1 일괄 작업)', () => {
  it('선택한 저장소로 일괄 작업을 돌리고 진행·결과를 둔다', async () => {
    const c = client();
    // W12: 고른 저장소는 트리 선택 중 저장소 디렉터리라, 고를 저장소가 폴더의 저장소 목록에 있어야 한다
    const repos = ['/f/a', '/f/b'].map((path) => ({ path, kind: 'standalone' as const }));
    const store = createFolderStore({ session: 7, path: '/f', repos }, c);
    await tick();
    expect(store.getState().settings?.concurrency).toBe(2);
    store.getState().toggleSelect('/f/a');
    store.getState().toggleSelect('/f/b');
    store.getState().toggleSelect('/f/b');
    expect(store.getState().selectedRepos()).toEqual(['/f/a']);
    store.getState().applyEvent({
      type: 'operationStarted',
      session: 7,
      opId: 1,
      kind: 'batch',
      label: '일괄 fetch',
    });
    expect(store.getState().batchRunning).toBe(true);
    store.getState().applyEvent({
      type: 'operationProgress',
      session: 7,
      opId: 1,
      phase: 'a',
      percent: 50,
      message: '',
    });
    expect(store.getState().batchProgress).toEqual({
      label: '일괄 fetch',
      phase: 'a',
      percent: 50,
    });
    store.getState().applyEvent({
      type: 'operationFinished',
      session: 7,
      opId: 1,
      ok: true,
      cancelled: false,
      message: '',
      lockLeft: false,
    });
    expect(store.getState().batchRunning).toBe(false);
    const r = await store.getState().runBatch({ kind: 'fetch', prune: true });
    expect(c.folderBatch).toHaveBeenCalledWith(7, { kind: 'fetch', prune: true }, ['/f/a']);
    expect(r?.skipped).toBe(1);
    // 결과는 개요에 남지 않고 작업 기록에 시각과 함께 쌓인다
    const [entry] = store.getState().taskHistory;
    expect(entry).toMatchObject({
      kind: 'batch',
      label: '일괄 fetch',
      result: RESULT,
      error: null,
    });
    expect(entry?.finishedAt).toBeGreaterThanOrEqual(entry?.startedAt ?? Number.POSITIVE_INFINITY);
    store.getState().clearTaskHistory();
    expect(store.getState().taskHistory).toEqual([]);
  });

  it('재스캔 이벤트로 저장소 목록을 바꾸고, 설정 저장을 넘긴다', async () => {
    const c = client();
    const store = createFolderStore({ session: 7, path: '/f', repos: [] }, c);
    await tick();
    store.getState().applyEvent({
      type: 'folderRescanned',
      session: 7,
      repos: [{ path: '/f/c', kind: 'standalone' }],
    });
    expect(store.getState().repos.map((r) => r.path)).toEqual(['/f/c']);
    // 저장소 간 커밋 검색은 로그 필터 바의 텍스트·해시 필터가 맡는다 (W17. 옛 검색 API 는 W28 에서 지웠다 — 대응 테스트:
    // filter-bar-view.test.tsx·folder-log-filter.test.tsx)
    const next = {
      exclude: [],
      pullMode: 'merge' as const,
      concurrency: 8,
      autoRefreshSecs: 30,
      worktreeRoot: '/wt',
    };
    await store.getState().saveSettings(next);
    expect(c.folderSettingsSet).toHaveBeenCalledWith(7, next);
    expect(store.getState().settings).toEqual(next);
    const r = await store.getState().commitAll(['/f/a'], 'msg', true);
    expect(c.folderCommit).toHaveBeenCalledWith(7, ['/f/a'], 'msg', true);
    expect(r?.succeeded).toBe(1);
    // W14·W17: 개요의 "변경"·"검색" 보기는 Commit 도구 창·로그 필터 바로 옮겨 가 보기 전환 상태가 없다
    expect('view' in store.getState()).toBe(false);
  });
});

describe('폴더 설정 저장', () => {
  const opened = { session: 1, path: '/f', repos: [] };
  const settings = {
    exclude: ['a'],
    pullMode: 'ffOnly' as const,
    concurrency: 4,
    autoRefreshSecs: 60,
    worktreeRoot: null,
  };

  it('실패하면 false 와 오류를 남기고 설정을 바꾸지 않는다', async () => {
    const client: IpcClient = {
      ...createNullClient(),
      folderSettingsSet: async () => {
        throw { kind: 'internal', message: '쓰기 실패' };
      },
    };
    const store = createFolderStore(opened, client);
    await store.getState().loadSettings();
    const before = store.getState().settings;
    expect(await store.getState().saveSettings(settings)).toBe(false);
    expect(store.getState().error).toContain('쓰기 실패');
    expect(store.getState().settings).toBe(before);
  });

  it('성공하면 true 이고 이전 오류를 지운다', async () => {
    const store = createFolderStore(opened, createNullClient());
    store.setState({ error: '이전 오류' });
    expect(await store.getState().saveSettings(settings)).toBe(true);
    expect(store.getState().error).toBeNull();
    expect(store.getState().settings).toEqual(settings);
  });
});

describe('작업 기록 (일괄 작업·commit·자동 fetch)', () => {
  const opened = { session: 3, path: '/f', repos: [] };
  /** 자동 fetch 이벤트의 저장소 하나: ref 가 있으면 갱신, `error` 가 있으면 실패 */
  const fetched = (name: string, refs: string[], error?: string): AutoFetchedRepo => ({
    path: `/f/${name}`,
    name,
    refs,
    error: error ?? null,
  });
  /** 폴더 자동 fetch 이벤트를 보낸다 */
  const autoFetched = (store: ReturnType<typeof createFolderStore>, repos: AutoFetchedRepo[]) =>
    store.getState().applyEvent({ type: 'folderAutoFetched', session: 3, repos });

  afterEach(() => {
    vi.restoreAllMocks();
    notifyHub.setHandler(null);
  });

  it('실행하지 못한 일괄 작업은 작업 종류의 라벨과 사유로 남는다', async () => {
    const store = createFolderStore(opened, {
      ...createNullClient(),
      folderBatch: async () => {
        throw { kind: 'internal', message: '연결 실패' };
      },
    });
    expect(await store.getState().runBatch({ kind: 'pull' }, ['/f/a'])).toBeNull();
    const [entry] = store.getState().taskHistory;
    expect(entry).toMatchObject({
      kind: 'batch',
      label: S.folder.history.ops.pull,
      result: null,
    });
    expect(entry?.error).toContain('연결 실패');
  });

  it('이미 일괄 작업 중이라 부르지 않은 실행은 남기지 않는다', async () => {
    const store = createFolderStore(opened, {
      ...createNullClient(),
      folderBatch: async () => RESULT,
    });
    store.setState({ batchRunning: true });
    expect(await store.getState().runBatch({ kind: 'fetch', prune: true })).toBeNull();
    expect(store.getState().taskHistory).toEqual([]);
  });

  it('일괄 commit 은 성공이면 결과를, 실패면 사유를 commit 줄로 남긴다', async () => {
    let fail = false;
    const store = createFolderStore(opened, {
      ...createNullClient(),
      folderCommit: async () => {
        if (fail) {
          throw { kind: 'internal', message: '훅 실패' };
        }
        return { ...RESULT, label: '일괄 commit' };
      },
    });
    await store.getState().commitAll(['/f/a'], 'msg', false);
    fail = true;
    await store.getState().commitAll(['/f/a'], 'msg', false);
    const [failed, done] = store.getState().taskHistory;
    expect(done).toMatchObject({ kind: 'commit', label: '일괄 commit', error: null });
    expect(failed).toMatchObject({
      kind: 'commit',
      label: S.folder.history.ops.commit,
      result: null,
    });
    expect(failed?.error).toContain('훅 실패');
  });

  it(`최신이 앞이고 ${TASK_HISTORY_CAPACITY}개를 넘으면 오래된 줄을 버린다`, async () => {
    let n = 0;
    const store = createFolderStore(opened, {
      ...createNullClient(),
      folderBatch: async () => ({ ...RESULT, label: `run ${++n}` }),
    });
    for (let i = 0; i < TASK_HISTORY_CAPACITY + 1; i += 1) {
      await store.getState().runBatch({ kind: 'fetch', prune: true }, ['/f/a']);
    }
    const history = store.getState().taskHistory;
    expect(history).toHaveLength(TASK_HISTORY_CAPACITY);
    expect(history[0]?.label).toBe(`run ${TASK_HISTORY_CAPACITY + 1}`);
    expect(history.at(-1)?.label).toBe('run 2');
  });

  it('자동 fetch 는 바뀐 저장소·실패를 한 줄로 남기고, 바뀐 ref 가 있으면 저장소 탭과 같은 꼴로 알린다', () => {
    const notices: Notice[] = [];
    notifyHub.setHandler((n) => notices.push(n));
    const store = createFolderStore(opened, createNullClient());
    autoFetched(store, [
      fetched('api', ['origin/main', 'origin/dev']),
      { path: '/f/web', name: 'web', refs: [], error: 'auth failed' },
    ]);
    const [entry] = store.getState().taskHistory;
    expect(entry).toMatchObject({
      kind: 'autoFetch',
      label: S.folder.history.autoFetch,
      result: null,
      error: null,
    });
    expect(entry?.autoFetch).toEqual([
      fetched('api', ['origin/main', 'origin/dev']),
      fetched('web', [], 'auth failed'),
    ]);
    expect(notices).toEqual([
      {
        kind: 'info',
        title: S.notify.autoFetched(2),
        message: 'api: origin/main, api: origin/dev',
        os: true,
      },
    ]);
    // 실패만 있으면 알리지 않는다 (기록에만 남는다)
    autoFetched(store, [fetched('web', [], 'auth failed')]);
    expect(notices).toHaveLength(1);
  });

  it('바뀐 ref 없이 같은 저장소의 실패만 이어지면 새 줄 대신 그 줄의 시각과 반복 수만 바꾼다', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = createFolderStore(opened, createNullClient());
    autoFetched(store, [fetched('web', [], 'auth failed'), fetched('api', [], 'timeout')]);
    now.mockReturnValue(2_000);
    autoFetched(store, [fetched('api', [], 'timeout again'), fetched('web', [], 'auth failed')]);
    let history = store.getState().taskHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ startedAt: 1_000, finishedAt: 2_000, repeat: 2 });
    expect(history[0]?.autoFetch?.[0]?.error).toBe('timeout again');

    // 실패한 저장소가 다르면 새 줄이다
    now.mockReturnValue(3_000);
    autoFetched(store, [fetched('web', [], 'auth failed')]);
    history = store.getState().taskHistory;
    expect(history.map((e) => e.repeat ?? 1)).toEqual([1, 2]);
  });

  it('바뀐 ref 가 있는 자동 fetch 는 합치지 않고, 그 뒤의 같은 실패도 새 줄이다', () => {
    const store = createFolderStore(opened, createNullClient());
    autoFetched(store, [fetched('web', [], 'auth failed')]);
    autoFetched(store, [fetched('web', [], 'auth failed'), fetched('api', ['origin/main'])]);
    autoFetched(store, [fetched('web', [], 'auth failed')]);
    expect(store.getState().taskHistory.map((e) => e.repeat ?? 1)).toEqual([1, 1, 1]);
  });

  it('합치는 자동 fetch 줄은 그사이 다른 작업이 있었어도 맨 위로 올라온다', async () => {
    const store = createFolderStore(opened, {
      ...createNullClient(),
      folderBatch: async () => RESULT,
    });
    autoFetched(store, [fetched('web', [], 'auth failed')]);
    await store.getState().runBatch({ kind: 'fetch', prune: true }, ['/f/a']);
    autoFetched(store, [fetched('web', [], 'auth failed')]);
    const history = store.getState().taskHistory;
    expect(history.map((e) => [e.kind, e.repeat ?? 1])).toEqual([
      ['autoFetch', 2],
      ['batch', 1],
    ]);
  });

  it('appendAutoFetch 는 합치지 않을 때 상한을 지킨다', () => {
    const entry = (id: number, repos: AutoFetchedRepo[]): TaskEntry => ({
      id,
      kind: 'autoFetch',
      label: 'auto',
      startedAt: id,
      finishedAt: id,
      result: null,
      error: null,
      autoFetch: repos,
    });
    const history = [
      entry(2, [fetched('a', ['origin/x'])]),
      entry(1, [fetched('b', ['origin/y'])]),
    ];
    const next = appendAutoFetch(history, entry(3, [fetched('c', ['origin/z'])]), 2);
    expect(next.map((e) => e.id)).toEqual([3, 2]);
  });
});
