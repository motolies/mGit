import type { GraphViewProps } from '@mgit/graph-view';
import {
  createMockClient,
  type GraphRow,
  type IpcClient,
  IpcClientError,
  type SessionId,
  type TimelineInfo,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterOf } from '../features/filter-bar/filter-model';
import { FolderLogFilter, timelineStatus } from '../features/folder/FolderLogFilter';
import {
  FolderTimeline,
  failedTimelineRepos,
  rowScopeAction,
} from '../features/folder/FolderTimeline';
import { getFolderStore, useAppStore } from '../store';
import { createFolderStore, type FolderStore } from '../store/folder-store';
import { clearSessionRegistry, disposeFolder, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그 뷰 대역: 마운트 횟수와 받은 props 를 기록하고, 캐시에 읽어 둔 앞쪽 행을 실제 행과 같은 속성으로 그린다
const h = vi.hoisted(() => ({ mounts: 0, last: null as unknown }));
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (props: GraphViewProps) => {
    h.last = props;
    // 캐시에 행이 들어오면 다시 그린다 (실제 뷰처럼)
    const [, bump] = useState(0);
    useEffect(() => props.cache.subscribe(() => bump((n) => n + 1)), [props.cache]);
    useEffect(() => {
      h.mounts += 1;
    }, []);
    const rows = props.cache.slice(0, Math.min(props.totalRows, 6)).rows;
    return (
      <div data-testid="graph-view">
        {rows.map((r) =>
          r ? (
            <div key={`${r.repo}:${r.oid}`} data-oid={r.oid} data-row={r.row}>
              {r.subject}
            </div>
          ) : null,
        )}
      </div>
    );
  },
}));

const FOLDER = '/mock/acme-platform';
const API = `${FOLDER}/api-gateway`;
const WEB = `${FOLDER}/web-console`;
let mounted: SessionId[] = [];

/** 목 폴더 장면으로 로그 탭을 그린다. `overrides` 로 일부 메서드를 바꾼다 */
async function setup(
  overrides: (mock: IpcClient) => Partial<IpcClient> = () => ({}),
  opts: { timelineDelayMs?: number } = {},
) {
  const mock = createMockClient({
    rows: 60,
    scene: 'folder',
    progressIntervalMs: 0,
    timelineDelayMs: opts.timelineDelayMs ?? 0,
  });
  const client: IpcClient = { ...mock, ...overrides(mock) };
  const spies = {
    querySet: vi.spyOn(client, 'folderTimelineQuerySet'),
    scopeSet: vi.spyOn(client, 'folderTimelineScopeSet'),
    authors: vi.spyOn(client, 'folderTimelineAuthors'),
    reload: vi.spyOn(client, 'folderTimelineReload'),
    prefs: vi.spyOn(client, 'folderTimelinePrefsSet'),
  };
  const opened = await client.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  const store: FolderStore = createFolderStore(opened, client);
  registerFolder(id, store);
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      client,
    }),
  );
  render(<FolderTimeline />);
  await tick();
  await tick();
  return { store, id, spies };
}

/** 캐시의 앞쪽 행을 읽어 뷰 대역이 그리게 한다 */
async function loadRows(store: FolderStore) {
  await act(() => store.getState().timeline.cache.ensureRange(0, 6));
  await tick();
}

const logPanel = () => document.querySelector<HTMLElement>('[data-panel="git-log"]') as HTMLElement;
const branchPanel = () =>
  document.querySelector<HTMLElement>('[data-panel="git-branches"]') as HTMLElement;
const treeRow = (id: string) =>
  within(branchPanel())
    .getAllByRole('treeitem')
    .find((el) => el.getAttribute('data-node-id') === id) as HTMLElement;
const treeSelected = () =>
  within(branchPanel())
    .getAllByRole('treeitem')
    .filter((el) => el.getAttribute('aria-selected') === 'true')
    .map((el) => el.getAttribute('data-node-id'));
const dropButton = (name: string) =>
  within(logPanel())
    .getAllByRole<HTMLButtonElement>('button')
    .find(
      (b) => b.getAttribute('aria-haspopup') === 'dialog' && b.textContent?.startsWith(name),
    ) as HTMLButtonElement;
const popover = () => screen.queryByRole('dialog');
const option = (label: string) =>
  within(popover() as HTMLElement)
    .getAllByRole('option')
    .find((o) => o.textContent?.startsWith(label)) as HTMLElement;
const closePopover = () =>
  act(() => {
    fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
  });
const textInput = () =>
  within(logPanel()).getByRole<HTMLInputElement>('textbox', { name: S.filterBar.textLabel });
async function applyText(value: string) {
  act(() => fireEvent.change(textInput(), { target: { value } }));
  act(() => {
    fireEvent.keyDown(textInput(), { key: 'Enter' });
  });
  await tick();
  await tick();
}
const view = () => h.last as GraphViewProps;

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  h.mounts = 0;
  h.last = null;
});

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() => useAppStore.setState({ sessions: {}, sessionOrder: [], activeSessionId: null }));
  for (const id of mounted) {
    disposeFolder(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('브랜치 트리 ↔ branch 드롭다운 (같은 상태: 질의의 ref 범위)', () => {
  it('트리에서 고르면 단추가 바뀌고, 드롭다운에서 고르면 트리 선택이 바뀌며, 단추의 × 로 지우면 트리 선택도 풀린다', async () => {
    const { store } = await setup();
    act(() => fireEvent.click(treeRow('ref:refs/heads/main')));
    await tick();
    expect(dropButton(S.filterBar.branch).textContent).toBe('branch: main');

    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    expect(option('main').getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.click(option('staging')));
    closePopover();
    await tick();
    const revs = store.getState().timeline.query.revs;
    expect(revs.kind).toBe('branches');
    expect(revs.kind === 'branches' ? [...revs.names].sort() : []).toEqual(['main', 'staging']);
    expect([...treeSelected()].sort()).toEqual(['ref:refs/heads/main', 'ref:refs/heads/staging']);

    act(() =>
      fireEvent.click(
        within(logPanel()).getByRole('button', {
          name: S.filterBar.clearCondition('branch: main +1'),
        }),
      ),
    );
    await tick();
    expect(store.getState().timeline.query.revs).toEqual({ kind: 'all' });
    expect(treeSelected()).toEqual([]);
  });

  it('branch 드롭다운은 트리와 같은 목록이다: HEAD·로컬·원격 묶음, 원격 숨기기면 원격이 빠진다', async () => {
    const { store } = await setup();
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    const text = (popover() as HTMLElement).textContent ?? '';
    expect(text).toContain(S.branches.head);
    expect(text).toContain(S.filterBar.local);
    expect(text).toContain(S.filterBar.remote);
    closePopover();
    await act(() =>
      store.getState().setTimelineQuery({ ...store.getState().timeline.query, hideRemotes: true }),
    );
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    expect((popover() as HTMLElement).textContent).not.toContain(S.filterBar.remote);
  });
});

describe('저장소 범위 (folderTimelineScopeSet)', () => {
  it('전체 선택은 로드·정보 갱신 후에도 유지되어 하나만 해제하고 다시 열 수 있다', async () => {
    const { store, spies } = await setup();
    const paths = (store.getState().timeline.info?.repos ?? []).map((repo) => repo.path);
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    act(() =>
      fireEvent.click(
        within(popover() as HTMLElement).getByRole('button', { name: S.selection.all }),
      ),
    );
    await tick();
    await tick();
    await act(() => store.getState().refreshTimelineInfo());
    expect(store.getState().timeline.info?.scoped).toBe(false);
    expect(store.getState().timeline.scope).toEqual(paths);
    expect(
      within(popover() as HTMLElement)
        .getAllByRole('option')
        .every((el) => el.getAttribute('aria-selected') === 'true'),
    ).toBe(true);
    closePopover();
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    expect(option('web-console').getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.click(option('web-console')));
    await tick();
    await tick();
    expect(spies.scopeSet).toHaveBeenLastCalledWith(
      expect.any(Number),
      paths.filter((path) => path !== WEB),
    );
    expect(store.getState().timeline.scope).toEqual(paths.filter((path) => path !== WEB));
    expect(option('web-console').getAttribute('aria-selected')).toBe('false');
    expect(option('api-gateway').getAttribute('aria-selected')).toBe('true');
    expect(store.getState().timeline.info?.repos.find((repo) => repo.path === WEB)?.inScope).toBe(
      false,
    );
    act(() =>
      fireEvent.click(
        within(popover() as HTMLElement).getByRole('button', { name: S.selection.none }),
      ),
    );
    await tick();
    await tick();
    await act(() => store.getState().refreshTimelineInfo());
    expect(store.getState().timeline.scope).toEqual([]);
    expect(store.getState().timeline.info?.scoped).toBe(false);
    expect(
      within(popover() as HTMLElement)
        .getAllByRole('option')
        .every((el) => el.getAttribute('aria-selected') === 'false'),
    ).toBe(true);
  });

  it('드롭다운에서 둘만 체크 → 닫기 전에 범위 적용 → inScope 갱신, 행은 그 둘만이고 색은 그대로다', async () => {
    const { store, spies } = await setup();
    const colors = Object.fromEntries(
      (store.getState().timeline.info?.repos ?? []).map((r) => [r.path, r.color]),
    );
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    act(() => fireEvent.click(option('api-gateway')));
    act(() => fireEvent.click(option('web-console')));
    expect(store.getState().timeline.scope).toEqual([API, WEB]);
    closePopover();
    await tick();
    await tick();
    expect(spies.scopeSet).toHaveBeenCalledTimes(2);
    expect(spies.scopeSet).toHaveBeenCalledWith(expect.any(Number), [API, WEB]);
    const repos = store.getState().timeline.info?.repos ?? [];
    expect(repos.filter((r) => r.inScope).map((r) => r.path)).toEqual([API, WEB]);
    expect(store.getState().timeline.info?.scoped).toBe(true);
    // 범위 밖 저장소도 번호·색을 그대로 둔다
    for (const r of repos) {
      expect(r.color).toBe(colors[r.path]);
    }
    await loadRows(store);
    const shown = store.getState().timeline.cache.slice(0, 6).rows.filter(Boolean) as GraphRow[];
    const inScope = new Set(repos.filter((r) => r.inScope).map((r) => r.index));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((r) => inScope.has(r.repo ?? -1))).toBe(true);
    expect(dropButton(S.filterBar.repo).textContent).toBe('저장소: api-gateway +1');
  });

  it('저장소 체크를 바꾼 뒤 로드가 끝나기 전에는 제외 저장소가 든 이전 그래프를 숨긴다', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store } = await setup((mock) => ({
      folderTimelineScopeSet: async (id, scope) => {
        await pending;
        return mock.folderTimelineScopeSet(id, scope);
      },
    }));
    await loadRows(store);
    expect(screen.getByTestId('graph-view')).toBeTruthy();
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    act(() => fireEvent.click(option('api-gateway')));
    expect(store.getState().timeline.scope).toEqual([API]);
    expect(screen.queryByTestId('graph-view')).toBeNull();
    expect(screen.getByRole('status', { name: S.folder.timeline.loading })).toBeTruthy();
    expect(popover()).not.toBeNull();
    await act(async () => {
      release();
      await pending;
    });
    await tick();
    await tick();
    expect(screen.getByTestId('graph-view')).toBeTruthy();
    expect(store.getState().timeline.scope).toEqual([API]);
    closePopover();
  });

  it('행 우클릭 "이 저장소만 보기" → 그 저장소 하나, 다시 우클릭하면 "모든 저장소 보기" 로 푼다', async () => {
    const { store } = await setup();
    await loadRows(store);
    const first = store.getState().timeline.cache.slice(0, 1).rows[0] as GraphRow;
    const repoPath = store.getState().timeline.info?.repos[first.repo ?? -1]?.path as string;
    fireEvent.contextMenu(screen.getAllByText(first.subject)[0] as HTMLElement);
    await tick();
    act(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: S.folder.timeline.onlyThisRepo })),
    );
    await tick();
    await tick();
    expect(store.getState().timeline.scope).toEqual([repoPath]);

    // 범위를 좁힌 뒤의 첫 행 (메뉴는 행 번호로 캐시에서 행을 찾는다 — 그 저장소의 행이다)
    await loadRows(store);
    const again = store.getState().timeline.cache.slice(0, 1).rows[0] as GraphRow;
    expect(store.getState().timeline.info?.repos[again.repo ?? -1]?.path).toBe(repoPath);
    fireEvent.contextMenu(logPanel().querySelector('[data-row="0"]') as HTMLElement);
    await tick();
    expect(screen.queryByRole('menuitem', { name: S.folder.timeline.onlyThisRepo })).toBeNull();
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: S.folder.timeline.allRepos })));
    await tick();
    expect(store.getState().timeline.scope).toEqual([]);
  });

  it('범위 항목 판정: 그 저장소 하나만 보는 중이면 풀고, 아니면 좁힌다', () => {
    expect(rowScopeAction([], API)).toEqual({
      label: S.folder.timeline.onlyThisRepo,
      scope: [API],
    });
    expect(rowScopeAction([API, WEB], API)).toEqual({
      label: S.folder.timeline.onlyThisRepo,
      scope: [API],
    });
    expect(rowScopeAction([API], API)).toEqual({ label: S.folder.timeline.allRepos, scope: [] });
  });
});

describe('작성자 후보', () => {
  it('드롭다운을 열 때 읽고(5명·커밋 수), 다시 열면 읽지 않으며, 범위가 바뀐 뒤 열면 다시 읽는다', async () => {
    const { store, spies } = await setup();
    expect(spies.authors).not.toHaveBeenCalled();
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    await tick();
    expect(spies.authors).toHaveBeenCalledTimes(1);
    expect(within(popover() as HTMLElement).getAllByRole('option')).toHaveLength(5);
    closePopover();
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    await tick();
    expect(spies.authors).toHaveBeenCalledTimes(1);
    closePopover();
    await act(() => store.getState().setTimelineScope([API]));
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    await tick();
    expect(spies.authors).toHaveBeenCalledTimes(2);
  });

  it('시간 초과면 후보와 함께 안내·다시 시도를 보인다', async () => {
    await setup((mock) => ({
      folderTimelineAuthors: async (s) => ({
        ...(await mock.folderTimelineAuthors(s)),
        timedOut: true,
      }),
    }));
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    await tick();
    expect(popover()?.textContent).toContain(S.filterBar.authorsTimedOut);
    expect(
      within(popover() as HTMLElement).getByRole('button', { name: S.filterBar.retry }),
    ).toBeTruthy();
  });

  it('두 명을 체크하면 작성자 필터가 걸리고 그래프 선 없는 목록 모드로 다시 마운트된다', async () => {
    const { store } = await setup();
    expect(h.mounts).toBe(1);
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    await tick();
    const [a, b] = within(popover() as HTMLElement).getAllByRole('option');
    act(() => fireEvent.click(a as HTMLElement));
    act(() => fireEvent.click(b as HTMLElement));
    closePopover();
    await tick();
    await tick();
    expect(filterOf(store.getState().timeline.query).authors).toHaveLength(2);
    expect(store.getState().timeline.listMode).toBe(true);
    expect(h.mounts).toBe(2);
    expect(within(logPanel()).getByText(S.filterBar.listMode)).toBeTruthy();
  });
});

describe('텍스트 필터와 상태 (LG-06·11)', () => {
  it('Enter 한 번에 질의 설정 한 번, 일치 수가 보이고 목록 모드가 된다. 지우면 원래대로', async () => {
    const { store, spies } = await setup();
    const all = store.getState().timeline.totalRows;
    await applyText('fix:');
    expect(spies.querySet).toHaveBeenCalledTimes(1);
    const n = store.getState().timeline.totalRows;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(all);
    expect(logPanel().textContent).toContain(S.folder.timeline.matched(n));
    expect(store.getState().timeline.listMode).toBe(true);
    act(() =>
      fireEvent.click(within(logPanel()).getByRole('button', { name: S.filterBar.clearText })),
    );
    await tick();
    await tick();
    expect(store.getState().timeline.totalRows).toBe(all);
    expect(logPanel().textContent).toContain(S.folder.timeline.rows(all));
    expect(store.getState().timeline.listMode).toBe(false);
  });

  it('잘못된 정규식은 입력란 옆에 사유를 보이고 이전 질의·결과를 유지한다', async () => {
    const { store } = await setup();
    await applyText('fix:');
    const rows = store.getState().timeline.totalRows;
    const query = store.getState().timeline.query;
    act(() => fireEvent.click(within(logPanel()).getByRole('button', { name: S.filterBar.regex })));
    await tick();
    await applyText('(');
    expect(within(logPanel()).getByRole('alert').textContent).toContain('정규식');
    expect(store.getState().timeline.totalRows).toBe(rows);
    expect(filterOf(store.getState().timeline.query).text.pattern).toBe('fix:');
    expect(store.getState().timeline.query).not.toBe(query);
    expect(textInput().value).toBe('(');
  });

  it('필터 결과 없음: 조건을 요약하고 "필터 지우기" 로 모두 푼다 (저장소 범위 포함)', async () => {
    const { store } = await setup();
    await act(() => store.getState().setTimelineScope([API]));
    await applyText('없는글자zz');
    expect(store.getState().timeline.totalRows).toBe(0);
    expect(logPanel().textContent).toContain(S.folder.timeline.noMatch);
    expect(logPanel().textContent).toContain(S.filterBar.textCondition('없는글자zz', false));
    expect(logPanel().textContent).toContain('저장소: api-gateway');
    act(() =>
      fireEvent.click(
        within(logPanel()).getByRole('button', { name: S.folder.timeline.clearFilters }),
      ),
    );
    await tick();
    await tick();
    expect(filterOf(store.getState().timeline.query).text.pattern).toBe('');
    expect(store.getState().timeline.scope).toEqual([]);
    expect(store.getState().timeline.totalRows).toBeGreaterThan(0);
    expect(textInput().value).toBe('');
  });

  it('첫 로드는 행 모양의 자리 표시(스켈레톤)다', async () => {
    await setup(undefined, { timelineDelayMs: 60_000 });
    const skeleton = logPanel().querySelector('[aria-busy="true"]');
    expect(skeleton?.getAttribute('aria-label')).toBe(S.folder.timeline.loading);
    expect(screen.queryByTestId('graph-view')).toBeNull();
  });

  it('커밋이 없는 폴더는 "커밋이 없습니다" (조건 없음)', async () => {
    const empty = (info: TimelineInfo): TimelineInfo => ({ ...info, rows: 0 });
    await setup((mock) => ({
      folderTimelineOpen: async (s) => empty(await mock.folderTimelineOpen(s)),
      folderTimelineInfo: async (s) => empty(await mock.folderTimelineInfo(s)),
    }));
    expect(logPanel().textContent).toContain(S.folder.timeline.empty);
    expect(
      within(logPanel()).queryByRole('button', { name: S.folder.timeline.clearFilters }),
    ).toBeNull();
  });

  it('읽기 실패는 사유와 다시 시도 (다시 시도는 코어에 다시 읽기를 요청한다)', async () => {
    const { spies } = await setup(() => ({
      folderTimelineOpen: async () => {
        throw new IpcClientError({ kind: 'internal', message: '타임라인 실패' });
      },
    }));
    const alert = within(logPanel()).getByRole('alert');
    expect(alert.textContent).toContain(S.folder.timeline.failed('타임라인 실패'));
    act(() =>
      fireEvent.click(within(alert).getByRole('button', { name: S.folder.timeline.retry })),
    );
    await tick();
    expect(spies.reload).toHaveBeenCalledTimes(1);
  });

  it('일부 저장소 실패: 로그는 보이고 실패한 저장소 이름을 알린다. 범위 밖 저장소는 실패가 아니다', async () => {
    const withError = (info: TimelineInfo): TimelineInfo => ({
      ...info,
      repos: info.repos.map((r) => (r.path === API ? { ...r, error: 'fatal: bad object' } : r)),
    });
    await setup((mock) => ({
      folderTimelineOpen: async (s) => withError(await mock.folderTimelineOpen(s)),
      folderTimelineInfo: async (s) => withError(await mock.folderTimelineInfo(s)),
    }));
    expect(screen.getByTestId('graph-view')).toBeTruthy();
    const notice = within(logPanel()).getByText(S.folder.timeline.partialFailed(1, 'api-gateway'));
    expect(notice.closest('[title]')?.getAttribute('title')).toBe('api-gateway: fatal: bad object');
    expect(
      failedTimelineRepos({
        generation: 1,
        rows: 1,
        finished: true,
        maxPerRepo: 1,
        scoped: true,
        repos: [
          {
            index: 0,
            name: 'a',
            path: '/a',
            color: 0,
            truncated: false,
            inScope: false,
            error: 'x',
          },
          {
            index: 1,
            name: 'b',
            path: '/b',
            color: 1,
            truncated: false,
            inScope: true,
            error: 'y',
          },
        ],
      }),
    ).toEqual([{ name: 'b', error: 'y' }]);
  });

  it('날짜만 걸면 그래프 선이 남는다 (목록 모드가 아니라 뷰를 다시 마운트하지 않는다)', async () => {
    const { store } = await setup();
    act(() => fireEvent.click(dropButton(S.filterBar.date)));
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.dates.last30 })));
    await tick();
    await tick();
    expect(filterOf(store.getState().timeline.query).since).not.toBeNull();
    expect(store.getState().timeline.listMode).toBe(false);
    expect(h.mounts).toBe(1);
    expect(within(logPanel()).queryByText(S.filterBar.listMode)).toBeNull();
  });
});

describe('보기 옵션 (LG-08)', () => {
  it('타임라인이 지키는 것만 싣는다: 원격 숨기기·첫 부모만·머지 제외·긴 엣지 접기 (정렬 없음)', async () => {
    const { spies, store } = await setup();
    act(() => {
      fireEvent.keyDown(within(logPanel()).getByRole('button', { name: S.filterBar.viewOptions }), {
        key: 'Enter',
      });
    });
    await tick();
    const items = screen
      .getAllByRole('menuitemcheckbox')
      .map((m) => m.textContent?.replace('✓', ''));
    expect(items).toEqual([
      S.folder.timeline.hideRemotes,
      S.graph.options.firstParent,
      S.graph.options.noMerges,
      S.graph.options.collapseLongEdges,
    ]);
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    // 켜진 항목은 이름 앞에 체크 표시(✓)가 붙는다
    const item = (label: string) =>
      screen.getByRole('menuitemcheckbox', { name: new RegExp(`${label}$`) });
    expect(item(S.graph.options.collapseLongEdges).getAttribute('aria-checked')).toBe('true');
    act(() => fireEvent.click(item(S.graph.options.firstParent)));
    expect(store.getState().timeline.query.firstParent).toBe(true);
    act(() => fireEvent.click(item(S.graph.options.collapseLongEdges)));
    expect(spies.prefs).toHaveBeenCalledWith(expect.any(Number), {
      pinHead: true,
      refColors: true,
      collapseLongEdges: false,
    });
  });
});

describe('상태 글자 (행 수·잘림)', () => {
  const base: TimelineInfo = {
    generation: 1,
    rows: 10,
    finished: true,
    maxPerRepo: 10000,
    scoped: false,
    repos: [
      { index: 0, name: 'api', path: '/a', color: 0, truncated: true, inScope: true },
      { index: 1, name: 'web', path: '/w', color: 1, truncated: false, inScope: true },
    ],
  };

  it('필터가 없으면 커밋 수와 "저장소당 최근 N개만", 있으면 일치 수와 "걸러진 결과가 상한을 넘었다"', () => {
    expect(timelineStatus({ loading: false, totalRows: 10, filtered: false, info: base })).toEqual({
      text: `${S.folder.timeline.rows(10)} · ${S.folder.timeline.truncated(10000)}`,
      title: S.folder.timeline.truncatedRepos('api'),
    });
    expect(timelineStatus({ loading: false, totalRows: 4, filtered: true, info: base }).text).toBe(
      `${S.folder.timeline.matched(4)} · ${S.folder.timeline.truncatedFiltered(10000)}`,
    );
    const none = { ...base, repos: base.repos.map((r) => ({ ...r, truncated: false })) };
    expect(timelineStatus({ loading: false, totalRows: 4, filtered: true, info: none })).toEqual({
      text: S.folder.timeline.matched(4),
    });
    expect(timelineStatus({ loading: true, totalRows: 4, filtered: true, info: base }).text).toBe(
      S.folder.timeline.loading,
    );
  });

  it('필터 바가 화면에 보이는 잘림 글자 (필터가 걸린 경우)', async () => {
    const truncated = (info: TimelineInfo): TimelineInfo => ({
      ...info,
      repos: info.repos.map((r, i) => (i === 0 ? { ...r, truncated: true } : r)),
    });
    const { store } = await setup((mock) => ({
      folderTimelineInfo: async (s) => truncated(await mock.folderTimelineInfo(s)),
    }));
    await applyText('fix:');
    expect(logPanel().textContent).toContain(
      S.folder.timeline.truncatedFiltered(store.getState().timeline.info?.maxPerRepo ?? 0),
    );
  });
});

describe('질의 변경 뒤 보던 위치 (LG-10)', () => {
  it('목록 모드로 바뀌면 보던 커밋을 새 결과에서 찾아 그 기준으로 다시 마운트한다', async () => {
    const { store } = await setup();
    await loadRows(store);
    const target = store
      .getState()
      .timeline.cache.slice(0, 6)
      .rows.find((r) => r?.subject.startsWith('fix:'));
    expect(target).toBeDefined();
    const row = target as GraphRow;
    act(() =>
      view().onAnchorChange?.({ oid: row.oid, repo: row.repo ?? null, row: row.row, offset: 3 }),
    );
    await applyText('fix:');
    expect(h.mounts).toBe(2);
    const anchor = view().initialAnchor;
    expect(anchor?.oid).toBe(row.oid);
    expect(anchor?.offset).toBe(3);
    // 새 결과의 행 번호로 고쳐졌다
    expect(anchor?.row).toBe(await store.getState().resolveTimelineRow(row.oid, row.repo ?? null));
  });

  it('보던 커밋이 결과에 없으면 맨 위로 간다', async () => {
    const { store } = await setup();
    await loadRows(store);
    const top = store.getState().timeline.cache.slice(0, 1).rows[0] as GraphRow;
    act(() => view().onAnchorChange?.({ oid: top.oid, repo: top.repo ?? null, row: 0, offset: 0 }));
    // 날짜만 바꿔 같은 뷰가 남는 경우: 맨 앞 커밋이 빠지는 범위
    await act(() =>
      store.getState().setTimelineQuery({
        ...store.getState().timeline.query,
        filter: { ...filterOf(store.getState().timeline.query), until: top.commitTime - 1 },
      }),
    );
    await tick();
    await tick();
    expect(store.getState().timeline.scrollReset).toBe(1);
    expect(view().scrollToRow).toBe(0);
  });
});

describe('FolderLogFilter 는 폴더 탭이 아니면 그리지 않는다', () => {
  it('활성 탭이 없으면 null', () => {
    const { container } = render(<FolderLogFilter branchNodes={[]} branchRepos={[]} />);
    expect(container.textContent).toBe('');
  });
});
