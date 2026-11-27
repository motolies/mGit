// 앱 루트 재렌더의 번짐 (G2, R5·G8): 세션·폴더 상태가 바뀌어도 동작 목록의 활성 여부가 그대로면 앱 루트가 다시 그려지지
// 않거나, 그려져도 로그 칸·워크스페이스로 번지지 않는다. 동작은 실행할 때의 최신 상태에 대고 돈다.
// 렌더 수는 모듈을 감싼 계수기로 센다 — 감싼 쪽은 부모가 다시 그릴 때만 다시 그려지므로(안쪽 구독은 진짜 컴포넌트 몫) 위에서
// 번져 내려온 재렌더만 센다. `root` 는 앱 루트(`App`)가 직접 그리는 팔레트로 센 루트 재렌더 수다
import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
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

const renders = vi.hoisted(() => ({
  /** 앱 루트가 다시 그린 횟수 (루트가 직접 그리는 팔레트의 대리값) */
  root: 0,
  toolbar: 0,
  repoWorkspace: 0,
  folderWorkspace: 0,
  repoLog: 0,
  folderLog: 0,
  /** 그래프 칸(`GraphPane`)이 그린 횟수 — 그래프 칸이 그릴 때마다 새 props 로 그리는 `GraphView` 목으로 센다 (D-3) */
  graph: 0,
}));
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => {
    renders.graph += 1;
    return <div data-testid="graph-view" />;
  },
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));
vi.mock('../features/palette/CommandPalette', async (orig) => {
  const mod = await orig<typeof import('../features/palette/CommandPalette')>();
  return {
    ...mod,
    CommandPalette: (props: Parameters<typeof mod.CommandPalette>[0]) => {
      renders.root += 1;
      return <mod.CommandPalette {...props} />;
    },
  };
});
vi.mock('../layout/Toolbar', async (orig) => {
  const mod = await orig<typeof import('../layout/Toolbar')>();
  return {
    ...mod,
    Toolbar: () => {
      renders.toolbar += 1;
      return <mod.Toolbar />;
    },
  };
});
vi.mock('../features/workspace/RepoWorkspace', async (orig) => {
  const mod = await orig<typeof import('../features/workspace/RepoWorkspace')>();
  return {
    ...mod,
    RepoWorkspace: (props: Parameters<typeof mod.RepoWorkspace>[0]) => {
      renders.repoWorkspace += 1;
      return <mod.RepoWorkspace {...props} />;
    },
  };
});
vi.mock('../features/workspace/FolderWorkspace', async (orig) => {
  const mod = await orig<typeof import('../features/workspace/FolderWorkspace')>();
  return {
    ...mod,
    FolderWorkspace: (props: Parameters<typeof mod.FolderWorkspace>[0]) => {
      renders.folderWorkspace += 1;
      return <mod.FolderWorkspace {...props} />;
    },
  };
});
vi.mock('../features/workspace/RepoGitLog', async (orig) => {
  const mod = await orig<typeof import('../features/workspace/RepoGitLog')>();
  return {
    ...mod,
    RepoGitLog: () => {
      renders.repoLog += 1;
      return <mod.RepoGitLog />;
    },
  };
});
vi.mock('../features/folder/FolderTimeline', async (orig) => {
  const mod = await orig<typeof import('../features/folder/FolderTimeline')>();
  return {
    ...mod,
    FolderTimeline: () => {
      renders.folderLog += 1;
      return <mod.FolderTimeline />;
    },
  };
});

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
  // 팔레트(cmdk)가 고른 항목을 보이게 할 때 부른다 (jsdom 에 없다)
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const REPO = '/mock/storefront-web';
const FOLDER = '/mock/acme-platform';
const AUTH = `${FOLDER}/auth-service`;
const WEB = `${FOLDER}/web-console`;
const ROWS = 30;
const LOG_DOCK = { tool: 'git', maximized: false, gitTab: 'log' } as const;
const originalClient = useAppStore.getState().client;
let repos: SessionId[] = [];
let folders: SessionId[] = [];

/** 저장소 세션 하나를 만들어 등록한다 (탭으로 열지는 않는다). 같은 목 클라이언트로 열어야 세션 id 가 겹치지 않는다 */
async function repoSession(mock: ReturnType<typeof createMockClient>, path: string) {
  const opened = await mock.openRepo(path, () => {});
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
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  return { id, mock, store };
}

/** 저장소 탭(들)을 열고 앱 전체를 그린다. 첫 탭이 활성이다 */
async function mountRepos(paths: string[]) {
  const mock = createMockClient({ rows: ROWS, scene: 'repo', progressIntervalMs: 0 });
  const opened: Awaited<ReturnType<typeof repoSession>>[] = [];
  for (const path of paths) opened.push(await repoSession(mock, path));
  const first = opened[0];
  if (!first) throw new Error('탭 없음');
  act(() =>
    useAppStore.setState({
      sessions: Object.fromEntries(
        opened.map((o, i) => [
          o.id,
          { id: o.id, kind: 'repo' as const, path: paths[i] ?? '', name: `r${i}`, parent: null },
        ]),
      ),
      sessionOrder: opened.map((o) => o.id),
      activeSessionId: first.id,
      dock: LOG_DOCK,
      leftTool: 'project',
      client: first.mock,
    }),
  );
  render(<App />);
  await settle();
  return opened;
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
      dock: LOG_DOCK,
      leftTool: 'project',
      client: mock,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  render(<App />);
  await settle();
  return { id, mock };
}

/** 읽기가 끝날 때까지 몇 박자 기다린다 */
async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
  }
}

/** 계수기를 0 으로 하고 `change` 뒤에 센 렌더 수를 돌려준다 */
async function count(change: () => void) {
  for (const key of Object.keys(renders) as (keyof typeof renders)[]) renders[key] = 0;
  act(change);
  await settle();
  return { ...renders };
}

/** 주 수정키를 누른 단축키 (macOS ⌘, 그 밖 Ctrl) */
const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  for (const key of Object.keys(renders) as (keyof typeof renders)[]) renders[key] = 0;
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
      repoSessions: {},
      repoSessionOpening: {},
      paletteOpen: false,
    }),
  );
  for (const id of [...repos, ...folders]) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  repos = [];
  folders = [];
  clearSessionRegistry();
});

describe('저장소 탭', () => {
  it('status·refs·되돌리기 상태가 새 객체로 와도 동작의 활성 여부가 같으면 루트·워크스페이스·로그가 다시 그려지지 않는다', async () => {
    const [repo] = await mountRepos([REPO]);
    if (!repo) throw new Error('세션 없음');
    const st = () => repo.store.getState();
    const status = await count(() => repo.store.setState({ status: { ...st().status } }));
    const refs = await count(() =>
      repo.store.setState({ refs: { ...st().refs, labels: [...st().refs.labels] } }),
    );
    const undo = await count(() => repo.store.setState({ undoState: { ...st().undoState } }));
    console.info('G2 repo status/refs/undo', JSON.stringify({ status, refs, undo }));
    for (const seen of [status, refs, undo]) {
      expect(seen).toMatchObject({ toolbar: 0, repoWorkspace: 0, repoLog: 0 });
    }
  });

  it('쓰기 동작의 시작·끝(busy)이 바뀌면 단축키와 팔레트의 활성 표시가 바로 따라간다', async () => {
    const [repo] = await mountRepos([REPO]);
    if (!repo) throw new Error('세션 없음');
    const fetch = vi.fn(async () => {});
    act(() => repo.store.setState({ fetch, busy: true }));
    await settle();
    fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, ...MOD });
    expect(fetch).not.toHaveBeenCalled();
    act(() => useAppStore.getState().setPaletteOpen(true));
    await settle();
    /** 팔레트의 Fetch 항목 */
    const fetchItem = () =>
      screen.getAllByRole('option').find((o) => o.textContent?.startsWith(S.actions.fetch));
    expect(fetchItem()?.getAttribute('aria-disabled')).toBe('true');
    act(() => repo.store.setState({ busy: false }));
    await settle();
    expect(fetchItem()?.getAttribute('aria-disabled')).toBe('false');
    act(() => useAppStore.getState().setPaletteOpen(false));
    await settle();
    fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, ...MOD });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('쓰기 동작의 시작·끝(busy)과 dock 토글에 워크스페이스·로그 칸·그래프가 다시 그려지지 않는다 (D-3)', async () => {
    const [repo] = await mountRepos([REPO]);
    if (!repo) throw new Error('세션 없음');
    const start = await count(() => repo.store.setState({ busy: true }));
    const end = await count(() => repo.store.setState({ busy: false }));
    console.info('D-3 repo busy', JSON.stringify({ start, end }));
    for (const seen of [start, end]) {
      // 툴바는 단추의 활성 표시가 바뀌므로 다시 그린다 (스스로 구독 — 위에서 번진 것이 아니다)
      expect(seen).toMatchObject({ repoWorkspace: 0, repoLog: 0, graph: 0 });
    }
    const hide = await count(() => useAppStore.getState().toggleDock('git'));
    expect(useAppStore.getState().dock.tool).toBeNull();
    expect(hide.repoWorkspace).toBe(0);
  });

  it('busy 가 꺼진 바로 그 순간의 단축키도 켜진 동작으로 돈다 (낡은 동작 목록을 쓰지 않는다)', async () => {
    const [repo] = await mountRepos([REPO]);
    if (!repo) throw new Error('세션 없음');
    const fetch = vi.fn(async () => {});
    act(() => repo.store.setState({ fetch, busy: true }));
    await settle();
    fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, ...MOD });
    expect(fetch).not.toHaveBeenCalled();
    // 기다리지 않고 바로 누른다
    act(() => repo.store.setState({ busy: false }));
    fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, ...MOD });
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => repo.store.setState({ busy: true }));
    fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, ...MOD });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('탭을 바꾼 직후의 단축키는 새 탭의 저장소에 대고 돈다', async () => {
    const [first, second] = await mountRepos([REPO, '/mock/other-repo']);
    if (!first || !second) throw new Error('세션 없음');
    expect(first.id).not.toBe(second.id);
    const fetchFirst = vi.fn(async () => {});
    const fetchSecond = vi.fn(async () => {});
    act(() => {
      first.store.setState({ fetch: fetchFirst });
      second.store.setState({ fetch: fetchSecond });
      useAppStore.getState().setActiveSession(second.id);
    });
    fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, ...MOD });
    expect(fetchSecond).toHaveBeenCalledTimes(1);
    expect(fetchFirst).not.toHaveBeenCalled();
  });
});

describe('폴더 탭', () => {
  it('활성 저장소(범위 세션)가 바뀌어도 루트·워크스페이스·로그가 다시 그려지지 않는다', async () => {
    const { id } = await mountFolder();
    const ws = () => getWorkspaceStore(id)?.getState();
    const first = await count(() => ws()?.setActiveRepo(AUTH));
    const second = await count(() => ws()?.setActiveRepo(WEB));
    console.info('G2 folder activeRepo', JSON.stringify({ first, second }));
    for (const seen of [first, second]) {
      expect(seen).toMatchObject({ toolbar: 0, folderWorkspace: 0, folderLog: 0 });
    }
  });

  it('Project 트리에서 고른 항목이 바뀌어도 루트·로그가 다시 그려지지 않는다', async () => {
    const { id } = await mountFolder();
    const tree = () => getFolderStore(id)?.getState().fileTree.getState();
    const first = await count(() => tree()?.select('auth-service'));
    const second = await count(() => tree()?.select('web-console'));
    console.info('G2 folder selection', JSON.stringify({ first, second }));
    for (const seen of [first, second]) {
      expect(seen).toMatchObject({ toolbar: 0, folderLog: 0 });
    }
  });

  it('폴더 요약을 다시 읽어도(내용이 같아도 달라도) 루트·워크스페이스·로그로 번지지 않는다', async () => {
    const { id } = await mountFolder();
    const folder = () => getFolderStore(id);
    const same = await count(() =>
      folder()?.setState({ summaries: [...(folder()?.getState().summaries ?? [])] }),
    );
    const changed = await count(() =>
      folder()?.setState({
        summaries: (folder()?.getState().summaries ?? []).map((s, i) =>
          i === 0 ? { ...s, changed: s.changed + 1 } : s,
        ),
      }),
    );
    console.info('G2 folder summaries', JSON.stringify({ same, changed }));
    for (const seen of [same, changed]) {
      expect(seen).toMatchObject({ toolbar: 0, folderWorkspace: 0, folderLog: 0 });
    }
  });
});
