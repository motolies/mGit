import { observeMethods, setIpcObserver } from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchFrames } from '../perf/browser';
import { watchInteractions } from '../perf/interaction';
import { perfMode } from '../perf/mode';
import { createRecorder, type PerfEntry } from '../perf/recorder';

/** 손으로 돌리는 시계·타이머 */
function clock(start = 0) {
  let now = start;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn });
    },
    /** 시각을 옮기고 그때까지 된 타이머를 돌린다 */
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    },
    pending: () => timers.length,
  };
}

/** 받은 줄 묶음을 JSON 줄로 풀어 모으는 내보낼 곳 */
function memorySink(accept = true) {
  const writes: PerfEntry[][] = [];
  return {
    writes,
    write: vi.fn(async (lines: string) => {
      writes.push(lines.split('\n').map((line) => JSON.parse(line) as PerfEntry));
      return accept;
    }),
  };
}

/** 대기 중인 약속을 모두 흘려보낸다 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setIpcObserver(null));

describe('성능 기록기 켜는 조건 (M1)', () => {
  it('네이티브 배포 프로필은 어떤 값으로도 켜지지 않는다', () => {
    const base = { native: true, mock: false, dev: false, stored: null };
    expect(perfMode({ ...base, profile: 'production' })).toBeNull();
    expect(perfMode({ ...base, profile: 'production', stored: '1' })).toBeNull();
    expect(perfMode({ ...base, profile: 'production', mock: true, dev: true })).toBeNull();
  });

  it('개발·테스트 네이티브는 파일, 목·개발 서버(웹)는 메모리, mgit.perf=0 이면 끈다', () => {
    const native = { native: true, mock: false, dev: true, stored: null };
    expect(perfMode({ ...native, profile: 'development' })).toBe('file');
    expect(perfMode({ ...native, profile: 'test' })).toBe('file');
    expect(perfMode({ ...native, profile: 'development', stored: '0' })).toBeNull();
    const web = { native: false, profile: 'production' as const, stored: null };
    expect(perfMode({ ...web, mock: true, dev: false })).toBe('memory');
    expect(perfMode({ ...web, mock: false, dev: true })).toBe('memory');
    expect(perfMode({ ...web, mock: false, dev: false })).toBeNull();
    expect(perfMode({ ...web, mock: true, dev: false, stored: '0' })).toBeNull();
  });
});

describe('성능 기록기 묶기·내보내기 (M1)', () => {
  it('줄을 모았다가 주기마다 한 번에 내보내고, 쌓인 줄이 없으면 타이머를 걸지 않는다', async () => {
    const c = clock(10_000);
    const sink = memorySink();
    const recorder = createRecorder({ now: c.now, sink, setTimer: c.setTimer, flushMs: 2000 });
    expect(c.pending()).toBe(0);
    recorder.ipc('repoState', 10_000, 10_012.34, true);
    recorder.ipc('fsFileStamps', 10_100, 10_101, false);
    expect(sink.write).not.toHaveBeenCalled();
    c.advance(2000);
    await settle();
    expect(sink.writes).toEqual([
      [
        { t: 10_000, kind: 'ipc', name: 'repoState', ms: 12.3, ok: true },
        { t: 10_100, kind: 'ipc', name: 'fsFileStamps', ms: 1, ok: false },
      ],
    ]);
    expect(c.pending()).toBe(0);
  });

  it('일정 개수가 쌓이면 주기를 기다리지 않고 내보낸다', async () => {
    const c = clock();
    const sink = memorySink();
    const recorder = createRecorder({ now: c.now, sink, setTimer: c.setTimer, flushCount: 3 });
    for (let i = 0; i < 3; i += 1) recorder.ipc('graphWindow', i, i + 1, true);
    await settle();
    expect(sink.writes.map((w) => w.length)).toEqual([3]);
  });

  it('이벤트는 종류별로 1초 단위 한 줄로 묶고, 이번 초의 묶음은 다음 내보내기까지 남긴다', async () => {
    const c = clock(5_200);
    const sink = memorySink();
    const recorder = createRecorder({ now: c.now, sink, setTimer: c.setTimer });
    recorder.count('events', 'openFolder:folderChanged');
    recorder.count('events', 'openFolder:folderChanged');
    recorder.count('events', 'openRepo:statusChanged');
    c.advance(900);
    recorder.count('events', 'openFolder:folderChanged');
    await recorder.flush();
    expect(sink.writes).toEqual([
      [
        {
          t: 5_000,
          kind: 'events',
          counts: { 'openFolder:folderChanged': 2, 'openRepo:statusChanged': 1 },
        },
      ],
    ]);
    c.advance(2000);
    await settle();
    expect(sink.writes[1]).toEqual([
      { t: 6_000, kind: 'events', counts: { 'openFolder:folderChanged': 1 } },
    ]);
  });

  it('기록기 자신의 쓰기 명령은 관찰 경로로 들어와도 기록하지 않는다', async () => {
    const c = clock();
    const commands = observeMethods({
      perfAppend: async (_lines: string) => true,
      repoState: async () => ({}),
    });
    const sink = memorySink();
    const recorder = createRecorder({
      now: c.now,
      setTimer: c.setTimer,
      // 내보낼 곳이 감싼 명령을 불러도 그 호출은 줄이 되지 않는다
      sink: { write: async (lines) => (await commands.perfAppend(lines)) && sink.write(lines) },
    });
    setIpcObserver({ call: recorder.ipc, event: () => {} });
    await commands.repoState();
    await recorder.flush();
    await recorder.flush();
    expect(sink.writes.flat().map((e) => e.name)).toEqual(['repoState']);
  });

  it('상한(false)이나 쓰기 거부를 받으면 기록을 멈춘다', async () => {
    const c = clock();
    const capped = memorySink(false);
    const recorder = createRecorder({ now: c.now, sink: capped, setTimer: c.setTimer });
    recorder.ipc('a', 0, 1, true);
    await recorder.flush();
    recorder.ipc('b', 0, 1, true);
    await recorder.flush();
    // 멈추기 전에 걸린 주기 타이머가 돌아도 다시 쓰지 않는다
    c.advance(5000);
    await settle();
    expect(capped.write).toHaveBeenCalledTimes(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejecting = { write: vi.fn(async () => Promise.reject(new Error('production'))) };
    const stopped = createRecorder({ now: c.now, sink: rejecting, setTimer: c.setTimer });
    stopped.ipc('a', 0, 1, true);
    await stopped.flush();
    stopped.ipc('b', 0, 1, true);
    await stopped.flush();
    expect(rejecting.write).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('메모리 모드는 내보내지 않고 모은 줄을 읽게 한다 (지난 초의 묶음은 읽을 때 닫는다)', () => {
    const c = clock(1_500);
    const recorder = createRecorder({ now: c.now, sink: null, setTimer: c.setTimer });
    recorder.ipc('compareLocalFiles', 1_500, 1_520, true);
    recorder.count('renders', 'project', 12);
    expect(recorder.entries().map((e) => e.kind)).toEqual(['ipc']);
    c.advance(1000);
    expect(recorder.entries().map((e) => e.kind)).toEqual(['ipc', 'renders']);
    expect(c.pending()).toBe(0);
    recorder.clear();
    expect(recorder.entries()).toEqual([]);
    // 측정 구간의 끝: 이번 초의 묶음도 닫는다
    recorder.count('stores', 'fileEditors');
    expect(recorder.entries()).toEqual([]);
    recorder.cut();
    expect(recorder.entries()).toEqual([{ t: 2_000, kind: 'stores', counts: { fileEditors: 1 } }]);
  });
});

describe('긴 프레임·입력 → 그리기 (M1)', () => {
  /** 손으로 돌리는 rAF */
  function frames() {
    let queue: ((time: number) => void)[] = [];
    return {
      raf: (callback: (time: number) => void) => {
        queue.push(callback);
        return queue.length;
      },
      cancelRaf: () => {
        queue = [];
      },
      tick(time: number) {
        const run = queue;
        queue = [];
        for (const callback of run) callback(time);
      },
      size: () => queue.length,
    };
  }

  it('50ms 넘는 간격만 직전 입력(종류·영역·경과)과 함께 남기고, 창이 숨으면 멈춘다', () => {
    document.body.innerHTML = '<div data-panel="project"><button id="b">x</button></div>';
    const c = clock();
    const recorder = createRecorder({ now: c.now, sink: null, setTimer: c.setTimer });
    const f = frames();
    const stop = watchFrames(recorder, {
      now: c.now,
      raf: f.raf,
      cancelRaf: f.cancelRaf,
      afterPaint: () => {},
    });
    f.tick(100);
    f.tick(116);
    document.getElementById('b')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    f.tick(200);
    const long = recorder.entries();
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ kind: 'frame', t: 116, ms: 84 });
    expect(long[0]?.input).toMatchObject({ type: 'pointerdown', panel: 'project' });

    // 숨은 동안의 간격은 세지 않는다
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(f.size()).toBe(0);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    f.tick(5_000);
    f.tick(5_010);
    expect(recorder.entries()).toHaveLength(1);
    visibility.mockRestore();
    stop();
  });

  it('키·클릭 뒤 다음 그리기까지 50ms 를 넘을 때만 남긴다', () => {
    document.body.innerHTML = '<div data-panel="editor"><input id="i" /></div>';
    const c = clock(1_000);
    const recorder = createRecorder({ now: c.now, sink: null, setTimer: c.setTimer });
    const painted: (() => void)[] = [];
    const stop = watchFrames(recorder, {
      now: c.now,
      raf: () => 0,
      cancelRaf: () => {},
      afterPaint: (callback) => painted.push(callback),
    });
    const input = document.getElementById('i') as HTMLInputElement;
    // jsdom 의 이벤트 시각은 문서 원점 기준이 아니므로 기록기는 지금 시각으로 바꾼다
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    c.advance(30);
    painted.shift()?.();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    c.advance(120);
    painted.shift()?.();
    expect(recorder.entries()).toEqual([
      { t: 1_030, kind: 'input', type: 'keydown', panel: 'editor', ms: 120 },
    ]);
    stop();
  });
});

describe('느린 상호작용·휠·렌더 시간 (F-3)', () => {
  it('긴 프레임 줄에 그 간격 동안의 React 렌더 시간을 붙이고, 값을 모르면 붙이지 않는다', () => {
    const c = clock();
    const recorder = createRecorder({ now: c.now, sink: null, setTimer: c.setTimer });
    let queue: ((time: number) => void)[] = [];
    const tick = (time: number) => {
      const run = queue;
      queue = [];
      for (const callback of run) callback(time);
    };
    const commits = [null, 12.5, null];
    const stop = watchFrames(recorder, {
      now: c.now,
      raf: (callback) => queue.push(callback),
      cancelRaf: () => {
        queue = [];
      },
      afterPaint: () => {},
      takeCommitMs: () => commits.shift() ?? null,
    });
    tick(100);
    tick(200);
    tick(300);
    expect(recorder.entries()).toEqual([
      { t: 100, kind: 'frame', ms: 100, focus: document.hasFocus(), input: null, react: 12.5 },
      { t: 200, kind: 'frame', ms: 100, focus: document.hasFocus(), input: null },
    ]);
    stop();
  });

  it('Event Timing 이 없으면 알리고, 휠·키의 리스너 시간과 휠 통계(가로 성분·취소)를 1초 묶음으로 센다', () => {
    document.body.innerHTML = '<div data-panel="editor"><div id="d"></div></div>';
    const c = clock(1_000);
    const recorder = createRecorder({ now: c.now, sink: null, setTimer: c.setTimer });
    const stop = watchInteractions(recorder, { now: c.now, eventTimingSupported: () => false });
    const target = document.getElementById('d') as HTMLElement;
    // 기본 동작을 취소하며 20ms 걸리는 리스너
    const slow = (event: Event) => {
      event.preventDefault();
      c.advance(20);
    };
    target.addEventListener('wheel', slow, { passive: false });
    target.dispatchEvent(
      new WheelEvent('wheel', { deltaX: 2, deltaY: 30, bubbles: true, cancelable: true }),
    );
    target.removeEventListener('wheel', slow);
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true }));
    recorder.cut();
    const entries = recorder.entries();
    expect(entries[0]).toMatchObject({ kind: 'note' });
    expect(entries.find((e) => e.kind === 'wheel')?.counts).toEqual({ n: 2, x: 1, prevented: 1 });
    expect(entries.find((e) => e.kind === 'handlers')?.counts).toEqual({
      'wheel:n': 2,
      'wheel:ms': 20,
      'wheel:over16': 1,
    });
    stop();
  });

  it('Event Timing 이 있으면 느린 상호작용마다 입력 지연·처리·그리기로 갈라 남긴다', () => {
    document.body.innerHTML = '<div data-panel="editor"><div id="d"></div></div>';
    const c = clock();
    const recorder = createRecorder({ now: c.now, sink: null, setTimer: c.setTimer });
    let deliver: ((entries: never[]) => void) | null = null;
    const stop = watchInteractions(recorder, {
      now: c.now,
      eventTimingSupported: () => true,
      observeEventTiming: (onEntries) => {
        deliver = onEntries as (entries: never[]) => void;
        return () => {};
      },
    });
    const target = document.getElementById('d');
    (deliver as ((entries: unknown[]) => void) | null)?.([
      {
        name: 'keydown',
        startTime: 100,
        duration: 120,
        processingStart: 110,
        processingEnd: 170,
        target,
      },
      {
        name: 'click',
        startTime: 400,
        duration: 30,
        processingStart: 401,
        processingEnd: 410,
        target,
      },
    ]);
    expect(recorder.entries().filter((e) => e.kind === 'interaction')).toEqual([
      {
        t: 100,
        kind: 'interaction',
        type: 'keydown',
        panel: 'editor',
        delay: 10,
        processing: 60,
        presentation: 50,
        duration: 120,
      },
    ]);
    stop();
  });
});
