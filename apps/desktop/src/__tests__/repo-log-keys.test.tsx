// W27: 로그의 키 — 폴더 탭과 저장소 탭이 같은 규칙. 실제 그래프 뷰(`@mgit/graph-view`)를 쓰고 jsdom 에서 행이 그려지도록
// 크기만 넣는다.
// - 로그(grid)에서 Enter = 상세 칸으로 포커스 (폴더: 변경 파일 트리, 저장소: 변경 파일 목록 — 고른 commit 이 없으면 상세
//   칸의 첫 조작 요소). ⇧F10 = 고른 행의 우클릭 메뉴.
// - 행을 마우스로 누르면 포커스는 행이 아니라 로그(grid)에 남는다 (그 뒤의 Enter 도 상세로).
// - 저장소 탭의 WIP 행: 첫 commit 행에서 ↑ = 고르기만(왼쪽 도구 창은 그대로), WIP 를 고른 채 Enter = 활성화(Commit 도구 창의
//   변경 탭으로 포커스). 그래프 뷰 단독의 계약(↑↓ 는 WIP 를 고르지 않는다)은 `wip-row-activation.test.tsx` 가 지킨다.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { getFolderStore, useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  getSessionStore,
  registerFolder,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 실제 그래프 뷰에 jsdom 용 크기만 넣는다 (레이아웃이 없어 행이 그려지지 않는다)
vi.mock('@mgit/graph-view', async (orig) => {
  const mod = await orig<typeof import('@mgit/graph-view')>();
  const { createElement } = await import('react');
  return {
    ...mod,
    GraphView: (props: GraphViewProps) =>
      createElement(mod.GraphView, {
        ...props,
        rowHeight: 24,
        initialRect: { width: 900, height: 240 },
      }),
  };
});
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

const REPO = '/mock/storefront-web';
const FOLDER = '/mock/acme-platform';
const ROWS = 60;
const originalClient = useAppStore.getState().client;
let repos: SessionId[] = [];
let folders: SessionId[] = [];

/** 저장소 탭을 열고 앱 전체를 그린다. 로그는 목 클라이언트의 그래프를 읽는다. `clean` 이면 작업 트리 변경이 없다 */
async function mountRepo(clean = false) {
  const mock = createMockClient({ rows: ROWS, scene: 'repo', progressIntervalMs: 0 });
  const opened = await mock.openRepo(REPO, () => {});
  const id = opened.session;
  repos.push(id);
  const cache = new GraphRangeCache({ fetchWindow: (s, n) => mock.graphWindow(id, s, n) });
  cache.setTotalRows(ROWS, true);
  const store = createSessionStore(
    opened,
    mock,
    cache,
    sessionRevealHooks(useAppStore.getState, id),
  );
  store.setState({ loadState: 'complete', totalRows: ROWS });
  if (clean) {
    const status = store.getState().status;
    store.setState({
      status: {
        ...status,
        entries: [],
        summary: { ...status.summary, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      },
    });
  }
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path: REPO, name: 'storefront-web', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      conflictLeave: null,
      appDialog: null,
    }),
  );
  render(<App />);
  await settle();
  return { id, store, st: () => store.getState() };
}

/** 폴더 탭을 열고 앱 전체를 그린다 (Git 도구 창 로그 탭 = 통합 타임라인) */
async function mountFolder() {
  const mock = createMockClient({ rows: ROWS, scene: 'folder', progressIntervalMs: 0 });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  folders.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  registerWorkspace(id, createWorkspaceStore('folder'));
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
  await settle();
  return { id };
}

/** 읽기·상세 읽기가 끝날 때까지 몇 박자 기다린다 */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await tick();
  }
}

/** 로그(grid)에 포커스를 주고 키를 누른다 */
async function key(k: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) {
  act(() => {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: k, ...mods });
  });
  await settle();
}
const grid = () => screen.getByRole('grid', { name: S.graph.label });
const focusGrid = () => act(() => grid().focus());
const focusedPanel = () =>
  (document.activeElement as HTMLElement | null)
    ?.closest('[data-panel]:not([data-panel="true"])')
    ?.getAttribute('data-panel');
const wipRow = () => document.querySelector<HTMLElement>('[data-row="wip"]');
/** grid 가 가리키는 행 (activedescendant) */
const activeRow = () => document.getElementById(grid().getAttribute('aria-activedescendant') ?? '');

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
      client: originalClient,
      toasts: [],
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      commitTab: 'changes',
      conflictLeave: null,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  for (const id of repos) {
    disposeWorkspace(id);
  }
  for (const id of folders) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  repos = [];
  folders = [];
  clearSessionRegistry();
});

describe('로그의 macOS 처음·끝 이동', () => {
  it.each(['repo', 'folder'] as const)(
    '%s: ⌘↑·⌘↓는 Home·End와 같은 커밋을 선택한다',
    async (kind) => {
      const mounted = kind === 'repo' ? await mountRepo() : await mountFolder();
      const selected = () =>
        kind === 'repo'
          ? getSessionStore(mounted.id)?.getState().selectedCommit
          : getFolderStore(mounted.id)?.getState().timeline.selected?.oid;
      focusGrid();
      await key('End');
      const endOid = selected();
      expect(endOid).toBeTruthy();
      await key('ArrowUp', { metaKey: true });
      expect(activeRow()?.getAttribute('data-row')).toBe('0');
      await key('ArrowDown', { metaKey: true });
      expect(selected()).toBe(endOid);
      expect(document.activeElement).toBe(grid());
    },
  );
});

describe('저장소 탭 로그의 Enter·⇧F10 (W27 — 폴더 탭과 같은 키)', () => {
  it('고른 commit 이 있으면 Enter 가 상세의 변경 파일 목록으로, 없으면(WIP 행도 없음) 상세 칸의 첫 조작 요소로 옮긴다', async () => {
    // 깨끗한 작업 트리: WIP 행이 없고 고른 commit 도 없다 → 상세 칸은 작업 트리 요약
    await mountRepo(true);
    focusGrid();
    await key('Enter');
    expect(focusedPanel()).toBe('git-detail');
    expect(document.activeElement?.textContent).toBe(S.workspace.repoLog.openCommitTool);
    cleanup();

    await mountRepo();
    focusGrid();
    await key('Home');
    expect(activeRow()?.getAttribute('data-row')).toBe('0');
    await key('Enter');
    expect(focusedPanel()).toBe('git-detail');
    // 변경 파일 목록의 지금 단추 (목록이 Tab 정지 하나)
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(document.activeElement?.closest('ul')).not.toBeNull();
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0');
  });

  it('수정키와 함께 누른 Enter 는 옮기지 않는다', async () => {
    await mountRepo();
    focusGrid();
    await key('Home');
    act(() => {
      fireEvent.keyDown(grid(), { key: 'Enter', altKey: true });
    });
    await settle();
    expect(document.activeElement).toBe(grid());
  });

  it('⇧F10 은 고른 commit 행의 우클릭 메뉴를 연다', async () => {
    await mountRepo();
    focusGrid();
    await key('Home');
    await key('F10', { shiftKey: true });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain(S.menu.copyHash);
  });

  it('행을 누르면 포커스가 로그(grid)에 남고, 그 뒤의 Enter 도 상세로 간다', async () => {
    await mountRepo();
    const row = document.querySelector<HTMLElement>('[role="grid"] [data-row="2"]') as HTMLElement;
    act(() => {
      row.focus();
      fireEvent.click(row);
    });
    await settle();
    expect(document.activeElement).toBe(grid());
    expect(activeRow()).toBe(row);
    await key('Enter');
    expect(focusedPanel()).toBe('git-detail');
  });
});

describe('저장소 탭 로그의 WIP 행 — 고르기와 활성화를 나눈다 (W27)', () => {
  it('첫 commit 행에서 ↑ 는 WIP 행을 고르기만 한다 (도구 창·포커스는 그대로). ↑ 를 더 눌러도 그대로, ↓ 는 첫 commit', async () => {
    const { st } = await mountRepo();
    focusGrid();
    await key('Home');
    await key('ArrowUp');
    expect(st().wipSelected).toBe(true);
    expect(st().selectedCommit).toBeNull();
    expect(useAppStore.getState().leftTool).toBe('project');
    expect(document.activeElement).toBe(grid());
    expect(activeRow()).toBe(wipRow());
    await key('ArrowUp');
    expect(st().wipSelected).toBe(true);
    expect(activeRow()).toBe(wipRow());
    await key('ArrowDown');
    expect(st().wipSelected).toBe(false);
    expect(activeRow()?.getAttribute('data-row')).toBe('0');
  });

  it('WIP 행을 고른 채 Enter 는 활성화 — Commit 도구 창의 변경 탭을 열고 그리로 포커스한다 (세션은 WIP 를 고른 채 시작한다)', async () => {
    const { st } = await mountRepo();
    act(() => useAppStore.getState().setCommitTab('stash'));
    focusGrid();
    // 처음 상태: WIP 행이 골라져 있다 — ↑ 는 그대로
    expect(st().wipSelected).toBe(true);
    await key('ArrowUp');
    expect(activeRow()).toBe(wipRow());
    expect(useAppStore.getState().leftTool).toBe('project');
    await key('Home');
    await key('ArrowUp');
    await key('Enter');
    expect(st().wipSelected).toBe(true);
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(useAppStore.getState().commitTab).toBe('changes');
    expect(focusedPanel()).toBe('commit');
  });

  it('수정키 조합의 ↑ 와 첫 행이 아닌 곳의 ↑ 는 WIP 를 고르지 않는다. 작업 트리가 깨끗하면 WIP 행이 없다', async () => {
    const { st } = await mountRepo();
    focusGrid();
    await key('Home');
    await key('ArrowUp', { shiftKey: true });
    expect(st().wipSelected).toBe(false);
    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowUp');
    expect(st().wipSelected).toBe(false);
    expect(activeRow()?.getAttribute('data-row')).toBe('1');
    cleanup();

    const clean = await mountRepo(true);
    focusGrid();
    await key('Home');
    await key('ArrowUp');
    expect(wipRow()).toBeNull();
    expect(clean.st().wipSelected).toBe(false);
    expect(activeRow()?.getAttribute('data-row')).toBe('0');
  });
});

describe('폴더 탭 로그 — 같은 규칙 (W19 ③ + W27 의 행 클릭)', () => {
  it('행을 누르면 포커스가 로그(grid)에 남고, Enter 가 변경 파일 트리로 간다', async () => {
    await mountFolder();
    const row = document.querySelector<HTMLElement>('[role="grid"] [data-row="1"]') as HTMLElement;
    expect(row).not.toBeNull();
    act(() => {
      row.focus();
      fireEvent.click(row);
    });
    await settle();
    expect(document.activeElement).toBe(grid());
    await key('Enter');
    expect(focusedPanel()).toBe('git-detail');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(S.detail.changedFiles);
  });
});

describe('로그 메시지 수정 명령', () => {
  it('F2의 원격 포함 확인이 실패하면 메시지 수정 창을 열지 않는다', async () => {
    const { store } = await mountRepo();
    const read = vi.fn(async () => 'subject');
    const check = vi.fn(async () => false);
    act(() => store.setState({ commitMessageOf: read, checkRewordAllowed: check }));
    focusGrid();
    await key('Home');
    await key('F2');
    expect(check).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: S.rebase.message })).toBeNull();
  });

  it('원격 브랜치에 포함된 커밋은 F2와 우클릭 수정 모두 비활성이다', async () => {
    const { store } = await mountRepo();
    focusGrid();
    await key('Home');
    const oid = store.getState().selectedCommit as string;
    act(() =>
      store.setState({
        containing: {
          of: oid,
          state: 'ready',
          refs: {
            timedOut: false,
            head: true,
            branches: [
              {
                name: 'refs/remotes/other/main',
                shortName: 'other/main',
                remote: true,
                current: false,
              },
            ],
          },
        },
      }),
    );
    await key('F2');
    expect(screen.queryByRole('textbox', { name: S.rebase.message })).toBeNull();
    await key('F10', { shiftKey: true });
    const item = screen.getByRole('menuitem', { name: /메시지 수정/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe(S.shortcuts.rewordPublished);
  });

  it('F2는 전체 메시지를 채우고 취소하면 수정하지 않는다', async () => {
    const { store } = await mountRepo();
    const message = 'subject\n\nbody paragraph\n\n';
    const read = vi.fn(async () => message);
    const write = vi.fn(async () => {});
    act(() => store.setState({ commitMessageOf: read, rewordCommit: write }));
    focusGrid();
    await key('Home');
    await key('F2');
    const input = screen.getByRole('textbox', { name: S.rebase.message }) as HTMLTextAreaElement;
    expect(input.value).toBe(message);
    expect(read).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(screen.getByRole('button', { name: S.confirm.cancel })));
    await settle();
    expect(write).not.toHaveBeenCalled();
  });

  it('수정 저장 시 메시지 본문과 앞뒤 공백을 그대로 전달한다', async () => {
    const { store } = await mountRepo();
    const message = 'subject\n\nbody\n\n';
    const write = vi.fn(async () => {});
    act(() => store.setState({ commitMessageOf: vi.fn(async () => message), rewordCommit: write }));
    focusGrid();
    await key('Home');
    const oid = store.getState().selectedCommit;
    await key('F2');
    act(() => fireEvent.click(screen.getByRole('button', { name: S.dialog.apply })));
    await settle();
    expect(write).toHaveBeenCalledWith(oid, message);
  });

  it('과거 커밋도 같은 수정 창을 열고 입력 중 F2는 실행하지 않는다', async () => {
    const { store } = await mountRepo();
    const read = vi.fn(async () => 'older subject\n\nolder body');
    act(() => store.setState({ commitMessageOf: read }));
    focusGrid();
    await key('Home');
    await key('ArrowDown');
    const oid = store.getState().selectedCommit;
    await key('F2');
    expect(read).toHaveBeenCalledWith(oid);
    const input = screen.getByRole('textbox', { name: S.rebase.message });
    act(() => fireEvent.keyDown(input, { key: 'F2' }));
    expect(read).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(screen.getByRole('button', { name: S.confirm.cancel })));
    await settle();
  });

  it('범위 선택과 detached HEAD에서는 수정 창을 열지 않는다', async () => {
    const { store } = await mountRepo();
    const read = vi.fn(async () => 'message');
    act(() => store.setState({ commitMessageOf: read }));
    focusGrid();
    await key('Home');
    act(() =>
      store.setState({
        range: { from: 0, to: 1, newer: 'a', older: 'b', base: 'c', files: [], loading: false },
      }),
    );
    await key('F2');
    expect(read).not.toHaveBeenCalled();
    act(() =>
      store.setState({
        range: null,
        refs: { ...store.getState().refs, head: { state: 'detached', oid: 'a' } },
      }),
    );
    await key('F2');
    expect(read).not.toHaveBeenCalled();
  });

  it('WIP와 실행 중 작업은 메시지를 읽지 않는다', async () => {
    const { store } = await mountRepo();
    const read = vi.fn(async () => 'message');
    act(() => store.setState({ commitMessageOf: read }));
    focusGrid();
    await key('F2');
    expect(read).not.toHaveBeenCalled();
    await key('Home');
    act(() => store.setState({ busy: true }));
    await key('F2');
    expect(read).not.toHaveBeenCalled();
  });

  it('메시지 로드 중 반복 F2를 합치고 다른 선택으로 바꾸면 늦은 창을 열지 않는다', async () => {
    const { store } = await mountRepo();
    let finish!: (message: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => store.setState({ commitMessageOf: read }));
    focusGrid();
    await key('Home');
    await key('F2');
    await key('F2');
    expect(read).toHaveBeenCalledTimes(1);
    await key('ArrowDown');
    await act(async () => finish('late'));
    await settle();
    expect(screen.queryByRole('textbox', { name: S.rebase.message })).toBeNull();
  });
});
