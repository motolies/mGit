// 파일 동작 메뉴 항목 (프로젝트 트리의 폴더 탭·저장소 탭, 폴더 탭 Commit 도구 창 공용): Finder 에서 보기, 터미널에서 열기,
// 변경 되돌리기(HEAD 기준 Rollback), .gitignore 에 추가. 순수 함수만 둔다 — 대상 계산(어느 status 항목을 되돌리나·ignore
// 할 수 있나)과 메뉴 항목 만들기. 확인창·실행·트리 다시 읽기는 컨테이너(`use-file-actions`)가 맡는다.
//
// - 되돌리기는 대상(여러 개 선택 포함)이 status 항목 자신이거나 그 항목을 품은 폴더일 때 보인다. 확인창에 보인 목록과
//   실제로 되돌리는 목록이 같도록 폴더를 항목 경로들로 펼쳐 넘긴다. 충돌 항목과 통째로 untracked 인 디렉터리(`dir/` —
//   git 이 내려가지 않는 중첩 저장소, 백업할 수 없다)는 뺀다. 진행 중 작업의 stage 항목 거부는 코어가 한다
// - ignore 는 untracked 파일 하나(이 파일 / *.ext / 폴더/)나 untracked 항목을 품은 폴더 하나(이 폴더/)에만 보인다

import type { StatusEntry } from '@mgit/ipc';
import { isMac, S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { isWithin, relativeTo } from '../../store/fs-path';

/** 저장소 안의 대상 하나: 저장소 절대 경로와 그 저장소 기준 경로 ('' 는 저장소 디렉터리 자신 — 전부) */
export interface RepoTarget {
  repoPath: string;
  path: string;
}

/** 되돌릴 묶음: 저장소 하나와 그 저장소 기준 항목 경로들 (status 항목의 현재 경로) */
export interface RollbackGroup {
  repoPath: string;
  paths: string[];
}

/** ignore 할 대상: untracked 파일 하나, 또는 untracked 항목을 품은 폴더 하나 */
export interface IgnoreTarget {
  repoPath: string;
  path: string;
  dir: boolean;
}

/** 메뉴가 거는 파일 동작 (컨테이너가 확인창·실행·트리 다시 읽기를 맡는다) */
export interface FileActions {
  /** Finder(파일 탐색기)에서 보기 — 절대 경로 */
  reveal(abs: string): void;
  /** 터미널에서 열기 — 절대 경로 (파일이면 셸이 부모 폴더로 연다) */
  terminal(abs: string): void;
  /** 확인창을 띄워 되돌린다 */
  rollback(groups: readonly RollbackGroup[]): void;
  /** 저장소의 `.gitignore` 에 패턴을 더한다 */
  ignore(repoPath: string, patterns: string[]): void;
}

/** "Finder 에서 보기"(macOS) / "파일 탐색기에서 보기"(그 밖) */
export function revealLabel(): string {
  return isMac() ? S.actions.revealFinder : S.actions.reveal;
}

/** status 경로가 저장소 기준 대상 경로 자신이거나 그 아래인지 (`''` 는 전부, 끝의 `/` 는 뗀다) */
function under(path: string | null | undefined, want: string): boolean {
  if (path === null || path === undefined) {
    return false;
  }
  const p = path.replace(/\/+$/, '');
  return want === '' || p === want || p.startsWith(`${want}/`);
}

/**
 * 저장소의 status 항목 중 그 안의 다른 저장소(중첩 저장소·서브모듈 — `repoPaths` 에 든 더 깊은 것) 경로에 걸리는 항목을
 * 뺀다 (`buildStatusLookup` 과 같은 규칙 — 그 항목은 안쪽 저장소가 맡는다)
 */
export function ownEntries(
  repoPath: string,
  repoPaths: readonly string[],
  entries: readonly StatusEntry[],
): StatusEntry[] {
  const inner = repoPaths.flatMap((p) => {
    const rel = p === repoPath ? null : relativeTo(repoPath, p);
    return rel === null || rel === '' ? [] : [rel];
  });
  if (inner.length === 0) {
    return [...entries];
  }
  return entries.filter((e) => {
    const p = e.path.replace(/\/+$/, '');
    return !inner.some((rel) => isWithin(p, rel));
  });
}

/** 되돌릴 수 있는 항목인지: 충돌과 통째로 untracked 인 디렉터리(중첩 저장소)는 뺀다 */
function rollbackable(e: StatusEntry): boolean {
  const conflicted =
    (e.conflict ?? null) !== null || e.index === 'unmerged' || e.worktree === 'unmerged';
  const untrackedDir = e.worktree === 'untracked' && e.path.endsWith('/');
  return !conflicted && !untrackedDir && e.worktree !== 'ignored';
}

/**
 * 대상들을 저장소별 되돌릴 항목으로 펼친다 (대상의 저장소 순서, 저장소 안은 status 순서). 이름이 바뀐 항목은 원래
 * 경로로 골라도 된다. 되돌릴 것이 없는 저장소는 빠진다 — 빈 배열이면 메뉴에 항목을 두지 않는다
 */
export function rollbackGroups(
  targets: readonly RepoTarget[],
  entriesOf: (repoPath: string) => readonly StatusEntry[],
): RollbackGroup[] {
  const wanted = new Map<string, string[]>();
  for (const t of targets) {
    wanted.set(t.repoPath, [...(wanted.get(t.repoPath) ?? []), t.path]);
  }
  return [...wanted].flatMap(([repoPath, wants]) => {
    const paths = entriesOf(repoPath)
      .filter(rollbackable)
      .filter((e) => wants.some((w) => under(e.path, w) || under(e.origPath, w)))
      .map((e) => e.path);
    return paths.length > 0 ? [{ repoPath, paths }] : [];
  });
}

/** 묶음들의 파일 수 */
export function rollbackCount(groups: readonly RollbackGroup[]): number {
  return groups.reduce((n, g) => n + g.paths.length, 0);
}

/** 확인창의 목록: 저장소가 하나면 저장소 기준 경로, 여럿이면 `저장소 이름/경로` */
export function rollbackItems(
  groups: readonly RollbackGroup[],
  repoName: (repoPath: string) => string,
): string[] {
  if (groups.length === 1) {
    return [...(groups[0]?.paths ?? [])];
  }
  return groups.flatMap((g) => g.paths.map((p) => `${repoName(g.repoPath)}/${p}`));
}

/**
 * ignore 할 수 있는 대상인지: 파일이면 그 경로의 untracked 항목이 있을 때, 폴더면(저장소 디렉터리 자신은 아님) 그 아래
 * untracked 항목이 있을 때. 아니면 null
 */
export function ignoreTarget(
  target: RepoTarget,
  dir: boolean,
  entries: readonly StatusEntry[],
): IgnoreTarget | null {
  if (target.path === '') {
    return null;
  }
  const untracked = entries.filter((e) => e.worktree === 'untracked');
  const hit = dir
    ? untracked.some((e) => under(e.path, target.path))
    : untracked.some((e) => e.path === target.path);
  return hit ? { ...target, dir } : null;
}

/**
 * ignore 하위 메뉴 (CHG-10): 파일은 이 파일 / 확장자 / 상위 폴더 패턴, 폴더(`dir`)는 그 폴더 패턴 하나.
 * 저장소 탭 변경 목록과 함께 쓴다 (옛 `ChangesPanel` 의 `ignoreMenu`)
 */
export function ignoreMenuItem(
  path: string,
  add: (patterns: string[]) => void,
  dir = false,
): MenuItem {
  if (dir) {
    return {
      label: S.safety.ignore,
      separator: true,
      children: [{ label: S.safety.ignoreDir(path), onSelect: () => add([`${path}/`]) }],
    };
  }
  const slash = path.lastIndexOf('/');
  const parent = slash > 0 ? path.slice(0, slash) : null;
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : null;
  const children: MenuItem[] = [{ label: S.safety.ignoreFile(path), onSelect: () => add([path]) }];
  if (ext) {
    children.push({ label: S.safety.ignoreExt(ext), onSelect: () => add([`*.${ext}`]) });
  }
  if (parent) {
    children.push({ label: S.safety.ignoreDir(parent), onSelect: () => add([`${parent}/`]) });
  }
  return { label: S.safety.ignore, separator: true, children };
}

/** 변경 묶음 (변경 되돌리기·ignore). 둘 다 없으면 빈 배열 */
export function changeItems(
  input: { rollback: readonly RollbackGroup[]; ignore: IgnoreTarget | null },
  act: Pick<FileActions, 'rollback' | 'ignore'>,
): MenuItem[] {
  const items: MenuItem[] = [];
  const n = rollbackCount(input.rollback);
  if (n > 0) {
    const m = S.project.menu;
    items.push({
      label: n > 1 ? m.many(m.rollback, n) : m.rollback,
      onSelect: () => act.rollback(input.rollback),
    });
  }
  const ignore = input.ignore;
  if (ignore) {
    items.push(
      ignoreMenuItem(ignore.path, (patterns) => act.ignore(ignore.repoPath, patterns), ignore.dir),
    );
  }
  // 한 묶음이라 안쪽 구분선은 없다. 묶음 앞 구분선은 묶는 쪽(`joinGroups`)이 정한다
  return items.map((item) => ({ ...item, separator: false }));
}

/** 열기 묶음 (Finder 에서 보기·터미널에서 열기) — 절대 경로 하나 */
export function openInItems(
  abs: string,
  act: Pick<FileActions, 'reveal' | 'terminal'>,
): MenuItem[] {
  return [
    { label: revealLabel(), onSelect: () => act.reveal(abs) },
    { label: S.actions.openTerminal, onSelect: () => act.terminal(abs) },
  ];
}

/** 묶음들을 이어 붙인다: 빈 묶음은 빼고, 둘째 묶음부터 첫 항목 앞에 구분선 (트리 메뉴 두 탭 공용) */
export function joinGroups(groups: readonly MenuItem[][]): MenuItem[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) =>
      i === 0 ? g : g.map((item, j) => (j === 0 ? { ...item, separator: true } : item)),
    );
}
