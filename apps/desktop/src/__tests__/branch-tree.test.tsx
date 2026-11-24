import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../components/ContextMenu';
import { BranchToolbar, type BranchToolbarProps } from '../features/branches/BranchToolbar';
import { BranchTree, type BranchTreeProps } from '../features/branches/BranchTree';
import type { BranchTreeExpansion, BranchTreeNode } from '../features/branches/branch-tree-model';
import { tick } from './dialog-stub';

const NODES: BranchTreeNode[] = [
  { id: 'head', kind: 'head', label: 'HEAD (현재 브랜치)' },
  {
    id: 'group:local',
    kind: 'group',
    label: '로컬',
    count: 3,
    children: [
      {
        id: 'ref:refs/heads/develop',
        kind: 'local',
        label: 'develop',
        fullName: 'refs/heads/develop',
        current: true,
        favoritable: true,
        suffix: '(api, web)',
      },
      {
        id: 'ref:refs/heads/main',
        kind: 'local',
        label: 'main',
        fullName: 'refs/heads/main',
        current: 'partial',
        favorite: true,
        favoritable: true,
        suffix: '(api, web, docs)',
      },
      {
        id: 'ref:refs/heads/feature/x',
        kind: 'local',
        label: 'feature/x',
        fullName: 'refs/heads/feature/x',
        favoritable: true,
        suffix: '(web)',
      },
    ],
  },
  {
    id: 'group:remote',
    kind: 'group',
    label: '원격',
    count: 2,
    children: [
      {
        id: 'ref:refs/remotes/origin/main',
        kind: 'remote',
        label: 'origin/main',
        fullName: 'refs/remotes/origin/main',
        favorite: true,
        favoritable: true,
        suffix: '(api)',
      },
      {
        id: 'ref:refs/remotes/origin/feature/x',
        kind: 'remote',
        label: 'origin/feature/x',
        fullName: 'refs/remotes/origin/feature/x',
        favoritable: true,
        suffix: '(web)',
      },
    ],
  },
];

type Overrides = Partial<BranchTreeProps> & { initialExpansion?: BranchTreeExpansion };

/** 펼침 상태를 들고 있는 바깥 (실제로는 컨테이너가 든다) */
function Harness({
  initialExpansion,
  onExpansionChange,
  ...props
}: Omit<BranchTreeProps, 'expansion'> & { initialExpansion: BranchTreeExpansion }) {
  const [expansion, setExpansion] = useState(initialExpansion);
  return (
    <BranchTree
      {...props}
      expansion={expansion}
      onExpansionChange={(next) => {
        onExpansionChange(next);
        setExpansion(next);
      }}
    />
  );
}

/** 트리를 그리고 콜백을 돌려준다 */
function setup(overrides: Overrides = {}) {
  const { initialExpansion, ...props } = overrides;
  const onActivate = vi.fn();
  const onOpen = vi.fn();
  const onToggleFavorite = vi.fn();
  const onExpansionChange = vi.fn();
  render(
    <Harness
      nodes={NODES}
      selectedIds={[]}
      initialExpansion={initialExpansion ?? {}}
      onExpansionChange={onExpansionChange}
      onActivate={onActivate}
      onOpen={onOpen}
      menu={() => []}
      onToggleFavorite={onToggleFavorite}
      {...props}
    />,
  );
  return { onActivate, onOpen, onToggleFavorite, onExpansionChange };
}

const tree = () => screen.getByRole('tree', { name: S.branches.tree });
const items = () => screen.getAllByRole('treeitem');
/** 보이는 행의 이름 (행의 `data-node-id`) */
const ids = () => items().map((el) => el.getAttribute('data-node-id'));
/** 이름으로 행을 찾는다 */
const row = (id: string) => {
  const el = items().find((item) => item.getAttribute('data-node-id') === id);
  if (!el) {
    throw new Error(`행 없음: ${id}`);
  }
  return el;
};
/** 키보드 커서가 있는 행의 노드 id */
const cursor = () => {
  const id = tree().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.getAttribute('data-node-id') : null;
};
const key = (name: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(tree(), { key: name, ...init });
/** 노드를 인자로 받은 호출의 노드 id 들 */
const calledIds = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((call) => (call[0] as BranchTreeNode).id);

afterEach(cleanup);

describe('BranchTree 렌더 (BT-01·02)', () => {
  it('검색 입력과 트리를 그리고 행에 단계·펼침·선택을 싣는다', () => {
    setup({
      multiselectable: true,
      selectedIds: ['ref:refs/heads/main', 'ref:refs/remotes/origin/main'],
    });
    expect(screen.getByRole('searchbox', { name: S.branches.search })).toBeTruthy();
    expect(tree().getAttribute('aria-multiselectable')).toBe('true');
    expect(tree().getAttribute('tabindex')).toBe('0');
    expect(ids()).toEqual([
      'head',
      'group:local',
      'ref:refs/heads/develop',
      'ref:refs/heads/main',
      'ref:refs/heads/feature/x',
      'group:remote',
      'ref:refs/remotes/origin/main',
      'ref:refs/remotes/origin/feature/x',
    ]);
    expect(items().map((el) => el.getAttribute('aria-level'))).toEqual([
      '1',
      '1',
      '2',
      '2',
      '2',
      '1',
      '2',
      '2',
    ]);
    // 펼침 표시는 그룹에만 있다
    expect(items().map((el) => el.getAttribute('aria-expanded'))).toEqual([
      null,
      'true',
      null,
      null,
      null,
      'true',
      null,
      null,
    ]);
    expect(
      items()
        .filter((el) => el.getAttribute('aria-selected') === 'true')
        .map((el) => el.getAttribute('data-node-id')),
    ).toEqual(['ref:refs/heads/main', 'ref:refs/remotes/origin/main']);
  });

  it('잎은 이름과 회색 글자를 쓰고, 넘칠 때를 위해 전체를 툴팁에 둔다. 그룹은 개수를 쓴다', () => {
    setup();
    const main = row('ref:refs/heads/main');
    expect(main.textContent).toBe('main(api, web, docs)');
    expect(main.getAttribute('title')).toBe('main (api, web, docs)');
    expect(row('group:local').textContent).toBe('로컬3');
    expect(row('head').getAttribute('title')).toBe('HEAD (현재 브랜치)');
  });

  it('아이콘은 현재 > 즐겨찾기 > 종류 순으로 고르고, 일부 저장소에서만 현재면 약하게 그린다', () => {
    setup();
    const tone = (id: string) => row(id).querySelector('[data-tone]');
    expect(tone('ref:refs/heads/develop')?.getAttribute('data-tone')).toBe('head');
    expect(tone('ref:refs/heads/develop')?.getAttribute('title')).toBe(S.branches.current);
    // 즐겨찾기이기도 하지만 현재 표시가 먼저다
    expect(tone('ref:refs/heads/main')?.getAttribute('data-tone')).toBe('partial');
    expect(tone('ref:refs/heads/main')?.getAttribute('title')).toBe(S.branches.currentPartial);
    expect(tone('ref:refs/heads/feature/x')?.getAttribute('data-tone')).toBe('local');
    expect(tone('ref:refs/remotes/origin/main')?.getAttribute('data-tone')).toBe('favorite');
    expect(tone('ref:refs/remotes/origin/feature/x')?.getAttribute('data-tone')).toBe('remote');
    // HEAD 행과 그룹은 아이콘 없이 이름만 쓴다
    expect(tone('head')).toBeNull();
    expect(tone('group:local')).toBeNull();
    // 모든 저장소에서 현재인 행만 현재 항목으로 알린다
    expect(row('ref:refs/heads/develop').getAttribute('aria-current')).toBe('true');
    expect(row('ref:refs/heads/main').getAttribute('aria-current')).toBeNull();
  });

  it('업스트림 차이와 배지를 그린다 (저장소 탭의 노드)', () => {
    setup({
      nodes: [
        {
          id: 'ref:refs/heads/topic',
          kind: 'local',
          label: 'topic',
          track: { ahead: 3, behind: 1, gone: false },
          badges: [{ icon: 'radarConflict', text: '2', title: '충돌 2개' }],
        },
        {
          id: 'ref:refs/heads/old',
          kind: 'local',
          label: 'old',
          track: { ahead: 0, behind: 0, gone: true },
          badges: [{ icon: 'worktree', title: '워크트리: /w/old' }],
        },
        { id: 'ref:refs/tags/v1', kind: 'tag', label: 'v1' },
      ],
    });
    // 받을 것(⇣)이 먼저, 보낼 것(⇡)이 다음이다 (BT-08)
    expect(row('ref:refs/heads/topic').textContent).toBe('topic⇣1⇡32');
    const marks = [...row('ref:refs/heads/topic').querySelectorAll('[data-dir]')];
    expect(marks.map((el) => [el.getAttribute('data-dir'), el.textContent])).toEqual([
      ['incoming', S.branches.incoming(1)],
      ['outgoing', S.branches.outgoing(3)],
    ]);
    expect(within(row('ref:refs/heads/topic')).getByTitle('충돌 2개')).toBeTruthy();
    expect(row('ref:refs/heads/old').textContent).toBe(`old${S.sidebar.gone}`);
    expect(within(row('ref:refs/heads/old')).getByTitle('워크트리: /w/old')).toBeTruthy();
    expect(row('ref:refs/tags/v1').querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(
      'tag',
    );
  });

  it('툴팁: 현재 표시와 업스트림 차이에 받은 문구를 쓰고, 행 툴팁에도 덧붙인다 (BT-08)', () => {
    setup({
      nodes: [
        {
          id: 'ref:refs/heads/main',
          kind: 'local',
          label: 'main',
          suffix: '(api, web)',
          current: 'partial',
          currentTitle: '현재 branch: api',
          track: { ahead: 3, behind: 54, gone: false },
          trackTitle: 'api: ⇣54\nweb: ⇡3',
        },
        { id: 'ref:refs/heads/plain', kind: 'local', label: 'plain', current: 'partial' },
      ],
    });
    const main = row('ref:refs/heads/main');
    expect(main.querySelector('[data-tone="partial"]')?.getAttribute('title')).toBe(
      '현재 branch: api',
    );
    // 업스트림 차이 묶음(방향 표시들의 부모)에 저장소별 수치를 툴팁으로 단다
    const marks = main.querySelector('[data-dir]')?.parentElement;
    expect(marks?.getAttribute('title')).toBe('api: ⇣54\nweb: ⇡3');
    expect(marks?.textContent).toBe('⇣54⇡3');
    expect(main.getAttribute('title')).toBe('main (api, web)\n현재 branch: api\napi: ⇣54\nweb: ⇡3');
    // 받은 문구가 없으면 기본 문구와 이름만 쓴다
    const plain = row('ref:refs/heads/plain');
    expect(plain.querySelector('[data-tone="partial"]')?.getAttribute('title')).toBe(
      S.branches.currentPartial,
    );
    expect(plain.getAttribute('title')).toBe('plain');
  });

  it('덧붙인 설명(detail)은 툴팁이 필요할 때만 만든다: 마우스가 올라갈 때, 키보드 커서 행 (tag 원격별 상태)', () => {
    const detail = vi.fn(() => 'origin: 다름');
    setup({
      nodes: [
        { id: 'ref:refs/tags/v2', kind: 'tag', label: 'v2', detail },
        { id: 'ref:refs/tags/v1', kind: 'tag', label: 'v1', suffix: 'push 안 됨', detail },
      ],
    });
    // 그리기만 해서는 만들지 않는다
    expect(detail).not.toHaveBeenCalled();
    expect(row('ref:refs/tags/v1').getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(row('ref:refs/tags/v1'));
    expect(row('ref:refs/tags/v1').getAttribute('title')).toBe('v1 push 안 됨\norigin: 다름');
    expect(detail).toHaveBeenCalledTimes(1);
    // 키보드 커서 행은 렌더에서 툴팁을 단다 (보조 기술이 설명으로 읽는다). 커서가 떠나면 다시 늦게 만든다
    act(() => tree().focus());
    key('ArrowDown');
    expect(cursor()).toBe('ref:refs/tags/v2');
    expect(row('ref:refs/tags/v2').getAttribute('title')).toBe('v2\norigin: 다름');
    key('ArrowDown');
    expect(cursor()).toBe('ref:refs/tags/v1');
    expect(row('ref:refs/tags/v2').getAttribute('title')).toBeNull();
    expect(row('ref:refs/tags/v1').getAttribute('title')).toBe('v1 push 안 됨\norigin: 다름');
  });

  it('노드가 없으면 빈 상태 문구를 쓴다 (읽는 중이면 받은 문구)', () => {
    setup({ nodes: [] });
    expect(screen.getByText(S.branches.empty)).toBeTruthy();
    expect(screen.queryAllByRole('treeitem')).toEqual([]);
    cleanup();
    setup({ nodes: [], emptyText: '읽는 중…' });
    expect(screen.getByText('읽는 중…')).toBeTruthy();
  });
});

describe('BranchTree 마우스 (BT-03·12)', () => {
  it('잎을 누르면 onActivate, ⌘/Ctrl 과 함께면 additive 로 알린다', () => {
    const { onActivate, onOpen } = setup();
    fireEvent.click(row('ref:refs/heads/main'));
    fireEvent.click(row('ref:refs/heads/feature/x'), { metaKey: true });
    fireEvent.click(row('ref:refs/remotes/origin/main'), { ctrlKey: true });
    fireEvent.click(row('head'));
    expect(onActivate.mock.calls.map(([node, options]) => [node.id, options])).toEqual([
      ['ref:refs/heads/main', { additive: false }],
      ['ref:refs/heads/feature/x', { additive: true }],
      ['ref:refs/remotes/origin/main', { additive: true }],
      ['head', { additive: false }],
    ]);
    expect(onOpen).not.toHaveBeenCalled();
    // 누른 행으로 키보드 커서가 간다
    expect(cursor()).toBe('head');
  });

  it('잎을 더블클릭하면 onOpen 으로 알린다', () => {
    const { onOpen } = setup();
    fireEvent.doubleClick(row('ref:refs/heads/main'));
    expect(calledIds(onOpen)).toEqual(['ref:refs/heads/main']);
  });

  it('그룹을 누르면 접고 펴기만 한다 (onActivate·onOpen 을 부르지 않는다)', () => {
    const { onActivate, onOpen, onExpansionChange } = setup();
    fireEvent.click(row('group:local'));
    expect(onExpansionChange).toHaveBeenLastCalledWith({ 'group:local': false });
    expect(row('group:local').getAttribute('aria-expanded')).toBe('false');
    expect(ids()).toEqual([
      'head',
      'group:local',
      'group:remote',
      'ref:refs/remotes/origin/main',
      'ref:refs/remotes/origin/feature/x',
    ]);
    fireEvent.click(row('group:local'));
    expect(onExpansionChange).toHaveBeenLastCalledWith({ 'group:local': true });
    expect(ids()).toHaveLength(8);
    fireEvent.doubleClick(row('group:remote'));
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('즐겨찾기할 수 있는 행에만 별 버튼이 있고, 누르면 onToggleFavorite 만 부른다', () => {
    const { onActivate, onOpen, onToggleFavorite } = setup();
    expect(within(row('head')).queryByRole('button')).toBeNull();
    expect(within(row('group:local')).queryByRole('button')).toBeNull();

    const add = within(row('ref:refs/heads/feature/x')).getByRole('button', {
      name: S.branches.addFavorite,
    });
    expect(add.getAttribute('aria-pressed')).toBe('false');
    // 행마다 탭 정지를 만들지 않는다
    expect(add.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(add);
    const remove = within(row('ref:refs/heads/main')).getByRole('button', {
      name: S.branches.removeFavorite,
    });
    expect(remove.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(remove);
    fireEvent.doubleClick(remove);
    expect(calledIds(onToggleFavorite)).toEqual([
      'ref:refs/heads/feature/x',
      'ref:refs/heads/main',
    ]);
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('우클릭 메뉴의 항목은 컨테이너가 준 것이고, 항목이 없는 노드에서는 메뉴를 열지 않는다', async () => {
    const onSelect = vi.fn();
    const menu = (node: BranchTreeNode): MenuItem[] =>
      node.kind === 'local' ? [{ label: `열기 ${node.label}`, onSelect }, { label: '복사' }] : [];
    setup({ menu });
    fireEvent.contextMenu(row('head'));
    await tick();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(row('group:local'));
    await tick();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(row('ref:refs/heads/main'));
    await tick();
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      '열기 main',
      '복사',
    ]);
    // 우클릭한 행으로 커서가 간다 (메뉴가 열린 동안 트리는 보조 기술에서 가려지므로 행의 표시로 본다)
    expect(document.querySelector('[data-cursor="true"]')?.getAttribute('data-node-id')).toBe(
      'ref:refs/heads/main',
    );
    act(() => fireEvent.click(screen.getByText('열기 main')));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('BranchTree 키보드 (WS-11)', () => {
  it('↑↓·Home·End 는 커서만 옮기고 끝에서 멈춘다 (onActivate 를 부르지 않는다)', () => {
    const { onActivate } = setup();
    expect(cursor()).toBeNull();
    key('ArrowDown');
    expect(cursor()).toBe('head');
    key('ArrowDown');
    key('ArrowDown');
    expect(cursor()).toBe('ref:refs/heads/develop');
    key('ArrowUp');
    expect(cursor()).toBe('group:local');
    key('End');
    expect(cursor()).toBe('ref:refs/remotes/origin/feature/x');
    key('ArrowDown');
    expect(cursor()).toBe('ref:refs/remotes/origin/feature/x');
    key('Home');
    expect(cursor()).toBe('head');
    key('ArrowUp');
    expect(cursor()).toBe('head');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('커서가 없을 때 ↑ 는 맨 아래에서, 선택이 있으면 선택한 행에서 시작한다', () => {
    setup();
    key('ArrowUp');
    expect(cursor()).toBe('ref:refs/remotes/origin/feature/x');
    cleanup();
    setup({ selectedIds: ['ref:refs/heads/main'] });
    expect(cursor()).toBe('ref:refs/heads/main');
    key('ArrowDown');
    expect(cursor()).toBe('ref:refs/heads/feature/x');
  });

  it('→ 는 접힌 그룹을 펴고 펼친 그룹에서는 첫 자식으로, ← 는 부모로 가고 펼친 그룹을 접는다', () => {
    const { onExpansionChange } = setup({ initialExpansion: { 'group:local': false } });
    key('ArrowDown');
    key('ArrowDown');
    expect(cursor()).toBe('group:local');
    key('ArrowRight');
    expect(onExpansionChange).toHaveBeenLastCalledWith({ 'group:local': true });
    expect(row('group:local').getAttribute('aria-expanded')).toBe('true');
    key('ArrowRight');
    expect(cursor()).toBe('ref:refs/heads/develop');
    // 잎에서 → 는 아무 일도 하지 않는다
    key('ArrowRight');
    expect(cursor()).toBe('ref:refs/heads/develop');
    key('ArrowDown');
    key('ArrowLeft');
    expect(cursor()).toBe('group:local');
    key('ArrowLeft');
    expect(onExpansionChange).toHaveBeenLastCalledWith({ 'group:local': false });
    expect(row('group:local').getAttribute('aria-expanded')).toBe('false');
    // 맨 위의 접힌 그룹에서 ← 는 갈 곳이 없다
    key('ArrowLeft');
    expect(cursor()).toBe('group:local');
  });

  it('Enter 는 잎을 열고, Space 는 잎을 누른다. 그룹에서는 둘 다 접고 편다', () => {
    const { onActivate, onOpen, onExpansionChange } = setup();
    fireEvent.click(row('ref:refs/heads/main'));
    onActivate.mockClear();
    key('Enter');
    expect(calledIds(onOpen)).toEqual(['ref:refs/heads/main']);
    key(' ');
    key(' ', { metaKey: true });
    expect(onActivate.mock.calls.map(([node, options]) => [node.id, options])).toEqual([
      ['ref:refs/heads/main', { additive: false }],
      ['ref:refs/heads/main', { additive: true }],
    ]);

    key('Home');
    key('ArrowDown');
    expect(cursor()).toBe('group:local');
    key('Enter');
    expect(onExpansionChange).toHaveBeenLastCalledWith({ 'group:local': false });
    key(' ');
    expect(onExpansionChange).toHaveBeenLastCalledWith({ 'group:local': true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('트리가 다루는 키는 기본 동작(스크롤)을 막고, 다른 키는 그대로 둔다', () => {
    setup();
    expect(key('ArrowDown')).toBe(false);
    expect(key(' ')).toBe(false);
    expect(key('a')).toBe(true);
    expect(key('Tab')).toBe(true);
  });
});

describe('BranchTree 검색 (BT-01)', () => {
  const type = (text: string) =>
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });

  it('입력하면 일치하는 잎과 그 그룹만 남고, 지우면 돌아온다', () => {
    setup();
    type('FEATURE');
    expect(ids()).toEqual([
      'group:local',
      'ref:refs/heads/feature/x',
      'group:remote',
      'ref:refs/remotes/origin/feature/x',
    ]);
    // 그룹의 개수는 남은 잎의 수다
    expect(row('group:local').textContent).toBe('로컬1');
    type('');
    expect(ids()).toHaveLength(8);
    expect(row('group:local').textContent).toBe('로컬3');
  });

  it('검색 중에는 접어 둔 그룹도 펼쳐 보이고, 검색을 지우면 접힌 상태로 돌아간다', () => {
    const { onExpansionChange } = setup({ initialExpansion: { 'group:local': false } });
    expect(ids()).not.toContain('ref:refs/heads/main');
    type('main');
    expect(ids()).toEqual([
      'group:local',
      'ref:refs/heads/main',
      'group:remote',
      'ref:refs/remotes/origin/main',
    ]);
    expect(row('group:local').getAttribute('aria-expanded')).toBe('true');
    // 검색 중에는 접고 펴는 조작이 펼침 상태를 바꾸지 않는다
    fireEvent.click(row('group:local'));
    expect(onExpansionChange).not.toHaveBeenCalled();
    type('');
    expect(ids()).not.toContain('ref:refs/heads/main');
  });

  it('일치하는 것이 없으면 그 사실을 쓴다', () => {
    setup();
    type('없는이름');
    expect(screen.queryAllByRole('treeitem')).toEqual([]);
    expect(screen.getByText(S.branches.noMatch)).toBeTruthy();
  });

  it('검색 입력에서 ↓ 를 누르면 트리의 첫 행으로 간다', () => {
    setup();
    const input = screen.getByRole('searchbox');
    input.focus();
    type('main');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tree());
    expect(cursor()).toBe('group:local');
  });

  it('한글 조합 중의 ↓ 는 트리로 가지 않는다', () => {
    setup();
    const input = screen.getByRole('searchbox');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(document.activeElement).toBe(input);
    expect(cursor()).toBeNull();
  });
});

describe('BranchToolbar (BT-05)', () => {
  /** 툴바를 그리고 콜백을 돌려준다 */
  function setupToolbar(overrides: Partial<BranchToolbarProps> = {}) {
    const handlers = {
      onTogglePanel: vi.fn(),
      onNewBranch: vi.fn(),
      onFetch: vi.fn(),
      onToggleFavorite: vi.fn(),
      onExpandAll: vi.fn(),
      onCollapseAll: vi.fn(),
    };
    render(<BranchToolbar panelOpen busy={false} favorite={false} {...handlers} {...overrides} />);
    return handlers;
  }
  const t = S.branches.toolbar;
  const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
  /** 꺼져 있는 버튼의 이름 */
  const disabled = () =>
    screen
      .getAllByRole<HTMLButtonElement>('button')
      .filter((b) => b.disabled)
      .map((b) => b.getAttribute('aria-label'));

  it('세로 툴바에 여섯 버튼이 차례로 있고 각각 콜백을 부른다', () => {
    const handlers = setupToolbar();
    const bar = screen.getByRole('toolbar', { name: t.label });
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([t.togglePanel, t.newBranch, t.fetch, t.favorite, t.expandAll, t.collapseAll]);
    expect(disabled()).toEqual([]);
    for (const name of [t.togglePanel, t.newBranch, t.fetch, t.favorite, t.expandAll]) {
      fireEvent.click(button(name));
    }
    fireEvent.click(button(t.collapseAll));
    for (const fn of Object.values(handlers)) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('즐겨찾기 버튼은 선택한 브랜치가 없으면 꺼지고, 즐겨찾기면 눌린 모양이다', () => {
    setupToolbar({ favorite: null });
    expect(disabled()).toEqual([t.favorite]);
    cleanup();
    setupToolbar({ favorite: true });
    expect(button(t.favorite).getAttribute('aria-pressed')).toBe('true');
    expect(button(t.favorite).disabled).toBe(false);
    cleanup();
    setupToolbar({ favorite: false });
    expect(button(t.favorite).getAttribute('aria-pressed')).toBe('false');
  });

  it('패널이 접혀 있으면 트리를 다루는 버튼만 꺼진다 (펴기·새 branch·fetch 는 그대로)', () => {
    setupToolbar({ panelOpen: false, favorite: true });
    expect(disabled()).toEqual([t.favorite, t.expandAll, t.collapseAll]);
    expect(button(t.togglePanel).getAttribute('aria-pressed')).toBe('false');
  });

  it('도구 창이 좁아 펼 수 없으면 접기/펴기 버튼을 끄고 까닭을 툴팁으로 쓴다', () => {
    setupToolbar({ panelOpen: false, favorite: null, panelLocked: '도구 창이 좁습니다' });
    expect(button(t.togglePanel).disabled).toBe(true);
    expect(button(t.togglePanel).getAttribute('title')).toBe('도구 창이 좁습니다');
  });

  it('다른 작업이 실행 중이면 새 branch·fetch 가 꺼지고, 대상을 적은 툴팁을 쓴다', () => {
    setupToolbar({
      busy: true,
      newBranchTitle: '새 branch… (전체 3개)',
      fetchTitle: 'fetch (전체 3개)',
    });
    expect(disabled()).toEqual([t.newBranch, t.fetch]);
    expect(button(t.newBranch).getAttribute('title')).toBe('새 branch… (전체 3개)');
    expect(button(t.fetch).getAttribute('title')).toBe('fetch (전체 3개)');
  });

  it('fetchDisabled 를 주면 fetch 만 따로 끄고 켠다 (저장소 탭: 진행 중 작업·원격 없음, W22)', () => {
    setupToolbar({ fetchDisabled: true });
    expect(disabled()).toEqual([t.fetch]);
    cleanup();
    // 실행 중이어도 fetchDisabled 가 false 면 fetch 는 켜져 있다 (새 branch 는 busy 를 따른다)
    setupToolbar({ busy: true, fetchDisabled: false });
    expect(disabled()).toEqual([t.newBranch]);
  });
});

/** 바깥이 다시 그려지는 부모 (memo 시험용 — `tick` 만 바뀌면 트리가 받는 값은 같다) */
function MemoParent({
  props,
  selected,
  tick: _tick,
}: {
  props: BranchTreeProps;
  selected: readonly string[];
  tick: number;
}) {
  return <BranchTree {...props} selectedIds={selected} />;
}

describe('BranchTree 저장소 탭용 확장 (W22): 행 끝 단추·밖에서 든 검색어·memo', () => {
  const ACTION_NODES: BranchTreeNode[] = [
    {
      id: 'group:worktrees',
      kind: 'group',
      label: '워크트리',
      count: 1,
      children: [{ id: 'worktree:/w', kind: 'worktree', label: 'main' }],
    },
  ];

  it('행 끝 단추를 그리고 누르면 그 동작만 부른다 (그룹 접기·onActivate·onOpen 으로 번지지 않는다). 꺼진 단추는 부르지 않는다', () => {
    const prune = vi.fn();
    const create = vi.fn();
    const { onActivate, onOpen, onExpansionChange } = setup({
      nodes: ACTION_NODES,
      rowActions: (node) =>
        node.id === 'group:worktrees'
          ? [
              { key: 'prune', icon: 'prune', label: '정리', title: '1개 정리', onSelect: prune },
              { key: 'create', icon: 'add', label: '만들기', disabled: true, onSelect: create },
            ]
          : [],
    });
    const group = within(row('group:worktrees'));
    const pruneButton = group.getByRole('button', { name: '정리' });
    expect(pruneButton.getAttribute('title')).toBe('1개 정리');
    // 행마다 Tab 정지를 만들지 않는다
    expect(pruneButton.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(pruneButton);
    fireEvent.doubleClick(pruneButton);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(onExpansionChange).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    // 꺼진 단추 (브라우저는 꺼진 단추의 클릭을 보내지 않는다 — jsdom 은 보내므로 누르지 않고 상태만 본다)
    const createButton = group.getByRole<HTMLButtonElement>('button', { name: '만들기' });
    expect(createButton.disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
    // 다른 행에는 단추가 없다
    expect(within(row('worktree:/w')).queryAllByRole('button')).toEqual([]);
  });

  it('rowActions 를 주지 않으면 행 끝 단추가 없다 (폴더 트리 그대로)', () => {
    setup();
    expect(tree().querySelectorAll('[data-action]')).toHaveLength(0);
  });

  it('검색어를 밖에서 주면 그 값으로 거르고, 입력은 onSearchChange 로만 알린다', () => {
    const onSearchChange = vi.fn();
    setup({ search: 'feature', onSearchChange });
    const input = screen.getByRole<HTMLInputElement>('searchbox', { name: S.branches.search });
    expect(input.value).toBe('feature');
    expect(ids()).toEqual([
      'group:local',
      'ref:refs/heads/feature/x',
      'group:remote',
      'ref:refs/remotes/origin/feature/x',
    ]);
    fireEvent.change(input, { target: { value: 'main' } });
    expect(onSearchChange).toHaveBeenCalledWith('main');
    // 바깥이 값을 바꾸지 않았으므로 그대로다
    expect(input.value).toBe('feature');
  });

  it('memo: 같은 props 로 다시 그려지면 트리를 다시 그리지 않는다', () => {
    const rowActions = vi.fn(() => []);
    const props: BranchTreeProps = {
      nodes: NODES,
      selectedIds: [],
      expansion: {},
      onExpansionChange: vi.fn(),
      onActivate: vi.fn(),
      onOpen: vi.fn(),
      menu: () => [],
      onToggleFavorite: vi.fn(),
      rowActions,
    };
    const none: string[] = [];
    const main = ['ref:refs/heads/main'];
    const { rerender } = render(<MemoParent props={props} selected={none} tick={0} />);
    const calls = rowActions.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    rerender(<MemoParent props={props} selected={none} tick={1} />);
    expect(rowActions.mock.calls.length).toBe(calls);
    // 받은 값이 바뀌면 다시 그린다
    rerender(<MemoParent props={props} selected={main} tick={2} />);
    expect(rowActions.mock.calls.length).toBeGreaterThan(calls);
  });
});
