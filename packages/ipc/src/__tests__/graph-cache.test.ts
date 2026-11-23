import { describe, expect, it, vi } from 'vitest';
import { GraphRangeCache } from '../graph-cache';
import type { GraphSource } from '../graph-source';
import { MockGraphSource } from '../mock/mock-graph-source';
import type { GraphWindow } from '../types';

/** 지연을 수동으로 풀 수 있는 가짜 출처 */
function deferredSource(total: number, finished = true) {
  const pending: { start: number; count: number; resolve: (w: GraphWindow) => void }[] = [];
  const fetchWindow = vi.fn(
    (start: number, count: number) =>
      new Promise<GraphWindow>((resolve) => {
        pending.push({ start, count, resolve });
      }),
  );
  const resolveAll = (rowsPerWindow?: number) => {
    for (const p of pending.splice(0)) {
      const n = Math.min(rowsPerWindow ?? p.count, Math.max(0, total - p.start));
      p.resolve({
        generation: 1,
        start: p.start,
        totalRows: total,
        finished,
        laneCount: 1,
        rows: Array.from({ length: n }, (_, i) => ({
          row: p.start + i,
          oid: String(p.start + i).padStart(40, '0'),
          parents: [],
          authorName: '',
          authorEmail: '',
          authorTime: 0,
          commitTime: 0,
          subject: `r${p.start + i}`,
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
      });
    }
  };
  const source: GraphSource = { fetchWindow };
  return { source, fetchWindow, resolveAll, pending };
}

describe('GraphRangeCache', () => {
  it('요청을 청크 경계로 정렬하고 겹치는 범위는 한 번만 요청한다', async () => {
    const { source, fetchWindow, resolveAll } = deferredSource(2000);
    const cache = new GraphRangeCache(source, { chunkSize: 500 });
    cache.setTotalRows(2000, true);

    const a = cache.ensureRange(10, 600);
    const b = cache.ensureRange(300, 900);
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    expect(fetchWindow).toHaveBeenNthCalledWith(1, 0, 500);
    expect(fetchWindow).toHaveBeenNthCalledWith(2, 500, 500);
    resolveAll();
    await Promise.all([a, b]);

    const s = cache.slice(495, 505);
    expect(s.rows.map((r) => r?.row)).toEqual([495, 496, 497, 498, 499, 500, 501, 502, 503, 504]);
    // 이미 있는 청크는 다시 요청하지 않는다
    await cache.ensureRange(0, 1000);
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it('총 행 수가 늘면 끝이 잘린 청크를 다시 요청한다', async () => {
    // 출처는 최종 800행이지만 첫 응답은 300행까지만 받은 상태를 흉내 낸다
    const { source, fetchWindow, resolveAll } = deferredSource(800, false);
    const cache = new GraphRangeCache(source, { chunkSize: 500 });
    cache.setTotalRows(300, false);

    const p = cache.ensureRange(0, 100);
    resolveAll(300);
    await p;
    expect(cache.slice(0, 300).rows.filter(Boolean)).toHaveLength(300);

    cache.setTotalRows(800, false);
    const p2 = cache.ensureRange(0, 100);
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    resolveAll(500);
    await p2;
    expect(cache.slice(0, 500).rows.filter(Boolean)).toHaveLength(500);
  });

  it('invalidateAll 뒤에 도착한 구세대 응답은 버리고 현재 세대로 다시 요청한다', async () => {
    const { source, fetchWindow, resolveAll, pending } = deferredSource(1000);
    const cache = new GraphRangeCache(source);
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.setTotalRows(1000, true);

    // 첫 요청이 나간 뒤 로드 완료(invalidateAll)가 끼어든 상황
    const p = cache.ensureRange(0, 10);
    cache.invalidateAll();
    resolveAll();
    await p;
    expect(cache.slice(0, 10).rows.filter(Boolean)).toHaveLength(0);

    // 리렌더(ensureRange) 없이도 재요청이 자동으로 나가 있어야 한다
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(1);
    resolveAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.slice(0, 10).rows.filter(Boolean)).toHaveLength(10);
    // 재요청 결과가 들어오면 구독자에게 알린다
    expect(listener).toHaveBeenCalled();
  });

  it('구세대 청크는 교체될 때까지 보여 주되 다시 요청한다', async () => {
    const { source, fetchWindow, resolveAll } = deferredSource(1000);
    const cache = new GraphRangeCache(source);
    cache.setTotalRows(1000, true);
    const p = cache.ensureRange(0, 10);
    resolveAll();
    await p;
    cache.invalidateAll();
    expect(cache.slice(0, 10).rows.filter(Boolean)).toHaveLength(10);
    const p2 = cache.ensureRange(0, 10);
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    resolveAll();
    await p2;
  });

  it('LRU 로 오래된 청크를 버린다', async () => {
    const { source, resolveAll } = deferredSource(5000);
    const cache = new GraphRangeCache(source, { chunkSize: 500, maxChunks: 2 });
    cache.setTotalRows(5000, true);
    const p = cache.ensureRange(0, 1500); // 청크 0,1,2
    resolveAll();
    await p;
    expect(cache.slice(0, 1).rows[0]).toBeUndefined(); // 청크 0 은 가장 먼저 들어와 쫓겨남
    expect(cache.slice(1000, 1001).rows[0]?.row).toBe(1000);
  });

  it('구독자는 데이터·행 수 변경마다 알림을 받고 버전이 오른다', async () => {
    const { source, resolveAll } = deferredSource(100);
    const cache = new GraphRangeCache(source);
    const listener = vi.fn();
    cache.subscribe(listener);
    const v0 = cache.getVersion();
    cache.setTotalRows(100, true);
    expect(listener).toHaveBeenCalledTimes(1);
    const p = cache.ensureRange(0, 10);
    resolveAll();
    await p;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(cache.getVersion()).toBeGreaterThan(v0);
  });

  it('목 출처와 함께 구간·엣지를 범위에 맞게 돌려준다', async () => {
    const source = new MockGraphSource({ rows: 3000, latencyMs: 0 });
    const cache = new GraphRangeCache(source);
    cache.setTotalRows(3000, true);
    await cache.ensureRange(1200, 1300);
    const s = cache.slice(1200, 1300);
    expect(s.rows.filter(Boolean)).toHaveLength(100);
    // 메인 레인 구간은 항상 포함된다
    expect(s.segments.some((seg) => seg.lane === 0)).toBe(true);
    for (const seg of s.segments) {
      expect(seg.toRow).toBeGreaterThanOrEqual(1200);
      expect(seg.fromRow).toBeLessThan(1300);
    }
    for (const e of s.edges) {
      expect(e.topRow).toBeGreaterThanOrEqual(1199);
      expect(e.topRow).toBeLessThan(1300);
    }
  });
});
