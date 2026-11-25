import { S } from '@mgit/ui';
import { type MenuItem, menuGroups } from '../../components/ContextMenu';
import { useAppStore, useFileTree, useWorkspace } from '../../store';
import { baseName, joinRoot, repoToRoot } from '../../store/fs-path';
import { type DocRequest, type EditorDoc, fileViewDoc } from '../../store/workspace-store';
import { revealLabel } from '../project/file-actions-menu';

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
  if (
    doc.kind !== 'worktreeDiff' &&
    doc.kind !== 'historyDiff' &&
    doc.kind !== 'commitDiff' &&
    doc.kind !== 'rangeDiff'
  ) {
    return [];
  }
  return [
    {
      label: S.fileView.editCurrent,
      onSelect: () => open(doc.repoPath, doc.path, doc.repoName),
    },
  ];
}

/** 파일을 가리키는 모든 탭에서 같은 경로 복사·Project 표시·Finder 동작을 제공한다. */
export function useEditorFileMenu(): (doc: EditorDoc) => MenuItem[] {
  const editCurrent = useCurrentFile();
  const root = useAppStore((s) =>
    s.activeSessionId === null ? null : (s.sessions[s.activeSessionId]?.path ?? null),
  );
  const setLeftTool = useAppStore((s) => s.setLeftTool);
  const openExternal = useAppStore((s) => s.openExternal);
  const reveal = useFileTree((s) => s.reveal);
  return (doc) => {
    if (!root || !('path' in doc) || doc.path === '') return [];
    const relative = doc.kind === 'file' ? doc.path : repoToRoot(root, doc.repoPath, doc.path);
    const absolute =
      doc.kind === 'file' ? joinRoot(root, doc.path) : joinRoot(doc.repoPath, doc.path);
    return menuGroups([
      currentFileTabMenu(doc, editCurrent),
      [
        ...(relative !== null && reveal
          ? [
              {
                label: S.workspace.revealInProject,
                onSelect: () => {
                  setLeftTool('project');
                  void reveal(relative);
                },
              },
            ]
          : []),
        { label: revealLabel(), onSelect: () => void openExternal('reveal', absolute) },
      ],
      [
        {
          label: S.project.menu.copyPath,
          onSelect: () => void navigator.clipboard.writeText(absolute).catch(() => {}),
        },
        ...(relative !== null
          ? [
              {
                label: S.project.menu.copyRelative,
                onSelect: () => void navigator.clipboard.writeText(relative).catch(() => {}),
              },
            ]
          : []),
      ],
    ]);
  };
}
