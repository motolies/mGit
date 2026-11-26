import { S } from '@mgit/ui';
import { useShallow } from 'zustand/shallow';
import { type MenuItem, menuGroups } from '../../components/ContextMenu';
import { useAppStore, useFileTree, useWorkspace } from '../../store';
import { baseName, joinRoot, repoToRootIn } from '../../store/fs-path';
import { dirSpace, type RootSpace } from '../../store/root-space';
import { tabSpace } from '../../store/session-space';
import { type DocRequest, type EditorDoc, fileViewDoc } from '../../store/workspace-store';
import { revealLabel } from '../project/file-actions-menu';

/**
 * 저장소 기준 경로를 현재 워크스페이스의 파일 탭으로 바꾼다. 과거 이름을 추측하거나 복원하지 않는다. 디렉터리 하나인
 * 공간의 `currentFileDocIn` 이다
 */
export function currentFileDoc(
  root: string,
  repoPath: string,
  path: string,
  repoName = baseName(repoPath),
): DocRequest | null {
  return currentFileDocIn(dirSpace(root), repoPath, path, repoName);
}

/** `currentFileDoc` 의 경로 공간 판 (MR-13): 탭의 공간에서 저장소 파일의 트리 경로를 찾는다 */
export function currentFileDocIn(
  space: RootSpace,
  repoPath: string,
  path: string,
  repoName = baseName(repoPath),
): DocRequest | null {
  const relative = repoToRootIn(space, repoPath, path);
  return relative === null || relative === ''
    ? null
    : fileViewDoc({ path: relative, name: baseName(relative), repoPath, repoName });
}

/** 활성 탭의 (id, 키). 탭이 없으면 null — 탭 공간(`tabSpace`)을 얻는 재료 */
function useActiveKey(): { id: number; key: string } | null {
  return useAppStore(
    useShallow((s) => {
      const meta = s.activeSessionId === null ? undefined : s.sessions[s.activeSessionId];
      return meta ? { id: meta.id, key: meta.path } : null;
    }),
  );
}

/** 현재 탭의 루트 안에서 디스크 파일을 고정 탭으로 연다. 같은 경로의 기존 탭과 diff는 유지한다. */
export function useCurrentFile() {
  const active = useActiveKey();
  const openDoc = useWorkspace((w) => w.openDoc);
  return (repoPath: string, path: string, repoName?: string) => {
    const space = active === null ? null : tabSpace(active.id, active.key);
    if (space === null || !openDoc) return;
    const doc = currentFileDocIn(space, repoPath, path, repoName);
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
  const active = useActiveKey();
  const setLeftTool = useAppStore((s) => s.setLeftTool);
  const openExternal = useAppStore((s) => s.openExternal);
  const reveal = useFileTree((s) => s.reveal);
  return (doc) => {
    const space = active === null ? null : tabSpace(active.id, active.key);
    if (!space || !('path' in doc) || doc.path === '') return [];
    const relative = doc.kind === 'file' ? doc.path : repoToRootIn(space, doc.repoPath, doc.path);
    // 파일 탭은 탭의 공간에서, diff 탭은 그 저장소에서 실제 경로를 얻는다 (실제 경로가 없으면 Finder·경로 복사를 뺀다)
    const absolute = doc.kind === 'file' ? space.toAbs(doc.path) : joinRoot(doc.repoPath, doc.path);
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
        ...(absolute !== null
          ? [{ label: revealLabel(), onSelect: () => void openExternal('reveal', absolute) }]
          : []),
      ],
      [
        ...(absolute !== null
          ? [
              {
                label: S.project.menu.copyPath,
                onSelect: () => void navigator.clipboard.writeText(absolute).catch(() => {}),
              },
            ]
          : []),
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
