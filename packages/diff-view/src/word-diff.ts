import { presentableDiff } from '@codemirror/merge';

/** 구문 강조 조각 */
export interface Span {
  text: string;
  cls: string;
}

/** 단어 강조까지 합친 최종 조각 */
export interface Piece extends Span {
  changed: boolean;
}

/** [from, to) 범위 */
export type Range = [number, number];

/** 짝지은 삭제·추가 줄에서 서로 다른 단어 범위를 구한다 (단어 경계 정렬) */
export function wordRanges(del: string, add: string): { del: Range[]; add: Range[] } {
  if (del === add || del.length === 0 || add.length === 0) {
    return { del: [], add: [] };
  }
  const changes = presentableDiff(del, add, { scanLimit: 500, timeout: 50 });
  // 한쪽이 거의 다 바뀌었으면 강조가 소음이라 생략한다
  const changedA = changes.reduce((n, c) => n + (c.toA - c.fromA), 0);
  const changedB = changes.reduce((n, c) => n + (c.toB - c.fromB), 0);
  if (changedA > del.length * 0.8 && changedB > add.length * 0.8) {
    return { del: [], add: [] };
  }
  return {
    del: changes.filter((c) => c.toA > c.fromA).map((c) => [c.fromA, c.toA]),
    add: changes.filter((c) => c.toB > c.fromB).map((c) => [c.fromB, c.toB]),
  };
}

/** 구문 조각을 강조 범위 경계에서 잘라 `changed` 플래그를 붙인다 */
export function applyRanges(spans: Span[], ranges: Range[]): Piece[] {
  if (ranges.length === 0) {
    return spans.map((s) => ({ ...s, changed: false }));
  }
  const out: Piece[] = [];
  let pos = 0;
  let ri = 0;
  for (const span of spans) {
    let start = pos;
    const end = pos + span.text.length;
    while (start < end) {
      while (ri < ranges.length && (ranges[ri]?.[1] ?? 0) <= start) {
        ri++;
      }
      const r = ranges[ri];
      if (!r || r[0] >= end) {
        out.push({ text: span.text.slice(start - pos, end - pos), cls: span.cls, changed: false });
        start = end;
        break;
      }
      if (r[0] > start) {
        out.push({ text: span.text.slice(start - pos, r[0] - pos), cls: span.cls, changed: false });
        start = r[0];
      }
      const stop = Math.min(r[1], end);
      out.push({ text: span.text.slice(start - pos, stop - pos), cls: span.cls, changed: true });
      start = stop;
    }
    pos = end;
  }
  return out;
}
