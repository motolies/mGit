import { isMac, normalizeShortcut } from '@mgit/ui';
import type { Action } from './actions';

export type CommandScope =
  | 'global'
  | 'project'
  | 'log'
  | 'files'
  | 'diff'
  | 'commit'
  | 'branch'
  | 'editor';

/** IntelliJ OS별 기본값. 없는 ID의 기존 mGit 기본값은 그대로 유지한다. */
export function defaultShortcut(id: string, fallback?: string, mac = isMac()): string | undefined {
  const keys: Record<string, string | undefined> = {
    'app.palette': 'mod+shift+a',
    'app.settings': mac ? 'mod+,' : 'ctrl+alt+s',
    'view.focusSidebar': mac ? 'mod+1' : 'alt+1',
    'view.focusGraph': mac ? 'mod+9' : 'alt+9',
    'view.toolCommit': mac ? 'mod+0' : 'alt+0',
    'view.terminal': 'alt+f12',
    'view.graphFilter': undefined,
    'sync.pull': 'mod+t',
    'sync.push': 'mod+shift+k',
    'project.newFile': 'mod+n',
    'project.newFolder': 'mod+shift+n',
    'project.rename': 'f2',
    'project.copy': 'mod+c',
    'project.cut': 'mod+x',
    'project.paste': 'mod+v',
    'project.trash': mac ? 'mod+backspace' : 'delete',
    'log.reword': 'f2',
    'log.copyHash': 'mod+c',
    'log.searchNext': mac ? 'mod+g' : 'f3',
    'log.searchPrevious': mac ? 'mod+shift+g' : 'shift+f3',
    'commit.prepare': 'mod+k',
    'commit.execute': 'mod+enter',
    'file.showDiff': 'mod+d',
    'diff.nextHunk': 'f7',
    'diff.previousHunk': 'shift+f7',
    'branch.create': undefined,
    'editor.format': 'mod+alt+l',
  };
  return id in keys ? keys[id] : fallback;
}

/** 명령별 입력 정책과 활성 영역의 메타데이터. */
export const COMMAND_SCOPES: Record<string, CommandScope> = {
  'project.newFile': 'project',
  'project.newFolder': 'project',
  'project.rename': 'project',
  'project.copy': 'project',
  'project.cut': 'project',
  'project.paste': 'project',
  'project.trash': 'project',
  'log.reword': 'log',
  'log.copyHash': 'log',
  'log.searchNext': 'log',
  'log.searchPrevious': 'log',
  'file.showDiff': 'files',
  'file.stage': 'files',
  'file.unstage': 'files',
  'file.discard': 'files',
  'diff.nextHunk': 'diff',
  'diff.previousHunk': 'diff',
  'diff.previousFile': 'diff',
  'diff.nextFile': 'diff',
  'commit.execute': 'commit',
  'branch.rename': 'branch',
  'branch.checkout': 'branch',
  'editor.pin': 'editor',
  'editor.format': 'editor',
};

/** 함께 활성화될 수 있는 영역만 충돌로 취급한다. 에디터는 diff를 포함한다. */
export function scopesOverlap(a: CommandScope = 'global', b: CommandScope = 'global'): boolean {
  return (
    a === 'global' ||
    b === 'global' ||
    a === b ||
    (a === 'editor' && b === 'diff') ||
    (b === 'editor' && a === 'diff') ||
    (a === 'commit' && b === 'files') ||
    (b === 'commit' && a === 'files')
  );
}

/** 저장·표시에서 동일한 정규형과 영역 규칙으로 충돌을 검사한다. */
export function shortcutsConflict(a: Action, b: Action): boolean {
  if (a.id === b.id || !a.shortcut || !b.shortcut) return false;
  const key = normalizeShortcut(a.shortcut);
  return key !== null && key === normalizeShortcut(b.shortcut) && scopesOverlap(a.scope, b.scope);
}

/** 터미널이 앱에 전달할 수 있는 명령만 명시한다. */
export const TERMINAL_COMMANDS = new Set([
  'view.terminal',
  'view.focusSidebar',
  'view.focusGraph',
  'view.toolCommit',
  'view.focusEditor',
  'view.focusDetail',
  'view.dockHide',
]);
