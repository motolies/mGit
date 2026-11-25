import type { FsOperationPlan } from '@mgit/ipc';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileConflictDialog, suggestedCopyName } from '../features/project/FileConflictDialog';
import { projectEditStrings } from '../features/project/project-edit-strings';
import './dialog-stub';

afterEach(cleanup);

it('복사본 제안은 파일 확장자를 유지하고 폴더 이름 전체를 보존한다', () => {
  const suffix = projectEditStrings().copySuffix;
  expect(suggestedCopyName('/w/readme.md', false)).toBe(`readme${suffix}.md`);
  expect(suggestedCopyName('/w/folder.name', true)).toBe(`folder.name${suffix}`);
});

it('폴더 skip이 하위 결정을 비활성화하고 merge는 다시 활성화한다', () => {
  const item = {
    directory: true,
    error: null,
    sourceSize: null,
    destinationSize: null,
    sourceMtimeMs: null,
    destinationMtimeMs: null,
  };
  const plan: FsOperationPlan = {
    id: 'p',
    kind: 'copy',
    items: [
      { ...item, id: 'parent', source: '/a/src', destination: '/b/src', conflict: 'directory' },
      {
        ...item,
        directory: false,
        id: 'child',
        source: '/a/src/a.ts',
        destination: '/b/src/a.ts',
        conflict: 'file',
      },
    ],
  };
  render(<FileConflictDialog plan={plan} onResolve={vi.fn()} />);
  const child = screen.getByRole('combobox', { name: '/b/src/a.ts' }) as HTMLSelectElement;
  expect(child.disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox', { name: '/b/src' }), {
    target: { value: 'merge' },
  });
  expect(child.disabled).toBe(false);
});
