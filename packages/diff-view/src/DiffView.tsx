import type { DiffDocument, FileDiff, LineSelection } from '@mgit/ipc';
import { Button, isImeKey, S } from '@mgit/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

/** 선택 토글에 필요한 키 정보 (마우스·키보드 공용) */
interface ToggleEvent {
  shiftKey: boolean;
}

import styles from './DiffView.module.css';
import { plainSpans } from './highlight';
import { buildContextRows, buildDocumentRows, buildRows, type DiffRow, type LineRef } from './rows';
import {
  changeLineIndices,
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
  onApplyHunk(hunk: number): void;
  onApplyLines(selection: LineSelection[]): void;
  /** 작업 트리 변경일 때만: 되돌리기 */
  onDiscardHunk?(hunk: number): void;
  /** false 로 끝나면 (확인에서 취소 등) 선택을 남긴다 */
  onDiscardLines?(selection: LineSelection[]): Promise<boolean> | undefined;
}

/** 줄 선택 상태. `key` 는 이 선택을 만든 diff 내용이다 */
interface LineSelectionState {
  key: string;
  lines: ReadonlySet<string>;
  anchor: { hunk: number; index: number } | null;
}

const NO_LINES: ReadonlySet<string> = new Set();

export interface DiffNavigation {
  moveHunk(direction: 1 | -1): void;
  available: boolean;
  current: number;
  total: number;
}

export interface DiffViewProps {
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
    const saved = Number(globalThis.localStorage?.getItem('mgit.diff.splitRatio'));
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
 * - 행은 @tanstack/react-virtual 로 가상화하고 줄바꿈 가변 높이를 측정한다
 * - 구문 강조는 비동기(언어 lazy 로드), 단어 강조는 짝지은 삭제·추가 줄에만
 * - `actions` 가 있으면 hunk 헤더 버튼과 줄 체크박스로 부분 스테이징·되돌리기
 */
export function DiffView({
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
}: DiffViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const viewRef = useRef<HTMLDivElement>(null);
  const leftScroll = useRef<HTMLElement>(null);
  const rightScroll = useRef<HTMLElement>(null);
  const [splitRatio, setSplitRatio] = useState(readSplitRatio);
  const offsets = useRef({ left: 0, right: 0 });
  const pendingScroll = useRef<{ left?: number; right?: number }>({});
  const [cursor, setCursor] = useState({ key: '', row: 0, side: 'right' as 'left' | 'right' });
  // 비 UTF-8 줄은 코어가 줄 단위 stage·discard 를 거부한다
  const actions = diff?.nonUtf8 || diff?.truncated || loading ? undefined : givenActions;
  const contentKey = useMemo(
    () => `${diffContentKey(path, diff)}:${document?.revision ?? ''}`,
    [path, diff, document?.revision],
  );
  const [lineState, setSelection] = useState<LineSelectionState>({
    key: '',
    lines: NO_LINES,
    anchor: null,
  });
  // 다른 diff 의 선택은 쓰지 않는다 (그 위치는 이 diff 에서 다른 줄이다)
  const selected = !loading && lineState.key === contentKey ? lineState.lines : NO_LINES;
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
  const width = Math.max(
    diff ? digits(diff) : 2,
    String(Math.max(document?.old.lineCount ?? 0, document?.new.lineCount ?? 0)).length,
  );
  const hunkRows = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'hunk' ? [index] : [])),
    [rows],
  );
  const columns = useMemo(() => {
    let left = 0;
    let right = 0;
    /** 탭과 전각 문자를 반영하여 가상화 밖의 긴 행까지 가로 이동 범위를 확보한다. */
    const length = (text: string) => {
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

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
    ...(initialHeight ? { initialRect: { width: 800, height: initialHeight } } : {}),
  });

  /** 분할 폭도 다른 보기 설정처럼 다음 파일과 세션에서 재사용한다. */
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem('mgit.diff.splitRatio', String(splitRatio));
    } catch {
      /* 저장이 막힌 환경에서도 현재 화면은 유지한다. */
    }
  }, [splitRatio]);

  /** 재조회가 시작되면 같은 내용으로 완료되더라도 이전 선택을 복원하지 않는다. */
  useEffect(() => {
    void loading;
    void mode;
    void fullFile;
    void highlightMode;
    void wrap;
    void horizontalSync;
    void tabWidth;
    setSelection({ key: '', lines: NO_LINES, anchor: null });
  }, [loading, mode, fullFile, highlightMode, wrap, horizontalSync, tabWidth]);

  /** 줄바꿈·분할 폭 변경 후 좌우를 함께 다시 측정한다. */
  useEffect(() => {
    void wrap;
    void splitRatio;
    void tabWidth;
    void mode;
    virtualizer.measure();
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => virtualizer.measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [wrap, splitRatio, tabWidth, mode, virtualizer]);

  /** 공통 세로 뷰포트 안의 코드만 이동해 거터와 중앙 경계를 고정한다. */
  const scrollHorizontal = (side: 'left' | 'right', value: number) => {
    if (pendingScroll.current[side] === value) {
      delete pendingScroll.current[side];
      return;
    }
    delete pendingScroll.current[side];
    offsets.current[side] = value;
    viewRef.current?.style.setProperty(`--diff-${side}-scroll`, `${value}px`);
    if (horizontalSync) {
      const other = side === 'left' ? 'right' : 'left';
      offsets.current[other] = value;
      viewRef.current?.style.setProperty(`--diff-${other}-scroll`, `${value}px`);
      const bar = other === 'left' ? leftScroll.current : rightScroll.current;
      if (bar && bar.scrollLeft !== value) {
        bar.scrollLeft = value;
        pendingScroll.current[other] = bar.scrollLeft;
      }
    }
  };

  /** 동기화를 켜거나 파일이 바뀌면 가로 위치를 공통 시작점으로 맞춘다. */
  useEffect(() => {
    void contentKey;
    void horizontalSync;
    void wrap;
    offsets.current = { left: 0, right: 0 };
    viewRef.current?.style.setProperty('--diff-left-scroll', '0px');
    viewRef.current?.style.setProperty('--diff-right-scroll', '0px');
    if (leftScroll.current) leftScroll.current.scrollLeft = 0;
    if (rightScroll.current) rightScroll.current.scrollLeft = 0;
  }, [contentKey, horizontalSync, wrap]);

  /** 트랙패드의 가로 이동은 포인터가 있는 패널에만 전달한다. 세로 이동은 공통 본문이 담당한다. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || wrap) return;
    const wheel = (event: WheelEvent) => {
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      const side =
        event.target instanceof Element
          ? event.target.closest('[data-side]')?.getAttribute('data-side')
          : null;
      const bar = side === 'left' ? leftScroll.current : rightScroll.current;
      if (bar) {
        bar.scrollLeft += delta;
        event.preventDefault();
        if (!event.shiftKey && event.deltaY) element.scrollTop += event.deltaY;
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [wrap]);

  /** 체크박스·클릭으로 줄 선택을 토글한다. Shift 면 같은 hunk 안의 범위 */
  const toggle = useCallback(
    (ref: LineRef, e: ToggleEvent) => {
      if (!diff || !actions) {
        return;
      }
      const key = lineKey(ref.hunk, ref.index);
      const next = new Set(selected);
      const h = diff.hunks[ref.hunk];
      if (e.shiftKey && anchor && anchor.hunk === ref.hunk && h) {
        for (const k of rangeKeys(h, ref.hunk, anchor.index, ref.index)) {
          next.add(k);
        }
      } else if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      setSelection({
        key: contentKey,
        lines: next,
        anchor: { hunk: ref.hunk, index: ref.index },
      });
    },
    [diff, actions, anchor, selected, contentKey],
  );

  const cursorRow =
    cursor.key === contentKey ? Math.min(cursor.row, rows.length - 1) : (hunkRows[0] ?? 0);
  const cursorRef = useRef(cursorRow);
  cursorRef.current = cursorRow;

  /** 커서만 옮긴다. 구간 이동은 줄 선택·stage 를 실행하지 않는다 */
  const moveCursor = useCallback(
    (index: number, align: 'auto' | 'start' = 'auto') => {
      const row = Math.max(0, Math.min(rows.length - 1, index));
      cursorRef.current = row;
      setCursor((prev) => ({ key: contentKey, row, side: prev.side }));
      virtualizer.scrollToIndex(row, { align });
    },
    [contentKey, rows.length, virtualizer],
  );

  /** 새 문서를 처음 열 때 첫 변경으로 이동한다. 보기 모드 전환도 새 행 위치를 적용한다. */
  useEffect(() => {
    void contentKey;
    void mode;
    void fullFile;
    moveCursor(hunkRows[0] ?? 0, 'start');
  }, [contentKey, mode, fullFile, hunkRows, moveCursor]);

  /** 다음·이전 변경 구간으로 옮기며 양끝에서 멈춘다 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !onNavigationReady) {
      return;
    }
    return onNavigationReady(element, {
      available: hunkRows.length > 0,
      current: hunkRows.length
        ? Math.max(1, hunkRows.filter((index) => index <= cursorRow).length)
        : 0,
      total: hunkRows.length,
      moveHunk: (direction) => {
        const hunks = hunkRows;
        const next =
          direction === 1
            ? hunks.find((index) => index > cursorRef.current)
            : [...hunks].reverse().find((index) => index < cursorRef.current);
        if (next !== undefined) {
          moveCursor(next, 'start');
        }
        element.focus();
      },
    });
  }, [hunkRows, cursorRow, moveCursor, onNavigationReady]);

  /** 본문은 Tab 진입점 하나다. 방향키는 커서, Space 는 줄, Shift 는 같은 구간의 범위를 고른다 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || isImeKey(e) || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const row = rows[cursorRow];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setCursor({
        key: contentKey,
        row: cursorRow,
        side: e.key === 'ArrowLeft' ? 'left' : 'right',
      });
      return;
    }
    const next =
      e.key === 'ArrowDown'
        ? cursorRow + 1
        : e.key === 'ArrowUp'
          ? cursorRow - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? rows.length - 1
              : null;
    if (next !== null) {
      e.preventDefault();
      const at = Math.max(0, Math.min(rows.length - 1, next));
      moveCursor(at);
      const target = rows[at];
      const ref =
        target?.kind === 'line'
          ? target.ref
          : target?.kind === 'split'
            ? target[cursor.side]
            : null;
      if (e.shiftKey && ref && ref.line.kind !== 'context') {
        toggle(ref, e);
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      const ref = row?.kind === 'line' ? row.ref : row?.kind === 'split' ? row[cursor.side] : null;
      if (ref && ref.line.kind !== 'context') {
        toggle(ref, e);
      }
    }
  };

  /** 드래그한 쪽의 코드만 복사하여 반대 패널·줄번호·hunk 도구가 섞이지 않게 한다. */
  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
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
  const clearSelection = () => setSelection({ key: contentKey, lines: NO_LINES, anchor: null });

  if (!diff) {
    return <div className={styles.empty}>{loading ? S.diff.loading : S.diff.noChanges}</div>;
  }

  const verb = actions?.verb === 'unstage' ? S.diff.unstage : S.diff.stage;

  return (
    <div
      ref={viewRef}
      className={styles.view}
      style={{ '--diff-split': `${splitRatio}%` } as CSSProperties}
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
        {actions && selected.size > 0 ? (
          <span className={styles.selectionActions}>
            <Button
              variant="primary"
              onClick={() => {
                actions.onApplyLines(selection);
                clearSelection();
              }}
            >
              {S.diff.applySelected(verb, selected.size)}
            </Button>
            {actions.onDiscardLines ? (
              <Button
                onClick={() => {
                  void Promise.resolve(actions.onDiscardLines?.(selection)).then((ok) => {
                    if (ok !== false) {
                      clearSelection();
                    }
                  });
                }}
              >
                {S.diff.discardSelected(selected.size)}
              </Button>
            ) : null}
            <Button onClick={clearSelection}>{S.diff.clearSelection}</Button>
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
          {/* biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 본문은 grid 배치와 activedescendant 를 쓴다 */}
          <div
            ref={scrollRef}
            className={styles.scroller}
            data-testid="diff-scroller"
            data-command-scope="diff"
            role="grid"
            aria-label={path}
            aria-rowcount={rows.length}
            aria-activedescendant={
              virtualizer.getVirtualItems().some((item) => item.index === cursorRow)
                ? `${baseId}-row-${cursorRow}`
                : undefined
            }
            tabIndex={0}
            onKeyDown={onKeyDown}
            onCopy={onCopy}
            onScroll={() => {
              const first = virtualizer
                .getVirtualItems()
                .find((item) => item.end > (scrollRef.current?.scrollTop ?? 0) + 1);
              if (first)
                setCursor((prev) =>
                  prev.row === first.index && prev.key === contentKey
                    ? prev
                    : { ...prev, key: contentKey, row: first.index },
                );
            }}
            data-wrap={wrap ? 'true' : 'false'}
            style={{ tabSize: tabWidth }}
          >
            <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) {
                  return null;
                }
                return (
                  // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 절대 위치로 배치한다
                  <div
                    key={item.key}
                    data-index={item.index}
                    id={`${baseId}-row-${item.index}`}
                    data-cursor={item.index === cursorRow ? 'true' : undefined}
                    role="row"
                    tabIndex={-1}
                    aria-rowindex={item.index + 1}
                    ref={virtualizer.measureElement}
                    className={styles.rowWrap}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {row.kind === 'hunk' ? (
                      <div className={styles.hunk}>
                        <span className={styles.hunkHeader}>{row.header}</span>
                        {actions ? (
                          <span className={styles.hunkActions}>
                            <button
                              type="button"
                              tabIndex={-1}
                              className={styles.link}
                              onClick={() => actions.onApplyHunk(row.hunk)}
                            >
                              {S.diff.applyHunk(verb)}
                            </button>
                            {actions.onDiscardHunk ? (
                              <button
                                type="button"
                                tabIndex={-1}
                                className={styles.link}
                                onClick={() => actions.onDiscardHunk?.(row.hunk)}
                              >
                                {S.diff.discardHunk}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              tabIndex={-1}
                              className={styles.link}
                              onClick={() => {
                                const h = diff.hunks[row.hunk];
                                if (!h) {
                                  return;
                                }
                                const next = new Set(selected);
                                for (const i of changeLineIndices(h)) {
                                  next.add(lineKey(row.hunk, i));
                                }
                                setSelection({ key: contentKey, lines: next, anchor });
                              }}
                            >
                              {S.diff.selectHunk}
                            </button>
                          </span>
                        ) : null}
                      </div>
                    ) : row.kind === 'line' ? (
                      <UnifiedLine
                        row={row}
                        width={width}
                        highlight={highlight}
                        highlightMode={highlightMode}
                        selectable={!!actions}
                        selected={selected.has(lineKey(row.ref.hunk, row.ref.index))}
                        onToggle={toggle}
                      />
                    ) : (
                      <SplitLine
                        row={row}
                        width={width}
                        highlight={highlight}
                        highlightMode={highlightMode}
                        selectable={!!actions}
                        selected={selected}
                        onToggle={toggle}
                      />
                    )}
                  </div>
                );
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
          <nav className={styles.overview} aria-label={S.diff.changeOverview}>
            {hunkRows.map((row, index) => (
              <button
                key={row}
                type="button"
                title={S.diff.changePosition(index + 1, hunkRows.length)}
                aria-label={S.diff.goToChange(index + 1)}
                style={{ top: `${(row / Math.max(1, rows.length)) * 100}%` }}
                onClick={() => {
                  moveCursor(row, 'start');
                  scrollRef.current?.focus();
                }}
              />
            ))}
          </nav>
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

/** 줄 종류 기호 */
function signOf(kind: LineRef['line']['kind']): string {
  return kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
}

/** unified 줄 */
function UnifiedLine({
  row,
  width,
  highlight,
  highlightMode,
  selectable,
  selected,
  onToggle,
}: {
  row: Extract<DiffRow, { kind: 'line' }>;
  width: number;
  highlight: HighlightMap;
  highlightMode: HighlightMode;
  selectable: boolean;
  selected: boolean;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
}) {
  const { line } = row.ref;
  const changeable = selectable && line.kind !== 'context';
  const pieces = piecesOf(row.ref, row.pair, highlight, highlightMode);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 둔다
    <div
      role="row"
      tabIndex={-1}
      className={styles.line}
      data-kind={line.kind}
      data-selected={selected ? 'true' : 'false'}
    >
      <span className={styles.check}>
        {changeable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => {}}
            onClick={(event) => onToggle(row.ref, event)}
            tabIndex={-1}
            aria-label={S.diff.selectLine}
          />
        ) : null}
      </span>
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
}

/** split 줄 (왼쪽 옛 파일, 오른쪽 새 파일) */
function SplitLine({
  row,
  width,
  highlight,
  highlightMode,
  selectable,
  selected,
  onToggle,
}: {
  row: Extract<DiffRow, { kind: 'split' }>;
  width: number;
  highlight: HighlightMap;
  highlightMode: HighlightMode;
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
}) {
  const left = row.left;
  const right = row.right;
  const isContext = left?.line.kind === 'context' && right?.line.kind === 'context';
  const leftPair = isContext ? null : right;
  const rightPair = isContext ? null : left;
  const side = (
    ref: LineRef | null,
    pair: LineRef | null,
    no: number | null | undefined,
    position: 'left' | 'right',
  ) => {
    if (!ref) {
      return <div className={styles.half} data-kind="empty" />;
    }
    const changeable = selectable && ref.line.kind !== 'context';
    const isSel = selected.has(lineKey(ref.hunk, ref.index));
    return (
      // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 둔다
      <div
        role="row"
        tabIndex={-1}
        className={styles.half}
        data-kind={ref.line.kind}
        data-selected={isSel ? 'true' : 'false'}
      >
        <span className={styles.check}>
          {changeable ? (
            <input
              type="checkbox"
              checked={isSel}
              onChange={() => {}}
              onClick={(event) => onToggle(ref, event)}
              tabIndex={-1}
              aria-label={S.diff.selectLine}
            />
          ) : null}
        </span>
        <span className={styles.no} style={{ width: `${width}ch` }}>
          {no ?? ''}
        </span>
        <span className={styles.code} data-side={position}>
          <span className={styles.codeText}>
            {renderPieces(piecesOf(ref, pair, highlight, highlightMode))}
            {ref.line.noNewline ? (
              <span className={styles.noNewline}>{S.diff.noNewline}</span>
            ) : null}
          </span>
        </span>
      </div>
    );
  };
  return (
    <div className={styles.split}>
      {side(left, leftPair, left?.line.oldNo, 'left')}
      {side(right, rightPair, right?.line.newNo, 'right')}
    </div>
  );
}
