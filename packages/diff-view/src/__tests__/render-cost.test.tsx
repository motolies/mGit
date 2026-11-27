// 반응성 E-3: diff 화면이 같은 내용을 다시 그리지 않는다 — 키 입력·다음 변경으로 화면이 움직여도 보이는 줄은 다시 만들지 않고,
// 덩어리가 그대로면 탐색 등록(도구 모음의 "n / 전체")을 새로 하지 않으며, 이미 불러온 언어는 문서가 그려지는 그 렌더에서 바로
// 강조한다 (J 부터 커서 줄이 없다)
import type { FileDiff, Hunk } from '@mgit/ipc';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DiffNavigation, DiffView } from '../DiffView';
import { useHighlight } from '../use-highlight';

const h = vi.hoisted(() => ({ pieces: 0 }));

// 줄 하나를 그릴 때마다 한 번 부르는 조각 합치기를 센다 (줄 컴포넌트가 다시 그려진 수)
vi.mock('../word-diff', async (orig) => {
  const mod = await orig<typeof import('../word-diff')>();
  return {
    ...mod,
    applyRanges: (...args: Parameters<typeof mod.applyRanges>) => {
      h.pieces += 1;
      return mod.applyRanges(...args);
    },
  };
});

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

afterEach(cleanup);

/** 문맥 줄 `n` 개 사이에 바뀐 줄 하나가 있는 hunk */
function hunk(start: number, n: number): Hunk {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push({
      kind: 'context',
      text: `line ${start + i}`,
      oldNo: start + i,
      newNo: start + i,
      noNewline: false,
    });
  }
  lines.push({
    kind: 'del',
    text: `old ${start}`,
    oldNo: start + n,
    newNo: null,
    noNewline: false,
  });
  lines.push({
    kind: 'add',
    text: `new ${start}`,
    oldNo: null,
    newNo: start + n,
    noNewline: false,
  });
  return {
    oldStart: start,
    oldLines: n + 1,
    newStart: start,
    newLines: n + 1,
    section: '',
    lines,
  } as unknown as Hunk;
}

/** 구간 셋짜리 diff */
function diff(): FileDiff {
  return {
    oldPath: 'a.txt',
    newPath: 'a.txt',
    change: { kind: 'modified' },
    binary: null,
    hunks: [hunk(1, 8), hunk(40, 8), hunk(80, 8)],
    truncated: false,
    totalLines: 30,
    nonUtf8: false,
  } as unknown as FileDiff;
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('diff 화면의 다시 그리기 (E-3)', () => {
  it('키 입력과 다음 변경 이동에도 보이는 줄은 다시 만들지 않는다', async () => {
    const ready = vi.fn((_el: HTMLElement, _nav: DiffNavigation) => () => {});
    render(
      <DiffView
        diff={diff()}
        path="a.txt"
        mode="split"
        fullFile={false}
        initialHeight={600}
        onNavigationReady={ready}
      />,
    );
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    expect(h.pieces).toBeGreaterThan(0);
    h.pieces = 0;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    act(() => {
      ready.mock.lastCall?.[1].moveHunk(1);
    });
    await flush();
    // 커서 줄 표시가 없고, 줄 내용도 다시 만들지 않는다 (옮겨 가기는 스크롤뿐)
    expect(grid.querySelector('[data-cursor]')).toBeNull();
    expect(h.pieces).toBe(0);
  });

  it('키 입력은 탐색을 새로 등록하지 않고, 덩어리가 바뀌면 새로 등록한다', async () => {
    const ready = vi.fn((_el: HTMLElement, _nav: DiffNavigation) => () => {});
    render(
      <DiffView
        diff={diff()}
        path="a.txt"
        mode="unified"
        fullFile={false}
        initialHeight={600}
        onNavigationReady={ready}
      />,
    );
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    const before = ready.mock.calls.length;
    expect(ready.mock.lastCall?.[1].current).toBe(1);
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await flush();
    expect(ready.mock.calls.length).toBe(before);
    act(() => {
      ready.mock.lastCall?.[1].moveHunk(1);
    });
    await flush();
    expect(ready.mock.calls.length).toBeGreaterThan(before);
    expect(ready.mock.lastCall?.[1].current).toBe(2);
  });
});

describe('바로 강조 (E-3)', () => {
  it('이미 불러온 언어의 새 문서는 그 렌더에서 바로 강조한다 (강조 없는 글자를 먼저 그리지 않는다)', async () => {
    const one = (path: string, text: string): FileDiff =>
      ({
        oldPath: path,
        newPath: path,
        change: { kind: 'modified' },
        binary: null,
        nonUtf8: false,
        truncated: false,
        totalLines: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            section: '',
            lines: [{ kind: 'add', text, oldNo: null, newNo: 1, noNewline: false }],
          },
        ],
      }) as unknown as FileDiff;
    const view = renderHook(({ value, path }) => useHighlight(value, path), {
      initialProps: { value: one('first.ts', 'const a = 1;'), path: 'first.ts' },
    });
    // 처음 보는 언어는 불러온 뒤에 강조한다
    await waitFor(() => expect(view.result.current.size).toBeGreaterThan(0));
    view.rerender({ value: one('second.ts', 'let b = "x";'), path: 'second.ts' });
    expect(
      view.result.current
        .get(0)
        ?.get(0)
        ?.some((span) => span.cls !== ''),
    ).toBe(true);
  });
});
