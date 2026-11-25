import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenuArea, menuGroups, normalizeMenuItems } from '../components/ContextMenu';

afterEach(cleanup);

describe('컨텍스트 메뉴 공통 정책', () => {
  it('빈 하위 메뉴를 빼고 구분선은 실제 그룹 사이에만 둔다', () => {
    const items = menuGroups([
      [],
      [{ label: '비어 있음', children: [] }],
      [{ label: '열기', separator: true }],
      [{ label: '빈 하위 메뉴', separator: true, children: [] }, { label: '복사' }],
    ]);
    expect(items.map((item) => [item.label, item.separator])).toEqual([
      ['열기', false],
      ['복사', true],
    ]);
    expect(
      normalizeMenuItems([{ label: '부모', children: [{ label: '하위', separator: true }] }])[0]
        ?.children?.[0]?.separator,
    ).toBe(false);
  });

  it('바깥 대상과 겹쳐도 가장 안쪽 영역만 메뉴를 연다', () => {
    const outer = vi.fn(() => 'outer');
    render(
      <ContextMenuArea resolveTarget={outer} items={() => [{ label: '바깥 메뉴' }]}>
        <ContextMenuArea resolveTarget={() => 'inner'} items={() => [{ label: '안쪽 메뉴' }]}>
          <span>중첩 항목</span>
        </ContextMenuArea>
      </ContextMenuArea>,
    );
    fireEvent.contextMenu(screen.getByText('중첩 항목'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: '안쪽 메뉴' })).toBeTruthy();
    expect(outer).not.toHaveBeenCalled();
  });

  it('대상이 있어도 빈 메뉴는 열지 않고 브라우저 기본 메뉴도 막는다', () => {
    render(
      <ContextMenuArea
        resolveTarget={() => true}
        items={() => [{ label: '빈 메뉴', children: [] }]}
      >
        <span>빈 항목</span>
      </ContextMenuArea>,
    );
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(screen.getByText('빈 항목'), event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('비활성 하위 메뉴에도 실행할 수 없는 사유를 표시한다', () => {
    render(
      <ContextMenuArea
        resolveTarget={() => true}
        items={() => [
          {
            label: '쓰기',
            children: [{ label: '삭제' }],
            disabled: true,
            disabledReason: '작업 중입니다',
          },
        ]}
      >
        <span>항목</span>
      </ContextMenuArea>,
    );
    fireEvent.contextMenu(screen.getByText('항목'));
    const menu = screen.getByRole('menuitem', { name: /쓰기/ });
    expect(menu.getAttribute('aria-disabled')).toBe('true');
    expect(menu.title).toBe('작업 중입니다');
  });
});
