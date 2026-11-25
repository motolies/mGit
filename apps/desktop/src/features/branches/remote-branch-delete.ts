import type { BatchResult, BranchDeleteTarget, BranchDeletionResult, RepoResult } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { useDialogs } from '../../components/use-dialogs';
import { repoNameOf } from '../../store';

export interface BranchDeleteFlow {
  dialogs: Pick<ReturnType<typeof useDialogs>, 'prompt' | 'confirm'>;
  inspect(): Promise<BranchDeleteTarget[]>;
  execute(targets: BranchDeleteTarget[], deleteLocal: boolean): Promise<BatchResult | null>;
  force(targets: BranchDeleteTarget[]): Promise<BatchResult | null>;
}

/** 삭제 단계의 결과를 작업 기록과 알림에 같은 문구로 표시한다. */
export function branchDeletionLines(result: BranchDeletionResult): string[] {
  const t = S.branches.deletion;
  return [
    t.remoteResult(t.status[result.remote.status]),
    ...result.locals.map(
      (local) =>
        `${t.localResult(local.name, t.status[local.status])}${local.message ? ` — ${local.message}` : ''}`,
    ),
    ...(result.remote.message ? [result.remote.message] : []),
  ];
}

/** 단일 저장소 삭제도 일괄 결과와 같은 방식으로 보고한다. */
export function singleDeletionResult(
  target: BranchDeleteTarget,
  result: BranchDeletionResult,
): BatchResult {
  const ok =
    ['deleted', 'alreadyAbsent', 'notRun'].includes(result.remote.status) &&
    result.locals.every((step) => ['deleted', 'alreadyAbsent'].includes(step.status));
  return {
    label: S.branches.deletion.resultTitle,
    results: [
      {
        path: target.path,
        name: repoNameOf(target.path),
        ok,
        skipped: null,
        message: '',
        branchDeletion: result,
      },
    ],
    succeeded: ok ? 1 : 0,
    skipped: 0,
    failed: ok ? 0 : 1,
  };
}

/** 강제 재시도는 미병합으로 남은 원래 후보만 전달하고 확인 후 생긴 브랜치를 포함하지 않는다. */
export function forceDeletionTargets(
  targets: readonly BranchDeleteTarget[],
  result: BatchResult,
): BranchDeleteTarget[] {
  return targets.flatMap((target) => {
    const row = result.results.find((entry) => entry.path === target.path);
    if (
      !row?.branchDeletion ||
      !['deleted', 'alreadyAbsent'].includes(row.branchDeletion.remote.status)
    )
      return [];
    const pending = row.branchDeletion.locals.filter((local) => local.status === 'notMerged');
    const locals = target.locals.filter((local) =>
      pending.some((item) => item.name === local.name && item.oid === local.oid),
    );
    return locals.length ? [{ ...target, locals }] : [];
  });
}

/** 원격 단계의 성공은 유지하고 로컬 재시도의 결과만 합친다. */
export function mergeDeletionRetry(initial: BatchResult, retried: BatchResult): BatchResult {
  const results = initial.results.map((row): RepoResult => {
    const next = retried.results.find((entry) => entry.path === row.path);
    if (!next || !row.branchDeletion) return row;
    if (!next.branchDeletion)
      return { ...row, ok: false, message: next.message || next.skipped || row.message };
    const branchDeletion = {
      ...row.branchDeletion,
      locals: row.branchDeletion.locals.map((local) => {
        const updated = next.branchDeletion?.locals.find((item) => item.name === local.name);
        if (updated) return updated;
        const failure = next.branchDeletion?.remote;
        if (
          local.status === 'notMerged' &&
          failure &&
          ['failed', 'unknown', 'stale'].includes(failure.status)
        ) {
          return { ...local, status: failure.status, message: failure.message };
        }
        return local;
      }),
    };
    const ok =
      ['deleted', 'alreadyAbsent'].includes(branchDeletion.remote.status) &&
      branchDeletion.locals.every((step) => ['deleted', 'alreadyAbsent'].includes(step.status));
    return { ...row, ok, branchDeletion };
  });
  const skipped = results.filter((row) => row.skipped).length;
  const failed = results.filter((row) => !row.ok).length;
  return { ...initial, results, skipped, failed, succeeded: results.length - skipped - failed };
}

/** 전체 대상을 한 번 확인하고 미병합 로컬만 최대 한 번 더 확인한다. */
export async function runRemoteBranchDeleteFlow(
  remote: string,
  name: string,
  flow: BranchDeleteFlow,
): Promise<BatchResult | null> {
  const t = S.branches.deletion;
  const targets = await flow.inspect();
  const eligible = targets.filter((target) => !target.excluded && !target.error);
  if (!eligible.length)
    throw new Error(
      [
        t.none,
        ...targets.flatMap((target) =>
          target.error ? [`${repoNameOf(target.path)}: ${target.error}`] : [],
        ),
      ].join('\n'),
    );
  const localCount = eligible.reduce(
    (sum, target) => sum + target.locals.filter((local) => !local.checkedOut).length,
    0,
  );
  const items = targets.flatMap((target) => {
    const repo = repoNameOf(target.path);
    const reason = target.excluded ? t.excluded : target.error;
    return [
      `${t.remoteTarget(repo, `${target.remote}/${target.name}`)}${reason ? ` — ${reason}` : ''}`,
      ...target.locals.map(
        (local) =>
          `${t.localTarget(repo, local.name)}${local.checkedOut ? ` — ${t.checkedOut(local.checkedOut)}` : ''}`,
      ),
    ];
  });
  const values = await flow.dialogs.prompt({
    title: t.title(`${remote}/${name}`),
    message: t.scope(targets.length),
    items,
    expandableItems: true,
    fields: [
      {
        key: 'deleteLocal',
        type: 'checkbox',
        label: t.together,
        initial: false,
        disabled: localCount === 0,
        note: localCount ? t.localCandidates(localCount) : t.noLocals,
      },
    ],
    danger: true,
    confirmLabel: S.dialog.delete,
  });
  if (!values) return null;
  const result = await flow.execute(targets, values.deleteLocal === true);
  if (!result) return null;
  if (values.deleteLocal !== true) return result;
  const pending = forceDeletionTargets(targets, result);
  if (!pending.length) return result;
  const force = await flow.dialogs.confirm({
    title: t.forceTitle,
    message: t.forceMessage,
    items: pending.flatMap((target) =>
      target.locals.map((local) => t.localTarget(repoNameOf(target.path), local.name)),
    ),
    expandableItems: true,
    danger: true,
    confirmLabel: t.forceConfirm,
  });
  if (!force) return result;
  const retried = await flow.force(pending);
  return retried ? mergeDeletionRetry(result, retried) : result;
}
