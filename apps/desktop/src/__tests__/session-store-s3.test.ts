import {
  type CommitDetail,
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** 상세·검색·브랜치 호출을 기록하는 가짜 클라이언트 */
function client(): IpcClient {
  const detail: CommitDetail = {
    oid: HEAD,
    parents: [OTHER],
    children: [],
    row: 0,
    authorName: 'a',
    authorEmail: 'a@x',
    authorTime: 1,
    committerName: 'a',
    committerEmail: 'a@x',
    committerTime: 1,
    message: 'hello',
    refs: [],
    files: [{ path: 'f.txt', oldPath: null, change: { kind: 'modified' } }],
  };
  return {
    ...createNullClient(),
    commitDetail: vi.fn(async () => detail),
    searchCommits: vi.fn(async (_s, q: string) =>
      q === 'hit'
        ? { rows: [3, 7, 9], total: 3, truncated: false }
        : { rows: [], total: 0, truncated: false },
    ),
    findRow: vi.fn(async (_s, oid: string) => (oid === OTHER ? 5 : null)),
    checkout: vi.fn(async (_s, target: { kind: string; local?: string | null }) => {
      if (target.kind === 'branch') {
        throw {
          kind: 'gitFailed',
          args: ['switch'],
          status: 1,
          stderr: 'overwritten',
          hint: { kind: 'dirtyWorkTree', files: ['a.txt'] },
        };
      }
      // 로컬 master 가 origin/master 를 추적하는데 fork/master 를 체크아웃하려는 상황
      if (target.kind === 'remoteBranch' && !target.local) {
        throw {
          kind: 'localBranchTracksOther',
          local: 'master',
          remote: 'fork',
          name: 'master',
          upstream: 'refs/remotes/origin/master',
        };
      }
    }),
    deleteBranch: vi.fn(async (_s, _n: string, force: boolean) => {
      if (!force) {
        throw {
          kind: 'gitFailed',
          args: ['branch', '-d'],
          status: 1,
          stderr: 'not fully merged',
          hint: { kind: 'notFullyMerged' },
        };
      }
    }),
    merge: vi.fn(async () => 'conflicts' as const),
    commitFileDiff: vi.fn(async () => ({
      oldPath: 'f.txt',
      newPath: 'f.txt',
      change: { kind: 'modified' as const },
      binary: null,
      hunks: [],
      truncated: false,
      totalLines: 0,
      nonUtf8: false,
    })),
    stageLines: vi.fn(async () => {}),
    discardLines: vi.fn(async () => null),
  };
}

/** 스토어 하나 */
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

/** 마이크로태스크를 비운다 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SessionStore (S3)', () => {
  it('selectCommit 이 상세를 읽고 WIP 선택을 푼다', async () => {
    const { store, client: c } = setup();
    store.getState().selectCommit(HEAD);
    expect(store.getState().wipSelected).toBe(false);
    await flush();
    expect(c.commitDetail).toHaveBeenCalledWith(1, HEAD);
    expect(store.getState().detail?.message).toBe('hello');
    store.getState().selectWip();
    expect(store.getState().detail).toBeNull();
  });

  it('openCommitFile 은 커밋 파일 diff 를 읽고 statusChanged 에 흔들리지 않는다', async () => {
    const { store, client: c } = setup();
    await store.getState().openCommitFile(HEAD, 'f.txt');
    // 옛 경로를 모르면 null 로 묻는다 (새 경로만)
    expect(c.commitFileDiff).toHaveBeenCalledWith(1, HEAD, 'f.txt', null, false, {
      ignoreWhitespace: false,
      context: 3,
    });
    // 옛 가운데 화면 'diff' 단언 → diff 슬롯에 커밋 파일 (W20)
    const opened = store.getState().selectedFile;
    expect(opened).toMatchObject({ path: 'f.txt', commit: HEAD });
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: emptyRepoState({ state: 'attached', branch: 'main', oid: HEAD }).status,
      op: null,
    });
    expect(store.getState().selectedFile?.commit).toBe(HEAD);
    // 옛 가운데 화면 'diff' 단언 → 상태 이벤트가 슬롯을 비우지도 바꾸지도 않는다
    expect(store.getState().selectedFile).toBe(opened);
  });

  it('이름이 바뀐 커밋 파일은 옛 경로를 함께 넘기고, 전체 diff 를 다시 읽을 때도 그대로 넘긴다', async () => {
    const { store, client: c } = setup();
    const opts = { ignoreWhitespace: false, context: 3 };
    await store.getState().openCommitFile(HEAD, 'src/new.ts', 'src/old.ts');
    expect(c.commitFileDiff).toHaveBeenLastCalledWith(
      1,
      HEAD,
      'src/new.ts',
      'src/old.ts',
      false,
      opts,
    );
    expect(store.getState().selectedFile?.oldPath).toBe('src/old.ts');
    await store.getState().loadFullDiff();
    expect(c.commitFileDiff).toHaveBeenLastCalledWith(
      1,
      HEAD,
      'src/new.ts',
      'src/old.ts',
      true,
      opts,
    );
    // 다른 파일을 열면 옛 경로가 남지 않는다
    await store.getState().openCommitFile(HEAD, 'g.txt');
    expect(c.commitFileDiff).toHaveBeenLastCalledWith(1, HEAD, 'g.txt', null, false, opts);
  });

  it('검색은 결과·커서·스크롤 행을 관리한다', async () => {
    const { store } = setup();
    store.getState().setSearchOpen(true);
    await store.getState().runSearch('hit');
    expect(store.getState().search.rows).toEqual([3, 7, 9]);
    expect(store.getState().scrollToRow).toBe(3);
    store.getState().consumeScroll();
    store.getState().searchStep(1);
    expect(store.getState().search.cursor).toBe(1);
    expect(store.getState().scrollToRow).toBe(7);
    store.getState().searchStep(-2);
    expect(store.getState().search.cursor).toBe(2);
    await store.getState().runSearch('');
    expect(store.getState().search.rows).toEqual([]);
    expect(store.getState().search.open).toBe(true);
    store.getState().setSearchOpen(false);
    expect(store.getState().search.open).toBe(false);
  });

  it('jumpToCommit 은 행을 찾아 스크롤하고 선택한다', async () => {
    const { store } = setup();
    await store.getState().jumpToCommit(OTHER);
    expect(store.getState().scrollToRow).toBe(5);
    expect(store.getState().selectedCommit).toBe(OTHER);
    await store.getState().jumpToCommit('nope');
    expect(store.getState().selectedCommit).toBe(OTHER);
  });

  it('힌트가 있는 실패는 대화상자로, 없는 실패는 actionError 로', async () => {
    const { store, client: c } = setup();
    await store.getState().checkout({ kind: 'branch', name: 'x' });
    expect(store.getState().pendingHint).toEqual({
      kind: 'dirtyWorkTree',
      files: ['a.txt'],
      target: { kind: 'branch', name: 'x' },
    });
    expect(store.getState().actionError).toBeNull();
    store.getState().dismissHint();
    await store.getState().checkout({ kind: 'branch', name: 'x' }, true);
    expect(c.checkout).toHaveBeenLastCalledWith(1, { kind: 'branch', name: 'x' }, true);

    await store.getState().deleteBranch('feat', false);
    expect(store.getState().pendingHint).toEqual({ kind: 'notFullyMerged', name: 'feat' });
    await store.getState().deleteBranch('feat', true);
    expect(c.deleteBranch).toHaveBeenLastCalledWith(1, 'feat', true);
    expect(store.getState().busy).toBe(false);
  });

  it('원격 branch 체크아웃이 다른 원격을 추적하는 로컬과 겹치면 전용 대화상자로 (BR-02)', async () => {
    const { store, client: c } = setup();
    store.setState({
      refs: {
        ...store.getState().refs,
        labels: [
          {
            fullName: 'refs/remotes/fork/master',
            shortName: 'fork/master',
            kind: { kind: 'remoteBranch', remote: 'fork' },
            target: OTHER,
            isCurrent: false,
            upstream: null,
            ahead: null,
            behind: null,
            upstreamGone: false,
            worktreePath: null,
          },
        ],
      },
    });
    await store.getState().checkout({ kind: 'remoteBranch', remote: 'fork', name: 'master' });
    expect(store.getState().pendingHint).toEqual({
      kind: 'remoteBranchTaken',
      local: 'master',
      remote: 'fork',
      name: 'master',
      upstream: 'refs/remotes/origin/master',
      oid: OTHER,
    });
    expect(store.getState().actionError).toBeNull();
    store.getState().dismissHint();

    // 대화상자에서 고른 새 이름은 local 로 다시 보낸다
    await store
      .getState()
      .checkout({ kind: 'remoteBranch', remote: 'fork', name: 'master', local: 'fork-master' });
    expect(c.checkout).toHaveBeenLastCalledWith(
      1,
      { kind: 'remoteBranch', remote: 'fork', name: 'master', local: 'fork-master' },
      false,
    );
    expect(store.getState().pendingHint).toBeNull();
    expect(store.getState().actionError).toBeNull();
  });

  it('부분 stage·discard 는 화면의 diff 옵션을 함께 보낸다', async () => {
    const { store, client: c } = setup();
    store.setState({
      selectedFile: { path: 'f.txt', staged: false, commit: null },
      diffOptions: { ignoreWhitespace: true, context: 0, wrap: true, tabWidth: 4 },
    });
    const selection = [{ hunk: 0, lines: [] }];
    await store.getState().applyHunk(0);
    expect(c.stageLines).toHaveBeenCalledWith(1, 'f.txt', selection, false, {
      ignoreWhitespace: true,
      context: 0,
    });
    await store.getState().discardHunk(0);
    expect(c.discardLines).toHaveBeenCalledWith(1, 'f.txt', selection, {
      ignoreWhitespace: true,
      context: 0,
    });
  });

  it('merge 결과를 lastOutcome 에 남긴다', async () => {
    const { store } = setup();
    await store.getState().merge('topic', 'noFf');
    expect(store.getState().lastOutcome).toBe('conflicts');
  });
});
