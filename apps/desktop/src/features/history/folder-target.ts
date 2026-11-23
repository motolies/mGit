import { useActiveTab, useAppStore, useFolder, useWorkspace } from '../../store';
import { baseName } from '../../store/fs-path';
import { commitDiffDoc } from '../../store/workspace-store';

/**
 * 폴더 탭에서 연 히스토리·blame 대화상자의 대상 저장소와 이동 동작 (W13). 저장소 탭의 대화상자는 그래프로 이동하고
 * 가운데에 diff 를 여는데, 폴더 탭의 세션은 그래프를 읽지 않으므로(가벼운 세션) 폴더 화면의 읽기 흐름으로 바꾼다
 */
export interface FolderDialogTarget {
  /** 대상 저장소 이름 (대화상자 머리의 보조 글자) */
  repoName: string;
  /**
   * 그 커밋을 로그에서 고르고 그 행을 보이게 한 뒤(W19), 그 커밋에서 이 파일의 diff 를 에디터 공간의 커밋 diff 탭(미리보기)
   * 으로 연다
   */
  openCommitFile(oid: string, path: string): void;
  /**
   * 그 커밋을 로그에서 골라 그 행을 보이게 하고(W19 — 지금 로그에 없으면 로그 위에 안내) Git 도구 창 로그 탭의 상세에
   * 보인다 (로그 탭이 안 보이면 연다)
   */
  showCommit(oid: string): void;
}

/**
 * 활성 폴더 탭의 대화상자 대상. 범위 세션은 활성 저장소의 숨은 세션이므로 대상 저장소 = 활성 저장소다.
 * 저장소 탭이거나 활성 저장소가 없으면 null (대화상자는 저장소 탭의 모양·동작 그대로다)
 */
export function useFolderDialogTarget(): FolderDialogTarget | null {
  const folderTab = useActiveTab()?.kind === 'folder';
  const ws = useWorkspace((w) => ({ activeRepo: w.activeRepo, openDoc: w.openDoc }));
  const f = useFolder((st) => ({ summaries: st.summaries, reveal: st.revealTimelineCommit }));
  const logShown = useAppStore((s) => s.dock.tool === 'git' && s.dock.gitTab === 'log');
  const toggleDock = useAppStore((s) => s.toggleDock);
  const repoPath = ws?.activeRepo ?? null;
  if (!folderTab || !ws || !f || repoPath === null) {
    return null;
  }
  const repoName = f.summaries.find((s) => s.path === repoPath)?.name ?? baseName(repoPath);
  return {
    repoName,
    openCommitFile: (oid, path) => {
      f.reveal(repoPath, oid);
      ws.openDoc(
        commitDiffDoc({ repoPath, repoName, oid, path, oldPath: null, merge: false }),
        'preview',
      );
    },
    showCommit: (oid) => {
      f.reveal(repoPath, oid);
      if (!logShown) {
        toggleDock('git', 'log');
      }
    },
  };
}
