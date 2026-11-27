// 느린 상호작용의 갈래와 휠 통계 (반응성 F-3). 긴 프레임이 입력 처리(스크립트) 때문인지 그리기 때문인지 가르는 재료를 남긴다.
// 개발·테스트 프로필에서만 불린다 (`install.ts`).
import { panelOf } from './browser';
import { type PerfRecorder, round } from './recorder';

/** Event Timing 항목에서 쓰는 필드 (`PerformanceEventTiming`) */
interface EventTimingEntry {
  name: string;
  startTime: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
  target?: EventTarget | null;
}

export interface InteractionWatchOptions {
  /** 이보다 오래 걸린 상호작용만 남긴다 (ms, 기본 50) */
  threshold?: number;
  /** 지금 시각 */
  now?: () => number;
  /** Event Timing 을 쓸 수 있는지 (테스트가 바꾼다) */
  eventTimingSupported?: () => boolean;
  /** Event Timing 관찰을 건다 (테스트가 바꾼다). 해제 함수를 준다 */
  observeEventTiming?: (
    onEntries: (entries: EventTimingEntry[]) => void,
    threshold: number,
  ) => () => void;
}

/** 브라우저가 Event Timing(`event` 항목)을 내는지 */
function supportsEventTiming(): boolean {
  return (
    typeof PerformanceObserver !== 'undefined' &&
    (PerformanceObserver.supportedEntryTypes ?? []).includes('event')
  );
}

/** Event Timing 관찰을 건다 */
function observeEvents(
  onEntries: (entries: EventTimingEntry[]) => void,
  threshold: number,
): () => void {
  const observer = new PerformanceObserver((list) =>
    onEntries(list.getEntries() as unknown as EventTimingEntry[]),
  );
  // durationThreshold 는 16ms 아래로 내릴 수 없다
  observer.observe({
    type: 'event',
    durationThreshold: Math.max(16, threshold),
  } as PerformanceObserverInit);
  return () => observer.disconnect();
}

/**
 * 느린 상호작용과 휠을 관찰한다 (F-3). 해제 함수를 준다.
 * - Event Timing 을 쓸 수 있으면 `threshold` 를 넘은 상호작용마다 `interaction` 줄: 입력 지연(`delay` = 처리 시작 − 입력),
 *   처리(`processing` = 리스너 시간), 그 뒤 그리기까지(`presentation`), 합(`duration`)
 * - 쓸 수 없으면 `note` 한 줄을 남기고, 대신 휠·키·포인터의 리스너 시간을 창의 capture → bubble 사이로 재 1초 묶음
 *   (`handlers` 줄: `<종류>:n`·`<종류>:ms` 합·`<종류>:over16`)으로 센다
 * - 휠은 늘 1초 묶음(`wheel` 줄: `n` 수, `x` 가로 성분이 있는 수, `prevented` 기본 동작을 취소한 수)으로 센다
 */
export function watchInteractions(
  recorder: PerfRecorder,
  options: InteractionWatchOptions = {},
): () => void {
  const threshold = options.threshold ?? 50;
  const now = options.now ?? (() => performance.now());
  const cleanups: (() => void)[] = [];
  const supported = (options.eventTimingSupported ?? supportsEventTiming)();
  if (supported) {
    cleanups.push(
      (options.observeEventTiming ?? observeEvents)((entries) => {
        for (const entry of entries) {
          if (entry.duration < threshold) continue;
          recorder.push({
            t: round(entry.startTime),
            kind: 'interaction',
            type: entry.name,
            panel: panelOf(entry.target ?? null),
            delay: round(entry.processingStart - entry.startTime),
            processing: round(entry.processingEnd - entry.processingStart),
            presentation: round(entry.startTime + entry.duration - entry.processingEnd),
            duration: round(entry.duration),
          });
        }
      }, threshold),
    );
  } else {
    recorder.push({
      t: round(now()),
      kind: 'note',
      message:
        'event timing unsupported — listener time measured between window capture and bubble',
    });
  }
  // 리스너 시간 (Event Timing 이 없을 때): 창 capture 에서 시작, 창 bubble 에서 끝
  const started: Record<string, number> = {};
  const types = supported ? [] : (['wheel', 'keydown', 'pointerdown'] as const);
  for (const type of types) {
    const begin = () => {
      started[type] = now();
    };
    const end = () => {
      const at = started[type];
      if (at === undefined) return;
      delete started[type];
      const ms = now() - at;
      recorder.count('handlers', `${type}:n`);
      recorder.count('handlers', `${type}:ms`, round(ms));
      if (ms > 16) recorder.count('handlers', `${type}:over16`);
    };
    window.addEventListener(type, begin, { capture: true, passive: true });
    window.addEventListener(type, end, { passive: true });
    cleanups.push(() => {
      window.removeEventListener(type, begin, { capture: true });
      window.removeEventListener(type, end);
    });
  }
  // 휠 통계 (창 bubble — 앞의 리스너가 기본 동작을 취소했는지 본다)
  const wheel = (event: WheelEvent) => {
    recorder.count('wheel', 'n');
    if (event.deltaX !== 0) recorder.count('wheel', 'x');
    if (event.defaultPrevented) recorder.count('wheel', 'prevented');
  };
  window.addEventListener('wheel', wheel, { passive: true });
  cleanups.push(() => window.removeEventListener('wheel', wheel));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
