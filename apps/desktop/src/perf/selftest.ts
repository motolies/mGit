// 실제 앱(WKWebView) 안에서 스스로 도는 그리기 자가 진단 (반응성 G). 개발·테스트 프로필에서 설정 키 `mgit.perf.selftest` 가
// 있을 때만 `install.ts` 가 불러온다 (배포 프로필은 기록기째 불러오지 않는다). 탐침마다 화면의 한 가지만 프레임마다 바꾸며 rAF
// 간격을 재 "무엇을 바꿔야 한 프레임이 길어지는가"를 가른다. 원인을 고치지 않는다 — 끝나면 넣은 요소·속성·스크롤 위치·창
// 크기를 되돌린다.
import { flushSettings, settingsStorage } from '@mgit/storage';
import { S } from '@mgit/ui';
import { viewportOf } from './browser';
import { SELFTEST_KEY } from './mode';
import { type PerfRecorder, round } from './recorder';

/** 설정 값에서 읽는 선택 (쉼표·공백으로 나눈 낱말: `exit`, `frames=N`, `nowindow`) */
export interface SelftestOptions {
  /** 탐침 하나에 돌릴 프레임 수 (기본 24) */
  frames: number;
  /** 끝난 뒤 창을 닫는다 (기존 닫기 경로 `mgit-close-requested`) */
  exit: boolean;
  /** 창 크기를 바꿔(최대화 켜고 끄기) 일부 탐침을 다시 잰다 */
  window: boolean;
}

/** 창 크기 바꾸기 (네이티브만) */
export interface WindowControl {
  /** 지금 최대화돼 있는지 */
  isMaximized(): Promise<boolean>;
  /** 최대화를 켜고 끈다 */
  toggle(): Promise<void>;
}

/** 기다림 기준 (ms) */
export interface SelftestTiming {
  /** 앱 시작 뒤 적어도 이만큼 지나야 시작한다 */
  minMs: number;
  /** IPC·코어 이벤트가 이만큼 없어야 "잠잠하다" */
  quietMs: number;
  /** 잠잠해지기를 이만큼까지만 기다린다 (넘으면 그 사실을 남기고 시작한다) */
  maxMs: number;
  /** 프레임 하나를 이만큼 못 받으면 멈춘 것으로 본다 (창이 숨었을 때 등) */
  frameTimeoutMs: number;
  /** 창 크기가 이만큼 그대로면 다 바뀐 것으로 본다 */
  resizeSettleMs: number;
  /** 창 크기 바뀌기를 이만큼까지만 기다린다 */
  resizeMaxMs: number;
  /** 창이 숨어 있을 때 다시 볼 간격 */
  visibleCheckMs: number;
  /** "끝남" 표시를 이만큼 보인 뒤 지운다 */
  badgeDoneMs: number;
}

const DEFAULT_TIMING: SelftestTiming = {
  minMs: 6_000,
  quietMs: 2_500,
  maxMs: 90_000,
  frameTimeoutMs: 2_000,
  resizeSettleMs: 800,
  resizeMaxMs: 6_000,
  visibleCheckMs: 500,
  badgeDoneMs: 4_000,
};

/** 화면 구석의 진행 표시 상태 */
export type BadgeState = 'waiting' | 'running' | 'done';

/** 화면 구석의 진행 표시 (탐침에 영향이 없게 고정 위치·작은 면적, 탐침 동안에는 바꾸지 않는다) */
export interface SelftestBadge {
  show(state: BadgeState): void;
  /** 지금 지운다 */
  remove(): void;
}

/** 진단이 쓰는 바깥 것들 (테스트가 바꾼다) */
export interface SelftestEnv {
  recorder: PerfRecorder;
  now(): number;
  raf(callback: (time: number) => void): number;
  sleep(ms: number): Promise<void>;
  /** 지난 호출 뒤 React 커밋에 든 렌더 시간 합 (개발 빌드만, 모르면 null) */
  takeCommitMs(): number | null;
  /** 마지막 IPC 완료·코어 이벤트 시각 (기록기 자신의 쓰기는 뺀다) */
  lastActivity(): number;
  /** 앱(기록기) 시작 시각 */
  startedAt: number;
  /** 설정 키를 지우고 저장한다 */
  removeKey(): Promise<void>;
  /** 창을 닫는다 (네이티브가 아니면 null) */
  close: (() => Promise<void>) | null;
  /** 창 크기 바꾸기 (네이티브가 아니면 null) */
  windowControl: WindowControl | null;
  /** 창이 보이는지 (기본 `document.visibilityState`) */
  visible?: () => boolean;
  /** 진행 표시 (없으면 띄우지 않는다) */
  badge?: SelftestBadge | null;
  timing?: Partial<SelftestTiming>;
}

/** 탐침 하나를 준비한 결과: 프레임마다 바꾸기, 되돌리기, 줄에 붙일 설명 */
interface Prepared {
  step(index: number): void;
  restore(): void;
  detail?: Record<string, unknown>;
}

/** 탐침: 준비하면 `Prepared`, 못 하면 건너뛴 까닭 */
interface Probe {
  name: string;
  prepare(frames: number): Prepared | string;
}

/** 칠하기 탐침이 번갈아 쓰는 거의 같은 두 색 */
const NEAR_A = '#7f7f7f';
const NEAR_B = '#808080';
/** 스크롤 탐침의 한 프레임 이동 (px) */
const SCROLL_STEP = 40;
/** 칠하기 탐침을 넣어 볼 영역 */
const PAINT_PANELS = ['editor', 'project', 'git-log'] as const;
/** 스크롤 탐침을 찾을 영역 */
const SCROLL_PANELS = ['editor', 'git-log', 'project'] as const;
/** 영역 안 배치 탐침을 넣을 영역 */
const LAYOUT_PANELS = ['editor', 'git-log', 'project'] as const;
/** 창 크기를 바꾼 뒤 다시 잴 탐침 */
const RESIZED_PROBES = new Set(['idle', 'paint-corner', 'row-highlight', 'repaint-root']);

/** 설정 값을 읽는다. 비었거나 `0` 이면 null (돌리지 않는다) */
export function parseSelftest(value: string | null): SelftestOptions | null {
  const text = value?.trim();
  if (!text || text === '0') return null;
  const words = text.split(/[\s,]+/);
  const framesWord = words.find((word) => word.startsWith('frames='));
  const frames = framesWord ? Number(framesWord.slice('frames='.length)) : Number.NaN;
  return {
    frames: Number.isInteger(frames) && frames >= 4 && frames <= 600 ? frames : 24,
    exit: words.includes('exit'),
    window: !words.includes('nowindow'),
  };
}

/** 크기가 있는 요소의 사각형, 없으면 null */
function visibleRect(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** 이름이 `name` 인 영역 중 화면에 보이는 첫 것 */
export function panelElement(name: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[data-panel="${name}"]`))
    if (visibleRect(element)) return element;
  return null;
}

/** 요소를 가리키는 짧은 이름 (`data-testid` → 첫 클래스 → 태그) */
function labelOf(element: Element): string {
  return (
    element.getAttribute('data-testid') ??
    element.getAttribute('class')?.split(/\s+/)[0] ??
    element.tagName.toLowerCase()
  );
}

/** 지금 문서 상태: 요소 수(전체·영역별), 스타일시트 규칙 수, 창 크기, 편집기에 보이는 문서 종류 */
export function documentState(): Record<string, unknown> {
  const panels: Record<string, number> = {};
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-panel]:not([data-panel="true"])',
  )) {
    const name = element.dataset.panel;
    if (!name || !visibleRect(element)) continue;
    panels[name] = (panels[name] ?? 0) + element.getElementsByTagName('*').length;
  }
  let rules = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      rules += sheet.cssRules.length;
    } catch {
      // 다른 출처의 스타일시트는 읽을 수 없다 (세지 않는다)
    }
  }
  const editor = panelElement('editor');
  const diff = editor?.querySelector('[data-testid="diff-scroller"]') ?? null;
  const view = diff
    ? 'diff'
    : editor?.querySelector('.cm-editor')
      ? 'code'
      : editor
        ? 'other'
        : 'none';
  const { width, height, dpr } = viewportOf();
  return {
    elements: document.getElementsByTagName('*').length,
    panels,
    rules,
    width,
    height,
    dpr,
    view,
    ...(diff ? { rows: diff.querySelectorAll('[data-index]').length } : {}),
  };
}

/**
 * 인라인 스타일 속성 하나를 바꾸고 되돌리는 손잡이. 되돌릴 때 그 속성만 원래 값으로 돌리고(그동안 React 가 바꾼 다른 속성은
 * 그대로), 처음에 `style` 속성이 없었으면 빈 속성도 지운다
 */
function inlineStyle(element: HTMLElement, property: string) {
  const hadStyle = element.hasAttribute('style');
  const original = element.style.getPropertyValue(property);
  const priority = element.style.getPropertyPriority(property);
  return {
    set: (value: string) => element.style.setProperty(property, value),
    reset: () => {
      if (original) element.style.setProperty(property, original, priority);
      else element.style.removeProperty(property);
      if (!hadStyle && element.getAttribute('style') === '') element.removeAttribute('style');
    },
    original,
  };
}

/** 아무것도 바꾸지 않는다 — 창의 기본 프레임 간격 */
function idleProbe(): Probe {
  return { name: 'idle', prepare: () => ({ step() {}, restore() {} }) };
}

/** 고정 위치의 8×8 상자를 `place` 가 정한 부모·자리에 넣고 프레임마다 배경을 바꾼다 */
function boxProbe(
  name: string,
  place: () => { parent: Element; left: number; top: number } | string,
): Probe {
  return {
    name,
    prepare() {
      const at = place();
      if (typeof at === 'string') return at;
      const box = document.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      box.setAttribute('data-mgit-probe', '');
      box.style.cssText = `position:fixed;left:${round(at.left)}px;top:${round(at.top)}px;width:8px;height:8px;z-index:2147483647;pointer-events:none;background:${NEAR_A}`;
      at.parent.appendChild(box);
      // 영역에 배치 경계(contain: layout)가 있으면 고정 위치의 기준이 창이 아니라 영역이다 — 놓인 자리와 바란 자리의
      // 차이만큼 되돌려 창 기준 자리에 둔다
      const placed = box.getBoundingClientRect();
      const dx = placed.left - at.left;
      const dy = placed.top - at.top;
      if (dx !== 0 || dy !== 0) {
        box.style.left = `${round(at.left - dx)}px`;
        box.style.top = `${round(at.top - dy)}px`;
      }
      const rect = box.getBoundingClientRect();
      return {
        step: (index) => {
          box.style.background = index % 2 ? NEAR_A : NEAR_B;
        },
        restore: () => box.remove(),
        detail: { x: round(rect.left), y: round(rect.top) },
      };
    },
  };
}

/** 편집기 영역의 보이는 행 하나: diff 가상 행(가운데), 없으면 CodeMirror 거터 칸 */
function visibleRow(editor: HTMLElement): { element: HTMLElement; kind: string } | null {
  const view = editor.getBoundingClientRect();
  const inside = (element: HTMLElement) => {
    const rect = visibleRect(element);
    return rect !== null && rect.top >= view.top && rect.bottom <= view.bottom;
  };
  const rows = [
    ...editor.querySelectorAll<HTMLElement>('[data-testid="diff-scroller"] [data-index]'),
  ].filter(inside);
  const row = rows[Math.floor(rows.length / 2)];
  if (row) return { element: row, kind: 'diff' };
  // CodeMirror 본문 줄은 편집기의 DOM 관찰이 고쳐 쓰므로 건드리지 않고, 본문 밖인 거터 칸을 쓴다
  const gutter = [...editor.querySelectorAll<HTMLElement>('.cm-gutterElement')].filter(inside);
  const cell = gutter[Math.floor(gutter.length / 2)];
  return cell ? { element: cell, kind: 'code-gutter' } : null;
}

/** 줄 강조 흉내: 보이는 행 하나의 배경 인라인 스타일을 프레임마다 켜고 끈다 (hover 강조와 비슷한 변화) */
function rowProbe(): Probe {
  return {
    name: 'row-highlight',
    prepare() {
      const editor = panelElement('editor');
      if (!editor) return 'no editor panel';
      const row = visibleRow(editor);
      if (!row) return 'no visible row';
      const style = inlineStyle(row.element, 'background-color');
      const rect = row.element.getBoundingClientRect();
      return {
        step: (index) => style.set(index % 2 ? style.original : 'rgba(128, 128, 128, 0.2)'),
        restore: style.reset,
        detail: { row: row.kind, width: round(rect.width), height: round(rect.height) },
      };
    },
  };
}

/** 스타일만: 쓰이지 않는 사용자 정의 속성(상속된다)을 프레임마다 바꾼다 — 그 아래 전체 스타일 재계산 */
function styleProbe(name: string, target: () => HTMLElement | null): Probe {
  return {
    name,
    prepare() {
      const element = target();
      if (!element) return 'no target';
      const style = inlineStyle(element, '--mgit-probe');
      return {
        step: (index) => style.set(String(index)),
        restore: style.reset,
        detail: { elements: element.getElementsByTagName('*').length },
      };
    },
  };
}

/** 배치만: 보이지 않는 작은 요소의 폭을 프레임마다 바꾼다 (문서 흐름 안 = body 의 블록, 밖 = 절대 위치) */
function layoutProbe(name: string, inFlow: boolean): Probe {
  return {
    name,
    prepare() {
      const element = document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('data-mgit-probe', '');
      element.style.cssText = inFlow
        ? 'height:0;overflow:hidden;visibility:hidden;width:10px'
        : 'position:absolute;left:0;top:0;height:1px;overflow:hidden;visibility:hidden;pointer-events:none;width:10px';
      document.body.appendChild(element);
      return {
        step: (index) => {
          element.style.width = `${10 + (index % 2)}px`;
        },
        restore: () => element.remove(),
      };
    },
  };
}

/** 높이 0 블록을 넣어도 모양이 그대로인 상자 (블록 흐름 또는 세로 flex) */
const BLOCK_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'flex']);

/**
 * 영역 안의 흐름 속 자리: 영역에서 넓이가 가장 큰 블록 수준 자식으로 내려가며 실제로 넘치는 스크롤 칸·편집 가능 요소·
 * CodeMirror·xterm·svg·canvas 에서 멈춘 곳(실험실 `bench/webkit-layout-probe.mjs` 의 주 사슬 끝과 같다). 그 자리가 가로
 * flex 면 블록·세로 flex 인 조상까지 올라간다 — 넣은 요소가 옆 칸을 밀거나 글줄을 나누지 않게
 */
function flowSpot(panel: HTMLElement): { element: HTMLElement; depth: number } {
  let at = panel;
  let depth = 0;
  for (;;) {
    const style = getComputedStyle(at);
    if (
      at !== panel &&
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      at.scrollHeight > at.clientHeight + 1
    )
      break;
    let best: HTMLElement | null = null;
    let area = 0;
    for (const child of at.children) {
      if (!(child instanceof HTMLElement)) continue;
      const childStyle = getComputedStyle(child);
      if (
        childStyle.position === 'absolute' ||
        childStyle.position === 'fixed' ||
        !BLOCK_DISPLAYS.has(childStyle.display)
      )
        continue;
      const rect = child.getBoundingClientRect();
      if (rect.width * rect.height > area) {
        best = child;
        area = rect.width * rect.height;
      }
    }
    if (
      !best ||
      best.isContentEditable ||
      best.matches('.cm-editor, .xterm, svg, canvas, textarea, input')
    )
      break;
    at = best;
    depth += 1;
  }
  for (; at !== panel; at = at.parentElement ?? panel, depth -= 1) {
    const style = getComputedStyle(at);
    const row = style.display === 'flex' && !style.flexDirection.startsWith('column');
    if (BLOCK_DISPLAYS.has(style.display) && !row) break;
  }
  return { element: at, depth };
}

/**
 * 배치만(영역 안): 영역 안 흐름 속 자리에 높이 0·보이지 않는 요소를 넣고 폭을 프레임마다 10↔11px 로 바꾼다. 모양은 그대로이고
 * 그 자리부터 문서 루트(또는 배치 경계)까지 배치가 무효화된다 — 실험실의 "영역 안에 상자 넣기"에 대응한다. `layout-flow` 는
 * body 바로 아래라 영역의 flex 사슬을 지나지 않는다
 */
function areaLayoutProbe(panelName: string): Probe {
  return {
    name: `layout:${panelName}`,
    prepare() {
      const panel = panelElement(panelName);
      if (!panel) return 'no panel';
      const spot = flowSpot(panel);
      const element = document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('data-mgit-probe', '');
      element.style.cssText =
        'display:block;flex:none;height:0;margin:0;padding:0;overflow:hidden;visibility:hidden;pointer-events:none;width:10px';
      spot.element.appendChild(element);
      return {
        step: (index) => {
          element.style.width = `${10 + (index % 2)}px`;
        },
        restore: () => element.remove(),
        detail: { spot: labelOf(spot.element), depth: spot.depth },
      };
    },
  };
}

/** `rgb()`·`rgba()` 글을 수로 (못 읽으면 null) */
function parseRgb(text: string): { r: number; g: number; b: number; a: number } | null {
  const inner = /rgba?\(([^)]+)\)/.exec(text)?.[1];
  if (!inner) return null;
  const [r, g, b, a] = inner
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r, g, b, a: a ?? 1 };
}

/** 요소(투명하면 body·문서 루트)의 배경색과 파랑만 1 다른 색 — 거의 같은 두 색 */
function nearPair(element: HTMLElement): [string, string] {
  const color = [element, document.body, document.documentElement]
    .map((e) => parseRgb(getComputedStyle(e).backgroundColor))
    .find((c) => c !== null && c.a > 0) ?? { r: 0, g: 0, b: 0, a: 1 };
  const other = color.b >= 255 ? color.b - 1 : color.b + 1;
  return [`rgb(${color.r}, ${color.g}, ${color.b})`, `rgb(${color.r}, ${color.g}, ${other})`];
}

/** 전체 다시 칠하기: 대상의 배경을 거의 같은 두 색으로 번갈아 바꾼다 */
function repaintProbe(name: string, target: () => HTMLElement | null): Probe {
  return {
    name,
    prepare() {
      const element = target();
      if (!element) return 'no target';
      const style = inlineStyle(element, 'background-color');
      const [a, b] = nearPair(element);
      const rect = element.getBoundingClientRect();
      return {
        step: (index) => style.set(index % 2 ? a : b),
        restore: style.reset,
        detail: { width: round(rect.width), height: round(rect.height) },
      };
    },
  };
}

/** 영역 안에서 세로로 스크롤되는 가장 큰 요소 (넘치는 높이 200px 이상) */
function largestScroller(panel: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  let area = 0;
  for (const element of [panel, ...panel.querySelectorAll<HTMLElement>('*')]) {
    if (element.scrollHeight - element.clientHeight < 200 || element.clientHeight < 80) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const size = element.clientWidth * element.clientHeight;
    if (size > area) {
      best = element;
      area = size;
    }
  }
  return best;
}

/** 스크롤: 영역의 큰 스크롤 요소를 프레임마다 40px 씩 `scrollTop` 으로 내렸다(반) 올린다(반) */
function scrollProbe(panelName: string): Probe {
  return {
    name: `scroll:${panelName}`,
    prepare(frames) {
      const panel = panelElement(panelName);
      if (!panel) return 'no panel';
      const element = largestScroller(panel);
      if (!element) return 'no scroller';
      const start = element.scrollTop;
      const half = Math.floor(frames / 2);
      const max = element.scrollHeight - element.clientHeight;
      const direction = start + SCROLL_STEP * half <= max ? 1 : -1;
      return {
        step: (index) => {
          element.scrollTop += (index < half ? direction : -direction) * SCROLL_STEP;
        },
        restore: () => {
          element.scrollTop = start;
        },
        detail: {
          target: labelOf(element),
          width: element.clientWidth,
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
        },
      };
    },
  };
}

/** 탐침 목록 (차례대로 돈다) */
export function probeList(): Probe[] {
  return [
    idleProbe(),
    boxProbe('paint-corner', () => ({
      parent: document.body,
      left: window.innerWidth - 10,
      top: window.innerHeight - 10,
    })),
    ...PAINT_PANELS.map((name) =>
      boxProbe(`paint:${name}`, () => {
        const panel = panelElement(name);
        if (!panel) return 'no panel';
        const rect = panel.getBoundingClientRect();
        return { parent: panel, left: rect.left + 4, top: rect.top + 4 };
      }),
    ),
    rowProbe(),
    styleProbe('style-root', () => document.documentElement),
    styleProbe('style:editor', () => panelElement('editor')),
    layoutProbe('layout-flow', true),
    layoutProbe('layout-abs', false),
    ...LAYOUT_PANELS.map(areaLayoutProbe),
    repaintProbe('repaint-root', () => document.getElementById('root') ?? document.body),
    repaintProbe('repaint:editor', () => panelElement('editor')),
    ...SCROLL_PANELS.map(scrollProbe),
  ];
}

/** 정렬된 수 목록의 백분위 (최근접 순위) */
function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

/** 기록기 안내 한 줄 */
function note(env: SelftestEnv, message: string, fields: Record<string, unknown> = {}): void {
  env.recorder.push({ t: round(env.now()), kind: 'note', message, ...fields });
}

/** 다음 프레임 시각. `timeoutMs` 안에 오지 않으면 null (창이 숨어 rAF 가 멈췄을 때) */
function nextFrame(env: SelftestEnv, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    env.raf((time) => {
      clearTimeout(timer);
      resolve(time);
    });
  });
}

/**
 * 앱이 잠잠해지기를 기다린다: 화면이 떴고(`[data-panel]`), 시작 뒤 `minMs` 가 지났고, IPC·코어 이벤트가 `quietMs` 동안 없을 때.
 * `maxMs` 를 넘기면 그대로 돌려준다(`quiet: false`). 창이 보이는지는 따로 기다린다(`waitForVisible`)
 */
export async function waitForQuiet(
  env: SelftestEnv,
  timing: Pick<SelftestTiming, 'minMs' | 'quietMs' | 'maxMs'>,
): Promise<{ waitedMs: number; quiet: boolean }> {
  const begin = env.now();
  for (;;) {
    const now = env.now();
    const ready =
      document.querySelector('[data-panel]') !== null &&
      now - env.startedAt >= timing.minMs &&
      now - env.lastActivity() >= timing.quietMs;
    if (ready) return { waitedMs: round(now - begin), quiet: true };
    if (now - begin >= timing.maxMs) return { waitedMs: round(now - begin), quiet: false };
    await env.sleep(250);
  }
}

/** 창이 보이는지 */
const isVisible = (env: SelftestEnv): boolean =>
  env.visible ? env.visible() : document.visibilityState === 'visible';

/**
 * 창이 보이고 rAF 가 실제로 올 때까지 기다린다 (상한 없음 — 화면 잠금·다른 창에 가려짐·최소화가 풀릴 때까지). 기다렸으면 그
 * 까닭(`hidden` = 숨음, `no frames` = 보이는데 프레임이 오지 않음)을 준다
 */
export async function waitForVisible(
  env: SelftestEnv,
  timing: Pick<SelftestTiming, 'frameTimeoutMs' | 'visibleCheckMs'>,
): Promise<{ waitedMs: number; reason: string | null }> {
  const begin = env.now();
  let reason: string | null = null;
  for (;;) {
    if (isVisible(env)) {
      if ((await nextFrame(env, timing.frameTimeoutMs)) !== null)
        return { waitedMs: round(env.now() - begin), reason };
      reason ??= 'no frames';
    } else {
      reason ??= 'hidden';
      await env.sleep(timing.visibleCheckMs);
    }
  }
}

/** 탐침 하나의 결과: 끝남, 창이 가려져 끊김(다시 할 것), 보이는데 프레임이 멈춤(진단을 끝낼 것) */
type ProbeResult = 'done' | 'interrupted' | 'stalled';

/**
 * 탐침 하나: 준비 → 두 프레임 쉬기 → N 프레임 동안 바꾸며 간격 재기 → 되돌리기. 도중에 창이 숨거나 프레임이 끊기면 되돌리고
 * 그 탐침을 버린다 — 창이 숨었으면 `interrupted`(줄을 남기지 않는다), 보이는데 프레임이 없으면 `stalled`(줄을 남긴다)
 */
async function runProbe(
  env: SelftestEnv,
  probe: Probe,
  frames: number,
  stage: string,
  timing: SelftestTiming,
): Promise<ProbeResult> {
  const state = documentState();
  const base = { kind: 'selftest', probe: probe.name, stage };
  let prepared: Prepared | string;
  try {
    prepared = probe.prepare(frames);
  } catch (error) {
    prepared = `error: ${String(error)}`;
  }
  if (typeof prepared === 'string') {
    env.recorder.push({ t: round(env.now()), ...base, skipped: prepared, state });
    return 'done';
  }
  const gaps: number[] = [];
  const start = env.now();
  let cut = false;
  try {
    // 준비가 바꾼 것(요소 넣기 등)을 먼저 그리고 시작한다
    for (let i = 0; i < 2 && !cut; i += 1)
      cut = (await nextFrame(env, timing.frameTimeoutMs)) === null || !isVisible(env);
    env.takeCommitMs();
    let last = cut ? null : await nextFrame(env, timing.frameTimeoutMs);
    for (let i = 0; i < frames && last !== null && isVisible(env); i += 1) {
      prepared.step(i);
      const time = await nextFrame(env, timing.frameTimeoutMs);
      if (time === null) break;
      gaps.push(time - last);
      last = time;
    }
    cut = cut || last === null || gaps.length < frames || !isVisible(env);
  } finally {
    prepared.restore();
  }
  const react = env.takeCommitMs();
  if (cut && !isVisible(env)) {
    note(env, 'selftest probe interrupted', { probe: probe.name, stage, frames: gaps.length });
    return 'interrupted';
  }
  const stalled = cut;
  const sorted = [...gaps].sort((a, b) => a - b);
  env.recorder.push({
    t: round(start),
    ...base,
    ms: round(env.now() - start),
    frames: gaps.length,
    p50: round(pct(sorted, 0.5)),
    p95: round(pct(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
    react,
    state,
    ...(prepared.detail ? { detail: prepared.detail } : {}),
    ...(stalled ? { stalled: true } : {}),
  });
  if (!stalled) await nextFrame(env, timing.frameTimeoutMs);
  return stalled ? 'stalled' : 'done';
}

/**
 * 탐침들을 차례로 돈다. 창이 가려져 끊긴 탐침은 창이 다시 보일 때까지 기다렸다가(기다린 시간·까닭을 안내로) 그 탐침부터 다시
 * 한다. 보이는데 프레임이 멈췄으면 false (나머지를 돌리지 않는다)
 */
async function runProbes(
  env: SelftestEnv,
  probes: Probe[],
  stage: string,
  options: SelftestOptions,
  timing: SelftestTiming,
): Promise<boolean> {
  for (const probe of probes) {
    for (;;) {
      const result = await runProbe(env, probe, options.frames, stage, timing);
      if (result === 'stalled') return false;
      if (result === 'done') break;
      env.badge?.show('waiting');
      const shown = await waitForVisible(env, timing);
      note(env, 'selftest waited for visible', { ...shown, phase: `${stage}:${probe.name}` });
      // 오래 가려져 있었으면 돌아온 직후의 갱신(포커스 갱신 등)이 지나가길 잠깐 기다린다
      await waitForQuiet(env, { minMs: 0, quietMs: timing.quietMs, maxMs: 8_000 });
      env.badge?.show('running');
    }
  }
  return true;
}

/** 창 크기 문자열 */
const sizeOf = (v: { width: number; height: number; dpr: number }) =>
  `${v.width}x${v.height}@${v.dpr}`;

/** 창 크기가 `from` 과 달라진 뒤 `resizeSettleMs` 동안 그대로이길 기다린다. 바뀌었으면 true */
async function waitForViewport(
  env: SelftestEnv,
  from: string,
  timing: SelftestTiming,
): Promise<boolean> {
  const begin = env.now();
  let last = sizeOf(viewportOf());
  let stableSince = env.now();
  while (env.now() - begin < timing.resizeMaxMs) {
    await env.sleep(100);
    const size = sizeOf(viewportOf());
    if (size !== last) {
      last = size;
      stableSince = env.now();
    }
    if (size !== from && env.now() - stableSince >= timing.resizeSettleMs) return true;
  }
  return last !== from;
}

/** 창 크기를 바꿔(최대화 켜고 끄기) 일부 탐침을 다시 재고, 원래 최대화 상태로 되돌린다 */
async function resizedStage(
  env: SelftestEnv,
  control: WindowControl,
  probes: Probe[],
  options: SelftestOptions,
  timing: SelftestTiming,
): Promise<void> {
  const before = sizeOf(viewportOf());
  let maximized: boolean;
  try {
    maximized = await control.isMaximized();
    await control.toggle();
  } catch (error) {
    note(env, 'selftest window toggle failed', { error: String(error) });
    return;
  }
  const changed = await waitForViewport(env, before, timing);
  const after = sizeOf(viewportOf());
  note(env, 'selftest window resized', {
    from: before,
    to: after,
    wasMaximized: maximized,
    changed,
  });
  if (changed) {
    await waitForQuiet(env, { minMs: 0, quietMs: timing.quietMs, maxMs: 8_000 });
    await runProbes(env, probes, 'resized', options, timing);
  }
  // 되돌리기: 최대화 상태가 처음과 같아질 때까지 (두 번까지)
  let restored = false;
  for (let attempt = 0; attempt < 2 && !restored; attempt += 1) {
    try {
      if ((await control.isMaximized()) !== maximized) {
        await control.toggle();
        await waitForViewport(env, after, timing);
      }
      restored = (await control.isMaximized()) === maximized;
    } catch (error) {
      note(env, 'selftest window restore failed', { error: String(error) });
      break;
    }
  }
  note(env, 'selftest window restored', { restored, size: sizeOf(viewportOf()) });
}

/**
 * 자가 진단 한 번: 잠잠해지기 기다림(상한 있음) → 창이 보이고 프레임이 올 때까지 기다림(상한 없음) → 설정 키 지우기(측정을 실제로
 * 시작할 때 — 기다리는 동안 앱이 닫히면 다음 실행에서 다시 돈다) → 탐침 차례로(가려지면 멈췄다 잇기) → (네이티브면) 창 크기를
 * 바꿔 일부 다시 → 기록 내보내기 → `exit` 면 창 닫기, 아니면 "끝남" 표시 뒤 창을 열어 둔다
 */
export async function runSelftest(env: SelftestEnv, options: SelftestOptions): Promise<void> {
  const timing = { ...DEFAULT_TIMING, ...env.timing };
  const began = env.now();
  env.badge?.show('waiting');
  const wait = await waitForQuiet(env, timing);
  const shown = await waitForVisible(env, timing);
  if (shown.reason) {
    note(env, 'selftest waited for visible', { ...shown, phase: 'start' });
    await waitForQuiet(env, { minMs: 0, quietMs: timing.quietMs, maxMs: 8_000 });
  }
  note(env, 'selftest begin', { ...options, ...wait, visibleWaitMs: shown.waitedMs });
  try {
    await env.removeKey();
  } catch (error) {
    note(env, 'selftest key not removed', { error: String(error) });
  }
  env.badge?.show('running');
  const probes = probeList();
  const running = await runProbes(env, probes, 'base', options, timing);
  if (running && options.window && env.windowControl) {
    const again = probes.filter((p) => RESIZED_PROBES.has(p.name) || p.name.startsWith('scroll:'));
    await resizedStage(env, env.windowControl, again, options, timing);
  } else if (running) {
    note(env, 'selftest window stage skipped', {
      reason: options.window ? 'no native window' : 'nowindow',
    });
  }
  if (options.exit && !env.close) note(env, 'selftest exit ignored (no native window)');
  note(env, 'selftest done', { ms: round(env.now() - began), completed: running });
  await env.recorder.flush();
  if (options.exit && env.close) {
    await env.close();
    return;
  }
  env.badge?.show('done');
}

/** 실제 창의 최대화 켜고 끄기: 제목 막대 두 번 누르기와 같은 명령(기본 권한 `allow-internal-toggle-maximize`) */
function nativeWindowControl(): WindowControl {
  return {
    async isMaximized() {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      return getCurrentWindow().isMaximized();
    },
    async toggle() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:window|internal_toggle_maximize');
    },
  };
}

/** 지금 도는 진단 (두 번 겹쳐 돌리지 않는다) */
let activeRun: Promise<void> | null = null;

/**
 * 실제 앱에서 자가 진단을 돌린다 (`install.ts`). `manual` 이면(개발 도구 콘솔의 `__mgitPerf.selftest()`) 시작 뒤 최소 대기를
 * 건너뛴다. 창 닫기는 기존 닫기 경로(`mgit-close-requested` → 저장 확인 → 창 파괴)를 탄다
 */
export async function startSelftest(
  recorder: PerfRecorder,
  input: {
    value: string;
    native: boolean;
    startedAt: number;
    lastActivity: () => number;
    takeCommitMs: () => number | null;
    manual?: boolean;
  },
): Promise<void> {
  const options = parseSelftest(input.value);
  if (!options) return;
  if (activeRun) {
    recorder.push({
      t: round(performance.now()),
      kind: 'note',
      message: 'selftest already running',
    });
    return activeRun;
  }
  activeRun = runSelftest(
    {
      recorder,
      now: () => performance.now(),
      raf: (callback) => requestAnimationFrame(callback),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      takeCommitMs: input.takeCommitMs,
      lastActivity: input.lastActivity,
      startedAt: input.startedAt,
      removeKey: async () => {
        if (settingsStorage.getItem(SELFTEST_KEY) === null) return;
        settingsStorage.removeItem(SELFTEST_KEY);
        await flushSettings();
      },
      close: input.native
        ? async () => {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('mgit-close-requested');
          }
        : null,
      windowControl: input.native ? nativeWindowControl() : null,
      badge: createSelftestBadge(DEFAULT_TIMING.badgeDoneMs),
      timing: input.manual ? { minMs: 0 } : undefined,
    },
    options,
  ).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

/**
 * 화면 왼쪽 아래(상태 막대 위)의 작은 진행 표시. body 에 고정 위치로 붙고 누를 수 없다. `done` 이면 `doneMs` 뒤 스스로
 * 지운다. 탐침이 상자를 넣는 오른쪽 아래·영역 왼쪽 위와 겹치지 않는 자리다
 */
export function createSelftestBadge(doneMs: number): SelftestBadge {
  let element: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const remove = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    element?.remove();
    element = null;
  };
  return {
    show(state) {
      if (!element) {
        element = document.createElement('div');
        element.setAttribute('role', 'status');
        element.setAttribute('data-mgit-selftest-badge', '');
        element.style.cssText =
          'position:fixed;left:8px;bottom:30px;z-index:2147483647;pointer-events:none;max-width:360px;padding:3px 8px;border-radius:4px;font:11px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,0.72)';
        document.body.appendChild(element);
      }
      element.dataset.state = state;
      element.textContent = S.perfSelftest[state];
      if (timer !== null) clearTimeout(timer);
      timer = state === 'done' ? setTimeout(remove, doneMs) : null;
    },
    remove,
  };
}
