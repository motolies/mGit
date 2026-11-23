import { GraphRangeCache, MockGraphSource } from '@mgit/ipc';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphView } from '../GraphView';
import { useNow } from '../use-now';

const T0 = new Date(2026, 10, 18, 14, 50).getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useNow (LG-04: 상대 날짜가 낡지 않게)', () => {
  it('주기가 될 때마다 현재 시각을 새로 준다', () => {
    const { result } = renderHook(() => useNow(60_000));
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(T0 + 60_000);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current).toBe(T0 + 180_000);
  });

  it('타이머는 하나뿐이고 내려가면 지운다', () => {
    const { unmount } = renderHook(() => useNow(60_000));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('그래프 뷰의 날짜 칸 (LG-04)', () => {
  it('떠 있는 동안 "방금 전"이 "1분 전"으로 넘어간다', async () => {
    const source = new MockGraphSource({ rows: 50, latencyMs: 0 });
    const cache = new GraphRangeCache(source);
    cache.setTotalRows(50, true);
    // 맨 위 커밋이 30초 전에 만들어진 시점에서 본다
    const newest = (source.graph.rows[0]?.authorTime ?? 0) * 1000;
    vi.setSystemTime(newest + 30_000);
    const { container } = render(
      <GraphView cache={cache} totalRows={50} initialRect={{ width: 800, height: 240 }} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    /** 행의 날짜 칸 (뒤에서 둘째 칸) 의 글자 */
    const dateOf = (row: number) => {
      const cells = container.querySelector(`[data-row="${row}"]`)?.children;
      return cells?.[cells.length - 2]?.textContent;
    };
    expect(dateOf(0)).toBe('방금 전');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(dateOf(0)).toBe('1분 전');
  });
});
