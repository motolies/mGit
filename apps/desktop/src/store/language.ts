import { settingsStorage } from '@mgit/storage';
import { type Locale, setStringsLocale } from '@mgit/ui';

// 화면 언어 (다국어 L3): 시스템 언어 따름·한국어·영어. 결과는 문구 사전(`S`)·날짜·숫자 포맷과 <html lang> 에 적용하고,
// Rust 문구 언어는 호출하는 쪽이 IPC `setLanguage` 로 맞춘다. 화면을 다시 그리는 일(루트 다시 마운트)도 호출하는 쪽 몫이다.

export type LanguagePreference = 'system' | 'ko' | 'en';

export const LANGUAGE_STORAGE_KEY = 'mgit.language';

/** OS 로캘 읽기의 기본 시간 제한 (ms). 시작할 때 첫 렌더가 이만큼까지 기다릴 수 있다 */
export const SYSTEM_LOCALE_TIMEOUT_MS = 1000;

/**
 * OS 로캘을 읽는다. `timeoutMs` 안에 답이 없거나 실패하면 null (system 선호는 영어로 정해진다). 시간을 넘긴 읽기는
 * 멈추지 않고 결과만 버린다
 */
export function readSystemLocale(
  read: () => Promise<string | null>,
  timeoutMs = SYSTEM_LOCALE_TIMEOUT_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const work = (async () => {
    try {
      return await read();
    } catch {
      return null;
    }
  })();
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 선호와 OS 로캘로 실제 화면 언어를 정한다. system 이면 Rust `Lang::from_code` 와 같은 규칙: 로캘의 언어 부분(`-`·`_`·
 * `.`·`@` 앞)이 대소문자 구분 없이 `ko` 면 한국어, 그 밖(감지 실패 null·빈 값 포함)은 영어. 명시한 선호는 그대로
 */
export function resolveLanguage(pref: LanguagePreference, systemLocale: string | null): Locale {
  if (pref !== 'system') {
    return pref;
  }
  const language = (systemLocale ?? '').trim().split(/[-_.@]/)[0] ?? '';
  // `u` 플래그 없는 `i` 는 ASCII 글자를 ASCII 끼리만 맞춘다 (Rust `eq_ignore_ascii_case` 와 같다)
  return /^ko$/i.test(language) ? 'ko' : 'en';
}

/** 정한 언어를 화면에 적용한다: 문구 사전·포맷 언어를 바꾸고 문서 루트의 `lang` 을 맞춘다 */
export function applyLanguage(locale: Locale): void {
  setStringsLocale(locale);
  document.documentElement.lang = locale;
}

/** 저장된 선호를 읽는다. 저장소 접근이 막혀 있거나 값이 이상하면 system */
export function loadLanguagePreference(): LanguagePreference {
  try {
    const raw = settingsStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (raw === 'system' || raw === 'ko' || raw === 'en') {
      return raw;
    }
  } catch {
    // private 모드 등에서는 localStorage 가 throw 할 수 있다
  }
  return 'system';
}

/** 선호를 저장한다. 실패해도 이번 실행의 언어는 바뀌므로 무시한다 */
export function saveLanguagePreference(pref: LanguagePreference): void {
  try {
    settingsStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
  } catch {
    // 무시
  }
}
