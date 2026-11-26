import {
  createNullClient,
  emptyRepoState,
  type GraphWindow,
  type IpcClient,
  type RepoOpened,
  type SessionEvent,
} from '@mgit/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeTabKind,
  createAppStore,
  DEFAULT_DOCK,
  DEFAULT_LEFT_TOOL,
  type DockState,
  dockToggled,
  effectiveDock,
  GIT_DOCK_TABS,
  gitDockTabsFor,
  restoreDock,
  restoreLeftTool,
  shownDock,
} from '../store/app-store';
import { clearSessionRegistry, getSessionCache, getSessionStore } from '../store/session-registry';
import { DEFAULT_GRAPH_QUERY } from '../store/session-store';

/** 이벤트를 수동으로 흘려보낼 수 있는 가짜 클라이언트 */
function fakeClient() {
  const handlers = new Map<number, (ev: SessionEvent) => void>();
  let nextId = 1;
  const client: IpcClient = {
    ...createNullClient(),
    gitVersion: vi.fn(async () => ({ version: '2.54.0', path: '/usr/bin/git' })),
    openRepo: vi.fn(async (path: string, onEvent) => {
      const session = nextId++;
      handlers.set(session, onEvent);
      // 응답 전에 도착하는 이벤트를 흉내 낸다
      onEvent({ type: 'graphLoadStarted', session, generation: 1 });
      const head = { state: 'attached' as const, branch: 'main', oid: 'a'.repeat(40) };
      const opened: RepoOpened = {
        session,
        alreadyOpen: false,
        nestedRepos: [],
        superproject: null,
        info: {
          workTree: path,
          gitDir: `${path}/.git`,
          commonDir: `${path}/.git`,
          objectFormat: 'sha1',
          head,
          commitGraph: { present: true },
          shallow: false,
        },
        state: emptyRepoState(head),
      };
      return opened;
    }),
    graphWindow: vi.fn(
      async (_s, start): Promise<GraphWindow> => ({
        generation: 1,
        start,
        totalRows: 0,
        finished: true,
        laneCount: 0,
        rows: [],
        segments: [],
        edges: [],
        stubs: [],
      }),
    ),
    findRow: vi.fn(async () => null),
    repoState: vi.fn(async () => emptyRepoState({ state: 'unborn', branch: 'main' })),
    refreshRepo: vi.fn(async () => {}),
    reloadGraph: vi.fn(async () => {}),
    cancelOperation: vi.fn(async () => true),
    commandLogRecent: vi.fn(async () => []),
    closeRepo: vi.fn(async () => {}),
  };
  const emit = (session: number, ev: SessionEvent) => handlers.get(session)?.(ev);
  return { client, emit };
}

describe('AppStore', () => {
  beforeEach(() => {
    clearSessionRegistry();
    localStorage.clear();
  });

  it('bootstrap 이 git 버전을 읽는다', async () => {
    const { client } = fakeClient();
    const store = createAppStore({ client, pickDirectory: async () => null });
    await store.getState().bootstrap();
    expect(store.getState().gitVersion).toBe('2.54.0');
  });

  it('openRepositoryAt 이 세션을 만들고 이벤트에 따라 loadState 가 바뀐다', async () => {
    const { client, emit } = fakeClient();
    const store = createAppStore({ client, pickDirectory: async () => null });

    await store.getState().openRepositoryAt('/tmp/repo');
    const id = store.getState().activeSessionId;
    expect(id).toBe(1);
    expect(store.getState().sessions[1]?.name).toBe('repo');
    const session = getSessionStore(1);
    expect(session).toBeDefined();
    expect(session?.getState().refs.head).toEqual({
      state: 'attached',
      branch: 'main',
      oid: 'a'.repeat(40),
    });
    // 응답 전에 온 Started 가 뒤늦게 반영돼 streaming 상태
    expect(session?.getState().loadState).toBe('streaming');
    expect(getSessionCache(1)).toBeDefined();

    emit(1, { type: 'graphFirstChunk', session: 1, generation: 1, rows: 500 });
    expect(session?.getState().totalRows).toBe(500);
    expect(getSessionCache(1)?.getTotalRows()).toBe(500);

    emit(1, {
      type: 'graphLoadFinished',
      session: 1,
      generation: 1,
      rows: 1234,
      laneCount: 3,
      elapsedMs: 10,
      commitGraphSuggested: false,
    });
    expect(session?.getState().loadState).toBe('complete');
    expect(session?.getState().totalRows).toBe(1234);
    expect(getSessionCache(1)?.isComplete()).toBe(true);
  });

  it('화면 재연결은 코어의 완료 상태와 기존 필터를 복원한다', async () => {
    const { client } = fakeClient();
    const opened = await client.openRepo('/tmp/repo', () => {});
    const query = { ...DEFAULT_GRAPH_QUERY, revs: { kind: 'head' as const }, hideRemotes: true };
    client.graphQuery = vi.fn(async () => query);
    vi.mocked(client.openRepo).mockImplementationOnce(async (_path, onEvent) => {
      onEvent({
        type: 'graphLoadFinished',
        session: opened.session,
        generation: 3,
        rows: 42,
        laneCount: 2,
        elapsedMs: 0,
        commitGraphSuggested: false,
      });
      return { ...opened, alreadyOpen: true };
    });
    const app = createAppStore({ client, pickDirectory: async () => null });
    await app.getState().openRepositoryAt('/tmp/repo');
    const st = getSessionStore(opened.session)?.getState();
    expect(st?.loadState).toBe('complete');
    expect(st?.totalRows).toBe(42);
    expect(st?.graphQuery).toEqual(query);
    expect(getSessionCache(opened.session)?.isComplete()).toBe(true);
  });

  it('이미 열린 탭을 재선택해도 새 채널의 버퍼와 이후 이벤트를 계속 반영한다', async () => {
    const { client } = fakeClient();
    const app = createAppStore({ client, pickDirectory: async () => null });
    await app.getState().openRepositoryAt('/tmp/repo');
    const opened = await vi.mocked(client.openRepo).mock.results[0]?.value;
    let send: ((event: SessionEvent) => void) | undefined;
    vi.mocked(client.openRepo).mockImplementationOnce(async (_path, onEvent) => {
      send = onEvent;
      onEvent({
        type: 'graphLoadFinished',
        session: 1,
        generation: 1,
        rows: 2,
        laneCount: 1,
        elapsedMs: 0,
        commitGraphSuggested: false,
      });
      return { ...opened, alreadyOpen: true };
    });
    const original = getSessionStore(1);
    await app.getState().openRepositoryAt('/tmp/repo');
    expect(getSessionStore(1)).toBe(original);
    expect(original?.getState().loadState).toBe('complete');
    expect(app.getState().sessionOrder).toEqual([1]);
    send?.({ type: 'graphReloaded', session: 1, generation: 2, rows: 4, laneCount: 1 });
    expect(original?.getState().totalRows).toBe(4);
  });

  it('재연결 이벤트의 순서가 섞여도 완료 상태와 새 세대가 과거로 돌아가지 않는다', async () => {
    const { client, emit } = fakeClient();
    const app = createAppStore({ client, pickDirectory: async () => null });
    await app.getState().openRepositoryAt('/tmp/repo');
    const session = getSessionStore(1);
    emit(1, {
      type: 'graphLoadFinished',
      session: 1,
      generation: 1,
      rows: 2,
      laneCount: 1,
      elapsedMs: 0,
      commitGraphSuggested: false,
    });
    emit(1, { type: 'graphLoadStarted', session: 1, generation: 1 });
    emit(1, { type: 'graphFirstChunk', session: 1, generation: 1, rows: 1 });
    expect(session?.getState().loadState).toBe('complete');
    expect(session?.getState().totalRows).toBe(2);
    emit(1, {
      type: 'graphLoadFinished',
      session: 1,
      generation: 2,
      rows: 5,
      laneCount: 1,
      elapsedMs: 0,
      commitGraphSuggested: false,
    });
    emit(1, { type: 'graphReloaded', session: 1, generation: 1, rows: 2, laneCount: 1 });
    expect(session?.getState().generation).toBe(2);
    expect(session?.getState().totalRows).toBe(5);
  });

  it('구세대 이벤트와 닫힌 세션의 이벤트는 무시한다', async () => {
    const { client, emit } = fakeClient();
    const store = createAppStore({ client, pickDirectory: async () => null });
    await store.getState().openRepositoryAt('/tmp/repo');
    const session = getSessionStore(1);
    emit(1, { type: 'graphLoadStarted', session: 1, generation: 2 });
    emit(1, { type: 'graphLoadFailed', session: 1, generation: 1, message: 'old' });
    expect(session?.getState().loadState).toBe('streaming');

    await store.getState().closeSession(1);
    expect(store.getState().sessions[1]).toBeUndefined();
    expect(store.getState().activeSessionId).toBeNull();
    expect(getSessionCache(1)).toBeUndefined();
    expect(getSessionStore(1)).toBeUndefined();
    expect(client.closeRepo).toHaveBeenCalledWith(1);
    // 닫힌 뒤 늦게 온 이벤트는 아무 일도 하지 않는다
    emit(1, { type: 'graphProgress', session: 1, generation: 2, rows: 9 });
    expect(store.getState().sessions[1]).toBeUndefined();
  });

  it('열기 실패는 lastError 에 한국어 문구로 남는다', async () => {
    const { client } = fakeClient();
    (client.openRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      kind: 'notARepository',
      path: '/tmp/x',
    });
    const store = createAppStore({ client, pickDirectory: async () => null });
    await store.getState().openRepositoryAt('/tmp/x');
    expect(store.getState().lastError).toContain('Git 저장소가 아닙니다');
    expect(store.getState().isOpening).toBe(false);
  });

  it('setTheme 이 저장하고 data-theme 를 바꾼다', () => {
    const { client } = fakeClient();
    const store = createAppStore({ client, pickDirectory: async () => null });
    store.getState().setTheme('dark');
    expect(store.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('mgit.theme')).toBe('dark');
  });

  it('refreshActive 는 활성 세션을 새로고침한다', async () => {
    const { client } = fakeClient();
    const store = createAppStore({ client, pickDirectory: async () => null });
    await store.getState().refreshActive(); // 세션 없음: 아무 일도 없다
    expect(client.refreshRepo).not.toHaveBeenCalled();
    await store.getState().openRepositoryAt('/tmp/repo');
    await store.getState().refreshActive();
    expect(client.refreshRepo).toHaveBeenCalledWith(1);
  });

  it('refreshActive 는 폴더 탭이면 요약과 함께 펼친 파일 트리도 다시 읽는다', async () => {
    const { client } = fakeClient();
    client.openFolder = vi.fn(async (path: string) => ({ session: 90, path, repos: [] }));
    const folderSummaries = vi.fn(async () => []);
    const fsListDir = vi.fn(async () => ({
      kind: 'listed' as const,
      entries: [],
      total: 0,
      truncated: false,
      nonUtf8Names: 0,
    }));
    client.folderSummaries = folderSummaries;
    client.fsListDir = fsListDir;
    const store = createAppStore({ client, pickDirectory: async () => null });
    await store.getState().openFolderAt('/w');
    // 열 때의 첫 요약 읽기가 끝나기를 기다린다 (도는 중이면 새로고침은 그 읽기에 합쳐진다)
    await new Promise((resolve) => setTimeout(resolve, 0));
    const summariesBefore = folderSummaries.mock.calls.length;
    expect(fsListDir).not.toHaveBeenCalled();
    await store.getState().refreshActive();
    expect(folderSummaries.mock.calls.length).toBeGreaterThan(summariesBefore);
    // 펼친 디렉터리(처음엔 루트)를 한 번 나열한다
    expect(fsListDir.mock.calls).toEqual([[90, '', null]]);
  });
});

describe('아래 도구 창 슬롯 (WS-02~04)', () => {
  const PREF = 'mgit.bottomDock';

  beforeEach(() => {
    clearSessionRegistry();
    localStorage.clear();
  });

  /** 새 스토어 (앱을 새로 띄운 것과 같다: 저장된 설정을 다시 읽는다) */
  const launch = () =>
    createAppStore({ client: fakeClient().client, pickDirectory: async () => null });
  type Store = ReturnType<typeof launch>;

  /** 슬롯을 숨기고 콘솔 탭을 골라 둔 채 끝낸 뒤 다시 띄운 스토어 (W2 전이 표의 출발점) */
  const launchHidden = () => {
    localStorage.setItem(PREF, JSON.stringify({ tool: null, gitTab: 'console' }));
    return launch();
  };

  /** 전이 표에서 쓰는 동작 이름 → 스토어 호출. ⌘J = 콘솔, ⌘⇧J = 터미널 */
  const STEPS: Record<string, (s: Store) => void> = {
    '⌘J': (s) => s.getState().toggleDock('git', 'console'),
    '⌘⇧J': (s) => s.getState().toggleDock('terminal'),
    최대화토글: (s) => s.getState().toggleDockMaximized(),
    최대화해제: (s) => s.getState().setDockMaximized(false),
    최대화: (s) => s.getState().setDockMaximized(true),
    숨기기: (s) => s.getState().hideDock(),
  };

  it('처음 실행하면 Git 도구 창의 로그 탭이 보인다 (WS-01)', () => {
    expect(GIT_DOCK_TABS).toEqual(['log', 'history', 'console']);
    expect(DEFAULT_DOCK).toEqual({ tool: 'git', maximized: false, gitTab: 'log' });
    expect(launch().getState().dock).toEqual(DEFAULT_DOCK);
    // 아무것도 바꾸지 않았으면 저장도 하지 않는다
    expect(localStorage.getItem(PREF)).toBeNull();
  });

  it('사용자가 숨기면 다시 띄워도 숨겨져 있다 (기본값으로 돌아가지 않는다)', () => {
    launch().getState().hideDock();
    expect(JSON.parse(localStorage.getItem(PREF) ?? 'null')).toEqual({ tool: null, gitTab: 'log' });
    expect(launch().getState().dock).toEqual({ tool: null, maximized: false, gitTab: 'log' });
  });

  it.each<[string, string[], DockState['tool'], boolean]>([
    ['숨김에서 ⌘J → Git 콘솔', ['⌘J'], 'git', false],
    ['Git 표시 중 ⌘J → 숨김', ['⌘J', '⌘J'], null, false],
    ['Git 표시 중 ⌘⇧J → 터미널', ['⌘J', '⌘⇧J'], 'terminal', false],
    ['터미널 표시 중 ⌘J → Git', ['⌘⇧J', '⌘J'], 'git', false],
    ['터미널 표시 중 ⌘⇧J → 숨김', ['⌘⇧J', '⌘⇧J'], null, false],
    ['최대화', ['⌘J', '최대화토글'], 'git', true],
    ['최대화 뒤 복원', ['⌘J', '최대화토글', '최대화토글'], 'git', false],
    ['최대화 해제 액션', ['⌘J', '최대화', '최대화해제'], 'git', false],
    ['최대화 중 도구 창을 바꾸면 최대화는 그대로', ['⌘J', '최대화토글', '⌘⇧J'], 'terminal', true],
    ['숨기면 최대화도 풀린다', ['⌘J', '최대화토글', '숨기기'], null, false],
    ['최대화 중 같은 단축키 → 숨김', ['⌘J', '최대화토글', '⌘J'], null, false],
    ['숨겼다 다시 열면 보통 크기', ['⌘J', '최대화토글', '숨기기', '⌘J'], 'git', false],
    ['숨김에서는 최대화가 켜지지 않는다', ['최대화토글', '최대화'], null, false],
  ])('%s', (_name, steps, tool, maximized) => {
    const store = launchHidden();
    for (const step of steps) {
      STEPS[step]?.(store);
    }
    expect(store.getState().dock).toEqual({ tool, maximized, gitTab: 'console' });
  });

  it('dockToggled 는 Git 의 다른 탭이 보이고 있으면 숨기지 않고 그 탭으로 바꾼다', () => {
    const other: DockState = { tool: 'git', maximized: true, gitTab: 'log' };
    expect(dockToggled(other, 'git', 'console')).toEqual({
      tool: 'git',
      maximized: true,
      gitTab: 'console',
    });
    // 탭을 주지 않으면 "Git 도구 창" 자체의 토글이다
    expect(dockToggled(other, 'git').tool).toBeNull();
  });

  it('clearTerminalInput 은 그 탭의 초기 입력만 지운다 (다시 마운트돼도 명령을 다시 실행하지 않게)', async () => {
    const store = launch();
    await store.getState().openRepositoryAt('/tmp/repo');
    store.getState().openTerminal('/tmp/repo', 'verify', 'pnpm test\n');
    store.getState().openTerminal('/tmp/repo', 'other', 'ls\n');
    const [verify, other] = store.getState().terminals;
    store.getState().clearTerminalInput(verify?.id ?? -1);
    expect(store.getState().terminals.map((t) => t.initialInput)).toEqual([null, 'ls\n']);
    expect(store.getState().terminals[1]).toBe(other);
    // 이미 비었으면 상태를 바꾸지 않는다
    const before = store.getState().terminals;
    store.getState().clearTerminalInput(verify?.id ?? -1);
    expect(store.getState().terminals).toBe(before);
  });

  it('터미널을 처음 보이면 탭을 하나 열고, 숨겼다 다시 보여도 탭은 그대로다', async () => {
    const store = launch();
    await store.getState().openRepositoryAt('/tmp/repo');
    store.getState().toggleDock('terminal');
    expect(store.getState().terminals.map((t) => t.cwd)).toEqual(['/tmp/repo']);
    const [first] = store.getState().terminals;
    expect(store.getState().activeTerminal).toBe(first?.id);
    store.getState().toggleDock('terminal');
    expect(store.getState().dock.tool).toBeNull();
    // 숨겨도 탭(PTY)은 남는다
    expect(store.getState().terminals).toEqual([first]);
    store.getState().toggleDock('git', 'console');
    store.getState().toggleDock('terminal');
    expect(store.getState().terminals).toEqual([first]);
  });

  it('openTerminal 은 숨김·Git 어디서든 터미널 도구 창을 연다', () => {
    const store = launch();
    store.getState().openTerminal('/r', '검증', 'make test\n');
    expect(store.getState().dock.tool).toBe('terminal');
    expect(store.getState().terminals).toMatchObject([
      { cwd: '/r', title: '검증', initialInput: 'make test\n' },
    ]);
    store.getState().toggleDock('git', 'console');
    store.getState().openTerminal('/other');
    expect(store.getState().dock.tool).toBe('terminal');
    expect(store.getState().terminals).toHaveLength(2);
    expect(store.getState().activeTerminal).toBe(store.getState().terminals[1]?.id);
  });

  it('마지막 터미널 탭을 닫으면 터미널 도구 창이 숨는다 (최대화도 풀린다)', () => {
    const store = launch();
    store.getState().openTerminal('/a');
    store.getState().openTerminal('/b');
    const [a, b] = store.getState().terminals;
    store.getState().setDockMaximized(true);
    store.getState().closeTerminal(b?.id ?? -1);
    // 탭이 남아 있으면 그대로 보이고 남은 탭이 활성이 된다
    expect(store.getState().dock).toMatchObject({ tool: 'terminal', maximized: true });
    expect(store.getState().activeTerminal).toBe(a?.id);
    store.getState().closeTerminal(a?.id ?? -1);
    expect(store.getState().terminals).toEqual([]);
    expect(store.getState().activeTerminal).toBeNull();
    expect(store.getState().dock).toMatchObject({ tool: null, maximized: false });
  });

  it('Git 이 보이는 동안 마지막 터미널 탭이 닫혀도 Git 은 그대로다', () => {
    const store = launch();
    store.getState().openTerminal('/a');
    store.getState().toggleDock('git', 'console');
    store.getState().closeTerminal(store.getState().terminals[0]?.id ?? -1);
    expect(store.getState().dock.tool).toBe('git');
  });

  it('열려 있던 도구 창과 Git 탭은 재시작 뒤 복원하고 최대화는 복원하지 않는다', () => {
    const first = launch();
    first.getState().toggleDock('git', 'console');
    first.getState().toggleDockMaximized();
    expect(first.getState().dock.maximized).toBe(true);
    // 저장값에는 최대화가 없다
    expect(JSON.parse(localStorage.getItem(PREF) ?? 'null')).toEqual({
      tool: 'git',
      gitTab: 'console',
    });
    expect(launch().getState().dock).toEqual({ tool: 'git', maximized: false, gitTab: 'console' });

    first.getState().hideDock();
    expect(launch().getState().dock.tool).toBeNull();
  });

  it('터미널 도구 창이 열린 채 끝났으면 재시작할 때 탭을 복원한 뒤 셸을 하나 띄운다', async () => {
    launch().getState().toggleDock('terminal');
    const { client } = fakeClient();
    client.openTabsGet = vi.fn(async () => ['/tmp/repo']);
    const store = createAppStore({ client, pickDirectory: async () => null });
    expect(store.getState().dock.tool).toBe('terminal');
    // 탭을 복원하기 전에는 셸을 띄우지 않는다
    expect(store.getState().terminals).toEqual([]);
    await store.getState().bootstrap();
    expect(store.getState().terminals.map((t) => t.cwd)).toEqual(['/tmp/repo']);
    expect(store.getState().dock.tool).toBe('terminal');
  });

  it('저장값이 깨졌거나 모르는 값이면 기본값으로 돌아간다', () => {
    expect(restoreDock({ tool: 'debugger', gitTab: 'blame' })).toEqual(DEFAULT_DOCK);
    expect(restoreDock({ tool: 'terminal', gitTab: 42 })).toEqual({
      tool: 'terminal',
      maximized: false,
      gitTab: 'log',
    });
    // 숨김(null)은 사용자가 고른 상태라 기본값으로 돌리지 않는다
    expect(restoreDock({ tool: null, gitTab: 'console' })).toEqual({
      tool: null,
      maximized: false,
      gitTab: 'console',
    });
    // 저장값에 최대화가 섞여 있어도 무시한다
    expect(restoreDock({ tool: 'git', gitTab: 'console', maximized: true } as never)).toEqual({
      tool: 'git',
      maximized: false,
      gitTab: 'console',
    });
    // 작업 기록 탭도 그대로 복원한다 (저장소 탭에서는 effectiveDock 이 로그로 그린다)
    expect(restoreDock({ tool: 'git', gitTab: 'history' })).toEqual({
      tool: 'git',
      maximized: false,
      gitTab: 'history',
    });
    localStorage.setItem(PREF, '{"tool":');
    expect(launch().getState().dock).toEqual(DEFAULT_DOCK);
    localStorage.setItem(PREF, '"git"');
    expect(launch().getState().dock).toEqual(DEFAULT_DOCK);
  });
});

describe('탭 종류별 Git 탭과 슬롯의 유효 상태 (WS-01)', () => {
  beforeEach(() => {
    clearSessionRegistry();
    localStorage.clear();
  });

  const LOG: DockState = { tool: 'git', maximized: false, gitTab: 'log' };
  const CONSOLE: DockState = { tool: 'git', maximized: false, gitTab: 'console' };
  const HISTORY: DockState = { tool: 'git', maximized: false, gitTab: 'history' };
  const TERMINAL: DockState = { tool: 'terminal', maximized: true, gitTab: 'log' };
  const HIDDEN: DockState = { tool: null, maximized: false, gitTab: 'log' };

  it('로그 탭은 폴더 탭·저장소 탭(W21)에서 쓰고, 작업 기록은 폴더 탭에만 있으며, 탭이 없을 때(홈)는 콘솔만 쓴다', () => {
    expect(gitDockTabsFor('folder')).toEqual(['log', 'history', 'console']);
    expect(gitDockTabsFor('repo')).toEqual(['log', 'console']);
    expect(gitDockTabsFor(null)).toEqual(['console']);
  });

  it.each<[string, DockState, 'repo' | 'folder' | null, DockState]>([
    ['폴더 탭의 로그는 그대로 보인다', LOG, 'folder', LOG],
    ['저장소 탭의 로그도 그대로 보인다 (W21)', LOG, 'repo', LOG],
    ['탭이 없을 때(홈)는 로그를 숨김처럼 그린다', LOG, null, HIDDEN],
    ['콘솔은 저장소 탭에서도 보인다', CONSOLE, 'repo', CONSOLE],
    ['콘솔은 홈에서도 보인다', CONSOLE, null, CONSOLE],
    ['터미널은 고른 Git 탭과 무관하게 보인다', TERMINAL, 'repo', TERMINAL],
    ['숨김은 어디서나 숨김이다', HIDDEN, 'folder', HIDDEN],
    ['작업 기록은 폴더 탭에서 그대로 보인다', HISTORY, 'folder', HISTORY],
    [
      '저장소 탭에서는 작업 기록 대신 첫 탭(로그)을 그린다',
      HISTORY,
      'repo',
      { ...HISTORY, gitTab: 'log' },
    ],
    ['홈에서는 작업 기록을 숨김처럼 그린다', HISTORY, null, { ...HISTORY, tool: null }],
  ])('%s', (_name, dock, kind, shown) => {
    expect(effectiveDock(dock, kind)).toEqual(shown);
  });

  it('숨김처럼 그릴 때는 최대화도 풀린 것으로 그린다 (본문이 가려지지 않는다)', () => {
    expect(effectiveDock({ ...LOG, maximized: true }, null)).toEqual(HIDDEN);
    expect(effectiveDock({ ...LOG, maximized: true }, 'repo')).toEqual({ ...LOG, maximized: true });
    // 로그로 대신 그릴 때는 최대화를 그대로 둔다 (도구 창이 사라지지 않는다)
    expect(effectiveDock({ ...HISTORY, maximized: true }, 'repo')).toEqual({
      ...LOG,
      maximized: true,
    });
  });

  it('유효 상태는 저장된 상태를 건드리지 않는다: 홈에서 가려진 로그가 탭을 열면 보이고, 폴더 탭·저장소 탭이 같은 슬롯을 쓴다', async () => {
    const { client } = fakeClient();
    client.openFolder = vi.fn(async (path: string) => ({ session: 90, path, repos: [] }));
    const store = createAppStore({ client, pickDirectory: async () => null });
    // 탭이 없을 때
    expect(activeTabKind(store.getState())).toBeNull();
    expect(shownDock(store.getState()).tool).toBeNull();

    await store.getState().openFolderAt('/w');
    expect(activeTabKind(store.getState())).toBe('folder');
    expect(shownDock(store.getState())).toEqual(DEFAULT_DOCK);

    const repo = await store.getState().openRepositoryAt('/w/api', 90);
    expect(activeTabKind(store.getState())).toBe('repo');
    // 저장소 탭에도 로그 탭이 있다 (W21)
    expect(shownDock(store.getState())).toEqual(DEFAULT_DOCK);
    expect(localStorage.getItem('mgit.bottomDock')).toBeNull();

    // 저장소 탭에서 ⌘J 는 콘솔을 연다. 슬롯은 앱 전역 1벌이라 폴더 탭도 콘솔이다
    store.getState().toggleDock('git', 'console');
    expect(shownDock(store.getState())).toEqual({
      tool: 'git',
      maximized: false,
      gitTab: 'console',
    });
    store.getState().setActiveSession(90);
    expect(shownDock(store.getState()).gitTab).toBe('console');
    // 폴더 탭에서 로그를 다시 고르면 저장소 탭에서도 로그다
    store.getState().toggleDock('git', 'log');
    expect(shownDock(store.getState())).toEqual(DEFAULT_DOCK);
    store.getState().setActiveSession(repo ?? -1);
    expect(shownDock(store.getState())).toEqual(DEFAULT_DOCK);

    // 폴더 탭에서 작업 기록을 보다 저장소 탭으로 가면 도구 창이 사라지지 않고 로그를 그린다. 고른 탭은 그대로라
    // 폴더 탭으로 돌아오면 다시 작업 기록이다
    store.getState().setActiveSession(90);
    store.getState().setGitDockTab('history');
    store.getState().setActiveSession(repo ?? -1);
    expect(shownDock(store.getState())).toEqual(DEFAULT_DOCK);
    expect(store.getState().dock.gitTab).toBe('history');
    store.getState().setActiveSession(90);
    expect(shownDock(store.getState()).gitTab).toBe('history');
  });
});

describe('왼쪽 도구 창 (WS-04·05)', () => {
  const PREF = 'mgit.leftTool';

  beforeEach(() => {
    clearSessionRegistry();
    localStorage.clear();
  });

  /** 새 스토어 (앱을 새로 띄운 것과 같다) */
  const launch = () =>
    createAppStore({ client: fakeClient().client, pickDirectory: async () => null });

  it('처음 실행하면 Project 도구 창이 열려 있다', () => {
    expect(DEFAULT_LEFT_TOOL).toBe('project');
    expect(launch().getState().leftTool).toBe('project');
    expect(localStorage.getItem(PREF)).toBeNull();
  });

  it('띠 버튼은 열려 있으면 접고 접혀 있으면 열며, 상태를 저장해 다시 띄워도 유지한다', () => {
    const store = launch();
    store.getState().toggleLeftTool('project');
    expect(store.getState().leftTool).toBeNull();
    expect(JSON.parse(localStorage.getItem(PREF) ?? '{}')).toEqual({ tool: null });
    expect(launch().getState().leftTool).toBeNull();

    store.getState().toggleLeftTool('project');
    expect(store.getState().leftTool).toBe('project');
    expect(launch().getState().leftTool).toBe('project');
  });

  it('setLeftTool 은 그 도구 창을 열고(이미 열려 있으면 그대로) null 이면 접는다', () => {
    const store = launch();
    store.getState().setLeftTool('project');
    // 바뀐 것이 없으면 저장하지 않는다
    expect(localStorage.getItem(PREF)).toBeNull();
    store.getState().setLeftTool(null);
    expect(store.getState().leftTool).toBeNull();
    store.getState().setLeftTool('project');
    expect(store.getState().leftTool).toBe('project');
  });

  it('저장값이 깨졌거나 모르는 도구 창이면 기본값으로 돌아간다', () => {
    expect(restoreLeftTool({ tool: 'project' })).toBe('project');
    expect(restoreLeftTool({ tool: null })).toBeNull();
    expect(restoreLeftTool({ tool: 'database' })).toBe('project');
    expect(restoreLeftTool({})).toBe('project');
    localStorage.setItem(PREF, '{"tool":');
    expect(launch().getState().leftTool).toBe('project');
  });

  it('Pull Requests(W24)도 저장·복원한다. 탭이 없어 보일 수 없으면 띠 단추의 뜻은 보이는 것(Project) 기준이다', () => {
    expect(restoreLeftTool({ tool: 'pullRequests' })).toBe('pullRequests');
    const store = launch();
    store.getState().setLeftTool('pullRequests');
    expect(JSON.parse(localStorage.getItem(PREF) ?? '{}')).toEqual({ tool: 'pullRequests' });
    expect(launch().getState().leftTool).toBe('pullRequests');
    // 활성 탭이 없다 → Pull Requests 를 보일 수 없다 → Project 가 보이는 것으로 친다: Project 단추 = 접기
    store.getState().toggleLeftTool('project');
    expect(store.getState().leftTool).toBeNull();
    // Commit 단추는 Commit 을 연다
    store.getState().setLeftTool('pullRequests');
    store.getState().toggleLeftTool('commit');
    expect(store.getState().leftTool).toBe('commit');
  });
});

describe('취소된 저장소 열기의 포커스', () => {
  it('늦게 완료된 탭 열기는 활성 탭을 바꾸지 않는다', async () => {
    const { client } = fakeClient();
    const app = createAppStore({ client, pickDirectory: async () => null });
    const first = await app.getState().openRepositoryAt('/first');
    let active = true;
    const open = app.getState().openRepositoryAt('/late', null, { activate: () => active });
    active = false;
    const late = await open;
    expect(late).not.toBeNull();
    expect(app.getState().activeSessionId).toBe(first);
    expect(late === null ? null : app.getState().sessions[late]?.path).toBe('/late');
  });
});

describe('임시 시작 화면', () => {
  beforeEach(() => {
    clearSessionRegistry();
    localStorage.clear();
  });

  it('시작 화면은 세션을 보존하고 이전 탭과 도구 배치로 복귀한다', async () => {
    const { client } = fakeClient();
    const app = createAppStore({ client, pickDirectory: async () => null });
    const first = await app.getState().openRepositoryAt('/first');
    const second = await app.getState().openRepositoryAt('/second');
    const session = getSessionStore(second ?? -1);
    app.setState({ dock: { tool: 'terminal', gitTab: 'log', maximized: true } });
    app.getState().showHome();
    app.getState().showHome();
    expect(app.getState().sessionOrder).toEqual([first, second]);
    expect(app.getState().activeSessionId).toBeNull();
    expect(shownDock(app.getState()).tool).toBeNull();
    expect(client.closeRepo).not.toHaveBeenCalled();
    app.getState().returnToWorkspace();
    expect(app.getState().activeSessionId).toBe(second);
    expect(getSessionStore(second ?? -1)).toBe(session);
    expect(shownDock(app.getState())).toMatchObject({ tool: 'terminal', maximized: true });
  });

  it('복귀할 탭을 닫았으면 남은 탭으로 돌아간다', async () => {
    const { client } = fakeClient();
    const app = createAppStore({ client, pickDirectory: async () => null });
    const first = await app.getState().openRepositoryAt('/first');
    const second = await app.getState().openRepositoryAt('/second');
    app.getState().showHome();
    await app.getState().closeSession(second ?? -1);
    expect(app.getState().activeSessionId).toBeNull();
    app.getState().returnToWorkspace();
    expect(app.getState().activeSessionId).toBe(first);
  });

  it('취소와 실패는 시작 화면을 유지하고 선택창 중복 호출을 막는다', async () => {
    const { client } = fakeClient();
    let resolve!: (path: string | null) => void;
    const pickDirectory = vi.fn(
      () =>
        new Promise<string | null>((done) => {
          resolve = done;
        }),
    );
    const app = createAppStore({ client, pickDirectory });
    app.getState().showHome();
    const pending = app.getState().openRepository();
    await app.getState().openRepository();
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    resolve(null);
    await pending;
    expect(app.getState().homeVisible).toBe(true);
    vi.mocked(client.openRepo).mockRejectedValueOnce(new Error('missing'));
    await app.getState().openRepositoryAt('/missing');
    expect(app.getState().homeVisible).toBe(true);
    expect(app.getState().lastError).not.toBeNull();
  });

  it('선택창 대기 중 탭을 바꾸면 완료된 열기가 포커스를 빼앗지 않는다', async () => {
    const { client } = fakeClient();
    let resolve!: (path: string | null) => void;
    const app = createAppStore({
      client,
      pickDirectory: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const first = await app.getState().openRepositoryAt('/first');
    app.getState().showHome();
    const pending = app.getState().openRepository();
    app.getState().setActiveSession(first ?? -1);
    resolve('/second');
    await pending;
    expect(app.getState().sessionOrder).toHaveLength(2);
    expect(app.getState().activeSessionId).toBe(first);
  });
});
