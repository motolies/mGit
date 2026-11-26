import type { GraphViewProps } from '@mgit/graph-view';
import {
  type BatchResult,
  type BranchDeleteTarget,
  createMockClient,
  createNullClient,
  type FolderBranch,
  type FolderBranches,
  type FolderBranchIn,
  GraphRangeCache,
  type GraphRevs,
  type IpcClient,
  type TimelineInfo,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREF_BRANCH_FAVORITES } from '../features/branches/branch-favorites';
import { batchNotice, batchSummary, repoResultState } from '../features/folder/batch-report';
import { FolderTimeline } from '../features/folder/FolderTimeline';
import { TaskHistoryPanel } from '../features/folder/TaskHistoryPanel';
import { useAppStore } from '../store';
import type { SessionMeta } from '../store/app-store';
import { type EditorFile, fileEditors } from '../store/file-editor-store';
import { createFolderStore, DEFAULT_TIMELINE_QUERY, type FolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  registerFolder,
  registerSession,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 그래프 뷰는 jsdom 에서 그리지 못한다. 여기서 보는 것은 브랜치 트리와 로그 머리다
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));

const FOLDER_ID = 31;
const ROOT = '/work/acme';
const REPOS = ['api', 'web', 'docs'];
const pathOf = (name: string) => `${ROOT}/${name}`;

/** 타임라인 정보. 브랜치 트리는 이 정보의 브랜치 목록을 쓰지 않는다 (비워 둔다) */
const INFO: TimelineInfo = {
  generation: 1,
  rows: 120,
  finished: true,
  maxPerRepo: 10000,
  repos: REPOS.map((name, index) => ({
    index,
    name,
    path: pathOf(name),
    color: index,
    headBranch: null,
    truncated: false,
    error: null,
    inScope: true,
  })),
  scoped: false,
};

/** 브랜치가 있는 저장소 하나. 이름 끝의 `*` 는 그 저장소에서 현재 브랜치라는 뜻이다 */
function at(spec: string, extra: Partial<FolderBranchIn> = {}): FolderBranchIn {
  const name = spec.replace('*', '');
  return {
    path: pathOf(name),
    color: REPOS.indexOf(name),
    current: spec.endsWith('*'),
    upstream: null,
    ahead: null,
    behind: null,
    gone: false,
    ...extra,
  };
}

/** 브랜치 하나. `origin/` 으로 시작하면 원격 브랜치다 */
function branch(name: string, ...repos: FolderBranchIn[]): FolderBranch {
  const remote = name.startsWith('origin/');
  return { name, remote, remoteName: remote ? 'origin' : null, repos };
}

/** 저장소 세 개에 걸친 브랜치 목록 (`folderBranches` 응답). development 는 api 에서 54 뒤처졌다 */
const BRANCHES: FolderBranches = {
  repos: [
    ['api', 'development'],
    ['web', 'feature/login'],
    ['docs', 'main'],
  ].map(([name, head], color) => ({
    path: pathOf(name ?? ''),
    name: name ?? '',
    color,
    head: { state: 'attached', branch: head ?? '', oid: '0'.repeat(40) },
    error: null,
  })),
  branches: [
    branch(
      'development',
      at('api*', { upstream: 'origin/development', ahead: 0, behind: 54 }),
      at('web', { upstream: 'origin/development', ahead: 3, behind: 0 }),
    ),
    branch('feature/login', at('web*')),
    branch('hotfix', at('api'), at('docs')),
    branch('main', at('api'), at('web'), at('docs*', { upstream: 'origin/main' })),
    branch('release', at('web')),
    branch('origin/hotfix', at('api'), at('docs')),
    branch('origin/main', at('api'), at('web'), at('docs')),
  ],
};

const RESULT: BatchResult = {
  label: '일괄 checkout: hotfix',
  results: [
    { path: pathOf('api'), name: 'api', ok: true, skipped: null, message: '' },
    {
      path: pathOf('docs'),
      name: 'docs',
      ok: true,
      skipped: '커밋하지 않은 변경이 있음',
      message: '',
    },
  ],
  succeeded: 1,
  skipped: 1,
  failed: 0,
};

const LOCAL = (name: string) => `ref:refs/heads/${name}`;
const REMOTE = (name: string) => `ref:refs/remotes/${name}`;

/** 폴더 탭 하나를 등록하고 로그 탭을 그린다. 브랜치 목록과 타임라인 정보가 올 때까지 기다린다 */
async function setup(
  folderBatch: IpcClient['folderBatch'] = async () => RESULT,
  overrides: Partial<IpcClient> = {},
) {
  const batch = vi.fn(folderBatch);
  const querySet = vi.fn<IpcClient['folderTimelineQuerySet']>(async () => {});
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => [],
    folderBranches: async () => BRANCHES,
    folderTimelineOpen: async () => INFO,
    folderTimelineInfo: async () => INFO,
    folderTimelineQuerySet: querySet,
    folderBatch: batch,
    ...overrides,
  };
  const store: FolderStore = createFolderStore(
    {
      session: FOLDER_ID,
      path: ROOT,
      repos: REPOS.map((name) => ({ path: pathOf(name), kind: 'standalone' as const })),
    },
    client,
  );
  registerFolder(FOLDER_ID, store);
  const meta: SessionMeta = {
    id: FOLDER_ID,
    kind: 'folder',
    path: ROOT,
    name: 'acme',
    parent: null,
  };
  act(() => {
    useAppStore.setState({
      sessions: { [FOLDER_ID]: meta },
      sessionOrder: [FOLDER_ID],
      activeSessionId: FOLDER_ID,
      toasts: [],
    });
  });
  render(<FolderTimeline />);
  await tick();
  /** 마지막 질의의 ref 범위 */
  const lastRevs = (): GraphRevs | undefined => querySet.mock.calls.at(-1)?.[1].revs;
  return { store, batch, querySet, lastRevs, client };
}

const branchPanel = () => document.querySelector<HTMLElement>('[data-panel="git-branches"]');
const logPanel = () => document.querySelector<HTMLElement>('[data-panel="git-log"]');
const items = () => within(branchPanel() as HTMLElement).getAllByRole('treeitem');
/** 보이는 행의 노드 id */
const ids = () => items().map((el) => el.getAttribute('data-node-id'));
/** 노드 id 로 행을 찾는다 */
const row = (id: string) => {
  const el = items().find((item) => item.getAttribute('data-node-id') === id);
  if (!el) {
    throw new Error(`행 없음: ${id}`);
  }
  return el;
};
/** 선택된 것으로 그린 행의 노드 id */
const selected = () =>
  items()
    .filter((el) => el.getAttribute('aria-selected') === 'true')
    .map((el) => el.getAttribute('data-node-id'));
const toolbarButton = (name: string) =>
  within(
    screen.getByRole('toolbar', { name: S.branches.toolbar.label }),
  ).getByRole<HTMLButtonElement>('button', { name });
/**
 * 필터 바의 branch 조건 해제 버튼 (W17: 옛 로그 머리의 칩을 branch 드롭다운 단추의 × 로 흡수했다). 없으면 undefined
 */
const chipClear = () =>
  within(logPanel() as HTMLElement)
    .queryAllByRole('button')
    .find((b) =>
      b
        .getAttribute('aria-label')
        ?.startsWith(S.filterBar.clearCondition(S.filterBar.summary(S.filterBar.branch, ''))),
    );
/** branch 조건의 글자 (드롭다운 단추의 요약) */
const branchLabel = (value: string) => S.filterBar.summary(S.filterBar.branch, value);
/** branch 드롭다운 단추 (해제 버튼 옆) */
const branchButton = () => chipClear()?.previousElementSibling as HTMLElement | null | undefined;
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
/** 열린 대화상자의 확인(제출) */
const submit = () =>
  act(() => fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement));
/** 우클릭 메뉴를 열고 항목을 준다 */
async function openMenu(id: string) {
  fireEvent.contextMenu(row(id));
  await tick();
  return screen.queryAllByRole('menuitem');
}
/** 우클릭 메뉴의 checkout… 으로 확인창을 연다 (더블클릭은 checkout 이 아니라 그래프 거르기다) */
async function openCheckout(id: string) {
  await openMenu(id);
  act(() => fireEvent.click(screen.getByText(S.branches.menu.checkout)));
  await tick();
}
/** 저장된 즐겨찾기 */
const storedFavorites = () => JSON.parse(localStorage.getItem(PREF_BRANCH_FAVORITES) ?? 'null');
const toasts = () => useAppStore.getState().toasts.map((t) => [t.kind, t.title, t.message]);

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
});

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() => {
    useAppStore.setState({ sessions: {}, sessionOrder: [], activeSessionId: null, toasts: [] });
  });
  disposeFolder(FOLDER_ID);
  clearSessionRegistry();
});

describe('폴더 로그 탭의 구조 (BT-01·02·05)', () => {
  it('세로 툴바, 브랜치 트리, 로그가 차례로 있고 트리는 현재 > 즐겨찾기 > 이름 순이다', async () => {
    await setup();
    const bar = screen.getByRole('toolbar', { name: S.branches.toolbar.label });
    // 세로 툴바는 접히는 브랜치 패널의 밖에 있다
    expect(branchPanel()?.contains(bar)).toBe(false);
    expect(bar.compareDocumentPosition(branchPanel() as HTMLElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(ids()).toEqual([
      'head',
      'group:local',
      LOCAL('main'),
      LOCAL('development'),
      LOCAL('feature/login'),
      LOCAL('hotfix'),
      LOCAL('release'),
      'group:remote',
      REMOTE('origin/main'),
      REMOTE('origin/hotfix'),
    ]);
    expect(row('group:local').textContent).toBe(`${S.branches.local}5`);
    expect(row('group:remote').textContent).toBe(`${S.branches.remote}2`);
    expect(row(LOCAL('hotfix')).textContent).toBe('hotfix(api, docs)');
    // 업스트림 차이: 저장소의 수치를 합쳐 쓰고 툴팁에 저장소별 수치를 쓴다 (BT-08)
    expect(row(LOCAL('development')).textContent).toBe('development⇣54⇡3(api, web)');
    expect(row(LOCAL('development')).getAttribute('title')).toBe(
      [
        'development (api, web)',
        S.branches.currentIn('api'),
        S.branches.trackOf('api', S.branches.incoming(54)),
        S.branches.trackOf('web', S.branches.outgoing(3)),
      ].join('\n'),
    );
    expect(selected()).toEqual([]);
    // 걸러지지 않은 로그: 조건 해제 버튼 없이 행 수만 (W17: 필터 바의 상태 글자)
    expect(chipClear()).toBeUndefined();
    expect(logPanel()?.textContent).toContain(S.folder.timeline.rows(120));
  });

  it('원격 숨기기는 필터 바의 보기 옵션에 있고, 켜면 질의가 바뀌고 원격 그룹이 빠진다', async () => {
    const { querySet } = await setup();
    // W17: 로그 머리의 체크 칸 → 필터 바 오른쪽 보기 옵션 메뉴 (LG-08)
    const trigger = within(logPanel() as HTMLElement).getByRole('button', {
      name: S.filterBar.viewOptions,
    });
    act(() => fireEvent.keyDown(trigger, { key: 'Enter' }));
    await tick();
    const check = screen.getByRole('menuitemcheckbox', { name: S.folder.timeline.hideRemotes });
    act(() => fireEvent.click(check));
    expect(querySet).toHaveBeenLastCalledWith(FOLDER_ID, {
      ...DEFAULT_TIMELINE_QUERY,
      hideRemotes: true,
    });
    // 체크 항목은 메뉴를 닫지 않는다. 열린 메뉴는 나머지를 보조 기술에서 숨기므로 닫고 트리를 본다
    act(() => fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }));
    await tick();
    expect(ids()).not.toContain('group:remote');
    expect(ids()).toContain('group:local');
  });
});

describe('브랜치 클릭과 로그 범위 (BT-03)', () => {
  it('잎을 누르면 로그가 그 브랜치로 걸러지고 필터 바의 branch 단추가 바뀌며, 단추의 × 로 해제한다', async () => {
    const { querySet, lastRevs } = await setup();
    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    expect(querySet).toHaveBeenLastCalledWith(FOLDER_ID, {
      ...DEFAULT_TIMELINE_QUERY,
      revs: { kind: 'solo', name: 'hotfix' },
    });
    expect(selected()).toEqual([LOCAL('hotfix')]);
    const clear = chipClear() as HTMLElement;
    expect(clear.getAttribute('aria-label')).toBe(
      S.filterBar.clearCondition(branchLabel('hotfix')),
    );
    expect(clear.parentElement?.textContent).toBe(branchLabel('hotfix'));

    // 같은 브랜치를 다시 눌러도 다시 읽지 않는다 (더블클릭의 두 번째 클릭)
    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    expect(querySet).toHaveBeenCalledTimes(1);

    act(() => fireEvent.click(clear));
    expect(lastRevs()).toEqual({ kind: 'all' });
    expect(selected()).toEqual([]);
    expect(chipClear()).toBeUndefined();
  });

  it('⌘/Ctrl 클릭은 여러 브랜치를 함께 고르고 다시 누르면 뺀다', async () => {
    const { lastRevs } = await setup();
    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    act(() => fireEvent.click(row(REMOTE('origin/main')), { metaKey: true }));
    expect(lastRevs()).toEqual({ kind: 'branches', names: ['hotfix', 'origin/main'] });
    expect(selected()).toEqual([LOCAL('hotfix'), REMOTE('origin/main')]);
    expect(chipClear()?.getAttribute('aria-label')).toBe(
      S.filterBar.clearCondition(branchLabel(S.filterBar.more('hotfix', 1))),
    );
    expect(branchButton()?.getAttribute('title')).toBe(branchLabel('hotfix, origin/main'));

    act(() => fireEvent.click(row(LOCAL('hotfix')), { ctrlKey: true }));
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'origin/main' });
    act(() => fireEvent.click(row(REMOTE('origin/main')), { metaKey: true }));
    expect(lastRevs()).toEqual({ kind: 'all' });
  });

  it('HEAD 행을 누르면 저장소마다 자기 HEAD 의 이력을 보고 HEAD 행이 선택된다', async () => {
    const { lastRevs } = await setup();
    act(() => fireEvent.click(row('head')));
    // 현재 브랜치 이름의 모음이 아니라 HEAD 범위다: 분리 HEAD 저장소도 들고 같은 이름의 다른 브랜치가 섞이지 않는다
    expect(lastRevs()).toEqual({ kind: 'head' });
    expect(selected()).toEqual(['head']);
    expect(chipClear()?.getAttribute('aria-label')).toBe(
      S.filterBar.clearCondition(branchLabel(S.branches.head)),
    );
    // 단추의 툴팁은 요약 아래에 저장소마다의 HEAD 다
    expect(branchButton()?.getAttribute('title')).toBe(
      [
        branchLabel(S.branches.head),
        S.branches.headOf('api', 'development'),
        S.branches.headOf('web', 'feature/login'),
        S.branches.headOf('docs', 'main'),
      ].join('\n'),
    );
    // 다시 눌러도 다시 읽지 않고, 브랜치를 ⌘ 클릭하면 그 브랜치만 남는다
    act(() => fireEvent.click(row('head')));
    act(() => fireEvent.click(row(LOCAL('hotfix')), { metaKey: true }));
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'hotfix' });
  });

  it('브랜치 트리는 타임라인 로드가 끝나기 전에 채워진다 (BT-06)', async () => {
    // 타임라인은 아직 읽는 중이다: 끝나지 않은 빈 정보만 왔고 완료 이벤트는 오지 않았다
    const loading: TimelineInfo = { ...INFO, generation: 0, rows: 0, finished: false, repos: [] };
    const { store } = await setup(undefined, { folderTimelineOpen: async () => loading });
    expect(store.getState().timeline.loadState).toBe('loading');
    expect(logPanel()?.textContent).toContain(S.folder.timeline.loading);
    expect(ids()).toHaveLength(10);
    expect(row(LOCAL('main')).textContent).toBe('main(api, web, docs)');
    expect(branchPanel()?.textContent).not.toContain(S.folder.timeline.loading);
  });

  it('브랜치 목록을 아직 못 받았으면 트리 자리에 읽는 중이라고 쓴다', async () => {
    await setup(undefined, { folderBranches: () => new Promise<FolderBranches>(() => {}) });
    expect(within(branchPanel() as HTMLElement).queryAllByRole('treeitem')).toEqual([]);
    expect(branchPanel()?.textContent).toContain(S.folder.timeline.loading);
  });
});

describe('브랜치 더블클릭·Enter = 그 branch 와 기본 branch 로 거르기 (checkout 하지 않는다)', () => {
  it('로컬 branch 를 더블클릭하면 [그 branch, main, origin/main] 으로 거르고 세 행이 선택으로 보인다. 확인창은 없다', async () => {
    const { batch, lastRevs } = await setup();
    act(() => fireEvent.doubleClick(row(LOCAL('hotfix'))));
    await tick();
    expect(lastRevs()).toEqual({ kind: 'branches', names: ['hotfix', 'main', 'origin/main'] });
    expect(selected()).toEqual([LOCAL('main'), LOCAL('hotfix'), REMOTE('origin/main')]);
    expect(dialog()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });

  it('저장소 범위도 그 branch 가 있는 저장소로 좁혀 필터 바에 보이고, 다른 branch 를 누르면 걸기 전으로 돌아간다', async () => {
    const scopeSet = vi.fn<IpcClient['folderTimelineScopeSet']>(async () => {});
    const { store } = await setup(undefined, { folderTimelineScopeSet: scopeSet });
    const repoButton = () =>
      within(logPanel() as HTMLElement)
        .getAllByRole('button')
        .find((b) => b.textContent?.startsWith(S.filterBar.repo));
    // hotfix 는 api·docs 에만 있다
    act(() => fireEvent.doubleClick(row(LOCAL('hotfix'))));
    await tick();
    expect(store.getState().timeline.scope).toEqual([pathOf('api'), pathOf('docs')]);
    expect(scopeSet).toHaveBeenLastCalledWith(FOLDER_ID, [pathOf('api'), pathOf('docs')]);
    expect(repoButton()?.textContent).toBe(S.filterBar.summary(S.filterBar.repo, 'api +1'));
    // 한 번 클릭(다른 범위): 걸기 전(전부)으로
    act(() => fireEvent.click(row(LOCAL('release'))));
    await tick();
    expect(store.getState().timeline.scope).toEqual([]);
    expect(scopeSet).toHaveBeenLastCalledWith(FOLDER_ID, []);
    // 모든 저장소에 있는 main 은 좁히지 않는다
    act(() => fireEvent.doubleClick(row(LOCAL('main'))));
    await tick();
    expect(store.getState().timeline.scope).toEqual([]);
    // branch 필터 해제(필터 바의 ×)도 되돌린다
    act(() => fireEvent.doubleClick(row(LOCAL('feature/login'))));
    await tick();
    expect(store.getState().timeline.scope).toEqual([pathOf('web')]);
    act(() => fireEvent.click(chipClear() as HTMLElement));
    await tick();
    expect(store.getState().timeline.query.revs).toEqual({ kind: 'all' });
    expect(store.getState().timeline.scope).toEqual([]);
  });

  it('원격 행·기본 branch 자신·모든 저장소에서 현재인 branch 도 거른다', async () => {
    const { lastRevs } = await setup();
    act(() => fireEvent.doubleClick(row(REMOTE('origin/hotfix'))));
    await tick();
    expect(lastRevs()).toEqual({
      kind: 'branches',
      names: ['origin/hotfix', 'main', 'origin/main'],
    });
    act(() => fireEvent.doubleClick(row(LOCAL('main'))));
    await tick();
    expect(lastRevs()).toEqual({ kind: 'branches', names: ['main', 'origin/main'] });
    // feature/login 은 web 에만 있고 거기서 현재 branch 다 (예전에는 checkout 할 것이 없어 아무 일도 없었다)
    act(() => fireEvent.doubleClick(row(LOCAL('feature/login'))));
    await tick();
    expect(lastRevs()).toEqual({
      kind: 'branches',
      names: ['feature/login', 'main', 'origin/main'],
    });
    expect(dialog()).toBeNull();
  });

  it('Enter 도 같다. 클릭 뒤 더블클릭이면 마지막 범위는 더블클릭의 것이다', async () => {
    const { lastRevs } = await setup();
    const tree = within(branchPanel() as HTMLElement).getByRole('tree');
    act(() => fireEvent.click(row(LOCAL('development'))));
    await tick();
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'development' });
    act(() => fireEvent.keyDown(tree, { key: 'Enter' }));
    await tick();
    expect(lastRevs()).toEqual({
      kind: 'branches',
      names: ['development', 'main', 'origin/main'],
    });
    act(() => fireEvent.click(row(LOCAL('release'))));
    act(() => fireEvent.doubleClick(row(LOCAL('release'))));
    await tick();
    expect(lastRevs()).toEqual({ kind: 'branches', names: ['release', 'main', 'origin/main'] });
  });

  it('HEAD 행·그룹의 더블클릭은 범위를 바꾸지 않는다', async () => {
    const { querySet } = await setup();
    const before = querySet.mock.calls.length;
    act(() => fireEvent.doubleClick(row('head')));
    act(() => fireEvent.doubleClick(row('group:local')));
    await tick();
    // HEAD 행의 한 번 클릭(더블클릭에 앞선 클릭은 jsdom 에서 따로 오지 않는다)도 없었으니 질의가 없다
    expect(querySet.mock.calls.length).toBe(before);
    expect(dialog()).toBeNull();
  });
});

describe('브랜치 우클릭 메뉴 (BT-07)', () => {
  it('로컬 브랜치 행의 메뉴는 checkout…, 업데이트, 여기서 새 branch…, 이름 변경…, 이 branch 만 보기, 즐겨찾기, 이름 복사다', async () => {
    await setup();
    const menu = await openMenu(LOCAL('hotfix'));
    expect(menu.map((m) => m.textContent)).toEqual([
      S.branches.menu.checkout,
      // hotfix 는 어느 저장소에도 업스트림이 없다: 사유를 이름에 적고 끈다 (BR-09)
      S.branches.menu.updateNone,
      `${S.comparison.withLocal}▸`,
      `${S.menu.compareWithHead('hotfix')}▸`,
      S.folder.integration.mergeMenu('hotfix'),
      S.folder.integration.rebaseMenu('hotfix'),
      S.branches.menu.newBranchHere,
      S.menu.rename,
      S.folder.localDeletion.menu,
      S.branches.menu.showOnly,
      S.branches.addFavorite,
      S.menu.copyName,
    ]);
    expect(menu.map((m) => m.getAttribute('aria-disabled'))).toEqual([
      null,
      'true',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('원격 브랜치 행에는 업데이트·이름 변경이 없다', async () => {
    await setup();
    const menu = await openMenu(REMOTE('origin/hotfix'));
    expect(menu.map((m) => m.textContent)).toEqual([
      S.branches.menu.checkout,
      `${S.comparison.withLocal}▸`,
      `${S.menu.compareWithHead('origin/hotfix')}▸`,
      S.folder.integration.mergeMenu('origin/hotfix'),
      S.folder.integration.rebaseMenu('origin/hotfix'),
      S.branches.menu.newBranchHere,
      S.menu.deleteRemote,
      S.branches.menu.showOnly,
      S.branches.addFavorite,
      S.menu.copyName,
    ]);
  });

  it('원격 삭제는 로그 범위와 무관하게 사전조회한 전체 저장소를 전달하고 로컬 옵션을 묻는다', async () => {
    const targets: BranchDeleteTarget[] = ['api', 'docs'].map((name) => ({
      path: pathOf(name),
      remote: 'origin',
      name: 'hotfix',
      remoteOid: 'a'.repeat(40),
      remoteUrl: '/remote.git',
      excluded: name === 'docs',
      error: null,
      locals: [
        {
          name: 'local-hotfix',
          oid: 'b'.repeat(40),
          upstream: 'refs/remotes/origin/hotfix',
          checkedOut: null,
        },
      ],
    }));
    const inspect = vi.fn(async () => targets);
    const { store, batch } = await setup(async () => ({ ...RESULT, label: 'remote delete' }), {
      inspectFolderRemoteBranchDeletion: inspect,
    });
    await act(async () => {
      await store.getState().setTimelineScope([pathOf('api')]);
    });
    const menu = await openMenu(REMOTE('origin/hotfix'));
    act(() =>
      fireEvent.click(menu.find((item) => item.textContent === S.menu.deleteRemote) as HTMLElement),
    );
    await tick();
    expect(inspect).toHaveBeenCalledWith(FOLDER_ID, 'origin', 'hotfix');
    const opened = dialog() as HTMLDialogElement;
    const check = within(opened).getByRole('checkbox', {
      name: (name) => name.startsWith(S.branches.deletion.together),
    }) as HTMLInputElement;
    expect(check.checked).toBe(false);
    expect(opened.textContent).toContain('docs');
    expect(opened.textContent).toContain(S.branches.deletion.excluded);
    act(() => fireEvent.click(check));
    act(() => fireEvent.submit(opened.querySelector('form') as HTMLFormElement));
    await tick();
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'deleteRemoteBranch', targets, deleteLocal: true },
      [pathOf('api'), pathOf('docs')],
    );
  });

  it('업데이트 (BR-09): 업스트림이 있는 저장소에서만 일괄 UpdateBranch 를 부르고 결과를 알린다. 원격 branch 에는 없다', async () => {
    const { batch } = await setup(async () => ({
      label: '일괄 업데이트: development',
      results: [
        {
          path: pathOf('api'),
          name: 'api',
          ok: true,
          skipped: null,
          message: '',
          moved: { branch: 'development', from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 54 },
        },
        {
          path: pathOf('web'),
          name: 'web',
          ok: true,
          skipped: '로컬이 앞섬 (⇡3), 받을 것 없음',
          message: '',
        },
      ],
      succeeded: 1,
      skipped: 1,
      failed: 0,
    }));
    const menu = await openMenu(LOCAL('development'));
    expect(menu[1]?.textContent).toBe(S.branches.menu.updateIn(2));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.updateIn(2))));
    await tick();
    expect(batch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'updateBranch', name: 'development' }, [
      pathOf('api'),
      pathOf('web'),
    ]);
    expect(toasts()).toEqual([
      [
        'success',
        '일괄 업데이트: development',
        [
          S.folder.batch.resultMoved(1, 0, 0, 1, 0),
          'web: 로컬이 앞섬 (⇡3), 받을 것 없음',
          `api: ${S.branches.update.moved('development', 54)}`,
        ].join('\n'),
      ],
    ]);
    const remote = await openMenu(REMOTE('origin/main'));
    expect(remote.map((m) => m.textContent)).not.toContain(S.branches.menu.updateNone);
  });

  it('"여기서 새 branch…" 는 그 브랜치를 가진 저장소를 체크 목록으로 확인받고, 체크한 저장소에만 만든다', async () => {
    const { batch } = await setup();
    await openMenu(LOCAL('main'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.newBranchHere)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    expect(open.querySelector('h2')?.textContent).toBe(
      S.folder.timeline.newBranchFromTitle('main'),
    );
    expect(open.textContent).toContain(S.folder.timeline.newBranchFromTargets(3));
    // 만든 뒤 checkout 은 꺼져 있고, 시작점을 가진 저장소는 모두 체크돼 있다
    const boxes = within(open).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((b) => [b.labels?.[0]?.textContent, b.checked])).toEqual([
      [S.folder.batch.branchCheckout, false],
      ['api', true],
      ['web', true],
      ['docs', true],
    ]);
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: 'main-2' } });
    // web 을 뺀다
    fireEvent.click(boxes[2] as HTMLInputElement);
    submit();
    await tick();
    // 시작점은 전체 ref 이름으로 넘긴다 (같은 짧은 이름의 태그·원격 브랜치와 헷갈리지 않게)
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'createBranch', name: 'main-2', checkout: false, startPoint: 'refs/heads/main' },
      [pathOf('api'), pathOf('docs')],
    );
    expect(toasts()).toHaveLength(1);
  });

  it('"여기서 새 branch…" 의 이름은 정규화한다: 칸 아래에 만들 이름을 미리 보이고 그 이름으로 만든다', async () => {
    const { batch } = await setup();
    await openMenu(LOCAL('main'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.newBranchHere)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    const preview = () => open.querySelector('[data-role="normalized-preview"]');
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: 'main' } });
    expect(preview()).toBeNull();
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: ' main  - 2 ' } });
    expect(preview()?.textContent).toBe(S.dialog.branchNameWillCreate('main-2'));
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'createBranch', name: 'main-2', checkout: false, startPoint: 'refs/heads/main' },
      [pathOf('api'), pathOf('web'), pathOf('docs')],
    );
  });

  it('"여기서 새 branch…" 에서 저장소를 모두 해제하면 실행하지 않는다 (빈 목록은 코어에서 전부를 뜻한다)', async () => {
    const { batch } = await setup();
    await openMenu(LOCAL('hotfix'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.newBranchHere)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: 'hotfix-2' } });
    const repos = within(open)
      .getAllByRole<HTMLInputElement>('checkbox')
      .filter((b) => b.labels?.[0]?.textContent !== S.folder.batch.branchCheckout);
    expect(repos.map((b) => b.labels?.[0]?.textContent)).toEqual(['api', 'docs']);
    for (const box of repos) {
      fireEvent.click(box);
    }
    // 대상 저장소를 하나도 체크하지 않으면 확인이 꺼진다 (W19)
    expect(
      within(open).getByRole<HTMLButtonElement>('button', { name: S.dialog.create }).disabled,
    ).toBe(true);
    expect(within(open).getByRole('status').textContent).toBe(S.folder.batch.noneChecked);
    submit();
    await tick();
    expect(batch).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('"여기서 새 branch…" 의 대상 저장소는 옵션과 나뉜 묶음이다 (W19)', async () => {
    await setup();
    await openMenu(LOCAL('main'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.newBranchHere)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    const group = within(open).getByRole('group', { name: S.folder.batch.repoGroup(3) });
    expect(
      within(group)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((b) => b.labels?.[0]?.textContent),
    ).toEqual(['api', 'web', 'docs']);
    // 이름 칸과 checkout 옵션은 묶음 밖이다
    expect(group.contains(within(open).getByRole('textbox'))).toBe(false);
    expect(
      group.contains(within(open).getByRole('checkbox', { name: S.folder.batch.branchCheckout })),
    ).toBe(false);
  });

  it('"여기서 새 branch…" 의 대상 묶음에 전체 선택·해제가 있다: 해제하면 만들기가 꺼지고 선택하면 다시 켜진다', async () => {
    const { batch } = await setup();
    await openMenu(LOCAL('main'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.newBranchHere)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: 'main-2' } });
    const group = within(open).getByRole('group', { name: S.folder.batch.repoGroup(3) });
    const repos = () =>
      within(group)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((b) => b.checked);
    const create = () =>
      within(open).getByRole<HTMLButtonElement>('button', { name: S.dialog.create });
    act(() => fireEvent.click(within(group).getByRole('button', { name: S.selection.none })));
    expect(repos()).toEqual([false, false, false]);
    expect(create().disabled).toBe(true);
    // checkout 옵션은 묶음 밖이라 바뀌지 않는다
    expect(
      within(open).getByRole<HTMLInputElement>('checkbox', { name: S.folder.batch.branchCheckout })
        .checked,
    ).toBe(false);
    act(() => fireEvent.click(within(group).getByRole('button', { name: S.selection.all })));
    expect(repos()).toEqual([true, true, true]);
    expect(create().disabled).toBe(false);
    // 단추는 제출하지 않는다
    expect(batch).not.toHaveBeenCalled();
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'createBranch', name: 'main-2', checkout: false, startPoint: 'refs/heads/main' },
      [pathOf('api'), pathOf('web'), pathOf('docs')],
    );
  });

  it('원격 브랜치에서 새 branch 를 만들면 시작점은 그 원격 ref 다', async () => {
    const { batch } = await setup();
    await openMenu(REMOTE('origin/hotfix'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.newBranchHere)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: 'fix' } });
    fireEvent.click(within(open).getByRole('checkbox', { name: S.folder.batch.branchCheckout }));
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      {
        kind: 'createBranch',
        name: 'fix',
        checkout: true,
        startPoint: 'refs/remotes/origin/hotfix',
      },
      [pathOf('api'), pathOf('docs')],
    );
  });

  it('즐겨찾기인 행의 메뉴는 "즐겨찾기 해제" 를 보인다', async () => {
    await setup();
    const menu = await openMenu(REMOTE('origin/main'));
    expect(menu.map((m) => m.textContent)).toContain(S.branches.removeFavorite);
    expect(menu.map((m) => m.textContent)).not.toContain(S.branches.addFavorite);
  });

  it('모든 저장소에서 이미 현재인 브랜치의 checkout 은 꺼져 있다', async () => {
    await setup();
    const menu = await openMenu(LOCAL('feature/login'));
    expect(menu[0]?.textContent).toBe(S.branches.menu.checkout);
    expect(menu[0]?.getAttribute('aria-disabled')).toBe('true');
  });

  it('HEAD 행과 그룹에는 메뉴가 없다', async () => {
    await setup();
    expect(await openMenu('head')).toEqual([]);
    expect(await openMenu('group:local')).toEqual([]);
  });

  it('"이 branch 만 보기" 는 로그를 그 브랜치로 거른다', async () => {
    const { lastRevs } = await setup();
    await openMenu(REMOTE('origin/hotfix'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.showOnly)));
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'origin/hotfix' });
  });

  it('"이름 복사" 는 브랜치 이름을 클립보드에 넣는다', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await setup();
    await openMenu(REMOTE('origin/hotfix'));
    act(() => fireEvent.click(screen.getByText(S.menu.copyName)));
    expect(writeText).toHaveBeenCalledWith('origin/hotfix');
  });
});

describe('브랜치 이름 변경 (로컬 branch, 폴더 일괄 RenameBranch)', () => {
  /** 이름 변경 결과: api 는 바꾸고 web 은 새 이름이 이미 있어 건너뛴다 */
  const RENAMED: BatchResult = {
    label: '일괄 이름 바꾸기: development → dev-2',
    results: [
      { path: pathOf('api'), name: 'api', ok: true, skipped: null, message: '' },
      {
        path: pathOf('web'),
        name: 'web',
        ok: true,
        skipped: '새 이름이 이미 있음: dev-2',
        message: '',
      },
    ],
    succeeded: 1,
    skipped: 1,
    failed: 0,
  };

  /** development 행의 메뉴에서 이름 변경을 연다 */
  async function openRename() {
    await openMenu(LOCAL('development'));
    act(() => fireEvent.click(screen.getByText(S.menu.rename)));
    await tick();
    return dialog() as HTMLDialogElement;
  }

  it('새 이름 칸은 지금 이름으로 채우고, 그 branch 가 있는 저장소를 체크 목록으로 확인받는다. 그대로면 확인이 꺼진다', async () => {
    const { batch } = await setup();
    const open = await openRename();
    expect(open.querySelector('h2')?.textContent).toBe(
      S.folder.timeline.renameTitle('development'),
    );
    expect(open.textContent).toContain(S.folder.timeline.renameTargets(2));
    const name = within(open).getByRole<HTMLInputElement>('textbox', { name: S.dialog.newName });
    expect(name.value).toBe('development');
    const boxes = within(open).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((b) => [b.labels?.[0]?.textContent, b.checked])).toEqual([
      ['api', true],
      ['web', true],
    ]);
    expect(within(open).getByRole('group', { name: S.folder.batch.repoGroup(2) })).toBeTruthy();
    const confirm = () =>
      within(open).getByRole<HTMLButtonElement>('button', { name: S.dialog.rename });
    // 지금 이름 그대로(공백만 덧붙여도 정규화하면 같다)면 확인이 꺼지고 사유가 보인다
    expect(confirm().disabled).toBe(true);
    expect(open.textContent).toContain(S.folder.timeline.renameSame);
    fireEvent.change(name, { target: { value: ' development ' } });
    expect(confirm().disabled).toBe(true);
    // 저장소를 모두 풀어도 꺼진다
    fireEvent.change(name, { target: { value: 'dev-2' } });
    expect(confirm().disabled).toBe(false);
    for (const box of boxes) {
      fireEvent.click(box);
    }
    expect(confirm().disabled).toBe(true);
    submit();
    await tick();
    expect(batch).not.toHaveBeenCalled();
  });

  it('정규화한 새 이름으로 체크한 저장소에서 일괄로 바꾸고 결과를 알린다', async () => {
    const { batch } = await setup(async () => RENAMED);
    const open = await openRename();
    const name = within(open).getByRole('textbox', { name: S.dialog.newName });
    fireEvent.change(name, { target: { value: 'dev  2' } });
    expect(open.querySelector('[data-role="normalized-preview"]')?.textContent).toBe(
      S.dialog.branchNameWillRename('dev-2'),
    );
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'renameBranch', from: 'development', to: 'dev-2' },
      [pathOf('api'), pathOf('web')],
    );
    expect(toasts()).toEqual([
      [
        'success',
        RENAMED.label,
        `${S.folder.batch.result(1, 1, 0)}\nweb: 새 이름이 이미 있음: dev-2`,
      ],
    ]);
  });

  it('로그가 그 branch 로 걸려 있었으면 범위의 이름도 바꾼다. 바꾸지 않은 저장소가 남으면 옛 이름도 남긴다', async () => {
    const { lastRevs } = await setup(async () => RENAMED);
    act(() => fireEvent.click(row(LOCAL('development'))));
    await tick();
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'development' });
    const open = await openRename();
    fireEvent.change(within(open).getByRole('textbox', { name: S.dialog.newName }), {
      target: { value: 'dev-2' },
    });
    submit();
    await tick();
    // web 은 건너뛰어 development 가 남았다
    expect(lastRevs()).toEqual({ kind: 'branches', names: ['development', 'dev-2'] });
  });
});

describe('브랜치 checkout (BT-07)', () => {
  it('확인창에 그 브랜치를 가진 저장소의 수와 이름을 체크 목록으로 보이고, 체크한 저장소에만 실행한다', async () => {
    const { batch } = await setup();
    await openMenu(LOCAL('main'));
    act(() => fireEvent.click(screen.getByText(S.branches.menu.checkout)));
    await tick();

    const open = dialog() as HTMLDialogElement;
    expect(open.querySelector('h2')?.textContent).toBe(S.folder.timeline.checkoutTitle('main'));
    expect(open.textContent).toContain(S.folder.timeline.checkoutTargets(3));
    expect(open.textContent).not.toContain(S.folder.timeline.checkoutTracking);
    const boxes = within(open).getAllByRole<HTMLInputElement>('checkbox');
    // 이미 그 브랜치인 저장소는 표시하고 체크를 빼 둔다
    expect(boxes.map((b) => [b.labels?.[0]?.textContent, b.checked])).toEqual([
      ['api', true],
      ['web', true],
      [S.folder.timeline.checkoutCurrent('docs'), false],
    ]);
    fireEvent.click(boxes[1] as HTMLInputElement);
    submit();
    await tick();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'checkout', name: 'main' }, [
      pathOf('api'),
    ]);
    // 결과를 알린다: 건너뛴 저장소와 사유까지
    expect(toasts()).toEqual([
      [
        'success',
        RESULT.label,
        `${S.folder.batch.result(1, 1, 0)}\ndocs: 커밋하지 않은 변경이 있음`,
      ],
    ]);
  });

  it('아무 저장소도 체크하지 않으면 실행하지 않는다 (빈 목록은 코어에서 전부를 뜻한다)', async () => {
    const { batch } = await setup();
    await openCheckout(LOCAL('hotfix'));
    const open = dialog() as HTMLElement;
    // 저장소 목록은 "대상 저장소" 묶음이다 (W19)
    expect(within(open).getByRole('group', { name: S.folder.batch.repoGroup(2) })).toBeTruthy();
    for (const box of within(open).getAllByRole('checkbox')) {
      fireEvent.click(box);
    }
    // 하나도 체크하지 않으면 확인이 꺼진다 (W19)
    expect(
      within(open).getByRole<HTMLButtonElement>('button', { name: S.menu.checkout }).disabled,
    ).toBe(true);
    submit();
    await tick();
    expect(batch).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('원격 브랜치는 로컬 추적 브랜치로 checkout 하고, 그렇게 된다는 것을 확인창에 적는다', async () => {
    const { batch } = await setup();
    await openCheckout(REMOTE('origin/hotfix'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      S.folder.timeline.checkoutTitle('origin/hotfix'),
    );
    expect(dialog()?.textContent).toContain(S.folder.timeline.checkoutTargets(2));
    expect(dialog()?.textContent).toContain(S.folder.timeline.checkoutTracking);
    submit();
    await tick();
    // 분리 HEAD 가 되는 `checkout origin/hotfix` 가 아니라 원격과 브랜치를 나눠 넘긴다
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'checkoutRemote', remote: 'origin', branch: 'hotfix' },
      [pathOf('api'), pathOf('docs')],
    );
  });

  it('원격 브랜치를 추적하는 로컬 짝이 이미 현재 브랜치인 저장소는 표시하고 체크를 빼 둔다', async () => {
    await setup();
    await openCheckout(REMOTE('origin/main'));
    const boxes = within(dialog() as HTMLElement).getAllByRole<HTMLInputElement>('checkbox');
    // docs 는 origin/main 을 추적하는 main 에 이미 있다
    expect(boxes.map((b) => [b.labels?.[0]?.textContent, b.checked])).toEqual([
      ['api', true],
      ['web', true],
      [S.folder.timeline.checkoutCurrent('docs'), false],
    ]);
  });

  it('같은 이름의 로컬이 현재 브랜치여도 그 원격을 추적하지 않으면 "현재 branch" 로 치지 않는다', async () => {
    // web 은 feature/login 에 있지만 그 브랜치는 origin/feature/login 을 추적하지 않는다 (코어가 건너뛴다)
    const branches: FolderBranches = {
      ...BRANCHES,
      branches: [...BRANCHES.branches, branch('origin/feature/login', at('web'))],
    };
    await setup(undefined, { folderBranches: async () => branches });
    await openCheckout(REMOTE('origin/feature/login'));
    const boxes = within(dialog() as HTMLElement).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((b) => [b.labels?.[0]?.textContent, b.checked])).toEqual([['web', true]]);
  });

  it('실행하지 못하면 사유를 알린다', async () => {
    await setup(async () => {
      throw new Error('세션 없음');
    });
    await openCheckout(LOCAL('hotfix'));
    submit();
    await tick();
    expect(toasts()).toEqual([['error', S.folder.timeline.batchFailed, '세션 없음']]);
  });
});

describe('즐겨찾기 (BT-04)', () => {
  it('행의 별을 누르면 순서가 바뀌고 루트 경로로 저장된다', async () => {
    await setup();
    expect(ids().slice(5, 7)).toEqual([LOCAL('hotfix'), LOCAL('release')]);
    const star = within(row(LOCAL('release'))).getByRole('button', {
      name: S.branches.addFavorite,
    });
    act(() => fireEvent.click(star));
    // 현재 브랜치 묶음 다음, 즐겨찾기가 이름순보다 먼저
    expect(ids().slice(2, 7)).toEqual([
      LOCAL('main'),
      LOCAL('development'),
      LOCAL('feature/login'),
      LOCAL('release'),
      LOCAL('hotfix'),
    ]);
    expect(storedFavorites()).toEqual({ [ROOT]: { on: ['refs/heads/release'], off: [] } });

    // 기본 즐겨찾기를 끄면 꺼진 채로 남는다
    act(() =>
      fireEvent.click(
        within(row(REMOTE('origin/main'))).getByRole('button', { name: S.branches.removeFavorite }),
      ),
    );
    expect(ids().slice(8)).toEqual([REMOTE('origin/hotfix'), REMOTE('origin/main')]);
    expect(storedFavorites()).toEqual({
      [ROOT]: { on: ['refs/heads/release'], off: ['refs/remotes/origin/main'] },
    });
  });

  it('저장한 즐겨찾기는 다시 열어도 그대로다', async () => {
    localStorage.setItem(
      PREF_BRANCH_FAVORITES,
      JSON.stringify({ [ROOT]: { on: ['refs/remotes/origin/hotfix'], off: ['refs/heads/main'] } }),
    );
    await setup();
    // 끈 기본 즐겨찾기(main)는 현재 묶음 안에서 이름순으로 내려가고, 켠 원격 브랜치는 위로 온다
    expect(ids().slice(2, 7)).toEqual([
      LOCAL('development'),
      LOCAL('feature/login'),
      LOCAL('main'),
      LOCAL('hotfix'),
      LOCAL('release'),
    ]);
    expect(ids().slice(8)).toEqual([REMOTE('origin/hotfix'), REMOTE('origin/main')]);
    expect(
      within(row(LOCAL('main'))).getByRole('button', { name: S.branches.addFavorite }),
    ).toBeTruthy();
    expect(
      within(row(REMOTE('origin/hotfix'))).getByRole('button', { name: S.branches.removeFavorite }),
    ).toBeTruthy();
  });

  it('메뉴의 즐겨찾기도 같은 값을 바꾼다', async () => {
    await setup();
    await openMenu(LOCAL('hotfix'));
    act(() => fireEvent.click(screen.getByText(S.branches.addFavorite)));
    expect(storedFavorites()).toEqual({ [ROOT]: { on: ['refs/heads/hotfix'], off: [] } });
  });
});

describe('세로 툴바 (BT-05)', () => {
  const t = S.branches.toolbar;

  it('즐겨찾기 버튼은 브랜치를 골랐을 때만 켜지고 고른 브랜치의 즐겨찾기를 뒤집는다', async () => {
    await setup();
    expect(toolbarButton(t.favorite).disabled).toBe(true);
    // HEAD 행은 즐겨찾기할 수 없다
    act(() => fireEvent.click(row('head')));
    expect(toolbarButton(t.favorite).disabled).toBe(true);

    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    expect(toolbarButton(t.favorite).disabled).toBe(false);
    expect(toolbarButton(t.favorite).getAttribute('aria-pressed')).toBe('false');
    act(() => fireEvent.click(toolbarButton(t.favorite)));
    expect(storedFavorites()).toEqual({ [ROOT]: { on: ['refs/heads/hotfix'], off: [] } });
    expect(toolbarButton(t.favorite).getAttribute('aria-pressed')).toBe('true');

    // 즐겨찾기와 아닌 것을 함께 고르면 모두 켠다
    act(() => fireEvent.click(row(REMOTE('origin/hotfix')), { metaKey: true }));
    expect(toolbarButton(t.favorite).getAttribute('aria-pressed')).toBe('false');
    act(() => fireEvent.click(toolbarButton(t.favorite)));
    expect(storedFavorites()).toEqual({
      [ROOT]: { on: ['refs/heads/hotfix', 'refs/remotes/origin/hotfix'], off: [] },
    });
    // 모두 즐겨찾기면 모두 끈다. 기본 상태로 돌아간 루트는 저장값에서 빠진다
    act(() => fireEvent.click(toolbarButton(t.favorite)));
    expect(storedFavorites()).toEqual({});
  });

  it('선택한 branch 업데이트 (BR-09): 업스트림이 있는 로컬 branch 하나를 골랐을 때만 켜지고 그 저장소들에서 업데이트한다', async () => {
    const { batch } = await setup();
    expect(toolbarButton(t.update).disabled).toBe(true);
    expect(toolbarButton(t.update).getAttribute('title')).toBe(t.updateNone);
    // 업스트림이 없는 branch·원격 branch 는 꺼진 채
    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    expect(toolbarButton(t.update).disabled).toBe(true);
    act(() => fireEvent.click(row(REMOTE('origin/main'))));
    expect(toolbarButton(t.update).disabled).toBe(true);

    act(() => fireEvent.click(row(LOCAL('development'))));
    expect(toolbarButton(t.update).disabled).toBe(false);
    expect(toolbarButton(t.update).getAttribute('title')).toBe(
      S.folder.batch.withScope(`${t.update}: development`, S.folder.batch.repoGroup(2)),
    );
    act(() => fireEvent.click(toolbarButton(t.update)));
    await tick();
    expect(batch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'updateBranch', name: 'development' }, [
      pathOf('api'),
      pathOf('web'),
    ]);
    // 둘을 고르면 꺼진다
    act(() => fireEvent.click(row(LOCAL('main')), { metaKey: true }));
    expect(toolbarButton(t.update).disabled).toBe(true);
  });

  it('모두 접기·모두 펼치기는 그룹을 한꺼번에 접고 편다', async () => {
    await setup();
    act(() => fireEvent.click(toolbarButton(t.collapseAll)));
    expect(ids()).toEqual(['head', 'group:local', 'group:remote']);
    act(() => fireEvent.click(toolbarButton(t.expandAll)));
    expect(ids()).toHaveLength(10);
  });

  it('접기 버튼은 브랜치 패널만 접고 선택을 저장한다. 접혀 있어도 툴바는 남아 다시 펼 수 있다', async () => {
    await setup();
    expect(toolbarButton(t.togglePanel).getAttribute('aria-pressed')).toBe('true');
    act(() => fireEvent.click(toolbarButton(t.togglePanel)));
    expect(branchPanel()?.hasAttribute('inert')).toBe(true);
    expect(localStorage.getItem('mgit.gitLogBranches')).toBe(JSON.stringify({ open: false }));
    expect(toolbarButton(t.togglePanel).getAttribute('aria-pressed')).toBe('false');
    // 트리를 다루는 버튼은 꺼지고, 새 branch·fetch 는 그대로 쓸 수 있다
    expect(toolbarButton(t.expandAll).disabled).toBe(true);
    expect(toolbarButton(t.collapseAll).disabled).toBe(true);
    expect(toolbarButton(t.newBranch).disabled).toBe(false);
    expect(toolbarButton(t.fetch).disabled).toBe(false);

    act(() => fireEvent.click(toolbarButton(t.togglePanel)));
    expect(branchPanel()?.hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem('mgit.gitLogBranches')).toBe(JSON.stringify({ open: true }));
  });

  it('fetch 는 기존 폴더 일괄 fetch 를 부르고 결과를 알린다. 툴팁에 대상 수를 쓴다', async () => {
    const { batch } = await setup();
    expect(toolbarButton(t.fetch).getAttribute('title')).toBe(
      S.folder.batch.withScope(t.fetch, S.folder.batch.allRepos(3)),
    );
    act(() => fireEvent.click(toolbarButton(t.fetch)));
    await tick();
    expect(batch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'fetch', prune: true }, []);
    expect(toasts()).toHaveLength(1);
  });

  it('새 branch 는 기존 폴더 일괄 branch 만들기 흐름을 열고, 확인창에 대상 저장소의 수와 이름을 쓴다', async () => {
    const { batch, store } = await setup();
    act(() => fireEvent.click(toolbarButton(t.newBranch)));
    await tick();
    const open = dialog() as HTMLDialogElement;
    expect(open.querySelector('h2')?.textContent).toBe(S.folder.batch.branchTitle);
    expect(open.textContent).toContain(
      S.folder.batch.targets(S.folder.batch.allRepos(3), 'api, web, docs'),
    );
    fireEvent.change(within(open).getByRole('textbox'), { target: { value: 'feature/new' } });
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      { kind: 'createBranch', name: 'feature/new', checkout: true },
      [],
    );

    // 개요에서 저장소를 골라 두었으면 그 저장소가 대상이고 툴팁과 확인창이 그렇게 말한다
    act(() => store.getState().setSelected([pathOf('web')]));
    expect(toolbarButton(t.newBranch).getAttribute('title')).toBe(
      S.folder.batch.withScope(t.newBranch, S.folder.batch.selected(1)),
    );
    act(() => fireEvent.click(toolbarButton(t.newBranch)));
    await tick();
    expect(dialog()?.textContent).toContain(
      S.folder.batch.targets(S.folder.batch.selected(1), 'web'),
    );
  });
});

describe('일괄 결과의 실제 변화 (BR-09)', () => {
  const moved = (branch: string, commits: number) => ({
    branch,
    from: 'a'.repeat(40),
    to: (commits > 0 ? 'b' : 'a').repeat(40),
    commits,
  });

  it('옮긴 결과가 있으면 성공을 갱신·이미 최신으로 나누고, 줄마다 "branch ← commit N개"·"이미 최신"을 쓴다', () => {
    const result: BatchResult = {
      label: '일괄 pull',
      results: [
        { path: '/f/a', name: 'a', ok: true, skipped: null, message: '', moved: moved('main', 3) },
        { path: '/f/b', name: 'b', ok: true, skipped: null, message: '', moved: moved('dev', 0) },
        { path: '/f/c', name: 'c', ok: true, skipped: '업스트림 없음', message: '' },
        { path: '/f/d', name: 'd', ok: false, skipped: null, message: 'fatal: x' },
      ],
      succeeded: 2,
      skipped: 1,
      failed: 1,
    };
    expect(batchSummary(result)).toBe(S.folder.batch.resultMoved(1, 1, 0, 1, 1));
    expect(result.results.map(repoResultState)).toEqual([
      S.branches.update.moved('main', 3),
      S.branches.update.upToDate,
      `${S.folder.batch.skipped}: 업스트림 없음`,
      S.folder.batch.failed,
    ]);
    expect(S.folder.batch.resultMoved(1, 1, 0, 1, 1)).toBe(
      '갱신 1 · 이미 최신 1 · 건너뜀 1 · 실패 1',
    );
  });

  it('작업 기록의 줄: 요약은 갱신·이미 최신 수, 펼친 저장소 줄은 "완료" 대신 무엇이 바뀌었는지', async () => {
    const { store } = await setup();
    const result: BatchResult = {
      label: '일괄 pull',
      results: [
        {
          path: pathOf('api'),
          name: 'api',
          ok: true,
          skipped: null,
          message: '',
          moved: moved('development', 54),
        },
        {
          path: pathOf('docs'),
          name: 'docs',
          ok: true,
          skipped: null,
          message: '',
          moved: moved('main', 0),
        },
      ],
      succeeded: 2,
      skipped: 0,
      failed: 0,
    };
    act(() =>
      store.setState({
        taskHistory: [
          {
            id: 1,
            kind: 'batch',
            label: result.label,
            startedAt: 0,
            finishedAt: 0,
            result,
            error: null,
          },
        ],
      }),
    );
    const { container } = render(<TaskHistoryPanel />);
    const toggle = within(container).getByRole('button', { expanded: false });
    expect(toggle.textContent).toContain('일괄 pull');
    expect(toggle.textContent).toContain(S.folder.batch.resultMoved(1, 1, 0, 0, 0));
    act(() => fireEvent.click(toggle));
    const items = [...container.querySelectorAll('li[data-state]')].map((li) => li.textContent);
    expect(items).toEqual([
      `api${S.branches.update.moved('development', 54)}`,
      `docs${S.branches.update.upToDate}`,
    ]);
  });

  it('옮긴 결과가 없는 작업(fetch 등)은 예전 요약과 "완료"를 쓴다', () => {
    const result: BatchResult = {
      label: '일괄 fetch',
      results: [{ path: '/f/a', name: 'a', ok: true, skipped: null, message: '' }],
      succeeded: 1,
      skipped: 0,
      failed: 0,
    };
    expect(batchSummary(result)).toBe(S.folder.batch.result(1, 0, 0));
    expect(repoResultState(result.results[0] as BatchResult['results'][number])).toBe(
      S.folder.batch.ok,
    );
  });
});

describe('batchNotice', () => {
  it('실패가 있으면 오류로, 건너뛰거나 실패한 저장소의 사유를 줄마다 쓴다', () => {
    const notice = batchNotice({
      label: '일괄 fetch',
      results: [
        { path: '/f/a', name: 'a', ok: true, skipped: null, message: '' },
        { path: '/f/b', name: 'b', ok: false, skipped: null, message: 'could not resolve host' },
        { path: '/f/c', name: 'c', ok: true, skipped: '업스트림 없음', message: '' },
      ],
      succeeded: 1,
      skipped: 1,
      failed: 1,
    });
    expect(notice).toEqual({
      kind: 'error',
      title: '일괄 fetch',
      message: `${S.folder.batch.result(1, 1, 1)}\nb: could not resolve host\nc: 업스트림 없음`,
    });
  });

  it('사유가 많으면 다섯 줄까지만 쓰고 나머지는 수로 줄인다', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      path: `/f/r${i}`,
      name: `r${i}`,
      ok: true,
      skipped: '이미 그 branch',
      message: '',
    }));
    const notice = batchNotice({ label: 'x', results, succeeded: 0, skipped: 8, failed: 0 });
    expect(notice.kind).toBe('success');
    expect(notice.message.split('\n')).toEqual([
      S.folder.batch.result(0, 8, 0),
      'r0: 이미 그 branch',
      'r1: 이미 그 branch',
      'r2: 이미 그 branch',
      'r3: 이미 그 branch',
      'r4: 이미 그 branch',
      S.confirm.more(3),
    ]);
  });
});

/** 병합·리베이스 확인창에 전달할 실제 형태의 사전 조회 결과이다. */
function integrationRows(): Awaited<ReturnType<IpcClient['folderIntegrationPreview']>> {
  return [
    {
      path: pathOf('api'),
      name: 'api',
      currentBranch: 'development',
      head: 'a'.repeat(40),
      sourceOid: 'b'.repeat(40),
      reason: null,
    },
    {
      path: pathOf('docs'),
      name: 'docs',
      currentBranch: 'main',
      head: 'c'.repeat(40),
      sourceOid: 'd'.repeat(40),
      reason: null,
    },
  ];
}

describe('멀티 저장소 병합·리베이스 확인', () => {
  it('현재 브랜치별 방향과 제외 사유를 보이고 선택한 스냅샷만 squash 실행한다', async () => {
    const rows = integrationRows().map((row) =>
      row.name === 'docs' ? { ...row, reason: 'Dirty working tree' } : row,
    );
    const preview = vi.fn(async () => rows);
    const { batch } = await setup(async () => RESULT, { folderIntegrationPreview: preview });
    await openMenu(LOCAL('hotfix'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: S.folder.integration.mergeMenu('hotfix') }),
    );
    const enabled = await screen.findByRole('checkbox', {
      name: (name) =>
        name.startsWith(S.folder.integration.mergeDirection('api', 'hotfix', 'development')),
    });
    const disabled = screen.getByRole('checkbox', {
      name: (name) =>
        name.startsWith(S.folder.integration.mergeDirection('docs', 'hotfix', 'main')),
    });
    expect(preview).toHaveBeenCalledWith(FOLDER_ID, 'refs/heads/hotfix', [
      pathOf('api'),
      pathOf('docs'),
    ]);
    expect(enabled).toHaveProperty('checked', true);
    expect(disabled).toHaveProperty('disabled', true);
    expect(disabled).toHaveProperty('checked', false);
    expect(screen.getByText(/Dirty working tree/)).toBeTruthy();
    expect(batch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: S.folder.integration.mode }), {
      target: { value: 'squash' },
    });
    expect(screen.getByText(S.folder.integration.squashNotice)).toBeTruthy();
    submit();
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      {
        kind: 'merge',
        reference: 'refs/heads/hotfix',
        mode: 'squash',
        targets: [
          {
            path: pathOf('api'),
            currentBranch: 'development',
            head: 'a'.repeat(40),
            sourceOid: 'b'.repeat(40),
          },
        ],
      },
      [pathOf('api')],
    );
  });

  it('원격 브랜치 리베이스도 현재 선택한 저장소를 우선 체크하고 확인 전에는 쓰지 않는다', async () => {
    const { store, batch } = await setup(async () => RESULT, {
      folderIntegrationPreview: async () => integrationRows(),
    });
    act(() => store.getState().setSelected([pathOf('docs')]));
    await openMenu(REMOTE('origin/hotfix'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: S.folder.integration.rebaseMenu('origin/hotfix') }),
    );
    const api = await screen.findByRole('checkbox', {
      name: (name) =>
        name.startsWith(
          S.folder.integration.rebaseDirection('api', 'development', 'origin/hotfix'),
        ),
    });
    expect(api).toHaveProperty('checked', false);
    expect(
      screen.getByRole('checkbox', {
        name: (name) =>
          name.startsWith(S.folder.integration.rebaseDirection('docs', 'main', 'origin/hotfix')),
      }),
    ).toHaveProperty('checked', true);
    expect(
      screen.getByText(
        new RegExp(S.folder.integration.remoteSnapshot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ),
    ).toBeTruthy();
    expect(batch).not.toHaveBeenCalled();
    submit();
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
    expect(batch).toHaveBeenCalledWith(
      FOLDER_ID,
      {
        kind: 'rebase',
        reference: 'refs/remotes/origin/hotfix',
        targets: [
          {
            path: pathOf('docs'),
            currentBranch: 'main',
            head: 'c'.repeat(40),
            sourceOid: 'd'.repeat(40),
          },
        ],
      },
      [pathOf('docs')],
    );
  });

  it('모두 해제·취소·실행 불가 상태는 빈 대상 일괄 실행으로 바뀌지 않는다', async () => {
    const { batch } = await setup(async () => RESULT, {
      folderIntegrationPreview: async () => integrationRows(),
    });
    await openMenu(LOCAL('hotfix'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: S.folder.integration.mergeMenu('hotfix') }),
    );
    await screen.findByRole('checkbox', {
      name: (name) =>
        name.startsWith(S.folder.integration.mergeDirection('api', 'hotfix', 'development')),
    });
    for (const checkbox of within(dialog() as HTMLElement).getAllByRole('checkbox'))
      fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: S.folder.integration.mergeRun })).toHaveProperty(
      'disabled',
      true,
    );
    submit();
    await tick();
    expect(batch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: S.confirm.cancel }));
    await tick();
    expect(batch).not.toHaveBeenCalled();
  });

  it('사전 조회 실패는 오류로 알리고 쓰기 작업을 시작하지 않는다', async () => {
    const { batch } = await setup(async () => RESULT, {
      folderIntegrationPreview: async () => {
        throw new Error('preview unavailable');
      },
    });
    await openMenu(LOCAL('hotfix'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: S.folder.integration.mergeMenu('hotfix') }),
    );
    await waitFor(() =>
      expect(
        useAppStore.getState().toasts.some((toast) => toast.message === 'preview unavailable'),
      ).toBe(true),
    );
    expect(dialog()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });

  it('스쿼시 준비와 충돌을 완료된 커밋으로 표시하지 않는다', () => {
    const squashed = {
      path: '/a',
      name: 'a',
      ok: true,
      skipped: null,
      message: '',
      integration: 'squashed' as const,
    };
    const conflicts = {
      path: '/b',
      name: 'b',
      ok: false,
      skipped: null,
      message: 'conflict',
      integration: 'conflicts' as const,
    };
    expect(repoResultState(squashed)).toBe(S.folder.integration.squashed);
    expect(repoResultState(conflicts)).toBe(S.folder.integration.conflicts);
    expect(
      batchNotice({
        label: 'merge',
        results: [squashed, conflicts],
        succeeded: 1,
        skipped: 0,
        failed: 1,
      }).message,
    ).toContain(S.folder.integration.squashed);
  });
});

it('일괄 통합 사전 조회가 끝나기 전에 폴더를 떠나면 확인창이나 쓰기를 시작하지 않는다', async () => {
  let finish: (rows: ReturnType<typeof integrationRows>) => void = () => {};
  const preview = vi.fn(
    () =>
      new Promise<ReturnType<typeof integrationRows>>((resolve) => {
        finish = resolve;
      }),
  );
  const { batch } = await setup(async () => RESULT, { folderIntegrationPreview: preview });
  await openMenu(LOCAL('hotfix'));
  fireEvent.click(screen.getByRole('menuitem', { name: S.folder.integration.mergeMenu('hotfix') }));
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  act(() => useAppStore.setState({ activeSessionId: null }));
  await act(async () => finish(integrationRows()));
  expect(dialog()).toBeNull();
  expect(batch).not.toHaveBeenCalled();
});

it('실행 가능한 저장소가 없으면 사유를 보이고 빈 대상으로 실행하지 않는다', async () => {
  const { batch } = await setup(async () => RESULT, {
    folderIntegrationPreview: async () =>
      integrationRows().map((row) => ({ ...row, reason: 'Current branch is the selected branch' })),
  });
  await openMenu(LOCAL('hotfix'));
  fireEvent.click(
    screen.getByRole('menuitem', { name: S.folder.integration.rebaseMenu('hotfix') }),
  );
  await screen.findByText(S.folder.integration.noneEligible);
  const boxes = within(dialog() as HTMLElement).getAllByRole('checkbox');
  expect(boxes.every((box) => (box as HTMLInputElement).disabled)).toBe(true);
  submit();
  await tick();
  expect(batch).not.toHaveBeenCalled();
});

/** 디스크와 다른 초안을 실제 편집 저장소에 넣고 IME 중으로 두어 자동 저장 타이밍을 제거한다. */
async function pendingIntegrationDraft(client: IpcClient, session: number, path: string) {
  client.fsReadEditableFile = async () => ({
    kind: 'text',
    fileKey: `batch-draft-${session}`,
    path,
    text: 'base',
    revision: '1',
    size: 4,
    bom: false,
    lineEnding: 'lf',
  });
  const opened = await fileEditors.open(client, session, path);
  if (!('fileKey' in opened)) throw new Error('Expected editable fixture');
  const doc = opened as EditorFile;
  fileEditors.composition(doc, true);
  fileEditors.update(
    doc,
    doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: 'draft' } }).state,
  );
  return doc;
}

it('폴더 세션으로 열린 미저장 편집 내용이 있으면 해당 저장소를 체크할 수 없다', async () => {
  const { batch, client } = await setup(async () => RESULT, {
    folderIntegrationPreview: async () => integrationRows(),
  });
  try {
    await pendingIntegrationDraft(client, FOLDER_ID, 'api/draft.ts');
    await openMenu(LOCAL('hotfix'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: S.folder.integration.mergeMenu('hotfix') }),
    );
    const checkbox = await screen.findByRole('checkbox', {
      name: (name) =>
        name.startsWith(S.folder.integration.mergeDirection('api', 'hotfix', 'development')),
    });
    expect(checkbox).toHaveProperty('disabled', true);
    expect(
      screen.getByText(
        new RegExp(S.folder.integration.pendingEditor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ),
    ).toBeTruthy();
    expect(batch).not.toHaveBeenCalled();
  } finally {
    await fileEditors.discard(FOLDER_ID);
    fileEditors.releaseSession(FOLDER_ID);
  }
});

it('확인창 이후 저장소 탭에서 생긴 초안은 다시 검사하여 병합 실행을 막는다', async () => {
  const { batch } = await setup(async () => RESULT, {
    folderIntegrationPreview: async () => integrationRows(),
  });
  const repoClient = createMockClient({ rows: 3, progressIntervalMs: 0 });
  const opened = await repoClient.openRepo(pathOf('api'), () => {});
  const cache = new GraphRangeCache({
    fetchWindow: (start, length) => repoClient.graphWindow(opened.session, start, length),
  });
  const repoStore = createSessionStore(opened, repoClient, cache);
  registerSession(opened.session, { store: repoStore, cache });
  try {
    await openMenu(LOCAL('hotfix'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: S.folder.integration.mergeMenu('hotfix') }),
    );
    await screen.findByRole('checkbox', {
      name: (name) =>
        name.startsWith(S.folder.integration.mergeDirection('api', 'hotfix', 'development')),
    });
    await pendingIntegrationDraft(repoClient, opened.session, 'draft.ts');
    submit();
    await waitFor(() =>
      expect(
        useAppStore
          .getState()
          .toasts.some((toast) => toast.message === S.folder.integration.editorChanged),
      ).toBe(true),
    );
    expect(batch).not.toHaveBeenCalled();
  } finally {
    await fileEditors.discard(opened.session);
    fileEditors.releaseSession(opened.session);
    await repoClient.closeRepo(opened.session);
  }
});

describe('멀티 레포 로컬 브랜치 삭제', () => {
  /** 로컬 브랜치 메뉴에서 삭제 확인을 연다. */
  async function openDelete(name: string) {
    await openMenu(LOCAL(name));
    act(() => fireEvent.click(screen.getByText(S.folder.localDeletion.menu)));
    await tick();
    return dialog() as HTMLDialogElement;
  }

  it('현재 브랜치는 선택할 수 없고 선택한 저장소만 안전 삭제한다', async () => {
    const { batch } = await setup();
    const opened = await openDelete('main');
    const boxes = within(opened).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(opened.textContent).toContain(S.folder.localDeletion.current);
    expect(opened.textContent).toContain(S.folder.localDeletion.message);
    fireEvent.click(boxes[1] as HTMLInputElement);
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'deleteBranch', name: 'main' }, [
      pathOf('api'),
    ]);
    expect(toasts().length).toBe(1);
  });

  it('빈 선택과 현재 브랜치만 있는 경우는 실행하지 않는다', async () => {
    const { batch } = await setup();
    const opened = await openDelete('feature/login');
    expect(within(opened).getByRole<HTMLInputElement>('checkbox').disabled).toBe(true);
    expect(opened.textContent).toContain(S.folder.localDeletion.noneEligible);
    expect(
      within(opened).getByRole<HTMLButtonElement>('button', {
        name: S.folder.localDeletion.confirm,
      }).disabled,
    ).toBe(true);
    submit();
    await tick();
    expect(batch).not.toHaveBeenCalled();
  });

  it('삭제 후 브랜치가 모두 사라지면 로그 조건을 HEAD로 돌린다', async () => {
    let deleted = false;
    const { lastRevs } = await setup(
      async () => {
        deleted = true;
        return {
          label: 'delete hotfix',
          results: ['api', 'docs'].map((name) => ({
            path: pathOf(name),
            name,
            ok: true,
            skipped: null,
            message: '',
          })),
          succeeded: 2,
          skipped: 0,
          failed: 0,
        };
      },
      {
        folderBranches: async () => ({
          ...BRANCHES,
          branches: BRANCHES.branches.filter((item) => !deleted || item.name !== 'hotfix'),
        }),
      },
    );
    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    await tick();
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'hotfix' });
    await openDelete('hotfix');
    submit();
    await tick();
    expect(lastRevs()).toEqual({ kind: 'head' });
    expect(ids()).not.toContain(LOCAL('hotfix'));
  });

  it('일부 삭제가 실패하면 남은 브랜치 조건과 실패 사유를 유지한다', async () => {
    const { lastRevs } = await setup(async () => ({
      label: 'delete hotfix',
      succeeded: 1,
      failed: 1,
      skipped: 0,
      results: [
        { path: pathOf('api'), name: 'api', ok: true, skipped: null, message: '' },
        {
          path: pathOf('docs'),
          name: 'docs',
          ok: false,
          skipped: null,
          message: 'not fully merged',
        },
      ],
    }));
    act(() => fireEvent.click(row(LOCAL('hotfix'))));
    await tick();
    await openDelete('hotfix');
    submit();
    await tick();
    expect(lastRevs()).toEqual({ kind: 'solo', name: 'hotfix' });
    expect(toasts()[0]?.[2]).toContain('not fully merged');
  });

  it('모든 체크 해제 또는 취소는 삭제를 실행하지 않는다', async () => {
    const { batch } = await setup();
    const opened = await openDelete('hotfix');
    for (const box of within(opened).getAllByRole('checkbox')) fireEvent.click(box);
    expect(
      within(opened).getByRole<HTMLButtonElement>('button', {
        name: S.folder.localDeletion.confirm,
      }).disabled,
    ).toBe(true);
    submit();
    await tick();
    expect(batch).not.toHaveBeenCalled();
    fireEvent.click(within(opened).getByRole('button', { name: S.confirm.cancel }));
    await tick();
    expect(batch).not.toHaveBeenCalled();
  });

  it('폴더에서 제외한 저장소는 체크를 끄고 사유를 표시한다', async () => {
    const { store, batch } = await setup();
    act(() =>
      store.setState({
        settings: {
          pullMode: 'ffOnly',
          concurrency: 4,
          autoRefreshSecs: 0,
          worktreeRoot: null,
          ...store.getState().settings,
          exclude: ['api'],
        },
      }),
    );
    const opened = await openDelete('hotfix');
    const boxes = within(opened).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(opened.textContent).toContain(S.folder.batch.excluded);
    submit();
    await tick();
    expect(batch).toHaveBeenCalledWith(FOLDER_ID, { kind: 'deleteBranch', name: 'hotfix' }, [
      pathOf('docs'),
    ]);
  });
});
