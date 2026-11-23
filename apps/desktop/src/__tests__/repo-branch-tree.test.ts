// W22: 저장소 탭 브랜치 트리의 빌더 (`buildRepoBranchTree`) — 옛 사이드바의 Local·Remote·Tags·Worktrees·Backups
// 섹션이 보이던 것(배지와 그 조건·툴팁, 업스트림 차이, 현재 표시, 태그 역순, 워크트리 표시, 백업 날짜, 기본 접힘)을
// 공용 노드 모델로 옮긴 결과를 고정한다.

import type { BackupRef, HeadState, RadarEntry, RefLabel, WorktreeInfo } from '@mgit/ipc';
import { formatDateTime, S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { isFavorite, NO_FAVORITE_OVERRIDES } from '../features/branches/branch-favorites';
import {
  type BranchTreeNode,
  filterBranchTree,
  flattenBranchTree,
  leafNodes,
} from '../features/branches/branch-tree-model';
import {
  backupNodeId,
  buildRepoBranchTree,
  labelTrack,
  localBadges,
  REPO_GROUP_IDS,
  type RepoBranchTreeInput,
  remoteGroupNodeId,
  repoBranchTarget,
  repoTargetCommit,
  worktreeNodeId,
} from '../features/branches/repo-branch-tree';

/** 숫자로 만든 커밋 id (앞자리가 숫자라 짧은 해시가 서로 다르다) */
const oid = (n: number) => n.toString(16).padEnd(40, '0');
const PATH = '/work/web';

/** 로컬 브랜치 라벨 */
function local(name: string, extra: Partial<RefLabel> = {}): RefLabel {
  return {
    fullName: `refs/heads/${name}`,
    shortName: name,
    kind: { kind: 'localBranch' },
    target: oid(name.length),
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    worktreePath: null,
    ...extra,
  };
}

/** 원격 브랜치 라벨 (`origin/x`) */
function remote(short: string, target = oid(7)): RefLabel {
  const [name = ''] = short.split('/');
  return {
    fullName: `refs/remotes/${short}`,
    shortName: short,
    kind: { kind: 'remoteBranch', remote: name },
    target,
    isCurrent: false,
    upstreamGone: false,
  };
}

/** 태그 라벨 */
function tag(name: string): RefLabel {
  return {
    fullName: `refs/tags/${name}`,
    shortName: name,
    kind: { kind: 'tag', annotated: true },
    target: oid(100 + name.length),
    isCurrent: false,
    upstreamGone: false,
  };
}

/** 워크트리 */
function worktree(path: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path,
    head: oid(9),
    branch: null,
    detached: false,
    bare: false,
    locked: null,
    prunable: null,
    isMain: false,
    ...extra,
  };
}

const HEAD: HeadState = { state: 'attached', branch: 'main', oid: oid(1) };
const LABELS: RefLabel[] = [
  local('staging', { upstream: 'origin/staging', ahead: 0, behind: 4 }),
  local('main', { isCurrent: true, upstream: 'origin/main', ahead: 2, behind: 0 }),
  local('feature/x', { upstream: 'origin/feature/x', ahead: 3, behind: 1 }),
  local('fix/old', { upstream: 'origin/fix/old', upstreamGone: true }),
  local('hotfix', { worktreePath: `${PATH}-hotfix`, ahead: 1, behind: 0 }),
  remote('upstream/main'),
  remote('origin/staging'),
  remote('origin/main'),
  tag('v1.0.0'),
  tag('v2.0.0'),
  tag('v1.5.0'),
];
const WORKTREES: WorktreeInfo[] = [
  worktree(PATH, { branch: 'main', isMain: true }),
  worktree(`${PATH}-hotfix`, { branch: 'hotfix' }),
  worktree(`${PATH}-review`, { detached: true, head: oid(0xabc), locked: '리뷰 중' }),
  worktree(`${PATH}-gone`, { detached: true, prunable: 'gitdir missing' }),
];
const BACKUPS: BackupRef[] = [
  {
    name: 'refs/mgit/backup/main/100-000001',
    branch: 'main',
    oid: oid(50),
    createdAt: 1_761_590_000,
  },
  { name: 'refs/mgit/backup/staging/90-000002', branch: 'staging', oid: oid(51), createdAt: null },
];
const RADAR: RadarEntry[] = [
  { reference: 'staging', kind: 'local', clean: true, conflicts: [], behind: 0, ahead: 0 },
  {
    reference: 'feature/x',
    kind: 'local',
    clean: false,
    conflicts: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    behind: 0,
    ahead: 0,
  },
  // 현재 브랜치의 레이더는 배지로 쓰지 않는다
  { reference: 'main', kind: 'local', clean: true, conflicts: [], behind: 0, ahead: 0 },
];

function input(extra: Partial<RepoBranchTreeInput> = {}): RepoBranchTreeInput {
  return {
    labels: LABELS,
    head: HEAD,
    worktrees: WORKTREES,
    backups: BACKUPS,
    radar: RADAR,
    path: PATH,
    isFavorite: (fullName) => isFavorite(NO_FAVORITE_OVERRIDES, fullName),
    ...extra,
  };
}

/** id 로 노드를 찾는다 (트리 전체) */
function find(nodes: readonly BranchTreeNode[], id: string): BranchTreeNode {
  const all = (list: readonly BranchTreeNode[]): BranchTreeNode[] =>
    list.flatMap((n) => [n, ...all(n.children ?? [])]);
  const found = all(nodes).find((n) => n.id === id);
  if (!found) {
    throw new Error(`노드 없음: ${id}`);
  }
  return found;
}
const childIds = (nodes: readonly BranchTreeNode[], id: string) =>
  (find(nodes, id).children ?? []).map((n) => n.id);

describe('buildRepoBranchTree (BT-11)', () => {
  it('맨 위는 HEAD 행, 그다음 로컬·원격·태그·워크트리·백업 그룹이다. 태그·백업은 접혀서 시작한다', () => {
    const nodes = buildRepoBranchTree(input());
    expect(nodes.map((n) => [n.id, n.label, n.count ?? null, n.defaultCollapsed === true])).toEqual(
      [
        ['head', S.branches.head, null, false],
        [REPO_GROUP_IDS.local, S.branches.local, 5, false],
        [REPO_GROUP_IDS.remote, S.branches.remote, 3, false],
        [REPO_GROUP_IDS.tags, S.sidebar.tags, 3, true],
        [REPO_GROUP_IDS.worktrees, S.sidebar.worktrees, 4, false],
        [REPO_GROUP_IDS.backups, S.safety.backups, 2, true],
      ],
    );
    // 처음 보이는 행: 태그·백업 그룹의 자식은 접혀 있다
    const visible = flattenBranchTree(nodes, {}).map((r) => r.node.id);
    expect(visible).not.toContain('ref:refs/tags/v1.0.0');
    expect(visible).not.toContain(backupNodeId(BACKUPS[0]?.name ?? ''));
    expect(visible).toContain(worktreeNodeId(PATH));
  });

  it('로컬은 현재 > 즐겨찾기 > 이름 순이다 (기본 즐겨찾기 main·master). 현재 브랜치 표시와 즐겨찾기 토글을 싣는다', () => {
    const nodes = buildRepoBranchTree(input());
    expect(childIds(nodes, REPO_GROUP_IDS.local)).toEqual([
      'ref:refs/heads/main',
      'ref:refs/heads/feature/x',
      'ref:refs/heads/fix/old',
      'ref:refs/heads/hotfix',
      'ref:refs/heads/staging',
    ]);
    const main = find(nodes, 'ref:refs/heads/main');
    expect(main).toMatchObject({
      kind: 'local',
      label: 'main',
      fullName: 'refs/heads/main',
      current: true,
      favorite: true,
      favoritable: true,
    });
    expect(find(nodes, 'ref:refs/heads/staging').current).toBe(false);
    // 사용자가 켠 즐겨찾기는 현재 브랜치 다음에 온다
    const withFav = buildRepoBranchTree(input({ isFavorite: (f) => f === 'refs/heads/staging' }));
    expect(childIds(withFav, REPO_GROUP_IDS.local).slice(0, 2)).toEqual([
      'ref:refs/heads/main',
      'ref:refs/heads/staging',
    ]);
  });

  it('원격은 원격 이름 그룹(이름순) 아래 브랜치 이름만 쓴다. 그룹마다 즐겨찾기(원격 짝 main) > 이름 순', () => {
    const nodes = buildRepoBranchTree(input());
    expect(childIds(nodes, REPO_GROUP_IDS.remote)).toEqual([
      remoteGroupNodeId('origin'),
      remoteGroupNodeId('upstream'),
    ]);
    const origin = find(nodes, remoteGroupNodeId('origin'));
    expect(origin.kind).toBe('group');
    expect(origin.label).toBe('origin');
    expect(origin.children?.map((n) => [n.label, n.fullName, n.favorite])).toEqual([
      ['main', 'refs/remotes/origin/main', true],
      ['staging', 'refs/remotes/origin/staging', false],
    ]);
    // 원격 행에는 업스트림 차이·배지가 없다 (옛 사이드바와 같다)
    expect(origin.children?.every((n) => !n.track && !n.badges)).toBe(true);
  });

  it('업스트림 차이: 사라졌으면 그 사실만, 아니면 앞섬·뒤처짐. 차이가 없으면 표시하지 않는다', () => {
    const nodes = buildRepoBranchTree(input());
    expect(find(nodes, 'ref:refs/heads/main').track).toEqual({ ahead: 2, behind: 0, gone: false });
    expect(find(nodes, 'ref:refs/heads/feature/x').track).toEqual({
      ahead: 3,
      behind: 1,
      gone: false,
    });
    expect(find(nodes, 'ref:refs/heads/fix/old').track).toEqual({
      ahead: 0,
      behind: 0,
      gone: true,
    });
    expect(labelTrack(local('plain'))).toBeNull();
    expect(labelTrack(local('even', { ahead: 0, behind: 0 }))).toBeNull();
    // 사라진 업스트림이면 남은 수가 있어도 쓰지 않는다 (옛 `trackBadge`)
    expect(labelTrack(local('g', { upstreamGone: true, ahead: 5 }))).toEqual({
      ahead: 0,
      behind: 0,
      gone: true,
    });
  });

  it('배지 3종: 다른 워크트리에 체크아웃됨, 레이더 깨끗함, 레이더 충돌(수 + 앞 다섯 파일). 현재 브랜치에는 없다', () => {
    const nodes = buildRepoBranchTree(input());
    expect(find(nodes, 'ref:refs/heads/hotfix').badges).toEqual([
      { icon: 'worktree', title: S.sidebar.checkedOutAt(`${PATH}-hotfix`) },
    ]);
    expect(find(nodes, 'ref:refs/heads/staging').badges).toEqual([
      { icon: 'radarOk', title: S.preview.radarClean },
    ]);
    expect(find(nodes, 'ref:refs/heads/feature/x').badges).toEqual([
      {
        icon: 'radarConflict',
        text: '6',
        title: `${S.preview.radarConflict(6)}: a.ts, b.ts, c.ts, d.ts, e.ts`,
      },
    ]);
    // 현재 브랜치는 레이더·워크트리 배지를 쓰지 않는다
    expect(find(nodes, 'ref:refs/heads/main').badges).toBeUndefined();
    expect(
      localBadges(local('main', { isCurrent: true, worktreePath: '/elsewhere' }), RADAR),
    ).toEqual([]);
    // 둘 다 있으면 워크트리 배지가 먼저다 (옛 사이드바 순서)
    expect(
      localBadges(local('staging', { worktreePath: '/w2' }), RADAR).map((b) => b.icon),
    ).toEqual(['worktree', 'radarOk']);
  });

  it('태그는 이름 역순이고 즐겨찾기할 수 없다', () => {
    const nodes = buildRepoBranchTree(input());
    expect(find(nodes, REPO_GROUP_IDS.tags).children?.map((n) => [n.label, n.kind])).toEqual([
      ['v2.0.0', 'tag'],
      ['v1.5.0', 'tag'],
      ['v1.0.0', 'tag'],
    ]);
    expect(
      leafNodes(find(nodes, REPO_GROUP_IDS.tags).children ?? []).some((n) => n.favoritable),
    ).toBe(false);
  });

  it('워크트리: 받은 순서, 이름은 브랜치(분리 HEAD 면 detached 해시), 회색 글자는 메인·잠김·폴더 없음. 이 탭의 것은 현재 표시', () => {
    const nodes = buildRepoBranchTree(input());
    expect(
      find(nodes, REPO_GROUP_IDS.worktrees).children?.map((n) => [
        n.id,
        n.label,
        n.suffix ?? '',
        n.current ?? false,
      ]),
    ).toEqual([
      [worktreeNodeId(PATH), 'main', S.sidebar.main, true],
      [worktreeNodeId(`${PATH}-hotfix`), 'hotfix', '', false],
      [worktreeNodeId(`${PATH}-review`), `${S.sidebar.detached} abc00000`, S.sidebar.locked, false],
      [worktreeNodeId(`${PATH}-gone`), `${S.sidebar.detached} 90000000`, S.sidebar.prunable, false],
    ]);
    expect(find(nodes, worktreeNodeId(PATH)).currentTitle).toBe(S.branches.currentWorktree);
    // 워크트리 그룹은 비어도 둔다 (머리 단추 "만들기"의 자리)
    const empty = buildRepoBranchTree(input({ worktrees: [] }));
    expect(find(empty, REPO_GROUP_IDS.worktrees).children).toEqual([]);
  });

  it('백업: 받은 순서, 이름은 브랜치, 회색 글자는 만든 시각. 백업이 없으면 그룹이 없다', () => {
    const nodes = buildRepoBranchTree(input());
    expect(
      find(nodes, REPO_GROUP_IDS.backups).children?.map((n) => [n.id, n.kind, n.label, n.suffix]),
    ).toEqual([
      [
        backupNodeId('refs/mgit/backup/main/100-000001'),
        'backup',
        'main',
        formatDateTime(1_761_590_000),
      ],
      [backupNodeId('refs/mgit/backup/staging/90-000002'), 'backup', 'staging', formatDateTime(0)],
    ]);
    const none = buildRepoBranchTree(input({ backups: [] }));
    expect(none.map((n) => n.id)).not.toContain(REPO_GROUP_IDS.backups);
  });

  it('브랜치·태그가 없는 그룹은 만들지 않고, HEAD 에 커밋이 없으면(unborn) HEAD 행도 없다', () => {
    const nodes = buildRepoBranchTree(
      input({ labels: [], head: { state: 'unborn', branch: 'main' }, backups: [] }),
    );
    expect(nodes.map((n) => n.id)).toEqual([REPO_GROUP_IDS.worktrees]);
    // 분리 HEAD 면 HEAD 행이 있다
    const detached = buildRepoBranchTree(input({ head: { state: 'detached', oid: oid(3) } }));
    expect(detached[0]?.id).toBe('head');
  });

  it('검색: 이름 부분 일치로 잎과 그 그룹만 남기고 개수를 고친다 (원격 이름 그룹 안까지)', () => {
    const nodes = buildRepoBranchTree(input());
    const hit = filterBranchTree(nodes, 'STAG');
    expect(hit.map((n) => [n.id, n.count ?? null])).toEqual([
      [REPO_GROUP_IDS.local, 1],
      [REPO_GROUP_IDS.remote, 1],
      [REPO_GROUP_IDS.backups, 1],
    ]);
    expect(childIds(hit, REPO_GROUP_IDS.remote)).toEqual([remoteGroupNodeId('origin')]);
    expect(childIds(hit, remoteGroupNodeId('origin'))).toEqual(['ref:refs/remotes/origin/staging']);
  });
});

describe('repoBranchTarget · repoTargetCommit (노드 → 대상 → 이동할 커밋)', () => {
  const source = input();

  it('ref 노드는 라벨, 원격 이름 그룹은 원격, 워크트리·백업은 그 항목, HEAD 행은 HEAD 커밋을 가리킨다', () => {
    const main = LABELS[1] as RefLabel;
    expect(repoBranchTarget('ref:refs/heads/main', source)).toEqual({ kind: 'local', label: main });
    expect(repoBranchTarget('ref:refs/remotes/upstream/main', source)).toEqual({
      kind: 'remote',
      label: LABELS[5],
      remote: 'upstream',
    });
    expect(repoBranchTarget('ref:refs/tags/v2.0.0', source)).toEqual({
      kind: 'tag',
      label: LABELS[9],
    });
    expect(repoBranchTarget(remoteGroupNodeId('origin'), source)).toEqual({
      kind: 'remoteGroup',
      remote: 'origin',
    });
    expect(repoBranchTarget(worktreeNodeId(`${PATH}-hotfix`), source)).toEqual({
      kind: 'worktree',
      worktree: WORKTREES[1],
    });
    expect(repoBranchTarget(backupNodeId(BACKUPS[1]?.name ?? ''), source)).toEqual({
      kind: 'backup',
      backup: BACKUPS[1],
    });
    expect(repoBranchTarget(REPO_GROUP_IDS.worktrees, source)).toEqual({ kind: 'worktreeGroup' });
    expect(repoBranchTarget('head', source)).toEqual({ kind: 'head', oid: oid(1) });
  });

  it('대상이 없는 그룹·사라진 항목은 null', () => {
    for (const id of [
      REPO_GROUP_IDS.local,
      REPO_GROUP_IDS.remote,
      REPO_GROUP_IDS.tags,
      REPO_GROUP_IDS.backups,
      'ref:refs/heads/gone',
      worktreeNodeId('/nowhere'),
      backupNodeId('refs/mgit/backup/x/1-1'),
    ]) {
      expect(repoBranchTarget(id, source), id).toBeNull();
    }
    expect(
      repoBranchTarget('head', { ...source, head: { state: 'unborn', branch: 'main' } }),
    ).toBeNull();
  });

  it('클릭하면 이동할 커밋: ref 는 가리키는 커밋, 백업은 백업 커밋, HEAD 는 HEAD. 워크트리·그룹은 없다', () => {
    const commit = (id: string) => {
      const t = repoBranchTarget(id, source);
      return t ? repoTargetCommit(t) : 'no-target';
    };
    expect(commit('ref:refs/heads/staging')).toBe(LABELS[0]?.target);
    expect(commit('ref:refs/remotes/origin/main')).toBe(LABELS[7]?.target);
    expect(commit('ref:refs/tags/v1.0.0')).toBe(LABELS[8]?.target);
    expect(commit(backupNodeId(BACKUPS[0]?.name ?? ''))).toBe(oid(50));
    expect(commit('head')).toBe(oid(1));
    expect(commit(worktreeNodeId(PATH))).toBeNull();
    expect(commit(remoteGroupNodeId('origin'))).toBeNull();
    expect(commit(REPO_GROUP_IDS.worktrees)).toBeNull();
  });
});
