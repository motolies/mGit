import type { GraphRangeCache, GraphRow } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { type Rect, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useFrameStats } from './dev/use-frame-stats';
import { buildDrawList, type WipDraw } from './draw-list';
import { GraphCanvas } from './GraphCanvas';
import {
  type AvatarLookup,
  DEFAULT_GRAPH_COLUMNS,
  fitColumns,
  type GraphColumns,
  GraphRowView,
  graphColumnLeft,
  type RepoLookup,
  type SelectModifiers,
  subjectColumnWidth,
} from './GraphRow';
import styles from './GraphView.module.css';
import { graphColumnWidth, type Viewport } from './geometry';
import { paint } from './paint';
import { refLabelBudget } from './ref-labels';
import { showsRepoName, topNameRow } from './repo-strip';
import { useDevicePixelRatio } from './use-device-pixel-ratio';
import { useGraphWindow } from './use-graph-window';
import { useNow } from './use-now';
import { usePalette } from './use-palette';
import { WipRowView, type WipSummary } from './WipRow';

/**
 * 스크롤 기준: 화면 맨 위에 걸친 커밋 행. 뷰가 다시 마운트되거나 데이터가 다시 읽혀도
 * 같은 커밋을 같은 자리에 두는 데 쓴다 (LG-10)
 */
export interface GraphScrollAnchor {
  oid: string;
  /** 통합 타임라인의 저장소 번호. 같은 커밋이 저장소마다 한 행씩 있을 수 있다. 단일 저장소는 null */
  repo: number | null;
  /** 기억할 때의 그래프 행 번호 */
  row: number;
  /** 그 행의 위쪽 가장자리가 화면 위로 넘어간 길이 (px) */
  offset: number;
}

/** 상대 날짜("N분 전")를 다시 계산하는 주기 (ms) */
const NOW_TICK_MS = 60_000;

export interface GraphViewProps {
  cache: GraphRangeCache;
  totalRows: number;
  rowHeight?: number;
  laneWidth?: number;
  laneCap?: number;
  /** jsdom 처럼 레이아웃이 없는 환경에서 쓸 초기 뷰포트 크기 */
  initialRect?: { width: number; height: number };
  onSelectRow?: (row: GraphRow) => void;
  /** 선택된 커밋 (제어형). 주지 않으면 내부 상태를 쓴다 */
  selectedOid?: string | null;
  /** 행 선택 판정. 같은 커밋이 여러 행일 수 있는 통합 타임라인이 준다 */
  isRowSelected?: (row: GraphRow) => boolean;
  /**
   * 커밋 id 의 현재 행 번호. 캐시가 세대 교체(재로드)되면 맨 위 보이는 커밋을 이 함수로
   * 다시 찾아 스크롤을 복원한다 (명세 3.3 "커밋 id 기준 스크롤 유지").
   * `repo` 는 그 행의 저장소 번호다 (통합 타임라인에서만 값이 있다)
   */
  resolveRow?: (oid: string, repo: number | null) => Promise<number | null>;
  /**
   * 마운트할 때 한 번만 읽는 스크롤 기준. 뷰가 내려갔다 다시 올라와도 보던 자리에서 시작한다.
   * `resolveRow` 가 있으면 그 사이 데이터가 바뀌었는지 확인해 행 번호를 바로잡는다
   */
  initialAnchor?: GraphScrollAnchor | null;
  /** 스크롤 기준이 바뀔 때마다 알린다. 받은 값을 `initialAnchor` 로 되돌려 주면 자리가 이어진다 */
  onAnchorChange?: (anchor: GraphScrollAnchor) => void;
  /** 작업 트리에 변경이 있으면 맨 위에 WIP 행을 둔다 (GRAPH-03) */
  wipRow?: WipSummary | null;
  wipSelected?: boolean;
  onSelectWip?: () => void;
  /** 다른 워크트리의 WIP 행들 (WT-06). 메인 WIP 아래에 차례로 */
  extraWips?: readonly ExtraWip[];
  onSelectExtraWip?: (wip: ExtraWip) => void;
  /** 브랜치 라벨을 행에 놓았을 때 (GRAPH-09) */
  onDropRef?: (refName: string, row: GraphRow) => void;
  /** 검색 일치 행 (GRAPH-06) */
  highlightRows?: ReadonlySet<number>;
  /** 이 행이 보이도록 스크롤한 뒤 `onScrolledTo` 를 부른다 */
  scrollToRow?: number | null;
  onScrolledTo?: () => void;
  /** 렌더한 슬라이스의 행을 알려 준다 (컨텍스트 메뉴가 oid 로 행을 찾는다) */
  onRowsRendered?: (rows: readonly (GraphRow | undefined)[]) => void;
  /** 표시할 열 (GRAPH-12) */
  columns?: GraphColumns;
  /** 작성자 아바타 (GRAPH-11) */
  avatarOf?: AvatarLookup;
  /** 행의 저장소 (통합 타임라인). `columns.repo` 와 함께 쓴다 */
  repoOf?: RepoLookup;
  /** 범위 선택에 든 행 (GRAPH-10) */
  rangeRows?: ReadonlySet<number>;
  /** ⇧+클릭 (GRAPH-10). 없으면 보통 선택으로 처리 */
  onSelectRange?: (row: GraphRow) => void;
  /** 흐리게 그릴 행 (HEAD 에서 닿지 않는 커밋). 없으면 모두 보통 */
  dimRow?: (row: GraphRow) => boolean;
}

/** 다른 워크트리의 WIP 행 */
export interface ExtraWip {
  /** 안정된 키 (워크트리 경로) */
  key: string;
  label: string;
  summary: WipSummary;
  /** 그 워크트리의 HEAD commit */
  headOid: string;
}

const OVERSCAN = 8;

/**
 * 커밋 그래프 뷰.
 * - 텍스트 열은 @tanstack/react-virtual 로 보이는 행만 DOM 에 둔다
 * - 레인·엣지·노드는 스크롤 컨테이너 밖의 캔버스 오버레이에 그린다
 * - 그리기는 렌더 후 effect(슬라이스·크기 변경)와 스크롤 이벤트마다 한다. 가상 행은 보이는 행 범위가
 *   바뀔 때만 다시 렌더되므로, 범위 안의 스크롤(탄성 튕김 복귀 포함)은 스크롤 이벤트가 캔버스를 맞춘다
 * - WIP 행이 있으면 표시 행 0 에 끼워 넣고 그래프 행은 1 씩 밀린다 (`rowOffset`)
 * - 저장소 띠 열이 있으면 캔버스를 그 폭만큼 오른쪽으로 옮긴다. 레인 좌표는 그래프 열 기준 그대로다
 */
export function GraphView({
  cache,
  totalRows,
  rowHeight = 24,
  laneWidth = 14,
  laneCap = 24,
  initialRect,
  onSelectRow,
  selectedOid,
  isRowSelected,
  resolveRow,
  initialAnchor,
  onAnchorChange,
  wipRow,
  wipSelected,
  onSelectWip,
  extraWips = [],
  onSelectExtraWip,
  onDropRef,
  highlightRows,
  scrollToRow,
  onScrolledTo,
  onRowsRendered,
  columns = DEFAULT_GRAPH_COLUMNS,
  avatarOf,
  repoOf,
  rangeRows,
  onSelectRange,
  dimRow,
}: GraphViewProps) {
  const baseId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportHeight, setViewportHeight] = useState(initialRect?.height ?? 0);
  const [maxLaneSeen, setMaxLaneSeen] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(initialRect?.width ?? 0);
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  // 마운트할 때의 스크롤 기준. 이후에 바뀌는 prop 은 보지 않는다
  const [startAnchor] = useState(() => initialAnchor ?? null);
  const startAnchorChecked = useRef(false);
  const dpr = useDevicePixelRatio();
  const colors = usePalette();
  const now = useNow(NOW_TICK_MS);
  const markActivity = useFrameStats(import.meta.env.DEV, 'graph-view');
  const mainOffset = wipRow ? 1 : 0;
  const offset = mainOffset + extraWips.length;
  const currentSelected = selectedOid === undefined ? internalSelected : selectedOid;
  const isSelected = useCallback(
    (row: GraphRow) => (isRowSelected ? isRowSelected(row) : row.oid === currentSelected),
    [isRowSelected, currentSelected],
  );

  // 레이아웃이 없는 환경(jsdom)에서는 getBoundingClientRect 가 0 이라 initialRect 를 고정값으로 쓴다
  const fixedRect = initialRect;
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: totalRows + offset,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    initialRect,
    // 첫 스크롤 위치로만 쓰인다: 기억해 둔 기준 행이 있으면 그 자리에서 시작한다 (맨 위에서 깜빡이지 않는다)
    initialOffset: startAnchor ? (startAnchor.row + offset) * rowHeight + startAnchor.offset : 0,
    ...(fixedRect
      ? {
          observeElementRect: (
            _instance: Virtualizer<HTMLDivElement, Element>,
            cb: (rect: Rect) => void,
          ) => {
            cb(fixedRect);
            return () => {};
          },
        }
      : {}),
  });
  const items = virtualizer.getVirtualItems();
  const first = Math.max(0, (items[0]?.index ?? 0) - offset);
  const last = (items[items.length - 1]?.index ?? -1) - offset;
  const slice = useGraphWindow(cache, first, last + 1);
  useEffect(() => {
    onRowsRendered?.(slice.rows);
  }, [slice, onRowsRendered]);

  // 검색·링크 이동: 요청한 행을 가운데로 스크롤한다
  useEffect(() => {
    if (scrollToRow === null || scrollToRow === undefined) {
      return;
    }
    virtualizer.scrollToIndex(scrollToRow + offset, { align: 'center' });
    onScrolledTo?.();
  }, [scrollToRow, virtualizer, offset, onScrolledTo]);

  // 맨 위 보이는 커밋을 기억해 둔다 (재로드·재마운트 뒤 스크롤 복원 기준).
  // 위치는 가상 행을 계산한 값과 같은 것을 쓴다 — 첫 렌더에는 DOM 의 스크롤 위치가 아직 0 이다
  const anchorRef = useRef<GraphScrollAnchor | null>(null);
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const firstVisible = items.find((it) => it.end > scrollTop && it.index >= offset);
  const anchorRow = firstVisible
    ? slice.rows[firstVisible.index - offset - slice.start]
    : undefined;
  const anchorOffset = firstVisible ? scrollTop - firstVisible.start : 0;
  if (anchorRow) {
    anchorRef.current = {
      oid: anchorRow.oid,
      repo: anchorRow.repo ?? null,
      row: anchorRow.row,
      offset: anchorOffset,
    };
  }
  const anchorOid = anchorRow?.oid;
  const anchorRepo = anchorRow?.repo ?? null;
  const anchorIndex = anchorRow?.row;
  // 기준이 바뀌면 바깥에 알린다 (바깥이 기억했다가 다음 마운트의 `initialAnchor` 로 준다)
  useEffect(() => {
    if (anchorOid !== undefined && anchorIndex !== undefined) {
      onAnchorChange?.({
        oid: anchorOid,
        repo: anchorRepo,
        row: anchorIndex,
        offset: anchorOffset,
      });
    }
  }, [anchorOid, anchorRepo, anchorIndex, anchorOffset, onAnchorChange]);

  // 재로드: 세대가 바뀌기 직전의 기준 커밋을 새 데이터에서 다시 찾아 그 자리로 간다
  useEffect(() => {
    if (!resolveRow) {
      return;
    }
    return cache.subscribeInvalidation(() => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      void resolveRow(anchor.oid, anchor.repo).then((row) => {
        if (row === null) {
          return;
        }
        virtualizer.scrollToOffset((row + offset) * rowHeight + anchor.offset);
      });
    });
  }, [cache, resolveRow, virtualizer, rowHeight, offset]);

  // 재마운트: 기억해 둔 행 번호에서 시작한 뒤, 뷰가 없던 사이 데이터가 다시 읽혔으면 행 번호를 바로잡는다
  useEffect(() => {
    if (!startAnchor || !resolveRow || startAnchorChecked.current) {
      return;
    }
    let live = true;
    void resolveRow(startAnchor.oid, startAnchor.repo).then((row) => {
      if (!live) {
        return;
      }
      startAnchorChecked.current = true;
      if (row !== null && row !== startAnchor.row) {
        virtualizer.scrollToOffset((row + offset) * rowHeight + startAnchor.offset);
      }
    });
    return () => {
      live = false;
    };
  }, [startAnchor, resolveRow, virtualizer, rowHeight, offset]);

  // 레인 폭은 단조 증가만 시켜 스크롤 중 열 폭이 떨리지 않게 한다
  let seen = maxLaneSeen;
  for (const row of slice.rows) {
    if (row && row.lane > seen) {
      seen = row.lane;
    }
  }
  for (const seg of slice.segments) {
    if (seg.lane > seen) {
      seen = seg.lane;
    }
  }
  useEffect(() => {
    if (seen > maxLaneSeen) {
      setMaxLaneSeen(seen);
    }
  }, [seen, maxLaneSeen]);
  const graphCol = graphColumnWidth(maxLaneSeen + 1, laneWidth, laneCap);
  const graphLeft = graphColumnLeft(columns);
  // 좁은 뷰에서는 다 들어가지 않는 칸을 뺀다 (제목 칸을 지킨다). 띠·그래프는 그대로라 캔버스 위치는 같다
  const shownColumns = fitColumns(columns, graphCol, viewportWidth);
  const labelBudget = refLabelBudget(
    viewportWidth > 0 ? subjectColumnWidth(shownColumns, graphCol, viewportWidth) : 0,
  );
  // 저장소 띠의 이름은 구간의 첫 행과 이 행(화면 맨 위)에만 쓴다 (LG-02)
  const nameRow = topNameRow(scrollTop, rowHeight, offset);

  // 뷰포트 크기 추적. 폭은 ref 라벨 영역의 예산을 낼 때 쓴다 (스크롤바를 뺀 행의 폭)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const update = () => {
      if (el.clientHeight > 0) {
        setViewportHeight(el.clientHeight);
      }
      if (el.clientWidth > 0) {
        setViewportWidth(el.clientWidth);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    if (!canvas || !scroller || viewportHeight <= 0) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return; // jsdom
    }
    const viewport: Viewport = {
      scrollTop: scroller.scrollTop,
      height: viewportHeight,
      rowHeight,
      laneWidth,
      laneCap,
      rowOffset: offset,
    };
    let wip: WipDraw | null = null;
    if (wipRow) {
      const head = slice.rows.find((r) => r?.isHead);
      wip = head
        ? { lane: head.lane, headRow: head.row, color: head.color }
        : { lane: 0, headRow: null, color: 0 };
    }
    const extras: WipDraw[] = extraWips.map((w, i) => {
      const target = slice.rows.find((r) => r?.oid === w.headOid);
      return target
        ? {
            lane: target.lane,
            headRow: target.row,
            color: target.color,
            displayIndex: mainOffset + i,
          }
        : { lane: 0, headRow: null, color: 0, displayIndex: mainOffset + i };
    });
    const list = buildDrawList(slice, viewport, wip, extras);
    paint(
      ctx,
      list,
      colors.lanes,
      dpr,
      { width: graphCol, height: viewportHeight },
      colors.background,
    );
  }, [
    slice,
    viewportHeight,
    rowHeight,
    laneWidth,
    laneCap,
    colors,
    dpr,
    graphCol,
    offset,
    mainOffset,
    wipRow,
    extraWips,
  ]);

  // 렌더(가상 행 갱신)마다 캔버스를 다시 그린다
  useEffect(() => {
    redraw();
  }, [redraw]);

  // 스크롤 리스너가 다시 붙지 않고도 최신 슬라이스·크기로 그리게 한다.
  // 레이아웃 effect 라 가상 스크롤이 스크롤 이벤트 안에서 flushSync 로 다시 렌더한 직후에도 최신이다
  const redrawRef = useRef(redraw);
  useLayoutEffect(() => {
    redrawRef.current = redraw;
  }, [redraw]);

  // 스크롤 이벤트마다: 활동 표시(프레임 측정용)와 캔버스 다시 그리기.
  // 가상 스크롤은 보이는 행 범위·isScrolling 이 바뀔 때만 다시 렌더하므로, 범위 안의 스크롤은 여기서 맞춘다.
  // 스크롤 이벤트는 브라우저가 프레임당 한 번 보내므로 rAF 로 다시 묶지 않는다
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      markActivity();
      redrawRef.current();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [markActivity]);

  const handleSelect = useCallback(
    (row: GraphRow, mods?: SelectModifiers) => {
      if (mods?.shiftKey && onSelectRange) {
        onSelectRange(row);
        return;
      }
      setInternalSelected(row.oid);
      onSelectRow?.(row);
    },
    [onSelectRow, onSelectRange],
  );

  // 키로 고른 행이 아직 읽히지 않았을 때: 읽힌 뒤에 고른다. 마지막 요청만 살린다 (키를 빨리 누르면 앞 요청은 버린다)
  const keySeq = useRef(0);
  /** 그 그래프 행을 고르고 보이게 스크롤한다 (PageUp·PageDown·Home·End). 첫 행이면 맨 위(WIP 행까지)로 */
  const selectAt = useCallback(
    (target: number) => {
      const seq = ++keySeq.current;
      if (target <= 0) {
        virtualizer.scrollToOffset(0);
      } else {
        virtualizer.scrollToIndex(target + offset, { align: 'auto' });
      }
      const loaded = cache.slice(target, target + 1).rows[0];
      if (loaded) {
        handleSelect(loaded);
        return;
      }
      void cache.ensureRange(target, target + 1).then(() => {
        const row = cache.slice(target, target + 1).rows[0];
        if (row && seq === keySeq.current) {
          handleSelect(row);
        }
      });
    },
    [cache, handleSelect, virtualizer, offset],
  );

  /**
   * 행 이동 (UX-10, W19 ③): ↑↓ 인접 행(로드된 행 안에서), PageUp·PageDown 한 화면, Home·End 처음·끝 행.
   * ⇧F10·메뉴 키는 고른 행의 우클릭 메뉴를 연다 (바깥의 메뉴 영역이 행의 `contextmenu` 를 받는다).
   * ⌘↑·⌘↓는 Home·End와 같은 경로로 이동한다. 입력란 안의 키와 나머지 수정키 조합은 건드리지 않는다
   */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        (e.target as HTMLElement).closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        return;
      }
      const rows = slice.rows;
      const idx = rows.findIndex((r) => r !== undefined && isSelected(r));
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        const el = e.currentTarget.querySelector<HTMLElement>('[role="row"][aria-selected="true"]');
        if (el) {
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: rect.left + Math.min(24, rect.width / 2),
              clientY: rect.bottom,
            }),
          );
        }
        return;
      }
      const commandBoundary =
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown');
      if ((e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) && !commandBoundary) {
        return;
      }
      const key = commandBoundary ? (e.key === 'ArrowUp' ? 'Home' : 'End') : e.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        const next =
          idx < 0
            ? rows.find((r) => r !== undefined)
            : rows[idx + (e.key === 'ArrowDown' ? 1 : -1)];
        if (!next) {
          return;
        }
        handleSelect(next);
        virtualizer.scrollToIndex(next.row + offset, { align: 'auto' });
        return;
      }
      if (totalRows <= 0) {
        return;
      }
      // 기준 행: 고른 행이 화면(읽힌 조각)에 있으면 그 행, 아니면 화면 맨 위 행
      const current = idx >= 0 ? (rows[idx]?.row ?? 0) : first;
      const page = Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
      let target: number;
      switch (key) {
        case 'Home':
          target = 0;
          break;
        case 'End':
          target = totalRows - 1;
          break;
        case 'PageDown':
          target = Math.min(totalRows - 1, current + page);
          break;
        case 'PageUp':
          target = Math.max(0, current - page);
          break;
        default:
          return;
      }
      e.preventDefault();
      selectAt(target);
    },
    [
      slice.rows,
      isSelected,
      handleSelect,
      virtualizer,
      offset,
      totalRows,
      first,
      viewportHeight,
      rowHeight,
      selectAt,
    ],
  );

  // 고른 행이 그려져 있으면 보조 기술에 그 행을 알린다 (포커스는 뷰가 받고 행은 activedescendant)
  const selectedItem = items.find((item) => {
    if (item.index < offset) {
      return item.index === 0 && wipRow && wipSelected;
    }
    const row = slice.rows[item.index - offset - slice.start];
    return row !== undefined && isSelected(row);
  });
  const rowDomId = (index: number) => `${baseId}-r${index}`;

  return (
    // 커밋 표 (W19 ③): 포커스는 뷰가 받고(⌘9) 행 단위로 옮긴다 (칸 단위 이동은 없다)
    // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤·캔버스 겹침이라 <table> 로 그릴 수 없다
    <div
      className={styles.wrapper}
      tabIndex={0}
      role="grid"
      aria-label={S.graph.label}
      aria-rowcount={totalRows + offset}
      aria-activedescendant={selectedItem ? rowDomId(selectedItem.index) : undefined}
      onKeyDown={onKeyDown}
    >
      <GraphCanvas
        canvasRef={canvasRef}
        width={graphCol}
        height={viewportHeight}
        left={graphLeft}
        dpr={dpr}
        className={styles.overlay}
      />
      {/* 스크롤 상자는 Tab 정지가 아니다 — 키는 바깥 표(grid)가 받는다 (Chromium 은 포커스 가능한 자식이 없는 스크롤
      상자를 Tab 으로 닿게 한다, W19 ③) */}
      <div
        ref={scrollRef}
        className={styles.scroller}
        data-testid="graph-scroller"
        role="presentation"
        tabIndex={-1}
      >
        <div
          className={styles.inner}
          style={{ height: virtualizer.getTotalSize() }}
          role="presentation"
        >
          {items.map((item) => {
            if (wipRow && item.index === 0) {
              return (
                <WipRowView
                  key={item.key}
                  summary={wipRow}
                  graphColumnWidth={graphCol}
                  rowHeight={rowHeight}
                  offsetTop={item.start}
                  selected={!!wipSelected}
                  columns={shownColumns}
                  onSelect={onSelectWip}
                  domId={rowDomId(item.index)}
                  ariaRowIndex={item.index + 1}
                />
              );
            }
            if (item.index < offset) {
              const extra = extraWips[item.index - mainOffset];
              if (extra) {
                return (
                  <WipRowView
                    key={item.key}
                    summary={extra.summary}
                    label={extra.label}
                    graphColumnWidth={graphCol}
                    rowHeight={rowHeight}
                    offsetTop={item.start}
                    selected={false}
                    columns={shownColumns}
                    onSelect={() => onSelectExtraWip?.(extra)}
                    domId={rowDomId(item.index)}
                    ariaRowIndex={item.index + 1}
                  />
                );
              }
            }
            const graphRow = item.index - offset;
            const row = slice.rows[graphRow - slice.start];
            // 앞 행이 슬라이스 밖이거나 아직 안 읽혔으면 undefined (구간의 시작인지 모른다)
            const prev = slice.rows[graphRow - 1 - slice.start];
            return (
              <GraphRowView
                key={item.key}
                index={graphRow}
                row={row}
                graphColumnWidth={graphCol}
                rowHeight={rowHeight}
                offsetTop={item.start}
                selected={row !== undefined && isSelected(row)}
                highlighted={highlightRows?.has(graphRow) ?? false}
                inRange={rangeRows?.has(graphRow) ?? false}
                dim={row !== undefined && (dimRow?.(row) ?? false)}
                columns={shownColumns}
                avatarOf={avatarOf}
                repoOf={repoOf}
                showRepoName={
                  columns.repo === true &&
                  row !== undefined &&
                  showsRepoName(
                    { index: graphRow, repo: row.repo ?? null },
                    prev === undefined ? undefined : (prev.repo ?? null),
                    nameRow,
                  )
                }
                now={now}
                labelBudget={labelBudget}
                onSelect={handleSelect}
                onDropRef={onDropRef}
                domId={rowDomId(item.index)}
                ariaRowIndex={item.index + 1}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
