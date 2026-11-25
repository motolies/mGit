import type { ChangedFile } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { type MenuItem, menuGroups } from '../../components/ContextMenu';
import { joinRoot } from '../../store/fs-path';

export interface ChangedFileActions {
  showDiff(): void;
  editCurrent(): void;
  blame?: () => void;
  history?: () => void;
  difftool?: () => void;
}

/** 단일·멀티·범위 상세의 파일 메뉴를 같은 순서로 만들고 과거 파일 경로를 보존한다. */
export function changedFileMenu(
  file: ChangedFile,
  repoPath: string,
  actions: ChangedFileActions,
): MenuItem[] {
  return menuGroups([
    [
      { label: S.menu.showDiff, commandId: 'file.showDiff', onSelect: actions.showDiff },
      { label: S.fileView.editCurrent, onSelect: actions.editCurrent },
    ],
    [
      ...(actions.blame
        ? [
            {
              label: S.menu.blame,
              disabled: file.change.kind === 'deleted',
              onSelect: actions.blame,
            },
          ]
        : []),
      ...(actions.history ? [{ label: S.menu.fileHistory, onSelect: actions.history }] : []),
      ...(actions.difftool ? [{ label: S.menu.difftool, onSelect: actions.difftool }] : []),
    ],
    [
      {
        label: S.project.menu.copyRelative,
        onSelect: () => void navigator.clipboard.writeText(file.path).catch(() => {}),
      },
      {
        label: S.project.menu.copyPath,
        onSelect: () =>
          void navigator.clipboard.writeText(joinRoot(repoPath, file.path)).catch(() => {}),
      },
    ],
  ]);
}
