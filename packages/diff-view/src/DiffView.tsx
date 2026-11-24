import type { FileDiff, LineSelection } from '@mgit/ipc';
import { Button, isImeKey, S } from '@mgit/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

/** 선택 토글에 필요한 키 정보 (마우스·키보드 공용) */
interface ToggleEvent {
  shiftKey: boolean;
}

import styles from './DiffView.module.css';
import { plainSpans } from './highlight';
import { buildRows, type DiffRow, type LineRef } from './rows';
import {
  changeLineIndices,
  diffContentKey,
  lineKey,
  rangeKeys,
  selectionFromKeys,
} from './selection';
import { type HighlightMap, useHighlight } from './use-highlight';
import { applyRanges, type Piece, type Range, type Span, wordRanges } from './word-diff';

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
}

export interface DiffViewProps {
  /** 앱의 유효 키맵에 구간 이동을 연결한다. 반환한 함수는 뷰 변경·해제 때 정리한다 */
  onNavigationReady?: (
    element: HTMLElement,
    navigation: DiffNavigation,
  ) => (() => void) | undefined;
  diff: FileDiff | null;
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
  /** 긴 줄 접기 (DIFF-03). 기본 켜짐 */
  wrap?: boolean;
  /** 탭 폭 (DIFF-03) */
  tabWidth?: number;
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
function piecesOf(ref: LineRef, pair: LineRef | null, highlight: HighlightMap): Piece[] {
  const spans: Span[] = highlight.get(ref.hunk)?.get(ref.index) ?? plainSpans(ref.line.text);
  let ranges: Range[] = [];
  if (pair) {
    const w =
      ref.line.kind === 'del'
        ? wordRanges(ref.line.text, pair.line.text)
        : wordRanges(pair.line.text, ref.line.text);
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
  path,
  mode,
  onModeChange,
  actions: givenActions,
  onLoadFull,
  loading,
  initialHeight,
  wrap = true,
  tabWidth = 4,
  onNavigationReady,
}: DiffViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [cursor, setCursor] = useState({ key: '', row: 0, side: 'right' as 'left' | 'right' });
  // 비 UTF-8 줄은 코어가 줄 단위 stage·discard 를 거부한다
  const actions = diff?.nonUtf8 ? undefined : givenActions;
  const contentKey = useMemo(() => diffContentKey(path, diff), [path, diff]);
  const [lineState, setSelection] = useState<LineSelectionState>({
    key: '',
    lines: NO_LINES,
    anchor: null,
  });
  // 다른 diff 의 선택은 쓰지 않는다 (그 위치는 이 diff 에서 다른 줄이다)
  const selected = lineState.key === contentKey ? lineState.lines : NO_LINES;
  const anchor = lineState.key === contentKey ? lineState.anchor : null;
  const highlight = useHighlight(diff, path);
  const rows = useMemo<DiffRow[]>(() => (diff ? buildRows(diff, mode) : []), [diff, mode]);
  const width = diff ? digits(diff) : 2;

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
    ...(initialHeight ? { initialRect: { width: 800, height: initialHeight } } : {}),
  });

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

  const cursorRow = cursor.key === contentKey ? Math.min(cursor.row, rows.length - 1) : 0;
  const cursorRef = useRef(cursorRow);
  cursorRef.current = cursorRow;

  /** 커서만 옮긴다. 구간 이동은 줄 선택·stage 를 실행하지 않는다 */
  const moveCursor = useCallback(
    (index: number) => {
      const row = Math.max(0, Math.min(rows.length - 1, index));
      cursorRef.current = row;
      setCursor((prev) => ({ key: contentKey, row, side: prev.side }));
      virtualizer.scrollToIndex(row, { align: 'auto' });
    },
    [contentKey, rows.length, virtualizer],
  );

  /** 다음·이전 변경 구간으로 옮기며 양끝에서 멈춘다 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !onNavigationReady) {
      return;
    }
    return onNavigationReady(element, {
      available: rows.some((row) => row.kind === 'hunk'),
      moveHunk: (direction) => {
        const hunks = rows.flatMap((row, index) => (row.kind === 'hunk' ? [index] : []));
        const next =
          direction === 1
            ? hunks.find((index) => index > cursorRef.current)
            : [...hunks].reverse().find((index) => index < cursorRef.current);
        if (next !== undefined) {
          moveCursor(next);
        }
        element.focus();
      },
    });
  }, [rows, moveCursor, onNavigationReady]);

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

  /** 선택을 코어 형식으로 */
  const selection = useMemo(() => selectionFromKeys(selected), [selected]);
  const clearSelection = () => setSelection({ key: contentKey, lines: NO_LINES, anchor: null });

  if (!diff) {
    return <div className={styles.empty}>{loading ? S.diff.loading : S.diff.noChanges}</div>;
  }

  const verb = actions?.verb === 'unstage' ? S.diff.unstage : S.diff.stage;

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.change}>{S.diff.change(diff.change)}</span>
        {diff.binary ? null : (
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
        {diff.truncated ? (
          <span className={styles.truncated}>
            {S.diff.truncated(diff.totalLines)}
            {onLoadFull ? <Button onClick={onLoadFull}>{S.diff.loadFull}</Button> : null}
          </span>
        ) : null}
      </div>

      {diff.binary ? (
        <div className={styles.empty}>
          {S.diff.binary(diff.binary.oldSize ?? null, diff.binary.newSize ?? null)}
        </div>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 본문은 grid 배치와 activedescendant 를 쓴다
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
                      selectable={!!actions}
                      selected={selected.has(lineKey(row.ref.hunk, row.ref.index))}
                      onToggle={toggle}
                    />
                  ) : (
                    <SplitLine
                      row={row}
                      width={width}
                      highlight={highlight}
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
      )}
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
  selectable,
  selected,
  onToggle,
}: {
  row: Extract<DiffRow, { kind: 'line' }>;
  width: number;
  highlight: HighlightMap;
  selectable: boolean;
  selected: boolean;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
}) {
  const { line } = row.ref;
  const changeable = selectable && line.kind !== 'context';
  const pieces = piecesOf(row.ref, row.pair, highlight);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 둔다
    <div
      role="row"
      tabIndex={-1}
      className={styles.line}
      data-kind={line.kind}
      data-selected={selected ? 'true' : 'false'}
      onClick={changeable ? (e) => onToggle(row.ref, e) : undefined}
      onKeyDown={
        changeable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle(row.ref, e);
              }
            }
          : undefined
      }
    >
      <span className={styles.check}>
        {changeable ? (
          <input
            type="checkbox"
            checked={selected}
            readOnly
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
      <span className={styles.code}>
        {renderPieces(pieces)}
        {line.noNewline ? <span className={styles.noNewline}>{S.diff.noNewline}</span> : null}
      </span>
    </div>
  );
}

/** split 줄 (왼쪽 옛 파일, 오른쪽 새 파일) */
function SplitLine({
  row,
  width,
  highlight,
  selectable,
  selected,
  onToggle,
}: {
  row: Extract<DiffRow, { kind: 'split' }>;
  width: number;
  highlight: HighlightMap;
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggle: (ref: LineRef, e: ToggleEvent) => void;
}) {
  const left = row.left;
  const right = row.right;
  const isContext = left && right && left.index === right.index;
  const leftPair = isContext ? null : right;
  const rightPair = isContext ? null : left;
  const side = (ref: LineRef | null, pair: LineRef | null, no: number | null | undefined) => {
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
        onClick={changeable ? (e) => onToggle(ref, e) : undefined}
        onKeyDown={
          changeable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(ref, e);
                }
              }
            : undefined
        }
      >
        <span className={styles.check}>
          {changeable ? (
            <input
              type="checkbox"
              checked={isSel}
              readOnly
              tabIndex={-1}
              aria-label={S.diff.selectLine}
            />
          ) : null}
        </span>
        <span className={styles.no} style={{ width: `${width}ch` }}>
          {no ?? ''}
        </span>
        <span className={styles.code}>{renderPieces(piecesOf(ref, pair, highlight))}</span>
      </div>
    );
  };
  return (
    <div className={styles.split}>
      {side(left, leftPair, left?.line.oldNo)}
      {side(right, rightPair, right?.line.newNo)}
    </div>
  );
}
