import type { BranchDeleteTarget } from '@mgit/ipc';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inspect: vi.fn(),
  refresh: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
  notice: vi.fn(),
  runBatch: vi.fn(),
}));
vi.mock('../components/use-dialogs', () => ({
  useDialogs: () => ({ prompt: h.prompt, confirm: h.confirm, element: null }),
}));
vi.mock('../store', () => ({
  describeError: (error: unknown) => String(error),
  repoNameOf: (path: string) => path.split('/').at(-1),
  getSessionStore: () => undefined,
  getFolderStore: () => ({
    getState: () => ({
      batchRunning: false,
      inspectRemoteBranchDeletion: h.inspect,
      runBatch: h.runBatch,
      refresh: h.refresh,
    }),
  }),
  useAppStore: { getState: () => ({ notice: h.notice }) },
}));

import { useRemoteBranchDelete } from '../features/branches/use-remote-branch-delete';

/** 사전조회 동안 잠금 유지와 갱신 실패 후 해제를 검증한다. */
describe('원격 삭제 흐름 중복 실행 방지', () => {
  it('확인 전 중복 실행을 차단하고 refresh 실패 후에도 다시 열 수 있다', async () => {
    h.inspect.mockReset();
    h.notice.mockReset();
    h.refresh.mockRejectedValue(new Error('refresh failed'));
    h.prompt.mockResolvedValue(null);
    let resolve!: (targets: BranchDeleteTarget[]) => void;
    const targets: BranchDeleteTarget[] = [
      {
        path: '/r',
        remote: 'origin',
        name: 'topic',
        remoteOid: 'a'.repeat(40),
        remoteUrl: '/remote',
        locals: [],
        error: null,
        excluded: false,
      },
    ];
    h.inspect
      .mockImplementationOnce(
        () =>
          new Promise<BranchDeleteTarget[]>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(targets);
    const { result } = renderHook(() => useRemoteBranchDelete('folder', 31));
    let first!: Promise<void>;
    act(() => {
      first = result.current.execute('origin', 'topic');
    });
    expect(result.current.running).toBe(true);
    await act(async () => {
      await result.current.execute('origin', 'topic');
    });
    expect(h.inspect).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(targets);
      await first;
    });
    expect(result.current.running).toBe(false);
    expect(h.notice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('refresh failed') }),
    );
    await act(async () => {
      await result.current.execute('origin', 'topic');
    });
    expect(h.inspect).toHaveBeenCalledTimes(2);
    expect(result.current.running).toBe(false);
  });
});
