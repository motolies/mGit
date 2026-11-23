import {
  type BatchResult,
  createNullClient,
  type IndexWriteResult,
  type IpcClient,
  type RepoChanges,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createFolderStore } from '../store/folder-store';

const A = '/f/a';
const B = '/f/b';
const REPOS = [A, B].map((path) => ({ path, kind: 'standalone' as const }));
const DONE: IndexWriteResult = { ran: true, skipped: [] };

/** 기다렸다가 풀 수 있는 약속 */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 변경 줄 하나 */
const repoChanges = (path: string, n: number): RepoChanges => ({
  path,
  name: path,
  branch: 'main',
  entries: [],
  summary: {
    staged: n,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    ahead: 0,
    behind: 0,
    stashCount: 0,
    upstream: null,
  },
});

/** 폴더 스토어 + 호출을 기록하는 클라이언트. 변경 목록을 한 번 읽어 둔 상태로 시작한다 */
async function setup(overrides: Partial<IpcClient> = {}) {
  let staged = 0;
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: vi.fn(async () => []),
    folderBranches: vi.fn(async () => ({ repos: [], branches: [] })),
    folderChanges: vi.fn(async (_s, repos?: readonly string[]) =>
      (repos && repos.length > 0 ? repos : [A, B]).map((p) => repoChanges(p, staged)),
    ),
    folderStage: vi.fn(async () => {
      staged = 1;
      return DONE;
    }),
    folderUnstage: vi.fn(async () => DONE),
    ...overrides,
  };
  const store = createFolderStore({ session: 9, path: '/f', repos: REPOS }, client);
  await store.getState().loadChanges();
  await flush();
  vi.mocked(client.folderChanges).mockClear();
  vi.mocked(client.folderSummaries).mockClear();
  return { client, store };
}

describe('폴더 stage·unstage (W14: 체크 = stage)', () => {
  it('그 저장소·대상으로 부르고, 돌던 동안 그 저장소를 "처리 중" 으로 두며, 그 저장소만 바로 다시 읽은 뒤에 끝난다', async () => {
    const gate = deferred<IndexWriteResult>();
    const { client, store } = await setup({ folderStage: vi.fn(() => gate.promise) });
    const target = { kind: 'paths' as const, paths: ['src/x.ts'] };
    const pending = store.getState().writeIndex(A, 'stage', target);
    expect(store.getState().indexWrites).toEqual({ [A]: { op: 'stage', target } });
    expect(client.folderStage).toHaveBeenCalledWith(9, A, target);
    // 같은 저장소의 두 번째 호출은 부르지 않는다. 다른 저장소는 된다
    expect(await store.getState().writeIndex(A, 'unstage', { kind: 'all' })).toEqual({
      kind: 'busy',
    });
    expect(client.folderUnstage).not.toHaveBeenCalled();

    gate.resolve(DONE);
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'done', result: DONE });
    // 디바운스를 기다리지 않고 그 저장소만 다시 읽었고, 그 뒤에 "처리 중" 이 풀렸다
    expect(client.folderChanges).toHaveBeenCalledWith(9, [A]);
    expect(client.folderSummaries).toHaveBeenCalledWith(9, [A]);
    expect(store.getState().indexWrites).toEqual({});
  });

  it('감시 이벤트가 먼저 와 디바운스에 걸려 있으면 그 예약을 당겨 한 번만 읽는다', async () => {
    const { client, store } = await setup({
      folderStage: vi.fn(async () => {
        // 코어처럼 쓰기 뒤 그 저장소의 folderChanged 를 응답보다 먼저 보낸다
        store.getState().applyEvent({ type: 'folderChanged', session: 9, refs: false, repo: A });
        return DONE;
      }),
    });
    await store.getState().writeIndex(A, 'stage', { kind: 'all' });
    await new Promise((r) => setTimeout(r, 450));
    expect(client.folderChanges).toHaveBeenCalledTimes(1);
  });

  it('빈 경로 목록은 보내지 않는다 (코어에서도 아무것도 하지 않는다)', async () => {
    const { client, store } = await setup();
    const outcome = await store.getState().writeIndex(A, 'stage', { kind: 'paths', paths: [] });
    expect(outcome).toEqual({ kind: 'done', result: { ran: false, skipped: [] } });
    expect(client.folderStage).not.toHaveBeenCalled();
  });

  it('쓰기를 돌리지 않았으면(충돌뿐) 다시 읽지 않고, 건너뛴 경로를 돌려준다', async () => {
    const skipped: IndexWriteResult = {
      ran: false,
      skipped: [{ path: 'c.kt', reason: 'unmerged' }],
    };
    const { client, store } = await setup({ folderStage: vi.fn(async () => skipped) });
    expect(await store.getState().writeIndex(A, 'stage', { kind: 'all' })).toEqual({
      kind: 'done',
      result: skipped,
    });
    expect(client.folderChanges).not.toHaveBeenCalled();
  });

  it('실패하면 사유를 돌려주고 상태를 바꾸지 않는다. 일괄 작업 중에는 부르지 않는다', async () => {
    const { client, store } = await setup({
      folderUnstage: vi.fn(async () => {
        throw { kind: 'nestedRepos', paths: ['vendor/lib'] };
      }),
    });
    const before = store.getState().changes;
    const outcome = await store.getState().writeIndex(B, 'unstage', { kind: 'all' });
    expect(outcome.kind).toBe('failed');
    expect(store.getState().changes).toBe(before);
    expect(store.getState().indexWrites).toEqual({});
    expect(client.folderChanges).not.toHaveBeenCalled();

    store.setState({ batchRunning: true });
    expect(await store.getState().writeIndex(A, 'stage', { kind: 'all' })).toEqual({
      kind: 'busy',
    });
    expect(client.folderStage).not.toHaveBeenCalled();
  });
});

describe('일괄 커밋 뒤 다시 읽기 (W14)', () => {
  it('대상 저장소의 요약·변경을 다시 읽은 뒤에 결과를 돌려주고, 그때까지 실행 중이다', async () => {
    const result: BatchResult = {
      label: '일괄 commit',
      results: [{ path: A, name: 'a', ok: true, skipped: null, message: '' }],
      succeeded: 1,
      skipped: 0,
      failed: 0,
    };
    const { client, store } = await setup({ folderCommit: vi.fn(async () => result) });
    const pending = store.getState().commitAll([A], 'msg', false);
    expect(store.getState().batchRunning).toBe(true);
    expect(await pending).toBe(result);
    expect(client.folderCommit).toHaveBeenCalledWith(9, [A], 'msg', false);
    expect(client.folderSummaries).toHaveBeenCalledWith(9, [A]);
    expect(client.folderChanges).toHaveBeenCalledWith(9, [A]);
    expect(store.getState().batchRunning).toBe(false);
    expect(store.getState().batchResult).toBe(result);
  });
});
