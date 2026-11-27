// 반응성 G: 실제 앱 안에서 도는 그리기 자가 진단과 창 크기 변화 기록
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { developerActions } from '../actions';
import { watchViewport } from '../perf/browser';
import { createRecorder, type PerfEntry } from '../perf/recorder';
import { watchCommitTime } from '../perf/renders';
import {
  type BadgeState,
  createSelftestBadge,
  parseSelftest,
  runSelftest,
  type SelftestEnv,
  type WindowControl,
  waitForQuiet,
} from '../perf/selftest';

/**
 * 가짜 시계: rAF 는 16ms 씩, sleep 은 그만큼 시간을 옮긴다(둘 다 다음 차례에 푼다). `hidden(now)` 이 참인 동안은 창이 숨어
 * rAF 가 오지 않는다. 프레임 기다림의 시간 제한은 실제 타이머라 `frameTimeoutMs` 를 짧게 둔다
 */
function fakeEnv(
  overrides: Partial<SelftestEnv> = {},
  screen: { hidden?: (now: number) => boolean; rafLimit?: number } = {},
) {
  let now = 10_000;
  let rafCalls = 0;
  const hidden = screen.hidden ?? (() => false);
  const recorder = createRecorder({ now: () => now, sink: null, setTimer: () => {} });
  const removeKey = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const env: SelftestEnv = {
    recorder,
    now: () => now,
    raf: (callback) => {
      rafCalls += 1;
      if (hidden(now) || rafCalls > (screen.rafLimit ?? Number.POSITIVE_INFINITY)) return 0;
      setTimeout(() => {
        now += 16;
        callback(now);
      }, 0);
      return 0;
    },
    visible: () => !hidden(now),
    sleep: (ms) =>
      new Promise((resolve) =>
        setTimeout(() => {
          now += ms;
          resolve();
        }, 0),
      ),
    takeCommitMs: () => 3,
    lastActivity: () => 0,
    startedAt: 0,
    removeKey,
    close,
    windowControl: null,
    timing: {
      minMs: 0,
      quietMs: 0,
      maxMs: 0,
      resizeSettleMs: 0,
      resizeMaxMs: 50,
      frameTimeoutMs: 5,
    },
    ...overrides,
  };
  return { env, recorder, removeKey, close, advance: (ms: number) => (now += ms) };
}

/** 화면 크기가 있는 것처럼 보이게 한다 (jsdom 은 배치를 하지 않는다) */
function fakeLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 400,
        bottom: 300,
        width: 400,
        height: 300,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  const sized = (value: (el: HTMLElement) => number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return value(this);
    },
  });
  Object.defineProperty(
    HTMLElement.prototype,
    'scrollHeight',
    sized((el) => (el.dataset.scrollable ? 4_000 : 0)),
  );
  Object.defineProperty(
    HTMLElement.prototype,
    'clientHeight',
    sized((el) => (el.dataset.scrollable ? 500 : 0)),
  );
  Object.defineProperty(
    HTMLElement.prototype,
    'clientWidth',
    sized((el) => (el.dataset.scrollable ? 800 : 0)),
  );
}

/** 편집기(diff 행 셋·스크롤 본문)와 Project 영역만 있는 화면 */
function fixture() {
  document.body.innerHTML = `
    <div id="root">
      <div data-panel="editor">
        <div data-testid="diff-scroller" data-scrollable="1" style="overflow-y: auto">
          <div data-index="0">a</div><div data-index="1">b</div><div data-index="2">c</div>
        </div>
      </div>
      <div data-panel="project"><div>tree</div></div>
    </div>`;
  const scroller = document.querySelector<HTMLElement>('[data-testid="diff-scroller"]');
  if (!scroller) throw new Error('fixture');
  scroller.scrollTop = 120;
  return { scroller, html: document.body.innerHTML };
}

const selftestLines = (entries: readonly PerfEntry[]) =>
  entries.filter((e) => e.kind === 'selftest');
const notes = (entries: readonly PerfEntry[]) =>
  entries.filter((e) => e.kind === 'note').map((e) => e.message);

beforeEach(() => {
  fakeLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const field of ['scrollHeight', 'clientHeight', 'clientWidth'])
    Reflect.deleteProperty(HTMLElement.prototype, field);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
});

describe('자가 진단 설정 값 (G)', () => {
  it('비었거나 0 이면 돌리지 않고, exit·frames=N·nowindow 를 읽는다', () => {
    expect(parseSelftest(null)).toBeNull();
    expect(parseSelftest(' ')).toBeNull();
    expect(parseSelftest('0')).toBeNull();
    expect(parseSelftest('1')).toEqual({ frames: 24, exit: false, window: true });
    expect(parseSelftest('exit, frames=10 nowindow')).toEqual({
      frames: 10,
      exit: true,
      window: false,
    });
    // 너무 작거나 큰 프레임 수는 기본값
    expect(parseSelftest('frames=2')?.frames).toBe(24);
  });
});

describe('그리기 자가 진단 (G)', () => {
  it('탐침마다 프레임 간격·React 렌더·문서 상태를 남기고, 없는 영역은 건너뛰며, 끝나면 화면을 되돌린다', async () => {
    const { scroller, html } = fixture();
    const { env, recorder, removeKey, close } = fakeEnv();
    await runSelftest(env, { frames: 6, exit: true, window: true });

    const lines = selftestLines(recorder.entries());
    const byName = new Map(lines.map((line) => [line.probe, line]));
    expect([...byName.keys()]).toEqual([
      'idle',
      'paint-corner',
      'paint:editor',
      'paint:project',
      'paint:git-log',
      'row-highlight',
      'style-root',
      'style:editor',
      'layout-flow',
      'layout-abs',
      'layout:editor',
      'layout:git-log',
      'layout:project',
      'repaint-root',
      'repaint:editor',
      'scroll:editor',
      'scroll:git-log',
      'scroll:project',
    ]);
    expect(byName.get('idle')).toMatchObject({
      stage: 'base',
      frames: 6,
      p50: 16,
      p95: 16,
      max: 16,
      react: 3,
      state: { view: 'diff', rows: 3, panels: { editor: 4, project: 1 } },
    });
    expect(byName.get('paint:git-log')).toMatchObject({ skipped: 'no panel' });
    expect(byName.get('scroll:project')).toMatchObject({ skipped: 'no scroller' });
    expect(byName.get('row-highlight')).toMatchObject({ frames: 6, detail: { row: 'diff' } });
    expect(byName.get('scroll:editor')).toMatchObject({
      detail: { target: 'diff-scroller', width: 800, height: 500, scrollHeight: 4_000 },
    });
    // 영역 안 배치: 넘치는 스크롤 칸(diff 본문) 안, 영역이 없으면 건너뛴다
    expect(byName.get('layout:editor')).toMatchObject({
      frames: 6,
      detail: { spot: 'diff-scroller', depth: 1 },
    });
    expect(byName.get('layout:git-log')).toMatchObject({ skipped: 'no panel' });
    expect(byName.get('layout:project')).toMatchObject({ detail: { depth: 1 } });

    // 되돌리기: 넣은 요소·인라인 스타일·사용자 정의 속성·스크롤 위치
    expect(document.body.innerHTML).toBe(html);
    expect(document.querySelector('[data-mgit-probe]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--mgit-probe')).toBe('');
    expect(scroller.scrollTop).toBe(120);

    expect(removeKey).toHaveBeenCalledTimes(1);
    expect(notes(recorder.entries())).toEqual([
      'selftest begin',
      'selftest window stage skipped',
      'selftest done',
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('창 크기를 바꿔 일부 탐침을 다시 재고, 처음 최대화 상태로 되돌린다', async () => {
    fixture();
    let maximized = true;
    const setWidth = (width: number) =>
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    setWidth(1600);
    const windowControl: WindowControl = {
      isMaximized: async () => maximized,
      toggle: vi.fn(async () => {
        maximized = !maximized;
        setWidth(maximized ? 1600 : 900);
      }),
    };
    const { env, recorder, close } = fakeEnv({ windowControl });
    await runSelftest(env, { frames: 4, exit: false, window: true });

    const resized = selftestLines(recorder.entries()).filter((l) => l.stage === 'resized');
    expect(resized.map((l) => l.probe)).toEqual([
      'idle',
      'paint-corner',
      'row-highlight',
      'repaint-root',
      'scroll:editor',
      'scroll:git-log',
      'scroll:project',
    ]);
    expect(resized[0]?.state).toMatchObject({ width: 900 });
    expect(windowControl.toggle).toHaveBeenCalledTimes(2);
    expect(maximized).toBe(true);
    const entries = recorder.entries();
    expect(entries.find((e) => e.message === 'selftest window resized')).toMatchObject({
      wasMaximized: true,
      changed: true,
    });
    expect(entries.find((e) => e.message === 'selftest window restored')).toMatchObject({
      restored: true,
    });
    expect(close).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, 'innerWidth');
  });

  it('창이 보이는데도 프레임이 멈추면 그 탐침을 멈춤으로 남기고 나머지를 돌리지 않는다', async () => {
    fixture();
    // 처음 한 프레임(보이는지 확인)만 오고 멈춘다
    const { env, recorder } = fakeEnv({}, { rafLimit: 1 });
    await runSelftest(env, { frames: 4, exit: false, window: true });
    const lines = selftestLines(recorder.entries());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ probe: 'idle', stalled: true, frames: 0 });
    expect(recorder.entries().at(-1)).toMatchObject({
      message: 'selftest done',
      completed: false,
    });
  });

  it('창이 숨어 있으면 상한 없이 보일 때까지 기다리고, 설정 키는 측정을 실제로 시작할 때 지운다', async () => {
    fixture();
    // 화면 잠금: 처음 1분 동안 창이 숨어 있다 (잠잠해지기 상한 0 보다 길다)
    const { env, recorder, removeKey } = fakeEnv({}, { hidden: (now) => now < 70_000 });
    let removedAt = 0;
    removeKey.mockImplementation(async () => {
      removedAt = env.now();
    });
    await runSelftest(env, { frames: 4, exit: false, window: true });
    const waited = recorder.entries().find((e) => e.message === 'selftest waited for visible');
    // 다시 보인 뒤 첫 프레임(16ms)까지 기다린다
    expect(waited).toMatchObject({ reason: 'hidden', phase: 'start', waitedMs: 60_016 });
    expect(removedAt).toBeGreaterThanOrEqual(70_000);
    expect(selftestLines(recorder.entries())).toHaveLength(18);
    expect(recorder.entries().at(-1)).toMatchObject({ message: 'selftest done', completed: true });
  });

  it('탐침 도중 창이 가려지면 그 탐침을 버리고, 다시 보일 때 그 탐침부터 잇는다', async () => {
    fixture();
    // 첫 탐침(idle)을 재는 도중 2초 동안 가려진다
    const { env, recorder } = fakeEnv({}, { hidden: (now) => now >= 10_080 && now < 12_080 });
    const states: BadgeState[] = [];
    env.badge = { show: (state) => states.push(state), remove: () => {} };
    await runSelftest(env, { frames: 6, exit: false, window: true });
    const entries = recorder.entries();
    expect(entries.find((e) => e.message === 'selftest probe interrupted')).toMatchObject({
      probe: 'idle',
      stage: 'base',
    });
    expect(entries.find((e) => e.message === 'selftest waited for visible')).toMatchObject({
      reason: 'hidden',
      phase: 'base:idle',
    });
    const lines = selftestLines(entries);
    expect(lines.filter((l) => l.probe === 'idle')).toHaveLength(1);
    expect(lines[0]).toMatchObject({ probe: 'idle', frames: 6 });
    expect(lines[0]?.stalled).toBeUndefined();
    expect(lines).toHaveLength(18);
    // 표시: 기다림 → 측정 → (가려짐) 기다림 → 측정 → 끝남 (exit 가 없으면 창을 열어 둔다)
    expect(states).toEqual(['waiting', 'running', 'waiting', 'running', 'done']);
  });

  it('앱 시작 뒤 최소 시간이 지나고 IPC 가 잠잠해질 때까지 기다리고, 상한을 넘기면 그대로 시작한다', async () => {
    fixture();
    let now = 0;
    let activity = 0;
    const env = {
      ...fakeEnv().env,
      now: () => now,
      startedAt: 0,
      lastActivity: () => activity,
      sleep: async (ms: number) => {
        now += ms;
        // 1초까지는 IPC 가 계속 끝난다
        if (now <= 1_000) activity = now;
      },
    };
    expect(await waitForQuiet(env, { minMs: 500, quietMs: 750, maxMs: 10_000 })).toEqual({
      waitedMs: 1_750,
      quiet: true,
    });
    now = 0;
    activity = 0;
    const busy = { ...env, lastActivity: () => now };
    expect(await waitForQuiet(busy, { minMs: 0, quietMs: 750, maxMs: 2_000 })).toEqual({
      waitedMs: 2_000,
      quiet: false,
    });
  });

  it('영역 안 배치 탐침은 가로 flex 자리를 피해 그 위 블록에 높이 0 요소를 넣고 폭만 바꾸며, 끝나면 뺀다', async () => {
    document.body.innerHTML = `
      <div data-panel="project">
        <div class="column"><div class="row" style="display: flex"><span>a</span><span>b</span></div></div>
      </div>`;
    const row = document.querySelector<HTMLElement>('.row');
    const column = document.querySelector<HTMLElement>('.column');
    if (!row || !column) throw new Error('fixture');
    const widths: string[] = [];
    // 프레임마다 넣은 요소의 폭을 적는다 (넣은 자리와 높이 0·보이지 않음도 본다)
    const observer = new MutationObserver(() => {
      // 영역 안 배치 탐침의 요소만 (칠하기 탐침의 고정 상자는 뺀다)
      const probe = [
        ...document.querySelectorAll<HTMLElement>('[data-panel] [data-mgit-probe]'),
      ].find((el) => el.style.visibility === 'hidden');
      if (!probe) return;
      expect(probe.parentElement).toBe(column);
      expect(probe.style.height).toBe('0px');
      expect(probe.style.visibility).toBe('hidden');
      widths.push(probe.style.width);
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    const { env, recorder } = fakeEnv();
    await runSelftest(env, { frames: 4, exit: false, window: false });
    observer.disconnect();

    const line = selftestLines(recorder.entries()).find((l) => l.probe === 'layout:project');
    expect(line).toMatchObject({ frames: 4, detail: { spot: 'column', depth: 1 } });
    expect(new Set(widths)).toEqual(new Set(['10px', '11px']));
    expect(row.children).toHaveLength(2);
    expect(document.querySelector('[data-mgit-probe]')).toBeNull();
  });

  it('영역에 배치 경계가 있어 고정 위치의 기준이 영역이어도 칠하기 상자를 영역 왼쪽 위(창 기준)에 둔다', async () => {
    fixture();
    // 편집기 영역이 창의 (100, 50) 에 있고 contain: layout 이라 고정 위치 자손의 기준 블록이 그 영역이다
    const at = { left: 100, top: 50 };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const probe = this instanceof HTMLElement && this.hasAttribute('data-mgit-probe');
      const left = probe ? at.left + Number.parseFloat(this.style.left) : at.left;
      const top = probe ? at.top + Number.parseFloat(this.style.top) : at.top;
      const [width, height] = probe ? [8, 8] : [400, 300];
      return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const { env, recorder } = fakeEnv();
    await runSelftest(env, { frames: 4, exit: false, window: false });

    const paint = selftestLines(recorder.entries()).find((l) => l.probe === 'paint:editor');
    expect(paint).toMatchObject({ detail: { x: 104, y: 54 } });
  });
});

describe('창 크기 변화 (G)', () => {
  it('크기·배율이 바뀌면 멎은 뒤 resize 줄 하나를 남기고, 같은 크기로 돌아오면 남기지 않는다', () => {
    vi.useFakeTimers();
    const recorder = createRecorder({ now: () => 0, sink: null, setTimer: () => {} });
    const stop = watchViewport(recorder, { delayMs: 500, now: () => 42 });
    const start = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(200);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(500);
    expect(recorder.entries()).toEqual([
      {
        t: 42,
        kind: 'resize',
        width: 640,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      },
    ]);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(500);
    expect(recorder.entries()).toHaveLength(1);
    stop();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: start });
    vi.useRealTimers();
  });
});

describe('React 커밋 렌더 시간 (G)', () => {
  it('잰 커밋을 한 번 본 뒤로는 커밋 없는 구간을 0, 아직 못 봤으면(프로덕션 빌드) null 로 준다', () => {
    type Hook = { onCommitFiberRoot?: (id: number, root: unknown) => void };
    const global = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook };
    const saved = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    Reflect.deleteProperty(global, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
    const commits = watchCommitTime();
    const commit = (actualDuration?: number) =>
      global.__REACT_DEVTOOLS_GLOBAL_HOOK__?.onCommitFiberRoot?.(1, {
        current: { actualDuration },
      });
    expect(commits?.take()).toBeNull();
    // 프로덕션 빌드의 커밋에는 렌더 시간이 없다
    commit(undefined);
    expect(commits?.take()).toBeNull();
    commit(4.25);
    commit(1);
    expect(commits?.take()).toBe(5.3);
    expect(commits?.take()).toBe(0);
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved;
  });
});

describe('진행 표시와 팔레트 명령 (G)', () => {
  it('진행 표시는 왼쪽 아래 고정 위치·누를 수 없는 작은 상자이고, 끝남을 보인 뒤 스스로 지운다', () => {
    vi.useFakeTimers();
    const badge = createSelftestBadge(4_000);
    badge.show('running');
    const element = document.querySelector<HTMLElement>('[data-mgit-selftest-badge]');
    expect(element?.textContent).toBe(S.perfSelftest.running);
    expect(element?.style.position).toBe('fixed');
    expect(element?.style.pointerEvents).toBe('none');
    badge.show('done');
    expect(element?.textContent).toBe(S.perfSelftest.done);
    vi.advanceTimersByTime(3_999);
    expect(document.querySelector('[data-mgit-selftest-badge]')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector('[data-mgit-selftest-badge]')).toBeNull();
    vi.useRealTimers();
  });

  it('성능 자가 진단 명령은 개발·테스트 프로필에만 있고 배포 프로필에는 없다', () => {
    const runner = { selftest: vi.fn(async () => {}) };
    expect(developerActions('production', runner)).toEqual([]);
    const [action] = developerActions('development', runner);
    expect(action).toMatchObject({ id: 'dev.perfSelftest', group: 'app', enabled: true });
    action?.run();
    expect(runner.selftest).toHaveBeenCalledWith('frames=24');
    // 기록기가 꺼져 있으면(mgit.perf=0) 꺼진 채로 까닭을 보인다
    expect(developerActions('test', undefined)[0]).toMatchObject({
      enabled: false,
      disabledReason: S.perfSelftest.unavailable,
    });
  });
});
