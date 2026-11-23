// 명령 로그(콘솔 탭)의 공용 규칙 — 저장소 탭(세션 스토어)과 폴더 탭(폴더 스토어, W19 ②)이 같은 상한·같은 실패 판정을 쓴다.

import type { CommandLogRecord, RepoSummary } from '@mgit/ipc';

/** 메모리에 보관하는 명령 로그 수 (탭마다) */
export const LOG_CAPACITY = 500;

/** 새 기록을 맨 앞에 붙이고(최신 순) 상한을 넘는 오래된 기록을 버린 새 목록 */
export function prependCapped<T>(list: readonly T[], item: T, cap: number = LOG_CAPACITY): T[] {
  const next = [item, ...list];
  return next.length > cap ? next.slice(0, cap) : next;
}

/** 실패한 명령인지: 취소가 아니고 종료 코드가 0 이 아니다 (시그널로 끝나 코드가 없어도 실패) */
export function commandFailed(record: CommandLogRecord): boolean {
  return !record.cancelled && record.status !== 0;
}

/** 폴더 콘솔의 기록 한 줄 (W19 ②): 폴더 목록의 대표 경로(워크트리에서 돈 명령이면 원 저장소)와 그 기록 */
export interface FolderLogEntry {
  repo: string;
  record: CommandLogRecord;
}

/** 콘솔 행에 붙는 저장소: 이름과 색 번호(`--graph-lane-N`, 모르면 null) */
export interface LogRepo {
  path: string;
  name: string;
  color: number | null;
}

/** 경로의 마지막 요소 (요약을 아직 못 읽은 저장소의 이름) */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/**
 * 기록의 저장소 경로 → 이름·색 (폴더 콘솔의 저장소 칸). 요약 줄에서 찾고, 없으면(아직 못 읽음·재스캔으로 빠짐) 경로의
 * 마지막 이름에 색 없음. 같은 경로는 같은 객체를 돌려 행이 다시 그려지지 않게 요약이 바뀔 때만 새로 만든다
 */
export function logRepoIndex(summaries: readonly RepoSummary[]): (path: string) => LogRepo {
  const known = new Map<string, LogRepo>(
    summaries.map((s) => [s.path, { path: s.path, name: s.name, color: s.color }]),
  );
  return (path) => {
    let repo = known.get(path);
    if (!repo) {
      repo = { path, name: lastSegment(path), color: null };
      known.set(path, repo);
    }
    return repo;
  };
}
