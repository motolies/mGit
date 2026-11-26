// 일괄 작업 전 편집기 초안 확인. 작업 트리 파일을 바꾸는 일괄 작업은 대상 저장소 안에 저장하지 않았거나 저장 중인 편집기
// 초안이 있으면 실행하지 않는다 — 실행 뒤 자동 저장이 바뀐 파일을 다시 써 충돌 띠가 뜨지 않게. 일괄 병합·리베이스
// (`integrateBranch`)의 규칙과 같다: 체크 목록에서는 그 저장소를 꺼진 칸으로 보이고, 확인 뒤(또는 확인 없이 바로 도는 작업은
// 누른 순간) 다시 검사해 하나라도 있으면 막는다.

import type { BatchOp } from '@mgit/ipc';
import { editorDrafts } from '../../store/editor-drafts';
import { commandRewritesWorkTree } from './git-command';

/** 저장소 안에 저장하지 않았거나 저장 중인 편집기 초안이 있는지 (폴더·저장소·가벼운 세션에서 연 문서 모두) */
export function hasPendingDraft(repoPath: string): boolean {
  return editorDrafts(repoPath, { includeSaving: true }).length > 0;
}

/**
 * 그 일괄 작업이 저장소의 작업 트리 파일을 바꿀 수 있는지. `currentBranch` 는 그 저장소의 지금 branch (모르면 undefined) —
 * branch 업데이트는 지금 checkout 된 branch 를 옮길 때만 파일을 바꾸고, branch 만들기는 시작점에서 만들며 checkout 할 때만
 * 바꾼다 (시작점 없이 지금 HEAD 에서 만들면 파일은 그대로다). 일괄 명령은 하위 명령으로 판단한다(알 수 없으면 바꾼다고 본다,
 * `commandRewritesWorkTree`). 모르면 바꾼다고 본다
 */
export function rewritesWorkTree(op: BatchOp, currentBranch?: string | null): boolean {
  switch (op.kind) {
    case 'pull':
    case 'checkout':
    case 'checkoutRemote':
    case 'merge':
    case 'rebase':
    case 'stashPush':
    case 'stashPop':
      return true;
    case 'updateBranch':
      return currentBranch === undefined || currentBranch === op.name;
    case 'createBranch':
      return op.checkout && !!op.startPoint;
    case 'runCommand':
      return commandRewritesWorkTree(op.args);
    case 'fetch':
    case 'push':
    case 'worktree':
    case 'renameBranch':
    case 'deleteBranch':
    case 'deleteRemoteBranch':
    case 'deleteLocalBranches':
      return false;
  }
}

/** 실행하면 편집기 초안과 부딪힐 대상 저장소 (대상 순서). `currentBranchOf` 는 저장소의 지금 branch (모르면 undefined) */
export function draftBlockedRepos<T extends { path: string }>(
  op: BatchOp,
  targets: readonly T[],
  currentBranchOf: (path: string) => string | null | undefined,
): T[] {
  return targets.filter(
    (target) => rewritesWorkTree(op, currentBranchOf(target.path)) && hasPendingDraft(target.path),
  );
}
