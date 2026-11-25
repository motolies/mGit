import type { FileDiff, Hunk } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { buildContextRows, buildDocumentRows, sourceLines } from '../rows';
import { selectedText } from '../selection';
import { applyRanges, changeRanges } from '../word-diff';

/** 원문 재구성 테스트용 최소 패치를 만든다. */
function patch(hunks: Hunk[] = []): FileDiff {
  return {
    oldPath: 'old.txt',
    newPath: 'new.txt',
    change: { kind: 'modified' },
    binary: null,
    truncated: false,
    nonUtf8: false,
    totalLines: hunks.reduce((n, h) => n + h.lines.length, 0),
    hunks,
  };
}

/** 행 중 각 원문의 실제 텍스트와 줄번호를 읽는다. */
function sources(value: ReturnType<typeof buildDocumentRows>) {
  const rows = value.filter((row) => row.kind === 'split');
  return {
    old: rows.flatMap((row) => (row.left ? [[row.left.line.oldNo, row.left.line.text]] : [])),
    new: rows.flatMap((row) => (row.right ? [[row.right.line.newNo, row.right.line.text]] : [])),
  };
}

/** 지정 위치의 한 줄 변경 hunk를 만든다. */
function replacement(at: number): Hunk {
  return {
    oldStart: at,
    oldLines: 1,
    newStart: at,
    newLines: 1,
    section: '',
    lines: [
      { kind: 'del', oldNo: at, newNo: null, text: 'old', noNewline: false },
      { kind: 'add', oldNo: null, newNo: at, text: 'new', noNewline: false },
    ],
  };
}

describe('전체 파일 표시 행', () => {
  it('멀리 떨어진 구간 사이의 원문을 복원하고 Git 부분 작업 인덱스를 보존한다', () => {
    const old = ['before', 'old', 'middle1', 'middle2', 'old', 'after'];
    const next = ['before', 'new', 'middle1', 'middle2', 'new', 'after'];
    const rows = buildDocumentRows(
      patch([replacement(2), replacement(5)]),
      old.join('\n'),
      next.join('\n'),
      'split',
    );
    expect(sources(rows)).toEqual({
      old: old.map((text, i) => [i + 1, text]),
      new: next.map((text, i) => [i + 1, text]),
    });
    expect(rows.filter((row) => row.kind === 'hunk').map((row) => row.hunk)).toEqual([0, 1]);
    const changed = rows
      .filter((row) => row.kind === 'split')
      .filter((row) => row.left?.line.kind === 'del');
    expect(changed.map((row) => [row.left?.hunk, row.left?.index, row.right?.index])).toEqual([
      [0, 0, 1],
      [1, 0, 1],
    ]);
    expect(
      rows
        .filter((row) => row.kind === 'split')
        .filter((row) => row.left?.line.kind === 'context')
        .every((row) => (row.left?.hunk ?? 0) < 0),
    ).toBe(true);
  });

  it('공백 무시로 패치가 없어져도 좌우의 공백·탭·CRLF·마지막 개행 상태를 보존한다', () => {
    const rows = buildDocumentRows(patch(), '\t a\r\n끝', ' a\n끝\n', 'split');
    expect(sources(rows)).toEqual({
      old: [
        [1, '\t a\r'],
        [2, '끝'],
      ],
      new: [
        [1, ' a'],
        [2, '끝'],
      ],
    });
    const last = rows.at(-1);
    expect(last?.kind === 'split' && last.left?.line.noNewline).toBe(true);
    expect(last?.kind === 'split' && last.right?.line.noNewline).toBe(false);
    const unified = buildDocumentRows(patch(), ' a\n', '\ta\n', 'unified');
    expect(unified.filter((row) => row.kind === 'line').map((row) => row.ref.line.text)).toEqual([
      ' a',
      '\ta',
    ]);
  });

  it('추가·삭제·빈 파일과 파일 끝 삽입의 0줄 hunk를 처리한다', () => {
    const added: Hunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      section: '',
      lines: [{ kind: 'add', oldNo: null, newNo: 1, text: 'added', noNewline: false }],
    };
    expect(sources(buildDocumentRows(patch([added]), '', 'added\n', 'split'))).toEqual({
      old: [],
      new: [[1, 'added']],
    });
    const deleted: Hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
      section: '',
      lines: [{ kind: 'del', oldNo: 1, newNo: null, text: 'gone', noNewline: true }],
    };
    expect(sources(buildDocumentRows(patch([deleted]), 'gone', '', 'split'))).toEqual({
      old: [[1, 'gone']],
      new: [],
    });
    expect(buildDocumentRows(patch(), '', '', 'split')).toEqual([]);
    const appended = {
      ...added,
      oldStart: 1,
      newStart: 2,
      lines: [{ ...added.lines[0], newNo: 2 }],
    } as Hunk;
    expect(
      sources(buildDocumentRows(patch([appended]), 'keep\n', 'keep\nadded\n', 'split')),
    ).toEqual({
      old: [[1, 'keep']],
      new: [
        [1, 'keep'],
        [2, 'added'],
      ],
    });
    expect(sourceLines('\n')).toEqual(['']);
  });

  it('패치의 문맥도 각 원문의 텍스트로 표시한다', () => {
    const h: Hunk = {
      ...replacement(2),
      oldStart: 1,
      newStart: 1,
      oldLines: 2,
      newLines: 2,
      lines: [
        { kind: 'context', text: ' keep', oldNo: 1, newNo: 1, noNewline: false },
        ...replacement(2).lines,
      ],
    };
    expect(sources(buildContextRows(patch([h]), '\tkeep\nold\n', ' keep\nnew\n', 'split'))).toEqual(
      {
        old: [
          [1, '\tkeep'],
          [2, 'old'],
        ],
        new: [
          [1, ' keep'],
          [2, 'new'],
        ],
      },
    );
    expect(
      sources(buildDocumentRows(patch([h]), '\tkeep\nold\n', ' keep\nnew\n', 'split')),
    ).toEqual({
      old: [
        [1, '\tkeep'],
        [2, 'old'],
      ],
      new: [
        [1, ' keep'],
        [2, 'new'],
      ],
    });
  });
});

describe('글자 강조', () => {
  it.each([
    ['x👩‍💻y', 'x👨‍💻y', '👩‍💻', '👨‍💻'],
    ['x가y', 'x거y', '가', '거'],
    ['a가b', 'a나b', '가', '나'],
  ])('문자 경계를 보존한다: %s', (old, next, del, add) => {
    const ranges = changeRanges(old, next, 'character');
    expect(ranges.del.map(([a, b]) => old.slice(a, b)).join('')).toBe(del);
    expect(ranges.add.map(([a, b]) => next.slice(a, b)).join('')).toBe(add);
    expect(
      applyRanges([{ text: next, cls: 'tok-string' }], ranges.add)
        .map((piece) => piece.text)
        .join(''),
    ).toBe(next);
  });

  it('줄 모드와 계산 제한은 줄 배경만 사용한다', () => {
    expect(changeRanges('old', 'new', 'line')).toEqual({ del: [], add: [] });
    expect(changeRanges('a'.repeat(20001), 'b', 'character')).toEqual({ del: [], add: [] });
    expect(changeRanges('', 'new', 'character').add).toEqual([[0, 3]]);
  });
});

describe('패널별 텍스트 복사', () => {
  it('순방향·역방향 드래그 모두 반대 패널과 거터를 제외한다', () => {
    const rows = buildDocumentRows(
      patch([replacement(2)]),
      'keep\nold\nafter\n',
      'keep\nnew\nafter\n',
      'split',
    );
    const first = { row: 0, offset: 2 };
    const last = { row: 3, offset: 3 };
    expect(selectedText(rows, first, last, 'left')).toBe('ep\nold\naft');
    expect(selectedText(rows, last, first, 'right')).toBe('ep\nnew\naft');
  });
});
