// 접근성 검사 도우미 (W19 ③, 테스트 전용): 렌더된 DOM 에서 Tab 정지와 이름 없는 단추를 찾는다.
// 새 의존성(접근성 검사 도구) 없이 규칙 몇 개만 본다 — 브라우저의 Tab 순서·이름 계산을 흉내 낸 근사다.

import { act, fireEvent } from '@testing-library/react';
import { expect, vi } from 'vitest';

/**
 * 트리 하나의 공용 규칙을 확인한다: 모든 행의 단계·형제 수·순번, 펼칠 수 있는 행의 펼침 상태, Home·↓ 의 커서 이동
 * (activedescendant), ⇧F10 의 우클릭 메뉴 요청. 트리 넷이 같은 결과여야 한다 (W19 ③ — 저장소 탭 브랜치 트리도 W22)
 */
export function checkTreeRules(tree: HTMLElement) {
  expect(tree.getAttribute('aria-label')).toBeTruthy();
  const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  expect(items.length).toBeGreaterThan(1);
  const missing = items.filter(
    (el) =>
      !el.getAttribute('aria-level') ||
      !el.getAttribute('aria-setsize') ||
      !el.getAttribute('aria-posinset'),
  );
  expect(missing.map((el) => el.textContent)).toEqual([]);
  const cursorRow = () =>
    document
      .getElementById(tree.getAttribute('aria-activedescendant') ?? '')
      ?.getAttribute('data-row-index');
  act(() => tree.focus());
  act(() => {
    fireEvent.keyDown(tree, { key: 'Home' });
  });
  expect(cursorRow()).toBe('0');
  act(() => {
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
  });
  expect(cursorRow()).toBe('1');
  const menu = vi.fn();
  tree.addEventListener('contextmenu', (e) =>
    menu((e.target as HTMLElement).closest('[data-row-index]')?.getAttribute('data-row-index')),
  );
  act(() => {
    fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
  });
  expect(menu).toHaveBeenCalledWith('1');
  // 열린 메뉴(있다면)를 Esc 로 닫는다 — 열린 동안에는 메뉴 밖이 보조 기술에서 숨는다
  const opened = document.querySelector('[role="menu"]');
  if (opened) {
    act(() => {
      fireEvent.keyDown(opened, { key: 'Escape' });
    });
  }
}

/**
 * 그 요소가 Tab 순서에서 빠지는지: 꺼짐·숨김(`hidden`·`display: none`)·`inert` 조상·닫힌 대화상자(`<dialog>` 는 열리기
 * 전에도 DOM 에 있다 — 브라우저는 닫힌 대화상자를 그리지 않는다. W27: 작업 진행 띠의 줄마다 확인창이 있다)
 */
function outOfTabOrder(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) {
    return true;
  }
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('inert') || node.hidden || node.style.display === 'none') {
      return true;
    }
    if (node.tagName === 'DIALOG' && !node.hasAttribute('open')) {
      return true;
    }
  }
  return false;
}

/** Tab 으로 닿는 요소들 (문서 순서, `tabindex` 양수는 쓰지 않으므로 순서 보정은 없다) */
export function tabStops(root: ParentNode = document): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, a[href], [tabindex]',
  );
  return [...candidates].filter((el) => {
    const attr = el.getAttribute('tabindex');
    if (attr !== null && Number(attr) < 0) {
      return false;
    }
    if (el instanceof HTMLInputElement && el.type === 'hidden') {
      return false;
    }
    return !outOfTabOrder(el);
  });
}

/** 단추의 접근성 이름 (근사): aria-label → aria-labelledby 의 글자 → 보이는 글자 → title */
export function buttonName(el: HTMLElement): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) {
    return label;
  }
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) {
      return text;
    }
  }
  const text = el.textContent?.trim();
  if (text) {
    return text;
  }
  return el.getAttribute('title')?.trim() ?? '';
}

/** 이름이 없는 단추들 (`button`·`role="button"`·`role="tab"`). 숨은 영역(`inert`·`hidden`)의 것도 본다 */
export function unnamedButtons(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"]')].filter(
    (el) => buttonName(el) === '',
  );
}
