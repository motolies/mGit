import type { GraphViewProps } from '@mgit/graph-view';
import {
  type BatchResult,
  createNullClient,
  type FolderBranch,
  type FolderBranches,
  type FolderBranchIn,
  type GraphRevs,
  type IpcClient,
  type TimelineInfo,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREF_BRANCH_FAVORITES } from '../features/branches/branch-favorites';
import { batchNotice } from '../features/folder/batch-report';
import { FolderTimeline } from '../features/folder/FolderTimeline';
import { useAppStore } from '../store';
import type { SessionMeta } from '../store/app-store';
import { createFolderStore, DEFAULT_TIMELINE_QUERY, type FolderStore } from '../store/folder-store';
import { clearSessionRegistry, disposeFolder, registerFolder } from '../store/session-registry';
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
  return { store, batch, querySet, lastRevs };
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

describe('브랜치 우클릭 메뉴 (BT-07)', () => {
  it('브랜치 행의 메뉴는 checkout…, 여기서 새 branch…, 이 branch 만 보기, 즐겨찾기, 이름 복사다', async () => {
    await setup();
    const menu = await openMenu(LOCAL('hotfix'));
    expect(menu.map((m) => m.textContent)).toEqual([
      S.branches.menu.checkout,
      S.branches.menu.newBranchHere,
      S.branches.menu.showOnly,
      S.branches.addFavorite,
      S.menu.copyName,
    ]);
    expect(menu.map((m) => m.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
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

  it('더블클릭과 Enter 도 같은 확인창을 연다', async () => {
    await setup();
    act(() => fireEvent.doubleClick(row(LOCAL('hotfix'))));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      S.folder.timeline.checkoutTitle('hotfix'),
    );
    act(() => fireEvent.click(within(dialog() as HTMLElement).getByText(S.confirm.cancel)));
    await tick();
    expect(dialog()).toBeNull();

    const tree = within(branchPanel() as HTMLElement).getByRole('tree');
    act(() => fireEvent.click(row(LOCAL('development'))));
    act(() => fireEvent.keyDown(tree, { key: 'Enter' }));
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      S.folder.timeline.checkoutTitle('development'),
    );
  });

  it('아무 저장소도 체크하지 않으면 실행하지 않는다 (빈 목록은 코어에서 전부를 뜻한다)', async () => {
    const { batch } = await setup();
    act(() => fireEvent.doubleClick(row(LOCAL('hotfix'))));
    await tick();
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
    act(() => fireEvent.doubleClick(row(REMOTE('origin/hotfix'))));
    await tick();
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
    act(() => fireEvent.doubleClick(row(REMOTE('origin/main'))));
    await tick();
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
    act(() => fireEvent.doubleClick(row(REMOTE('origin/feature/login'))));
    await tick();
    const boxes = within(dialog() as HTMLElement).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((b) => [b.labels?.[0]?.textContent, b.checked])).toEqual([['web', true]]);
  });

  it('모든 저장소에서 이미 현재인 브랜치는 더블클릭해도 확인창을 열지 않는다', async () => {
    await setup();
    act(() => fireEvent.doubleClick(row(LOCAL('feature/login'))));
    await tick();
    expect(dialog()).toBeNull();
  });

  it('실행하지 못하면 사유를 알린다', async () => {
    await setup(async () => {
      throw new Error('세션 없음');
    });
    act(() => fireEvent.doubleClick(row(LOCAL('hotfix'))));
    await tick();
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
