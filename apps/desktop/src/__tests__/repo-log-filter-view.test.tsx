// W26: 저장소 탭 로그 위의 필터 바 (LG-15). 앱 전체를 그려 옛 머리줄·필터 바가 없고 같은 기능이 필터 바·보기 옵션·찾기
// 줄에서 닿는지, 세션 스토어(질의·작성자·모듈 범위)와 이어지는지, 본문 상태와 목록 모드의 다시 마운트를 확인한다.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type GraphRow, type SessionId } from '@mgit/ipc';
import { formatShortcut, S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import {
  clearSessionRegistry,
  disposeWorkspace,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그 뷰는 jsdom 에서 그리지 않는다: 마운트 수와 마지막 props 만 기록한다 (다시 마운트 = 목록 모드 전환)
const views = vi.hoisted(() => ({ mounts: 0, last: null as GraphViewProps | null }));
vi.mock('@mgit/graph-view', async (orig) => {
  const { useEffect } = await import('react');
  return {
    ...(await orig<typeof import('@mgit/graph-view')>()),
    GraphView: (props: GraphViewProps) => {
      useEffect(() => {
        views.mounts += 1;
      }, []);
      views.last = props;
      return <div data-testid="graph-view" />;
    },
  };
});
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

const REPO = '/mock/storefront-web';
const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 저장소 탭 하나를 등록하고 앱 전체를 그린다 (`repo-workspace-shell.test.tsx` 와 같은 준비) */
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
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path: REPO, name: 'storefront-web', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      conflictLeave: null,
    }),
  );
  render(<App />);
  await tick();
  return { mock, id, st: () => store.getState(), set: store.setState };
}

/** 로그 칸 */
const log = () => within(document.querySelector('[data-panel="git-log"]') as HTMLElement);
const bar = () => document.querySelector('[data-panel="git-log"] [data-filter-bar]') as HTMLElement;
/** 필터 바의 드롭다운 단추 (요약 글자로 시작) */
const dropButton = (name: string) =>
  within(bar())
    .getAllByRole<HTMLButtonElement>('button')
    .find(
      (b) => b.getAttribute('aria-haspopup') === 'dialog' && b.textContent?.startsWith(name),
    ) as HTMLButtonElement;
const popover = () => screen.queryByRole('dialog');
const textInput = () =>
  within(bar()).getByRole<HTMLInputElement>('textbox', { name: S.filterBar.textLabel });
/** 텍스트를 넣고 Enter */
async function applyText(value: string) {
  act(() => fireEvent.change(textInput(), { target: { value } }));
  act(() => {
    fireEvent.keyDown(textInput(), { key: 'Enter' });
  });
  await tick();
}
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  views.mounts = 0;
  views.last = null;
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
    }),
  );
  for (const id of mounted) {
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('옛 자리와 새 자리 (LG-15, W26)', () => {
  it('로그 위는 공용 필터 바이고 옛 머리줄(검색·필터 토글·옵션 ▾·요약 ×)과 옛 필터 바(ref select·원격 숨기기·경로 입력·초기화)는 그리지 않는다', async () => {
    await mountRepo();
    expect(bar()).not.toBeNull();
    expect(log().getByTestId('graph-view')).toBeTruthy();
    // 옛 단추의 이름 (W28 에서 그 문자열을 지웠으므로 글자로 적는다)
    for (const old of ['🔍 검색', '▾ 필터', '옵션 ▾', '초기화', '필터 초기화']) {
      expect(log().queryByRole('button', { name: old }), old).toBeNull();
    }
    expect(document.querySelector('[data-panel="git-log"] select')).toBeNull();
    expect(log().queryByPlaceholderText(S.graph.filter.pathPlaceholder)).toBeNull();
    // 새 바의 요소: 텍스트·토글, branch·작성자·날짜·경로, 상태, 찾기, 보기 옵션, 다시 읽기 (저장소 드롭다운 없음)
    for (const name of [
      S.filterBar.branch,
      S.filterBar.author,
      S.filterBar.date,
      S.filterBar.path,
    ]) {
      expect(dropButton(name), name).toBeTruthy();
    }
    expect(dropButton(S.filterBar.repo)).toBeUndefined();
    expect(within(bar()).getByText(S.folder.timeline.rows(60))).toBeTruthy();
    for (const name of [S.filterBar.find, S.filterBar.viewOptions, S.filterBar.refresh]) {
      expect(within(bar()).getByRole('button', { name }), name).toBeTruthy();
    }
  });

  it('찾기 단추(옛 "검색")가 찾기 줄을 여닫고, 찾기 줄은 필터 바 아래·그래프 위에 뜬다. 툴팁에 ⌘F', async () => {
    const { st } = await mountRepo();
    const find = within(bar()).getByRole('button', { name: S.filterBar.find });
    expect(find.getAttribute('aria-pressed')).toBe('false');
    expect(find.title).toBe(S.filterBar.findTitle(formatShortcut('mod+f')));
    act(() => fireEvent.click(find));
    await tick();
    expect(st().search.open).toBe(true);
    expect(find.getAttribute('aria-pressed')).toBe('true');
    const search = log().getByPlaceholderText(S.search.placeholder);
    // 찾기 줄이 뜨면 그 입력란에 포커스 (GraphSearch 그대로)
    expect(document.activeElement).toBe(search);
    const graph = log().getByTestId('graph-view');
    expect(bar().compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => fireEvent.click(find));
    await tick();
    expect(st().search.open).toBe(false);
    expect(log().queryByPlaceholderText(S.search.placeholder)).toBeNull();
  });
});

describe('branch 드롭다운 = 옛 "표시할 ref" (W26)', () => {
  it('브랜치 트리 메뉴의 solo 가 드롭다운에 체크로 보이고, HEAD·로컬·원격 항목이 있다', async () => {
    const { st } = await mountRepo();
    // 브랜치 트리 메뉴 "이 branch 만 그래프에 표시"와 같은 질의 (repo-branch-menu 의 solo)
    await act(async () => {
      await st().setGraphQuery({ ...st().graphQuery, revs: { kind: 'solo', name: 'origin/main' } });
    });
    expect(dropButton(S.filterBar.branch).textContent).toBe('브랜치: origin/main');
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    const options = within(popover() as HTMLElement).getAllByRole('option');
    expect(options[0]?.textContent).toBe(S.branches.head);
    const names = options.map((o) => o.textContent ?? '');
    expect(names.some((n) => n.startsWith('main'))).toBe(true);
    const picked = options.find((o) => o.textContent === 'origin/main');
    expect(picked?.getAttribute('aria-selected')).toBe('true');
    // HEAD 를 고르면 head 범위 (W6 — HEAD 를 따라간다)
    act(() => fireEvent.click(options[0] as HTMLElement));
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    await tick();
    expect(st().graphQuery.revs).toEqual({ kind: 'head' });
    expect(dropButton(S.filterBar.branch).textContent).toBe(
      `${S.filterBar.branch}: ${S.branches.head}`,
    );
  });

  it('"ref 이름 입력…" 은 옛 대화상자 그대로다 (제목·필드·처음 값 = 현재 branch). 여럿이면 branches, 취소하면 그대로', async () => {
    const { st } = await mountRepo();
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    act(() =>
      fireEvent.click(
        within(popover() as HTMLElement).getByRole('button', { name: S.filterBar.customRefs }),
      ),
    );
    await tick();
    const d = dialog() as HTMLElement;
    expect(d.textContent).toContain(S.graph.filter.customTitle);
    const field = within(d).getByLabelText(S.graph.filter.customField) as HTMLInputElement;
    expect(field.value).toBe('main');
    act(() => fireEvent.change(field, { target: { value: ' main ,  development, ' } }));
    act(() => fireEvent.submit(d.querySelector('form') as HTMLFormElement));
    await tick();
    expect(st().graphQuery.revs).toEqual({ kind: 'branches', names: ['main', 'development'] });
    // 다시 열면 처음 값이 지금 이름들. 취소하면 바뀌지 않는다
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    act(() =>
      fireEvent.click(
        within(popover() as HTMLElement).getByRole('button', { name: S.filterBar.customRefs }),
      ),
    );
    await tick();
    const again = dialog() as HTMLElement;
    expect(
      (within(again).getByLabelText(S.graph.filter.customField) as HTMLInputElement).value,
    ).toBe('main, development');
    act(() => fireEvent.click(within(again).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(st().graphQuery.revs).toEqual({ kind: 'branches', names: ['main', 'development'] });
  });
});

describe('텍스트·경로·모듈 범위 (W26)', () => {
  it('텍스트를 Enter 로 걸면 질의에 실리고 상태가 "N개 일치". 잘못된 정규식은 입력란 아래 안내 + 이전 질의 그대로', async () => {
    const { st } = await mountRepo();
    await applyText('fix:');
    expect(st().graphQuery.filter?.text?.pattern).toBe('fix:');
    expect(within(bar()).getByText(S.folder.timeline.matched(st().totalRows))).toBeTruthy();
    // 정규식 켜고 '('
    act(() => fireEvent.click(within(bar()).getByRole('button', { name: S.filterBar.regex })));
    await tick();
    await applyText('(');
    expect(within(bar()).getByRole('alert').textContent).toContain('(');
    expect(st().graphQuery.filter?.text?.pattern).toBe('fix:');
    expect(textInput().getAttribute('aria-invalid')).toBe('true');
    // 입력을 고치면 안내가 사라진다
    act(() => fireEvent.change(textInput(), { target: { value: '(x)' } }));
    expect(within(bar()).queryByRole('alert')).toBeNull();
    expect(st().filterError).toBeNull();
  });

  it('모듈을 고르면 경로 칩이 모듈 이름으로 뜨고, 필터 바에서 경로를 풀면 Project 띠의 "범위"도 사라진다', async () => {
    const { st } = await mountRepo();
    await act(async () => {
      await st().selectModule('src/features/cart');
    });
    await tick();
    const chip = dropButton(S.filterBar.path);
    expect(chip.textContent).toBe('경로: cart');
    expect(chip.title).toBe(`경로: ${S.filterBar.pathModule('src/features/cart')}`);
    expect(document.querySelector('[data-kind="scope"]')).not.toBeNull();
    act(() =>
      fireEvent.click(
        within(bar()).getByRole('button', { name: S.filterBar.clearCondition('경로: cart') }),
      ),
    );
    await tick();
    expect(st().graphQuery.pathScope).toEqual([]);
    expect(st().moduleScope).toBeNull();
    expect(document.querySelector('[data-kind="scope"]')).toBeNull();
  });

  it('콘솔 탭에 다녀와도(로그가 내려갔다 올라와도) 걸어 둔 조건이 그대로 보인다', async () => {
    await mountRepo();
    await applyText('fix:');
    act(() => useAppStore.getState().toggleDock('git', 'console'));
    await tick();
    expect(document.querySelector('[data-filter-bar]')).toBeNull();
    act(() => useAppStore.getState().toggleDock('git', 'log'));
    await tick();
    expect(textInput().value).toBe('fix:');
  });

  it('쓰기 중(busy)에는 질의를 바꾸는 조작이 잠긴다 (aria-disabled — 옛 바도 ref·경로를 껐다)', async () => {
    const { set } = await mountRepo();
    act(() => set({ busy: true }));
    for (const name of [
      S.filterBar.branch,
      S.filterBar.path,
      S.filterBar.author,
      S.filterBar.date,
    ]) {
      expect(dropButton(name).getAttribute('aria-disabled'), name).toBe('true');
    }
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    expect(popover()).toBeNull();
    act(() => set({ busy: false }));
    expect(dropButton(S.filterBar.branch).hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('본문 상태 (LG-11, W26)', () => {
  it('조건이 걸려 0행이면 폴더처럼 "필터와 일치하는 커밋이 없습니다" + 조건 요약 + "필터 지우기"(경로까지 지우고 보기 옵션은 남김)', async () => {
    const { st, set } = await mountRepo();
    await applyText('zzz');
    await act(async () => {
      await st().setGraphQuery({ ...st().graphQuery, pathScope: ['src'], noMerges: true });
    });
    const zero = { ...st().status.summary, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    act(() =>
      set({ totalRows: 0, loadState: 'complete', status: { ...st().status, summary: zero } }),
    );
    expect(log().getByText(S.folder.timeline.noMatch)).toBeTruthy();
    expect(log().getByText(`${S.filterBar.textCondition('zzz', false)} · 경로: src`)).toBeTruthy();
    expect(log().queryByTestId('graph-view')).toBeNull();
    act(() => fireEvent.click(log().getByRole('button', { name: S.folder.timeline.clearFilters })));
    await tick();
    expect(st().graphQuery.filter?.text?.pattern).toBe('');
    expect(st().graphQuery.pathScope).toEqual([]);
    expect(st().graphQuery.noMerges).toBe(true);
  });

  it('작업 트리 변경(WIP 행)이 있으면 로그는 WIP 행을 남기고, 결과 없음은 로그 위 한 줄 안내 + "필터 지우기"로 알린다', async () => {
    const { st, set } = await mountRepo();
    await applyText('zzz');
    act(() => set({ totalRows: 0, loadState: 'complete' }));
    expect(log().getByTestId('graph-view')).toBeTruthy();
    expect(views.last?.wipRow).not.toBeNull();
    const notice = log().getByRole('status');
    expect(notice.textContent).toContain(S.folder.timeline.noMatch);
    expect(notice.textContent).toContain(S.filterBar.textCondition('zzz', false));
    act(() =>
      fireEvent.click(within(notice).getByRole('button', { name: S.folder.timeline.clearFilters })),
    );
    await tick();
    expect(st().graphQuery.filter?.text?.pattern).toBe('');
  });

  it('보기 옵션만으로 0행이면 옛 안내, 조건 없는 빈 저장소는 "commit이 없습니다" — 둘 다 필터 바가 남는다', async () => {
    const { st, set } = await mountRepo();
    const zero = { ...st().status.summary, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    act(() => set({ totalRows: 0, status: { ...st().status, summary: zero } }));
    expect(log().getByText(S.panel.graphNoCommits)).toBeTruthy();
    expect(bar()).not.toBeNull();
    await act(async () => {
      await st().setGraphQuery({ ...st().graphQuery, firstParent: true });
    });
    act(() => set({ totalRows: 0, loadState: 'complete' }));
    expect(log().getByText(S.panel.graphNoMatch)).toBeTruthy();
    expect(bar()).not.toBeNull();
  });

  it('여는 중·읽기 실패에도 필터 바가 보여 조건을 풀 수 있다 (안내 글자는 그대로)', async () => {
    const { st, set } = await mountRepo();
    await applyText('fix:');
    act(() => set({ loadState: 'opening' }));
    expect(log().getByText(S.panel.graphLoading)).toBeTruthy();
    expect(within(bar()).getByText(S.folder.timeline.loading)).toBeTruthy();
    act(() => set({ loadState: 'error', error: '로드 실패' }));
    expect(log().getByText('로드 실패')).toBeTruthy();
    act(() => fireEvent.click(within(bar()).getByRole('button', { name: S.filterBar.clearAll })));
    await tick();
    expect(st().graphQuery.filter?.text?.pattern).toBe('');
  });
});

describe('목록 모드의 다시 마운트 (W26)', () => {
  /** 로그 뷰에 그린 행을 알린다 */
  const rendered = (lanes: number[]) =>
    act(() => {
      views.last?.onRowsRendered?.(
        lanes.map((lane, row) => ({ lane, row }) as unknown as GraphRow),
      );
    });

  it('목록 모드로 바뀔 때·돌아올 때만 다시 마운트하고, 목록 모드의 다시 읽기에는 마운트를 유지한다', async () => {
    await mountRepo();
    const start = views.mounts;
    await applyText('fix:');
    expect(views.mounts).toBe(start + 1);
    // 목록 데이터(레인 0)를 그리고 다시 읽혀도 그대로
    rendered([0, 0, 0]);
    await applyText('feat');
    rendered([0, 0]);
    expect(views.mounts).toBe(start + 1);
    // 그래프로 돌아오면 다시 마운트
    act(() => fireEvent.click(within(bar()).getByRole('button', { name: S.filterBar.clearAll })));
    await tick();
    expect(views.mounts).toBe(start + 2);
  });

  it('목록 모드로 다시 마운트한 뷰가 아직 옛 그래프 데이터(레인 > 0)를 그렸으면 새 데이터를 그릴 때 한 번 더 마운트한다', async () => {
    await mountRepo();
    const start = views.mounts;
    await applyText('fix:');
    expect(views.mounts).toBe(start + 1);
    rendered([0, 2, 1]);
    expect(views.mounts).toBe(start + 1);
    rendered([0, 0]);
    expect(views.mounts).toBe(start + 2);
    // 그 뒤로는 그대로
    rendered([0, 0, 0]);
    expect(views.mounts).toBe(start + 2);
  });
});
