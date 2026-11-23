import type { ConflictDoc } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { buildResultDoc, markerLineNumbers, plainDoc, sideDoc, toFileText } from '../model';

const DOC: ConflictDoc = {
  eol: 'lf',
  trailingNewline: true,
  blocks: [
    { kind: 'clean', lines: ['a'] },
    {
      kind: 'conflict',
      ours: ['O1', 'O2'],
      base: ['B'],
      theirs: ['T'],
      labels: ['main', 'base', 'other'],
    },
    { kind: 'clean', lines: ['c'] },
    { kind: 'conflict', ours: [], base: ['x'], theirs: ['T2'], labels: ['main', 'base', 'other'] },
    { kind: 'clean', lines: ['z'] },
  ],
};

describe('buildResultDoc', () => {
  it('미해결 블록은 마커로, 해결 블록은 줄로 바꾸고 범위를 돌려준다', () => {
    const r = buildResultDoc(DOC, []);
    expect(r.text).toBe(
      'a\n<<<<<<< main\nO1\nO2\n||||||| base\nB\n=======\nT\n>>>>>>> other\nc\n<<<<<<< main\n||||||| base\nx\n=======\nT2\n>>>>>>> other\nz',
    );
    expect(r.ranges).toHaveLength(2);
    const first = r.ranges[0];
    expect(first && r.text.slice(first.from, first.to)).toBe(
      '<<<<<<< main\nO1\nO2\n||||||| base\nB\n=======\nT\n>>>>>>> other',
    );

    const picked = buildResultDoc(DOC, ['ours', 'theirs']);
    expect(picked.text).toBe('a\nO1\nO2\nc\nT2\nz');
    expect(picked.ranges.map((x) => picked.text.slice(x.from, x.to))).toEqual(['O1\nO2', 'T2']);

    // 빈 선택은 길이 0 범위 (앞 줄 끝)
    const empty = buildResultDoc(DOC, ['theirs', 'ours']);
    expect(empty.text).toBe('a\nT\nc\nz');
    expect(empty.ranges[1]).toMatchObject({ from: 5, to: 5 });
  });
});

describe('toFileText', () => {
  it('원본 줄 끝과 끝 줄바꿈을 따른다', () => {
    expect(toFileText('a\nb', { eol: 'crLf', trailingNewline: true })).toBe('a\r\nb\r\n');
    expect(toFileText('a\nb\n', { eol: 'lf', trailingNewline: false })).toBe('a\nb');
    expect(toFileText('', { eol: 'lf', trailingNewline: true })).toBe('');
  });
});

describe('줄끝이 섞인 문서', () => {
  // 코어는 CRLF·LF 가 섞인 파일의 줄에 `\r` 을 남기고 eol 을 lf 로 준다
  const MIXED: ConflictDoc = {
    eol: 'lf',
    trailingNewline: true,
    blocks: [
      { kind: 'clean', lines: ['first', 'second\r'] },
      {
        kind: 'conflict',
        ours: ['o\r'],
        base: [],
        theirs: ['t'],
        labels: ['main', 'base', 'other'],
      },
      { kind: 'clean', lines: ['last\r', 'end'] },
    ],
  };

  it('편집기용 문서에는 \\r 이 없어 범위 오프셋이 어긋나지 않는다', () => {
    const r = buildResultDoc(plainDoc(MIXED), ['ours']);
    expect(r.text).toBe('first\nsecond\no\nlast\nend');
    const first = r.ranges[0];
    expect(first && r.text.slice(first.from, first.to)).toBe('o');
  });

  it('고치지 않은 줄의 줄끝을 줄마다 되살린다', () => {
    expect(toFileText('first\nsecond\no\nlast\nend', MIXED)).toBe(
      'first\nsecond\r\no\r\nlast\r\nend\n',
    );
    expect(toFileText('first\nsecond\nt\nlast\nend', MIXED)).toBe(
      'first\nsecond\r\nt\nlast\r\nend\n',
    );
  });

  it('새로 쓴 줄은 앞 줄의 줄끝을 따른다', () => {
    expect(toFileText('first\nsecond\nnew\nlast\nend', MIXED)).toBe(
      'first\nsecond\r\nnew\r\nlast\r\nend\n',
    );
  });
});

describe('sideDoc / markerLineNumbers', () => {
  it('열 텍스트와 블록 줄 범위를 만든다', () => {
    const ours = sideDoc(DOC, 'ours');
    expect(ours.text).toBe('a\nO1\nO2\nc\nz');
    expect(ours.blockLines).toEqual([
      { index: 0, from: 2, to: 3 },
      { index: 1, from: 5, to: 5 },
    ]);
    expect(markerLineNumbers('x\n<<<<<<< a\ny\n=======\n>>>>>>> b\n<<<<<<<< eight\n')).toEqual([
      2, 5,
    ]);
  });

  it('정상 문서에 있을 수 있는 ======= · ||||||| 줄은 마커로 세지 않는다', () => {
    expect(markerLineNumbers('Title\n=======\n\n||||||| note\nbody')).toEqual([]);
  });
});
