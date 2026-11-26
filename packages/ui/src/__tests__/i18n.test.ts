import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import {
  formatCommitDate,
  formatFileDate,
  formatNumber,
  getLocale,
  S,
  setStringsLocale,
} from '../index';

/** 한글 자모·음절 */
const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** 원어로 쓰는 언어 이름의 키 경로 (`i18n/language-names.ts`). 어느 사전에서나 같은 값이라 영어 사전에도 한글이 있다 */
const ENDONYM_PATHS: ReadonlySet<string> = new Set(['settings.languageKo', 'settings.languageEn']);

/** 사전을 펼쳐 키 경로 → 값 종류(`string`·`object`·`function/<인자 수>`)로 적는다 */
function shapeOf(
  node: unknown,
  path = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (typeof node === 'function') {
    // TS 는 인자가 적은 함수의 대입을 막지 않으므로 인자 수는 런타임에 비교한다
    out[path] = `function/${node.length}`;
  } else if (typeof node === 'object' && node !== null) {
    out[path || '(root)'] = 'object';
    for (const [key, value] of Object.entries(node)) {
      shapeOf(value, path ? `${path}.${key}` : key, out);
    }
  } else {
    out[path] = typeof node;
  }
  return out;
}

/**
 * 매개변수 타입을 모르는 채로 함수마다 넣어 볼 표본 값. 각 값을 모든 인자 자리에 똑같이 넣는다. 분기(서명 코드·변경
 * 종류·PR 상태·null·0·빈 문자열·참거짓)를 두루 지나게 고른다
 */
const SAMPLE_VALUES: readonly unknown[] = [
  0,
  1,
  2,
  12_345,
  'x',
  '',
  true,
  false,
  null,
  ['a', 'b'],
  [3, 4],
  // 서명 코드 (detail.signatureCode)
  'G',
  'B',
  'U',
  'X',
  'Y',
  'R',
  'E',
  // 변경 종류 (diff.change)
  { kind: 'added' },
  { kind: 'deleted' },
  { kind: 'renamed', similarity: 90 },
  { kind: 'copied', similarity: 50 },
  { kind: 'typeChanged' },
  // PR 리뷰·검사 상태와 호스팅 종류 (pr.*)
  'approved',
  'changes_requested',
  'review_required',
  'success',
  'failure',
  'gitlab',
];

/** 인자마다 종류가 다른 함수(명령 인자 배열 + stderr, 경로 + 저장소 목록)를 위한 섞인 인자 */
const MIXED_ARGS: readonly (readonly unknown[])[] = [
  [['fetch', '--all'], 'fatal: x'],
  [['fetch', '--all'], ''],
  ['/work', ['a', 'b']],
];

/**
 * 사전의 모든 문자열 값과, 모든 함수를 표본 인자로 부른 결과를 (경로, 문구) 로 모은다. 인자 모양이 안 맞아 던지는
 * 호출은 건너뛰고, 한 번도 문자열을 돌려주지 못한 함수 경로는 `uncalled` 로 따로 돌려준다 (표본이 모자란 함수)
 */
function renderAll(dict: unknown): { texts: [string, string][]; uncalled: string[] } {
  const texts: [string, string][] = [];
  const uncalled: string[] = [];
  const argSets = [...SAMPLE_VALUES.map((v) => [v, v, v, v]), ...MIXED_ARGS];
  /** 한 노드를 펼쳐 문구를 모은다 */
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      texts.push([path, node]);
    } else if (typeof node === 'function') {
      let rendered = 0;
      for (const args of argSets) {
        try {
          const text: unknown = node(...args);
          if (typeof text === 'string') {
            texts.push([path, text]);
            rendered++;
          }
        } catch {
          // 이 표본은 인자 모양이 맞지 않는다
        }
      }
      if (rendered === 0) {
        uncalled.push(path);
      }
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        visit(value, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(dict, '');
  return { texts, uncalled };
}

describe('영어 사전 (L2)', () => {
  it('ko 와 키 경로·값 종류·함수 인자 수가 같다', () => {
    expect(shapeOf(en)).toEqual(shapeOf(ko));
  });

  it('모든 문자열 값과 함수 결과에 한글이 없다 (원어로 쓰는 언어 이름은 빼고)', () => {
    const { texts, uncalled } = renderAll(en);
    expect(uncalled).toEqual([]);
    const withHangul = texts
      .filter(([path, text]) => !ENDONYM_PATHS.has(path) && HANGUL.test(text))
      .map(([p, t]) => `${p}: ${t}`);
    expect(withHangul).toEqual([]);
  });

  it('언어 이름은 두 사전에서 같은 원어 표기다', () => {
    expect(en.settings.languageKo).toBe(ko.settings.languageKo);
    expect(en.settings.languageEn).toBe(ko.settings.languageEn);
    expect(ko.settings.languageKo).toBe('한국어');
    expect(en.settings.languageEn).toBe('English');
  });

  it('검사가 헛돌지 않는다: 같은 표본으로 ko 를 부르면 모든 함수가 불리고 한글이 잡힌다', () => {
    const { texts, uncalled } = renderAll(ko);
    expect(uncalled).toEqual([]);
    expect(texts.some(([path, text]) => path === 'status.loaded' && HANGUL.test(text))).toBe(true);
  });
});

describe('언어 전환 (setStringsLocale)', () => {
  // 다른 테스트는 한국어를 전제로 한다
  afterEach(() => setStringsLocale('ko'));

  it('en 으로 바꾸면 재수출(index)된 S 가 영어 사전이고 언어·숫자 포맷도 영어다', () => {
    setStringsLocale('en');
    expect(S).toBe(en);
    expect(getLocale()).toBe('en');
    expect(formatNumber(1234)).toBe('1,234');
    expect(S.status.loaded(1)).toBe('1 commit');
    expect(S.status.loaded(12_345)).toBe('12,345 commits');
    expect(S.commitTool.targets(1, 2)).toBe('1 repo · 2 files');

    setStringsLocale('ko');
    expect(S).toBe(ko);
    expect(getLocale()).toBe('ko');
    expect(S.status.loaded(12_345)).toBe('커밋 12,345개');
  });

  it('영어 상대 날짜·날짜 포맷: S.date 를 넘긴 formatCommitDate·formatFileDate', () => {
    setStringsLocale('en');
    /** 로컬 시간대의 시각 (ms) */
    const at = (day: number, hour: number, minute: number) =>
      new Date(2026, 10, day, hour, minute).getTime();
    const NOW = at(18, 14, 50);
    /** `NOW` 에서 본 `then` 의 로그 날짜 */
    const show = (then: number) => formatCommitDate(then / 1000, NOW, S.date);

    expect(show(NOW - 30_000)).toBe('Just now');
    expect(show(NOW - 7 * 60_000)).toBe('7 min ago');
    // ICU 판에 따라 시각과 AM/PM 사이가 일반 공백 또는 좁은 공백(U+202F)이다
    expect(show(at(18, 10, 21))).toMatch(/^Today 10:21\sAM$/);
    expect(show(at(17, 18, 5))).toMatch(/^Yesterday 6:05\sPM$/);
    expect(show(at(11, 14, 50))).toMatch(/^11\/11\/2026, 2:50\sPM$/);
    expect(formatFileDate(at(18, 9, 5), NOW, S.date)).toMatch(/^Today 9:05\sAM$/);
    // 날짜 필터의 범위 표기: 월/일, 다른 해면 월/일/연, 사이는 en dash
    const { dates } = S.filterBar;
    expect(dates.range(dates.day(10, 28), dates.dayWithYear(2025, 11, 3))).toBe(
      '10/28 – 11/3/2025',
    );
  });
});
