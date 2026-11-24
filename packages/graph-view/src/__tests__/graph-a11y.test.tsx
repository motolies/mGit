import { GraphRangeCache, type GraphRow, MockGraphSource } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GraphView } from '../GraphView';

// 커밋 로그의 보조 기술 구조와 키보드 (W19 ③): 표(grid) 하나, 행 단위 이동, 캔버스는 장식

/** 지연 없는 목 출처와 캐시 */
function setup(rows: number) {
  const source = new MockGraphSource({ rows, latencyMs: 0 });
  const cache = new GraphRangeCache(source);
  cache.setTotalRows(rows, true);
  return { source, cache };
}

/** 다음 매크로태스크까지 기다린다 (fetchWindow 의 Promise 해소) */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** 고른 행을 바깥이 쥐는 뷰 (FolderTimeline 처럼 제어형) */
function Controlled({
  cache,
  total,
  onSelect,
}: {
  cache: GraphRangeCache;
  total: number;
  onSelect: (row: GraphRow) => void;
}) {
  const [oid, setOid] = useState<string | null>(null);
  return (
    <GraphView
      cache={cache}
      totalRows={total}
      rowHeight={24}
      initialRect={{ width: 800, height: 240 }}
      selectedOid={oid}
      onSelectRow={(row) => {
        setOid(row.oid);
        onSelect(row);
      }}
    />
  );
}

describe('커밋 로그의 ARIA (grid)', () => {
  it('뷰가 이름 있는 grid 이고 전체 행 수를 알린다. 행은 row·aria-rowindex, 칸은 gridcell, 캔버스는 숨긴다', async () => {
    const { cache } = setup(50);
    const { container } = render(
      <GraphView cache={cache} totalRows={50} initialRect={{ width: 800, height: 240 }} />,
    );
    await flush();
    await flush();
    const grid = container.querySelector('[role="grid"]');
    expect(grid?.getAttribute('aria-label')).toBe(S.graph.label);
    expect(grid?.getAttribute('aria-rowcount')).toBe('50');
    expect(grid?.getAttribute('tabindex')).toBe('0');
    const first = container.querySelector('[data-row="0"]');
    expect(first?.getAttribute('role')).toBe('row');
    expect(first?.getAttribute('aria-rowindex')).toBe('1');
    expect(first?.getAttribute('aria-selected')).toBe('false');
    expect(first?.querySelectorAll('[role="gridcell"]').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('커밋 로그의 키보드', () => {
  it('↓ 로 고른 행을 activedescendant 로 알리고, End·Home·PageDown 으로 끝·처음·한 화면씩 옮긴다', async () => {
    const { cache } = setup(200);
    const onSelect = vi.fn();
    const { container } = render(<Controlled cache={cache} total={200} onSelect={onSelect} />);
    await flush();
    await flush();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(0);
    const active = grid.getAttribute('aria-activedescendant');
    expect(
      active && container.querySelector(`#${CSS.escape(active)}`)?.getAttribute('data-row'),
    ).toBe('0');

    fireEvent.keyDown(grid, { key: 'End' });
    await flush();
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(199);

    fireEvent.keyDown(grid, { key: 'Home' });
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(0);

    // 240px / 24px = 10행 화면 → 한 화면은 9행
    fireEvent.keyDown(grid, { key: 'PageDown' });
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(9);
    fireEvent.keyDown(grid, { key: 'PageUp' });
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(0);
  });

  it('⌘↓는 미로드된 마지막 행을 읽어 선택하고 ⌘↑는 Home과 같은 첫 행을 선택한다', async () => {
    const { cache } = setup(2000);
    const onSelect = vi.fn();
    const { container } = render(<Controlled cache={cache} total={2000} onSelect={onSelect} />);
    await flush();
    await flush();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(0);
    expect(cache.slice(1999, 2000).rows[0]).toBeUndefined();
    expect(fireEvent.keyDown(grid, { key: 'ArrowDown', metaKey: true })).toBe(false);
    await flush();
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(1999);
    expect(fireEvent.keyDown(grid, { key: 'ArrowUp', metaKey: true })).toBe(false);
    await flush();
    expect(onSelect.mock.calls.at(-1)?.[0].row).toBe(0);
  });

  it('빈 목록의 ⌘↑·⌘↓는 선택하지 않는다', async () => {
    const { cache } = setup(0);
    const onSelect = vi.fn();
    const { container } = render(<Controlled cache={cache} total={0} onSelect={onSelect} />);
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    fireEvent.keyDown(grid, { key: 'ArrowUp', metaKey: true });
    fireEvent.keyDown(grid, { key: 'ArrowDown', metaKey: true });
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('입력란과 편집 중인 요소의 ⌘↑·⌘↓는 가로채지 않는다', async () => {
    const { cache } = setup(30);
    const onSelect = vi.fn();
    const { container } = render(<Controlled cache={cache} total={30} onSelect={onSelect} />);
    await flush();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    grid.append(input, editor);
    for (const target of [input, editor]) {
      expect(fireEvent.keyDown(target, { key: 'ArrowUp', metaKey: true })).toBe(true);
      expect(fireEvent.keyDown(target, { key: 'ArrowDown', metaKey: true })).toBe(true);
    }
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
    input.remove();
    editor.remove();
  });

  it('⇧F10·메뉴 키는 고른 행에 contextmenu 를 보낸다 (바깥의 메뉴 영역이 연다)', async () => {
    const { cache } = setup(30);
    const { container } = render(<Controlled cache={cache} total={30} onSelect={() => {}} />);
    await flush();
    await flush();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await flush();
    const opened = vi.fn();
    container.addEventListener('contextmenu', (e) => opened((e.target as HTMLElement).dataset.row));
    fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
    fireEvent.keyDown(grid, { key: 'ContextMenu' });
    expect(opened.mock.calls).toEqual([['0'], ['0']]);
  });

  it('⌘↑·⌘↓ 이외의 수정키 조합은 뷰가 가로채지 않는다 (앱 단축키)', async () => {
    const { cache } = setup(30);
    const onSelect = vi.fn();
    const { container } = render(<Controlled cache={cache} total={30} onSelect={onSelect} />);
    await flush();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    fireEvent.keyDown(grid, { key: 'ArrowDown', metaKey: true, shiftKey: true });
    fireEvent.keyDown(grid, { key: 'ArrowUp', metaKey: true, altKey: true });
    fireEvent.keyDown(grid, { key: 'End', ctrlKey: true });
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
