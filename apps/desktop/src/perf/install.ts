// 성능 기록기 설치 (반응성 측정 M1). `index.ts` 가 켜는 조건을 확인한 뒤에만 불러온다.
import { perfAppend, setIpcObserver } from '@mgit/ipc';
import { settingsStorage } from '@mgit/storage';
import { isNativeRuntime } from '../runtime';
import { viewportOf, watchFrames, watchViewport } from './browser';
import { watchInteractions } from './interaction';
import { type PerfMode, SELFTEST_KEY } from './mode';
import { createRecorder, isSelfCall, type PerfEntry, type PerfRecorder, round } from './recorder';
import { watchCommitTime, watchRenders } from './renders';

/** 개발 도구 콘솔·측정 도구가 읽는 창 전역 (`window.__mgitPerf`) */
export interface PerfHandle {
  mode: Exclude<PerfMode, null>;
  /** 모은 줄 (메모리 모드). 파일 모드는 아직 내보내지 않은 줄 */
  entries(): readonly PerfEntry[];
  /** 시각 `t` 이후의 줄 (`kind` 를 주면 그 종류만) */
  since(t: number, kind?: string): PerfEntry[];
  /** 지금 묶음을 닫고 (파일 모드면) 내보낸다 */
  flush(): Promise<void>;
  /** 메모리 모드의 줄을 비운다 (측정 구간의 시작) */
  clear(): void;
  /** 이번 초의 묶음까지 닫는다 (측정 구간의 끝) */
  cut(): void;
  /**
   * 외부 저장소의 알림 수를 1초 묶음(`stores` 줄: 이름 → 알림 수)으로 센다. 세는 구독자 하나를 더할 뿐 저장소 동작은
   * 바꾸지 않는다. 해제 함수를 준다
   */
  watchStore(name: string, subscribe: (listener: () => void) => () => void): () => void;
  /**
   * 그리기 자가 진단을 지금 돌린다 (반응성 G — 값은 `mgit.perf.selftest` 와 같다: `exit`·`frames=N`·`nowindow`). 시작 뒤 최소
   * 대기는 건너뛰고 앱이 잠잠해지기만 기다린다. 결과는 `selftest` 줄
   */
  selftest(value?: string): Promise<void>;
}

declare global {
  interface Window {
    __mgitPerf?: PerfHandle;
  }
}

/** 기록기를 만들고 IPC 관찰자·프레임·입력(·렌더) 관찰을 건다 */
export function installPerfRecorder(
  mode: Exclude<PerfMode, null>,
  options: { renders: boolean; profile: string },
): PerfRecorder {
  const recorder = createRecorder({
    now: () => performance.now(),
    sink: mode === 'file' ? { write: perfAppend } : null,
  });
  recorder.push({
    t: round(performance.now()),
    kind: 'start',
    wall: Date.now(),
    mode,
    profile: options.profile,
    renders: options.renders,
    userAgent: navigator.userAgent,
    // 창·화면 크기 (F-3): 다시 칠하는 면적을 가늠한다
    viewport: viewportOf(),
  });
  // 마지막 앱 활동(IPC 완료·코어 이벤트) 시각 — 자가 진단이 앱이 잠잠해지기를 기다린다 (기록기 자신의 쓰기는 뺀다)
  const startedAt = performance.now();
  let lastActivity = startedAt;
  setIpcObserver({
    call: (name, start, end, ok) => {
      recorder.ipc(name, start, end, ok);
      if (!isSelfCall(name)) lastActivity = Math.max(lastActivity, end);
    },
    event: (source, type) => {
      recorder.count('events', `${source}:${type}`);
      lastActivity = performance.now();
    },
  });
  // 긴 프레임 줄에 그동안의 React 렌더 시간을 붙인다 (개발 빌드만 값이 있다, F-3)
  const commits = watchCommitTime();
  watchFrames(recorder, { takeCommitMs: commits?.take });
  watchInteractions(recorder);
  watchViewport(recorder);
  // 그리기 자가 진단 (G): 설정 키가 있을 때만 모듈을 불러온다. 커밋 시간 관찰은 React 가 뜨기 전에 걸어 둔다
  const selftestCommits = watchCommitTime();
  const selftest = (value: string, manual: boolean) =>
    import('./selftest')
      .then(({ startSelftest }) =>
        startSelftest(recorder, {
          value,
          manual,
          native: isNativeRuntime(),
          startedAt,
          lastActivity: () => lastActivity,
          takeCommitMs: () => selftestCommits?.take() ?? null,
        }),
      )
      .catch((error: unknown) =>
        recorder.push({
          t: round(performance.now()),
          kind: 'note',
          message: 'selftest failed',
          error: String(error),
        }),
      );
  const requested = settingsStorage.getItem(SELFTEST_KEY);
  if (requested) void selftest(requested, false);
  if (options.renders && !watchRenders(recorder))
    recorder.push({ t: round(performance.now()), kind: 'note', message: 'renders unavailable' });
  // 창을 닫거나 새로 고칠 때 남은 줄을 내보낸다 (끝나기 전에 쓰지 못하면 그 몫은 잃는다)
  window.addEventListener('pagehide', () => void recorder.flush());
  window.__mgitPerf = {
    mode,
    entries: recorder.entries,
    since: (t, kind) => recorder.entries().filter((e) => e.t >= t && (!kind || e.kind === kind)),
    flush: recorder.flush,
    clear: recorder.clear,
    cut: recorder.cut,
    watchStore: (name, subscribe) => subscribe(() => recorder.count('stores', name)),
    selftest: (value = '1') => selftest(value, true),
  };
  return recorder;
}
