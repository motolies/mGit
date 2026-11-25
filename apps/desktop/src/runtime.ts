import type { RuntimeProfile } from '@mgit/ipc';
import { createSettingsStorage, installSettingsStorage, parseSnapshot } from '@mgit/storage';
import { invoke, isTauri } from '@tauri-apps/api/core';

let profile: RuntimeProfile = { kind: 'production', id: 'production', title: 'mGit' };

/** 초기화가 끝난 뒤 앱과 목 데이터 선택에서 같은 실행 환경을 참조한다. */
export function runtimeProfile(): RuntimeProfile {
  return profile;
}

/** 목 모드와 무관하게 네이티브 창 수명 주기를 처리한다. */
export function isNativeRuntime(): boolean {
  return isTauri();
}

/** 개발 서버의 응답 오류를 설정 없음으로 처리하지 않는다. */
async function readDevelopmentResource(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot read ${path}: ${response.status}`);
  return response.json();
}

/** 서버/네이티브에서 검증된 실행 환경만 UI에 반영한다. */
function parseProfile(value: unknown): RuntimeProfile {
  const candidate = value as Partial<RuntimeProfile> | null;
  if (
    !candidate ||
    !['production', 'development', 'test'].includes(candidate.kind ?? '') ||
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string'
  ) {
    throw new Error('Invalid runtime profile');
  }
  return candidate as RuntimeProfile;
}

/** 스토어와 bootstrap 모듈을 로드하기 전에 환경과 동기 저장소를 준비한다. */
export async function initializeRuntime(): Promise<void> {
  const native = isNativeRuntime();
  if (native) {
    profile = parseProfile(await invoke('runtime_profile'));
  } else if (import.meta.env.DEV) {
    profile = parseProfile(await readDevelopmentResource('/__mgit/profile'));
  }
  if (profile.kind !== 'production') {
    const snapshot = parseSnapshot(
      native
        ? await invoke('ui_settings_snapshot')
        : await readDevelopmentResource('/__mgit/settings'),
    );
    installSettingsStorage(
      createSettingsStorage(
        snapshot,
        async (key, value) => {
          if (native) {
            await invoke('ui_settings_set', { key, value });
          } else {
            const response = await fetch('/__mgit/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key, value }),
              keepalive: true,
            });
            if (!response.ok) throw new Error(`Cannot save UI settings: ${response.status}`);
          }
        },
        (error) => {
          console.error('UI settings could not be saved', error);
          window.dispatchEvent(new CustomEvent('mgit-settings-error', { detail: error }));
        },
      ),
    );
  }
  document.title = profile.title;
}
