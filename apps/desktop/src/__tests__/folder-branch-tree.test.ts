import type { FolderBranch, FolderBranchIn, FolderBranchRepo, GraphRevs } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { isFavorite, NO_FAVORITE_OVERRIDES } from '../features/branches/branch-favorites';
import type { BranchTreeNode } from '../features/branches/branch-tree-model';
import {
  branchNamesOfRevs,
  buildFolderBranchTree,
  describeRevs,
  folderBranchFullName,
  folderBranchNodeId,
  headRevs,
  isHeadRevs,
  remoteBranchParts,
  revsAfterActivate,
  revsAfterDelete,
  revsAfterRename,
  revsOfBranchNames,
  sameRevs,
  selectedBranchNodeIds,
  selectedLocalBranch,
  trackText,
  updateTargetsOf,
} from '../features/branches/folder-branch-tree';

const pathOf = (name: string) => `/work/${name}`;
const OID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** 저장소 세 개: api 는 development, web 은 feature/login, docs 는 main 이 현재 브랜치다 */
const REPOS: FolderBranchRepo[] = [
  ['api', 'development'],
  ['web', 'feature/login'],
  ['docs', 'main'],
].map(([name, branch], color) => ({
  path: pathOf(name ?? ''),
  name: name ?? '',
  color,
  head: { state: 'attached', branch: branch ?? '', oid: OID },
  error: null,
}));

/** 브랜치가 있는 저장소 하나. 이름 끝의 `*` 는 그 저장소에서 현재 브랜치라는 뜻이다 */
function at(spec: string, extra: Partial<FolderBranchIn> = {}): FolderBranchIn {
  const name = spec.replace('*', '');
  return {
    path: pathOf(name),
    color: REPOS.findIndex((repo) => repo.name === name),
    current: spec.endsWith('*'),
    upstream: null,
    ahead: null,
    behind: null,
    gone: false,
    ...extra,
  };
}

/** 로컬 브랜치 */
const local = (name: string, ...repos: FolderBranchIn[]): FolderBranch => ({
  name,
  remote: false,
  remoteName: null,
  repos,
});

/** 원격 브랜치 (이름의 첫 마디가 원격) */
const remote = (name: string, ...repos: FolderBranchIn[]): FolderBranch => ({
  name,
  remote: true,
  remoteName: name.split('/')[0] ?? null,
  repos,
});

/** 저장소 세 개에 걸친 브랜치. 코어가 주는 순서(로컬 먼저, 이름순) */
const BRANCHES: FolderBranch[] = [
  local('development', at('api*'), at('web')),
  local('feature/login', at('web*')),
  local('hotfix', at('api'), at('docs')),
  local('main', at('api'), at('web'), at('docs*')),
  remote('origin/development', at('api'), at('web')),
  remote('origin/main', at('api'), at('web'), at('docs')),
  remote('upstream/master', at('docs')),
];

/** 기본 즐겨찾기만 켠 트리 */
function build(
  branches: readonly FolderBranch[] = BRANCHES,
  options: {
    hideRemotes?: boolean;
    isFavorite?: (fullName: string) => boolean;
    repos?: readonly FolderBranchRepo[];
  } = {},
): BranchTreeNode[] {
  return buildFolderBranchTree({
    branches,
    repos: options.repos ?? REPOS,
    isFavorite: options.isFavorite ?? ((fullName) => isFavorite(NO_FAVORITE_OVERRIDES, fullName)),
    hideRemotes: options.hideRemotes ?? false,
  });
}

/** id 로 맨 위 노드를 찾는다 */
function top(nodes: readonly BranchTreeNode[], id: string): BranchTreeNode {
  const node = nodes.find((n) => n.id === id);
  if (!node) {
    throw new Error(`노드 없음: ${id}`);
  }
  return node;
}

/** 그룹의 잎을 이름으로 찾는다 */
function child(nodes: readonly BranchTreeNode[], groupId: string, label: string): BranchTreeNode {
  const node = top(nodes, groupId).children?.find((n) => n.label === label);
  if (!node) {
    throw new Error(`잎 없음: ${label}`);
  }
  return node;
}

describe('buildFolderBranchTree (BT-01·02)', () => {
  it('HEAD 행, 로컬 그룹, 원격 그룹을 차례로 두고 그룹에 개수를 쓴다', () => {
    const nodes = build();
    expect(nodes.map((n) => [n.id, n.kind, n.label, n.count])).toEqual([
      ['head', 'head', S.branches.head, undefined],
      ['group:local', 'group', S.branches.local, 4],
      ['group:remote', 'group', S.branches.remote, 3],
    ]);
    // 그룹 안은 평면이다: 이름의 `/` 로 폴더를 만들지 않는다
    expect(top(nodes, 'group:local').children?.every((n) => n.children === undefined)).toBe(true);
  });

  it('노드 id 와 전체 ref 이름은 로컬·원격의 ref 경로다 (즐겨찾기 저장 키)', () => {
    const nodes = build();
    const local = child(nodes, 'group:local', 'feature/login');
    expect([local.id, local.fullName, local.kind]).toEqual([
      'ref:refs/heads/feature/login',
      'refs/heads/feature/login',
      'local',
    ]);
    const remote = child(nodes, 'group:remote', 'origin/main');
    expect([remote.id, remote.fullName, remote.kind]).toEqual([
      'ref:refs/remotes/origin/main',
      'refs/remotes/origin/main',
      'remote',
    ]);
    expect(folderBranchFullName({ name: 'x', remote: false })).toBe('refs/heads/x');
    expect(folderBranchNodeId({ name: 'origin/x', remote: true })).toBe(
      'ref:refs/remotes/origin/x',
    );
  });

  it('잎의 회색 글자는 그 브랜치를 가진 저장소 이름이고 코어가 준 순서(순번순)다', () => {
    const nodes = build();
    expect(child(nodes, 'group:local', 'main').suffix).toBe('(api, web, docs)');
    expect(child(nodes, 'group:local', 'hotfix').suffix).toBe('(api, docs)');
    expect(child(nodes, 'group:remote', 'upstream/master').suffix).toBe('(docs)');
    // 저장소 목록에 없는 경로는 경로의 마지막 요소를 이름으로 쓴다
    const stray = build([local('x', { ...at('api'), path: '/elsewhere/tools' })]);
    expect(child(stray, 'group:local', 'x').suffix).toBe('(tools)');
  });

  it('모든 소속 저장소에서 현재면 true, 일부면 partial, 아니면 false', () => {
    const nodes = build();
    expect(child(nodes, 'group:local', 'feature/login').current).toBe(true);
    expect(child(nodes, 'group:local', 'development').current).toBe('partial');
    expect(child(nodes, 'group:local', 'main').current).toBe('partial');
    expect(child(nodes, 'group:local', 'hotfix').current).toBe(false);
    expect(child(nodes, 'group:remote', 'origin/main').current).toBe(false);
    // 일부 저장소에서만 현재면 어느 저장소인지 툴팁에 쓴다 (BT-08). 전부거나 없으면 쓰지 않는다
    expect(child(nodes, 'group:local', 'main').currentTitle).toBe(S.branches.currentIn('docs'));
    expect(child(nodes, 'group:local', 'development').currentTitle).toBe(
      S.branches.currentIn('api'),
    );
    expect(child(nodes, 'group:local', 'feature/login').currentTitle).toBeUndefined();
    expect(child(nodes, 'group:local', 'hotfix').currentTitle).toBeUndefined();
  });

  it('업스트림 차이는 저장소의 수치를 합쳐 행에 쓰고, 툴팁에 저장소별 수치를 쓴다 (BT-08)', () => {
    const nodes = build([
      local(
        'development',
        at('api*', { upstream: 'origin/development', ahead: 0, behind: 54 }),
        at('web', { upstream: 'origin/development', ahead: 3, behind: 2 }),
        at('docs', { upstream: 'origin/development', ahead: 0, behind: 0 }),
      ),
      local('old', at('api', { upstream: 'origin/old', gone: true })),
      local('synced', at('api', { upstream: 'origin/synced', ahead: 0, behind: 0 })),
      local('plain', at('api')),
    ]);
    const development = child(nodes, 'group:local', 'development');
    expect(development.track).toEqual({ ahead: 3, behind: 56, gone: false });
    // 차이가 없는 저장소(docs)는 툴팁에 쓰지 않는다
    expect(development.trackTitle).toBe(
      [
        S.branches.trackOf('api', S.branches.incoming(54)),
        S.branches.trackOf('web', `${S.branches.incoming(2)} ${S.branches.outgoing(3)}`),
      ].join('\n'),
    );
    const old = child(nodes, 'group:local', 'old');
    expect(old.track).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(old.trackTitle).toBe(S.branches.trackOf('api', S.sidebar.gone));
    // 차이가 없거나 업스트림이 없으면 아무것도 그리지 않는다
    expect(child(nodes, 'group:local', 'synced').track).toBeUndefined();
    expect(child(nodes, 'group:local', 'plain').track).toBeUndefined();
    expect(trackText({ ahead: 3, behind: 54, gone: false })).toBe('⇣54 ⇡3');
  });

  it('정렬은 현재 > 즐겨찾기 > 이름이고, main·master 와 원격 짝이 기본 즐겨찾기다', () => {
    const nodes = build();
    // 현재(main 은 즐겨찾기라 먼저) → 나머지 이름순
    expect(top(nodes, 'group:local').children?.map((n) => n.label)).toEqual([
      'main',
      'development',
      'feature/login',
      'hotfix',
    ]);
    expect(top(nodes, 'group:remote').children?.map((n) => [n.label, n.favorite])).toEqual([
      ['origin/main', true],
      ['upstream/master', true],
      ['origin/development', false],
    ]);
    expect(leafFlags(nodes, 'favoritable')).toEqual([true]);
  });

  it('즐겨찾기 판정을 바꾸면 순서가 따라 바뀐다', () => {
    const nodes = build(BRANCHES, { isFavorite: (fullName) => fullName === 'refs/heads/hotfix' });
    expect(top(nodes, 'group:local').children?.map((n) => n.label)).toEqual([
      'development',
      'feature/login',
      'main',
      'hotfix',
    ]);
    expect(child(nodes, 'group:local', 'hotfix').favorite).toBe(true);
    expect(child(nodes, 'group:local', 'main').favorite).toBe(false);
  });

  it('원격 숨기기면 원격 그룹을, 브랜치가 없는 그룹과 HEAD 에 커밋이 없는 HEAD 행을 빼고 만든다', () => {
    expect(build(BRANCHES, { hideRemotes: true }).map((n) => n.id)).toEqual([
      'head',
      'group:local',
    ]);
    expect(build([], { repos: [] }).map((n) => n.id)).toEqual([]);
    const main = [local('main', at('api'))];
    /** api 저장소의 HEAD 만 바꾼 저장소 목록 */
    const withHead = (head: FolderBranchRepo['head']): FolderBranchRepo[] => [
      { path: pathOf('api'), name: 'api', color: 0, head, error: null },
    ];
    // 분리 HEAD 여도 볼 이력이 있으므로 HEAD 행을 둔다 (W5 까지는 현재 브랜치가 있어야 했다)
    expect(
      build(main, { repos: withHead({ state: 'detached', oid: OID }) }).map((n) => n.id),
    ).toEqual(['head', 'group:local']);
    // 커밋이 없거나 HEAD 를 읽지 못한 저장소뿐이면 두지 않는다
    expect(
      build(main, { repos: withHead({ state: 'unborn', branch: 'main' }) }).map((n) => n.id),
    ).toEqual(['group:local']);
    expect(build(main, { repos: withHead(null) }).map((n) => n.id)).toEqual(['group:local']);
  });
});

/** 모든 브랜치 잎의 한 속성 값 (중복 제거) */
function leafFlags(nodes: readonly BranchTreeNode[], key: 'favoritable'): unknown[] {
  const leaves = nodes.flatMap((n) => n.children ?? []);
  return [...new Set(leaves.map((n) => n[key]))];
}

describe('브랜치 트리와 로그 범위 (BT-03)', () => {
  const ALL: GraphRevs = { kind: 'all' };
  const solo = (name: string): GraphRevs => ({ kind: 'solo', name });
  const many = (...names: string[]): GraphRevs => ({ kind: 'branches', names });

  const HEAD: GraphRevs = { kind: 'head' };

  it('HEAD 행의 범위는 저장소마다 자기 HEAD 다 (브랜치 이름의 모음이 아니다)', () => {
    expect(headRevs()).toEqual(HEAD);
    expect(isHeadRevs(HEAD)).toBe(true);
    expect(branchNamesOfRevs(HEAD)).toEqual([]);
  });

  it('HEAD 범위는 현재 브랜치들을 직접 고른 것과 구분된다', () => {
    // W5 까지는 현재 브랜치 이름의 모음이 HEAD 범위였다. 이제는 그저 그 브랜치들을 고른 것이다
    expect(isHeadRevs(many('development', 'feature/login', 'main'))).toBe(false);
    expect(isHeadRevs(solo('main'))).toBe(false);
    expect(isHeadRevs(ALL)).toBe(false);
    expect(selectedBranchNodeIds(HEAD, BRANCHES)).toEqual(['head']);
    expect(selectedBranchNodeIds(many('development', 'feature/login', 'main'), BRANCHES)).toEqual([
      'ref:refs/heads/development',
      'ref:refs/heads/feature/login',
      'ref:refs/heads/main',
    ]);
  });

  it('HEAD 범위에서 ⌘/Ctrl 클릭하면 그 브랜치만 남는다', () => {
    expect(revsAfterActivate(HEAD, 'main', true)).toEqual(solo('main'));
    expect(revsAfterActivate(HEAD, 'main', false)).toEqual(solo('main'));
  });

  it('그냥 누르면 그 브랜치만 본다', () => {
    expect(revsAfterActivate(ALL, 'main', false)).toEqual(solo('main'));
    expect(revsAfterActivate(many('a', 'b'), 'origin/main', false)).toEqual(solo('origin/main'));
  });

  it('⌘/Ctrl 클릭은 고른 브랜치에 더하거나 빼고, 다 빼면 전체로 돌아간다', () => {
    expect(revsAfterActivate(ALL, 'main', true)).toEqual(solo('main'));
    expect(revsAfterActivate(solo('main'), 'hotfix', true)).toEqual(many('main', 'hotfix'));
    expect(revsAfterActivate(many('main', 'hotfix'), 'main', true)).toEqual(solo('hotfix'));
    expect(revsAfterActivate(solo('hotfix'), 'hotfix', true)).toEqual(ALL);
  });

  it('범위에 맞춰 선택할 노드 id 를 고른다', () => {
    expect(selectedBranchNodeIds(ALL, BRANCHES)).toEqual([]);
    expect(selectedBranchNodeIds(solo('origin/main'), BRANCHES)).toEqual([
      'ref:refs/remotes/origin/main',
    ]);
    expect(selectedBranchNodeIds(many('hotfix', 'main'), BRANCHES)).toEqual([
      'ref:refs/heads/hotfix',
      'ref:refs/heads/main',
    ]);
    // 지금은 없는 브랜치를 고른 범위면 선택할 행이 없다
    expect(selectedBranchNodeIds(solo('gone'), BRANCHES)).toEqual([]);
  });

  it('범위와 이름 목록을 서로 바꾼다', () => {
    expect(branchNamesOfRevs(ALL)).toEqual([]);
    expect(branchNamesOfRevs(solo('a'))).toEqual(['a']);
    expect(branchNamesOfRevs(many('a', 'b'))).toEqual(['a', 'b']);
    expect(revsOfBranchNames([])).toEqual(ALL);
    expect(revsOfBranchNames(['a'])).toEqual(solo('a'));
    expect(revsOfBranchNames(['a', 'b'])).toEqual(many('a', 'b'));
  });

  it('같은 범위인지 본다', () => {
    expect(sameRevs(ALL, { kind: 'all' })).toBe(true);
    expect(sameRevs(solo('a'), solo('a'))).toBe(true);
    expect(sameRevs(solo('a'), solo('b'))).toBe(false);
    expect(sameRevs(solo('a'), many('a'))).toBe(false);
    expect(sameRevs(many('a', 'b'), many('a', 'b'))).toBe(true);
    expect(sameRevs(many('a', 'b'), many('a'))).toBe(false);
    expect(sameRevs(HEAD, { kind: 'head' })).toBe(true);
    expect(sameRevs(HEAD, ALL)).toBe(false);
  });

  it('칩의 표기: 전체면 없고, 하나면 이름, 여럿이면 "외 N개"', () => {
    expect(describeRevs(ALL, REPOS)).toBeNull();
    expect(describeRevs(solo('main'), REPOS)).toEqual({ label: 'main', title: 'main' });
    expect(describeRevs(many('hotfix', 'main', 'origin/main'), REPOS)).toEqual({
      label: S.folder.timeline.moreBranches('hotfix', 2),
      title: 'hotfix, main, origin/main',
    });
  });

  it('HEAD 범위의 칩은 HEAD 행 이름이고, 툴팁에 저장소마다의 HEAD 를 쓴다 (분리 HEAD 는 해시)', () => {
    const repos: FolderBranchRepo[] = [
      ...REPOS.slice(0, 1),
      {
        path: pathOf('web'),
        name: 'web',
        color: 1,
        head: { state: 'detached', oid: OID },
        error: null,
      },
      {
        path: pathOf('empty'),
        name: 'empty',
        color: 2,
        head: { state: 'unborn', branch: 'main' },
        error: null,
      },
      { path: pathOf('broken'), name: 'broken', color: 3, head: null, error: '읽기 실패' },
    ];
    expect(describeRevs(HEAD, repos)).toEqual({
      label: S.branches.head,
      // 커밋이 없는 저장소와 읽지 못한 저장소는 쓰지 않는다
      title: [
        S.branches.headOf('api', 'development'),
        S.branches.headOf('web', S.branches.detachedAt('a1b2c3d4')),
      ].join('\n'),
    });
  });

  it('원격 브랜치를 원격과 브랜치 이름으로 나눈다', () => {
    expect(remoteBranchParts({ name: 'origin/feature/x', remoteName: 'origin' })).toEqual({
      remote: 'origin',
      branch: 'feature/x',
    });
    // 원격 이름에 `/` 가 있어도 코어가 준 이름을 따른다
    expect(remoteBranchParts({ name: 'team/fork/main', remoteName: 'team/fork' })).toEqual({
      remote: 'team/fork',
      branch: 'main',
    });
    // 원격 이름을 모르면 첫 마디를 원격으로 본다. 나눌 수 없으면 null
    expect(remoteBranchParts({ name: 'origin/main', remoteName: null })).toEqual({
      remote: 'origin',
      branch: 'main',
    });
    expect(remoteBranchParts({ name: 'weird', remoteName: null })).toBeNull();
  });
});

describe('branch 업데이트 대상 (BR-09)', () => {
  it('업스트림이 있고 원격에서 사라지지 않은 저장소만, 원격 branch 는 없다', () => {
    const dev = local(
      'development',
      at('api*', { upstream: 'origin/development', behind: 4 }),
      at('web', { upstream: 'origin/development', gone: true }),
      at('docs'),
    );
    expect(updateTargetsOf(dev)).toEqual([pathOf('api')]);
    expect(updateTargetsOf(remote('origin/main', at('api')))).toEqual([]);
  });

  it('세로 툴바는 고른 행이 로컬 branch 하나일 때만 그 branch 를 준다', () => {
    const id = (b: FolderBranch) => folderBranchNodeId(b);
    const [dev, , , main, originDev] = BRANCHES as [
      FolderBranch,
      FolderBranch,
      FolderBranch,
      FolderBranch,
      FolderBranch,
    ];
    expect(selectedLocalBranch(BRANCHES, [id(dev)])).toBe(dev);
    expect(selectedLocalBranch(BRANCHES, [id(originDev)])).toBeNull();
    expect(selectedLocalBranch(BRANCHES, [id(dev), id(main)])).toBeNull();
    expect(selectedLocalBranch(BRANCHES, [])).toBeNull();
  });
});

describe('revsAfterRename', () => {
  it('범위에 옛 이름이 있으면 새 이름으로, 남은 저장소가 있으면 둘 다. 없으면 그대로', () => {
    expect(revsAfterRename({ kind: 'solo', name: 'a' }, 'a', 'b', false)).toEqual({
      kind: 'solo',
      name: 'b',
    });
    expect(revsAfterRename({ kind: 'solo', name: 'a' }, 'a', 'b', true)).toEqual({
      kind: 'branches',
      names: ['a', 'b'],
    });
    expect(revsAfterRename({ kind: 'branches', names: ['x', 'a', 'b'] }, 'a', 'b', false)).toEqual({
      kind: 'branches',
      names: ['x', 'b'],
    });
    const all = { kind: 'all' } as const;
    expect(revsAfterRename(all, 'a', 'b', false)).toBe(all);
    const other = { kind: 'solo', name: 'x' } as const;
    expect(revsAfterRename(other, 'a', 'b', false)).toBe(other);
  });
});

describe('revsAfterDelete', () => {
  it('지운 이름(refs/heads/ 꼴 포함)을 범위에서 빼고, 그 이름만 걸려 있었으면 HEAD 범위로. 없으면 그대로', () => {
    expect(revsAfterDelete({ kind: 'solo', name: 'a' }, 'a')).toEqual({ kind: 'head' });
    expect(revsAfterDelete({ kind: 'solo', name: 'refs/heads/a' }, 'a')).toEqual({ kind: 'head' });
    expect(revsAfterDelete({ kind: 'branches', names: ['x', 'a', 'refs/heads/a'] }, 'a')).toEqual({
      kind: 'branches',
      names: ['x'],
    });
    expect(revsAfterDelete({ kind: 'branches', names: ['a'] }, 'a')).toEqual({ kind: 'head' });
    const other = { kind: 'solo', name: 'x' } as const;
    expect(revsAfterDelete(other, 'a')).toBe(other);
    const all = { kind: 'all' } as const;
    expect(revsAfterDelete(all, 'a')).toBe(all);
  });
});
