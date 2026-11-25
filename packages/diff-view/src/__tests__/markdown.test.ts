import type { FileDiff, Hunk } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { isMarkdownPath, languagePath, loadLanguage, parserFor, tokenize } from '../index';
import { highlightDiff } from '../use-highlight';
import type { Span } from '../word-diff';

/** 테스트에서 구문 조각의 토큰 종류를 간단히 확인한다. */
function has(spans: Span[] | undefined, token: string): boolean {
  return spans?.some((span) => span.cls.split(' ').includes(`tok-${token}`)) ?? false;
}

/** 실제 원문 3번째 줄에 변경이 있는 최소 diff를 만든다. */
function patch(old: string, next: string): FileDiff {
  const hunk: Hunk = {
    oldStart: 3,
    newStart: 3,
    oldLines: 1,
    newLines: 1,
    section: '',
    lines: [
      { kind: 'del', oldNo: 3, newNo: null, text: old, noNewline: false },
      { kind: 'add', oldNo: null, newNo: 3, text: next, noNewline: false },
    ],
  };
  return {
    oldPath: 'guide.md',
    newPath: 'guide.md',
    change: { kind: 'modified' },
    binary: null,
    truncated: false,
    nonUtf8: false,
    totalLines: 2,
    hunks: [hunk],
  };
}

describe('공유 Markdown 언어 로더', () => {
  it('최초 동기 파싱부터 SQL 키워드·문자열·주석을 구분한다', async () => {
    const text = "# SQL\n\n```sql\nSELECT 'name' -- comment\nFROM users;\n```";
    const parser = await parserFor('guide.md', [text]);
    expect(parser).not.toBeNull();
    if (!parser) return;
    const lines = tokenize(parser, text);
    expect(has(lines[0], 'heading')).toBe(true);
    expect(has(lines[3], 'keyword')).toBe(true);
    expect(has(lines[3], 'string')).toBe(true);
    expect(has(lines[3], 'comment')).toBe(true);
    expect(lines.map((line) => line.map((span) => span.text).join('')).join('\n')).toBe(text);
  });

  it.each([
    ['js', 'const name = "value";', 'keyword'],
    ['TS', 'const name: string = "value";', 'keyword'],
    ['json', '{"name": "value"}', 'string'],
    ['java', 'public class Example {}', 'keyword'],
    ['yml', 'name: "value"', 'string'],
  ])('기존 주요 언어와 별칭을 공유한다: %s', async (info, code, token) => {
    const text = `\`\`\`${info}\n${code}\n\`\`\``;
    const parser = await parserFor('guide.markdown', [text]);
    expect(parser).not.toBeNull();
    if (!parser) return;
    expect(has(tokenize(parser, text)[1], token)).toBe(true);
    expect(languagePath(info)).not.toBeNull();
  });

  it('GFM 취소선·표·체크리스트와 본문 구문을 파싱한다', async () => {
    const text =
      '# Title\n**bold** *italic* ~~gone~~ [link](https://example.com) `code`\n\n- [x] done\n\n| a | b |\n| - | - |\n| c | d |';
    const parser = await parserFor('readme.mkd', [text]);
    if (!parser) throw new Error('Markdown parser missing');
    const tree = parser.parse(text).toString();
    expect(tree).toContain('Strikethrough');
    expect(tree).toContain('Table');
    expect(tree).toContain('Task');
    const line = tokenize(parser, text)[1];
    for (const token of ['strong', 'emphasis', 'strikethrough', 'link', 'monospace']) {
      expect(has(line, token), token).toBe(true);
    }
  });

  it('미지정·미지원 펜스는 일반 텍스트이며 유사 이름을 추측하지 않는다', async () => {
    for (const info of ['', 'not-sql', 'mermaid']) {
      const text = `\`\`\`${info}\nSELECT 'text';\n\`\`\``;
      const parser = await parserFor('a.md', [text]);
      if (!parser) throw new Error('Markdown parser missing');
      expect(has(tokenize(parser, text)[1], 'keyword')).toBe(false);
      expect(has(tokenize(parser, text)[1], 'string')).toBe(false);
      expect(languagePath(info)).toBeNull();
    }
  });

  it('블록 인용·목록 내부의 펜스도 트리에서 탐지하고 언어 변경을 반영한다', async () => {
    const before = '> ```sql\n> SELECT 1;\n> ```';
    const after = '- ```js\n  const value = 1;\n  ```';
    for (const text of [before, after]) {
      const parser = await parserFor('a.md', [text]);
      if (!parser) throw new Error('Markdown parser missing');
      expect(has(tokenize(parser, text)[1], 'keyword')).toBe(true);
    }
    expect(await loadLanguage('a.md')).toBe(await loadLanguage('b.markdown'));
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('a.mdx')).toBe(false);
    expect(await loadLanguage('a.unknown')).toBeNull();
  });
});

describe('Markdown diff 원문 문맥', () => {
  it('hunk 밖의 펜스와 이전·이후 서로 다른 언어를 정확한 줄에 매핑한다', async () => {
    const old = "SELECT 'old';";
    const next = 'const value = "new";';
    const result = await highlightDiff(patch(old, next), 'guide.md', {
      old: `# Before\n\`\`\`sql\n${old}\n\`\`\``,
      new: `# After\n\`\`\`js\n${next}\n\`\`\``,
    });
    expect(has(result.get(0)?.get(0), 'keyword')).toBe(true);
    expect(has(result.get(0)?.get(1), 'keyword')).toBe(true);
    expect(has(result.get(0)?.get(0), 'string')).toBe(true);
    expect(has(result.get(0)?.get(1), 'string')).toBe(true);
    expect(result.get(-1)?.get(2)).toEqual(result.get(0)?.get(0));
    expect(result.get(-2)?.get(2)).toEqual(result.get(0)?.get(1));
  });

  it('원문 없는 부분 diff에서는 보이지 않는 펜스를 추정하지 않는다', async () => {
    const result = await highlightDiff(patch('SELECT 1;', 'SELECT 2;'), 'guide.md');
    expect(has(result.get(0)?.get(0), 'keyword')).toBe(false);
    expect(has(result.get(0)?.get(1), 'keyword')).toBe(false);
  });

  it('원문 없는 diff에서 확인 가능한 펜스 언어는 먼저 로드한다', async () => {
    const diff = patch('old', 'new');
    const hunk = diff.hunks[0];
    if (!hunk) throw new Error('Test hunk missing');
    hunk.lines = [
      { kind: 'context', oldNo: 1, newNo: 1, text: '```sql', noNewline: false },
      { kind: 'del', oldNo: 2, newNo: null, text: 'SELECT 1;', noNewline: false },
      { kind: 'add', oldNo: null, newNo: 2, text: 'SELECT 2;', noNewline: false },
      { kind: 'context', oldNo: 3, newNo: 3, text: '```', noNewline: false },
    ];
    const result = await highlightDiff(diff, 'guide.md');
    expect(has(result.get(0)?.get(1), 'keyword')).toBe(true);
    expect(has(result.get(0)?.get(2), 'keyword')).toBe(true);
  });

  it('합계 128Ki 문자를 넘는 원문 또는 부분 diff는 강조하지 않는다', async () => {
    const long = 'a'.repeat(65537);
    expect((await highlightDiff(patch('old', 'new'), 'a.md', { old: long, new: long })).size).toBe(
      0,
    );
    expect((await highlightDiff(patch(long, long), 'a.md')).size).toBe(0);
  });

  it('5000줄 제한을 넘는 원문은 hunk 문맥으로 대체하지 않는다', async () => {
    expect(
      (
        await highlightDiff(patch('old', 'new'), 'a.md', {
          old: '\n'.repeat(2500),
          new: '\n'.repeat(2500),
        })
      ).size,
    ).toBe(0);
  });
});
