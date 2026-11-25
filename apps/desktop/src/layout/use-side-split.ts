import { settingsStorage } from '@mgit/storage';
import { useLayoutEffect, useRef } from 'react';
import {
  type Layout,
  type LayoutChangedMeta,
  useDefaultLayout,
  useGroupRef,
} from 'react-resizable-panels';

/** 한쪽 칸을 접고 펴는 두 칸 분할의 정의. 훅의 의존값이므로 모듈 상수로 둔다 */
export interface SideSplit {
  /** 분할 크기 저장 id (앱 전역 1벌). localStorage 키는 `react-resizable-panels:<layoutId>` */
  layoutId: string;
  /** 접히는 칸의 패널 id. 저장된 배치의 키이자 DOM id 이므로 바꾸면 저장값이 버려진다 */
  sideId: string;
  /** 남는 칸의 패널 id */
  mainId: string;
  /** 접히는 칸의 기본 크기 (퍼센트) */
  defaultPercent: number;
}

/** 접힘 여부에 맞는 배치(패널 id → 퍼센트). 펼쳤을 때만 기억해 둔 크기를 쓴다 */
export function sideSplitLayout(split: SideSplit, collapsed: boolean, percent: number): Layout {
  const side = collapsed ? 0 : percent;
  return { [split.sideId]: side, [split.mainId]: 100 - side };
}

/** 확정된 배치에서 접히는 칸이 접혀 있는지 (접힌 패널의 크기는 0 이다) */
export function isSideCollapsed(split: SideSplit, layout: Layout): boolean {
  return (layout[split.sideId] ?? 0) <= 0;
}

/** 배치에서 펼친 상태의 크기(퍼센트)를 꺼낸다. 없거나 접힌 값이면 기본 크기 */
export function sidePercentOf(split: SideSplit, layout: Layout | undefined): number {
  const percent = layout?.[split.sideId];
  return typeof percent === 'number' && percent > 0 && percent < 100
    ? percent
    : split.defaultPercent;
}

/**
 * 한쪽 칸을 바깥 상태(`collapsed`)로 접고 펴는 두 칸 분할의 공통 절차. 두 패널을 항상 렌더하고 접기만 한다
 * (조건부 마운트는 저장 키를 갈라놓는다). 접힘은 `setLayout` 한 번으로 적용하고, 저장하는 것은 펼친 상태의
 * 크기뿐이라 접힘이 저장된 배치를 덮어쓰지 않는다. 사용자가 분할선을 끌어 접으면 `onUserCollapse` 로 알린다.
 * 접힌 동안에는 분할선을 끌 수 없게 해야 한다 (`Separator disabled`) — 다시 펴는 것은 바깥 상태의 몫이다
 */
export function useSideSplit(split: SideSplit, collapsed: boolean, onUserCollapse: () => void) {
  const groupRef = useGroupRef();
  const { defaultLayout: saved, onLayoutChanged: saveLayout } = useDefaultLayout({
    storage: settingsStorage,
    id: split.layoutId,
  });
  // 펼친 상태의 크기. 접었다가 펼 때 이 크기로 돌아간다
  const percent = useRef(sidePercentOf(split, saved));

  // 접힘 상태가 바뀌면 배치를 맞춘다. 라이브러리가 그룹을 등록한 뒤(자식의 layout effect)이고 그리기 전이다
  useLayoutEffect(() => {
    groupRef.current?.setLayout(sideSplitLayout(split, collapsed, percent.current));
  }, [split, collapsed, groupRef]);

  /** 배치가 확정됐을 때: 펼친 모양이면 크기를 기억·저장하고, 끌어서 접었으면 바깥 상태로 옮긴다 */
  const onLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!isSideCollapsed(split, layout)) {
      percent.current = sidePercentOf(split, meta.requestedLayout ?? layout);
      saveLayout(layout, meta);
    } else if (meta.isUserInteraction && !collapsed) {
      onUserCollapse();
    }
  };

  return {
    groupRef,
    // 크기를 아직 못 잰 그룹(가려진 도구 창 등)은 이 값으로 첫 배치를 잡으므로 현재 모양을 그대로 준다
    defaultLayout: sideSplitLayout(split, collapsed, percent.current),
    onLayoutChanged,
  };
}
