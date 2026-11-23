import {
  type ConflictPayload,
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);

/** D3 호출을 기록하는 클라이언트 */
function client(newErrors: boolean) {
  let verify: string | null = null;
  let init: string | null = null;
  const c: IpcClient = {
    ...createNullClient(),
    syntaxCompare: vi.fn(async () => ({
      language: 'json',
      resultErrors: newErrors ? 2 : 0,
      oursErrors: 0,
      theirsErrors: 0,
      firstErrorLine: newErrors ? 3 : null,
      newErrors,
    })),
    resolveFile: vi.fn(async () => {}),
    verifyCommand: vi.fn(async () => verify),
    verifyCommandSet: vi.fn(async (_s, cmd: string | null) => {
      verify = cmd;
    }),
    runVerify: vi.fn(async () => ({
      command: 'pnpm test',
      ok: false,
      status: 1,
      output: 'FAIL x\n',
      elapsedMs: 12,
      timedOut: false,
    })),
    worktreeInitCommand: vi.fn(async () => init),
    worktreeInitCommandSet: vi.fn(async (_s, cmd: string | null) => {
      init = cmd;
    }),
    worktreeAdd: vi.fn(async (_s, path: string) => path),
    runWorktreeInit: vi.fn(async () => ({
      command: 'pnpm i',
      ok: true,
      status: 0,
      output: '',
      elapsedMs: 5,
      timedOut: false,
    })),
    lfsStatus: vi.fn(async () => ({
      installed: true,
      version: '3.7.1',
      configured: true,
      patterns: ['*.bin'],
      files: [{ oid: 'abc', path: 'a.bin', full: true }],
      locks: [],
      locksError: null,
    })),
    lfsTrack: vi.fn(async () => {}),
    lfsUntrack: vi.fn(async () => {}),
  };
  return c;
}

/** 스토어 */
function setup(newErrors = true) {
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
  const c = client(newErrors);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, c, cache), client: c };
}

const payload = {
  file: { path: 'a.json', kind: 'bothModified', binary: false, submodule: false, stages: [] },
  labels: { ours: 'main', base: 'base', theirs: 'side' },
} as unknown as ConflictPayload;

describe('SessionStore (D3 검증·초기화·LFS)', () => {
  it('구문 오류가 새로 생기면 저장을 막고 힌트를 띄운다. 강제 저장은 통과', async () => {
    const { store, client: c } = setup(true);
    store.setState({ conflict: { path: 'a.json', payload } });
    expect(await store.getState().saveConflict('{"a": }')).toBe(false);
    expect(c.resolveFile).not.toHaveBeenCalled();
    const hint = store.getState().pendingHint;
    expect(hint?.kind).toBe('syntaxErrors');
    expect(await store.getState().saveConflict('{"a": }', { force: true })).toBe(true);
    expect(c.resolveFile).toHaveBeenCalledWith(1, 'a.json', '{"a": }', false);
    const clean = setup(false);
    clean.store.setState({ conflict: { path: 'a.json', payload } });
    expect(await clean.store.getState().saveConflict('{"a": 1}')).toBe(true);
    expect(clean.store.getState().pendingHint).toBeNull();
  });

  it('검증 명령을 저장·실행하고 결과를 리뷰 창에 보여 준다', async () => {
    const { store, client: c } = setup();
    await store.getState().saveVerifyCommand('pnpm test');
    expect(c.verifyCommandSet).toHaveBeenCalledWith(1, 'pnpm test');
    expect(store.getState().verifyCommand).toBe('pnpm test');
    await store.getState().runVerify();
    expect(store.getState().review?.text).toBe('FAIL x\n');
    expect(store.getState().review?.loading).toBe(false);
    await store.getState().saveVerifyCommand('');
    expect(store.getState().verifyCommand).toBeNull();
  });

  it('워크트리를 만들면 초기화 명령을 그 폴더에서 돌린다', async () => {
    const { store, client: c } = setup();
    const created = await store
      .getState()
      .worktreeAdd('/r.worktrees/x', { kind: 'newBranch', name: 'x', start: null });
    expect(created).toBe('/r.worktrees/x');
    expect(c.runWorktreeInit).toHaveBeenCalledWith(1, '/r.worktrees/x');
  });

  it('LFS 상태를 읽고 추적/해제 뒤 다시 읽는다', async () => {
    const { store, client: c } = setup();
    await store.getState().loadLfs();
    expect(store.getState().lfs?.patterns).toEqual(['*.bin']);
    await store.getState().lfsTrack('*.psd');
    expect(c.lfsTrack).toHaveBeenCalledWith(1, '*.psd');
    await store.getState().lfsUntrack('*.bin');
    expect(c.lfsUntrack).toHaveBeenCalledWith(1, '*.bin');
    expect(c.lfsStatus).toHaveBeenCalledTimes(3);
  });
});
