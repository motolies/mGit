import type { FileDiff, Hunk } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DiffActions, DiffView } from '../DiffView';

/** 변경 줄 하나짜리 hunk */
function hunk(tag: string): Hunk {
  return {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    section: null,
    lines: [
      { kind: 'del', text: `old-${tag}`, oldNo: 1, newNo: null, noNewline: false },
      { kind: 'add', text: `new-${tag}`, oldNo: null, newNo: 1, noNewline: false },
    ],
  } as unknown as Hunk;
}

/** 파일 diff 하나 */
function diff(tag: string, nonUtf8 = false): FileDiff {
  return {
    oldPath: `${tag}.txt`,
    newPath: `${tag}.txt`,
    change: 'modified',
    binary: null,
    hunks: [hunk(tag)],
    truncated: false,
    totalLines: 2,
    nonUtf8,
  } as unknown as FileDiff;
}

/** 동작 스파이 */
function actions(over: Partial<DiffActions> = {}): DiffActions {
  return {
    verb: 'stage',
    onApplyHunk: vi.fn(),
    onApplyLines: vi.fn(),
    onDiscardHunk: vi.fn(),
    onDiscardLines: vi.fn(),
    ...over,
  };
}

beforeAll(() => {
  // 가상 스크롤이 뷰포트 크기를 읽는다
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

afterEach(cleanup);

/** 삭제 줄의 거터 체크박스를 클릭해 고른다 */
function pickDeletedLine(): void {
  const row = document.querySelector('[role="row"][data-kind="del"] input');
  fireEvent.click(row as Element);
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const selectedCount = () => document.querySelectorAll('[role="row"][data-selected="true"]').length;

describe('DiffView 줄 선택', () => {
  it('다른 파일로 바뀌면 선택을 버린다', async () => {
    const a = actions();
    const view = (tag: string) => (
      <DiffView diff={diff(tag)} path={`${tag}.txt`} mode="unified" actions={a} />
    );
    const { rerender } = render(view('a'));
    await flush();
    pickDeletedLine();
    expect(screen.getByText(S.diff.discardSelected(1))).toBeTruthy();
    rerender(view('b'));
    await flush();
    expect(selectedCount()).toBe(0);
    expect(screen.queryByText(S.diff.discardSelected(1))).toBeNull();
  });

  it('같은 파일이어도 내용이 바뀌면 선택을 버린다', async () => {
    const a = actions();
    const view = (tag: string) => (
      <DiffView diff={diff(tag)} path="f.txt" mode="unified" actions={a} />
    );
    const { rerender } = render(view('a'));
    await flush();
    pickDeletedLine();
    rerender(view('b'));
    await flush();
    expect(selectedCount()).toBe(0);
  });

  it('내용이 같은 diff 로 다시 읽히면 선택을 유지한다', async () => {
    const a = actions();
    const view = () => <DiffView diff={diff('a')} path="f.txt" mode="unified" actions={a} />;
    const { rerender } = render(view());
    await flush();
    pickDeletedLine();
    rerender(view());
    await flush();
    expect(selectedCount()).toBe(1);
  });

  it('되돌리기를 취소하면(false) 선택을 남긴다', async () => {
    const a = actions({ onDiscardLines: vi.fn(async () => false) });
    render(<DiffView diff={diff('a')} path="f.txt" mode="unified" actions={a} />);
    await flush();
    pickDeletedLine();
    fireEvent.click(screen.getByText(S.diff.discardSelected(1)));
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledTimes(1);
    expect(selectedCount()).toBe(1);
  });
});

describe('DiffView 비 UTF-8', () => {
  it('줄·hunk 동작을 숨기고 이유를 보여 준다', async () => {
    render(<DiffView diff={diff('a', true)} path="f.txt" mode="unified" actions={actions()} />);
    await flush();
    expect(screen.queryByText(S.diff.discardHunk)).toBeNull();
    expect(screen.queryByText(S.diff.applyHunk(S.diff.stage))).toBeNull();
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(screen.getByText(S.diff.nonUtf8)).toBeTruthy();
  });
});

describe('DiffView 키보드 본문', () => {
  it('본문 진입점 하나에서 방향키·Space·Shift 범위 선택을 제공한다', async () => {
    const a = actions();
    render(<DiffView diff={diff('a')} path="a.txt" mode="unified" actions={a} />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    expect(grid.tabIndex).toBe(0);
    expect(
      [...grid.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(
        (el) => el.tabIndex === 0,
      ),
    ).toHaveLength(0);
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(selectedCount()).toBe(0);
    fireEvent.keyDown(grid, { key: ' ' });
    expect(selectedCount()).toBe(1);
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    expect(selectedCount()).toBe(2);
    expect(a.onApplyHunk).not.toHaveBeenCalled();
    expect(a.onApplyLines).not.toHaveBeenCalled();
  });

  it('구간 이동은 끝에서 멈추고 선택·stage 없이 이동한다', async () => {
    const a = actions();
    let navigation: import('../DiffView').DiffNavigation | undefined;
    const release = vi.fn();
    const ready = (_el: HTMLElement, controller: import('../DiffView').DiffNavigation) => {
      navigation = controller;
      return release;
    };
    const value = { ...diff('a'), hunks: [hunk('a'), hunk('b'), hunk('c')] } as FileDiff;
    const { unmount } = render(
      <DiffView diff={value} path="a.txt" mode="unified" actions={a} onNavigationReady={ready} />,
    );
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    const cursor = () =>
      document
        .getElementById(grid.getAttribute('aria-activedescendant') ?? '')
        ?.getAttribute('data-index');
    act(() => navigation?.moveHunk(1));
    expect(cursor()).toBe('3');
    act(() => navigation?.moveHunk(1));
    expect(cursor()).toBe('6');
    act(() => navigation?.moveHunk(1));
    expect(cursor()).toBe('6');
    act(() => navigation?.moveHunk(-1));
    expect(cursor()).toBe('3');
    expect(document.activeElement).toBe(grid);
    expect(selectedCount()).toBe(0);
    expect(a.onApplyHunk).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalled();
  });

  it('split 좌우 선택과 IME 보호를 제공한다', async () => {
    render(<DiffView diff={diff('a')} path="a.txt" mode="split" actions={actions()} />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(document.querySelector('[data-kind="add"][data-selected="true"]')).not.toBeNull();
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.keyDown(grid, { key: ' ', isComposing: true });
    expect(selectedCount()).toBe(1);
    fireEvent.keyDown(grid, { key: ' ' });
    expect(selectedCount()).toBe(2);
  });
});

describe('IDE 비교 화면 안전성', () => {
  it('코드 드래그·클릭은 부분 작업 선택을 바꾸지 않고 거터만 선택한다', async () => {
    render(<DiffView diff={diff('a')} path="a.txt" mode="split" actions={actions()} />);
    await flush();
    fireEvent.click(document.querySelector('[data-kind="del"]') as Element);
    expect(selectedCount()).toBe(0);
    pickDeletedLine();
    expect(selectedCount()).toBe(1);
  });

  it('재조회 중 동작을 숨기고 같은 내용으로 완료되어도 이전 선택을 복원하지 않는다', async () => {
    const value = diff('a');
    const a = actions();
    const view = (loading: boolean) => (
      <DiffView diff={value} path="a.txt" mode="split" actions={a} loading={loading} />
    );
    const { rerender } = render(view(false));
    await flush();
    pickDeletedLine();
    expect(selectedCount()).toBe(1);
    rerender(view(true));
    expect(screen.queryByText(S.diff.applyHunk(S.diff.stage))).toBeNull();
    expect(screen.queryByText(S.diff.applySelected(S.diff.stage, 1))).toBeNull();
    rerender(view(false));
    await flush();
    expect(selectedCount()).toBe(0);
  });

  it('보기 옵션 변경은 이전 선택을 무효화하고 잘린 패치의 부분 쓰기를 막는다', async () => {
    const value = diff('a');
    const { rerender } = render(
      <DiffView diff={value} path="a.txt" mode="split" actions={actions()} />,
    );
    await flush();
    pickDeletedLine();
    rerender(<DiffView diff={value} path="a.txt" mode="split" actions={actions()} wrap />);
    await flush();
    expect(selectedCount()).toBe(0);
    rerender(
      <DiffView
        diff={{ ...value, truncated: true }}
        path="a.txt"
        mode="split"
        actions={actions()}
      />,
    );
    await flush();
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(screen.queryByText(S.diff.applyHunk(S.diff.stage))).toBeNull();
  });
});

describe('공백만 달라 패치가 없는 문서', () => {
  it('변경 주변 모드에서도 양쪽 원문을 유지한다', async () => {
    const value = { ...diff('a'), hunks: [], totalLines: 0 };
    render(
      <DiffView
        diff={value}
        document={{
          diff: value,
          revision: 'raw',
          limitReason: null,
          old: { path: 'a.txt', label: 'Index', content: ' old\n', lineCount: 1 },
          new: { path: 'a.txt', label: 'Working tree', content: '\told\n', lineCount: 1 },
        }}
        path="a.txt"
        mode="split"
        fullFile={false}
      />,
    );
    await flush();
    expect(
      [...document.querySelectorAll('[data-side]')].map((element) => element.textContent),
    ).toEqual([' old', '\told']);
  });
});

describe('원문 복사 이벤트', () => {
  it('여러 줄을 드래그해 복사하면 선택한 패널의 코드만 클립보드에 넣는다', async () => {
    const value = {
      ...diff('a'),
      hunks: [
        {
          ...hunk('a'),
          oldStart: 2,
          newStart: 2,
          lines: hunk('a').lines.map((line) => ({
            ...line,
            oldNo: line.oldNo ? 2 : null,
            newNo: line.newNo ? 2 : null,
          })),
        },
      ],
    };
    render(
      <DiffView
        diff={value}
        document={{
          diff: value,
          revision: 'copy',
          limitReason: null,
          old: { path: 'a.txt', label: 'Index', content: 'keep\nold-a\nafter\n', lineCount: 3 },
          new: {
            path: 'a.txt',
            label: 'Working tree',
            content: 'keep\nnew-a\nafter\n',
            lineCount: 3,
          },
        }}
        path="a.txt"
        mode="split"
        actions={actions()}
      />,
    );
    await flush();
    const lines = document.querySelectorAll('[data-side="left"]');
    const start = document
      .createTreeWalker(lines[0] as Node, NodeFilter.SHOW_TEXT)
      .nextNode() as Node;
    const end = document
      .createTreeWalker(lines[2] as Node, NodeFilter.SHOW_TEXT)
      .nextNode() as Node;
    const range = document.createRange();
    range.setStart(start, 2);
    range.setEnd(end, 3);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const setData = vi.fn();
    fireEvent.copy(screen.getByTestId('diff-scroller'), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', 'ep\nold-a\naft');
    expect(selectedCount()).toBe(0);
    selection?.removeAllRanges();
  });
});
