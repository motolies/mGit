// 창 포커스 복귀 한 번에 나가는 IPC 호출 수 (반응성 G4, R9). 앱 전체를 그린 뒤(폴더 탭·저장소 탭 각각, 보이는 파일 하나와
// 뒤 탭의 파일 하나를 연 채) 포커스 이벤트를 보내고, 목 클라이언트를 감싼 계수기로 메서드별 호출 수를 센다
import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type IpcClient, type SessionId } from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { installFileEditorLifecycle } from '../file-editor-lifecycle';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import { fileEditors } from '../store/file-editor-store';
import { focusRefreshers } from '../store/focus-refresh';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  // 앱 시작(bootstrap)처럼 편집기 수명주기를 한 번 건다 (창 포커스의 열린 파일 재검사)
  await installFileEditorLifecycle(false);
});

const REPO = '/mock/storefront-web';
const FOLDER = '/mock/acme-platform';
const ROWS = 30;
const originalClient = useAppStore.getState().client;
let sessions: SessionId[] = [];

/** 메서드별 호출 수를 세는 클라이언트 (목 클라이언트를 감싼다). `overrides` 의 메서드는 그것으로 바꿔 부른다 */
function counting(mock: IpcClient, overrides: Partial<IpcClient> = {}) {
  const calls: Record<string, number> = {};
  const client = new Proxy(mock, {
    get(target, key, receiver) {
      const value =
        typeof key === 'string' && key in overrides
          ? overrides[key as keyof IpcClient]
          : Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || typeof key !== 'string') return value;
      return (...args: unknown[]) => {
        calls[key] = (calls[key] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { client, calls };
}

/** 읽기가 끝날 때까지 몇 박자 기다린다 */
async function settle() {
  for (let i = 0; i < 8; i++) await tick();
}

/** 파일 탭 둘을 연다: 앞의 것은 뒤 탭, 나중 것이 보이는 탭 */
async function openFiles(id: SessionId, paths: [string, string], repoPath: string) {
  for (const path of paths) {
    act(() =>
      getWorkspaceStore(id)
        ?.getState()
        .openDoc(
          { id: `file:${path}`, kind: 'file', path, name: path, repoPath, repoName: 'r' },
          'pinned',
        ),
    );
    await settle();
  }
  await fileEditors.settleOpening();
  await settle();
}

/** 폴더 탭을 열고 앱을 그린다 */
async function mountFolder() {
  const mock = createMockClient({ rows: ROWS, scene: 'folder', progressIntervalMs: 0 });
  const { client, calls } = counting(mock);
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  sessions.push(id);
  registerFolder(id, createFolderStore(opened, client));
  registerWorkspace(id, createWorkspaceStore('folder'));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  render(<App />);
  await settle();
  await openFiles(id, ['.editorconfig', '.vscode/settings.json'], FOLDER);
  return { id, calls };
}

/** 저장소 탭을 열고 앱을 그린다 */
async function mountRepo(overrides: Partial<IpcClient> = {}) {
  const mock = createMockClient({ rows: ROWS, scene: 'repo', progressIntervalMs: 0 });
  const { client, calls } = counting(mock, overrides);
  const opened = await mock.openRepo(REPO, () => {});
  const id = opened.session;
  sessions.push(id);
  const cache = new GraphRangeCache({ fetchWindow: (s, n) => mock.graphWindow(id, s, n) });
  cache.setTotalRows(ROWS, true);
  const store = createSessionStore(
    opened,
    client,
    cache,
    sessionRevealHooks(useAppStore.getState, id),
  );
  store.setState({ loadState: 'complete', totalRows: ROWS });
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path: REPO, name: 'r', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client,
    }),
  );
  render(<App />);
  await settle();
  await openFiles(id, ['package.json', 'README.md'], REPO);
  return { id, calls };
}

// 조율기의 시계(`performance.now()`)를 앞당긴다: 앱을 열며 읽은 직후라 건너뛰는 것을 피해, 다른 앱에 다녀온 만큼 시간이
// 흐른 포커스를 흉내 낸다 (실제 타이머는 그대로 둔다)
const realNow = performance.now.bind(performance);
let shifted = 0;

/** 계수기를 비우고 창 포커스를 보낸 뒤 나간 호출을 메서드별로 돌려준다. `away` 만큼 시간이 흐른 뒤의 포커스다 */
async function focusOnce(calls: Record<string, number>, away = 0) {
  shifted += away;
  for (const key of Object.keys(calls)) delete calls[key];
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await settle();
  return { ...calls };
}

/** 호출 수 합 */
const total = (calls: Record<string, number>) =>
  Object.values(calls).reduce((sum, n) => sum + n, 0);

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  shifted = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + shifted);
});

afterEach(async () => {
  cleanup();
  removeDialogStub();
  await fileEditors.discard();
  for (const id of sessions) fileEditors.release(id);
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      client: originalClient,
      toasts: [],
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  for (const id of sessions) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  sessions = [];
  clearSessionRegistry();
  vi.restoreAllMocks();
});

describe('창 포커스 한 번의 IPC', () => {
  it('폴더 탭', async () => {
    const { calls } = await mountFolder();
    // 처음 포커스는 표지를 처음 받는 차례라 원문 읽기가 더 많다. 그다음(1분 뒤)이 여느 때의 포커스다
    const first = await focusOnce(calls, 60_000);
    const steady = await focusOnce(calls, 60_000);
    const again = await focusOnce(calls);
    console.info('G4 folder focus', JSON.stringify({ first, steady, again }));
    expect(total(steady)).toBeGreaterThan(0);
  });

  it('저장소 탭', async () => {
    const { calls } = await mountRepo();
    // 처음 포커스는 표지를 처음 받는 차례라 원문 읽기가 더 많다. 그다음(1분 뒤)이 여느 때의 포커스다
    const first = await focusOnce(calls, 60_000);
    const steady = await focusOnce(calls, 60_000);
    const again = await focusOnce(calls);
    console.info('G4 repo focus', JSON.stringify({ first, steady, again }));
    expect(total(steady)).toBeGreaterThan(0);
  });

  it('클립보드는 잘라내기 표시가 있을 때만 포커스에 다시 읽는다 (바깥에서 클립보드를 바꿨으면 표시를 지운다)', async () => {
    // 처음 그릴 때는 이 트리가 잘라 둔 파일이 클립보드에 있고, 다른 앱에 다녀오는 동안 Finder 가 클립보드를 바꾼다
    let cut = true;
    const fsClipboardRead = vi.fn(async () =>
      cut ? { count: 1, paths: [`${REPO}/package.json`], token: 't', cut: true } : null,
    );
    const { calls } = await mountRepo({ fsClipboardRead });
    expect(fsClipboardRead).toHaveBeenCalledTimes(1);
    cut = false;
    const marked = await focusOnce(calls, 60_000);
    expect(marked.fsClipboardRead).toBe(1);
    // 표시가 지워졌으니 다음 포커스는 읽지 않는다
    const cleared = await focusOnce(calls, 60_000);
    expect(cleared.fsClipboardRead).toBeUndefined();
  });

  it('탭을 내리면 화면 쪽 듣는 쪽이 조율기에서 빠진다 (편집기 수명주기만 남는다)', async () => {
    await mountFolder();
    expect(focusRefreshers().length).toBeGreaterThan(2);
    cleanup();
    expect(focusRefreshers().sort()).toEqual(['editor:hidden', 'editor:shown']);
  });
});
