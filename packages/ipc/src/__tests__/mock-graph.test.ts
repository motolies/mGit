import { describe, expect, it } from 'vitest';
import { buildMockGraph } from '../mock/mock-graph-source';

describe('buildMockGraph', () => {
  it('결정적이다', () => {
    const a = buildMockGraph({ rows: 500, seed: 7 });
    const b = buildMockGraph({ rows: 500, seed: 7 });
    expect(a.rows.map((r) => r.oid)).toEqual(b.rows.map((r) => r.oid));
    expect(a.edges).toEqual(b.edges);
  });

  it('모든 행의 레인은 그 행을 덮는 구간이 있고 엣지는 인접 행을 잇는다', () => {
    const g = buildMockGraph({ rows: 2000 });
    const covers = (lane: number, row: number) =>
      g.segments.some((s) => s.lane === lane && s.start <= row && row <= s.end);
    for (const row of g.rows) {
      expect(covers(row.lane, row.row)).toBe(true);
    }
    for (const e of g.edges) {
      expect(covers(e.topLane, e.topRow)).toBe(true);
      expect(covers(e.bottomLane, e.topRow + 1)).toBe(true);
    }
    expect(g.laneCount).toBeGreaterThan(1);
    expect(g.rows[0]?.refs.some((r) => r.shortName === 'main')).toBe(true);
  });

  it('부모 oid 는 모두 더 아래 행을 가리킨다', () => {
    const g = buildMockGraph({ rows: 800 });
    const rowOf = new Map(g.rows.map((r) => [r.oid, r.row]));
    for (const r of g.rows) {
      for (const p of r.parents) {
        const pr = rowOf.get(p);
        expect(pr).toBeDefined();
        expect(pr ?? -1).toBeGreaterThan(r.row);
      }
    }
  });
});
