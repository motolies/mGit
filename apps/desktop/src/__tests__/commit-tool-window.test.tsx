import type { GraphViewProps } from '@mgit/graph-view';
import {
  type BatchResult,
  createMockClient,
  type IndexWriteResult,
  type SessionId,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { revealLabel } from '../features/project/file-actions-menu';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../store';
import { DEFAULT_DOCK, type LeftTool } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { conflictDocId, createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그·터미널·홈은 jsdom 에서 그리지 않는다 (뷰 자체는 각 패키지가 테스트한다)
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // 변경 트리는 가상 스크롤이라 모든 줄이 그려지도록 높게 잡는다
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 3000 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

// 목 폴더 장면 (계획 부록 "W14 ① 에서 확정"의 확인용 저장소)
const FOLDER = '/mock/acme-platform';
const AUTH = `${FOLDER}/auth-service`;
const CATALOG = `${FOLDER}/catalog-service`;
const WEB = `${FOLDER}/web-console`;
const ORDERS = 'apps/console/src/shared/api/orders.ts';
const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 폴더 탭을 등록하고 앱 전체를 그린다. 앱 스토어·폴더 스토어의 클라이언트는 같은 목이다 */
async function mountFolder(leftTool: LeftTool = 'commit', folderOps = 0) {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0, folderOps });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  registerWorkspace(
    id,
    createWorkspaceStore('folder', {
      closeSessionDoc: (doc) => useAppStore.getState().closeRepoDiff(id, doc.repoPath),
    }),
  );
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool,
      client: mock,
      repoSessions: {},
      repoSessionOpening: {},
      toasts: [],
    }),
  );
  render(<App />);
  await tick();
  await tick();
  return { mock, id };
}

/** Commit 도구 창 영역 */
const commitArea = () => document.querySelector<HTMLElement>('[data-panel="commit"]');
/** 변경 트리에서 그 이름의 줄 */
function crow(name: string): HTMLElement {
  const area = commitArea();
  if (!area) {
    throw new Error('Commit 도구 창이 없다');
  }
  const found = within(area)
    .getAllByRole('treeitem')
    .find((r) => [...r.querySelectorAll('span')].some((s) => s.textContent === name));
  if (!found) {
    throw new Error(`줄 없음: ${name}`);
  }
  return found;
}
/** 줄의 체크 상태 (`aria-checked`) */
const checkOf = (name: string) => crow(name).getAttribute('aria-checked');
/** 줄의 체크 상자를 누른다 */
const clickCheck = (name: string) =>
  act(() => {
    fireEvent.click(crow(name).querySelector('[data-check]') as HTMLElement);
  });
/** 띠 버튼 */
const stripe = (label: string) =>
  within(
    document.querySelector('[role="toolbar"][aria-orientation="vertical"]') as HTMLElement,
  ).getByRole('button', { name: label });
/** 커밋 메시지 입력란 */
const messageBox = () =>
  within(commitArea() as HTMLElement).getByRole<HTMLTextAreaElement>('textbox', {
    name: S.commitTool.message,
  });
/** 커밋 버튼 */
const commitButton = () =>
  within(commitArea() as HTMLElement).getByRole<HTMLButtonElement>('button', {
    name: S.commitTool.commit,
  });
/** 키를 누른다 (앱은 window 에서 받는다) */
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  (globalThis as { __mgitMockBatches?: unknown[] }).__mgitMockBatches = [];
});

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      repoSessions: {},
      repoSessionOpening: {},
      client: originalClient,
      toasts: [],
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('Commit 도구 창 자리 (WS-05, ⌘0)', () => {
  it('⌘0·띠 버튼으로 Project 자리에 번갈아 뜨고, 메시지 초안은 도구 창을 바꿔도 남는다', async () => {
    await mountFolder('project');
    expect(commitArea()).toBeNull();
    expect(document.querySelector('[data-panel="project"]')).not.toBeNull();
    press('0', MOD);
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(commitArea()).not.toBeNull();
    expect(document.querySelector('[data-panel="project"]')).toBeNull();
    expect(stripe(S.commitTool.title).getAttribute('aria-pressed')).toBe('true');

    act(() => fireEvent.change(messageBox(), { target: { value: 'fix: 주문 내보내기' } }));
    act(() => fireEvent.click(stripe(S.project.title)));
    await tick();
    expect(commitArea()).toBeNull();
    act(() => fireEvent.click(stripe(S.commitTool.title)));
    await tick();
    expect(messageBox().value).toBe('fix: 주문 내보내기');
    // 띠 버튼을 다시 누르면 접힌다
    act(() => fireEvent.click(stripe(S.commitTool.title)));
    expect(useAppStore.getState().leftTool).toBeNull();
  });

  it('폴더 탭의 띠에는 Pull Requests 단추가 없다. 저장된 값이 Pull Requests(저장소 탭 전용, W24)여도 Project 가 보이고 Project 단추로 접힌다', async () => {
    await mountFolder('pullRequests');
    const labels = within(
      document.querySelector('[role="toolbar"][aria-orientation="vertical"]') as HTMLElement,
    )
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([S.project.title, S.commitTool.title, S.dock.git, S.terminal.title]);
    expect(document.querySelector('[data-panel="project"]')).not.toBeNull();
    expect(document.querySelector('[data-panel="pull-requests"]')).toBeNull();
    expect(stripe(S.project.title).getAttribute('aria-pressed')).toBe('true');
    // 저장된 값은 그대로 (PR 이 있는 저장소 탭으로 가면 다시 PR)
    expect(useAppStore.getState().leftTool).toBe('pullRequests');
    act(() => fireEvent.click(stripe(S.project.title)));
    expect(useAppStore.getState().leftTool).toBeNull();
    expect(stripe(S.project.title).getAttribute('aria-pressed')).toBe('false');
    // Commit 도구 창(폴더 모드)은 그대로 열린다
    act(() => fireEvent.click(stripe(S.commitTool.title)));
    await tick();
    expect(commitArea()).not.toBeNull();
    expect(commitArea()?.querySelector('header')?.textContent).toBe(S.commitTool.title);
  });

  it('폴더 모드에는 탭이 없다: 머리는 제목과 도구 단추뿐이고 내용은 변경 트리·커밋 영역 그대로 (W23 의 변경 | Stash 는 저장소 탭만)', async () => {
    // 저장소 탭에서 Stash 탭을 보다 와도 폴더 탭은 같은 모양이다 (탭 상태는 앱 전역이지만 폴더 모드는 보지 않는다)
    act(() => useAppStore.getState().setCommitTab('stash'));
    await mountFolder('commit');
    const area = within(commitArea() as HTMLElement);
    expect(area.queryByRole('tablist')).toBeNull();
    expect(area.queryByRole('tab')).toBeNull();
    expect(area.queryByRole('tabpanel')).toBeNull();
    const header = commitArea()?.querySelector('header');
    expect(header?.textContent).toBe(S.commitTool.title);
    expect(
      within(header as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([S.commitTool.expandAll, S.commitTool.collapseAll, S.commitTool.refresh]);
    expect(area.getByRole('tree', { name: S.commitTool.tree })).toBeTruthy();
    expect(messageBox()).toBeTruthy();
    expect(area.queryByRole('listbox', { name: S.stash.list })).toBeNull();
    act(() => useAppStore.getState().setCommitTab('changes'));
  });

  it('개요 탭의 "변경" 보기는 없고 Commit 도구 창을 여는 진입점이 있다 (FolderChanges 이전)', async () => {
    await mountFolder('project');
    const editor = within(document.querySelector('[data-panel="editor"]') as HTMLElement);
    // W17: 보기 전환이 없다 (커밋 검색은 로그 필터 바로 옮겼다). 옛 통합 변경 보기의 커밋 입력란·검색 칸도 없다
    expect(editor.getByRole('table')).toBeTruthy();
    expect(editor.queryByRole('textbox')).toBeNull();
    act(() => fireEvent.click(editor.getByRole('button', { name: S.folder.openCommitTool })));
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(commitArea()).not.toBeNull();
  });
});

describe('세 상태 체크 = git index (W14)', () => {
  it('web-console 에 체크·중간·빔이 모두 보이고 저장소·폴더 줄이 아래를 모은다. 변경이 있는 저장소만 나온다', async () => {
    await mountFolder();
    expect(checkOf('OrderTable.tsx')).toBe('true');
    expect(checkOf('StatusFilter.tsx')).toBe('mixed');
    expect(checkOf('orders.ts')).toBe('false');
    expect(checkOf('Table.stories.tsx')).toBe('false');
    expect(checkOf('filters')).toBe('mixed');
    expect(checkOf('web-console')).toBe('mixed');
    expect(checkOf('shared')).toBe('false');
    // 저장소 줄: 브랜치·파일 수. 변경 없는 저장소(api-gateway)·요약 실패로 목록에 없는 저장소는 줄이 없다
    expect(crow('web-console').textContent).toContain('staging');
    expect(crow('web-console').textContent).toContain(S.commitTool.files(8));
    const repos = within(commitArea() as HTMLElement)
      .getAllByRole('treeitem')
      .filter((r) => r.getAttribute('data-kind') === 'repo')
      .map(
        (r) =>
          [...r.querySelectorAll('span')].find((s) => s.getAttribute('title')?.startsWith(FOLDER))
            ?.textContent,
      );
    expect(repos).toEqual([
      'auth-service',
      'catalog-service',
      'design-system-hotfix',
      'web-console',
    ]);
    // 진행 중 작업은 저장소 줄에 보인다
    expect(crow('catalog-service').textContent).toContain(S.project.rebasing);
  });

  it('파일 체크 → 그 저장소·그 경로로 stage 하고, 다시 읽은 값으로 체크가 채워지며 상위가 따라간다. 해제는 unstage', async () => {
    const { mock, id } = await mountFolder();
    const stage = vi.spyOn(mock, 'folderStage');
    const unstage = vi.spyOn(mock, 'folderUnstage');
    clickCheck('orders.ts');
    await tick();
    expect(stage).toHaveBeenCalledWith(id, WEB, { kind: 'paths', paths: [ORDERS] });
    expect(checkOf('orders.ts')).toBe('true');
    expect(checkOf('api')).toBe('true');
    expect(checkOf('shared')).toBe('mixed');

    clickCheck('orders.ts');
    await tick();
    expect(unstage).toHaveBeenCalledWith(id, WEB, { kind: 'paths', paths: [ORDERS] });
    expect(checkOf('orders.ts')).toBe('false');
  });

  it('이름이 바뀐 파일의 해제는 새 경로와 옛 경로를 함께 보내고, 폴더 줄은 그 디렉터리, 저장소 줄은 전부다', async () => {
    const { mock, id } = await mountFolder();
    const stage = vi.spyOn(mock, 'folderStage');
    const unstage = vi.spyOn(mock, 'folderUnstage');
    clickCheck('OrderExport.tsx');
    await tick();
    expect(unstage).toHaveBeenCalledWith(id, WEB, {
      kind: 'paths',
      paths: [
        'apps/console/src/pages/orders/OrderExport.tsx',
        'apps/console/src/pages/orders/Export.tsx',
      ],
    });
    clickCheck('filters');
    await tick();
    expect(stage).toHaveBeenLastCalledWith(id, WEB, {
      kind: 'paths',
      paths: ['apps/console/src/pages/orders/filters'],
    });
    expect(checkOf('filters')).toBe('true');
    clickCheck('web-console');
    await tick();
    expect(stage).toHaveBeenLastCalledWith(id, WEB, { kind: 'all' });
    expect(checkOf('web-console')).toBe('true');
    // 어떤 호출도 빈 경로 목록을 보내지 않았다
    for (const call of [...stage.mock.calls, ...unstage.mock.calls]) {
      const target = call[2];
      expect(target.kind === 'all' || target.paths.length > 0).toBe(true);
    }
  });

  it('충돌 파일은 체크할 수 없다 (호출 없음, 사유 툴팁·⚠). 누르면 그 저장소의 머지 편집기 탭을 연다 (W15)', async () => {
    const { mock, id } = await mountFolder();
    const stage = vi.spyOn(mock, 'folderStage');
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    const conflict = crow('FacetBuilder.kt');
    expect(conflict.getAttribute('aria-checked')).toBe('false');
    const box = conflict.querySelector('[data-check]') as HTMLElement;
    expect(box.getAttribute('data-disabled')).toBe('true');
    expect(box.getAttribute('title')).toBe(S.commitTool.conflictFile);
    expect(within(conflict).getByRole('img', { name: S.commitTool.conflictFile })).toBeTruthy();
    clickCheck('FacetBuilder.kt');
    await tick();
    expect(stage).not.toHaveBeenCalled();
    act(() => fireEvent.click(conflict));
    await tick();
    await tick();
    // W14 에서는 안내만 했다. W15 부터 그 저장소 세션을 열어 충돌 탭을 보인다
    expect(open).toHaveBeenCalledWith(id, CATALOG, expect.any(Function));
    expect(getWorkspaceStore(id)?.getState().activeDocId).toBe(conflictDocId(CATALOG));
  });

  it('충돌 파일을 품은 폴더를 누르면 충돌만 빼고 쓰고, 건너뛴 것을 알린다', async () => {
    const { mock, id } = await mountFolder();
    const unstage = vi.spyOn(mock, 'folderUnstage');
    // 충돌을 빼면 stage 된 두 파일뿐이라 체크 상태다 → 누르면 unstage
    expect(checkOf('src/search')).toBe('true');
    clickCheck('src/search');
    await tick();
    expect(unstage).toHaveBeenCalledWith(id, CATALOG, { kind: 'paths', paths: ['src/search'] });
    expect(checkOf('src/search')).toBe('false');
    expect(checkOf('FacetBuilder.kt')).toBe('false');
    const toast = useAppStore.getState().toasts.at(-1);
    expect(toast?.title).toBe(S.commitTool.skipped('catalog-service', 1));
    expect(toast?.message).toBe('src/search/facets/FacetBuilder.kt');
  });

  it('호출이 도는 동안 그 줄은 "처리 중" 이고 같은 저장소의 체크는 막힌다. 실패하면 사유를 알리고 표시는 그대로다', async () => {
    const { mock } = await mountFolder();
    let fail: (e: unknown) => void = () => {};
    const stage = vi.spyOn(mock, 'folderStage').mockImplementation(
      () =>
        new Promise<IndexWriteResult>((_resolve, reject) => {
          fail = reject;
        }),
    );
    clickCheck('orders.ts');
    await tick();
    expect(crow('orders.ts').getAttribute('aria-busy')).toBe('true');
    expect(crow('orders.ts').textContent).toContain(S.commitTool.processing);
    // 같은 저장소의 다른 줄은 막히고(툴팁이 사유) 눌러도 부르지 않는다
    const other = crow('ko.json').querySelector('[data-check]') as HTMLElement;
    expect(other.getAttribute('title')).toBe(S.commitTool.repoBusy);
    clickCheck('ko.json');
    expect(stage).toHaveBeenCalledTimes(1);
    // 다른 저장소는 막히지 않는다
    expect(
      crow('rate-limit.yaml').querySelector('[data-check]')?.getAttribute('data-disabled'),
    ).toBeNull();

    await act(async () => {
      fail({ kind: 'gitFailed', args: ['add'], stderr: 'fatal: boom', status: 128 });
    });
    await tick();
    expect(crow('orders.ts').getAttribute('aria-busy')).toBeNull();
    expect(checkOf('orders.ts')).toBe('false');
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe(
      S.commitTool.writeFailed('web-console'),
    );
  });

  it('키보드: Space = 체크, Enter = 열기 (트리가 포커스를 받는다)', async () => {
    const { mock, id } = await mountFolder();
    const stage = vi.spyOn(mock, 'folderStage');
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    const tree = within(commitArea() as HTMLElement).getByRole('tree', { name: S.commitTool.tree });
    act(() => tree.focus());
    act(() => fireEvent.keyDown(tree, { key: 'Home' }));
    // 맨 위 줄 = auth-service (중간) → Space 로 전부 stage
    act(() => fireEvent.keyDown(tree, { key: ' ' }));
    await tick();
    expect(stage).toHaveBeenCalledWith(id, AUTH, { kind: 'all' });
    // 맨 아래 줄(파일)에서 Enter → 그 저장소 세션으로 diff 를 연다
    act(() => fireEvent.keyDown(tree, { key: 'End' }));
    act(() => fireEvent.keyDown(tree, { key: 'Enter' }));
    await tick();
    expect(open).toHaveBeenCalledWith(id, WEB, expect.any(Function));
  });
});

describe('커밋 영역 (W14)', () => {
  it('누르기 전에 대상과 커밋되지 않을 저장소를 보이고, 메시지가 비면 버튼이 꺼진다', async () => {
    await mountFolder();
    const area = within(commitArea() as HTMLElement);
    // auth(A, MM) 2개 + web(M, R, A, MM) 4개. catalog 는 stage 된 것이 있지만 rebase 중이라 커밋되지 않는다
    expect(area.getByText(S.commitTool.targets(2, 6))).toBeTruthy();
    expect(
      area.getByText(S.commitTool.skipLine('catalog-service', S.commitTool.skip.inProgress)),
    ).toBeTruthy();
    expect(commitButton().disabled).toBe(true);
    expect(commitButton().getAttribute('title')).toBe(S.commitTool.noMessage);
    act(() => fireEvent.change(messageBox(), { target: { value: 'feat: x' } }));
    expect(commitButton().disabled).toBe(false);
  });

  it('커밋되지 않을 저장소가 여럿이면 한 줄로 접히고, 툴팁·펼치기로 저장소별 사유를 누르기 전에 본다 (W19)', async () => {
    // 조절값 3: catalog(rebase) 에 더해 billing(merge)·design-system(cherry-pick)·api-gateway(revert) 가 진행 중이다.
    // stage 된 것이 있어 커밋되지 않을 저장소는 billing·catalog·design-system 셋이다
    await mountFolder('commit', 3);
    const area = within(commitArea() as HTMLElement);
    const t = S.commitTool;
    const toggle = area.getByRole('button', { name: new RegExp(`^${t.skippedSummary(3)}`) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(area.queryByRole('list', { name: t.skippedLabel })).toBeNull();
    // 접혀 있어도 툴팁에 저장소별 사유가 다 있다
    const lines = ['billing-service', 'catalog-service', 'design-system'].map((name) =>
      t.skipLine(name, t.skip.inProgress),
    );
    for (const line of lines) {
      expect(toggle.getAttribute('title')).toContain(line);
    }
    // 누르면 떠 있는 창에 저장소별 사유가 펼쳐진다 (낮은 칸에서도 단추 줄을 밀어내지 않는다)
    expect(toggle.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => fireEvent.click(toggle));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const popup = screen.getByRole('dialog', { name: t.skippedLabel });
    const list = within(popup).getByRole('list', { name: t.skippedLabel });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(lines);
    // 커밋 단추는 그대로 있다
    expect(commitButton()).toBeTruthy();
    // Esc 로 닫으면 포커스가 접힌 줄로 돌아온다
    act(() => {
      fireEvent.keyDown(popup, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog', { name: t.skippedLabel })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    // 다시 누르면 열리고, 한 번 더 누르면 닫힌다
    act(() => fireEvent.click(toggle));
    expect(screen.getByRole('dialog', { name: t.skippedLabel })).toBeTruthy();
    act(() => fireEvent.click(toggle));
    expect(screen.queryByRole('dialog', { name: t.skippedLabel })).toBeNull();
  });

  it('변경 목록 | 커밋 영역은 끌어 조절하는 분할이고, 저장된 크기로 다시 그린다 (W19)', async () => {
    // 저장 키는 앱 전역 1벌 (`react-resizable-panels:commit-tool`)
    localStorage.setItem(
      'react-resizable-panels:commit-tool',
      JSON.stringify({ 'commit-changes': 40, 'commit-message': 60 }),
    );
    await mountFolder();
    const area = commitArea() as HTMLElement;
    expect(within(area).getByRole('separator', { name: S.commitTool.resize })).toBeTruthy();
    const changes = document.getElementById('commit-changes') as HTMLElement;
    const message = document.getElementById('commit-message') as HTMLElement;
    // 위 칸에 변경 트리, 아래 칸에 커밋 영역
    expect(within(changes).getByRole('tree', { name: S.commitTool.tree })).toBeTruthy();
    expect(within(message).getByRole('textbox', { name: S.commitTool.message })).toBeTruthy();
    expect(changes.style.flexGrow).toBe('40');
    expect(message.style.flexGrow).toBe('60');
  });

  it('⌘Enter 로 커밋: 표시한 저장소의 명시 목록·stage 된 것만. 다시 읽은 뒤 커밋된 줄이 빠지고 메시지가 빈다', async () => {
    const { mock, id } = await mountFolder();
    const commit = vi.spyOn(mock, 'folderCommit');
    act(() => fireEvent.change(messageBox(), { target: { value: 'feat: 주문' } }));
    act(() => {
      fireEvent.keyDown(messageBox(), { key: 'Enter', ...MOD });
    });
    await tick();
    await tick();
    expect(commit).toHaveBeenCalledWith(id, [AUTH, WEB], 'feat: 주문', false);
    expect(messageBox().value).toBe('');
    // stage 됐던 줄은 사라지고 작업 트리 쪽만 남는다 (StatusFilter 는 작업 트리 변경이 남아 빔)
    expect(() => crow('OrderTable.tsx')).toThrow();
    expect(checkOf('StatusFilter.tsx')).toBe('false');
    // 앞섬이 오른 요약 (프로젝트 트리·상태 바가 쓰는 값)
    const auth = getFolderStore(id)
      ?.getState()
      .summaries.find((s) => s.path === AUTH);
    expect(auth?.ahead).toBe(4);
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('일괄 commit');
  });

  it('건너뛰거나 실패한 저장소가 있으면 메시지를 남긴다', async () => {
    const { mock } = await mountFolder();
    const partial: BatchResult = {
      label: '일괄 commit',
      results: [
        { path: AUTH, name: 'auth-service', ok: true, skipped: null, message: '' },
        { path: WEB, name: 'web-console', ok: false, skipped: null, message: 'hook 실패' },
      ],
      succeeded: 1,
      skipped: 0,
      failed: 1,
    };
    vi.spyOn(mock, 'folderCommit').mockResolvedValue(partial);
    act(() => fireEvent.change(messageBox(), { target: { value: 'feat: y' } }));
    act(() => fireEvent.click(commitButton()));
    await tick();
    expect(messageBox().value).toBe('feat: y');
    expect(useAppStore.getState().toasts.at(-1)?.kind).toBe('error');
  });

  it('Commit and Push… 는 커밋된 저장소로 push 체크 목록을 연다 (오른 앞섬으로)', async () => {
    const { mock, id } = await mountFolder();
    const batch = vi.spyOn(mock, 'folderBatch');
    act(() => fireEvent.change(messageBox(), { target: { value: 'feat: z' } }));
    act(() =>
      fireEvent.click(
        within(commitArea() as HTMLElement).getByRole('button', {
          name: S.commitTool.commitAndPush,
        }),
      ),
    );
    await tick();
    await tick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;
    expect(dialog.querySelector('h2')?.textContent).toBe(S.folder.batch.pushTitle);
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .map((b) => b.closest('label')?.textContent),
    ).toEqual([
      S.folder.batch.pushCommits('auth-service', 4),
      S.folder.batch.pushCommits('web-console', 2),
    ]);
    act(() => fireEvent.submit(dialog.querySelector('form') as HTMLFormElement));
    await tick();
    expect(batch).toHaveBeenCalledWith(id, { kind: 'push' }, [AUTH, WEB]);
  });

  it('커밋하는 동안 체크와 버튼이 막힌다', async () => {
    const { mock } = await mountFolder();
    let finish: (r: BatchResult) => void = () => {};
    vi.spyOn(mock, 'folderCommit').mockImplementation(
      () =>
        new Promise<BatchResult>((resolve) => {
          finish = resolve;
        }),
    );
    const stage = vi.spyOn(mock, 'folderStage');
    act(() => fireEvent.change(messageBox(), { target: { value: 'feat: w' } }));
    act(() => fireEvent.click(commitButton()));
    await tick();
    expect(
      within(commitArea() as HTMLElement).getByRole<HTMLButtonElement>('button', {
        name: S.commitTool.committing,
      }).disabled,
    ).toBe(true);
    const box = crow('orders.ts').querySelector('[data-check]') as HTMLElement;
    expect(box.getAttribute('title')).toBe(S.commitTool.committingLock);
    clickCheck('orders.ts');
    expect(stage).not.toHaveBeenCalled();
    await act(async () => {
      finish({ label: '일괄 commit', results: [], succeeded: 0, skipped: 0, failed: 0 });
    });
    await tick();
  });
});

describe('Commit 도구 창 → 작업 트리 diff 탭 (ED-05)', () => {
  it('파일을 누르면 그 저장소 세션으로 diff 탭을 연다 (작업 트리 쪽). 체크된 파일은 staged 쪽', async () => {
    const { mock, id } = await mountFolder();
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    const diff = vi.spyOn(mock, 'workTreeDiff');
    act(() => fireEvent.click(crow('orders.ts')));
    await tick();
    expect(open).toHaveBeenCalledWith(id, WEB, expect.any(Function));
    expect(diff).toHaveBeenLastCalledWith(
      expect.any(Number),
      ORDERS,
      false,
      false,
      expect.anything(),
    );
    const ws = getWorkspaceStore(id)?.getState();
    expect(ws?.activeDocId).toBe(`worktreeDiff:${WEB}`);
    act(() => fireEvent.click(crow('OrderTable.tsx')));
    await tick();
    expect(diff).toHaveBeenLastCalledWith(
      expect.any(Number),
      'apps/console/src/pages/orders/OrderTable.tsx',
      true,
      false,
      expect.anything(),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('Commit 도구 창 파일 메뉴 (Finder·터미널·변경 되돌리기)', () => {
  /** 열린 메뉴 항목의 이름 (구분선은 `─` 를 앞에 붙인다) */
  const menuLabels = () => screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');

  it('파일: 열기·저장소 탭 뒤에 변경 되돌리기와 Finder·터미널. 되돌리기는 파일 목록 확인창 → 그 저장소 세션으로 Rollback', async () => {
    const { mock } = await mountFolder();
    // Finder·터미널은 앱 스토어가 만들 때 받은 클라이언트로 부른다
    const reveal = vi.spyOn(originalClient, 'openExternal').mockResolvedValue();
    const rollback = vi.spyOn(mock, 'rollbackPaths');
    fireEvent.contextMenu(crow('orders.ts'));
    await tick();
    const m = S.project.menu;
    expect(menuLabels()).toEqual([
      m.open,
      S.project.openAsTab,
      m.rollback,
      revealLabel(),
      S.actions.openTerminal,
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: revealLabel() }));
    await tick();
    expect(reveal).toHaveBeenCalledWith('reveal', `${WEB}/${ORDERS}`);

    fireEvent.contextMenu(crow('orders.ts'));
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: m.rollback }));
    await tick();
    const dialog = screen.getByRole('dialog', { name: m.rollbackTitle });
    expect(dialog.textContent).toContain(ORDERS);
    expect(dialog.textContent).toContain(m.rollbackMessage(1));
    fireEvent.click(within(dialog).getByRole('button', { name: m.rollbackConfirm }));
    await tick();
    await tick();
    expect(rollback).toHaveBeenCalledWith(expect.any(Number), [ORDERS]);
    // 목은 상태에서 그 항목을 빼고 폴더 변경 알림을 낸다 → 폴더 스토어가 (디바운스 뒤) 다시 읽어 변경 트리에서 사라진다
    await vi.waitFor(() => expect(() => crow('orders.ts')).toThrow(), { timeout: 2000 });
  });

  it('확인창에서 취소하면 부르지 않고, 저장소 줄은 저장소 탭 열기 뒤 Finder·터미널', async () => {
    const { mock } = await mountFolder();
    const rollback = vi.spyOn(mock, 'rollbackPaths');
    const terminal = vi.spyOn(originalClient, 'openExternal').mockResolvedValue();
    fireEvent.contextMenu(crow('orders.ts'));
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.project.menu.rollback }));
    await tick();
    const dialog = screen.getByRole('dialog', { name: S.project.menu.rollbackTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: S.confirm.cancel }));
    await tick();
    expect(rollback).not.toHaveBeenCalled();
    expect(crow('orders.ts')).toBeTruthy();

    fireEvent.contextMenu(crow('web-console'));
    await tick();
    expect(menuLabels()).toEqual([S.project.openAsTab, revealLabel(), S.actions.openTerminal]);
    fireEvent.click(screen.getByRole('menuitem', { name: S.actions.openTerminal }));
    await tick();
    expect(terminal).toHaveBeenCalledWith('terminal', WEB);
  });
});
