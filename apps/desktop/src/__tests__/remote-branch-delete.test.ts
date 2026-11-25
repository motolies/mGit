import type { BatchResult, BranchDeleteTarget, BranchDeletionResult } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  forceDeletionTargets,
  mergeDeletionRetry,
  runRemoteBranchDeleteFlow,
  singleDeletionResult,
} from '../features/branches/remote-branch-delete';

/** 다른 이름의 추적 로컬을 포함한 확인 스냅샷이다. */
function target(path = '/folder/repo'): BranchDeleteTarget {
  return {
    path,
    remote: 'origin',
    name: 'topic',
    remoteOid: 'a'.repeat(40),
    remoteUrl: '/remote.git',
    excluded: false,
    error: null,
    locals: [
      {
        name: 'local-topic',
        oid: 'b'.repeat(40),
        upstream: 'refs/remotes/origin/topic',
        checkedOut: null,
      },
      {
        name: 'active-topic',
        oid: 'c'.repeat(40),
        upstream: 'refs/remotes/origin/topic',
        checkedOut: '/other-worktree',
      },
    ],
  };
}

/** 단계 상태를 지정해 실제 IPC와 같은 결과를 만든다. */
function resultOf(
  t: BranchDeleteTarget,
  status: BranchDeletionResult['locals'][number]['status'] = 'deleted',
): BatchResult {
  return singleDeletionResult(t, {
    remote: { status: 'deleted', message: '' },
    locals: t.locals.map((local) => ({
      name: local.name,
      oid: local.oid,
      status: local.checkedOut ? 'checkedOut' : status,
      message: '',
    })),
  });
}

/** 확인 응답과 실행 횟수를 관측하는 흐름 의존성이다. */
function setup() {
  const t = target();
  const prompt = vi.fn(async () => ({ deleteLocal: false }));
  const confirm = vi.fn(async () => false);
  const inspect = vi.fn(async () => [t]);
  const execute = vi.fn(async () => resultOf(t));
  const force = vi.fn(async () => resultOf(t));
  return {
    t,
    prompt,
    confirm,
    inspect,
    execute,
    force,
    flow: { dialogs: { prompt, confirm }, inspect, execute, force },
  };
}

describe('원격 브랜치 삭제 확인 흐름', () => {
  it('전체 대상과 제외 사유를 보여주고 로컬 동시 삭제는 기본 미선택이다', async () => {
    const f = setup();
    const excluded = { ...target('/folder/excluded'), excluded: true };
    f.inspect.mockResolvedValue([f.t, excluded]);
    await runRemoteBranchDeleteFlow('origin', 'topic', f.flow);
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        expandableItems: true,
        fields: [expect.objectContaining({ key: 'deleteLocal', initial: false })],
        items: expect.arrayContaining([
          expect.stringContaining(S.branches.deletion.excluded),
          expect.stringContaining('local-topic'),
          expect.stringContaining('/other-worktree'),
        ]),
      }),
    );
    expect(f.execute).toHaveBeenCalledWith([f.t, excluded], false);
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('최초 확인을 취소하면 원격과 로컬 모두 실행하지 않는다', async () => {
    const f = setup();
    f.prompt.mockResolvedValue(null as never);
    expect(await runRemoteBranchDeleteFlow('origin', 'topic', f.flow)).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.force).not.toHaveBeenCalled();
  });

  it('원격 실패 저장소와 checkout 로컬을 강제 재시도에 포함하지 않는다', () => {
    const t = target();
    const other = target('/folder/other');
    const a = resultOf(t, 'notMerged');
    const b = resultOf(other, 'notMerged');
    const failed = b.results[0];
    if (failed?.branchDeletion) failed.branchDeletion.remote.status = 'failed';
    expect(
      forceDeletionTargets([t, other], { ...a, results: [...a.results, ...b.results] }),
    ).toEqual([{ ...t, locals: [t.locals[0]] }]);
  });

  it('미병합 로컬만 한 번 더 확인하고 승인 시 로컬 단계만 재시도한다', async () => {
    const f = setup();
    f.prompt.mockResolvedValue({ deleteLocal: true });
    f.confirm.mockResolvedValue(true);
    f.execute.mockResolvedValue(resultOf(f.t, 'notMerged'));
    const retried = {
      remote: { status: 'notRun' as const, message: '' },
      locals: [
        {
          name: 'local-topic',
          oid: f.t.locals[0]?.oid ?? '',
          status: 'deleted' as const,
          message: '',
        },
      ],
    };
    f.force.mockResolvedValue(singleDeletionResult(f.t, retried));
    const result = await runRemoteBranchDeleteFlow('origin', 'topic', f.flow);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.force).toHaveBeenCalledWith([{ ...f.t, locals: [f.t.locals[0]] }]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(result?.results[0]?.branchDeletion?.remote.status).toBe('deleted');
    expect(result?.results[0]?.branchDeletion?.locals[0]?.status).toBe('deleted');
  });

  it('강제 확인 취소는 원격 성공과 로컬 보존을 그대로 보고한다', async () => {
    const f = setup();
    f.prompt.mockResolvedValue({ deleteLocal: true });
    const initial = resultOf(f.t, 'notMerged');
    f.execute.mockResolvedValue(initial);
    expect(await runRemoteBranchDeleteFlow('origin', 'topic', f.flow)).toBe(initial);
    expect(f.force).not.toHaveBeenCalled();
  });

  it('요청한 로컬 단계가 실행되지 않았다면 전체 성공으로 표시하지 않는다', () => {
    const result = singleDeletionResult(target(), {
      remote: { status: 'deleted', message: '' },
      locals: [
        { name: 'local-topic', oid: 'b'.repeat(40), status: 'notRun', message: 'cancelled' },
      ],
    });
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it('강제 요청의 전체 검증 실패도 최초 원격 성공을 잃지 않고 로컬 오류로 남긴다', () => {
    const t = target();
    const initial = resultOf(t, 'notMerged');
    const retry = singleDeletionResult(t, {
      remote: { status: 'stale', message: 'push URL changed' },
      locals: [],
    });
    const result = mergeDeletionRetry(initial, retry);
    expect(result.results[0]?.branchDeletion?.remote.status).toBe('deleted');
    expect(result.results[0]?.branchDeletion?.locals[0]).toMatchObject({
      status: 'stale',
      message: 'push URL changed',
    });
    expect(result.failed).toBe(1);
  });
});
