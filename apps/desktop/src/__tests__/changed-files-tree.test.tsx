import type { ChangedFile, DiffChange, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileList } from '../features/changes/FileList';
import { buildPathTree, compressPathTree, type PathTreeNode } from '../features/changes/path-tree';
import { ChangedFilesTree } from '../features/detail/ChangedFilesTree';
import {
  buildChangedFilesTree,
  CHANGED_ROOT_ID,
  changedFileTone,
  changedTreeRows,
} from '../features/detail/changed-files-tree';
import { tick } from './dialog-stub';

afterEach(cleanup);

/** 변경 파일 하나 */
function changed(
  path: string,
  kind: DiffChange['kind'] = 'modified',
  oldPath?: string,
): ChangedFile {
  const change =
    kind === 'renamed' || kind === 'copied'
      ? ({ kind, similarity: 90 } as DiffChange)
      : ({ kind } as DiffChange);
  return { path, oldPath: oldPath ?? null, change };
}

/** 트리 모양: `이름(파일 수)` 를 들여쓰기로 (파일은 이름만) */
function shape<T>(nodes: readonly PathTreeNode<T>[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.item === undefined ? `${n.name}/(${n.files})` : n.name}`,
    ...shape(n.children, depth + 1),
  ]);
}

describe('경로 트리 (FileList 와 변경 파일 트리 공용)', () => {
  it('디렉터리 먼저·이름순으로 놓고 디렉터리마다 파일 수를 센다', () => {
    const tree = buildPathTree([
      { path: 'z.txt' },
      { path: 'src/b.ts' },
      { path: 'src/a/x.ts' },
      { path: 'a.txt' },
      { path: 'src/a/y.ts' },
    ]);
    expect(shape(tree)).toEqual([
      'src/(3)',
      '  a/(2)',
      '    x.ts',
      '    y.ts',
      '  b.ts',
      'a.txt',
      'z.txt',
    ]);
  });

  it('같은 이름의 파일과 디렉터리는 따로 노드가 되고, 같은 경로가 두 번 오면 처음 것만 남는다', () => {
    const first = { path: 'lib', tag: 1 };
    const tree = buildPathTree([first, { path: 'lib/x.ts', tag: 2 }, { path: 'lib', tag: 3 }]);
    expect(shape(tree)).toEqual(['lib/(1)', '  x.ts', 'lib']);
    expect(tree[1]?.item).toBe(first);
  });

  it('압축: 자식이 디렉터리 하나뿐인 사슬을 한 노드로 잇는다. 파일 하나뿐인 디렉터리는 그대로다', () => {
    const tree = compressPathTree(
      buildPathTree([
        { path: 'src/main/java/co/kr/A.java' },
        { path: 'src/main/java/co/kr/b/B.java' },
        { path: 'docs/README.md' },
      ]),
    );
    expect(shape(tree)).toEqual([
      'docs/(1)',
      '  README.md',
      'src/main/java/co/kr/(2)',
      '  b/(1)',
      '    B.java',
      '  A.java',
    ]);
    // 압축한 노드의 경로는 마지막 단계까지다
    expect(tree[1]?.path).toBe('src/main/java/co/kr');
  });

  it('압축은 원래 트리를 바꾸지 않는다', () => {
    const tree = buildPathTree([{ path: 'a/b/c.ts' }]);
    const before = shape(tree);
    compressPathTree(tree);
    expect(shape(tree)).toEqual(before);
  });
});

describe('FileList 트리 보기 (공용 함수로 바꾼 뒤에도 그대로)', () => {
  /** 작업 트리 변경 하나 */
  const entry = (path: string): StatusEntry =>
    ({
      path,
      index: 'unmodified',
      worktree: 'modified',
      conflict: false,
    }) as unknown as StatusEntry;

  it('디렉터리를 압축하지 않고 디렉터리 먼저·이름순으로 그리며 접고 편다', () => {
    render(
      <FileList
        entries={[entry('b.txt'), entry('src/x/y.ts'), entry('a.txt')]}
        staged={false}
        view="tree"
        selected={new Set()}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    const rows = () => screen.getAllByRole('listitem').map((li) => li.textContent?.trim());
    expect(rows()).toEqual(['▾ src', '▾ x', 'My.ts', 'Ma.txt', 'Mb.txt']);
    fireEvent.click(screen.getByRole('button', { name: '▾ src' }));
    expect(rows()).toEqual(['▸ src', 'Ma.txt', 'Mb.txt']);
  });
});

describe('변경 파일 트리 모델 (CD-01)', () => {
  const FILES = [
    changed('src/routes/orders/handlers/create-order.ts'),
    changed('src/routes/orders/schema/order.v2.json', 'added'),
    changed('src/lib/http/retry-policy.ts', 'renamed', 'src/lib/retry.ts'),
    changed('README.md', 'deleted'),
  ];

  it('단일 자식 사슬을 압축하고 폴더 먼저·이름순, rename 은 새 경로 자리에 둔다', () => {
    const rows = changedTreeRows('api', buildChangedFilesTree(FILES), new Set());
    expect(
      rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.kind === 'file' ? '' : ` ${r.files}`}`),
    ).toEqual([
      'api 4',
      '  src 3',
      '    lib/http 1',
      '      retry-policy.ts',
      '    routes/orders 2',
      '      handlers 1',
      '        create-order.ts',
      '      schema 1',
      '        order.v2.json',
      '  README.md',
    ]);
    const renamed = rows.find((r) => r.name === 'retry-policy.ts');
    expect(renamed?.file?.oldPath).toBe('src/lib/retry.ts');
    expect(renamed?.parentId).toBe('d:src/lib/http');
  });

  it('루트 직속 파일만 있어도 루트 행 아래에 놓인다. 빈 목록은 루트 행 하나(0개, 펼칠 것 없음)다', () => {
    const only = changedTreeRows(
      'web',
      buildChangedFilesTree([changed('a.txt', 'added')]),
      new Set(),
    );
    expect(only.map((r) => [r.kind, r.name, r.depth])).toEqual([
      ['root', 'web', 0],
      ['file', 'a.txt', 1],
    ]);
    const empty = changedTreeRows('web', buildChangedFilesTree([]), new Set());
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ id: CHANGED_ROOT_ID, files: 0, expandable: false });
  });

  it('접은 디렉터리의 자식과 접은 루트의 전체를 건너뛴다 (기본은 모두 펼침)', () => {
    const tree = buildChangedFilesTree(FILES);
    const folded = changedTreeRows('api', tree, new Set(['d:src/routes/orders']));
    expect(folded.map((r) => r.name)).not.toContain('handlers');
    expect(folded.find((r) => r.id === 'd:src/routes/orders')).toMatchObject({ expanded: false });
    expect(changedTreeRows('api', tree, new Set([CHANGED_ROOT_ID])).map((r) => r.name)).toEqual([
      'api',
    ]);
  });

  it('상태 색: 추가·복사 = 추가, 삭제 = 삭제, 그 밖(수정·이름·종류 바뀜) = 수정', () => {
    expect(
      (['added', 'copied', 'deleted', 'modified', 'renamed', 'typeChanged'] as const).map((k) =>
        changedFileTone(changed('x', k)),
      ),
    ).toEqual(['added', 'added', 'deleted', 'modified', 'modified', 'modified']);
  });
});

describe('ChangedFilesTree (CD-01·04)', () => {
  beforeAll(() => {
    // 가상 스크롤이 보이는 높이를 알도록 (jsdom 은 배치를 계산하지 않는다)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 300 });
  });

  const FILES = [
    changed('src/a/one.ts', 'added'),
    changed('src/a/two.ts'),
    changed('src/b/old-name.ts', 'renamed', 'src/b/older.ts'),
    changed('gone.txt', 'deleted'),
  ];

  /** 트리를 그리고 콜백을 돌려준다 */
  function setup(menu = vi.fn(() => [{ label: '메뉴 항목' }])) {
    const onPreview = vi.fn();
    const onOpen = vi.fn();
    render(
      <ChangedFilesTree
        files={FILES}
        root={{ name: 'api', color: 3 }}
        onPreview={onPreview}
        onOpen={onOpen}
        menu={menu}
      />,
    );
    const tree = screen.getByRole('tree', { name: S.detail.changedFiles });
    return { onPreview, onOpen, menu, tree };
  }
  // 메뉴가 열리면 Radix 가 나머지를 보조 기술에서 가리므로 역할 질의 대신 속성으로 찾는다
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  /** 이름이 정확히 그것인 행 */
  const item = (name: string) => {
    const el = items().find((row) =>
      [...row.querySelectorAll('span')].some((span) => span.textContent === name),
    );
    if (!el) {
      throw new Error(`행 없음: ${name}`);
    }
    return el;
  };
  const selectedName = () =>
    items().find((row) => row.getAttribute('aria-selected') === 'true')?.textContent ?? null;

  it('ARIA: 트리·행 수준·펼침을 알리고, 루트에 저장소 색 사각형과 파일 수를 보인다', () => {
    const { tree } = setup();
    expect(tree.getAttribute('tabindex')).toBe('0');
    expect(items().map((row) => row.getAttribute('aria-level'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '4',
      '3',
      '4',
      '2',
    ]);
    const root = items()[0] as HTMLElement;
    expect(root.getAttribute('aria-expanded')).toBe('true');
    expect(root.textContent).toContain('api');
    expect(root.textContent).toContain(S.detail.fileCount(4));
    // 색은 데이터의 색 번호로 레인 토큰을 가리킨다 (LF-09)
    const swatch = within(root).getByTestId('repo-swatch');
    expect(swatch.style.getPropertyValue('--repo-color')).toBe('var(--graph-lane-3)');
    expect(item('src').textContent).toContain(S.detail.fileCount(3));
  });

  it('파일 행은 상태 문자와 상태 색(데이터 속성)을 함께 쓰고, rename 은 옛 경로를 보조 글자·툴팁으로 보인다', () => {
    setup();
    const letter = (name: string) => item(name).querySelector('[data-letter]')?.textContent;
    expect([letter('one.ts'), letter('two.ts'), letter('old-name.ts'), letter('gone.txt')]).toEqual(
      ['A', 'M', 'R', 'D'],
    );
    expect(
      ['one.ts', 'two.ts', 'old-name.ts', 'gone.txt'].map((n) => item(n).getAttribute('data-tone')),
    ).toEqual(['added', 'modified', 'modified', 'deleted']);
    expect(item('old-name.ts').textContent).toContain(S.changes.renamedFrom('src/b/older.ts'));
    expect(item('old-name.ts').getAttribute('title')).toBe('src/b/older.ts → src/b/old-name.ts');
  });

  it('클릭 = 미리보기, 더블클릭 = 고정. 폴더 클릭은 접고 편다', () => {
    const { onPreview, onOpen } = setup();
    fireEvent.click(item('two.ts'));
    expect(onPreview).toHaveBeenCalledWith(FILES[1]);
    expect(selectedName()).toContain('two.ts');
    fireEvent.doubleClick(item('two.ts'));
    expect(onOpen).toHaveBeenCalledWith(FILES[1]);

    fireEvent.click(item('a'));
    expect(screen.queryByText('one.ts')).toBeNull();
    expect(item('a').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(item('a'));
    expect(screen.getByText('one.ts')).toBeTruthy();
  });

  it('키보드: ↑↓·Home·End 는 선택만 옮기고, ←→ 로 접고 펴며 부모로, Enter = 고정, Space = 미리보기', () => {
    const { tree, onPreview, onOpen } = setup();
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(selectedName()).toContain('api');
    fireEvent.keyDown(tree, { key: 'End' });
    expect(selectedName()).toContain('gone.txt');
    fireEvent.keyDown(tree, { key: 'Home' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(selectedName()).toContain('a');
    expect(tree.getAttribute('aria-activedescendant')).toBe(item('a').id);
    // ← 로 접고, 다시 ← 로 부모(src)로
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(item('a').getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(selectedName()).toContain('src');
    // → 는 펼친 폴더에서 첫 자식으로
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(tree.getAttribute('aria-activedescendant')).toBe(item('a').id);
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(item('a').getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(selectedName()).toContain('one.ts');
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: ' ' });
    expect(onPreview).toHaveBeenCalledWith(FILES[0]);
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(FILES[0]);
  });

  it('우클릭은 파일 행에서만 메뉴를 연다 (컨테이너가 준 항목)', async () => {
    const { menu } = setup();
    fireEvent.contextMenu(item('two.ts'));
    await tick();
    expect(menu).toHaveBeenCalledWith(FILES[1]);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['메뉴 항목']);
    expect(selectedName()).toContain('two.ts');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await tick();
    menu.mockClear();
    fireEvent.contextMenu(item('src'));
    await tick();
    expect(menu).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'src' }));
  });

  describe('가상 스크롤 (W18: 파일 수천 개짜리 커밋)', () => {
    /** `src/m<0~9>/f<NNNN>.ts` 파일 `count` 개 */
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        changed(`src/m${i % 10}/f${String(i).padStart(4, '0')}.ts`),
      );

    it('보이는 행만 그리고, 단계·형제 수·순번은 ARIA 로 알린다', () => {
      render(
        <ChangedFilesTree
          files={many(5_000)}
          root={{ name: 'api' }}
          onPreview={vi.fn()}
          onOpen={vi.fn()}
          menu={() => []}
        />,
      );
      expect(items().length).toBeGreaterThan(10);
      expect(items().length).toBeLessThan(100);
      const aria = (name: string) =>
        ['aria-level', 'aria-setsize', 'aria-posinset'].map((a) => item(name).getAttribute(a));
      expect(aria('api')).toEqual(['1', '1', '1']);
      expect(aria('src')).toEqual(['2', '1', '1']);
      expect(aria('m0')).toEqual(['3', '10', '1']);
      expect(aria('f0000.ts')).toEqual(['4', '500', '1']);
      expect(aria('f0010.ts')).toEqual(['4', '500', '2']);
    });

    it('키보드로 화면 밖 행까지 옮긴다: End 는 마지막 행을 골라 그 자리로 스크롤하고, Enter 로 연다', () => {
      const scrollTo = vi.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        value: scrollTo,
        configurable: true,
      });
      // jsdom 은 배치를 계산하지 않으므로 스크롤 높이를 안쪽 상자(가상 목록 전체 높이)의 높이로 흉내 낸다
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        get(this: HTMLElement) {
          return (
            Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? '') ||
            0
          );
        },
        configurable: true,
      });
      try {
        const files = many(5_000);
        const onOpen = vi.fn();
        render(
          <ChangedFilesTree
            files={files}
            root={{ name: 'api' }}
            onPreview={vi.fn()}
            onOpen={onOpen}
            menu={() => []}
          />,
        );
        const tree = screen.getByRole('tree', { name: S.detail.changedFiles });
        act(() => {
          fireEvent.keyDown(tree, { key: 'End' });
        });
        // 마지막 행(src/m9/f4999.ts)은 5,000 + 디렉터리 12 행 아래에 있다 — 그 자리로 스크롤을 요청한다
        const top = Math.max(
          0,
          ...scrollTo.mock.calls.map(([arg]) => (arg as { top: number }).top),
        );
        expect(top).toBeGreaterThan(5_000 * 22 - 600);
        fireEvent.keyDown(tree, { key: 'Enter' });
        expect(onOpen).toHaveBeenCalledWith(files[4_999]);
        // 그려진 행이 아니므로 activedescendant 는 비워 둔다 (가리킬 요소가 없다)
        expect(tree.getAttribute('aria-activedescendant')).toBeNull();
      } finally {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      }
    });
  });
});
