import { GraphRangeCache, MockGraphSource } from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawList } from '../draw-list';
import { GraphView } from '../GraphView';
import { rowCenterY } from '../geometry';
import { paint } from '../paint';

// 캔버스에 무엇을 그렸는지만 본다: paint 가 받은 DrawList(두 번째 인자)를 기록한다
vi.mock('../paint', () => ({ paint: vi.fn() }));

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

describe('레인 캔버스 스크롤 동기화', () => {
  const ROW_H = 24;
  // jsdom 은 2D 컨텍스트가 없어(null) 그리기 전에 빠진다. 빈 컨텍스트를 돌려 paint 까지 가게 한다
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.mocked(paint).mockClear();
    HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof originalGetContext;
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  /** 마지막으로 그린 목록에서 행 0 노드의 y (뷰포트 기준 px) */
  const lastRow0Y = () =>
    (vi.mocked(paint).mock.lastCall?.[1] as DrawList | undefined)?.nodes[0]?.y;

  /** 스크롤 상자의 위치를 바꾸고 scroll 이벤트를 보낸다 (jsdom 은 레이아웃이 없어 scrollTop 을 흉내 낸다) */
  const scrollTo = (el: HTMLElement, top: number) =>
    act(() => {
      Object.defineProperty(el, 'scrollTop', { configurable: true, value: top });
      el.dispatchEvent(new Event('scroll'));
    });

  it('행 범위가 그대로인 스크롤에도 캔버스를 새 위치로 다시 그린다', async () => {
    const { cache } = setup(10_000);
    const { container } = render(
      <GraphView
        cache={cache}
        totalRows={10_000}
        rowHeight={ROW_H}
        initialRect={{ width: 800, height: 480 }}
      />,
    );
    await flush();
    await flush();
    const scroller = container.querySelector<HTMLElement>('[data-testid="graph-scroller"]');
    if (!scroller) {
      throw new Error('스크롤 상자가 없다');
    }
    expect(lastRow0Y()).toBe(rowCenterY(0, { scrollTop: 0, rowHeight: ROW_H }));

    // 스크롤 시작: isScrolling 이 false→true 로 바뀌어 다시 렌더된다
    scrollTo(scroller, 5);
    expect(lastRow0Y()).toBe(rowCenterY(0, { scrollTop: 5, rowHeight: ROW_H }));

    // 이어지는 스크롤: isScrolling·보이는 행 범위가 그대로라 React 는 다시 렌더하지 않는다.
    // 탄성 튕김이 0 으로 돌아오는 마지막 구간이 이 경우다 — 그래도 캔버스는 따라와야 한다
    scrollTo(scroller, 10);
    expect(lastRow0Y()).toBe(rowCenterY(0, { scrollTop: 10, rowHeight: ROW_H }));
  });
});
