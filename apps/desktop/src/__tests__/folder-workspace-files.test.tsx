import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import {
  createNullClient,
  type FsDirListing,
  type FsEditableFile,
  type FsEntry,
  type FsFile,
  type IpcClient,
  type RepoSummary,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBody } from '../App';
import { focusPanel } from '../actions';
import { StatusBar } from '../layout/StatusBar';
import { DEFAULT_TIMELINE_QUERY, getFolderStore, getWorkspaceStore, useAppStore } from '../store';
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

vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));
// 로그는 jsdom 에서 그릴 수 없다 (이 테스트의 관심도 아니다)
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

const FOLDER_ID = 61;
const ROOT = '/f';

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file'): FsEntry {
  return { name, kind, size: 10, mtimeMs: 0, openable: kind === 'file' };
}

const LAYOUT: Record<string, FsEntry[]> = {
  '': [entry('api', 'dir'), entry('docs', 'dir'), entry('web', 'dir'), entry('README.md')],
  api: [entry('src', 'dir'), entry('pom.xml')],
  'api/src': [entry('Main.java')],
  docs: [entry('guide.md')],
  web: [entry('index.ts')],
};

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
  summary({ name: 'web', branch: 'feature/x', ahead: 3, behind: 0 }),
];

/** 파일 내용 응답을 손으로 줄 수 있는 가짜 클라이언트 */
function folderClient() {
  const reads: { path: string; resolve: (file: FsFile) => void }[] = [];
  let manualReads = false;
  const savedFiles = new Map<string, string>();
  const fsReadFile = vi.fn(
    (_session: number, path: string): Promise<FsFile> =>
      manualReads
        ? new Promise<FsFile>((resolve) => reads.push({ path, resolve }))
        : Promise.resolve({
            kind: 'text',
            text: savedFiles.get(path) ?? `// ${path}\nbody`,
            size: 20,
          }),
  );
  const fsListDir = vi.fn(
    async (_session: number, dir: string): Promise<FsDirListing> => ({
      kind: 'listed',
      entries: LAYOUT[dir] ?? [],
      total: LAYOUT[dir]?.length ?? 0,
      truncated: false,
      nonUtf8Names: 0,
    }),
  );
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => SUMMARIES,
    fsListDir,
    fsReadFile,
    fsReadEditableFile: async (session, path): Promise<FsEditableFile> => {
      const file = await fsReadFile(session, path);
      return file.kind === 'text'
        ? {
            ...file,
            fileKey: `${session}:${path}`,
            revision: file.text,
            lineEnding: 'lf',
            bom: false,
          }
        : file;
    },
    fsSaveFile: vi.fn(async (_session, path, _revision, text) => {
      savedFiles.set(path, text);
      return { kind: 'saved' as const, revision: text };
    }),
  };
  return {
    client,
    fsListDir,
    fsReadFile,
    reads,
    manual: () => {
      manualReads = true;
    },
  };
}

const FOLDER_META: SessionMeta = {
  id: FOLDER_ID,
  kind: 'folder',
  path: ROOT,
  name: 'f',
  parent: null,
};

/** 폴더 탭을 등록하고 앱 본문·상태 바를 그린다 (`openFolderAt` 과 같이 문서가 열리면 최대화를 푼다) */
async function mount() {
  const fake = folderClient();
  registerFolder(
    FOLDER_ID,
    createFolderStore(
      {
        session: FOLDER_ID,
        path: ROOT,
        repos: SUMMARIES.map((s) => ({ path: s.path, kind: s.kind })),
      },
      fake.client,
    ),
  );
  registerWorkspace(
    FOLDER_ID,
    createWorkspaceStore('folder', {
      onDocOpened: () => useAppStore.getState().setDockMaximized(false),
    }),
  );
  act(() => {
    useAppStore.setState({
      client: fake.client,
      sessions: { [FOLDER_ID]: FOLDER_META },
      sessionOrder: [FOLDER_ID],
      activeSessionId: FOLDER_ID,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
    });
  });
  render(
    <>
      <AppBody actions={[]} />
      <StatusBar />
    </>,
  );
  await tick();
  return fake;
}

/** 워크스페이스 상태 */
const ws = () => getWorkspaceStore(FOLDER_ID)?.getState();
/** 파일 트리 상태 */
const fileTree = () => getFolderStore(FOLDER_ID)?.getState().fileTree.getState();
/** Project 도구 창 */
const project = () =>
  within(document.querySelector<HTMLElement>('[data-panel="project"]') as HTMLElement);
/** 이름으로 트리 행을 찾는다 */
const row = (name: string) =>
  project()
    .getAllByRole('treeitem')
    .find((r) => r.querySelector('span[title]')?.textContent === name) as HTMLElement;
/** 상태 바 */
const statusBar = () => within(document.querySelector('footer') as HTMLElement);
/** 에디터 공간 */
const editor = () =>
  within(document.querySelector<HTMLElement>('[data-panel="editor"]') as HTMLElement);
/** 제목이 그 글자인 에디터 탭 (보조 글자는 제목 뒤의 따로 된 글자다) */
const tabOf = (title: string) =>
  editor()
    .getAllByRole('tab')
    .find((t) => t.firstChild?.textContent === title) as HTMLElement;

/** 디렉터리 행을 눌러 펼치고 읽기를 기다린다 */
async function expand(name: string) {
  fireEvent.click(row(name));
  await tick();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await fileEditors.discard();
  fileEditors.releaseSession(FOLDER_ID);
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      dock: DEFAULT_DOCK,
    }),
  );
  disposeFolder(FOLDER_ID);
  disposeWorkspace(FOLDER_ID);
  clearSessionRegistry();
});

describe('폴더 탭의 프로젝트 트리 (PT-01·03)', () => {
  it('루트 행 아래에 폴더 전체를 그리고 펼칠 때 그 디렉터리만 읽는다', async () => {
    const { fsListDir } = await mount();
    expect(fsListDir.mock.calls.map((c) => c[1])).toEqual(['']);
    expect(project().getAllByRole('treeitem')).toHaveLength(1 + (LAYOUT[''] ?? []).length);
    // 저장소 디렉터리는 요약 장식을 단다
    expect(within(row('api')).getByText('54↓')).toBeTruthy();
    expect(within(row('web')).getByText('3↑')).toBeTruthy();
    expect(within(row('docs')).queryByText('main')).toBeNull();

    await expand('api');
    expect(fsListDir.mock.calls.map((c) => c[1])).toEqual(['', 'api']);
    fireEvent.click(row('api'));
    await expand('api');
    expect(fsListDir).toHaveBeenCalledTimes(2);
  });
});

describe('활성 저장소 (WS-07)', () => {
  it('저장소(나 그 안의 항목)를 고르면 활성 저장소가 바뀌고, 로그 필터·에디터는 그대로다', async () => {
    await mount();
    expect(statusBar().getByText(S.status.noActiveRepo)).toBeTruthy();
    await expand('api');
    expect(ws()?.activeRepo).toBe(`${ROOT}/api`);
    expect(statusBar().getByText('api')).toBeTruthy();
    expect(statusBar().getByText('development')).toBeTruthy();
    expect(statusBar().getByText('54↓')).toBeTruthy();
    expect(ws()?.docs.map((d) => d.id)).toEqual(['overview']);
    expect(getFolderStore(FOLDER_ID)?.getState().timeline.query).toEqual(DEFAULT_TIMELINE_QUERY);

    // 저장소 안의 항목도 그 저장소다
    await expand('web');
    expect(ws()?.activeRepo).toBe(`${ROOT}/web`);
    fireEvent.click(row('pom.xml'));
    expect(ws()?.activeRepo).toBe(`${ROOT}/api`);

    // 저장소 밖의 항목은 활성 저장소를 바꾸지 않는다
    fireEvent.click(row('docs'));
    await tick();
    expect(ws()?.activeRepo).toBe(`${ROOT}/api`);
    expect(fileTree()?.selected).toBe('docs');
  });

  it('파일 클릭 = 미리보기 탭(같은 탭 교체), 더블클릭 = 고정. 활성 저장소는 그 파일의 저장소다', async () => {
    await mount();
    await expand('web');
    fireEvent.click(row('index.ts'));
    await tick();
    expect(ws()?.docs.map((d) => [d.id, d.pinned])).toEqual([
      ['overview', true],
      ['file:web/index.ts', false],
    ]);
    expect(ws()?.activeRepo).toBe(`${ROOT}/web`);
    // 탭 글자: 파일 이름, 보조 글자 = 저장소 이름, 툴팁 = 전체 상대 경로
    const tab = tabOf('index.ts');
    expect(tab.textContent).toBe('index.tsweb');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('title')).toContain('web/index.ts');
    expect(tab.parentElement?.getAttribute('data-preview')).toBe('true');
    expect(screen.getByTestId('file-editor').querySelector('.cm-content')?.textContent).toContain(
      '// web/index.ts',
    );

    await expand('api');
    await expand('src');
    fireEvent.click(row('Main.java'));
    await tick();
    expect(ws()?.docs.map((d) => d.id)).toEqual(['overview', 'file:api/src/Main.java']);
    expect(ws()?.activeRepo).toBe(`${ROOT}/api`);
    fireEvent.doubleClick(row('Main.java'));
    expect(ws()?.docs.map((d) => [d.id, d.pinned])).toEqual([
      ['overview', true],
      ['file:api/src/Main.java', true],
    ]);
  });

  it('에디터 탭을 활성화하면 활성 저장소가 그 문서의 저장소가 되고, 트리 선택·스크롤은 그대로다', async () => {
    await mount();
    await expand('web');
    fireEvent.doubleClick(row('index.ts'));
    await expand('api');
    await expand('src');
    fireEvent.doubleClick(row('Main.java'));
    fireEvent.click(row('README.md'));
    await tick();
    fileTree()?.rememberScroll(123);
    const selected = fileTree()?.selected;
    expect(selected).toBe('README.md');
    // 저장소 밖 파일(README.md)을 열어도 활성 저장소는 그대로다
    expect(ws()?.activeRepo).toBe(`${ROOT}/api`);

    fireEvent.click(tabOf('index.ts'));
    expect(ws()?.activeRepo).toBe(`${ROOT}/web`);
    expect(statusBar().getByText('web')).toBeTruthy();
    expect(fileTree()?.selected).toBe(selected);
    expect(fileTree()?.scrollTop()).toBe(123);
    // 저장소 없는 문서(개요)를 활성화해도 그대로다
    fireEvent.click(editor().getByRole('tab', { name: S.workspace.overview }));
    expect(ws()?.activeRepo).toBe(`${ROOT}/web`);
    // 저장소 밖 파일 탭의 보조 글자는 상위 폴더 (루트 바로 아래면 없다)
    expect(tabOf('README.md').textContent).toBe('README.md');
  });

  it('문서가 열리면 아래 도구 창 최대화를 푼다', async () => {
    await mount();
    await expand('docs');
    act(() => useAppStore.getState().setDockMaximized(true));
    expect(useAppStore.getState().dock.maximized).toBe(true);
    fireEvent.click(row('guide.md'));
    expect(useAppStore.getState().dock.maximized).toBe(false);
    expect(tabOf('guide.md').textContent).toBe('guide.mddocs');
  });
});

describe('파일 편집 탭', () => {
  it('첫 입력으로 미리보기를 고정하고 탭 전환 뒤 Undo·커서를 보존하며 즉시 저장한다', async () => {
    const fake = await mount();
    await expand('docs');
    fireEvent.click(row('guide.md'));
    await tick();
    const first = EditorView.findFromDOM(
      screen.getByTestId('file-editor').firstElementChild as HTMLElement,
    );
    expect(first).not.toBeNull();
    act(() =>
      first?.dispatch({ changes: { from: 0, insert: 'draft ' }, selection: { anchor: 3 } }),
    );
    expect(ws()?.docs.find((doc) => doc.id === 'file:docs/guide.md')?.pinned).toBe(true);
    expect(fileEditors.hasDirty(FOLDER_ID, 'docs/guide.md')).toBe(true);
    fireEvent.click(editor().getByRole('tab', { name: S.workspace.overview }));
    await tick();
    fireEvent.click(tabOf('guide.md'));
    await tick();
    const restored = EditorView.findFromDOM(
      screen.getByTestId('file-editor').firstElementChild as HTMLElement,
    );
    expect(restored?.state.selection.main.anchor).toBe(3);
    expect(restored?.state.doc.toString()).toContain('draft ');
    act(() => {
      if (restored) undo(restored);
    });
    expect(restored?.state.doc.toString()).toBe('// docs/guide.md\nbody');
    act(() => restored?.dispatch({ changes: { from: 0, insert: 'saved ' } }));
    fireEvent.click(screen.getByRole('button', { name: S.fileEditor.save }));
    await tick();
    expect(fake.client.fsSaveFile).toHaveBeenCalledOnce();
    expect(fileEditors.hasDirty(FOLDER_ID, 'docs/guide.md')).toBe(false);
    expect(restored?.state.doc.toString()).toContain('saved ');
  });
});

describe('파일 보기 탭 다시 읽기 (ED-04)', () => {
  it('파일 트리가 다시 읽으면 내용을 보인 채 다시 읽고, 늦게 온 옛 응답은 버린다', async () => {
    const fake = await mount();
    await expand('docs');
    fake.manual();
    fireEvent.click(row('guide.md'));
    await tick();
    expect(screen.getByText(S.fileView.loading)).toBeTruthy();
    act(() => fake.reads.shift()?.resolve({ kind: 'text', text: 'v1', size: 2 }));
    await tick();
    expect(screen.getByTestId('file-editor').querySelector('.cm-content')?.textContent).toBe('v1');

    // 새로고침: 다시 읽는 동안 이전 내용을 그대로 보인다
    fireEvent.click(project().getByRole('button', { name: S.folder.refresh }));
    await tick();
    expect(fake.reads).toHaveLength(1);
    expect(screen.getByTestId('file-editor').querySelector('.cm-content')?.textContent).toBe('v1');
    // 한 번 더: 앞 요청의 응답이 뒤에 와도 버린다
    fireEvent.click(project().getByRole('button', { name: S.folder.refresh }));
    await tick();
    const [older, newer] = fake.reads.splice(0, 2);
    act(() => newer?.resolve({ kind: 'text', text: 'v3', size: 2 }));
    await tick();
    act(() => older?.resolve({ kind: 'text', text: 'v2', size: 2 }));
    await tick();
    expect(screen.getByTestId('file-editor').querySelector('.cm-content')?.textContent).toBe('v3');
  });

  it('읽기 실패는 다시 시도할 수 있다', async () => {
    const fake = await mount();
    fake.fsReadFile.mockRejectedValueOnce(new Error('세션이 닫혔습니다'));
    fireEvent.click(row('README.md'));
    await tick();
    expect(screen.getByText(S.fileView.failed('세션이 닫혔습니다'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: S.fileView.retry }));
    await tick();
    expect(screen.getByTestId('file-editor').querySelector('.cm-content')?.textContent).toContain(
      '// README.md',
    );
  });
});

describe('키보드만으로 (PT-04, WS-11)', () => {
  it('⌘1 의 포커스 이동이 트리에 닿고, ↓→ 로 내려가 Enter 로 파일을 고정 탭으로 연다', async () => {
    await mount();
    focusPanel('project');
    const treeEl = project().getByRole('tree', { name: S.project.tree });
    expect(document.activeElement).toBe(treeEl);
    const press = async (key: string) => {
      fireEvent.keyDown(treeEl, { key });
      await tick();
    };
    await press('ArrowDown');
    expect(fileTree()?.selected).toBe('');
    await press('ArrowDown');
    expect(fileTree()?.selected).toBe('api');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(fileTree()?.selected).toBe('api/src');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(fileTree()?.selected).toBe('api/src/Main.java');
    await press('Enter');
    expect(ws()?.docs.find((d) => d.id === 'file:api/src/Main.java')?.pinned).toBe(true);
    expect(ws()?.activeRepo).toBe(`${ROOT}/api`);
  });

  it('열린 파일을 트리에서 찾는다 (◎): 조상을 펼치고 그 행을 고른다', async () => {
    const { fsListDir } = await mount();
    act(() =>
      ws()?.openDoc(
        {
          id: 'file:api/src/Main.java',
          kind: 'file',
          path: 'api/src/Main.java',
          name: 'Main.java',
          repoPath: `${ROOT}/api`,
          repoName: 'api',
        },
        'pinned',
      ),
    );
    await tick();
    fireEvent.click(project().getByRole('button', { name: S.project.locate }));
    await tick();
    expect(fsListDir.mock.calls.map((c) => c[1])).toEqual(['', 'api', 'api/src']);
    expect(fileTree()?.selected).toBe('api/src/Main.java');
    expect(row('Main.java').getAttribute('aria-selected')).toBe('true');
  });
});
