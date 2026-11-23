// 로그 범위를 하나로 합치기 (MRG-07, GRAPH-10). 세션 스토어가 IPC 로 plan 목록(`rebasePlanCommits`)과 메시지를 읽어 이
// 파일의 순수 함수로 검사·초안·plan 을 만들고, 기존 인터랙티브 rebase(`rebaseInteractive`)로 실행한다 — 실행 전 branch
// 백업과 Undo 항목은 코어의 그 경로가 남긴다.

import type { PlanCommit, RebasePlan, RebasePlanInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { RangeSelection } from './session-store';

/** git 의 빈 트리 (첫 commit 이 든 범위의 기준 `RangeSelection.base`) */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 합칠 범위: rebase 기준(가장 오래된 commit 의 부모, 첫 commit 이면 null = `--root`)과 범위·그 뒤 commit (오래된 것부터) */
export interface SquashRangeTarget {
  onto: string | null;
  /** 범위의 commit. 첫째가 가장 오래된 것 */
  range: PlanCommit[];
  /** 범위 뒤에서 HEAD 까지 (다시 쓰이기만 한다) */
  trailing: PlanCommit[];
}

/** 대화상자에 넘기는 준비 결과: 합칠 범위 + 메시지 초안 */
export interface SquashRangePrep extends SquashRangeTarget {
  draft: string;
}

/** 범위 검사 결과. 안 되면 오류 줄에 보일 사유 */
export type SquashRangeCheck =
  | { ok: true; target: SquashRangeTarget }
  | { ok: false; reason: string };

/** 범위가 칠한 로그 줄 수 (메뉴 문구의 N). 실행 전 검사가 이 수와 실제로 합칠 commit 수가 같은지 본다 */
export function rangeRowCount(range: Pick<RangeSelection, 'from' | 'to'>): number {
  return range.to - range.from + 1;
}

/** 범위의 rebase 기준: 범위 diff 의 기준(`older^`)이고, 빈 트리(첫 commit 이 든 범위)면 null (`--root`) */
export function squashRangeOnto(base: string): string | null {
  return base === EMPTY_TREE ? null : base;
}

/**
 * plan 목록(`onto..HEAD`, 오래된 것부터, merge 제외)으로 범위를 검사한다. 합칠 수 있으려면
 * - `onto..HEAD` 에 merge commit 이 없고 (범위 안과 범위 위 모두 — 있으면 실행이 이력을 평탄화한다)
 * - 가장 오래된 commit 이 목록의 첫째이고 가장 새 commit 이 목록에 있으며 (현재 branch 의 이어진 commit)
 * - 그 사이 commit 수가 로그에 칠한 줄 수와 같아야 한다 (다른 branch 의 줄이 끼었거나 필터로 가린 commit 이 없음)
 */
export function checkSquashRange(
  info: RebasePlanInfo,
  onto: string | null,
  older: string,
  newer: string,
  rows: number,
): SquashRangeCheck {
  if (info.hasMerges) {
    return { ok: false, reason: S.rebase.squashRangeMerges };
  }
  const end = info.commits.findIndex((c) => c.oid === newer);
  if (info.commits[0]?.oid !== older || end < 0) {
    return { ok: false, reason: S.rebase.squashRangeNotOnBranch };
  }
  const range = info.commits.slice(0, end + 1);
  if (range.length !== rows || range.length < 2) {
    return { ok: false, reason: S.rebase.squashRangeMixed };
  }
  return { ok: true, target: { onto, range, trailing: info.commits.slice(end + 1) } };
}

/** 메시지 초안: 범위의 메시지를 오래된 것부터 빈 줄 하나로 이어 붙인다 (각 메시지의 끝 공백은 걷는다) */
export function squashRangeDraft(messages: readonly string[]): string {
  return messages
    .map((m) => m.trimEnd())
    .filter((m) => m !== '')
    .join('\n\n');
}

/**
 * 실행 plan: 가장 오래된 commit 은 reword(사용자 메시지), 범위의 나머지는 fixup(메시지 버림), 범위 뒤는 pick. fixup 은
 * 그때의 HEAD(= reword 한 commit) 메시지를 남기므로 결과는 사용자 메시지의 commit 하나다 (코어 통합 테스트로 확인).
 * 메시지 수정·부모에 합치기와 같이 작업 중 변경은 stash 했다가 되돌리고, 다른 branch 는 옮기지 않는다
 */
export function buildSquashRangePlan(target: SquashRangeTarget, message: string): RebasePlan {
  const [first, ...rest] = target.range;
  return {
    onto: target.onto,
    steps: [
      ...(first ? [{ oid: first.oid, action: { kind: 'reword' as const, message } }] : []),
      ...rest.map((c) => ({ oid: c.oid, action: { kind: 'fixup' as const } })),
      ...target.trailing.map((c) => ({ oid: c.oid, action: { kind: 'pick' as const } })),
    ],
    autostash: true,
    updateRefs: false,
    exec: null,
  };
}
