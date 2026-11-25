import type { FsOperationRequest } from '@mgit/ipc';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ManagedProjectTree,
  normalizeProjectPaths,
  validProjectName,
} from '../features/project/ManagedProjectTree';
import type { ProjectTreeProps } from '../features/project/ProjectTree';
import { projectEditStrings } from '../features/project/project-edit-strings';
import { flattenProjectTree } from '../features/project/project-tree-model';
import { tick } from './dialog-stub';

const prepare = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() => vi.fn());
vi.mock('../features/project/file-operation-coordinator', () => ({
  prepareFileOperation: prepare,
  executeFileOperation: execute,
}));
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 300,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 실제 트리 행과 컨테이너 콜백으로 파일 관리 UI를 준비한다. */
function mount() {
  const props: ProjectTreeProps = {
    root: { name: 'project', detail: '/w' },
    rows: flattenProjectTree(
      {
        '': {
          load: {
            state: 'listed',
            entries: [{ name: 'readme.md', kind: 'file', size: 0, mtimeMs: 0, openable: true }],
            total: 1,
            truncated: false,
            nonUtf8Names: 0,
          },
          pending: false,
          limit: null,
        },
      },
      { '': true },
    ),
    selected: 'readme.md',
    selection: { 'readme.md': true },
    decorate: () => null,
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    menu: () => [],
    onRefresh: vi.fn(),
    busy: false,
  };
  prepare.mockImplementation(async (_client, request: FsOperationRequest) => ({
    id: 'test',
    kind: request.kind,
    items: [],
  }));
  execute.mockResolvedValue({
    id: 'test',
    items: [
      {
        status: 'committed',
        source: null,
        destination: '/w/new.txt',
        directory: false,
        error: null,
      },
    ],
  });
  render(<ManagedProjectTree {...props} session={1} />);
  return props;
}

describe('Project 파일 관리', () => {
  it('상위 선택과 하위 선택을 한 번만 처리하며 형제 접두는 보존한다', () => {
    expect(normalizeProjectPaths(['src', 'src/a.ts', 'src-other/a.ts', 'src'])).toEqual([
      'src',
      'src-other/a.ts',
    ]);
  });
  it('한글 이름을 허용하고 경로 탈출과 Git 내부 이름을 막는다', () => {
    expect(validProjectName('새 파일.ts')).toBe(true);
    for (const name of ['', '..', '.', '../file', 'dir/file', '.git', '.GIT'])
      expect(validProjectName(name)).toBe(false);
  });
  it('인라인 새 파일 입력은 접근 가능하며 확정 후 고정 편집 탭을 연다', async () => {
    const props = mount();
    const t = projectEditStrings();
    fireEvent.click(screen.getByRole('button', { name: t.newFile }));
    await tick();
    const input = screen.getByRole('textbox', { name: t.name });
    expect(input.closest('[aria-disabled="true"]')).toBeNull();
    fireEvent.change(input, { target: { value: 'new.txt' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await tick();
    });
    expect(prepare).toHaveBeenCalledWith(expect.anything(), {
      kind: 'createFile',
      sources: [],
      destination: { session: 1, path: 'new.txt' },
    });
    expect(props.onOpenFile).toHaveBeenCalledWith('new.txt', 'pinned');
  });
  it('잘못된 이름은 입력을 보존하며 Esc는 파일 작업 없이 취소한다', async () => {
    mount();
    const t = projectEditStrings();
    fireEvent.click(screen.getByRole('button', { name: t.newFolder }));
    await tick();
    const input = screen.getByRole('textbox', { name: t.name });
    fireEvent.change(input, { target: { value: '../outside' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await tick();
    expect(screen.getByRole('alert').textContent).toBe(t.invalid);
    expect(prepare).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    await tick();
    expect(screen.queryByRole('textbox', { name: t.name })).toBeNull();
  });
});

describe('인라인 이름의 텍스트 메뉴', () => {
  it('우클릭 메뉴로 이동해도 입력을 유지하고 실제 바깥 클릭만 취소한다', async () => {
    mount();
    const t = projectEditStrings();
    fireEvent.click(screen.getByRole('button', { name: t.newFile }));
    await tick();
    const input = screen.getByRole('textbox', { name: t.name });
    fireEvent.change(input, { target: { value: 'draft.ts' } });
    fireEvent.contextMenu(input);
    await tick();
    const menu = screen.getByRole('menu');
    fireEvent.blur(input, { relatedTarget: menu });
    expect(document.body.contains(input)).toBe(true);
    fireEvent.pointerDown(menu);
    expect(document.body.contains(input)).toBe(true);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await tick();
    fireEvent.pointerDown(document.body);
    await tick();
    expect(screen.queryByRole('textbox', { name: t.name })).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
});
