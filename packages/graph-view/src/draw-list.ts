import type { GraphSlice } from '@mgit/ipc';
import { laneX, rowBottomY, rowCenterY, rowTopY, type Viewport } from './geometry';

export interface DrawLine {
  x: number;
  y1: number;
  y2: number;
  color: number;
}

export interface DrawCurve {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}

export interface DrawNode {
  x: number;
  y: number;
  color: number;
  /** 부모가 둘 이상인 merge commit. 고리로 그린다 */
  merge: boolean;
}

/** WIP 행 표시 (GRAPH-03): HEAD 레인 위의 점선 노드와 HEAD 행까지의 점선 */
export interface WipDraw {
  lane: number;
  /** HEAD 커밋의 그래프 행. 슬라이스에 없으면 null (선을 긋지 않는다) */
  headRow: number | null;
  color: number;
  /** 표시 행 (0 = 맨 위). 기본 0. 워크트리별 WIP(WT-06)는 1, 2, … */
  displayIndex?: number;
}

/** 접힌 긴 엣지의 스텁: 노드 중심에서 비스듬히 짧게 나가는 선 + 끝의 화살촉 */
export interface DrawStub {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
  dir: 'down' | 'up';
}

/** 한 프레임에 그릴 것. 좌표는 모두 뷰포트 기준 px */
export interface DrawList {
  lines: DrawLine[];
  curves: DrawCurve[];
  nodes: DrawNode[];
  /** 접힌 긴 엣지 (없으면 빈 배열) */
  stubs: DrawStub[];
  /** 표시 상한을 넘는 레인이 있었는지 */
  folded: boolean;
  /** WIP 노드와 HEAD 행까지의 점선 */
  wipNode?: DrawNode;
  wipLine?: DrawLine;
  /** 다른 워크트리의 WIP 들 (WT-06) */
  wipNodes?: DrawNode[];
  wipLines?: DrawLine[];
}

/**
 * 캐시 슬라이스와 뷰포트로 그릴 목록을 만든다 (순수 함수).
 * - 세로 구간: continuesUp/Down 이면 행 가장자리까지, 아니면 행 중심까지
 * - 엣지: 인접 행 중심 사이의 곡선
 * - 노드: 받은 행마다 하나. 뷰포트 밖(한 행 여유)은 버린다
 * - `wip` 가 있으면 표시 행 0 에 점선 노드를 두고 HEAD 행까지 점선을 긋는다
 */
export function buildDrawList(
  slice: GraphSlice,
  v: Viewport,
  wip?: WipDraw | null,
  extraWips: readonly WipDraw[] = [],
): DrawList {
  const lines: DrawLine[] = [];
  const curves: DrawCurve[] = [];
  const nodes: DrawNode[] = [];
  let folded = false;
  const margin = v.rowHeight;
  const minY = -margin;
  const maxY = v.height + margin;

  for (const seg of slice.segments) {
    if (seg.lane >= v.laneCap) {
      folded = true;
    }
    const y1 = seg.continuesUp ? rowTopY(seg.fromRow, v) : rowCenterY(seg.fromRow, v);
    const y2 = seg.continuesDown ? rowBottomY(seg.toRow, v) : rowCenterY(seg.toRow, v);
    if (y2 < minY || y1 > maxY) {
      continue;
    }
    lines.push({
      x: laneX(seg.lane, v),
      y1: Math.max(y1, minY),
      y2: Math.min(y2, maxY),
      color: seg.color,
    });
  }

  for (const edge of slice.edges) {
    if (edge.topLane >= v.laneCap || edge.bottomLane >= v.laneCap) {
      folded = true;
    }
    const y1 = rowCenterY(edge.topRow, v);
    const y2 = rowCenterY(edge.topRow + 1, v);
    if (y2 < minY || y1 > maxY) {
      continue;
    }
    curves.push({
      x1: laneX(edge.topLane, v),
      y1,
      x2: laneX(edge.bottomLane, v),
      y2,
      color: edge.color,
    });
  }

  for (const row of slice.rows) {
    if (!row) {
      continue;
    }
    if (row.lane >= v.laneCap) {
      folded = true;
    }
    const y = rowCenterY(row.row, v);
    if (y < minY || y > maxY) {
      continue;
    }
    nodes.push({ x: laneX(row.lane, v), y, color: row.color, merge: row.parents.length > 1 });
  }

  // 스텁: Down 은 노드 중심에서 오른쪽 아래 행 가장자리 쪽으로, Up 은 오른쪽 위로
  const stubs: DrawStub[] = [];
  for (const stub of slice.stubs) {
    if (stub.lane >= v.laneCap) {
      folded = true;
    }
    const y1 = rowCenterY(stub.row, v);
    if (y1 < minY || y1 > maxY) {
      continue;
    }
    const x1 = laneX(stub.lane, v);
    const x2 = x1 + v.laneWidth * 0.5;
    const y2 = stub.dir === 'down' ? rowBottomY(stub.row, v) - 2 : rowTopY(stub.row, v) + 2;
    stubs.push({ x1, y1, x2, y2, color: stub.color, dir: stub.dir });
  }

  const list: DrawList = { lines, curves, nodes, stubs, folded };
  if (wip) {
    // WIP 는 표시 행 0: 그래프 행 번호로는 -rowOffset
    const wipRow = -(v.rowOffset ?? 0);
    const y = rowCenterY(wipRow, v);
    const x = laneX(wip.lane, v);
    if (y >= minY && y <= maxY) {
      list.wipNode = { x, y, color: wip.color, merge: false };
    }
    if (wip.headRow !== null) {
      const y2 = rowCenterY(wip.headRow, v);
      if (!(y2 < minY && y < minY) && !(y > maxY && y2 > maxY)) {
        list.wipLine = { x, y1: Math.max(y, minY), y2: Math.min(y2, maxY), color: wip.color };
      }
    }
  }
  if (extraWips.length > 0) {
    const nodes: DrawNode[] = [];
    const lines: DrawLine[] = [];
    for (const w of extraWips) {
      // 표시 행 i 는 그래프 행 번호로 i - rowOffset
      const wipRow = (w.displayIndex ?? 0) - (v.rowOffset ?? 0);
      const y = rowCenterY(wipRow, v);
      const x = laneX(w.lane, v);
      if (y >= minY && y <= maxY) {
        nodes.push({ x, y, color: w.color, merge: false });
      }
      if (w.headRow !== null) {
        const y2 = rowCenterY(w.headRow, v);
        if (!(y2 < minY && y < minY) && !(y > maxY && y2 > maxY)) {
          lines.push({ x, y1: Math.max(y, minY), y2: Math.min(y2, maxY), color: w.color });
        }
      }
    }
    list.wipNodes = nodes;
    list.wipLines = lines;
  }
  return list;
}
