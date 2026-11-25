import type { GraphViewProps } from '@mgit/graph-view';
import {
  type ChangedFile,
  type CommitDetail,
  createNullClient,
  type DiffChange,
  emptyRepoState,
  type FileDiff,
  type GraphRow,
  type IpcClient,
  type RepoOpened,
  type TimelineInfo,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBody } from '../App';
import { withText } from '../features/filter-bar/filter-model';
import { revealNoticeOf } from '../features/folder/FolderTimeline';
import { BlameDialog } from '../features/history/BlameDialog';
import { FileHistoryDialog } from '../features/history/FileHistoryDialog';
import { useAppStore } from '../store';
import { DEFAULT_DOCK, type SessionMeta } from '../store/app-store';
import { createFolderStore, type FolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { createWorkspaceStore, type WorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';
import { documentOf } from './diff-document-fixture';

// 로그는 jsdom 에서 그릴 수 없다. 로그 탭이 뷰에 무엇을 넘기는지만 본다 (뷰 자체는 graph-view 가 테스트한다)
const h = vi.hoisted(() => ({ last: null as unknown }));
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (props: GraphViewProps) => {
    h.last = props;
    return <div data-testid="graph-view" />;
  },
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

const FOLDER_ID = 41;
const ROOT = '/f';
const API = `${ROOT}/api`;
const WEB = `${ROOT}/web`;
const OID = 'a1b2c3d4'.padEnd(40, '1');
const OTHER = 'b2c3d4e5'.padEnd(40, '2');
const PARENT = 'c3d4e5f6'.padEnd(40, '3');

const INFO: TimelineInfo = {
  generation: 1,
  rows: 10,
  finished: true,
  maxPerRepo: 10000,
  repos: [
    {
      index: 0,
      name: 'api',
      path: API,
      color: 0,
      headBranch: 'main',
      truncated: false,
      error: null,
      inScope: true,
    },
    {
      index: 1,
      name: 'web',
      path: WEB,
      color: 1,
      headBranch: 'main',
      truncated: false,
      error: null,
      inScope: true,
    },
  ],
  scoped: false,
};

/** 변경 파일 하나 */
function changed(
  path: string,
  kind: DiffChange['kind'] = 'modified',
  oldPath?: string,
): ChangedFile {
  const change =
    kind === 'renamed' ? ({ kind, similarity: 90 } as DiffChange) : ({ kind } as DiffChange);
  return { path, oldPath: oldPath ?? null, change };
}

const FILES = [
  changed('src/a/one.ts', 'added'),
  changed('src/a/two.ts'),
  changed('docs/new.md', 'renamed', 'docs/old.md'),
];

/** 커밋 상세 응답 */
function detailOf(oid: string, partial: Partial<CommitDetail> = {}): CommitDetail {
  return {
    oid,
    parents: [PARENT],
    children: [],
    row: 2,
    authorName: 'Jamie Park',
    authorEmail: 'jamie@acme.dev',
    authorTime: 1761632400,
    committerName: 'Jamie Park',
    committerEmail: 'jamie@acme.dev',
    committerTime: 1761632400,
    message: `${oid.slice(0, 8)} 의 제목\n\n본문`,
    refs: [],
    files: FILES,
    ...partial,
  };
}

/** 그 경로가 보이는 diff 응답 (줄 글자로 어느 파일의 응답인지 가린다) */
function diffOf(path: string, marker = path): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    change: { kind: 'modified' },
    binary: null,
    truncated: false,
    totalLines: 1,
    nonUtf8: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        section: '',
        lines: [
          { kind: 'add', text: `diff of ${marker}`, oldNo: null, newNo: 1, noNewline: false },
        ],
      },
    ],
  };
}

/** 미뤄 둔 응답 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 폴더가 연 가벼운 세션 응답 (W13) */
function lightOpened(session: number, repo: string): RepoOpened {
  const head = { state: 'attached' as const, branch: 'main', oid: OID };
  return {
    session,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: repo,
      gitDir: `${repo}/.git`,
      commonDir: `${repo}/.git`,
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState(head),
    profile: 'light',
    promoted: false,
  };
}

/**
 * 폴더 장면의 가짜 클라이언트. 세션을 여는 `openRepo`·`folderOpenRepoSession`(W13 가벼운 세션)과 읽기 호출을 기록한다.
 * 가벼운 세션은 저장소마다 id 를 하나씩 준다 (같은 저장소를 다시 열면 같은 id 로 `alreadyOpen`)
 */
function folderClient(overrides: Partial<IpcClient> = {}) {
  const lightIds = new Map<string, number>();
  const spies = {
    openRepo: vi.fn<IpcClient['openRepo']>(async () => {
      throw new Error('세션을 열면 안 된다');
    }),
    folderOpenRepoSession: vi.fn<IpcClient['folderOpenRepoSession']>(async (_f, repo) => {
      const known = lightIds.get(repo);
      const id = known ?? 500 + lightIds.size;
      lightIds.set(repo, id);
      return { ...lightOpened(id, repo), alreadyOpen: known !== undefined };
    }),
    fileHistory: vi.fn<IpcClient['fileHistory']>(async (_s, path) => [
      { oid: OID, subject: '히스토리 첫 커밋', authorName: 'Jamie', authorTime: 1761632400, path },
    ]),
    blame: vi.fn<IpcClient['blame']>(async () => []),
    openDifftool: vi.fn<IpcClient['openDifftool']>(async () => {}),
    folderCommitDetail: vi.fn<IpcClient['folderCommitDetail']>(async (_s, _repo, oid) =>
      detailOf(oid),
    ),
    folderCommitFileDiffDocument: vi.fn<IpcClient['folderCommitFileDiffDocument']>(
      async (_s, _r, _o, path) => documentOf(diffOf(path)),
    ),
    folderTimelineFindRow: vi.fn<IpcClient['folderTimelineFindRow']>(async () => 7),
  };
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => [],
    folderTimelineOpen: async () => INFO,
    folderTimelineInfo: async () => INFO,
    ...spies,
    ...overrides,
  };
  return { client, spies };
}

/** 폴더 스토어 하나 (화면 없이) */
function folderStore(client: IpcClient): FolderStore {
  return createFolderStore(
    {
      session: FOLDER_ID,
      path: ROOT,
      repos: [API, WEB].map((path) => ({ path, kind: 'standalone' as const })),
    },
    client,
  );
}

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  disposeFolder(FOLDER_ID);
  disposeWorkspace(FOLDER_ID);
  clearSessionRegistry();
});

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  h.last = null;
});

describe('폴더 스토어: 로그 선택 → 커밋 상세 (LG-07, CD-05)', () => {
  it('행을 고르면 폴더 API 로 상세를 읽는다. 저장소 세션을 열지 않는다', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    store.getState().selectTimelineRow(WEB, OID);
    expect(store.getState().timeline.detail).toMatchObject({ state: 'loading' });
    await tick();
    expect(spies.folderCommitDetail).toHaveBeenCalledWith(FOLDER_ID, WEB, OID);
    expect(store.getState().timeline.detail).toMatchObject({
      of: { repoPath: WEB, oid: OID },
      state: 'ready',
      detail: { oid: OID },
    });
    expect(spies.openRepo).not.toHaveBeenCalled();
    expect(spies.folderOpenRepoSession).not.toHaveBeenCalled();
  });

  it('빠르게 여러 행을 고르면 마지막 선택의 응답만 반영한다 (늦게 온 옛 응답은 버린다)', async () => {
    const first = deferred<CommitDetail>();
    const second = deferred<CommitDetail>();
    const { client } = folderClient({
      folderCommitDetail: vi.fn(async (_s, _r, oid) =>
        oid === OID ? first.promise : second.promise,
      ),
    });
    const store = folderStore(client);
    store.getState().selectTimelineRow(WEB, OID);
    store.getState().selectTimelineRow(API, OTHER);
    second.resolve(detailOf(OTHER));
    await tick();
    first.resolve(detailOf(OID));
    await tick();
    expect(store.getState().timeline.selected).toEqual({ repoPath: API, oid: OTHER });
    expect(store.getState().timeline.detail?.detail?.oid).toBe(OTHER);
  });

  it('같은 행 재선택은 재사용하고 타임라인 재로드 뒤에는 선택 상세를 다시 읽는다', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().selectTimelineRow(WEB, OID);
    await tick();
    store.getState().selectTimelineRow(WEB, OID);
    expect(spies.folderCommitDetail).toHaveBeenCalledTimes(1);
    store.getState().applyEvent({
      type: 'graphReloaded',
      session: FOLDER_ID,
      generation: 2,
      rows: 10,
      laneCount: 2,
    });
    store.getState().applyEvent({ type: 'folderRescanned', session: FOLDER_ID, repos: [] });
    await tick();
    expect(spies.folderCommitDetail).toHaveBeenCalledTimes(2);
    expect(store.getState().timeline.detail?.state).toBe('ready');
    expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: OID });
  });

  it('재로드 전에 시작한 상세 응답은 새 타임라인 상세를 덮어쓰지 않는다', async () => {
    const old = deferred<CommitDetail>();
    let calls = 0;
    const { client } = folderClient({
      folderCommitDetail: async () =>
        ++calls === 1 ? old.promise : detailOf(OID, { children: [OTHER] }),
    });
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().selectTimelineRow(WEB, OID);
    store.getState().applyEvent({
      type: 'graphReloaded',
      session: FOLDER_ID,
      generation: 2,
      rows: 10,
      laneCount: 2,
    });
    await tick();
    old.resolve(detailOf(OID, { children: [] }));
    await tick();
    expect(calls).toBe(2);
    expect(store.getState().timeline.detail?.detail?.children).toEqual([OTHER]);
  });

  it('읽지 못하면 오류 상태이고, 다시 시도하거나 같은 행을 다시 고르면 다시 읽는다', async () => {
    let fail = true;
    const { client, spies } = folderClient({
      folderCommitDetail: vi.fn(async (_s, _r, oid) => {
        if (fail) {
          throw new Error('bad object');
        }
        return detailOf(oid);
      }),
    });
    const store = folderStore(client);
    store.getState().selectTimelineRow(WEB, OID);
    await tick();
    expect(store.getState().timeline.detail).toMatchObject({ state: 'error' });
    expect(store.getState().timeline.detail?.error).toContain('bad object');
    store.getState().selectTimelineRow(WEB, OID);
    await tick();
    expect(client.folderCommitDetail).toHaveBeenCalledTimes(2);
    fail = false;
    store.getState().reloadTimelineDetail();
    await tick();
    expect(store.getState().timeline.detail?.state).toBe('ready');
    expect(spies.openRepo).not.toHaveBeenCalled();
  });

  it('질의를 바꾸면 선택과 상세를 비우고, 그 전에 보낸 요청의 응답은 버린다', async () => {
    const pending = deferred<CommitDetail>();
    const { client } = folderClient({ folderCommitDetail: vi.fn(() => pending.promise) });
    const store = folderStore(client);
    store.getState().selectTimelineRow(WEB, OID);
    await store.getState().setTimelineQuery({
      ...store.getState().timeline.query,
      hideRemotes: true,
    });
    pending.resolve(detailOf(OID));
    await tick();
    expect(store.getState().timeline.selected).toBeNull();
    expect(store.getState().timeline.detail).toBeNull();
  });

  it('커밋 diff 탭의 로더는 폴더 id 와 저장소 경로로 파일 diff 를 읽는다', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    const opts = { ignoreWhitespace: true, context: 5 };
    expect(
      await store.getState().readCommitFileDiff(WEB, OID, 'docs/new.md', 'docs/old.md', true, opts),
    ).toEqual(documentOf(diffOf('docs/new.md')));
    expect(spies.folderCommitFileDiffDocument).toHaveBeenCalledWith(
      FOLDER_ID,
      WEB,
      OID,
      'docs/new.md',
      'docs/old.md',
      true,
      opts,
    );
  });
});

describe('폴더 스토어: 로그에서 커밋 보이기 (W19)', () => {
  it('고르고 지금 로그에서 행을 찾는다: 찾으면 found(행), 로그가 스크롤했다고 알리면 scrolled', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().revealTimelineCommit(WEB, OID);
    expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: OID });
    expect(store.getState().timeline.reveal).toMatchObject({ state: 'finding', row: null });
    await tick();
    expect(spies.folderTimelineFindRow).toHaveBeenCalledWith(FOLDER_ID, 1, OID);
    const reveal = store.getState().timeline.reveal;
    expect(reveal).toMatchObject({ state: 'found', row: 7, scrolled: false });
    store.getState().ackTimelineReveal(reveal?.seq ?? -1);
    expect(store.getState().timeline.reveal?.scrolled).toBe(true);
    expect(store.getState().timeline.detail?.state).toBe('ready');
  });

  it('로그를 아직 열지 않았으면 기다렸다가, 열려 다 읽으면 찾는다', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    store.getState().revealTimelineCommit(API, OID);
    await tick();
    expect(spies.folderTimelineFindRow).not.toHaveBeenCalled();
    expect(store.getState().timeline.reveal?.state).toBe('finding');
    await store.getState().openTimeline();
    await tick();
    expect(spies.folderTimelineFindRow).toHaveBeenCalledWith(FOLDER_ID, 0, OID);
    expect(store.getState().timeline.reveal?.state).toBe('found');
  });

  it('지금 로그에 없으면 missing (범위 밖 저장소는 찾지도 않는다)', async () => {
    const outOfScope: TimelineInfo = {
      ...INFO,
      repos: INFO.repos.map((r) => (r.path === API ? { ...r, inScope: false } : r)),
    };
    const findRow = vi.fn<IpcClient['folderTimelineFindRow']>(async () => null);
    const { client } = folderClient({
      folderTimelineFindRow: findRow,
      folderTimelineOpen: async () => outOfScope,
      folderTimelineInfo: async () => outOfScope,
    });
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().revealTimelineCommit(WEB, OID);
    await tick();
    expect(store.getState().timeline.reveal).toMatchObject({ state: 'missing', row: null });
    store.getState().revealTimelineCommit(API, OTHER);
    await tick();
    expect(store.getState().timeline.reveal).toMatchObject({
      of: { repoPath: API, oid: OTHER },
      state: 'missing',
    });
    expect(findRow).toHaveBeenCalledTimes(1);
  });

  it('로그에서 다른 커밋을 고르거나 질의를 바꾸면 요청이 끝나고, 늦게 온 옛 찾기 응답은 버린다', async () => {
    const first = deferred<number | null>();
    const { client } = folderClient({
      folderTimelineFindRow: vi.fn(() => first.promise),
    });
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().revealTimelineCommit(WEB, OID);
    // 같은 커밋을 다시 고르는 것은 요청을 끝내지 않는다
    store.getState().selectTimelineRow(WEB, OID);
    expect(store.getState().timeline.reveal).not.toBeNull();
    store.getState().selectTimelineRow(API, OTHER);
    expect(store.getState().timeline.reveal).toBeNull();
    first.resolve(3);
    await tick();
    expect(store.getState().timeline.reveal).toBeNull();

    store.getState().revealTimelineCommit(WEB, OID);
    await store.getState().setTimelineQuery({ ...store.getState().timeline.query, noMerges: true });
    expect(store.getState().timeline.reveal).toBeNull();
  });

  it('범위를 바꿔도 고른 커밋이 남으면 새 범위의 로그를 다 읽은 뒤 다시 찾는다', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().revealTimelineCommit(WEB, OID);
    await tick();
    const before = store.getState().timeline.reveal;
    expect(before?.state).toBe('found');
    await store.getState().setTimelineScope([WEB]);
    const finding = store.getState().timeline.reveal;
    expect(finding).toMatchObject({ state: 'finding', row: null });
    expect(finding?.seq).toBeGreaterThan(before?.seq ?? 0);
    expect(spies.folderTimelineFindRow).toHaveBeenCalledTimes(1);
    store.getState().applyEvent({
      type: 'graphReloaded',
      session: FOLDER_ID,
      generation: 2,
      rows: 10,
      laneCount: 1,
    });
    await tick();
    expect(spies.folderTimelineFindRow).toHaveBeenCalledTimes(2);
    expect(store.getState().timeline.reveal).toMatchObject({ state: 'found', row: 7 });
  });

  it('revealOnNextLoad: 질의를 바꾼 뒤 처음 온 데이터에서 그 커밋을 다시 고르고 찾는다 ("필터 지우고 보기")', async () => {
    const { client, spies } = folderClient();
    const store = folderStore(client);
    await store.getState().openTimeline();
    store.getState().revealOnNextLoad({ repoPath: WEB, oid: PARENT });
    await store.getState().setTimelineQuery({ ...store.getState().timeline.query, noMerges: true });
    expect(store.getState().timeline.selected).toBeNull();
    store.getState().applyEvent({
      type: 'graphReloaded',
      session: FOLDER_ID,
      generation: 2,
      rows: 10,
      laneCount: 1,
    });
    await tick();
    expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: PARENT });
    expect(spies.folderTimelineFindRow).toHaveBeenLastCalledWith(FOLDER_ID, 1, PARENT);
    expect(store.getState().timeline.reveal).toMatchObject({ state: 'found', row: 7 });
  });
});

describe('로그 위 안내의 판정 (W19)', () => {
  const of = { repoPath: WEB, oid: OID };
  const reveal = (state: 'finding' | 'found' | 'missing') => ({
    seq: 1,
    of,
    state,
    row: state === 'found' ? 3 : null,
    scrolled: false,
  });
  it('지금 고른 커밋의 요청이 missing 일 때만: 필터가 걸려 있으면 filtered, 아니면 absent', () => {
    expect(revealNoticeOf(reveal('missing'), of, true)).toBe('filtered');
    expect(revealNoticeOf(reveal('missing'), of, false)).toBe('absent');
    expect(revealNoticeOf(reveal('found'), of, true)).toBeNull();
    expect(revealNoticeOf(reveal('finding'), of, true)).toBeNull();
    expect(revealNoticeOf(null, of, true)).toBeNull();
    expect(revealNoticeOf(reveal('missing'), { repoPath: API, oid: OID }, true)).toBeNull();
  });
});

/** 행 하나 (로그 뷰가 넘기는 값) */
function row(oid: string, repo: number, partial: Partial<GraphRow> = {}): GraphRow {
  return {
    row: 2,
    oid,
    parents: [PARENT],
    authorName: 'Jamie Park',
    authorEmail: 'jamie@acme.dev',
    authorTime: 0,
    commitTime: 0,
    subject: '제목',
    lane: 0,
    color: repo,
    refs: [],
    isHead: false,
    inHead: true,
    repo,
    ...partial,
  };
}

describe('폴더 탭: 변경 파일 트리 → 커밋 diff 탭 (CD-01·04·05, ED-02·03)', () => {
  /**
   * 폴더 탭을 등록하고 앱 본문(과 폴더 탭에서 마운트되는 세션 대화상자 둘)을 그린다. 로그 탭이 보이고 타임라인이
   * 열릴 때까지 기다린다. 앱 스토어의 클라이언트도 이 가짜로 바꿔 저장소 세션 열기(W13)를 기록한다
   */
  async function setup(overrides: Partial<IpcClient> = {}) {
    const { client, spies } = folderClient(overrides);
    const store = folderStore(client);
    registerFolder(FOLDER_ID, store);
    const workspace: WorkspaceStore = createWorkspaceStore('folder');
    registerWorkspace(FOLDER_ID, workspace);
    const original = useAppStore.getState().openRepositoryAt;
    const originalClient = useAppStore.getState().client;
    const openRepositoryAt = vi.fn(async () => null);
    const meta: SessionMeta = {
      id: FOLDER_ID,
      kind: 'folder',
      path: ROOT,
      name: 'f',
      parent: null,
    };
    act(() => {
      useAppStore.setState({
        sessions: { [FOLDER_ID]: meta },
        sessionOrder: [FOLDER_ID],
        activeSessionId: FOLDER_ID,
        dock: DEFAULT_DOCK,
        leftTool: 'project',
        openRepositoryAt,
        client,
      });
    });
    render(
      <>
        <AppBody actions={[]} />
        <FileHistoryDialog />
        <BlameDialog />
      </>,
    );
    await tick();
    const restore = () =>
      act(() => useAppStore.setState({ openRepositoryAt: original, client: originalClient }));
    return { store, workspace, spies, openRepositoryAt, restore };
  }

  const view = () => h.last as GraphViewProps;
  const detailArea = () => document.querySelector<HTMLElement>('[data-panel="git-detail"]');
  const editorArea = () => document.querySelector<HTMLElement>('[data-panel="editor"]');
  /** 변경 파일 트리의 이름이 정확히 그것인 행 */
  const fileRow = (name: string) => {
    const el = [...(detailArea()?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(
      (item) => [...item.querySelectorAll('span')].some((s) => s.textContent === name),
    );
    if (!el) {
      throw new Error(`행 없음: ${name}`);
    }
    return el;
  };
  /** 에디터 탭 막대: `제목` (미리보기는 `~제목`, 활성은 `[ ]`) */
  const tabs = () =>
    within(editorArea() as HTMLElement)
      .getAllByRole('tab')
      .map((tab) => {
        const title = tab.firstChild?.textContent ?? '';
        const name =
          tab.parentElement?.getAttribute('data-preview') === 'true' ? `~${title}` : title;
        return tab.getAttribute('aria-selected') === 'true' ? `[${name}]` : name;
      });

  it('상세 칸은 커밋을 고르기 전에 안내를 보이고, 행을 고르면 저장소 루트(색·파일 수)와 상세가 뜬다', async () => {
    const { spies, restore } = await setup();
    try {
      expect(detailArea()?.textContent).toContain(S.detail.pickCommit);
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      const tree = within(detailArea() as HTMLElement).getByRole('tree');
      const root = within(tree).getAllByRole('treeitem')[0] as HTMLElement;
      expect(root.textContent).toContain('web');
      expect(root.textContent).toContain(S.detail.fileCount(3));
      expect(within(root).getByTestId('repo-swatch').style.getPropertyValue('--repo-color')).toBe(
        'var(--graph-lane-1)',
      );
      expect(detailArea()?.textContent).toContain(`${OID.slice(0, 8)} 의 제목`);
      expect(detailArea()?.textContent).toContain('<jamie@acme.dev>');
      // 로그 선택은 에디터 탭을 바꾸지 않는다 (선택 연동 규칙)
      expect(tabs()).toEqual([`[${S.workspace.overview}]`]);
      expect(spies.openRepo).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('파일 클릭 = 미리보기 탭(교체), 더블클릭 = 고정 탭. 로그 선택은 그대로이고 세션을 열지 않는다', async () => {
    const { store, spies, openRepositoryAt, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.click(fileRow('one.ts'));
      await tick();
      expect(tabs()).toEqual([S.workspace.overview, `[~one.ts @a1b2c3d4]`]);
      expect(spies.folderCommitFileDiffDocument).toHaveBeenLastCalledWith(
        FOLDER_ID,
        WEB,
        OID,
        'src/a/one.ts',
        null,
        false,
        { ignoreWhitespace: false, context: 3 },
      );
      expect(editorArea()?.textContent).toContain('diff of src/a/one.ts');

      // 다른 파일을 누르면 같은 미리보기 탭이 교체된다
      fireEvent.click(fileRow('new.md'));
      await tick();
      expect(tabs()).toEqual([S.workspace.overview, `[~new.md @a1b2c3d4]`]);
      // rename 은 옛 경로를 함께 넘겨 이름 변경으로 짝지어진다
      expect(spies.folderCommitFileDiffDocument).toHaveBeenLastCalledWith(
        FOLDER_ID,
        WEB,
        OID,
        'docs/new.md',
        'docs/old.md',
        false,
        { ignoreWhitespace: false, context: 3 },
      );
      // 탭의 보조 글자·툴팁으로 저장소를 가린다 (ED-02)
      const active = within(editorArea() as HTMLElement).getByRole('tab', { selected: true });
      expect(active.textContent).toContain('web');
      expect(active.getAttribute('title')).toContain('web: docs/new.md @a1b2c3d4');

      // 더블클릭하면 고정 탭이 되고, 다음 미리보기는 새 탭으로 열린다
      fireEvent.doubleClick(fileRow('new.md'));
      fireEvent.click(fileRow('two.ts'));
      await tick();
      expect(tabs()).toEqual([S.workspace.overview, 'new.md @a1b2c3d4', `[~two.ts @a1b2c3d4]`]);

      // 파일을 열어도 로그 선택은 바뀌지 않는다
      expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: OID });
      expect(spies.openRepo).not.toHaveBeenCalled();
      expect(spies.folderOpenRepoSession).not.toHaveBeenCalled();
      expect(openRepositoryAt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('로그를 여러 번 훑고 파일을 여럿 열어도 저장소 세션을 만들지 않는다 (CD-05 — 가벼운 세션도 0회, 범위는 W13 에서 다시 정함)', async () => {
    const { spies, openRepositoryAt, restore } = await setup();
    try {
      for (const [oid, repo] of [
        [OID, 1],
        [OTHER, 0],
        [OID, 1],
        [OID, 1],
      ] as const) {
        act(() => view().onSelectRow?.(row(oid, repo)));
        await tick();
        fireEvent.click(fileRow('two.ts'));
        fireEvent.doubleClick(fileRow('one.ts'));
        await tick();
      }
      expect(spies.folderCommitDetail).toHaveBeenCalled();
      expect(spies.folderCommitFileDiffDocument).toHaveBeenCalled();
      expect(spies.openRepo).not.toHaveBeenCalled();
      expect(spies.folderOpenRepoSession).not.toHaveBeenCalled();
      expect(openRepositoryAt).not.toHaveBeenCalled();
      expect(useAppStore.getState().repoSessions).toEqual({});
    } finally {
      restore();
    }
  });

  it('보기 옵션을 바꾸면 다시 읽고, 늦게 온 옛 응답은 버린다', async () => {
    const slow = deferred<ReturnType<typeof documentOf>>();
    let call = 0;
    const { restore } = await setup({
      folderCommitFileDiffDocument: vi.fn(async (_s, _r, _o, path, _old, _full, options) => {
        call += 1;
        // 첫 요청(공백 무시 끔)만 늦게 온다
        return call === 1
          ? slow.promise
          : documentOf(diffOf(path, `${path} ws=${options?.ignoreWhitespace}`));
      }),
    });
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.click(fileRow('two.ts'));
      await tick();
      fireEvent.click(within(editorArea() as HTMLElement).getByLabelText(S.diff.ignoreWhitespace));
      await tick();
      expect(editorArea()?.textContent).toContain('diff of src/a/two.ts ws=true');
      slow.resolve(documentOf(diffOf('src/a/two.ts', 'stale')));
      await tick();
      expect(editorArea()?.textContent).not.toContain('diff of stale');
      expect(editorArea()?.textContent).toContain('diff of src/a/two.ts ws=true');
    } finally {
      restore();
    }
  });

  it('머지 commit 의 파일 diff 는 첫 부모 기준이라는 안내를 보이고, 변경이 없으면(null) "변경 없음" 이다', async () => {
    const { restore } = await setup({
      folderCommitDetail: vi.fn(async (_s, _r, oid) => detailOf(oid, { parents: [PARENT, OTHER] })),
      folderCommitFileDiffDocument: vi.fn(async () => documentOf()),
    });
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.click(fileRow('two.ts'));
      await tick();
      expect(editorArea()?.textContent).toContain(S.diff.mergeFirstParent);
      expect(editorArea()?.textContent).toContain('HEAD');
    } finally {
      restore();
    }
  });

  it('파일 우클릭: diff 보기(고정 탭), blame·파일 히스토리·외부 도구(W13), 경로 복사. 메뉴를 여는 것만으로는 세션이 없다', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { spies, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.contextMenu(fileRow('two.ts'));
      await tick();
      expect(screen.getAllByRole('menuitem').map((m) => m.childNodes[0]?.textContent)).toEqual([
        S.menu.showDiff,
        S.fileView.editCurrent,
        S.menu.blame,
        S.menu.fileHistory,
        S.menu.difftool,
        S.project.menu.copyRelative,
        S.menu.copyPath,
      ]);
      expect(spies.folderOpenRepoSession).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('menuitem', { name: S.project.menu.copyRelative }));
      await tick();
      expect(writeText).toHaveBeenCalledWith('src/a/two.ts');
      fireEvent.contextMenu(fileRow('two.ts'));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(S.menu.showDiff) }));
      await tick();
      expect(tabs()).toEqual([S.workspace.overview, '[two.ts @a1b2c3d4]']);
    } finally {
      restore();
    }
  });

  it('폴더 히스토리 메뉴·diff 도구 모음·파일 히스토리는 같은 현재 파일 탭을 열고 diff를 유지한다', async () => {
    const { workspace, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.click(fileRow('two.ts'));
      await tick();
      const diffId = workspace.getState().activeDocId;
      fireEvent.click(
        within(editorArea() as HTMLElement).getByRole('button', { name: S.fileView.editCurrent }),
      );
      await tick();
      const fileId = 'file:web/src/a/two.ts';
      expect(workspace.getState().activeDocId).toBe(fileId);
      expect(workspace.getState().docs.some((doc) => doc.id === diffId)).toBe(true);
      fireEvent.contextMenu(fileRow('two.ts'));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: S.fileView.editCurrent }));
      await tick();
      expect(workspace.getState().docs.filter((doc) => doc.id === fileId)).toHaveLength(1);
      fireEvent.contextMenu(fileRow('two.ts'));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: S.menu.fileHistory }));
      await tick();
      const dialog = document.querySelector<HTMLElement>('dialog[open]');
      expect(dialog).not.toBeNull();
      fireEvent.click(
        within(dialog as HTMLElement).getByRole('button', { name: S.fileView.editCurrent }),
      );
      await tick();
      expect(workspace.getState().activeDocId).toBe(fileId);
      expect(workspace.getState().docs.filter((doc) => doc.id === fileId)).toHaveLength(1);
      expect(document.querySelector('dialog[open]')).toBeNull();
    } finally {
      restore();
    }
  });

  it('파일 히스토리·Blame 을 요청할 때만 그 커밋 저장소의 세션이 열린다: 처음 1회, 같은 저장소는 다시 열지 않는다 (W13, CD-04)', async () => {
    const { spies, workspace, restore } = await setup();
    /** 변경 파일 메뉴의 항목을 누른다 */
    const choose = async (file: string, label: string) => {
      fireEvent.contextMenu(fileRow(file));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      await tick();
    };
    const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
    try {
      // 활성 저장소는 api 인데 web 의 커밋을 고른다 — 요청한 기능의 대상은 그 커밋의 저장소다
      act(() => workspace.getState().setActiveRepo(API));
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      expect(spies.folderOpenRepoSession).not.toHaveBeenCalled();

      await choose('two.ts', S.menu.fileHistory);
      expect(spies.folderOpenRepoSession).toHaveBeenCalledTimes(1);
      expect(spies.folderOpenRepoSession).toHaveBeenCalledWith(
        FOLDER_ID,
        WEB,
        expect.any(Function),
      );
      expect(spies.fileHistory).toHaveBeenCalledWith(500, 'src/a/two.ts', expect.any(Number));
      // 대화상자에 대상 저장소가 보이고, 그 저장소가 활성 저장소가 됐다
      expect(dialog()?.textContent).toContain(S.history.historyTitle('src/a/two.ts'));
      expect(dialog()?.textContent).toContain(S.history.inRepo('web'));
      expect(dialog()?.textContent).toContain('히스토리 첫 커밋');
      expect(workspace.getState().activeRepo).toBe(WEB);

      fireEvent.click(
        within(dialog() as HTMLElement).getByRole('button', { name: S.history.close }),
      );
      await tick();
      expect(dialog()).toBeNull();

      // 같은 저장소의 Blame 은 이미 연 세션을 쓴다 (커밋 시점)
      await choose('one.ts', S.menu.blame);
      expect(spies.folderOpenRepoSession).toHaveBeenCalledTimes(1);
      expect(spies.blame).toHaveBeenCalledWith(500, 'src/a/one.ts', OID, false);
      expect(dialog()?.textContent).toContain(S.history.blameTitle('src/a/one.ts'));
      expect(dialog()?.textContent).toContain(S.history.inRepo('web'));
      expect(spies.openRepo).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('외부 diff 도구: 변경 파일 메뉴와 커밋 diff 탭의 버튼이 그 커밋 저장소의 세션으로 부른다 (W13)', async () => {
    const { spies, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      // 커밋 diff 탭을 여는 것만으로는 세션이 없다
      fireEvent.click(fileRow('two.ts'));
      await tick();
      expect(spies.folderOpenRepoSession).not.toHaveBeenCalled();
      fireEvent.click(
        within(editorArea() as HTMLElement).getByRole('button', { name: S.history.difftool }),
      );
      await tick();
      expect(spies.folderOpenRepoSession).toHaveBeenCalledTimes(1);
      expect(spies.openDifftool).toHaveBeenLastCalledWith(500, {
        kind: 'commit',
        oid: OID,
        path: 'src/a/two.ts',
      });

      fireEvent.contextMenu(fileRow('one.ts'));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: S.menu.difftool }));
      await tick();
      expect(spies.folderOpenRepoSession).toHaveBeenCalledTimes(1);
      expect(spies.openDifftool).toHaveBeenLastCalledWith(500, {
        kind: 'commit',
        oid: OID,
        path: 'src/a/one.ts',
      });
    } finally {
      restore();
    }
  });

  it('히스토리 대화상자의 해시는 폴더 탭에서 로그 선택 + 커밋 diff 탭으로 간다 (그래프 이동을 부르지 않는다)', async () => {
    const { store, spies, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OTHER, 0)));
      await tick();
      fireEvent.contextMenu(fileRow('two.ts'));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: S.menu.fileHistory }));
      await tick();
      const dialog = document.querySelector<HTMLElement>('dialog[open]') as HTMLElement;
      expect(dialog.textContent).toContain(S.history.inRepo('api'));
      fireEvent.click(within(dialog).getByRole('button', { name: OID.slice(0, 8) }));
      await tick();
      expect(document.querySelector('dialog[open]')).toBeNull();
      expect(store.getState().timeline.selected).toEqual({ repoPath: API, oid: OID });
      expect(tabs()).toContain(`[~two.ts @a1b2c3d4]`);
      expect(spies.folderCommitFileDiffDocument).toHaveBeenLastCalledWith(
        FOLDER_ID,
        API,
        OID,
        'src/a/two.ts',
        null,
        false,
        { ignoreWhitespace: false, context: 3 },
      );
    } finally {
      restore();
    }
  });

  it('상세의 부모를 누르면 그 커밋을 고르고 로그를 그 행으로 스크롤한다', async () => {
    const { store, spies, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.click(
        within(detailArea() as HTMLElement).getByRole('button', { name: PARENT.slice(0, 8) }),
      );
      await tick();
      expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: PARENT });
      expect(spies.folderTimelineFindRow).toHaveBeenCalledWith(FOLDER_ID, 1, PARENT);
      expect(view().scrollToRow).toBe(7);
      act(() => view().onScrolledTo?.());
      expect(view().scrollToRow).toBeNull();
    } finally {
      restore();
    }
  });

  it('로그 행을 직접 누르면 고르기만 하고 스크롤은 건드리지 않는다 (W19)', async () => {
    const { store, spies, restore } = await setup();
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: OID });
      expect(store.getState().timeline.reveal).toBeNull();
      expect(spies.folderTimelineFindRow).not.toHaveBeenCalled();
      expect(view().scrollToRow ?? null).toBeNull();
    } finally {
      restore();
    }
  });

  it('히스토리·blame 의 해시를 누르면 로그를 그 커밋의 행으로 스크롤한다 (W19)', async () => {
    const { spies, workspace, restore } = await setup({
      blame: vi.fn(async () => [
        {
          oid: OTHER,
          origLine: 1,
          line: 1,
          author: 'Jamie',
          authorMail: 'jamie@acme.dev',
          authorTime: 1761632400,
          summary: '블레임 커밋',
          previousOid: null,
          previousPath: null,
          boundary: false,
          text: 'x',
        },
      ]),
    });
    const dialog = () => document.querySelector<HTMLElement>('dialog[open]') as HTMLElement;
    /** 변경 파일 메뉴의 항목을 누른다 */
    const choose = async (file: string, label: string) => {
      fireEvent.contextMenu(fileRow(file));
      await tick();
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      await tick();
    };
    try {
      act(() => workspace.getState().setActiveRepo(API));
      act(() => view().onSelectRow?.(row(OTHER, 0)));
      await tick();
      // 히스토리의 해시 (api 저장소 = 타임라인 번호 0)
      await choose('two.ts', S.menu.fileHistory);
      fireEvent.click(within(dialog()).getByRole('button', { name: OID.slice(0, 8) }));
      await tick();
      expect(spies.folderTimelineFindRow).toHaveBeenLastCalledWith(FOLDER_ID, 0, OID);
      expect(view().scrollToRow).toBe(7);
      act(() => view().onScrolledTo?.());
      expect(view().scrollToRow).toBeNull();
      // blame 의 해시
      await choose('one.ts', S.menu.blame);
      fireEvent.click(within(dialog()).getByRole('button', { name: OTHER.slice(0, 8) }));
      await tick();
      expect(spies.folderTimelineFindRow).toHaveBeenLastCalledWith(FOLDER_ID, 0, OTHER);
      expect(view().scrollToRow).toBe(7);
    } finally {
      restore();
    }
  });

  it('지금 필터에 없는 커밋이면 상세는 그대로이고 로그 위에 안내가 뜬다. "필터 지우고 보기" 는 필터를 풀고 다시 읽은 로그에서 그 커밋으로 간다 (W19)', async () => {
    let found: number | null = null;
    const findRow = vi.fn<IpcClient['folderTimelineFindRow']>(async () => found);
    const { store, restore } = await setup({ folderTimelineFindRow: findRow });
    const querySet = vi.spyOn(useAppStore.getState().client, 'folderTimelineQuerySet');
    /** 다시 읽힌 로그가 왔다 */
    const reloaded = (generation: number) =>
      act(() =>
        store.getState().applyEvent({
          type: 'graphReloaded',
          session: FOLDER_ID,
          generation,
          rows: 10,
          laneCount: 1,
        }),
      );
    const logArea = () => document.querySelector<HTMLElement>('[data-panel="git-log"]');
    try {
      await act(async () => {
        await store.getState().setTimelineQuery(
          withText(store.getState().timeline.query, {
            pattern: 'fix',
            regex: false,
            matchCase: false,
          }),
        );
      });
      reloaded(2);
      await tick();
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      fireEvent.click(
        within(detailArea() as HTMLElement).getByRole('button', { name: PARENT.slice(0, 8) }),
      );
      await tick();
      // 상세는 부모의 것이고, 로그는 스크롤하지 않고 안내를 띄운다
      expect(store.getState().timeline.detail?.detail?.oid).toBe(PARENT);
      expect(view().scrollToRow ?? null).toBeNull();
      const notice = within(logArea() as HTMLElement).getByRole('status');
      expect(notice.textContent).toContain(S.folder.timeline.revealFiltered);
      // 필터를 지우면 다시 읽은 로그에서 그 커밋을 다시 고르고 그 행으로 간다
      found = 4;
      fireEvent.click(within(notice).getByRole('button', { name: S.folder.timeline.revealClear }));
      await tick();
      expect(querySet).toHaveBeenLastCalledWith(
        FOLDER_ID,
        expect.objectContaining({
          filter: expect.objectContaining({ text: expect.objectContaining({ pattern: '' }) }),
        }),
      );
      reloaded(3);
      await tick();
      await tick();
      expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: PARENT });
      expect(findRow).toHaveBeenLastCalledWith(FOLDER_ID, 1, PARENT);
      expect(view().scrollToRow).toBe(4);
      expect(within(logArea() as HTMLElement).queryByRole('status')).toBeNull();
    } finally {
      restore();
    }
  });

  it('상세의 커밋이 지금 로그에 없으면(행 번호 없음) 부모·자식은 링크가 아니다', async () => {
    const { restore } = await setup({
      folderCommitDetail: vi.fn(async (_s, _r, oid) => detailOf(oid, { row: null })),
    });
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      expect(
        within(detailArea() as HTMLElement).queryByRole('button', { name: PARENT.slice(0, 8) }),
      ).toBeNull();
      expect(detailArea()?.textContent).toContain(PARENT.slice(0, 8));
    } finally {
      restore();
    }
  });

  it('상세를 읽지 못하면 오류와 "다시 시도" 를 보인다', async () => {
    let fail = true;
    const { restore } = await setup({
      folderCommitDetail: vi.fn(async (_s, _r, oid) => {
        if (fail) {
          throw new Error('bad object');
        }
        return detailOf(oid);
      }),
    });
    try {
      act(() => view().onSelectRow?.(row(OID, 1)));
      await tick();
      const alert = within(detailArea() as HTMLElement).getByRole('alert');
      expect(alert.textContent).toContain('bad object');
      fail = false;
      fireEvent.click(within(alert).getByRole('button', { name: S.detail.retry }));
      await tick();
      expect(within(detailArea() as HTMLElement).getByRole('tree')).toBeTruthy();
    } finally {
      restore();
    }
  });
});
