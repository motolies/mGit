import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface TreeWidthText {
  text: string;
  bold?: boolean;
}
export interface TreeWidthRow {
  depth: number;
  texts: readonly TreeWidthText[];
  icons?: number;
  extra?: number;
}
export interface TreeWidthMetrics {
  indent: number;
  icon: number;
  gap: number;
  padding: number;
}

/** DOM에 없는 가상 행도 포함해 들여쓰기·아이콘·표시 문구의 최대 필요 폭을 구한다. */
export function treeContentWidth(
  rows: readonly TreeWidthRow[],
  measure: (text: string, bold: boolean) => number,
  metrics: TreeWidthMetrics,
): number {
  return Math.ceil(
    rows.reduce(
      (max, row) =>
        Math.max(
          max,
          metrics.padding +
            row.depth * metrics.indent +
            (row.icons ?? 0) * (metrics.icon + metrics.gap) +
            row.texts.reduce(
              (sum, part) => sum + measure(part.text, part.bold === true) + metrics.gap,
              0,
            ) +
            (row.extra ?? 0),
        ),
      0,
    ),
  );
}

/** 글자 폭 캐시가 기억하는 글꼴 수. 넘으면 가장 먼저 넣은 글꼴부터 버린다 */
const MAX_CACHED_FONTS = 8;
/** 글꼴 하나에서 기억하는 글자 수. 넘으면 그 글꼴의 캐시를 비우고 다시 채운다 */
const MAX_CACHED_TEXTS = 50_000;

/**
 * 글꼴(굵기·크기·패밀리 — canvas `font` 문자열)별로 잰 글자 폭. 효과 밖(모듈)에 두어 트리를 다시 그리거나 여러 트리가 같은
 * 글자를 써도 같은 글꼴의 같은 글자는 한 번만 잰다. 글꼴 로딩이 끝나면 비운다(`clearTreeWidthCache`)
 */
const widthCache = new Map<string, Map<string, number>>();
/** 폭을 재는 canvas 컨텍스트 (처음 잴 때 만든다, canvas 가 없으면 null) */
let measureContext: CanvasRenderingContext2D | null | undefined;
/** `measureContext` 에 마지막으로 넣은 글꼴 (같은 글꼴을 다시 넣지 않는다) */
let contextFont = '';
/** 글꼴 로딩으로 캐시를 비운 횟수. 훅이 "입력이 같으면 건너뛰기" 를 할 때 함께 본다 */
let fontEpoch = 0;
/** 글꼴 로딩 완료를 기다리는 훅들 */
const fontListeners = new Set<() => void>();
/** `loadingdone` 을 듣고 있는 글꼴 집합 (문서가 바뀌면 다시 붙인다) */
let hookedFonts: FontFaceSet | undefined;

/**
 * 글자 폭 캐시와 측정 컨텍스트를 비운다. 글꼴 로딩이 끝나 같은 글꼴 이름의 실제 글자 폭이 달라졌을 때 부르고, 테스트가 목
 * canvas 를 새로 쓸 때도 부른다
 */
export function clearTreeWidthCache(): void {
  widthCache.clear();
  measureContext = undefined;
  contextFont = '';
  fontEpoch += 1;
}

/** 글꼴 로딩이 끝났을 때: 캐시를 비우고 훅들이 다시 재게 한다 */
function fontsChanged(): void {
  clearTreeWidthCache();
  for (const listener of [...fontListeners]) listener();
}

/**
 * 글꼴 로딩 완료를 듣는다. 문서의 글꼴 집합에는 듣는 쪽을 하나만 붙인다 (트리마다 붙이지 않는다). 붙일 때 아직 읽는 중이면
 * `ready` 도 기다린다
 */
function onFontsChanged(listener: () => void): () => void {
  fontListeners.add(listener);
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (fonts && hookedFonts !== fonts) {
    hookedFonts?.removeEventListener('loadingdone', fontsChanged);
    hookedFonts = fonts;
    fonts.addEventListener('loadingdone', fontsChanged);
    if (fonts.status === 'loading') void fonts.ready.then(fontsChanged);
  }
  return () => {
    fontListeners.delete(listener);
  };
}

/** 그 글꼴에서 글자 하나의 폭. 캐시에 없을 때만 잰다 (canvas 가 없으면 글자 수 × 글자 크기로 어림한다) */
function textWidth(font: string, size: number, text: string): number {
  let texts = widthCache.get(font);
  if (!texts) {
    if (widthCache.size >= MAX_CACHED_FONTS) {
      const oldest = widthCache.keys().next().value;
      if (oldest !== undefined) widthCache.delete(oldest);
    }
    texts = new Map();
    widthCache.set(font, texts);
  } else if (texts.size >= MAX_CACHED_TEXTS) {
    texts.clear();
  }
  const cached = texts.get(text);
  if (cached !== undefined) return cached;
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
    contextFont = '';
  }
  let value: number;
  if (measureContext && typeof measureContext.measureText === 'function') {
    if (contextFont !== font) {
      measureContext.font = font;
      contextFont = font;
    }
    value = measureContext.measureText(text).width;
  } else
    value = Array.from(text).reduce(
      (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1) * size,
      0,
    );
  texts.set(text, value);
  return value;
}

/** 마지막으로 폭을 계산한 입력. 같으면 다시 계산하지 않는다 */
interface WidthInputs {
  rows: readonly TreeWidthRow[];
  font: string;
  metrics: TreeWidthMetrics;
  epoch: number;
}

/** 두 입력이 같은지 (행은 참조로, 글꼴·간격은 값으로) */
function sameInputs(a: WidthInputs | null, b: WidthInputs): boolean {
  return (
    a !== null &&
    a.rows === b.rows &&
    a.font === b.font &&
    a.epoch === b.epoch &&
    a.metrics.indent === b.metrics.indent &&
    a.metrics.icon === b.metrics.icon &&
    a.metrics.gap === b.metrics.gap &&
    a.metrics.padding === b.metrics.padding
  );
}

/**
 * 현재 글꼴로 전체 펼친 행을 측정하고 폰트 로딩·크기 변경에도 내용 폭을 갱신한다. 글자 폭은 모듈 캐시(`textWidth`)에서
 * 찾으므로 같은 내용으로 다시 그리면 재지 않고, 행 배열·글꼴·간격 토큰이 모두 그대로면 폭 계산도 건너뛴다. 다시 계산하는
 * 때: 행 배열이 바뀜, 요소 크기가 바뀜(글자 크기·배율 변경이 여기로 온다 — 그때 글꼴을 다시 읽는다), 글꼴 로딩 완료
 */
export function useTreeContentWidth(
  ref: RefObject<HTMLElement | null>,
  rows: readonly TreeWidthRow[],
): number {
  const [width, setWidth] = useState(0);
  const latestRows = useRef(rows);
  const last = useRef<WidthInputs | null>(null);
  // 요소의 지금 글꼴·간격 토큰으로 폭을 계산한다. 입력이 지난번과 같으면 아무것도 하지 않는다
  const update = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const px = (name: string, fallback: number) =>
      Number.parseFloat(style.getPropertyValue(name)) || fallback;
    const size = Number.parseFloat(style.fontSize) || 12;
    const family = style.fontFamily || 'sans-serif';
    const inputs: WidthInputs = {
      rows: latestRows.current,
      font: `${size}px ${family}`,
      metrics: {
        indent: px('--tree-indent', 16),
        icon: px('--icon-size', 16),
        gap: px('--space-2', 4),
        padding: 24,
      },
      epoch: fontEpoch,
    };
    if (sameInputs(last.current, inputs)) return;
    last.current = inputs;
    setWidth(
      treeContentWidth(
        inputs.rows,
        (text, bold) => textWidth(`${bold ? 600 : 400} ${inputs.font}`, size, text),
        inputs.metrics,
      ),
    );
  }, [ref]);
  useLayoutEffect(() => {
    latestRows.current = rows;
    update();
  }, [rows, update]);
  // 크기 변화·글꼴 로딩을 한 번만 붙인다 (행이 바뀔 때마다 다시 붙이지 않는다). 붙인 직후의 첫 크기 알림은 입력이 같아 건너뛴다
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const off = onFontsChanged(update);
    return () => {
      observer.disconnect();
      off();
    };
  }, [ref, update]);
  return width;
}

/** 행 이동은 세로 위치만 조정해 사용자가 옮긴 가로 스크롤을 보존한다. */
export function revealTreeRowVertically(
  container: HTMLElement | null,
  row: HTMLElement | null | undefined,
): void {
  if (!container || !row) return;
  const viewport = container.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  if (bounds.top < viewport.top) container.scrollTop += bounds.top - viewport.top;
  else if (bounds.bottom > viewport.bottom) container.scrollTop += bounds.bottom - viewport.bottom;
}
