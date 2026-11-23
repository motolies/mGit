import { GraphRangeCache, MockGraphSource } from '@mgit/ipc';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphView } from '../GraphView';

/** 지연 없는 목 출처와 캐시 */
function setup(rows: number) {
  const source = new MockGraphSource({ rows, latencyMs: 0 });
  const cache = new GraphRangeCache(source);
  cache.setTotalRows(rows, true);
  return { source, cache };
}

/** 다음 매크로태스크까지 기다린다 (fetchWindow 의 Promise 해소) */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('GraphView', () => {
  it('보이는 행 + overscan 만 DOM 에 둔다', async () => {
    const { cache } = setup(10_000);
    const { container } = render(
      <GraphView
        cache={cache}
        totalRows={10_000}
        rowHeight={24}
        initialRect={{ width: 800, height: 480 }}
      />,
    );
    await flush();
    await flush();
    const rows = container.querySelectorAll('[data-row]');
    // 480/24 = 20 행 + overscan 8 (맨 위라 아래쪽만)
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeLessThanOrEqual(40);
  });

  it('데이터가 도착하면 스켈레톤 대신 메시지·해시를 그린다', async () => {
    const { cache, source } = setup(50);
    const { container } = render(
      <GraphView cache={cache} totalRows={50} initialRect={{ width: 800, height: 240 }} />,
    );
    await flush();
    await flush();
    const firstRow = container.querySelector('[data-row="0"]');
    expect(firstRow?.getAttribute('aria-busy')).toBeNull();
    expect(firstRow?.textContent).toContain(source.graph.rows[0]?.subject ?? '');
    expect(firstRow?.textContent).toContain('HEAD');
    expect(firstRow?.textContent).toContain('main');
  });

  it('행이 0개면 DOM 행도 없다', async () => {
    const { cache } = setup(0);
    const { container } = render(
      <GraphView cache={cache} totalRows={0} initialRect={{ width: 800, height: 240 }} />,
    );
    await flush();
    expect(container.querySelectorAll('[data-row]')).toHaveLength(0);
  });
});
