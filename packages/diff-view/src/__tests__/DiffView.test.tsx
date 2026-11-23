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

/** 삭제 줄을 클릭해 고른다 */
function pickDeletedLine(): void {
  const row = document.querySelector('[role="row"][data-kind="del"]');
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
