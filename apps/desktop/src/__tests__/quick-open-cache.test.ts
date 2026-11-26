import type { WorkspaceFileList } from '@mgit/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileListCache, filesStamp } from '../features/search/file-list';

const stores = vi.hoisted(() => ({
  folder: undefined as unknown,
  repo: undefined as unknown,
}));
vi.mock('../store', () => ({
  getFolderStore: () => stores.folder,
  getSessionStore: () => stores.repo,
}));

/** 파일 목록 응답 */
function list(files: string[], cancelled = false): WorkspaceFileList {
  return { files, repos: [''], skipped: 0, truncated: false, cancelled };
}

beforeEach(() => {
  stores.folder = undefined;
  stores.repo = undefined;
});

describe('빠른 열기 파일 목록 캐시', () => {
  it('표지가 같으면 한 번만 받고, 받는 중인 요청도 함께 쓴다', async () => {
    const cache = new FileListCache();
    const fetch = vi.fn(async () => list(['a.ts']));
    const [first, second] = await Promise.all([
      cache.load(1, ['repo', 0], fetch),
      cache.load(1, ['repo', 0], fetch),
    ]);
    expect(first).toBe(second);
    expect(await cache.load(1, ['repo', 0], fetch)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.peek(1)?.files).toEqual(['a.ts']);
    expect(cache.isLoading(1)).toBe(false);
  });

  it('표지가 바뀌면 다시 받고, 그동안 낡은 목록을 보여 줄 수 있다', async () => {
    const cache = new FileListCache();
    const status = {};
    await cache.load(1, ['repo', 0, status], async () => list(['old.ts']));
    let resolve!: (value: WorkspaceFileList) => void;
    const loading = cache.load(1, ['repo', 0, {}], () => new Promise((done) => (resolve = done)));
    expect(cache.isLoading(1)).toBe(true);
    expect(cache.peek(1)?.files).toEqual(['old.ts']);
    resolve(list(['new.ts']));
    await loading;
    expect(cache.peek(1)?.files).toEqual(['new.ts']);
  });

  it('늦게 끝난 옛 요청은 새 목록을 덮지 않는다', async () => {
    const cache = new FileListCache();
    let finishOld!: (value: WorkspaceFileList) => void;
    const old = cache.load(1, ['repo', 0], () => new Promise((done) => (finishOld = done)));
    await cache.load(1, ['repo', 1], async () => list(['new.ts']));
    finishOld(list(['old.ts']));
    expect((await old).files).toEqual(['old.ts']);
    expect(cache.peek(1)?.files).toEqual(['new.ts']);
  });

  it('취소돼 일부만 받았거나 실패했거나 무효로 한 목록은 다음에 다시 받는다', async () => {
    const cache = new FileListCache();
    const fetch = vi.fn(async () => list(['part.ts'], true));
    await cache.load(1, ['repo', 0], fetch);
    await cache.load(1, ['repo', 0], fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async (): Promise<WorkspaceFileList> => {
      throw new Error('boom');
    });
    await expect(cache.load(2, ['repo', 0], failing)).rejects.toThrow('boom');
    await expect(cache.load(2, ['repo', 0], failing)).rejects.toThrow('boom');
    expect(failing).toHaveBeenCalledTimes(2);
    const fine = vi.fn(async () => list(['a.ts']));
    await cache.load(3, ['repo', 0], fine);
    cache.invalidate(3);
    expect(cache.peek(3)?.files).toEqual(['a.ts']);
    await cache.load(3, ['repo', 0], fine);
    expect(fine).toHaveBeenCalledTimes(2);
  });

  it('닫힌 세션의 목록은 버린다', async () => {
    const cache = new FileListCache();
    await cache.load(1, [], async () => list(['a.ts']));
    await cache.load(2, [], async () => list(['b.ts']));
    cache.retain((session) => session === 2);
    expect(cache.peek(1)).toBeNull();
    expect(cache.peek(2)?.files).toEqual(['b.ts']);
  });

  it('표지는 폴더 탭이면 파일 트리 epoch·저장소 목록·요약, 저장소 탭이면 epoch·작업 트리 상태다', () => {
    const repos = [{ path: '/w/a' }];
    const summaries = [{ path: '/w/a' }];
    let epoch = 3;
    stores.folder = {
      getState: () => ({ repos, summaries, fileTree: { getState: () => ({ epoch }) } }),
    };
    const folderStamp = filesStamp(1);
    expect(folderStamp).toEqual(['folder', 3, repos, summaries]);
    epoch = 4;
    expect(filesStamp(1)).not.toEqual(folderStamp);
    stores.folder = undefined;
    const status = { entries: [] };
    stores.repo = { getState: () => ({ status, fileTree: { getState: () => ({ epoch: 0 }) } }) };
    expect(filesStamp(2)).toEqual(['repo', 0, status]);
    stores.repo = undefined;
    expect(filesStamp(3)).toEqual([]);
  });
});
