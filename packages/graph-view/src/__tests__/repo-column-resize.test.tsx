import { GraphRangeCache, MockGraphSource } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_GRAPH_COLUMNS,
  graphColumnLeft,
  gridTemplate,
  repoColumnWidth,
  subjectColumnWidth,
} from '../GraphRow';
import { GraphView } from '../GraphView';

vi.mock('../paint', () => ({ paint: vi.fn() }));
afterEach(cleanup);

it('사용자 폭은 행 grid·캔버스 위치·제목 예산에 동일하게 반영된다', () => {
  const columns = { ...DEFAULT_GRAPH_COLUMNS, repo: true, repoWidth: 280 };
  expect(gridTemplate(columns).startsWith('280px ')).toBe(true);
  expect(graphColumnLeft(columns)).toBe(288);
  const narrow = subjectColumnWidth({ ...columns, repoWidth: 180 }, 100, 1200);
  expect(subjectColumnWidth(columns, 100, 1200)).toBe(narrow - 100);
  expect(repoColumnWidth({ ...columns, repoWidth: Number.NaN })).toBe(100);
  expect(repoColumnWidth({ ...columns, repoWidth: 9999 })).toBe(600);
});

/** 저장소 열 조절 값을 유지하는 그래프 화면이다. */
function Fixture({ cache, selected }: { cache: GraphRangeCache; selected: () => void }) {
  const [width, setWidth] = useState(180);
  return (
    <GraphView
      cache={cache}
      totalRows={20}
      initialRect={{ width: 1000, height: 240 }}
      columns={{ ...DEFAULT_GRAPH_COLUMNS, repo: true, repoWidth: width }}
      onRepoWidthChange={setWidth}
      onSelectRow={selected}
    />
  );
}

it('저장소 경계 방향키는 열을 늘리며 커밋 선택·스크롤 위치를 바꾸지 않는다', async () => {
  const source = new MockGraphSource({ rows: 20, latencyMs: 0 });
  const cache = new GraphRangeCache(source);
  cache.setTotalRows(20, true);
  const selected = vi.fn();
  const { container } = render(<Fixture cache={cache} selected={selected} />);
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const separator = screen.getByRole('separator', { name: S.folder.columns.name });
  const scroller = screen.getByTestId('graph-scroller');
  scroller.scrollTop = 80;
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  expect(separator.getAttribute('aria-valuenow')).toBe('190');
  expect(container.querySelector('canvas')?.style.left).toBe('198px');
  expect(scroller.scrollTop).toBe(80);
  fireEvent.keyDown(separator, { key: 'Enter' });
  expect(selected).not.toHaveBeenCalled();
  cache.dispose();
});

it('좁은 창에서는 표시 폭만 줄여 조절 경계를 남기고 저장 폭은 바꾸지 않는다', () => {
  const cache = new GraphRangeCache(new MockGraphSource({ rows: 0, latencyMs: 0 }));
  cache.setTotalRows(0, true);
  const resize = vi.fn();
  render(
    <GraphView
      cache={cache}
      totalRows={0}
      initialRect={{ width: 400, height: 240 }}
      columns={{ ...DEFAULT_GRAPH_COLUMNS, repo: true, repoWidth: 600 }}
      onRepoWidthChange={resize}
    />,
  );
  const separator = screen.getByRole('separator', { name: S.folder.columns.name });
  const shown = Number(separator.getAttribute('aria-valuenow'));
  expect(shown).toBeGreaterThanOrEqual(80);
  expect(shown).toBeLessThan(180);
  expect(Number.parseFloat(separator.style.left)).toBeLessThan(400);
  expect(resize).not.toHaveBeenCalled();
  cache.dispose();
});
