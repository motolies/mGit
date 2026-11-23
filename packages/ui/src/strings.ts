import { en } from './i18n/en';
import { ko } from './i18n/ko';
import { type Locale, setLocale } from './locale';

// UI 문구의 진입점 (UX-06). 외부 다국어 프레임워크 없이 언어별 사전(`i18n/ko.ts`, `i18n/en/`)을 두고, 화면은 `S.x.y(…)` 로
// 지금 언어의 사전을 읽는다. 한국어 사전 `ko` 의 모양을 넓힌 `Strings` 가 기준 타입이라, 다른 언어 사전에 키가
// 빠지거나 함수 인자가 다르면 타입 검사에서 걸린다. Git 용어(commit, branch 등)는 어느 언어에서나 원어를 유지한다.

/**
 * 사전 값의 타입을 넓힌다: 문자열 리터럴 → `string`, 함수 → 같은 인자에 넓힌 반환, 객체 → 키를 유지한 채 재귀(읽기
 * 전용). 그 밖은 그대로 둔다
 */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends object
      ? { readonly [K in keyof T]: Widen<T[K]> }
      : T;

/** 모든 언어 사전이 따라야 하는 모양 (`ko` 기준) */
export type Strings = Widen<typeof ko>;

/** 언어 → 사전. `Locale` 마다 사전이 있어야 하고, 런타임에 모르는 값이 오면 `ko` 로 대신한다 */
const DICTIONARIES: Record<Locale, Strings> = { ko, en };

/**
 * 지금 언어의 문구 사전. ESM 라이브 바인딩이라 `setStringsLocale` 뒤에는 `import { S }` 한 모든 곳(재수출 포함)이
 * 새 사전을 본다. 모듈 최상위에서 `S.x` 를 미리 읽어 두면 언어가 바뀌어도 옛 값이 남으니 쓰는 시점에 읽는다
 */
export let S: Strings = ko;

/** UI 언어를 바꾼다: 날짜·숫자 포맷의 언어(`setLocale`)와 문구 사전 `S` 를 함께 바꾼다 */
export function setStringsLocale(l: Locale): void {
  setLocale(l);
  S = DICTIONARIES[l] ?? ko;
}
