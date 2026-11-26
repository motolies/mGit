import type { FileDiff, Hunk } from '@mgit/ipc';
import { isMac, S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DiffActions, DiffView } from '../DiffView';

/** 기존 행 단위 계약을 명시적으로 선택한 상태에서 검증한다. */
function renderLines(ui: ReactElement) {
  const result = render(ui);
  const unit = screen.queryByRole('combobox', { name: S.diff.selectionUnit });
  if (unit) fireEvent.change(unit, { target: { value: 'line' } });
  return result;
}

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
    onApplyHunk: vi.fn(async () => true),
    onApplyLines: vi.fn(async () => true),
    onDiscardHunk: vi.fn(async () => true),
    onDiscardLines: vi.fn(async () => true),
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
  const row = document.querySelector('input[type="checkbox"]');
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
    const { rerender } = renderLines(view('a'));
    await flush();
    pickDeletedLine();
    expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
    rerender(view('b'));
    await flush();
    expect(selectedCount()).toBe(0);
    expect(screen.getByText(S.diff.selectedChanges(0))).toBeTruthy();
  });

  it('같은 파일이어도 내용이 바뀌면 선택을 버린다', async () => {
    const a = actions();
    const view = (tag: string) => (
      <DiffView diff={diff(tag)} path="f.txt" mode="unified" actions={a} />
    );
    const { rerender } = renderLines(view('a'));
    await flush();
    pickDeletedLine();
    rerender(view('b'));
    await flush();
    expect(selectedCount()).toBe(0);
  });

  it('내용이 같은 diff 로 다시 읽히면 선택을 유지한다', async () => {
    const a = actions();
    const view = () => <DiffView diff={diff('a')} path="f.txt" mode="unified" actions={a} />;
    const { rerender } = renderLines(view());
    await flush();
    pickDeletedLine();
    rerender(view());
    await flush();
    expect(selectedCount()).toBe(2);
  });

  it('되돌리기를 취소하면(false) 선택을 남긴다', async () => {
    const a = actions({ onDiscardLines: vi.fn(async () => false) });
    renderLines(<DiffView diff={diff('a')} path="f.txt" mode="unified" actions={a} />);
    await flush();
    pickDeletedLine();
    fireEvent.click(screen.getByText(S.diff.discardSelectedChanges));
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledTimes(1);
    expect(selectedCount()).toBe(2);
  });
});

describe('DiffView 비 UTF-8', () => {
  it('줄·hunk 동작을 숨기고 이유를 보여 준다', async () => {
    renderLines(
      <DiffView diff={diff('a', true)} path="f.txt" mode="unified" actions={actions()} />,
    );
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
    renderLines(<DiffView diff={diff('a')} path="a.txt" mode="unified" actions={a} />);
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
    expect(selectedCount()).toBe(2);
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
    const { unmount } = renderLines(
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

  it('변경 내부에서도 이전은 논리적 이전 변경이며 첫 변경에서는 경계를 반환한다', async () => {
    let navigation: import('../DiffView').DiffNavigation | undefined;
    const ready = (_element: HTMLElement, value: import('../DiffView').DiffNavigation) => {
      navigation = value;
      return () => {};
    };
    renderLines(
      <DiffView
        diff={{ ...diff('a'), hunks: [hunk('a'), hunk('b')] }}
        path="a.txt"
        mode="unified"
        onNavigationReady={ready}
      />,
    );
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(navigation?.current).toBe(1);
    expect(navigation?.canMove(-1)).toBe(false);
    let moved: boolean | undefined;
    act(() => {
      moved = navigation?.moveHunk(-1);
    });
    expect(moved).toBe(false);
    act(() => navigation?.moveHunk(1));
    expect(navigation?.current).toBe(2);
  });

  it('마지막 변경 도착은 한 번만 포커스하고 이후 내용 갱신은 입력 포커스를 빼앗지 않는다', async () => {
    const arrival = { token: 999, edge: 'last' as const, focus: true };
    let navigation: import('../DiffView').DiffNavigation | undefined;
    const ready = (_element: HTMLElement, value: import('../DiffView').DiffNavigation) => {
      navigation = value;
      return () => {};
    };
    const view = (tag: string, mode: 'split' | 'unified') => (
      <>
        <input aria-label="keep-focus" />
        <DiffView
          diff={{ ...diff('a'), hunks: [hunk(tag), hunk('b'), hunk('c')] }}
          path="a.txt"
          mode={mode}
          arrival={arrival}
          onNavigationReady={ready}
        />
      </>
    );
    const { rerender } = renderLines(view('a', 'unified'));
    await flush();
    expect(navigation?.current).toBe(3);
    expect(document.activeElement).toBe(screen.getByTestId('diff-scroller'));
    const input = screen.getByRole('textbox', { name: 'keep-focus' });
    input.focus();
    rerender(view('changed', 'split'));
    await flush();
    expect(document.activeElement).toBe(input);
    expect(navigation?.current).toBe(3);
  });

  it('split 좌우 선택과 IME 보호를 제공한다', async () => {
    renderLines(<DiffView diff={diff('a')} path="a.txt" mode="split" actions={actions()} />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(document.querySelector('[data-kind="add"][data-selected="true"]')).not.toBeNull();
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.keyDown(grid, { key: ' ', isComposing: true });
    expect(selectedCount()).toBe(2);
    fireEvent.keyDown(grid, { key: ' ' });
    expect(selectedCount()).toBe(0);
  });
});

describe('IDE 비교 화면 안전성', () => {
  it('코드 드래그·클릭은 부분 작업 선택을 바꾸지 않고 거터만 선택한다', async () => {
    renderLines(<DiffView diff={diff('a')} path="a.txt" mode="split" actions={actions()} />);
    await flush();
    fireEvent.click(document.querySelector('[data-kind="del"]') as Element);
    expect(selectedCount()).toBe(0);
    pickDeletedLine();
    expect(selectedCount()).toBe(2);
  });

  it('재조회 중 컨트롤을 비활성화하고 같은 내용이면 선택을 유지한다', async () => {
    const value = diff('a');
    const a = actions();
    const view = (loading: boolean) => (
      <DiffView diff={value} path="a.txt" mode="split" actions={a} loading={loading} />
    );
    const { rerender } = renderLines(view(false));
    await flush();
    pickDeletedLine();
    expect(selectedCount()).toBe(2);
    rerender(view(true));
    expect((screen.getByText(S.diff.applyHunk(S.diff.stage)) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByText(S.diff.stageSelectedChanges) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(selectedCount()).toBe(2);
    rerender(view(false));
    await flush();
    expect(selectedCount()).toBe(2);
  });

  it('보기 옵션 변경은 선택을 유지하고 잘린 패치의 부분 쓰기를 막는다', async () => {
    const value = diff('a');
    const { rerender } = renderLines(
      <DiffView diff={value} path="a.txt" mode="split" actions={actions()} />,
    );
    await flush();
    pickDeletedLine();
    rerender(<DiffView diff={value} path="a.txt" mode="split" actions={actions()} wrap />);
    await flush();
    expect(selectedCount()).toBe(2);
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
    renderLines(
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
    renderLines(
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

/** 줄 수가 다른 교체와 순수 추가·삭제, 여러 구간을 함께 만든다. */
function mixedDiff(): FileDiff {
  const line = (kind: 'add' | 'del', text: string, no: number) => ({
    kind,
    text,
    oldNo: kind === 'del' ? no : null,
    newNo: kind === 'add' ? no : null,
    noNewline: false,
  });
  return {
    ...diff('mixed'),
    hunks: [
      {
        ...hunk('a'),
        oldLines: 3,
        newLines: 2,
        lines: [
          line('del', '확인', 1),
          line('del', 'old-b', 2),
          line('del', 'only-old', 3),
          line('add', '확인 안함', 1),
          line('add', 'new-b', 2),
        ],
      },
      {
        ...hunk('b'),
        oldStart: 10,
        newStart: 10,
        oldLines: 0,
        newLines: 1,
        lines: [line('add', 'only-new', 10)],
      },
    ],
  };
}

describe('작업 트리 변경 행 동작', () => {
  it('선택 전에도 실행 도구 모음을 유지하며 좌우 중앙 오른쪽에 한 세트만 둔다', async () => {
    renderLines(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={actions()} />);
    await flush();
    for (const label of [
      S.diff.discardSelectedChanges,
      S.diff.stageSelectedChanges,
      S.diff.clearSelection,
    ]) {
      expect((screen.getByText(label) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: S.diff.restoreChange })).toHaveLength(4);
    expect(document.querySelectorAll('[data-kind="del"] input')).toHaveLength(0);
    expect(document.querySelectorAll('[data-kind="empty"] input')).toHaveLength(1);
  });

  it('화살표는 체크 선택과 무관하게 해당 수정 쌍만 전달한다', async () => {
    const a = actions({ onDiscardLines: vi.fn(async () => false) });
    renderLines(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />);
    await flush();
    fireEvent.click(screen.getAllByRole('checkbox')[1] as Element);
    fireEvent.click(screen.getAllByRole('button', { name: S.diff.restoreChange })[0] as Element);
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledWith([{ hunk: 0, lines: [0, 3] }]);
    expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
    fireEvent.click(screen.getByText(S.diff.discardSelectedChanges));
    await flush();
    expect(a.onDiscardLines).toHaveBeenLastCalledWith([{ hunk: 0, lines: [1, 4] }]);
  });

  it('Shift는 같은 구간의 수정 행 순서를 따라 선택하고 다른 구간은 독립적으로 더한다', async () => {
    const a = actions();
    renderLines(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />);
    await flush();
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[0] as Element);
    fireEvent.click(checks[2] as Element, { shiftKey: true });
    fireEvent.click(checks[3] as Element, { shiftKey: true });
    expect(screen.getByText(S.diff.selectedChanges(4))).toBeTruthy();
    fireEvent.click(screen.getByText(S.diff.stageSelectedChanges));
    await flush();
    expect(a.onApplyLines).toHaveBeenCalledWith([
      { hunk: 0, lines: [0, 1, 2, 3, 4] },
      { hunk: 1, lines: [0] },
    ]);
    expect(screen.getByText(S.diff.selectedChanges(0))).toBeTruthy();
  });

  it('통합 보기에서도 첫 줄에만 컨트롤을 두고 쌍의 두 줄을 함께 선택한다', async () => {
    const a = actions();
    const { rerender } = renderLines(
      <DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />,
    );
    await flush();
    fireEvent.click(screen.getAllByRole('checkbox')[0] as Element);
    rerender(
      <DiffView diff={mixedDiff()} path="f.txt" mode="unified" actions={a} fullFile={false} />,
    );
    await flush();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(selectedCount()).toBe(2);
    expect(document.querySelector('[data-kind="add"][data-selected="true"] input')).toBeNull();
    expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
  });

  it('Enter는 빈 오른쪽 삭제 행도 복원 대상으로 전달한다', async () => {
    const a = actions();
    renderLines(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    for (let i = 0; i < 3; i++) fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledWith([{ hunk: 0, lines: [2] }]);
  });

  it('진행 중 컨트롤을 유지하고 중복 클릭을 막으며 실패 시 선택을 보존한다', async () => {
    let resolve: (ok: boolean) => void = () => {};
    const a = actions({
      onApplyLines: vi.fn(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      ),
    });
    renderLines(<DiffView diff={diff('a')} path="f.txt" mode="split" actions={a} />);
    await flush();
    fireEvent.click(screen.getByRole('checkbox'));
    const apply = screen.getByText(S.diff.stageSelectedChanges) as HTMLButtonElement;
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(a.onApplyLines).toHaveBeenCalledTimes(1);
    expect(apply.disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: S.diff.restoreChange }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => resolve(false));
    expect(apply.disabled).toBe(false);
    expect(selectedCount()).toBe(2);
  });

  it('거부된 비동기 실행에도 선택을 남기고 다시 실행할 수 있다', async () => {
    const a = actions({
      onApplyLines: vi.fn(async () => {
        throw new Error('failed');
      }),
    });
    renderLines(<DiffView diff={diff('a')} path="f.txt" mode="split" actions={a} />);
    await flush();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText(S.diff.stageSelectedChanges));
    await flush();
    expect(selectedCount()).toBe(2);
    expect((screen.getByText(S.diff.stageSelectedChanges) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('구간 전체 실행에는 다른 구간 체크 선택을 섞지 않는다', async () => {
    const a = actions({ onDiscardHunk: vi.fn(async () => false) });
    renderLines(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />);
    await flush();
    fireEvent.click(screen.getAllByRole('checkbox')[3] as Element);
    fireEvent.click(screen.getAllByText(S.diff.discardHunk)[0] as Element);
    await flush();
    expect(a.onDiscardHunk).toHaveBeenCalledWith(0);
    expect(a.onDiscardLines).not.toHaveBeenCalled();
    expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
  });

  it('staged 화면은 삭제·추가 개별 패치 선택을 유지한다', async () => {
    const a = actions({ verb: 'unstage', onDiscardLines: undefined, onDiscardHunk: undefined });
    renderLines(<DiffView diff={diff('a')} path="f.txt" mode="split" actions={a} />);
    await flush();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: S.diff.restoreChange })).toBeNull();
    fireEvent.click(screen.getAllByRole('checkbox')[0] as Element);
    expect(selectedCount()).toBe(1);
    fireEvent.click(screen.getByText(S.diff.applySelected(S.diff.unstage, 1)));
    await flush();
    expect(a.onApplyLines).toHaveBeenCalledWith([{ hunk: 0, lines: [0] }]);
  });
});

/** 같은 구간 안에 문맥으로 떨어진 두 변경 블록을 만든다. */
function separatedBlocks(): FileDiff {
  const sample = mixedDiff();
  const first = sample.hunks[0];
  if (!first) throw new Error('missing fixture');
  return {
    ...sample,
    hunks: [
      {
        ...first,
        lines: [
          ...first.lines,
          { kind: 'context', text: 'unchanged', oldNo: 4, newNo: 3, noNewline: false },
          { kind: 'add', text: 'separate addition', oldNo: null, newNo: 4, noNewline: false },
          { kind: 'add', text: '', oldNo: null, newNo: 5, noNewline: false },
        ],
      },
    ],
  };
}

describe('기본 변경 블록 선택', () => {
  it.each(['split', 'unified'] as const)(
    '%s에서 연속 변경 묶음에 컨트롤을 하나만 두고 블록만 되돌린다',
    async (mode) => {
      const a = actions({ onDiscardLines: vi.fn(async () => false) });
      render(<DiffView diff={separatedBlocks()} path="f.txt" mode={mode} actions={a} />);
      await flush();
      expect(
        (screen.getByRole('combobox', { name: S.diff.selectionUnit }) as HTMLSelectElement).value,
      ).toBe('block');
      const checks = screen.getAllByRole('checkbox', { name: S.diff.selectBlock });
      expect(checks).toHaveLength(2);
      fireEvent.click(checks[1] as Element);
      expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: S.diff.restoreBlock })[0] as Element);
      await flush();
      expect(a.onDiscardLines).toHaveBeenCalledWith([{ hunk: 0, lines: [0, 1, 2, 3, 4] }]);
      fireEvent.click(screen.getByText(S.diff.discardSelectedChanges));
      await flush();
      expect(a.onDiscardLines).toHaveBeenLastCalledWith([{ hunk: 0, lines: [6, 7] }]);
      expect(a.onDiscardHunk).not.toHaveBeenCalled();
    },
  );

  it('블록 선택은 모든 변경 행을 표시하고 Shift로 같은 구간의 여러 블록을 고른다', async () => {
    const a = actions();
    render(<DiffView diff={separatedBlocks()} path="f.txt" mode="unified" actions={a} />);
    await flush();
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[0] as Element);
    expect(selectedCount()).toBe(5);
    fireEvent.click(checks[1] as Element, { shiftKey: true });
    expect(screen.getByText(S.diff.selectedChanges(2))).toBeTruthy();
    fireEvent.click(screen.getByText(S.diff.stageSelectedChanges));
    await flush();
    expect(a.onApplyLines).toHaveBeenCalledWith([{ hunk: 0, lines: [0, 1, 2, 3, 4, 6, 7] }]);
  });

  it('블록 내부 행에서도 Space와 Enter는 블록 전체를 대상으로 한다', async () => {
    const a = actions({ onDiscardLines: vi.fn(async () => false) });
    render(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
    fireEvent.keyDown(grid, { key: 'Enter' });
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledWith([{ hunk: 0, lines: [0, 1, 2, 3, 4] }]);
  });

  it('행 단위 전환 시 선택을 초기화하고 이전의 수정 쌍 선택을 사용할 수 있다', async () => {
    const a = actions();
    render(<DiffView diff={mixedDiff()} path="f.txt" mode="split" actions={a} />);
    await flush();
    fireEvent.click(screen.getAllByRole('checkbox')[0] as Element);
    fireEvent.change(screen.getByRole('combobox', { name: S.diff.selectionUnit }), {
      target: { value: 'line' },
    });
    expect(screen.getByText(S.diff.selectedChanges(0))).toBeTruthy();
    expect(screen.getAllByRole('checkbox', { name: S.diff.selectLine })).toHaveLength(4);
    fireEvent.click(screen.getAllByRole('button', { name: S.diff.restoreChange })[0] as Element);
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledWith([{ hunk: 0, lines: [0, 3] }]);
  });

  it.each(['add', 'del'] as const)('연속된 %s 24행과 빈 행을 한 번에 처리한다', async (kind) => {
    const sample = diff('a');
    sample.hunks[0] = {
      ...hunk('a'),
      oldLines: kind === 'del' ? 24 : 0,
      newLines: kind === 'add' ? 24 : 0,
      lines: Array.from({ length: 24 }, (_, i) => ({
        kind,
        text: i % 2 ? `line ${i}` : '',
        oldNo: kind === 'del' ? i + 1 : null,
        newNo: kind === 'add' ? i + 1 : null,
        noNewline: false,
      })),
    };
    const a = actions();
    const { rerender } = render(<DiffView diff={sample} path="f.txt" mode="split" actions={a} />);
    await flush();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: S.diff.restoreBlock })).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<DiffView diff={sample} path="f.txt" mode="unified" fullFile={false} actions={a} />);
    await flush();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText(S.diff.selectedChanges(1))).toBeTruthy();
    fireEvent.click(screen.getByText(S.diff.discardSelectedChanges));
    await flush();
    expect(a.onDiscardLines).toHaveBeenCalledWith([
      { hunk: 0, lines: Array.from({ length: 24 }, (_, i) => i) },
    ]);
  });

  it('staged와 읽기 전용 화면에는 블록 선택 모드를 추가하지 않는다', async () => {
    const { rerender } = render(
      <DiffView
        diff={mixedDiff()}
        path="f.txt"
        mode="split"
        actions={actions({ verb: 'unstage', onDiscardLines: undefined })}
      />,
    );
    await flush();
    expect(screen.queryByRole('combobox', { name: S.diff.selectionUnit })).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    rerender(<DiffView diff={mixedDiff()} path="f.txt" mode="split" />);
    await flush();
    expect(screen.queryByRole('combobox', { name: S.diff.selectionUnit })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

/** 비동기로 원문이 도착한 뒤에도 본문 휠이 가로 스크롤바에 연결되어야 한다. */
it('늦게 로드된 삭제 파일의 긴 줄을 휠로 이동하고 sync off에서는 반대쪽을 유지한다', async () => {
  const value = {
    ...diff('long'),
    newPath: null,
    change: { kind: 'deleted' },
    hunks: [
      {
        ...hunk('long'),
        newLines: 0,
        lines: [{ kind: 'del', oldNo: 1, newNo: null, text: 'x'.repeat(400), noNewline: false }],
      },
    ],
  } as FileDiff;
  const { rerender } = render(
    <DiffView diff={null} loading path="long.txt" mode="split" horizontalSync={false} />,
  );
  rerender(<DiffView diff={value} path="long.txt" mode="split" horizontalSync={false} />);
  await flush();
  const left = screen.getByRole('region', { name: S.diff.oldHorizontalScroll });
  const right = screen.getByRole('region', { name: S.diff.newHorizontalScroll });
  const code = document.querySelector('[data-side="left"]');
  if (!code) throw new Error('Missing left side');
  fireEvent.wheel(code, { deltaX: 120 });
  expect(left.scrollLeft).toBe(120);
  expect(right.scrollLeft).toBe(0);
  const gutter = document.querySelector('[data-scroll-side="left"]');
  if (!gutter) throw new Error('Missing gutter');
  fireEvent.wheel(gutter, { deltaY: 2, deltaMode: 1, shiftKey: true });
  expect(left.scrollLeft).toBe(160);
  fireEvent.scroll(left);
  expect(
    screen
      .getByTestId('diff-scroller')
      .closest('[style*="--diff-left-scroll"]')
      ?.getAttribute('style'),
  ).toContain('160px');
});

it('동기화할 반대 패널의 실제 스크롤 한계를 넘겨 코드를 밀지 않는다', async () => {
  render(<DiffView diff={diff('a')} path="a.txt" mode="split" />);
  await flush();
  const left = screen.getByRole('region', { name: S.diff.oldHorizontalScroll });
  const right = screen.getByRole('region', { name: S.diff.newHorizontalScroll });
  let clamped = 0;
  Object.defineProperty(right, 'scrollLeft', {
    configurable: true,
    get: () => clamped,
    set: (value: number) => {
      clamped = Math.min(30, value);
    },
  });
  left.scrollLeft = 120;
  fireEvent.scroll(left);
  expect(right.scrollLeft).toBe(30);
  expect(right.closest('[style*="--diff-split"]')?.getAttribute('style')).toContain(
    '--diff-right-scroll: 30px',
  );
});

it('좌우·통합 전환 뒤 스크롤바와 코드 오프셋을 같은 시작점으로 맞춘다', async () => {
  const value = diff('a');
  const { rerender } = render(<DiffView diff={value} path="a.txt" mode="split" />);
  await flush();
  const left = screen.getByRole('region', { name: S.diff.oldHorizontalScroll });
  left.scrollLeft = 120;
  fireEvent.scroll(left);
  rerender(<DiffView diff={value} path="a.txt" mode="unified" />);
  await flush();
  const unified = screen.getByRole('region', { name: S.diff.newHorizontalScroll });
  expect(unified.scrollLeft).toBe(0);
  expect(unified.closest('[style*="--diff-split"]')?.getAttribute('style')).toContain(
    '--diff-left-scroll: 0px',
  );
  rerender(<DiffView diff={value} path="a.txt" mode="split" />);
  await flush();
  expect(screen.getByRole('region', { name: S.diff.oldHorizontalScroll }).scrollLeft).toBe(0);
});

it('배율 변경은 코드 크기와 행 높이를 함께 갱신하며 본문을 유지한다', () => {
  const value = diff('zoom');
  const { container, rerender } = render(<DiffView diff={value} path="zoom.txt" mode="split" />);
  const root = container.firstElementChild as HTMLElement;
  const scroller = container.querySelector('[data-wrap]');
  expect(root.style.getPropertyValue('--diff-font-size')).toBe('12px');
  rerender(<DiffView diff={value} path="zoom.txt" mode="split" fontSize={24} />);
  expect(container.querySelector('[data-wrap]')).toBe(scroller);
  expect(root.style.getPropertyValue('--diff-font-size')).toBe('24px');
  expect(root.style.getPropertyValue('--diff-line-height')).toBe('40px');
});

it('같은 본문의 자동 갱신은 스크롤을 재배치하지 않고 새 도착 요청만 이동한다', async () => {
  const value = diff('a');
  const spy = vi.fn();
  try {
    const view = render(<DiffView diff={value} path="a.txt" mode="split" />);
    await flush();
    const grid = screen.getByRole('grid');
    grid.scrollTo = spy;
    grid.focus();
    spy.mockClear();
    view.rerender(<DiffView diff={value} path="a.txt" mode="split" loading />);
    await flush();
    view.rerender(
      <DiffView diff={structuredClone(value)} path="a.txt" mode="split" loading={false} />,
    );
    await flush();
    expect(screen.getByRole('grid')).toBe(grid);
    expect(document.activeElement).toBe(grid);
    expect(spy).not.toHaveBeenCalled();
    view.rerender(
      <DiffView
        diff={value}
        path="a.txt"
        mode="split"
        arrival={{ token: 999, edge: 'first', focus: true }}
      />,
    );
    await flush();
    expect(spy).toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

/** 전체 선택 키는 운영체제의 기본 수정키를 사용한다. */
function selectAllCode(target: Element) {
  return fireEvent.keyDown(target, { key: 'a', metaKey: isMac(), ctrlKey: !isMac() });
}
/** 네이티브 클립보드에 전달할 본문을 읽는다. */
function copiedCode(target: Element) {
  const setData = vi.fn();
  fireEvent.copy(target, { clipboardData: { setData } });
  return setData;
}

describe('Diff 본문 전체 선택', () => {
  it.each(['left', 'right'] as const)(
    '%s 코드를 클릭한 뒤 전체 선택해도 바깥 그래프·반대쪽·번호는 복사하지 않는다',
    async (side) => {
      render(
        <>
          <DiffView diff={diff('a')} path="a.txt" mode="split" actions={actions()} />
          <div>OUTSIDE GRAPH</div>
        </>,
      );
      await flush();
      const code = document.querySelector(`[data-side="${side}"]`);
      if (!code) throw new Error('No code');
      fireEvent.pointerDown(code);
      const grid = screen.getByTestId('diff-scroller');
      grid.focus();
      expect(selectAllCode(grid)).toBe(false);
      expect(grid.getAttribute('data-text-selected')).toBe(side);
      expect(
        window.getSelection()?.anchorNode &&
          grid.contains(window.getSelection()?.anchorNode ?? null),
      ).toBeTruthy();
      expect(copiedCode(grid)).toHaveBeenCalledWith(
        'text/plain',
        side === 'left' ? 'old-a' : 'new-a',
      );
      expect(selectedCount()).toBe(0);
    },
  );
  it('키보드로 고른 쪽과 통합 보기의 표시 코드 전체를 복사한다', async () => {
    const view = render(<DiffView diff={diff('a')} path="a.txt" mode="split" />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    selectAllCode(grid);
    expect(copiedCode(grid)).toHaveBeenCalledWith('text/plain', 'old-a');
    view.rerender(<DiffView diff={diff('a')} path="a.txt" mode="unified" />);
    expect(grid.hasAttribute('data-text-selected')).toBe(false);
    selectAllCode(grid);
    expect(copiedCode(grid)).toHaveBeenCalledWith('text/plain', 'old-a\nnew-a');
  });
  it('전체 파일은 화면 밖 원문과 마지막 개행까지 복사하고 변경 주변 보기는 표시 범위만 복사한다', async () => {
    const value = diff('a');
    const oldText = `${Array.from({ length: 300 }, (_, i) => `old-${i}`).join('\n')}\n`;
    const newText = `${Array.from({ length: 300 }, (_, i) => `new-${i}`).join('\n')}\n`;
    const documentValue = {
      diff: value,
      revision: 'all',
      limitReason: null,
      old: { path: 'a.txt', label: 'Old', content: oldText, lineCount: 300 },
      new: { path: 'a.txt', label: 'New', content: newText, lineCount: 300 },
    };
    const view = render(
      <DiffView diff={value} document={documentValue} path="a.txt" mode="split" fullFile />,
    );
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    expect(document.querySelectorAll('[data-side="right"]').length).toBeLessThan(300);
    selectAllCode(grid);
    expect(copiedCode(grid)).toHaveBeenCalledWith('text/plain', newText);
    view.rerender(
      <DiffView diff={value} document={documentValue} path="a.txt" mode="split" fullFile={false} />,
    );
    selectAllCode(grid);
    const setData = copiedCode(grid);
    expect(setData.mock.calls[0]?.[1]).not.toContain('new-299');
  });
  it('Esc·방향키·포인터·파일 전환은 전체 선택을 해제한다', async () => {
    const view = render(<DiffView diff={diff('a')} path="a.txt" mode="split" />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    for (const key of ['Escape', 'ArrowDown', 'F7']) {
      selectAllCode(grid);
      expect(grid.hasAttribute('data-text-selected')).toBe(true);
      fireEvent.keyDown(grid, { key });
      expect(grid.hasAttribute('data-text-selected')).toBe(false);
    }
    selectAllCode(grid);
    fireEvent.pointerDown(grid, { button: 2 });
    expect(grid.hasAttribute('data-text-selected')).toBe(true);
    fireEvent.pointerDown(grid);
    expect(grid.hasAttribute('data-text-selected')).toBe(false);
    selectAllCode(grid);
    view.rerender(<DiffView diff={diff('b')} path="b.txt" mode="split" />);
    expect(grid.hasAttribute('data-text-selected')).toBe(false);
    view.rerender(<DiffView diff={diff('a')} path="a.txt" mode="split" />);
    expect(grid.hasAttribute('data-text-selected')).toBe(false);
  });
  it('본문 안 컨트롤·IME·다른 수정키는 전체 선택 명령으로 처리하지 않는다', async () => {
    render(<DiffView diff={diff('a')} path="a.txt" mode="split" actions={actions()} />);
    await flush();
    const grid = screen.getByTestId('diff-scroller');
    const button = grid.querySelector('button');
    if (!button) throw new Error('No control');
    expect(selectAllCode(button)).toBe(true);
    fireEvent.keyDown(grid, { key: 'a', metaKey: isMac(), ctrlKey: !isMac(), isComposing: true });
    fireEvent.keyDown(grid, { key: 'a', metaKey: isMac(), ctrlKey: !isMac(), altKey: true });
    expect(grid.hasAttribute('data-text-selected')).toBe(false);
  });
});
