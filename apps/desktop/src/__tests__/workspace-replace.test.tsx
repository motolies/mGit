import type { ReplacePreview } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSearchPanel } from '../features/search/search-state';
import { WorkspaceSearch } from '../features/search/WorkspaceSearch';
import { installDialogStub, removeDialogStub } from './dialog-stub';

const fixture = vi.hoisted(() => ({
  search: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  undo: vi.fn(),
  refreshAll: vi.fn(async () => {}),
  /** 지금 편집기에 저장하지 않은 초안이 있는 파일 (루트 기준) */
  drafts: [] as string[],
}));
vi.mock('../store', () => {
  const state = {
    activeSessionId: 1,
    sessions: { 1: { path: '/workspace' } },
    client: {
      workspaceSearch: fixture.search,
      workspaceSearchCancel: vi.fn(async () => {}),
      workspaceFiles: vi.fn(),
      workspaceReplacePreview: fixture.preview,
      workspaceReplaceApply: fixture.apply,
      workspaceReplaceUndo: fixture.undo,
    },
  };
  const folder = { getState: () => ({ repos: [], summaries: [] }) };
  return {
    useAppStore: (selector: (s: unknown) => unknown) => selector(state),
    getFolderStore: () => folder,
    getSessionStore: () => undefined,
    getWorkspaceStore: () => undefined,
  };
});
vi.mock('../store/editor-drafts', () => ({
  editorDrafts: () => fixture.drafts.map((path) => ({ path, text: '' })),
}));
vi.mock('../store/file-editor-store', () => ({
  fileEditors: {
    subscribe: () => () => {},
    getVersion: () => 0,
    open: vi.fn(),
    reveal: vi.fn(),
    refreshAll: fixture.refreshAll,
  },
}));

/** 일치 셋(보이는 둘)인 파일과 하나인 파일, 초안으로 뺀 파일 */
const preview: ReplacePreview = {
  files: [
    {
      path: 'app/a.ts',
      repo: 'app',
      revision: 'ra',
      matches: 3,
      hiddenLines: 1,
      lines: [
        {
          line: 4,
          text: 'let foo_1 = foo_2;',
          cutStart: false,
          cutEnd: false,
          hidden: 0,
          matches: [
            { index: 0, start: 4, end: 9, replacement: 'bar1' },
            { index: 1, start: 12, end: 17, replacement: 'bar2' },
          ],
        },
      ],
    },
    {
      path: 'b.ts',
      repo: '',
      revision: 'rb',
      matches: 1,
      hiddenLines: 0,
      lines: [
        {
          line: 1,
          text: 'foo_9',
          cutStart: false,
          cutEnd: false,
          hidden: 0,
          matches: [{ index: 0, start: 0, end: 5, replacement: 'bar9' }],
        },
      ],
    },
  ],
  excluded: [{ path: 'c.ts', reason: 'draft' }],
  unreadable: 2,
  truncated: false,
  cancelled: false,
};

beforeEach(() => {
  installDialogStub();
  fixture.search
    .mockReset()
    .mockResolvedValue({ hits: [], skipped: 0, truncated: false, cancelled: false });
  fixture.preview.mockReset().mockResolvedValue(preview);
  fixture.apply.mockReset();
  fixture.undo.mockReset();
  fixture.refreshAll.mockClear();
  fixture.drafts = ['c.ts'];
  useSearchPanel.setState({ mode: null, focusVersion: 0 });
});
afterEach(() => {
  cleanup();
  removeDialogStub();
  vi.clearAllMocks();
});

/** 내용 검색 창을 열고 정규식 검색어와 바꿀 내용을 넣은 뒤 바꾸기 창을 연다 */
async function openReplace() {
  render(<WorkspaceSearch />);
  act(() => useSearchPanel.getState().open('content'));
  fireEvent.change(screen.getByRole('combobox', { name: S.workspaceSearch.query }), {
    target: { value: 'foo_(\\d)' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: S.workspaceSearch.regex }));
  fireEvent.change(screen.getByRole('textbox', { name: S.workspaceSearch.replaceWith }), {
    target: { value: 'bar$1' },
  });
  fireEvent.click(screen.getByRole('button', { name: S.workspaceSearch.replaceOpen }));
  return screen.findByRole('dialog', { name: S.workspaceSearch.replaceTitle });
}

describe('여러 파일 바꾸기', () => {
  it('검색 조건 그대로 미리보고, 끈 일치·초안 파일을 빼고 적용한 뒤 되돌린다', async () => {
    const dialog = await openReplace();
    await within(dialog).findByText('app/a.ts');
    expect(fixture.preview).toHaveBeenCalledWith(1, expect.any(String), {
      pattern: { text: 'foo_(\\d)', regex: true, caseSensitive: false, replacement: 'bar$1' },
      pathFilter: '',
      scope: '',
      drafts: ['c.ts'],
    });
    // 초안으로 뺀 파일·읽지 못한 수·보이지 않는 줄 안내가 보인다
    expect(within(dialog).getByText(S.workspaceSearch.replaceReasons.draft)).toBeTruthy();
    expect(within(dialog).getByText(/1 MiB/)).toBeTruthy();
    expect(within(dialog).getByText(S.workspaceSearch.replaceHiddenLines(1))).toBeTruthy();
    // 바꾼 뒤 줄은 켠 일치만 바꾼다
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: S.workspaceSearch.replaceMatch('foo_2', 'bar2'),
      }),
    );
    const after = within(dialog).getAllByLabelText(S.workspaceSearch.replaceAfter)[0];
    expect(after?.textContent).toBe('let bar1 = foo_2;');

    // 미리본 뒤 b.ts 에 초안이 생겼다 → 보내지 않고 건너뛴 것으로 보인다
    fixture.drafts = ['b.ts'];
    fixture.apply.mockResolvedValue([
      { kind: 'applied', path: 'app/a.ts', replaced: 2, backup: 7, revision: 'na' },
    ]);
    const searches = fixture.search.mock.calls.length;
    fireEvent.click(
      within(dialog).getByRole('button', { name: S.workspaceSearch.replaceApply(2, 3) }),
    );
    await within(dialog).findByText(new RegExp(S.workspaceSearch.replaceDone(1, 2)));
    expect(fixture.apply).toHaveBeenCalledWith(1, {
      pattern: { text: 'foo_(\\d)', regex: true, caseSensitive: false, replacement: 'bar$1' },
      files: [{ path: 'app/a.ts', revision: 'ra', excluded: [1] }],
    });
    const skipped = within(dialog).getByRole('region', {
      name: S.workspaceSearch.replaceSkippedTitle,
    });
    expect(within(skipped).getByText('b.ts')).toBeTruthy();
    expect(within(skipped).getByText(S.workspaceSearch.replaceReasons.draft)).toBeTruthy();
    // 열린 편집기를 곧바로 다시 읽고 검색 결과도 다시 받는다
    expect(fixture.refreshAll).toHaveBeenCalled();
    await waitFor(() => expect(fixture.search.mock.calls.length).toBeGreaterThan(searches));

    fixture.undo.mockResolvedValue([{ kind: 'restored', path: 'app/a.ts' }]);
    fireEvent.click(within(dialog).getByRole('button', { name: S.workspaceSearch.replaceUndo }));
    await within(dialog).findByText(new RegExp(S.workspaceSearch.replaceUndone(1)));
    expect(fixture.undo).toHaveBeenCalledWith(1, [{ path: 'app/a.ts', backup: 7, revision: 'na' }]);
    expect(
      within(dialog).queryByRole('button', { name: S.workspaceSearch.replaceUndo }),
    ).toBeNull();
  });

  it('파일 체크를 끄면 그 파일을 보내지 않고, 모두 끄면 적용할 수 없다', async () => {
    fixture.drafts = [];
    const dialog = await openReplace();
    await within(dialog).findByText('app/a.ts');
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: S.workspaceSearch.replaceFile('b.ts') }),
    );
    fixture.apply.mockResolvedValue([{ kind: 'skipped', path: 'app/a.ts', reason: 'changed' }]);
    fireEvent.click(
      within(dialog).getByRole('button', { name: S.workspaceSearch.replaceApply(1, 3) }),
    );
    await within(dialog).findByText(S.workspaceSearch.replaceReasons.changed);
    expect(fixture.apply.mock.calls[0]?.[1].files.map((f: { path: string }) => f.path)).toEqual([
      'app/a.ts',
    ]);
    // 바꾼 파일이 없으면 되돌리기도 없다
    expect(
      within(dialog).queryByRole('button', { name: S.workspaceSearch.replaceUndo }),
    ).toBeNull();
  });

  it('검색어가 없으면 바꾸기 창을 열 수 없다', () => {
    render(<WorkspaceSearch />);
    act(() => useSearchPanel.getState().open('content'));
    const button = screen.getByRole('button', { name: S.workspaceSearch.replaceOpen });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(fixture.preview).not.toHaveBeenCalled();
  });
});
