import { type RefObject, useLayoutEffect, useState } from 'react';

export interface TreeWidthText {
  text: string;
  bold?: boolean;
}
export interface TreeWidthRow {
  depth: number;
  texts: readonly TreeWidthText[];
  icons?: number;
  extra?: number;
}
export interface TreeWidthMetrics {
  indent: number;
  icon: number;
  gap: number;
  padding: number;
}

/** DOM에 없는 가상 행도 포함해 들여쓰기·아이콘·표시 문구의 최대 필요 폭을 구한다. */
export function treeContentWidth(
  rows: readonly TreeWidthRow[],
  measure: (text: string, bold: boolean) => number,
  metrics: TreeWidthMetrics,
): number {
  return Math.ceil(
    rows.reduce(
      (max, row) =>
        Math.max(
          max,
          metrics.padding +
            row.depth * metrics.indent +
            (row.icons ?? 0) * (metrics.icon + metrics.gap) +
            row.texts.reduce(
              (sum, part) => sum + measure(part.text, part.bold === true) + metrics.gap,
              0,
            ) +
            (row.extra ?? 0),
        ),
      0,
    ),
  );
}

/** 현재 글꼴로 전체 펼친 행을 측정하고 폰트 로딩·크기 변경에도 내용 폭을 갱신한다. */
export function useTreeContentWidth(
  ref: RefObject<HTMLElement | null>,
  rows: readonly TreeWidthRow[],
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let live = true;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const update = () => {
      if (!live) return;
      const style = getComputedStyle(element);
      const px = (name: string, fallback: number) =>
        Number.parseFloat(style.getPropertyValue(name)) || fallback;
      const size = Number.parseFloat(style.fontSize) || 12;
      const family = style.fontFamily || 'sans-serif';
      const cache = new Map<string, number>();
      const measure = (text: string, bold: boolean) => {
        const key = `${bold}:${text}`;
        const previous = cache.get(key);
        if (previous !== undefined) return previous;
        let value: number;
        if (context && typeof context.measureText === 'function') {
          context.font = `${bold ? 600 : 400} ${size}px ${family}`;
          value = context.measureText(text).width;
        } else
          value = Array.from(text).reduce(
            (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1) * size,
            0,
          );
        cache.set(key, value);
        return value;
      };
      setWidth(
        treeContentWidth(rows, measure, {
          indent: px('--tree-indent', 16),
          icon: px('--icon-size', 16),
          gap: px('--space-2', 4),
          padding: 24,
        }),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    void document.fonts?.ready.then(update);
    document.fonts?.addEventListener('loadingdone', update);
    return () => {
      live = false;
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', update);
    };
  }, [ref, rows]);
  return width;
}

/** 행 이동은 세로 위치만 조정해 사용자가 옮긴 가로 스크롤을 보존한다. */
export function revealTreeRowVertically(
  container: HTMLElement | null,
  row: HTMLElement | null | undefined,
): void {
  if (!container || !row) return;
  const viewport = container.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  if (bounds.top < viewport.top) container.scrollTop += bounds.top - viewport.top;
  else if (bounds.bottom > viewport.bottom) container.scrollTop += bounds.bottom - viewport.bottom;
}
