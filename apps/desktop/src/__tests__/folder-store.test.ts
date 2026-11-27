import { createNullClient, type IpcClient, type RepoSummary } from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { FOCUS_REFRESH_GAP_MS } from '../store/focus-refresh';
import { autoRefreshMs, createFolderStore, visibleSummaries } from '../store/folder-store';

/** 요약 한 줄 */
function summary(partial: Partial<RepoSummary> & { name: string }): RepoSummary {
  return {
    path: `/f/${partial.name}`,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
    ...partial,
  };
}

describe('visibleSummaries', () => {
  const rows = [
    summary({ name: 'b', changed: 2 }),
    summary({ name: 'a' }),
    summary({ name: 'c', behind: 3, op: 'merge' }),
  ];

  it('필터·정렬을 적용한다', () => {
    expect(visibleSummaries([...rows], 'all', 'name').map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(visibleSummaries([...rows], 'changed', 'name').map((r) => r.name)).toEqual(['b']);
    expect(visibleSummaries([...rows], 'behind', 'name').map((r) => r.name)).toEqual(['c']);
    expect(visibleSummaries([...rows], 'inProgress', 'name').map((r) => r.name)).toEqual(['c']);
    expect(visibleSummaries([...rows], 'all', 'changed').map((r) => r.name)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(visibleSummaries([...rows], 'all', 'behind').map((r) => r.name)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('보낼 것 있음·업스트림 없음·stash 있음 필터와 stash 수 정렬 (셋째 묶음 K)', () => {
    const list = [
      summary({ name: 'push', ahead: 2, behind: 0, stashCount: 1 }),
      summary({ name: 'synced', ahead: 0, behind: 4 }),
      // 업스트림이 없는 branch (ahead 가 비어 있다)
      summary({ name: 'fresh', stashCount: 3 }),
      // 분리 HEAD·상태를 못 읽은 줄은 업스트림 없음에 들지 않는다
      summary({ name: 'detached', branch: null, detached: true }),
      summary({ name: 'broken', branch: null, error: 'x' }),
      summary({ name: 'unborn-error', branch: 'main', error: 'x' }),
    ];
    const names = (filter: Parameters<typeof visibleSummaries>[1], sort: 'name' | 'stash') =>
      visibleSummaries([...list], filter, sort).map((r) => r.name);
    expect(names('ahead', 'name')).toEqual(['push']);
    expect(names('noUpstream', 'name')).toEqual(['fresh']);
    expect(names('stashed', 'name')).toEqual(['fresh', 'push']);
    expect(names('all', 'stash')).toEqual([
      'fresh',
      'push',
      'broken',
      'detached',
      'synced',
      'unborn-error',
    ]);
  });
});

describe('FolderStore', () => {
  it('열면 요약을 읽고, folderChanged 가 몰려도 한 번만 다시 읽는다', async () => {
    vi.useFakeTimers();
    const client: IpcClient = {
      ...createNullClient(),
      folderSummaries: vi.fn(async () => [summary({ name: 'a' })]),
    };
    const store = createFolderStore({ session: 7, path: '/f', repos: [] }, client);
    await vi.runAllTimersAsync();
    expect(client.folderSummaries).toHaveBeenCalledTimes(1);
    expect(store.getState().summaries.map((s) => s.name)).toEqual(['a']);
    expect(store.getState().name).toBe('f');

    store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: false });
    store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: false });
    await vi.runAllTimersAsync();
    expect(client.folderSummaries).toHaveBeenCalledTimes(2);

    store.getState().dispose();
    store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: false });
    await vi.runAllTimersAsync();
    expect(client.folderSummaries).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('창 포커스·주기 재조회 (MR-03)', () => {
  /** 요약 호출 수를 세는 폴더 스토어. 열자마자 한 번 읽는 것까지 끝낸 상태로 준다 */
  async function setup(autoRefreshSecs: number | null) {
    vi.useFakeTimers();
    const client: IpcClient = {
      ...createNullClient(),
      folderSummaries: vi.fn(async () => [summary({ name: 'a' })]),
      folderSettings: vi.fn(async () => {
        if (autoRefreshSecs === null) {
          throw new Error('설정 없음');
        }
        return {
          exclude: [],
          pullMode: 'ffOnly' as const,
          concurrency: 4,
          autoRefreshSecs,
          worktreeRoot: null,
        };
      }),
    };
    const store = createFolderStore({ session: 7, path: '/f', repos: [] }, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.folderSummaries).toHaveBeenCalledTimes(1);
    return { store, calls: () => (client.folderSummaries as ReturnType<typeof vi.fn>).mock.calls };
  }

  it('간격은 폴더 설정의 초 단위 값을 따르고, 설정을 못 읽었으면 60초, 0 이면 끈다', () => {
    expect(autoRefreshMs(null)).toBe(60_000);
    expect(autoRefreshMs({ autoRefreshSecs: 15 })).toBe(15_000);
    expect(autoRefreshMs({ autoRefreshSecs: 0 })).toBe(0);
  });

  it('켜 둔 동안 창이 포커스를 받으면 요약을 다시 읽고, 끄면 더 읽지 않는다', async () => {
    const { store, calls } = await setup(0);
    // 켜기 전에는 포커스에 반응하지 않는다 (화면이 떠 있을 때만 돈다)
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(1);

    const stop = store.getState().startAutoRefresh();
    // 열 때 막 읽었으므로 포커스 갱신 간격(G4)이 지난 뒤의 포커스다
    await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_GAP_MS);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(2);
    expect(store.getState().refreshedAt).not.toBeNull();

    stop();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(2);
    vi.useRealTimers();
  });

  it('설정의 간격마다 다시 읽고, 끄면 타이머도 멈춘다', async () => {
    const { store, calls } = await setup(30);
    const stop = store.getState().startAutoRefresh();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls()).toHaveLength(3);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toHaveLength(3);
    vi.useRealTimers();
  });

  it('설정을 못 읽었으면 60초마다 읽고, 간격이 0 이면 주기 재조회를 하지 않는다', async () => {
    const fallback = await setup(null);
    const stopFallback = fallback.store.getState().startAutoRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fallback.calls()).toHaveLength(2);
    stopFallback();

    const off = await setup(0);
    const stopOff = off.store.getState().startAutoRefresh();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(off.calls()).toHaveLength(1);
    stopOff();
    vi.useRealTimers();
  });

  it('켜 둔 동안 설정의 간격이 바뀌면 새 간격으로 다시 맞춘다', async () => {
    const { store, calls } = await setup(30);
    const stop = store.getState().startAutoRefresh();
    const settings = store.getState().settings;
    if (!settings) {
      throw new Error('설정을 읽지 못함');
    }
    await store.getState().saveSettings({ ...settings, autoRefreshSecs: 7 });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(calls()).toHaveLength(2);
    // 34초까지 7초 간격으로 4번(7·14·21·28초)만 읽는다. 옛 30초 타이머가 남았다면 한 번 더 읽는다
    await vi.advanceTimersByTimeAsync(27_000);
    expect(calls()).toHaveLength(5);
    stop();
    vi.useRealTimers();
  });
});
