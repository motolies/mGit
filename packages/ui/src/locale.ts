// 현재 UI 언어 상태. 아무것도 import 하지 않아 `format.ts`·`strings.ts` 어느 쪽에서 읽어도 순환이 생기지 않는다.
// 화면 문구까지 함께 바꾸려면 `setLocale` 대신 `strings.ts` 의 `setStringsLocale` 을 부른다.

/** 지원하는 UI 언어 */
export type Locale = 'ko' | 'en';

let current: Locale = 'en';

/** 지금 UI 언어 (기본 `'en'`) */
export function getLocale(): Locale {
  return current;
}

/** UI 언어를 바꾼다. 날짜·숫자 포맷이 다음 호출부터 따른다 */
export function setLocale(l: Locale): void {
  current = l;
}

/** UI 언어 → Intl 로캘 태그 (날짜·숫자 포맷용) */
export function intlLocale(l: Locale = getLocale()): 'ko-KR' | 'en-US' {
  return l === 'ko' ? 'ko-KR' : 'en-US';
}
