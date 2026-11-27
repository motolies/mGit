// 반응성 H: 줄바꿈이 꺼져 있으면 diff 코드 줄은 높이를 재지 않는다 — 행마다 ResizeObserver 를 달고 붙을 때마다 크기를 읽던
// 비용을 없앤다. 높이는 CSS 의 `--diff-line-height` 와 같고, hunk 머리 줄과 "줄 끝 개행 없음" 줄만 잰다. 글자 크기·보기 모드를
// 바꾸면 잰 행을 곧바로 다시 잰다
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffView } from '../DiffView';
import diffCss from '../DiffView.module.css?raw';
import { diffOf, flush, hunk, installLayoutStub, scroller, settle, size } from './diff-layout-stub';

installLayoutStub();

/**
 * 관찰을 기록하는 ResizeObserver (가상 스크롤이 `measureElement` 로 붙인 행을 센다). 브라우저처럼 관찰을 시작하면 다음 차례에
 * 한 번 알린다 — 가상 스크롤은 그때 행의 높이(`offsetHeight`)를 읽는다
 */
function recordObserved() {
  const observed = new Set<Element>();
  class Recording {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      observed.add(target);
      setTimeout(() => {
        if (observed.has(target))
          this.callback(
            [{ target } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }, 0);
    }
    unobserve(target: Element) {
      observed.delete(target);
    }
    disconnect() {}
  }
  globalThis.ResizeObserver = Recording as unknown as typeof ResizeObserver;
  return () =>
    [...observed]
      .map((el) => el.getAttribute('data-index'))
      .filter((index): index is string => index !== null)
      .map(Number)
      .sort((a, b) => a - b);
}

/** 행의 세로 위치 (translateY) */
const startOf = (grid: HTMLElement, index: number) => {
  const row = grid.querySelector<HTMLElement>(`[data-index="${index}"]`);
  const match = /translateY\(([-\d.]+)px\)/.exec(row?.style.transform ?? '');
  return match ? Number(match[1]) : Number.NaN;
};

describe('줄 높이 (H)', () => {
  // 행 0 = 구간 머리, 1~5 = 문맥, 6 = 삭제, 7 = 추가(줄 끝 개행 없음 표시)
  const small = () => diffOf(hunk(1, 5, true));

  it('줄바꿈이 꺼져 있으면 코드 줄은 재지 않고(관찰 0) 구간 머리 줄과 "개행 없음" 줄만 잰다', async () => {
    const observedRows = recordObserved();
    render(
      <DiffView diff={small()} path="a.txt" mode="unified" fullFile={false} initialHeight={600} />,
    );
    await flush();
    expect(observedRows()).toEqual([0, 7]);
  });

  it('줄바꿈이 켜져 있으면 지금처럼 모든 행을 잰다', async () => {
    const observedRows = recordObserved();
    render(
      <DiffView
        diff={small()}
        path="a.txt"
        mode="unified"
        fullFile={false}
        initialHeight={600}
        wrap
      />,
    );
    await flush();
    expect(observedRows()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('코드 줄의 높이는 글자 크기의 --diff-line-height 와 같고, 글자 크기를 바꾸면 따라간다 (split 도 같다)', async () => {
    recordObserved();
    size.hunkHeight = 24;
    const view = render(
      <DiffView diff={small()} path="a.txt" mode="unified" fullFile={false} initialHeight={600} />,
    );
    await settle();
    const grid = scroller();
    const lineHeight = (root: HTMLElement) =>
      Number.parseFloat(
        (root.closest<HTMLElement>('[style*="--diff-line-height"]') ?? root).style.getPropertyValue(
          '--diff-line-height',
        ),
      );
    expect(lineHeight(grid)).toBe(20);
    // 구간 머리 줄은 잰 높이(24), 그 뒤 코드 줄은 20씩
    expect([1, 2, 3, 6].map((i) => startOf(grid, i))).toEqual([24, 44, 64, 124]);

    // 글자 크기를 키우면 코드 줄은 25, 머리 줄은 다시 잰 새 높이(29)
    size.rowHeight = 25;
    size.hunkHeight = 29;
    view.rerender(
      <DiffView
        diff={small()}
        path="a.txt"
        mode="unified"
        fullFile={false}
        initialHeight={600}
        fontSize={15}
      />,
    );
    await settle();
    expect(lineHeight(grid)).toBe(25);
    expect([1, 2, 3, 6].map((i) => startOf(grid, i))).toEqual([29, 54, 79, 154]);

    view.rerender(
      <DiffView
        diff={small()}
        path="a.txt"
        mode="split"
        fullFile={false}
        initialHeight={600}
        fontSize={15}
      />,
    );
    await settle();
    // split: 0 = 머리, 1~5 = 문맥, 6 = 삭제·추가 짝
    expect([1, 2, 6].map((i) => startOf(scroller(), i))).toEqual([29, 54, 154]);
  });

  it('CSS 가 코드 줄 높이를 --diff-line-height 하나로 정한다 (이 가정이 깨지면 고정 높이를 다시 봐야 한다)', () => {
    const css = diffCss;
    /** 선택자 하나의 선언 블록 (첫 번째) */
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    for (const selector of ['.line', '.half']) {
      const block = rule(selector);
      expect(block).toContain('min-height: var(--diff-line-height');
      expect(block).toContain('line-height: var(--diff-line-height');
      expect(block).not.toMatch(/padding|border-(top|bottom)|margin/);
    }
    expect(rule('.rowWrap')).not.toMatch(/padding|border|margin/);
    expect(rule('.scroller[data-wrap="false"] .code')).toContain('white-space: pre;');
  });

  it('구간 머리 줄과 "개행 없음" 표시는 한 줄일 때 높이가 --diff-line-height 와 같다 (L-2 — 엔진의 글꼴 메트릭에 맡기지 않는다)', () => {
    const css = diffCss;
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    const hunk = rule('.hunk');
    // 줄 높이 + 위아래 패딩 2+2 + 테두리 1+1 = --diff-line-height
    expect(hunk).toContain('line-height: calc(var(--diff-line-height, 20px) - 6px);');
    expect(hunk).toContain('padding: 2px 10px;');
    expect(hunk).toContain('border-top: 1px solid');
    expect(hunk).toContain('border-bottom: 1px solid');
    expect(hunk).not.toMatch(/min-height|(^|\s)height:|margin/);
    // 작은 글자는 줄 상자를 키우지 않게 글자 높이만큼만
    expect(rule('.noNewline')).toContain('line-height: 1;');
  });
});
