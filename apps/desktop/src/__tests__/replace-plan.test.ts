import type { ReplaceFilePreview, ReplacePreview } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  holdDrafts,
  lineSegments,
  replaceChoices,
  replaceReport,
  selectionTotals,
  toggleFile,
  toggleMatch,
  undoReport,
} from '../features/search/replace';

/** 일치 둘인 줄 하나와 보이지 않는 줄을 가진 파일 */
const fileA: ReplaceFilePreview = {
  path: 'app/a.ts',
  repo: 'app',
  revision: 'ra',
  matches: 3,
  hiddenLines: 1,
  lines: [
    {
      line: 4,
      text: 'let foo_1 = foo_2;',
      cutStart: false,
      cutEnd: false,
      hidden: 0,
      matches: [
        { index: 0, start: 4, end: 9, replacement: 'bar1' },
        { index: 1, start: 12, end: 17, replacement: 'bar2' },
      ],
    },
  ],
};
const fileB: ReplaceFilePreview = {
  path: 'b.ts',
  repo: '',
  revision: 'rb',
  matches: 1,
  hiddenLines: 0,
  lines: [
    {
      line: 1,
      text: 'foo_9',
      cutStart: false,
      cutEnd: false,
      hidden: 0,
      matches: [{ index: 0, start: 0, end: 5, replacement: '' }],
    },
  ],
};
const preview: ReplacePreview = {
  files: [fileA, fileB],
  excluded: [],
  unreadable: 0,
  truncated: false,
  cancelled: false,
};

describe('여러 파일 바꾸기 선택', () => {
  it('처음에는 모두 바꾸고, 끈 일치 순번과 revision 을 파일마다 보낸다', () => {
    expect(selectionTotals(preview, EMPTY_SELECTION)).toEqual({ files: 2, matches: 4 });
    const off = toggleMatch(EMPTY_SELECTION, 'app/a.ts', 1);
    expect(selectionTotals(preview, off)).toEqual({ files: 2, matches: 3 });
    expect(replaceChoices(preview, off)).toEqual([
      { path: 'app/a.ts', revision: 'ra', excluded: [1] },
      { path: 'b.ts', revision: 'rb', excluded: [] },
    ]);
    // 다시 켜면 빈 목록이 지워진다
    expect(toggleMatch(off, 'app/a.ts', 1).matches.size).toBe(0);
  });

  it('파일 체크를 끄거나 모든 일치를 끈 파일은 보내지 않는다 (보이지 않는 일치가 남으면 보낸다)', () => {
    const noB = toggleFile(EMPTY_SELECTION, 'b.ts');
    expect(replaceChoices(preview, noB).map((c) => c.path)).toEqual(['app/a.ts']);
    const allOffB = toggleMatch(EMPTY_SELECTION, 'b.ts', 0);
    expect(replaceChoices(preview, allOffB).map((c) => c.path)).toEqual(['app/a.ts']);
    // a 는 보이는 일치 둘을 꺼도 보이지 않는 줄의 일치 하나가 남는다
    const visibleOff = toggleMatch(toggleMatch(EMPTY_SELECTION, 'app/a.ts', 0), 'app/a.ts', 1);
    expect(replaceChoices(preview, visibleOff)[0]).toEqual({
      path: 'app/a.ts',
      revision: 'ra',
      excluded: [0, 1],
    });
    expect(toggleFile(noB, 'b.ts').files.size).toBe(0);
  });

  it('적용 직전 초안이 생긴 파일은 보내지 않고 draft 로 건너뛴다', () => {
    const { send, held } = holdDrafts(replaceChoices(preview, EMPTY_SELECTION), ['b.ts']);
    expect(send.map((c) => c.path)).toEqual(['app/a.ts']);
    expect(held).toEqual([{ kind: 'skipped', path: 'b.ts', reason: 'draft' }]);
  });

  it('줄 조각: 전은 모든 일치를 지우고, 후는 켠 일치만 바꾼다 (빈 글자로 바꾸면 들어가는 조각이 없다)', () => {
    const line = fileA.lines[0];
    if (!line) throw new Error('줄이 있어야 한다');
    const { before, after } = lineSegments(line, new Set([1]));
    expect(before.map((p) => [p.kind, p.text])).toEqual([
      ['same', 'let '],
      ['del', 'foo_1'],
      ['same', ' = '],
      ['del', 'foo_2'],
      ['same', ';'],
    ]);
    expect(after.map((p) => [p.kind, p.text])).toEqual([
      ['same', 'let '],
      ['ins', 'bar1'],
      ['same', ' = '],
      ['same', 'foo_2'],
      ['same', ';'],
    ]);
    const empty = fileB.lines[0];
    if (!empty) throw new Error('줄이 있어야 한다');
    expect(lineSegments(empty, undefined).after).toEqual([]);
  });

  it('결과 요약은 바꾼 수·건너뜀·실패를 나누고 바꾼 파일만 되돌리기 요청으로 만든다', () => {
    const report = replaceReport([
      { kind: 'applied', path: 'app/a.ts', replaced: 2, backup: 7, revision: 'na' },
      { kind: 'skipped', path: 'b.ts', reason: 'changed' },
      { kind: 'failed', path: 'c.ts', message: 'File is read-only' },
    ]);
    expect(report.files).toBe(1);
    expect(report.matches).toBe(2);
    expect(report.undo).toEqual([{ path: 'app/a.ts', backup: 7, revision: 'na' }]);
    expect(report.skipped.map((o) => o.reason)).toEqual(['changed']);
    expect(report.failed.map((o) => o.path)).toEqual(['c.ts']);
    expect(
      undoReport([
        { kind: 'restored', path: 'app/a.ts' },
        { kind: 'skipped', path: 'b.ts', reason: 'changed' },
        { kind: 'failed', path: 'c.ts', message: 'x' },
      ]),
    ).toEqual({
      restored: 1,
      changed: ['b.ts'],
      failed: [{ kind: 'failed', path: 'c.ts', message: 'x' }],
    });
  });
});
