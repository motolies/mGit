import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoSummary,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBody } from '../App';
import type { Action } from '../actions';
import { EditorArea, EditorEmptyState } from '../features/workspace/EditorArea';
import { getFolderStore, useAppStore } from '../store';
import {
  createRepoWorkspace,
  DEFAULT_DOCK,
  type DockState,
  type SessionMeta,
} from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  getWorkspaceStore,
  registerFolder,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { createWorkspaceStore } from '../store/workspace-store';
import { tick } from './dialog-stub';

const h = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('@mgit/terminal', () => ({
  /** 마운트 수만 세는 터미널 */
  TerminalView: () => {
    useEffect(() => {
      h.mounts += 1;
      return () => {
        h.unmounts += 1;
      };
    }, []);
    return <div data-testid="term" />;
  },
}));

// 저장소 탭이 새 틀(W21)에 옮겨 싣는 옛 화면은 이 테스트의 관심이 아니다: 자리만 채운다 (어느 칸에 실렸는지만 본다).
// 옛 사이드바는 W25 에서 비어 어디서도 그리지 않으므로 목도 없다 (왼쪽 칸은 브랜치 트리뿐이다)
vi.mock('../features/graph/GraphPane', async (orig) => ({
  ...(await orig<typeof import('../features/graph/GraphPane')>()),
  GraphPane: () => <div data-testid="old-graph" />,
}));
vi.mock('../features/changes/ChangesPanel', () => ({
  ChangesPanel: () => <div data-testid="old-changes" />,
}));
vi.mock('../features/home/HomeScreen', () => ({
  HomeScreen: () => <div data-testid="home" />,
}));

beforeAll(() => {
  // 프로젝트 트리의 가상 스크롤이 보이는 높이를 알도록 (jsdom 은 배치를 계산하지 않는다)
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
});

const FOLDER_ID = 11;
const REPO_ID = 12;
const ROOT = '/work/acme';

/** 요약 한 줄 */
function summary(partial: Partial<RepoSummary> & { name: string }): RepoSummary {
  return {
    path: `${ROOT}/${partial.name}`,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
    ...partial,
  };
}

const SUMMARIES = [
  summary({ name: 'api', branch: 'development', ahead: 0, behind: 54 }),
  summary({ name: 'web', branch: 'feature/x', ahead: 3, behind: 0, changed: 2 }),
];

/**
 * 폴더 장면의 가짜 클라이언트. 타임라인 열기 호출을 센다. 파일 트리의 루트에는 저장소 디렉터리 둘만 있다
 * (W3 간이 트리와 같은 행 수가 나오게)
 */
function folderClient() {
  const base = createNullClient();
  const folderTimelineOpen = vi.fn(base.folderTimelineOpen);
  const client: IpcClient = {
    ...base,
    folderSummaries: async () => SUMMARIES,
    folderTimelineOpen,
    fsListDir: async (_session, dir) => ({
      kind: 'listed',
      entries:
        dir === ''
          ? SUMMARIES.map((s) => ({
              name: s.name,
              kind: 'dir' as const,
              size: null,
              mtimeMs: null,
              openable: false,
            }))
          : [],
      total: dir === '' ? SUMMARIES.length : 0,
      truncated: false,
      nonUtf8Names: 0,
    }),
  };
  return { client, folderTimelineOpen };
}

const FOLDER_META: SessionMeta = {
  id: FOLDER_ID,
  kind: 'folder',
  path: ROOT,
  name: 'acme',
  parent: null,
};
const REPO_META: SessionMeta = {
  id: REPO_ID,
  kind: 'repo',
  path: `${ROOT}/api`,
  name: 'api',
  parent: FOLDER_ID,
};

/** 폴더 탭의 스토어들을 등록한다 (앱 스토어의 `openFolderAt` 이 하는 일) */
function registerFolderTab(client: IpcClient): void {
  registerFolder(
    FOLDER_ID,
    createFolderStore(
      {
        session: FOLDER_ID,
        path: ROOT,
        repos: SUMMARIES.map((s) => ({ path: s.path, kind: s.kind })),
      },
      client,
    ),
  );
  registerWorkspace(FOLDER_ID, createWorkspaceStore('folder'));
}

/** 저장소 탭의 세션 스토어를 등록한다 */
function registerRepoTab(): void {
  const head = { state: 'unborn' as const, branch: 'main' };
  const cache = new GraphRangeCache({
    fetchWindow: () => Promise.reject(new Error('no session')),
  });
  const store = createSessionStore(
    {
      session: REPO_ID,
      alreadyOpen: false,
      nestedRepos: [],
      superproject: null,
      info: {
        workTree: REPO_META.path,
        gitDir: `${REPO_META.path}/.git`,
        commonDir: `${REPO_META.path}/.git`,
        objectFormat: 'sha1',
        head,
        commitGraph: { present: false },
        shallow: false,
      },
      state: emptyRepoState(head),
    },
    createNullClient(),
    cache,
  );
  registerSession(REPO_ID, { cache, store });
  // W21: 저장소 탭도 워크스페이스(에디터 공간)를 갖는다 (앱 스토어의 `openRepositoryAt` 과 같다)
  registerWorkspace(REPO_ID, createRepoWorkspace(REPO_ID, useAppStore.getState));
}

/** 열린 탭과 활성 탭, 도구 창 상태를 앱 스토어에 넣는다 */
function setTabs(
  metas: SessionMeta[],
  active: number | null,
  state: { dock?: DockState; leftTool?: 'project' | null } = {},
): void {
  act(() => {
    useAppStore.setState({
      sessions: Object.fromEntries(metas.map((m) => [m.id, m])),
      sessionOrder: metas.map((m) => m.id),
      activeSessionId: active,
      dock: state.dock ?? DEFAULT_DOCK,
      leftTool: state.leftTool === undefined ? 'project' : state.leftTool,
    });
  });
}

/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
/** 왼쪽 띠 */
const stripe = () => screen.queryByRole('toolbar', { name: S.workspace.stripe });
/** 띠의 버튼별 눌림 상태 */
const pressed = () =>
  Object.fromEntries(
    within(stripe() as HTMLElement)
      .getAllByRole('button')
      .map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
  );

const ACTIONS: Action[] = [
  {
    id: 'view.focusSidebar',
    title: S.actions.focusSidebar,
    group: 'view',
    shortcut: 'f6',
    enabled: true,
    run: () => {},
  },
  { id: 'view.terminal', title: S.actions.terminal, group: 'view', enabled: true, run: () => {} },
];

beforeEach(() => {
  localStorage.clear();
  h.mounts = 0;
  h.unmounts = 0;
});

afterEach(() => {
  cleanup();
  setTabs([], null);
  act(() => useAppStore.setState({ terminals: [], activeTerminal: null }));
  disposeFolder(FOLDER_ID);
  disposeWorkspace(FOLDER_ID);
  disposeWorkspace(REPO_ID);
  clearSessionRegistry();
});

describe('앱 본문의 화면 틀 (WS-01·05)', () => {
  it('폴더 탭에서는 띠·Project·에디터·Git 로그 영역이 동시에 마운트된다', async () => {
    const { client, folderTimelineOpen } = folderClient();
    registerFolderTab(client);
    setTabs([FOLDER_META], FOLDER_ID);
    render(<AppBody actions={ACTIONS} />);
    await tick();

    // 위 묶음: Project·Commit(W14, 같은 자리에 번갈아), 아래 묶음: Git·터미널
    expect(pressed()).toEqual({
      [S.project.title]: 'true',
      [S.commitTool.title]: 'false',
      [S.dock.git]: 'true',
      [S.terminal.title]: 'false',
    });
    for (const name of ['project', 'editor', 'git-branches', 'git-log']) {
      expect(area(name), name).not.toBeNull();
    }
    // 옛 3단 배치는 그리지 않는다
    expect(area('sidebar')).toBeNull();
    expect(area('center')).toBeNull();

    // Project 도구 창: 루트 + 루트 아래 항목(여기서는 저장소 디렉터리 둘), 저장소 행에 요약 장식
    const tree = within(area('project') as HTMLElement).getByRole('tree', { name: S.project.tree });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1 + SUMMARIES.length);
    expect(within(tree).getByText('54↓')).toBeTruthy();
    expect(within(tree).getByText('3↑')).toBeTruthy();

    // 에디터 공간: 개요 탭이 기본으로 열려 있고 요약 표가 보인다 (ED-07)
    const editor = within(area('editor') as HTMLElement);
    expect(
      editor.getByRole('tab', { name: S.workspace.overview }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(editor.getAllByRole('row')).toHaveLength(1 + SUMMARIES.length);

    // Git 도구 창: [로그][작업 기록][콘솔], 로그 탭이 골라져 있고 타임라인을 한 번 열었다 (PF-04)
    const dock = within(screen.getByRole('region', { name: S.dock.label }));
    expect(dock.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      S.dock.tabs.log,
      S.dock.tabs.history,
      S.dock.tabs.console,
    ]);
    expect(dock.getByRole('tab', { name: S.dock.tabs.log }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(folderTimelineOpen).toHaveBeenCalledTimes(1);
    expect(folderTimelineOpen).toHaveBeenCalledWith(FOLDER_ID);
  });

  it('통합 타임라인은 로그 탭이 처음 보일 때 연다: 숨김·콘솔 탭에서는 열지 않는다 (PF-04)', async () => {
    const { client, folderTimelineOpen } = folderClient();
    registerFolderTab(client);
    setTabs([FOLDER_META], FOLDER_ID, { dock: { tool: null, maximized: false, gitTab: 'log' } });
    render(<AppBody actions={ACTIONS} />);
    await tick();
    expect(area('git-log')).toBeNull();
    expect(area('project')).not.toBeNull();
    expect(folderTimelineOpen).not.toHaveBeenCalled();

    act(() => useAppStore.getState().toggleDock('git', 'console'));
    await tick();
    expect(area('git-log')).toBeNull();
    expect(folderTimelineOpen).not.toHaveBeenCalled();

    act(() => useAppStore.getState().setGitDockTab('log'));
    await tick();
    expect(area('git-log')).not.toBeNull();
    expect(folderTimelineOpen).toHaveBeenCalledTimes(1);

    // 탭을 오가며 다시 마운트돼도 다시 열지 않는다
    act(() => useAppStore.getState().setGitDockTab('console'));
    act(() => useAppStore.getState().setGitDockTab('log'));
    await tick();
    expect(folderTimelineOpen).toHaveBeenCalledTimes(1);
  });

  it('띠 버튼이 Project·Git·터미널 도구 창을 여닫는다', async () => {
    registerFolderTab(folderClient().client);
    setTabs([FOLDER_META], FOLDER_ID);
    render(<AppBody actions={ACTIONS} />);
    await tick();
    const button = (name: string) => within(stripe() as HTMLElement).getByRole('button', { name });

    act(() => fireEvent.click(button(S.project.title)));
    expect(useAppStore.getState().leftTool).toBeNull();
    expect(pressed()[S.project.title]).toBe('false');
    // 접힌 도구 창은 DOM 에 남되 포커스·보조 기술에서 빠진다
    expect(area('project')?.hasAttribute('inert')).toBe(true);
    act(() => fireEvent.click(button(S.project.title)));
    expect(useAppStore.getState().leftTool).toBe('project');
    expect(area('project')?.hasAttribute('inert')).toBe(false);

    act(() => fireEvent.click(button(S.dock.git)));
    expect(useAppStore.getState().dock.tool).toBeNull();
    expect(pressed()[S.dock.git]).toBe('false');
    act(() => fireEvent.click(button(S.dock.git)));
    // 고른 탭(로그)은 기억한 채 다시 보인다
    expect(useAppStore.getState().dock).toMatchObject({ tool: 'git', gitTab: 'log' });

    act(() => fireEvent.click(button(S.terminal.title)));
    expect(useAppStore.getState().dock.tool).toBe('terminal');
    expect(pressed()).toMatchObject({ [S.dock.git]: 'false', [S.terminal.title]: 'true' });
  });

  it('개요 탭을 닫으면 단축키 안내와 "개요 열기" 가 나오고, 누르면 개요가 돌아온다 (ED-07)', async () => {
    registerFolderTab(folderClient().client);
    setTabs([FOLDER_META], FOLDER_ID);
    render(<AppBody actions={ACTIONS} />);
    await tick();
    const editor = within(area('editor') as HTMLElement);

    act(() =>
      fireEvent.click(
        editor.getByRole('button', { name: S.workspace.closeTab(S.workspace.overview) }),
      ),
    );
    expect(editor.queryByRole('tab')).toBeNull();
    expect(editor.getByText(S.workspace.empty.title)).toBeTruthy();
    // 안내는 동작 목록의 단축키(사용자 재지정 반영)를 쓰고, 단축키가 없는 동작은 뺀다
    expect(editor.getByText(S.actions.palette)).toBeTruthy();
    expect(editor.getByText(S.actions.focusSidebar)).toBeTruthy();
    expect(editor.getByText('F6')).toBeTruthy();
    expect(editor.queryByText(S.actions.terminal)).toBeNull();
    // 닫혀 있어도 Project 도구 창과 Git 로그는 그대로다
    expect(within(area('project') as HTMLElement).getAllByRole('treeitem')).toHaveLength(3);
    expect(area('git-log')).not.toBeNull();

    act(() =>
      fireEvent.click(editor.getByRole('button', { name: S.workspace.empty.openOverview })),
    );
    expect(editor.getByRole('tab', { name: S.workspace.overview })).toBeTruthy();
    expect(getWorkspaceStore(FOLDER_ID)?.getState().docs).toHaveLength(1);
  });

  it('프로젝트 트리의 "저장소 탭으로 열기" 와 요약 표 더블클릭이 같은 저장소 탭을 연다', async () => {
    const openRepositoryAt = vi.fn(async () => null);
    registerFolderTab(folderClient().client);
    setTabs([FOLDER_META], FOLDER_ID);
    act(() => useAppStore.setState({ openRepositoryAt }));
    render(<AppBody actions={ACTIONS} />);
    await tick();

    const row = within(area('project') as HTMLElement).getByText('web');
    fireEvent.contextMenu(row);
    await tick();
    act(() => fireEvent.click(screen.getByText(S.project.openAsTab)));
    expect(openRepositoryAt).toHaveBeenLastCalledWith(`${ROOT}/web`, FOLDER_ID);
    // 우클릭한 행이 선택되고 활성 저장소가 그 저장소가 된다 (WS-07)
    expect(getFolderStore(FOLDER_ID)?.getState().fileTree.getState().selected).toBe('web');
    expect(getWorkspaceStore(FOLDER_ID)?.getState().activeRepo).toBe(`${ROOT}/web`);

    const tableRow = within(area('editor') as HTMLElement)
      .getByText('api')
      .closest('tr');
    act(() => fireEvent.doubleClick(tableRow as HTMLElement));
    expect(openRepositoryAt).toHaveBeenLastCalledWith(`${ROOT}/api`, FOLDER_ID);
  });

  it('저장소 탭도 폴더 탭과 같은 틀이다 (W21): 띠·Project·에디터 + Git 도구 창 로그 탭에 브랜치 트리 | 그래프 | 상세. 옛 3단 배치는 없다', async () => {
    registerRepoTab();
    setTabs([REPO_META], REPO_ID);
    render(<AppBody actions={ACTIONS} />);
    await tick();

    expect(pressed()).toEqual({
      [S.project.title]: 'true',
      [S.commitTool.title]: 'false',
      [S.dock.git]: 'true',
      [S.terminal.title]: 'false',
    });
    for (const name of ['project', 'editor', 'git-branches', 'git-log', 'git-detail']) {
      expect(area(name), name).not.toBeNull();
    }
    for (const name of ['sidebar', 'center', 'detail']) {
      expect(area(name), name).toBeNull();
    }
    // 옮겨 실은 화면: 로그 탭 왼쪽 칸은 브랜치 트리 하나(W22 브랜치 트리 + W25 에서 옛 사이드바의 남은 덩이를 Project 도구
    // 창으로 옮겼다 — 섹션·superproject 단추가 없다), 그래프는 가운데 칸
    const branchesArea = area('git-branches') as HTMLElement;
    expect(within(branchesArea).getByRole('tree', { name: S.branches.tree })).toBeTruthy();
    expect(branchesArea.querySelector('section')).toBeNull();
    expect(within(branchesArea).queryByText(new RegExp(S.submodule.superproject))).toBeNull();
    expect(within(area('git-log') as HTMLElement).getByTestId('old-graph')).toBeTruthy();
    // 상세 칸: 아무것도 안 골랐으면 변경 요약 + Commit 도구 창 열기 (옛 변경 사항은 Commit 도구 창으로 갔다)
    expect(
      within(area('git-detail') as HTMLElement).getByText(S.workspace.repoLog.pickCommit),
    ).toBeTruthy();
    expect(screen.queryByTestId('old-changes')).toBeNull();
    // Git 탭은 [로그][콘솔], 로그가 골라져 있다
    const dock = within(screen.getByRole('region', { name: S.dock.label }));
    expect(dock.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      S.dock.tabs.log,
      S.dock.tabs.console,
    ]);
    expect(document.querySelector('[data-dock-mode]')?.getAttribute('data-dock-mode')).toBe(
      'normal',
    );

    // Commit 도구 창: 같은 자리에 옛 변경 사항(ChangesPanel)을 그대로 싣는다
    act(() =>
      fireEvent.click(
        within(stripe() as HTMLElement).getByRole('button', { name: S.commitTool.title }),
      ),
    );
    await tick();
    expect(within(area('commit') as HTMLElement).getByTestId('old-changes')).toBeTruthy();
    expect(area('project')).toBeNull();
  });

  it('탭이 없으면 띠 없이 홈 화면만 그린다', async () => {
    setTabs([], null);
    render(<AppBody actions={ACTIONS} />);
    await tick();
    expect(stripe()).toBeNull();
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(area('project')).toBeNull();
    expect(area('sidebar')).toBeNull();
  });

  it('폴더 탭과 저장소 탭을 오가도 터미널 뷰는 내려가지 않는다 (WS-02)', async () => {
    registerFolderTab(folderClient().client);
    registerRepoTab();
    setTabs([FOLDER_META, REPO_META], FOLDER_ID, {
      dock: { tool: 'terminal', maximized: false, gitTab: 'log' },
    });
    act(() =>
      useAppStore.setState({
        terminals: [{ id: 1, cwd: ROOT, title: '', initialInput: null }],
        activeTerminal: 1,
      }),
    );
    render(<AppBody actions={ACTIONS} />);
    await tick();
    const term = screen.getByTestId('term');
    expect(stripe()).not.toBeNull();

    act(() => useAppStore.getState().setActiveSession(REPO_ID));
    await tick();
    // 저장소 탭도 같은 띠·틀이다 (W21)
    expect(stripe()).not.toBeNull();
    expect(area('project')).not.toBeNull();
    expect(area('sidebar')).toBeNull();
    expect(screen.getByTestId('term')).toBe(term);

    act(() => useAppStore.getState().setActiveSession(FOLDER_ID));
    await tick();
    expect(stripe()).not.toBeNull();
    expect(area('project')).not.toBeNull();
    expect(screen.getByTestId('term')).toBe(term);
    expect(h.mounts).toBe(1);
    expect(h.unmounts).toBe(0);
  });
});

// W3 간이 트리의 뷰 테스트(행 클릭·↑↓·저장소 행 메뉴·머리 버튼)는 W11 의 파일 트리 뷰 테스트
// (`project-tree.test.tsx`)로 옮겼다 — 같은 동작을 새 props(평탄화한 행·행 장식 주입)로 확인한다

describe('EditorArea', () => {
  const docs = [
    { id: 'a', pinned: true },
    { id: 'p', pinned: false },
  ];

  /** 탭 두 개(고정 a, 미리보기 p)를 그린다 */
  function setup(activeId: string | null = 'a') {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const onPin = vi.fn();
    render(
      <EditorArea
        docs={docs}
        activeId={activeId}
        titleOf={(d) => `문서 ${d.id}`}
        renderDoc={(d) => <div>내용 {d.id}</div>}
        onActivate={onActivate}
        onClose={onClose}
        onPin={onPin}
        empty={<div>빈 상태</div>}
      />,
    );
    return { onActivate, onClose, onPin };
  }

  it('탭 막대와 활성 문서 하나를 그리고, 미리보기 탭을 표시한다', () => {
    setup();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['문서 a', '문서 p']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs.map((t) => t.parentElement?.getAttribute('data-preview'))).toEqual([
      'false',
      'true',
    ]);
    // 문서는 활성 탭의 것만 그린다
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toBe('내용 a');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
    expect(screen.queryByText('빈 상태')).toBeNull();
  });

  it('탭을 누르면 활성화, 더블클릭하면 고정, 닫기 버튼은 닫기를 알린다', () => {
    const { onActivate, onClose, onPin } = setup();
    fireEvent.click(screen.getByRole('tab', { name: '문서 p' }));
    expect(onActivate).toHaveBeenCalledWith('p');
    fireEvent.doubleClick(screen.getByRole('tab', { name: '문서 p' }));
    expect(onPin).toHaveBeenCalledWith('p');
    fireEvent.click(screen.getByRole('button', { name: S.workspace.closeTab('문서 a') }));
    expect(onClose).toHaveBeenCalledWith('a');
    // 닫기 버튼을 눌러도 탭 활성화로 번지지 않는다
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('탭이 하나도 없으면 빈 상태를 그린다', () => {
    render(
      <EditorArea
        docs={[]}
        activeId={null}
        titleOf={() => ''}
        renderDoc={() => null}
        onActivate={() => {}}
        onClose={() => {}}
        onPin={() => {}}
        empty={
          <EditorEmptyState
            hints={[
              { label: '팔레트', shortcut: 'f1' },
              { label: '단축키 없음', shortcut: undefined },
            ]}
            action={{ label: '다시 열기', onClick: () => {} }}
          />
        }
      />,
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText(S.workspace.empty.title)).toBeTruthy();
    expect(screen.getByText('팔레트')).toBeTruthy();
    expect(screen.getByText('F1')).toBeTruthy();
    expect(screen.queryByText('단축키 없음')).toBeNull();
    expect(screen.getByRole('button', { name: '다시 열기' })).toBeTruthy();
  });
});
