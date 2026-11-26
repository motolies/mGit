import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, type SessionId } from '@mgit/ipc';
import { ConfirmDialog, S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { focusTargetIn } from '../actions';
import { CommandLogView } from '../features/log/CommandLogPanel';
import { EditorArea } from '../features/workspace/EditorArea';
import { ToolStripe } from '../layout/ToolStripe';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../store';
import { DEFAULT_DOCK } from '../store/app-store';
import { createFolderStore, timelineRepoPath } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { createWorkspaceStore } from '../store/workspace-store';
import { checkTreeRules, tabStops, unnamedButtons } from './a11y-helpers';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그는 포커스를 받는 표 하나로만 흉내 낸다 (뷰 자체의 키·ARIA 는 graph-view 가 테스트한다). 터미널·홈은 그리지 않는다
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

const FOLDER = '/mock/acme-platform';
const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 폴더 탭을 등록하고 앱 전체를 그린다 (Project 도구 창 + Git 도구 창의 로그 탭) */
async function mountFolder() {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
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
  await tick();
  return { id };
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

/**
 * 지금 포커스가 있는 요소의 영역 이름 (`data-panel`). 패널 라이브러리의 칸(`data-panel="true"` — 편집기 공간의 그룹 칸
 * 등)은 영역이 아니므로 건너뛴다 (저장소 탭 테스트와 같은 규칙)
 */
const focusedPanel = () =>
  (document.activeElement as HTMLElement | null)
    ?.closest('[data-panel]:not([data-panel="true"])')
    ?.getAttribute('data-panel');

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
      repoSessions: {},
      repoSessionOpening: {},
      client: originalClient,
      toasts: [],
      dock: DEFAULT_DOCK,
      leftTool: 'project',
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('폴더 화면의 이름과 Tab 정지 (W19 ③)', () => {
  it('이름 없는 단추가 없다 — Project·Commit 도구 창, 로그·콘솔 탭 모두', async () => {
    await mountFolder();
    expect(unnamedButtons().map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
    act(() => useAppStore.getState().setLeftTool('commit'));
    await tick();
    expect(unnamedButtons().map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    expect(unnamedButtons().map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
  });

  it('모든 분할선에 이름이 있다', async () => {
    await mountFolder();
    const separators = [...document.querySelectorAll('[role="separator"]')];
    expect(separators.length).toBeGreaterThanOrEqual(4);
    expect(separators.filter((s) => !s.getAttribute('aria-label'))).toEqual([]);
  });

  it('최대화로 접힌 본문·숨긴 아래 도구 창·접힌 왼쪽 도구 창은 Tab 순서에서 빠진다', async () => {
    await mountFolder();
    const inBody = () =>
      tabStops().filter((el) => el.closest('[data-panel="project"], [data-panel="editor"]'));
    const inDock = () => tabStops().filter((el) => el.closest('[data-dock]'));
    expect(inBody().length).toBeGreaterThan(0);
    expect(inDock().length).toBeGreaterThan(0);

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

  it('큰 목록·트리·막대는 Tab 정지가 하나다 (트리·개요 표·탭 막대·왼쪽 띠·브랜치 세로 툴바)', async () => {
    await mountFolder();
    const stopsIn = (selector: string) =>
      tabStops().filter((el) => el.closest(selector) !== null).length;
    expect(stopsIn('[role="tree"]')).toBe(2); // 프로젝트 트리 + 브랜치 트리 (각각 트리 자신)
    expect(stopsIn('tbody')).toBe(1); // 개요 표의 줄
    expect(stopsIn('[role="tablist"]')).toBe(3); // 에디터 탭 막대 + Git 도구 창 탭
    expect(stopsIn(`[role="toolbar"][aria-label="${S.workspace.stripe}"]`)).toBe(1);
    expect(stopsIn(`[role="toolbar"][aria-label="${S.branches.toolbar.label}"]`)).toBe(1);
  });

  it('도구 막대의 ↑↓ 는 켜진 단추 사이를 옮기고 Tab 정지를 따라 옮긴다', async () => {
    await mountFolder();
    const bar = screen.getByRole('toolbar', { name: S.branches.toolbar.label });
    const stop = () => tabStops().filter((el) => bar.contains(el));
    const first = stop()[0] as HTMLElement;
    act(() => first.focus());
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowDown' });
    });
    expect(document.activeElement).not.toBe(first);
    expect(stop()).toEqual([document.activeElement]);
  });
});

// 트리 하나의 공용 규칙 확인(`checkTreeRules`)은 저장소 탭 브랜치 트리(W22)와 함께 쓰려고 `a11y-helpers` 로 옮겼다

describe('트리 넷의 같은 규칙 (WS-11, W19 ③)', () => {
  it('프로젝트·브랜치·Commit·변경 파일 트리: 단계·형제 수·순번, Home·↓, ⇧F10', async () => {
    const { id } = await mountFolder();
    checkTreeRules(screen.getByRole('tree', { name: S.project.tree }));
    checkTreeRules(screen.getByRole('tree', { name: S.branches.tree }));
    act(() => useAppStore.getState().setLeftTool('commit'));
    await tick();
    checkTreeRules(screen.getByRole('tree', { name: S.commitTool.tree }));
    // 로그에서 커밋을 고르면 오른쪽 칸에 변경 파일 트리가 뜬다 (로그 뷰는 흉내라 첫 행을 직접 읽는다)
    const folder = getFolderStore(id)?.getState();
    await act(async () => {
      await folder?.timeline.cache.ensureRange(0, 1);
    });
    const first = folder?.timeline.cache.slice(0, 1).rows[0];
    const repoPath = timelineRepoPath(folder?.timeline.info ?? null, first?.repo);
    expect(first && repoPath).toBeTruthy();
    await act(async () => {
      folder?.selectTimelineRow(repoPath ?? '', first?.oid ?? '');
    });
    await tick();
    await tick();
    checkTreeRules(screen.getByRole('tree', { name: S.detail.changedFiles }));
  });
});

describe('영역 단축키의 포커스 대상 (WS-11)', () => {
  it('⌘1 프로젝트 트리, ⌘2 에디터의 활성 문서, ⌘9 로그, ⌘0 Commit 트리, ⌘F 필터 칸', async () => {
    await mountFolder();
    await press('1');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(S.project.tree);

    await press('2');
    expect(focusedPanel()).toBe('editor');
    // 개요 문서의 본문(표의 줄)이 키보드를 받는다
    expect(document.activeElement?.tagName).toBe('TR');

    await press('9');
    expect(document.activeElement?.getAttribute('role')).toBe('grid');

    await press('0');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(S.commitTool.tree);

    await press('f');
    expect(document.activeElement?.hasAttribute('data-filter-text')).toBe(true);
  });

  it('focusTargetIn: 탭 패널 안 → 첫 tabindex=0 → 첫 조작 요소 → 영역 자신 (분할선은 빼고)', () => {
    const panel = document.createElement('div');
    panel.innerHTML = `
      <div role="separator" tabindex="0" id="sep"></div>
      <button id="tab" role="tab" tabindex="0">t</button>
      <div role="tabpanel"><div id="body" tabindex="0"></div></div>`;
    expect(focusTargetIn(panel).id).toBe('body');
    panel.querySelector('#body')?.remove();
    expect(focusTargetIn(panel).id).toBe('tab');
    panel.querySelector('#tab')?.remove();
    expect(focusTargetIn(panel)).toBe(panel);
    panel.insertAdjacentHTML('beforeend', '<button id="open">o</button>');
    expect(focusTargetIn(panel).id).toBe('open');
  });

  it('⌘W: 에디터에 포커스가 있으면 에디터 탭만 닫고, 닫을 탭이 없으면 폴더 탭을 닫지 않는다 (결정 7번)', async () => {
    const { id } = await mountFolder();
    const requestClose = vi.spyOn(useAppStore.getState(), 'requestCloseSession');
    await press('2');
    expect(getWorkspaceStore(id)?.getState().docs.length).toBe(1);
    await press('w');
    expect(getWorkspaceStore(id)?.getState().docs.length).toBe(0);
    expect(requestClose).not.toHaveBeenCalled();
    // 빈 에디터에서 한 번 더 눌러도 폴더 탭은 그대로다
    await press('2');
    await press('w');
    expect(requestClose).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeSessionId).toBe(id);
  });

  it('⇧Esc 로 도구 창을 숨기면 그 안에 있던 포커스가 에디터로 돌아간다', async () => {
    await mountFolder();
    await press('9');
    expect(focusedPanel()).toBe('git-log');
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape', shiftKey: true });
    });
    await tick();
    expect(useAppStore.getState().dock.tool).toBeNull();
    expect(focusedPanel()).toBe('editor');
  });
});

describe('Git 도구 창 탭 (tablist)', () => {
  it('←→ 로 옆 탭을 고르고 포커스를 옮긴다. 고른 탭만 Tab 정지이고 탭 패널과 이어진다', async () => {
    await mountFolder();
    const dock = within(screen.getByRole('region', { name: S.dock.label }));
    const log = dock.getByRole('tab', { name: S.dock.tabs.log });
    expect(log.getAttribute('tabindex')).toBe('0');
    const panel = document.getElementById(log.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    act(() => log.focus());
    act(() => {
      fireEvent.keyDown(log, { key: 'ArrowRight' });
    });
    await tick();
    // 폴더 탭의 탭 순서: 로그 → 작업 기록 → 콘솔
    expect(useAppStore.getState().dock.gitTab).toBe('history');
    const historyTab = dock.getByRole('tab', { name: S.dock.tabs.history });
    expect(document.activeElement).toBe(historyTab);
    act(() => {
      fireEvent.keyDown(historyTab, { key: 'ArrowRight' });
    });
    await tick();
    expect(useAppStore.getState().dock.gitTab).toBe('console');
    const consoleTab = dock.getByRole('tab', { name: S.dock.tabs.console });
    expect(document.activeElement).toBe(consoleTab);
    expect(consoleTab.getAttribute('tabindex')).toBe('0');
    expect(log.getAttribute('tabindex')).toBe('-1');
  });
});

describe('에디터 탭 막대 (tablist)', () => {
  const docs = [
    { id: 'a', pinned: true },
    { id: 'b', pinned: false },
    { id: 'c', pinned: true },
  ];
  /** 탭 막대를 그린다 */
  function renderTabs(activeId: string) {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorArea
        docs={docs}
        activeId={activeId}
        titleOf={(d) => `문서 ${d.id}`}
        renderDoc={(d) => <div>{d.id}</div>}
        onActivate={onActivate}
        onClose={onClose}
        onPin={() => {}}
        empty={null}
      />,
    );
    return { onActivate, onClose };
  }

  it('활성 탭만 Tab 정지이고 닫기 단추는 Tab 정지가 아니다. 활성 탭이 탭 패널을 가리킨다', () => {
    renderTabs('b');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(tabStops(screen.getByRole('tablist'))).toEqual([tabs[1]]);
    expect(tabStops()).toEqual([
      tabs[1],
      screen.getByRole('button', { name: S.workspace.editorTabs }),
    ]);
    const panel = document.getElementById(tabs[1]?.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
  });

  it('←→·Home·End 로 옆 탭을 열고 (끝에서 돈다), Delete·Backspace 로 그 탭을 닫는다', () => {
    const { onActivate, onClose } = renderTabs('b');
    const tab = screen.getByRole('tab', { name: '문서 b' });
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    fireEvent.keyDown(tab, { key: 'ArrowLeft' });
    fireEvent.keyDown(tab, { key: 'End' });
    fireEvent.keyDown(screen.getByRole('tab', { name: '문서 c' }), { key: 'ArrowRight' });
    expect(onActivate.mock.calls.map((c) => c[0])).toEqual(['c', 'a', 'c', 'a']);
    fireEvent.keyDown(tab, { key: 'Delete' });
    fireEvent.keyDown(tab, { key: 'Backspace' });
    expect(onClose.mock.calls.map((c) => c[0])).toEqual(['b', 'b']);
    // 수정키 조합은 탭 막대 몫이 아니다
    fireEvent.keyDown(tab, { key: 'ArrowRight', metaKey: true });
    expect(onActivate).toHaveBeenCalledTimes(4);
  });
});

describe('왼쪽 띠 (toolbar)', () => {
  it('Tab 정지가 하나이고 ↑↓ 로 단추 사이 포커스를 옮긴다 (끝에서 돈다). 단추는 이름과 눌림 상태를 가진다', () => {
    const tool = (id: string, active: boolean) => ({
      id,
      icon: 'project' as const,
      label: id,
      active,
      onToggle: () => {},
    });
    render(<ToolStripe top={[tool('p', true), tool('c', false)]} bottom={[tool('g', false)]} />);
    const buttons = screen.getAllByRole('button');
    expect(
      buttons.map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['p', 'true'],
      ['c', 'false'],
      ['g', 'false'],
    ]);
    expect(tabStops().length).toBe(1);
    act(() => buttons[0]?.focus());
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[0]);
    expect(tabStops()).toEqual([buttons[0]]);
  });
});

describe('콘솔 목록 (W19 ② 가 넘긴 Tab 정지 1,500개)', () => {
  /** 기록 하나 */
  const rec = (id: number, stderrTail = '') => ({
    id,
    args: ['push', `r${id}`],
    cwd: '/r',
    startedAt: 1_763_500_000_000,
    elapsedMs: 10,
    status: stderrTail ? 1 : 0,
    stderrTail,
    isWrite: true,
    cancelled: false,
  });
  const repo = { path: '/r', name: 'r', color: 1 };

  it('목록 하나가 Tab 정지 하나다. ↓↑·Home·End 로 줄을 옮기고, 줄에서 Enter 로 stderr 를 펼친다', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      record: rec(50 - i, i === 1 ? 'error: boom' : ''),
      repo,
    }));
    render(<CommandLogView rows={rows} emptyText="x" />);
    // 줄마다 단추 3개(저장소 칸·명령줄·복사)가 있어도 Tab 정지는 줄 하나다
    expect(tabStops().length).toBe(1);
    const items = () => screen.getAllByRole('listitem');
    act(() => items()[0]?.focus());
    fireEvent.keyDown(items()[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    expect(tabStops()).toEqual([items()[1]]);
    // 줄에서 Enter: stderr 펼치기 (명령줄 단추의 펼침 상태로도 알린다)
    const command = within(items()[1] as HTMLElement).getByRole('button', {
      name: /^git push/,
    });
    expect(command.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(items()[1] as HTMLElement, { key: 'Enter' });
    expect(command.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('error: boom')).toBeTruthy();
    // → 는 줄 안의 단추로, ← 는 다시 줄로
    fireEvent.keyDown(items()[1] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement?.tagName).toBe('BUTTON');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(items()[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(items()[49]);
    fireEvent.keyDown(items()[49] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('줄에서 ⌘C 로 명령줄을 복사한다', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CommandLogView rows={[{ record: rec(1), repo }]} emptyText="x" />);
    const item = screen.getByRole('listitem');
    act(() => item.focus());
    await act(async () => {
      fireEvent.keyDown(item, { key: 'c', ctrlKey: true });
    });
    expect(writeText).toHaveBeenCalledWith('git push r1');
  });
});

describe('대화상자의 포커스와 이름', () => {
  it('위험한 확인창은 취소 단추에서 시작하고, 아니면 확인 단추에서 시작한다. 제목·설명이 이름·설명이 된다', async () => {
    const props = {
      title: '정말 버릴까요',
      message: '되돌릴 수 없습니다',
      onConfirm: () => {},
      onCancel: () => {},
    };
    const { rerender } = render(<ConfirmDialog {...props} open danger confirmLabel="버리기" />);
    await tick();
    expect(document.activeElement?.textContent).toBe(S.confirm.cancel);
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      props.title,
    );
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(props.message);
    rerender(<ConfirmDialog {...props} open={false} confirmLabel="확인" />);
    await tick();
    rerender(<ConfirmDialog {...props} open confirmLabel="확인" />);
    await tick();
    expect(document.activeElement?.textContent).toBe('확인');
  });
});
