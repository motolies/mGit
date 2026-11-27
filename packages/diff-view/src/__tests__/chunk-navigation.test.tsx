// 반응성 J: 다음/이전 변경은 `@@` 구간 머리 줄이 아니라 변경 덩어리(문맥이 아닌 행이 이어진 묶음) 단위로 옮겨 간다. 사용자의
// 그림처럼 한 구간 안에 덩어리가 둘이면 ① → ② 순으로 멈추고, 덩어리 첫 행 위에 문맥 3줄을 남긴다
import { S } from '@mgit/ui';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type DiffNavigation, DiffView, nearestChunk } from '../DiffView';
import { diffOf, flush, hunk, installLayoutStub, scroller, twoChunks } from './diff-layout-stub';

installLayoutStub();

/** 덩어리 첫 행 (`twoChunks` 의 설명과 같다) */
const STARTS = {
  'unified:full': [78, 84],
  'unified:context': [4, 10],
  'split:full': [78, 83],
  'split:context': [4, 9],
} as const;

/** 두 덩어리 문서를 열고 탐색 손잡이를 받는다 */
async function open(mode: 'unified' | 'split', fullFile: boolean, wrap = false) {
  const ready = vi.fn((_el: HTMLElement, _nav: DiffNavigation) => () => {});
  const { diff, document } = twoChunks();
  render(
    <DiffView
      diff={diff}
      document={document}
      path="a.txt"
      mode={mode}
      fullFile={fullFile}
      wrap={wrap}
      initialHeight={600}
      onNavigationReady={ready}
    />,
  );
  await flush();
  const nav = () => ready.mock.lastCall?.[1];
  const move = async (direction: 1 | -1) => {
    let moved: boolean | undefined;
    act(() => {
      moved = nav()?.moveHunk(direction);
    });
    await flush();
    return moved;
  };
  return { grid: scroller(), nav, move };
}

describe('다음/이전 변경은 변경 덩어리 단위 (J)', () => {
  it.each([
    ['unified', true],
    ['unified', false],
    ['split', true],
    ['split', false],
  ] as const)(
    '%s · 전체 파일 %s: 한 구간 안의 덩어리 ①·② 에 차례로 멈추고 "n / 전체" 도 덩어리 수다',
    async (mode, fullFile) => {
      const { nav, move } = await open(mode, fullFile);
      expect(nav()?.total).toBe(2);
      // 처음 열면 ① (머리 줄 `@@` 가 아니다)
      expect(nav()?.current).toBe(1);
      expect(nav()?.canMove(-1)).toBe(false);
      expect(await move(1)).toBe(true);
      expect(nav()?.current).toBe(2);
      expect(await move(1)).toBe(false);
      expect(await move(-1)).toBe(true);
      expect(nav()?.current).toBe(1);
      expect(await move(-1)).toBe(false);
    },
  );

  it.each([
    ['unified', 'unified:full'],
    ['split', 'split:full'],
  ] as const)(
    '%s 전체 파일: 덩어리 첫 행 위에 문맥 3줄을 남기고 스크롤만 한다',
    async (mode, key) => {
      const { grid, move } = await open(mode, true);
      const [first, second] = STARTS[key];
      expect(grid.scrollTop).toBe((first - 3) * 20);
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((list) => records.push(...list));
      observer.observe(grid, { attributes: true, subtree: true, attributeFilter: ['data-cursor'] });
      await move(1);
      observer.disconnect();
      expect(grid.scrollTop).toBe((second - 3) * 20);
      expect(records).toEqual([]);
    },
  );

  it('줄바꿈을 켜도 같은 덩어리에 멈춘다', async () => {
    const { grid, nav, move } = await open('unified', true, true);
    expect(grid.scrollTop).toBe((78 - 3) * 20);
    await move(1);
    expect(grid.scrollTop).toBe((84 - 3) * 20);
    expect(nav()?.current).toBe(2);
  });

  it('오른쪽 변경 위치 띠도 덩어리마다 단추 하나이고 누르면 그 덩어리로 간다', async () => {
    const { grid, nav } = await open('split', true);
    const overview = screen.getByRole('navigation', { name: S.diff.changeOverview });
    const buttons = within(overview).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]?.getAttribute('title')).toBe(S.diff.changePosition(2, 2));
    fireEvent.click(buttons[1] as Element);
    await flush();
    expect(grid.scrollTop).toBe((83 - 3) * 20);
    expect(nav()?.current).toBe(2);
  });

  it('보기 모드를 바꾸면 같은 차례의 덩어리로 돌아간다', async () => {
    const ready = vi.fn((_el: HTMLElement, _nav: DiffNavigation) => () => {});
    const { diff, document } = twoChunks();
    const view = (mode: 'unified' | 'split') => (
      <DiffView
        diff={diff}
        document={document}
        path="a.txt"
        mode={mode}
        initialHeight={600}
        onNavigationReady={ready}
      />
    );
    const { rerender } = render(view('unified'));
    await flush();
    act(() => {
      ready.mock.lastCall?.[1].moveHunk(1);
    });
    await flush();
    rerender(view('split'));
    await flush();
    expect(scroller().scrollTop).toBe((83 - 3) * 20);
    expect(ready.mock.lastCall?.[1].current).toBe(2);
  });
});

describe('변경 위치 띠는 누른 높이에 가장 가까운 덩어리로 간다 (L-1)', () => {
  it('가운데가 가장 가까운 표시를 고르고, 같으면 앞 덩어리다', () => {
    // 300행 문서의 10·12·14행 (띠 100px → 표시 가운데 5.83·6.5·7.17px — 표시 높이 5px 보다 촘촘하다)
    expect(nearestChunk([10, 12, 14], 300, 100, 5.8)).toBe(10);
    expect(nearestChunk([10, 12, 14], 300, 100, 6.5)).toBe(12);
    expect(nearestChunk([10, 12, 14], 300, 100, 7.2)).toBe(14);
    expect(nearestChunk([10, 12, 14], 300, 100, 0)).toBe(10);
    expect(nearestChunk([10, 12, 14], 300, 100, 100)).toBe(14);
    expect(nearestChunk([0, 30], 300, 100, (0 + 10) / 2 + 2.5)).toBe(0);
    expect(nearestChunk([], 300, 100, 50)).toBeUndefined();
  });

  /** 띠를 `height` px 로 보이게 하고 그 높이를 누른다 (jsdom 은 배치가 없다) */
  function stripOf(height: number) {
    const nav = screen.getByRole('navigation', { name: S.diff.changeOverview });
    nav.getBoundingClientRect = () =>
      ({ top: 100, bottom: 100 + height, height, left: 0, right: 12, width: 12 }) as DOMRect;
    return {
      nav,
      press: async (y: number) => {
        fireEvent.click(nav, { clientY: 100 + y, detail: 1 });
        await flush();
      },
    };
  }

  it('촘촘해 표시가 겹쳐도 각 덩어리 표시의 가운데를 누르면 그 덩어리로 간다', async () => {
    // 구간 40개 (머리·문맥·삭제·추가 4행씩, 덩어리 첫 행 2·6·10…, 160행) → 띠 100px 에서 표시 간격 2.5px
    const ready = vi.fn((_el: HTMLElement, _nav: DiffNavigation) => () => {});
    const hunks = Array.from({ length: 40 }, (_, i) => hunk(1 + i * 10, 1));
    render(
      <DiffView
        diff={diffOf(...hunks)}
        path="a.txt"
        mode="unified"
        fullFile={false}
        initialHeight={600}
        onNavigationReady={ready}
      />,
    );
    await flush();
    const { press } = stripOf(100);
    for (const ordinal of [2, 3, 20, 40, 1]) {
      const row = 2 + (ordinal - 1) * 4;
      await press((row / 160) * 100 + 2.5);
      expect(ready.mock.lastCall?.[1].current).toBe(ordinal);
    }
  });

  it('성긴 문서는 전과 같고, 표시 사이 빈 곳은 가까운 쪽, 키보드로 누른 단추는 그 단추의 덩어리로 간다', async () => {
    const { nav, move } = await open('unified', false);
    // 변경 주변 29행, 덩어리 4·10 → 띠 100px 에서 가운데 16.3·37px
    const { press } = stripOf(100);
    await press(37);
    expect(nav()?.current).toBe(2);
    await press(16);
    expect(nav()?.current).toBe(1);
    await press(25);
    expect(nav()?.current).toBe(1);
    await press(32);
    expect(nav()?.current).toBe(2);
    // 키보드(Enter·Space 의 click 은 detail 0)는 누른 높이와 상관없이 그 단추의 덩어리
    const buttons = within(
      screen.getByRole('navigation', { name: S.diff.changeOverview }),
    ).getAllByRole('button');
    fireEvent.click(buttons[0] as Element, { detail: 0, clientY: 137 });
    await flush();
    expect(nav()?.current).toBe(1);
    expect(await move(1)).toBe(true);
    expect(nav()?.current).toBe(2);
  });
});
