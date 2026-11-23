// 고정 높이 행 트리의 가상 스크롤 (프로젝트 트리·Commit 도구 창 트리·변경 파일 트리 공용, W18).
// 행 높이 토큰(`--tree-row-h`)을 읽어 그 높이로 화면에 보이는 행만 그린다. 행을 어떻게 그리는지, 무엇을 고르는지,
// 키보드로 어떻게 옮기는지는 각 화면이 정한다 — 여기는 "몇 번째 행을 어디에 그릴지"만 맡는다.

import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { type RefObject, useLayoutEffect, useState } from 'react';

/** 행 높이 토큰을 못 읽었을 때 (jsdom 등)의 값. `--tree-row-h` 와 같다 */
const DEFAULT_TREE_ROW_H = 22;
/** 목록 위아래 여백 (px, `--space-2`) */
const TREE_LIST_PADDING = 4;
/** 화면 밖에 미리 그려 둘 행 수 (위아래 각각) */
const OVERSCAN = 12;

/** 행 높이 토큰(`--tree-row-h`)을 픽셀로 읽는다. 마운트 때 한 번 읽고, 못 읽으면 기본값이다 */
export function useTreeRowHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(DEFAULT_TREE_ROW_H);
  useLayoutEffect(() => {
    const el = ref.current;
    const value = el
      ? Number.parseFloat(getComputedStyle(el).getPropertyValue('--tree-row-h'))
      : Number.NaN;
    if (Number.isFinite(value) && value > 0) {
      setHeight(value);
    }
  }, [ref]);
  return height;
}

export interface VirtualTreeOptions {
  /** 스크롤되는 요소 (포커스를 받는 트리 자체) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 행 수 */
  count: number;
  /** 행의 안정된 키. 펼침·접힘으로 행이 밀려도 같은 행은 같은 키여야 그려 둔 행을 다시 쓴다 */
  keyOf: (index: number) => string | number;
}

export interface VirtualTree {
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  /** 행 높이 (px). 행 요소의 `height` 로 쓴다 */
  rowHeight: number;
  /** 키보드로 옮긴 행이 보이게 스크롤한다 (`treeScrollTarget` 규칙) */
  scrollToRow: (index: number) => void;
}

/** 키보드로 옮긴 행을 보이게 하는 스크롤: 맨 위 / 맨 아래 / 그 행이 보이게만 */
export type TreeScrollTarget = 'top' | 'bottom' | 'row';

/**
 * 행으로 옮길 때의 스크롤 방식 (순수 함수, W19 ③). 첫 행은 맨 위(위 여백까지 보이게 — 행 기준으로 맞추면 여백 4px 가
 * 가려진다), 끝 행은 맨 아래(아래 여백까지), 나머지는 그 행이 보이게만 (이미 보이면 그대로)
 */
export function treeScrollTarget(index: number, count: number): TreeScrollTarget {
  if (index <= 0) {
    return 'top';
  }
  return index >= count - 1 ? 'bottom' : 'row';
}

/**
 * 고정 높이 행 트리의 가상 스크롤: 행 높이 토큰을 읽고, 그 높이와 위아래 여백으로 virtualizer 를 만든다. 토큰을 읽어
 * 높이가 바뀌면 크기를 다시 잰다. 화면은 `virtualizer.getVirtualItems()` 의 행을 안쪽 상자(높이 `getTotalSize()`)에
 * `translateY(item.start)` 로 놓고, 키보드로 옮길 때 `scrollToRow(i)` 를 부른다
 */
export function useVirtualTree({ scrollRef, count, keyOf }: VirtualTreeOptions): VirtualTree {
  const rowHeight = useTreeRowHeight(scrollRef);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: keyOf,
    overscan: OVERSCAN,
    paddingStart: TREE_LIST_PADDING,
    paddingEnd: TREE_LIST_PADDING,
  });

  // 행 높이 토큰을 읽은 뒤 높이를 다시 잰다
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowHeight 는 다시 재라는 신호다 (estimateSize 가 읽는다)
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  /** 키보드로 옮긴 행이 보이게 스크롤한다. 첫 행·끝 행은 여백까지 보이게 끝까지 민다 */
  const scrollToRow = (index: number) => {
    switch (treeScrollTarget(index, count)) {
      case 'top':
        virtualizer.scrollToOffset(0);
        break;
      case 'bottom':
        virtualizer.scrollToOffset(virtualizer.getTotalSize());
        break;
      case 'row':
        virtualizer.scrollToIndex(index, { align: 'auto' });
        break;
    }
  };

  return { virtualizer, rowHeight, scrollToRow };
}
