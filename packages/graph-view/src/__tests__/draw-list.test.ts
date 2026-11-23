import type { GraphRow, GraphSlice } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { buildDrawList } from '../draw-list';
import {
  GRAPH_PADDING,
  graphColumnWidth,
  laneX,
  rowCenterY,
  type Viewport,
  visibleRowRange,
} from '../geometry';

const V: Viewport = { scrollTop: 0, height: 100, rowHeight: 20, laneWidth: 10, laneCap: 4 };

/** 테스트용 행 */
function row(index: number, lane: number, parents = 1): GraphRow {
  return {
    row: index,
    oid: index.toString(16).padStart(40, '0'),
    parents: Array.from({ length: parents }, (_, i) => `p${i}`),
    authorName: 'a',
    authorEmail: 'a@x',
    authorTime: 0,
    commitTime: 0,
    subject: `s${index}`,
    lane,
    color: lane,
    refs: [],
    isHead: index === 0,
    inHead: true,
    repo: null,
  };
}

/** 테스트용 슬라이스 */
function slice(partial: Partial<GraphSlice>): GraphSlice {
  return {
    start: 0,
    rows: [],
    segments: [],
    edges: [],
    stubs: [],
    totalRows: 100,
    complete: true,
    ...partial,
  };
}

describe('geometry', () => {
  it('laneX 는 레인 중심이고 상한을 넘으면 마지막 자리에 접는다', () => {
    expect(laneX(0, V)).toBe(GRAPH_PADDING / 2 + 5);
    expect(laneX(1, V)).toBe(GRAPH_PADDING / 2 + 15);
    expect(laneX(9, V)).toBe(laneX(3, V));
  });

  it('visibleRowRange 는 뷰포트에 걸친 행을 돌려준다', () => {
    expect(visibleRowRange(V, 100)).toEqual({ first: 0, last: 4 });
    expect(visibleRowRange({ ...V, scrollTop: 30 }, 100)).toEqual({ first: 1, last: 6 });
    expect(visibleRowRange(V, 0)).toEqual({ first: 0, last: -1 });
    expect(visibleRowRange({ ...V, scrollTop: 1990 }, 100)).toEqual({ first: 99, last: 99 });
  });

  it('graphColumnWidth 는 레인 수에 비례하되 상한에서 멈춘다', () => {
    expect(graphColumnWidth(1, 10, 4)).toBe(10 + GRAPH_PADDING);
    expect(graphColumnWidth(3, 10, 4)).toBe(30 + GRAPH_PADDING);
    expect(graphColumnWidth(30, 10, 4)).toBe(40 + GRAPH_PADDING);
  });
});

describe('buildDrawList', () => {
  it('세로 구간은 continues 플래그에 따라 가장자리 또는 중심에서 시작·끝난다', () => {
    const list = buildDrawList(
      slice({
        segments: [
          { lane: 0, fromRow: 0, toRow: 4, color: 0, continuesUp: true, continuesDown: true },
          { lane: 1, fromRow: 1, toRow: 2, color: 1, continuesUp: false, continuesDown: false },
        ],
      }),
      V,
    );
    expect(list.lines).toHaveLength(2);
    const main = list.lines[0];
    expect(main?.y1).toBe(0);
    expect(main?.y2).toBe(100);
    const branch = list.lines[1];
    expect(branch?.y1).toBe(rowCenterY(1, V));
    expect(branch?.y2).toBe(rowCenterY(2, V));
    expect(branch?.x).toBe(laneX(1, V));
  });

  it('뷰포트 밖 구간은 버리고 걸친 구간은 클립한다', () => {
    const list = buildDrawList(
      slice({
        segments: [
          { lane: 0, fromRow: 20, toRow: 30, color: 0, continuesUp: false, continuesDown: false },
          { lane: 1, fromRow: 3, toRow: 40, color: 1, continuesUp: false, continuesDown: true },
        ],
      }),
      V,
    );
    expect(list.lines).toHaveLength(1);
    expect(list.lines[0]?.y1).toBe(rowCenterY(3, V));
    expect(list.lines[0]?.y2).toBe(V.height + V.rowHeight);
  });

  it('엣지는 인접 행 중심을 잇는 곡선이 된다', () => {
    const list = buildDrawList(
      slice({ edges: [{ topRow: 1, topLane: 0, bottomLane: 2, color: 2 }] }),
      V,
    );
    expect(list.curves).toEqual([
      { x1: laneX(0, V), y1: rowCenterY(1, V), x2: laneX(2, V), y2: rowCenterY(2, V), color: 2 },
    ]);
  });

  it('노드는 받은 행마다 하나이고 merge 는 부모 수로 판별한다', () => {
    const list = buildDrawList(
      slice({ start: 0, rows: [row(0, 0, 2), undefined, row(2, 1, 1)] }),
      V,
    );
    expect(list.nodes).toHaveLength(2);
    expect(list.nodes[0]).toMatchObject({ x: laneX(0, V), y: rowCenterY(0, V), merge: true });
    expect(list.nodes[1]).toMatchObject({ x: laneX(1, V), merge: false });
  });

  it('상한을 넘는 레인이 있으면 folded 가 켜진다', () => {
    const list = buildDrawList(slice({ rows: [row(0, 7)] }), V);
    expect(list.folded).toBe(true);
    expect(list.nodes[0]?.x).toBe(laneX(3, V));
  });

  it('스크롤 위치가 좌표에 반영된다', () => {
    const v = { ...V, scrollTop: 200 };
    const list = buildDrawList(slice({ rows: [row(10, 0), row(11, 0)] }), v);
    expect(list.nodes[0]?.y).toBe(10);
    expect(list.nodes[1]?.y).toBe(30);
  });
});

describe('extra WIP rows (WT-06)', () => {
  it('표시 행마다 점선 노드를 두고 HEAD 행까지 선을 긋는다', () => {
    const v: Viewport = { ...V, rowOffset: 2 };
    const list = buildDrawList(
      slice({ rows: [row(0, 1), row(1, 0)] }),
      v,
      { lane: 1, headRow: 0, color: 3 },
      [{ lane: 0, headRow: 1, color: 5, displayIndex: 1 }],
    );
    expect(list.wipNode).toBeDefined();
    expect(list.wipNodes).toHaveLength(1);
    expect(list.wipLines).toHaveLength(1);
    const node = list.wipNodes?.[0];
    expect(node?.y).toBe(rowCenterY(1 - 2, v));
    expect(node?.color).toBe(5);
    expect(list.wipLines?.[0]?.y2).toBe(rowCenterY(1, v));
  });
});

describe('buildDrawList 스텁', () => {
  it('Down 스텁은 노드 중심에서 행 아래쪽으로, Up 은 위쪽으로 비스듬히 나간다', () => {
    const list = buildDrawList(
      slice({
        rows: [row(0, 0), row(1, 1)],
        stubs: [
          { row: 0, lane: 0, dir: 'down', otherRow: 50, color: 2 },
          { row: 1, lane: 1, dir: 'up', otherRow: 0, color: 3 },
        ],
      }),
      V,
    );
    expect(list.stubs).toHaveLength(2);
    const down = list.stubs[0];
    const up = list.stubs[1];
    expect(down?.x1).toBe(laneX(0, V));
    expect(down?.y1).toBe(rowCenterY(0, V));
    expect(down?.x2).toBe(laneX(0, V) + V.laneWidth * 0.5);
    expect(down?.y2).toBe(V.rowHeight - 2);
    expect(down?.dir).toBe('down');
    expect(up?.y2).toBe(V.rowHeight + 2);
    expect(up?.color).toBe(3);
  });

  it('뷰포트 밖 행의 스텁은 버리고, 상한을 넘는 레인은 folded 로 표시한다', () => {
    const far = buildDrawList(
      slice({ stubs: [{ row: 50, lane: 0, dir: 'down', otherRow: null, color: 0 }] }),
      V,
    );
    expect(far.stubs).toHaveLength(0);
    const wide = buildDrawList(
      slice({
        rows: [row(0, 9)],
        stubs: [{ row: 0, lane: 9, dir: 'down', otherRow: null, color: 0 }],
      }),
      V,
    );
    expect(wide.folded).toBe(true);
  });
});
