import type { FolderBranch, FolderBranchRepo, GraphRevs } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import {
  type BranchTrack,
  type BranchTreeNode,
  groupNodeId,
  HEAD_NODE_ID,
  LOCAL_REF_PREFIX,
  REMOTE_REF_PREFIX,
  refNodeId,
  sortBranchNodes,
} from './branch-tree-model';

/** 브랜치의 전체 ref 이름. 즐겨찾기 저장 키이므로 저장소 탭의 빌더(W22)와 같은 형식이어야 한다 */
export function folderBranchFullName(branch: Pick<FolderBranch, 'name' | 'remote'>): string {
  return `${branch.remote ? REMOTE_REF_PREFIX : LOCAL_REF_PREFIX}${branch.name}`;
}

/** 브랜치의 노드 id */
export function folderBranchNodeId(branch: Pick<FolderBranch, 'name' | 'remote'>): string {
  return refNodeId(folderBranchFullName(branch));
}

export interface FolderBranchTreeInput {
  /** 코어가 이름으로 합쳐 준 브랜치 목록 (`folderBranches`) */
  branches: readonly FolderBranch[];
  /** 브랜치 목록의 저장소: 이름과 HEAD */
  repos: readonly FolderBranchRepo[];
  /** 전체 ref 이름이 즐겨찾기인지 */
  isFavorite: (fullName: string) => boolean;
  /** 원격 그룹을 뺄지 (원격 숨기기) */
  hideRemotes: boolean;
}

/** 경로의 마지막 요소 (저장소 목록에 없는 경로의 이름) */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 저장소 경로 → 이름 */
type RepoNames = (path: string) => string;

/** 저장소 목록으로 경로 → 이름 찾기를 만든다 */
function repoNamesOf(repos: readonly FolderBranchRepo[]): RepoNames {
  const names = new Map(repos.map((repo) => [repo.path, repo.name]));
  return (path) => names.get(path) ?? baseName(path);
}

/** 업스트림 차이의 글자 표기: `⇣54 ⇡3`, 원격에서 사라졌으면 그 사실 */
export function trackText(track: BranchTrack): string {
  return [
    track.behind > 0 ? S.branches.incoming(track.behind) : '',
    track.ahead > 0 ? S.branches.outgoing(track.ahead) : '',
    track.gone ? S.sidebar.gone : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * 브랜치의 저장소별 업스트림 차이를 합친다 (BT-08): 행에는 합계를, 툴팁에는 저장소별 수치를 쓴다.
 * 어느 저장소에서도 차이가 없으면 null (아무것도 그리지 않는다)
 */
function folderTrack(
  branch: FolderBranch,
  nameOf: RepoNames,
): Pick<BranchTreeNode, 'track' | 'trackTitle'> | null {
  const total: BranchTrack = { ahead: 0, behind: 0, gone: false };
  const lines: string[] = [];
  for (const repo of branch.repos) {
    const own: BranchTrack = {
      ahead: repo.ahead ?? 0,
      behind: repo.behind ?? 0,
      gone: repo.gone,
    };
    if (own.ahead === 0 && own.behind === 0 && !own.gone) {
      continue;
    }
    total.ahead += own.ahead;
    total.behind += own.behind;
    total.gone ||= own.gone;
    lines.push(S.branches.trackOf(nameOf(repo.path), trackText(own)));
  }
  return lines.length === 0 ? null : { track: total, trackTitle: lines.join('\n') };
}

/** 브랜치 하나의 잎 노드 */
function branchLeaf(
  branch: FolderBranch,
  nameOf: RepoNames,
  isFavorite: FolderBranchTreeInput['isFavorite'],
): BranchTreeNode {
  const fullName = folderBranchFullName(branch);
  const currentIn = branch.repos.filter((repo) => repo.current);
  const everywhere = currentIn.length === branch.repos.length;
  const names = (repos: readonly { path: string }[]) =>
    repos.map((repo) => nameOf(repo.path)).join(', ');
  return {
    id: refNodeId(fullName),
    kind: branch.remote ? 'remote' : 'local',
    label: branch.name,
    fullName,
    current: currentIn.length === 0 ? false : everywhere ? true : 'partial',
    // 일부 저장소에서만 현재면 어느 저장소인지 알린다
    ...(currentIn.length > 0 && !everywhere
      ? { currentTitle: S.branches.currentIn(names(currentIn)) }
      : {}),
    favorite: isFavorite(fullName),
    favoritable: true,
    suffix: S.folder.timeline.inRepos(names(branch.repos)),
    ...(folderTrack(branch, nameOf) ?? {}),
  };
}

/** 그룹 노드. 브랜치가 없으면 만들지 않는다 */
function branchGroup(
  name: 'local' | 'remote',
  branches: readonly FolderBranch[],
  nameOf: RepoNames,
  isFavorite: FolderBranchTreeInput['isFavorite'],
): BranchTreeNode[] {
  if (branches.length === 0) {
    return [];
  }
  return [
    {
      id: groupNodeId(name),
      kind: 'group',
      label: S.branches[name],
      count: branches.length,
      children: sortBranchNodes(branches.map((branch) => branchLeaf(branch, nameOf, isFavorite))),
    },
  ];
}

/** 저장소의 HEAD 에 커밋이 있는지 (현재 브랜치든 분리 HEAD 든). 커밋 없는 저장소·읽지 못한 저장소는 아니다 */
function hasHeadCommit(repo: FolderBranchRepo): boolean {
  const state = repo.head?.state;
  return state === 'attached' || state === 'detached';
}

/**
 * 폴더의 브랜치 트리 (BT-01·02): `HEAD (현재 브랜치)` 행, 로컬 그룹, 원격 그룹.
 * 그룹 안은 평면이고(이름의 `/` 로 폴더를 만들지 않는다) 현재 > 즐겨찾기 > 이름 순이다.
 * HEAD 행은 HEAD 에 커밋이 있는 저장소가 하나라도 있을 때만 둔다 — 볼 이력이 없으면 누를 수 없는 행이 된다
 */
export function buildFolderBranchTree(input: FolderBranchTreeInput): BranchTreeNode[] {
  const nameOf = repoNamesOf(input.repos);
  const local = input.branches.filter((branch) => !branch.remote);
  const remote = input.hideRemotes ? [] : input.branches.filter((branch) => branch.remote);
  const head: BranchTreeNode[] = input.repos.some(hasHeadCommit)
    ? [{ id: HEAD_NODE_ID, kind: 'head', label: S.branches.head }]
    : [];
  return [
    ...head,
    ...branchGroup('local', local, nameOf, input.isFavorite),
    ...branchGroup('remote', remote, nameOf, input.isFavorite),
  ];
}

/** 범위가 고른 브랜치 이름들. 전체·HEAD 범위면 빈 목록 */
export function branchNamesOfRevs(revs: GraphRevs): string[] {
  switch (revs.kind) {
    case 'solo':
      return [revs.name];
    case 'branches':
      return revs.names;
    default:
      return [];
  }
}

/** 두 범위가 같은지. 같은 범위로 다시 질의하지 않으려고 본다 (branches 는 이름 순서까지 같아야 한다) */
export function sameRevs(a: GraphRevs, b: GraphRevs): boolean {
  const left = branchNamesOfRevs(a);
  const right = branchNamesOfRevs(b);
  return (
    a.kind === b.kind && left.length === right.length && left.every((name, i) => name === right[i])
  );
}

/** 브랜치 이름들을 범위로: 없으면 전체, 하나면 solo, 여럿이면 branches */
export function revsOfBranchNames(names: readonly string[]): GraphRevs {
  const [first] = names;
  if (first === undefined) {
    return { kind: 'all' };
  }
  return names.length === 1
    ? { kind: 'solo', name: first }
    : { kind: 'branches', names: [...names] };
}

/**
 * HEAD 행을 눌렀을 때의 범위 (BT-03): 저장소마다 자기 HEAD 에서 닿는 커밋만 본다. 분리 HEAD 인 저장소는
 * 그 커밋부터 나오고, 현재 브랜치와 이름이 같은 다른 저장소의 브랜치는 섞이지 않는다
 */
export function headRevs(): GraphRevs {
  return { kind: 'head' };
}

/** 범위가 HEAD 행의 범위인지 */
export function isHeadRevs(revs: GraphRevs): boolean {
  return revs.kind === 'head';
}

/**
 * 브랜치를 눌렀을 때의 다음 범위 (BT-03). 그냥 누르면 그 브랜치만, `additive`(⌘/Ctrl 클릭)면 지금 고른
 * 브랜치들에 더하거나 뺀다. HEAD 범위에서 더하면 그 브랜치만 남는다 (HEAD 범위는 이름을 고른 것이 아니다)
 */
export function revsAfterActivate(revs: GraphRevs, name: string, additive: boolean): GraphRevs {
  if (!additive) {
    return { kind: 'solo', name };
  }
  const names = branchNamesOfRevs(revs);
  return revsOfBranchNames(
    names.includes(name) ? names.filter((other) => other !== name) : [...names, name],
  );
}

/** 범위에 맞춰 선택된 것으로 그릴 노드 id. HEAD 범위면 HEAD 행 하나다 */
export function selectedBranchNodeIds(
  revs: GraphRevs,
  branches: readonly FolderBranch[],
): string[] {
  if (isHeadRevs(revs)) {
    return [HEAD_NODE_ID];
  }
  const names = new Set(branchNamesOfRevs(revs));
  return branches.filter((branch) => names.has(branch.name)).map(folderBranchNodeId);
}

/** 저장소의 HEAD 표기 한 줄. HEAD 에 커밋이 없으면(또는 읽지 못했으면) null */
function headLine(repo: FolderBranchRepo): string | null {
  const head = repo.head ?? null;
  if (head?.state === 'attached') {
    return S.branches.headOf(repo.name, head.branch);
  }
  if (head?.state === 'detached') {
    return S.branches.headOf(repo.name, S.branches.detachedAt(shortHash(head.oid)));
  }
  return null;
}

/**
 * 로그 머리의 칩에 쓸 범위 표기. 전체면 null (칩을 그리지 않는다).
 * HEAD 범위의 툴팁은 저장소마다의 HEAD (현재 브랜치 또는 분리 HEAD 의 커밋)다
 */
export function describeRevs(
  revs: GraphRevs,
  repos: readonly FolderBranchRepo[],
): { label: string; title: string } | null {
  if (isHeadRevs(revs)) {
    const lines = repos.flatMap((repo) => headLine(repo) ?? []);
    return { label: S.branches.head, title: lines.join('\n') };
  }
  const names = branchNamesOfRevs(revs);
  const [first] = names;
  if (first === undefined) {
    return null;
  }
  return {
    label: names.length === 1 ? first : S.folder.timeline.moreBranches(first, names.length - 1),
    title: names.join(', '),
  };
}

/**
 * 원격 브랜치를 (원격, 브랜치) 로 나눈다 (`origin/feature/x` → `origin`, `feature/x`).
 * 코어가 원격 이름을 주지 못했으면 이름의 첫 마디를 원격으로 본다. 나눌 수 없으면 null
 */
export function remoteBranchParts(
  branch: Pick<FolderBranch, 'name' | 'remoteName'>,
): { remote: string; branch: string } | null {
  const remote = branch.remoteName ?? branch.name.split('/')[0] ?? '';
  const rest = branch.name.startsWith(`${remote}/`) ? branch.name.slice(remote.length + 1) : '';
  return remote === '' || rest === '' ? null : { remote, branch: rest };
}
