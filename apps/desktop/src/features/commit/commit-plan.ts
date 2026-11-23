// Commit 도구 창(폴더 모드)의 커밋 대상 (W14). 누르기 전에 무엇이 커밋되는지 보이고, 그 목록을 그대로 코어에 넘긴다.
// 규칙은 코어 `folder_commit(…, stage_all = false)` 의 건너뛰기와 같다 (계획 부록 "W14 ① 에서 확정"): 커밋될 저장소 =
// 변경 목록의 stage 된 항목이 있고 충돌이 없으며, 요약의 진행 중 작업·요약 실패가 없는 저장소. stage 된 것이 없는
// 저장소는 대상도 아니고 건너뜀으로 보이지도 않는다. stage 는 됐는데 커밋되지 않을 저장소는 사유와 함께 보인다.

import type { BatchResult, RepoChanges, RepoSummary } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { entryInArea } from '../../store/session-store';

/** stage 는 됐지만 커밋되지 않을 사유 */
export type CommitSkipReason = 'inProgress' | 'conflict' | 'summaryFailed' | 'unknown';

/** 커밋 대상 저장소 하나 */
export interface CommitPlanRepo {
  path: string;
  name: string;
  /** stage 된 파일 수 */
  files: number;
}

/** 커밋되지 않을 저장소 하나와 사유 */
export interface CommitSkip extends CommitPlanRepo {
  reason: CommitSkipReason;
}

export interface CommitPlan {
  /** 커밋될 저장소 (변경 목록 순서). 이 목록을 그대로 `folderCommit` 에 넘긴다 */
  repos: CommitPlanRepo[];
  /** 커밋될 파일 수 (커밋될 저장소의 stage 된 항목) */
  files: number;
  /** stage 된 것이 있는데 커밋되지 않을 저장소 */
  skipped: CommitSkip[];
}

/** 저장소의 stage 된 항목 수 (충돌 항목은 세지 않는다 — 저장소 탭의 Staged 목록과 같은 기준) */
export function stagedFiles(rc: RepoChanges): number {
  return rc.entries.filter((e) => entryInArea(e, true)).length;
}

/** 커밋되지 않을 사유 (코어 순서: 요약 실패·진행 중 작업·충돌). 커밋될 저장소면 null */
function skipReason(rc: RepoChanges, summary: RepoSummary | undefined): CommitSkipReason | null {
  if (summary === undefined) {
    return 'unknown';
  }
  if (summary.error !== null && summary.error !== undefined) {
    return 'summaryFailed';
  }
  if (summary.op !== null && summary.op !== undefined) {
    return 'inProgress';
  }
  const conflicted = rc.summary.conflicted > 0 || rc.entries.some((e) => e.conflict);
  return conflicted ? 'conflict' : null;
}

/** 지금 상태로 커밋하면 무엇이 커밋되고 무엇이 건너뛰어지는지 */
export function commitPlan(
  changes: readonly RepoChanges[],
  summaries: readonly RepoSummary[],
): CommitPlan {
  const byPath = new Map(summaries.map((s) => [s.path, s]));
  const repos: CommitPlanRepo[] = [];
  const skipped: CommitSkip[] = [];
  for (const rc of changes) {
    const files = stagedFiles(rc);
    if (files === 0) {
      continue;
    }
    const reason = skipReason(rc, byPath.get(rc.path));
    const row = { path: rc.path, name: rc.name, files };
    if (reason === null) {
      repos.push(row);
    } else {
      skipped.push({ ...row, reason });
    }
  }
  return { repos, files: repos.reduce((sum, r) => sum + r.files, 0), skipped };
}

/** 커밋 버튼을 막는 사유 */
export type CommitBlocker = 'running' | 'pending' | 'noTargets' | 'noMessage';

/**
 * 커밋 버튼을 막는 사유 (툴팁으로 보인다). 일괄 작업(커밋 포함)이 돌고 있음 → stage·unstage 가 돌고 있음 → 커밋될 것이
 * 없음 → 메시지가 빔 순서. 누를 수 있으면 null
 */
export function commitBlocker(
  plan: CommitPlan,
  message: string,
  state: { running: boolean; pending: boolean },
): CommitBlocker | null {
  if (state.running) {
    return 'running';
  }
  if (state.pending) {
    return 'pending';
  }
  if (plan.repos.length === 0) {
    return 'noTargets';
  }
  return message.trim() === '' ? 'noMessage' : null;
}

/**
 * 커밋 뒤 메시지를 비우는지: 대상이 모두 커밋됐을 때만 (실패나 건너뜀이 있으면 남긴다 — 고쳐서 다시 누를 수 있게)
 */
export function clearsMessage(result: BatchResult): boolean {
  return result.succeeded > 0 && result.failed === 0 && result.skipped === 0;
}

/** 커밋되지 않을 저장소 안내의 접힌 한 줄 (W19) */
export interface SkipSummary {
  /** 접힌 줄의 글자: 하나면 그 줄 그대로, 여럿이면 `커밋되지 않을 저장소 N개` */
  text: string;
  /** 툴팁: 제목과 저장소별 사유 (접혀 있어도 누르기 전에 볼 수 있다) */
  detail: string;
}

/**
 * 커밋되지 않을 저장소 안내를 한 줄로 접는다 (W19, 낮은 창에서 변경 목록의 자리를 남긴다). 저장소별 사유는 펼치거나
 * 툴팁으로 본다. 없으면 null
 */
export function skipSummary(lines: readonly string[]): SkipSummary | null {
  const [first] = lines;
  if (first === undefined) {
    return null;
  }
  const t = S.commitTool;
  return {
    text: lines.length === 1 ? first : t.skippedSummary(lines.length),
    detail: [t.skippedLabel, ...lines].join('\n'),
  };
}

/** 실제로 커밋된 저장소 (Commit and Push 가 push 확인창에 넘긴다) */
export function committedRepos(result: BatchResult): string[] {
  return result.results.filter((r) => r.ok && !r.skipped).map((r) => r.path);
}
