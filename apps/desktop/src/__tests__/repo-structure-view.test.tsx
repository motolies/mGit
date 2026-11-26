// W25: 저장소 탭 Project 도구 창의 모듈·서브모듈·하위 저장소·상위 저장소 (PT-13). 앱 전체를 목 저장소 장면으로 그려 확인한다:
// - 행 장식: 모듈(아이콘의 뜻·변경 수·범위 배지), 서브모듈(배지·상태), 하위 저장소(아이콘의 뜻·굵은 이름), 루트(서브모듈 배지).
// - 행 메뉴: 서브모듈 4개(옛 그대로) + 경로 복사, 하위 저장소 "저장소 탭으로 열기", 모듈 범위 토글·숨기기, 루트의 상위 저장소.
// - 머리 메뉴: 보이는 조건, 모듈 고르기 = 범위 토글 + 트리에서 드러내기(접힌 조상이 펼쳐지고 그 행이 골라진다), 서브모듈
//   머리 동작 넷과 꺼짐, 목록 → 트리에서 드러내기.
// - 트리 위 띠: 범위 표시와 한 번에 풀기, 상위 저장소 링크.
// - 더블클릭은 펼침(탭을 열지 않는다), 키보드 공용 규칙, 폴더 탭의 머리는 그대로.
// 옛 자리의 테스트를 옮긴 것: `repo-branch-tree-view.test.tsx` 의 superproject 클릭 → "상위 저장소" 케이스.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { revealLabel } from '../features/project/file-actions-menu';
import { ProjectTree } from '../features/project/ProjectTree';
import { flattenProjectTree } from '../features/project/project-tree-model';
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

// 목 저장소 장면 (storefront-web): 모듈 다섯(직접 추가 tools 포함, cart 변경 4·checkout 변경 1), 서브모듈 다섯(상태 다섯
// 가지, vendor/design-system 은 모듈이기도 하다), 하위 저장소 둘(experiments·playground)
const REPO = '/mock/storefront-web';
const originalClient = useAppStore.getState().client;
const originalOpen = useAppStore.getState().openRepositoryAt;
let mounted: SessionId[] = [];

/** 저장소 탭 하나를 `openRepositoryAt` 처럼 등록하고 앱 전체를 그린다. 왼쪽은 Project 도구 창 */
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
  // 생성 때 읽기(모듈·서브모듈)가 끝나기를 기다린다
  await act(async () => {
    await store.getState().loadModules();
    await store.getState().loadSubmodules();
  });
  await tick();
  return { mock, id, store, st: () => store.getState(), openRepositoryAt };
}

/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
const project = () => within(area('project') as HTMLElement);
const tree = () => project().getByRole('tree', { name: S.project.tree });
const menuButton = () => project().queryByRole('button', { name: S.project.structure.menu });
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 메뉴 항목 하나의 글자 (라디오의 고름 표시 ● 는 뺀다 — 고름은 aria-checked 로 본다), 꺼짐 ` [off]` */
const itemText = (el: Element) =>
  `${(el.textContent ?? '').replace('●', '')}${el.hasAttribute('data-disabled') ? ' [off]' : ''}`;
/** 열린 메뉴의 항목: 구분선 `─`, 꺼짐 ` [off]` */
const menuShape = () =>
  [...(document.querySelector('[role="menu"]')?.children ?? [])].flatMap((el) => {
    if (el.getAttribute('role') === 'separator') {
      return ['─'];
    }
    if (el.getAttribute('role') === 'group') {
      return [...el.children].map(itemText);
    }
    return [itemText(el)];
  });

/**
 * 열린 메뉴의 라디오 항목. 공용 드롭다운은 고른 항목의 표시 글자(●)가 이름 앞에 붙으므로 끝 맞춤으로 찾는다 (필터 바
 * 테스트와 같은 방식)
 */
const radio = (label: string) =>
  screen.getByRole('menuitemradio', {
    name: new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  });

/** 트리 행 (작업 트리 기준 경로). 지금 펼친 트리에서의 위치로 찾는다 (가상 스크롤 행에는 경로가 적혀 있지 않다) */
function prow(
  st: () => { fileTree: { getState(): { dirs: never; expanded: never } } },
  path: string,
) {
  const t = st().fileTree.getState();
  const index = flattenProjectTree(t.dirs, t.expanded).findIndex((r) => r.id === path);
  const el = tree().querySelector<HTMLElement>(`[data-row-index="${index}"]`);
  if (index < 0 || !el) {
    throw new Error(`행 없음: ${path}`);
  }
  return el;
}

/** 트리에서 그 경로를 드러낸다 (머리의 "열린 파일 찾기"와 같은 스토어 동작) */
async function revealInTree(
  st: () => { fileTree: { getState(): { reveal(p: string): Promise<void> } } },
  path: string,
) {
  await act(async () => {
    await st().fileTree.getState().reveal(path);
  });
  await tick();
}

/** 머리 메뉴를 연다 (키보드 Enter — Radix 메뉴) */
async function openStructureMenu() {
  const button = menuButton();
  if (!button) {
    throw new Error('메뉴 단추 없음');
  }
  act(() => {
    fireEvent.keyDown(button, { key: 'Enter' });
  });
  await tick();
}

/** 열린 메뉴(우클릭·머리)를 닫는다 */
async function closeMenu() {
  const menu = screen.queryByRole('menu');
  if (menu) {
    act(() => {
      fireEvent.keyDown(menu, { key: 'Escape' });
    });
    await tick();
  }
}

/** 행의 우클릭 메뉴를 연다 */
async function contextMenu(el: HTMLElement) {
  act(() => {
    fireEvent.contextMenu(el);
  });
  await tick();
}

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

describe('머리 메뉴 (⋮) — 펼치지 않아도 닿게', () => {
  it('보이는 조건: 모듈·서브모듈·하위 저장소가 있으면 단추(툴팁에 개수), 하나도 없으면 없다. 범위만 걸려 있어도 있다', async () => {
    const { store } = await mountRepo();
    const button = menuButton() as HTMLElement;
    expect(button.title).toBe(`${S.project.structure.menu}\n모듈 5 · 서브모듈 5 · 하위 저장소 2`);
    // 도구 모음은 Tab 정지 하나이며 End로 마지막 메뉴 단추에 닿는다.
    const toolbar = button.closest('[role="toolbar"]');
    const first = toolbar?.querySelector<HTMLElement>('[tabindex="0"]');
    if (!first) throw new Error('Missing toolbar entry');
    act(() => {
      first.focus();
      fireEvent.keyDown(first, { key: 'End' });
    });
    expect(document.activeElement).toBe(button);
    act(() => store.setState({ modules: [], submodules: [], nestedRepos: [] }));
    await tick();
    expect(menuButton()).toBeNull();
    act(() => store.setState({ moduleScope: 'apps/x' }));
    await tick();
    expect(menuButton()?.title).toBe(`${S.project.structure.menu}\n모듈 0`);
  });

  it('모듈 고르기: 범위가 걸리고(그래프 경로 범위), 접힌 조상이 펼쳐지며 그 디렉터리 행이 골라진다. 메뉴는 닫힌다', async () => {
    const { st } = await mountRepo();
    await openStructureMenu();
    expect(menuShape().slice(0, 7)).toEqual([
      '모듈 5',
      S.modules.all,
      '@acme/ui',
      'cart · 변경 4',
      'checkout · 변경 1',
      'build-tools',
      '@acme/design-system',
    ]);
    expect(radio(S.modules.all).getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.click(radio('cart · 변경 4'));
    });
    await tick();
    await tick();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(st().moduleScope).toBe('src/features/cart');
    expect(st().graphQuery.pathScope).toEqual(['src/features/cart']);
    const t = st().fileTree.getState();
    expect(t.expanded.src).toBe(true);
    expect(t.expanded['src/features']).toBe(true);
    // 모듈 디렉터리 자신은 펼치지 않는다 (드러내기만)
    expect(t.expanded['src/features/cart']).toBeUndefined();
    expect(t.selected).toBe('src/features/cart');
    expect(prow(st as never, 'src/features/cart').getAttribute('aria-selected')).toBe('true');
    // 지금 범위인 모듈을 다시 고르면 풀린다 (옛 행 클릭과 같은 토글)
    await openStructureMenu();
    expect(radio('cart · 변경 4').getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.click(radio('cart · 변경 4'));
    });
    await tick();
    expect(st().moduleScope).toBeNull();
    expect(st().graphQuery.pathScope).toEqual([]);
  });

  it('busy 면 모듈·직접 추가·서브모듈 4동작이 꺼진다 ("전체"·다시 감지·목록은 켜짐). 진행 중 작업이면 서브모듈 4동작만', async () => {
    const { store } = await mountRepo();
    act(() => store.setState({ busy: true }));
    await tick();
    await openStructureMenu();
    expect(legacyMenuShape().filter((t) => t.endsWith('[off]'))).toEqual([
      '@acme/ui [off]',
      'cart · 변경 4 [off]',
      'checkout · 변경 1 [off]',
      'build-tools [off]',
      '@acme/design-system [off]',
      `${S.modules.add} [off]`,
      `${S.submodule.add} [off]`,
      `${S.submodule.sync} [off]`,
      `${S.submodule.batch} [off]`,
      `${S.submodule.updateRecursive} [off]`,
    ]);
    await closeMenu();
    act(() =>
      store.setState({ busy: false, op: { kind: 'merge', step: null, total: null } as never }),
    );
    await tick();
    await openStructureMenu();
    expect(legacyMenuShape().filter((t) => t.endsWith('[off]'))).toEqual([
      `${S.submodule.add} [off]`,
      `${S.submodule.sync} [off]`,
      `${S.submodule.batch} [off]`,
      `${S.submodule.updateRecursive} [off]`,
    ]);
  });

  it('서브모듈 머리 동작: sync·재귀 update 는 바로 부르고, 추가·일괄은 옛 대화상자(취소하면 부르지 않는다). 목록 항목은 트리에서 드러낸다', async () => {
    const { mock, id, st } = await mountRepo();
    // 세션 동작이 부르는 클라이언트 메서드를 본다 (화면은 렌더 때 고른 세션 동작을 쥐고 있다)
    const sync = vi.spyOn(mock, 'submoduleSync');
    const update = vi.spyOn(mock, 'submoduleUpdate');
    const add = vi.spyOn(mock, 'submoduleAdd');
    const batch = vi.spyOn(mock, 'submoduleBatch');
    const pick = async (name: string) => {
      await openStructureMenu();
      act(() => {
        fireEvent.click(screen.getByRole('menuitem', { name }));
      });
      await tick();
    };
    await pick(S.submodule.sync);
    expect(sync).toHaveBeenCalledWith(id);
    await pick(S.submodule.updateRecursive);
    expect(update).toHaveBeenCalledWith(id, true);
    await pick(S.submodule.add);
    expect(dialog()?.textContent).toContain(S.submodule.addTitle);
    act(() =>
      fireEvent.click(
        within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
      ),
    );
    await tick();
    expect(add).not.toHaveBeenCalled();
    await pick(S.submodule.batch);
    expect(dialog()?.textContent).toContain(S.submodule.batchTitle);
    act(() =>
      fireEvent.click(
        within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
      ),
    );
    await tick();
    expect(batch).not.toHaveBeenCalled();
    // 접힌 vendor/ 안의 서브모듈: 고르면 펼쳐져 그 행이 골라진다
    expect(st().fileTree.getState().expanded.vendor).toBeUndefined();
    await pick(`vendor/payment-sdk · ${S.submodule.status.mismatch}`);
    await tick();
    expect(st().fileTree.getState().expanded.vendor).toBe(true);
    expect(st().fileTree.getState().selected).toBe('vendor/payment-sdk');
    await pick('playground');
    await tick();
    expect(st().fileTree.getState().selected).toBe('playground');
  });

  it('모듈 직접 추가·다시 감지: 옛 대화상자(경로 필수·이름) → 수동 보정에 더해 목록에 생긴다. 다시 감지는 목록을 다시 읽는다', async () => {
    const { mock, st } = await mountRepo();
    const reload = vi.spyOn(mock, 'modules');
    await openStructureMenu();
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.modules.reload })));
    await tick();
    expect(reload).toHaveBeenCalledTimes(1);
    await openStructureMenu();
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.modules.add })));
    await tick();
    const d = within(dialog() as HTMLElement);
    expect(d.getByText(S.modules.addTitle)).toBeTruthy();
    act(() => {
      fireEvent.change(d.getByLabelText(S.modules.path), { target: { value: ' playground ' } });
      fireEvent.change(d.getByLabelText(S.modules.name), { target: { value: ' play ' } });
    });
    act(() => fireEvent.click(d.getByRole('button', { name: S.dialog.create })));
    await tick();
    await tick();
    expect(st().modules.find((m) => m.path === 'playground')).toEqual({
      name: 'play',
      path: 'playground',
      kind: 'manual',
    });
  });
});

describe('트리 위 띠 — 범위 표시와 상위 저장소 링크', () => {
  it('범위가 걸리면 "범위: 이름"·경로가 보이고 × 한 번으로 풀린다. 범위가 없으면 띠가 없다', async () => {
    const { st } = await mountRepo();
    expect(project().queryByText(S.project.structure.scope('cart'))).toBeNull();
    await act(async () => {
      await st().selectModule('src/features/cart');
    });
    await tick();
    expect(project().getByText(S.project.structure.scope('cart'))).toBeTruthy();
    expect(project().getByText('src/features/cart')).toBeTruthy();
    act(() => fireEvent.click(project().getByRole('button', { name: S.modules.clearScope })));
    await tick();
    expect(st().moduleScope).toBeNull();
    expect(st().graphQuery.pathScope).toEqual([]);
    expect(project().queryByText(S.project.structure.scope('cart'))).toBeNull();
  });

  it('상위 저장소 (옛 `repo-branch-tree-view` 의 superproject 클릭을 옮김): 띠의 링크(옛 글자·툴팁) → 그 저장소를 탭으로, 루트 행은 서브모듈 배지와 메뉴 첫 항목', async () => {
    const { store, st, openRepositoryAt } = await mountRepo();
    expect(project().queryByRole('button', { name: /상위 저장소/ })).toBeNull();
    act(() => store.setState({ superproject: '/mock/platform' }));
    await tick();
    const link = project().getByRole('button', { name: `${S.submodule.superproject} platform` });
    expect(link.title).toBe('/mock/platform');
    act(() => fireEvent.click(link));
    await tick();
    expect(openRepositoryAt).toHaveBeenCalledWith('/mock/platform');
    const root = prow(st as never, '');
    expect(root.textContent).toContain(S.folder.kind.submodule);
    await contextMenu(root);
    expect(legacyMenuShape()).toEqual([
      `${S.submodule.superproject} platform`,
      '─',
      S.folder.refresh,
      '─',
      revealLabel(),
      S.actions.openTerminal,
      '─',
      S.project.menu.copyPath,
    ]);
    act(() =>
      fireEvent.click(
        screen.getByRole('menuitem', { name: `${S.submodule.superproject} platform` }),
      ),
    );
    await tick();
    expect(openRepositoryAt).toHaveBeenCalledTimes(2);
  });
});

describe('행 장식과 행 메뉴', () => {
  it('모듈 디렉터리: 아이콘의 뜻 "모듈"·변경 수, 우클릭 = 이 모듈만 보기·숨기기 ─ 경로 복사. 범위면 "범위" 배지와 범위 해제. 숨기면 장식이 사라진다', async () => {
    const { st } = await mountRepo();
    await revealInTree(st as never, 'src/features/cart');
    const cart = () => prow(st as never, 'src/features/cart');
    expect(within(cart()).getByRole('img', { name: S.project.structure.moduleIcon })).toBeTruthy();
    expect(cart().textContent).toContain(S.project.changed(4));
    await contextMenu(cart());
    expect(legacyMenuShape()).toEqual([
      S.modules.scopeTo,
      S.modules.hide,
      '─',
      // 모듈 안의 변경 4개를 되돌리기, untracked 항목이 있어 ignore (파일 메뉴)
      S.project.menu.many(S.project.menu.rollback, 4),
      `${S.safety.ignore}▸`,
      '─',
      revealLabel(),
      S.actions.openTerminal,
      '─',
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.modules.scopeTo })));
    await tick();
    expect(st().moduleScope).toBe('src/features/cart');
    expect(cart().textContent).toContain(S.modules.scopeBadge);
    await contextMenu(cart());
    expect(legacyMenuShape()[0]).toBe(S.modules.clearScope);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.modules.hide })));
    await tick();
    await tick();
    // 숨긴 모듈이 범위였으면 범위도 풀린다 (세션 동작 그대로)
    expect(st().moduleScope).toBeNull();
    expect(st().modules.some((m) => m.path === 'src/features/cart')).toBe(false);
    expect(within(cart()).queryByRole('img', { name: S.project.structure.moduleIcon })).toBeNull();
  });

  it('서브모듈 디렉터리: 서브모듈 배지·상태 문구, ⇧F10 메뉴 = 옛 4개 + 경로 복사. 열기 → 작업 트리/경로, 제거 → 옛 확인창(취소면 부르지 않는다)', async () => {
    const { mock, st, openRepositoryAt } = await mountRepo();
    const remove = vi.spyOn(mock, 'submoduleRemove');
    await revealInTree(st as never, 'vendor/payment-sdk');
    const row = () => prow(st as never, 'vendor/payment-sdk');
    expect(row().textContent).toContain(S.folder.kind.submodule);
    expect(row().textContent).toContain('커밋 다름');
    // ⇧F10 = 고른 행의 메뉴 (reveal 이 그 행을 골랐다)
    act(() => tree().focus());
    act(() => {
      fireEvent.keyDown(tree(), { key: 'F10', shiftKey: true });
    });
    await tick();
    expect(legacyMenuShape()).toEqual([
      S.submodule.open,
      S.submodule.updateRemote,
      S.submodule.setBranch,
      '─',
      S.submodule.remove,
      '─',
      // 서브모듈 안 변경은 그 저장소 몫이라 되돌리기가 없다 (Finder·터미널만)
      revealLabel(),
      S.actions.openTerminal,
      '─',
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.submodule.open })));
    await tick();
    expect(openRepositoryAt).toHaveBeenCalledWith(`${REPO}/vendor/payment-sdk`);
    await contextMenu(row());
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.submodule.remove })));
    await tick();
    const d = dialog() as HTMLElement;
    expect(d.textContent).toContain(S.submodule.removeTitle('vendor/payment-sdk'));
    expect(d.textContent).toContain(S.submodule.removeMessage);
    // 위험 확인창: 제거 단추가 위험 모양
    expect(within(d).getByRole('button', { name: S.submodule.removeConfirm }).className).toMatch(
      /danger/,
    );
    act(() => fireEvent.click(within(d).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(remove).not.toHaveBeenCalled();
  });

  it('초기화 안 된 서브모듈: 펼치면 "비어 있음", 메뉴의 update --remote 만 꺼진다 (옛 조건)', async () => {
    const { st } = await mountRepo();
    await revealInTree(st as never, 'vendor/legacy-theme');
    const row = () => prow(st as never, 'vendor/legacy-theme');
    expect(row().textContent).toContain('미초기화');
    act(() => fireEvent.click(row()));
    await tick();
    await tick();
    expect(st().fileTree.getState().expanded['vendor/legacy-theme']).toBe(true);
    expect(tree().textContent).toContain(S.project.empty);
    await contextMenu(row());
    expect(legacyMenuShape().filter((t) => t.endsWith('[off]'))).toEqual([
      `${S.submodule.updateRemote} [off]`,
    ]);
  });

  it('하위 저장소: 아이콘의 뜻 "하위 저장소"·굵은 이름, 더블클릭은 펼침(탭을 열지 않는다), 메뉴 "저장소 탭으로 열기" → 절대 경로', async () => {
    const { st, openRepositoryAt } = await mountRepo();
    const row = () => prow(st as never, 'experiments');
    expect(within(row()).getByRole('img', { name: S.project.structure.nestedIcon })).toBeTruthy();
    act(() => {
      fireEvent.click(row(), { detail: 1 });
      fireEvent.click(row(), { detail: 2 });
      fireEvent.doubleClick(row());
    });
    await tick();
    expect(st().fileTree.getState().expanded.experiments).toBe(true);
    expect(openRepositoryAt).not.toHaveBeenCalled();
    await contextMenu(row());
    expect(legacyMenuShape()).toEqual([
      S.project.openAsTab,
      '─',
      // 하위 저장소(통째로 untracked 인 디렉터리)는 백업할 수 없어 되돌리기·ignore 대상이 아니다
      revealLabel(),
      S.actions.openTerminal,
      '─',
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.project.openAsTab })));
    await tick();
    expect(openRepositoryAt).toHaveBeenCalledWith(`${REPO}/experiments`);
  });

  it('서브모듈 안 파일에는 히스토리·Blame 이 없다 (상위 저장소가 추적하지 않는다 — 하위 저장소와 같은 규칙)', async () => {
    const { st } = await mountRepo();
    await revealInTree(st as never, 'vendor/payment-sdk/README.md');
    await contextMenu(prow(st as never, 'vendor/payment-sdk/README.md'));
    expect(menuShape()).not.toContain(S.menu.fileHistory);
    expect(menuShape()).not.toContain(S.menu.blame);
    await closeMenu();
    // 작업 트리 자신의 파일에는 그대로 있다
    await contextMenu(prow(st as never, 'package.json'));
    expect(menuShape()).toContain(S.menu.fileHistory);
  });

  it('키보드: 장식이 붙은 트리도 공용 규칙(단계·형제 수·순번·Home·↓·⇧F10)을 지킨다', async () => {
    const { st } = await mountRepo();
    await revealInTree(st as never, 'vendor/design-system');
    checkTreeRules(tree());
  });
});

describe('ProjectTree 뷰의 새 자리 (tools·banner) — 폴더 탭은 그대로', () => {
  const base = {
    root: { name: 'acme', detail: '/w/acme' },
    rows: flattenProjectTree({}, { '': true }),
    selected: null,
    decorate: () => null,
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    menu: () => [],
    onRefresh: vi.fn(),
    busy: false,
  };

  it('주지 않으면 머리 단추와 띠가 전과 같다 (폴더 탭: 찾기·새로고침·다시 스캔·설정)', () => {
    const { container } = render(
      <ProjectTree {...base} onRescan={vi.fn()} onLocate={vi.fn()} onSettings={vi.fn()} />,
    );
    expect(
      [...(container.querySelector('header')?.querySelectorAll('button') ?? [])].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual([S.project.locate, S.folder.refresh, S.folder.rescan, S.project.settings]);
    // 머리 다음은 곧바로 트리 (띠가 없다)
    expect(
      container.querySelector('header')?.nextElementSibling?.querySelector('[role="tree"]'),
    ).toBeTruthy();
  });

  it('tools 는 머리 끝에, banner 는 머리와 트리 사이에 그린다', () => {
    const { container } = render(
      <ProjectTree
        {...base}
        tools={<button type="button">도구</button>}
        banner={<div data-testid="banner" />}
      />,
    );
    const header = container.querySelector('header') as HTMLElement;
    expect(header.lastElementChild?.textContent).toBe('도구');
    expect(header.nextElementSibling?.getAttribute('data-testid')).toBe('banner');
  });
});

/** 기존 Git 메뉴의 순서를 파일 관리 공통 묶음과 독립적으로 검증한다. */
function legacyMenuShape() {
  const labels = [
    S.projectEdit.newFile,
    S.projectEdit.newFolder,
    S.projectEdit.rename,
    S.projectEdit.copy,
    S.projectEdit.cut,
    S.projectEdit.paste,
    S.projectEdit.trash,
  ];
  const result = menuShape().filter((label) => !labels.some((prefix) => label.startsWith(prefix)));
  return result.filter(
    (label, index) =>
      label !== '─' || (index > 0 && index < result.length - 1 && result[index - 1] !== '─'),
  );
}
