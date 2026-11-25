// W27: 저장소 탭 화면 전체의 접근성 — 폴더 탭(`folder-a11y.test.tsx`, W19 ③)과 같은 규칙·같은 도우미로 확인한다.
// 이름 없는 단추 0(W20~W26 의 새 영역: Project 머리의 ⋮ 메뉴·트리 위 띠, Commit 탭 막대·Stash 목록, PR 목록, 필터 바의
// 찾기·경로 팝오버·"ref 이름 입력…"·WIP 안내 줄의 "필터 지우기"), 트리의 같은 규칙, 영역 단축키의 포커스 대상, 큰 목록·막대의
// Tab 정지 하나, 한 바퀴 Tab 정지 수.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { useAppStore } from '../store';
import {
  createRepoWorkspace,
  DEFAULT_DOCK,
  type LeftTool,
  sessionRevealHooks,
} from '../store/app-store';
import {
  clearSessionRegistry,
  disposeWorkspace,
  getWorkspaceStore,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { checkTreeRules, tabStops, unnamedButtons } from './a11y-helpers';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그는 포커스를 받는 표 하나로만 흉내 낸다 (뷰의 키·ARIA 는 graph-view 가, 로그의 Enter·WIP 키는
// `repo-log-keys.test.tsx` 가 테스트한다). 터미널·홈은 그리지 않는다
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => (
    // biome-ignore lint/a11y/useSemanticElements: 테스트용 흉내
    <div data-testid="graph-view" role="grid" aria-label={S.graph.label} tabIndex={0} />
  ),
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

// 목 저장소 장면 (storefront-web): 작업 트리 변경(staged·변경·untracked), 스태시 3, 모듈·서브모듈·하위 저장소, GitHub 원격
// 프로젝트(PR 6개)
const REPO = '/mock/storefront-web';
const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 저장소 탭을 열고 앱 전체를 그린다. 생성 때 읽기(모듈·서브모듈·스태시)가 끝날 때까지 기다린다 */
async function mountRepo(leftTool: LeftTool | null = 'project') {
  const mock = createMockClient({ rows: 60, scene: 'repo', progressIntervalMs: 0 });
  const opened = await mock.openRepo(REPO, () => {});
  const id = opened.session;
  mounted.push(id);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(
    opened,
    mock,
    cache,
    sessionRevealHooks(useAppStore.getState, id),
  );
  store.setState({ loadState: 'complete', totalRows: 60 });
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path: REPO, name: 'storefront-web', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool,
      client: mock,
      conflictLeave: null,
      appDialog: null,
      openRepositoryAt: vi.fn(async () => null),
    }),
  );
  render(<App />);
  await tick();
  await act(async () => {
    await store.getState().loadModules();
    await store.getState().loadSubmodules();
    await store.getState().loadStashes();
  });
  await tick();
  return { id, store, st: () => store.getState() };
}

/** 앱 단축키를 누른다 (jsdom 은 mac 이 아니라 mod = Ctrl) */
async function press(key: string, mods: { shift?: boolean } = {}) {
  const target = document.activeElement ?? document.body;
  act(() => {
    fireEvent.keyDown(target, {
      key,
      ctrlKey: !['0', '1', '9'].includes(key),
      altKey: ['0', '1', '9'].includes(key),
      shiftKey: mods.shift ?? false,
    });
  });
  await tick();
}

/** 지금 포커스가 있는 요소의 영역 이름 (`data-panel`) */
const focusedPanel = () =>
  (document.activeElement as HTMLElement | null)
    ?.closest('[data-panel]:not([data-panel="true"])')
    ?.getAttribute('data-panel');
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
/** 그 선택자 안의 Tab 정지 수 */
const stopsIn = (selector: string) =>
  tabStops().filter((el) => el.closest(selector) !== null).length;
/** 이름 없는 단추 (보고용으로 앞 120자) */
const unnamed = () => unnamedButtons().map((b) => b.outerHTML.slice(0, 120));
/** 첫 번째 ref 의 커밋을 고르고 상세(변경 파일 목록)가 뜰 때까지 기다린다 */
async function selectFirstCommit(store: ReturnType<typeof createSessionStore>) {
  const oid = store.getState().refs.labels[0]?.target ?? '';
  await act(async () => {
    store.getState().selectCommit(oid);
  });
  await tick();
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
});

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() =>
    useAppStore.setState({
      shortcutOverrides: {},
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      client: originalClient,
      toasts: [],
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      commitTab: 'changes',
      conflictLeave: null,
    }),
  );
  for (const id of mounted) {
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('저장소 화면의 이름 (W27 — W20~W26 의 새 영역)', () => {
  it('Project 도구 창: 트리·⋮ 메뉴(열었을 때 포함)·트리 위 범위 띠의 링크와 ×', async () => {
    const { store } = await mountRepo();
    expect(unnamed()).toEqual([]);
    const project = within(area('project') as HTMLElement);
    const menu = project.getByRole('button', { name: S.project.structure.menu });
    act(() => {
      fireEvent.keyDown(menu, { key: 'Enter' });
    });
    await tick();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(unnamed()).toEqual([]);
    act(() => {
      fireEvent.keyDown(document.querySelector('[role="menu"]') as HTMLElement, { key: 'Escape' });
    });
    await tick();
    // 모듈 범위가 걸리면 트리 위 띠(범위 이름·×)가 생긴다
    act(() => store.setState({ moduleScope: 'src/features/cart' }));
    await tick();
    expect(project.getByRole('button', { name: S.modules.clearScope })).toBeTruthy();
    expect(unnamed()).toEqual([]);
  });

  it('Commit 도구 창(변경·Stash 탭)·Pull Requests 도구 창', async () => {
    await mountRepo('commit');
    expect(within(area('commit') as HTMLElement).getByRole('tablist')).toBeTruthy();
    expect(unnamed()).toEqual([]);
    act(() => useAppStore.getState().setCommitTab('stash'));
    await tick();
    expect(screen.getByRole('listbox', { name: S.stash.list })).toBeTruthy();
    expect(unnamed()).toEqual([]);
    act(() => useAppStore.getState().setLeftTool('pullRequests'));
    await tick();
    await tick();
    expect(within(area('pull-requests') as HTMLElement).getByRole('listbox')).toBeTruthy();
    expect(unnamed()).toEqual([]);
  });

  it('로그 탭: 필터 바(찾기 단추·경로 팝오버의 입력·적용·branch 팝오버의 "ref 이름 입력…")·WIP 안내 줄의 "필터 지우기"·콘솔 탭', async () => {
    const { store, st } = await mountRepo();
    const log = within(area('git-log') as HTMLElement);
    expect(log.getByRole('button', { name: S.filterBar.find })).toBeTruthy();
    /** 필터 바의 드롭다운 단추 (요약 글자로 시작) */
    const drop = (name: string) =>
      log
        .getAllByRole<HTMLButtonElement>('button')
        .find(
          (b) => b.getAttribute('aria-haspopup') === 'dialog' && b.textContent?.startsWith(name),
        ) as HTMLButtonElement;
    act(() => fireEvent.click(drop(S.filterBar.path)));
    expect(screen.getByRole('textbox', { name: S.filterBar.path })).toBeTruthy();
    expect(unnamed()).toEqual([]);
    act(() => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    act(() => fireEvent.click(drop(S.filterBar.branch)));
    await tick();
    expect(screen.getByRole('button', { name: S.filterBar.customRefs })).toBeTruthy();
    expect(unnamed()).toEqual([]);
    act(() => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    // 조건에 맞는 commit 이 없고 작업 트리 변경이 있으면 로그 위 안내 줄 + "필터 지우기"
    act(() =>
      store.setState({
        graphQuery: { ...st().graphQuery, revs: { kind: 'solo', name: 'zzz-없음' } },
        totalRows: 0,
      }),
    );
    await tick();
    expect(log.getByRole('button', { name: S.folder.timeline.clearFilters })).toBeTruthy();
    expect(unnamed()).toEqual([]);
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    expect(unnamed()).toEqual([]);
  });

  it('상세 칸: 고른 commit 이 없을 때(작업 트리 요약)와 있을 때(변경 파일 목록)', async () => {
    const { store } = await mountRepo();
    expect(within(area('git-detail') as HTMLElement).getByRole('button')).toBeTruthy();
    await selectFirstCommit(store);
    expect(
      within(area('git-detail') as HTMLElement).getByRole('tree', { name: S.detail.changedFiles }),
    ).toBeTruthy();
    expect(unnamed()).toEqual([]);
  });

  it('모든 분할선에 이름이 있다', async () => {
    await mountRepo();
    const separators = [...document.querySelectorAll('[role="separator"]')];
    expect(separators.length).toBeGreaterThanOrEqual(4);
    expect(separators.filter((s) => !s.getAttribute('aria-label'))).toEqual([]);
  });
});

describe('저장소 화면의 Tab 정지 (W27)', () => {
  it('큰 목록·트리·막대는 Tab 정지가 하나다 (트리 둘·띠·브랜치 세로 툴바·도구 창 탭)', async () => {
    await mountRepo();
    expect(stopsIn('[role="tree"]')).toBe(2); // 프로젝트 트리 + 브랜치 트리 (각각 트리 자신)
    expect(stopsIn(`[role="toolbar"][aria-label="${S.workspace.stripe}"]`)).toBe(1);
    expect(stopsIn(`[role="toolbar"][aria-label="${S.branches.toolbar.label}"]`)).toBe(1);
    expect(stopsIn('[data-dock] [role="tablist"]')).toBe(1);
  });

  it('Commit 도구 창: 탭 막대 하나, 변경 목록은 목록마다 하나, Stash 목록 하나 / PR 목록 하나', async () => {
    await mountRepo('commit');
    const commit = area('commit') as HTMLElement;
    expect(stopsIn('[data-panel="commit"] [role="tablist"]')).toBe(1);
    const lists = [...commit.querySelectorAll('ul')];
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.map((ul) => tabStops(ul).length)).toEqual(lists.map(() => 1));
    act(() => useAppStore.getState().setCommitTab('stash'));
    await tick();
    expect(stopsIn('[role="listbox"]')).toBe(1);
    act(() => useAppStore.getState().setLeftTool('pullRequests'));
    await tick();
    await tick();
    expect(stopsIn('[data-panel="pull-requests"] [role="listbox"]')).toBe(1);
  });

  it('변경 목록 안은 ↑↓·Home·End 로 파일 행과 디렉터리 단추 사이를 옮기고 Tab 정지가 따라간다 (끝에서 멈춘다)', async () => {
    await mountRepo('commit');
    const list = (area('commit') as HTMLElement).querySelector('ul') as HTMLElement;
    const [first] = tabStops(list);
    act(() => (first as HTMLElement).focus());
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    });
    expect(document.activeElement).toBe(first);
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    });
    expect(document.activeElement).not.toBe(first);
    expect(tabStops(list)).toEqual([document.activeElement]);
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    });
    expect(document.activeElement).toBe(first);
  });

  it('상세의 변경 파일 목록이 Tab 정지 하나다', async () => {
    const { store } = await mountRepo();
    await selectFirstCommit(store);
    const files = screen.getByRole('tree', { name: S.detail.changedFiles });
    expect(within(files).getAllByRole('treeitem').length).toBeGreaterThan(1);
    expect(files.tabIndex).toBe(0);
    expect(tabStops(files)).toHaveLength(0);
    checkTreeRules(files);
  });

  it('한 바퀴 Tab 정지 수: Commit 도구 창을 열어도 Project 와 몇 개 차이다 (전에는 변경 파일마다 하나 — 브라우저 38 → 75)', async () => {
    await mountRepo();
    const withProject = tabStops().length;
    act(() => useAppStore.getState().setLeftTool('commit'));
    await tick();
    const withCommit = tabStops().length;
    // 변경 목록 둘(staged·변경) + 머리 단추·폼 입력이 늘고, 프로젝트 트리·머리 단추가 빠진다
    expect(Math.abs(withCommit - withProject)).toBeLessThanOrEqual(12);
    expect(withCommit).toBeLessThan(60);
  });

  it('최대화로 접힌 본문·숨긴 아래 도구 창·접힌 왼쪽 도구 창은 Tab 순서에서 빠진다', async () => {
    await mountRepo();
    const inBody = () =>
      tabStops().filter((el) => el.closest('[data-panel="project"], [data-panel="editor"]'));
    const inDock = () => tabStops().filter((el) => el.closest('[data-dock]'));
    expect(inBody().length).toBeGreaterThan(0);
    act(() => useAppStore.getState().setDockMaximized(true));
    await tick();
    expect(inBody()).toEqual([]);
    expect(inDock().length).toBeGreaterThan(0);
    act(() => useAppStore.getState().setDockMaximized(false));
    act(() => useAppStore.getState().hideDock());
    await tick();
    expect(inDock()).toEqual([]);
    act(() => useAppStore.getState().setLeftTool(null));
    await tick();
    expect(tabStops().filter((el) => el.closest('[data-panel="project"]'))).toEqual([]);
  });
});

describe('저장소 탭 트리의 같은 규칙 (WS-11)', () => {
  it('프로젝트 트리·브랜치 트리: 단계·형제 수·순번, Home·↓, ⇧F10', async () => {
    await mountRepo();
    checkTreeRules(screen.getByRole('tree', { name: S.project.tree }));
    checkTreeRules(screen.getByRole('tree', { name: S.branches.tree }));
  });
});

describe('저장소 탭 영역 단축키의 포커스 대상 (WS-11, 두 탭이 같다)', () => {
  it('⌘1 프로젝트 트리, ⌘2 에디터, ⌘9 로그, ⌘3 상세, ⌘0 Commit 변경 목록, ⌘⇧G 필터 바 텍스트 칸', async () => {
    const { store } = await mountRepo();
    await press('1');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(S.project.tree);
    await press('2');
    expect(focusedPanel()).toBe('editor');
    await press('9');
    expect(document.activeElement?.getAttribute('role')).toBe('grid');
    // 고른 commit 이 없으면 상세 칸은 작업 트리 요약 — 그 칸의 첫 조작 요소
    await press('3');
    expect(document.activeElement?.textContent).toBe(S.workspace.repoLog.openCommitTool);
    // commit 을 고르면 변경 파일 목록 (폴더 탭의 변경 파일 트리와 같은 자리)
    await selectFirstCommit(store);
    await press('3');
    expect(focusedPanel()).toBe('git-detail');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(S.detail.changedFiles);
    await press('0');
    expect(focusedPanel()).toBe('commit');
    expect(document.activeElement?.closest('ul')).not.toBeNull();
    act(() => useAppStore.getState().setShortcutOverrides({ 'view.graphFilter': 'ctrl+shift+g' }));
    await press('g', { shift: true });
    expect(document.activeElement?.hasAttribute('data-filter-text')).toBe(true);
  });
});

/** 범위 상세도 같은 트리·분할로 그리면서 기존 범위 diff 계약을 유지한다. */
describe('단일 저장소 변경 파일 트리 통일', () => {
  it('파일 단일 클릭은 미리보기를 교체하고 더블클릭은 독립 탭으로 고정한다', async () => {
    const { store, id } = await mountRepo();
    await selectFirstCommit(store);
    const selectedCommit = store.getState().selectedCommit;
    const tree = screen.getByRole('tree', { name: S.detail.changedFiles });
    const files = within(tree)
      .getAllByRole('treeitem')
      .filter((item) => item.getAttribute('data-kind') === 'file');
    const first = files[0];
    const second = files[1];
    if (!first || !second) throw new Error('변경 파일 둘이 필요합니다');
    const ws = () => getWorkspaceStore(id)?.getState();
    fireEvent.click(first);
    expect(ws()?.docs).toHaveLength(1);
    expect(ws()?.docs[0]).toMatchObject({ kind: 'commitDiff', pinned: false, oid: selectedCommit });
    const firstId = ws()?.docs[0]?.id;
    fireEvent.click(second);
    expect(ws()?.docs).toHaveLength(1);
    expect(ws()?.docs[0]?.id).not.toBe(firstId);
    fireEvent.doubleClick(second);
    expect(ws()?.docs[0]?.pinned).toBe(true);
    fireEvent.click(first);
    expect(ws()?.docs).toHaveLength(2);
    expect(ws()?.docs.map((doc) => doc.pinned)).toEqual([true, false]);
    fireEvent.contextMenu(first);
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(S.menu.showDiff) }));
    expect(ws()?.docs.map((doc) => doc.pinned)).toEqual([true, true]);
    expect(store.getState().selectedFile).toBeNull();
    expect(store.getState().selectedCommit).toBe(selectedCommit);
  });

  it('범위는 폴더 계층·rename 정보를 보이고 범위 diff를 그대로 연다', async () => {
    const { store, id } = await mountRepo();
    act(() =>
      store.setState({
        range: {
          from: 0,
          to: 2,
          older: 'a'.repeat(40),
          newer: 'b'.repeat(40),
          base: 'c'.repeat(40),
          loading: false,
          files: [
            { path: 'src/new.ts', oldPath: 'old.ts', change: { kind: 'renamed', similarity: 95 } },
            { path: 'src/removed.ts', oldPath: null, change: { kind: 'deleted' } },
          ],
        },
      }),
    );
    await tick();
    const tree = screen.getByRole('tree', { name: S.detail.changedFiles });
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((item) => item.getAttribute('aria-level')),
    ).toEqual(['1', '2', '3', '3']);
    const file = within(tree)
      .getAllByRole('treeitem')
      .find((item) => item.title === 'old.ts → src/new.ts');
    expect(file).toBeTruthy();
    expect(document.getElementById('gitdetail-files')?.contains(tree)).toBe(true);
    expect(document.getElementById('gitdetail-info')?.textContent).toContain(
      S.detail.rangeTitle(3),
    );
    fireEvent.click(file as HTMLElement);
    expect(getWorkspaceStore(id)?.getState().docs).toEqual([
      expect.objectContaining({
        kind: 'rangeDiff',
        path: 'src/new.ts',
        base: 'c'.repeat(40),
        newer: 'b'.repeat(40),
        pinned: false,
      }),
    ]);
    fireEvent.doubleClick(file as HTMLElement);
    expect(getWorkspaceStore(id)?.getState().docs[0]?.pinned).toBe(true);
    expect(store.getState().selectedFile).toBeNull();
    fireEvent.contextMenu(file as HTMLElement);
    expect(screen.queryByRole('menuitem', { name: S.menu.blame })).toBeNull();
    expect(screen.getByRole('menuitem', { name: S.project.menu.copyRelative })).toBeTruthy();
  });
});
