// 실패한 저장소만 다시 실행 (작업 기록 줄의 단추). 작업 기록에 남긴 실행 인자(`TaskEntry.request`)로 같은 작업을 실패하거나
// 취소된 저장소에만 다시 건다. 확인 없이 실행하던 작업은 바로 다시 실행하고, 확인 창을 거치던 작업은 같은 확인 흐름을 그
// 저장소들로 좁혀 다시 연다 (이전 값을 채워서). 확인 시점의 스냅샷으로만 실행하는 원격 branch 삭제는 다시 실행하지 않는다.

import type { BatchOp, BatchResult, RepoSummary } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { TaskEntry } from '../../store';
import type { BranchStartPoint, CheckoutCandidate, useFolderBatchFlows } from './FolderBatchBar';
import { formatGitCommand } from './git-command';

/** 다시 실행 방식: 확인 없이 바로 / 원래 확인 흐름을 실패 저장소로 좁혀 다시 연다 */
export type RetryMode = 'direct' | 'confirm';

/** 일괄 작업 흐름 (`useFolderBatchFlows` 가 돌려준 것) */
export type FolderBatchFlows = ReturnType<typeof useFolderBatchFlows>;

/** 다시 실행할 저장소 하나 */
export interface RetryTarget {
  path: string;
  name: string;
}

/** 작업 기록 줄의 다시 실행 계획 */
export interface RetryPlan {
  mode: RetryMode;
  op: BatchOp;
  targets: RetryTarget[];
}

/**
 * 작업 종류별 다시 실행 방식. fetch·pull·branch 업데이트는 원래 확인 없이 돌아 바로 다시 실행한다. 확인 창을 거치던 작업은
 * 그 확인을 다시 연다. 원격 branch 삭제·로컬 강제 삭제는 확인 때의 OID 스냅샷으로만 실행하므로 다시 실행하지 않는다 (null)
 */
export function retryModeOf(op: BatchOp): RetryMode | null {
  switch (op.kind) {
    case 'fetch':
    case 'pull':
    case 'updateBranch':
      return 'direct';
    case 'push':
    case 'createBranch':
    case 'checkout':
    case 'checkoutRemote':
    case 'worktree':
    case 'renameBranch':
    case 'deleteBranch':
    case 'merge':
    case 'rebase':
    // 스태시 저장은 같은 묶음으로 메시지를 채워, 꺼내기는 충돌이 날 수 있어 남은 항목을 보이는 체크 목록으로 다시 연다
    case 'stashPush':
    case 'stashPop':
    // 일괄 명령은 같은 명령을 채운 입력 창을 다시 연다 (위험한 명령은 그 뒤 확인도 다시 묻는다)
    case 'runCommand':
      return 'confirm';
    case 'deleteRemoteBranch':
    case 'deleteLocalBranches':
      return null;
  }
}

/** 다시 실행할 저장소: 실패했거나 취소된 저장소 (결과 순서) */
export function retryTargets(result: BatchResult): RetryTarget[] {
  return result.results
    .filter((r) => !r.ok || r.cancelled === true)
    .map((r) => ({ path: r.path, name: r.name }));
}

/**
 * 작업 기록 줄의 다시 실행 계획: 일괄 작업 줄이고, 실행 인자와 결과가 있고, 다시 실행할 수 있는 작업이며, 실패·취소된
 * 저장소가 하나 이상일 때만. 아니면 null (단추를 그리지 않는다)
 */
export function retryPlan(entry: TaskEntry): RetryPlan | null {
  if (entry.kind !== 'batch' || !entry.request || !entry.result) {
    return null;
  }
  const mode = retryModeOf(entry.request.op);
  const targets = retryTargets(entry.result);
  return mode === null || targets.length === 0 ? null : { mode, op: entry.request.op, targets };
}

/** ref 전체 이름을 화면용 짧은 이름으로 (`refs/remotes/origin/x` → `origin/x`) */
function shortRef(name: string): string {
  return name.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
}

/** 그 branch 가 지금 현재 branch 인 저장소를 표시한 checkout·삭제 체크 목록의 대상 */
function candidatesOf(
  targets: readonly RetryTarget[],
  branch: string,
  summaryOf: (path: string) => RepoSummary | undefined,
): CheckoutCandidate[] {
  return targets.map((t) => ({ ...t, current: summaryOf(t.path)?.branch === branch }));
}

/** 시작점·병합 기준 ref 를 흐름의 시작점 꼴로 */
function startPointOf(fullName: string): BranchStartPoint {
  return { fullName, name: shortRef(fullName) };
}

/**
 * 계획대로 다시 실행한다. 확인 없는 작업은 실패 저장소에서 바로, 확인 창이 있던 작업은 같은 흐름을 그 저장소로 좁혀 이전
 * 값으로 다시 연다 (push 의 새 업스트림 원격, branch 이름·checkout, 워크트리 폴더·branch, 새 이름, 병합 방식, 스태시 저장의
 * 묶음·메시지·미추적 파일 포함, 스태시 꺼내기의 묶음). checkout·삭제의
 * 현재 branch 표시와 병합·리베이스의 사전 조회는 지금 상태로 다시 한다. `summaryOf` 는 누른 순간의 요약을 읽는다
 */
export async function retryFailed(
  flows: FolderBatchFlows,
  plan: RetryPlan,
  summaryOf: (path: string) => RepoSummary | undefined,
): Promise<void> {
  const { op, targets } = plan;
  const paths = targets.map((t) => t.path);
  switch (op.kind) {
    case 'fetch':
    case 'pull':
    case 'updateBranch':
      await flows.run(op, paths);
      return;
    case 'push':
      await flows.push(paths, { remotes: op.newUpstream?.remotes ?? [] });
      return;
    case 'createBranch': {
      const preset = { name: op.name, checkout: op.checkout };
      if (op.startPoint) {
        await flows.createBranchFrom(startPointOf(op.startPoint), targets, preset);
      } else {
        await flows.createBranch(paths, preset);
      }
      return;
    }
    case 'checkout':
      await flows.checkoutBranch({ name: op.name }, candidatesOf(targets, op.name, summaryOf));
      return;
    case 'checkoutRemote':
      await flows.checkoutBranch(
        { name: `${op.remote}/${op.branch}`, remote: { remote: op.remote, branch: op.branch } },
        candidatesOf(targets, op.branch, summaryOf),
        S.folder.timeline.checkoutTracking,
      );
      return;
    case 'worktree':
      await flows.worktree(paths, {
        root: op.destRoot,
        branch: op.branch,
        create: op.createBranch,
      });
      return;
    case 'renameBranch':
      await flows.renameBranch(op.from, targets, { to: op.to });
      return;
    case 'deleteBranch':
      await flows.deleteBranch(op.name, candidatesOf(targets, op.name, summaryOf), {
        checkAll: true,
      });
      return;
    case 'merge':
      await flows.integrateBranch('merge', startPointOf(op.reference), targets, {
        checkAll: true,
        mode: op.mode,
      });
      return;
    case 'rebase':
      await flows.integrateBranch('rebase', startPointOf(op.reference), targets, {
        checkAll: true,
      });
      return;
    case 'stashPush':
      await flows.stashSave(paths, {
        batch: op.batch,
        message: op.message ?? '',
        includeUntracked: op.includeUntracked,
      });
      return;
    case 'stashPop':
      await flows.stashPop(paths, { batch: op.batch });
      return;
    case 'runCommand':
      await flows.runCommand(paths, { command: formatGitCommand(op.args) });
      return;
    case 'deleteRemoteBranch':
    case 'deleteLocalBranches':
      return;
  }
}
