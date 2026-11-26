import type { FileDiff } from '@mgit/ipc';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useHighlight } from '../use-highlight';

afterEach(cleanup);

it('동일 내용 재조회에서는 강조 결과를 유지하고 다른 파일에는 재사용하지 않는다', async () => {
  const diff: FileDiff = {
    oldPath: 'a.ts',
    newPath: 'a.ts',
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
        lines: [{ kind: 'add', text: 'const value = 1;', oldNo: null, newNo: 1, noNewline: false }],
      },
    ],
  };
  const original = { old: '', new: 'const value = 1;' };
  const view = renderHook(({ value, path, text }) => useHighlight(value, path, text), {
    initialProps: { value: diff, path: 'a.ts', text: original },
  });
  await waitFor(() => expect(view.result.current.size).toBeGreaterThan(0));
  const highlighted = view.result.current;
  view.rerender({ value: structuredClone(diff), path: 'a.ts', text: { ...original } });
  expect(view.result.current).toBe(highlighted);
  view.rerender({ value: { ...diff, newPath: 'b.ts' }, path: 'b.ts', text: { ...original } });
  expect(view.result.current).not.toBe(highlighted);
});
