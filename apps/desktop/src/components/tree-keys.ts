// 트리 넷(프로젝트·브랜치·변경 파일·Commit 도구 창)이 함께 쓰는 키보드 규칙 (WS-11, W19 ③).
// 키 → 뜻(이동·펼침·접힘·Enter·Space·메뉴)은 여기서 한 번 정하고, Enter·Space 가 무엇을 하는지(열기·체크·필터)는
// 트리마다 정한다. 화면을 모르는 순수 함수라 표 기반 테스트로 네 트리의 규칙이 같음을 지킨다.

/** 키 규칙이 보는 행의 모양 */
export interface TreeKeyRow {
  id: string;
  parentId: string | null;
  /** 펼치거나 접을 수 있는 행 (루트·디렉터리·그룹) */
  expandable: boolean;
  expanded: boolean;
}

/** 키 하나가 뜻하는 것 */
export type TreeKeyCommand =
  /** 그 행으로 커서를 옮긴다. `extend` 면 범위를 그 행까지 넓힌다 (⇧↑↓, 다중 선택 트리만 쓴다) */
  | { kind: 'move'; index: number; extend: boolean }
  /** 커서 행을 펼친다 (→, 접힌 행) */
  | { kind: 'expand' }
  /** 커서 행을 접는다 (←, 펼친 행) */
  | { kind: 'collapse' }
  /** Enter: 열기·주 동작 (트리마다 뜻이 다르다) */
  | { kind: 'enter' }
  /** Space: 미리보기·체크·누르기 (트리마다 뜻이 다르다) */
  | { kind: 'space' }
  /** ⇧F10·메뉴 키: 커서 행의 우클릭 메뉴 */
  | { kind: 'menu' };

/** 키 규칙이 보는 키 입력 */
export interface TreeKeyInput {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export interface TreeKeyOptions {
  /** 펼친 행을 ← 로 접을 수 있는지. 아니면 ← 는 부모로만 간다 (브랜치 트리의 검색 중 — 모두 펼쳐 보인다) */
  canCollapse?: boolean;
}

/** 우클릭 메뉴를 키보드로 여는 키인지: 메뉴 키(`ContextMenu`) 또는 ⇧F10 */
export function isContextMenuKey(e: TreeKeyInput): boolean {
  return (
    e.key === 'ContextMenu' ||
    (e.key === 'F10' && e.shiftKey === true && !e.metaKey && !e.ctrlKey && !e.altKey)
  );
}

/**
 * 트리의 키 하나를 뜻으로 바꾼다 (`index` 는 커서 행, 없으면 -1). ↑↓ 한 줄 이동(커서가 없으면 ↓ = 첫 행, ↑ = 끝 행),
 * Home·End 처음·끝, → 접힌 행은 펼치고 펼친 행은 첫 자식으로, ← 펼친 행은 접고 아니면 부모로, Enter·Space·메뉴 키.
 * ⌘·Ctrl·⌥ 와 함께 누른 화살표는 트리 몫이 아니다 (앱 단축키). 할 일이 없는 키면 null
 */
export function treeKeyCommand(
  e: TreeKeyInput,
  rows: readonly TreeKeyRow[],
  index: number,
  options: TreeKeyOptions = {},
): TreeKeyCommand | null {
  if (isContextMenuKey(e)) {
    return index >= 0 ? { kind: 'menu' } : null;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || rows.length === 0) {
    return null;
  }
  const last = rows.length - 1;
  const row = index >= 0 ? rows[index] : undefined;
  const extend = e.shiftKey === true;
  switch (e.key) {
    case 'ArrowDown':
      return { kind: 'move', index: index < 0 ? 0 : Math.min(last, index + 1), extend };
    case 'ArrowUp':
      return { kind: 'move', index: index < 0 ? last : Math.max(0, index - 1), extend };
    case 'Home':
      return { kind: 'move', index: 0, extend: false };
    case 'End':
      return { kind: 'move', index: last, extend: false };
    case 'ArrowRight':
      if (!row?.expandable) {
        return null;
      }
      if (!row.expanded) {
        return { kind: 'expand' };
      }
      return rows[index + 1]?.parentId === row.id
        ? { kind: 'move', index: index + 1, extend: false }
        : null;
    case 'ArrowLeft': {
      if (!row) {
        return null;
      }
      if (row.expandable && row.expanded && options.canCollapse !== false) {
        return { kind: 'collapse' };
      }
      const parent = row.parentId === null ? -1 : rows.findIndex((r) => r.id === row.parentId);
      return parent >= 0 ? { kind: 'move', index: parent, extend: false } : null;
    }
    case 'Enter':
      return row ? { kind: 'enter' } : null;
    case ' ':
      return row ? { kind: 'space' } : null;
    default:
      return null;
  }
}

/** 행의 형제 수와 그 안의 순번 (`aria-setsize`·`aria-posinset`, 1부터) */
export interface SiblingPosition {
  setSize: number;
  posInSet: number;
}

/**
 * 펼친 트리를 평탄화한 행들의 형제 수·순번 (순수 함수). 같은 부모(`parentId`, 맨 위는 null)를 가진 행끼리 나타난
 * 차례로 센다 — 부모가 펼쳐져 있으면 그 자식들은 모두 행에 있으므로 보이는 행만으로 셀 수 있다. 가상 스크롤로 화면 밖
 * 행이 DOM 에 없어도 보조 기술이 "N개 중 M번째"를 알 수 있게 한다
 */
export function siblingPositions(parentIds: readonly (string | null)[]): SiblingPosition[] {
  const counts = new Map<string | null, number>();
  const order = parentIds.map((parent) => {
    const next = (counts.get(parent) ?? 0) + 1;
    counts.set(parent, next);
    return next;
  });
  return parentIds.map((parent, i) => ({
    setSize: counts.get(parent) ?? 1,
    posInSet: order[i] ?? 1,
  }));
}

/**
 * 그 요소의 우클릭 메뉴를 키보드로 연다: 요소의 왼쪽 아래에서 `contextmenu` 이벤트를 낸다. 영역의 우클릭 메뉴
 * (`ContextMenuArea`)는 이 이벤트의 대상으로 메뉴 대상을 찾고 그 자리에 메뉴를 연다 — 마우스 우클릭과 같은 길이다
 */
export function openContextMenuAt(el: Element | null | undefined): void {
  if (!el) {
    return;
  }
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
