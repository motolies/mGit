import { describe, expect, it } from 'vitest';
import {
  type BranchTreeNode,
  expansionForAll,
  filterBranchTree,
  flattenBranchTree,
  groupNodeId,
  isBranchNodeExpanded,
  leafNodes,
  refNodeId,
  sortBranchNodes,
} from '../features/branches/branch-tree-model';

/** 잎 노드 */
function leaf(label: string, extra: Partial<BranchTreeNode> = {}): BranchTreeNode {
  return { id: refNodeId(`refs/heads/${label}`), kind: 'local', label, ...extra };
}

/** 그룹 노드 */
function group(name: string, children: BranchTreeNode[], extra: Partial<BranchTreeNode> = {}) {
  return {
    id: groupNodeId(name),
    kind: 'group' as const,
    label: name,
    count: children.length,
    children,
    ...extra,
  };
}

const TREE: BranchTreeNode[] = [
  { id: 'head', kind: 'head', label: 'HEAD' },
  group('local', [leaf('main'), leaf('Feature/Login'), leaf('fix/typo')]),
  group('remote', [
    group('origin', [
      leaf('origin/main', { id: 'ref:refs/remotes/origin/main', kind: 'remote' }),
      leaf('origin/feature/login', { id: 'ref:refs/remotes/origin/feature/login', kind: 'remote' }),
    ]),
  ]),
];

/** 행의 이름 목록 */
const labels = (nodes: readonly BranchTreeNode[], expansion = {}, force = false) =>
  flattenBranchTree(nodes, expansion, force).map((r) => r.node.label);

describe('브랜치 트리 정렬 (BT-02)', () => {
  it('현재 > 즐겨찾기 > 이름 순이다', () => {
    const sorted = sortBranchNodes([
      leaf('zeta'),
      leaf('alpha'),
      leaf('main', { favorite: true }),
      leaf('develop', { current: true }),
      leaf('beta', { favorite: true }),
    ]);
    expect(sorted.map((n) => n.label)).toEqual(['develop', 'beta', 'main', 'alpha', 'zeta']);
  });

  it('일부 저장소에서만 현재인 것도 현재 묶음이고, 그 안에서는 즐겨찾기·이름 순이다', () => {
    const sorted = sortBranchNodes([
      leaf('staging', { current: 'partial' }),
      leaf('alpha', { favorite: true }),
      leaf('main', { current: 'partial', favorite: true }),
      leaf('develop', { current: true }),
    ]);
    expect(sorted.map((n) => n.label)).toEqual(['main', 'develop', 'staging', 'alpha']);
  });

  it('원본 배열은 바꾸지 않는다', () => {
    const input = [leaf('b'), leaf('a')];
    sortBranchNodes(input);
    expect(input.map((n) => n.label)).toEqual(['b', 'a']);
  });
});

describe('브랜치 트리 검색 (BT-01)', () => {
  it('빈 검색어는 트리를 그대로 준다', () => {
    expect(filterBranchTree(TREE, '  ')).toEqual(TREE);
  });

  it('이름 부분 일치(대소문자 무시)로 잎을 고르고 조상 그룹을 남긴다', () => {
    const found = filterBranchTree(TREE, 'LOGIN');
    expect(labels(found, {}, true)).toEqual([
      'local',
      'Feature/Login',
      'remote',
      'origin',
      'origin/feature/login',
    ]);
  });

  it('일치하는 잎이 없는 그룹과 잎은 빠진다', () => {
    const found = filterBranchTree(TREE, 'typo');
    expect(labels(found, {}, true)).toEqual(['local', 'fix/typo']);
    expect(filterBranchTree(TREE, '없는이름')).toEqual([]);
  });

  it('그룹 이름은 검색 대상이 아니다', () => {
    expect(filterBranchTree(TREE, 'remote')).toEqual([]);
  });

  it('그룹의 개수는 남은 잎의 수로 바뀐다', () => {
    const found = filterBranchTree(TREE, 'main');
    expect(found.map((n) => [n.label, n.count])).toEqual([
      ['local', 1],
      ['remote', 1],
    ]);
    // 원본은 그대로다
    expect(TREE[1]?.count).toBe(3);
  });
});

describe('브랜치 트리 평탄화', () => {
  it('기본은 모두 펼친 행 목록이고 깊이와 부모를 싣는다', () => {
    const rows = flattenBranchTree(TREE, {});
    expect(rows.map((r) => [r.node.label, r.depth, r.parentId])).toEqual([
      ['HEAD', 0, null],
      ['local', 0, null],
      ['main', 1, 'group:local'],
      ['Feature/Login', 1, 'group:local'],
      ['fix/typo', 1, 'group:local'],
      ['remote', 0, null],
      ['origin', 1, 'group:remote'],
      ['origin/main', 2, 'group:origin'],
      ['origin/feature/login', 2, 'group:origin'],
    ]);
    expect(rows.filter((r) => r.expandable).map((r) => r.node.label)).toEqual([
      'local',
      'remote',
      'origin',
    ]);
    expect(rows.filter((r) => r.expandable).every((r) => r.expanded)).toBe(true);
  });

  it('접힌 그룹의 자식은 뺀다', () => {
    expect(labels(TREE, { 'group:local': false })).toEqual([
      'HEAD',
      'local',
      'remote',
      'origin',
      'origin/main',
      'origin/feature/login',
    ]);
    expect(labels(TREE, { 'group:remote': false })).toEqual([
      'HEAD',
      'local',
      'main',
      'Feature/Login',
      'fix/typo',
      'remote',
    ]);
  });

  it('처음에 접어 두는 노드는 사용자가 펼치기 전까지 접혀 있다', () => {
    const tree = [group('tags', [leaf('v1')], { defaultCollapsed: true })];
    expect(labels(tree)).toEqual(['tags']);
    expect(labels(tree, { 'group:tags': true })).toEqual(['tags', 'v1']);
    expect(isBranchNodeExpanded(tree[0] as BranchTreeNode, {})).toBe(false);
  });

  it('검색 중에는 펼침 상태와 무관하게 모두 펼친다', () => {
    const rows = flattenBranchTree(TREE, { 'group:local': false }, true);
    expect(rows.map((r) => r.node.label)).toContain('main');
    expect(rows.find((r) => r.node.id === 'group:local')?.expanded).toBe(true);
  });

  it('모두 펼치기·접기는 펼칠 수 있는 노드 전부의 상태를 만든다', () => {
    expect(expansionForAll(TREE, false)).toEqual({
      'group:local': false,
      'group:remote': false,
      'group:origin': false,
    });
    expect(labels(TREE, expansionForAll(TREE, false))).toEqual(['HEAD', 'local', 'remote']);
    expect(labels(TREE, expansionForAll(TREE, true))).toHaveLength(9);
  });

  it('잎만 화면 순서대로 모은다', () => {
    expect(leafNodes(TREE).map((n) => n.label)).toEqual([
      'HEAD',
      'main',
      'Feature/Login',
      'fix/typo',
      'origin/main',
      'origin/feature/login',
    ]);
  });
});
