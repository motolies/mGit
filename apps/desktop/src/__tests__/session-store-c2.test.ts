import {
  createNullClient,
  emptyRepoState,
  type FileDiff,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import { subprojectPointers } from '../features/diff/subproject';
import { type Notice, notifyHub } from '../store/notify';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);

/** 미등록 하위 저장소·push 안 된 서브모듈을 흉내 내는 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    stagePaths: vi.fn(async () => {
      throw { kind: 'nestedRepos', paths: ['vendor/lib'] };
    }),
    submodules: vi.fn(async () => [
      { path: 'vendor/lib', oid: OLD, status: 'clean' as const, describe: null },
    ]),
    submoduleUnpushed: vi.fn(async () => [{ path: 'vendor/lib', count: 2 }]),
    push: vi.fn(async () => {}),
    submoduleBatch: vi.fn(async () => ({
      label: '일괄 push',
      results: [],
      succeeded: 1,
      skipped: 0,
      failed: 0,
    })),
    submoduleAdopt: vi.fn(async () => {}),
    submodulePointerLog: vi.fn(async () => ({
      commits: [{ oid: NEW, subject: 'bump', author: 'me', time: 1 }],
      reversed: false,
      missing: false,
    })),
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

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SessionStore (C2 서브모듈)', () => {
  it('미등록 하위 저장소를 stage 하면 안내 힌트가 뜨고, 등록 뒤 다시 stage 한다', async () => {
    const { store, client: c } = setup();
    await store.getState().stage(['vendor/lib']);
    expect(store.getState().pendingHint).toEqual({ kind: 'nestedRepo', paths: ['vendor/lib'] });
    await store.getState().submoduleAdopt('vendor/lib');
    expect(c.submoduleAdopt).toHaveBeenCalledWith(1, 'vendor/lib');
  });

  it('push 전에 서브모듈의 push 안 된 commit 을 확인한다', async () => {
    const { store, client: c } = setup();
    await store.getState().loadSubmodules();
    await store.getState().push();
    expect(c.push).not.toHaveBeenCalled();
    expect(store.getState().pendingHint).toMatchObject({
      kind: 'submoduleUnpushed',
      items: [{ path: 'vendor/lib', count: 2 }],
    });
    // 서브모듈 먼저 push → 상위 push
    store.getState().dismissHint();
    await store.getState().pushSubmodulesThenPush({});
    expect(c.submoduleBatch).toHaveBeenCalledWith(1, { kind: 'push' }, []);
    expect(c.push).toHaveBeenCalledTimes(1);
    // 검사 건너뛰기
    await store.getState().push({}, { skipSubmoduleCheck: true });
    expect(c.push).toHaveBeenCalledTimes(2);
  });

  it('서브모듈 push 를 취소했거나 실패했으면 상위 저장소 push 로 이어 가지 않는다', async () => {
    const notices: Notice[] = [];
    const before = notifyHub.setHandler((n) => notices.push(n));
    try {
      const { store, client: c } = setup();
      // 취소: 성공 1·취소 1 (실패 0 이어도 멈춘다)
      vi.mocked(c.submoduleBatch).mockResolvedValueOnce({
        label: '일괄 push',
        results: [],
        succeeded: 1,
        skipped: 0,
        failed: 0,
        cancelled: 1,
      });
      await store.getState().pushSubmodulesThenPush({});
      expect(c.push).not.toHaveBeenCalled();
      expect(notices.map((n) => [n.kind, n.title])).toEqual([
        ['info', `일괄 push: ${S.folder.batch.withCancelled(S.folder.batch.result(1, 0, 0), 1)}`],
        ['info', S.dialog.submoduleUnpushedCancelled],
      ]);
      // 실패: 멈추고 오류 알림만
      vi.mocked(c.submoduleBatch).mockResolvedValueOnce({
        label: '일괄 push',
        results: [],
        succeeded: 0,
        skipped: 0,
        failed: 1,
      });
      await store.getState().pushSubmodulesThenPush({});
      expect(c.push).not.toHaveBeenCalled();
      expect(notices.at(-1)?.kind).toBe('error');
    } finally {
      notifyHub.setHandler(before);
    }
  });

  it('서브모듈 포인터 diff 를 알아보고 commit 목록을 읽는다', async () => {
    const diff = {
      oldPath: 'vendor/lib',
      newPath: 'vendor/lib',
      change: { kind: 'modified' },
      binary: null,
      truncated: false,
      totalLines: 2,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          section: '',
          lines: [
            {
              kind: 'del',
              oldNo: 1,
              newNo: null,
              text: `Subproject commit ${OLD}`,
              noNewline: false,
            },
            {
              kind: 'add',
              oldNo: null,
              newNo: 1,
              text: `Subproject commit ${NEW}`,
              noNewline: false,
            },
          ],
        },
      ],
    } as unknown as FileDiff;
    expect(subprojectPointers(diff)).toEqual({ old: OLD, new: NEW });
    expect(subprojectPointers(null)).toBeNull();
    const { store, client: c } = setup();
    await store.getState().loadSubmoduleLog('vendor/lib', OLD, NEW);
    await tick();
    expect(c.submodulePointerLog).toHaveBeenCalledWith(1, 'vendor/lib', OLD, NEW);
    expect(store.getState().submoduleLog?.log.commits[0]?.subject).toBe('bump');
  });
});
