import '@mgit/ui/tokens.css';
import './project-drop.css';
import { startPerfRecorder } from './perf';
import { initializeRuntime } from './runtime';

/** 환경별 설정을 읽은 뒤에만 스토어와 앱을 불러오며, 실패 시 기존 설정을 보존한다. */
async function start(): Promise<void> {
  try {
    await initializeRuntime();
    // 개발·테스트 프로필의 성능 기록기는 스토어·React 보다 먼저 건다 (배포 프로필에서는 아무것도 불러오지 않는다)
    await startPerfRecorder();
    const { bootstrap } = await import('./bootstrap');
    await bootstrap();
  } catch (error) {
    console.error('mGit startup failed', error);
    const container = document.getElementById('root');
    if (container) {
      container.textContent = `mGit could not start. Your saved settings have been preserved. ${String(error)}`;
    }
  }
}

void start();
