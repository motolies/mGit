// W23: 저장소 탭 Commit 도구 창의 탭(변경 | Stash, WS-22)과 Stash 탭. 앱 전체를 그려 확인한다.
// - 탭: tablist/tab/tabpanel, ←→·Home·End, Tab 정지 하나. ⌘0·왼쪽 띠는 마지막에 보던 탭을 연다.
// - 충돌 목록이 Stash 탭 뒤에 가려지지 않는다 (계획 10절): 띠의 충돌 수·"충돌 해결", 충돌 자동 활성화(처음 볼 때 포함),
//   WIP 행, 상세 칸의 "Commit 도구 창 열기" 가 모두 변경 탭을 고른다.
// - Stash 탭: 옛 사이드바 스태시 섹션(행·클릭·메뉴·`+` 저장)과 옛 상세 칸의 `StashDetail` 을 옮겼다 — 옛 테스트
//   `repo-workspace-shell.test.tsx` 의 "stash 를 고르면 stash 상세", `repo-branch-tree-view.test.tsx` 의 "스태시 행을 누르면
//   그 스태시 상세"의 새 자리다. 기대 글자는 손대기 전 브라우저 기준(스크래치패드 `w23/baseline-old-stash.json`).
// - 선택 규칙: 스태시 보기와 로그 선택은 독립이다. pop 이 성공하면 변경 탭, drop 뒤에는 Stash 탭에 머문다.

import type { GraphViewProps } from '@mgit/graph-view';
import {
  createMockClient,
  GraphRangeCache,
  type InProgressOp,
  type SessionId,
  type StatusEntry,
} from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { getWorkspaceStore, useAppStore } from '../store';
import {
  type CommitTab,
  createRepoWorkspace,
  DEFAULT_DOCK,
  type DockState,
  type LeftTool,
  sessionRevealHooks,
} from '../store/app-store';
import {
  clearSessionRegistry,
  disposeWorkspace,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
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

// 목 장면: 저장소 장면(storefront-web, 스태시 3개 — 셋째는 다른 워크트리에서 만듦)과 충돌 장면(checkout-service)
const REPO = '/mock/storefront-web';
const CONFLICT_REPO = '/mock/checkout-service';
const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };
// 옛 사이드바 행의 글자 (손대기 전 브라우저 기준)
const ROW_TEXTS = [
  'stash@{0} WIP on main: 장바구니 합계 반올림 실험main',
  'stash@{1} On feature/checkout-redesign: 결제 단계 배치 임시 저장feature/checkout-redesign',
  'stash@{2} On hotfix/payment-timeout: 브랜치 전환 전 자동 보관hotfix/payment-timeout',
];
const ROW_TITLES = [
  'WIP on main: 장바구니 합계 반올림 실험',
  'On feature/checkout-redesign: 결제 단계 배치 임시 저장',
  '워크트리: /mock/storefront-web-hotfix',
];

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/**
 * 저장소 탭 하나를 `openRepositoryAt` 처럼 등록하고(세션 스토어 + "보여라" 훅 + 저장소 워크스페이스) 앱 전체를 그린다.
 * 아래 도구 창은 Git 로그 탭. 생성 때 읽기(스태시 목록 포함)가 끝난 뒤 돌려준다
 */
async function mountRepo(
  scene: 'repo' | 'conflict' = 'repo',
  init: { leftTool?: LeftTool | null; commitTab?: CommitTab; dock?: DockState } = {},
) {
  const path = scene === 'repo' ? REPO : CONFLICT_REPO;
  const mock = createMockClient({ rows: 60, scene, progressIntervalMs: 0 });
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
  store.setState({ loadState: 'complete', totalRows: 60 });
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  const name = path.slice(path.lastIndexOf('/') + 1);
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path, name, parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: init.dock ?? DEFAULT_DOCK,
      leftTool: init.leftTool === undefined ? 'commit' : init.leftTool,
      commitTab: init.commitTab ?? 'changes',
      client: mock,
      conflictLeave: null,
    }),
  );
  render(<App />);
  await tick();
  await tick();
  return {
    mock,
    id,
    store,
    st: () => store.getState(),
    ws: () => getWorkspaceStore(id)?.getState(),
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

/** 세션의 충돌 수를 바꾼다 (코어의 `statusChanged` 처럼 상태 목록·요약·진행 중 작업을 함께) */
function setConflicts(store: ReturnType<typeof createSessionStore>, n: number) {
  const op: InProgressOp | null = n > 0 ? { kind: 'merge', head: 'x' } : null;
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

/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
/** Commit 도구 창 영역 안에서 찾기 */
const commit = () => within(area('commit') as HTMLElement);
/** Commit 도구 창의 탭 단추 [변경, Stash] */
const tabs = () => commit().getAllByRole('tab');
/** 고른 탭 */
const tabState = () => useAppStore.getState().commitTab;
/** Stash 탭의 목록과 행 */
const stashList = () => screen.getByRole('listbox', { name: S.stash.list });
const rows = () => within(stashList()).getAllByRole('option');
/** Stash 탭 아래 칸의 상세 */
const stashDetail = () => commit().queryByRole('region', { name: S.stash.title });
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 열린 메뉴의 항목 라벨 (꺼진 것은 [off]) */
const menuLabels = () =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
    (el) => `${el.textContent}${el.hasAttribute('data-disabled') ? ' [off]' : ''}`,
  );
/** 작업 진행 띠의 첫 줄 */
const bandRow = () =>
  within(
    screen
      .getByRole('region', { name: S.opBand.label })
      .querySelector('[role="group"]') as HTMLElement,
  );
/** 키를 누른다 (앱 단축키는 window 에서 받는다) */
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });
/** 탭을 고른다 (스토어로) */
const selectTab = (tab: CommitTab) => act(() => useAppStore.getState().setCommitTab(tab));
/** 변경 탭이 보이고 그 패널에 충돌 목록이 있다 */
function expectConflictsShown(n: number) {
  expect(tabState()).toBe('changes');
  const panel = commit().getByRole('tabpanel');
  expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0]?.id);
  expect(within(panel).getByText(S.changes.conflicts(n))).toBeTruthy();
  expect(screen.queryByRole('listbox', { name: S.stash.list })).toBeNull();
}

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
      client: originalClient,
      toasts: [],
      conflictLeave: null,
      commitTab: 'changes',
    }),
  );
  for (const id of mounted) {
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('Commit 도구 창의 탭 (WS-22)', () => {
  it('머리에 탭 둘(변경 | Stash 개수). 기본은 변경 탭 — 옛 변경 사항 그대로. Stash 를 누르면 Stash 패널과 + 저장 단추', async () => {
    await mountRepo();
    const list = commit().getByRole('tablist', { name: S.commitTool.title });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([S.commitTool.tabs.changes, `${S.commitTool.tabs.stash}3`]);
    const [changes, stash] = tabs() as [HTMLElement, HTMLElement];
    let panel = commit().getByRole('tabpanel');
    expect(changes.getAttribute('aria-selected')).toBe('true');
    expect(changes.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(changes.id);
    expect(stash.getAttribute('aria-selected')).toBe('false');
    expect(stash.getAttribute('aria-controls')).toBeNull();
    // 변경 탭 = 옛 변경 사항 + 커밋 입력
    expect(within(panel).getByText(S.changes.title)).toBeTruthy();
    expect(within(panel).getByPlaceholderText(S.commit.summary)).toBeTruthy();
    expect(commit().queryByRole('button', { name: S.stash.save })).toBeNull();

    act(() => fireEvent.click(stash));
    await tick();
    expect(tabState()).toBe('stash');
    panel = commit().getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(stash.id);
    expect(stash.getAttribute('aria-controls')).toBe(panel.id);
    expect(within(panel).getByRole('listbox', { name: S.stash.list })).toBeTruthy();
    expect(within(panel).queryByText(S.changes.title)).toBeNull();
    expect(commit().getByRole('button', { name: S.stash.save })).toBeTruthy();
    // 머리의 제목은 그대로
    expect(commit().getByText(S.commitTool.title)).toBeTruthy();
  });

  it('탭 키: ←→·Home·End 로 옆 탭을 고르고 그 탭에 포커스를 준다(끝에서 돈다). Tab 정지는 고른 탭 하나', async () => {
    await mountRepo();
    const tabIndexes = () => tabs().map((t) => t.tabIndex);
    expect(tabIndexes()).toEqual([0, -1]);
    const [changes, stash] = tabs() as [HTMLElement, HTMLElement];
    changes.focus();
    act(() => fireEvent.keyDown(changes, { key: 'ArrowRight' }));
    expect(tabState()).toBe('stash');
    expect(document.activeElement).toBe(stash);
    expect(tabIndexes()).toEqual([-1, 0]);
    act(() => fireEvent.keyDown(stash, { key: 'ArrowRight' }));
    expect(tabState()).toBe('changes');
    act(() => fireEvent.keyDown(changes, { key: 'End' }));
    expect(tabState()).toBe('stash');
    act(() => fireEvent.keyDown(stash, { key: 'Home' }));
    expect(tabState()).toBe('changes');
    act(() => fireEvent.keyDown(changes, { key: 'ArrowLeft' }));
    expect(tabState()).toBe('stash');
    // 수정키 조합은 앱 단축키 몫이다
    act(() => fireEvent.keyDown(stash, { key: 'ArrowLeft', ...MOD }));
    expect(tabState()).toBe('stash');
  });

  it('⌘0 과 왼쪽 띠의 Commit 단추는 마지막에 보던 탭(Stash)을 그대로 연다', async () => {
    await mountRepo('repo', { leftTool: 'project', commitTab: 'stash' });
    press('0', /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { altKey: true });
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(tabState()).toBe('stash');
    expect(stashList()).toBeTruthy();
    // ⌘0 은 그 영역의 키보드 대상으로 포커스를 준다 (탭 패널 안의 목록)
    await tick();
    expect(document.activeElement).toBe(stashList());
    const stripe = within(screen.getByRole('toolbar', { name: S.workspace.stripe }));
    act(() => fireEvent.click(stripe.getByRole('button', { name: S.commitTool.title })));
    expect(useAppStore.getState().leftTool).toBeNull();
    act(() => fireEvent.click(stripe.getByRole('button', { name: S.commitTool.title })));
    await tick();
    expect(tabState()).toBe('stash');
    expect(stashList()).toBeTruthy();
  });
});

describe('충돌 목록이 Stash 탭 뒤에 가려지지 않는다 (계획 10절)', () => {
  it('① 작업 진행 띠의 충돌 수·"충돌 해결"(충돌 파일 여럿): Stash 탭을 보던 중이어도 변경 탭의 충돌 목록', async () => {
    await mountRepo('conflict', { leftTool: 'commit' });
    selectTab('stash');
    await tick();
    expect(stashList()).toBeTruthy();
    fireEvent.click(bandRow().getByRole('button', { name: S.opBand.conflicts(2) }));
    await tick();
    expectConflictsShown(2);
    expect(document.activeElement?.closest('[data-panel="commit"]')).not.toBeNull();
    // "충돌 해결" 단추도 같다 (Project 에서 와도)
    selectTab('stash');
    act(() => useAppStore.getState().setLeftTool('project'));
    await tick();
    fireEvent.click(bandRow().getByRole('button', { name: S.opBand.resolve }));
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expectConflictsShown(2);
  });

  it('② 충돌 자동 활성화(충돌 수 0 → 양수): Stash 탭을 보던 중이어도, Project 에서도 변경 탭의 충돌 목록', async () => {
    const { store } = await mountRepo('repo', { leftTool: 'commit', commitTab: 'stash' });
    expect(stashList()).toBeTruthy();
    setConflicts(store, 2);
    await tick();
    expectConflictsShown(2);
    // 0 이 됐다가 다시 생길 때 Project 에 Stash 탭이 골라져 있었어도
    setConflicts(store, 0);
    selectTab('stash');
    act(() => useAppStore.getState().setLeftTool('project'));
    setConflicts(store, 3);
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expectConflictsShown(3);
  });

  it('② Pull Requests 도구 창(W24)을 보던 중에도 충돌 수 0 → 양수면 Commit 의 변경 탭', async () => {
    const { store } = await mountRepo('repo', { leftTool: 'pullRequests', commitTab: 'stash' });
    expect(area('pull-requests')).not.toBeNull();
    setConflicts(store, 2);
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(area('pull-requests')).toBeNull();
    expectConflictsShown(2);
  });

  it('② 저장된 값이 Pull Requests 인 채 충돌이 있는 탭을 처음 볼 때도 Commit 의 변경 탭 (W24)', async () => {
    await mountRepo('conflict', { leftTool: 'pullRequests', commitTab: 'stash' });
    expect(useAppStore.getState().leftTool).toBe('commit');
    expectConflictsShown(2);
  });

  it('② 충돌이 있는 탭을 처음 볼 때(새로 고침·탭 열기)도 Stash 탭이 아니라 변경 탭의 충돌 목록', async () => {
    await mountRepo('conflict', { leftTool: 'project', commitTab: 'stash' });
    expect(useAppStore.getState().leftTool).toBe('commit');
    expectConflictsShown(2);
  });

  it('③ 그래프의 WIP 행: Stash 탭을 보던 중이어도 변경 탭의 충돌 목록 (최대화를 풀고 그 영역으로 포커스)', async () => {
    const { store, st } = await mountRepo('repo', {
      leftTool: 'commit',
      dock: { tool: 'git', maximized: true, gitTab: 'log' },
    });
    setConflicts(store, 2);
    selectTab('stash');
    await tick();
    expect(stashList()).toBeTruthy();
    act(() => h.graph?.onSelectWip?.());
    await tick();
    expect(st().wipSelected).toBe(true);
    expect(useAppStore.getState().dock.maximized).toBe(false);
    expectConflictsShown(2);
    expect(document.activeElement?.closest('[data-panel="commit"]')).not.toBeNull();
  });

  it('④ 상세 칸 빈 상태의 "Commit 도구 창 열기": Stash 탭을 보던 중이어도 변경 탭의 충돌 목록', async () => {
    const { store } = await mountRepo('repo', { leftTool: 'commit' });
    setConflicts(store, 2);
    selectTab('stash');
    act(() => useAppStore.getState().setLeftTool('project'));
    await tick();
    fireEvent.click(
      within(area('git-detail') as HTMLElement).getByRole('button', {
        name: S.workspace.repoLog.openCommitTool,
      }),
    );
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expectConflictsShown(2);
  });

  it('⌘0 은 충돌이 있어도 보던 탭 그대로다 (사용자가 고른 탭)', async () => {
    const { store } = await mountRepo('repo', { leftTool: 'commit' });
    setConflicts(store, 2);
    selectTab('stash');
    act(() => useAppStore.getState().setLeftTool('project'));
    press('0', /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { altKey: true });
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(tabState()).toBe('stash');
  });
});

describe('Stash 탭 (옛 사이드바 스태시 섹션 + 옛 상세 칸의 StashDetail)', () => {
  it('목록: 행 = stash@{N} 메시지 + branch, 툴팁 = 출처 워크트리 또는 메시지. 아무것도 안 골랐으면 아래 칸에 안내', async () => {
    await mountRepo('repo', { commitTab: 'stash' });
    expect(rows().map((r) => r.textContent)).toEqual(ROW_TEXTS);
    expect(rows().map((r) => r.title)).toEqual(ROW_TITLES);
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
    expect(commit().getByText(S.stash.pick)).toBeTruthy();
    expect(stashDetail()).toBeNull();
  });

  it('출처 정보가 오기 전에는 refs 의 목록(툴팁 = 메시지)을 보이고, 스태시가 없으면 빈 안내와 저장 단추. 개수는 감춘다', async () => {
    const { store, st } = await mountRepo('repo', { commitTab: 'stash' });
    act(() => store.setState({ stashes: [] }));
    expect(rows().map((r) => r.textContent)).toEqual(ROW_TEXTS);
    // 출처 정보가 없으므로 셋째 행의 툴팁도 메시지다
    expect(rows().map((r) => r.title)).toEqual([
      ROW_TITLES[0],
      ROW_TITLES[1],
      'On hotfix/payment-timeout: 브랜치 전환 전 자동 보관',
    ]);
    expect(tabs()[1]?.textContent).toBe(`${S.commitTool.tabs.stash}3`);
    act(() => store.setState({ refs: { ...st().refs, stashes: [] } }));
    expect(screen.queryByRole('listbox', { name: S.stash.list })).toBeNull();
    expect(commit().getByText(S.stash.empty)).toBeTruthy();
    expect(tabs()[1]?.textContent).toBe(S.commitTool.tabs.stash);
    // 빈 상태의 저장 단추 = + 와 같은 대화상자
    const buttons = commit().getAllByRole('button', { name: S.stash.save });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.stash.saveTitle);
  });

  it('행을 누르면 아래 칸에 상세: 제목·이름·해시, apply/pop/drop, 메시지, 날짜·branch·출처 경로, 파일 수·파일. 파일을 누르면 에디터에 diff 탭', async () => {
    const { st } = await mountRepo('repo', { commitTab: 'stash' });
    const oid = st().stashes[2]?.info.oid ?? '';
    fireEvent.click(rows()[2] as HTMLElement);
    await tick();
    expect(rows()[2]?.getAttribute('aria-selected')).toBe('true');
    expect(st().stashView?.entry.info.oid).toBe(oid);
    const detail = within(stashDetail() as HTMLElement);
    const head = (stashDetail() as HTMLElement).querySelector('header') as HTMLElement;
    expect([...head.querySelectorAll('span')].map((s) => s.textContent)).toEqual([
      S.stash.title,
      `stash@{2} · ${shortHash(oid)}`,
    ]);
    expect(within(head).getByTitle(oid)).toBeTruthy();
    expect(
      detail
        .getAllByRole('button')
        .slice(0, 3)
        .map((b) => b.textContent),
    ).toEqual(['적용', '적용 후 삭제', '스태시 삭제…']);
    expect(stashDetail()?.querySelector('pre')?.textContent).toBe(
      'On hotfix/payment-timeout: 브랜치 전환 전 자동 보관',
    );
    expect([...(stashDetail()?.querySelectorAll('dt') ?? [])].map((d) => d.textContent)).toEqual([
      S.detail.author,
      '브랜치',
      '경로',
    ]);
    const dds = [...(stashDetail()?.querySelectorAll('dd') ?? [])];
    expect(dds.slice(1).map((d) => d.textContent)).toEqual([
      'hotfix/payment-timeout',
      '/mock/storefront-web-hotfix',
    ]);
    expect(dds[2]?.title).toBe('/mock/storefront-web-hotfix');
    expect(detail.getByText(S.stash.files(4))).toBeTruthy();
    const files = (stashDetail() as HTMLElement).querySelectorAll(
      '[role="treeitem"][data-kind="file"]',
    );
    expect(files).toHaveLength(4);
    // 파일을 누르면 그 스태시 파일의 diff 가 에디터 탭으로 열리고, 그 파일이 열린 것으로 보인다
    fireEvent.click(files[0] as HTMLElement);
    await tick();
    expect(st().selectedFile).toMatchObject({
      commit: oid,
      stash: oid,
      origin: { kind: 'stash', oid },
      path: files[0]?.getAttribute('title'),
    });
    expect(within(area('editor') as HTMLElement).getAllByRole('tab')).toHaveLength(1);
    expect(
      (stashDetail() as HTMLElement)
        .querySelector('[role="treeitem"][aria-selected="true"]')
        ?.getAttribute('title'),
    ).toBe(files[0]?.getAttribute('title'));
  });

  it('우클릭 메뉴 4개(옛 라벨·순서·구분선)와 "내용 보기"', async () => {
    const { st } = await mountRepo('repo', { commitTab: 'stash' });
    fireEvent.contextMenu(rows()[1] as HTMLElement);
    await tick();
    expect(menuLabels()).toEqual(['내용 보기', '적용', '적용 후 삭제', '스태시 삭제…']);
    const items = [...(document.querySelector('[role="menu"]')?.children ?? [])].map((c) =>
      c.getAttribute('role'),
    );
    expect(items).toEqual(['menuitem', 'separator', 'menuitem', 'menuitem', 'menuitem']);
    fireEvent.click(screen.getByRole('menuitem', { name: S.stash.show }));
    await tick();
    expect(st().stashView?.entry.info.index).toBe(1);
    expect(stashDetail()).not.toBeNull();
  });

  it('키보드: 목록이 Tab 정지 하나. ↑↓·Home·End = 커서, Enter·Space = 보기, ⇧F10 = 커서 행의 메뉴', async () => {
    const { st } = await mountRepo('repo', { commitTab: 'stash' });
    const list = stashList();
    expect(list.tabIndex).toBe(0);
    expect(rows().every((r) => !r.hasAttribute('tabindex'))).toBe(true);
    list.focus();
    const cursor = () => list.getAttribute('aria-activedescendant');
    expect(cursor()).toBe(rows()[0]?.id);
    act(() => fireEvent.keyDown(list, { key: 'ArrowDown' }));
    expect(cursor()).toBe(rows()[1]?.id);
    // 커서만으로는 보지 않는다
    expect(st().stashView).toBeNull();
    act(() => fireEvent.keyDown(list, { key: 'Enter' }));
    await tick();
    expect(st().stashView?.entry.info.index).toBe(1);
    act(() => fireEvent.keyDown(list, { key: 'End' }));
    expect(cursor()).toBe(rows()[2]?.id);
    act(() => fireEvent.keyDown(list, { key: ' ' }));
    await tick();
    expect(st().stashView?.entry.info.index).toBe(2);
    act(() => fireEvent.keyDown(list, { key: 'Home' }));
    act(() => fireEvent.keyDown(list, { key: 'ArrowUp' }));
    expect(cursor()).toBe(rows()[0]?.id);
    act(() => fireEvent.keyDown(list, { key: 'F10', shiftKey: true }));
    await tick();
    expect(menuLabels()).toEqual(['내용 보기', '적용', '적용 후 삭제', '스태시 삭제…']);
  });

  it('+ 저장: 옛 대화상자(메시지·untracked 기본 켜짐·staged 만) → stashPush(null, true, false, []). 취소하면 부르지 않는다', async () => {
    const { store } = await mountRepo('repo', { commitTab: 'stash' });
    const push = vi.fn(async () => {});
    act(() => store.setState({ stashPush: push }));
    const plus = commit().getByRole('button', { name: S.stash.save });
    expect(plus.title).toBe('스태시 저장…');
    fireEvent.click(plus);
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('스태시 저장');
    const inputs = [...(dialog()?.querySelectorAll('input') ?? [])];
    expect(inputs.map((i) => [i.type, i.checked])).toEqual([
      ['text', false],
      ['checkbox', true],
      ['checkbox', false],
    ]);
    expect(dialog()?.textContent).toContain('미추적 파일 포함');
    expect(dialog()?.textContent).toContain('스테이징된 변경만 (--staged)');
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(plus);
    await tick();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(push).toHaveBeenCalledWith(null, true, false, []);
  });

  it('drop: 위험 확인창(옛 제목·문구·삭제, 포커스는 취소) — 취소하면 부르지 않고, 지우면 Stash 탭에 머물며 커서·포커스가 다음 행으로', async () => {
    const { store, st } = await mountRepo('repo', { commitTab: 'stash' });
    const drop = vi.fn(async () => true);
    act(() => store.setState({ stashDrop: drop }));
    fireEvent.click(rows()[1] as HTMLElement);
    await tick();
    const dropButton = () =>
      within(stashDetail() as HTMLElement).getByRole('button', { name: S.stash.drop });
    fireEvent.click(dropButton());
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('stash@{1}을(를) 지울까요?');
    expect(dialog()?.textContent).toContain('지운 스태시는 되돌릴 수 없습니다.');
    expect(within(dialog() as HTMLElement).getByRole('button', { name: '삭제' })).toBeTruthy();
    // 위험 확인창은 취소 단추에서 시작한다
    expect(document.activeElement?.textContent).toBe(S.confirm.cancel);
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(drop).not.toHaveBeenCalled();
    fireEvent.click(dropButton());
    await tick();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(drop).toHaveBeenCalledWith(st().stashes[1]?.info.oid);
    expect(tabState()).toBe('stash');
    expect(document.activeElement).toBe(stashList());
    expect(stashList().getAttribute('aria-activedescendant')).toBe(rows()[2]?.id);
  });

  it('drop: 마지막 스태시를 지우면 포커스는 Stash 탭 단추로 간다 (지운 행·단추에 남지 않는다)', async () => {
    const { store, st } = await mountRepo('repo', { commitTab: 'stash' });
    const only = st().stashes[0];
    expect(only).toBeDefined();
    const drop = vi.fn(async () => true);
    act(() =>
      store.setState({
        stashDrop: drop,
        stashes: only ? [only] : [],
        refs: { ...st().refs, stashes: only ? [only.info] : [] },
      }),
    );
    fireEvent.contextMenu(rows()[0] as HTMLElement);
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.stash.drop }));
    await tick();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(drop).toHaveBeenCalledWith(only?.info.oid);
    expect(tabState()).toBe('stash');
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it('pop: 성공하면 변경 탭으로(상세 단추·메뉴 모두). 왼쪽 도구 창·로그 선택은 그대로. 실패하면 머문다. apply 는 머문다', async () => {
    const { store, st } = await mountRepo('repo', { commitTab: 'stash' });
    const apply = vi.fn(async () => true);
    const pop = vi.fn(async () => false);
    act(() => store.setState({ stashApply: apply, stashPop: pop }));
    act(() => st().selectCommit('a'.repeat(40)));
    fireEvent.click(rows()[0] as HTMLElement);
    await tick();
    const oid = st().stashes[0]?.info.oid;
    const button = (name: string) =>
      within(stashDetail() as HTMLElement).getByRole('button', { name });
    fireEvent.click(button(S.stash.apply));
    await tick();
    expect(apply).toHaveBeenCalledWith(oid);
    expect(tabState()).toBe('stash');
    // 실패한 pop 은 머문다
    fireEvent.click(button(S.stash.pop));
    await tick();
    expect(pop).toHaveBeenCalledWith(oid);
    expect(tabState()).toBe('stash');
    // 성공한 pop 은 변경 탭으로 — 로그 선택과 왼쪽 도구 창은 그대로
    pop.mockResolvedValue(true);
    fireEvent.click(button(S.stash.pop));
    await tick();
    expect(tabState()).toBe('changes');
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(st().selectedCommit).toBe('a'.repeat(40));
    // 메뉴의 pop 도 같다
    selectTab('stash');
    await tick();
    fireEvent.contextMenu(rows()[1] as HTMLElement);
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.stash.pop }));
    await tick();
    expect(pop).toHaveBeenLastCalledWith(st().stashes[1]?.info.oid);
    expect(tabState()).toBe('changes');
  });

  it('꺼짐 조건(옛 그대로): 실행 중이면 상세의 apply·pop·drop 과 + 가 꺼지고, 진행 중 작업만 있으면 + 만 꺼진다', async () => {
    const { store } = await mountRepo('repo', { commitTab: 'stash' });
    fireEvent.click(rows()[0] as HTMLElement);
    await tick();
    const detailButtons = () =>
      within(stashDetail() as HTMLElement)
        .getAllByRole<HTMLButtonElement>('button')
        .slice(0, 3)
        .map((b) => b.disabled);
    const plus = () => commit().getByRole<HTMLButtonElement>('button', { name: S.stash.save });
    expect(detailButtons()).toEqual([false, false, false]);
    expect(plus().disabled).toBe(false);
    act(() => store.setState({ busy: true }));
    expect(detailButtons()).toEqual([true, true, true]);
    expect(plus().disabled).toBe(true);
    act(() => store.setState({ busy: false, op: { kind: 'merge', head: 'x' } }));
    expect(detailButtons()).toEqual([false, false, false]);
    expect(plus().disabled).toBe(true);
  });
});

describe('선택 규칙: 스태시 보기와 로그 선택은 독립이다 (W23)', () => {
  it('스태시를 골라도 로그의 커밋 선택·상세 칸이 그대로, 로그에서 커밋·WIP 를 골라도 Stash 탭의 상세가 그대로', async () => {
    const { st } = await mountRepo('repo', { commitTab: 'stash' });
    const detailPane = () => within(area('git-detail') as HTMLElement);
    act(() => st().selectCommit('a'.repeat(40)));
    await tick();
    expect(detailPane().queryByText(S.workspace.repoLog.pickCommit)).toBeNull();
    fireEvent.click(rows()[1] as HTMLElement);
    await tick();
    expect(st().selectedCommit).toBe('a'.repeat(40));
    expect(detailPane().queryByText(S.workspace.repoLog.pickCommit)).toBeNull();
    expect(detailPane().queryByText(S.stash.title)).toBeNull();
    expect(stashDetail()).not.toBeNull();
    // 로그에서 다른 커밋을 고른다 → Stash 탭의 상세는 그대로
    act(() => h.graph?.onSelectRow?.({ oid: 'b'.repeat(40) } as never));
    await tick();
    expect(st().selectedCommit).toBe('b'.repeat(40));
    expect(st().stashView?.entry.info.index).toBe(1);
    expect(stashDetail()).not.toBeNull();
    // WIP 선택(스토어)도 스태시 보기를 비우지 않는다
    act(() => st().selectWip());
    await tick();
    expect(st().stashView?.entry.info.index).toBe(1);
    expect(stashDetail()).not.toBeNull();
    expect(detailPane().getByText(S.workspace.repoLog.pickCommit)).toBeTruthy();
  });
});
