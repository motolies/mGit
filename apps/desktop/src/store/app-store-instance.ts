import {
  createMockClient,
  createTauriClient,
  type MockSceneName,
  parseMockScene,
  pickDirectory,
} from '@mgit/ipc';
import { settingsStorage } from '@mgit/storage';
import { S } from '@mgit/ui';
import { runtimeProfile } from '../runtime';
import { createAppStore } from './app-store';

/** 명시된 목 행 수를 사용하고 TEST 환경의 기본값은 100, 그 외는 0이다. */
export function mockRowCount(): number {
  const raw = import.meta.env.VITE_MGIT_MOCK;
  const n = raw ? Number(raw) : runtimeProfile().kind === 'test' ? 100 : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 실행 중에 장면을 고르는 저장 키 (`folder | repo | conflict | none`). 새로 고침만으로 장면을 바꿀 때 쓴다 */
const MOCK_SCENE_KEY = 'mgit.mock.scene';

/**
 * `localStorage['mgit.mock.scene']` 의 장면. 없거나 읽을 수 없으면 undefined(환경 변수를 따른다), `none` 이면 null
 * (장면 없이 시작 화면), 모르는 값이면 경고하고 undefined
 */
function storedMockScene(): MockSceneName | null | undefined {
  let raw: string | null;
  try {
    raw = settingsStorage.getItem(MOCK_SCENE_KEY) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) {
    return undefined;
  }
  if (raw === 'none') {
    return null;
  }
  const scene = parseMockScene(raw);
  if (!scene) {
    console.warn(
      `${MOCK_SCENE_KEY}="${raw}" is not a known scene (folder | repo | conflict | none)`,
    );
    return undefined;
  }
  return scene;
}

/**
 * 목 모드의 장면. 저장 키 `mgit.mock.scene` 이 있으면 그것, 없으면 `VITE_MGIT_MOCK_SCENE`. 둘 다 없으면 null,
 * 환경 변수가 모르는 값이면 경고하고 null (목 모드에서만 부른다 — 실제 앱 경로는 저장 키를 읽지 않는다)
 */
function mockScene(): MockSceneName | null {
  const stored = storedMockScene();
  if (stored !== undefined) {
    return stored;
  }
  const raw = import.meta.env.VITE_MGIT_MOCK_SCENE;
  const scene = parseMockScene(raw);
  if (raw && !scene) {
    console.warn(`VITE_MGIT_MOCK_SCENE="${raw}" is not a known scene (folder | repo | conflict)`);
  }
  return scene;
}

const mockRows = mockRowCount();

/** 앱 전역 스토어. 목 모드면 코어 대신 합성 그래프(와 장면 데이터)를 쓴다 */
export const useAppStore = createAppStore(
  mockRows > 0
    ? {
        client: createMockClient({ rows: mockRows, scene: mockScene() }),
        pickDirectory: async () => `/mock/repo-${mockRows}`,
      }
    : {
        client: createTauriClient(),
        pickDirectory: (purpose) =>
          pickDirectory(purpose === 'scan' ? S.home.scanTitle : S.toolbar.openRepo),
      },
);
