import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RebasePlan,
  type RepoOpened,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { moveRow, rowsToSteps } from '../features/rebase/RebasePlanDialog';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

/** 리베이스·워크트리 WIP 를 흉내 내는 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    rebasePlanCommits: vi.fn(async () => ({
      commits: [
        { oid: OLD, subject: 'old', authorName: 'me' },
        { oid: HEAD, subject: 'head', authorName: 'me' },
      ],
      hasMerges: true,
    })),
    rebaseInteractive: vi.fn(async () => 'clean' as const),
    squashIntoParent: vi.fn(async () => 'conflicts' as const),
    worktreeWips: vi.fn(async () => [
      {
        path: '/w/x',
        branch: 'x',
        head: OLD,
        summary: {
          ...emptyRepoState({ state: 'attached', branch: 'main', oid: HEAD }).status.summary,
          unstaged: 1,
        },
      },
    ]),
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

describe('SessionStore (A2 이력 수정)', () => {
  it('플랜을 열면 commit 을 읽고, 실행하면 플랜을 넘기고 닫는다', async () => {
    const { store, client: c } = setup();
    await store.getState().openRebasePlan('main');
    expect(store.getState().rebasePlan?.commits.map((x) => x.subject)).toEqual(['old', 'head']);
    expect(store.getState().rebasePlan?.hasMerges).toBe(true);
    const plan: RebasePlan = {
      onto: 'main',
      steps: [
        { oid: HEAD, action: { kind: 'pick' } },
        { oid: OLD, action: { kind: 'reword', message: 'new' } },
      ],
      autostash: true,
      updateRefs: false,
    };
    expect(await store.getState().runRebasePlan(plan)).toBe(true);
    expect(c.rebaseInteractive).toHaveBeenCalledWith(1, plan);
    expect(store.getState().rebasePlan).toBeNull();
    expect(store.getState().lastOutcome).toBe('clean');
    await store.getState().squashIntoParent(OLD);
    expect(store.getState().lastOutcome).toBe('conflicts');
  });

  it('워크트리가 둘 이상일 때만 다른 워크트리 WIP 를 읽는다', async () => {
    const { store, client: c } = setup();
    await store.getState().loadWorktreeWips();
    expect(c.worktreeWips).not.toHaveBeenCalled();
    const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
    const refs = emptyRepoState(head).refs;
    store.getState().applyEvent({
      type: 'refsChanged',
      session: 1,
      refs: {
        ...refs,
        worktrees: [
          {
            path: '/r',
            head: HEAD,
            branch: 'main',
            detached: false,
            bare: false,
            locked: null,
            prunable: null,
            isMain: true,
          },
          {
            path: '/w/x',
            head: OLD,
            branch: 'x',
            detached: false,
            bare: false,
            locked: null,
            prunable: null,
            isMain: false,
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.worktreeWips).toHaveBeenCalled();
    expect(store.getState().worktreeWips[0]?.branch).toBe('x');
  });
});

describe('RebasePlanDialog helpers', () => {
  it('줄을 옮기고 step 으로 바꾼다', () => {
    const rows = [
      {
        commit: { oid: OLD, subject: 'old', authorName: 'me' },
        kind: 'pick' as const,
        message: 'old',
      },
      {
        commit: { oid: HEAD, subject: 'head', authorName: 'me' },
        kind: 'reword' as const,
        message: 'renamed',
      },
    ];
    const moved = moveRow(rows, 1, 0);
    expect(moved.map((r) => r.commit.subject)).toEqual(['head', 'old']);
    expect(moveRow(rows, 0, 5)).toEqual(rows);
    expect(rowsToSteps(moved)).toEqual([
      { oid: HEAD, action: { kind: 'reword', message: 'renamed' } },
      { oid: OLD, action: { kind: 'pick' } },
    ]);
  });
});
