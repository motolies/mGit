import type { FsEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RowStatus } from '../features/project/file-status';
import { ProjectTree, type ProjectTreeProps } from '../features/project/ProjectTree';
import { type RowDecoration, repoDecoration } from '../features/project/project-rows';
import { flattenProjectTree } from '../features/project/project-tree-model';
import { type DirMap, type ExpandedSet, noteRowId, rangeSelection } from '../store/file-tree';
import { tick } from './dialog-stub';

beforeAll(() => {
  // 가상 스크롤이 보이는 높이를 알도록 (jsdom 은 배치를 계산하지 않는다)
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 300 });
});

afterEach(cleanup);

const ROOT = '/w/acme';

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file', openable = kind === 'file'): FsEntry {
  return { name, kind, size: 1, mtimeMs: 0, openable };
}

/** 읽은 디렉터리 */
function listed(entries: FsEntry[], extra: { total?: number; nonUtf8Names?: number } = {}) {
  const total = extra.total ?? entries.length;
  return {
    load: {
      state: 'listed' as const,
      entries,
      total,
      truncated: total > entries.length,
      nonUtf8Names: extra.nonUtf8Names ?? 0,
    },
    limit: null,
    pending: false,
  };
}

const DIRS: DirMap = {
  '': listed([
    entry('.claude', 'dir'),
    entry('api', 'dir'),
    entry('broken', 'dir'),
    entry('logs', 'dir'),
    entry('private', 'dir'),
    entry('current', 'symlink', false),
    entry('agent.sock', 'other', false),
    entry('README.md'),
  ]),
  api: listed([entry('src', 'dir'), entry('pom.xml')]),
  'api/src': listed([entry('Main.java')]),
  logs: listed([entry('a.log'), entry('b.log')], { total: 2_402, nonUtf8Names: 2 }),
  private: { load: { state: 'error', error: 'EIO' }, limit: null, pending: false },
};

/** 저장소 장식: api 는 behind 54, broken 은 요약 실패 */
function decorate(path: string) {
  if (path === 'api') {
    return repoDecoration(
      { path: `${ROOT}/api`, kind: 'standalone' },
      {
        path: `${ROOT}/api`,
        name: 'api',
        kind: 'standalone',
        color: 0,
        branch: 'development',
        detached: false,
        changed: 2,
        conflicted: 0,
        ahead: 0,
        behind: 54,
        op: 'rebase',
        lastFetch: null,
        error: null,
      },
    );
  }
  if (path === 'broken') {
    return repoDecoration(
      { path: `${ROOT}/broken`, kind: 'worktree' },
      {
        path: `${ROOT}/broken`,
        name: 'broken',
        kind: 'worktree',
        color: 0,
        branch: null,
        detached: false,
        changed: 0,
        conflicted: 0,
        ahead: null,
        behind: null,
        op: null,
        lastFetch: null,
        error: 'bad index',
      },
    );
  }
  return null;
}

/** 콜백 묶음 */
function spies() {
  return {
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onRescan: vi.fn(),
    onLocate: vi.fn(),
  };
}

/** 펼침·선택을 스스로 가진 컨테이너 흉내 (키보드 흐름을 끝까지 따라가 본다) */
function Harness({
  calls,
  initialExpanded = { '': true },
  initialSelected = null,
  extra = {},
}: {
  calls: ReturnType<typeof spies>;
  initialExpanded?: ExpandedSet;
  initialSelected?: string | null;
  extra?: Partial<ProjectTreeProps>;
}) {
  const [expanded, setExpanded] = useState<ExpandedSet>(initialExpanded);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  return (
    <ProjectTree
      root={{ name: 'acme', detail: ROOT }}
      rows={flattenProjectTree(DIRS, expanded)}
      selected={selected}
      decorate={decorate}
      menu={(row) =>
        row.kind === 'entry' && row.path === 'api' ? [{ label: S.project.openAsTab }] : []
      }
      busy={false}
      {...calls}
      onSelect={(id) => {
        calls.onSelect(id);
        setSelected(id);
      }}
      onToggle={(path) => {
        calls.onToggle(path);
        setExpanded((prev) => {
          const next = { ...prev };
          if (next[path]) {
            delete next[path];
          } else {
            next[path] = true;
          }
          return next;
        });
      }}
      {...extra}
    />
  );
}

/** 이름이 그 글자인 행 */
const rowNamed = (name: string) =>
  screen.getAllByRole('treeitem').find((r) => r.textContent?.startsWith(name)) as HTMLElement;
/** 트리 */
const tree = () => screen.getByRole('tree', { name: S.project.tree });
/** 키를 누른다 */
const press = (key: string) => fireEvent.keyDown(tree(), { key });

describe('ProjectTree — 행 (PT-01·02·09)', () => {
  it('루트 행은 굵은 이름과 회색 경로, 저장소 행은 W3 간이 트리와 같은 장식을 그린다', () => {
    render(<Harness calls={spies()} />);
    const root = screen.getAllByRole('treeitem')[0] as HTMLElement;
    expect(root.textContent).toBe(`acme${ROOT}`);
    expect(root.getAttribute('aria-expanded')).toBe('true');
    const api = rowNamed('api');
    expect(within(api).getByText('development')).toBeTruthy();
    expect(within(api).getByText('54↓')).toBeTruthy();
    expect(within(api).getByText('리베이스 중')).toBeTruthy();
    expect(within(api).getByText(S.project.changed(2))).toBeTruthy();
    const broken = rowNamed('broken');
    expect(within(broken).getByText(S.folder.kind.worktree)).toBeTruthy();
    expect(
      within(broken).getByRole('img', { name: S.project.summaryFailed('bad index') }),
    ).toBeTruthy();
    // 점 폴더도 보인다 (나열 결과 그대로)
    expect(rowNamed('.claude')).toBeTruthy();
  });

  it('링크·특수 파일은 펼치지도 열지도 못하고 흐리게, 툴팁으로 이유를 알린다', () => {
    const calls = spies();
    render(<Harness calls={calls} />);
    const link = rowNamed('current');
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('data-inert')).toBe('true');
    expect(link.getAttribute('title')).toBe(S.project.symlink);
    expect(link.getAttribute('aria-expanded')).toBeNull();
    expect(rowNamed('agent.sock').getAttribute('title')).toBe(S.project.special);
    fireEvent.click(link);
    fireEvent.doubleClick(link);
    expect(calls.onSelect).toHaveBeenCalledWith('current');
    expect(calls.onOpenFile).not.toHaveBeenCalled();
    expect(calls.onToggle).not.toHaveBeenCalled();
  });

  it('잘린 디렉터리의 "더 보기" 줄과 이름을 읽을 수 없는 항목 안내, 오류 줄의 다시 시도', () => {
    const calls = spies();
    render(<Harness calls={calls} initialExpanded={{ '': true, logs: true, private: true }} />);
    const more = screen.getByText(S.project.more(2_400));
    expect(screen.getByText(S.project.nonUtf8Names(2))).toBeTruthy();
    fireEvent.click(more);
    expect(calls.onLoadMore).toHaveBeenCalledWith('logs');
    expect(calls.onSelect).toHaveBeenLastCalledWith(noteRowId('more', 'logs'));
    expect(screen.getByText(S.project.failed('EIO'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: S.project.retry }));
    expect(calls.onRetry).toHaveBeenCalledWith('private');
  });

  it('행마다 단계·형제 수·순번을 ARIA 로 싣고, 고른 행을 활성 항목으로 알린다', () => {
    render(
      <Harness
        calls={spies()}
        initialExpanded={{ '': true, api: true }}
        initialSelected="api/pom.xml"
      />,
    );
    const pom = rowNamed('pom.xml');
    expect(pom.getAttribute('aria-level')).toBe('3');
    expect(pom.getAttribute('aria-setsize')).toBe('2');
    expect(pom.getAttribute('aria-posinset')).toBe('2');
    expect(pom.getAttribute('aria-selected')).toBe('true');
    expect(tree().getAttribute('aria-activedescendant')).toBe(pom.id);
    expect(rowNamed('api').getAttribute('aria-posinset')).toBe('2');
    expect(rowNamed('api').getAttribute('aria-setsize')).toBe('8');
  });
});

describe('ProjectTree — 동작 (PT-04·05)', () => {
  it('파일 단일 클릭 = 미리보기, 더블클릭 = 고정. 디렉터리 클릭 = 고르기 + 펼침 토글', () => {
    const calls = spies();
    render(<Harness calls={calls} />);
    fireEvent.click(rowNamed('README.md'));
    expect(calls.onSelect).toHaveBeenLastCalledWith('README.md');
    expect(calls.onOpenFile).toHaveBeenLastCalledWith('README.md', 'preview');
    fireEvent.doubleClick(rowNamed('README.md'));
    expect(calls.onOpenFile).toHaveBeenLastCalledWith('README.md', 'pinned');

    fireEvent.click(rowNamed('api'));
    expect(calls.onSelect).toHaveBeenLastCalledWith('api');
    expect(calls.onToggle).toHaveBeenLastCalledWith('api');
    expect(rowNamed('pom.xml')).toBeTruthy();
    // 더블클릭의 두 번째 클릭은 고르기만 한다 (펼침이 두 번 뒤집히지 않는다)
    fireEvent.click(rowNamed('api'), { detail: 2 });
    expect(calls.onToggle).toHaveBeenCalledTimes(1);
  });

  it('키보드: ↓↑ 이동, → 펼침·첫 자식, ← 부모·접기, Home·End', () => {
    const calls = spies();
    render(<Harness calls={calls} initialSelected="" />);
    press('ArrowDown');
    press('ArrowDown');
    expect(calls.onSelect).toHaveBeenLastCalledWith('api');
    press('ArrowRight');
    expect(calls.onToggle).toHaveBeenLastCalledWith('api');
    press('ArrowRight');
    expect(calls.onSelect).toHaveBeenLastCalledWith('api/src');
    press('ArrowLeft');
    expect(calls.onSelect).toHaveBeenLastCalledWith('api');
    press('ArrowLeft');
    expect(calls.onToggle).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('pom.xml')).toBeNull();
    press('End');
    expect(calls.onSelect).toHaveBeenLastCalledWith('README.md');
    press('ArrowDown');
    expect(calls.onSelect).toHaveBeenLastCalledWith('README.md');
    press('Home');
    expect(calls.onSelect).toHaveBeenLastCalledWith('');
    press('ArrowUp');
    expect(calls.onSelect).toHaveBeenLastCalledWith('');
    // 루트에서 ← 는 루트를 접는다
    press('ArrowLeft');
    expect(calls.onToggle).toHaveBeenLastCalledWith('');
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
  });

  it('Enter: 파일은 고정, 디렉터리는 토글, 더 보기·오류 줄은 그 동작. Space: 파일은 미리보기', () => {
    const calls = spies();
    render(
      <Harness
        calls={calls}
        initialExpanded={{ '': true, logs: true, private: true }}
        initialSelected="README.md"
      />,
    );
    press('Enter');
    expect(calls.onOpenFile).toHaveBeenLastCalledWith('README.md', 'pinned');
    press(' ');
    expect(calls.onOpenFile).toHaveBeenLastCalledWith('README.md', 'preview');
    press('Home');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(calls.onToggle).toHaveBeenLastCalledWith('api');
    cleanup();

    const notes = spies();
    render(
      <Harness
        calls={notes}
        initialExpanded={{ '': true, logs: true, private: true }}
        initialSelected={noteRowId('more', 'logs')}
      />,
    );
    press('Enter');
    expect(notes.onLoadMore).toHaveBeenCalledWith('logs');
    press('ArrowDown');
    press('ArrowDown');
    expect(notes.onSelect).toHaveBeenLastCalledWith(noteRowId('status', 'private'));
    press('Enter');
    expect(notes.onRetry).toHaveBeenCalledWith('private');
    // 링크는 Enter 로도 열리지 않는다
    press('ArrowDown');
    press('Enter');
    expect(notes.onOpenFile).not.toHaveBeenCalled();
  });

  it('저장소 행 우클릭은 그 행을 고르고 메뉴를 연다. 메뉴가 없는 행은 열지 않는다', async () => {
    const calls = spies();
    render(<Harness calls={calls} />);
    fireEvent.contextMenu(rowNamed('README.md'));
    await tick();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(rowNamed('api'));
    await tick();
    expect(calls.onSelect).toHaveBeenLastCalledWith('api');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      S.project.openAsTab,
    ]);
  });

  it('머리줄: 새로고침·다시 스캔·트리에서 찾기. 읽는 중에는 막고, 주지 않은 버튼은 없다', () => {
    const calls = spies();
    const view = render(<Harness calls={calls} extra={{ locateDisabled: true }} />);
    fireEvent.click(screen.getByRole('button', { name: S.folder.refresh }));
    fireEvent.click(screen.getByRole('button', { name: S.folder.rescan }));
    expect(calls.onRefresh).toHaveBeenCalledTimes(1);
    expect(calls.onRescan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: S.project.locate }).disabled).toBe(
      true,
    );
    view.rerender(
      <Harness calls={calls} extra={{ busy: true, onRescan: undefined, onLocate: undefined }} />,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: S.folder.refresh }).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: S.folder.rescan })).toBeNull();
    expect(screen.queryByRole('button', { name: S.project.locate })).toBeNull();
  });

  it('안내 한 줄(저장소 없음)을 트리 위에 보인다', () => {
    render(<Harness calls={spies()} extra={{ notice: S.folder.empty }} />);
    expect(screen.getByText(S.folder.empty)).toBeTruthy();
  });

  it('가상 스크롤: 행이 수천 개여도 보이는 만큼만 DOM 에 있고, 키보드로 옮긴 행은 보이게 스크롤한다', () => {
    const many: DirMap = {
      '': listed(Array.from({ length: 3_000 }, (_, i) => entry(`f${String(i).padStart(4, '0')}`))),
    };
    const onSelect = vi.fn();
    render(
      <ProjectTree
        root={{ name: 'acme', detail: ROOT }}
        rows={flattenProjectTree(many, { '': true })}
        selected="f0000"
        decorate={() => null}
        menu={() => []}
        busy={false}
        {...spies()}
        onSelect={onSelect}
      />,
    );
    const rendered = screen.getAllByRole('treeitem').length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(100);
    act(() => {
      press('End');
    });
    expect(onSelect).toHaveBeenLastCalledWith('f2999');
  });
});

/** 선택 집합·기준 행·범위 시작 행을 스스로 가진 컨테이너 흉내 */
function Multi({
  calls,
  initial = [],
  expanded = { '': true },
}: {
  calls: ReturnType<typeof spies> & {
    onToggleSelect: (id: string) => void;
    onSelectRange: (id: string) => void;
  };
  initial?: string[];
  expanded?: ExpandedSet;
}) {
  const [state, setState] = useState({
    selection: Object.fromEntries(initial.map((id) => [id, true as const])),
    selected: initial.at(-1) ?? null,
    anchor: initial.at(-1) ?? null,
  });
  const rows = flattenProjectTree(DIRS, expanded);
  return (
    <ProjectTree
      root={{ name: 'acme', detail: ROOT }}
      rows={rows}
      selected={state.selected}
      selection={state.selection}
      decorate={decorate}
      menu={(row) => (row.kind === 'entry' ? [{ label: `메뉴:${row.path}` }] : [])}
      busy={false}
      {...calls}
      onSelect={(id) => {
        calls.onSelect(id);
        setState({ selection: { [id]: true }, selected: id, anchor: id });
      }}
      onToggleSelect={(id) => {
        calls.onToggleSelect(id);
        setState((prev) => {
          const selection = { ...prev.selection };
          if (selection[id]) {
            delete selection[id];
          } else {
            selection[id] = true;
          }
          return { selection, selected: id, anchor: id };
        });
      }}
      onSelectRange={(id) => {
        calls.onSelectRange(id);
        setState((prev) => {
          const order = rows.map((r) => r.id);
          const range = rangeSelection(order, prev.anchor ?? id, id);
          return {
            selection: Object.fromEntries(range.map((x) => [x, true as const])),
            selected: id,
            anchor: prev.anchor,
          };
        });
      }}
    />
  );
}

describe('ProjectTree — 다중 선택 (PT-07)', () => {
  const multiSpies = () => ({ ...spies(), onToggleSelect: vi.fn(), onSelectRange: vi.fn() });
  // 우클릭 메뉴가 열려 있으면 나머지가 aria-hidden 이 되므로 숨은 것까지 본다
  const selectedNames = () =>
    screen
      .getAllByRole('treeitem', { hidden: true })
      .filter((r) => r.getAttribute('aria-selected') === 'true')
      .map((r) => r.querySelector('span[title]')?.textContent);

  it('⌘클릭은 하나씩 더하고 빼며 펼치거나 열지 않는다. 트리는 다중 선택을 알린다', () => {
    const calls = multiSpies();
    render(<Multi calls={calls} />);
    expect(tree().getAttribute('aria-multiselectable')).toBe('true');
    fireEvent.click(rowNamed('api'));
    fireEvent.click(rowNamed('README.md'), { metaKey: true });
    fireEvent.click(rowNamed('logs'), { ctrlKey: true });
    expect(selectedNames()).toEqual(['api', 'logs', 'README.md']);
    expect(calls.onOpenFile).not.toHaveBeenCalled();
    // 그냥 클릭의 펼침 한 번뿐
    expect(calls.onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(rowNamed('logs'), { metaKey: true });
    expect(selectedNames()).toEqual(['api', 'README.md']);
    // 기준 행(키보드 포커스)은 마지막으로 누른 행이다
    expect(tree().getAttribute('aria-activedescendant')).toBe(rowNamed('logs').id);
  });

  it('⇧클릭은 기준 행부터 범위를 고르고, ⌘·⇧ 더블클릭은 파일을 열지 않는다', () => {
    const calls = multiSpies();
    render(<Multi calls={calls} initial={['broken']} />);
    fireEvent.click(rowNamed('agent.sock'), { shiftKey: true });
    expect(calls.onSelectRange).toHaveBeenLastCalledWith('agent.sock');
    expect(selectedNames()).toEqual(['broken', 'logs', 'private', 'current', 'agent.sock']);
    fireEvent.click(rowNamed('README.md'), { shiftKey: true });
    fireEvent.doubleClick(rowNamed('README.md'), { shiftKey: true });
    fireEvent.doubleClick(rowNamed('README.md'), { metaKey: true });
    expect(calls.onOpenFile).not.toHaveBeenCalled();
    expect(selectedNames()).toHaveLength(6);
  });

  it('⇧↓·⇧↑ 는 범위를 넓히고 줄인다. 그냥 화살표는 한 행만 고른다', () => {
    const calls = multiSpies();
    render(<Multi calls={calls} initial={['api']} />);
    fireEvent.keyDown(tree(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(tree(), { key: 'ArrowDown', shiftKey: true });
    expect(selectedNames()).toEqual(['api', 'broken', 'logs']);
    fireEvent.keyDown(tree(), { key: 'ArrowUp', shiftKey: true });
    expect(selectedNames()).toEqual(['api', 'broken']);
    press('ArrowDown');
    expect(selectedNames()).toEqual(['logs']);
  });

  it('우클릭: 고른 행 위면 선택을 그대로 두고, 밖의 행이면 그 행만 고른다', async () => {
    const calls = multiSpies();
    render(<Multi calls={calls} initial={['api', 'logs']} />);
    fireEvent.contextMenu(rowNamed('api'));
    await tick();
    expect(calls.onSelect).not.toHaveBeenCalled();
    expect(selectedNames()).toEqual(['api', 'logs']);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.contextMenu(rowNamed('README.md'));
    await tick();
    expect(calls.onSelect).toHaveBeenLastCalledWith('README.md');
    expect(selectedNames()).toEqual(['README.md']);
  });
});

describe('ProjectTree — 파일 상태와 날짜·크기 (PT-06·10, LF-05)', () => {
  const NOW = new Date(2026, 10, 18, 14, 50).getTime();
  const status = (tone: RowStatus['tone'], letter: string | null, title: string): RowStatus => ({
    tone,
    letter,
    title,
  });
  /** README.md 는 수정, pom.xml 은 충돌, api 는 안에 변경 있음 (저장소 장식도 그대로) */
  const decorateWithStatus = (path: string): RowDecoration | null => {
    if (path === 'README.md') {
      return { status: status('modified', 'M', '수정됨') };
    }
    if (path === 'api/pom.xml') {
      return { status: status('conflict', 'U', '충돌') };
    }
    const repo = decorate(path);
    return path === 'api' ? { ...repo, status: status('modified', null, '안에 변경') } : repo;
  };
  const DATED: DirMap = {
    ...DIRS,
    '': listed([
      entry('api', 'dir'),
      { name: 'README.md', kind: 'file', size: 1_536, mtimeMs: NOW - 5 * 60_000, openable: true },
    ]),
  };

  it('상태는 행의 색 갈래와 행 끝 상태 문자·툴팁, 충돌은 ⚠ 로도 보인다. 디렉터리는 색만 (문자 없음)', () => {
    render(
      <ProjectTree
        root={{ name: 'acme', detail: ROOT }}
        rows={flattenProjectTree(DATED, { '': true, api: true })}
        selected={null}
        decorate={decorateWithStatus}
        menu={() => []}
        busy={false}
        {...spies()}
      />,
    );
    const readme = rowNamed('README.md');
    expect(readme.getAttribute('data-status')).toBe('modified');
    const letter = within(readme).getByTitle('수정됨');
    expect(letter.textContent).toBe('M');
    // 이름의 툴팁에도 상태를 쓴다 (색을 못 봐도 알 수 있게)
    expect(within(readme).getByText('README.md').getAttribute('title')).toBe('README.md\n수정됨');
    const pom = rowNamed('pom.xml');
    expect(pom.getAttribute('data-status')).toBe('conflict');
    expect(within(pom).getByTitle('충돌').textContent).toBe('U');
    expect(pom.querySelector('.codicon-warning')).not.toBeNull();
    const api = rowNamed('api');
    expect(api.getAttribute('data-status')).toBe('modified');
    // 저장소 장식은 그대로 있고 상태 문자는 없다
    expect(within(api).getByText('54↓')).toBeTruthy();
    expect(within(api).queryByTitle('안에 변경')).toBeNull();
  });

  it('기준 시각을 주면 파일 행에만 `날짜, 크기` 를 쓰고, 주지 않으면 쓰지 않는다', () => {
    const props = {
      root: { name: 'acme', detail: ROOT },
      rows: flattenProjectTree(DATED, { '': true }),
      selected: null,
      decorate: () => null,
      menu: () => [],
      busy: false,
      ...spies(),
    };
    const view = render(<ProjectTree {...props} now={NOW} />);
    expect(rowNamed('README.md').textContent).toBe('README.md5분 전, 1.5 KB');
    expect(rowNamed('api').textContent).toBe('api');
    view.rerender(<ProjectTree {...props} />);
    expect(rowNamed('README.md').textContent).toBe('README.md');
  });
});
