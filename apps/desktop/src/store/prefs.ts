import { settingsStorage } from '@mgit/storage';
/** 사용자 설정 (localStorage). private 모드·차단 환경에서는 조용히 기본값을 쓴다 */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = settingsStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== typeof fallback) {
      return fallback;
    }
    // 객체는 기본값의 키를 유지하고 저장된 값으로 덮는다 (새 필드가 생겨도 안전)
    if (typeof fallback === 'object' && fallback !== null && typeof parsed === 'object') {
      return { ...fallback, ...(parsed as object) } as T;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** 설정 저장. 실패는 무시한다 */
export function writePref(key: string, value: unknown): void {
  try {
    settingsStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 무시
  }
}
