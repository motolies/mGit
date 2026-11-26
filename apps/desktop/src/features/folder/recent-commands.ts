// 폴더마다 기억하는 최근 git 명령 (일괄 명령 입력 창의 처음 값과 제안 목록). 사용자 설정 저장소에 남아 앱을 다시 켜도
// 이어진다. 자격 증명이 든 명령은 남기지 않는다 (`withRecentCommand`).

import { readPref, writePref } from '../../store/prefs';
import { withRecentCommand } from './git-command';

/** 저장 키 (폴더 탭의 경로마다) */
export function recentCommandsKey(folder: string): string {
  return `mgit.folder.commands:${folder}`;
}

/** 그 폴더의 최근 명령 (가장 최근이 앞, `git …` 꼴) */
export function readRecentCommands(folder: string): string[] {
  return readPref<unknown[]>(recentCommandsKey(folder), []).filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
}

/** 명령을 그 폴더의 최근 목록 맨 앞에 올린다. 목록이 바뀌지 않으면(자격 증명이 든 명령, 이미 맨 앞) 쓰지 않는다 */
export function recordRecentCommand(folder: string, args: readonly string[]): string[] {
  const before = readRecentCommands(folder);
  const next = withRecentCommand(before, args);
  if (next.length !== before.length || next.some((item, i) => item !== before[i])) {
    writePref(recentCommandsKey(folder), next);
  }
  return next;
}
