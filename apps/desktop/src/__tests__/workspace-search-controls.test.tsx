import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileListCache } from '../features/search/file-list';
import { type SearchMode, useSearchPanel } from '../features/search/search-state';
import { WorkspaceSearch } from '../features/search/WorkspaceSearch';
import { writePref } from '../store/prefs';
import { recentFilesKey, recordRecentFile } from '../store/recent-files';
import { installDialogStub, removeDialogStub } from './dialog-stub';

const fixture = vi.hoisted(() => ({
  search: vi.fn(),
  files: vi.fn(),
  cancel: vi.fn(async () => {}),
  open: vi.fn(async (): Promise<{ kind: string }> => ({ kind: 'binary' })),
  doc: vi.fn(),
  /** 폴더 스토어의 파일 트리 epoch (빠른 열기 목록 표지) */
  epoch: 0,
}));
vi.mock('../store', () => {
  const sessions = { 1: { path: '/workspace' } };
  const state = {
    activeSessionId: 1,
    sessions,
    client: {
      workspaceSearch: fixture.search,
      workspaceSearchCancel: fixture.cancel,
      workspaceFiles: fixture.files,
    },
  };
  const repos: unknown[] = [];
  const summaries: unknown[] = [];
  const folder = {
    getState: () => ({
      repos,
      summaries,
      fileTree: { getState: () => ({ epoch: fixture.epoch }) },
    }),
  };
  return {
    useAppStore: (selector: (state: unknown) => unknown) => selector(state),
    getFolderStore: () => folder,
    useFolder: (selector: (state: unknown) => unknown) => selector(folder.getState()),
    getSessionStore: () => undefined,
    getWorkspaceStore: () => ({ getState: () => ({ openDoc: fixture.doc }) }),
  };
});
vi.mock('../store/editor-drafts', () => ({ editorDrafts: () => [], editorDraftStamp: () => '' }));
vi.mock('../store/file-editor-store', () => ({
  fileEditors: {
    subscribe: () => () => {},
    getVersion: () => 0,
    open: fixture.open,
    reveal: vi.fn(),
  },
}));
const hit = (index: number) => ({
  path: `file-${index}.ts`,
  repo: '',
  line: index + 1,
  column: 1,
  text: `result ${index}`,
});
const result = (length: number) => ({
  hits: Array.from({ length }, (_, i) => hit(i)),
  skipped: 0,
  truncated: false,
  cancelled: false,
});
/** 빠른 열기 파일 목록 응답 */
const fileList = (files: string[]) => ({
  files,
  repos: [''],
  skipped: 0,
  truncated: false,
  cancelled: false,
});
const input = () => screen.getByRole('combobox', { name: S.workspaceSearch.query });
const scroll = vi.fn();
let oldOffset: PropertyDescriptor | undefined;
let oldScroll: PropertyDescriptor | undefined;
let oldHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  installDialogStub();
  oldOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 200000,
  });
  oldScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 340,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scroll });
  fixture.search.mockReset().mockResolvedValue(result(3));
  fixture.files.mockReset().mockResolvedValue(fileList(['file-0.ts', 'file-1.ts', 'file-2.ts']));
  fixture.open.mockReset().mockResolvedValue({ kind: 'binary' });
  fixture.epoch = 0;
  fileListCache.clear();
  writePref(recentFilesKey('/workspace'), []);
  useSearchPanel.setState({ mode: null, focusVersion: 0 });
});
afterEach(() => {
  cleanup();
  removeDialogStub();
  if (oldOffset) Object.defineProperty(HTMLElement.prototype, 'clientHeight', oldOffset);
  if (oldScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', oldScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  if (oldHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', oldHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  vi.clearAllMocks();
});
/** 검색창 열기를 실제 호출자 포커스와 함께 재현한다. */
function show(mode: SearchMode = 'files') {
  render(
    <>
      <button type="button">origin</button>
      <WorkspaceSearch />
    </>,
  );
  screen.getByText('origin').focus();
  act(() => useSearchPanel.getState().open(mode));
}

describe('검색 결과 키보드와 포커스', () => {
  it('한글 조합·Safari229 Enter는 파일을 열지 않고 일반 Enter만 연다', async () => {
    show();
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeTruthy());
    fireEvent.compositionStart(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(fixture.open).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(fixture.open).toHaveBeenCalledWith(expect.anything(), 1, 'file-0.ts'),
    );
  });

  it('빈 결과에서 아래 화살표를 눌러도 이후 첫 결과를 Enter로 열 수 있다', async () => {
    fixture.files.mockResolvedValue(fileList(['other.ts', 'file-0.ts']));
    show();
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeTruthy());
    fireEvent.change(input(), { target: { value: 'zzz' } });
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeNull());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.change(input(), { target: { value: 'file' } });
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeTruthy());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(fixture.open).toHaveBeenCalledWith(expect.anything(), 1, 'file-0.ts'),
    );
    expect(fixture.files).toHaveBeenCalledTimes(1);
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it('퍼지 일치 글자를 강조하고 점수 순으로 보이며, 결과 수는 맞은 전체 파일 수다', async () => {
    fixture.files.mockResolvedValue(
      fileList(['docs/reference.md', 'src/FileEditor.tsx', 'src/fe.ts', 'zzz.md']),
    );
    show();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    fireEvent.change(input(), { target: { value: 'fe' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.getAttribute('title'))).toEqual([
      'src/fe.ts:1:1',
      'src/FileEditor.tsx:1:1',
      'docs/reference.md:1:1',
    ]);
    expect([...(options[1]?.querySelectorAll('mark') ?? [])].map((m) => m.textContent)).toEqual([
      'F',
      'E',
    ]);
    expect(screen.getByRole('status').textContent).toContain(S.workspaceSearch.results(3));
  });

  it('목록은 한 번만 받아 입력·다시 열기에 그대로 쓰고, 표지가 바뀐 뒤 열 때만 다시 받는다', async () => {
    show();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    for (const value of ['f', 'fi', 'file-1']) fireEvent.change(input(), { target: { value } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    act(() => useSearchPanel.getState().close());
    act(() => useSearchPanel.getState().open('files'));
    act(() => useSearchPanel.getState().open('files'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(fixture.files).toHaveBeenCalledTimes(1);
    // 파일 트리를 다시 읽으면(창 포커스·새로고침·파일 작업 등) epoch 가 오른다
    fixture.files.mockResolvedValue(fileList(['file-0.ts', 'new.ts']));
    fixture.epoch = 1;
    act(() => useSearchPanel.getState().close());
    act(() => useSearchPanel.getState().open('files'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(fixture.files).toHaveBeenCalledTimes(2);
  });

  it('최근 파일(저장한 배열)이 빈 검색어 맨 앞에 온다', async () => {
    recordRecentFile('/workspace', 'file-1.ts');
    recordRecentFile('/workspace', 'file-2.ts');
    show();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('title'))).toEqual([
      'file-2.ts:1:1',
      'file-1.ts:1:1',
      'file-0.ts:1:1',
    ]);
  });

  it('최근 파일 창(⌘E)은 아직 있는 최근 파일만 최근 순서로 보이고, 검색어로 거르며 Enter 로 연다', async () => {
    recordRecentFile('/workspace', 'gone.ts');
    recordRecentFile('/workspace', 'file-0.ts');
    recordRecentFile('/workspace', 'file-2.ts');
    show('recent');
    expect(screen.getByText(S.workspaceSearch.recentFiles)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.getAttribute('title'))).toEqual([
        'file-2.ts:1:1',
        'file-0.ts:1:1',
      ]),
    );
    fireEvent.change(input(), { target: { value: 'f0' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(fixture.open).toHaveBeenCalledWith(expect.anything(), 1, 'file-0.ts'),
    );
    expect(fixture.doc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'file-0.ts' }),
      'pinned',
    );
  });

  it('낡은 목록에서 고른 파일이 사라졌으면 그 탭은 열고 다음에 열 때 목록을 다시 받는다', async () => {
    fixture.open.mockResolvedValue({ kind: 'missing' });
    show();
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeTruthy());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(fixture.doc).toHaveBeenCalledTimes(1));
    act(() => useSearchPanel.getState().open('files'));
    await waitFor(() => expect(fixture.files).toHaveBeenCalledTimes(2));
  });

  it('긴 결과는 가상화하고 PageDown 선택을 스크롤하며 Home·End는 입력칸에 남긴다', async () => {
    fixture.search.mockResolvedValue(result(2000));
    show('content');
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeTruthy());
    expect(screen.getAllByRole('option').length).toBeLessThan(50);
    expect(screen.getAllByRole('option').every((el) => el.tabIndex === -1)).toBe(true);
    for (let step = 0; step < 5; step++) fireEvent.keyDown(input(), { key: 'PageDown' });
    const active = input().getAttribute('aria-activedescendant');
    expect(document.getElementById(active ?? '')?.getAttribute('aria-posinset')).toBe('51');
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) }));
    expect(scroll.mock.calls.some(([options]) => options.top > 1000)).toBe(true);
    expect(fireEvent.keyDown(input(), { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: 'End' })).toBe(true);
    expect(input().getAttribute('aria-activedescendant')).toBe(active);
  });

  it('같은 검색 명령은 입력칸으로 돌아가고 Esc는 원래 영역으로 복귀한다', async () => {
    show('content');
    const origin = screen.getByText('origin');
    origin.focus();
    act(() => useSearchPanel.getState().open('content'));
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
