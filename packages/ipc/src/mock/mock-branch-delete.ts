import type { BranchDeleteTarget, BranchDeletionResult, FolderBranches, RefLabel } from '../types';

/** 실제 조회와 같은 추적 관계로 목 삭제 확인 대상을 만든다. */
export function mockBranchDeleteTarget(
  path: string,
  remote: string,
  name: string,
  labels: readonly RefLabel[],
): BranchDeleteTarget {
  const full = `refs/remotes/${remote}/${name}`;
  return {
    path,
    remote,
    name,
    remoteOid: labels.find((label) => label.fullName === full)?.target ?? null,
    remoteUrl: `https://example.invalid/${path.split('/').pop()}.git`,
    error: null,
    excluded: false,
    locals: labels
      .filter((label) => label.fullName.startsWith('refs/heads/') && label.upstream === full)
      .map((label) => ({
        name: label.shortName,
        oid: label.target,
        upstream: full,
        checkedOut: label.isCurrent ? path : null,
      })),
  };
}

/** 폴더 목은 소속 저장소와 추적 로컬 이름을 실제 브랜치 목록에서 읽는다. */
export function mockFolderDeleteTargets(
  branches: FolderBranches,
  remote: string,
  name: string,
  excluded: readonly string[],
): BranchDeleteTarget[] {
  const remoteBranch = branches.branches.find(
    (branch) => branch.remote && branch.name === `${remote}/${name}`,
  );
  return (remoteBranch?.repos ?? []).map((repo) => ({
    path: repo.path,
    remote,
    name,
    remoteOid: 'a'.repeat(40),
    remoteUrl: `https://example.invalid/${repo.path.split('/').pop()}.git`,
    error: null,
    excluded: excluded.includes(repo.path.split('/').pop() ?? ''),
    locals: branches.branches.flatMap((branch) => {
      const own = branch.repos.find(
        (item) => item.path === repo.path && item.upstream === `${remote}/${name}`,
      );
      return !branch.remote && own
        ? [
            {
              name: branch.name,
              oid: 'a'.repeat(40),
              upstream: `refs/remotes/${remote}/${name}`,
              checkedOut: own.current ? repo.path : null,
            },
          ]
        : [];
    }),
  }));
}

/** 원격과 로컬 결과를 나누며 현재 checkout된 로컬은 목에서도 삭제하지 않는다. */
export function mockDeleteBranches(
  target: BranchDeleteTarget,
  deleteLocal: boolean,
  force: boolean,
): BranchDeletionResult {
  return {
    remote: {
      status: force
        ? 'notRun'
        : target.error
          ? 'failed'
          : target.remoteOid
            ? 'deleted'
            : 'alreadyAbsent',
      message: target.error ?? '',
    },
    locals:
      deleteLocal || force
        ? target.locals.map((local) => ({
            name: local.name,
            oid: local.oid,
            status: target.error ? 'notRun' : local.checkedOut ? 'checkedOut' : 'deleted',
            message: local.checkedOut ?? target.error ?? '',
          }))
        : [],
  };
}

/** 성공한 원격·로컬만 폴더 목록에서 제거해 새로고침 결과에 반영한다. */
export function applyMockBranchDeletion(
  branches: FolderBranches,
  target: BranchDeleteTarget,
  result: BranchDeletionResult,
): void {
  const removed = new Set(
    result.locals.filter((local) => local.status === 'deleted').map((local) => local.name),
  );
  branches.branches = branches.branches.flatMap((branch) => {
    const deleted = branch.remote
      ? branch.name === `${target.remote}/${target.name}` &&
        ['deleted', 'alreadyAbsent'].includes(result.remote.status)
      : removed.has(branch.name);
    const repos = deleted ? branch.repos.filter((repo) => repo.path !== target.path) : branch.repos;
    return repos.length ? [{ ...branch, repos }] : [];
  });
}
