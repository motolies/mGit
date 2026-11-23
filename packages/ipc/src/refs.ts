import type { RefLabel } from './bindings';

/**
 * 원격 브랜치 라벨에서 원격 접두를 뗀 브랜치 이름 (`origin/feature/x` → `feature/x`).
 * `fullName` 의 `refs/remotes/<remote>/` 뒤를 쓰므로 표시용으로 바꾼 `shortName` 에 영향받지 않는다.
 * 원격 브랜치가 아니면 `shortName` 그대로
 */
export function remoteBranchName(label: Pick<RefLabel, 'fullName' | 'shortName' | 'kind'>): string {
  if (label.kind.kind !== 'remoteBranch') {
    return label.shortName;
  }
  const prefix = `refs/remotes/${label.kind.remote}/`;
  return label.fullName.startsWith(prefix)
    ? label.fullName.slice(prefix.length)
    : label.shortName.slice(label.kind.remote.length + 1);
}
