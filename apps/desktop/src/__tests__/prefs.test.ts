import { describe, expect, it } from 'vitest';
import { readPref, writePref } from '../store/prefs';

describe('사용자 설정 읽기', () => {
  it('배열은 배열로 돌려주고, 모양이 다르면 기본값을 쓴다', () => {
    writePref('test.prefs.array', ['b.ts', 'a.ts']);
    expect(readPref<string[]>('test.prefs.array', [])).toEqual(['b.ts', 'a.ts']);
    writePref('test.prefs.array', { 0: 'x' });
    expect(readPref<string[]>('test.prefs.array', [])).toEqual([]);
  });

  it('객체는 기본값의 키를 유지하고 저장된 값으로 덮는다', () => {
    writePref('test.prefs.object', { b: 2 });
    expect(readPref('test.prefs.object', { a: 1, b: 0 })).toEqual({ a: 1, b: 2 });
  });
});
