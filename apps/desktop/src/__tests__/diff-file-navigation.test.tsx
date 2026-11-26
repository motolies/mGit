import type { FileDiff } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffPaneView } from '../features/diff/DiffPaneView';
import { nearestDiffFile, orderedDiffFiles } from '../store/diff-origin';
import { DEFAULT_DIFF_OPTIONS } from '../store/session-store';
import { commitDiffDoc, createWorkspaceStore } from '../store/workspace-store';

const diff: FileDiff = {
  oldPath: 'a.txt',
  newPath: 'a.txt',
  change: { kind: 'modified' },
  binary: null,
  nonUtf8: false,
  truncated: false,
  totalLines: 2,
  hunks: [
    {
      section: '',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        { kind: 'del', oldNo: 1, newNo: null, text: 'old', noNewline: false },
        { kind: 'add', oldNo: null, newNo: 1, text: 'new', noNewline: false },
      ],
    },
  ],
};
afterEach(cleanup);
/** 도구 모음의 경계 처리를 실제 diff 컨트롤러와 함께 확인한다. */
function setup(over: Partial<React.ComponentProps<typeof DiffPaneView>> = {}) {
  const move = vi.fn();
  const load = vi.fn();
  render(
    <DiffPaneView
      path="a.txt"
      areaLabel="test"
      diff={diff}
      loading={false}
      error={null}
      mode="unified"
      onModeChange={() => {}}
      options={DEFAULT_DIFF_OPTIONS}
      onOptionsChange={() => {}}
      onLoadFull={load}
      fileNavigation={{ index: 0, total: 2, move }}
      {...over}
    />,
  );
  return { move, load };
}
describe('변경과 파일 경계', () => {
  it('마지막 변경 다음은 다음 파일이고 전체 첫 파일 이전은 꺼져 있다', async () => {
    const { move } = setup();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` })).not.toHaveProperty(
        'disabled',
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` }));
    expect(move).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: `↑ ${S.diff.previousChange}` })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('잘린 마지막 변경은 자동으로 전체를 읽거나 다음 파일을 건너뛰지 않는다', async () => {
    const { move, load } = setup({ diff: { ...diff, truncated: true } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `${S.diff.nextFile} →` }));
    expect(move).toHaveBeenCalledWith(1);
  });
  it('오류에서는 변경 이동이 꺼져도 명시적 파일 이동은 가능하다', () => {
    const { move } = setup({ diff: null, error: 'failed' });
    expect(screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: `${S.diff.nextFile} →` }));
    expect(move).toHaveBeenCalledWith(1);
  });
});
it('트리 접힘과 무관한 디렉터리 우선 순서와 삭제된 파일의 실제 이웃을 유지한다', () => {
  expect(
    orderedDiffFiles([
      { path: 'z.txt' },
      { path: 'a.txt' },
      { path: 'z/b.txt' },
      { path: 'a/b.txt' },
    ]).map((f) => f.path),
  ).toEqual(['a/b.txt', 'z/b.txt', 'a.txt', 'z.txt']);
  const before = ['a', 'b', 'c', 'd', 'e'].map((path) => ({ path }));
  expect(
    nearestDiffFile(
      'c',
      before,
      ['b', 'd', 'e'].map((path) => ({ path })),
    )?.path,
  ).toBe('d');
});
it('역사 파일 탐색은 위치와 고정 상태를 유지하고 이미 열린 대상 탭을 중복하지 않는다', () => {
  const store = createWorkspaceStore('repo');
  const doc = (path: string) =>
    commitDiffDoc({
      repoPath: '/repo',
      repoName: 'repo',
      oid: 'a'.repeat(40),
      path,
      oldPath: null,
      merge: false,
    });
  store.getState().openDoc(doc('a'), 'pinned');
  store.getState().navigateDiffDoc(doc('a').id, doc('b'));
  expect(store.getState().docs).toHaveLength(1);
  expect(store.getState().docs[0]).toMatchObject({ id: doc('b').id, path: 'b', pinned: true });
  store.getState().openDoc(doc('c'), 'pinned');
  store.getState().navigateDiffDoc(doc('c').id, doc('b'));
  expect(store.getState().docs).toHaveLength(2);
  expect(store.getState().activeDocId).toBe(doc('b').id);
});

it('단독으로 열린 파일을 목록에서 다시 열면 고정 상태를 유지하며 탐색 출처를 받는다', () => {
  const store = createWorkspaceStore('repo');
  const base = {
    repoPath: '/repo',
    repoName: 'repo',
    oid: 'a'.repeat(40),
    path: 'a',
    oldPath: null,
    merge: false,
  };
  store.getState().openDoc(commitDiffDoc(base), 'pinned');
  const origin = {
    kind: 'commit' as const,
    repoPath: '/repo',
    oid: base.oid,
    files: [{ path: 'a' }, { path: 'b' }],
  };
  store.getState().openDoc(commitDiffDoc({ ...base, origin }), 'preview');
  expect(store.getState().docs).toHaveLength(1);
  expect(store.getState().docs[0]).toMatchObject({ pinned: true, origin });
});
