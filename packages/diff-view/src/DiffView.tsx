import type { DiffDocument, FileDiff, LineSelection } from '@mgit/ipc';
import { settingsStorage } from '@mgit/storage';
import { Button, isImeKey, isPrimaryModifier, S } from '@mgit/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 선택 토글에 필요한 키 정보 (마우스·키보드 공용) */
interface ToggleEvent {
  shiftKey: boolean;
}

import styles from './DiffView.module.css';
import { plainSpans } from './highlight';
import {
  buildContextRows,
  buildDocumentRows,
  buildRows,
  changeStarts,
  type DiffRow,
  type LineRef,
} from './rows';
import {
  changeBlocks,
  changeLineIndices,
  changeRangeKeys,
  changeUnits,
  diffContentKey,
  lineKey,
  rangeKeys,
  selectedText,
  selectionFromKeys,
} from './selection';
import { type HighlightMap, useHighlight } from './use-highlight';
import {
  applyRanges,
  changeRanges,
  type HighlightMode,
  type Piece,
  type Range,
  type Span,
} from './word-diff';

export type DiffMode = 'unified' | 'split';

/** 변경 줄에 적용할 수 있는 동작 */
export interface DiffActions {
  /** 버튼 문구에 쓰는 동작 이름 (stage / unstage) */
  verb: 'stage' | 'unstage';
  disabled?: boolean;
  onApplyHunk(hunk: number): Promise<boolean>;
  onApplyLines(selection: LineSelection[]): Promise<boolean>;
  /** 작업 트리 변경일 때만: 되돌리기 */
  onDiscardHunk?(hunk: number): Promise<boolean>;
  /** false 로 끝나면 (확인에서 취소 등) 선택을 남긴다 */
  onDiscardLines?(selection: LineSelection[]): Promise<boolean>;
}

/** 줄 선택 상태. `key` 는 이 선택을 만든 diff 내용이다 */
interface LineSelectionState {
  key: string;
  lines: ReadonlySet<string>;
  anchor: { hunk: number; index: number } | null;
}

const NO_LINES: ReadonlySet<string> = new Set();
/** 휠 제스처의 끝으로 볼 간격 (ms). 이 안에 이어진 휠은 처음 정한 축(세로·가로)을 따른다 */
const WHEEL_GESTURE_GAP_MS = 120;
/** 탭·제어 문자·비 ASCII 가 섞인 줄 (가로 폭을 글자마다 세야 하는 줄) */
const NOT_PLAIN_ASCII = /[^\x20-\x7e]/;
const consumedArrivals = new WeakSet<DiffArrival>();
/** 변경 덩어리로 옮겨 갈 때 그 위에 남기는 행 수 (위가 모자라면 있는 만큼) */
const CONTEXT_ABOVE = 3;

/**
 * 다음/이전 변경 탐색 (단위는 변경 덩어리 — 문맥이 아닌 행이 이어진 묶음, J). 이름의 `Hunk` 는 옛 이름이고 `@@` 구간이 아니다
 */
export interface DiffNavigation {
  moveHunk(direction: 1 | -1): boolean;
  canMove(direction: 1 | -1): boolean;
  focus(): void;
  moveToHunk(index: number): void;
  available: boolean;
  current: number;
  total: number;
}

export interface DiffArrival {
  token: number;
  edge: 'first' | 'last';
  focus?: boolean;
}

export interface DiffViewProps {
  /** 코드 글자 크기. 생략하면 기존 12px을 유지한다. */
  fontSize?: number;
  arrival?: DiffArrival;
  /** 앱의 유효 키맵에 구간 이동을 연결한다. 반환한 함수는 뷰 변경·해제 때 정리한다 */
  onNavigationReady?: (
    element: HTMLElement,
    navigation: DiffNavigation,
  ) => (() => void) | undefined;
  diff: FileDiff | null;
  document?: DiffDocument | null;
  fullFile?: boolean;
  horizontalSync?: boolean;
  highlightMode?: HighlightMode;
  hideModeControls?: boolean;
  /** 구문 강조 언어 선택용 경로 */
  path: string;
  mode: DiffMode;
  onModeChange?: (mode: DiffMode) => void;
  /** 있으면 hunk·줄 선택과 동작 버튼을 보여 준다 */
  actions?: DiffActions;
  /** 잘린 diff 의 전체를 요청 */
  onLoadFull?: () => void;
  loading?: boolean;
  /** jsdom 용 고정 뷰포트 높이 */
  initialHeight?: number;
  /** 긴 줄 접기. 기본 꺼짐 */
  wrap?: boolean;
  /** 탭 폭 (DIFF-03) */
  tabWidth?: number;
}

/** 저장된 분할 폭이 유효할 때만 재사용한다. 저장소 접근이 막히면 기본 50:50을 쓴다. */
function readSplitRatio(): number {
  try {
    const saved = Number(settingsStorage.getItem('mgit.diff.splitRatio'));
    return Number.isFinite(saved) && saved >= 20 && saved <= 80 ? saved : 50;
  } catch {
    return 50;
  }
}

/** 줄 번호 표시 폭 (자리수) */
function digits(diff: FileDiff): number {
  let max = 1;
  for (const h of diff.hunks) {
    max = Math.max(max, h.oldStart + h.oldLines, h.newStart + h.newLines);
  }
  return Math.max(2, String(max).length);
}

/** 줄 하나의 조각을 만든다 (구문 + 단어 강조) */
function piecesOf(
  ref: LineRef,
  pair: LineRef | null,
  highlight: HighlightMap,
  mode: HighlightMode,
): Piece[] {
  const spans: Span[] = highlight.get(ref.hunk)?.get(ref.index) ?? plainSpans(ref.line.text);
  let ranges: Range[] = [];
  if (pair && ref.line.kind !== 'context') {
    const w =
      ref.line.kind === 'del'
        ? changeRanges(ref.line.text, pair.line.text, mode)
        : changeRanges(pair.line.text, ref.line.text, mode);
    ranges = ref.line.kind === 'del' ? w.del : w.add;
  }
  return applyRanges(spans, ranges);
}

/**
 * 줄바꿈이 꺼져 있을 때 높이를 재야 하는 행인지 (반응성 H). 코드 줄(`.line`·`.half`)은 한 줄이고 min-height·line-height 가
 * 모두 `--diff-line-height` 라 높이가 글자 크기로 정해진다 — 재지 않고 어림값을 그대로 쓴다(행마다 ResizeObserver 를 달고 붙을
 * 때마다 크기를 읽던 비용이 없다). 재는 것: hunk 머리 줄(위아래 패딩·테두리와 UI 글꼴의 줄 높이, 좁으면 단추가 다음 줄로
 * 넘어간다)과 "줄 끝 개행 없음" 표시가 있는 줄(작은 글자가 기준선에 붙어 줄 상자가 1px 안팎 커질 수 있다)
 */
function needsMeasure(row: DiffRow): boolean {
  if (row.kind === 'hunk') return true;
  if (row.kind === 'line') return row.ref.line.noNewline;
  return !!row.left?.line.noNewline || !!row.right?.line.noNewline;
}

/** 정렬된 `sorted` 에서 `value` 이하인 값의 개수 (덩어리 차례: 그 위치까지 시작한 변경 덩어리 수, 앞이면 0) */
function countAtOrBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 정렬된 `sorted` 에서 `value` 보다 작은 값의 개수 */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 조각을 span 으로 */
function renderPieces(pieces: Piece[]) {
  return pieces.map((p, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: 조각은 순서로만 식별된다
      key={i}
      className={[p.cls, p.changed ? styles.word : ''].filter(Boolean).join(' ')}
    >
      {p.text}
    </span>
  ));
}

/**
 * unified·split diff 뷰 (DIFF-01·02).
 * - 행은 @tanstack/react-virtual 로 가상화한다. 줄바꿈을 켜면 가변 높이를 재고, 끄면 코드 줄은 글자 크기로 정해진 높이라 재지
 *   않는다 (hunk 머리 줄 등만 잰다 — `needsMeasure`)
 * - 커서 줄이 없다 (J): 키보드는 본문을 브라우저 기본으로 스크롤하고, 줄 선택·되돌리기는 거터의 체크·단추로 한다. 다음/이전
 *   변경은 변경 덩어리 단위로 옮겨 가며(위에 문맥 3줄) 스크롤 말고는 DOM 을 바꾸지 않는다
 * - 구문 강조는 비동기(언어 lazy 로드), 단어 강조는 짝지은 삭제·추가 줄에만
 * - `actions` 가 있으면 hunk 헤더 버튼과 줄 체크박스로 부분 스테이징·되돌리기
 */
export function DiffView({
  fontSize = 12,
  diff,
  document,
  fullFile = true,
  horizontalSync = true,
  highlightMode = 'character',
  hideModeControls = false,
  path,
  mode,
  onModeChange,
  actions: givenActions,
  onLoadFull,
  loading,
  initialHeight,
  wrap = false,
  tabWidth = 4,
  onNavigationReady,
  arrival,
}: DiffViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const leftScroll = useRef<HTMLElement>(null);
  const rightScroll = useRef<HTMLElement>(null);
  const [splitRatio, setSplitRatio] = useState(readSplitRatio);
  const offsets = useRef({ left: 0, right: 0 });
  const pendingScroll = useRef<{ left?: number; right?: number }>({});
  // 비 UTF-8 줄은 코어가 줄 단위 stage·discard 를 거부한다
  const actions = diff?.nonUtf8 || diff?.truncated ? undefined : givenActions;
  const worktree = actions?.verb === 'stage' && !!actions.onDiscardLines;
  const [selectionUnit, setSelectionUnit] = useState<'block' | 'line'>('block');
  const blockMode = worktree && selectionUnit === 'block';
  const units = useMemo(
    () => diff?.hunks.map(blockMode ? changeBlocks : changeUnits) ?? [],
    [diff, blockMode],
  );
  const blockStarts = useMemo(
    () => new Set(units.flatMap((hunk, hi) => hunk.map((unit) => lineKey(hi, unit[0] ?? -1)))),
    [units],
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const disabled = !!loading || !!actions?.disabled || pending;
  const contentKey = useMemo(
    () => `${diffContentKey(path, diff)}:${document?.revision ?? ''}`,
    [path, diff, document?.revision],
  );
  const textSelectionKey = `${contentKey}:${mode}:${fullFile}`;
  const [allText, setAllText] = useState<{
    key: string;
    side: 'left' | 'right' | 'unified';
  } | null>(null);
  const textSide = useRef<'left' | 'right'>('right');
  const selectedTextSide = allText?.key === textSelectionKey ? allText.side : null;
  // 다른 문서나 보기 구성으로 바뀌면 이전 전체 선택을 복원하지 않는다.
  useEffect(() => {
    if (!allText || allText.key === textSelectionKey) return;
    setAllText(null);
    const selection = window.getSelection();
    if (selection?.anchorNode && scrollRef.current?.contains(selection.anchorNode))
      selection.removeAllRanges();
  }, [textSelectionKey, allText]);
  const [lineState, setSelection] = useState<LineSelectionState>({
    key: '',
    lines: NO_LINES,
    anchor: null,
  });
  // 다른 diff 의 선택은 쓰지 않는다 (그 위치는 이 diff 에서 다른 줄이다)
  const selected = lineState.key === contentKey ? lineState.lines : NO_LINES;
  const anchor = lineState.key === contentKey ? lineState.anchor : null;
  const originals = useMemo(
    () =>
      document?.old.content != null && document.new.content != null
        ? { old: document.old.content, new: document.new.content }
        : undefined,
    [document],
  );
  const highlight = useHighlight(diff, path, originals);
  const rows = useMemo<DiffRow[]>(
    () =>
      diff
        ? (fullFile || diff.hunks.length === 0) && originals
          ? buildDocumentRows(diff, originals.old, originals.new, mode)
          : originals
            ? buildContextRows(diff, originals.old, originals.new, mode)
            : buildRows(diff, mode)
        : [],
    [diff, mode, fullFile, originals],
  );
  // 효과 안에서 지금 행을 읽는다 (행이 바뀔 때마다 다시 재지 않게 의존성에 넣지 않는다)
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const width = Math.max(
    diff ? digits(diff) : 2,
    String(Math.max(document?.old.lineCount ?? 0, document?.new.lineCount ?? 0)).length,
  );
  // 변경 덩어리마다 첫 행 (J): 다음/이전 변경·"n / 전체"·변경 위치 띠의 단위. `@@` 머리 줄은 이동 대상이 아니다
  const chunkRows = useMemo(() => changeStarts(rows), [rows]);
  const columns = useMemo(() => {
    let left = 0;
    let right = 0;
    /** 탭과 전각 문자를 반영하여 가상화 밖의 긴 행까지 가로 이동 범위를 확보한다. */
    const length = (text: string) => {
      // 탭·제어 문자·비 ASCII 가 없으면 글자 수가 곧 폭이다 (문서가 바뀔 때 모든 줄을 한 글자씩 돌던 비용, E-3)
      if (!NOT_PLAIN_ASCII.test(text)) return text.length;
      let count = 0;
      for (const char of text)
        count +=
          char === '\t'
            ? tabWidth - (count % tabWidth)
            : (char.codePointAt(0) ?? 0) >= 0x1100
              ? 2
              : 1;
      return count;
    };
    for (const row of rows) {
      if (row.kind === 'split') {
        left = Math.max(left, length(row.left?.line.text ?? ''));
        right = Math.max(right, length(row.right?.line.text ?? ''));
      } else if (row.kind === 'line') right = Math.max(right, length(row.ref.line.text));
    }
    return { left, right };
  }, [rows, tabWidth]);

  // 코드 줄 높이 (CSS `--diff-line-height` 와 같은 값). 줄바꿈이 꺼져 있으면 코드 줄은 이 높이 그대로라 재지 않는다 (H)
  const lineHeight = (20 * fontSize) / 12;
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => lineHeight,
    overscan: 20,
    // 스크롤마다 동기로(flushSync) 다시 그리지 않는다: 같은 스크롤 이벤트의 커서 갱신과 한 번에 그린다 (E-3, 라이브러리가
    // 성능을 위해 끄라고 안내하는 옵션)
    useFlushSync: false,
    ...(initialHeight ? { initialRect: { width: 800, height: initialHeight } } : {}),
  });

  /** 분할 폭도 다른 보기 설정처럼 다음 파일과 세션에서 재사용한다. */
  useEffect(() => {
    try {
      settingsStorage.setItem('mgit.diff.splitRatio', String(splitRatio));
    } catch {
      /* 저장이 막힌 환경에서도 현재 화면은 유지한다. */
    }
  }, [splitRatio]);

  /** 다른 파일이나 revision으로 전환한 선택은 다시 돌아와도 복원하지 않는다. */
  useEffect(() => {
    setSelection((previous) =>
      previous.key === contentKey ? previous : { key: contentKey, lines: NO_LINES, anchor: null },
    );
  }, [contentKey]);

  /** 확인창부터 갱신 완료까지 중복 실행을 막고 성공한 요청의 선택만 지운다. */
  const run = async (action: () => Promise<boolean>) => {
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (await action()) {
        setSelection((previous) =>
          previous.key === contentKey
            ? { key: contentKey, lines: NO_LINES, anchor: null }
            : previous,
        );
      }
    } catch {
      // 실행 오류는 호출자가 표시하며 실패한 선택은 재시도를 위해 유지한다.
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  /** 화살표는 체크 선택과 무관하게 현재 단위의 변경만 실행한다. */
  const discardRow = (ref: LineRef) => {
    const hunk = diff?.hunks[ref.hunk];
    const discard = actions?.onDiscardLines;
    if (!hunk || !discard || ref.line.kind === 'context') return;
    const lines = units[ref.hunk]?.find((unit) => unit.includes(ref.index));
    if (lines) void run(() => discard([{ hunk: ref.hunk, lines }]));
  };
  // 행에 넘기는 되돌리기는 참조가 바뀌지 않게 한다 — 그려진 행은 스크롤·커서 이동에 다시 그리지 않는다 (E-3). 부를 때는 지금
  // 그린 값(`discardRow`)으로 돈다
  const discardRef = useRef(discardRow);
  discardRef.current = discardRow;
  const onDiscardRow = useCallback((ref: LineRef) => discardRef.current(ref), []);

  /**
   * 글자 크기·줄바꿈·분할 폭·탭 폭·보기 모드가 바뀌면 잰 높이를 버리고 다시 잰다. 줄바꿈이 켜져 있으면 본문 폭이 바뀔 때도 버린다
   * (화면 밖 행의 옛 높이가 남지 않게). 줄바꿈이 꺼져 있으면 폭으로 높이가 바뀌는 행은 hunk 머리 줄뿐이고 그 행은 제 관찰자가
   * 다시 잰다 — 본문 크기가 바뀔 때마다(처음 그린 직후 포함) 잰 높이를 모두 버려 머리 줄이 어림값으로 돌아가고 뒤 행이 모두
   * 자리를 옮기던 것을 하지 않는다 (H)
   */
  useEffect(() => {
    void fontSize;
    void splitRatio;
    void tabWidth;
    void mode;
    const element = scrollRef.current;
    /**
     * 잰 높이를 버리고, 지금 붙어 있는 행 중 재는 행은 곧바로 다시 잰다 — 버리기만 하면 크기가 그대로인 행(보기 모드를 바꿔도
     * 같은 자리의 hunk 머리 줄 등)은 관찰자가 다시 알리지 않아 어림값으로 남았다
     */
    const remeasure = () => {
      virtualizer.measure();
      // 버린 뒤의 위치를 먼저 다시 계산한다 — 라이브러리는 잰 값을 직전 계산의 크기와 견주므로, 그대로 두면 크기가 같은 행의
      // 다시 재기를 "바뀐 것 없음" 으로 넘긴다
      virtualizer.getTotalSize();
      for (const node of element?.querySelectorAll<HTMLElement>('[data-index]') ?? []) {
        const row = rowsRef.current[Number(node.dataset.index)];
        if (row && (wrap || needsMeasure(row))) virtualizer.measureElement(node);
      }
    };
    remeasure();
    if (!element || !wrap) return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fontSize, wrap, splitRatio, tabWidth, mode, virtualizer]);

  /**
   * 공통 세로 뷰포트 안의 코드만 이동해 거터와 중앙 경계를 고정한다. 아래 막대의 scroll 이벤트(프레임에 한 번)가 부른다.
   * 막대 위치를 모두 읽고 쓴 뒤에 CSS 변수를 마지막에 쓴다 — 변수를 먼저 쓰면 그 뒤 막대를 읽을 때 그려진 모든 줄의 스타일을
   * 그 자리에서 다시 계산했다 (F-2). 값이 같으면 변수를 다시 쓰지 않는다
   */
  const scrollHorizontal = useCallback(
    (side: 'left' | 'right', value: number) => {
      if (pendingScroll.current[side] === value) {
        delete pendingScroll.current[side];
        return;
      }
      delete pendingScroll.current[side];
      const other = side === 'left' ? 'right' : 'left';
      let otherValue: number | null = null;
      if (horizontalSync) {
        const bar = other === 'left' ? leftScroll.current : rightScroll.current;
        if (bar && bar.scrollLeft !== value) {
          bar.scrollLeft = value;
          pendingScroll.current[other] = bar.scrollLeft;
        }
        otherValue = bar?.scrollLeft ?? value;
      }
      const setOffset = (at: 'left' | 'right', offset: number) => {
        if (offsets.current[at] === offset) return;
        offsets.current[at] = offset;
        viewRef.current?.style.setProperty(`--diff-${at}-scroll`, `${offset}px`);
      };
      setOffset(side, value);
      if (otherValue !== null) setOffset(other, otherValue);
    },
    [horizontalSync],
  );

  /** 동기화를 켜거나 파일이 바뀌면 가로 위치를 공통 시작점으로 맞춘다. */
  useEffect(() => {
    void contentKey;
    void horizontalSync;
    void wrap;
    void mode;
    offsets.current = { left: 0, right: 0 };
    viewRef.current?.style.setProperty('--diff-left-scroll', '0px');
    viewRef.current?.style.setProperty('--diff-right-scroll', '0px');
    if (leftScroll.current) leftScroll.current.scrollLeft = 0;
    if (rightScroll.current) rightScroll.current.scrollLeft = 0;
  }, [contentKey, horizontalSync, wrap, mode]);

  const horizontalEnabled = !!diff && !diff.binary && !wrap;
  /**
   * 비동기 원문 로드 뒤 새 본문에도 휠을 연결한다. 거터·빈 반쪽도 해당 패널을 따른다 (F-2).
   * - 세로는 브라우저 기본 스크롤에 맡긴다: 리스너는 passive 라 휠마다 화면 스레드가 스크롤을 기다리지 않는다. 전에는 트랙패드가
   *   세로로 굴릴 때 섞는 작은 가로 성분 때문에 휠마다 기본 스크롤을 취소하고 스크립트로 옮겼다 (휠마다 그려진 모든 줄의 스타일을
   *   다시 계산하고, 브라우저에 따라 세로로 두 번 움직였다)
   * - 가로로 보는 휠: Shift+휠, 또는 가로 성분이 더 큰 휠. 한 제스처 안에서는 처음 정한 축을 지킨다 — 손가락이 조금 흔들려도
   *   세로 스크롤이 끊기지 않게. 세로 본문은 `overflow-x: hidden` 이라 가로 휠을 기본 동작으로 쓰지 않으므로 취소하지 않고
   *   아래 막대만 옮긴다. 막대의 scroll 이벤트(프레임에 한 번)가 코드를 옮긴다 (`scrollHorizontal`)
   * - Shift+휠이 세로 성분(deltaY)으로만 오는 환경(OS 가 가로로 바꿔 주지 않을 때)에서는 기본 동작이 세로 스크롤이라 가로와
   *   함께 움직인다. 그래서 Shift 를 누르는 동안에만 그런 휠을 취소하는 리스너(passive 아님)를 따로 건다 — 평소 스크롤은
   *   취소할 수 있는 리스너를 기다리지 않는다
   */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !horizontalEnabled) return;
    const gesture = { axis: null as 'x' | 'y' | null, at: 0 };
    const wheel = (event: WheelEvent) => {
      const now = performance.now();
      if (now - gesture.at > WHEEL_GESTURE_GAP_MS) gesture.axis = null;
      gesture.at = now;
      gesture.axis ??= Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'x' : 'y';
      if (!event.shiftKey && gesture.axis === 'y') return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      const panel =
        event.target instanceof Element
          ? event.target.closest('[data-side], [data-scroll-side]')
          : null;
      const side = panel?.getAttribute('data-side') ?? panel?.getAttribute('data-scroll-side');
      const bar = side === 'left' ? leftScroll.current : rightScroll.current;
      if (bar) {
        const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? bar.clientWidth : 1;
        bar.scrollLeft += delta * unit;
      }
    };
    // Shift 를 누르는 동안만: 세로 성분으로만 온 Shift+휠의 세로 스크롤을 막는다
    const cancelShiftVertical = (event: WheelEvent) => {
      if (event.shiftKey && event.deltaY && !event.deltaX) event.preventDefault();
    };
    let cancelling = false;
    const setCancelling = (on: boolean) => {
      if (on === cancelling) return;
      cancelling = on;
      if (on) element.addEventListener('wheel', cancelShiftVertical, { passive: false });
      else element.removeEventListener('wheel', cancelShiftVertical);
    };
    const shift = (event: KeyboardEvent) => setCancelling(event.shiftKey);
    const blur = () => setCancelling(false);
    element.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('keydown', shift, true);
    window.addEventListener('keyup', shift, true);
    window.addEventListener('blur', blur);
    return () => {
      setCancelling(false);
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', shift, true);
      window.removeEventListener('keyup', shift, true);
      window.removeEventListener('blur', blur);
    };
  }, [horizontalEnabled]);

  /** 체크박스·클릭으로 줄 선택을 토글한다. Shift 면 같은 hunk 안의 범위 */
  const toggle = useCallback(
    (ref: LineRef, e: ToggleEvent) => {
      if (!diff || !actions || disabled || pendingRef.current) {
        return;
      }
      const next = new Set(selected);
      const h = diff.hunks[ref.hunk];
      const indices =
        worktree && h
          ? (units[ref.hunk]?.find((unit) => unit.includes(ref.index)) ?? [ref.index])
          : [ref.index];
      const keys = indices.map((index) => lineKey(ref.hunk, index));
      if (e.shiftKey && anchor && anchor.hunk === ref.hunk && h) {
        for (const k of (worktree ? changeRangeKeys : rangeKeys)(
          h,
          ref.hunk,
          anchor.index,
          ref.index,
          blockMode,
        )) {
          next.add(k);
        }
      } else if (keys.every((key) => next.has(key))) {
        for (const key of keys) next.delete(key);
      } else {
        for (const key of keys) next.add(key);
      }
      setSelection({
        key: contentKey,
        lines: next,
        anchor: { hunk: ref.hunk, index: ref.index },
      });
    },
    [diff, actions, anchor, selected, contentKey, disabled, worktree, units, blockMode],
  );

  const position = useRef({ path: '', ordinal: 0 });
  const positioned = useRef<{ key: string; element: HTMLElement } | null>(null);
  /** 마지막으로 옮겨 간 변경 덩어리의 첫 행 (화면에 그리지 않는다 — 다음/이전 변경의 기준으로만 쓴다, J) */
  const landedRef = useRef<{ key: string; row: number } | null>(null);

  /**
   * 다음/이전 변경의 기준 위치 (반응성 J). 마지막으로 옮겨 간 덩어리의 첫 행이 아직 화면에 보이면 그 행, 스크롤해 벗어났으면
   * 보이는 맨 위 줄 바로 위(행 번호 − 0.5). 그래서 스크롤한 뒤 "다음" 은 맨 위 줄부터 보이는 첫 덩어리, "이전" 은 맨 위 줄보다 위에서
   * 시작한 마지막 덩어리로 가고, 옮겨 간 뒤 연달아 누르면 하나씩 넘어간다. 스크롤해도 DOM 을 바꾸지 않으므로 누르는 그때 계산한다
   */
  const anchorPosition = useCallback((): number => {
    const landed = landedRef.current?.key === contentKey ? landedRef.current.row : null;
    const element = scrollRef.current;
    if (!element) return landed ?? -0.5;
    const top = element.scrollTop;
    if (landed !== null) {
      const height = virtualizer.scrollRect?.height || element.clientHeight;
      // 본문 높이를 모르면(숨은 칸·배치 전) 보이는지 가릴 수 없다 — 옮겨 간 곳을 그대로 기준으로 삼는다
      if (height <= 0) return landed;
      const item = virtualizer.measurementsCache[landed];
      // 일부만 보여도 보이는 것으로 친다 (높이 0 인 행은 그 자리가 화면 안이면)
      if (item && item.start < top + height && (item.end > top || item.start >= top)) return landed;
    }
    const first = virtualizer.getVirtualItemForOffset(top + 1);
    if (!first) return landed ?? -0.5;
    // 맨 위에 걸친 줄이 없으면(내용 끝을 지나 스크롤된 상태) 끝을 기준으로 삼는다 — 다음은 없고 이전은 마지막 덩어리
    if (first.end <= top) return virtualizer.options.count - 0.5;
    return first.index - 0.5;
  }, [virtualizer, contentKey]);

  // 도구 모음의 "n / 전체" 에 보이는 덩어리 차례. 옮겨 가거나 스크롤해 기준 위치가 다른 덩어리로 넘어갈 때만 바꾼다 — 스크롤
  // 프레임마다 상태를 바꾸지 않는다 (H, 받는 쪽의 탐색 등록도 이 값이 바뀔 때만 새로 한다 E-3)
  const [shownChange, setShownChange] = useState({ key: '', ordinal: 0 });
  const shownRef = useRef(shownChange);
  shownRef.current = shownChange;
  /** 보이는 차례가 지금과 다를 때만 바꾼다 */
  const noteChange = useCallback(
    (ordinal: number) => {
      const prev = shownRef.current;
      if (prev.key === contentKey && prev.ordinal === ordinal) return;
      const next = { key: contentKey, ordinal };
      shownRef.current = next;
      setShownChange(next);
    },
    [contentKey],
  );
  /** 기준 위치의 덩어리 차례: 그 위치(스크롤했으면 맨 위 줄)까지 시작한 덩어리 수 */
  const ordinalAt = useCallback(
    (at: number) => countAtOrBelow(chunkRows, Math.ceil(at)),
    [chunkRows],
  );

  /**
   * 덩어리 첫 행으로 옮겨 간다: 위에 문맥 3줄을 남기고 스크롤만 한다(줄 선택·stage 를 하지 않고, 스크롤 말고는 DOM 을 바꾸지
   * 않는다 — 상태는 "n / 전체" 가 바뀔 때 한 번)
   */
  const moveTo = useCallback(
    (index: number) => {
      const row = Math.max(0, Math.min(rows.length - 1, index));
      landedRef.current = { key: contentKey, row };
      position.current.ordinal = Math.max(0, countAtOrBelow(chunkRows, row) - 1);
      noteChange(countAtOrBelow(chunkRows, row));
      virtualizer.scrollToIndex(Math.max(0, row - CONTEXT_ABOVE), { align: 'start' });
    },
    [contentKey, rows.length, virtualizer, chunkRows, noteChange],
  );

  /** 새 문서를 처음 열 때 첫 변경 덩어리로 이동한다. 보기 모드 전환도 새 행 위치를 적용한다. */
  useEffect(() => {
    void contentKey;
    void mode;
    void fullFile;
    // 경로가 먼저 바뀌고 원문이 나중에 도착하는 중간 렌더에서는 도착 요청을 소비하지 않는다.
    if (loading || !diff || (diff.newPath ?? diff.oldPath) !== path || !scrollRef.current) return;
    const fresh = !!arrival && !consumedArrivals.has(arrival);
    const layoutKey = JSON.stringify([contentKey, mode, fullFile]);
    // 같은 내용의 자동 재조회는 현재 스크롤을 다시 이동시키지 않는다.
    if (
      !fresh &&
      positioned.current?.key === layoutKey &&
      positioned.current.element === scrollRef.current
    )
      return;
    positioned.current = { key: layoutKey, element: scrollRef.current };
    const changedPath = position.current.path !== path;
    const ordinal = fresh
      ? arrival.edge === 'last'
        ? chunkRows.length - 1
        : 0
      : changedPath
        ? 0
        : position.current.ordinal;
    position.current.path = path;
    moveTo(chunkRows[Math.max(0, Math.min(ordinal, chunkRows.length - 1))] ?? 0);
    if (fresh) {
      consumedArrivals.add(arrival);
      if (arrival.focus) scrollRef.current?.focus();
    }
  }, [contentKey, mode, fullFile, chunkRows, moveTo, arrival, path, loading, diff]);

  // 기준 위치의 덩어리 차례 (1부터, 첫 덩어리 위면 0). 도구 모음의 "n / 전체" 가 쓴다 — 덩어리가 바뀔 때만 바뀐다
  const currentChange = chunkRows.length
    ? shownChange.key === contentKey
      ? shownChange.ordinal
      : 1
    : 0;
  /**
   * 다음·이전 변경 덩어리로 옮기며 양끝에서 멈춘다(끝이면 false — 받는 쪽이 다음 파일로 넘어간다). 이동은 누르는 그때의 기준
   * 위치(`anchorPosition`)로 판단하므로 등록은 덩어리 차례가 바뀔 때만 새로 한다 — 줄마다 새로 등록하면 받는 쪽(도구 모음)이
   * 프레임마다 다시 그려졌다 (E-3)
   */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !onNavigationReady) {
      return;
    }
    /** 기준 위치에서 그 방향의 다음 덩어리 첫 행 (없으면 undefined) */
    const target = (direction: 1 | -1) => {
      const at = anchorPosition();
      return direction === 1
        ? chunkRows[countAtOrBelow(chunkRows, at)]
        : chunkRows[countBelow(chunkRows, at) - 1];
    };
    return onNavigationReady(element, {
      available: chunkRows.length > 0,
      canMove: (direction) => target(direction) !== undefined,
      focus: () => element.focus(),
      moveToHunk: (index) => {
        moveTo(chunkRows[Math.max(0, Math.min(index, chunkRows.length - 1))] ?? 0);
        element.focus();
      },
      current: currentChange,
      total: chunkRows.length,
      moveHunk: (direction) => {
        const next = target(direction);
        if (next === undefined) return false;
        moveTo(next);
        element.focus();
        return true;
      },
    });
  }, [chunkRows, currentChange, moveTo, onNavigationReady, anchorPosition]);

  /** 오른쪽 변경 위치 띠에서 고른 덩어리로 간다 (참조는 행 목록이 바뀔 때만 바뀐다 — 띠가 스크롤마다 다시 그려지지 않게) */
  const goToChange = useCallback(
    (row: number) => {
      moveTo(row);
      scrollRef.current?.focus();
    },
    [moveTo],
  );

  /** 본문 전체 선택은 가상 행 밖의 코드도 모델에서 복사하고 다른 패널은 포함하지 않는다. */
  const selectAllText = () => {
    const side = mode === 'unified' ? 'unified' : textSide.current;
    setAllText({ key: textSelectionKey, side });
    const element = scrollRef.current;
    element?.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    // 네이티브 복사 명령도 발생하도록 보이는 코드 안에만 선택 범위를 둔다.
    const first = [
      ...(element?.querySelectorAll(
        `[data-side="${side === 'unified' ? 'right' : side}"] > span`,
      ) ?? []),
    ].find((code) => (code.textContent?.length ?? 0) > 0);
    if (first) {
      const range = window.document.createRange();
      range.selectNodeContents(first);
      selection?.addRange(range);
    }
  };

  /** 컨트롤 자체의 텍스트 명령은 비교 본문의 전체 선택과 분리한다. */
  const isControl = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest('input, textarea, select, button, [contenteditable="true"]');

  /** 전체 선택을 해제하고 기존 브라우저 드래그·커서 탐색으로 돌아간다. */
  const clearAllText = () => {
    if (!selectedTextSide) return;
    setAllText(null);
    window.getSelection()?.removeAllRanges();
  };

  /**
   * 본문은 Tab 진입점 하나다. ⌘A(본문 코드 전체 선택)·Esc(그 선택 해제)만 가로챈다 — 방향키·Home·End·PageUp·PageDown·Space 는
   * 브라우저 기본 스크롤에 맡긴다 (J: 커서 줄이 없으므로 키보드로 줄을 고르거나 되돌리지 않는다, 줄 조작은 거터의 체크·단추로)
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeKey(e) || isControl(e.target)) return;
    if (
      isPrimaryModifier(e) &&
      !(e.metaKey && e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === 'a'
    ) {
      e.preventDefault();
      e.stopPropagation();
      selectAllText();
      return;
    }
    if (selectedTextSide && e.key === 'Escape') {
      clearAllText();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (
      [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        ' ',
        'F7',
      ].includes(e.key)
    )
      clearAllText();
  };

  /** 드래그한 쪽의 코드만 복사하여 반대 패널·줄번호·hunk 도구가 섞이지 않게 한다. */
  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isControl(event.target)) return;
    if (selectedTextSide) {
      const original = selectedTextSide === 'left' ? document?.old.content : document?.new.content;
      const text =
        mode === 'split' && fullFile && original != null
          ? original
          : rows
              .flatMap((row) => {
                const ref =
                  row.kind === 'line'
                    ? row.ref
                    : row.kind === 'split'
                      ? row[selectedTextSide === 'left' ? 'left' : 'right']
                      : null;
                return ref ? [ref.line.text] : [];
              })
              .join('\n');
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    /** 선택 끝점의 DOM 위치를 가상 행과 원문 내 UTF-16 위치로 바꾼다. */
    const position = (node: Node | null, offset: number) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const code = element?.closest<HTMLElement>('[data-side]');
      const text = code?.firstElementChild;
      const row = code?.closest<HTMLElement>('[data-index]');
      if (!node || !code || !text || !row || !scrollRef.current?.contains(code)) return null;
      const range = window.document.createRange();
      range.setStart(text, 0);
      range.setEnd(node, offset);
      return {
        side: code.dataset.side as 'left' | 'right',
        row: Number(row.dataset.index),
        offset: range.toString().length,
      };
    };
    const anchor = position(selection.anchorNode, selection.anchorOffset);
    const focus = position(selection.focusNode, selection.focusOffset);
    if (!anchor || !focus || anchor.side !== focus.side) return;
    event.clipboardData.setData('text/plain', selectedText(rows, anchor, focus, anchor.side));
    event.preventDefault();
  };

  /** 선택을 코어 형식으로 */
  const selection = useMemo(() => selectionFromKeys(selected), [selected]);
  const selectedCount =
    worktree && diff
      ? units.reduce(
          (count, hunkUnits, hi) =>
            count +
            hunkUnits.filter((unit) => unit.some((index) => selected.has(lineKey(hi, index))))
              .length,
          0,
        )
      : selected.size;
  const clearSelection = () => setSelection({ key: contentKey, lines: NO_LINES, anchor: null });

  const verb = actions?.verb === 'unstage' ? S.diff.unstage : S.diff.stage;
  // hunk 머리 단추가 부르는 동작 (참조가 바뀌지 않게 — 부를 때는 지금 그린 값으로 돈다)
  const hunkHandlers = useRef({
    apply: (_hunk: number) => {},
    discard: (_hunk: number) => {},
    select: (_hunk: number) => {},
  });
  hunkHandlers.current = {
    apply: (hunk) => {
      if (actions) void run(() => actions.onApplyHunk(hunk));
    },
    discard: (hunk) => {
      const discard = actions?.onDiscardHunk;
      if (discard) void run(() => discard(hunk));
    },
    select: (hunk) => {
      if (disabled || pendingRef.current) return;
      const h = diff?.hunks[hunk];
      if (!h) return;
      const next = new Set(selected);
      for (const i of changeLineIndices(h)) next.add(lineKey(hunk, i));
      setSelection({ key: contentKey, lines: next, anchor });
    },
  };
  const onApplyHunk = useCallback((hunk: number) => hunkHandlers.current.apply(hunk), []);
  const onDiscardHunk = useCallback((hunk: number) => hunkHandlers.current.discard(hunk), []);
  const onSelectHunk = useCallback((hunk: number) => hunkHandlers.current.select(hunk), []);
  const hasActions = !!actions;
  const canDiscardHunk = !!actions?.onDiscardHunk;
  // 가상 행이 함께 쓰는 값 (E-3): 스크롤·커서 이동 중에는 같은 객체라 그려 둔 행은 다시 그리지 않고 새로 들어온 행만 그린다
  const rowContext = useMemo<RowContext>(
    () => ({
      width,
      highlight,
      highlightMode,
      worktree,
      blockMode,
      disabled,
      selected,
      blockStarts,
      hasActions,
      canDiscardHunk,
      verb,
      onToggle: toggle,
      onDiscard: onDiscardRow,
      onApplyHunk,
      onDiscardHunk,
      onSelectHunk,
    }),
    [
      width,
      highlight,
      highlightMode,
      worktree,
      blockMode,
      disabled,
      selected,
      blockStarts,
      hasActions,
      canDiscardHunk,
      verb,
      toggle,
      onDiscardRow,
      onApplyHunk,
      onDiscardHunk,
      onSelectHunk,
    ],
  );

  if (!diff) {
    return <div className={styles.empty}>{loading ? S.diff.loading : S.diff.noChanges}</div>;
  }

  return (
    <div
      ref={viewRef}
      className={styles.view}
      style={
        {
          '--diff-split': `${splitRatio}%`,
          '--diff-ratio': splitRatio / 100,
          '--diff-font-size': `${fontSize}px`,
          '--diff-line-height': `${lineHeight}px`,
        } as CSSProperties
      }
    >
      <div className={styles.toolbar}>
        <span className={styles.change}>{S.diff.change(diff.change)}</span>
        {diff.binary || hideModeControls ? null : (
          <span className={styles.modes}>
            <button
              type="button"
              className={mode === 'unified' ? styles.modeActive : styles.mode}
              onClick={() => onModeChange?.('unified')}
            >
              {S.diff.unified}
            </button>
            <button
              type="button"
              className={mode === 'split' ? styles.modeActive : styles.mode}
              onClick={() => onModeChange?.('split')}
            >
              {S.diff.split}
            </button>
          </span>
        )}
        {worktree ? (
          <label className={styles.selectionUnit}>
            {S.diff.selectionUnit}
            <select
              aria-label={S.diff.selectionUnit}
              value={selectionUnit}
              disabled={disabled}
              onChange={(event) => {
                clearSelection();
                setSelectionUnit(event.target.value as 'block' | 'line');
              }}
            >
              <option value="block">{S.diff.blockUnit}</option>
              <option value="line">{S.diff.lineUnit}</option>
            </select>
          </label>
        ) : null}
        {actions ? (
          <span className={styles.selectionActions}>
            {actions.onDiscardLines ? (
              <Button
                disabled={disabled || selectedCount === 0}
                onClick={() =>
                  void run(() => actions.onDiscardLines?.(selection) ?? Promise.resolve(false))
                }
              >
                {worktree ? S.diff.discardSelectedChanges : S.diff.discardSelected(selectedCount)}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={disabled || selectedCount === 0}
              onClick={() => void run(() => actions.onApplyLines(selection))}
            >
              {worktree ? S.diff.stageSelectedChanges : S.diff.applySelected(verb, selectedCount)}
            </Button>
            <Button disabled={disabled || selectedCount === 0} onClick={clearSelection}>
              {S.diff.clearSelection}
            </Button>
            <span aria-live="polite">{worktree ? S.diff.selectedChanges(selectedCount) : ''}</span>
          </span>
        ) : null}
        {diff.nonUtf8 ? <span className={styles.truncated}>{S.diff.nonUtf8}</span> : null}
        {diff.truncated && !document ? (
          <span className={styles.truncated}>
            {S.diff.truncated(diff.totalLines)}
            {onLoadFull ? <Button onClick={onLoadFull}>{S.diff.loadFull}</Button> : null}
          </span>
        ) : null}
      </div>

      {document ? (
        <div className={styles.sideLabels} data-mode={mode}>
          <span title={`${document.old.label} · ${document.old.path ?? '∅'}`}>
            {document.old.label} · {document.old.path ?? '∅'}
          </span>
          <span title={`${document.new.label} · ${document.new.path ?? '∅'}`}>
            {document.new.label} · {document.new.path ?? '∅'}
          </span>
        </div>
      ) : null}
      {diff.binary ? (
        <div className={styles.empty}>
          {S.diff.binary(diff.binary.oldSize ?? null, diff.binary.newSize ?? null)}
        </div>
      ) : (
        <div className={styles.viewport}>
          {/* biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 본문은 grid 배치를 쓴다 (행은 절대 위치) */}
          <div
            ref={scrollRef}
            className={styles.scroller}
            data-testid="diff-scroller"
            data-primary-focus="content"
            data-command-scope="diff"
            role="grid"
            aria-label={path}
            aria-rowcount={rows.length}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onCopy={onCopy}
            data-text-selected={selectedTextSide ?? undefined}
            onPointerDown={(event) => {
              if (event.button > 0) return;
              clearAllText();
              const target =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>('[data-side]')
                  : null;
              if (target?.dataset.side === 'left' || target?.dataset.side === 'right')
                textSide.current = target.dataset.side;
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearAllText();
            }}
            onScroll={() => noteChange(ordinalAt(anchorPosition()))}
            data-wrap={wrap ? 'true' : 'false'}
            style={{ tabSize: tabWidth }}
          >
            <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                return row ? (
                  <DiffRowView
                    key={item.key}
                    row={row}
                    index={item.index}
                    start={item.start}
                    measure={wrap || needsMeasure(row) ? virtualizer.measureElement : undefined}
                    ctx={rowContext}
                  />
                ) : null;
              })}
            </div>
          </div>
          {mode === 'split' ? (
            // biome-ignore lint/a11y/useSemanticElements: 키보드와 포인터로 조절하는 분할 핸들이다
            <div
              className={styles.divider}
              role="separator"
              aria-label={S.diff.splitWidth}
              aria-orientation="vertical"
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={splitRatio}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  setSplitRatio((value) =>
                    Math.min(80, Math.max(20, value + (event.key === 'ArrowLeft' ? -2 : 2))),
                  );
                }
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const rect = scrollRef.current?.getBoundingClientRect();
                if (rect?.width)
                  setSplitRatio(
                    Math.min(80, Math.max(20, ((event.clientX - rect.left) / rect.width) * 100)),
                  );
              }}
              onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            />
          ) : null}
          <ChangeOverview chunkRows={chunkRows} total={rows.length} onGo={goToChange} />
        </div>
      )}
      {!wrap && !diff.binary ? (
        <div className={mode === 'split' ? styles.horizontalSplit : styles.horizontalUnified}>
          {(mode === 'split' ? (['left', 'right'] as const) : (['right'] as const)).map((side) => (
            <section
              key={side}
              ref={side === 'left' ? leftScroll : rightScroll}
              className={styles.horizontal}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: 키보드로 가로 스크롤하는 영역이다
              tabIndex={0}
              aria-label={side === 'left' ? S.diff.oldHorizontalScroll : S.diff.newHorizontalScroll}
              onScroll={(event) => scrollHorizontal(side, event.currentTarget.scrollLeft)}
            >
              <div
                style={{
                  width: `calc(${(horizontalSync ? Math.max(columns.left, columns.right) : columns[side]) + width * (mode === 'split' ? 1 : 2) + 8}ch + 40px)`,
                  height: 1,
                }}
              />
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 변경 위치 띠 표시의 높이 반 (px, CSS `.overview button` 의 `min-height: 5px`) — 표시의 가운데를 잴 때 쓴다 */
const OVERVIEW_MARKER_HALF = 2.5;

/**
 * 변경 위치 띠에서 누른 높이(`y`, 띠 위에서부터 px)에 가운데가 가장 가까운 덩어리의 첫 행 (L-1). 표시는 문서 안 비율 자리에
 * 그려지므로(`row / total`) 촘촘한 문서에서는 겹친다 — 누른 요소가 아니라 높이로 고르면 덮인 표시도 고를 수 있다. 같으면 앞
 * 덩어리. 덩어리가 없으면 undefined
 */
export function nearestChunk(
  chunkRows: readonly number[],
  total: number,
  height: number,
  y: number,
): number | undefined {
  const center = (row: number) => (row / Math.max(1, total)) * height + OVERVIEW_MARKER_HALF;
  // 가운데가 y 이상인 첫 표시 (없으면 마지막)
  let low = 0;
  let high = chunkRows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (center(chunkRows[mid] ?? 0) < y) low = mid + 1;
    else high = mid;
  }
  const after = chunkRows[low];
  const before = chunkRows[low - 1];
  if (after === undefined) return undefined;
  if (before === undefined) return after;
  return Math.abs(center(before) - y) <= Math.abs(center(after) - y) ? before : after;
}

/**
 * 오른쪽 변경 위치 띠: 변경 덩어리마다 단추 하나(다음/이전 변경과 같은 단위, J). 받은 값이 같으면 다시 그리지 않는다 (E-3).
 * 마우스로 누르면 누른 높이에 가장 가까운 덩어리로 간다 — 촘촘해 표시가 겹쳐도 덮인 덩어리를 고를 수 있고 표시 사이 빈 곳을
 * 눌러도 된다 (L-1). 키보드(초점을 둔 단추의 Enter·Space, `detail` 0)는 그 단추의 덩어리로 간다
 */
const ChangeOverview = memo(function ChangeOverview({
  chunkRows,
  total,
  onGo,
}: {
  chunkRows: readonly number[];
  total: number;
  onGo: (row: number) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 띠의 마우스 누름은 높이로 고르는 보조 경로이고, 키보드는 띠 안의 단추들이 맡는다
    <nav
      className={styles.overview}
      aria-label={S.diff.changeOverview}
      onClick={(event) => {
        if (event.detail === 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const row = nearestChunk(chunkRows, total, rect.height, event.clientY - rect.top);
        if (row !== undefined) onGo(row);
      }}
    >
      {chunkRows.map((row, index) => (
        <button
          key={row}
          type="button"
          title={S.diff.changePosition(index + 1, chunkRows.length)}
          aria-label={S.diff.goToChange(index + 1)}
          style={{ top: `${(row / Math.max(1, total)) * 100}%` }}
          onClick={(event) => {
            // 마우스 누름은 띠가 높이로 고른다 (겹친 표시) — 키보드로 누른 단추만 여기서
            if (event.detail === 0) onGo(row);
          }}
        />
      ))}
    </nav>
  );
});

/** 가상 행이 함께 쓰는 값 */
interface RowContext {
  width: number;
  highlight: HighlightMap;
  highlightMode: HighlightMode;
  worktree: boolean;
  blockMode: boolean;
  disabled: boolean;
  selected: ReadonlySet<string>;
  blockStarts: ReadonlySet<string>;
  hasActions: boolean;
  canDiscardHunk: boolean;
  verb: string;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
  onDiscard: (ref: LineRef) => void;
  onApplyHunk: (hunk: number) => void;
  onDiscardHunk: (hunk: number) => void;
  onSelectHunk: (hunk: number) => void;
}

/** 가상 행 하나 (E-3): 받은 값이 같으면 다시 그리지 않는다 — 스크롤할 때 새로 들어온 행만 그린다 */
const DiffRowView = memo(function DiffRowView({
  row,
  index,
  start,
  measure,
  ctx,
}: {
  row: DiffRow;
  index: number;
  start: number;
  /** 높이를 재는 행만 받는다 (줄바꿈이 꺼진 코드 줄은 없다 — `needsMeasure`) */
  measure: ((node: Element | null) => void) | undefined;
  ctx: RowContext;
}) {
  return (
    // 행은 포커스를 받지 않는다 (J): 줄을 눌러도 포커스는 본문 하나에 남고, 줄 단위 포커스 테두리가 뜨지 않는다
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: 가상 스크롤 행은 절대 위치로 배치하고, 포커스는 본문 grid 하나가 받는다
    <div
      data-index={index}
      role="row"
      aria-rowindex={index + 1}
      ref={measure}
      className={styles.rowWrap}
      style={{ transform: `translateY(${start}px)` }}
    >
      {row.kind === 'hunk' ? (
        <div className={styles.hunk}>
          <span className={styles.hunkHeader}>{row.header}</span>
          {ctx.hasActions ? (
            <span className={styles.hunkActions}>
              <button
                type="button"
                tabIndex={-1}
                className={styles.link}
                disabled={ctx.disabled}
                onClick={() => ctx.onApplyHunk(row.hunk)}
              >
                {S.diff.applyHunk(ctx.verb)}
              </button>
              {ctx.canDiscardHunk ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.link}
                  disabled={ctx.disabled}
                  onClick={() => ctx.onDiscardHunk(row.hunk)}
                >
                  {S.diff.discardHunk}
                </button>
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                className={styles.link}
                disabled={ctx.disabled}
                onClick={() => ctx.onSelectHunk(row.hunk)}
              >
                {S.diff.selectHunk}
              </button>
            </span>
          ) : null}
        </div>
      ) : row.kind === 'line' ? (
        <UnifiedLine
          row={row}
          width={ctx.width}
          highlight={ctx.highlight}
          highlightMode={ctx.highlightMode}
          selectable={
            ctx.hasActions &&
            (!ctx.blockMode || ctx.blockStarts.has(lineKey(row.ref.hunk, row.ref.index)))
          }
          worktree={ctx.worktree}
          blockMode={ctx.blockMode}
          disabled={ctx.disabled}
          onDiscard={ctx.onDiscard}
          selected={ctx.selected.has(lineKey(row.ref.hunk, row.ref.index))}
          onToggle={ctx.onToggle}
        />
      ) : (
        <SplitLine
          row={row}
          width={ctx.width}
          highlight={ctx.highlight}
          highlightMode={ctx.highlightMode}
          selectable={
            ctx.hasActions &&
            (!ctx.blockMode ||
              ctx.blockStarts.has(lineKey(row.hunk, (row.left ?? row.right)?.index ?? -1)))
          }
          worktree={ctx.worktree}
          blockMode={ctx.blockMode}
          disabled={ctx.disabled}
          onDiscard={ctx.onDiscard}
          selected={ctx.selected}
          onToggle={ctx.onToggle}
        />
      )}
    </div>
  );
});

/** 줄 종류 기호 */
function signOf(kind: LineRef['line']['kind']): string {
  return kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
}

/** 변경 행의 선택과 실행은 별도 클릭 영역으로 제공한다. */
function LineControls({
  refLine,
  blockMode,
  selected,
  disabled,
  onToggle,
  onDiscard,
}: {
  refLine: LineRef | null;
  blockMode: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
  onDiscard?: (ref: LineRef) => void;
}) {
  return (
    <span className={styles.lineControls}>
      {refLine ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled}
            onChange={() => {}}
            onClick={(event) => onToggle(refLine, event)}
            tabIndex={-1}
            aria-label={blockMode ? S.diff.selectBlock : S.diff.selectLine}
          />
        </label>
      ) : (
        <span className={styles.check} />
      )}
      {onDiscard ? (
        <span className={styles.rowAction}>
          {refLine ? (
            <button
              type="button"
              tabIndex={-1}
              disabled={disabled}
              title={blockMode ? S.diff.restoreBlock : S.diff.restoreChange}
              aria-label={blockMode ? S.diff.restoreBlock : S.diff.restoreChange}
              onClick={() => onDiscard(refLine)}
            >
              →
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * unified 줄은 수정 쌍의 첫 표시 줄에만 선택·실행 컨트롤을 둔다. 받은 값이 같으면 다시 그리지 않는다 (E-3: 스크롤·커서
 * 이동·문서 도착 뒤의 측정 재렌더에 보이는 행 전부를 다시 만들던 비용)
 */
const UnifiedLine = memo(function UnifiedLine({
  row,
  width,
  highlight,
  highlightMode,
  selectable,
  worktree,
  blockMode,
  disabled,
  selected,
  onToggle,
  onDiscard,
}: {
  row: Extract<DiffRow, { kind: 'line' }>;
  width: number;
  highlight: HighlightMap;
  highlightMode: HighlightMode;
  selectable: boolean;
  worktree: boolean;
  blockMode: boolean;
  disabled: boolean;
  selected: boolean;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
  onDiscard: (ref: LineRef) => void;
}) {
  const { line } = row.ref;
  const changeable =
    selectable &&
    line.kind !== 'context' &&
    (!worktree || !row.pair || row.ref.index < row.pair.index);
  const pieces = piecesOf(row.ref, row.pair, highlight, highlightMode);
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 두고, 포커스는 본문 grid 하나가 받는다
    <div
      role="row"
      className={styles.line}
      data-kind={line.kind}
      data-selected={selected ? 'true' : 'false'}
    >
      <LineControls
        blockMode={blockMode}
        refLine={changeable ? row.ref : null}
        selected={selected}
        disabled={disabled}
        onToggle={onToggle}
        onDiscard={worktree ? onDiscard : undefined}
      />
      <span className={styles.no} style={{ width: `${width}ch` }}>
        {line.oldNo ?? ''}
      </span>
      <span className={styles.no} style={{ width: `${width}ch` }}>
        {line.newNo ?? ''}
      </span>
      <span className={styles.sign}>{signOf(line.kind)}</span>
      <span className={styles.code} data-side="right">
        <span className={styles.codeText}>
          {renderPieces(pieces)}
          {line.noNewline ? <span className={styles.noNewline}>{S.diff.noNewline}</span> : null}
        </span>
      </span>
    </div>
  );
});

/** 좌우 패치 참조는 보존하고 작업 트리 조작은 중앙 오른쪽에 모은다. 받은 값이 같으면 다시 그리지 않는다 (E-3) */
const SplitLine = memo(function SplitLine({
  row,
  width,
  highlight,
  highlightMode,
  selectable,
  worktree,
  blockMode,
  disabled,
  selected,
  onToggle,
  onDiscard,
}: {
  row: Extract<DiffRow, { kind: 'split' }>;
  width: number;
  highlight: HighlightMap;
  highlightMode: HighlightMode;
  selectable: boolean;
  worktree: boolean;
  blockMode: boolean;
  disabled: boolean;
  selected: ReadonlySet<string>;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
  onDiscard: (ref: LineRef) => void;
}) {
  const { left, right } = row;
  const isContext = left?.line.kind === 'context' && right?.line.kind === 'context';
  /** 오른쪽이 빈 삭제 행에도 중앙 컨트롤과 왼쪽 선택 표시를 유지한다. */
  const side = (ref: LineRef | null, pair: LineRef | null, position: 'left' | 'right') => {
    const controlRef = worktree ? (right ?? left) : ref;
    const changeable = selectable && controlRef && controlRef.line.kind !== 'context';
    const selectedRef = ref ?? (worktree ? controlRef : null);
    const isSel = !!selectedRef && selected.has(lineKey(selectedRef.hunk, selectedRef.index));
    return (
      // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 두고, 포커스는 본문 grid 하나가 받는다
      <div
        role="row"
        className={styles.half}
        data-scroll-side={position}
        data-kind={ref?.line.kind ?? 'empty'}
        data-selected={isSel ? 'true' : 'false'}
      >
        {!worktree || position === 'right' ? (
          <LineControls
            blockMode={blockMode}
            refLine={changeable ? controlRef : null}
            selected={isSel}
            disabled={disabled}
            onToggle={onToggle}
            onDiscard={worktree ? onDiscard : undefined}
          />
        ) : null}
        <span className={styles.no} style={{ width: `${width}ch` }}>
          {(position === 'left' ? ref?.line.oldNo : ref?.line.newNo) ?? ''}
        </span>
        <span className={styles.code} data-side={position}>
          {ref ? (
            <span className={styles.codeText}>
              {renderPieces(piecesOf(ref, pair, highlight, highlightMode))}
              {ref.line.noNewline ? (
                <span className={styles.noNewline}>{S.diff.noNewline}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      </div>
    );
  };
  return (
    <div className={styles.split}>
      {side(left, isContext ? null : right, 'left')}
      {side(right, isContext ? null : left, 'right')}
    </div>
  );
});
