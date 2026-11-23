// 폴더 탭 프로젝트 트리의 우클릭 메뉴 (W12, PT-07). 행 종류(루트·저장소·일반 폴더·파일)마다 동작하는 항목만 둔다.
// 대상은 우클릭한 행이 선택에 들어 있으면 선택 전체, 아니면 그 행 하나다 (`menuTargets`). 쓰기 동작(일괄 작업)은
// 항목 이름에 대상 저장소의 이름이나 수를 붙이고, 실행은 기존 일괄 흐름(`useFolderBatchFlows`)에 맡긴다 — 확인창과
// 코어의 안전 규칙이 그대로다. 저장소 안 파일 하나에는 파일 히스토리·blame 이 있다 (W13 — 가장 안쪽 저장소의 세션).

import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { parseNoteRowId, type SelectionSet } from '../../store/file-tree';
import { joinRoot } from '../../store/fs-path';
import type { ProjectOpenMode } from '../project/ProjectTree';
import type { EntryRow, RootRow } from '../project/project-tree-model';

/** 메뉴가 거는 동작 (컨테이너가 주입한다). 저장소는 절대 경로로 넘긴다 */
export interface FolderTreeMenuActions {
  refresh(): void;
  rescan(): void;
  openSettings(): void;
  openRepoTab(repoPath: string): void;
  openFile(path: string, mode: ProjectOpenMode): void;
  fetch(repos: readonly string[]): void;
  pull(repos: readonly string[]): void;
  push(repos: readonly string[]): void;
  createBranch(repos: readonly string[]): void;
  checkout(repos: readonly string[]): void;
  worktree(repos: readonly string[]): void;
  /** 파일 히스토리 (저장소 절대 경로, 저장소 기준 상대 경로) */
  fileHistory(repoPath: string, path: string): void;
  /** 작업 트리 파일의 blame (저장소 절대 경로, 저장소 기준 상대 경로) */
  blame(repoPath: string, path: string): void;
  copy(text: string): void;
}

/** 메뉴를 만들 때 필요한 것 */
export interface FolderTreeMenuInput {
  /** 우클릭한 행 */
  row: RootRow | EntryRow;
  /** 대상 행 id (`menuTargets`) */
  targets: readonly string[];
  /** 폴더(트리 루트)의 절대 경로 */
  root: string;
  /** 루트 기준 상대 경로가 저장소 디렉터리면 그 저장소, 아니면 null */
  repoAt(rel: string): { path: string; name: string } | null;
  /** 파일 보기로 열 수 있는 파일 행인지 */
  isOpenable(rel: string): boolean;
  /**
   * 루트 기준 상대 경로의 파일이 속한 가장 안쪽 저장소와 그 저장소 기준 경로 (`rootToRepo`). 저장소 밖이거나
   * 저장소 세션 기능을 쓸 수 없으면 null
   */
  fileRepo(rel: string): { repoPath: string; path: string } | null;
  /** 폴더의 저장소 수 ("전체 Fetch" 표기) */
  repoCount: number;
  /** 일괄 작업이 도는 중이면 쓰기 동작을 막는다 */
  busy: boolean;
}

/**
 * 메뉴의 대상 행 id (PT-07): 우클릭한 행이 선택에 들어 있으면 선택 전체(보이는 순서, 안 보이는 것은 그 뒤), 아니면
 * 그 행 하나. 안내 줄은 빼고, 루트는 혼자일 때만 대상이다
 */
export function menuTargets(
  id: string,
  selection: SelectionSet,
  order: readonly string[],
): string[] {
  if (selection[id] !== true) {
    return [id];
  }
  const shown = new Set(order);
  const ids = [
    ...order.filter((x) => selection[x] === true),
    ...Object.keys(selection)
      .filter((x) => !shown.has(x))
      .sort(),
  ].filter((x) => parseNoteRowId(x) === null);
  return ids.length > 1 ? ids.filter((x) => x !== '') : ids;
}

/** 여러 대상이면 수를 붙인다 */
function counted(label: string, n: number): string {
  return n > 1 ? S.project.menu.many(label, n) : label;
}

/** 일반 폴더·파일 행의 메뉴가 쓰는 입력 (폴더 탭·저장소 탭 공용, W21) */
export type EntryMenuInput = Pick<
  FolderTreeMenuInput,
  'targets' | 'root' | 'isOpenable' | 'fileRepo'
> & { row: EntryRow };

/** 일반 폴더·파일 행의 메뉴가 거는 동작 (폴더 탭·저장소 탭 공용, W21) */
export type EntryMenuActions = Pick<
  FolderTreeMenuActions,
  'openFile' | 'fileHistory' | 'blame' | 'copy'
>;

/** 경로 복사 두 항목 (일반 폴더·파일). 루트 기준 상대 경로와 절대 경로, 여러 대상이면 줄마다 하나 */
function copyItems(
  input: Pick<FolderTreeMenuInput, 'targets' | 'root'>,
  act: Pick<FolderTreeMenuActions, 'copy'>,
  separator: boolean,
) {
  const { targets, root } = input;
  const m = S.project.menu;
  return [
    {
      label: counted(m.copyPath, targets.length),
      separator,
      onSelect: () => act.copy(targets.map((t) => joinRoot(root, t)).join('\n')),
    },
    {
      label: counted(m.copyRelative, targets.length),
      onSelect: () => act.copy(targets.join('\n')),
    },
  ];
}

/** 프로젝트 트리 행의 우클릭 메뉴 */
export function folderTreeMenu(input: FolderTreeMenuInput, act: FolderTreeMenuActions): MenuItem[] {
  const { row, targets, root, busy } = input;
  const m = S.project.menu;
  if (row.kind === 'root') {
    return [
      { label: S.folder.refresh, onSelect: act.refresh },
      { label: S.folder.rescan, onSelect: act.rescan },
      { label: S.project.settings, onSelect: act.openSettings },
      {
        label: m.fetchAll(input.repoCount),
        separator: true,
        disabled: busy,
        onSelect: () => act.fetch([]),
      },
      { label: m.copyPath, separator: true, onSelect: () => act.copy(joinRoot(root, '')) },
    ];
  }
  if (input.repoAt(row.path) !== null) {
    const repos = targets.flatMap((t) => {
      const repo = input.repoAt(t);
      return repo ? [repo] : [];
    });
    const paths = repos.map((r) => r.path);
    const scope = repos.length === 1 ? (repos[0]?.name ?? '') : m.repos(repos.length);
    const scoped = (label: string) => S.folder.batch.withScope(label, scope);
    return [
      ...(repos.length === 1 && repos[0]
        ? [{ label: S.project.openAsTab, onSelect: () => act.openRepoTab(paths[0] ?? '') }]
        : []),
      {
        label: scoped(S.remote.fetch),
        separator: repos.length === 1,
        disabled: busy,
        onSelect: () => act.fetch(paths),
      },
      { label: scoped(S.remote.pull), disabled: busy, onSelect: () => act.pull(paths) },
      { label: scoped(m.push), disabled: busy, onSelect: () => act.push(paths) },
      {
        label: scoped(S.branches.toolbar.newBranch),
        separator: true,
        disabled: busy,
        onSelect: () => act.createBranch(paths),
      },
      {
        label: scoped(S.branches.menu.checkout),
        disabled: busy,
        onSelect: () => act.checkout(paths),
      },
      {
        label: scoped(S.folder.batch.worktree),
        disabled: busy,
        onSelect: () => act.worktree(paths),
      },
      {
        label: counted(m.copyPath, targets.length),
        separator: true,
        onSelect: () => act.copy(targets.map((t) => joinRoot(root, t)).join('\n')),
      },
    ];
  }
  return entryMenu({ ...input, row }, act);
}

/**
 * 일반 폴더·파일 행의 우클릭 메뉴 (폴더 탭 W12·W13, 저장소 탭 W21): 폴더·열 수 없는 항목은 경로 복사만, 파일은 열기
 * (미리보기·새 탭, 여러 파일이면 모두 새 탭) + 저장소 안 파일 하나면 파일 히스토리·blame + 경로 복사
 */
export function entryMenu(input: EntryMenuInput, act: EntryMenuActions): MenuItem[] {
  const { row, targets } = input;
  const m = S.project.menu;
  if (row.entryKind === 'dir' || !input.isOpenable(row.path)) {
    // 일반 폴더, 열 수 없는 항목(링크·특수 파일·이름이 너무 긴 파일): 복사만
    return copyItems(input, act, false);
  }
  const files = targets.filter((t) => input.isOpenable(t));
  const open: MenuItem[] =
    files.length > 1
      ? [
          {
            label: counted(m.openPinned, files.length),
            onSelect: () => {
              for (const path of files) {
                act.openFile(path, 'pinned');
              }
            },
          },
        ]
      : [
          { label: m.open, onSelect: () => act.openFile(row.path, 'preview') },
          { label: m.openPinned, onSelect: () => act.openFile(row.path, 'pinned') },
        ];
  // 파일 히스토리·blame: 저장소 안의 파일 하나일 때만 (여러 항목을 고른 채면 없다)
  const repo = targets.length === 1 ? input.fileRepo(row.path) : null;
  const vcs: MenuItem[] = repo
    ? [
        {
          label: S.menu.fileHistory,
          separator: true,
          onSelect: () => act.fileHistory(repo.repoPath, repo.path),
        },
        { label: S.menu.blame, onSelect: () => act.blame(repo.repoPath, repo.path) },
      ]
    : [];
  return [...open, ...vcs, ...copyItems(input, act, true)];
}
