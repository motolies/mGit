import type { DiffLine, FileDiff, Hunk } from '@mgit/ipc';

/** 줄 하나의 위치: hunk 번호와 그 안의 인덱스 */
export interface LineRef {
  hunk: number;
  index: number;
  line: DiffLine;
}

/** 표시 행 (unified·split 공용) */
export type DiffRow =
  | { kind: 'hunk'; hunk: number; header: string }
  | { kind: 'line'; ref: LineRef; pair: LineRef | null }
  | { kind: 'split'; hunk: number; left: LineRef | null; right: LineRef | null };

/** `@@ -a,b +c,d @@ section` 형식의 헤더 문구 */
export function hunkHeader(h: Hunk): string {
  const section = h.section ? ` ${h.section}` : '';
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${section}`;
}

/**
 * hunk 안에서 "삭제 묶음 뒤 추가 묶음" 을 같은 순서로 짝짓는다 (단어 강조 대상).
 * 돌려주는 맵은 양방향이다 (삭제 인덱스 → 추가 인덱스, 추가 → 삭제)
 */
export function pairChanges(h: Hunk): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < h.lines.length) {
    if (h.lines[i]?.kind !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < h.lines.length && h.lines[i]?.kind === 'del') {
      dels.push(i);
      i++;
    }
    const adds: number[] = [];
    while (i < h.lines.length && h.lines[i]?.kind === 'add') {
      adds.push(i);
      i++;
    }
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = adds[k];
      if (d !== undefined && a !== undefined) {
        pairs.set(d, a);
        pairs.set(a, d);
      }
    }
  }
  return pairs;
}

/** unified 행 목록 */
export function buildUnifiedRows(diff: FileDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', hunk: hi, header: hunkHeader(h) });
    const pairs = pairChanges(h);
    h.lines.forEach((line, li) => {
      const p = pairs.get(li);
      const pairLine = p === undefined ? undefined : h.lines[p];
      rows.push({
        kind: 'line',
        ref: { hunk: hi, index: li, line },
        pair: p !== undefined && pairLine ? { hunk: hi, index: p, line: pairLine } : null,
      });
    });
  });
  return rows;
}

/** split(나란히) 행 목록: 컨텍스트는 양쪽, 삭제·추가 묶음은 같은 행에 짝지어 둔다 */
export function buildSplitRows(diff: FileDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', hunk: hi, header: hunkHeader(h) });
    let i = 0;
    while (i < h.lines.length) {
      const line = h.lines[i];
      if (!line) {
        break;
      }
      if (line.kind === 'context') {
        const ref = { hunk: hi, index: i, line };
        rows.push({ kind: 'split', hunk: hi, left: ref, right: ref });
        i++;
        continue;
      }
      const dels: LineRef[] = [];
      while (i < h.lines.length && h.lines[i]?.kind === 'del') {
        const l = h.lines[i];
        if (l) {
          dels.push({ hunk: hi, index: i, line: l });
        }
        i++;
      }
      const adds: LineRef[] = [];
      while (i < h.lines.length && h.lines[i]?.kind === 'add') {
        const l = h.lines[i];
        if (l) {
          adds.push({ hunk: hi, index: i, line: l });
        }
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        rows.push({ kind: 'split', hunk: hi, left: dels[k] ?? null, right: adds[k] ?? null });
      }
      if (dels.length === 0 && adds.length === 0) {
        i++; // 알 수 없는 종류: 무한 루프 방지
      }
    }
  });
  return rows;
}

/** 모드에 따라 행 목록을 만든다 */
export function buildRows(diff: FileDiff, mode: 'unified' | 'split'): DiffRow[] {
  return mode === 'split' ? buildSplitRows(diff) : buildUnifiedRows(diff);
}
