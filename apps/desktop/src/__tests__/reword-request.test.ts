import { createMockClient, GraphRangeCache } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/app-store-instance';
import { finishRewordRequest, requestRepoReword, useRewordRequest } from '../store/reword-request';
import { clearSessionRegistry, registerSession } from '../store/session-registry';
import { createSessionStore } from '../store/session-store';

const original = useAppStore.getState();

/** 폴더에서 열린 저장소 세션을 준비하고 열기의 포커스 정책을 흉내 낸다. */
async function setup(loadState: 'opening' | 'complete' = 'complete') {
  const client = createMockClient({ rows: 10 });
  const opened = await client.openRepo('/repo', () => {});
  const id = opened.session;
  const cache = new GraphRangeCache({
    fetchWindow: (start, count) => client.graphWindow(id, start, count),
  });
  const store = createSessionStore(opened, client, cache);
  store.setState({ loadState, resolveRow: vi.fn(async () => 0) });
  registerSession(id, { store, cache });
  const notice = vi.fn();
  const open = vi.fn(async (_path, _parent, options) => {
    if (options.activate()) useAppStore.setState({ activeSessionId: id });
    return id;
  });
  useAppStore.setState({
    activeSessionId: -1,
    sessions: {
      [-1]: { id: -1, kind: 'folder', path: '/folder', name: 'folder', parent: null },
      [id]: { id, kind: 'repo', path: '/repo', name: 'repo', parent: -1 },
    },
    openRepositoryAt: open,
    notice,
  });
  return { id, store, open, notice };
}

afterEach(() => {
  useAppStore.setState({ activeSessionId: null });
  useAppStore.setState(original);
  clearSessionRegistry();
});

describe('폴더 메시지 수정 요청 수명', () => {
  it('조회 성공 후 동일 커밋의 수정 요청을 저장소 화면에 전달한다', async () => {
    const { id, store } = await setup();
    const jump = vi.fn(async () => 'found' as const);
    store.setState({ jumpToCommit: jump });
    await requestRepoReword(-1, '/repo', 'commit');
    expect(jump).toHaveBeenCalledOnce();
    const request = useRewordRequest.getState().request;
    expect(request?.sessionId).toBe(id);
    expect(request?.oid).toBe('commit');
    if (request) finishRewordRequest(request);
    expect(useRewordRequest.getState().request).toBeNull();
  });

  it('로드 중 반복 요청은 합치고 다른 탭으로 이동하면 대기 요청을 취소한다', async () => {
    const { store, open } = await setup('opening');
    const jump = vi.fn(async () => 'found' as const);
    store.setState({ jumpToCommit: jump });
    const first = requestRepoReword(-1, '/repo', 'commit');
    await requestRepoReword(-1, '/repo', 'commit');
    useAppStore.setState({ activeSessionId: -1 });
    store.setState({ loadState: 'complete' });
    await first;
    expect(open).toHaveBeenCalledOnce();
    expect(jump).not.toHaveBeenCalled();
    expect(useRewordRequest.getState().request).toBeNull();
    expect(useAppStore.getState().activeSessionId).toBe(-1);
  });

  it.each(['missing', 'failed'] as const)(
    '%s 결과를 구분해 알리고 요청을 종료한다',
    async (result) => {
      const { store, notice } = await setup();
      store.setState({ jumpToCommit: vi.fn(async () => result) });
      await requestRepoReword(-1, '/repo', 'commit');
      expect(notice).toHaveBeenCalledWith({
        kind: 'error',
        title: result === 'missing' ? S.shortcuts.commitMissing : S.shortcuts.commitLoadFailed,
      });
      expect(useRewordRequest.getState().request).toBeNull();
    },
  );
});
