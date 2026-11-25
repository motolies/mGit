import type { FileDiff } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { buildSplitRows, buildUnifiedRows, hunkHeader, pairChanges } from '../rows';
import {
  changeLineIndices,
  changeRangeKeys,
  changeUnits,
  countSelectedChanges,
  lineKey,
  rangeKeys,
  selectionFromKeys,
} from '../selection';
import { applyRanges, wordRanges } from '../word-diff';

/** 첫 hunk (없으면 실패) */
function hunk0() {
  const h = sample().hunks[0];
  if (!h) {
    throw new Error('hunk 없음');
  }
  return h;
}

/** 테스트용 diff: 컨텍스트, 삭제 2, 추가 1, 컨텍스트 */
function sample(): FileDiff {
  return {
    oldPath: 'a.rs',
    newPath: 'a.rs',
    change: { kind: 'modified' },
    binary: null,
    truncated: false,
    totalLines: 5,
    nonUtf8: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 3,
        section: 'fn main',
        lines: [
          { kind: 'context', oldNo: 1, newNo: 1, text: 'let a = 1;', noNewline: false },
          { kind: 'del', oldNo: 2, newNo: null, text: 'let b = 2;', noNewline: false },
          { kind: 'del', oldNo: 3, newNo: null, text: 'let c = 3;', noNewline: false },
          { kind: 'add', oldNo: null, newNo: 2, text: 'let b = 20;', noNewline: false },
          { kind: 'context', oldNo: 4, newNo: 3, text: 'done', noNewline: true },
        ],
      },
    ],
  };
}

describe('rows', () => {
  it('unified 행은 hunk 헤더 뒤에 줄이 오고 삭제·추가를 짝짓는다', () => {
    const rows = buildUnifiedRows(sample());
    expect(rows[0]).toEqual({ kind: 'hunk', hunk: 0, header: '@@ -1,4 +1,3 @@ fn main' });
    expect(rows).toHaveLength(6);
    const del = rows[2];
    const add = rows[4];
    expect(del?.kind === 'line' && del.pair?.index).toBe(3);
    expect(add?.kind === 'line' && add.pair?.index).toBe(1);
    const del2 = rows[3];
    expect(del2?.kind === 'line' && del2.pair).toBeNull();
    expect(hunkHeader({ ...hunk0(), section: '' })).toBe('@@ -1,4 +1,3 @@');
  });

  it('split 행은 컨텍스트를 양쪽에, 변경 묶음을 나란히 둔다', () => {
    const rows = buildSplitRows(sample());
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'split', 'split', 'split', 'split']);
    const first = rows[2];
    expect(first?.kind === 'split' && first.left?.index).toBe(1);
    expect(first?.kind === 'split' && first.right?.index).toBe(3);
    const second = rows[3];
    expect(second?.kind === 'split' && second.left?.index).toBe(2);
    expect(second?.kind === 'split' && second.right).toBeNull();
  });

  it('pairChanges 는 양방향 맵을 만든다', () => {
    const pairs = pairChanges(hunk0());
    expect([...pairs.entries()]).toEqual([
      [1, 3],
      [3, 1],
    ]);
  });
});

describe('selection', () => {
  it('키 집합을 hunk 별 정렬된 선택으로 바꾼다', () => {
    expect(selectionFromKeys([lineKey(1, 5), lineKey(0, 3), lineKey(1, 2), lineKey(1, 2)])).toEqual(
      [
        { hunk: 0, lines: [3] },
        { hunk: 1, lines: [2, 5] },
      ],
    );
    expect(selectionFromKeys(['bad'])).toEqual([]);
  });

  it('수정 쌍과 남은 삭제 행을 나누고 같은 구간의 표시 순서로 범위를 고른다', () => {
    expect(changeUnits(hunk0())).toEqual([[1, 3], [2]]);
    expect(changeRangeKeys(hunk0(), 0, 3, 2)).toEqual(['0:1', '0:3', '0:2']);
    expect(changeRangeKeys(hunk0(), 0, 2, 1)).toEqual(['0:1', '0:3', '0:2']);
    expect(countSelectedChanges(sample(), [{ hunk: 0, lines: [1, 3] }])).toBe(1);
    expect(countSelectedChanges(sample(), [{ hunk: 0, lines: [] }])).toBe(2);
    expect(countSelectedChanges(sample(), [])).toBe(0);
  });

  it('변경 줄 인덱스와 Shift 범위', () => {
    const h = hunk0();
    expect(changeLineIndices(h)).toEqual([1, 2, 3]);
    expect(rangeKeys(h, 0, 3, 1)).toEqual(['0:1', '0:2', '0:3']);
  });
});

describe('word-diff', () => {
  it('바뀐 단어 범위를 찾고 조각에 표시한다', () => {
    const w = wordRanges('let b = 2;', 'let b = 20;');
    expect(w.add.length).toBeGreaterThan(0);
    const pieces = applyRanges([{ text: 'let b = 20;', cls: '' }], w.add);
    const changed = pieces
      .filter((p) => p.changed)
      .map((p) => p.text)
      .join('');
    // '2' → '20' 은 '0' 하나가 끼어든 것이므로 그 글자만 강조된다
    expect(changed).toBe('0');
    expect(w.del).toEqual([]);
    expect(pieces.map((p) => p.text).join('')).toBe('let b = 20;');
  });

  it('완전히 다른 줄은 강조하지 않는다', () => {
    const w = wordRanges('abc', 'xyz');
    expect(w).toEqual({ del: [], add: [] });
    expect(applyRanges([{ text: 'xyz', cls: 'k' }], [])).toEqual([
      { text: 'xyz', cls: 'k', changed: false },
    ]);
  });

  it('범위가 조각 경계를 가로질러도 텍스트가 보존된다', () => {
    const pieces = applyRanges(
      [
        { text: 'ab', cls: 'x' },
        { text: 'cd', cls: 'y' },
      ],
      [[1, 3]],
    );
    expect(pieces).toEqual([
      { text: 'a', cls: 'x', changed: false },
      { text: 'b', cls: 'x', changed: true },
      { text: 'c', cls: 'y', changed: true },
      { text: 'd', cls: 'y', changed: false },
    ]);
  });
});
