import { describe, expect, it } from 'vitest';
import { highlightHunk, parserFor, tokenize } from '../highlight';

describe('highlight', () => {
  it('확장자로 언어를 찾아 토큰을 만든다', async () => {
    const parser = await parserFor('src/main.rs');
    expect(parser).not.toBeNull();
    if (!parser) {
      return;
    }
    const lines = tokenize(parser, 'fn main() {\n  let x = 1;\n}');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.map((s) => s.text).join('')).toBe('fn main() {');
    expect(lines[0]?.some((s) => s.cls.includes('tok-keyword'))).toBe(true);
    expect(lines[1]?.map((s) => s.text).join('')).toBe('  let x = 1;');
  });

  it('모르는 확장자는 null', async () => {
    expect(await parserFor('weird.zzz')).toBeNull();
  });

  it('hunk 는 새 쪽·옛 쪽을 따로 파싱해 줄마다 맞는 조각을 준다', async () => {
    const parser = await parserFor('a.js');
    expect(parser).not.toBeNull();
    if (!parser) {
      return;
    }
    const map = highlightHunk(parser, {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      section: '',
      lines: [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'const a = 1;', noNewline: false },
        { kind: 'del', oldNo: 2, newNo: null, text: 'return a;', noNewline: false },
        { kind: 'add', oldNo: null, newNo: 2, text: 'return a + 1;', noNewline: false },
      ],
    });
    expect(
      map
        .get(0)
        ?.map((s) => s.text)
        .join(''),
    ).toBe('const a = 1;');
    expect(
      map
        .get(1)
        ?.map((s) => s.text)
        .join(''),
    ).toBe('return a;');
    expect(
      map
        .get(2)
        ?.map((s) => s.text)
        .join(''),
    ).toBe('return a + 1;');
  });
});
