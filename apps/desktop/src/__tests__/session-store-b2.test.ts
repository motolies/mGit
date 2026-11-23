import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type PullRequest,
  type RepoOpened,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { defaultBase, remoteBranches } from '../features/hosting/pr-flows';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const PR: PullRequest = {
  number: 7,
  title: 'feat',
  draft: false,
  author: 'lee',
  authorAvatar: null,
  headRef: 'feat',
  headSha: 'b'.repeat(40),
  baseRef: 'main',
  headRepo: null,
  crossRepo: false,
  webUrl: 'https://github.com/kim/app/pull/7',
  updatedAt: null,
  review: 'approved',
  checks: 'success',
  mergeable: true,
  labels: [],
};

/** PR·아바타 호출을 흉내 내는 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    hostingRemoteProject: vi.fn(async () => ({
      accountId: 'github:github.com:kim',
      kind: 'github' as const,
      host: 'github.com',
      project: 'kim/app',
      remote: 'origin',
    })),
    pullRequests: vi.fn(async () => [PR]),
    checkoutPullRequest: vi.fn(async (_s, n: number) => `pr/${n}`),
    createPullRequest: vi.fn(async () => PR),
    avatar: vi.fn(async (email: string) => (email === 'a@x' ? 'data:image/png;base64,AA==' : null)),
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

describe('SessionStore (B2 PR/MR·아바타)', () => {
  it('원격 프로젝트와 PR 목록을 읽고, 체크아웃·만들기를 넘긴다', async () => {
    const { store, client: c } = setup();
    await tick();
    expect(store.getState().remoteProject?.project).toBe('kim/app');
    await store.getState().loadPullRequests();
    expect(store.getState().pullRequests).toEqual([PR]);
    expect(store.getState().prsLoading).toBe(false);
    expect(await store.getState().checkoutPullRequest(7, null)).toBe('pr/7');
    expect(c.checkoutPullRequest).toHaveBeenCalledWith(1, 7, null);
    const spec = { head: 'feat', base: 'main', title: 't', body: '', draft: false };
    expect(await store.getState().createPullRequest(spec)).toEqual(PR);
    expect(c.createPullRequest).toHaveBeenCalledWith(1, spec);
  });

  it('아바타는 한 번만 요청하고 결과를 이메일별로 둔다', async () => {
    const { store, client: c } = setup();
    store.getState().requestAvatars(['a@x', 'b@x', 'a@x', undefined]);
    store.getState().requestAvatars(['a@x']);
    await tick();
    expect(c.avatar).toHaveBeenCalledTimes(2);
    expect(store.getState().avatars).toEqual({ 'a@x': 'data:image/png;base64,AA==', 'b@x': null });
    store.getState().requestAvatars(['b@x']);
    await tick();
    expect(c.avatar).toHaveBeenCalledTimes(2);
  });

  it('PR base 는 원격 branch 중 main/master 를 고른다', () => {
    const refs = emptyRepoState({ state: 'attached', branch: 'main', oid: HEAD }).refs;
    const labels = [
      {
        fullName: 'refs/remotes/origin/dev',
        shortName: 'origin/dev',
        kind: { kind: 'remoteBranch', remote: 'origin' },
      },
      {
        fullName: 'refs/remotes/origin/master',
        shortName: 'origin/master',
        kind: { kind: 'remoteBranch', remote: 'origin' },
      },
      {
        fullName: 'refs/remotes/origin/HEAD',
        shortName: 'origin/HEAD',
        kind: { kind: 'remoteBranch', remote: 'origin' },
      },
      { fullName: 'refs/heads/main', shortName: 'main', kind: { kind: 'localBranch' } },
    ] as unknown as typeof refs.labels;
    const branches = remoteBranches({ ...refs, labels }, 'origin');
    expect(branches).toEqual(['dev', 'master']);
    expect(defaultBase(branches)).toBe('master');
    expect(defaultBase([])).toBe('main');
  });
});
