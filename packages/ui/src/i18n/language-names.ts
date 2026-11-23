import type { Locale } from '../locale';

// 언어 이름 (다국어 L3). 언어 고르기에서 각 언어는 화면 언어와 상관없이 그 언어 자신의 이름(원어 표기)으로 보인다. 모든
// 사전에서 같은 값이라 사전마다 번역하지 않고 여기 한 곳에 두고 두 사전이 같은 값을 가리킨다. 사전 밖에 한글이 있는
// 파일이라 한글 리터럴 가드(`i18n-guard.test.ts`)의 제외 목록에 있고, 영어 사전 검사(`i18n.test.ts`)도 이 값만 뺀다.

/** 언어 → 그 언어로 쓴 이름 */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  ko: '한국어',
  en: 'English',
};
