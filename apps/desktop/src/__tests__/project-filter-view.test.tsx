import {
  createNullClient,
  type FsDirListing,
  type FsEntry,
  type GroupInfo,
  type IpcClient,
  type RepoChanges,
  type RepoSummary,
  type StatusEntry,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBody } from '../App';
import { buildActions } from '../actions';
import { fileListCache } from '../features/search/file-list';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../store';
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
import { createWorkspaceStore } from '../store/workspace-store';
import { tick } from './dialog-stub';

// Project 트리 이름 필터·"변경된 파일만" (R1): 폴더 탭과 그룹 탭의 Project 도구 창을 앱 전체로 그려 확인한다

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

const ID = 71;

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file'): FsEntry {
  return { name, kind, size: 10, mtimeMs: 0, openable: kind === 'file' };
}

/** 상태 엔트리 하나 (작업 트리에서 수정) */
function modified(path: string): StatusEntry {
  return {
    path,
    origPath: null,
    index: 'unmodified',
    worktree: 'modified',
    submodule: null,
    conflict: null,
    renameScore: null,
  };
}

/** 저장소 하나의 변경 목록 */
function changes(path: string, entries: StatusEntry[]): RepoChanges {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    branch: 'main',
    entries,
    summary: {
      staged: 0,
      unstaged: entries.length,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0,
      stashCount: 0,
      upstream: null,
    },
  };
}

/** 요약 한 줄 */
function summary(path: string): RepoSummary {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
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
  };
}

/** 장면 하나: 디렉터리 나열·빠른 열기 파일 목록·저장소 변경 */
interface Scene {
  path: string;
  repos: string[];
  layout: Record<string, FsEntry[]>;
  files: string[];
  changes: RepoChanges[];
  group?: GroupInfo;
}

const FOLDER: Scene = {
  path: '/f',
  repos: ['/f/api', '/f/web'],
  layout: {
    '': [entry('api', 'dir'), entry('web', 'dir'), entry('README.md')],
    api: [entry('src', 'dir'), entry('pom.xml')],
    'api/src': [entry('Main.java'), entry('Util.java')],
    web: [entry('index.ts')],
  },
  files: ['README.md', 'api/pom.xml', 'api/src/Main.java', 'api/src/Util.java', 'web/index.ts'],
  changes: [changes('/f/api', [modified('src/Util.java')])],
};

const GROUP: GroupInfo = {
  id: 'g1',
  name: 'Work',
  members: [
    { alias: 'api', path: '/w/api', state: 'present', kind: 'standalone' },
    { alias: 'web', path: '/x/team/web', state: 'present', kind: 'standalone' },
  ],
};

const GROUP_SCENE: Scene = {
  path: 'mgit-group:g1',
  repos: ['/w/api', '/x/team/web'],
  layout: { '': [entry('api', 'dir'), entry('web', 'dir')] },
  files: ['api/src/a.ts', 'web/b.ts'],
  changes: [changes('/w/api', [modified('src/a.ts')])],
  group: GROUP,
};

/** 장면의 가짜 클라이언트 */
function sceneClient(scene: Scene) {
  const fsListDir = vi.fn(
    async (_session: number, dir: string): Promise<FsDirListing> => ({
      kind: 'listed',
      entries: scene.layout[dir] ?? [],
      total: scene.layout[dir]?.length ?? 0,
      truncated: false,
      nonUtf8Names: 0,
    }),
  );
  const workspaceFiles = vi.fn(async () => ({
    files: scene.files,
    repos: [],
    skipped: 0,
    truncated: false,
    cancelled: false,
  }));
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => scene.repos.map(summary),
    folderChanges: async () => scene.changes,
    fsListDir,
    workspaceFiles,
    fsReadFile: async (_session, path) => ({ kind: 'text', text: `// ${path}`, size: 10 }),
    fsReadEditableFile: async (session, path) => ({
      kind: 'text',
      text: `// ${path}`,
      size: 10,
      fileKey: `${session}:${path}`,
      revision: 'r',
      lineEnding: 'lf',
      bom: false,
    }),
  };
  return { client, fsListDir, workspaceFiles };
}

/** 폴더(그룹) 탭을 등록하고 앱 본문을 그린다 */
async function mount(scene: Scene = FOLDER) {
  const fake = sceneClient(scene);
  registerFolder(
    ID,
    createFolderStore(
      {
        session: ID,
        path: scene.path,
        repos: scene.repos.map((path) => ({ path, kind: 'standalone' as const })),
        ...(scene.group ? { group: scene.group } : {}),
      },
      fake.client,
    ),
  );
  registerWorkspace(ID, createWorkspaceStore('folder'));
  const meta: SessionMeta = { id: ID, kind: 'folder', path: scene.path, name: 'f', parent: null };
  act(() => {
    useAppStore.setState({
      client: fake.client,
      sessions: { [ID]: meta },
      sessionOrder: [ID],
      activeSessionId: ID,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
    });
  });
  render(<AppBody actions={[]} />);
  await tick();
  return fake;
}

/** Project 도구 창 */
const panel = () => document.querySelector<HTMLElement>('[data-panel="project"]') as HTMLElement;
const project = () => within(panel());
/** 트리(행 목록) */
const treeEl = () => panel().querySelector<HTMLElement>('[data-project-tree]') as HTMLElement;
/** 이름 필터 칸 */
const filterInput = () =>
  project().getByRole('searchbox', { name: S.project.filter.label }) as HTMLInputElement;
/** "변경된 파일만" 단추 */
const changedButton = () => project().getByRole('button', { name: S.project.filter.changedOnly });
/** 보이는 행의 이름들 (들여쓰기 단계를 앞에 붙여) */
const shown = () =>
  project()
    .getAllByRole('treeitem')
    .map((r) => `${r.getAttribute('aria-level')}:${r.querySelector('span[title]')?.textContent}`);
/** 이름으로 행을 찾는다 */
const row = (name: string) =>
  project()
    .getAllByRole('treeitem')
    .find((r) => r.querySelector('span[title]')?.textContent === name) as HTMLElement;
/** 파일 트리 상태 */
const fileTree = () => getFolderStore(ID)?.getState().fileTree.getState();
/** 이름 필터에 적는다 */
async function type(text: string) {
  fireEvent.change(filterInput(), { target: { value: text } });
  await tick();
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  fileListCache.clear();
});

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

describe('Project 트리 이름 필터 (R1)', () => {
  it('펼치지 않은 폴더의 파일도 찾아 상위 폴더와 함께 보이고 맞은 글자를 강조한다. 거르기를 지우면 고른 행으로 펼친다', async () => {
    const { fsListDir, workspaceFiles } = await mount();
    expect(shown()).toEqual(['1:f', '2:api', '2:web', '2:README.md']);

    await type('main');
    expect(workspaceFiles).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual(['1:f', '2:api', '3:src', '4:Main.java']);
    expect(row('Main.java').querySelector('mark')?.textContent).toBe('Main');
    // 거른 보기의 폴더는 접지 않는다
    expect(project().getByRole('button', { name: S.projectEdit.collapse })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(row('api'));
    expect(shown()).toHaveLength(4);
    expect(fileTree()?.expanded).toEqual({ '': true });

    // ↓ 는 첫 맞은 항목을 고르고 트리로 간다
    fireEvent.keyDown(filterInput(), { key: 'ArrowDown' });
    expect(fileTree()?.selected).toBe('api/src/Main.java');
    expect(document.activeElement).toBe(treeEl());

    // 트리의 Esc 는 필터를 지우고, 고른 행이 보이게 실제 트리를 펼친다 (선택은 그대로)
    fireEvent.keyDown(treeEl(), { key: 'Escape' });
    await tick();
    await tick();
    expect(filterInput().value).toBe('');
    expect(fsListDir.mock.calls.map((c) => c[1])).toEqual(['', 'api', 'api/src']);
    expect(shown()).toEqual([
      '1:f',
      '2:api',
      '3:src',
      '4:Main.java',
      '4:Util.java',
      '3:pom.xml',
      '2:web',
      '2:README.md',
    ]);
    expect(fileTree()?.selected).toBe('api/src/Main.java');
    // 같은 표지면 파일 목록을 다시 받지 않는다
    await type('util');
    expect(workspaceFiles).toHaveBeenCalledTimes(1);
  });

  it('트리에서 글자를 치면 필터 칸으로 가서 이어 적고, 맞는 것이 없으면 안내한다. 칸의 Esc 는 지우고 트리로 간다', async () => {
    await mount();
    act(() => treeEl().focus());
    fireEvent.keyDown(treeEl(), { key: 'z' });
    await tick();
    await tick();
    expect(filterInput().value).toBe('z');
    expect(document.activeElement).toBe(filterInput());
    expect(project().getByRole('status').textContent).toBe(S.project.filter.noMatch);
    expect(shown()).toEqual(['1:f']);

    fireEvent.keyDown(filterInput(), { key: 'Escape' });
    await tick();
    expect(filterInput().value).toBe('');
    expect(document.activeElement).toBe(treeEl());
    expect(project().queryByRole('status')).toBeNull();
  });

  it('Enter 는 첫 맞은 파일을 고정 탭으로 연다', async () => {
    await mount();
    await type('POM');
    fireEvent.keyDown(filterInput(), { key: 'Enter' });
    await tick();
    const ws = getWorkspaceStore(ID)?.getState();
    expect(ws?.docs.find((d) => d.kind === 'file')).toMatchObject({
      path: 'api/pom.xml',
      pinned: true,
    });
    expect(fileTree()?.selected).toBe('api/pom.xml');
  });

  it('변경된 파일만: 변경 파일과 상위 폴더만 보이고 파일 목록은 받지 않는다. 다시 누르면 원래 트리', async () => {
    const { workspaceFiles } = await mount();
    fireEvent.click(changedButton());
    await tick();
    expect(changedButton().getAttribute('aria-pressed')).toBe('true');
    expect(shown()).toEqual(['1:f', '2:api', '3:src', '4:Util.java']);
    expect(row('Util.java').closest('[data-status]')?.getAttribute('data-status')).toBe('modified');
    // 이름 필터와 함께면 둘 다 맞아야 한다
    await type('main');
    expect(shown()).toEqual(['1:f']);
    expect(project().getByRole('status').textContent).toBe(S.project.filter.noMatch);
    expect(workspaceFiles).not.toHaveBeenCalled();
    await type('');
    fireEvent.click(changedButton());
    await tick();
    expect(shown()).toEqual(['1:f', '2:api', '2:web', '2:README.md']);
  });

  it('팔레트의 "프로젝트 트리 이름 필터" 는 Project 도구 창을 열고 필터 칸으로 간다 (기본 키 없음)', async () => {
    await mount();
    act(() => useAppStore.setState({ leftTool: 'commit' }));
    const noop = () => {};
    const action = buildActions({
      app: useAppStore.getState(),
      session: null,
      tabKind: 'folder',
      openQuickSwitch: noop,
      startClone: noop,
      startInit: noop,
      promptBranch: noop,
      promptCompare: noop,
      promptColumns: noop,
    } as unknown as Parameters<typeof buildActions>[0]).find((a) => a.id === 'view.projectFilter');
    expect(action?.title).toBe(S.actions.projectFilter);
    expect(action?.shortcut).toBeUndefined();
    expect(action?.enabled).toBe(true);
    act(() => action?.run());
    await tick();
    expect(useAppStore.getState().leftTool).toBe('project');
    expect(document.activeElement).toBe(filterInput());
  });
});

describe('그룹 탭의 Project 트리 필터 (R1)', () => {
  it('별칭 경로 공간에서 이름으로 거르고, 멤버 저장소의 변경을 별칭 아래로 보인다', async () => {
    await mount(GROUP_SCENE);
    expect(shown()).toEqual(['1:Work', '2:api', '2:web']);
    await type('b.ts');
    expect(shown()).toEqual(['1:Work', '2:web', '3:b.ts']);
    await type('');
    fireEvent.click(changedButton());
    await tick();
    expect(shown()).toEqual(['1:Work', '2:api', '3:src', '4:a.ts']);
  });
});
