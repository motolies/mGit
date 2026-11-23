import { type BatchResult, createNullClient, type IpcClient } from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createFolderStore } from '../store/folder-store';

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
    expect(store.getState().batchResult?.label).toBe('일괄 fetch');
    store.getState().clearBatchResult();
    expect(store.getState().batchResult).toBeNull();
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
