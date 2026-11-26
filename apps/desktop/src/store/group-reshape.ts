// 그룹 고치기의 화면 쪽 (MR-13 M4). 코어는 열린 그룹을 그 자리에서 고치고(`group_update` → `folderRescanned` →
// `groupChanged`), 화면은 탭을 닫지 않고 그 전후를 맞춘다:
// - 빠지는 멤버(뺀 것·위치를 바꾼 것)의 파일 탭: 그 경로가 다른 파일(또는 없는 파일)을 가리키게 되므로 고치기 전에 초안
//   확인을 거쳐 닫는다. 확인을 취소하면 고치기도 하지 않는다 (원자적)
// - 별칭이 바뀐 멤버: 같은 파일이므로 고친 뒤 열린 문서(초안 포함)·파일 탭·트리의 경로를 새 별칭으로 옮긴다. 고치는 동안
//   그 문서의 자동 저장·다시 읽기를 멈춰 옛 별칭으로 저장하지 않게 한다
// 저장한 기록(편집기 탭 복원·최근 파일)의 경로 옮기기는 `root-prefs` 가 한다
import type { GroupMemberEdit, SessionId } from '@mgit/ipc';
import { guardFileEditorClose } from './file-editor-close';
import { type EditorFile, fileEditors } from './file-editor-store';
import { baseName } from './fs-path';
import { type PathMove, remapGroupFileDocs, remapTreePaths, type TreePaths } from './path-remap';
import { getFolderStore, getWorkspaceStore } from './session-registry';
import { fileViewDocId } from './workspace-store';

/** 멤버(별칭·위치) 바뀜: 별칭만 바뀐 멤버, 뺀 멤버, 같은 별칭으로 위치를 바꾼 멤버 */
export interface MemberChanges {
  /** 옛 별칭 → 새 별칭 (위치는 같다) */
  renamed: ReadonlyMap<string, string>;
  /** 새 목록에 그 위치도 그 별칭도 없다 */
  removed: ReadonlySet<string>;
  /** 같은 별칭이 다른 위치를 가리킨다 (그 아래 경로는 다른 저장소의 파일이 된다) */
  relocated: ReadonlySet<string>;
}

/** 바뀐 것이 없다 */
const UNCHANGED: MemberChanges = { renamed: new Map(), removed: new Set(), relocated: new Set() };

/**
 * 고치기 전후의 멤버를 견준다 (순수 함수). 같은 위치의 멤버는 같은 저장소다 — 별칭이 다르면 이름만 바뀐 것이다. 옛 위치가
 * 새 목록에 없으면 같은 별칭이 남아 있을 때 위치를 바꾼 것, 아니면 뺀 것이다. 멤버를 고치지 않으면(`after` 가 null) 바뀐
 * 것이 없다
 */
export function memberChanges(
  before: readonly GroupMemberEdit[],
  after: readonly GroupMemberEdit[] | null | undefined,
): MemberChanges {
  if (after == null) return UNCHANGED;
  const renamed = new Map<string, string>();
  const removed = new Set<string>();
  const relocated = new Set<string>();
  for (const old of before) {
    const same = after.find((m) => m.path === old.path);
    if (same) {
      if (same.alias !== old.alias) renamed.set(old.alias, same.alias);
    } else if (after.some((m) => m.alias === old.alias)) {
      relocated.add(old.alias);
    } else {
      removed.add(old.alias);
    }
  }
  return { renamed, removed, relocated };
}

/** 그룹 경로의 별칭(첫 구성요소)과 나머지 (`별칭/나머지`, 별칭 자신이면 나머지는 '') */
function splitAlias(path: string): { alias: string; rest: string } {
  const at = path.indexOf('/');
  return at < 0 ? { alias: path, rest: '' } : { alias: path.slice(0, at), rest: path.slice(at) };
}

/**
 * 그룹 경로를 새 멤버에 맞춰 옮기는 함수 (순수): 별칭이 바뀐 멤버 아래는 새 별칭으로, 뺀 멤버 아래는 null(사라짐), 그 밖
 * (맨 위 '', 위치를 바꾼 멤버, 그대로인 멤버)은 그대로다. 위치를 바꾼 멤버의 경로는 같은 별칭으로 남는다 — 저장한 기록
 * (최근 파일 등)은 옮긴 저장소에서도 대개 같은 파일이다
 */
export function groupPathMove(changes: MemberChanges): PathMove {
  return (path) => {
    if (path === '') return path;
    const { alias, rest } = splitAlias(path);
    if (changes.removed.has(alias)) return null;
    const next = changes.renamed.get(alias);
    return next === undefined ? path : `${next}${rest}`;
  };
}

/** 그 경로가 빠지는 멤버(뺀 것·위치를 바꾼 것) 아래인지 */
function underDropped(changes: MemberChanges, path: string): boolean {
  const { alias } = splitAlias(path);
  return changes.removed.has(alias) || changes.relocated.has(alias);
}

/** 열린 그룹 탭을 고치는 동안 쥔 것: 멈춘 문서와 고치기 전 트리 상태 */
export interface OpenGroupEdit {
  session: SessionId;
  changes: MemberChanges;
  /** 별칭이 바뀌는 멤버의 문서 (자동 저장·다시 읽기를 멈췄다) */
  locked: EditorFile[];
  /** 고치기 전 트리의 선택·펼침. 고치는 사이 트리를 다시 읽어 옛 별칭의 펼침이 지워져도 이것을 옮겨 되살린다 */
  tree: TreePaths | null;
}

/**
 * 열린 그룹 탭을 고치기 전에 준비한다: 빠지는 멤버의 파일 탭(과 탭 없이 남은 초안)을 한 번의 초안 확인으로 저장·버린 뒤
 * 닫고, 별칭이 바뀌는 멤버의 문서는 멈춘 뒤 진행 중 저장을 기다린다. 확인을 취소했거나 다른 닫기가 도는 중이면 null —
 * 아무것도 닫지 않았다
 */
export async function prepareOpenGroupEdit(
  session: SessionId,
  changes: MemberChanges,
): Promise<OpenGroupEdit | null> {
  const workspace = getWorkspaceStore(session);
  await fileEditors.settleOpening();
  const sources = fileEditors
    .documents(session)
    .flatMap((doc) =>
      [...doc.sources.values()].filter((s) => s.session === session).map((s) => s.path),
    );
  const state = workspace?.getState();
  // 두 편집기 그룹(R3)의 파일 탭
  const tabs = [...(state?.docs ?? []), ...(state?.split?.docs ?? [])].flatMap((doc) =>
    doc.kind === 'file' ? [doc] : [],
  );
  const dropped = [
    ...new Set(
      [...tabs.map((doc) => doc.path), ...sources].filter((p) => underDropped(changes, p)),
    ),
  ];
  if (dropped.length > 0) {
    if (!(await guardFileEditorClose(dropped.map((path) => ({ session, path }))))) return null;
    const ids = tabs.filter((doc) => underDropped(changes, doc.path)).map((doc) => doc.id);
    if (workspace && ids.length > 0 && !(await workspace.getState().closeDocs(ids))) return null;
    // 탭 없이 이 세션에 남은 별칭(앞서 닫은 탭의 저장을 기다리던 문서 등)도 놓는다 — 확인에서 이미 저장하거나 버렸다
    for (const path of dropped) fileEditors.release(session, path);
  }
  const move = groupPathMove(changes);
  const locked =
    changes.renamed.size === 0
      ? []
      : fileEditors
          .documents(session)
          .filter((doc) =>
            [...doc.sources.values()].some((s) => s.session === session && move(s.path) !== s.path),
          );
  fileEditors.lockMutation(locked, true);
  await Promise.allSettled(locked.map((doc) => doc.inflight));
  const tree = getFolderStore(session)?.getState().fileTree.getState();
  return {
    session,
    changes,
    locked,
    tree: tree
      ? {
          selected: tree.selected,
          anchor: tree.anchor,
          selection: tree.selection,
          expanded: tree.expanded,
        }
      : null,
  };
}

/**
 * 고치기가 끝난 뒤 (`applied` 는 코어가 받아들였는지): 받아들였고 별칭이 바뀌었으면 문서의 별칭·파일 탭·트리의 경로를 새
 * 별칭으로 옮기고 트리를 다시 읽는다. 어느 쪽이든 멈췄던 문서를 다시 움직인다 (남은 초안은 새 경로로 자동 저장된다)
 */
export function finishOpenGroupEdit(edit: OpenGroupEdit, applied: boolean): void {
  const { session, changes } = edit;
  try {
    if (!applied || changes.renamed.size === 0) return;
    const move = groupPathMove(changes);
    fileEditors.renameSources(session, move);
    const workspace = getWorkspaceStore(session);
    workspace?.setState(
      remapGroupFileDocs(workspace.getState(), (doc) => {
        const path = move(doc.path);
        if (path === null) return null;
        if (path === doc.path) return doc;
        return { ...doc, id: fileViewDocId(path), path, name: baseName(path) };
      }),
    );
    const tree = getFolderStore(session)?.getState().fileTree;
    if (tree && edit.tree) {
      tree.setState({
        ...remapTreePaths(edit.tree, move),
        revealSeq: tree.getState().revealSeq + 1,
      });
      void tree.getState().reload();
    }
  } finally {
    fileEditors.lockMutation(edit.locked, false);
  }
}
