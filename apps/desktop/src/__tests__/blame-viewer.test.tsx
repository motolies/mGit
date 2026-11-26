import { S, shortHash } from '@mgit/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BlameDialog } from '../features/history/BlameDialog';
import { installDialogStub, removeDialogStub } from './dialog-stub';

const fixture = vi.hoisted(() => ({ close: vi.fn(), jump: vi.fn(), open: vi.fn() }));
const longCode = `\tpublic String value = "${'LongIdentifier'.repeat(80)}END";`;
vi.mock('../store', () => ({
  useSession: (select: (state: unknown) => unknown) =>
    select({
      blame: {
        path: 'Main.java',
        rev: null,
        loading: false,
        error: null,
        lines: [
          {
            oid: 'a'.repeat(40),
            line: 1,
            text: longCode,
            author: 'Kim',
            authorMail: 'kim@example.invalid',
            authorTime: 1,
            summary: 'test',
            previousOid: 'b'.repeat(40),
            previousPath: 'Old.java',
          },
          {
            oid: 'a'.repeat(40),
            line: 2,
            text: 'short',
            author: 'Kim',
            authorMail: 'kim@example.invalid',
            authorTime: 1,
            summary: 'test',
          },
        ],
      },
      closeBlame: fixture.close,
      openBlame: fixture.open,
      jumpToCommit: fixture.jump,
      diffOptions: { ignoreWhitespace: false },
      setDiffOptions: vi.fn(),
      actionError: null,
    }),
  useHasSession: () => true,
}));
vi.mock('../features/history/folder-target', () => ({ useFolderDialogTarget: () => null }));
beforeEach(installDialogStub);
afterEach(() => {
  cleanup();
  removeDialogStub();
  vi.clearAllMocks();
});

it('Blame 코드 영역은 키보드 스크롤 대상이고 긴 원문·탭·끝 글자를 보존한다', () => {
  render(<BlameDialog />);
  const region = screen.getByRole('region', { name: S.history.blameTitle('Main.java') });
  expect(region.tabIndex).toBe(0);
  region.focus();
  expect(document.activeElement).toBe(region);
  const lines = region.querySelectorAll('[data-first]');
  expect(lines).toHaveLength(2);
  expect(lines[0]?.lastElementChild?.textContent).toBe(longCode);
  expect(lines[1]?.lastElementChild?.textContent).toBe('short');
  expect(lines[0]?.parentElement).toBe(lines[1]?.parentElement);
});

it('긴 줄을 표시해도 이전 이력과 커밋 이동 동작을 유지한다', () => {
  render(<BlameDialog />);
  fireEvent.click(screen.getByTitle(S.history.previousOf(shortHash('b'.repeat(40)))));
  expect(fixture.open).toHaveBeenCalledWith('Old.java', 'b'.repeat(40));
  fireEvent.click(screen.getByRole('button', { name: shortHash('a'.repeat(40)) }));
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.jump).toHaveBeenCalledWith('a'.repeat(40));
});
