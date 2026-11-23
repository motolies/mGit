import type { DrawList } from './draw-list';

export interface PaintSize {
  width: number;
  height: number;
}

const LINE_WIDTH = 2;
const NODE_RADIUS = 3.5;

/** 색 번호를 팔레트 문자열로. 범위를 넘으면 순환 */
function colorOf(palette: string[], color: number): string {
  if (palette.length === 0) {
    return '#888';
  }
  return palette[color % palette.length] ?? '#888';
}

/**
 * DrawList 를 캔버스에 그린다 (부수효과만, 테스트하지 않음).
 * 선은 색별로 묶어 strokeStyle 변경 횟수를 줄인다.
 */
export function paint(
  ctx: CanvasRenderingContext2D,
  list: DrawList,
  palette: string[],
  dpr: number,
  size: PaintSize,
  background: string,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const byColor = new Map<number, { lines: DrawList['lines']; curves: DrawList['curves'] }>();
  for (const line of list.lines) {
    const bucket = byColor.get(line.color) ?? { lines: [], curves: [] };
    bucket.lines.push(line);
    byColor.set(line.color, bucket);
  }
  for (const curve of list.curves) {
    const bucket = byColor.get(curve.color) ?? { lines: [], curves: [] };
    bucket.curves.push(curve);
    byColor.set(curve.color, bucket);
  }

  for (const [color, bucket] of byColor) {
    ctx.strokeStyle = colorOf(palette, color);
    ctx.beginPath();
    for (const line of bucket.lines) {
      ctx.moveTo(line.x, line.y1);
      ctx.lineTo(line.x, line.y2);
    }
    for (const c of bucket.curves) {
      const half = (c.y2 - c.y1) / 2;
      ctx.moveTo(c.x1, c.y1);
      ctx.bezierCurveTo(c.x1, c.y1 + half, c.x2, c.y2 - half, c.x2, c.y2);
    }
    ctx.stroke();
  }

  // 접힌 긴 엣지: 비스듬한 짧은 선과 끝의 화살촉 (노드보다 먼저 그려 노드가 위에 오게)
  for (const s of list.stubs) {
    ctx.strokeStyle = colorOf(palette, s.color);
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    const head = 4;
    const dy = s.dir === 'down' ? -head : head;
    ctx.moveTo(s.x2 - head, s.y2 + dy);
    ctx.lineTo(s.x2, s.y2);
    ctx.lineTo(s.x2 + head * 0.6, s.y2 + dy * 0.8);
    ctx.stroke();
  }

  for (const node of list.nodes) {
    const color = colorOf(palette, node.color);
    ctx.beginPath();
    ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
    if (node.merge) {
      ctx.fillStyle = background;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // 다른 워크트리의 WIP (WT-06): 같은 점선 스타일
  const extraLines = list.wipLines ?? [];
  const extraNodes = list.wipNodes ?? [];
  if (extraLines.length > 0 || extraNodes.length > 0) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    for (const l of extraLines) {
      ctx.strokeStyle = colorOf(palette, l.color);
      ctx.beginPath();
      ctx.moveTo(l.x, l.y1);
      ctx.lineTo(l.x, l.y2);
      ctx.stroke();
    }
    for (const n of extraNodes) {
      ctx.strokeStyle = colorOf(palette, n.color);
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.arc(n.x, n.y, NODE_RADIUS + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // WIP 행 (GRAPH-03): 점선으로 HEAD 와 이어진 빈 고리
  if (list.wipLine || list.wipNode) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    if (list.wipLine) {
      ctx.strokeStyle = colorOf(palette, list.wipLine.color);
      ctx.beginPath();
      ctx.moveTo(list.wipLine.x, list.wipLine.y1);
      ctx.lineTo(list.wipLine.x, list.wipLine.y2);
      ctx.stroke();
    }
    if (list.wipNode) {
      ctx.strokeStyle = colorOf(palette, list.wipNode.color);
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.arc(list.wipNode.x, list.wipNode.y, NODE_RADIUS + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
