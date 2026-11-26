// 경로가 바뀐 뒤 열린 화면 상태(프로젝트 트리의 선택·펼침, 파일 탭)를 새 경로로 옮기는 순수 함수. 파일 작업(이동·이름
// 바꾸기·휴지통, `file-operation-coordinator`)과 그룹 별칭 바꾸기(`group-reshape`)가 같은 규칙을 쓴다 — 경로를 어떻게
// 옮길지는 부르는 쪽이 정하고(실제 경로 기준 / 별칭 접두 기준), 상태를 옮기는 방법은 여기 한 곳에 둔다
import type { ExpandedSet, SelectionSet, SelectionState } from './file-tree';
import {
  type EditorDoc,
  type EditorTabs,
  normalizeGroups,
  type WorkspaceState,
} from './workspace-store';

/** 트리 경로 하나의 새 경로. null 이면 사라졌다 */
export type PathMove = (path: string) => string | null;

/** 트리의 선택·펼침 상태 (옮길 것만) */
export interface TreePaths extends SelectionState {
  expanded: ExpandedSet;
}

/** 파일 탭 문서 */
export type FileDoc = Extract<EditorDoc, { kind: 'file' }>;

/** 탭 상태 중 옮길 것 */
export type MovableTabs = Pick<EditorTabs, 'docs' | 'activeDocId' | 'recentDocIds'>;

/** 경로 집합을 옮긴다 (사라진 경로는 뺀다) */
function movedSet(set: SelectionSet, move: PathMove): Record<string, true> {
  return Object.fromEntries(
    Object.keys(set).flatMap((path) => {
      const next = move(path);
      return next === null ? [] : [[next, true as const]];
    }),
  );
}

/** 트리의 기준 행·범위 시작 행·선택·펼침을 옮긴다. 사라진 경로는 빼고, 기준 행이 사라지면 null 이다 */
export function remapTreePaths(tree: TreePaths, move: PathMove): TreePaths {
  return {
    selected: tree.selected === null ? null : move(tree.selected),
    anchor: tree.anchor === null ? null : move(tree.anchor),
    selection: movedSet(tree.selection, move),
    expanded: movedSet(tree.expanded, move),
  };
}

/**
 * 파일 탭을 옮긴다: `move` 가 돌려준 문서로 바꾸고 null 이면 뺀다(다른 문서는 그대로). 옮긴 결과 id 가 겹치면 앞 자리에
 * 뒤 문서가 남는다. 보던 파일 탭이 사라졌으면 첫 탭을 보고(파일이 아닌 문서를 보던 중이면 그대로), 본 순서도 새 id 로
 * 옮긴다. `move` 는 파일 탭마다 한 번만 부른다 (부르는 쪽이 옮길 곳을 모으는 부수 효과를 가질 수 있다)
 */
export function remapFileDocs(
  tabs: MovableTabs,
  move: (doc: FileDoc) => FileDoc | null,
): MovableTabs {
  const ids = new Map<string, string | null>();
  const entries = tabs.docs.flatMap<EditorDoc>((doc) => {
    if (doc.kind !== 'file') return [doc];
    const next = move(doc);
    ids.set(doc.id, next?.id ?? null);
    return next ? [next] : [];
  });
  const docsById = new Map(entries.map((doc) => [doc.id, doc]));
  const moved = tabs.activeDocId === null ? undefined : ids.get(tabs.activeDocId);
  const activeDocId =
    moved === undefined
      ? tabs.activeDocId
      : moved !== null && docsById.has(moved)
        ? moved
        : (entries[0]?.id ?? null);
  const recentDocIds = [
    ...new Set(
      tabs.recentDocIds.flatMap((id) => {
        const next = ids.has(id) ? ids.get(id) : id;
        return next == null ? [] : [next];
      }),
    ),
  ];
  return { docs: [...docsById.values()], activeDocId, recentDocIds };
}

/** 두 편집기 그룹의 탭 상태 (R3): 왼쪽 그룹과 오른쪽 그룹·지금 그룹 */
export type MovableGroups = MovableTabs &
  Pick<WorkspaceState, 'sessionDocs' | 'split' | 'focusedGroup'>;

/**
 * 두 편집기 그룹(R3)의 파일 탭을 함께 옮긴다 (`remapFileDocs` 를 그룹마다). 같은 파일이 두 그룹에 있어도 `move` 는 파일마다
 * 한 번만 부른다. 옮긴 뒤 비는 그룹은 사라진다 (`normalizeGroups`)
 */
export function remapGroupFileDocs(
  state: MovableGroups,
  move: (doc: FileDoc) => FileDoc | null,
): Pick<WorkspaceState, 'docs' | 'activeDocId' | 'recentDocIds' | 'split' | 'focusedGroup'> {
  const seen = new Map<string, FileDoc | null>();
  /** 파일마다 한 번만 옮길 곳을 묻는다 */
  const once = (doc: FileDoc) => {
    if (!seen.has(doc.id)) seen.set(doc.id, move(doc));
    const next = seen.get(doc.id) ?? null;
    return next === null ? null : { ...next, pinned: doc.pinned };
  };
  const main = remapFileDocs(state, once);
  const side = state.split ? remapFileDocs(state.split, once) : null;
  const grouped = normalizeGroups({
    main: { ...main, sessionDocs: state.sessionDocs },
    split: side,
    focusedGroup: state.focusedGroup,
  });
  return {
    docs: grouped.main.docs,
    activeDocId: grouped.main.activeDocId,
    recentDocIds: grouped.main.recentDocIds,
    split: grouped.split,
    focusedGroup: grouped.focusedGroup,
  };
}
