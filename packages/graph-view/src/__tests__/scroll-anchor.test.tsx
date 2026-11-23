import { GraphRangeCache, type GraphSource, MockGraphSource } from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRAPH_COLUMNS } from '../GraphRow';
import { type GraphScrollAnchor, GraphView } from '../GraphView';

const ROWS = 10_000;
const ROW_H = 24;
const RECT = { width: 800, height: 480 };

/** 지연 없는 목 출처와 캐시. `repoOf` 를 주면 행에 저장소 번호를 싣는다 (통합 타임라인 흉내) */
function setup(repoOf?: (row: number) => number) {
  const mock = new MockGraphSource({ rows: ROWS, latencyMs: 0 });
  const source: GraphSource = repoOf
    ? {
        fetchWindow: async (start, count) => {
          const w = await mock.fetchWindow(start, count);
          return { ...w, rows: w.rows.map((r) => ({ ...r, repo: repoOf(r.row) })) };
        },
      }
    : mock;
  const cache = new GraphRangeCache(source);
  cache.setTotalRows(ROWS, true);
  return { mock, cache };
}

/** 다음 매크로태스크까지 기다린다 (fetchWindow 의 Promise 해소) */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** 지금 DOM 에 있는 그래프 행 번호들 */
function renderedRows(container: HTMLElement): number[] {
  return [...container.querySelectorAll('[data-row]')].map((el) =>
    Number(el.getAttribute('data-row')),
  );
}

// jsdom 은 레이아웃이 없다: 요소의 scrollTo 가 없고 scrollHeight·clientHeight 는 0 이다.
// 뷰가 스크롤 위치를 어디로 쓰는지만 기록하고, 스크롤할 수 있는 범위(가상 스크롤이 목표 위치를 이 범위로
// 자른다)는 실제 크기를 흉내 낸다
const scrollTo = vi.fn();
const SIZES = { scrollHeight: (ROWS + 1) * ROW_H, clientHeight: RECT.height };

beforeEach(() => {
  scrollTo.mockClear();
  HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
  for (const [name, value] of Object.entries(SIZES)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});

afterEach(() => {
  cleanup();
  for (const name of ['scrollTo', ...Object.keys(SIZES)]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

/** 마지막으로 쓴 스크롤 위치 (px) */
const lastScrollTop = () => (scrollTo.mock.lastCall?.[0] as { top: number } | undefined)?.top;

describe('스크롤 기준 알리기 (LG-10)', () => {
  it('행이 읽히면 맨 위 커밋을 기준으로 알린다', async () => {
    const { mock, cache } = setup();
    const onAnchorChange = vi.fn();
    render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        onAnchorChange={onAnchorChange}
      />,
    );
    // 아직 행을 못 읽었으면 알릴 기준이 없다
    expect(onAnchorChange).not.toHaveBeenCalled();
    await flush();
    await flush();
    expect(onAnchorChange).toHaveBeenLastCalledWith({
      oid: mock.graph.rows[0]?.oid,
      repo: null,
      row: 0,
      offset: 0,
    });
  });
});

describe('기억해 둔 기준에서 시작하기 (재마운트)', () => {
  it('맨 위가 아니라 기준 행의 자리에서 그리기 시작한다', async () => {
    const { mock, cache } = setup();
    const anchor: GraphScrollAnchor = {
      oid: mock.graph.rows[400]?.oid ?? '',
      repo: null,
      row: 400,
      offset: 6,
    };
    const onAnchorChange = vi.fn();
    const { container } = render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        initialAnchor={anchor}
        onAnchorChange={onAnchorChange}
      />,
    );
    // 첫 렌더부터 기준 행 둘레만 DOM 에 있다 (맨 위 행을 그렸다 옮기지 않는다)
    expect(renderedRows(container)).toContain(400);
    expect(renderedRows(container)).not.toContain(0);
    // DOM 의 스크롤 위치도 그 자리로 쓴다: 행 400 의 위쪽 + 넘어가 있던 6px
    expect(lastScrollTop()).toBe(400 * ROW_H + 6);

    await flush();
    await flush();
    // 다시 알리는 기준도 같은 커밋·같은 오프셋이다 (기억이 맨 위로 덮이지 않는다)
    expect(onAnchorChange).toHaveBeenLastCalledWith(anchor);
  });

  it('WIP 행이 있으면 그만큼 아래에서 시작한다', () => {
    const { mock, cache } = setup();
    render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        wipRow={{ staged: 1, unstaged: 0, untracked: 0, conflicted: 0 }}
        initialAnchor={{ oid: mock.graph.rows[400]?.oid ?? '', repo: null, row: 400, offset: 0 }}
      />,
    );
    expect(lastScrollTop()).toBe(401 * ROW_H);
  });

  it('뷰가 없던 사이 데이터가 다시 읽혀 행 번호가 달라졌으면 새 행으로 옮긴다', async () => {
    const { mock, cache } = setup();
    const oid = mock.graph.rows[400]?.oid ?? '';
    const resolveRow = vi.fn(async () => 520);
    render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        initialAnchor={{ oid, repo: null, row: 400, offset: 6 }}
        resolveRow={resolveRow}
      />,
    );
    await flush();
    expect(resolveRow).toHaveBeenCalledWith(oid, null);
    expect(lastScrollTop()).toBe(520 * ROW_H + 6);
  });

  it('행 번호가 그대로면 다시 옮기지 않는다', async () => {
    const { mock, cache } = setup();
    const resolveRow = vi.fn(async () => 400);
    render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        initialAnchor={{ oid: mock.graph.rows[400]?.oid ?? '', repo: null, row: 400, offset: 6 }}
        resolveRow={resolveRow}
      />,
    );
    const writes = scrollTo.mock.calls.length;
    await flush();
    await flush();
    expect(resolveRow).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls.length).toBe(writes);
  });

  it('기준 커밋이 사라졌으면(null) 기억한 자리에 그대로 둔다', async () => {
    const { mock, cache } = setup();
    const resolveRow = vi.fn(async () => null);
    render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        initialAnchor={{ oid: mock.graph.rows[400]?.oid ?? '', repo: null, row: 400, offset: 0 }}
        resolveRow={resolveRow}
      />,
    );
    await flush();
    expect(resolveRow).toHaveBeenCalledTimes(1);
    expect(lastScrollTop()).toBe(400 * ROW_H);
  });
});

describe('재로드 뒤 보던 커밋으로 돌아가기 (LG-10)', () => {
  it('세대가 바뀌면 맨 위 커밋의 새 행을 저장소 번호와 함께 물어 그 자리로 간다', async () => {
    // 통합 타임라인: 같은 커밋이 저장소마다 한 행씩 있을 수 있어 저장소 번호가 있어야 찾는다
    const { mock, cache } = setup((row) => (row % 3) + 1);
    const resolveRow = vi.fn(async () => 37);
    render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        columns={{ ...DEFAULT_GRAPH_COLUMNS, repo: true }}
        repoOf={(row) => ({ name: `repo-${row.repo}`, color: row.repo ?? 0 })}
        resolveRow={resolveRow}
      />,
    );
    await flush();
    await flush();
    expect(resolveRow).not.toHaveBeenCalled();

    act(() => cache.invalidateAll());
    await flush();
    expect(resolveRow).toHaveBeenCalledTimes(1);
    expect(resolveRow).toHaveBeenCalledWith(mock.graph.rows[0]?.oid, 1);
    expect(lastScrollTop()).toBe(37 * ROW_H);
  });

  it('resolveRow 가 없으면 재로드에 아무것도 하지 않는다', async () => {
    const { cache } = setup();
    render(<GraphView cache={cache} totalRows={ROWS} rowHeight={ROW_H} initialRect={RECT} />);
    await flush();
    await flush();
    const writes = scrollTo.mock.calls.length;
    act(() => cache.invalidateAll());
    await flush();
    expect(scrollTo.mock.calls.length).toBe(writes);
  });
});

describe('저장소 띠의 이름 (LG-02)', () => {
  it('구간의 첫 행에만 이름 글자가 있고, 이어지는 행은 띠만 있다', async () => {
    // 저장소가 4행씩 이어진다: 0~3 → 1번, 4~7 → 2번, …
    const { cache } = setup((row) => Math.floor(row / 4) + 1);
    const { container } = render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        columns={{ ...DEFAULT_GRAPH_COLUMNS, repo: true }}
        repoOf={(row) => ({ name: `repo-${row.repo}`, color: (row.repo ?? 0) % 10 })}
      />,
    );
    await flush();
    await flush();
    /** 행의 띠 칸 (첫 칸) 의 글자 */
    const stripText = (row: number) =>
      container.querySelector(`[data-row="${row}"]`)?.firstElementChild?.textContent;
    expect([0, 1, 2, 3, 4, 5, 8].map(stripText)).toEqual([
      'repo-1',
      '',
      '',
      '',
      'repo-2',
      '',
      'repo-3',
    ]);
  });

  it('구간 중간으로 스크롤해 있으면 화면 맨 위 행에도 이름을 쓴다', async () => {
    const { mock, cache } = setup((row) => Math.floor(row / 40) + 1);
    const { container } = render(
      <GraphView
        cache={cache}
        totalRows={ROWS}
        rowHeight={ROW_H}
        initialRect={RECT}
        columns={{ ...DEFAULT_GRAPH_COLUMNS, repo: true }}
        repoOf={(row) => ({ name: `repo-${row.repo}`, color: (row.repo ?? 0) % 10 })}
        initialAnchor={{ oid: mock.graph.rows[410]?.oid ?? '', repo: 11, row: 410, offset: 0 }}
      />,
    );
    await flush();
    await flush();
    const stripText = (row: number) =>
      container.querySelector(`[data-row="${row}"]`)?.firstElementChild?.textContent;
    // 행 400~439 가 한 구간(11번). 맨 위에 보이는 410 에 이름이 있고 그 아래는 없다
    expect([410, 411, 412].map(stripText)).toEqual(['repo-11', '', '']);
  });
});
