import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { useAppStore, useWorkspace } from '../../store';
import { baseName, repoToRoot } from '../../store/fs-path';
import { type DocRequest, type EditorDoc, fileViewDoc } from '../../store/workspace-store';

/** 저장소 기준 경로를 현재 워크스페이스의 파일 탭으로 바꾼다. 과거 이름을 추측하거나 복원하지 않는다. */
export function currentFileDoc(
  root: string,
  repoPath: string,
  path: string,
  repoName = baseName(repoPath),
): DocRequest | null {
  const relative = repoToRoot(root, repoPath, path);
  return relative === null || relative === ''
    ? null
    : fileViewDoc({ path: relative, name: baseName(relative), repoPath, repoName });
}

/** 현재 탭의 루트 안에서 디스크 파일을 고정 탭으로 연다. 같은 경로의 기존 탭과 diff는 유지한다. */
export function useCurrentFile() {
  const root = useAppStore((s) =>
    s.activeSessionId === null ? null : (s.sessions[s.activeSessionId]?.path ?? null),
  );
  const openDoc = useWorkspace((w) => w.openDoc);
  return (repoPath: string, path: string, repoName?: string) => {
    if (root === null || !openDoc) return;
    const doc = currentFileDoc(root, repoPath, path, repoName);
    if (doc) openDoc(doc, 'pinned');
  };
}

/** 모든 diff 종류의 탭 메뉴는 그 diff가 가리키는 정확한 작업 트리 경로를 연다. */
export function currentFileTabMenu(
  doc: EditorDoc,
  open: (repoPath: string, path: string, repoName?: string) => void,
): MenuItem[] {
  if (doc.kind !== 'worktreeDiff' && doc.kind !== 'historyDiff' && doc.kind !== 'commitDiff') {
    return [];
  }
  return [
    {
      label: S.fileView.editCurrent,
      onSelect: () => open(doc.repoPath, doc.path, doc.repoName),
    },
  ];
}
