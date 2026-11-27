import { useAppStore } from '../../store/app-store-instance';
import { editorDocStamp, editorDrafts } from '../../store/editor-drafts';
import { getWorkspaceStore } from '../../store/session-registry';

export const LOCAL = '@LOCAL';
/** 실제 파일 식별자를 저장소 상대 경로로 바꿔 같은 초안을 중복 없이 전달한다. */
export function comparisonDrafts(root: string): [string, string][] {
  return editorDrafts(root).map(({ path, text }) => [path, text]);
}

/**
 * 로컬 비교의 재조회 신호 (반응성 F2): 저장소 `root`(파일 비교면 그 파일 `path`)에 열린 편집기 문서의 초안·저장 지문. 같으면
 * 다시 조회하지 않는다 — 편집기의 주기 검사처럼 바뀐 것이 없는 일에는 같은 값이다
 */
export function comparisonStamp(root: string, path?: string): string {
  return editorDocStamp(root, path === undefined ? {} : { path });
}

/** 파일 비교는 현재 워크스페이스에서 저장소와 경로를 고정해 연다. */
export function openFileComparison(session: number, repoPath: string, path: string): void {
  const active = useAppStore.getState().activeSessionId;
  if (active === null || !repoPath) return;
  getWorkspaceStore(active)
    ?.getState()
    .openDoc(
      {
        kind: 'comparison',
        id: `comparison:${JSON.stringify([repoPath, path])}`,
        session,
        repoPath,
        repoName: repoPath.split('/').pop() ?? repoPath,
        a: 'HEAD',
        b: LOCAL,
        threeDot: false,
        filterPath: path,
      },
      'pinned',
    );
}
