// 루트(폴더·저장소 탭)별 최근 파일. 빠른 열기(⌘P)의 빈 검색어·순위 가중과 "최근 파일"(⌘E)이 같은 목록을 쓴다.
// 워크스페이스의 `recentDocIds` 는 지금 열린 탭을 본 순서(탭을 닫으면 돌아갈 곳)라서 닫으면 빠지고 저장하지 않는다 —
// 이 목록은 닫은 파일도 남고 앱을 다시 켜도 남는다.
import { readPref, writePref } from './prefs';
import type { WorkspaceStore } from './workspace-store';

/** 루트마다 기억하는 최근 파일 수 */
export const RECENT_FILES_LIMIT = 50;

/** 저장 키. 예전 빠른 열기 최근 목록과 같은 키라 이미 쌓인 기록이 그대로 이어진다 */
export function recentFilesKey(root: string): string {
  return `mgit.search.recent:${root}`;
}

/** 루트의 최근 파일 (가장 최근이 앞, 루트 기준 상대 경로) */
export function readRecentFiles(root: string): string[] {
  return readPref<unknown[]>(recentFilesKey(root), []).filter(
    (path): path is string => typeof path === 'string' && path !== '',
  );
}

/** 파일을 최근 목록 맨 앞에 둔다. 이미 맨 앞이면 쓰지 않는다 */
export function recordRecentFile(root: string, path: string): string[] {
  const before = readRecentFiles(root);
  if (before[0] === path) return before;
  const next = [path, ...before.filter((item) => item !== path)].slice(0, RECENT_FILES_LIMIT);
  writePref(recentFilesKey(root), next);
  return next;
}

/**
 * 워크스페이스에서 파일 탭이 보이게 될 때마다(트리·빠른 열기·검색 결과 등 어느 길로 열었든, 미리보기 탭 포함) 그
 * 파일을 최근 목록에 올린다. 해제 함수를 돌려준다
 */
export function watchRecentFiles(root: string, store: WorkspaceStore): () => void {
  return store.subscribe((now, before) => {
    // 두 편집기 그룹(R3) 각각에서 보게 된 파일
    const shown = [
      now.activeDocId !== before.activeDocId && now.activeDocId !== null
        ? now.docs.find((item) => item.id === now.activeDocId)
        : undefined,
      now.split && now.split.activeDocId !== before.split?.activeDocId
        ? now.split.docs.find((item) => item.id === now.split?.activeDocId)
        : undefined,
    ];
    for (const doc of shown) if (doc?.kind === 'file') recordRecentFile(root, doc.path);
  });
}
