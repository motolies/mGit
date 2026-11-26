import { useAppStore } from '../../store/app-store-instance';
import { editorDrafts } from '../../store/editor-drafts';
import { getWorkspaceStore } from '../../store/session-registry';

export const LOCAL = '@LOCAL';
/** 실제 파일 식별자를 저장소 상대 경로로 바꿔 같은 초안을 중복 없이 전달한다. */
export function comparisonDrafts(root: string): [string, string][] {
  return editorDrafts(root).map(({ path, text }) => [path, text]);
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
