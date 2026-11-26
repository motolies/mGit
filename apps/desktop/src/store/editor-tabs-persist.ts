// 재시작 뒤 편집기 탭 복원. 폴더·저장소 탭(루트)마다 고정한 파일 탭의 경로·순서와 보던 탭을 저장하고, 앱을 다시 켜서
// 그 루트의 탭이 복원되면 파일 탭도 다시 연다. 저장하지 않는 것:
// - 미리보기 탭: 한 번 눌러 본 파일이라 다음 클릭에 자리를 내주는 탭이다. 다시 켰을 때 되살릴 만한 작업이 아니다
// - 파일이 아닌 문서: diff·충돌 문서는 세션 상태에서 파생하고, 커밋·범위 diff·비교·태그 문서는 그때의 기록·세션에
//   묶여 있어 다시 여는 길이 따로 있다. 폴더 탭의 개요는 늘 기본으로 열린다
// - 저장하지 않은 편집(초안): 파일 경로만 저장한다. 초안은 자동 저장(1초)과 닫기 확인이 다룬다
import type { FsDirListing } from '@mgit/ipc';
import { FS_LIST_MAX } from './file-tree';
import { baseName, parentDir } from './fs-path';
import { readPref, writePref } from './prefs';
import {
  type EditorDoc,
  type EditorTabs,
  type FileViewTarget,
  fileViewDoc,
  fileViewDocId,
  SPLIT_RATIO_DEFAULT,
  type WorkspaceState,
  type WorkspaceStore,
} from './workspace-store';

/** 저장 키. 값은 `루트 경로 → 저장한 탭` 이다 (닫힌 루트를 한 번에 지울 수 있게 한 키에 둔다) */
export const PREF_EDITOR_TABS = 'mgit.editorTabs';
/** 루트마다 저장하는 파일 탭 수 상한 (넘으면 최근에 본 탭부터 남긴다) */
export const EDITOR_TABS_LIMIT = 30;
/** 탭이 바뀐 뒤 저장까지 기다리는 시간. 연달아 바뀌면 한 번만 쓴다 */
export const EDITOR_TABS_SAVE_DELAY_MS = 500;

/** 저장한 파일 탭 하나 (파일 보기 문서를 다시 만드는 데 드는 것만) */
export interface SavedFileTab {
  /** 루트 기준 상대 경로 */
  path: string;
  repoPath: string | null;
  repoName: string | null;
}

/** 편집기 그룹 하나의 저장한 탭 */
export interface SavedTabGroup {
  /** 탭 막대 순서 */
  files: SavedFileTab[];
  /** 보던 탭의 경로. 보던 것이 파일 탭이 아니었으면 null */
  active: string | null;
}

/**
 * 루트 하나의 저장한 탭: 왼쪽(기본) 그룹의 탭과, 편집기를 나눴으면 오른쪽 그룹(`side`, R3)과 왼쪽 그룹의 폭(`ratio`).
 * 나누기 전에 저장한 값(`side`·`ratio` 없음)은 그룹 하나로 읽는다
 */
export interface SavedEditorTabs extends SavedTabGroup {
  side?: SavedTabGroup;
  /** 왼쪽 그룹의 폭 (퍼센트). 기본값이면 저장하지 않는다 */
  ratio?: number;
}

type FileDoc = EditorDoc & FileViewTarget;

/** 고정한 파일 탭인지 */
function isPinnedFile(doc: EditorDoc): doc is FileDoc {
  return doc.kind === 'file' && doc.pinned;
}

/**
 * 워크스페이스 탭 상태에서 저장할 것을 고른다. 그룹마다 상한을 넘으면 최근에 본 탭부터 남기고 탭 순서는 그대로 둔다.
 * 오른쪽 그룹은 고정한 파일 탭이 있을 때만, 폭은 기본값이 아닐 때만 싣는다 (R3)
 */
export function editorTabsSnapshot(
  tabs: Pick<EditorTabs, 'docs' | 'activeDocId' | 'recentDocIds'> &
    Partial<Pick<WorkspaceState, 'split' | 'splitRatio'>>,
): SavedEditorTabs {
  const main = groupSnapshot(tabs);
  const side = tabs.split ? groupSnapshot(tabs.split) : null;
  return {
    ...main,
    ...(side && side.files.length > 0 ? { side } : {}),
    ...(tabs.splitRatio !== undefined && tabs.splitRatio !== SPLIT_RATIO_DEFAULT
      ? { ratio: tabs.splitRatio }
      : {}),
  };
}

/** 그룹 하나에서 저장할 것: 고정한 파일 탭(상한을 넘으면 최근에 본 것부터)과 보던 탭 */
function groupSnapshot(
  tabs: Pick<EditorTabs, 'docs' | 'activeDocId' | 'recentDocIds'>,
): SavedTabGroup {
  const pinned = tabs.docs.filter(isPinnedFile);
  let kept = pinned;
  if (pinned.length > EDITOR_TABS_LIMIT) {
    const seen = new Map(tabs.recentDocIds.map((id, index) => [id, index]));
    const keep = new Set(
      [...pinned]
        .sort((a, b) => (seen.get(b.id) ?? -1) - (seen.get(a.id) ?? -1))
        .slice(0, EDITOR_TABS_LIMIT)
        .map((doc) => doc.id),
    );
    kept = pinned.filter((doc) => keep.has(doc.id));
  }
  return {
    files: kept.map((doc) => ({ path: doc.path, repoPath: doc.repoPath, repoName: doc.repoName })),
    active: kept.find((doc) => doc.id === tabs.activeDocId)?.path ?? null,
  };
}

/**
 * 저장된 값 하나를 검사한다. 모양이 틀린 항목은 버린다. 오른쪽 그룹이 틀렸으면 그 그룹만 버리고(그룹 하나로 읽는다), 폭이
 * 숫자가 아니면 뺀다
 */
function parseSaved(value: unknown): SavedEditorTabs | null {
  const main = parseGroup(value);
  if (main === null) return null;
  const { side, ratio } = value as { side?: unknown; ratio?: unknown };
  const group = side === undefined ? null : parseGroup(side);
  return {
    ...main,
    ...(group && group.files.length > 0 ? { side: group } : {}),
    ...(typeof ratio === 'number' && Number.isFinite(ratio) ? { ratio } : {}),
  };
}

/** 그룹 하나의 저장된 값을 검사한다 (탭 목록이 배열이 아니면 null) */
function parseGroup(value: unknown): SavedTabGroup | null {
  if (value === null || typeof value !== 'object') return null;
  const { files, active } = value as { files?: unknown; active?: unknown };
  if (!Array.isArray(files)) return null;
  const text = (item: unknown) => (typeof item === 'string' ? item : null);
  const list = files.flatMap((item): SavedFileTab[] => {
    if (item === null || typeof item !== 'object') return [];
    const { path, repoPath, repoName } = item as Record<string, unknown>;
    return typeof path === 'string' && path !== ''
      ? [{ path, repoPath: text(repoPath), repoName: text(repoName) }]
      : [];
  });
  return { files: list.slice(0, EDITOR_TABS_LIMIT), active: text(active) };
}

/** 저장된 모든 루트의 탭 */
function readAll(): Record<string, SavedEditorTabs> {
  const all: Record<string, SavedEditorTabs> = {};
  for (const [root, value] of Object.entries(
    readPref<Record<string, unknown>>(PREF_EDITOR_TABS, {}),
  )) {
    const saved = parseSaved(value);
    if (saved) all[root] = saved;
  }
  return all;
}

/** 루트의 저장한 탭. 없으면 null */
export function readSavedEditorTabs(root: string): SavedEditorTabs | null {
  return readAll()[root] ?? null;
}

/** 루트의 탭을 저장한다. null 이거나 파일 탭이 없으면 그 루트의 기록을 지운다 */
export function writeSavedEditorTabs(root: string, saved: SavedEditorTabs | null): void {
  const all = readAll();
  if (saved === null || saved.files.length === 0) {
    if (!(root in all)) return;
    delete all[root];
  } else all[root] = saved;
  writePref(PREF_EDITOR_TABS, all);
}

/** 지금 열린 루트 밖의 기록을 지운다 (다시 열지 못한 루트의 기록이 쌓이지 않게) */
export function retainSavedEditorTabs(roots: Iterable<string>): void {
  const keep = new Set(roots);
  const all = readAll();
  const stale = Object.keys(all).filter((root) => !keep.has(root));
  if (stale.length === 0) return;
  for (const root of stale) delete all[root];
  writePref(PREF_EDITOR_TABS, all);
}

// 루트 → 기다리는 저장 (앱을 닫기 전에 한꺼번에 쓴다)
const pendingSaves = new Map<string, () => void>();

/**
 * 워크스페이스의 탭이 바뀌면 잠시 뒤 루트의 기록을 저장한다. 강제 종료돼도 마지막 변경에서 0.5초 안의 것만 잃는다.
 * 해제하면 기다리던 저장은 버린다 (탭을 닫아 기록을 지울 때 되살리지 않게)
 */
export function watchEditorTabs(
  root: string,
  store: WorkspaceStore,
  delay = EDITOR_TABS_SAVE_DELAY_MS,
): () => void {
  let last = JSON.stringify(editorTabsSnapshot(store.getState()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 지금 상태를 저장한다 (바뀐 것이 없으면 쓰지 않는다) */
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pendingSaves.get(root) === save) pendingSaves.delete(root);
    const snapshot = editorTabsSnapshot(store.getState());
    const text = JSON.stringify(snapshot);
    if (text === last) return;
    last = text;
    writeSavedEditorTabs(root, snapshot);
  };
  const unsubscribe = store.subscribe((now, before) => {
    if (
      now.docs === before.docs &&
      now.activeDocId === before.activeDocId &&
      now.split === before.split &&
      now.splitRatio === before.splitRatio
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(save, delay);
    pendingSaves.set(root, save);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
    if (pendingSaves.get(root) === save) pendingSaves.delete(root);
  };
}

/** 기다리는 저장을 바로 한다 (앱 창을 닫기 직전) */
export function flushEditorTabSaves(): void {
  for (const save of [...pendingSaves.values()]) save();
}

/**
 * 파일들이 아직 있는지 부모 디렉터리를 한 번씩 나열해 확인한다 (내용은 읽지 않는다). 디렉터리가 없거나 읽지 못하면 그
 * 안의 파일은 없는 것으로 본다
 */
export async function existingFiles(
  list: (dir: string, limit: number) => Promise<FsDirListing>,
  paths: readonly string[],
): Promise<Set<string>> {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = parentDir(path) ?? '';
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  const found = new Set<string>();
  await Promise.all(
    [...byDir].map(async ([dir, inside]) => {
      try {
        const listing = await list(dir, FS_LIST_MAX);
        if (listing.kind !== 'listed') return;
        const files = new Set(
          listing.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name),
        );
        for (const path of inside) if (files.has(baseName(path))) found.add(path);
      } catch {
        // 그 디렉터리의 탭만 건너뛴다
      }
    }),
  );
  return found;
}

/**
 * 저장한 탭을 워크스페이스에 다시 연다. 사라졌거나 확인하지 못한 파일은 조용히 건너뛴다. 탭 내용은 그 탭을 볼 때
 * 읽으므로(보이는 문서 하나만 그린다) 여기서는 읽지 않는다. 다시 연 탭 수를 돌려준다
 */
export async function restoreEditorTabs(
  store: WorkspaceStore,
  saved: SavedEditorTabs,
  exists: (paths: readonly string[]) => Promise<Set<string>>,
): Promise<number> {
  const side = saved.side?.files ?? [];
  const present = await exists([...saved.files, ...side].map((file) => file.path));
  /** 그룹 하나의 있는 파일 탭과 보던 탭 (문서 요청으로) */
  const restorable = (group: SavedTabGroup) => {
    const files = group.files.filter((file) => present.has(file.path));
    const active = group.active !== null && present.has(group.active) ? group.active : null;
    return {
      docs: files.map((file) => fileViewDoc({ ...file, name: baseName(file.path) })),
      active: active === null ? null : fileViewDocId(active),
    };
  };
  const main = restorable(saved);
  const right = saved.side ? restorable(saved.side) : null;
  if (main.docs.length > 0) store.getState().restoreDocs(main.docs, main.active);
  // 편집기를 나눠 두었으면 오른쪽 그룹과 폭도 되살린다 (R3 — 왼쪽 그룹이 비어 있으면 오른쪽 탭이 왼쪽으로 온다)
  if (right && right.docs.length > 0) {
    store.getState().restoreSplit(right.docs, right.active, saved.ratio ?? null);
  } else if (saved.ratio !== undefined) store.getState().setSplitRatio(saved.ratio);
  return main.docs.length + (right?.docs.length ?? 0);
}
