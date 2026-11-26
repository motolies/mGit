import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSearchPanel } from '../features/search/search-state';
import { WorkspaceSearch } from '../features/search/WorkspaceSearch';
import { installDialogStub, removeDialogStub } from './dialog-stub';

const fixture = vi.hoisted(() => ({
  search: vi.fn(),
  cancel: vi.fn(async () => {}),
  open: vi.fn(async () => ({ kind: 'binary' })),
  doc: vi.fn(),
}));
vi.mock('../store', () => {
  const state = {
    activeSessionId: 1,
    sessions: { 1: { path: '/workspace' } },
    client: { workspaceSearch: fixture.search, workspaceSearchCancel: fixture.cancel },
  };
  return {
    useAppStore: (selector: (state: unknown) => unknown) => selector(state),
    getFolderStore: () => undefined,
    getWorkspaceStore: () => ({ getState: () => ({ openDoc: fixture.doc }) }),
  };
});
vi.mock('../store/editor-drafts', () => ({ editorDrafts: () => [] }));
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
function show(mode: 'files' | 'content' = 'files') {
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
    fixture.search.mockResolvedValueOnce(result(0)).mockResolvedValue(result(1));
    show();
    await waitFor(() => expect(fixture.search).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.change(input(), { target: { value: 'file' } });
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBeTruthy());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(fixture.open).toHaveBeenCalledWith(expect.anything(), 1, 'file-0.ts'),
    );
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
