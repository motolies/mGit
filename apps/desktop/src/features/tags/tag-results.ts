// 태그 문서 결과 칸의 순수 함수 (C4, TG-12 ②): 일괄 작업 결과·지울 곳 삭제 요약을 "요약 한 줄 + 실패만 남긴 목록 +
// 다시 시도할 이름"으로 바꾼다. 화면(`TagResultPanel`)은 이것을 그리기만 한다.

import { S } from '@mgit/ui';
import {
  isTagRetryable,
  isTagSuccess,
  type TagBatchOutcome,
  type TagDeleteSummary,
  tagResultText,
} from '../../store/tag-ops';

/** 실패 한 줄 */
export interface TagResultLine {
  name: string;
  /** 사유 (원격 이름이 붙을 수 있다) */
  text: string;
  /** 일시적 실패·확인 대기라 다시 해 볼 만한지 */
  retryable: boolean;
}

/** 결과 칸 하나 */
export interface TagResultView {
  /** 요약 한 줄 (`role=status`) */
  summary: string;
  /** 실패한 것만 (성공은 남기지 않는다) */
  failures: TagResultLine[];
  /** 명령 전체가 실패했거나 확인창에서 멈춘 사유 */
  error: string | null;
  /** 다시 시도할 이름 (일시적 실패만). 비었으면 다시 시도 단추를 끈다 */
  retryNames: string[];
  /** 실패로 남은 이름 (선택으로 남긴다) */
  failedNames: string[];
}

/** 이름 목록을 겹치지 않게 순서대로 */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * 일괄 push·가져오기·덮어쓰기의 결과 칸 (TG-12 ②). 명령 전체가 실패했으면 모든 이름을 다시 시도할 수 있다 (인증·연결은
 * 고친 뒤 다시 하는 것이 보통이다)
 */
export function batchResultView(
  title: string,
  outcome: TagBatchOutcome,
  names: readonly string[],
): TagResultView {
  if (outcome.error !== null) {
    return {
      summary: S.tag.result.summary(title, 0, names.length),
      failures: [],
      error: outcome.error,
      retryNames: [...names],
      failedNames: [...names],
    };
  }
  const failures = outcome.results
    .filter((r) => !isTagSuccess(r.status))
    .map(
      (r): TagResultLine => ({
        name: r.name,
        text: tagResultText(r),
        retryable: isTagRetryable(r.status),
      }),
    );
  return {
    summary: S.tag.result.summary(title, outcome.results.length - failures.length, failures.length),
    failures,
    error: null,
    retryNames: failures.filter((f) => f.retryable).map((f) => f.name),
    failedNames: failures.map((f) => f.name),
  };
}

/**
 * 지울 곳 삭제의 결과 칸 (TG-05 ④·TG-12 ②): 원격별 실패(원격 이름을 붙여), 원격 명령 전체 실패, 로컬에 남긴 것, 로컬 실패.
 * 다 지운 이름만 성공으로 센다. 확인창에서 취소했으면 그 사실을 사유로 둔다
 */
export function deleteResultView(title: string, summary: TagDeleteSummary): TagResultView {
  const failures: TagResultLine[] = [];
  const retry: string[] = [];
  for (const remote of summary.scope.remotes) {
    for (const r of summary.remote[remote] ?? []) {
      if (!isTagSuccess(r.status)) {
        failures.push({
          name: r.name,
          text: S.tag.del.remoteFailed(remote, tagResultText(r)),
          retryable: isTagRetryable(r.status),
        });
      }
    }
    if (summary.remoteErrors[remote] !== undefined && summary.remote[remote] === undefined) {
      // 원격 명령 전체가 실패: 그 원격의 모든 이름을 다시 해 볼 만하다
      retry.push(...summary.names);
    }
  }
  const remoteFailed = new Set(failures.map((f) => f.name));
  for (const name of summary.localKept) {
    if (!remoteFailed.has(name)) {
      failures.push({ name, text: S.tag.result.localKept, retryable: summary.localError !== null });
    }
  }
  const errors = [
    ...summary.scope.remotes.flatMap((remote) =>
      summary.remoteErrors[remote] !== undefined
        ? [S.tag.del.remoteFailed(remote, summary.remoteErrors[remote])]
        : [],
    ),
    ...(summary.localError !== null ? [S.tag.del.localFailed(summary.localError)] : []),
    ...(summary.cancelled ? [S.tag.del.cancelled] : []),
  ];
  const failedNames = unique([
    ...failures.map((f) => f.name),
    ...(retry.length > 0 ? summary.names : []),
  ]);
  const retryNames = unique([...failures.filter((f) => f.retryable).map((f) => f.name), ...retry]);
  return {
    summary: S.tag.result.summary(
      title,
      summary.names.length - failedNames.length,
      failedNames.length,
    ),
    failures,
    error: errors.length > 0 ? errors.join(' · ') : null,
    retryNames,
    failedNames,
  };
}
