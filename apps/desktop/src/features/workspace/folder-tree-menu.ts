// 폴더 탭 프로젝트 트리의 우클릭 메뉴 (W12, PT-07). 행 종류(루트·저장소·일반 폴더·파일)마다 동작하는 항목만 둔다.
// 대상은 우클릭한 행이 선택에 들어 있으면 선택 전체, 아니면 그 행 하나다 (`menuTargets`). 쓰기 동작(일괄 작업)은
// 항목 이름에 대상 저장소의 이름이나 수를 붙이고, 실행은 기존 일괄 흐름(`useFolderBatchFlows`)에 맡긴다 — 확인창과
// 코어의 안전 규칙이 그대로다. 저장소 안 파일 하나에는 파일 히스토리·blame 이 있다 (W13 — 가장 안쪽 저장소의 세션).
// 파일 동작(Finder·터미널·변경 되돌리기·ignore)은 재료(`files`)와 동작(`files`)을 받을 때만 둔다 (`file-actions-menu`).

import type { StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { parseNoteRowId, type SelectionSet } from '../../store/file-tree';
import { joinRoot } from '../../store/fs-path';
import {
  changeItems,
  type FileActions,
  ignoreTarget,
  joinGroups,
  openInItems,
  type RepoTarget,
  rollbackGroups,
} from '../project/file-actions-menu';
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
  /** 파일 동작 (Finder·터미널·변경 되돌리기·ignore). 없으면 그 항목들을 두지 않는다 */
  files?: FileActions;
}

/** 파일 동작의 재료 (컨테이너가 준다) */
export interface FileMenuSource {
  /**
   * 루트 기준 상대 경로를 품은 저장소(이 화면이 쓰기를 걸 수 있는 것)와 그 저장소 기준 경로 ('' 는 저장소 디렉터리 자신).
   * 저장소 밖이면 null — 변경 되돌리기·ignore 를 두지 않는다
   */
  target(rel: string): RepoTarget | null;
  /** 저장소의 지금 status 항목 (안쪽 저장소의 항목은 뺀 것, `ownEntries`) */
  entriesOf(repoPath: string): readonly StatusEntry[];
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
  /** 파일 동작의 재료. 없으면 그 항목들을 두지 않는다 */
  files?: FileMenuSource;
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
  'targets' | 'root' | 'isOpenable' | 'fileRepo' | 'files'
> & { row: EntryRow };

/** 일반 폴더·파일 행의 메뉴가 거는 동작 (폴더 탭·저장소 탭 공용, W21) */
export type EntryMenuActions = Pick<
  FolderTreeMenuActions,
  'openFile' | 'fileHistory' | 'blame' | 'copy' | 'files'
>;

/**
 * 우클릭한 행(`clicked`)과 대상 행들의 파일 동작 묶음: 변경 묶음(대상 전체의 변경 되돌리기, 대상이 하나면 ignore)과 열기
 * 묶음(우클릭한 행의 Finder·터미널). 동작이 없으면 둘 다 빈 배열, 재료가 없으면 변경 묶음만 빈 배열
 */
export function fileGroups(
  input: Pick<FolderTreeMenuInput, 'targets' | 'root' | 'files'>,
  clicked: { path: string; dir: boolean },
  act: Pick<FolderTreeMenuActions, 'files'>,
): { changes: MenuItem[]; openIn: MenuItem[] } {
  const files = act.files;
  if (!files) {
    return { changes: [], openIn: [] };
  }
  const openIn = openInItems(joinRoot(input.root, clicked.path), files);
  const source = input.files;
  if (!source) {
    return { changes: [], openIn };
  }
  const targets = input.targets.flatMap((t) => {
    const target = source.target(t);
    return target ? [target] : [];
  });
  const one = input.targets.length === 1 ? source.target(clicked.path) : null;
  const changes = changeItems(
    {
      rollback: rollbackGroups(targets, source.entriesOf),
      ignore: one ? ignoreTarget(one, clicked.dir, source.entriesOf(one.repoPath)) : null,
    },
    files,
  );
  return { changes, openIn };
}

/**
 * 경로 복사 두 항목 (일반 폴더·파일). 루트 기준 상대 경로와 절대 경로, 여러 대상이면 줄마다 하나. 앞 구분선은 묶는 쪽
 * (`joinGroups`)이 정한다
 */
function copyItems(
  input: Pick<FolderTreeMenuInput, 'targets' | 'root'>,
  act: Pick<FolderTreeMenuActions, 'copy'>,
) {
  const { targets, root } = input;
  const m = S.project.menu;
  return [
    {
      label: counted(m.copyPath, targets.length),
      separator: false,
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
    const head: MenuItem[] = [
      { label: S.folder.refresh, onSelect: act.refresh },
      { label: S.folder.rescan, onSelect: act.rescan },
      { label: S.project.settings, onSelect: act.openSettings },
      {
        label: m.fetchAll(input.repoCount),
        separator: true,
        disabled: busy,
        onSelect: () => act.fetch([]),
      },
    ];
    const openIn = act.files ? openInItems(joinRoot(root, ''), act.files) : [];
    return joinGroups([
      head,
      openIn,
      [{ label: m.copyPath, onSelect: () => act.copy(joinRoot(root, '')) }],
    ]);
  }
  if (input.repoAt(row.path) !== null) {
    const repos = targets.flatMap((t) => {
      const repo = input.repoAt(t);
      return repo ? [repo] : [];
    });
    const paths = repos.map((r) => r.path);
    const scope = repos.length === 1 ? (repos[0]?.name ?? '') : m.repos(repos.length);
    const scoped = (label: string) => S.folder.batch.withScope(label, scope);
    // 저장소 노드: 대상 저장소들의 변경 되돌리기(저장소 전체), 우클릭한 저장소의 Finder·터미널
    const { changes, openIn } = fileGroups(input, { path: row.path, dir: true }, act);
    const batch: MenuItem[] = [
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
    ];
    return joinGroups([
      batch,
      changes,
      openIn,
      [
        {
          label: counted(m.copyPath, targets.length),
          onSelect: () => act.copy(targets.map((t) => joinRoot(root, t)).join('\n')),
        },
      ],
    ]);
  }
  return entryMenu({ ...input, row }, act);
}

/**
 * 일반 폴더·파일 행의 우클릭 메뉴 (폴더 탭 W12·W13, 저장소 탭 W21): 폴더·열 수 없는 항목은 (변경 묶음·열기 묶음 +) 경로
 * 복사, 파일은 열기(미리보기·새 탭, 여러 파일이면 모두 새 탭) + 저장소 안 파일 하나면 파일 히스토리·blame + 변경 묶음
 * (변경 되돌리기·ignore) + 열기 묶음(Finder·터미널) + 경로 복사
 */
export function entryMenu(input: EntryMenuInput, act: EntryMenuActions): MenuItem[] {
  const { row, targets } = input;
  const m = S.project.menu;
  const { changes, openIn } = fileGroups(
    input,
    { path: row.path, dir: row.entryKind === 'dir' },
    act,
  );
  if (row.entryKind === 'dir' || !input.isOpenable(row.path)) {
    // 일반 폴더, 열 수 없는 항목(링크·특수 파일·이름이 너무 긴 파일): 열기·히스토리 없이
    return joinGroups([changes, openIn, copyItems(input, act)]);
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
  return joinGroups([open, [...vcs, ...changes], openIn, copyItems(input, act)]);
}
