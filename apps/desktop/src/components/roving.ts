// 묶음 하나를 Tab 정지 하나로 만드는 "움직이는 tabindex" 의 키 규칙 (W19 ③). 탭 막대·도구 막대·콘솔 목록·개요 표가 쓴다.
// 묶음 안의 항목 중 하나만 tabIndex 0 이고 나머지는 -1 이며, 화살표·Home·End 로 포커스를 옮긴다.

import { type FocusEvent, type KeyboardEvent, useLayoutEffect, useRef } from 'react';

/** 화살표 방향: 가로(←→) / 세로(↑↓) */
export type RovingOrientation = 'horizontal' | 'vertical';

/** 한 번에 넘기는 항목 수 (PageUp·PageDown, 세로 목록만) */
export const ROVING_PAGE = 10;

/**
 * 키에 맞는 다음 항목 번호 (순수 함수). 방향에 맞는 화살표는 한 칸(끝에서 반대쪽 끝으로 돈다 — 탭·도구 막대의 관례),
 * Home·End 는 처음·끝, 세로 목록의 PageUp·PageDown 은 `ROVING_PAGE` 칸(끝에서 멈춘다). 항목이 없거나 그 키가 아니면 null.
 * `wrap` 이 거짓이면 화살표도 끝에서 멈춘다 (긴 목록)
 */
export function rovingIndex(
  key: string,
  index: number,
  count: number,
  orientation: RovingOrientation,
  wrap = true,
): number | null {
  if (count <= 0) {
    return null;
  }
  const last = count - 1;
  const at = Math.min(Math.max(index, 0), last);
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  switch (key) {
    case next:
      if (index < 0) {
        return 0;
      }
      return at < last ? at + 1 : wrap ? 0 : last;
    case prev:
      if (index < 0) {
        return last;
      }
      return at > 0 ? at - 1 : wrap ? last : 0;
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return orientation === 'vertical' ? Math.min(last, at + ROVING_PAGE) : null;
    case 'PageUp':
      return orientation === 'vertical' ? Math.max(0, at - ROVING_PAGE) : null;
    default:
      return null;
  }
}

/** 수정키(⌘·Ctrl·⌥)와 함께 누른 키인지. 움직이는 tabindex 의 화살표는 맨 키(⇧ 없이)만 받는다 */
export function hasModifier(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
}

/** 도구 막대 안의 항목: 켜진 단추 */
const TOOLBAR_ITEMS = 'button:not([disabled])';

/** 묶음 하나의 선택 사항 (W27). 주지 않으면 도구 막대의 규칙이다 */
export interface RovingGroupOptions {
  /** 묶음 안의 항목 (CSS 선택자, 기본 = 켜진 단추) */
  items?: string;
  /**
   * 화살표가 끝에서 반대쪽 끝으로 도는지 (기본 true — 막대). false 면 끝에서 멈추고 세로 목록의 PageUp·PageDown 도
   * 받는다 (긴 목록 — 저장소 탭 Commit 도구 창의 변경 목록·커밋 상세의 파일 목록)
   */
  wrap?: boolean;
}

/**
 * 도구 막대(`role="toolbar"`) 하나를 Tab 정지 하나로 만든다 (W19 ③ — 왼쪽 띠·브랜치 세로 툴바). 막대 안의 켜진 단추 중
 * 마지막으로 포커스를 받은 것만 tabIndex 0 이고, 방향 화살표·Home·End 로 옆 단추에 포커스를 옮긴다(끝에서 돈다).
 * 단추가 몇 개인지·무엇인지 모른다 — 그릴 때마다 DOM 의 켜진 단추로 tabIndex 를 맞춘다(꺼진 단추는 건너뛴다).
 * 돌려준 `ref`·`onKeyDown`·`onFocus` 를 막대 요소에 단다. 막대가 아닌 묶음(긴 목록)은 `options` 로 항목·끝 규칙을 바꾼다
 */
export function useRovingToolbar<T extends HTMLElement>(
  orientation: RovingOrientation,
  options: RovingGroupOptions = {},
) {
  const ref = useRef<T>(null);
  const current = useRef(0);
  const selector = options.items ?? TOOLBAR_ITEMS;
  const wrap = options.wrap ?? true;
  /** 묶음 안의 항목들 (기본: 켜진 단추) */
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
  /** Tab 정지를 지금 단추 하나로 맞춘다 */
  const sync = () => {
    const list = items();
    const at = Math.min(current.current, list.length - 1);
    list.forEach((el, i) => {
      el.tabIndex = i === at ? 0 : -1;
    });
  };
  // 그릴 때마다(단추가 켜지고 꺼질 때) 맞춘다
  useLayoutEffect(sync);
  const onFocus = (e: FocusEvent<T>) => {
    const at = items().indexOf(e.target as HTMLElement);
    if (at >= 0 && at !== current.current) {
      current.current = at;
      sync();
    }
  };
  const onKeyDown = (e: KeyboardEvent<T>) => {
    if (hasModifier(e) || (wrap && (e.key === 'PageUp' || e.key === 'PageDown'))) {
      return;
    }
    const list = items();
    const at = list.indexOf(e.target as HTMLElement);
    const next = rovingIndex(e.key, at, list.length, orientation, wrap);
    if (next === null || at < 0) {
      return;
    }
    e.preventDefault();
    current.current = next;
    sync();
    list[next]?.focus();
  };
  return { ref, onKeyDown, onFocus };
}

/** 열 번호들 중 `col` 에 가장 가까운 것의 순번 (거리가 같으면 왼쪽 — 결과가 가벼운 단추). 비었으면 0 */
export function nearestColumn(cols: readonly number[], col: number): number {
  let best = 0;
  cols.forEach((c, i) => {
    const d = Math.abs(c - col);
    const bestCol = cols[best] ?? 0;
    const bestD = Math.abs(bestCol - col);
    if (d < bestD || (d === bestD && c < bestCol)) {
      best = i;
    }
  });
  return best;
}

/** 2차원 묶음의 항목 자리: 몇째 줄의 몇째 항목 (각 줄의 켜진 항목 안에서 센다) */
export interface GridSpot {
  row: number;
  index: number;
}

/**
 * 2차원 묶음(작업 진행 띠, W27)의 키 하나에 맞는 다음 자리 (순수 함수). `cols` 는 줄마다 켜진 항목들의 열 번호(왼쪽부터).
 * 줄 안은 막대 규칙 — ←→ 한 칸(끝에서 돈다), Home·End 는 그 줄의 처음·끝. 줄 사이는 목록 규칙 — ↑↓ 는 켜진 항목이 있는
 * 위·아래 줄로(끝에서 멈춘다) 가서 열이 가장 가까운 항목을 고른다(거리가 같으면 왼쪽). 그 키가 아니거나 갈 곳이 없으면 null
 */
export function rovingGridMove(
  key: string,
  at: GridSpot,
  cols: readonly (readonly number[])[],
): GridSpot | null {
  const row = cols[at.row] ?? [];
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step = key === 'ArrowDown' ? 1 : -1;
    const col = row[at.index] ?? 0;
    for (let r = at.row + step; r >= 0 && r < cols.length; r += step) {
      const target = cols[r] ?? [];
      if (target.length > 0) {
        return { row: r, index: nearestColumn(target, col) };
      }
    }
    return null;
  }
  if (key === 'PageUp' || key === 'PageDown') {
    return null;
  }
  const next = rovingIndex(key, at.index, row.length, 'horizontal');
  return next === null ? null : { row: at.row, index: next };
}

/** 2차원 묶음의 선택 사항 */
export interface RovingGridOptions {
  /** 줄 요소 (CSS 선택자) — 묶음 안에서 위에서부터 차례로 줄이다 */
  row: string;
  /** 줄 안의 항목 (CSS 선택자, 기본 = 켜진 단추). 대화상자(`dialog`) 안의 요소는 늘 뺀다 */
  items?: string;
  /** 묶음이 화면에서 사라질 때 포커스가 그 안에 있었으면 옮길 곳 (W27 — 띠가 통째로 사라질 때) */
  onFocusLost?: () => void;
}

/** 항목의 열 번호: 가장 가까운 `data-col` (없으면 그 줄 안의 순번) */
function columnOf(el: HTMLElement, fallback: number): number {
  const col = Number(el.closest<HTMLElement>('[data-col]')?.dataset.col);
  return Number.isFinite(col) ? col : fallback;
}

/**
 * 2차원 묶음 하나를 Tab 정지 하나로 만든다 (W27 — 작업 진행 띠: 줄마다 단추 2~5개). 공용 규칙을 두 축에 나눠 쓴다: 줄 안은
 * 막대(←→ 돈다·Home·End), 줄 사이는 목록(↑↓ 끝에서 멈춘다, 같은 열에 가장 가까운 켜진 항목). 꺼진 단추는 건너뛰고, 켜진
 * 항목이 없는 줄은 ↑↓ 에서 건너뛴다. Tab 정지는 마지막으로 포커스를 받은 항목이다 — 그 항목이 꺼졌으면 같은 줄의 가장
 * 가까운 켜진 항목, 줄까지 사라졌으면 첫 켜진 항목.
 * 포커스가 있던 항목이 꺼지거나 사라지면(작업 실행 → busy → 끝남) 포커스를 묶음 자신에 잠시 둔다 — 다른 줄(다른 저장소·
 * 격리 병합의 "반영")의 단추로 저절로 옮기지 않는다. 묶음에 둔 동안 그 줄에 켜진 항목이 다시 생기면(다시 충돌·실패) 그
 * 줄의 Tab 정지로 돌아간다. 묶음이 통째로 사라질 때 포커스가 그 안에 있었으면 `onFocusLost` 를 부른다 — 이 훅을 쓰는
 * 컴포넌트가 묶음과 함께 내려가야 한다. 돌려준 `ref`·`onKeyDown`·`onFocus`·`onBlur` 를 묶음 요소에 단다
 */
export function useRovingGrid<T extends HTMLElement>(options: RovingGridOptions) {
  const ref = useRef<T>(null);
  // 마지막으로 포커스를 받은 항목, 포커스가 묶음 안에 있는지 (꺼짐·사라짐으로 body 로 빠졌는지 가르는 데 쓴다)
  const last = useRef<HTMLElement | null>(null);
  const inside = useRef(false);
  const { row: rowSelector, items: itemSelector = TOOLBAR_ITEMS, onFocusLost } = options;
  const lostRef = useRef(onFocusLost);
  useLayoutEffect(() => {
    lostRef.current = onFocusLost;
  });

  /** 줄마다의 켜진 항목 (대화상자 안의 것은 뺀다) */
  const rows = (): HTMLElement[][] =>
    [...(ref.current?.querySelectorAll<HTMLElement>(rowSelector) ?? [])].map((row) =>
      [...row.querySelectorAll<HTMLElement>(itemSelector)].filter((el) => !el.closest('dialog')),
    );
  /** Tab 정지가 될 항목: 마지막 항목 → (그 줄이 남았으면) 같은 줄의 열이 가장 가까운 항목 → 첫 항목 */
  const stopOf = (grid: HTMLElement[][]): HTMLElement | undefined => {
    const prev = last.current;
    if (prev && grid.some((r) => r.includes(prev))) {
      return prev;
    }
    const prevRow = prev?.isConnected ? prev.closest(rowSelector) : null;
    const sameRow = prevRow ? grid.find((r) => r[0]?.closest(rowSelector) === prevRow) : undefined;
    if (prev && sameRow) {
      const cols = sameRow.map((el, i) => columnOf(el, i));
      return sameRow[nearestColumn(cols, columnOf(prev, 0))];
    }
    return grid.flat()[0];
  };

  // 그릴 때마다: Tab 정지를 하나로 맞추고, 포커스가 있던 항목이 꺼지거나 사라졌으면 묶음에 둔다
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) {
      return;
    }
    const grid = rows();
    const all = grid.flat();
    const stop = stopOf(grid);
    for (const el of all) {
      el.tabIndex = el === stop ? 0 : -1;
    }
    if (!inside.current) {
      return;
    }
    const active = document.activeElement;
    const prev = last.current;
    if (active === box) {
      // 묶음에 둔 동안 그 줄에 켜진 항목이 다시 생겼다 (다시 충돌·실패): 그 줄의 Tab 정지로 돌아간다
      if (stop && prev?.isConnected && stop.closest(rowSelector) === prev.closest(rowSelector)) {
        stop.focus({ preventScroll: true });
      }
      return;
    }
    const gone = prev !== null && !all.includes(prev);
    const fell = active === null || active === document.body;
    if (gone && (fell || active === prev)) {
      // 누른 단추가 꺼졌거나(busy) 그 줄이 사라졌다: 묶음에 둔다 (묶음을 떠나면 tabIndex 를 거둔다)
      box.tabIndex = -1;
      box.focus({ preventScroll: true });
    } else if (fell) {
      // 항목은 그대로인데 포커스가 빠졌다 (빈 곳을 눌렀다 등): 묶음을 떠난 것이다
      inside.current = false;
    }
  });

  // 묶음이 내려갈 때 포커스가 그 안에 있었으면 옮길 곳에 준다 (DOM 에서 떼어지기 전에 불린다)
  useLayoutEffect(() => {
    const box = ref.current;
    return () => {
      if (box?.contains(document.activeElement)) {
        lostRef.current?.();
      }
    };
  }, []);

  const onFocus = (e: FocusEvent<T>) => {
    inside.current = true;
    const target = e.target as HTMLElement;
    const all = rows().flat();
    if (all.includes(target)) {
      last.current = target;
      for (const el of all) {
        el.tabIndex = el === target ? 0 : -1;
      }
    }
  };
  const onBlur = (e: FocusEvent<T>) => {
    const box = ref.current;
    const next = e.relatedTarget as Node | null;
    if (box && next !== null && !box.contains(next)) {
      inside.current = false;
    }
    if (box && e.target === box) {
      box.removeAttribute('tabindex');
    }
  };
  const onKeyDown = (e: KeyboardEvent<T>) => {
    if (hasModifier(e)) {
      return;
    }
    const grid = rows();
    // 묶음에 둔 포커스에서 화살표·Home·End: Tab 정지 항목으로 들어간다
    if (e.target === ref.current) {
      const stop = stopOf(grid);
      if (stop && GRID_KEYS.has(e.key)) {
        e.preventDefault();
        stop.focus();
      }
      return;
    }
    const row = grid.findIndex((r) => r.includes(e.target as HTMLElement));
    if (row < 0) {
      // 항목이 아닌 곳(대화상자 안 등)의 키는 건드리지 않는다
      return;
    }
    const index = grid[row]?.indexOf(e.target as HTMLElement) ?? -1;
    const cols = grid.map((r) => r.map((el, i) => columnOf(el, i)));
    const next = rovingGridMove(e.key, { row, index }, cols);
    if (next === null) {
      return;
    }
    e.preventDefault();
    grid[next.row]?.[next.index]?.focus();
  };
  return { ref, onKeyDown, onFocus, onBlur };
}

/** 2차원 묶음이 받는 키 */
const GRID_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
