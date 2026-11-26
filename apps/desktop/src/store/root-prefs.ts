// 루트(폴더·그룹 탭의 세션 키)마다 저장하는 화면 설정의 수명 (MR-13 M4). 그룹을 지우면 그 그룹 키의 기록을 지우고,
// 그룹 별칭이 바뀌면 경로를 담은 기록의 경로를 옮긴다. 대상:
// - 편집기 탭 복원 `mgit.editorTabs[루트]`, 최근 파일 `mgit.search.recent:<루트>` — 루트 기준 경로를 담는다 (옮기고 지운다)
// - 통합 타임라인의 저장소 열 너비 `mgit.timeline.repoWidth:<루트>`, 브랜치 즐겨찾기 `mgit.branchFavorites[루트]`, 일괄
//   명령의 최근 명령 `mgit.folder.commands:<루트>` — 경로가 없다 (지우기만 한다)
// 폴더 설정(동시 실행 수 등)은 코어 설정 `folder:<루트>` 라 코어가 그룹을 지울 때 지운다
import {
  NO_FAVORITE_OVERRIDES,
  writeFavoriteOverrides,
} from '../features/branches/branch-favorites';
import { recentCommandsKey } from '../features/folder/recent-commands';
import {
  readSavedEditorTabs,
  type SavedEditorTabs,
  type SavedTabGroup,
  writeSavedEditorTabs,
} from './editor-tabs-persist';
import type { PathMove } from './path-remap';
import { removePref, writePref } from './prefs';
import { readRecentFiles, recentFilesKey } from './recent-files';

/** 통합 타임라인의 저장소 열 너비 저장 키 (루트마다) */
export function timelineRepoWidthKey(root: string): string {
  return `mgit.timeline.repoWidth:${root}`;
}

/**
 * 저장한 편집기 탭의 경로를 옮긴다 (순수 함수): 그룹마다 사라진 경로(null)의 탭은 빼고, 옮긴 결과 겹치는 탭은 앞의 것만
 * 남긴다. 보던 탭도 옮기고, 그 탭이 사라졌으면 null 이다. 편집기를 나눈 기록(R3)은 오른쪽 그룹도 옮기고 폭은 그대로 두며,
 * 왼쪽 그룹이 비면 오른쪽 그룹이 왼쪽이 된다. 남은 탭이 없으면 null (그 루트의 기록을 지운다)
 */
export function movedSavedTabs(
  saved: SavedEditorTabs | null,
  move: PathMove,
): SavedEditorTabs | null {
  if (saved === null) return null;
  const main = movedGroup(saved, move);
  const side = saved.side ? movedGroup(saved.side, move) : null;
  const ratio = saved.ratio === undefined ? {} : { ratio: saved.ratio };
  if (main === null) return side === null ? null : { ...side, ...ratio };
  return { ...main, ...(side === null ? {} : { side }), ...ratio };
}

/** 그룹 하나의 탭 경로를 옮긴다. 남은 탭이 없으면 null */
function movedGroup(group: SavedTabGroup, move: PathMove): SavedTabGroup | null {
  const seen = new Set<string>();
  const files = group.files.flatMap((tab) => {
    const path = move(tab.path);
    if (path === null || seen.has(path)) return [];
    seen.add(path);
    return [{ ...tab, path }];
  });
  if (files.length === 0) return null;
  const active = group.active === null ? null : move(group.active);
  return { files, active: active !== null && seen.has(active) ? active : null };
}

/** 최근 파일 목록의 경로를 옮긴다 (순수 함수): 사라진 경로는 빼고, 겹치면 앞(더 최근)의 것만 남긴다 */
export function movedRecentFiles(list: readonly string[], move: PathMove): string[] {
  const seen = new Set<string>();
  return list.flatMap((item) => {
    const path = move(item);
    if (path === null || seen.has(path)) return [];
    seen.add(path);
    return [path];
  });
}

/** 루트의 경로를 담은 기록(편집기 탭 복원·최근 파일)의 경로를 옮긴다. 바뀐 것이 없으면 쓰지 않는다 */
export function moveRootPrefPaths(root: string, move: PathMove): void {
  const saved = readSavedEditorTabs(root);
  const tabs = movedSavedTabs(saved, move);
  if (JSON.stringify(tabs) !== JSON.stringify(saved)) writeSavedEditorTabs(root, tabs);
  const recent = readRecentFiles(root);
  const moved = movedRecentFiles(recent, move);
  if (moved.join('\0') === recent.join('\0')) return;
  if (moved.length === 0) removePref(recentFilesKey(root));
  else writePref(recentFilesKey(root), moved);
}

/** 사라진 루트(지운 그룹)의 기록을 모두 지운다 */
export function forgetRootPrefs(root: string): void {
  writeSavedEditorTabs(root, null);
  removePref(recentFilesKey(root));
  removePref(timelineRepoWidthKey(root));
  writeFavoriteOverrides(root, NO_FAVORITE_OVERRIDES);
  removePref(recentCommandsKey(root));
}
