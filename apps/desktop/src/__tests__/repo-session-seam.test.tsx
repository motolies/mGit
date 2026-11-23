import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type IpcClient, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { getFolderStore, getSessionStore, getWorkspaceStore, useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import { activeRepoLocked, sessionBusy } from '../store/repo-sessions';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { conflictDocId, createWorkspaceStore, worktreeDiffDocId } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그·터미널·홈은 jsdom 에서 그리지 않는다 (뷰 자체는 각 패키지가 테스트한다)
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

// 목 폴더 장면 (코어의 가벼운 세션 계약을 흉내 낸다)
const FOLDER = '/mock/acme-platform';
const API = `${FOLDER}/api-gateway`;
const AUTH = `${FOLDER}/auth-service`;
const WEB = `${FOLDER}/web-console`;
const FILE = 'src/routes/orders/handlers/create-order.ts';
const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/**
 * 앱 스토어의 활성 저장소 잠금과 같은 판정 (`openFolderAt` 이 워크스페이스에 주입하는 것을 화면 테스트에서도 건다).
 * 잠금의 근거(범위 세션의 바쁨)는 앱 스토어 테스트가 따로 확인한다
 */
function locked(folder: SessionId): boolean {
  const app = useAppStore.getState();
  const active = getWorkspaceStore(folder)?.getState().activeRepo ?? null;
  const entry = active === null ? undefined : app.repoSessions[folder]?.[active];
  return activeRepoLocked({
    opening: app.repoSessionOpening[folder] !== undefined,
    scope: (entry ? getSessionStore(entry.session)?.getState() : undefined) ?? null,
  });
}

/** 폴더 탭을 등록하고 앱 전체를 그린다. 앱 스토어의 클라이언트는 목이다 */
async function mountFolder() {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  registerWorkspace(
    id,
    createWorkspaceStore('folder', {
      activeRepoLocked: () => locked(id),
      // W14·W15: 세션 문서를 닫으면 그 문서의 저장소 세션 슬롯을 비운다 (앱 스토어가 주입하는 것과 같다)
      closeSessionDoc: (doc) =>
        doc.kind === 'conflict'
          ? useAppStore.getState().closeRepoConflict(id, doc.repoPath)
          : useAppStore.getState().closeRepoDiff(id, doc.repoPath),
    }),
  );
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  render(<App />);
  await tick();
  return { mock, id };
}

/**
 * 저장소 탭 하나를 등록하고 앱 전체를 그린다. 앱 스토어의 `openRepositoryAt` 처럼 세션 스토어에 "보여라" 훅을 걸고
 * 저장소 탭 워크스페이스를 등록한다 (W20)
 */
async function mountRepo(path = WEB) {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const opened = await mock.openRepo(path, () => {});
  const id = opened.session;
  mounted.push(id);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  registerSession(id, {
    cache,
    store: createSessionStore(opened, mock, cache, sessionRevealHooks(useAppStore.getState, id)),
  });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  const name = path.slice(path.lastIndexOf('/') + 1);
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path, name, parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: { tool: null, maximized: false, gitTab: 'log' },
      client: mock,
    }),
  );
  render(<App />);
  await tick();
  return { mock, id, store: () => getSessionStore(id) };
}

/** 키를 누른다 (앱은 window 에서 받는다) */
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

/** 툴바 (`<header>` 중 첫째) */
const toolbar = () => within(document.querySelector('header') as HTMLElement);
/** 상태 바 */
const footer = () => document.querySelector('footer') as HTMLElement;
/** Project 도구 창의 이름이 그것인 행 */
const row = (name: string) =>
  within(document.querySelector<HTMLElement>('[data-panel="project"]') as HTMLElement)
    .getAllByRole('treeitem')
    .find((r) => r.querySelector('span[title]')?.textContent === name) as HTMLElement;
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
});

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
      client: originalClient,
      toasts: [],
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('범위 세션 이음새: 폴더 탭은 허용 목록만 켠다 (W13 규칙 3)', () => {
  it('폴더 탭에서 숨은 세션이 범위 세션이어도 툴바·상태 바는 폴더 탭 모양이고 저장소 탭 전용 단축키가 동작하지 않는다', async () => {
    const { mock, id } = await mountFolder();
    const spies = {
      undo: vi.spyOn(mock, 'undo'),
      redo: vi.spyOn(mock, 'redo'),
      fetch: vi.spyOn(mock, 'fetch'),
      push: vi.spyOn(mock, 'push'),
      stashPush: vi.spyOn(mock, 'stashPush'),
    } satisfies Partial<Record<keyof IpcClient, unknown>>;
    await act(async () => {
      await useAppStore.getState().withRepoSession(id, API, () => {});
    });
    const session = useAppStore.getState().repoSessions[id]?.[API]?.session ?? -1;
    const hidden = getSessionStore(session);
    expect(hidden?.getState().profile).toBe('light');
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(API);
    // 저장소 탭이었다면 ⌘Z·⌘⇧Z·Esc 가 건드렸을 상태를 숨은 세션에 만들어 둔다
    act(() =>
      hidden?.setState({
        undoState: { entries: [{ id: 1, label: 'commit', at: 0, changed: 1 }], redoCount: 1 },
        selectedFile: { path: 'a.ts', staged: false, commit: null },
      }),
    );
    await tick();

    // 툴바: 세션 버튼(동기화·원격·undo)이 없고 폴더의 일괄 버튼만 있다
    expect(toolbar().queryByText(`↶ ${S.safety.undo}`)).toBeNull();
    expect(toolbar().queryByRole('button', { name: S.remote.remotes })).toBeNull();
    expect(toolbar().queryByRole('button', { name: S.remote.pushMenu })).toBeNull();
    // 폴더의 일괄 Fetch 는 이름에 대상 범위를 붙인다 (저장소 탭의 Fetch 는 글자만)
    expect(toolbar().getByText(S.remote.fetch).getAttribute('aria-label')).not.toBeNull();
    // 상태 바: 활성 저장소 요약이고 세션 줄(로드 상태·변경 수)이 없다
    expect(footer().textContent).toContain('api-gateway');
    expect(footer().textContent).not.toContain(S.status.opening);
    expect(footer().textContent).not.toContain(S.status.noChanges);

    // 저장소 탭 전용 단축키: undo·redo·fetch·push·stash·검색·Esc(세션 diff 닫기)
    press('z', MOD);
    press('z', { ...MOD, shiftKey: true });
    press('f', { ...MOD, shiftKey: true });
    press('k', { ...MOD, shiftKey: true });
    press('s', { ...MOD, shiftKey: true });
    press('f', MOD);
    press('Escape');
    await tick();
    expect(spies.undo).not.toHaveBeenCalled();
    expect(spies.redo).not.toHaveBeenCalled();
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(spies.push).not.toHaveBeenCalled();
    expect(spies.stashPush).not.toHaveBeenCalled();
    expect(hidden?.getState().search.open).toBe(false);
    // 옛 가운데 화면 'diff' 단언 → 숨은 세션의 diff 슬롯이 그대로다 (폴더 탭의 Esc 는 활성 탭(개요)을 볼 뿐, W20)
    expect(hidden?.getState().selectedFile?.path).toBe('a.ts');
    // W17: 폴더 탭의 ⌘F 는 보기 동작이다 — 로그 필터 바의 텍스트 칸에 포커스할 뿐 숨은 세션의 검색을 열지 않는다
    expect(document.activeElement?.hasAttribute('data-filter-text')).toBe(true);
    // 저장소 탭 전용 대화상자(힌트 등)는 마운트되지 않는다: 숨은 세션에 힌트를 걸어도 뜨지 않는다
    act(() => hidden?.setState({ pendingHint: { kind: 'nestedRepo', paths: ['x'] } }));
    await tick();
    expect(dialog()).toBeNull();
  });

  it('폴더 탭의 콘솔은 폴더의 쓰기 기록을 저장소 이름과 보이고, 숨은 세션의 기록(읽기 포함)은 보이지 않는다 (W19 ②)', async () => {
    const { id } = await mountFolder();
    await act(async () => {
      await useAppStore.getState().withRepoSession(id, API, () => {});
    });
    const session = useAppStore.getState().repoSessions[id]?.[API]?.session ?? -1;
    const hidden = getSessionStore(session);
    // 숨은 세션에만 있는 기록: 폴더 콘솔에 나오면 안 된다
    act(() =>
      hidden?.setState({
        log: [
          {
            id: 999,
            args: ['status', '--porcelain=v2'],
            cwd: API,
            startedAt: 1_763_500_000_000,
            elapsedMs: 3,
            status: 0,
            stderrTail: '',
            isWrite: false,
            cancelled: false,
          },
        ],
      }),
    );
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    const panel = () => screen.getByRole('region', { name: S.log.title });
    expect(panel().textContent).toContain(S.log.folderEmpty);
    expect(panel().textContent).not.toContain('status --porcelain=v2');

    // 폴더 stage (Commit 도구 창의 체크와 같은 길) → 그 저장소 이름과 함께 한 줄
    await act(async () => {
      await getFolderStore(id)?.getState().writeIndex(WEB, 'stage', { kind: 'all' });
    });
    await tick();
    const rows = [...panel().querySelectorAll('li')];
    expect(rows).toHaveLength(1);
    expect(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'web-console' }),
    ).toBeTruthy();
    expect(rows[0]?.textContent).toContain('git add -A -- .');
    expect(panel().textContent).not.toContain('status --porcelain=v2');
  });

  it('저장소 탭은 그대로다: 세션 버튼·상태 바 세션 줄이 보이고 단축키가 그 탭의 세션에 대고 동작한다', async () => {
    const { mock, id, store } = await mountRepo();
    const undo = vi.spyOn(mock, 'undo');
    expect(toolbar().getByText(`↶ ${S.safety.undo}`)).toBeTruthy();
    expect(toolbar().getByRole('button', { name: S.remote.remotes })).toBeTruthy();
    expect(footer().textContent).toContain(S.status.opening);

    act(() =>
      store()?.setState({
        undoState: { entries: [{ id: 1, label: 'commit', at: 0, changed: 1 }], redoCount: 0 },
      }),
    );
    await tick();
    press('z', MOD);
    await tick();
    expect(undo).toHaveBeenCalledTimes(1);
    press('f', MOD);
    expect(store()?.getState().search.open).toBe(true);
    press('Escape');
    expect(store()?.getState().search.open).toBe(false);
    // 파일을 열면 에디터 공간에 diff 탭이 생긴다 (W20 의 세션 슬롯 + 워크스페이스의 활성 diff 문서, W21 의 탭 막대)
    act(() => void store()?.getState().openFile('a.ts', false));
    await tick();
    expect(getWorkspaceStore(id)?.getState().activeDocId).toBe(worktreeDiffDocId(WEB));
    const editor = () => within(document.querySelector('[data-panel="editor"]') as HTMLElement);
    expect(editor().getByRole('tab', { name: /a\.ts/ })).toBeTruthy();
    press('Escape');
    // diff 슬롯이 비고 활성 문서가 없다 → 에디터 공간은 빈 상태 안내 (그래프는 Git 도구 창 로그 탭에 있다, W21)
    expect(store()?.getState().selectedFile).toBeNull();
    expect(getWorkspaceStore(id)?.getState().activeDocId).toBeNull();
    expect(editor().queryByRole('tab')).toBeNull();
    expect(editor().getByText(S.workspace.empty.title)).toBeTruthy();
  });
});

describe('저장소 탭의 세션 문서는 에디터 공간의 탭이다 (W20 ED-10 → W21)', () => {
  const CATALOG = `${FOLDER}/catalog-service`;
  const FACET = 'src/search/facets/FacetBuilder.kt';
  const backToGraph = () => screen.queryByRole('button', { name: `← ${S.diff.back}` });
  const backToList = () => screen.queryByRole('button', { name: `← ${S.conflict.back}` });
  const editor = () => within(document.querySelector('[data-panel="editor"]') as HTMLElement);

  it('diff: 파일을 열면 diff 탭, 옛 "← 그래프로" 대신 탭 닫기 단추가 슬롯을 비운다 (W21 — 폴더 탭과 같다)', async () => {
    const { store } = await mountRepo();
    await act(async () => {
      await store()?.getState().openFile('a.ts', false);
    });
    await tick();
    expect(backToGraph()).toBeNull();
    fireEvent.click(present(editor().getByRole('button', { name: S.workspace.closeTab('a.ts') })));
    await tick();
    expect(store()?.getState().selectedFile).toBeNull();
    expect(editor().queryByRole('tab')).toBeNull();
  });

  it('충돌: 열면 충돌 탭(옛 "← 목록으로" 없음), 탭 닫기는 슬롯을 비운다. 초안이 있으면 Esc(편집기 밖)가 확인을 먼저 받는다 (W21 에서 달라짐)', async () => {
    const { id, store } = await mountRepo(CATALOG);
    await act(async () => {
      await store()?.getState().openConflict(FACET);
    });
    await tick();
    expect(getWorkspaceStore(id)?.getState().activeDocId).toBe(conflictDocId(CATALOG));
    expect(backToList()).toBeNull();
    fireEvent.click(
      present(
        editor().getByRole('button', {
          name: S.workspace.closeTab(S.workspace.conflictTitle('FacetBuilder.kt', false)),
        }),
      ),
    );
    await tick();
    expect(store()?.getState().conflict).toBeNull();

    await act(async () => {
      await store()?.getState().openConflict(FACET);
    });
    await tick();
    const open = present(store()?.getState().conflict);
    const draft = { text: 'mine', ranges: [], key: open.payload.file.stages.join(':') };
    act(() => store()?.getState().setConflictDraft(FACET, draft));
    press('Escape');
    await tick();
    // 옛 저장소 탭은 확인 없이 닫았다. 이제 폴더 탭과 같이 확인을 받는다
    expect(dialog()?.textContent).toContain(S.conflictLeave.closeMessage('catalog-service', true));
    expect(store()?.getState().conflict?.path).toBe(FACET);
    // "닫기": 닫고 초안은 남긴다
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(store()?.getState().conflict).toBeNull();
    expect(store()?.getState().conflictDrafts[FACET]).toEqual(draft);
    expect(editor().getByText(S.workspace.empty.title)).toBeTruthy();
  });
});

/** 값이 있다고 확인하고 돌려준다 */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('값 없음');
  }
  return value;
}

describe('폴더 화면의 파일 히스토리·Blame 진입 (W13)', () => {
  it('트리를 펼치고 파일·저장소 행을 골라도 세션은 없고, 파일 우클릭 → 파일 히스토리에서 처음 열린다', async () => {
    const { mock, id } = await mountFolder();
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    await act(async () => {
      await getFolderStore(id)?.getState().fileTree.getState().reveal(`api-gateway/${FILE}`);
    });
    await tick();
    // 다른 저장소 행을 골랐다가 파일을 고른다 (파일 보기 미리보기 탭이 열리고 활성 저장소가 그 파일의 저장소가 된다)
    fireEvent.click(row('auth-service'));
    await tick();
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(AUTH);
    fireEvent.click(row('create-order.ts'));
    await tick();
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(API);
    expect(open).not.toHaveBeenCalled();

    fireEvent.contextMenu(row('create-order.ts'));
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.menu.fileHistory }));
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(id, API, expect.any(Function));
    expect(dialog()?.textContent).toContain(S.history.historyTitle(FILE));
    expect(dialog()?.textContent).toContain(S.history.inRepo('api-gateway'));
    // 상태 바는 대상 저장소를 보인다 (요청한 저장소 = 활성 저장소)
    expect(footer().textContent).toContain('api-gateway');

    // 대화상자가 열린 동안 다른 저장소 행을 골라도 선택만 움직이고 활성 저장소는 그대로다
    fireEvent.click(row('auth-service'));
    await tick();
    expect(getFolderStore(id)?.getState().fileTree.getState().selected).toBe('auth-service');
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(API);

    fireEvent.click(within(dialog() as HTMLElement).getByRole('button', { name: S.history.close }));
    await tick();
    expect(dialog()).toBeNull();
    // 닫으면 다시 고를 때 옮겨 간다
    fireEvent.click(row('auth-service'));
    await tick();
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(AUTH);
  });

  it('파일 보기 탭 머리줄의 Blame·히스토리는 같은 저장소의 세션을 다시 쓴다 (추가 열기 없음)', async () => {
    const { mock, id } = await mountFolder();
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    const blame = vi.spyOn(mock, 'blame');
    await act(async () => {
      await getFolderStore(id)?.getState().fileTree.getState().reveal(`api-gateway/${FILE}`);
    });
    await tick();
    fireEvent.doubleClick(row('create-order.ts'));
    await tick();
    const editor = within(
      document.querySelector<HTMLElement>('[data-panel="editor"]') as HTMLElement,
    );
    fireEvent.click(editor.getByRole('button', { name: S.fileView.blame }));
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(blame).toHaveBeenCalledWith(expect.any(Number), FILE, null, false);
    expect(dialog()?.textContent).toContain(S.history.blameTitle(FILE));
    expect(dialog()?.textContent).toContain(S.history.workTree);
    expect(dialog()?.textContent).toContain(S.history.inRepo('api-gateway'));
    fireEvent.click(within(dialog() as HTMLElement).getByRole('button', { name: S.history.close }));
    await tick();

    fireEvent.click(editor.getByRole('button', { name: S.fileView.history }));
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(dialog()?.textContent).toContain(S.history.historyTitle(FILE));
  });

  it('Esc 는 폴더 탭의 미리보기 탭을 닫고 고정 탭·개요는 남긴다. 대화상자가 열려 있으면 대화상자 몫이다', async () => {
    const { id } = await mountFolder();
    await act(async () => {
      await getFolderStore(id)?.getState().fileTree.getState().reveal(`api-gateway/${FILE}`);
    });
    await tick();
    const ws = () => getWorkspaceStore(id)?.getState();
    // 미리보기 탭
    fireEvent.click(row('create-order.ts'));
    await tick();
    expect(ws()?.docs.map((d) => [d.id, d.pinned])).toEqual([
      ['overview', true],
      [`file:api-gateway/${FILE}`, false],
    ]);
    // 대화상자가 열려 있으면 Esc 는 문서를 닫지 않는다
    await act(async () => {
      await useAppStore.getState().withRepoSession(id, API, (st) => void st.openFileHistory(FILE));
    });
    await tick();
    expect(dialog()).not.toBeNull();
    press('Escape');
    expect(ws()?.docs).toHaveLength(2);
    fireEvent.click(within(dialog() as HTMLElement).getByRole('button', { name: S.history.close }));
    await tick();
    // 미리보기 탭은 닫힌다
    press('Escape');
    expect(ws()?.docs.map((d) => d.id)).toEqual(['overview']);
    // 고정 탭·개요는 닫히지 않는다
    fireEvent.doubleClick(row('create-order.ts'));
    await tick();
    press('Escape');
    expect(ws()?.docs.map((d) => [d.id, d.pinned])).toEqual([
      ['overview', true],
      [`file:api-gateway/${FILE}`, true],
    ]);
    act(() => ws()?.activateDoc('overview'));
    press('Escape');
    expect(ws()?.docs).toHaveLength(2);
  });
});

describe('W14 로 넓힌 허용 목록: 폴더 탭의 작업 트리 diff 탭', () => {
  const ORDERS = 'apps/console/src/shared/api/orders.ts';

  /** web-console 파일을 작업 트리 diff 탭으로 연다 (Commit 도구 창이 여는 길과 같다) */
  async function openWebDiff(id: SessionId) {
    await act(async () => {
      await useAppStore.getState().withRepoSession(id, WEB, (st) => {
        void st.openFile(ORDERS, false);
        getWorkspaceStore(id)?.getState().revealDoc(worktreeDiffDocId(WEB));
      });
    });
    await tick();
    const session = useAppStore.getState().repoSessions[id]?.[WEB]?.session ?? -1;
    return { session, store: getSessionStore(session) };
  }

  it('새로 켠 것: diff 탭과 그 안의 hunk stage·되돌리기는 그 저장소 세션에 닿는다', async () => {
    const { mock, id } = await mountFolder();
    const stageLines = vi.spyOn(mock, 'stageLines');
    const discardLines = vi.spyOn(mock, 'discardLines');
    const { session } = await openWebDiff(id);
    const editor = within(
      document.querySelector<HTMLElement>('[data-panel="editor"]') as HTMLElement,
    );
    expect(editor.getByText(ORDERS)).toBeTruthy();
    fireEvent.click(editor.getByText(S.diff.applyHunk(S.diff.stage)));
    await tick();
    expect(stageLines).toHaveBeenCalledWith(
      session,
      ORDERS,
      [{ hunk: 0, lines: [] }],
      false,
      expect.anything(),
    );
    fireEvent.click(editor.getByText(S.diff.discardHunk));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      S.diff.discardTitleIn('web-console', ORDERS),
    );
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(discardLines).toHaveBeenCalledWith(
      session,
      ORDERS,
      [{ hunk: 0, lines: [] }],
      expect.anything(),
    );
  });

  it('여전히 꺼진 것: 툴바의 저장소 버튼·undo/redo·쓰기 단축키·힌트 대화상자. Esc 는 탭만 닫는다', async () => {
    const { mock, id } = await mountFolder();
    const spies = {
      undo: vi.spyOn(mock, 'undo'),
      redo: vi.spyOn(mock, 'redo'),
      fetch: vi.spyOn(mock, 'fetch'),
      push: vi.spyOn(mock, 'push'),
      stashPush: vi.spyOn(mock, 'stashPush'),
    } satisfies Partial<Record<keyof IpcClient, unknown>>;
    const { store } = await openWebDiff(id);
    act(() =>
      store?.setState({
        undoState: { entries: [{ id: 1, label: 'commit', at: 0, changed: 1 }], redoCount: 1 },
      }),
    );
    await tick();
    // 툴바는 폴더 탭 모양 그대로다
    expect(toolbar().queryByText(`↶ ${S.safety.undo}`)).toBeNull();
    expect(toolbar().queryByRole('button', { name: S.remote.remotes })).toBeNull();
    expect(toolbar().queryByRole('button', { name: S.remote.pushMenu })).toBeNull();
    press('z', MOD);
    press('z', { ...MOD, shiftKey: true });
    press('f', { ...MOD, shiftKey: true });
    press('k', { ...MOD, shiftKey: true });
    press('s', { ...MOD, shiftKey: true });
    press('f', MOD);
    await tick();
    for (const spy of Object.values(spies)) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(store?.getState().search.open).toBe(false);
    // 저장소 탭 전용 힌트는 diff 탭이 열려 있어도 뜨지 않는다. W15 부터 index.lock·충돌 흐름의 힌트는 폴더 탭에서도
    // 보이므로(아래 W15 묶음) 여전히 꺼진 종류(push 거부)로 확인한다
    act(() =>
      store?.setState({
        pendingHint: {
          kind: 'nonFastForward',
          spec: {
            remote: 'origin',
            setUpstream: false,
            tags: false,
            forceWithLease: false,
            confirmUpstreamMismatch: false,
            rememberUpstreamMismatch: false,
          },
        },
      }),
    );
    await tick();
    expect(dialog()).toBeNull();
    // Esc 는 그 문서의 저장소 세션 슬롯만 비운다 (탭이 닫힌다)
    press('Escape');
    await tick();
    expect(store?.getState().selectedFile).toBeNull();
    expect(getWorkspaceStore(id)?.getState().sessionDocs).toEqual([]);
  });
});

describe('W15 로 넓힌 허용 목록: 충돌 편집기 탭·작업 띠·충돌 흐름의 힌트', () => {
  const CATALOG = `${FOLDER}/catalog-service`;
  const FACET = 'src/search/facets/FacetBuilder.kt';

  /** catalog 의 충돌 탭을 연 뒤 web 을 활성 저장소로 둔다 (힌트가 범위 밖 세션에 서는 모양) */
  async function catalogThenWeb(id: SessionId) {
    await act(async () => {
      await useAppStore.getState().openRepoConflict(id, CATALOG, FACET);
    });
    await tick();
    await act(async () => {
      await useAppStore.getState().withRepoSession(id, WEB, () => {});
    });
    await tick();
    const catalog = useAppStore.getState().repoSessions[id]?.[CATALOG]?.session ?? -1;
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(WEB);
    return { catalog, store: getSessionStore(catalog) };
  }

  it('새로 켠 힌트: index.lock 은 활성 저장소가 아닌 세션의 것도 저장소 이름을 붙여 보이고, 동작은 그 세션에 간다', async () => {
    const { mock, id } = await mountFolder();
    const removeLock = vi.spyOn(mock, 'removeIndexLock');
    const { catalog, store } = await catalogThenWeb(id);
    act(() => store?.setState({ pendingHint: { kind: 'indexLock' } }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      S.repoSession.hintTitle('catalog-service', S.dialog.indexLock),
    );
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(removeLock).toHaveBeenCalledWith(catalog);
    expect(store?.getState().pendingHint).toBeNull();
  });

  it('새로 켠 힌트: 충돌 마커가 남은 채 계속은 그 세션에서 허용하고 다시 계속한다', async () => {
    const { mock, id } = await mountFolder();
    const cont = vi.spyOn(mock, 'opContinue');
    const { catalog, store } = await catalogThenWeb(id);
    act(() =>
      store?.setState({
        pendingHint: { kind: 'conflictMarkers', files: [FACET], retry: { kind: 'opContinue' } },
      }),
    );
    await tick();
    expect(dialog()?.textContent).toContain(S.dialog.conflictMarkersContinue);
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(cont).toHaveBeenCalledWith(catalog, true);
  });

  it('안내만: hook 거부는 확인 단추 하나이고 커밋을 다시 하지 않는다. 보이는 힌트는 그 세션을 바쁘게 한다', async () => {
    const { mock, id } = await mountFolder();
    const commit = vi.spyOn(mock, 'commit');
    const { store } = await catalogThenWeb(id);
    act(() => store?.setState({ pendingHint: { kind: 'hookFailed' } }));
    await tick();
    expect(dialog()?.textContent).toContain(S.repoSession.hookFailedInfo);
    expect(dialog()?.textContent).not.toContain(S.dialog.retryNoVerify);
    expect(sessionBusy(store?.getState() as never)).toBe(true);
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(commit).not.toHaveBeenCalled();
    expect(store?.getState().pendingHint).toBeNull();
  });

  it('저장소 탭의 작업 띠(W21 ② — 그래프 위 배너에서 옮김): 같은 문구·조건, 저장소 탭 문구의 Abort 확인창, 그 탭의 세션에 대고 실행', async () => {
    const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    const abort = vi.spyOn(mock, 'opAbort');
    const opened = await mock.openRepo(CATALOG, () => {});
    const id = opened.session;
    const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
    const tabStore = createSessionStore(opened, mock, cache);
    // 그래프는 다 읽은 것으로 둔다 (띠는 그래프 로드 상태와 무관하다 — 로그 칸에 배너가 없는지 보기 위해 그래프를 그린다)
    tabStore.setState({ loadState: 'complete', totalRows: 60 });
    registerSession(id, { cache, store: tabStore });
    act(() =>
      useAppStore.setState({
        sessions: {
          [id]: { id, kind: 'repo', path: CATALOG, name: 'catalog-service', parent: null },
        },
        sessionOrder: [id],
        activeSessionId: id,
        dock: DEFAULT_DOCK,
        client: mock,
      }),
    );
    render(<App />);
    await tick();
    // 툴바 아래 띠에 한 줄, 그래프(로그 칸) 안에는 같은 배너가 없다
    const band = screen.getByRole('region', { name: S.opBand.label });
    const log = document.querySelector<HTMLElement>('[data-panel="git-log"]') as HTMLElement;
    expect(within(log).queryByRole('group')).toBeNull();
    // 상태 바에도 같은 라벨이 있다
    expect(screen.getAllByText(S.status.op.rebase(3, 5)).length).toBeGreaterThan(0);
    expect(within(band).getByText(S.op.conflicts(1))).toBeTruthy();
    const cont = within(band).getByRole('button', {
      name: S.op.continueLabel,
    }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    // W21 ②: 저장소 탭에도 "충돌 해결"이 있다 (WS-19 — 충돌 파일이 하나면 머지 편집기 탭)
    expect(within(band).getByRole('button', { name: S.opBand.resolve }).title).toBe(
      S.opBand.resolveOne,
    );
    fireEvent.click(within(band).getByRole('button', { name: S.op.abort }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.op.abortTitle);
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(abort).toHaveBeenCalledWith(id);
  });

  it('여전히 꺼진 것: 저장소 탭 전용 힌트·세션 대화상자(reflog·rebase 플랜·미리보기)·검증 명령 읽기', async () => {
    const { mock, id } = await mountFolder();
    const verify = vi.spyOn(mock, 'verifyCommand');
    const { store } = await catalogThenWeb(id);
    act(() =>
      store?.setState({
        pendingHint: { kind: 'detachedHead' },
        reflogOpen: true,
        rebasePlan: { onto: null, commits: [], hasMerges: false },
      }),
    );
    await tick();
    expect(dialog()).toBeNull();
    // 끈 힌트는 바쁨에 세지 않는다 (사용자가 닫을 수 없으므로)
    expect(sessionBusy(store?.getState() as never)).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    // 충돌 탭 머리줄에 검증 실행이 없다 (검증 명령은 가벼운 세션에서 읽지 않는다)
    act(() => getWorkspaceStore(id)?.getState().activateDoc(`conflict:${CATALOG}`));
    await tick();
    const editor = within(
      document.querySelector<HTMLElement>('[data-panel="editor"]') as HTMLElement,
    );
    expect(editor.queryByRole('button', { name: S.verify.run })).toBeNull();
  });
});
