import { EditorView } from '@codemirror/view';
import {
  createNullClient,
  type FsDirListing,
  type FsEntry,
  type IpcClient,
  type SessionId,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBody } from '../App';
import { focusPanel } from '../actions';
import { executeCommand } from '../command-registry';
import { commandSourceOf } from '../features/workspace/editor-hints';
import { getWorkspaceStore, useAppStore } from '../store';
import { DEFAULT_DOCK, type SessionMeta } from '../store/app-store';
import { fileEditors } from '../store/file-editor-store';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { createWorkspaceStore, fileViewDoc } from '../store/workspace-store';
import { tick } from './dialog-stub';

// 편집기 분할 (R3): 탭 메뉴로 오른쪽에 분할하면 두 그룹이 나란히 보이고, 같은 파일은 한 편집 상태를 함께 쓴다. 지금
// 그룹(포커스가 들어간 그룹)이 열기·⌘2 의 대상이고, 마지막 탭을 닫으면 분할이 풀린다

vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: () => <div data-testid="graph-view" />,
}));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

const ID: SessionId = 81;
const ROOT = '/f';

/** 항목 하나 */
function entry(name: string): FsEntry {
  return { name, kind: 'file', size: 10, mtimeMs: 0, openable: true };
}

/** 파일 둘을 가진 폴더의 가짜 클라이언트 */
function client(): IpcClient {
  return {
    ...createNullClient(),
    fsListDir: async (): Promise<FsDirListing> => ({
      kind: 'listed',
      entries: [entry('a.txt'), entry('b.txt')],
      total: 2,
      truncated: false,
      nonUtf8Names: 0,
    }),
    fsReadEditableFile: async (_session, path) => ({
      kind: 'text',
      text: `${path}\n`,
      size: 6,
      fileKey: `key:${path}`,
      revision: 'r',
      lineEnding: 'lf',
      bom: false,
    }),
  };
}

/** 폴더 탭을 등록하고 앱 본문을 그린다 */
async function mount() {
  const fake = client();
  registerFolder(ID, createFolderStore({ session: ID, path: ROOT, repos: [] }, fake));
  registerWorkspace(ID, createWorkspaceStore('folder'));
  const meta: SessionMeta = { id: ID, kind: 'folder', path: ROOT, name: 'f', parent: null };
  act(() => {
    useAppStore.setState({
      client: fake,
      sessions: { [ID]: meta },
      sessionOrder: [ID],
      activeSessionId: ID,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
    });
  });
  render(<AppBody commands={commandSourceOf(() => [])} />);
  await tick();
}

/** 워크스페이스 상태 */
const ws = () => getWorkspaceStore(ID)?.getState();
/** 그 이름의 편집기 그룹 영역 */
const group = (label: string) => screen.getByRole('group', { name: label });
/** 그룹 안 탭 제목들 */
const tabs = (label: string) =>
  within(group(label))
    .getAllByRole('tab')
    .map((t) => t.firstChild?.textContent);
/** 그룹 안 편집기 */
const viewIn = (label: string) =>
  EditorView.findFromDOM(group(label).querySelector('.cm-editor') as HTMLElement) as EditorView;
/** 파일을 고정 탭으로 연다 */
async function open(path: string) {
  act(() =>
    ws()?.openDoc(fileViewDoc({ path, name: path, repoPath: null, repoName: null }), 'pinned'),
  );
  await tick();
  await tick();
}

const t = S.workspace.split;

beforeEach(() => localStorage.clear());

afterEach(async () => {
  cleanup();
  await fileEditors.discard();
  fileEditors.releaseSession(ID);
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      dock: DEFAULT_DOCK,
    }),
  );
  disposeFolder(ID);
  disposeWorkspace(ID);
  clearSessionRegistry();
});

describe('편집기 분할 화면 (R3)', () => {
  it('탭 메뉴의 "오른쪽으로 분할" 로 두 그룹이 나란히 보이고, 같은 파일은 한 편집 상태(초안)를 함께 쓴다', async () => {
    await mount();
    await open('a.txt');
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'a.txt' }));
    fireEvent.click(screen.getByRole('menuitem', { name: t.right }));
    await tick();
    await tick();
    expect(tabs(t.mainGroup)).toEqual([S.workspace.overview, 'a.txt']);
    expect(tabs(t.sideGroup)).toEqual(['a.txt']);
    expect(group(t.sideGroup).getAttribute('data-editor-current')).toBe('true');

    // 왼쪽에서 고친 글이 오른쪽 편집기에도 보이고, 초안은 하나다
    act(() => viewIn(t.mainGroup).dispatch({ changes: { from: 0, insert: 'X' } }));
    await tick();
    expect(viewIn(t.sideGroup).state.doc.toString()).toBe('Xa.txt\n');
    expect(fileEditors.documents(ID)).toHaveLength(1);
    expect(fileEditors.hasDirty(ID, 'a.txt')).toBe(true);
  });

  it('지금 그룹으로 열고 ⌘2 도 지금 그룹으로 간다. 오른쪽 마지막 탭을 닫으면 분할이 풀린다', async () => {
    await mount();
    await open('a.txt');
    act(() => ws()?.splitDoc('file:a.txt', 'main'));
    await tick();
    await open('b.txt');
    expect(tabs(t.sideGroup)).toEqual(['a.txt', 'b.txt']);

    // 왼쪽 그룹을 누르면 왼쪽이 지금 그룹이다 — 다음에 여는 파일은 왼쪽에
    fireEvent.pointerDown(group(t.mainGroup));
    expect(ws()?.focusedGroup).toBe('main');
    expect(group(t.mainGroup).getAttribute('data-editor-current')).toBe('true');
    act(() => focusPanel('editor'));
    expect(group(t.mainGroup).contains(document.activeElement)).toBe(true);

    // 팔레트 명령도 그 그룹에 대고 실행한다: 오른쪽 탭 b 를 왼쪽으로 옮긴다
    act(() => {
      executeCommand('editor.moveToOppositeGroup', group(t.sideGroup));
    });
    await tick();
    expect(tabs(t.mainGroup)).toContain('b.txt');
    expect(tabs(t.sideGroup)).toEqual(['a.txt']);

    // 오른쪽 마지막 탭을 닫는다 (왼쪽에도 열려 있어 확인 없이) → 한 그룹으로
    fireEvent.click(
      within(group(t.sideGroup)).getByRole('button', { name: S.workspace.closeTab('a.txt') }),
    );
    await tick();
    expect(screen.queryByRole('group', { name: t.sideGroup })).toBeNull();
    expect(ws()?.split).toBeNull();
    expect(tabs(t.mainGroup)).toEqual([S.workspace.overview, 'a.txt', 'b.txt']);
  });
});

/** 패널 하나의 flex-grow (라이브러리가 배치를 적는 값 — 크기를 모르는 jsdom 에서는 처음 배치 그대로) */
const grow = (id: string) => document.getElementById(id)?.style.flexGrow ?? null;
/** 지금 그려진 오른쪽 패널의 id (분할을 켤 때마다 바뀐다) */
const sidePanelId = () => document.querySelector<HTMLElement>('[id^="editor-side"]')?.id ?? null;

describe('분할을 켜고 풀어도 왼쪽 그룹이 다시 마운트되지 않는다 (R3 회귀)', () => {
  // 패널 라이브러리가 폭을 재서 배치를 실제로 계산하게 한다 (jsdom 은 0 이라 처음 배치를 미뤄 둔 채 그린다)
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 1000,
    });
  });
  afterAll(() => {
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
  });

  it('폴더 개요에서 연 대화상자가 분할 되살리기·풀기 뒤에도 같은 노드·입력 그대로 남는다', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: S.folder.command.button }));
    await tick();
    const dialog = [...document.querySelectorAll('dialog[open]')].find(
      (d) => d.querySelector('h2')?.textContent === S.folder.command.title,
    );
    expect(dialog).toBeTruthy();
    const input = dialog?.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'status -sb' } });

    // 재시작 뒤 저장된 분할을 되살리는 길 (R3b) — 대화상자가 열린 사이에 와도 개요는 그대로다
    const side = fileViewDoc({ path: 'b.txt', name: 'b.txt', repoPath: null, repoName: null });
    act(() => ws()?.restoreSplit([side], side.id, 30));
    await tick();
    await tick();
    expect(screen.getByRole('group', { name: t.sideGroup })).toBeTruthy();
    expect(grow('editor-main')).toBe('30');
    expect(grow(sidePanelId() ?? '')).toBe('70');
    expect(dialog?.isConnected).toBe(true);
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('status -sb');

    // 오른쪽 마지막 탭을 닫아 분할이 풀린다 (왼쪽이 보던 개요는 그대로 — "분할 해제"는 오른쪽 탭을 왼쪽에서 보이므로 쓰지 않는다)
    act(() => ws()?.closeSideDoc(side.id));
    await tick();
    expect(screen.queryByRole('group', { name: t.sideGroup })).toBeNull();
    expect(ws()?.split).toBeNull();
    expect(dialog?.isConnected).toBe(true);
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(input.value).toBe('status -sb');
  });

  it('왼쪽 편집기 뷰가 분할을 켜고 풀어도 다시 만들어지지 않고, 폭은 풀면 왼쪽 전체·다시 켜면 저장된 폭이다', async () => {
    await mount();
    await open('a.txt');
    const view = viewIn(t.mainGroup);
    act(() => view.dispatch({ selection: { anchor: 3 } }));

    act(() => ws()?.splitDoc('file:a.txt', 'main'));
    await tick();
    expect(tabs(t.sideGroup)).toEqual(['a.txt']);
    expect(viewIn(t.mainGroup)).toBe(view);
    expect(view.state.selection.main.head).toBe(3);
    expect(grow('editor-main')).toBe('50');
    expect(grow(sidePanelId() ?? '')).toBe('50');

    // 저장된 폭(경계를 옮기면 바뀌는 값)은 풀었다 다시 켜면 그대로 적용된다 — 라이브러리가 기억한 앞 배치(50)가 아니다
    act(() => ws()?.setSplitRatio(30));
    act(() => ws()?.unsplit());
    await tick();
    expect(sidePanelId()).toBeNull();
    expect(viewIn(t.mainGroup)).toBe(view);
    expect(grow('editor-main')).toBe('100');

    act(() => ws()?.splitDoc('file:a.txt', 'main'));
    await tick();
    expect(viewIn(t.mainGroup)).toBe(view);
    expect(view.state.selection.main.head).toBe(3);
    expect(grow('editor-main')).toBe('30');
    expect(grow(sidePanelId() ?? '')).toBe('70');
  });

  it('다시 분할하면 라이브러리가 기억한 앞 배치가 아니라 그 탭의 저장된 폭으로 나눈다', async () => {
    await mount();
    const side = fileViewDoc({ path: 'b.txt', name: 'b.txt', repoPath: null, repoName: null });
    act(() => ws()?.restoreSplit([side], side.id, 30));
    await tick();
    // 경계를 키보드로 옮기면 라이브러리가 그 배치를 이 패널 묶음의 것으로 기억한다
    fireEvent.keyDown(screen.getByRole('separator', { name: t.resize }), { key: 'ArrowRight' });
    await tick();
    expect(ws()?.splitRatio).toBeGreaterThan(30);
    // 저장된 폭이 따로 바뀐 뒤(예: 범위로 맞춘 값) 분할을 풀었다 다시 켠다
    act(() => ws()?.setSplitRatio(60));
    act(() => ws()?.closeSideDoc(side.id));
    await tick();
    expect(grow('editor-main')).toBe('100');
    act(() => ws()?.restoreSplit([side], side.id, null));
    await tick();
    expect(grow('editor-main')).toBe('60');
    expect(grow(sidePanelId() ?? '')).toBe('40');
  });

  it('분할한 두 폴더 탭을 오가면 탭마다 저장된 폭으로 나뉜다 (재시작 뒤 되살린 폭 R3b)', async () => {
    const ID2: SessionId = 82;
    await mount();
    registerFolder(ID2, createFolderStore({ session: ID2, path: '/g', repos: [] }, client()));
    registerWorkspace(ID2, createWorkspaceStore('folder'));
    const meta2: SessionMeta = { id: ID2, kind: 'folder', path: '/g', name: 'g', parent: null };
    const side = fileViewDoc({ path: 'b.txt', name: 'b.txt', repoPath: null, repoName: null });
    act(() => {
      useAppStore.setState({
        sessions: { ...useAppStore.getState().sessions, [ID2]: meta2 },
        sessionOrder: [ID, ID2],
      });
      ws()?.restoreSplit([side], side.id, 30);
      getWorkspaceStore(ID2)?.getState().restoreSplit([side], side.id, 70);
    });
    await tick();
    expect(grow('editor-main')).toBe('30');
    // 경계를 키보드로 옮긴다 (사용자 조작 — 라이브러리가 이 배치를 기억하고 탭의 폭으로 저장한다)
    fireEvent.keyDown(screen.getByRole('separator', { name: t.resize }), { key: 'ArrowRight' });
    await tick();
    const moved = ws()?.splitRatio ?? 0;
    expect(moved).toBeGreaterThan(30);
    expect(Number(grow('editor-main'))).toBeCloseTo(moved);

    act(() => useAppStore.setState({ activeSessionId: ID2 }));
    await tick();
    expect(grow('editor-main')).toBe('70');
    expect(grow(sidePanelId() ?? '')).toBe('30');

    act(() => useAppStore.setState({ activeSessionId: ID }));
    await tick();
    expect(Number(grow('editor-main'))).toBeCloseTo(moved);
    disposeFolder(ID2);
    disposeWorkspace(ID2);
  });
});
