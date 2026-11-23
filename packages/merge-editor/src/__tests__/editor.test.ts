import { redo, undo } from '@codemirror/commands';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { ConflictDoc } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { blocksOf, createMergeState, pickSpec, remainingCount } from '../editor';

const DOC: ConflictDoc = {
  eol: 'lf',
  trailingNewline: true,
  blocks: [
    { kind: 'clean', lines: ['a'] },
    {
      kind: 'conflict',
      ours: ['O'],
      base: ['B'],
      theirs: ['T1', 'T2'],
      labels: ['main', 'base', 'other'],
    },
    { kind: 'clean', lines: ['c'] },
    { kind: 'conflict', ours: [], base: [], theirs: ['X'], labels: ['main', 'base', 'other'] },
  ],
};
const LABELS = { ours: 'main', base: 'base', theirs: 'other' };
const CFG = {
  doc: DOC,
  labels: LABELS,
  pickLabels: {
    both: 'both',
    bothReversed: 'both reversed',
    unresolved: 'undo',
    linePick: 'lines',
  },
};

/** 상태에 트랜잭션을 적용한 새 상태 */
function apply(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state;
}

/** undo/redo 를 뷰 없이 돌린다 */
function run(state: EditorState, cmd: typeof undo): EditorState {
  let next = state;
  cmd({ state, dispatch: (tr) => (next = tr.state) });
  return next;
}

describe('merge editor state', () => {
  it('블록 선택이 텍스트와 범위를 바꾸고, undo 한 번에 되돌아간다 (PoC-3)', () => {
    let state = createMergeState(CFG);
    expect(remainingCount(state)).toBe(2);
    const spec = pickSpec(state, DOC, 0, 'theirs');
    expect(spec).not.toBeNull();
    state = apply(state, spec ?? {});
    expect(state.doc.toString()).toBe(
      'a\nT1\nT2\nc\n<<<<<<< main\n||||||| base\n=======\nX\n>>>>>>> other',
    );
    expect(remainingCount(state)).toBe(1);
    const b0 = blocksOf(state).find((b) => b.index === 0);
    expect(b0 && state.doc.sliceString(b0.from, b0.to)).toBe('T1\nT2');

    state = run(state, undo);
    expect(remainingCount(state)).toBe(2);
    expect(state.doc.toString().startsWith('a\n<<<<<<< main\nO\n')).toBe(true);
    state = run(state, redo);
    expect(remainingCount(state)).toBe(1);
    expect(blocksOf(state).find((b) => b.index === 0)?.kind).toBe('theirs');
  });

  it('빈 쪽을 고르면 줄바꿈까지 정리되고, 다시 채우면 복원된다', () => {
    let state = createMergeState(CFG);
    state = apply(state, pickSpec(state, DOC, 1, 'ours') ?? {});
    expect(state.doc.toString()).toBe(
      'a\n<<<<<<< main\nO\n||||||| base\nB\n=======\nT1\nT2\n>>>>>>> other\nc',
    );
    const b1 = blocksOf(state).find((b) => b.index === 1);
    expect(b1).toMatchObject({ kind: 'ours', from: state.doc.length, to: state.doc.length });
    state = apply(state, pickSpec(state, DOC, 1, 'theirs') ?? {});
    expect(state.doc.toString().endsWith('c\nX')).toBe(true);
    expect(blocksOf(state).find((b) => b.index === 1)?.kind).toBe('theirs');
  });

  it('블록 앞에 글을 넣어도 범위가 따라오고, 블록 안을 고치면 custom 이 된다', () => {
    let state = createMergeState(CFG);
    state = apply(state, pickSpec(state, DOC, 0, 'ours') ?? {});
    const before = blocksOf(state).find((b) => b.index === 0);
    expect(before && state.doc.sliceString(before.from, before.to)).toBe('O');
    state = apply(state, { changes: { from: 0, insert: 'NEW\n' } });
    const after = blocksOf(state).find((b) => b.index === 0);
    expect(after && state.doc.sliceString(after.from, after.to)).toBe('O');
    expect(after?.kind).toBe('ours');
    state = apply(state, { changes: { from: after?.from ?? 0, insert: 'edited ' } });
    const edited = blocksOf(state).find((b) => b.index === 0);
    expect(edited?.kind).toBe('custom');
    expect(edited && state.doc.sliceString(edited.from, edited.to)).toBe('edited O');
    expect(remainingCount(state)).toBe(1);
  });

  it('두 블록에 걸친 선택을 지워도 예외 없이 적용되고 두 블록 모두 직접 편집이 된다', () => {
    let state = createMergeState(CFG);
    const text = state.doc.toString();
    const from = text.indexOf('O');
    const to = text.lastIndexOf('X');
    state = apply(state, { changes: { from, to, insert: 'MINE' } });
    expect(state.doc.toString()).toContain('MINE');
    expect(blocksOf(state).map((b) => b.kind)).toEqual(['custom', 'custom']);
  });

  it('문서 전체를 바꿔도 예외가 나지 않는다', () => {
    let state = createMergeState(CFG);
    state = apply(state, { changes: { from: 0, to: state.doc.length, insert: 'all new' } });
    expect(state.doc.toString()).toBe('all new');
  });

  it('이어서 편집 모드는 블록 추적 없이 텍스트만 든다', () => {
    const state = createMergeState(CFG, 'hand\nedited');
    expect(state.doc.toString()).toBe('hand\nedited');
    expect(blocksOf(state)).toEqual([]);
  });
});
