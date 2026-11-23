import {
  type ChangedFile,
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type GraphRow,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore, isDefaultGraphQuery } from '../store/session-store';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

/** A 는 2행, B 는 5행인 그래프를 흉내 내는 클라이언트 */
function client(): IpcClient {
  const changed = [{ path: 'f.txt', change: { kind: 'modified' } }] as unknown as ChangedFile[];
  return {
    ...createNullClient(),
    findRow: vi.fn(async (_s, oid: string) => (oid === A ? 2 : oid === B ? 5 : null)),
    rangeFiles: vi.fn(async () => ({ base: BASE, files: changed })),
    workTreeDiff: vi.fn(async () => null),
    setGraphQuery: vi.fn(async () => {}),
    blame: vi.fn(async () => [
      {
        oid: A,
        origLine: 1,
        line: 1,
        author: 'me',
        authorMail: 'm@x',
        authorTime: 1,
        summary: 's',
        previousOid: null,
        previousPath: null,
        boundary: false,
        text: 'hello',
      },
    ]),
    fileHistory: vi.fn(async () => [
      { oid: A, subject: 's', authorName: 'me', authorTime: 1, path: 'old.txt' },
    ]),
    compareRefs: vi.fn(async () => changed),
    compareFileDiff: vi.fn(async () => null),
    searchAdvanced: vi.fn(async () => ({ rows: [3, 7], total: 2, truncated: false })),
  };
}

/** 스토어 */
function setup() {
  const head = { state: 'attached' as const, branch: 'main', oid: A };
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

/** 마이크로태스크 비우기 */
const tick = () => new Promise((r) => setTimeout(r, 0));

// 설정은 localStorage 에 남으므로 테스트마다 비운다
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // 없으면 무시
  }
});

describe('SessionStore (A3 diff·히스토리·그래프)', () => {
  it('diff 옵션이 코어 호출에 실리고 바꾸면 다시 읽는다', async () => {
    const { store, client: c } = setup();
    await store.getState().openFile('a.txt', false);
    expect(c.workTreeDiff).toHaveBeenLastCalledWith(1, 'a.txt', false, false, {
      ignoreWhitespace: false,
      context: 3,
    });
    store.getState().setDiffOptions({ ignoreWhitespace: true, context: 1 });
    await tick();
    expect(c.workTreeDiff).toHaveBeenLastCalledWith(1, 'a.txt', false, false, {
      ignoreWhitespace: true,
      context: 1,
    });
    // 뷰 전용 옵션은 다시 읽지 않는다
    const calls = (c.workTreeDiff as ReturnType<typeof vi.fn>).mock.calls.length;
    store.getState().setDiffOptions({ wrap: false, tabWidth: 8 });
    await tick();
    expect((c.workTreeDiff as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect(store.getState().diffOptions).toEqual({
      ignoreWhitespace: true,
      context: 1,
      wrap: false,
      tabWidth: 8,
    });
  });

  it('그래프 질의를 바꾸면 코어에 넘기고 범위 선택을 지운다', async () => {
    const { store, client: c } = setup();
    expect(isDefaultGraphQuery(store.getState().graphQuery)).toBe(true);
    const q = {
      revs: { kind: 'solo' as const, name: 'main' },
      hideRemotes: true,
      sort: 'topo' as const,
      firstParent: false,
      noMerges: false,
      pathScope: ['src/'],
    };
    await store.getState().setGraphQuery(q);
    expect(c.setGraphQuery).toHaveBeenCalledWith(1, q);
    expect(store.getState().graphQuery).toEqual(q);
    expect(isDefaultGraphQuery(q)).toBe(false);
  });

  it('⇧+클릭 범위는 행 순서로 newer/older 를 정하고 파일을 읽는다', async () => {
    const { store, client: c } = setup();
    store.setState({ selectedCommit: A });
    await store.getState().selectRange({ row: 5, oid: B } as unknown as GraphRow);
    const r = store.getState().range;
    expect(r).toMatchObject({ from: 2, to: 5, newer: A, older: B, base: BASE, loading: false });
    expect(r?.files.map((f) => f.path)).toEqual(['f.txt']);
    expect(c.rangeFiles).toHaveBeenCalledWith(1, A, B);
    // 범위 파일 → 결합 diff
    await store.getState().openRangeFile('f.txt');
    expect(store.getState().selectedFile?.range).toMatchObject({ base: BASE, newer: A });
    // 옛 가운데 화면 'diff' 단언 → diff 슬롯이 범위 파일이다 (W20, 위 줄과 같은 근거 — 보이는지는 워크스페이스)
    expect(store.getState().selectedFile?.path).toBe('f.txt');
    // 보통 클릭은 범위를 지운다
    store.getState().selectCommit(B);
    expect(store.getState().range).toBeNull();
    // 기준이 없으면 그냥 선택
    store.setState({ selectedCommit: null });
    await store.getState().selectRange({ row: 5, oid: B } as unknown as GraphRow);
    expect(store.getState().range).toBeNull();
    expect(store.getState().selectedCommit).toBe(B);
  });

  it('blame·파일 히스토리·비교 상태를 연다', async () => {
    const { store, client: c } = setup();
    await store.getState().openBlame('f.txt', null);
    expect(store.getState().blame).toMatchObject({ path: 'f.txt', rev: null, loading: false });
    expect(store.getState().blame?.lines[0]?.text).toBe('hello');
    store.getState().closeBlame();
    expect(store.getState().blame).toBeNull();

    await store.getState().openFileHistory('f.txt');
    expect(store.getState().fileHistory?.entries[0]?.path).toBe('old.txt');

    await store.getState().openCompare('main', 'feat', true);
    expect(store.getState().compare?.files).toHaveLength(1);
    await store.getState().compareSelectFile('f.txt');
    expect(c.compareFileDiff).toHaveBeenCalledWith(
      1,
      'main',
      'feat',
      true,
      'f.txt',
      { ignoreWhitespace: false, context: 3 },
      true,
    );
    expect(store.getState().compare?.path).toBe('f.txt');
    store.getState().closeCompare();
    expect(store.getState().compare).toBeNull();
  });

  it('고급 검색은 결과 행을 싣고 재검색 조건을 기억한다', async () => {
    const { store, client: c } = setup();
    const q = {
      text: null,
      author: 'me',
      path: null,
      pickaxe: null,
      pickaxeRegex: false,
      since: null,
      until: null,
    };
    await store.getState().runAdvancedSearch(q);
    expect(c.searchAdvanced).toHaveBeenCalledWith(1, q, 5000);
    expect(store.getState().search.rows).toEqual([3, 7]);
    expect(store.getState().search.advanced?.author).toBe('me');
    expect(store.getState().scrollToRow).toBe(3);
  });
});
