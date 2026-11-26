// 백업 자동 정리를 부르는 때 (#18·#26): 폴더 탭은 첫 요약을 읽은 뒤 한 번, 저장소 탭은 새로 열 때 한 번 부른다.
// 하루 한 번 규칙은 코어가 지킨다 (`crates/mgit-core/tests/backup_cleanup.rs`).

import { createMockClient, type SessionId } from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import { clearSessionRegistry } from '../store/session-registry';

const FOLDER = '/mock/acme-platform';
const WEB = `${FOLDER}/web-console`;

afterEach(() => {
  clearSessionRegistry();
});

describe('백업 자동 정리 호출', () => {
  it('폴더를 열면 첫 요약 뒤 한 번, 저장소 탭은 새로 열 때만 한 번 부른다', async () => {
    const client = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    const order: string[] = [];
    // 감싸기 전에 원래 함수를 잡아 둔다 (스파이를 건 뒤에 읽으면 자기 자신을 부른다)
    const original = client.folderSummaries.bind(client);
    const summaries = vi
      .spyOn(client, 'folderSummaries')
      .mockImplementation(async (...args: Parameters<typeof client.folderSummaries>) => {
        order.push('summaries');
        return original(...args);
      });
    const folderPrune = vi.spyOn(client, 'folderPruneBackupsDaily').mockImplementation(async () => {
      order.push('prune');
      return { ran: true, refs: 0, files: 0 };
    });
    const prune = vi.spyOn(client, 'pruneBackupsDaily');
    const store = createAppStore({ client, pickDirectory: async () => null });

    await store.getState().openFolderAt(FOLDER);
    const folder = store.getState().activeSessionId as SessionId;
    await vi.waitFor(() => expect(folderPrune).toHaveBeenCalledTimes(1));
    expect(folderPrune).toHaveBeenCalledWith(folder);
    expect(order.indexOf('summaries')).toBeLessThan(order.indexOf('prune'));
    expect(summaries).toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();

    const tab = await store.getState().openRepositoryAt(WEB);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(tab);
    // 이미 열린 탭으로 돌아가는 열기는 다시 부르지 않는다
    await store.getState().openRepositoryAt(WEB);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(folderPrune).toHaveBeenCalledTimes(1);
  });

  it('정리가 실패해도 열기는 그대로 끝난다 (알리지 않는다)', async () => {
    const client = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    vi.spyOn(client, 'folderPruneBackupsDaily').mockRejectedValue(new Error('x'));
    const prune = vi.spyOn(client, 'pruneBackupsDaily').mockRejectedValue(new Error('x'));
    const store = createAppStore({ client, pickDirectory: async () => null });
    await store.getState().openFolderAt(FOLDER);
    const tab = await store.getState().openRepositoryAt(WEB);
    expect(tab).not.toBeNull();
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().toasts).toEqual([]);
  });
});
