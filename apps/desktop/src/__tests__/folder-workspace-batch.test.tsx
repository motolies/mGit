import {
  type BatchResult,
  createNullClient,
  type FileState,
  type FolderSettings,
  type FsDirListing,
  type FsEntry,
  type IpcClient,
  type RepoChanges,
  type RepoSummary,
  type StatusEntry,
} from '@mgit/ipc';
import { formatTime, S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBody } from '../App';
import { Toolbar } from '../layout/Toolbar';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../store';
import { DEFAULT_DOCK, type SessionMeta } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

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
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

const FOLDER_ID = 71;
const ROOT = '/f';
const NAMES = ['api', 'auth', 'web'];
const pathOf = (name: string) => `${ROOT}/${name}`;

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file'): FsEntry {
  return { name, kind, size: 10, mtimeMs: 0, openable: kind === 'file' };
}

const LAYOUT: Record<string, FsEntry[]> = {
  '': [...NAMES.map((n) => entry(n, 'dir')), entry('docs', 'dir'), entry('README.md')],
  api: [entry('src', 'dir'), entry('pom.xml')],
  'api/src': [entry('Main.java'), entry('New.java'), entry('Facet.kt')],
  auth: [entry('notes.md')],
  web: [entry('index.ts')],
  docs: [entry('guide.md')],
};

/** 요약 한 줄. api 는 보낼 commit 3개, auth 는 업스트림 없음, web 은 보낼 것 없음 */
function summary(name: string, ahead: number | null): RepoSummary {
  return {
    path: pathOf(name),
    name,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead,
    behind: ahead === null ? null : 0,
    op: null,
    lastFetch: null,
    error: null,
  };
}

const SUMMARIES = [summary('api', 3), summary('auth', null), summary('web', 0)];

/** 상태 엔트리 */
function st(path: string, index: FileState, worktree: FileState, conflict = false): StatusEntry {
  return {
    path,
    origPath: null,
    index,
    worktree,
    submodule: null,
    conflict: conflict ? 'bothModified' : null,
    renameScore: null,
  };
}

const CHANGES: RepoChanges[] = [
  {
    path: pathOf('api'),
    name: 'api',
    branch: 'main',
    entries: [
      st('src/Main.java', 'modified', 'unmodified'),
      st('src/New.java', 'added', 'unmodified'),
      st('src/Facet.kt', 'unmerged', 'unmerged', true),
      st('pom.xml', 'untracked', 'untracked'),
    ],
    summary: {
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicted: 1,
      ahead: 3,
      behind: 0,
      stashCount: 0,
      upstream: 'origin/main',
    },
  },
];

const SETTINGS: FolderSettings = {
  exclude: [],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 0,
  worktreeRoot: null,
};

const RESULT: BatchResult = {
  label: '일괄 fetch',
  results: [],
  succeeded: 3,
  skipped: 0,
  failed: 0,
};

/** 폴더 탭을 등록하고 툴바·앱 본문을 그린다 */
async function mount(overrides: Partial<IpcClient> = {}) {
  const folderBatch = vi.fn<IpcClient['folderBatch']>(async () => RESULT);
  const folderSettingsSet = vi.fn<IpcClient['folderSettingsSet']>(async () => {});
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => SUMMARIES,
    folderChanges: async () => CHANGES,
    folderSettings: async () => SETTINGS,
    folderSettingsSet,
    folderBatch,
    fsListDir: async (_session, dir): Promise<FsDirListing> => ({
      kind: 'listed',
      entries: LAYOUT[dir] ?? [],
      total: LAYOUT[dir]?.length ?? 0,
      truncated: false,
      nonUtf8Names: 0,
    }),
    ...overrides,
  };
  registerFolder(
    FOLDER_ID,
    createFolderStore(
      {
        session: FOLDER_ID,
        path: ROOT,
        repos: NAMES.map((n) => ({ path: pathOf(n), kind: 'standalone' })),
      },
      client,
    ),
  );
  registerWorkspace(FOLDER_ID, createWorkspaceStore('folder'));
  const meta: SessionMeta = { id: FOLDER_ID, kind: 'folder', path: ROOT, name: 'f', parent: null };
  act(() => {
    useAppStore.setState({
      sessions: { [FOLDER_ID]: meta },
      sessionOrder: [FOLDER_ID],
      activeSessionId: FOLDER_ID,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      toasts: [],
    });
  });
  render(
    <>
      <Toolbar />
      <AppBody actions={[]} />
    </>,
  );
  await tick();
  return { folderBatch, folderSettingsSet };
}

/** 영역 */
const area = (name: string) =>
  within(document.querySelector<HTMLElement>(`[data-panel="${name}"]`) as HTMLElement);
/** 이름으로 트리 행 */
const row = (name: string) =>
  area('project')
    .getAllByRole('treeitem')
    .find((r) => r.querySelector('span[title]')?.textContent === name) as HTMLElement;
/** 트리에서 고른 행 이름 (우클릭 메뉴가 열려 나머지가 aria-hidden 이어도 본다) */
const treeSelected = () =>
  area('project')
    .getAllByRole('treeitem', { hidden: true })
    .filter((r) => r.getAttribute('aria-selected') === 'true')
    .map((r) => r.querySelector('span[title]')?.textContent);
/** 개요 표에서 체크된 저장소 이름 */
const overviewChecked = () =>
  NAMES.filter(
    (n) =>
      area('editor').getByRole<HTMLInputElement>('checkbox', { name: S.folder.selectRepo(n) })
        .checked,
  );
/** 맨 위 툴바 (먼저 그린 header) */
const toolbar = () => within(document.querySelector('header') as HTMLElement);
/** 툴바의 버튼 */
const toolbarButton = (op: string, scope: string) =>
  toolbar().getByRole<HTMLButtonElement>('button', { name: S.folder.batch.withScope(op, scope) });
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
const fileTree = () => getFolderStore(FOLDER_ID)?.getState().fileTree.getState();

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
      dock: DEFAULT_DOCK,
      toasts: [],
    }),
  );
  disposeFolder(FOLDER_ID);
  disposeWorkspace(FOLDER_ID);
  clearSessionRegistry();
});

describe('트리 선택과 개요 체크박스는 한 상태다 (PT-07)', () => {
  it('⌘클릭으로 저장소 셋을 고르면 개요의 체크박스 셋이 체크되고, 개요에서 풀면 트리 선택에서 빠진다', async () => {
    await mount();
    // 파일을 그냥 누르면 미리보기 탭이 개요를 가리므로 ⌘ 로 고른다
    fireEvent.click(row('README.md'), { metaKey: true });
    fireEvent.click(row('api'), { metaKey: true });
    fireEvent.click(row('auth'), { metaKey: true });
    fireEvent.click(row('web'), { metaKey: true });
    expect(overviewChecked()).toEqual(['api', 'auth', 'web']);
    act(() =>
      fireEvent.click(area('editor').getByRole('checkbox', { name: S.folder.selectRepo('auth') })),
    );
    // 다른 선택(README.md)은 그대로
    expect(treeSelected()).toEqual(['api', 'web', 'README.md']);
    expect(overviewChecked()).toEqual(['api', 'web']);
  });

  it('⇧클릭 범위, 개요의 전체 선택은 저장소 행만 넣고 빼며 트리의 다른 선택을 지킨다', async () => {
    await mount();
    // 디렉터리를 그냥 누르면 펼쳐져 범위에 자식이 끼므로 ⌘ 로 시작 행을 고른다
    fireEvent.click(row('api'), { metaKey: true });
    fireEvent.click(row('web'), { shiftKey: true });
    expect(treeSelected()).toEqual(['api', 'auth', 'web']);
    expect(overviewChecked()).toEqual(['api', 'auth', 'web']);
    fireEvent.click(row('README.md'), { metaKey: true });
    const all = area('editor').getByRole<HTMLInputElement>('checkbox', {
      name: S.folder.selectAll,
    });
    expect(all.checked).toBe(true);
    act(() => fireEvent.click(all));
    expect(treeSelected()).toEqual(['README.md']);
    act(() => fireEvent.click(all));
    expect(treeSelected()).toEqual(['api', 'auth', 'web', 'README.md']);
  });

  it('활성 저장소는 마지막으로 고른 행이 정한다 (WS-07)', async () => {
    await mount();
    fireEvent.click(row('api'));
    fireEvent.click(row('web'), { metaKey: true });
    expect(fileTree()?.selected).toBe('web');
    expect(getWorkspaceStore(FOLDER_ID)?.getState().activeRepo).toBe(pathOf('web'));
    // 개요에서 체크해도 기준 행·활성 저장소는 그대로다
    act(() =>
      fireEvent.click(area('editor').getByRole('checkbox', { name: S.folder.selectRepo('auth') })),
    );
    expect(getWorkspaceStore(FOLDER_ID)?.getState().activeRepo).toBe(pathOf('web'));
    // ⌘ 로 뺀 행은 기준 행이 되지만 활성 저장소를 가져가지 않는다
    fireEvent.click(row('api'), { metaKey: true });
    expect(fileTree()?.selected).toBe('api');
    expect(getWorkspaceStore(FOLDER_ID)?.getState().activeRepo).toBe(pathOf('web'));
  });
});

describe('툴바의 Fetch·Pull·Push (WS-09)', () => {
  it('대상은 고른 저장소, 없으면 전체 — 접근성 이름과 툴팁에 수를 쓴다. Fetch 는 바로 그 저장소로 부른다', async () => {
    const { folderBatch } = await mount();
    const all = S.folder.batch.allRepos(3);
    expect(toolbarButton(S.remote.fetch, all).getAttribute('title')).toBe(
      S.folder.batch.withScope(S.remote.fetch, all),
    );
    expect(toolbarButton(S.remote.pull, all).getAttribute('title')).toContain(
      S.folder.batch.pullTip(S.folder.settings.ffOnly),
    );
    fireEvent.click(row('api'));
    fireEvent.click(row('web'), { metaKey: true });
    const two = S.folder.batch.selected(2);
    act(() => fireEvent.click(toolbarButton(S.remote.fetch, two)));
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'fetch', prune: true }, [
      pathOf('api'),
      pathOf('web'),
    ]);
    // 결과는 개요를 열지 않아도 토스트로 보인다
    expect(useAppStore.getState().toasts.map((t) => t.title)).toEqual([RESULT.label]);
    act(() => fireEvent.click(toolbarButton(S.remote.pull, two)));
    await tick();
    expect(folderBatch).toHaveBeenLastCalledWith(FOLDER_ID, { kind: 'pull' }, [
      pathOf('api'),
      pathOf('web'),
    ]);
  });

  it('Push 는 체크 목록이다: 올라갈 commit 이 있는 저장소만 체크된 칸, 건너뛸 저장소는 같은 목록의 꺼진 칸과 사유. 취소하면 부르지 않는다', async () => {
    const { folderBatch } = await mount();
    const all = S.folder.batch.allRepos(3);
    act(() => fireEvent.click(toolbarButton(S.remote.push, all)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    expect(open.querySelector('h2')?.textContent).toBe(S.folder.batch.pushTitle);
    // 체크할 수 있는 칸은 올라갈 commit 이 있는 api 하나 (처음엔 체크됨). 건너뛸 저장소는 꺼진 빈 칸 (W19)
    const b = S.folder.batch;
    const boxes = within(open).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((x) => [x.closest('label')?.textContent, x.checked, x.disabled])).toEqual([
      [b.pushCommits('api', 3), true, false],
      [`auth${b.noUpstream}`, false, true],
      [`web${b.nothingToPush}`, false, true],
    ]);
    // 사유는 꺼진 칸의 설명이고, 목록은 "대상 저장소" 묶음 하나다. 사유 줄은 설명 글에 더는 없다
    const auth = boxes[1] as HTMLInputElement;
    expect(document.getElementById(auth.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      b.noUpstream,
    );
    expect(within(open).getByRole('group', { name: b.repoGroup(3) })).toBeTruthy();
    expect(open.querySelector('p')?.textContent).not.toContain(b.noUpstream);
    act(() => fireEvent.click(within(open).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();

    // 확인하면 체크한 저장소만 명시 목록으로 넘긴다 (빈 목록 = 전부로 보내지 않는다)
    act(() => fireEvent.click(toolbarButton(S.remote.push, all)));
    await tick();
    act(() => fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement));
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'push' }, [pathOf('api')]);
  });

  it('Push 체크를 모두 풀면 확인 단추가 꺼지고, 그래도 제출되면 부르지 않는다 (빈 목록이 "전부" 로 가지 않는다)', async () => {
    const { folderBatch } = await mount();
    act(() => fireEvent.click(toolbarButton(S.remote.push, S.folder.batch.allRepos(3))));
    await tick();
    const open = dialog() as HTMLDialogElement;
    const confirm = within(open).getByRole<HTMLButtonElement>('button', { name: S.remote.push });
    expect(confirm.disabled).toBe(false);
    for (const box of within(open).getAllByRole<HTMLInputElement>('checkbox')) {
      act(() => fireEvent.click(box));
    }
    expect(confirm.disabled).toBe(true);
    expect(within(open).getByRole('status').textContent).toBe(S.folder.batch.noneChecked);
    act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();
  });

  it('보낼 저장소가 하나도 없으면 꺼진 칸과 사유만 보이고 확인이 꺼져 있다. 제출되어도 부르지 않는다', async () => {
    const { folderBatch } = await mount();
    // auth(업스트림 없음)·web(보낼 commit 없음)만 고른다
    fireEvent.click(row('auth'));
    fireEvent.click(row('web'), { metaKey: true });
    act(() => fireEvent.click(toolbarButton(S.remote.push, S.folder.batch.selected(2))));
    await tick();
    const open = dialog() as HTMLDialogElement;
    expect(
      within(open)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((x) => [x.checked, x.disabled]),
    ).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(
      within(open).getByRole<HTMLButtonElement>('button', { name: S.remote.push }).disabled,
    ).toBe(true);
    expect(open.querySelector('p')?.textContent).toContain(S.folder.batch.pushNone);
    act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();
  });

  it('실행 중에는 세 버튼을 다시 누를 수 없고 진행을 보인다', async () => {
    let finish: (r: BatchResult) => void = () => {};
    await mount({
      folderBatch: vi.fn(
        () =>
          new Promise<BatchResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const all = S.folder.batch.allRepos(3);
    act(() => fireEvent.click(toolbarButton(S.remote.fetch, all)));
    act(() =>
      getFolderStore(FOLDER_ID)?.getState().applyEvent({
        type: 'operationStarted',
        session: FOLDER_ID,
        opId: 1,
        kind: 'batch',
        label: '일괄 fetch',
      }),
    );
    for (const op of [S.remote.fetch, S.remote.pull, S.remote.push]) {
      expect(toolbarButton(op, all).disabled, op).toBe(true);
    }
    expect(toolbar().getByRole('status').textContent).toContain('일괄 fetch');
    act(() => finish(RESULT));
    await tick();
    expect(toolbarButton(S.remote.fetch, all).disabled).toBe(false);
  });

  it('브랜치 트리 세로 툴바의 일괄 대상도 같은 집합이다', async () => {
    await mount();
    const fetch = () =>
      within(screen.getByRole('toolbar', { name: S.branches.toolbar.label })).getByRole('button', {
        name: S.branches.toolbar.fetch,
      });
    expect(fetch().getAttribute('title')).toBe(
      S.folder.batch.withScope(S.branches.toolbar.fetch, S.folder.batch.allRepos(3)),
    );
    fireEvent.click(row('auth'));
    expect(fetch().getAttribute('title')).toBe(
      S.folder.batch.withScope(S.branches.toolbar.fetch, S.folder.batch.selected(1)),
    );
  });
});

describe('개요의 일괄 작업 결과 → 토스트·작업 기록', () => {
  const DETAILED: BatchResult = {
    label: '일괄 fetch',
    results: [
      { path: pathOf('api'), name: 'api', ok: true, skipped: null, message: '' },
      { path: pathOf('web'), name: 'web', ok: false, skipped: null, message: 'fatal: x' },
    ],
    succeeded: 1,
    skipped: 0,
    failed: 1,
  };

  it('개요에서 fetch 하면 결과 목록을 남기지 않고 토스트로 알리며, 작업 기록 탭에 끝난 시각과 함께 남는다', async () => {
    await mount({ folderBatch: async () => DETAILED });
    act(() => fireEvent.click(area('editor').getByRole('button', { name: S.folder.batch.fetch })));
    await tick();
    // 개요에는 저장소별 결과가 남지 않는다 (닫기 단추도 없다)
    expect(area('editor').queryByText('fatal: x')).toBeNull();
    expect(document.querySelector('[data-panel="editor"] li[data-state]')).toBeNull();
    expect(useAppStore.getState().toasts.map((t) => [t.kind, t.title])).toEqual([
      ['error', DETAILED.label],
    ]);

    const dock = within(screen.getByRole('region', { name: S.dock.label }));
    act(() => fireEvent.click(dock.getByRole('tab', { name: S.dock.tabs.history })));
    await tick();
    const entry = getFolderStore(FOLDER_ID)?.getState().taskHistory[0];
    const panel = within(dock.getByRole('region', { name: S.folder.history.title }));
    const toggle = panel.getByRole('button', { expanded: false });
    const line = toggle.closest('li') as HTMLElement;
    expect(line.textContent).toContain(formatTime(entry?.finishedAt ?? 0));
    expect(toggle.textContent).toContain(DETAILED.label);
    expect(toggle.textContent).toContain(S.folder.batch.result(1, 0, 1));
    expect(line.getAttribute('data-failed')).toBe('true');
    act(() => fireEvent.click(toggle));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      [...line.querySelectorAll('li[data-state]')].map((li) => li.getAttribute('data-state')),
    ).toEqual(['ok', 'failed']);
    expect(panel.getByText('fatal: x')).toBeTruthy();

    // 기록 지우기: 빈 상태 안내가 보이고 단추가 꺼진다
    act(() => fireEvent.click(panel.getByRole('button', { name: S.folder.history.clear })));
    expect(panel.getByText(S.folder.history.empty)).toBeTruthy();
    expect(
      panel.getByRole<HTMLButtonElement>('button', { name: S.folder.history.clear }).disabled,
    ).toBe(true);
  });
});

describe('트리의 우클릭 메뉴 (PT-07)', () => {
  it('고른 저장소 위의 우클릭은 선택 전체가 대상이고 항목에 수를 쓴다. 선택 밖은 그 행만', async () => {
    const { folderBatch } = await mount();
    fireEvent.click(row('api'));
    fireEvent.click(row('web'), { metaKey: true });
    fireEvent.contextMenu(row('web'));
    await tick();
    const scope = S.project.menu.repos(2);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toContain(
      S.folder.batch.withScope(S.remote.fetch, scope),
    );
    act(() => fireEvent.click(screen.getByText(S.folder.batch.withScope(S.remote.fetch, scope))));
    await tick();
    expect(folderBatch).toHaveBeenLastCalledWith(FOLDER_ID, { kind: 'fetch', prune: true }, [
      pathOf('api'),
      pathOf('web'),
    ]);

    fireEvent.contextMenu(row('auth'));
    await tick();
    expect(treeSelected()).toEqual(['auth']);
    expect(screen.getByRole('menuitem', { name: S.project.openAsTab })).toBeTruthy();
    expect(screen.getByText(S.folder.batch.withScope(S.remote.pull, 'auth'))).toBeTruthy();
  });

  it('루트 메뉴의 "폴더 설정…" 이 대화상자를 연다', async () => {
    await mount();
    fireEvent.contextMenu(row('f'));
    await tick();
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.project.settings })));
    await tick();
    expect(screen.getByRole('dialog', { name: S.folder.settings.title })).toBeTruthy();
  });
});

describe('파일 상태 색 (PT-06)', () => {
  it('변경 목록을 한 번 읽어 수정·추가·충돌·untracked 를 행에 칠하고 상태 문자를 붙인다', async () => {
    await mount();
    expect(row('api').getAttribute('data-status')).toBe('modified');
    fireEvent.click(row('api'));
    await tick();
    fireEvent.click(row('src'));
    await tick();
    expect(row('src').getAttribute('data-status')).toBe('modified');
    const of = (name: string) => [
      row(name).getAttribute('data-status'),
      row(name).querySelector('[title]:last-child')?.textContent,
    ];
    expect(of('Main.java')).toEqual(['modified', 'M']);
    expect(of('New.java')).toEqual(['added', 'A']);
    expect(of('Facet.kt')).toEqual(['conflict', 'U']);
    expect(of('pom.xml')).toEqual(['untracked', '?']);
    // 변경 없는 저장소·폴더는 칠하지 않는다
    expect(row('web').getAttribute('data-status')).toBeNull();
    expect(row('docs').getAttribute('data-status')).toBeNull();
  });
});

describe('폴더 설정 대화상자 (W12)', () => {
  it('개요 탭·Project 머리줄에서 열고, 저장하고, close(Esc) 로 닫힌다', async () => {
    const { folderSettingsSet } = await mount();
    act(() =>
      fireEvent.click(area('editor').getByRole('button', { name: S.folder.settings.open })),
    );
    await tick();
    const box = screen.getByRole('dialog', { name: S.folder.settings.title });
    fireEvent.change(within(box).getByLabelText(S.folder.settings.exclude), {
      target: { value: 'auth, web' },
    });
    act(() => fireEvent.click(within(box).getByText(S.folder.settings.save)));
    await tick();
    expect(folderSettingsSet).toHaveBeenCalledWith(
      FOLDER_ID,
      expect.objectContaining({ exclude: ['auth', 'web'] }),
    );
    // 브라우저는 Esc 에서 cancel → close 를 보낸다
    act(() => {
      box.dispatchEvent(new Event('close'));
    });
    await tick();
    expect(screen.queryByRole('dialog', { name: S.folder.settings.title })).toBeNull();

    act(() => fireEvent.click(area('project').getByRole('button', { name: S.project.settings })));
    await tick();
    expect(screen.getByRole('dialog', { name: S.folder.settings.title })).toBeTruthy();
  });
});

describe('앱 툴바 새로고침·재스캔 (W12 추가)', () => {
  it('폴더 탭에서 툴바의 새로고침은 켜져 있고, 요약과 함께 펼친 파일 트리를 다시 읽는다', async () => {
    const fsListDir = vi.fn(
      async (_session: number, dir: string): Promise<FsDirListing> => ({
        kind: 'listed',
        entries: LAYOUT[dir] ?? [],
        total: LAYOUT[dir]?.length ?? 0,
        truncated: false,
        nonUtf8Names: 0,
      }),
    );
    await mount({ fsListDir });
    fireEvent.click(row('api'));
    await tick();
    fsListDir.mockClear();
    const refresh = toolbar().getByRole<HTMLButtonElement>('button', { name: S.toolbar.refresh });
    expect(refresh.disabled).toBe(false);
    act(() => fireEvent.click(refresh));
    await tick();
    expect(fsListDir.mock.calls.map((c) => c[1])).toEqual(['', 'api']);
  });

  it('재스캔으로 활성 저장소가 저장소 목록에서 빠지면 비운다. 남아 있으면 그대로다', async () => {
    await mount();
    fireEvent.click(row('web'));
    const ws = () => getWorkspaceStore(FOLDER_ID)?.getState();
    expect(ws()?.activeRepo).toBe(pathOf('web'));
    const rescanned = (names: string[]) =>
      act(() =>
        getFolderStore(FOLDER_ID)
          ?.getState()
          .applyEvent({
            type: 'folderRescanned',
            session: FOLDER_ID,
            repos: names.map((n) => ({ path: pathOf(n), kind: 'standalone' as const })),
          }),
      );
    rescanned(['api', 'web']);
    expect(ws()?.activeRepo).toBe(pathOf('web'));
    rescanned(['api', 'auth']);
    expect(ws()?.activeRepo).toBeNull();
    await tick();
  });
});
