import { settingsStorage } from '@mgit/storage';
// 테마(UX-05): 라이트·다크·시스템 연동. 결과는 <html data-theme> 속성으로 적용하고
// tokens.css 의 CSS 변수가 그 속성을 보고 색을 바꾼다.

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'mgit.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 사용자 선호와 시스템 다크 여부로 실제 적용할 테마를 정한다 */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') {
    return systemDark ? 'dark' : 'light';
  }
  return pref;
}

/** 시스템이 다크 모드인지 읽는다. matchMedia 가 없으면 라이트로 본다 */
export function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

/** 결정된 테마를 문서 루트에 적용한다 */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

/** 저장된 선호를 읽는다. 저장소 접근이 막혀 있거나 값이 이상하면 system */
export function loadThemePreference(): ThemePreference {
  try {
    const raw = settingsStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }
  } catch {
    // private 모드 등에서는 localStorage 가 throw 할 수 있다
  }
  return 'system';
}

/** 선호를 저장한다. 실패해도 앱 동작에는 영향이 없으므로 무시한다 */
export function saveThemePreference(pref: ThemePreference): void {
  try {
    settingsStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // 무시
  }
}

/** 시스템 테마 변경을 구독한다. 해제 함수를 돌려준다 */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(DARK_QUERY);
  const handler = (ev: MediaQueryListEvent) => onChange(ev.matches);
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
