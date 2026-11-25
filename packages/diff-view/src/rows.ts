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

/** 원문의 개행을 보존하면서 실제 파일 줄만 분리한다. 마지막 LF는 빈 줄을 추가하지 않는다. */
export function sourceLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** 원문 행은 음수 hunk로 구분하여 Git의 부분 작업 인덱스에 연결되지 않게 한다. */
function sourceRef(
  lines: string[],
  index: number,
  side: 'old' | 'new',
  content: string,
): LineRef | null {
  const text = lines[index];
  if (text === undefined) return null;
  return {
    hunk: side === 'old' ? -1 : -2,
    index,
    line: {
      kind: 'context',
      text,
      oldNo: side === 'old' ? index + 1 : null,
      newNo: side === 'new' ? index + 1 : null,
      noNewline: index === lines.length - 1 && !content.endsWith('\n'),
    },
  };
}

/** 패치의 구간과 변경 인덱스를 유지하고, 구간 사이에는 양쪽 원문을 각각 채운다. */
export function buildDocumentRows(
  diff: FileDiff,
  oldContent: string,
  newContent: string,
  mode: 'unified' | 'split',
): DiffRow[] {
  const oldLines = sourceLines(oldContent);
  const newLines = sourceLines(newContent);
  const rows: DiffRow[] = [];
  let oldAt = 0;
  let newAt = 0;
  /** 문맥 행은 좌우 내용을 따로 보존하며 통합 모드에서도 공백 차이를 숨기지 않는다. */
  const contextUntil = (oldEnd: number, newEnd: number) => {
    while (oldAt < oldEnd || newAt < newEnd) {
      const left = oldAt < oldEnd ? sourceRef(oldLines, oldAt++, 'old', oldContent) : null;
      const right = newAt < newEnd ? sourceRef(newLines, newAt++, 'new', newContent) : null;
      if (mode === 'split') {
        rows.push({ kind: 'split', hunk: -1, left, right });
      } else if (
        left &&
        right &&
        left.line.text === right.line.text &&
        left.line.noNewline === right.line.noNewline
      ) {
        rows.push({
          kind: 'line',
          ref: { ...right, line: { ...right.line, oldNo: left.line.oldNo } },
          pair: null,
        });
      } else {
        if (left) rows.push({ kind: 'line', ref: left, pair: null });
        if (right) rows.push({ kind: 'line', ref: right, pair: null });
      }
    }
  };
  diff.hunks.forEach((h, hi) => {
    contextUntil(
      Math.min(oldLines.length, h.oldStart - (h.oldLines > 0 ? 1 : 0)),
      Math.min(newLines.length, h.newStart - (h.newLines > 0 ? 1 : 0)),
    );
    rows.push({ kind: 'hunk', hunk: hi, header: hunkHeader(h) });
    let i = 0;
    while (i < h.lines.length) {
      const line = h.lines[i];
      if (!line) break;
      if (line.kind === 'context') {
        contextUntil(line.oldNo ?? oldAt, line.newNo ?? newAt);
        i++;
        continue;
      }
      const dels: LineRef[] = [];
      const adds: LineRef[] = [];
      while (h.lines[i]?.kind === 'del') {
        const entry = h.lines[i];
        if (!entry) break;
        const no = entry.oldNo;
        dels.push({
          hunk: hi,
          index: i++,
          line: { ...entry, text: no ? (oldLines[no - 1] ?? entry.text) : entry.text },
        });
        if (no) oldAt = no;
      }
      while (h.lines[i]?.kind === 'add') {
        const entry = h.lines[i];
        if (!entry) break;
        const no = entry.newNo;
        adds.push({
          hunk: hi,
          index: i++,
          line: { ...entry, text: no ? (newLines[no - 1] ?? entry.text) : entry.text },
        });
        if (no) newAt = no;
      }
      if (mode === 'split') {
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          rows.push({ kind: 'split', hunk: hi, left: dels[k] ?? null, right: adds[k] ?? null });
        }
      } else {
        dels.forEach((ref, k) => {
          rows.push({ kind: 'line', ref, pair: adds[k] ?? null });
        });
        adds.forEach((ref, k) => {
          rows.push({ kind: 'line', ref, pair: dels[k] ?? null });
        });
      }
      if (!dels.length && !adds.length) i++;
    }
  });
  contextUntil(oldLines.length, newLines.length);
  return rows;
}

/** 변경 주변 모드에서도 패치가 생략한 공백을 각 원문에서 복원한다. */
export function buildContextRows(
  diff: FileDiff,
  oldContent: string,
  newContent: string,
  mode: 'unified' | 'split',
): DiffRow[] {
  const oldLines = sourceLines(oldContent);
  const newLines = sourceLines(newContent);
  /** 변경 참조는 그대로 두고 문맥만 원문의 독립 참조로 교체한다. */
  const original = (ref: LineRef | null, side: 'old' | 'new') => {
    if (!ref) return null;
    const no = side === 'old' ? ref.line.oldNo : ref.line.newNo;
    if (!no) return ref;
    const raw = sourceRef(
      side === 'old' ? oldLines : newLines,
      no - 1,
      side,
      side === 'old' ? oldContent : newContent,
    );
    if (!raw) return ref;
    return ref.line.kind === 'context'
      ? raw
      : { ...ref, line: { ...ref.line, text: raw.line.text } };
  };
  return buildRows(diff, mode).flatMap((row): DiffRow[] => {
    if (row.kind === 'hunk') return [row];
    if (row.kind === 'split')
      return [{ ...row, left: original(row.left, 'old'), right: original(row.right, 'new') }];
    if (row.ref.line.kind !== 'context')
      return [
        { ...row, ref: original(row.ref, row.ref.line.kind === 'del' ? 'old' : 'new') ?? row.ref },
      ];
    const left = original(row.ref, 'old');
    const right = original(row.ref, 'new');
    if (
      left &&
      right &&
      left.line.text === right.line.text &&
      left.line.noNewline === right.line.noNewline
    ) {
      return [{ ...row, ref: { ...right, line: { ...right.line, oldNo: left.line.oldNo } } }];
    }
    return [left, right].flatMap((ref) => (ref ? [{ kind: 'line', ref, pair: null }] : []));
  });
}
