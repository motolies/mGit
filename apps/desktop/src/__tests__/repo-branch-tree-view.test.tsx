// W22: 저장소 탭 Git 도구 창 왼쪽 칸의 브랜치 트리 (BT-11). 앱 전체를 그려 확인한다:
// - 조립: 검색 + 브랜치 트리뿐이다. 옛 사이드바의 섹션은 모두 옮겼다 (다섯 = 여기, 스태시 = W23, PR = W24, superproject·
//   모듈·서브모듈·하위 저장소 = W25 의 Project 도구 창).
// - 클릭 = 그 커밋으로 이동, 더블클릭·Enter = checkout 류, Space = 클릭과 같다 (결정 16번).
// - Worktrees 머리 단추(정리·만들기), 세로 툴바 여섯 단추, 우클릭 메뉴(앱에서 열기).
// - 펼침·검색어·고른 행이 로그 탭을 내렸다 올려도 남는다 (W21 이 남긴 문제).

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { PREF_BRANCH_FAVORITES } from '../features/branches/branch-favorites';
import {
  backupNodeId,
  REPO_GROUP_IDS,
  remoteGroupNodeId,
  worktreeNodeId,
} from '../features/branches/repo-branch-tree';
import { useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import {
  clearSessionRegistry,
  disposeWorkspace,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { checkTreeRules } from './a11y-helpers';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 그래프·터미널·홈은 jsdom 에서 그리지 않는다 (뷰 자체는 각 패키지가 테스트한다)
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

// 목 저장소 장면 (storefront-web): 현재 branch main, 로컬 8·원격 9·태그 4, 워크트리 4(하나는 폴더 없음), 백업 2
const REPO = '/mock/storefront-web';
const originalClient = useAppStore.getState().client;
const originalOpen = useAppStore.getState().openRepositoryAt;
let mounted: SessionId[] = [];

/** 저장소 탭 하나를 `openRepositoryAt` 처럼 등록하고 앱 전체를 그린다. 아래 도구 창은 Git 로그 탭 */
async function mountRepo() {
  const mock = createMockClient({ rows: 60, scene: 'repo', progressIntervalMs: 0 });
  const opened = await mock.openRepo(REPO, () => {});
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
  const openRepositoryAt = vi.fn(async () => null);
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path: REPO, name: 'storefront-web', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      conflictLeave: null,
      openRepositoryAt,
    }),
  );
  render(<App />);
  await tick();
  // 생성 때 읽기(백업·충돌 레이더)가 끝나기를 기다린다
  await act(async () => {
    await store.getState().loadBackups();
    await store.getState().loadRadar();
  });
  await tick();
  return { mock, id, store, st: () => store.getState(), openRepositoryAt };
}

/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
const tree = () => screen.getByRole('tree', { name: S.branches.tree });
/** 보이는 행의 노드 id */
const ids = () =>
  within(tree())
    .queryAllByRole('treeitem')
    .map((el) => el.getAttribute('data-node-id'));
/** 노드 id 의 행 */
const row = (id: string) => {
  const el = tree().querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
  if (!el) {
    throw new Error(`행 없음: ${id}`);
  }
  return el;
};
const toolbar = () => within(screen.getByRole('toolbar', { name: S.branches.toolbar.label }));
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 열린 메뉴의 항목 라벨 (꺼진 것은 [off]) */
const menuLabels = () =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
    (el) => `${el.textContent}${el.hasAttribute('data-disabled') ? ' [off]' : ''}`,
  );

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
      client: originalClient,
      openRepositoryAt: originalOpen,
      toasts: [],
      conflictLeave: null,
    }),
  );
  for (const id of mounted) {
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('저장소 탭 Git 도구 창의 왼쪽 칸 (W22 조립)', () => {
  it('검색 + 브랜치 트리(HEAD·로컬·원격·태그·워크트리·백업)뿐이다. 옛 사이드바의 섹션(옮긴 다섯·스태시·PR·모듈·서브모듈·하위 저장소)과 superproject 단추가 없다', async () => {
    const { store } = await mountRepo();
    const side = within(area('git-branches') as HTMLElement);
    expect(side.getByRole('searchbox', { name: S.branches.search })).toBeTruthy();
    expect(
      within(tree())
        .getAllByRole('treeitem')
        .filter((el) => el.getAttribute('aria-level') === '1')
        .map((el) => el.getAttribute('data-node-id')),
    ).toEqual([
      'head',
      REPO_GROUP_IDS.local,
      REPO_GROUP_IDS.remote,
      REPO_GROUP_IDS.tags,
      REPO_GROUP_IDS.worktrees,
      REPO_GROUP_IDS.backups,
    ]);
    // 옛 사이드바의 섹션이 하나도 없다: 옮긴 다섯과 스태시(W23 — Commit 도구 창 Stash 탭), PR(W24 — Pull Requests 도구
    // 창), 모듈·서브모듈·하위 저장소(W25 — Project 도구 창. 목 장면에 다섯·다섯·둘이 있어도 여기에는 없다). 같은 기능이 두
    // 곳에 보이지 않는다
    expect(area('git-branches')?.querySelector('section')).toBeNull();
    const text = area('git-branches')?.textContent ?? '';
    // 옛 섹션 제목 (W28 에서 그 문자열을 지웠으므로 글자로 적는다: 스태시·모듈·서브모듈·하위 저장소)
    for (const title of ['스태시', S.pr.title('github'), '모듈', '서브모듈', '하위 저장소']) {
      expect(text.includes(title), title).toBe(false);
    }
    expect(
      area('git-branches')?.querySelector(
        '[data-key^="local:"], [data-key^="worktree:"], [data-key^="stash:"], [data-pr], [data-module], [data-sm]',
      ),
    ).toBeNull();
    // superproject 링크도 없다 (W25 — Project 도구 창의 트리 위 띠·루트 행 메뉴로 옮겼다. 그 동작은
    // `repo-structure-view.test.tsx` 의 "상위 저장소" 케이스가 본다)
    act(() => store.setState({ superproject: '/mock/platform' }));
    await tick();
    expect(
      within(area('git-branches') as HTMLElement).queryByRole('button', {
        name: `${S.submodule.superproject} platform`,
      }),
    ).toBeNull();
  });

  it('배지·현재 표시·업스트림 차이 (목 장면): 현재 main ⇡2, 체크아웃된 hotfix, 레이더 깨끗함·충돌 6, 원격 삭제됨', async () => {
    await mountRepo();
    expect(row('ref:refs/heads/main').getAttribute('aria-current')).toBe('true');
    expect(row('ref:refs/heads/main').textContent).toBe(`main${S.branches.outgoing(2)}`);
    expect(
      within(row('ref:refs/heads/hotfix/payment-timeout')).getByTitle(
        S.sidebar.checkedOutAt(`${REPO}-hotfix`),
      ),
    ).toBeTruthy();
    expect(within(row('ref:refs/heads/development')).getByTitle(S.preview.radarClean)).toBeTruthy();
    expect(
      row('ref:refs/heads/feature/checkout-redesign').querySelector('[data-icon="radarConflict"]')
        ?.textContent,
    ).toBe('6');
    expect(row('ref:refs/heads/fix/cart-rounding').textContent).toContain(S.sidebar.gone);
    // 이 탭의 워크트리는 현재 표시, 폴더 없는 워크트리는 회색 글자
    expect(row(worktreeNodeId(REPO)).getAttribute('aria-current')).toBe('true');
    expect(row(worktreeNodeId(`${REPO}-spike`)).textContent).toContain(S.sidebar.prunable);
  });

  it('트리 넷의 같은 규칙(단계·형제 수·순번, Home·↓, ⇧F10)이 저장소 브랜치 트리에도 통과한다', async () => {
    await mountRepo();
    checkTreeRules(tree());
  });
});

describe('클릭·더블클릭·Enter·Space (결정 16번 — 저장소 탭은 이동, 더블클릭은 checkout)', () => {
  it('잎을 누르면 고르고 그 커밋으로 이동한다 (로그의 행을 고른다). HEAD 행은 HEAD 커밋, 백업은 백업 커밋', async () => {
    const { st } = await mountRepo();
    const target = (name: string) => st().refs.labels.find((l) => l.shortName === name)?.target;
    fireEvent.click(row('ref:refs/heads/development'));
    await tick();
    expect(st().selectedCommit).toBe(target('development'));
    expect(row('ref:refs/heads/development').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(row('ref:refs/remotes/upstream/main'));
    await tick();
    expect(st().selectedCommit).toBe(target('upstream/main'));
    fireEvent.click(row('head'));
    await tick();
    const head = st().refs.head;
    expect(st().selectedCommit).toBe(head.state === 'attached' ? head.oid : 'no-head');
    // 백업 그룹은 접혀서 시작한다 → 펴고 누른다
    fireEvent.click(row(REPO_GROUP_IDS.backups));
    const b = st().backups[1];
    fireEvent.click(row(backupNodeId(b?.name ?? '')));
    await tick();
    expect(st().selectedCommit).toBe(b?.oid);
    // 워크트리 행은 이동하지 않는다 (옛 사이드바에 클릭 동작이 없었다)
    fireEvent.click(row(worktreeNodeId(`${REPO}-hotfix`)));
    await tick();
    expect(st().selectedCommit).toBe(b?.oid);
  });

  it('더블클릭은 checkout 류: 로컬·원격·태그 (현재 branch 는 아무것도), 워크트리는 탭으로 연다', async () => {
    const { mock, id, openRepositoryAt } = await mountRepo();
    const checkout = vi.spyOn(mock, 'checkout');
    fireEvent.doubleClick(row('ref:refs/heads/main'));
    await tick();
    expect(checkout).not.toHaveBeenCalled();
    fireEvent.doubleClick(row('ref:refs/heads/staging'));
    await tick();
    expect(checkout).toHaveBeenLastCalledWith(id, { kind: 'branch', name: 'staging' }, false);
    fireEvent.doubleClick(row('ref:refs/remotes/origin/feature/checkout-redesign'));
    await tick();
    expect(checkout).toHaveBeenLastCalledWith(
      id,
      { kind: 'remoteBranch', remote: 'origin', name: 'feature/checkout-redesign' },
      false,
    );
    fireEvent.click(row(REPO_GROUP_IDS.tags));
    fireEvent.doubleClick(row('ref:refs/tags/v2.4.0'));
    await tick();
    expect(checkout.mock.lastCall?.[1]).toMatchObject({ kind: 'commit' });
    fireEvent.doubleClick(row(worktreeNodeId(`${REPO}-hotfix`)));
    await tick();
    expect(openRepositoryAt).toHaveBeenCalledWith(`${REPO}-hotfix`);
    // 이 탭의 워크트리는 열지 않는다
    fireEvent.doubleClick(row(worktreeNodeId(REPO)));
    await tick();
    expect(openRepositoryAt).toHaveBeenCalledTimes(1);
  });

  it('Enter 는 더블클릭(checkout), Space 는 클릭(이동)과 같다', async () => {
    const { mock, id, st } = await mountRepo();
    const checkout = vi.spyOn(mock, 'checkout');
    const t = tree();
    act(() => t.focus());
    // 커서 없음 → HEAD → 로컬 그룹 → main → development (현재 > 즐겨찾기 > 이름)
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(t, { key: 'ArrowDown' });
    }
    expect(
      document
        .getElementById(t.getAttribute('aria-activedescendant') ?? '')
        ?.getAttribute('data-node-id'),
    ).toBe('ref:refs/heads/development');
    fireEvent.keyDown(t, { key: ' ' });
    await tick();
    expect(st().selectedCommit).toBe(
      st().refs.labels.find((l) => l.shortName === 'development')?.target,
    );
    fireEvent.keyDown(t, { key: 'Enter' });
    await tick();
    expect(checkout).toHaveBeenCalledWith(id, { kind: 'branch', name: 'development' }, false);
  });
});

describe('Worktrees 그룹의 머리 단추와 우클릭 메뉴 (앱에서)', () => {
  it('정리 단추는 사라진 워크트리가 있을 때 보이고(툴팁에 수) 정리를 부른다. 만들기는 새 워크트리 흐름을 연다', async () => {
    const { mock, id } = await mountRepo();
    const prune = vi.spyOn(mock, 'worktreePrune');
    const group = within(row(REPO_GROUP_IDS.worktrees));
    const pruneButton = group.getByRole('button', { name: S.worktree.prune });
    expect(pruneButton.getAttribute('title')).toBe(S.safety.prunable(1));
    fireEvent.click(pruneButton);
    await tick();
    expect(prune).toHaveBeenCalledWith(id);
    // 단추를 눌러도 그룹이 접히지 않는다
    expect(row(REPO_GROUP_IDS.worktrees).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(group.getByRole('button', { name: S.worktree.create }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.worktree.createTitle);
  });

  it('로컬 branch 우클릭 메뉴가 옛 메뉴와 같고, 삭제는 위험 확인창을 연다 (취소하면 지우지 않는다)', async () => {
    const { mock } = await mountRepo();
    const del = vi.spyOn(mock, 'deleteBranch');
    fireEvent.contextMenu(row('ref:refs/heads/development'));
    await tick();
    expect(menuLabels()).toEqual([
      'checkout',
      '이 branch 만 그래프에 표시',
      '현재 branch 와 development 비교…',
      'development 을(를) 현재 branch 에 merge▸',
      'development merge 미리보기…',
      'development 위로 rebase 예측…',
      'development 격리 병합…',
      '현재 branch 를 development 위로 rebase',
      '이름 변경…',
      '업스트림 해제',
      '삭제…',
      '이름 복사',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: S.menu.delete }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.dialog.deleteBranch('development'));
    expect(dialog()?.textContent).toContain(S.dialog.deleteBranchMessage);
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(del).not.toHaveBeenCalled();
  });

  it('원격 이름 그룹 행에 메뉴가 있고, 로컬·원격 묶음 행과 HEAD 행에는 없다', async () => {
    await mountRepo();
    fireEvent.contextMenu(row(remoteGroupNodeId('origin')));
    await tick();
    expect(menuLabels()).toEqual([
      S.remote.fetchOnly('origin'),
      S.remote.pushTo('origin'),
      S.remote.pushToSetUpstream('origin'),
      S.menu.copyName,
    ]);
    fireEvent.keyDown(document.querySelector('[role="menu"]') as HTMLElement, { key: 'Escape' });
    await tick();
    for (const id of ['head', REPO_GROUP_IDS.local, REPO_GROUP_IDS.remote]) {
      fireEvent.contextMenu(row(id));
      await tick();
      expect(document.querySelector('[role="menu"]'), id).toBeNull();
    }
  });
});

describe('세로 툴바 (BT-05) — 저장소 탭에서 동작하는 여섯 단추', () => {
  it('차례: 접기·새 branch·fetch·즐겨찾기·모두 펼치기·모두 접기. fetch 는 세션 fetch(prune), 새 branch 는 branch 만들기 흐름', async () => {
    const { mock, id } = await mountRepo();
    expect(
      toolbar()
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      S.branches.toolbar.togglePanel,
      S.branches.toolbar.newBranch,
      S.branches.toolbar.fetch,
      S.branches.toolbar.favorite,
      S.branches.toolbar.expandAll,
      S.branches.toolbar.collapseAll,
    ]);
    const fetch = vi.spyOn(mock, 'fetch');
    fireEvent.click(toolbar().getByRole('button', { name: S.branches.toolbar.fetch }));
    await tick();
    expect(fetch).toHaveBeenCalledWith(id, null, true);
    fireEvent.click(toolbar().getByRole('button', { name: S.branches.toolbar.newBranch }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.dialog.createBranch);
  });

  it('진행 중 작업이 있거나 원격이 없으면 fetch 만 꺼지고, 실행 중이면 새 branch 도 꺼진다', async () => {
    const { store } = await mountRepo();
    const button = (name: string) => toolbar().getByRole('button', { name }) as HTMLButtonElement;
    expect(button(S.branches.toolbar.fetch).disabled).toBe(false);
    act(() => store.setState({ op: { kind: 'merge', head: 'a'.repeat(40) } }));
    expect(button(S.branches.toolbar.fetch).disabled).toBe(true);
    expect(button(S.branches.toolbar.newBranch).disabled).toBe(false);
    act(() => store.setState({ op: null, refs: { ...store.getState().refs, remotes: [] } }));
    expect(button(S.branches.toolbar.fetch).disabled).toBe(true);
    act(() => store.setState({ busy: true }));
    expect(button(S.branches.toolbar.newBranch).disabled).toBe(true);
  });

  it('즐겨찾기는 고른 branch 를 즐겨찾기로 바꿔 순서를 바꾸고 저장소 경로로 저장한다. 고른 것이 없으면 꺼져 있다', async () => {
    await mountRepo();
    const fav = () =>
      toolbar().getByRole('button', { name: S.branches.toolbar.favorite }) as HTMLButtonElement;
    expect(fav().disabled).toBe(true);
    fireEvent.click(row('ref:refs/heads/staging'));
    await tick();
    expect(fav().disabled).toBe(false);
    expect(fav().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(fav());
    await tick();
    expect(fav().getAttribute('aria-pressed')).toBe('true');
    // 현재(main) 다음, 이름순 앞의 것들보다 먼저 온다
    const locals = ids().filter((id) => id?.startsWith('ref:refs/heads/'));
    expect(locals.slice(0, 2)).toEqual(['ref:refs/heads/main', 'ref:refs/heads/staging']);
    expect(JSON.parse(localStorage.getItem(PREF_BRANCH_FAVORITES) ?? '{}')).toEqual({
      [REPO]: { on: ['refs/heads/staging'], off: [] },
    });
  });

  it('모두 접기·모두 펼치기는 원격 이름 그룹까지 한꺼번에 접고 편다. 접기 단추는 브랜치 칸을 접는다', async () => {
    await mountRepo();
    fireEvent.click(toolbar().getByRole('button', { name: S.branches.toolbar.collapseAll }));
    await tick();
    expect(ids()).toEqual([
      'head',
      REPO_GROUP_IDS.local,
      REPO_GROUP_IDS.remote,
      REPO_GROUP_IDS.tags,
      REPO_GROUP_IDS.worktrees,
      REPO_GROUP_IDS.backups,
    ]);
    fireEvent.click(toolbar().getByRole('button', { name: S.branches.toolbar.expandAll }));
    await tick();
    expect(ids()).toContain('ref:refs/tags/v2.4.0');
    expect(ids()).toContain('ref:refs/remotes/upstream/release/2026.10');
    const panel = toolbar().getByRole('button', { name: S.branches.toolbar.togglePanel });
    expect(panel.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(panel);
    await tick();
    expect(area('git-branches')?.hasAttribute('inert')).toBe(true);
    expect(JSON.parse(localStorage.getItem('mgit.gitLogBranches') ?? '{}')).toEqual({
      open: false,
    });
  });
});

describe('펼침·검색어·고른 행은 로그 탭을 내렸다 올려도 남는다 (W21 이 남긴 문제)', () => {
  it('콘솔 탭에 다녀와도 접은 그룹·편 그룹·고른 행·검색어가 그대로다', async () => {
    await mountRepo();
    fireEvent.click(row(REPO_GROUP_IDS.local)); // 접는다
    fireEvent.click(row(REPO_GROUP_IDS.tags)); // 편다 (기본 접힘)
    fireEvent.click(row('ref:refs/remotes/origin/main'));
    await tick();
    const before = ids();
    expect(before).not.toContain('ref:refs/heads/main');
    expect(before).toContain('ref:refs/tags/v2.4.0');
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    expect(screen.queryByRole('tree', { name: S.branches.tree })).toBeNull();
    act(() => useAppStore.getState().setGitDockTab('log'));
    await tick();
    expect(ids()).toEqual(before);
    expect(row('ref:refs/remotes/origin/main').getAttribute('aria-selected')).toBe('true');
    // 검색어도 남는다
    fireEvent.change(screen.getByRole('searchbox', { name: S.branches.search }), {
      target: { value: 'hotfix' },
    });
    await tick();
    const searched = ids();
    act(() => useAppStore.getState().hideDock());
    await tick();
    act(() => useAppStore.getState().toggleDock('git', 'log'));
    await tick();
    expect(
      (screen.getByRole('searchbox', { name: S.branches.search }) as HTMLInputElement).value,
    ).toBe('hotfix');
    expect(ids()).toEqual(searched);
  });
});
