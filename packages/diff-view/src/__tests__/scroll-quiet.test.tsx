// 반응성 H·J: diff 본문을 스크롤하는 동안 DOM 을 건드리지 않는다. 사용자 환경(WKWebView·큰 창)에서는 화면을 한 번 다시 그리는
// 값이 약 0.1초라, 스크롤마다 커서 줄 표시(`data-cursor`)가 옮겨 가면 스크롤이 매 프레임 버벅였다 (J 부터 커서 줄이 없다).
// - 스크롤해도 가상 창이 바뀔 때는 새 줄만 붙고 기존 줄의 속성은 그대로다
// - 스크롤한 뒤 다음/이전 변경은 그때 보이는 곳에서 이어 간다 (옮겨 간 덩어리가 보이면 그 덩어리, 아니면 보이는 맨 위 줄)
// - 도구 모음의 "n / 전체" 는 덩어리 경계를 넘을 때만 바뀐다
import { act, fireEvent, render } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type DiffNavigation, DiffView } from '../DiffView';
import { big, flush, installLayoutStub, scroller } from './diff-layout-stub';

installLayoutStub();

/** 본문을 `top` 으로 스크롤한다 */
async function scrollTo(grid: HTMLElement, top: number) {
  act(() => {
    grid.scrollTop = top;
    fireEvent.scroll(grid);
  });
  await flush();
}

describe('스크롤은 DOM 을 바꾸지 않는다 (H)', () => {
  it('스크롤해도 가상 창이 바뀔 때 기존 행의 속성은 그대로이고 커서 줄 표시는 없다', async () => {
    render(
      <DiffView diff={big()} path="a.txt" mode="unified" fullFile={false} initialHeight={600} />,
    );
    await flush();
    const grid = scroller();
    // 첫 덩어리(101행)로 옮겨 가 있다 — 본문을 맨 위로 돌려 행 0 부터 스크롤한다
    await scrollTo(grid, 0);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(grid, { attributes: true, childList: true, subtree: true });
    // 한 번에 1.5줄씩 일곱 번 (행 0 은 overscan 안에 남는다)
    for (let step = 1; step <= 7; step += 1) await scrollTo(grid, step * 30);
    observer.disconnect();
    console.info(
      'H row-crossing scroll',
      JSON.stringify({
        attributes: records.filter((r) => r.type === 'attributes').length,
        childList: records.filter((r) => r.type === 'childList').length,
      }),
    );
    expect(grid.querySelector('[data-cursor]')).toBeNull();
    const changed = records
      .filter((r) => r.type === 'attributes')
      .map(
        (r) => `${(r.target as Element).getAttribute('data-index') ?? 'grid'}:${r.attributeName}`,
      );
    expect(changed).toEqual([]);
    // 새 줄은 붙는다 (가상 창의 아래쪽)
    expect(records.some((r) => r.type === 'childList' && r.addedNodes.length > 0)).toBe(true);
  });

  it('가상 창이 그대로인 작은 스크롤은 DOM 을 바꾸지 않는다', async () => {
    let commits = 0;
    render(
      <Profiler id="diff" onRender={() => (commits += 1)}>
        <DiffView diff={big()} path="a.txt" mode="unified" fullFile={false} initialHeight={600} />
      </Profiler>,
    );
    await flush();
    const grid = scroller();
    await scrollTo(grid, 3);
    // 스크롤 중 표시(라이브러리의 isScrolling)가 꺼질 때까지 기다린다
    await act(() => new Promise<void>((r) => setTimeout(r, 250)));
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(grid, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    commits = 0;
    for (const top of [6, 9, 12, 15]) await scrollTo(grid, top);
    await act(() => new Promise<void>((r) => setTimeout(r, 250)));
    observer.disconnect();
    console.info('H small scroll', JSON.stringify({ commits, mutations: records.length }));
    expect(records).toEqual([]);
    // 남는 커밋은 가상 스크롤 라이브러리가 스크롤 시작·끝(isScrolling)을 알릴 때뿐이다 — 행은 다시 그리지 않는다
    expect(commits).toBeLessThanOrEqual(2);
  });
});

describe('스크롤한 뒤 다음/이전 변경은 보이는 곳에서 이어 간다 (J)', () => {
  /** big() 을 열고 탐색 손잡이를 받는다 (덩어리 첫 행 101·204·307, 문서 309행 = 6,180px, 최대 스크롤 5,580) */
  async function open() {
    const ready = vi.fn((_el: HTMLElement, _nav: DiffNavigation) => () => {});
    render(
      <DiffView
        diff={big()}
        path="a.txt"
        mode="unified"
        fullFile={false}
        initialHeight={600}
        onNavigationReady={ready}
      />,
    );
    await flush();
    const grid = scroller();
    const nav = () => ready.mock.lastCall?.[1];
    const move = async (direction: 1 | -1) => {
      let moved: boolean | undefined;
      act(() => {
        moved = nav()?.moveHunk(direction);
      });
      await flush();
      return moved;
    };
    return { grid, nav, move, ready };
  }

  it('연달아 누르면 덩어리를 하나씩 넘어가며 같은 덩어리에 머물지 않고, 위에 문맥 3줄을 남긴다', async () => {
    const { grid, nav, move } = await open();
    // 처음 열면 첫 덩어리(101행) 위 3줄(98행)이 맨 위
    expect(grid.scrollTop).toBe(98 * 20);
    expect(nav()?.current).toBe(1);
    expect(await move(1)).toBe(true);
    expect(grid.scrollTop).toBe(201 * 20);
    expect(nav()?.current).toBe(2);
    expect(await move(1)).toBe(true);
    // 304행은 최대 스크롤(5,580 = 279행)보다 아래라 끝까지만 — 307행은 화면 안
    expect(grid.scrollTop).toBe(5580);
    expect(nav()?.current).toBe(3);
    expect(await move(1)).toBe(false);
    expect(nav()?.current).toBe(3);
    expect(await move(-1)).toBe(true);
    expect(grid.scrollTop).toBe(201 * 20);
    expect(await move(-1)).toBe(true);
    expect(grid.scrollTop).toBe(98 * 20);
    expect(nav()?.current).toBe(1);
    expect(await move(-1)).toBe(false);
  });

  it('옮겨 간 덩어리가 화면 밖이면 다음은 보이는 첫 덩어리(맨 위 줄 포함), 이전은 맨 위 줄 위의 마지막 덩어리', async () => {
    const { grid, nav, move } = await open();
    // 첫 덩어리(101행)를 지나 150행이 맨 위: 다음 → 204행
    await scrollTo(grid, 150 * 20);
    expect(nav()?.canMove(-1)).toBe(true);
    await move(1);
    expect(grid.scrollTop).toBe(201 * 20);
    expect(nav()?.current).toBe(2);
    // 맨 위 줄이 덩어리 시작(204행)이고 옮겨 간 곳(204행)도 보인다 — 다음은 307행 (멈추지 않는다)
    await scrollTo(grid, 204 * 20);
    await move(1);
    expect(nav()?.current).toBe(3);
    // 옮겨 간 곳(307행)이 화면 밖으로 올라가게 250행을 맨 위로: 이전 → 맨 위 줄 위의 204행
    await scrollTo(grid, 250 * 20);
    await move(-1);
    expect(grid.scrollTop).toBe(201 * 20);
    expect(nav()?.current).toBe(2);
    // 옮겨 간 곳(204행)이 화면 밖이고 맨 위 줄이 덩어리 시작(101행)이면: 다음은 그 덩어리 자신, 그다음은 204행
    await scrollTo(grid, 101 * 20);
    expect(nav()?.current).toBe(1);
    await move(1);
    expect(grid.scrollTop).toBe(98 * 20);
    expect(nav()?.current).toBe(1);
    await move(1);
    expect(grid.scrollTop).toBe(201 * 20);
    expect(nav()?.current).toBe(2);
  });

  it('도구 모음의 "n / 전체" 는 스크롤로 덩어리 경계를 넘을 때만 한 번 바뀐다', async () => {
    const { grid, nav, ready } = await open();
    const before = ready.mock.calls.length;
    expect(nav()?.current).toBe(1);
    expect(nav()?.total).toBe(3);
    // 5줄씩 250행까지: 두 번째 덩어리(204행)를 한 번 넘는다
    for (let row = 100; row <= 250; row += 5) await scrollTo(grid, row * 20);
    expect(ready.mock.calls.length).toBe(before + 1);
    expect(nav()?.current).toBe(2);
    // 같은 덩어리 안의 스크롤은 다시 등록하지 않는다
    await scrollTo(grid, 260 * 20);
    expect(ready.mock.calls.length).toBe(before + 1);
  });

  it('키 입력은 본문 DOM 을 바꾸지 않고 기본 동작(스크롤)을 막지 않는다', async () => {
    const { grid } = await open();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(grid, { attributes: true, childList: true, subtree: true });
    for (const key of [
      'ArrowDown',
      'ArrowUp',
      'PageDown',
      'Home',
      'End',
      ' ',
      'Enter',
      'ArrowLeft',
    ])
      expect(fireEvent.keyDown(grid, { key })).toBe(true);
    await flush();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
