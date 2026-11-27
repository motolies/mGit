// 긴 프레임·입력 → 다음 그리기 관찰 (반응성 측정 M1). WKWebView 는 `longtask` 관측을 지원하지 않아 rAF 간격으로 잰다.
import { type PerfRecorder, round } from './recorder';

/** 이보다 긴 rAF 간격·입력 → 그리기만 기록한다 (ms) */
export const LONG_FRAME_MS = 50;

/** 직전 사용자 입력 */
interface LastInput {
  type: string;
  panel: string | null;
  t: number;
}

export interface FrameWatchOptions {
  /** 기준 (ms, 기본 50) */
  threshold?: number;
  /** 지금 시각 */
  now?: () => number;
  /** 다음 프레임 예약 (테스트가 바꾼다) */
  raf?: (callback: (time: number) => void) => number;
  /** 프레임 예약 취소 */
  cancelRaf?: (handle: number) => void;
  /** 그리기가 끝난 뒤 돌 작업 예약 (기본: rAF 안에서 보낸 MessageChannel 메시지) */
  afterPaint?: (callback: () => void) => void;
  /**
   * 지난 프레임 뒤 React 커밋에 든 렌더 시간(ms)을 주고 0 으로 돌린다 (F-3, 개발 빌드만 값이 있다). 긴 프레임 줄에 `react` 로
   * 붙여 스크립트(렌더)가 긴 것인지 그리기가 긴 것인지 가른다
   */
  takeCommitMs?: () => number | null;
}

/** 요소가 속한 앱 영역 이름 (`data-panel`, 분할 패널의 `true` 는 뺀다). 없으면 null */
export function panelOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : null;
  return (
    element?.closest('[data-panel]:not([data-panel="true"])')?.getAttribute('data-panel') ?? null
  );
}

/** rAF 안에서 보낸 메시지는 그 프레임을 그린 뒤에 돈다 — "다음 그리기" 시각을 얻는다 */
function defaultAfterPaint(
  raf: (callback: (time: number) => void) => number,
): (callback: () => void) => void {
  const channel = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
  const queue: (() => void)[] = [];
  if (channel)
    channel.port1.onmessage = () => {
      queue.shift()?.();
    };
  return (callback) =>
    raf(() => {
      if (channel) {
        queue.push(callback);
        channel.port2.postMessage(null);
      } else {
        setTimeout(callback, 0);
      }
    });
}

/**
 * 긴 프레임과 입력 → 다음 그리기를 기록한다. 창이 숨으면(`visibilityState`) 프레임 관찰을 멈추고, 다시 보이면 간격을
 * 새로 잰다. 해제 함수를 준다
 */
export function watchFrames(recorder: PerfRecorder, options: FrameWatchOptions = {}): () => void {
  const threshold = options.threshold ?? LONG_FRAME_MS;
  const now = options.now ?? (() => performance.now());
  const raf = options.raf ?? ((callback) => requestAnimationFrame(callback));
  const cancelRaf = options.cancelRaf ?? ((handle) => cancelAnimationFrame(handle));
  const afterPaint = options.afterPaint ?? defaultAfterPaint(raf);
  let last = 0;
  let handle: number | null = null;
  let lastInput: LastInput | null = null;
  let lastTarget: EventTarget | null = null;
  let lastPanel: string | null = null;
  let measuring = false;

  /** 프레임마다 직전 프레임과의 간격을 본다 */
  const frame = (time: number) => {
    // 이 간격 동안의 React 렌더 시간 (프레임마다 돌려 다음 간격과 섞이지 않게 한다)
    const react = options.takeCommitMs?.() ?? null;
    if (last > 0 && time - last > threshold) {
      recorder.push({
        t: round(last),
        kind: 'frame',
        ms: round(time - last),
        focus: document.hasFocus(),
        input: lastInput
          ? { type: lastInput.type, panel: lastInput.panel, since: round(last - lastInput.t) }
          : null,
        ...(react !== null ? { react } : {}),
      });
    }
    last = time;
    handle = raf(frame);
  };
  const start = () => {
    if (handle !== null) return;
    last = 0;
    handle = raf(frame);
  };
  const stop = () => {
    if (handle !== null) cancelRaf(handle);
    handle = null;
    last = 0;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };

  /** 입력을 직전 입력으로 남기고, 키·클릭이면 다음 그리기까지 잰다 (한 번에 하나만) */
  const onInput = (event: Event) => {
    // 이벤트 시각이 문서 시간 원점 기준이 아니면(옛 엔진) 지금 시각을 쓴다
    const stamp = event.timeStamp > 0 && event.timeStamp <= now() + 1 ? event.timeStamp : now();
    if (event.target !== lastTarget) {
      lastTarget = event.target;
      lastPanel = panelOf(event.target);
    }
    lastInput = { type: event.type, panel: lastPanel, t: stamp };
    if ((event.type !== 'keydown' && event.type !== 'click') || measuring) return;
    measuring = true;
    const input = lastInput;
    afterPaint(() => {
      measuring = false;
      const ms = now() - input.t;
      if (ms > threshold)
        recorder.push({
          t: round(input.t),
          kind: 'input',
          type: input.type,
          panel: input.panel,
          ms: round(ms),
        });
    });
  };

  const inputs = ['keydown', 'pointerdown', 'click', 'wheel'] as const;
  for (const type of inputs)
    window.addEventListener(type, onInput, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  if (document.visibilityState === 'visible') start();
  return () => {
    stop();
    for (const type of inputs) window.removeEventListener(type, onInput, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** 창 크기 (CSS px)·배율·화면 크기 — `start`·`resize`·자가 진단 줄이 같이 쓴다 */
export function viewportOf(): {
  width: number;
  height: number;
  dpr: number;
  screenWidth: number | null;
  screenHeight: number | null;
} {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    screenWidth: window.screen?.width ?? null,
    screenHeight: window.screen?.height ?? null,
  };
}

/**
 * 창 크기·배율이 바뀌면 멎은 뒤(`delayMs`, 기본 500ms) `resize` 줄 하나를 남긴다 (G — 사용자가 창을 줄여 써 봤는지, 다른
 * 화면으로 옮겼는지). 끌어서 바꾸는 동안의 중간 크기는 남기지 않는다. 해제 함수를 준다
 */
export function watchViewport(
  recorder: PerfRecorder,
  options: { delayMs?: number; now?: () => number } = {},
): () => void {
  const delayMs = options.delayMs ?? 500;
  const now = options.now ?? (() => performance.now());
  const keyOf = (v: ReturnType<typeof viewportOf>) => `${v.width}x${v.height}@${v.dpr}`;
  let last = keyOf(viewportOf());
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    timer = null;
    const v = viewportOf();
    const key = keyOf(v);
    if (key === last) return;
    last = key;
    recorder.push({
      t: round(now()),
      kind: 'resize',
      width: v.width,
      height: v.height,
      dpr: v.dpr,
    });
  };
  const onResize = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(settle, delayMs);
  };
  window.addEventListener('resize', onResize);
  return () => {
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener('resize', onResize);
  };
}
