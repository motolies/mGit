import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { treeContentWidth } from '../components/tree-width';
import { BranchTree } from '../features/branches/BranchTree';
import { ChangedFilesTree } from '../features/detail/ChangedFilesTree';
import { ProjectTree } from '../features/project/ProjectTree';
import { flattenProjectTree } from '../features/project/project-tree-model';

let height: PropertyDescriptor | undefined;
let width: PropertyDescriptor | undefined;
let scroll: PropertyDescriptor | undefined;
beforeEach(() => {
  height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 120,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 180,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      if (options.top !== undefined) this.scrollTop = options.top;
      if (options.left !== undefined) this.scrollLeft = options.left;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: Array.from(text).length * 9 }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const [key, descriptor] of [
    ['clientHeight', height],
    ['clientWidth', width],
    ['scrollTo', scroll],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});
const longName = 'LongShippingLabelRepositoryWithDetailedImplementationAndMetadata.java';
const changed = (path: string) => ({ path, oldPath: null, change: { kind: 'modified' as const } });
/** 가상 트리의 실제 스크롤 내용 폭이다. */
function innerWidth(tree: HTMLElement): number {
  return Number.parseFloat((tree.firstElementChild as HTMLElement).style.minWidth);
}

describe('트리 가로 내용 폭', () => {
  it('텍스트·굵기·들여쓰기·아이콘·배지를 모두 합산하고 좁은 행에 맞춰 줄어든다', () => {
    const metric = { indent: 16, icon: 16, gap: 4, padding: 24 };
    const measure = (text: string, bold: boolean) => text.length * (bold ? 10 : 8);
    const small = { depth: 0, texts: [{ text: 'root' }], icons: 1 };
    const long = {
      depth: 5,
      texts: [{ text: longName, bold: true }, { text: 'ahead 99' }],
      icons: 3,
      extra: 28,
    };
    const full = treeContentWidth([small, long], measure, metric);
    expect(full).toBeGreaterThan(measure(longName, true) + 5 * 16 + 3 * 16 + 28);
    expect(treeContentWidth([small], measure, metric)).toBeLessThan(full);
  });
  it('변경 파일 트리는 화면 밖 긴 파일도 폭에 포함하고 키 이동 중 가로 위치를 유지한다', () => {
    const files = [
      ...Array.from({ length: 200 }, (_, i) => changed(`file-${String(i).padStart(3, '0')}.ts`)),
      changed(`z/${longName}`),
    ];
    const props = {
      files,
      root: { name: 'repo' },
      onPreview: vi.fn(),
      onOpen: vi.fn(),
      menu: () => [],
    };
    const { rerender } = render(<ChangedFilesTree {...props} />);
    const tree = screen.getByRole('tree', { name: S.detail.changedFiles });
    expect(innerWidth(tree)).toBeGreaterThan(600);
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(50);
    tree.scrollLeft = 170;
    act(() => tree.focus());
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.scrollLeft).toBe(170);
    rerender(<ChangedFilesTree {...props} files={[changed('a.ts')]} />);
    expect(innerWidth(tree)).toBeLessThan(300);
  });
  it('Project 파일 이름과 저장소 장식이 넓어져도 실제 이름이 남고 폭이 갱신된다', () => {
    const entries = [
      { name: longName, kind: 'file' as const, size: 1, mtimeMs: 0, openable: true },
    ];
    const rows = flattenProjectTree(
      {
        '': {
          load: { state: 'listed', entries, total: 1, truncated: false, nonUtf8Names: 0 },
          limit: null,
          pending: false,
        },
      },
      { '': true },
    );
    render(
      <ProjectTree
        root={{ name: 'repo', detail: '/workspace/repo' }}
        rows={rows}
        selected={null}
        decorate={() => null}
        menu={() => []}
        onSelect={() => {}}
        onToggle={() => {}}
        onOpenFile={() => {}}
        onLoadMore={() => {}}
        onRetry={() => {}}
        onRefresh={() => {}}
        busy={false}
      />,
    );
    const tree = screen.getByRole('tree', { name: S.project.tree });
    expect(innerWidth(tree)).toBeGreaterThan(600);
    expect(tree.textContent).toContain(longName);
    tree.scrollLeft = 140;
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.scrollLeft).toBe(140);
  });
  it('브랜치 그룹을 펼치면 긴 이름·업스트림·배지를 위한 가로 폭이 늘어난다', () => {
    const nodes = [
      {
        id: 'group',
        kind: 'group' as const,
        label: 'Local',
        children: [
          {
            id: 'long',
            kind: 'local' as const,
            label: `feature/${longName}`,
            suffix: '(service-with-long-name)',
            track: { ahead: 99, behind: 1, gone: false },
          },
        ],
      },
    ];
    const props = {
      nodes,
      selectedIds: [],
      expansion: { group: false },
      onExpansionChange: vi.fn(),
      onActivate: vi.fn(),
      onOpen: vi.fn(),
      onToggleFavorite: vi.fn(),
      menu: () => [],
    };
    const { rerender } = render(<BranchTree {...props} />);
    const tree = screen.getByRole('tree', { name: S.branches.tree });
    const closed = innerWidth(tree);
    rerender(<BranchTree {...props} expansion={{ group: true }} />);
    expect(innerWidth(tree)).toBeGreaterThan(closed + 600);
    tree.scrollLeft = 190;
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.scrollLeft).toBe(190);
  });
});
