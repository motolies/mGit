// 같은 내용을 다시 읽어도 스토어 참조가 바뀌지 않게 하는 구조 공유 (G3, R9·G7). 코어 응답은 늘 새 객체로 오므로
// 시험용 클라이언트도 부를 때마다 깊은 복사본을 준다. 구독자 호출은 상태 묶음(요약·브랜치·변경·바쁨 표시 등)마다 참조가
// 바뀐 횟수로 센다
import {
  createNullClient,
  emptyRepoState,
  type FolderBranches,
  type FsEntry,
  GraphRangeCache,
  type IpcClient,
  type RepoChanges,
  type RepoOpened,
  type RepoSummary,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTree, type FileTreeSource } from '../store/file-tree';
import { FOCUS_REFRESH_GAP_MS } from '../store/focus-refresh';
import { createFolderStore, type FolderState } from '../store/folder-store';
import { createSessionStore, type SessionState } from '../store/session-store';
import { shareRows, shareValue } from '../store/structural-share';

describe('구조 공유 도우미', () => {
  it('모든 필드가 같으면 옛 값 자체를, 다르면 바뀐 부분만 새 참조로 준다', () => {
    const prev = { a: [1, 2], b: { c: 'x', d: [{ e: 1 }, { e: 2 }] } };
    expect(shareValue(prev, structuredClone(prev))).toBe(prev);
    const next = structuredClone(prev);
    next.b.d[1] = { e: 3 };
    const shared = shareValue(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared.a).toBe(prev.a);
    expect(shared.b.d[0]).toBe(prev.b.d[0]);
    expect(shared.b.d[1]).toEqual({ e: 3 });
    // 값이 undefined 인 키와 없는 키, 키 집합이 다른 객체는 다르게 본다
    expect(shareValue<Record<string, unknown>>({ a: 1 }, { a: 1, b: undefined })).toEqual({
      a: 1,
      b: undefined,
    });
    // Map·Date 같은 일반 객체가 아닌 값은 견주지 않고 새 값으로 본다
    const map = new Map([['a', 1]]);
    expect(shareValue(map, new Map([['a', 2]]))).not.toBe(map);
    const keys: Record<string, number> = { a: 1, b: 2 };
    expect(shareValue<Record<string, number>>(keys, { a: 1, c: 2 })).not.toBe(keys);
  });

  it('열쇠 목록은 줄이 끼거나 빠져도 남은 줄의 참조를 유지한다', () => {
    const prev = ['a', 'b', 'c'].map((path) => ({ path, n: 0 }));
    const next = [
      { path: 'a', n: 0 },
      { path: 'x', n: 0 },
      { path: 'c', n: 1 },
    ];
    const shared = shareRows(prev, next, (row) => row.path);
    expect(shared[0]).toBe(prev[0]);
    expect(shared[1]).toBe(next[1]);
    expect(shared[2]).not.toBe(prev[2]);
    expect(shared[2]).toEqual({ path: 'c', n: 1 });
    expect(shareRows(prev, structuredClone(prev), (row) => row.path)).toBe(prev);
  });
});

const ID = 7;
const pathOf = (name: string) => `/f/${name}`;
const REPOS = ['a', 'b', 'c'].map((name) => ({ path: pathOf(name), kind: 'standalone' as const }));

/** 요약 한 줄 */
function summary(name: string, changed = 0): RepoSummary {
  return {
    path: pathOf(name),
    name,
    kind: 'standalone',
    color: ['a', 'b', 'c'].indexOf(name),
    branch: 'main',
    detached: false,
    changed,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
  };
}

/** 변경이 있는 저장소 한 줄 */
function changes(name: string, staged = 1): RepoChanges {
  return {
    path: pathOf(name),
    name,
    branch: 'main',
    entries: [],
    summary: {
      staged,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0,
      stashCount: 0,
      upstream: null,
    },
  };
}

/** 브랜치 목록: a·b·c 에 main(a·b 현재), a 에 topic */
function branches(topicCurrent = false): FolderBranches {
  const repo = (name: string) => ({
    path: pathOf(name),
    name,
    color: ['a', 'b', 'c'].indexOf(name),
    head: { state: 'attached' as const, branch: 'main', oid: '0'.repeat(40) },
    error: null,
  });
  const at = (name: string, current = false) => ({
    path: pathOf(name),
    color: ['a', 'b', 'c'].indexOf(name),
    current,
    upstream: null,
    ahead: null,
    behind: null,
    gone: false,
  });
  return {
    repos: [repo('a'), repo('b'), repo('c')],
    branches: [
      {
        name: 'main',
        remote: false,
        remoteName: null,
        repos: [at('a', true), at('b', true), at('c')],
      },
      { name: 'topic', remote: false, remoteName: null, repos: [at('a', topicCurrent)] },
    ],
  };
}

/** 코어가 지금 돌려줄 값 (테스트가 바꾼다). 응답은 부를 때마다 깊은 복사본이다 */
const model = {
  summaries: [] as RepoSummary[],
  branches: branches(),
  changes: [] as RepoChanges[],
};

/** 폴더 스토어를 만들고 처음 읽기·변경 목록 읽기까지 끝낸다 */
async function openedFolder() {
  model.summaries = [summary('a'), summary('b'), summary('c')];
  model.branches = branches();
  model.changes = [changes('a'), changes('b')];
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: vi.fn(async () => structuredClone(model.summaries)),
    folderBranches: vi.fn(async () => structuredClone(model.branches)),
    folderChanges: vi.fn(async () => structuredClone(model.changes)),
  };
  const store = createFolderStore({ session: ID, path: '/f', repos: REPOS }, client);
  await vi.advanceTimersByTimeAsync(0);
  await store.getState().ensureChanges();
  await vi.advanceTimersByTimeAsync(0);
  return { store };
}

/** 상태 묶음마다 참조가 바뀐 횟수와, 바쁨 표시가 켜진 적이 있는지 센다 */
function watchFolder(store: ReturnType<typeof createFolderStore>) {
  const seen = {
    calls: 0,
    summaries: 0,
    branches: 0,
    changes: 0,
    loading: 0,
    busyShown: false,
    changedKeys: new Set<string>(),
  };
  const off = store.subscribe((now: FolderState, before: FolderState) => {
    seen.calls += 1;
    for (const key of Object.keys(now) as (keyof FolderState)[]) {
      if (now[key] !== before[key]) seen.changedKeys.add(key);
    }
    if (now.summaries !== before.summaries) seen.summaries += 1;
    if (now.branches !== before.branches) seen.branches += 1;
    if (now.changes !== before.changes) seen.changes += 1;
    if (now.loading !== before.loading) seen.loading += 1;
    if (now.loading) seen.busyShown = true;
  });
  return { seen, off };
}

/** 포커스 갱신 간격(G4)이 지난 뒤 창 포커스(배경 전부 읽기)를 보내고 읽기가 끝나기를 기다린다 */
async function focusRefresh() {
  await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_GAP_MS);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
}

describe('폴더 스토어 전부 읽기', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('같은 응답으로 창 포커스 전부 읽기를 두 번 해도 요약·브랜치·변경 참조가 그대로이고 바쁨 표시도 켜지지 않는다', async () => {
    const { store } = await openedFolder();
    const stop = store.getState().startAutoRefresh();
    const before = store.getState();
    const { seen, off } = watchFolder(store);
    await focusRefresh();
    await focusRefresh();
    off();
    stop();
    // 고치기 전: 구독자 호출 6, 요약·브랜치·변경 참조 교체 각 2, 바쁨 표시 토글 4. 이제 읽은 시각(대시보드 표시)만 바뀐다
    expect(store.getState().summaries).toBe(before.summaries);
    expect(store.getState().branches).toBe(before.branches);
    expect(store.getState().changes).toBe(before.changes);
    expect(seen).toMatchObject({ summaries: 0, branches: 0, changes: 0, loading: 0 });
    expect(seen.busyShown).toBe(false);
    // 읽을 때마다 `set` 은 한 번 불리지만 바뀌는 값은 읽은 시각뿐이다 (가짜 시계라 여기서는 그것도 그대로다)
    expect(seen.calls).toBe(2);
    expect([...seen.changedKeys].filter((key) => key !== 'refreshedAt')).toEqual([]);
  });

  it('저장소 하나·브랜치 하나만 바뀌면 그 줄만 새 참조이고 나머지 줄은 옛 참조다', async () => {
    const { store } = await openedFolder();
    const stop = store.getState().startAutoRefresh();
    const before = store.getState();
    model.summaries = [summary('a'), summary('b', 5), summary('c')];
    model.changes = [changes('a'), changes('b', 2)];
    model.branches = branches(true);
    await focusRefresh();
    stop();
    const after = store.getState();
    expect(after.summaries).not.toBe(before.summaries);
    expect(after.summaries[0]).toBe(before.summaries[0]);
    expect(after.summaries[2]).toBe(before.summaries[2]);
    expect(after.summaries[1]?.changed).toBe(5);
    expect(after.changes[0]).toBe(before.changes[0]);
    expect(after.changes[1]?.summary.staged).toBe(2);
    expect(after.branches?.repos).toBe(before.branches?.repos);
    expect(after.branches?.branches[0]).toBe(before.branches?.branches[0]);
    expect(after.branches?.branches[1]?.repos[0]?.current).toBe(true);
  });

  it('사용자가 누른 새로고침은 지금처럼 바쁨 표시를 켰다 끈다', async () => {
    const { store } = await openedFolder();
    const { seen, off } = watchFolder(store);
    await store.getState().refresh();
    off();
    expect(seen.busyShown).toBe(true);
    expect(store.getState().loading).toBe(false);
    expect(seen.loading).toBe(2);
  });
});

/** 저장소 세션 스토어 (읽기 응답은 테스트가 바꾸는 `replies` 의 깊은 복사본) */
function openedSession(replies: Record<string, unknown>) {
  const head = { state: 'attached' as const, branch: 'main', oid: 'a'.repeat(40) };
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
  const reply = (name: string) => async () => structuredClone(replies[name]);
  const client = {
    ...createNullClient(),
    submodules: vi.fn(reply('submodules')),
    undoState: vi.fn(reply('undoState')),
    listStashes: vi.fn(reply('stashes')),
    worktreeWips: vi.fn(reply('worktreeWips')),
    rerereStatus: vi.fn(reply('rerere')),
    keptResolutions: vi.fn(reply('kept')),
    renameConflicts: vi.fn(reply('renameConflicts')),
    backups: vi.fn(reply('backups')),
    conflictRadar: vi.fn(reply('radar')),
  } as unknown as IpcClient;
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(opened, client, cache);
  // 워크트리가 둘 이상이어야 워크트리 WIP 를 읽는다
  const refs = store.getState().refs;
  store.setState({
    refs: {
      ...refs,
      worktrees: [
        { path: '/r', head: null, branch: 'main', bare: false, locked: false, prunable: false },
        { path: '/w', head: null, branch: 'wt', bare: false, locked: false, prunable: false },
      ] as unknown as SessionState['refs']['worktrees'],
    },
  });
  return store;
}

/** 로더마다: 이름, 읽는 상태 키, 처음 응답, 바뀐 응답 */
const LOADERS = [
  ['loadSubmodules', 'submodules', [{ path: 'lib', oid: '1' }], [{ path: 'lib', oid: '2' }]],
  [
    'loadUndo',
    'undoState',
    { entries: [{ label: 'commit' }], redoCount: 0 },
    { entries: [], redoCount: 1 },
  ],
  [
    'loadStashes',
    'stashes',
    [{ info: { oid: 's1', message: 'm' } }],
    [{ info: { oid: 's2', message: 'n' } }],
  ],
  ['loadWorktreeWips', 'worktreeWips', [{ path: '/w', changed: 1 }], [{ path: '/w', changed: 2 }]],
  [
    'loadRerere',
    'rerere',
    { enabled: true, autoupdate: false, resolvedPaths: [] },
    { enabled: false, autoupdate: false, resolvedPaths: [] },
  ],
  [
    'loadKept',
    'kept',
    [{ opKey: 'k', matchesCurrent: false, paths: ['a'] }],
    [{ opKey: 'k', matchesCurrent: false, paths: ['b'] }],
  ],
  ['loadRenameConflicts', 'renameConflicts', [{ from: 'a', to: 'b' }], [{ from: 'a', to: 'c' }]],
  ['loadBackups', 'backups', [{ name: 'refs/mgit/backup/1' }], [{ name: 'refs/mgit/backup/2' }]],
  ['loadRadar', 'radar', [{ branch: 'topic', files: ['a'] }], [{ branch: 'topic', files: ['b'] }]],
] as const;

describe('세션 스토어의 후속 읽기', () => {
  it.each(LOADERS)(
    '%s: 같은 응답이면 넣지 않고, 다른 응답이면 넣는다',
    async (loader, key, first, second) => {
      const replies: Record<string, unknown> = { [key]: first };
      const store = openedSession(replies);
      const run = () => (store.getState()[loader] as () => Promise<void>)();
      await run();
      // 세션을 열 때 돌던 읽기(명령 설정 등)가 끝나기를 기다린다
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.getState()[key]).toEqual(first);
      const kept = store.getState()[key];
      let calls = 0;
      const off = store.subscribe(() => {
        calls += 1;
      });
      await run();
      expect(calls).toBe(0);
      expect(store.getState()[key]).toBe(kept);
      replies[key] = second;
      await run();
      off();
      expect(store.getState()[key]).toEqual(second);
      expect(calls).toBeGreaterThan(0);
    },
  );

  it('ref·status 이벤트는 바뀌지 않은 목록·줄의 옛 참조를 유지한다', () => {
    const store = openedSession({});
    const st = () => store.getState();
    const labels = [
      {
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: { kind: 'localBranch' },
        target: 'a',
        isCurrent: true,
        upstreamGone: false,
      },
    ] as unknown as SessionState['refs']['labels'];
    store
      .getState()
      .applyEvent({ type: 'refsChanged', session: 1, refs: { ...st().refs, labels } });
    const before = st().refs;
    // 라벨은 그대로, stash 목록만 바뀐 ref 변경
    store.getState().applyEvent({
      type: 'refsChanged',
      session: 1,
      refs: {
        ...structuredClone(before),
        stashes: [
          { index: 0, oid: 'b'.repeat(40), message: 'wip' },
        ] as unknown as SessionState['refs']['stashes'],
      },
    });
    expect(st().refs).not.toBe(before);
    expect(st().refs.labels).toBe(before.labels);
    expect(st().refs.head).toBe(before.head);
    // 한 줄만 바뀐 status: 나머지 줄은 옛 참조
    const entry = (path: string, index: string, worktree: string) => ({
      path,
      origPath: null,
      index,
      worktree,
      submodule: null,
      conflict: null,
      renameScore: null,
    });
    const statusOf = (entries: ReturnType<typeof entry>[]) =>
      ({ ...structuredClone(st().status), entries }) as unknown as SessionState['status'];
    const a = entry('a.txt', 'unmodified', 'modified');
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: statusOf([a, entry('b.txt', 'modified', 'unmodified')]),
      op: null,
    });
    const first = st().status;
    // 작업 트리 diff 로 a.txt 를 보고 있다
    const target = {
      path: 'a.txt',
      staged: false,
      commit: null,
      origin: {
        kind: 'worktree' as const,
        staged: false,
        repoPath: '/r',
        files: [first.entries[0]],
      },
    } as unknown as SessionState['selectedFile'];
    store.setState({ selectedFile: target });
    // 스테이지된 b.txt 만 바뀌었다: a.txt 줄과 작업 트리 쪽 파일 목록은 그대로다
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: statusOf([structuredClone(a), entry('b.txt', 'added', 'unmodified')]),
      op: null,
    });
    expect(st().status.entries[0]).toBe(first.entries[0]);
    expect(st().status.entries[1]).not.toBe(first.entries[1]);
    expect(st().status.summary).toBe(first.summary);
    expect(st().selectedFile).toBe(target);
    // a.txt 가 바뀌면 고른 대상도 새 파일 목록으로 바뀐다
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: statusOf([
        entry('a.txt', 'unmodified', 'deleted'),
        entry('b.txt', 'added', 'unmodified'),
      ]),
      op: null,
    });
    expect(st().selectedFile).not.toBe(target);
    expect(st().selectedFile?.origin?.files[0]).toMatchObject({
      path: 'a.txt',
      worktree: 'deleted',
    });
  });
});

describe('파일 트리 다시 읽기', () => {
  it('나열이 같으면 디렉터리 항목이 요청 전 참조로 돌아오고, 한 디렉터리만 바뀌면 그 디렉터리의 바뀐 줄만 새 참조다', async () => {
    const file = (name: string, size = 1) => ({
      name,
      kind: 'file' as const,
      size,
      mtimeMs: 0,
      openable: true,
    });
    const listings: Record<string, FsEntry[]> = {
      '': [{ name: 'src', kind: 'dir', size: null, mtimeMs: 0, openable: false }, file('a.md')],
      src: [file('main.ts'), file('util.ts')],
    };
    const source: FileTreeSource = {
      list: async (dir) => {
        const entries = structuredClone(listings[dir] ?? []);
        return {
          kind: 'listed',
          entries,
          total: entries.length,
          truncated: false,
          nonUtf8Names: 0,
        };
      },
      read: async () => ({ kind: 'missing' }),
    };
    const tree = createFileTree(source);
    tree.getState().open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    tree.getState().setExpanded('src', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = tree.getState().dirs;
    await tree.getState().reload();
    expect(tree.getState().dirs['']).toBe(first['']);
    expect(tree.getState().dirs.src).toBe(first.src);
    listings.src = [file('main.ts'), file('util.ts', 2)];
    await tree.getState().reload();
    const after = tree.getState().dirs;
    expect(after['']).toBe(first['']);
    expect(after.src).not.toBe(first.src);
    const entriesOf = (state: (typeof after)[string] | undefined) =>
      state?.load.state === 'listed' ? state.load.entries : [];
    expect(entriesOf(after.src)[0]).toBe(entriesOf(first.src)[0]);
    expect(entriesOf(after.src)[1]?.size).toBe(2);
    tree.getState().dispose();
  });
});
