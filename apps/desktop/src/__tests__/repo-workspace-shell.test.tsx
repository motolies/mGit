// W21 ①: 저장소 탭의 셸 전환. 저장소 탭이 폴더 탭과 같은 틀(WS-15)에 그려지는지, 옛 3단 배치(W28 에서 지웠다)가 그려지지
// 않는지, 옮겨 실은 부품(옛 사이드바·그래프·상세·변경 사항)이 새 자리에서 그대로 동작하는지 앱 전체를 그려 확인한다.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { getSessionStore, getWorkspaceStore, useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import {
  clearSessionRegistry,
  disposeWorkspace,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { conflictDocId, tagsDocId, worktreeDiffDocId } from '../store/workspace-store';
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

// 목 장면: 저장소 장면(storefront-web)과 충돌 장면(checkout-service)
const REPO = '/mock/storefront-web';
const CONFLICT_REPO = '/mock/checkout-service';
const PAY = 'src/features/checkout/steps/PaymentStep.tsx';
const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/**
 * 저장소 탭 하나를 앱 스토어의 `openRepositoryAt` 처럼 등록하고(세션 스토어 + "보여라" 훅 + 저장소 워크스페이스) 앱 전체를
 * 그린다. 아래 도구 창은 Git 로그 탭, 왼쪽은 Project
 */
async function mountRepo(scene: 'repo' | 'conflict' = 'repo') {
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
  // 그래프는 다 읽은 것으로 둔다 (이 시험은 그래프 로드 이벤트를 잇지 않는다)
  store.setState({ loadState: 'complete', totalRows: 60 });
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  const name = path.slice(path.lastIndexOf('/') + 1);
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path, name, parent: null } },
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
  return { mock, id, st: () => store.getState(), ws: () => getWorkspaceStore(id)?.getState() };
}

/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
/** 영역 안에서 찾기 */
const inArea = (name: string) => within(area(name) as HTMLElement);
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 키를 누른다 (앱은 window 에서 받는다) */
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });
/** 지금 포커스가 든 영역 이름 */
const focusedArea = () =>
  document.activeElement
    ?.closest('[data-panel]:not([data-panel="true"])')
    ?.getAttribute('data-panel') ?? null;

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

describe('저장소 탭의 화면 틀 (WS-15, W21)', () => {
  it('폴더 탭과 같은 띠·왼쪽 도구 창·에디터 공간·Git 도구 창(브랜치 트리 + 옛 사이드바의 남은 섹션 | 그래프 | 상세)에 그리고, 옛 3단 배치는 없다', async () => {
    await mountRepo();
    // 왼쪽 띠: Project·Commit(·Pull Requests — 목 저장소 장면은 GitHub 원격 프로젝트가 있다, W24) / Git·터미널
    const stripe = screen.getByRole('toolbar', { name: S.workspace.stripe });
    expect(
      within(stripe)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      S.project.title,
      S.commitTool.title,
      S.pr.title('github'),
      S.dock.git,
      S.terminal.title,
    ]);
    for (const name of ['project', 'editor', 'git-branches', 'git-log', 'git-detail']) {
      expect(area(name), name).not.toBeNull();
    }
    // 옛 3단 배치의 영역(sidebar·center·detail)은 그리지 않는다
    for (const name of ['sidebar', 'center', 'detail']) {
      expect(area(name), name).toBeNull();
    }
    // Git 도구 창: [로그][콘솔], 로그 탭이 골라져 있다
    const dock = within(screen.getByRole('region', { name: S.dock.label }));
    expect(dock.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      S.dock.tabs.log,
      S.dock.tabs.console,
    ]);
    // 왼쪽 칸 (W22) = 브랜치 트리(로컬·원격·태그 그룹 — 옛 사이드바 섹션을 옮긴 것) + 옛 사이드바의 남은 섹션(PR·모듈 등).
    // 스태시는 W23 에서 Commit 도구 창의 Stash 탭으로 옮겨 여기에 없다
    const tree = inArea('git-branches').getByRole('tree', { name: S.branches.tree });
    for (const id of ['group:local', 'group:remote', 'group:tags']) {
      expect(tree.querySelector(`[data-node-id="${id}"]`), id).not.toBeNull();
    }
    // 옛 섹션 제목 "스태시"·"로컬 브랜치" (W28 에서 그 문자열을 지웠으므로 글자로 적는다)
    expect(inArea('git-branches').queryByText('스태시')).toBeNull();
    expect(inArea('git-branches').queryByText('로컬 브랜치')).toBeNull();
    // 가운데 칸 = 그래프 (머리줄·그래프 뷰)
    expect(inArea('git-log').getByTestId('graph-view')).toBeTruthy();
    expect(inArea('git-log').getByRole('button', { name: /옵션/ })).toBeTruthy();
    // 오른쪽 칸 = 아무것도 안 골랐으므로 빈 상태 (변경 요약 + Commit 도구 창 열기)
    expect(inArea('git-detail').getByText(S.workspace.repoLog.pickCommit)).toBeTruthy();
    // 에디터 공간: 문서가 없으면 단축키 안내, 개요 탭(과 "개요 열기")은 없다 (ED-11)
    expect(inArea('editor').getByText(S.workspace.empty.title)).toBeTruthy();
    expect(inArea('editor').queryByText(S.workspace.empty.openOverview)).toBeNull();
    expect(inArea('editor').queryByRole('tab')).toBeNull();
  });

  it('빈 에디터 공간의 "tag 관리 열기" 링크는 팔레트(view.tagsDoc)처럼 태그 문서를 고정 탭으로 연다', async () => {
    const { ws } = await mountRepo();
    fireEvent.click(inArea('editor').getByRole('button', { name: S.tag.doc.open }));
    await tick();
    const doc = ws()?.docs.find((d) => d.kind === 'tags');
    expect(doc?.id).toBe(tagsDocId(REPO));
    expect(ws()?.activeDocId).toBe(doc?.id);
    expect(inArea('editor').getByRole('tab', { name: new RegExp(S.tag.doc.title) })).toBeTruthy();
    // 문서가 열렸으니 빈 화면(과 링크)은 사라진다
    expect(inArea('editor').queryByText(S.workspace.empty.title)).toBeNull();
  });

  it('상세 칸은 범위 → commit → 빈 상태 순으로 고르고 스태시는 그리지 않는다 (CD-09, W23). 빈 상태는 변경 수와 Commit 도구 창(변경 탭) 진입', async () => {
    const { st } = await mountRepo();
    const detail = () => inArea('git-detail');
    // 빈 상태: 작업 트리 변경 요약 (목 장면: staged 4 · 변경 4 · untracked 2)
    const summary = st().status.summary;
    expect(detail().getByText(S.status.staged(summary.staged))).toBeTruthy();
    expect(detail().getByText(S.status.unstaged(summary.unstaged))).toBeTruthy();
    expect(detail().getByText(S.status.untracked(summary.untracked))).toBeTruthy();
    expect(detail().getByText(S.status.conflicted(summary.conflicted))).toBeTruthy();
    // commit 을 고르면 commit 상세
    act(() => st().selectCommit('a'.repeat(40)));
    await tick();
    expect(detail().queryByText(S.workspace.repoLog.pickCommit)).toBeNull();
    // 범위를 고르면 범위 상세 (commit 보다 앞선다)
    act(() =>
      getSessionStore(st().id)?.setState({
        range: {
          from: 0,
          to: 1,
          newer: 'b'.repeat(40),
          older: 'c'.repeat(40),
          base: 'd'.repeat(40),
          files: [],
          loading: false,
        },
      }),
    );
    await tick();
    expect(detail().getByText(S.detail.rangeTitle(2))).toBeTruthy();
    // stash 를 골라도 상세 칸은 그대로 범위 상세다 (W23 전에는 stash 상세가 가장 앞섰다 — 이제 Commit 도구 창의
    // Stash 탭에 있고 로그 선택과 독립이다. 새 자리는 `commit-stash-tab.test.tsx`)
    await act(async () => {
      await st().loadStashes();
    });
    const stash = st().stashes[0];
    expect(stash).toBeDefined();
    await act(async () => {
      if (stash) {
        await st().selectStash(stash);
      }
    });
    await tick();
    expect(st().stashView).not.toBeNull();
    expect(detail().queryByText(S.stash.title)).toBeNull();
    expect(detail().getByText(S.detail.rangeTitle(2))).toBeTruthy();
    // WIP 를 고르면 다시 빈 상태
    act(() => {
      getSessionStore(st().id)?.setState({ range: null });
      st().selectWip();
    });
    await tick();
    expect(detail().getByText(S.workspace.repoLog.pickCommit)).toBeTruthy();
    // "Commit 도구 창 열기": 왼쪽에 Commit 도구 창의 변경 탭(옛 변경 사항 그대로)이 열린다
    act(() =>
      fireEvent.click(detail().getByRole('button', { name: S.workspace.repoLog.openCommitTool })),
    );
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(useAppStore.getState().commitTab).toBe('changes');
    expect(area('project')).toBeNull();
    expect(inArea('commit').getByText(S.commitTool.title)).toBeTruthy();
    expect(inArea('commit').getByText(S.changes.title)).toBeTruthy();
    expect(inArea('commit').getByPlaceholderText(S.commit.summary)).toBeTruthy();
  });

  it('Project 도구 창: 작업 트리가 루트 하나인 파일 트리. 바뀐 파일은 상태 문자, 클릭은 미리보기 탭, 더블클릭은 고정 탭', async () => {
    const { ws } = await mountRepo();
    await tick();
    const tree = inArea('project').getByRole('tree', { name: S.project.tree });
    const items = within(tree).getAllByRole('treeitem');
    // 루트 행 = 저장소 이름 + 경로
    expect(items[0]?.textContent).toContain('storefront-web');
    expect(items[0]?.textContent).toContain(REPO);
    // 바뀐 파일(package.json, 목 장면에서 작업 트리 수정)은 상태 문자 M
    const pkg = items.find((r) => r.textContent?.includes('package.json')) as HTMLElement;
    expect(pkg.textContent).toContain('M');
    fireEvent.click(within(pkg).getByText('package.json'));
    await tick();
    expect(ws()?.docs.map((d) => [d.id, d.pinned])).toEqual([['file:package.json', false]]);
    fireEvent.doubleClick(within(pkg).getByText('package.json'));
    await tick();
    expect(ws()?.docs.map((d) => [d.id, d.pinned])).toEqual([['file:package.json', true]]);
    // 파일 보기 탭 머리줄에 히스토리·Blame (저장소 안 파일)
    expect(inArea('editor').getByRole('button', { name: S.fileView.history })).toBeTruthy();
    expect(inArea('editor').getByRole('button', { name: S.fileView.blame })).toBeTruthy();
  });

  it('에디터 공간: 세션 diff 문서가 탭으로 생기고 탭 × 로 닫으면 세션 슬롯이 빈다. 직전 문서로 돌아간다', async () => {
    const { st, ws } = await mountRepo();
    await tick();
    // 파일 보기 탭 하나를 먼저 연다
    act(() =>
      ws()?.openDoc(
        {
          id: 'file:README.md',
          kind: 'file',
          path: 'README.md',
          name: 'README.md',
          repoPath: REPO,
          repoName: 'storefront-web',
        },
        'pinned',
      ),
    );
    await act(async () => {
      await st().openFile('package.json', false);
    });
    await tick();
    expect(ws()?.activeDocId).toBe(worktreeDiffDocId(REPO));
    const tabs = () =>
      inArea('editor')
        .getAllByRole('tab')
        .map((t) => t.textContent);
    expect(tabs()).toEqual(['README.mdstorefront-web', 'package.jsonstorefront-web']);
    // 옛 "← 그래프로" 는 없다 — 탭 닫기가 대신한다
    expect(screen.queryByRole('button', { name: `← ${S.diff.back}` })).toBeNull();
    act(() =>
      fireEvent.click(
        inArea('editor').getByRole('button', { name: S.workspace.closeTab('package.json') }),
      ),
    );
    await tick();
    expect(st().selectedFile).toBeNull();
    expect(tabs()).toEqual(['README.mdstorefront-web']);
    expect(ws()?.activeDocId).toBe('file:README.md');
  });

  it('충돌 탭: 초안이 있으면 탭 닫기·Esc 가 확인을 먼저 받는다 (W21 에서 달라짐). 닫아도 초안은 남는다', async () => {
    const { st, ws, id } = await mountRepo('conflict');
    await act(async () => {
      await st().openConflict(PAY);
    });
    await tick();
    expect(ws()?.activeDocId).toBe(conflictDocId(CONFLICT_REPO));
    // 옛 "← 목록으로" 는 없다
    expect(screen.queryByRole('button', { name: `← ${S.conflict.back}` })).toBeNull();
    const open = st().conflict;
    expect(open).not.toBeNull();
    const draft = { text: 'mine', ranges: [], key: open?.payload.file.stages.join(':') ?? '' };
    act(() => st().setConflictDraft(PAY, draft));
    await tick();
    act(() =>
      fireEvent.click(
        inArea('editor').getByRole('button', {
          name: S.workspace.closeTab(S.workspace.conflictTitle('PaymentStep.tsx', true)),
        }),
      ),
    );
    await tick();
    expect(dialog()?.textContent).toContain(S.conflictLeave.closeMessage('checkout-service', true));
    expect(useAppStore.getState().conflictLeave).toMatchObject({ folder: id, next: null });
    // 취소하면 그대로
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(st().conflict?.path).toBe(PAY);
    // 편집기 밖 Esc 도 같은 확인 → "닫기" 는 초안을 남긴다
    inArea('editor').getAllByRole('tab')[0]?.focus();
    press('Escape');
    await tick();
    expect(dialog()).not.toBeNull();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    expect(st().conflict).toBeNull();
    expect(st().conflictDrafts[PAY]).toEqual(draft);
    expect(inArea('editor').queryByRole('tab')).toBeNull();
    // 같은 파일을 다시 열면 초안이 이어진다 (탭 제목의 * 표시)
    await act(async () => {
      await st().openConflict(PAY);
    });
    await tick();
    expect(ws()?.sessionDocs.map((d) => d.kind === 'conflict' && d.draft)).toEqual([true]);
  });
});

describe('저장소 탭의 단축키 (WS-20, W21)', () => {
  it('⌘1 Project · ⌘0 Commit · ⌘2 에디터 · ⌘9 로그 · ⌘3 상세 로 포커스가 간다 (옛 영역 폴백 없이)', async () => {
    await mountRepo();
    press('1', MOD);
    await tick();
    expect(focusedArea()).toBe('project');
    press('0', MOD);
    await tick();
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(focusedArea()).toBe('commit');
    press('2', MOD);
    await tick();
    expect(focusedArea()).toBe('editor');
    press('9', MOD);
    await tick();
    expect(focusedArea()).toBe('git-log');
    press('3', MOD);
    await tick();
    expect(focusedArea()).toBe('git-detail');
  });

  it('⌘W: 에디터에 포커스가 있으면 에디터 탭만 닫고, 밖이면 저장소 탭을 닫는다 (결정 7번)', async () => {
    const { st, ws, id } = await mountRepo();
    const requestCloseSession = vi.fn(async () => {});
    act(() => useAppStore.setState({ requestCloseSession }));
    await act(async () => {
      await st().openFile('package.json', false);
    });
    await tick();
    inArea('editor').getAllByRole('tab')[0]?.focus();
    press('w', MOD);
    await tick();
    expect(ws()?.sessionDocs).toEqual([]);
    expect(st().selectedFile).toBeNull();
    expect(requestCloseSession).not.toHaveBeenCalled();
    // 에디터 밖(로그)
    press('9', MOD);
    await tick();
    press('w', MOD);
    await tick();
    expect(requestCloseSession).toHaveBeenCalledWith(id);
  });

  it('⌘F·⌘⇧G 는 로그 탭이 숨겨져 있으면 열고 찾기 줄을 열거나 필터 바의 텍스트 칸으로 간다 (W26)', async () => {
    const { st } = await mountRepo();
    act(() => useAppStore.getState().hideDock());
    await tick();
    expect(area('git-log')).toBeNull();
    press('f', MOD);
    await tick();
    expect(useAppStore.getState().dock).toMatchObject({ tool: 'git', gitTab: 'log' });
    expect(st().search.open).toBe(true);
    expect(area('git-log')).not.toBeNull();
    act(() => useAppStore.getState().toggleDock('git', 'console'));
    press('g', { ...MOD, shiftKey: true });
    await tick();
    expect(useAppStore.getState().dock.gitTab).toBe('log');
    // 필터 바는 늘 보이고(옛 열기/닫기 없음) 포커스가 텍스트 칸으로 간다. 찾기 줄은 그대로 열려 있다
    expect(document.activeElement?.hasAttribute('data-filter-text')).toBe(true);
    expect(document.querySelector('[data-panel="git-log"] [data-filter-bar]')).not.toBeNull();
    expect(st().search.open).toBe(true);
    // 한 번 더 눌러도 필터 바를 닫지 않는다
    press('g', { ...MOD, shiftKey: true });
    await tick();
    expect(document.activeElement?.hasAttribute('data-filter-text')).toBe(true);
    expect(document.querySelector('[data-panel="git-log"] [data-filter-bar]')).not.toBeNull();
  });
});
