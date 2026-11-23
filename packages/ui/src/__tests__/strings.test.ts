import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { ko } from '../i18n/ko';
import * as ui from '../index';
import { getLocale, type Locale } from '../locale';
import { S, type Strings, setStringsLocale } from '../strings';

describe('문구 사전 진입점 (S)', () => {
  // 다른 테스트는 한국어를 전제로 한다
  afterEach(() => setStringsLocale('ko'));

  it('기본 사전은 한국어 사전 그 자체다', () => {
    expect(getLocale()).toBe('ko');
    expect(S).toBe(ko);
    expect(ui.S).toBe(ko);
  });

  it('setStringsLocale 은 포맷 언어와 사전을 함께 바꾸고, 재수출(index)로 읽어도 같은 사전을 본다', () => {
    // 등록되지 않은 언어는 한국어 사전으로 대신한다
    setStringsLocale('fr' as Locale);
    expect(getLocale()).toBe('fr');
    expect(S).toBe(ko);

    ui.setStringsLocale('ko');
    expect(getLocale()).toBe('ko');
    expect(ui.getLocale()).toBe('ko');
    expect(S).toBe(ko);
    // ESM 라이브 바인딩: 진입점의 `S` 와 재수출된 `S` 가 같은 값이다
    expect(ui.S).toBe(S);
    expect(ui.S.status.loaded(12_345)).toBe('commit 12,345개');
  });

  it('Strings 는 리터럴을 string 으로 넓히고 함수 인자는 그대로 둔다', () => {
    expectTypeOf<Strings['app']['title']>().toEqualTypeOf<string>();
    expectTypeOf<Strings['status']['loaded']>().toEqualTypeOf<(n: number) => string>();
    expectTypeOf<Strings['filterBar']['dates']['dayWithYear']>().toEqualTypeOf<
      (year: number, month: number, day: number) => string
    >();
    expectTypeOf(ko).toExtend<Strings>();
    expectTypeOf(S).toEqualTypeOf<Strings>();
  });
});
