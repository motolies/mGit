// 폴더 일괄 작업의 결과 알림 (W5 에서 FolderTimeline 에 있던 것을 W12 에서 옮겼다). 개요 탭·브랜치 트리·툴바·프로젝트
// 트리 메뉴 어디서 실행하든 끝나면 토스트로 요약하고, 저장소별 결과는 Git 도구 창의 작업 기록 탭(`TaskHistoryPanel`)이
// 같은 요약·상태 글자로 보인다.

import type { BatchResult, CommandOutput, RepoResult } from '@mgit/ipc';
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

/** 업스트림을 새로 지정해 게시한 저장소 수 (일괄 push). 하나도 없으면 0 */
export function publishedCount(result: BatchResult): number {
  return result.results.filter((r) => r.ok && !r.skipped && r.upstreamSet).length;
}

/**
 * 작업 기록 줄·토스트의 수: 옮긴 결과가 있으면 "갱신 · 이미 최신 · 건너뜀 · 실패", push 가 업스트림을 새로 지정했으면
 * "성공 (업스트림 새로 지정 n) · 건너뜀 · 실패", 아니면 "성공 · 건너뜀 · 실패". 취소된 저장소가 있으면 끝에 "· 취소됨 c" 를
 * 붙인다 (건너뜀·실패에 섞지 않는다)
 */
export function batchSummary(result: BatchResult): string {
  const cancelled = result.cancelled ?? 0;
  const counts = countsSummary(result);
  return cancelled > 0 ? S.folder.batch.withCancelled(counts, cancelled) : counts;
}

/** 취소를 뺀 수의 요약 (`batchSummary` 의 앞부분) */
function countsSummary(result: BatchResult): string {
  const t = S.folder.batch;
  if (result.results.some((row) => row.integration)) {
    const prepared = result.results.filter(
      (row) => row.ok && !row.skipped && row.integration === 'squashed',
    ).length;
    const conflicts = result.results.filter(
      (row) => !row.skipped && row.integration === 'conflicts',
    ).length;
    return S.folder.integration.result(
      result.succeeded - prepared,
      prepared,
      conflicts,
      result.skipped,
      Math.max(0, result.failed - conflicts),
    );
  }
  const moved = movedCounts(result);
  if (moved) {
    return t.resultMoved(moved.updated, moved.upToDate, moved.done, result.skipped, result.failed);
  }
  const published = publishedCount(result);
  return published > 0
    ? t.resultPublished(result.succeeded, published, result.skipped, result.failed)
    : t.result(result.succeeded, result.skipped, result.failed);
}

/** 일괄 명령 저장소 한 줄의 종료 상태: `종료 코드 N · 1.2초` (종료 코드가 없으면 신호·취소) */
export function commandStateText(out: CommandOutput): string {
  const c = S.folder.command;
  const status = out.status ?? null;
  return `${status === null ? c.noExit : c.exit(status)} · ${c.elapsed(out.elapsedMs)}`;
}

/**
 * 저장소 한 줄의 상태 글자: 취소됐으면 그 사유(`취소됨`·`실행 중에 취소했습니다 …`), `건너뜀: 사유`, 일괄 명령이면 종료
 * 코드·소요 시간, `실패`, 옮겼으면 `master ← commit 3개`·`이미 최신`, push 가 업스트림을 새로 지정했으면 `업스트림 새로
 * 지정: origin/x`, 그 밖의 성공은 `완료`
 */
export function repoResultState(r: RepoResult): string {
  const t = S.folder.batch;
  if (r.branchDeletion) return branchDeletionLines(r.branchDeletion).join(' · ');
  if (r.cancelled) {
    return r.skipped ?? t.cancelledState;
  }
  if (r.skipped) {
    return `${t.skipped}: ${r.skipped}`;
  }
  if (r.integration === 'conflicts') return S.folder.integration.conflicts;
  if (r.integration === 'squashed') return S.folder.integration.squashed;
  if (r.command) {
    return commandStateText(r.command);
  }
  if (!r.ok) {
    return t.failed;
  }
  if (r.moved) {
    return r.moved.commits > 0
      ? S.branches.update.moved(r.moved.branch, r.moved.commits)
      : S.branches.update.upToDate;
  }
  if (r.upstreamSet) {
    return t.upstreamSet(r.upstreamSet);
  }
  return t.ok;
}

/** 커밋하지 않은 변경으로 건너뛴 저장소 수 (pull·checkout·branch 업데이트, 코어 `skippedDirty`) */
export function dirtySkippedCount(result: BatchResult): number {
  return result.results.filter((r) => r.skippedDirty === true).length;
}

/**
 * 일괄 작업 결과를 토스트 문구로 옮긴다: 수(`batchSummary`), 건너뛰거나 실패한 저장소의 사유, 그다음 갱신한 저장소
 * (`저장소: master ← commit 3개`, push 가 업스트림을 새로 지정한 저장소는 `저장소: 업스트림 새로 지정: origin/x`). 줄이
 * 많으면 "외 N개" 로 줄인다. 커밋하지 않은 변경으로 건너뛴 저장소가 있으면 끝에 스태시 저장 후 다시 실행하라는 안내를
 * 붙인다 (줄 수 상한과 따로). 실패가 하나라도 있으면 오류 토스트다
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
        `${r.name}: ${r.branchDeletion ? [...branchDeletionLines(r.branchDeletion), ...(r.message ? [r.message] : [])].join(' · ') : (r.skipped ?? (r.integration === 'conflicts' ? [repoResultState(r), r.message].filter(Boolean).join(' · ') : r.message))}`,
    );
  const updates = result.results
    .filter(
      (r) =>
        r.ok &&
        !r.skipped &&
        (r.branchDeletion ||
          r.integration === 'squashed' ||
          (r.moved?.commits ?? 0) > 0 ||
          !!r.upstreamSet),
    )
    .map((r) => `${r.name}: ${repoResultState(r)}`);
  const lines = [...problems, ...updates];
  const more = lines.length - BATCH_PROBLEM_LINES;
  const dirty = dirtySkippedCount(result);
  return {
    kind: result.failed > 0 ? 'error' : 'success',
    title: result.label,
    message: [
      batchSummary(result),
      ...lines.slice(0, BATCH_PROBLEM_LINES),
      ...(more > 0 ? [S.confirm.more(more)] : []),
      ...(dirty > 0 ? [S.folder.batch.dirtyHint(dirty)] : []),
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
