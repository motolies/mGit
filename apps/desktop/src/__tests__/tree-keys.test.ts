import { describe, expect, it } from 'vitest';
import { ROVING_PAGE, rovingIndex } from '../components/roving';
import {
  isContextMenuKey,
  siblingPositions,
  type TreeKeyRow,
  treeKeyCommand,
} from '../components/tree-keys';
import { treeScrollTarget } from '../components/use-virtual-tree';

// 펼친 트리: root(펼침) > a(접힘), b(펼침) > b1, b2 ; c(잎)
const ROWS: TreeKeyRow[] = [
  { id: 'root', parentId: null, expandable: true, expanded: true },
  { id: 'a', parentId: 'root', expandable: true, expanded: false },
  { id: 'b', parentId: 'root', expandable: true, expanded: true },
  { id: 'b1', parentId: 'b', expandable: false, expanded: false },
  { id: 'b2', parentId: 'b', expandable: false, expanded: false },
  { id: 'c', parentId: 'root', expandable: false, expanded: false },
];
const at = (id: string) => ROWS.findIndex((r) => r.id === id);

describe('트리 넷의 공용 키 규칙 (treeKeyCommand, W19 ③)', () => {
  it.each<[string, { key: string; shiftKey?: boolean }, string | null, unknown]>([
    ['↓ 다음 행', { key: 'ArrowDown' }, 'a', { kind: 'move', index: at('b'), extend: false }],
    [
      '↓ 끝 행에서 멈춘다',
      { key: 'ArrowDown' },
      'c',
      { kind: 'move', index: at('c'), extend: false },
    ],
    ['↑ 앞 행', { key: 'ArrowUp' }, 'b', { kind: 'move', index: at('a'), extend: false }],
    [
      '커서가 없으면 ↓ 는 첫 행',
      { key: 'ArrowDown' },
      null,
      { kind: 'move', index: 0, extend: false },
    ],
    [
      '커서가 없으면 ↑ 는 끝 행',
      { key: 'ArrowUp' },
      null,
      { kind: 'move', index: 5, extend: false },
    ],
    [
      '⇧↓ 는 범위 넓히기',
      { key: 'ArrowDown', shiftKey: true },
      'a',
      { kind: 'move', index: at('b'), extend: true },
    ],
    ['Home 첫 행', { key: 'Home' }, 'b2', { kind: 'move', index: 0, extend: false }],
    ['End 끝 행', { key: 'End' }, 'a', { kind: 'move', index: 5, extend: false }],
    ['→ 접힌 행은 펼친다', { key: 'ArrowRight' }, 'a', { kind: 'expand' }],
    [
      '→ 펼친 행은 첫 자식으로',
      { key: 'ArrowRight' },
      'b',
      { kind: 'move', index: at('b1'), extend: false },
    ],
    ['→ 잎은 아무것도 하지 않는다', { key: 'ArrowRight' }, 'c', null],
    ['← 펼친 행은 접는다', { key: 'ArrowLeft' }, 'b', { kind: 'collapse' }],
    ['← 잎은 부모로', { key: 'ArrowLeft' }, 'b2', { kind: 'move', index: at('b'), extend: false }],
    ['← 접힌 행은 부모로', { key: 'ArrowLeft' }, 'a', { kind: 'move', index: 0, extend: false }],
    ['Enter', { key: 'Enter' }, 'c', { kind: 'enter' }],
    ['Space', { key: ' ' }, 'c', { kind: 'space' }],
    ['커서가 없으면 Enter 는 없다', { key: 'Enter' }, null, null],
    ['⇧F10 은 메뉴', { key: 'F10', shiftKey: true }, 'b1', { kind: 'menu' }],
    ['메뉴 키', { key: 'ContextMenu' }, 'b1', { kind: 'menu' }],
    ['글자 입력은 찾기가 아니다 (넣지 않는다)', { key: 'b' }, 'a', null],
  ])('%s', (_name, key, cursor, expected) => {
    expect(treeKeyCommand(key, ROWS, cursor === null ? -1 : at(cursor))).toEqual(expected);
  });

  it('⌘·Ctrl·⌥ 와 함께 누른 화살표는 트리 몫이 아니다 (앱 단축키)', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(treeKeyCommand({ key: 'ArrowDown', [mod]: true }, ROWS, 0)).toBeNull();
    }
  });

  it('접을 수 없게 하면 (브랜치 트리의 검색 중) ← 는 부모로만 간다', () => {
    expect(treeKeyCommand({ key: 'ArrowLeft' }, ROWS, at('b'), { canCollapse: false })).toEqual({
      kind: 'move',
      index: 0,
      extend: false,
    });
  });

  it('행이 없으면 아무것도 하지 않는다', () => {
    expect(treeKeyCommand({ key: 'ArrowDown' }, [], -1)).toBeNull();
  });

  it('메뉴 키 판정: 메뉴 키, ⇧F10 (다른 수정키 없이)', () => {
    expect(isContextMenuKey({ key: 'ContextMenu' })).toBe(true);
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: 'F10' })).toBe(false);
    expect(isContextMenuKey({ key: 'F10', shiftKey: true, metaKey: true })).toBe(false);
  });
});

describe('형제 수·순번 (siblingPositions — aria-setsize·aria-posinset)', () => {
  it('같은 부모의 행끼리 나타난 차례로 센다', () => {
    expect(siblingPositions(ROWS.map((r) => r.parentId))).toEqual([
      { setSize: 1, posInSet: 1 },
      { setSize: 3, posInSet: 1 },
      { setSize: 3, posInSet: 2 },
      { setSize: 2, posInSet: 1 },
      { setSize: 2, posInSet: 2 },
      { setSize: 3, posInSet: 3 },
    ]);
  });
});

describe('키로 옮긴 행의 스크롤 (treeScrollTarget — Home 이 위 여백을 가리지 않게)', () => {
  it.each<[number, number, string]>([
    [0, 10, 'top'],
    [9, 10, 'bottom'],
    [4, 10, 'row'],
    [0, 1, 'top'],
  ])('%i번째 / %i행 → %s', (index, count, expected) => {
    expect(treeScrollTarget(index, count)).toBe(expected);
  });
});

describe('움직이는 tabindex 의 키 (rovingIndex)', () => {
  it.each<[string, number, number, 'horizontal' | 'vertical', boolean, number | null]>([
    ['ArrowRight', 0, 3, 'horizontal', true, 1],
    ['ArrowRight', 2, 3, 'horizontal', true, 0],
    ['ArrowLeft', 0, 3, 'horizontal', true, 2],
    ['ArrowDown', 0, 3, 'horizontal', true, null],
    ['ArrowDown', 1, 3, 'vertical', true, 2],
    ['ArrowDown', 2, 3, 'vertical', false, 2],
    ['ArrowUp', 0, 3, 'vertical', false, 0],
    ['Home', 2, 3, 'vertical', true, 0],
    ['End', 0, 3, 'horizontal', true, 2],
    ['PageDown', 0, 30, 'vertical', false, ROVING_PAGE],
    ['PageDown', 25, 30, 'vertical', false, 29],
    ['PageUp', 5, 30, 'vertical', false, 0],
    ['PageDown', 0, 30, 'horizontal', false, null],
    ['ArrowDown', -1, 3, 'vertical', false, 0],
    ['Enter', 0, 3, 'vertical', true, null],
  ])('%s (%i / %i, %s, 돌기 %s) → %s', (key, index, count, orientation, wrap, expected) => {
    expect(rovingIndex(key, index, count, orientation, wrap)).toBe(expected);
  });

  it('항목이 없으면 null', () => {
    expect(rovingIndex('ArrowDown', 0, 0, 'vertical')).toBeNull();
  });
});
