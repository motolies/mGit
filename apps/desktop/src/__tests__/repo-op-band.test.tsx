// W21 ②: 저장소 탭의 작업 진행 띠(WS-18)와 Commit 도구 창 연동(WS-19). 앱 전체를 그려 확인한다.
// - 띠: 툴바 아래, 에디터 문서·콘솔·도구 창 숨김·최대화와 무관하게 보인다. 그래프 위 배너는 없다.
// - 격리 병합 줄: 옛 사이드바 격리 병합 띠의 단언을 옮겼다 (`review-ui.test.tsx` "사이드바 격리 병합·백업").
// - 충돌이 생기면 Commit 도구 창을 한 번 연다 (결정 15번). WIP 행 클릭 → Commit 도구 창.

import type { GraphViewProps } from '@mgit/graph-view';
import {
  createMockClient,
  GraphRangeCache,
  type InProgressOp,
  type SessionId,
  type StatusEntry,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { opSlotColumn } from '../features/workspace/op-band';
import { getFolderStore, getSessionStore, getWorkspaceStore, useAppStore } from '../store';
import {
  createRepoWorkspace,
  DEFAULT_DOCK,
  type DockState,
  type LeftTool,
  sessionRevealHooks,
} from '../store/app-store';
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
import { conflictDocId, createWorkspaceStore, worktreeDiffDocId } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const h = vi.hoisted(() => ({ graph: null as GraphViewProps | null }));

// 그래프 뷰는 그리지 않고 받은 props 만 남긴다 (WIP 행 활성화를 그 콜백으로 부른다). 터미널·홈도 그리지 않는다
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (props: GraphViewProps) => {
    h.graph = props;
    return <div data-testid="graph-view" />;
  },
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

// 목 장면: 저장소 장면(storefront-web, 작업 없음)과 충돌 장면(checkout-service, merge 중 충돌 2개)
const REPO = '/mock/storefront-web';
const CONFLICT_REPO = '/mock/checkout-service';
const PAY = 'src/features/checkout/steps/PaymentStep.tsx';
// 폴더 장면 (탭 둘·폴더 탭 확인용)
const FOLDER = '/mock/acme-platform';
const API = `${FOLDER}/api-gateway`;
const WEB = `${FOLDER}/web-console`;
const CATALOG = `${FOLDER}/catalog-service`;
const FACET = 'src/search/facets/FacetBuilder.kt';

const originalClient = useAppStore.getState().client;
const originalCloseSession = useAppStore.getState().closeSession;
let mounted: SessionId[] = [];

/** 저장소 탭 하나를 `openRepositoryAt` 처럼 등록한다 (세션 스토어 + "보여라" 훅 + 저장소 워크스페이스) */
async function addRepoTab(mock: ReturnType<typeof createMockClient>, path: string) {
  const opened = await mock.openRepo(path, () => {});
  const id = opened.session;
  mounted.push(id);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(
    opened,
    mock,
    cache,
    sessionRevealHooks(useAppStore.getState, id),
  );
  // 그래프는 다 읽은 것으로 둔다 (이 시험은 그래프 로드 이벤트를 잇지 않는다)
  store.setState({ loadState: 'complete', totalRows: 60 });
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { id, store, meta: { id, kind: 'repo' as const, path, name, parent: null } };
}

/** 저장소 탭 하나를 열고 앱 전체를 그린다. 아래 도구 창은 Git 로그 탭 */
async function mountRepo(
  scene: 'repo' | 'conflict' = 'repo',
  init: { leftTool?: LeftTool | null; dock?: DockState } = {},
) {
  const mock = createMockClient({ rows: 60, scene, progressIntervalMs: 0 });
  const tab = await addRepoTab(mock, scene === 'repo' ? REPO : CONFLICT_REPO);
  act(() =>
    useAppStore.setState({
      sessions: { [tab.id]: tab.meta },
      sessionOrder: [tab.id],
      activeSessionId: tab.id,
      dock: init.dock ?? DEFAULT_DOCK,
      leftTool: init.leftTool === undefined ? 'project' : init.leftTool,
      client: mock,
      conflictLeave: null,
    }),
  );
  render(<App />);
  await tick();
  const st = () => tab.store.getState();
  return {
    mock,
    id: tab.id,
    store: tab.store,
    st,
    ws: () => getWorkspaceStore(tab.id)?.getState(),
  };
}

/** 충돌 파일 하나 */
const conflictEntry = (path: string): StatusEntry => ({
  path,
  origPath: null,
  index: 'unmerged',
  worktree: 'unmerged',
  submodule: null,
  conflict: 'bothModified',
  renameScore: null,
});

/**
 * 세션의 충돌 수를 바꾼다 (코어의 `statusChanged` 가 하는 것처럼 상태 목록·요약·진행 중 작업을 함께). 0 이면 충돌 파일을
 * 빼고 작업도 끝난 것으로 둔다
 */
function setConflicts(
  store: ReturnType<typeof createSessionStore>,
  n: number,
  op: InProgressOp | null = n > 0 ? { kind: 'merge', head: 'x' } : null,
) {
  const status = store.getState().status;
  const others = status.entries.filter((e) => !e.conflict);
  const conflicts = Array.from({ length: n }, (_, i) => conflictEntry(`src/conflict-${i}.ts`));
  act(() =>
    store.setState({
      op,
      status: {
        ...status,
        entries: [...conflicts, ...others],
        summary: { ...status.summary, conflicted: n },
      },
    }),
  );
}

/** 작업 진행 띠 */
const band = () => screen.queryByRole('region', { name: S.opBand.label });
/** 띠의 줄들 */
const bandRows = () => [...(band()?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])];
/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 왼쪽 도구 창 */
const leftTool = () => useAppStore.getState().leftTool;

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  h.graph = null;
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
      closeSession: originalCloseSession,
      toasts: [],
      conflictLeave: null,
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('저장소 탭의 작업 진행 띠 (WS-18)', () => {
  it('진행 중인 작업이 있으면 툴바 바로 아래 띠에 한 줄: 라벨·충돌 수·안내·충돌 해결·Continue(꺼짐과 사유)·Abort. 그래프 위 배너는 없다', async () => {
    await mountRepo('conflict');
    const region = band() as HTMLElement;
    expect(region).not.toBeNull();
    // 툴바(첫 header) 바로 다음 형제
    expect(region.previousElementSibling).toBe(document.querySelector('header'));
    const rows = bandRows();
    expect(rows).toHaveLength(1);
    const row = within(rows[0] as HTMLElement);
    expect(row.getByText(S.status.op.merge)).toBeTruthy();
    expect(row.getByRole('button', { name: S.opBand.conflicts(2) })).toBeTruthy();
    expect(row.getByText(S.op.conflicts(2))).toBeTruthy();
    expect(row.getByRole('button', { name: S.opBand.resolve }).title).toBe(S.opBand.resolveMany(2));
    const cont = row.getByRole('button', { name: S.op.continueLabel }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(cont.parentElement?.title).toBe(S.opBand.continueBlocked(2));
    // merge 는 Skip 이 없다
    expect(row.queryByRole('button', { name: S.op.skip })).toBeNull();
    expect(row.getByRole('button', { name: S.op.abort })).toBeTruthy();
    // 저장소 이름 칸은 없다 (탭이 그 저장소다)
    expect(rows[0]?.querySelector('[data-slot="subject"]')).toBeNull();
    // 그래프(로그 칸)에는 같은 배너가 없다 — 중복 없음
    expect(within(area('git-log') as HTMLElement).queryByRole('group')).toBeNull();
    expect(within(area('git-log') as HTMLElement).getByTestId('graph-view')).toBeTruthy();
  });

  it('진행 중인 작업이 없으면 띠가 없다 (자리를 차지하지 않는다). 작업이 생기면 나타나고 끝나면 사라진다', async () => {
    const { store } = await mountRepo('repo');
    expect(band()).toBeNull();
    setConflicts(store, 1);
    expect(bandRows()).toHaveLength(1);
    setConflicts(store, 0);
    expect(band()).toBeNull();
  });

  it('에디터에 충돌·diff 탭이 떠 있어도, 콘솔 탭·도구 창 숨김·최대화에서도 띠가 보인다', async () => {
    const { st, ws } = await mountRepo('conflict');
    await act(async () => {
      await st().openConflict(PAY);
    });
    await tick();
    expect(ws()?.activeDocId).toBe(conflictDocId(CONFLICT_REPO));
    expect(bandRows()).toHaveLength(1);
    await act(async () => {
      await st().openFile('src/features/checkout/CheckoutPage.tsx', true);
    });
    await tick();
    expect(ws()?.activeDocId).toBe(worktreeDiffDocId(CONFLICT_REPO));
    expect(bandRows()).toHaveLength(1);
    // 콘솔 탭: 로그(그래프)가 내려가도 띠는 남는다
    act(() => useAppStore.getState().toggleDock('git', 'console'));
    await tick();
    expect(area('git-log')).toBeNull();
    expect(bandRows()).toHaveLength(1);
    // 숨김
    act(() => useAppStore.getState().hideDock());
    await tick();
    expect(bandRows()).toHaveLength(1);
    // 최대화
    act(() => useAppStore.getState().toggleDock('git', 'log'));
    act(() => useAppStore.getState().setDockMaximized(true));
    await tick();
    expect(useAppStore.getState().dock.maximized).toBe(true);
    expect(bandRows()).toHaveLength(1);
  });

  it('그래프 로드 상태와 무관하다: 그래프를 여는 중·실패여도 세션의 작업을 보인다', async () => {
    const { store } = await mountRepo('conflict');
    act(() => store.setState({ loadState: 'opening' }));
    await tick();
    expect(screen.getByText(S.panel.graphLoading)).toBeTruthy();
    expect(bandRows()).toHaveLength(1);
    act(() => store.setState({ loadState: 'error', error: '실패' }));
    await tick();
    expect(bandRows()).toHaveLength(1);
  });

  it('Continue·Skip·Abort 는 그 탭의 세션에 간다. Abort 는 저장소 탭 문구의 확인창 뒤', async () => {
    const { mock, id, store } = await mountRepo('conflict');
    const cont = vi.spyOn(mock, 'opContinue');
    const skip = vi.spyOn(mock, 'opSkip');
    const abort = vi.spyOn(mock, 'opAbort');
    // 충돌을 모두 풀면 Continue 가 켜진다
    setConflicts(store, 0, { kind: 'merge', head: 'x' });
    const row = () => within(bandRows()[0] as HTMLElement);
    expect(row().getByText(S.op.noConflicts)).toBeTruthy();
    const continueButton = row().getByRole('button', {
      name: S.op.continueLabel,
    }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);
    await tick();
    expect(cont).toHaveBeenCalledWith(id, false);
    // rebase 면 Skip 이 있다
    act(() =>
      store.setState({
        op: { kind: 'rebase', interactive: false, headName: null, onto: null, step: 2, total: 5 },
      }),
    );
    await tick();
    expect(row().getByText(S.status.op.rebase(3, 5))).toBeTruthy();
    fireEvent.click(row().getByRole('button', { name: S.op.skip }));
    await tick();
    expect(skip).toHaveBeenCalledWith(id);
    // Abort: 저장소 탭 문구의 확인창 → 확인하면 그 세션에
    fireEvent.click(row().getByRole('button', { name: S.op.abort }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.op.abortTitle);
    expect(abort).not.toHaveBeenCalled();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(abort).toHaveBeenCalledWith(id);
  });

  it('충돌 수·충돌 해결: 충돌 파일이 여럿이면 Commit 도구 창(최대화를 풀고 그 영역으로 포커스), 하나면 그 파일의 충돌 탭', async () => {
    const { st, store, ws } = await mountRepo('conflict', {
      leftTool: 'project',
      dock: { tool: 'git', maximized: true, gitTab: 'log' },
    });
    // 탭을 열 때 한 번 열린 Commit 도구 창(자동 활성화)을 Project 로 돌려 둔다
    act(() => useAppStore.getState().setLeftTool('project'));
    await tick();
    const row = () => within(bandRows()[0] as HTMLElement);
    fireEvent.click(row().getByRole('button', { name: S.opBand.conflicts(2) }));
    await tick();
    expect(leftTool()).toBe('commit');
    expect(useAppStore.getState().dock.maximized).toBe(false);
    expect(document.activeElement?.closest('[data-panel="commit"]')).not.toBeNull();
    // 충돌 목록이 Commit 도구 창 맨 위에 있다
    expect(within(area('commit') as HTMLElement).getByText(S.changes.conflicts(2))).toBeTruthy();
    // 충돌 파일 하나: 충돌 탭이 열린다 (Commit 도구 창은 건드리지 않는다)
    act(() => useAppStore.getState().setLeftTool('project'));
    setConflicts(store, 0);
    setConflicts(store, 1);
    act(() => useAppStore.getState().setLeftTool('project'));
    act(() => {
      const status = st().status;
      store.setState({
        status: {
          ...status,
          entries: [conflictEntry(PAY), ...status.entries.filter((e) => !e.conflict)],
        },
      });
    });
    await tick();
    expect(row().getByRole('button', { name: S.opBand.resolve }).title).toBe(S.opBand.resolveOne);
    fireEvent.click(row().getByRole('button', { name: S.opBand.resolve }));
    await tick();
    await tick();
    expect(st().conflict?.path ?? st().conflictLoading).toBeTruthy();
    expect(ws()?.activeDocId).toBe(conflictDocId(CONFLICT_REPO));
    expect(leftTool()).toBe('project');
  });
});

describe('격리 병합 줄 (계획 7.2절 — 옛 사이드바의 격리 병합 띠를 옮김)', () => {
  /** 격리 워크트리 탭 (작업 없음, 변경 없음) */
  async function mountIsolated() {
    const m = await mountRepo('repo');
    const status = m.st().status;
    act(() =>
      m.store.setState({
        isolatedBranch: 'mgit/isolated-1',
        status: {
          ...status,
          entries: [],
          summary: { ...status.summary, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        },
      }),
    );
    await tick();
    return m;
  }
  /** 격리 줄 */
  const isolatedRow = () =>
    bandRows().find((r) => r.textContent?.includes(S.opBand.isolatedLabel)) as HTMLElement;
  /** 반영 단추 */
  const applyButton = () =>
    within(isolatedRow()).getByRole('button', {
      name: S.preview.isolatedApply,
    }) as HTMLButtonElement;

  it('변경이나 진행 중 작업이 있으면 반영 버튼을 막고 사유를 툴팁으로 보인다 (옛 "변경이나 진행 중 작업이 있으면 반영 버튼을 막는다")', async () => {
    const { store, st } = await mountIsolated();
    expect(
      within(isolatedRow()).getByText(S.preview.isolatedBanner('mgit/isolated-1')),
    ).toBeTruthy();
    // 깨끗하면 반영할 수 있다
    expect(applyButton().disabled).toBe(false);
    expect(applyButton().parentElement?.title ?? '').toBe('');
    // staged 변경이 남았으면 막고 사유
    act(() =>
      store.setState({
        status: { ...st().status, summary: { ...st().status.summary, staged: 1 } },
      }),
    );
    await tick();
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().parentElement?.title).toBe(S.preview.isolatedApplyBlocked);
    // 진행 중 작업(merge 가 끝나지 않음)이 있으면 막는다
    act(() =>
      store.setState({
        op: { kind: 'merge', head: 'x' },
        status: { ...st().status, summary: { ...st().status.summary, staged: 0 } },
      }),
    );
    await tick();
    expect(applyButton().disabled).toBe(true);
    // 쓰기가 도는 중에도 막는다
    act(() => store.setState({ op: null, busy: true }));
    await tick();
    expect(applyButton().disabled).toBe(true);
    act(() => store.setState({ busy: false }));
    await tick();
    expect(applyButton().disabled).toBe(false);
  });

  it('반영: 코어가 메인 경로를 돌려주면 이 탭을 닫는다. 실패하면 닫지 않는다', async () => {
    const { mock, id } = await mountIsolated();
    const closeSession = vi.fn(async () => {});
    act(() => useAppStore.setState({ closeSession }));
    const apply = vi.spyOn(mock, 'isolatedApply').mockRejectedValueOnce(new Error('거부'));
    fireEvent.click(applyButton());
    await tick();
    expect(apply).toHaveBeenCalledWith(id);
    expect(closeSession).not.toHaveBeenCalled();
    apply.mockResolvedValueOnce('/mock/main');
    fireEvent.click(applyButton());
    await tick();
    expect(closeSession).toHaveBeenCalledWith(id);
  });

  it('버리기: 위험 확인창(옛 문구) 뒤에만 버리고 이 탭을 닫는다. 취소하면 아무것도 하지 않는다', async () => {
    const { mock, id } = await mountIsolated();
    const closeSession = vi.fn(async () => {});
    act(() => useAppStore.setState({ closeSession }));
    const discard = vi.spyOn(mock, 'isolatedDiscard').mockResolvedValue('/mock/main');
    const discardButton = () =>
      within(isolatedRow()).getByRole('button', { name: S.preview.isolatedDiscard });
    fireEvent.click(discardButton());
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.preview.isolatedTitle);
    expect(dialog()?.textContent).toContain(S.preview.isolatedDiscardConfirm);
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(discard).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    fireEvent.click(discardButton());
    await tick();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(discard).toHaveBeenCalledWith(id);
    expect(closeSession).toHaveBeenCalledWith(id);
  });

  it('merge 가 충돌로 멈추면 두 줄: 격리 줄이 위, 반영은 Continue 열·버리기는 Abort 열 (같은 뜻의 단추가 같은 열)', async () => {
    const { store } = await mountIsolated();
    setConflicts(store, 1);
    const rows = bandRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(S.opBand.isolatedLabel);
    expect(rows[1]?.textContent).toContain(S.status.op.merge);
    const column = (row: HTMLElement | undefined, slot: string) =>
      (row?.querySelector(`[data-slot="${slot}"]`) as HTMLElement | null)?.style.gridColumn;
    expect(column(rows[0], 'apply')).toBe(String(opSlotColumn('continue')));
    expect(column(rows[0], 'discard')).toBe(String(opSlotColumn('abort')));
    expect(column(rows[1], 'continue')).toBe(String(opSlotColumn('continue')));
    expect(column(rows[1], 'abort')).toBe(String(opSlotColumn('abort')));
    expect(column(rows[0], 'hint')).toBe(column(rows[1], 'hint'));
    // 작업 중에는 반영이 꺼져 있다
    expect(applyButton().disabled).toBe(true);
  });

  it('왼쪽 칸(브랜치 트리·옛 사이드바의 남은 섹션)에는 격리 병합 띠가 없고, 브랜치 트리 메뉴의 "격리 병합…" 은 그대로다 (W22 에서 옛 사이드바 → 브랜치 트리)', async () => {
    await mountIsolated();
    const side = within(area('git-branches') as HTMLElement);
    expect(side.queryByText(S.preview.isolatedApply)).toBeNull();
    expect(side.queryByText(S.preview.isolatedBanner('mgit/isolated-1'))).toBeNull();
    // 현재 branch 가 아닌 로컬 branch 의 메뉴 (격리 탭이라 항목은 꺼져 있다 — 이미 격리 병합 중)
    const local = [
      ...(area('git-branches')?.querySelectorAll<HTMLElement>(
        '[role="treeitem"][data-node-id^="ref:refs/heads/"]',
      ) ?? []),
    ].find((el) => el.getAttribute('aria-current') !== 'true') as HTMLElement;
    const name = (local.getAttribute('data-node-id') ?? '').replace('ref:refs/heads/', '');
    fireEvent.contextMenu(local);
    await tick();
    const item = screen.getByRole('menuitem', { name: S.menu.isolatedMerge(name) });
    expect(item.getAttribute('aria-disabled') ?? String((item as HTMLButtonElement).disabled)).toBe(
      'true',
    );
  });
});

describe('충돌이 생기면 Commit 도구 창을 한 번 연다 (WS-19, 결정 15번)', () => {
  it('충돌 수 0 → 양수: 왼쪽이 Commit 으로 바뀌고 포커스는 그대로다. Project 로 돌아가면 충돌이 남아도 유지', async () => {
    const { store } = await mountRepo('repo');
    expect(leftTool()).toBe('project');
    const editor = area('editor') as HTMLElement;
    editor.focus();
    expect(document.activeElement).toBe(editor);
    setConflicts(store, 2);
    await tick();
    expect(leftTool()).toBe('commit');
    expect(area('commit')).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    // 사용자가 Project 로 돌아간다 → 충돌 수가 바뀌어도(2 → 1) 다시 바꾸지 않는다
    act(() => useAppStore.getState().setLeftTool('project'));
    setConflicts(store, 1);
    await tick();
    expect(leftTool()).toBe('project');
  });

  it('충돌이 0 이 됐다가 다시 생기면 또 한 번 연다', async () => {
    const { store } = await mountRepo('repo');
    setConflicts(store, 1);
    expect(leftTool()).toBe('commit');
    act(() => useAppStore.getState().setLeftTool('project'));
    setConflicts(store, 0);
    expect(leftTool()).toBe('project');
    setConflicts(store, 3);
    expect(leftTool()).toBe('commit');
  });

  it('왼쪽 도구 창이 접혀 있으면 펼친다. 아래 도구 창의 최대화는 그대로 둔다', async () => {
    const { store } = await mountRepo('repo', {
      leftTool: null,
      dock: { tool: 'git', maximized: true, gitTab: 'log' },
    });
    setConflicts(store, 1);
    expect(leftTool()).toBe('commit');
    expect(useAppStore.getState().dock.maximized).toBe(true);
  });

  it('탭을 열 때 이미 충돌이 있으면 한 번 연다 (충돌 장면)', async () => {
    await mountRepo('conflict', { leftTool: 'project' });
    expect(leftTool()).toBe('commit');
  });

  it('비활성 탭: 충돌이 생겨도 지금 화면은 그대로이고, 그 탭으로 돌아올 때 한 번 연다. 그 사이 풀렸으면 열지 않는다', async () => {
    const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    const a = await addRepoTab(mock, WEB);
    const b = await addRepoTab(mock, API);
    act(() =>
      useAppStore.setState({
        sessions: { [a.id]: a.meta, [b.id]: b.meta },
        sessionOrder: [a.id, b.id],
        activeSessionId: a.id,
        dock: DEFAULT_DOCK,
        leftTool: 'project',
        client: mock,
      }),
    );
    render(<App />);
    await tick();
    setConflicts(b.store, 2);
    await tick();
    expect(leftTool()).toBe('project');
    act(() => useAppStore.getState().setActiveSession(b.id));
    await tick();
    expect(leftTool()).toBe('commit');
    // 다시 a 로 갔다 와도 또 열지 않는다 (계기 하나에 한 번)
    act(() => useAppStore.getState().setLeftTool('project'));
    act(() => useAppStore.getState().setActiveSession(a.id));
    act(() => useAppStore.getState().setActiveSession(b.id));
    expect(leftTool()).toBe('project');
    // a 에 충돌이 생겼다가 a 로 돌아오기 전에 모두 풀리면 열지 않는다
    setConflicts(a.store, 1);
    setConflicts(a.store, 0);
    act(() => useAppStore.getState().setActiveSession(a.id));
    expect(leftTool()).toBe('project');
  });

  it('폴더 탭은 그대로다: 폴더가 연 저장소 세션에 충돌이 있어도 왼쪽 도구 창을 바꾸지 않는다', async () => {
    const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    const opened = await mock.openFolder(FOLDER, (e) =>
      getFolderStore(e.session)?.getState().applyEvent(e),
    );
    const id = opened.session;
    mounted.push(id);
    registerFolder(id, createFolderStore(opened, mock));
    registerWorkspace(
      id,
      createWorkspaceStore('folder', {
        closeSessionDoc: (doc) =>
          doc.kind === 'conflict'
            ? useAppStore.getState().closeRepoConflict(id, doc.repoPath)
            : useAppStore.getState().closeRepoDiff(id, doc.repoPath),
      }),
    );
    act(() =>
      useAppStore.setState({
        sessions: {
          [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null },
        },
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
    // catalog-service(rebase 중 충돌 1개)의 충돌 탭을 폴더 탭에서 연다 — 그 저장소의 세션이 생긴다
    await act(async () => {
      await useAppStore.getState().openRepoConflict(id, CATALOG, FACET);
    });
    await tick();
    const catalog = useAppStore.getState().repoSessions[id]?.[CATALOG]?.session ?? -1;
    expect(getSessionStore(catalog)?.getState().status.summary.conflicted).toBe(1);
    expect(leftTool()).toBe('project');
    // 폴더 탭의 띠는 그대로 (저장소 탭 띠가 아니다)
    expect(bandRows()[0]?.textContent).toContain('catalog-service');
  });
});

describe('WIP 행 → Commit 도구 창', () => {
  it('WIP 행을 누르면 상세 칸이 변경 요약이 되고 Commit 도구 창이 열린다 (최대화를 풀고 그 영역으로 포커스)', async () => {
    const { st } = await mountRepo('repo', {
      leftTool: 'project',
      dock: { tool: 'git', maximized: true, gitTab: 'log' },
    });
    act(() => st().selectCommit('a'.repeat(40)));
    await tick();
    expect(h.graph?.wipRow).not.toBeNull();
    act(() => h.graph?.onSelectWip?.());
    await tick();
    expect(st().wipSelected).toBe(true);
    expect(st().selectedCommit).toBeNull();
    expect(leftTool()).toBe('commit');
    expect(useAppStore.getState().dock.maximized).toBe(false);
    expect(document.activeElement?.closest('[data-panel="commit"]')).not.toBeNull();
    expect(
      within(area('git-detail') as HTMLElement).getByText(S.workspace.repoLog.pickCommit),
    ).toBeTruthy();
  });

  it('commit 행을 고르는 것(클릭·키보드 이동)으로는 왼쪽 도구 창이 바뀌지 않는다', async () => {
    const { st } = await mountRepo('repo', { leftTool: 'project' });
    act(() => h.graph?.onSelectRow?.({ oid: 'b'.repeat(40) } as never));
    await tick();
    expect(st().selectedCommit).toBe('b'.repeat(40));
    expect(leftTool()).toBe('project');
  });
});
