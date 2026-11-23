import { describe, expect, it } from 'vitest';
import { remoteBranchName } from '../refs';

/** 라벨 흉내 */
function remote(remoteName: string, name: string, shortName = `${remoteName}/${name}`) {
  return {
    fullName: `refs/remotes/${remoteName}/${name}`,
    shortName,
    kind: { kind: 'remoteBranch' as const, remote: remoteName },
  };
}

describe('remoteBranchName', () => {
  it('원격 접두를 뗀 이름을 돌려준다', () => {
    expect(remoteBranchName(remote('origin', 'main'))).toBe('main');
    expect(remoteBranchName(remote('fork', 'master'))).toBe('master');
    expect(remoteBranchName(remote('origin', 'feature/login'))).toBe('feature/login');
  });

  it('표시용으로 이미 잘린 shortName 이 와도 fullName 기준이라 두 번 잘리지 않는다', () => {
    expect(remoteBranchName(remote('fork', 'master', 'master'))).toBe('master');
    expect(remoteBranchName(remote('origin', 'feature/login', 'feature/login'))).toBe(
      'feature/login',
    );
  });

  it('원격 브랜치가 아니면 shortName 그대로', () => {
    expect(
      remoteBranchName({
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: { kind: 'localBranch' },
      }),
    ).toBe('main');
  });
});
