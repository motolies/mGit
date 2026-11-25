import { diff as characterDiff, presentableDiff } from '@codemirror/merge';

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

export type HighlightMode = 'character' | 'word' | 'line';

const rangeCache = new Map<string, { del: Range[]; add: Range[] }>();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** UTF-16 변경 범위를 한글 조합·이모지의 실제 글자 경계까지 확장한다. */
function graphemeRanges(text: string, ranges: Range[]): Range[] {
  const boundaries = [...segmenter.segment(text)].map((segment) => segment.index);
  boundaries.push(text.length);
  return ranges.map(([from, to]) => {
    let start = 0;
    let end = text.length;
    for (const boundary of boundaries) {
      if (boundary <= from) start = boundary;
      if (boundary >= to) {
        end = boundary;
        break;
      }
    }
    return [start, end];
  });
}

/** 보이는 변경 쌍만 계산하고 제한 초과 시 줄 배경을 유지한다. 캐시는 유한하게 유지한다. */
export function changeRanges(
  del: string,
  add: string,
  mode: HighlightMode,
): { del: Range[]; add: Range[] } {
  if (mode === 'line' || del === add || del.length + add.length > 20000)
    return { del: [], add: [] };
  const key = JSON.stringify([mode, del, add]);
  const cached = rangeCache.get(key);
  if (cached) return cached;
  let ranges: { del: Range[]; add: Range[] };
  if (mode === 'word') {
    ranges = wordRanges(del, add);
  } else {
    const changes = characterDiff(del, add, { scanLimit: 500, timeout: 50 });
    ranges = {
      del: changes.filter((c) => c.toA > c.fromA).map((c) => [c.fromA, c.toA]),
      add: changes.filter((c) => c.toB > c.fromB).map((c) => [c.fromB, c.toB]),
    };
  }
  ranges = { del: graphemeRanges(del, ranges.del), add: graphemeRanges(add, ranges.add) };
  if (rangeCache.size >= 1000) rangeCache.clear();
  rangeCache.set(key, ranges);
  return ranges;
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
