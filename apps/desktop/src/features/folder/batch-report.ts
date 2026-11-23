// 폴더 일괄 작업의 결과 알림 (W5 에서 FolderTimeline 에 있던 것을 W12 에서 옮겼다). 브랜치 트리·툴바·프로젝트 트리
// 메뉴에서 실행한 작업은 개요 탭의 결과 표가 보이지 않을 수 있으므로 어디서든 보이는 토스트로 알린다.

import type { BatchResult } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useCallback } from 'react';
import { getFolderStore, useAppStore, useFolder } from '../../store';

/** 토스트에 적는 저장소별 사유의 상한. 넘는 것은 "외 N개" 로 줄인다 */
const BATCH_PROBLEM_LINES = 5;

/**
 * 일괄 작업 결과를 토스트 문구로 옮긴다: 성공·건너뜀·실패 수와 건너뛰거나 실패한 저장소의 사유. 실패가 하나라도
 * 있으면 오류 토스트다
 */
export function batchNotice(result: BatchResult): {
  kind: 'success' | 'error';
  title: string;
  message: string;
} {
  const problems = result.results
    .filter((r) => r.skipped || !r.ok)
    .map((r) => `${r.name}: ${r.skipped ?? r.message}`);
  const more = problems.length - BATCH_PROBLEM_LINES;
  return {
    kind: result.failed > 0 ? 'error' : 'success',
    title: result.label,
    message: [
      S.folder.batch.result(result.succeeded, result.skipped, result.failed),
      ...problems.slice(0, BATCH_PROBLEM_LINES),
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
