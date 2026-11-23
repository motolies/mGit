// 저장소 탭의 브랜치 트리 (BT-11, W22): 세션의 ref·워크트리·백업·충돌 레이더를 공용 노드 모델(`BranchTreeNode`)로
// 바꾸는 순수 함수와, 노드 id 에서 그 노드가 가리키는 대상을 되찾는 함수. 옛 사이드바의 Local·Remote·Tags·Worktrees·
// Backups 다섯 섹션을 옮긴 것이다 — 보이는 것(배지·현재 표시·업스트림 차이)의 조건은 옛 사이드바와 같다.

import {
  type BackupRef,
  type HeadState,
  type RadarEntry,
  type RefLabel,
  remoteBranchName,
  type WorktreeInfo,
} from '@mgit/ipc';
import { formatDateTime, S, shortHash } from '@mgit/ui';
import {
  type BranchBadge,
  type BranchTrack,
  type BranchTreeNode,
  groupNodeId,
  HEAD_NODE_ID,
  refNodeId,
  sortBranchNodes,
} from './branch-tree-model';

/** 트리를 만드는 재료 (세션 상태에서 고른 것) */
export interface RepoBranchSource {
  /** ref 라벨 전부 (로컬·원격 브랜치, 태그. stash 는 쓰지 않는다) */
  labels: readonly RefLabel[];
  /** HEAD. 커밋이 있을 때(현재 브랜치·분리 HEAD)만 `HEAD (현재 브랜치)` 행을 둔다 */
  head: HeadState;
  worktrees: readonly WorktreeInfo[];
  backups: readonly BackupRef[];
  /** 충돌 레이더 결과 (CF-02). 이름(`reference`)이 로컬 브랜치의 짧은 이름과 같은 것만 배지로 쓴다 */
  radar: readonly RadarEntry[];
  /** 이 탭의 작업 트리 경로 (지금 연 워크트리 표시) */
  path: string;
}

export interface RepoBranchTreeInput extends RepoBranchSource {
  /** 전체 ref 이름이 즐겨찾기인지 (BT-04) */
  isFavorite: (fullName: string) => boolean;
}

/** 노드 id 의 접두 (5.3절): 원격 이름 그룹, 워크트리, 백업 */
const REMOTE_GROUP_PREFIX = 'remote:';
const WORKTREE_PREFIX = 'worktree:';
const BACKUP_PREFIX = 'backup:';

/** 그룹 노드 id. 로컬·원격은 폴더 트리와 같은 id 다 (펼침 상태 키) */
export const REPO_GROUP_IDS = {
  local: groupNodeId('local'),
  remote: groupNodeId('remote'),
  tags: groupNodeId('tags'),
  worktrees: groupNodeId('worktrees'),
  backups: groupNodeId('backups'),
} as const;

/** 원격 이름 그룹의 노드 id */
export function remoteGroupNodeId(remote: string): string {
  return `${REMOTE_GROUP_PREFIX}${remote}`;
}

/** 워크트리 노드 id (경로로 가리킨다) */
export function worktreeNodeId(path: string): string {
  return `${WORKTREE_PREFIX}${path}`;
}

/** 백업 노드 id (백업 ref 이름으로 가리킨다) */
export function backupNodeId(name: string): string {
  return `${BACKUP_PREFIX}${name}`;
}

/**
 * 업스트림 차이 (옛 사이드바 `trackBadge` 와 같은 조건): 업스트림이 원격에서 사라졌으면 그 사실만, 아니면 앞섬·뒤처짐.
 * 아무것도 없으면 null (그리지 않는다). 표기는 공용 트리의 `⇣N ⇡N` 이다 (옛 사이드바는 `↑N ↓N`)
 */
export function labelTrack(label: RefLabel): BranchTrack | null {
  if (label.upstreamGone) {
    return { ahead: 0, behind: 0, gone: true };
  }
  const ahead = label.ahead ?? 0;
  const behind = label.behind ?? 0;
  return ahead > 0 || behind > 0 ? { ahead, behind, gone: false } : null;
}

/**
 * 로컬 브랜치 행의 배지 (옛 사이드바와 같은 조건·툴팁): 다른 워크트리에 체크아웃됨(현재 브랜치가 아닐 때),
 * 충돌 레이더(현재 브랜치가 아닐 때 — 깨끗하면 ok, 충돌이면 수와 앞 다섯 파일)
 */
export function localBadges(label: RefLabel, radar: readonly RadarEntry[]): BranchBadge[] {
  if (label.isCurrent) {
    return [];
  }
  const badges: BranchBadge[] = [];
  if (label.worktreePath) {
    badges.push({ icon: 'worktree', title: S.sidebar.checkedOutAt(label.worktreePath) });
  }
  const r = radar.find((x) => x.reference === label.shortName);
  if (r) {
    badges.push(
      r.clean
        ? { icon: 'radarOk', title: S.preview.radarClean }
        : {
            icon: 'radarConflict',
            text: String(r.conflicts.length),
            title: `${S.preview.radarConflict(r.conflicts.length)}: ${r.conflicts.slice(0, 5).join(', ')}`,
          },
    );
  }
  return badges;
}

/** 로컬·원격 브랜치 잎. 원격은 원격 이름 그룹 아래에 있으므로 이름에서 원격을 뗀다 (옛 사이드바와 같다) */
function branchLeaf(
  label: RefLabel,
  input: RepoBranchTreeInput,
  kind: 'local' | 'remote',
): BranchTreeNode {
  const track = kind === 'local' ? labelTrack(label) : null;
  const badges = kind === 'local' ? localBadges(label, input.radar) : [];
  return {
    id: refNodeId(label.fullName),
    kind,
    label: kind === 'remote' ? remoteBranchName(label) : label.shortName,
    fullName: label.fullName,
    current: label.isCurrent,
    favorite: input.isFavorite(label.fullName),
    favoritable: true,
    ...(track ? { track } : {}),
    ...(badges.length > 0 ? { badges } : {}),
  };
}

/** 워크트리 행의 이름: 브랜치, 분리 HEAD 면 `detached <해시>` (옛 사이드바와 같다) */
export function worktreeLabel(wt: WorktreeInfo): string {
  return wt.branch ?? (wt.head ? `${S.sidebar.detached} ${shortHash(wt.head)}` : '');
}

/** 워크트리 행의 회색 글자: 메인·잠김·폴더 없음 (옛 사이드바와 같은 조건) */
export function worktreeSuffix(wt: WorktreeInfo): string {
  return [
    wt.isMain ? S.sidebar.main : '',
    wt.locked !== null ? S.sidebar.locked : '',
    wt.prunable !== null ? S.sidebar.prunable : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** 그룹 노드. 비었으면 만들지 않는다 (`keepEmpty` 면 만든다) */
function group(
  id: string,
  label: string,
  children: BranchTreeNode[],
  options: { count?: number; defaultCollapsed?: boolean; keepEmpty?: boolean } = {},
): BranchTreeNode[] {
  if (children.length === 0 && !options.keepEmpty) {
    return [];
  }
  return [
    {
      id,
      kind: 'group',
      label,
      count: options.count ?? children.length,
      children,
      ...(options.defaultCollapsed ? { defaultCollapsed: true } : {}),
    },
  ];
}

/** HEAD 에 커밋이 있으면 그 커밋 (현재 브랜치·분리 HEAD). 커밋이 없으면(unborn) null */
export function headCommit(head: HeadState): string | null {
  return head.state === 'unborn' ? null : head.oid;
}

/**
 * 저장소 탭의 브랜치 트리 (BT-01·11): `HEAD (현재 브랜치)` 행, Local, Remote(원격 이름마다 그룹), Tags(기본 접힘,
 * 이름 역순), Worktrees(늘 둔다 — 머리 동작 "만들기"가 붙는다), Backups(있을 때만, 기본 접힘).
 * 브랜치는 폴더 트리(W5)처럼 평면이고(이름의 `/` 로 폴더를 만들지 않는다) 현재 > 즐겨찾기 > 이름 순이다 (BT-02).
 * 원격 이름 그룹은 이름 순, 워크트리·백업은 받은 순서 그대로다 (옛 사이드바와 같다)
 */
export function buildRepoBranchTree(input: RepoBranchTreeInput): BranchTreeNode[] {
  const locals: BranchTreeNode[] = [];
  const remotes = new Map<string, BranchTreeNode[]>();
  const tags: RefLabel[] = [];
  for (const l of input.labels) {
    if (l.kind.kind === 'localBranch') {
      locals.push(branchLeaf(l, input, 'local'));
    } else if (l.kind.kind === 'remoteBranch') {
      const list = remotes.get(l.kind.remote) ?? [];
      list.push(branchLeaf(l, input, 'remote'));
      remotes.set(l.kind.remote, list);
    } else if (l.kind.kind === 'tag') {
      tags.push(l);
    }
  }
  const remoteGroups = [...remotes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([remote, list]): BranchTreeNode => ({
        id: remoteGroupNodeId(remote),
        kind: 'group',
        label: remote,
        children: sortBranchNodes(list),
      }),
    );
  const remoteCount = remoteGroups.reduce((n, g) => n + (g.children?.length ?? 0), 0);
  // 태그는 이름 역순 (옛 사이드바: 이름순 정렬 뒤 뒤집기 — 새 버전이 위로)
  const tagNodes = tags
    .sort((a, b) => a.shortName.localeCompare(b.shortName))
    .reverse()
    .map(
      (l): BranchTreeNode => ({
        id: refNodeId(l.fullName),
        kind: 'tag',
        label: l.shortName,
        fullName: l.fullName,
      }),
    );
  const worktreeNodes = input.worktrees.map((wt): BranchTreeNode => {
    const suffix = worktreeSuffix(wt);
    const current = wt.path === input.path;
    return {
      id: worktreeNodeId(wt.path),
      kind: 'worktree',
      label: worktreeLabel(wt),
      ...(suffix ? { suffix } : {}),
      ...(current ? { current: true, currentTitle: S.branches.currentWorktree } : {}),
    };
  });
  const backupNodes = input.backups.map(
    (b): BranchTreeNode => ({
      id: backupNodeId(b.name),
      kind: 'backup',
      label: b.branch,
      suffix: formatDateTime(b.createdAt ?? 0),
    }),
  );
  const head: BranchTreeNode[] =
    headCommit(input.head) === null
      ? []
      : [{ id: HEAD_NODE_ID, kind: 'head', label: S.branches.head }];
  return [
    ...head,
    ...group(REPO_GROUP_IDS.local, S.branches.local, sortBranchNodes(locals)),
    ...group(REPO_GROUP_IDS.remote, S.branches.remote, remoteGroups, { count: remoteCount }),
    ...group(REPO_GROUP_IDS.tags, S.sidebar.tags, tagNodes, { defaultCollapsed: true }),
    ...group(REPO_GROUP_IDS.worktrees, S.sidebar.worktrees, worktreeNodes, { keepEmpty: true }),
    ...group(REPO_GROUP_IDS.backups, S.safety.backups, backupNodes, { defaultCollapsed: true }),
  ];
}

/** 노드가 가리키는 것 (메뉴·클릭·더블클릭의 대상). 옛 사이드바의 `Target` 에 HEAD 행과 워크트리 그룹을 더했다 */
export type RepoBranchTarget =
  | { kind: 'head'; oid: string }
  | { kind: 'local'; label: RefLabel }
  | { kind: 'remote'; label: RefLabel; remote: string }
  | { kind: 'remoteGroup'; remote: string }
  | { kind: 'tag'; label: RefLabel }
  | { kind: 'worktreeGroup' }
  | { kind: 'worktree'; worktree: WorktreeInfo }
  | { kind: 'backup'; backup: BackupRef };

/**
 * 노드 id → 대상. 세션의 지금 상태에서 찾는다 (우클릭·클릭한 순간의 값). 대상이 없는 노드(로컬·원격·태그·백업
 * 그룹)나 이미 사라진 것이면 null
 */
export function repoBranchTarget(
  nodeId: string,
  source: RepoBranchSource,
): RepoBranchTarget | null {
  if (nodeId === HEAD_NODE_ID) {
    const oid = headCommit(source.head);
    return oid === null ? null : { kind: 'head', oid };
  }
  if (nodeId === REPO_GROUP_IDS.worktrees) {
    return { kind: 'worktreeGroup' };
  }
  if (nodeId.startsWith(REMOTE_GROUP_PREFIX)) {
    return { kind: 'remoteGroup', remote: nodeId.slice(REMOTE_GROUP_PREFIX.length) };
  }
  if (nodeId.startsWith(WORKTREE_PREFIX)) {
    const path = nodeId.slice(WORKTREE_PREFIX.length);
    const worktree = source.worktrees.find((wt) => wt.path === path);
    return worktree ? { kind: 'worktree', worktree } : null;
  }
  if (nodeId.startsWith(BACKUP_PREFIX)) {
    const name = nodeId.slice(BACKUP_PREFIX.length);
    const backup = source.backups.find((b) => b.name === name);
    return backup ? { kind: 'backup', backup } : null;
  }
  const label = source.labels.find((l) => refNodeId(l.fullName) === nodeId);
  switch (label?.kind.kind) {
    case 'localBranch':
      return { kind: 'local', label };
    case 'remoteBranch':
      return { kind: 'remote', label, remote: label.kind.remote };
    case 'tag':
      return { kind: 'tag', label };
    default:
      return null;
  }
}

/**
 * 클릭(Space)하면 이동할 커밋 (결정 16번 — 저장소 탭은 그 커밋으로 이동, 옛 사이드바 그대로): ref 는 가리키는 커밋,
 * 백업은 백업 커밋, HEAD 행은 HEAD 커밋. 워크트리 행은 옛 사이드바에 클릭 동작이 없었으므로 null
 */
export function repoTargetCommit(target: RepoBranchTarget): string | null {
  switch (target.kind) {
    case 'head':
      return target.oid;
    case 'local':
    case 'remote':
    case 'tag':
      return target.label.target;
    case 'backup':
      return target.backup.oid;
    default:
      return null;
  }
}
