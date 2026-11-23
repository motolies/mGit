import { createNullClient, type IpcClient, type TimelineInfo } from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { filterBranchTree, leafNodes } from '../features/branches/branch-tree-model';
import { buildFolderBranchTree } from '../features/branches/folder-branch-tree';
import { createFolderStore, DEFAULT_TIMELINE_QUERY } from '../store/folder-store';

/** 타임라인 정보 샘플 */
function info(finished: boolean, rows = 0): TimelineInfo {
  return {
    generation: 1,
    rows,
    finished,
    maxPerRepo: 10000,
    repos: [
      {
        index: 0,
        name: 'a',
        path: '/f/a',
        color: 0,
        headBranch: 'main',
        truncated: false,
        inScope: true,
      },
      {
        index: 1,
        name: 'b',
        path: '/f/b',
        color: 1,
        headBranch: 'main',
        truncated: false,
        inScope: true,
      },
    ],
    scoped: false,
  };
}

/** 타임라인 IPC 를 기록하는 클라이언트 */
function client(opened: TimelineInfo = info(false)): IpcClient {
  return {
    ...createNullClient(),
    folderSummaries: vi.fn(async () => []),
    folderTimelineOpen: vi.fn(async () => opened),
    folderTimelineInfo: vi.fn(async () => info(true, 5)),
    folderTimelineReload: vi.fn(async () => {}),
    folderTimelineQuerySet: vi.fn(async () => {}),
  };
}

/** 마이크로태스크 비우기 */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('통합 타임라인 스토어 (G2)', () => {
  it('처음 열면 코어에 열기를 요청하고, 로드 완료 이벤트로 행 수·세대·정보를 받는다', async () => {
    const c = client();
    const store = createFolderStore({ session: 7, path: '/f', repos: [] }, c);
    await tick();
    expect(store.getState().timeline.opened).toBe(false);
    await store.getState().openTimeline();
    expect(c.folderTimelineOpen).toHaveBeenCalledWith(7);
    expect(store.getState().timeline.opened).toBe(true);
    expect(store.getState().timeline.loadState).toBe('loading');
    // 두 번째 열기는 무시
    await store.getState().openTimeline();
    expect(c.folderTimelineOpen).toHaveBeenCalledTimes(1);

    store.getState().applyEvent({
      type: 'graphLoadFinished',
      session: 7,
      generation: 1,
      rows: 5,
      laneCount: 2,
      elapsedMs: 10,
      commitGraphSuggested: false,
    });
    await tick();
    const t = store.getState().timeline;
    expect(t.loadState).toBe('complete');
    expect(t.totalRows).toBe(5);
    expect(t.generation).toBe(1);
    expect(t.cache.slice(0, 1).totalRows).toBe(5);
    expect(c.folderTimelineInfo).toHaveBeenCalledWith(7);
    expect(t.info?.repos.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('이미 끝난 타임라인을 열면 정보만으로 바로 완료 상태가 된다', async () => {
    const c = client(info(true, 3));
    const store = createFolderStore({ session: 7, path: '/f', repos: [] }, c);
    await store.getState().openTimeline();
    expect(store.getState().timeline.loadState).toBe('complete');
    expect(store.getState().timeline.totalRows).toBe(3);
  });

  it('ref 변경 이벤트는 타임라인을 열어 둔 때만 묶어서 다시 읽고, 질의 변경은 IPC 로 보낸다', async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const store = createFolderStore({ session: 7, path: '/f', repos: [] }, c);
      store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: true });
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.folderTimelineReload).not.toHaveBeenCalled();

      await store.getState().openTimeline();
      store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: false });
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.folderTimelineReload).not.toHaveBeenCalled();
      store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: true });
      store.getState().applyEvent({ type: 'folderChanged', session: 7, refs: true });
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.folderTimelineReload).toHaveBeenCalledTimes(1);

      const q = { ...DEFAULT_TIMELINE_QUERY, revs: { kind: 'solo' as const, name: 'main' } };
      await store.getState().setTimelineQuery(q);
      expect(c.folderTimelineQuerySet).toHaveBeenCalledWith(7, q);
      expect(store.getState().timeline.query).toEqual(q);
      expect(store.getState().timeline.selected).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('브랜치 검색은 이름 부분 일치(대소문자 무시)', () => {
    // 옛 평면 브랜치 목록의 이름 필터를 대신하는 브랜치 트리의 검색 (W5)
    const here = (path: string) => ({
      path,
      color: 0,
      current: false,
      upstream: null,
      ahead: null,
      behind: null,
      gone: false,
    });
    const nodes = buildFolderBranchTree({
      branches: [
        { name: 'main', remote: false, remoteName: null, repos: [here('/f/a'), here('/f/b')] },
        { name: 'feature/x', remote: false, remoteName: null, repos: [here('/f/a')] },
        { name: 'origin/main', remote: true, remoteName: 'origin', repos: [here('/f/a')] },
      ],
      repos: [],
      isFavorite: () => false,
      hideRemotes: false,
    });
    /** 검색어에 남는 브랜치 이름 (HEAD 행은 브랜치가 아니다) */
    const found = (text: string) =>
      leafNodes(filterBranchTree(nodes, text))
        .filter((n) => n.kind !== 'head')
        .map((n) => n.label);
    expect(found('')).toHaveLength(3);
    expect(found('FEAT')).toEqual(['feature/x']);
    expect(found('main')).toEqual(['main', 'origin/main']);
  });
});
