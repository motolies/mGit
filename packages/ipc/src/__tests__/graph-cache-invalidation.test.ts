import { describe, expect, it, vi } from 'vitest';
import { GraphRangeCache } from '../graph-cache';
import type { GraphWindow } from '../types';

/** 요청 범위만큼 빈 행을 돌려주는 출처 */
function source(total: number) {
  return {
    fetchWindow: async (start: number, count: number): Promise<GraphWindow> => ({
      generation: 1,
      start,
      totalRows: total,
      finished: true,
      laneCount: 1,
      rows: Array.from({ length: Math.min(count, total - start) }, (_, i) => ({
        row: start + i,
        oid: `${start + i}`.padStart(40, '0'),
        parents: [],
        authorName: '',
        authorEmail: '',
        authorTime: 0,
        commitTime: 0,
        subject: '',
        lane: 0,
        color: 0,
        refs: [],
        isHead: false,
        inHead: true,
        repo: null,
      })),
      segments: [],
      edges: [],
      stubs: [],
    }),
  };
}

describe('GraphRangeCache invalidation listeners', () => {
  it('invalidateAll 직전에 리스너가 옛 데이터를 읽을 수 있다', async () => {
    const cache = new GraphRangeCache(source(10), { chunkSize: 5 });
    cache.setTotalRows(10, true);
    await cache.ensureRange(0, 10);
    const seen: string[] = [];
    const unsubscribe = cache.subscribeInvalidation(() => {
      seen.push(cache.slice(3, 4).rows[0]?.oid ?? 'none');
    });
    cache.invalidateAll();
    expect(seen).toEqual(['3'.padStart(40, '0')]);
    unsubscribe();
    cache.invalidateAll();
    expect(seen).toHaveLength(1);
  });

  it('범위가 바뀌면 이전 행을 버리고 새 청크가 올 때까지 노출하지 않는다', async () => {
    const cache = new GraphRangeCache(source(10), { chunkSize: 5 });
    cache.setTotalRows(10, true);
    await cache.ensureRange(0, 10);
    const listener = vi.fn(() => cache.slice(0, 1).rows[0]?.oid);
    cache.subscribeInvalidation(listener);
    cache.invalidateAll({ discardRows: true });
    expect(listener.mock.results[0]?.value).toBe('0'.repeat(40));
    expect(cache.slice(0, 5).rows.every((row) => row === undefined)).toBe(true);
    await cache.ensureRange(0, 5);
    expect(cache.slice(0, 5).rows.every(Boolean)).toBe(true);
  });

  it('dispose 뒤에는 리스너가 불리지 않는다', () => {
    const cache = new GraphRangeCache(source(1));
    const listener = vi.fn();
    cache.subscribeInvalidation(listener);
    cache.dispose();
    cache.invalidateAll();
    expect(listener).not.toHaveBeenCalled();
  });
});
