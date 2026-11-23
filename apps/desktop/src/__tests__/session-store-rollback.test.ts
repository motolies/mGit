// 세션 스토어의 변경 되돌리기 (파일 메뉴 Rollback): discard 와 같은 알림 방식, 실패는 actionError
import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyHub } from '../store/notify';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);

/** `rollbackPaths` 를 바꿔 끼운 스토어 */
function setup(rollbackPaths: IpcClient['rollbackPaths']) {
  const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
  const opened: RepoOpened = {
    session: 7,
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
  const client: IpcClient = { ...createNullClient(), rollbackPaths };
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return createSessionStore(opened, client, cache);
}

const notices: { kind: string; title: string }[] = [];

beforeEach(() => {
  notices.length = 0;
  notifyHub.setHandler((n) => notices.push({ kind: n.kind, title: n.title }));
});
afterEach(() => {
  notifyHub.setHandler(null);
});

describe('SessionStore.rollback', () => {
  it('세션·경로로 부르고, 성공하면 "폐기 백업에서 복구할 수 있습니다" 를 알린다', async () => {
    const call = vi.fn(async () => [11, 12]);
    const store = setup(call);
    await store.getState().rollback(['.DS_Store', 'src/a.ts']);
    expect(call).toHaveBeenCalledWith(7, ['.DS_Store', 'src/a.ts']);
    expect(notices).toEqual([{ kind: 'info', title: S.safety.discardBackedUp }]);
    expect(store.getState().actionError).toBeNull();
  });

  it('코어가 거부하면(충돌·진행 중 작업) 알림 없이 사유를 actionError 로 보인다', async () => {
    const store = setup(async () => {
      throw { kind: 'internal', message: '충돌 중인 파일은 되돌리지 않습니다: c.txt' };
    });
    await store.getState().rollback(['c.txt']);
    expect(notices).toEqual([]);
    expect(store.getState().actionError).toContain('c.txt');
  });
});
