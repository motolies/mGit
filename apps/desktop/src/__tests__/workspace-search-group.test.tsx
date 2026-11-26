import { createNullClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileListCache } from '../features/search/file-list';
import { type SearchMode, useSearchPanel } from '../features/search/search-state';
import { WorkspaceSearch } from '../features/search/WorkspaceSearch';
import { createFolderStore } from '../store/folder-store';
import { writePref } from '../store/prefs';
import { recentFilesKey, recordRecentFile } from '../store/recent-files';
import type { RootSpace } from '../store/root-space';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub } from './dialog-stub';

// 그룹 탭의 검색·⌘P (MR-13 M3): 결과 경로는 `별칭/…` 이고, 결과의 저장소는 멤버 루트로, 초안은 그룹 공간 경로로 보낸다

const KEY = 'mgit-group:g1';
const GROUP = {
  id: 'g1',
  name: 'Work',
  members: [
    { alias: 'api', path: '/w/api', state: 'present' as const, kind: 'standalone' as const },
    { alias: 'web', path: '/x/team/web', state: 'present' as const, kind: 'standalone' as const },
  ],
};

const fixture = vi.hoisted(() => ({
  search: vi.fn(),
  files: vi.fn(),
  replacePreview: vi.fn(),
  cancel: vi.fn(async () => {}),
  open: vi.fn(async (): Promise<{ kind: string }> => ({ kind: 'binary' })),
  doc: vi.fn(),
  drafts: vi.fn((_space: unknown) => [{ path: 'web/b.ts', text: 'draft' }]),
}));
vi.mock('../store', () => {
  const state = {
    activeSessionId: 1,
    sessions: { 1: { path: 'mgit-group:g1' } },
    client: {
      workspaceSearch: fixture.search,
      workspaceSearchCancel: fixture.cancel,
      workspaceFiles: fixture.files,
      workspaceReplacePreview: fixture.replacePreview,
    },
  };
  const repos = [
    { path: '/w/api', kind: 'standalone' },
    { path: '/x/team/web', kind: 'standalone' },
  ];
  const folder = {
    getState: () => ({ repos, summaries: [], fileTree: { getState: () => ({ epoch: 0 }) } }),
  };
  return {
    useAppStore: (selector: (state: unknown) => unknown) => selector(state),
    getFolderStore: () => folder,
    getSessionStore: () => undefined,
    getWorkspaceStore: () => ({ getState: () => ({ openDoc: fixture.doc }) }),
  };
});
vi.mock('../store/editor-drafts', () => ({ editorDrafts: fixture.drafts }));
vi.mock('../store/file-editor-store', () => ({
  fileEditors: {
    subscribe: () => () => {},
    getVersion: () => 0,
    open: fixture.open,
    reveal: vi.fn(),
  },
}));

const input = () => screen.getByRole('combobox', { name: S.workspaceSearch.query });
let oldHeight: PropertyDescriptor | undefined;
let oldScrollHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  installDialogStub();
  // 가상 목록이 줄을 그리도록 보이는 높이를 준다
  oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  oldScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 340,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 2000,
  });
  // 탭 공간은 실제 세션 등록부의 그룹 폴더 스토어에서 찾는다 (`tabSpace`)
  registerFolder(
    1,
    createFolderStore({ session: 1, path: KEY, repos: [], group: GROUP }, createNullClient()),
  );
  fixture.search.mockReset().mockResolvedValue({
    hits: [{ path: 'web/b.ts', repo: 'web', line: 2, column: 3, text: 'a needle' }],
    skipped: 0,
    truncated: false,
    cancelled: false,
  });
  fixture.files.mockReset().mockResolvedValue({
    files: ['api/src/a.ts', 'web/b.ts'],
    repos: ['api', 'web'],
    skipped: 0,
    truncated: false,
    cancelled: false,
  });
  fixture.open.mockReset().mockResolvedValue({ kind: 'binary' });
  fixture.drafts.mockClear();
  fileListCache.clear();
  writePref(recentFilesKey(KEY), []);
  useSearchPanel.setState({ mode: null, focusVersion: 0 });
});
afterEach(() => {
  cleanup();
  removeDialogStub();
  clearSessionRegistry();
  if (oldHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', oldHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  if (oldScrollHeight)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', oldScrollHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  vi.clearAllMocks();
});

/** 검색창을 연다 */
function show(mode: SearchMode) {
  render(<WorkspaceSearch />);
  act(() => useSearchPanel.getState().open(mode));
}

describe('그룹 탭의 검색·빠른 열기', () => {
  it('내용 검색은 초안을 그룹 공간 경로로 보내고, 결과를 열면 별칭 경로·멤버 루트 저장소로 연다', async () => {
    show('content');
    fireEvent.change(input(), { target: { value: 'needle' } });
    await waitFor(() => expect(fixture.search).toHaveBeenCalled());
    const space = fixture.drafts.mock.calls.at(-1)?.[0] as RootSpace | undefined;
    expect(space?.key).toBe(KEY);
    expect(fixture.search.mock.calls.at(-1)?.[2]).toMatchObject({
      text: 'needle',
      drafts: [{ path: 'web/b.ts', text: 'draft' }],
    });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(fixture.open).toHaveBeenCalledWith(expect.anything(), 1, 'web/b.ts'),
    );
    await waitFor(() => expect(fixture.doc).toHaveBeenCalled());
    expect(fixture.doc.mock.calls[0]?.[0]).toMatchObject({
      path: 'web/b.ts',
      repoPath: '/x/team/web',
      repoName: 'web',
    });
  });

  it('저장소 범위 선택지는 멤버 별칭이고, 고르면 그 별칭이 범위로 간다', async () => {
    show('content');
    const select = screen.getByLabelText(S.workspaceSearch.repoScope) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'api', 'web']);
    fireEvent.change(select, { target: { value: 'api' } });
    fireEvent.change(input(), { target: { value: 'needle' } });
    await waitFor(() => expect(fixture.search).toHaveBeenCalled());
    expect(fixture.search.mock.calls.at(-1)?.[2]).toMatchObject({ scope: 'api' });
  });

  it('빠른 열기는 별칭 경로 목록에서 고르고, 고른 파일의 저장소는 가장 긴 저장소 경로(멤버)다', async () => {
    show('files');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    fireEvent.change(input(), { target: { value: 'a.ts' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(fixture.open).toHaveBeenCalledWith(expect.anything(), 1, 'api/src/a.ts'),
    );
    await waitFor(() => expect(fixture.doc).toHaveBeenCalled());
    expect(fixture.doc.mock.calls[0]?.[0]).toMatchObject({ repoPath: '/w/api' });
  });

  it('여러 파일 바꾸기는 초안을 그룹 공간 경로로 보내고 별칭 경로로 미리본다', async () => {
    fixture.replacePreview.mockReset().mockResolvedValue({
      files: [
        {
          path: 'api/src/a.ts',
          repo: 'api',
          revision: 'r1',
          matches: 1,
          hiddenLines: 0,
          lines: [
            {
              line: 1,
              text: 'needle',
              cutStart: false,
              cutEnd: false,
              hidden: 0,
              matches: [{ index: 0, start: 0, end: 6, replacement: 'pin' }],
            },
          ],
        },
      ],
      excluded: [{ path: 'web/b.ts', reason: 'draft' }],
      unreadable: 0,
      truncated: false,
      cancelled: false,
    });
    show('content');
    fireEvent.change(input(), { target: { value: 'needle' } });
    fireEvent.change(screen.getByRole('textbox', { name: S.workspaceSearch.replaceWith }), {
      target: { value: 'pin' },
    });
    fireEvent.click(screen.getByRole('button', { name: S.workspaceSearch.replaceOpen }));
    const dialog = await screen.findByRole('dialog', { name: S.workspaceSearch.replaceTitle });
    await within(dialog).findByText('api/src/a.ts');
    const space = fixture.drafts.mock.calls.at(-1)?.[0] as RootSpace | undefined;
    expect(space?.key).toBe(KEY);
    expect(fixture.replacePreview).toHaveBeenCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ scope: '', drafts: ['web/b.ts'] }),
    );
    expect(within(dialog).getByText('web/b.ts')).toBeTruthy();
  });

  it('최근 파일(⌘E)은 그룹 키로 기억한 별칭 경로를 맨 앞에 보인다', async () => {
    recordRecentFile(KEY, 'web/b.ts');
    show('recent');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getAllByRole('option')[0]?.getAttribute('title')).toBe('web/b.ts:1:1');
  });
});
