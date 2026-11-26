import { EditorView } from '@codemirror/view';
import type { ConflictDoc } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { blocksOf } from '../editor';
import { MergeEditor } from '../MergeEditor';

const DOC: ConflictDoc = {
  eol: 'lf',
  trailingNewline: true,
  blocks: [
    { kind: 'clean', lines: ['a'] },
    {
      kind: 'conflict',
      ours: ['O'],
      base: ['B'],
      theirs: ['T'],
      labels: ['main', 'base', 'other'],
    },
    { kind: 'clean', lines: ['z'] },
  ],
};
const LABELS = { ours: 'main', base: 'base', theirs: 'other' };

beforeAll(() => {
  // jsdom 에 없는 레이아웃 API. CodeMirror 측정이 부른다
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(cleanup);

/** 결과 편집기 뷰 (DOM 순서상 마지막) */
function resultView(container: HTMLElement): EditorView {
  const list = container.querySelectorAll<HTMLElement>('.cm-content');
  const view = EditorView.findFromDOM(list[list.length - 1] as HTMLElement);
  if (!view) {
    throw new Error('편집기 없음');
  }
  return view;
}

/** 미해결 블록을 ours 로 고른다 */
function pickOurs(view: EditorView): void {
  const btn = view.dom.querySelector<HTMLElement>('.cm-mg-pick-btn[data-kind="ours"]');
  fireEvent.click(btn as HTMLElement);
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('MergeEditor 저장', () => {
  it('저장이 실패해도 편집기를 다시 만들지 않고 편집 내용을 남긴다', async () => {
    const onSave = vi.fn(async () => false);
    const { container } = render(
      <MergeEditor path="a.txt" doc={DOC} labels={LABELS} onSave={onSave} />,
    );
    const before = resultView(container);
    act(() => pickOurs(before));
    const edited = before.state.doc.toString();
    expect(edited).toBe('a\nO\nz');
    fireEvent.click(screen.getByText(S.conflict.saveDirty));
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    const after = resultView(container);
    expect(after).toBe(before);
    expect(after.state.doc.toString()).toBe(edited);
    expect(screen.getByText(S.conflict.saveDirty)).toBeTruthy();
  });

  it('저장 중에도 편집기가 그대로다', async () => {
    let done: (ok: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => (done = resolve)));
    const { container } = render(
      <MergeEditor path="a.txt" doc={DOC} labels={LABELS} onSave={onSave} />,
    );
    const before = resultView(container);
    act(() => pickOurs(before));
    fireEvent.click(screen.getByText(S.conflict.saveDirty));
    await flush();
    expect(resultView(container)).toBe(before);
    done(false);
    await flush();
    expect(resultView(container)).toBe(before);
  });

  it('마커가 남아 있으면 막되 "그래도 저장" 으로 넘길 수 있다', async () => {
    const onSave = vi.fn(async () => true);
    render(<MergeEditor path="a.txt" doc={DOC} labels={LABELS} onSave={onSave} />);
    fireEvent.click(screen.getByText(S.conflict.save));
    await flush();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(S.conflict.saveAnyway));
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]).toEqual([
      expect.stringContaining('<<<<<<<'),
      { allowConflictMarkers: true },
    ]);
  });
});

describe('MergeEditor 블록 버튼 줄', () => {
  it('고정 문구는 UI 문구 사전에서 넘긴 것이다 (편집기는 사전을 모른다)', () => {
    const { container } = render(
      <MergeEditor
        path="a.txt"
        doc={DOC}
        labels={LABELS}
        onSave={async () => false}
        onLinePick={() => {}}
      />,
    );
    const view = resultView(container);
    const text = (kind: string) =>
      view.dom.querySelector(`.cm-mg-pick-btn[data-kind="${kind}"]`)?.textContent;
    expect(text('bothOursFirst')).toBe(S.conflict.pickBoth);
    expect(text('bothTheirsFirst')).toBe(S.conflict.pickBothReversed);
    expect(text('linePick')).toBe(S.assist.linePick);
    act(() => pickOurs(view));
    expect(text('unresolved')).toBe(S.conflict.pickUndo);
  });
});

describe('MergeEditor 초안', () => {
  it('편집할 때마다 초안을 알리고, 초안으로 다시 열면 블록 상태까지 복원한다', async () => {
    const onDraftChange = vi.fn();
    const first = render(
      <MergeEditor
        path="a.txt"
        doc={DOC}
        labels={LABELS}
        onSave={async () => false}
        onDraftChange={onDraftChange}
      />,
    );
    act(() => pickOurs(resultView(first.container)));
    await flush();
    const draft = onDraftChange.mock.calls.at(-1)?.[0];
    expect(draft.text).toBe('a\nO\nz');
    expect(draft.ranges).toEqual([{ index: 0, from: 2, to: 3, kind: 'ours' }]);
    first.unmount();

    const second = render(
      <MergeEditor
        path="a.txt"
        doc={DOC}
        labels={LABELS}
        onSave={async () => false}
        initialDraft={draft}
      />,
    );
    const view = resultView(second.container);
    expect(view.state.doc.toString()).toBe('a\nO\nz');
    expect(blocksOf(view.state)).toEqual(draft.ranges);
    expect(screen.getByText(S.conflict.draftRestored)).toBeTruthy();
  });

  it('문서 객체가 새로 와도 진행 중인 초안을 잃지 않는다', async () => {
    const draft = { text: 'a\nMINE\nz', ranges: [] };
    const view = (doc: ConflictDoc) => (
      <MergeEditor
        path="a.txt"
        doc={doc}
        labels={LABELS}
        onSave={async () => false}
        initialDraft={draft}
      />
    );
    const { container, rerender } = render(view(DOC));
    rerender(view({ ...DOC }));
    await flush();
    expect(resultView(container).state.doc.toString()).toBe('a\nMINE\nz');
  });
});

it('배율 변경은 모든 열을 재측정하고 편집 내용과 실행 취소 기록을 보존한다', () => {
  const onSave = vi.fn(async () => true);
  const { container, rerender } = render(
    <MergeEditor path="a.txt" doc={DOC} labels={LABELS} onSave={onSave} />,
  );
  const before = resultView(container);
  act(() => pickOurs(before));
  const state = before.state;
  const measure = vi.spyOn(before, 'requestMeasure');
  rerender(<MergeEditor path="a.txt" doc={DOC} labels={LABELS} onSave={onSave} fontSize={24} />);
  expect(resultView(container)).toBe(before);
  expect(before.state).toBe(state);
  expect(before.state.doc.toString()).toBe('a\nO\nz');
  expect(measure).toHaveBeenCalled();
  expect(
    (container.firstElementChild as HTMLElement).style.getPropertyValue('--merge-font-size'),
  ).toBe('24px');
});
