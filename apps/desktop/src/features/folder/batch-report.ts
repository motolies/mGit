// 폴더 일괄 작업의 결과 알림 (W5 에서 FolderTimeline 에 있던 것을 W12 에서 옮겼다). 개요 탭·브랜치 트리·툴바·프로젝트
// 트리 메뉴 어디서 실행하든 끝나면 토스트로 요약하고, 저장소별 결과는 Git 도구 창의 작업 기록 탭(`TaskHistoryPanel`)이
// 같은 요약·상태 글자로 보인다.

import type { BatchResult, RepoResult } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useCallback } from 'react';
import { getFolderStore, useAppStore, useFolder } from '../../store';
import { branchDeletionLines } from '../branches/remote-branch-delete';

/** 토스트에 적는 저장소별 줄(건너뜀·실패 사유, 갱신)의 상한. 넘는 것은 "외 N개" 로 줄인다 */
const BATCH_PROBLEM_LINES = 5;

/**
 * branch 를 옮기는 작업(pull·branch 업데이트, BR-09)의 성공 나눔: 받은 commit 이 있는 것(갱신), 없는 것(이미 최신),
 * 옮긴 것을 알 수 없는 성공(완료). 옮긴 결과(`moved`)가 하나도 없으면 null — fetch·push 처럼 나누지 않는 작업이다
 */
export function movedCounts(
  result: BatchResult,
): { updated: number; upToDate: number; done: number } | null {
  if (!result.results.some((r) => r.moved)) {
    return null;
  }
  const succeeded = result.results.filter((r) => r.ok && !r.skipped);
  const updated = succeeded.filter((r) => (r.moved?.commits ?? 0) > 0).length;
  const upToDate = succeeded.filter((r) => r.moved?.commits === 0).length;
  return { updated, upToDate, done: succeeded.length - updated - upToDate };
}

/** 작업 기록 줄·토스트의 수: 옮긴 결과가 있으면 "갱신 · 이미 최신 · 건너뜀 · 실패", 아니면 "성공 · 건너뜀 · 실패" */
export function batchSummary(result: BatchResult): string {
  const t = S.folder.batch;
  const moved = movedCounts(result);
  return moved
    ? t.resultMoved(moved.updated, moved.upToDate, moved.done, result.skipped, result.failed)
    : t.result(result.succeeded, result.skipped, result.failed);
}

/** 저장소 한 줄의 상태 글자: `건너뜀: 사유`, `실패`, 옮겼으면 `master ← commit 3개`·`이미 최신`, 그 밖의 성공은 `완료` */
export function repoResultState(r: RepoResult): string {
  const t = S.folder.batch;
  if (r.branchDeletion) return branchDeletionLines(r.branchDeletion).join(' · ');
  if (r.skipped) {
    return `${t.skipped}: ${r.skipped}`;
  }
  if (!r.ok) {
    return t.failed;
  }
  if (r.moved) {
    return r.moved.commits > 0
      ? S.branches.update.moved(r.moved.branch, r.moved.commits)
      : S.branches.update.upToDate;
  }
  return t.ok;
}

/**
 * 일괄 작업 결과를 토스트 문구로 옮긴다: 수(`batchSummary`), 건너뛰거나 실패한 저장소의 사유, 그다음 갱신한 저장소
 * (`저장소: master ← commit 3개`). 줄이 많으면 "외 N개" 로 줄인다. 실패가 하나라도 있으면 오류 토스트다
 */
export function batchNotice(result: BatchResult): {
  kind: 'success' | 'error';
  title: string;
  message: string;
} {
  const problems = result.results
    .filter((r) => r.skipped || !r.ok)
    .map(
      (r) =>
        `${r.name}: ${r.branchDeletion ? [...branchDeletionLines(r.branchDeletion), ...(r.message ? [r.message] : [])].join(' · ') : (r.skipped ?? r.message)}`,
    );
  const updates = result.results
    .filter((r) => r.ok && !r.skipped && (r.branchDeletion || (r.moved?.commits ?? 0) > 0))
    .map((r) => `${r.name}: ${repoResultState(r)}`);
  const lines = [...problems, ...updates];
  const more = lines.length - BATCH_PROBLEM_LINES;
  return {
    kind: result.failed > 0 ? 'error' : 'success',
    title: result.label,
    message: [
      batchSummary(result),
      ...lines.slice(0, BATCH_PROBLEM_LINES),
      ...(more > 0 ? [S.confirm.more(more)] : []),
    ].join('\n'),
  };
}

/**
 * 일괄 작업 결과를 토스트로 알리는 함수 (`useFolderBatchFlows` 의 `report`). 실행하지 못했으면(null) 폴더
 * 스토어의 `error` 를 사유로 적는다
 */
export function useBatchReport(): (result: BatchResult | null) => void {
  const notice = useAppStore((s) => s.notice);
  const folderId = useFolder((st) => st.id);
  return useCallback(
    (result: BatchResult | null) => {
      if (result) {
        notice(batchNotice(result));
        return;
      }
      const reason = folderId === null ? null : getFolderStore(folderId)?.getState().error;
      notice({ kind: 'error', title: S.folder.timeline.batchFailed, message: reason ?? undefined });
    },
    [folderId, notice],
  );
}
