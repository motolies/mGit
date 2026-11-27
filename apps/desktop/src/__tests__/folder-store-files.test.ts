import {
  createNullClient,
  type FsDirListing,
  type FsEntry,
  type IpcClient,
  type RepoSummary,
} from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_REFRESH_GAP_MS } from '../store/focus-refresh';
import { createFolderStore } from '../store/folder-store';

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file'): FsEntry {
  return { name, kind, size: 1, mtimeMs: 0, openable: kind === 'file' };
}

/** 디렉터리 배치 (상대 경로 → 항목) */
const LAYOUT: Record<string, FsEntry[]> = {
  '': [entry('api', 'dir'), entry('web', 'dir'), entry('README.md')],
  api: [entry('src', 'dir')],
  'api/src': [entry('Main.java')],
  web: [entry('index.ts')],
};

/** 파일 API 와 요약을 세는 가짜 클라이언트 */
function client() {
  const fsListDir = vi.fn(
    async (_session: number, dir: string): Promise<FsDirListing> => ({
      kind: 'listed',
      entries: LAYOUT[dir] ?? [],
      total: LAYOUT[dir]?.length ?? 0,
      truncated: false,
      nonUtf8Names: 0,
    }),
  );
  const folderSummaries = vi.fn(async (): Promise<RepoSummary[]> => []);
  const c: IpcClient = {
    ...createNullClient(),
    fsListDir,
    folderSummaries,
    folderRescan: vi.fn(async () => []),
    folderBatch: vi.fn(async () => ({ results: [] }) as never),
    folderSettings: vi.fn(async () => ({
      exclude: [],
      pullMode: 'ffOnly' as const,
      concurrency: 4,
      autoRefreshSecs: 30,
      worktreeRoot: null,
    })),
  };
  return { c, fsListDir, folderSummaries };
}

/** 폴더 스토어를 열고 트리를 루트·api 까지 펼친 상태로 준다 (web 은 읽었다 접은 상태) */
async function setup() {
  vi.useFakeTimers();
  const { c, fsListDir, folderSummaries } = client();
  const store = createFolderStore({ session: 9, path: '/w', repos: [] }, c);
  const tree = store.getState().fileTree;
  tree.getState().open();
  await vi.advanceTimersByTimeAsync(0);
  tree.getState().setExpanded('api', true);
  tree.getState().setExpanded('web', true);
  await vi.advanceTimersByTimeAsync(0);
  tree.getState().setExpanded('web', false);
  fsListDir.mockClear();
  folderSummaries.mockClear();
  return { store, tree, fsListDir, folderSummaries };
}

/** 나열한 디렉터리들 (정렬) */
const listed = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((call) => call[1]).sort();

afterEach(() => {
  vi.useRealTimers();
});

describe('폴더 스토어의 파일 트리 다시 읽기 (PT-08)', () => {
  it('창 포커스는 요약을 한 번, 파일 트리는 보이는 펼친 디렉터리만 다시 읽는다', async () => {
    const { store, tree, fsListDir, folderSummaries } = await setup();
    const stop = store.getState().startAutoRefresh();
    // 열 때 막 읽었으므로 포커스 갱신 간격(G4)이 지난 뒤의 포커스다
    await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_GAP_MS);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(folderSummaries).toHaveBeenCalledTimes(1);
    // 접어 둔 web 은 다시 읽지 않는다
    expect(listed(fsListDir)).toEqual(['', 'api']);
    expect(tree.getState().epoch).toBe(1);

    // 주기 재조회는 요약만 읽는다 (파일 트리는 감시하지 않는다)
    fsListDir.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(folderSummaries).toHaveBeenCalledTimes(2);
    expect(fsListDir).not.toHaveBeenCalled();

    // 끄면 포커스에도 다시 읽지 않는다
    stop();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fsListDir).not.toHaveBeenCalled();
    store.getState().dispose();
  });

  it('재스캔 이벤트·다시 스캔·일괄 작업 뒤에 다시 읽는다', async () => {
    const { store, fsListDir } = await setup();
    store.getState().applyEvent({ type: 'folderRescanned', session: 9, repos: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(listed(fsListDir)).toEqual(['', 'api']);

    fsListDir.mockClear();
    await store.getState().rescan();
    await vi.advanceTimersByTimeAsync(0);
    expect(listed(fsListDir)).toEqual(['', 'api']);

    fsListDir.mockClear();
    await store.getState().runBatch({ kind: 'fetch' } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(listed(fsListDir)).toEqual(['', 'api']);
    store.getState().dispose();
  });

  it('폴더를 닫으면 파일 트리의 늦은 응답을 버린다', async () => {
    const { store, tree, fsListDir } = await setup();
    let release: (listing: FsDirListing) => void = () => {};
    fsListDir.mockImplementationOnce(
      () => new Promise<FsDirListing>((resolve) => (release = resolve)),
    );
    tree.getState().retry('web');
    store.getState().dispose();
    release({
      kind: 'listed',
      entries: [entry('late.ts')],
      total: 1,
      truncated: false,
      nonUtf8Names: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    const load = tree.getState().dirs.web?.load;
    expect(load?.state === 'listed' && load.entries.map((e) => e.name)).toEqual(['index.ts']);
  });
});
