// 실제 앱 성능 기록기의 진입점 (반응성 측정 M1). 켜는 조건이 맞을 때만 기록기 모듈을 불러온다.
import { isNativeRuntime, runtimeProfile } from '../runtime';
import { perfMode, readSwitch } from './mode';

/**
 * 실행 환경을 확인한 뒤(`initializeRuntime` 다음), 스토어·React 를 불러오기 전에 부른다 — IPC 관찰자와 렌더 계수 훅이
 * 첫 호출·첫 렌더보다 먼저 걸려야 한다. 설치에 실패해도 앱 시작을 막지 않는다
 */
export async function startPerfRecorder(): Promise<void> {
  const mode = perfMode({
    native: isNativeRuntime(),
    profile: runtimeProfile().kind,
    mock: Boolean(import.meta.env.VITE_MGIT_MOCK),
    dev: import.meta.env.DEV,
    stored: readSwitch('mgit.perf'),
  });
  if (mode === null) return;
  try {
    const { installPerfRecorder } = await import('./install');
    installPerfRecorder(mode, {
      renders: readSwitch('mgit.perf.renders') === '1',
      profile: runtimeProfile().kind,
    });
  } catch (error) {
    console.warn('mGit performance recorder could not start', error);
  }
}
