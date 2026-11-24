// W24: 저장소 탭의 Pull Requests 도구 창 (WS-17). 옛 Git 도구 창 왼쪽 칸의 PR/MR 섹션(`PrSection.tsx`)을 왼쪽 띠의 세 번째
// 도구 창으로 옮겼다. 기대 글자·조건은 손대기 전 브라우저에서 모은 기준(스크래치패드 `w24/baseline-old-pr.json`)이다.
// - 구조(순수 함수): 메뉴 셋(라벨·순서·구분선·꺼짐·부르는 것), 배지(조건·글자·툴팁·색), 내용 상태 다섯, 머리 단추의 꺼짐
// - 첫 읽기: 계정이 연결된 프로젝트가 처음 보일 때 한 번, 프로젝트가 바뀌면 다시 — 기억은 세션에 있다
// - 띠: 원격 프로젝트가 있을 때만 단추, 순서 Project·Commit·Pull Requests, 누르면 열리고 다시 누르면 접힌다
// - 저장된 값과 보이는 것이 어긋날 때: 보일 수 없으면 Project 를 보이고(띠의 강조·영역 이름도), Project 단추로 접히며, 보일 수
//   있게 되면(다른 탭에서 돌아옴·원격 프로젝트가 늦게 옴) 다시 PR
// - 도구 창: 머리(제목·개수·새로고침·만들기…), 상태 다섯, 행(번호·제목·배지·작성자·툴팁), 더블클릭·Enter = 웹에서 열기,
//   우클릭·⇧F10 = 메뉴, 키보드(Tab 정지 하나·↑↓·Home·End)

import type { GraphViewProps } from '@mgit/graph-view';
import {
  createMockClient,
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type PullRequest,
  type RemoteProject,
  type RepoOpened,
  type SessionId,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import {
  createPr,
  type PrDeps,
  prBadges,
  prContent,
  prCreateDisabled,
  prMenu,
  prNumberLabel,
  prReloadDisabled,
} from '../features/hosting/pr-tool';
import { useAppStore } from '../store';
import {
  createRepoWorkspace,
  DEFAULT_DOCK,
  effectiveLeftTool,
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
  // 팔레트(cmdk)가 고른 항목을 보이게 스크롤한다 (jsdom 에는 없다)
  Element.prototype.scrollIntoView ??= () => {};
});

// 목 저장소 장면 (storefront-web — GitHub `acme/storefront-web`, 계정 연결, 열린 PR 여섯)과 두 번째 탭으로 쓸 저장소
const REPO = '/mock/storefront-web';
const OTHER = '/mock/checkout-service';
const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };
const WEB = 'https://github.com/acme/storefront-web/pull';

/** 옛 섹션의 행 (손대기 전 브라우저 기준): 번호·제목(= 툴팁)·배지 [글자, 툴팁, 색]·작성자 */
const OLD_ROWS: [string, string, [string, string | null, string | null][], string][] = [
  [
    '#128',
    'Checkout: 결제 단계 오류 메시지 개선',
    [
      ['승인됨', null, 'success'],
      ['✓', 'success', 'success'],
    ],
    'hana-lee',
  ],
  [
    '#127',
    '장바구니 합계 계산을 서버로 옮기기',
    [
      ['draft', null, null],
      ['리뷰 필요', null, null],
      ['…', 'pending', null],
    ],
    'minjun-park',
  ],
  [
    '#125',
    '검색 결과 페이지의 필터·정렬·페이지네이션 상태를 URL 쿼리로 동기화하고 뒤로 가기 동작을 정리',
    [
      ['변경 요청', null, 'danger'],
      ['✗', 'failure', 'danger'],
      ['충돌', null, 'danger'],
    ],
    'seoyoon-choi',
  ],
  [
    '#121',
    'Bump react-router from 6.26.1 to 6.28.0',
    [['✓', 'success', 'success']],
    'dependabot[bot]',
  ],
  ['#119', '배송지 폼 접근성 라벨 보강', [], 'jiwoo-kim'],
  [
    '#118',
    '결제 단계 컴포넌트 분리',
    [
      ['승인됨', null, 'success'],
      ['✗', 'failure', 'danger'],
      ['충돌', null, 'danger'],
    ],
    'hana-lee',
  ],
];
/** 옛 우클릭 메뉴 (라벨 순서, 구분선은 셋째 항목 앞) */
const OLD_MENU = ['branch 로 체크아웃', '새 워크트리로 체크아웃…', '브라우저에서 열기'];

const originalApp = (() => {
  const s = useAppStore.getState();
  return {
    client: s.client,
    openUrl: s.openUrl,
    openRepositoryAt: s.openRepositoryAt,
    setAppDialog: s.setAppDialog,
  };
})();
let mounted: SessionId[] = [];

/** PR 하나 (테스트용 기본값) */
function pr(extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: 'feat',
    draft: false,
    author: 'lee',
    authorAvatar: null,
    headRef: 'feat',
    headSha: 'b'.repeat(40),
    baseRef: 'main',
    headRepo: null,
    crossRepo: false,
    webUrl: 'https://github.com/kim/app/pull/7',
    updatedAt: null,
    review: null,
    checks: null,
    mergeable: null,
    labels: [],
    ...extra,
  };
}

const GITHUB: RemoteProject = {
  accountId: 'github:github.com:kim',
  kind: 'github',
  host: 'github.com',
  project: 'kim/app',
  remote: 'origin',
};

/**
 * 저장소 탭(들)을 `openRepositoryAt` 처럼 등록하고(세션 스토어 + "보여라" 훅 + 저장소 워크스페이스) 앱 전체를 그린다.
 * `paths` 의 첫 탭이 활성이다. 생성 때 읽기(원격 프로젝트 포함)가 끝난 뒤 돌려준다. 웹 열기·계정 대화상자·저장소 열기는
 * 기록기로 바꾼다
 */
async function mountRepo(
  init: {
    hosting?: 'github' | 'none' | 'noAccount' | 'empty' | 'error' | 'gitlab';
    leftTool?: LeftTool | null;
    paths?: string[];
  } = {},
) {
  const mock = createMockClient({
    rows: 60,
    scene: 'repo',
    progressIntervalMs: 0,
    hosting: init.hosting ?? 'github',
  });
  const pullRequests = vi.spyOn(mock, 'pullRequests');
  const checkout = vi.spyOn(mock, 'checkoutPullRequest');
  const create = vi.spyOn(mock, 'createPullRequest');
  const tabs: { id: SessionId; store: ReturnType<typeof createSessionStore>; path: string }[] = [];
  for (const path of init.paths ?? [REPO]) {
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
    tabs.push({ id, store, path });
  }
  const openUrl = vi.fn(async (_url: string) => {});
  const openRepositoryAt = vi.fn(async (_path: string): Promise<SessionId | null> => null);
  const first = tabs[0] as (typeof tabs)[number];
  act(() =>
    useAppStore.setState({
      sessions: Object.fromEntries(
        tabs.map((t) => [
          t.id,
          {
            id: t.id,
            kind: 'repo' as const,
            path: t.path,
            name: t.path.slice(t.path.lastIndexOf('/') + 1),
            parent: null,
          },
        ]),
      ),
      sessionOrder: tabs.map((t) => t.id),
      activeSessionId: first.id,
      dock: DEFAULT_DOCK,
      leftTool: init.leftTool === undefined ? 'pullRequests' : init.leftTool,
      client: mock,
      conflictLeave: null,
      appDialog: null,
      openUrl,
      openRepositoryAt,
    }),
  );
  render(<App />);
  await tick();
  await tick();
  return {
    mock,
    tabs,
    id: first.id,
    store: first.store,
    st: () => first.store.getState(),
    calls: { pullRequests, checkout, create, openUrl, openRepositoryAt },
  };
}

/** `data-panel` 이름의 영역 */
const area = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
/** Pull Requests 도구 창 안에서 찾기 */
const prTool = () => within(area('pull-requests') as HTMLElement);
/** 도구 창의 머리 */
const header = () => area('pull-requests')?.querySelector('header') as HTMLElement;
/** PR 목록과 행 */
const list = () => prTool().getByRole('listbox');
const rows = () => within(list()).getAllByRole('option');
/** 왼쪽 띠 */
const stripe = () => within(screen.getByRole('toolbar', { name: S.workspace.stripe }));
/** 띠 단추의 접근성 이름들 (순서대로) */
const stripeLabels = () =>
  stripe()
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
/** 띠 단추별 눌림 상태 (위쪽 도구 창만) */
const pressed = () =>
  Object.fromEntries(
    stripe()
      .getAllByRole('button')
      .map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
  );
/** 열린 메뉴의 항목 라벨 (꺼진 것은 [off]) */
const menuLabels = () =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
    (el) => `${el.textContent}${el.hasAttribute('data-disabled') ? ' [off]' : ''}`,
  );
/** 열린 메뉴의 항목 종류 (구분선 위치) */
const menuRoles = () =>
  [...(document.querySelector('[role="menu"]')?.children ?? [])].map((c) => c.getAttribute('role'));
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 키를 누른다 (앱 단축키는 window 에서 받는다) */
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });
/** 왼쪽 도구 창의 저장된 값 */
const leftTool = () => useAppStore.getState().leftTool;

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
      toasts: [],
      conflictLeave: null,
      appDialog: null,
      paletteOpen: false,
      leftTool: 'project',
      ...originalApp,
    }),
  );
  for (const id of mounted) {
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('구조 (순수 함수 — 옛 PR 섹션 대조)', () => {
  /** 메뉴·더블클릭이 부르는 것을 기록하는 동작 묶음 */
  function deps(busy = false) {
    const prompt = vi.fn(async () => ({ path: ' /r-pr-7 ' }) as Record<string, string | boolean>);
    const d: PrDeps = {
      state: { busy, repoPath: '/r' },
      session: { checkoutPullRequest: vi.fn(async () => 'pr/7') },
      dialogs: { prompt, confirm: vi.fn(), element: null } as unknown as PrDeps['dialogs'],
      openUrl: vi.fn(async () => {}),
      openRepositoryAt: vi.fn(async () => {}),
    };
    return { d, prompt };
  }

  it('우클릭 메뉴 셋: 라벨·순서·구분선(셋째 앞)·꺼짐(busy 면 앞의 둘) — 옛 섹션 그대로', () => {
    const items = prMenu(pr(), deps().d);
    expect(items.map((i) => i.label)).toEqual(OLD_MENU);
    expect(items.map((i) => i.separator ?? false)).toEqual([false, false, true]);
    expect(items.map((i) => i.disabled ?? false)).toEqual([false, false, false]);
    expect(prMenu(pr(), deps(true).d).map((i) => i.disabled ?? false)).toEqual([true, true, false]);
    expect(items.some((i) => i.danger)).toBe(false);
  });

  it('메뉴가 부르는 것: checkoutPullRequest(번호, null) / 워크트리 흐름(경로 → 체크아웃 → 그 워크트리 열기) / openUrl(웹 주소)', async () => {
    const { d, prompt } = deps();
    const [checkout, worktree, web] = prMenu(pr(), d);
    checkout?.onSelect?.();
    expect(d.session.checkoutPullRequest).toHaveBeenCalledWith(7, null);
    web?.onSelect?.();
    expect(d.openUrl).toHaveBeenCalledWith('https://github.com/kim/app/pull/7');
    worktree?.onSelect?.();
    await tick();
    // 경로 기본값은 `<저장소>-pr-<번호>`, 제목은 메뉴 라벨과 같다 (옛 `checkoutPrWorktreeFlow`)
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        title: S.pr.checkoutWorktree,
        fields: [expect.objectContaining({ key: 'path', initial: '/r-pr-7' })],
      }),
    );
    expect(d.session.checkoutPullRequest).toHaveBeenLastCalledWith(7, '/r-pr-7');
    expect(d.openRepositoryAt).toHaveBeenCalledWith('/r-pr-7');
    // 번호가 없는 PR 은 0 으로 부른다 (옛 섹션 그대로)
    prMenu(pr({ number: null }), d)[0]?.onSelect?.();
    expect(d.session.checkoutPullRequest).toHaveBeenLastCalledWith(0, null);
    expect(prNumberLabel(pr({ number: null }))).toBe('#');
  });

  it('배지: draft → 리뷰 → 검사(툴팁 = 원문) → 충돌(mergeable 이 false 일 때만). 색은 승인·성공 / 변경 요청·실패·충돌', () => {
    expect(prBadges(pr())).toEqual([]);
    expect(prBadges(pr({ mergeable: null }))).toEqual([]);
    expect(prBadges(pr({ mergeable: true }))).toEqual([]);
    expect(
      prBadges(pr({ draft: true, review: 'approved', checks: 'success', mergeable: false })).map(
        (b) => [b.kind, b.text, b.title ?? null, b.tone],
      ),
    ).toEqual([
      ['draft', 'draft', null, null],
      ['review', '승인됨', null, 'success'],
      ['checks', '✓', 'success', 'success'],
      ['conflict', '충돌', null, 'danger'],
    ]);
    expect(
      prBadges(pr({ review: 'changes_requested', checks: 'failure' })).map((b) => [b.text, b.tone]),
    ).toEqual([
      ['변경 요청', 'danger'],
      ['✗', 'danger'],
    ]);
    expect(
      prBadges(pr({ review: 'review_required', checks: 'pending' })).map((b) => [b.text, b.tone]),
    ).toEqual([
      ['리뷰 필요', null],
      ['…', null],
    ]);
  });

  it('내용 상태 다섯 (옛 분기 순서): 계정 없음 → 오류 → 읽는 중(목록이 빌 때만) → 비어 있음 → 목록', () => {
    const noAccount = { ...GITHUB, accountId: null };
    const at = (s: Partial<Parameters<typeof prContent>[0]>) =>
      prContent({ project: GITHUB, error: null, loading: false, count: 0, ...s }).kind;
    expect(at({ project: noAccount, error: 'x', loading: true })).toBe('noAccount');
    expect(prContent({ project: GITHUB, error: 'x', loading: true, count: 3 })).toEqual({
      kind: 'error',
      message: 'x',
    });
    expect(at({ loading: true })).toBe('loading');
    expect(at({ loading: true, count: 2 })).toBe('list');
    expect(at({})).toBe('empty');
    expect(at({ count: 1 })).toBe('list');
  });

  it('머리 단추의 꺼짐: 새로고침 = 읽는 중, 만들기… = 다른 작업 중이거나 현재 branch 없음', () => {
    expect(prReloadDisabled(true)).toBe(true);
    expect(prReloadDisabled(false)).toBe(false);
    expect(prCreateDisabled({ busy: false, headBranch: 'main' })).toBe(false);
    expect(prCreateDisabled({ busy: true, headBranch: 'main' })).toBe(true);
    expect(prCreateDisabled({ busy: false, headBranch: null })).toBe(true);
  });

  it('만들기: 옛 흐름 뒤 만들었으면 목록을 다시 읽고, 취소하면 다시 읽지 않는다', async () => {
    const reload = vi.fn(async () => {});
    const base = {
      headBranch: 'main',
      refs: emptyRepoState({ state: 'attached', branch: 'main', oid: 'a'.repeat(40) }).refs,
      remote: 'origin',
      templates: async () => [],
      create: vi.fn(async () => pr({ number: 9 })),
      openUrl: vi.fn(async () => {}),
      reload,
    };
    const cancel = { prompt: vi.fn(async () => null) } as unknown as PrDeps['dialogs'];
    await createPr({ ...base, dialogs: cancel });
    expect(base.create).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    const ok = {
      prompt: vi.fn(async () => ({
        head: 'main',
        base: 'main',
        title: 't',
        body: '',
        draft: false,
      })),
    } as unknown as PrDeps['dialogs'];
    await createPr({ ...base, dialogs: ok });
    expect(base.create).toHaveBeenCalledWith({
      head: 'main',
      base: 'main',
      title: 't',
      body: '',
      draft: false,
    });
    expect(base.openUrl).toHaveBeenCalledWith(pr({ number: 9 }).webUrl);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('보이는 도구 창: 저장된 값이 Pull Requests 인데 보일 수 없으면 Project, 나머지는 그대로', () => {
    expect(effectiveLeftTool('pullRequests', true)).toBe('pullRequests');
    expect(effectiveLeftTool('pullRequests', false)).toBe('project');
    for (const tool of ['project', 'commit', null] as const) {
      expect(effectiveLeftTool(tool, false)).toBe(tool);
      expect(effectiveLeftTool(tool, true)).toBe(tool);
    }
  });
});

describe('첫 읽기 (ensurePullRequests — 세션에 기억)', () => {
  /** 세션 스토어 하나와 PR 목록 호출 기록 */
  async function setup(project: RemoteProject | null) {
    const head = { state: 'attached' as const, branch: 'main', oid: 'a'.repeat(40) };
    const opened: RepoOpened = {
      session: 1,
      alreadyOpen: false,
      nestedRepos: [],
      superproject: null,
      info: {
        workTree: '/r',
        gitDir: '/r/.git',
        commonDir: '/r/.git',
        objectFormat: 'sha1',
        head,
        commitGraph: { present: false },
        shallow: false,
      },
      state: emptyRepoState(head),
    };
    const pullRequests = vi.fn(async () => [pr()]);
    const client: IpcClient = {
      ...createNullClient(),
      hostingRemoteProject: vi.fn(async () => project),
      pullRequests,
    };
    const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
    const store = createSessionStore(opened, client, cache);
    await tick();
    return { store, pullRequests };
  }

  it('계정이 연결된 프로젝트면 한 번만 읽고, 새로고침(loadPullRequests)은 늘 읽으며, 프로젝트가 바뀌면 다시 읽는다', async () => {
    const { store, pullRequests } = await setup(GITHUB);
    // 세션을 만들 때는 읽지 않는다 (도구 창이 처음 보일 때 읽는다)
    expect(pullRequests).not.toHaveBeenCalled();
    await store.getState().ensurePullRequests();
    expect(pullRequests).toHaveBeenCalledTimes(1);
    expect(store.getState().pullRequests).toEqual([pr()]);
    await store.getState().ensurePullRequests();
    expect(pullRequests).toHaveBeenCalledTimes(1);
    await store.getState().loadPullRequests();
    expect(pullRequests).toHaveBeenCalledTimes(2);
    await store.getState().ensurePullRequests();
    expect(pullRequests).toHaveBeenCalledTimes(2);
    store.setState({ remoteProject: { ...GITHUB, project: 'kim/other' } });
    await store.getState().ensurePullRequests();
    expect(pullRequests).toHaveBeenCalledTimes(3);
  });

  it('계정이 없거나 원격 프로젝트가 없으면 읽지 않는다', async () => {
    for (const project of [{ ...GITHUB, accountId: null }, null]) {
      const { store, pullRequests } = await setup(project);
      await store.getState().ensurePullRequests();
      expect(pullRequests).not.toHaveBeenCalled();
    }
  });
});

describe('왼쪽 띠와 도구 창 자리 (WS-17, WS-05)', () => {
  it('원격 프로젝트가 있으면 띠에 Project·Commit·Pull Requests 차례로 단추가 있고, 누르면 열리고 다시 누르면 접힌다', async () => {
    await mountRepo({ leftTool: 'project' });
    expect(stripeLabels()).toEqual([
      S.project.title,
      S.commitTool.title,
      S.pr.title('github'),
      S.dock.git,
      S.terminal.title,
    ]);
    expect(area('pull-requests')).toBeNull();
    act(() => fireEvent.click(stripe().getByRole('button', { name: S.pr.title('github') })));
    await tick();
    expect(leftTool()).toBe('pullRequests');
    expect(area('pull-requests')).not.toBeNull();
    expect(area('project')).toBeNull();
    expect(pressed()[S.pr.title('github')]).toBe('true');
    expect(pressed()[S.project.title]).toBe('false');
    // 띠 단추는 포커스를 옮기지 않는다 (Project·Commit 단추와 같다)
    expect(document.activeElement?.closest('[data-panel="pull-requests"]') ?? null).toBeNull();
    act(() => fireEvent.click(stripe().getByRole('button', { name: S.pr.title('github') })));
    expect(leftTool()).toBeNull();
    // 저장된다 (앱 전역 1벌)
    expect(JSON.parse(localStorage.getItem('mgit.leftTool') ?? '{}')).toEqual({ tool: null });
  });

  it('원격 프로젝트가 없으면 단추가 없다', async () => {
    await mountRepo({ hosting: 'none', leftTool: 'project' });
    expect(stripeLabels()).toEqual([
      S.project.title,
      S.commitTool.title,
      S.dock.git,
      S.terminal.title,
    ]);
  });

  it('GitLab 이면 단추·도구 창·목록의 이름이 Merge Requests 다', async () => {
    await mountRepo({ hosting: 'gitlab' });
    expect(stripeLabels()).toContain('Merge Requests');
    expect(header().textContent).toBe('Merge Requests6');
    expect(list().getAttribute('aria-label')).toBe('Merge Requests');
  });

  it('계정이 없어도 원격 프로젝트가 있으면 단추가 있다 (도구 창 안에서 계정 연결을 안내한다)', async () => {
    await mountRepo({ hosting: 'noAccount' });
    expect(stripeLabels()).toContain(S.pr.title('github'));
    expect(area('pull-requests')).not.toBeNull();
  });

  it('어긋남 ①: 저장된 값이 Pull Requests 인 채 원격 프로젝트가 없어지면 Project 가 보이고(띠의 강조·영역 이름도), Project 단추로 접힌다', async () => {
    const { store } = await mountRepo();
    expect(area('pull-requests')).not.toBeNull();
    act(() => store.setState({ remoteProject: null }));
    await tick();
    expect(leftTool()).toBe('pullRequests');
    expect(area('pull-requests')).toBeNull();
    expect(area('project')).not.toBeNull();
    expect(pressed()[S.project.title]).toBe('true');
    expect(stripeLabels()).not.toContain(S.pr.title('github'));
    // 보이는 도구 창(Project)의 단추를 누르면 접힌다 (저장된 값만 보면 아무 일도 안 일어난다)
    act(() => fireEvent.click(stripe().getByRole('button', { name: S.project.title })));
    expect(leftTool()).toBeNull();
    expect(pressed()[S.project.title]).toBe('false');
    // 다시 누르면 Project
    act(() => fireEvent.click(stripe().getByRole('button', { name: S.project.title })));
    expect(leftTool()).toBe('project');
  });

  it('어긋남 ②: 저장된 값이 Pull Requests 인 채 시작해 원격 프로젝트가 늦게 오면 그때 Pull Requests 가 보인다', async () => {
    const { store, calls } = await mountRepo();
    const project = store.getState().remoteProject;
    act(() => store.setState({ remoteProject: null, pullRequests: [] }));
    await tick();
    expect(area('project')).not.toBeNull();
    const before = calls.pullRequests.mock.calls.length;
    act(() => store.setState({ remoteProject: project }));
    await tick();
    expect(area('pull-requests')).not.toBeNull();
    expect(pressed()[S.pr.title('github')]).toBe('true');
    // 같은 프로젝트로 이미 읽었으므로 다시 읽지 않는다 (세션의 기억)
    expect(calls.pullRequests.mock.calls.length).toBe(before);
  });

  it('어긋남 ③: 원격 프로젝트가 없는 저장소 탭으로 가면 Project, 있는 탭으로 돌아오면 다시 Pull Requests (저장된 값은 그대로)', async () => {
    const { tabs } = await mountRepo({ paths: [REPO, OTHER] });
    const [a, b] = tabs as [(typeof tabs)[number], (typeof tabs)[number]];
    act(() => b.store.setState({ remoteProject: null }));
    expect(area('pull-requests')).not.toBeNull();
    act(() => useAppStore.getState().setActiveSession(b.id));
    await tick();
    expect(area('project')).not.toBeNull();
    expect(area('pull-requests')).toBeNull();
    expect(pressed()[S.project.title]).toBe('true');
    expect(leftTool()).toBe('pullRequests');
    act(() => useAppStore.getState().setActiveSession(a.id));
    await tick();
    expect(area('pull-requests')).not.toBeNull();
    expect(pressed()[S.pr.title('github')]).toBe('true');
  });

  it('⌘1·⌘0 은 Pull Requests 를 보던 중에도 그대로다 (Project·Commit 을 열고 포커스)', async () => {
    await mountRepo();
    press('1', /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { altKey: true });
    await tick();
    expect(leftTool()).toBe('project');
    expect(document.activeElement?.closest('[data-panel="project"]')).not.toBeNull();
    act(() => useAppStore.getState().setLeftTool('pullRequests'));
    await tick();
    press('0', /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { altKey: true });
    await tick();
    expect(leftTool()).toBe('commit');
    expect(document.activeElement?.closest('[data-panel="commit"]')).not.toBeNull();
  });

  it('팔레트 동작(기본 키 없음)은 Pull Requests 를 열고 목록에 포커스를 준다', async () => {
    await mountRepo({ leftTool: 'project' });
    act(() => useAppStore.getState().setPaletteOpen(true));
    await tick();
    const item = screen.getByRole('option', { name: S.actions.toolPullRequests('Pull Requests') });
    // 기본 키가 없으므로 단축키 표시가 없다
    expect(item.querySelector('kbd')).toBeNull();
    act(() => fireEvent.click(item));
    await tick();
    await tick();
    expect(leftTool()).toBe('pullRequests');
    expect(document.activeElement).toBe(list());
  });
});

describe('Pull Requests 도구 창 (옛 섹션 대조)', () => {
  it('머리: 제목 + 개수, 단추 [새로고침, 만들기…] (머리 높이·모양은 Commit 도구 창과 같은 틀). 행: 번호·제목·배지·작성자·툴팁', async () => {
    await mountRepo();
    expect(header().textContent).toBe('Pull Requests6');
    expect(
      within(header())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([S.pr.reload, S.pr.createAction]);
    // 같은 틀: 머리의 클래스가 Commit 도구 창의 머리와 같다
    act(() => useAppStore.getState().setLeftTool('commit'));
    await tick();
    const commitHeader = area('commit')?.querySelector('header')?.className;
    act(() => useAppStore.getState().setLeftTool('pullRequests'));
    await tick();
    expect(header().className).toBe(commitHeader);
    expect(rows()).toHaveLength(OLD_ROWS.length);
    for (const [i, [number, title, badges, author]] of OLD_ROWS.entries()) {
      const row = rows()[i] as HTMLElement;
      // 행 툴팁 = 제목, 글자 = #번호 제목 배지들 작성자 (옛 행과 같은 차례)
      expect(row.title).toBe(title);
      expect(row.textContent).toBe(`${number}${title}${badges.map(([t]) => t).join('')}${author}`);
      expect(
        [...row.querySelectorAll('[data-badge]')].map((b) => [
          b.textContent,
          b.getAttribute('title'),
          b.getAttribute('data-tone'),
        ]),
      ).toEqual(badges);
    }
  });

  it('더블클릭·Enter = 웹에서 열기(openUrl(웹 주소)). 한 번 클릭은 고르기만 한다', async () => {
    const { calls } = await mountRepo();
    fireEvent.click(rows()[1] as HTMLElement);
    expect(calls.openUrl).not.toHaveBeenCalled();
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.doubleClick(rows()[0] as HTMLElement);
    expect(calls.openUrl).toHaveBeenLastCalledWith(`${WEB}/128`);
    list().focus();
    act(() => fireEvent.keyDown(list(), { key: 'Enter' }));
    expect(calls.openUrl).toHaveBeenLastCalledWith(`${WEB}/127`);
  });

  it('우클릭 메뉴 셋: 옛 라벨·순서·구분선. checkout → checkoutPullRequest(세션, 번호, null), 브라우저에서 열기 → openUrl', async () => {
    const { calls, id } = await mountRepo();
    fireEvent.contextMenu(rows()[1] as HTMLElement);
    await tick();
    expect(menuLabels()).toEqual(OLD_MENU);
    expect(menuRoles()).toEqual(['menuitem', 'menuitem', 'separator', 'menuitem']);
    fireEvent.click(screen.getByRole('menuitem', { name: S.pr.checkout }));
    await tick();
    expect(calls.checkout).toHaveBeenCalledWith(id, 127, null);
    fireEvent.contextMenu(rows()[2] as HTMLElement);
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.pr.openWeb }));
    await tick();
    expect(calls.openUrl).toHaveBeenLastCalledWith(`${WEB}/125`);
  });

  it('워크트리로 checkout: 옛 대화상자(경로 기본값 <저장소>-pr-<번호>) — 취소하면 부르지 않고, 확인하면 체크아웃 뒤 그 워크트리를 연다', async () => {
    const { calls, id } = await mountRepo();
    fireEvent.contextMenu(rows()[2] as HTMLElement);
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.pr.checkoutWorktree }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.pr.checkoutWorktree);
    expect(dialog()?.querySelector('input')?.value).toBe(`${REPO}-pr-125`);
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(calls.checkout).not.toHaveBeenCalled();
    fireEvent.contextMenu(rows()[2] as HTMLElement);
    await tick();
    fireEvent.click(screen.getByRole('menuitem', { name: S.pr.checkoutWorktree }));
    await tick();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    await tick();
    expect(calls.checkout).toHaveBeenCalledWith(id, 125, `${REPO}-pr-125`);
    expect(calls.openRepositoryAt).toHaveBeenCalledWith(`${REPO}-pr-125`);
  });

  it('꺼짐: 다른 작업 중이면 메뉴 앞의 둘과 만들기…, 읽는 중이면 새로고침, 현재 branch 가 없으면 만들기…', async () => {
    const { store } = await mountRepo();
    const button = (name: string) =>
      within(header()).getByRole<HTMLButtonElement>('button', { name });
    expect(button(S.pr.reload).disabled).toBe(false);
    expect(button(S.pr.createAction).disabled).toBe(false);
    act(() => store.setState({ busy: true }));
    fireEvent.contextMenu(rows()[0] as HTMLElement);
    await tick();
    expect(menuLabels()).toEqual([`${OLD_MENU[0]} [off]`, `${OLD_MENU[1]} [off]`, OLD_MENU[2]]);
    press('Escape');
    expect(button(S.pr.createAction).disabled).toBe(true);
    expect(button(S.pr.reload).disabled).toBe(false);
    act(() => store.setState({ busy: false, prsLoading: true }));
    expect(button(S.pr.reload).disabled).toBe(true);
    expect(button(S.pr.createAction).disabled).toBe(false);
    // 읽는 중이어도 목록이 있으면 목록을 그대로 보인다
    expect(rows()).toHaveLength(6);
    const refs = store.getState().refs;
    act(() =>
      store.setState({
        prsLoading: false,
        refs: {
          ...refs,
          head: { state: 'detached', oid: 'a'.repeat(40) },
          labels: refs.labels.map((l) => ({ ...l, isCurrent: false })),
        },
      }),
    );
    expect(button(S.pr.createAction).disabled).toBe(true);
  });

  it('새로고침 = 목록 다시 읽기. 만들기… = 옛 대화상자(PR/MR 만들기) — 취소하면 만들지 않고, 만들면 웹에서 열고 목록을 다시 읽는다', async () => {
    const { calls, id } = await mountRepo();
    expect(calls.pullRequests).toHaveBeenCalledTimes(1);
    fireEvent.click(within(header()).getByRole('button', { name: S.pr.reload }));
    await tick();
    expect(calls.pullRequests).toHaveBeenCalledTimes(2);
    fireEvent.click(within(header()).getByRole('button', { name: S.pr.createAction }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.pr.createTitle);
    expect(
      [...(dialog()?.querySelectorAll('input, select, textarea') ?? [])].map(
        (e) => (e as HTMLInputElement).value,
      ),
    ).toEqual(['main', 'main', 'main', '## 변경 내용\n\n## 확인 방법\n\n## 관련 이슈\n', 'on']);
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }),
    );
    await tick();
    expect(calls.create).not.toHaveBeenCalled();
    fireEvent.click(within(header()).getByRole('button', { name: S.pr.createAction }));
    await tick();
    fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    await tick();
    await tick();
    expect(calls.create).toHaveBeenCalledWith(id, expect.objectContaining({ head: 'main' }));
    expect(calls.openUrl).toHaveBeenLastCalledWith(`${WEB}/129`);
    expect(calls.pullRequests).toHaveBeenCalledTimes(3);
  });

  it('상태: 계정 없음(안내 + "계정 연결…" → 계정 대화상자, 머리 단추 없음, 읽지 않음)', async () => {
    const { calls } = await mountRepo({ hosting: 'noAccount' });
    expect(header().textContent).toBe('Pull Requests0');
    expect(within(header()).queryAllByRole('button')).toEqual([]);
    expect(area('pull-requests')?.textContent).toContain(S.pr.noAccount);
    expect(calls.pullRequests).not.toHaveBeenCalled();
    fireEvent.click(prTool().getByRole('button', { name: S.pr.connect }));
    expect(useAppStore.getState().appDialog).toBe('accounts');
  });

  it('상태: 오류(원문, alert) · 읽는 중(목록이 빌 때만) · 비어 있음', async () => {
    const { store } = await mountRepo({ hosting: 'error' });
    expect(prTool().getByRole('alert').textContent).toBe(
      'GitHub API 요청이 실패했습니다 (401 Bad credentials)',
    );
    expect(header().textContent).toBe('Pull Requests0');
    act(() => store.setState({ prsError: null, prsLoading: true }));
    expect(area('pull-requests')?.textContent).toContain(S.pr.loading);
    act(() => store.setState({ prsLoading: false }));
    expect(area('pull-requests')?.textContent).toContain(S.pr.empty);
    expect(prTool().queryByRole('listbox')).toBeNull();
  });

  it('키보드: 목록이 Tab 정지 하나. ↑↓·Home·End = 커서(고른 행이 따라간다), Enter = 웹에서 열기, ⇧F10·메뉴 키 = 커서 행의 메뉴', async () => {
    const { calls } = await mountRepo();
    const lb = list();
    expect(lb.tabIndex).toBe(0);
    expect(rows().every((r) => !r.hasAttribute('tabindex'))).toBe(true);
    // 머리 단추는 Tab 으로 닿는다 (tabIndex 를 빼지 않는다)
    expect(
      within(header())
        .getAllByRole('button')
        .every((b) => b.tabIndex === 0),
    ).toBe(true);
    lb.focus();
    const cursor = () => lb.getAttribute('aria-activedescendant');
    expect(cursor()).toBe(rows()[0]?.id);
    act(() => fireEvent.keyDown(lb, { key: 'ArrowDown' }));
    expect(cursor()).toBe(rows()[1]?.id);
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.keyDown(lb, { key: 'End' }));
    expect(cursor()).toBe(rows()[5]?.id);
    // 끝에서 멈춘다 (긴 목록 규칙)
    act(() => fireEvent.keyDown(lb, { key: 'ArrowDown' }));
    expect(cursor()).toBe(rows()[5]?.id);
    act(() => fireEvent.keyDown(lb, { key: 'Enter' }));
    expect(calls.openUrl).toHaveBeenLastCalledWith(`${WEB}/118`);
    act(() => fireEvent.keyDown(lb, { key: 'Home' }));
    expect(cursor()).toBe(rows()[0]?.id);
    // 수정키 조합은 앱 단축키 몫이다
    act(() => fireEvent.keyDown(lb, { key: 'ArrowDown', ...MOD }));
    expect(cursor()).toBe(rows()[0]?.id);
    act(() => fireEvent.keyDown(lb, { key: 'F10', shiftKey: true }));
    await tick();
    expect(menuLabels()).toEqual(OLD_MENU);
    press('Escape');
    await tick();
    act(() => fireEvent.keyDown(lb, { key: 'ContextMenu' }));
    await tick();
    expect(menuLabels()).toEqual(OLD_MENU);
  });

  it('첫 읽기: 처음 보일 때 한 번. 도구 창을 닫았다 열거나 Project·로그 탭에 다녀와도 다시 읽지 않는다 (옛 섹션은 다시 마운트될 때마다 읽었다)', async () => {
    const { calls } = await mountRepo({ leftTool: 'project' });
    expect(calls.pullRequests).not.toHaveBeenCalled();
    act(() => useAppStore.getState().setLeftTool('pullRequests'));
    await tick();
    expect(calls.pullRequests).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(stripe().getByRole('button', { name: S.pr.title('github') })));
    act(() => fireEvent.click(stripe().getByRole('button', { name: S.pr.title('github') })));
    await tick();
    act(() => useAppStore.getState().setLeftTool('project'));
    act(() => useAppStore.getState().setLeftTool('pullRequests'));
    await tick();
    act(() => useAppStore.getState().toggleDock('git', 'console'));
    act(() => useAppStore.getState().toggleDock('git', 'log'));
    await tick();
    expect(rows()).toHaveLength(6);
    expect(calls.pullRequests).toHaveBeenCalledTimes(1);
  });
});
