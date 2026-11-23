import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyHub } from '../store/notify';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);

/** 비밀 스캔 결과를 바꿀 수 있는 클라이언트 */
function client(hits: { path: string; line: number; rule: string; snippet: string }[]) {
  const scan = vi.fn(async () => hits);
  return {
    client: {
      ...createNullClient(),
      scanStagedSecrets: scan,
      commit: vi.fn(async () => HEAD),
      secretIgnores: vi.fn(async () => []),
      secretIgnoresSet: vi.fn(async () => {}),
      createTag: vi.fn(async () => {}),
      perfStatus: vi.fn(async () => ({
        fsmonitor: false,
        untrackedCache: false,
        trackedFiles: 30000,
        suggested: true,
      })),
      enablePerf: vi.fn(async () => {}),
      signingInfo: vi.fn(async () => ({
        format: 'ssh',
        signingKey: '~/.ssh/id.pub',
        commitSign: true,
        tagSign: false,
      })),
    } as IpcClient,
    scan,
  };
}

/** 스토어 */
function setup(hits: { path: string; line: number; rule: string; snippet: string }[] = []) {
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
      shallow: true,
    },
    state: emptyRepoState(head),
  };
  const { client: c, scan } = client(hits);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, c, cache), client: c, scan };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const notices: { kind: string; title: string }[] = [];

beforeEach(() => {
  notices.length = 0;
  notifyHub.setHandler((n) => notices.push({ kind: n.kind, title: n.title }));
});
afterEach(() => {
  notifyHub.setHandler(null);
});

describe('SessionStore (A4 서명·비밀 스캔·알림·설정)', () => {
  it('비밀 정보가 staged 에 있으면 커밋을 멈추고, 무시하면 서명 설정과 함께 커밋한다', async () => {
    const hit = { path: 'a.env', line: 1, rule: 'github-pat', snippet: 'ghp_…ab' };
    const { store, client: c, scan } = setup([hit]);
    await tick();
    expect(store.getState().signingInfo?.commitSign).toBe(true);
    expect(store.getState().perfSuggestion?.suggested).toBe(true);
    store.getState().setCommitMessage('feat: x');
    expect(await store.getState().commit()).toBe(false);
    expect(store.getState().secretHits).toEqual([hit]);
    expect(c.commit).not.toHaveBeenCalled();
    store.getState().setCommitSign(false);
    expect(await store.getState().commit({ ignoreSecrets: true })).toBe(true);
    expect(c.commit).toHaveBeenCalledWith(1, {
      message: 'feat: x',
      amend: false,
      noVerify: false,
      sign: false,
      allowConflictMarkers: false,
    });
    expect(store.getState().secretHits).toBeNull();
    expect(scan).toHaveBeenCalledTimes(1);
    // 규칙 무시를 추가하면 다시 스캔한다
    scan.mockResolvedValueOnce([]);
    store.setState({ secretHits: [hit] });
    await store.getState().addSecretIgnore({ rule: 'github-pat', path: null });
    expect(c.secretIgnoresSet).toHaveBeenCalledWith([{ rule: 'github-pat', path: null }]);
    expect(store.getState().secretHits).toBeNull();
  });

  it('오래 걸린 작업·실패·자동 fetch 를 알린다', async () => {
    const { store } = setup();
    const start = (opId: number, label: string) =>
      store
        .getState()
        .applyEvent({ type: 'operationStarted', session: 1, opId, kind: 'fetch', label });
    const finish = (opId: number, ok: boolean) =>
      store.getState().applyEvent({
        type: 'operationFinished',
        session: 1,
        opId,
        ok,
        cancelled: false,
        message: '',
        lockLeft: false,
      });
    start(1, 'fetch');
    finish(1, true);
    expect(notices).toEqual([]);
    start(2, 'push');
    store.setState({
      operations: {
        ...store.getState().operations,
        2: { ...store.getState().operations[2], startedAt: Date.now() - 5000 },
      },
    } as never);
    finish(2, true);
    start(3, 'pull');
    finish(3, false);
    store.getState().applyEvent({ type: 'autoFetched', session: 1, refs: ['origin/main'] });
    expect(notices.map((n) => n.kind)).toEqual(['success', 'error', 'info']);
  });

  it('서명 태그·fsmonitor 켜기·얕은 복제 상태', async () => {
    const { store, client: c } = setup();
    await store.getState().createTag('v1', HEAD, null, true);
    expect(c.createTag).toHaveBeenCalledWith(1, 'v1', HEAD, null, true);
    expect(store.getState().shallow).toBe(true);
    await tick();
    await store.getState().enablePerf();
    expect(c.enablePerf).toHaveBeenCalledWith(1);
    expect(store.getState().perfSuggestion).toBeNull();
  });
});
