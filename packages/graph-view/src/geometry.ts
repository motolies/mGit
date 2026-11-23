// 그래프 좌표 계산. 모두 순수 함수라 jsdom 없이 테스트한다.

export interface Viewport {
  /** 스크롤 컨테이너의 scrollTop (px) */
  scrollTop: number;
  /** 보이는 영역 높이 (px) */
  height: number;
  rowHeight: number;
  laneWidth: number;
  /** 표시 상한. 이 이상인 레인은 마지막 자리에 접는다 */
  laneCap: number;
  /** 그래프 행 앞에 끼워 넣은 표시 행 수 (WIP 행이 있으면 1). 기본 0 */
  rowOffset?: number;
}

/** 그래프 열 양옆 여백 (px) */
export const GRAPH_PADDING = 8;

/** 레인 번호를 열 안의 x 좌표(중심)로 바꾼다. 상한을 넘는 레인은 마지막 자리에 접는다 */
export function laneX(lane: number, g: Pick<Viewport, 'laneWidth' | 'laneCap'>): number {
  const clamped = Math.min(lane, Math.max(g.laneCap, 1) - 1);
  return GRAPH_PADDING / 2 + (clamped + 0.5) * g.laneWidth;
}

/** 그래프 행 번호를 표시 행 번호로 (WIP 행만큼 밀린다) */
function displayRow(row: number, v: Pick<Viewport, 'rowOffset'>): number {
  return row + (v.rowOffset ?? 0);
}

/** 행의 세로 중심 (뷰포트 기준) */
export function rowCenterY(
  row: number,
  v: Pick<Viewport, 'scrollTop' | 'rowHeight' | 'rowOffset'>,
): number {
  return (displayRow(row, v) + 0.5) * v.rowHeight - v.scrollTop;
}

/** 행의 위쪽 가장자리 (뷰포트 기준) */
export function rowTopY(
  row: number,
  v: Pick<Viewport, 'scrollTop' | 'rowHeight' | 'rowOffset'>,
): number {
  return displayRow(row, v) * v.rowHeight - v.scrollTop;
}

/** 행의 아래쪽 가장자리 (뷰포트 기준) */
export function rowBottomY(
  row: number,
  v: Pick<Viewport, 'scrollTop' | 'rowHeight' | 'rowOffset'>,
): number {
  return (displayRow(row, v) + 1) * v.rowHeight - v.scrollTop;
}

/** 뷰포트에 걸치는 행 범위 (last 포함). 행이 없으면 last < first */
export function visibleRowRange(
  v: Pick<Viewport, 'scrollTop' | 'height' | 'rowHeight'>,
  totalRows: number,
): { first: number; last: number } {
  if (totalRows <= 0 || v.rowHeight <= 0) {
    return { first: 0, last: -1 };
  }
  const first = Math.max(0, Math.floor(v.scrollTop / v.rowHeight));
  const last = Math.min(totalRows - 1, Math.ceil((v.scrollTop + v.height) / v.rowHeight) - 1);
  return { first, last: Math.max(last, first - 1) };
}

/** 레인 수에 따른 그래프 열 폭 (px) */
export function graphColumnWidth(laneCount: number, laneWidth: number, laneCap: number): number {
  const lanes = Math.min(Math.max(laneCount, 1), Math.max(laneCap, 1));
  return lanes * laneWidth + GRAPH_PADDING;
}
