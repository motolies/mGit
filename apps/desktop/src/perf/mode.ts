// 성능 기록기를 켜는 조건 (반응성 측정 M1). 배포 프로필의 네이티브 앱에서는 기록기 모듈을 불러오지도 않는다.

/** 기록 방식: 개발·테스트 네이티브 앱은 파일, 목·개발 서버(웹)는 메모리, 그 밖은 끔 */
export type PerfMode = 'file' | 'memory' | null;

export interface PerfModeInput {
  /** Tauri 안에서 도는지 */
  native: boolean;
  /** 실행 프로필 종류 */
  profile: 'production' | 'development' | 'test';
  /** 목 모드(`VITE_MGIT_MOCK`) 빌드인지 */
  mock: boolean;
  /** Vite 개발 서버인지 */
  dev: boolean;
  /** `localStorage['mgit.perf']` 값 ('0' 이면 끈다) */
  stored: string | null;
}

/** 켜는 조건을 정한다. 네이티브 배포 프로필은 어떤 값으로도 켜지지 않는다 */
export function perfMode(input: PerfModeInput): PerfMode {
  if (input.stored === '0') return null;
  if (input.native) return input.profile === 'production' ? null : 'file';
  return input.mock || input.dev ? 'memory' : null;
}

/**
 * 그리기 자가 진단을 켜는 설정 키 (반응성 G). 개발 프로필은 환경 폴더의 `ui-settings.json`, 목 미리보기는 localStorage 에서
 * 읽는다(`@mgit/storage` 의 `settingsStorage`). 값은 `selftest.ts` 의 `parseSelftest`
 */
export const SELFTEST_KEY = 'mgit.perf.selftest';

/** 저장소 값을 읽는다 (사생활 보호 모드 등으로 못 읽으면 null) */
export function readSwitch(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
