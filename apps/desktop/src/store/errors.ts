import { toIpcError } from '@mgit/ipc';
import { S } from '@mgit/ui';

/** IpcError 를 한국어 안내 문구로 바꾼다 */
export function describeError(value: unknown): string {
  const err = toIpcError(value);
  switch (err.kind) {
    case 'notARepository':
      return `${S.error.notARepository}: ${err.path}`;
    case 'multiRepoFolder':
      return S.error.multiRepoFolder(err.path, err.repos);
    case 'gitNotFound':
      return S.error.gitNotFound;
    case 'gitTooOld':
      return S.error.gitTooOld(err.found, err.required);
    case 'sessionNotFound':
      return S.error.sessionNotFound;
    case 'gitFailed':
      // 서버 거부(hook 등)는 강제 push 로 풀리지 않는다 — git 원문 대신 서버가 준 사유를 보인다 (TG-02·07)
      if (err.hint?.kind === 'remoteRejected') {
        return S.error.remoteRejected(err.hint.reason);
      }
      return S.error.gitFailed(err.args, err.stderr);
    case 'cancelled':
      return S.error.cancelled;
    case 'conflictMarkers':
      return S.error.conflictMarkers(err.files);
    case 'nestedRepos':
      return S.error.nestedRepos(err.paths);
    case 'localBranchTracksOther':
      return S.error.localBranchTracksOther(err.local);
    case 'pushUpstreamMismatch':
      return S.error.pushUpstreamMismatch(err.local, err.remote, err.upstream);
    case 'graphUnavailable':
      return S.error.graphUnavailable;
    case 'lightSessionLimit':
      return S.error.lightSessionLimit(err.limit);
    // 코어가 한국어 안내와 git 의 거부 사유를 함께 준다
    case 'invalidFilter':
      return err.message || S.error.unknown;
    case 'internal':
      return err.message || S.error.unknown;
    default:
      return S.error.unknown;
  }
}
