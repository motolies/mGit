import type { FileDiff, Hunk, LineSelection } from '@mgit/ipc';

/**
 * 줄 선택이 가리키는 diff 의 내용 키. 선택은 `hunk:index` 위치로 저장되므로 파일이나 내용이 바뀌면 다른 줄을
 * 가리키게 된다. 키가 달라지면 선택을 버리고, 내용이 같은 재조회에서는 유지한다
 */
export function diffContentKey(path: string, diff: FileDiff | null): string {
  if (!diff) {
    return '';
  }
  const parts = [path];
  for (const h of diff.hunks) {
    parts.push(`@${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`);
    for (const l of h.lines) {
      parts.push(`${l.kind}:${l.text}`);
    }
  }
  return parts.join('\n');
}

/** 선택 키: `hunk:index` */
export function lineKey(hunk: number, index: number): string {
  return `${hunk}:${index}`;
}

/** 키를 다시 (hunk, index) 로 */
export function parseLineKey(key: string): { hunk: number; index: number } | null {
  const [h, i] = key.split(':');
  const hunk = Number(h);
  const index = Number(i);
  return Number.isInteger(hunk) && Number.isInteger(index) ? { hunk, index } : null;
}

/** 선택된 키 집합을 코어의 `LineSelection[]` 로 바꾼다 (hunk 별로 묶고 정렬) */
export function selectionFromKeys(keys: Iterable<string>): LineSelection[] {
  const byHunk = new Map<number, number[]>();
  for (const key of keys) {
    const parsed = parseLineKey(key);
    if (!parsed) {
      continue;
    }
    const list = byHunk.get(parsed.hunk) ?? [];
    list.push(parsed.index);
    byHunk.set(parsed.hunk, list);
  }
  return [...byHunk.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hunk, lines]) => ({ hunk, lines: [...new Set(lines)].sort((a, b) => a - b) }));
}

/** hunk 안의 변경 줄(추가·삭제) 인덱스 */
export function changeLineIndices(h: Hunk): number[] {
  const out: number[] = [];
  h.lines.forEach((l, i) => {
    if (l.kind !== 'context') {
      out.push(i);
    }
  });
  return out;
}

/** 두 변경 줄 사이(포함)의 모든 변경 줄 키 (Shift 범위 선택). 같은 hunk 안에서만 */
export function rangeKeys(h: Hunk, hunk: number, a: number, b: number): string[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return changeLineIndices(h)
    .filter((i) => i >= from && i <= to)
    .map((i) => lineKey(hunk, i));
}

/** 텍스트 선택의 시작·끝 위치. 부분 작업 거터 선택과 독립적이다. */
export interface TextPosition {
  row: number;
  offset: number;
}

/** 좌우 행이 DOM에 섞여 있어도 복사할 때는 선택한 패널의 원문만 반환한다. */
export function selectedText(
  rows: import('./rows').DiffRow[],
  anchor: TextPosition,
  focus: TextPosition,
  side: 'left' | 'right',
): string {
  const [from, to] =
    anchor.row < focus.row || (anchor.row === focus.row && anchor.offset <= focus.offset)
      ? [anchor, focus]
      : [focus, anchor];
  return rows
    .slice(from.row, to.row + 1)
    .flatMap((row, index) => {
      const ref = row.kind === 'line' ? row.ref : row.kind === 'split' ? row[side] : null;
      if (!ref) return [];
      const start = index === 0 ? from.offset : 0;
      const end = from.row + index === to.row ? to.offset : ref.line.text.length;
      return [ref.line.text.slice(start, end)];
    })
    .join('\n');
}
