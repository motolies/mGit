import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDENT_UNIT,
  detectIndentUnit,
  indentUnitFor,
  requiresTabs,
} from '../features/workspace/editor/indentation';

describe('들여쓰기 감지', () => {
  it('공백 2칸·4칸 파일은 이웃 줄의 칸 수 차이로 정한다', () => {
    expect(detectIndentUnit('{\n  "a": {\n    "b": 1\n  }\n}\n')).toBe('  ');
    expect(detectIndentUnit('server:\n  port: 80\n  hosts:\n    - a\n    - b\n')).toBe('  ');
    expect(detectIndentUnit('def f():\n    if x:\n        return 1\n    return 2\n')).toBe('    ');
  });

  it('블록 주석의 1칸 정렬은 더 넓은 차이가 있으면 무시한다', () => {
    const text = [
      'class A {',
      '    /**',
      '     * 설명',
      '     */',
      '    run() {',
      '        go();',
      '    }',
      '}',
    ].join('\n');
    expect(detectIndentUnit(text)).toBe('    ');
  });

  it('탭으로 시작하는 줄이 많으면 탭, 탭 줄과 공백 줄이 같으면 판단하지 않는다', () => {
    expect(detectIndentUnit('func a() {\n\tif x {\n\t\treturn\n\t}\n}\n')).toBe('\t');
    expect(detectIndentUnit('a\n\tb\n  c\n')).toBeNull();
    expect(detectIndentUnit('a\n\tb\n\tc\n  d\n')).toBe('\t');
  });

  it('들여쓰기가 없거나 빈 줄뿐이면 판단하지 않는다', () => {
    expect(detectIndentUnit('')).toBeNull();
    expect(detectIndentUnit('# 제목\n\n본문 문장입니다.\n')).toBeNull();
    expect(detectIndentUnit('a\n   \n\t\nb\n')).toBeNull();
  });

  it('빈 줄과 공백만 있는 줄은 이웃 관계를 끊지 않고, CRLF 원문도 같게 읽는다', () => {
    expect(detectIndentUnit('a:\n  b: 1\n\n      \n  c: 2\nd:\n  e: 3\n')).toBe('  ');
    expect(detectIndentUnit('a:\r\n  b: 1\r\n  \r\nc:\r\n  d: 2\r\n')).toBe('  ');
  });

  it('8칸보다 넓은 정렬 차이와 공백 뒤에 탭이 섞인 줄은 근거로 쓰지 않는다', () => {
    const text = [
      'call(first,',
      '                   second)',
      'block:',
      '  inner',
      '  \tmixed',
      'other:',
      '  inner',
    ].join('\n');
    expect(detectIndentUnit(text)).toBe('  ');
  });

  it('Makefile 계열은 내용과 상관없이 탭, 그 밖에는 감지 실패 시 기본값(공백 2칸)', () => {
    for (const path of [
      'Makefile',
      'sub/makefile',
      'GNUmakefile',
      'Makefile.am',
      'rules.mk',
      'a.MAK',
    ])
      expect(requiresTabs(path)).toBe(true);
    for (const path of ['Makefile.js', 'make.md', 'mk', 'README.md'])
      expect(requiresTabs(path)).toBe(false);
    expect(indentUnitFor('Makefile', 'all:\n    echo hi\n')).toBe('\t');
    expect(indentUnitFor('notes.md', '본문\n')).toBe(DEFAULT_INDENT_UNIT);
    expect(DEFAULT_INDENT_UNIT).toBe('  ');
    expect(indentUnitFor('a.py', 'if x:\n    y\n')).toBe('    ');
  });
});
