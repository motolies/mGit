import type { GraphScrollAnchor, GraphViewProps } from '@mgit/graph-view';
import {
  createNullClient,
  type GraphRow,
  type IpcClient,
  type SessionEvent,
  type TimelineInfo,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomDock } from '../layout/BottomDock';
import { useAppStore } from '../store';
import { DEFAULT_DOCK, type SessionMeta } from '../store/app-store';
import { createFolderStore, type FolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  getFolderStore,
  registerFolder,
} from '../store/session-registry';
import { tick } from './dialog-stub';

// 그래프 뷰는 jsdom 에서 스크롤하지 못한다. 여기서 볼 것은 로그 탭이 뷰에 무엇을 넘기고 뷰가 언제
// 다시 마운트되는지이므로, 받은 props 와 마운트 횟수만 기록하는 대역을 쓴다 (뷰 자체는 graph-view 가 테스트한다)
const h = vi.hoisted(() => ({
  /** 마운트될 때마다 그때의 props */
  mounts: [] as unknown[],
  unmounts: 0,
  /** 가장 최근 렌더의 props */
  last: null as unknown,
}));

vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (props: GraphViewProps) => {
    h.last = props;
    // biome-ignore lint/correctness/useExhaustiveDependencies: 마운트할 때의 props 를 한 번만 기록한다
    useEffect(() => {
      h.mounts.push(props);
      return () => {
        h.unmounts += 1;
      };
    }, []);
    // 우클릭 메뉴가 행을 찾을 수 있게 캐시에 읽어 둔 앞쪽 행을 실제 행과 같은 속성으로 그린다
    const rows = props.cache.slice(0, Math.min(props.totalRows, 4)).rows;
    return (
      <div data-testid="graph-view">
        {rows.map((r) =>
          r ? (
            <div key={r.row} data-oid={r.oid} data-row={r.row}>
              {r.subject}
            </div>
          ) : null,
        )}
      </div>
    );
  },
}));

vi.mock('@mgit/terminal', () => ({
  TerminalView: () => <div data-testid="term" />,
}));

const FOLDER_ID = 21;
const OTHER_ID = 22;
const ROWS = 500;

/** 타임라인 정보 */
function info(generation: number): TimelineInfo {
  return {
    generation,
    rows: ROWS,
    finished: true,
    maxPerRepo: 10000,
    repos: [
      {
        index: 0,
        name: 'api',
        path: '/f/api',
        color: 0,
        headBranch: 'main',
        truncated: false,
        inScope: true,
      },
      {
        index: 1,
        name: 'web',
        path: '/f/web',
        color: 1,
        headBranch: 'main',
        truncated: false,
        inScope: true,
      },
    ],
    scoped: false,
  };
}

/** 타임라인이 이미 다 읽힌 폴더의 가짜 클라이언트. 행 찾기 호출을 기록한다 */
function folderClient(findRow: IpcClient['folderTimelineFindRow']) {
  const folderTimelineFindRow = vi.fn(findRow);
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => [],
    folderTimelineOpen: async () => info(1),
    folderTimelineInfo: async () => info(1),
    folderTimelineFindRow,
  };
  return { client, folderTimelineFindRow };
}

/** 폴더 탭 하나를 등록한다 */
function registerFolderTab(id: number, client: IpcClient): FolderStore {
  const store = createFolderStore({ session: id, path: `/f${id}`, repos: [] }, client);
  registerFolder(id, store);
  return store;
}

/** 폴더 탭들을 열고 하나를 활성으로 둔다. 도구 창은 Git 의 로그 탭 */
function openTabs(ids: number[], active: number): void {
  const metas: SessionMeta[] = ids.map((id) => ({
    id,
    kind: 'folder',
    path: `/f${id}`,
    name: `f${id}`,
    parent: null,
  }));
  act(() => {
    useAppStore.setState({
      sessions: Object.fromEntries(metas.map((m) => [m.id, m])),
      sessionOrder: ids,
      activeSessionId: active,
      dock: DEFAULT_DOCK,
    });
  });
}

/** 그래프 뷰가 지금 받은 props */
const view = () => h.last as GraphViewProps;
/** n 번째 마운트 때 받은 props */
const mounted = (n: number) => h.mounts[n] as GraphViewProps;

const ANCHOR: GraphScrollAnchor = { oid: 'c'.repeat(40), repo: 1, row: 240, offset: 6 };

/** 아래 도구 창을 그리고 타임라인이 열릴 때까지 기다린다 */
async function renderDock(): Promise<void> {
  render(
    <BottomDock>
      <div>본문</div>
    </BottomDock>,
  );
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  h.mounts = [];
  h.unmounts = 0;
  h.last = null;
});

afterEach(() => {
  cleanup();
  act(() => {
    useAppStore.setState({ sessions: {}, sessionOrder: [], activeSessionId: null });
  });
  for (const id of [FOLDER_ID, OTHER_ID]) {
    disposeFolder(id);
  }
  clearSessionRegistry();
});

describe('폴더 스토어: 타임라인 행 찾기와 스크롤 기준 (LG-10)', () => {
  it('행 찾기는 저장소 번호와 커밋으로 코어에 묻는다', async () => {
    const { client, folderTimelineFindRow } = folderClient(async () => 37);
    const store = createFolderStore({ session: FOLDER_ID, path: '/f', repos: [] }, client);
    expect(await store.getState().resolveTimelineRow('abc', 2)).toBe(37);
    expect(folderTimelineFindRow).toHaveBeenCalledWith(FOLDER_ID, 2, 'abc');
  });

  it('저장소 번호가 없는 행은 찾을 수 없으므로 묻지 않는다', async () => {
    const { client, folderTimelineFindRow } = folderClient(async () => 37);
    const store = createFolderStore({ session: FOLDER_ID, path: '/f', repos: [] }, client);
    expect(await store.getState().resolveTimelineRow('abc', null)).toBeNull();
    expect(folderTimelineFindRow).not.toHaveBeenCalled();
  });

  it('행 찾기가 실패하면 null 이다 (스크롤을 그대로 둔다)', async () => {
    const { client } = folderClient(async () => {
      throw new Error('세션 없음');
    });
    const store = createFolderStore({ session: FOLDER_ID, path: '/f', repos: [] }, client);
    expect(await store.getState().resolveTimelineRow('abc', 0)).toBeNull();
  });

  it('스크롤 기준은 기억만 하고 구독자를 깨우지 않는다', () => {
    const { client } = folderClient(async () => null);
    const store = createFolderStore({ session: FOLDER_ID, path: '/f', repos: [] }, client);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getState().timelineAnchor()).toBeNull();
    store.getState().rememberTimelineAnchor(ANCHOR);
    expect(store.getState().timelineAnchor()).toEqual(ANCHOR);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('로그 탭의 스크롤 위치 유지 (LG-10)', () => {
  it('그래프 뷰에 폴더용 행 찾기를 넘긴다', async () => {
    const { client, folderTimelineFindRow } = folderClient(async () => 37);
    registerFolderTab(FOLDER_ID, client);
    openTabs([FOLDER_ID], FOLDER_ID);
    await renderDock();

    expect(h.mounts).toHaveLength(1);
    expect(await view().resolveRow?.('abc', 1)).toBe(37);
    expect(folderTimelineFindRow).toHaveBeenCalledWith(FOLDER_ID, 1, 'abc');
  });

  it('타임라인이 다시 읽혀도(세대 변경) 그래프 뷰를 내리지 않는다', async () => {
    const { client } = folderClient(async () => 37);
    const store = registerFolderTab(FOLDER_ID, client);
    openTabs([FOLDER_ID], FOLDER_ID);
    await renderDock();
    expect(store.getState().timeline.generation).toBe(1);

    const reloaded: SessionEvent = {
      type: 'graphReloaded',
      session: FOLDER_ID,
      generation: 2,
      rows: ROWS - 40,
      laneCount: 2,
    };
    act(() => store.getState().applyEvent(reloaded));
    await tick();
    expect(store.getState().timeline.generation).toBe(2);
    expect(view().totalRows).toBe(ROWS - 40);
    // 같은 뷰가 남아 있어야 뷰가 보던 커밋을 새 데이터에서 다시 찾을 수 있다
    expect(h.mounts).toHaveLength(1);
    expect(h.unmounts).toBe(0);
  });

  it('콘솔 탭에 갔다 오면 보던 기준에서 다시 시작한다', async () => {
    const { client } = folderClient(async () => 240);
    registerFolderTab(FOLDER_ID, client);
    openTabs([FOLDER_ID], FOLDER_ID);
    await renderDock();
    // 처음에는 기억한 기준이 없다 (맨 위에서 시작)
    expect(mounted(0).initialAnchor).toBeNull();

    // 뷰가 스크롤하며 알린 기준
    act(() => view().onAnchorChange?.(ANCHOR));
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    expect(h.unmounts).toBe(1);

    act(() => useAppStore.getState().setGitDockTab('log'));
    await tick();
    expect(h.mounts).toHaveLength(2);
    expect(mounted(1).initialAnchor).toEqual(ANCHOR);
    // 그 사이 다시 읽혔을 수 있으므로 행 찾기도 함께 넘어간다
    expect(mounted(1).resolveRow).toBeTypeOf('function');
  });

  it('도구 창을 숨겼다 다시 열어도 보던 기준에서 다시 시작한다', async () => {
    const { client } = folderClient(async () => 240);
    registerFolderTab(FOLDER_ID, client);
    openTabs([FOLDER_ID], FOLDER_ID);
    await renderDock();
    act(() => view().onAnchorChange?.(ANCHOR));

    act(() => useAppStore.getState().hideDock());
    await tick();
    expect(h.unmounts).toBe(1);

    act(() => useAppStore.getState().toggleDock('git', 'log'));
    await tick();
    expect(h.mounts).toHaveLength(2);
    expect(mounted(1).initialAnchor).toEqual(ANCHOR);
  });

  it('기준은 폴더마다 따로 기억한다: 다른 폴더 탭에 갔다 와도 섞이지 않는다', async () => {
    registerFolderTab(FOLDER_ID, folderClient(async () => 240).client);
    registerFolderTab(OTHER_ID, folderClient(async () => 0).client);
    openTabs([FOLDER_ID, OTHER_ID], FOLDER_ID);
    await renderDock();
    act(() => view().onAnchorChange?.(ANCHOR));

    act(() => useAppStore.setState({ activeSessionId: OTHER_ID }));
    await tick();
    // 다른 폴더의 로그는 그 폴더의 기준(아직 없음)에서 시작한다
    expect(mounted(h.mounts.length - 1).initialAnchor).toBeNull();
    expect(getFolderStore(OTHER_ID)?.getState().timelineAnchor()).toBeNull();

    act(() => useAppStore.setState({ activeSessionId: FOLDER_ID }));
    await tick();
    expect(mounted(h.mounts.length - 1).initialAnchor).toEqual(ANCHOR);
  });
});

describe('로그 탭의 행 선택: 저장소 경로 식별자 (W7)', () => {
  it('행 선택은 저장소 경로로 남아, 재스캔으로 번호가 밀려도 같은 커밋 행이 선택으로 보인다 (W7)', async () => {
    let current = info(1);
    const client: IpcClient = {
      ...createNullClient(),
      folderSummaries: async () => [],
      folderTimelineOpen: async () => current,
      folderTimelineInfo: async () => current,
    };
    const store = registerFolderTab(FOLDER_ID, client);
    openTabs([FOLDER_ID], FOLDER_ID);
    await renderDock();
    const oid = 'd'.repeat(40);
    const row = (repo: number) => ({ oid, repo }) as unknown as GraphRow;

    act(() => view().onSelectRow?.(row(1)));
    expect(store.getState().timeline.selected).toEqual({ repoPath: '/f/web', oid });
    expect(view().isRowSelected?.(row(1))).toBe(true);
    expect(view().isRowSelected?.(row(0))).toBe(false);

    // 재스캔: 경로순으로 web 앞에 저장소가 끼어 web 의 번호가 1 → 2 로 밀린다
    current = {
      ...info(2),
      repos: [
        {
          index: 0,
          name: 'api',
          path: '/f/api',
          color: 0,
          headBranch: 'main',
          truncated: false,
          inScope: true,
        },
        {
          index: 1,
          name: 'auth',
          path: '/f/auth',
          color: 1,
          headBranch: 'main',
          truncated: false,
          inScope: true,
        },
        {
          index: 2,
          name: 'web',
          path: '/f/web',
          color: 2,
          headBranch: 'main',
          truncated: false,
          inScope: true,
        },
      ],
    };
    act(() =>
      store.getState().applyEvent({ type: 'folderRescanned', session: FOLDER_ID, repos: [] }),
    );
    act(() =>
      store.getState().applyEvent({
        type: 'graphReloaded',
        session: FOLDER_ID,
        generation: 2,
        rows: ROWS,
        laneCount: 3,
      }),
    );
    await tick();
    expect(store.getState().timeline.info?.repos).toHaveLength(3);
    expect(store.getState().timeline.selected).toEqual({ repoPath: '/f/web', oid });
    expect(view().isRowSelected?.(row(2))).toBe(true);
    expect(view().isRowSelected?.(row(1))).toBe(false);
  });

  it('선택한 행을 다시 눌러도 저장소 탭을 열지 않고, 행 우클릭의 "저장소 탭으로 열기" 가 연다 (W8, LG-09)', async () => {
    const original = useAppStore.getState().openRepositoryAt;
    const openRepositoryAt = vi.fn(async () => null);
    act(() => useAppStore.setState({ openRepositoryAt }));
    try {
      const oid = 'e'.repeat(40);
      const web = {
        row: 0,
        oid,
        parents: [],
        authorName: 'a',
        authorEmail: 'a@x',
        authorTime: 0,
        commitTime: 0,
        subject: 'web 의 커밋',
        lane: 0,
        color: 1,
        refs: [],
        isHead: false,
        inHead: true,
        repo: 1,
      } satisfies GraphRow;
      const { client } = folderClient(async () => null);
      const store = registerFolderTab(FOLDER_ID, {
        ...client,
        folderTimelineWindow: async (_session, start) => ({
          generation: 1,
          start,
          totalRows: ROWS,
          finished: true,
          laneCount: 2,
          rows: start === 0 ? [web] : [],
          segments: [],
          edges: [],
          stubs: [],
        }),
      });
      openTabs([FOLDER_ID], FOLDER_ID);
      await renderDock();
      await act(() => store.getState().timeline.cache.ensureRange(0, 1));

      // 다시 눌러도 오른쪽 상세만 바뀔 뿐 저장소 탭으로 가지 않는다
      act(() => view().onSelectRow?.(web));
      act(() => view().onSelectRow?.(web));
      await tick();
      expect(openRepositoryAt).not.toHaveBeenCalled();

      // 우클릭 메뉴: 해시 복사, 제목 복사, 저장소 탭으로 열기, 이 저장소만 보기 (W17, LG-09)
      fireEvent.contextMenu(screen.getByText('web 의 커밋'));
      await tick();
      expect(
        screen.getAllByRole('menuitem').map((m) => {
          const label = m.cloneNode(true) as HTMLElement;
          label.querySelector('kbd')?.remove();
          return label.textContent;
        }),
      ).toEqual([
        S.comparison.withLocal,
        S.menu.copyHash,
        S.menu.copySubject,
        S.menu.reword,
        S.folder.timeline.openInRepo,
        S.folder.timeline.onlyThisRepo,
      ]);
      fireEvent.click(screen.getByRole('menuitem', { name: S.folder.timeline.openInRepo }));
      await tick();
      expect(openRepositoryAt).toHaveBeenCalledWith('/f/web', FOLDER_ID);
    } finally {
      act(() => useAppStore.setState({ openRepositoryAt: original }));
    }
  });
});
