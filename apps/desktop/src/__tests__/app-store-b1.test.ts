import { createNullClient, type HostingAccount, type IpcClient, type Profile } from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';

const ACC: HostingAccount = {
  id: 'github:github.com:kim',
  kind: 'github',
  host: 'github.com',
  user: 'kim',
  name: 'Kim',
  avatarUrl: null,
  webUrl: 'https://github.com/kim',
};

/** 계정·프로필 호출을 기록하는 클라이언트 */
function client(fail = false) {
  let accounts: HostingAccount[] = [];
  let profiles: Profile[] = [];
  const c: IpcClient = {
    ...createNullClient(),
    hostingAccounts: vi.fn(async () => accounts),
    hostingAddPat: vi.fn(async (_k, _h, token: string) => {
      if (fail || token !== 'ok') {
        throw new Error('인증 실패');
      }
      accounts = [ACC];
      return ACC;
    }),
    hostingRemove: vi.fn(async () => {
      accounts = [];
    }),
    profiles: vi.fn(async () => profiles),
    profilesSet: vi.fn(async (list: Profile[]) => {
      profiles = list.map((p, i) => ({ ...p, id: p.id || `p${i}` }));
      return profiles;
    }),
    hostingRepos: vi.fn(async () => ({
      repos: [
        {
          fullName: 'kim/a',
          name: 'a',
          description: null,
          private: false,
          fork: false,
          cloneUrl: 'https://github.com/kim/a.git',
          sshUrl: 'git@github.com:kim/a.git',
          webUrl: 'https://github.com/kim/a',
          defaultBranch: 'main',
          updatedAt: null,
          stars: 0,
        },
      ],
      nextPage: null,
    })),
  };
  return c;
}

describe('AppStore (B1 호스팅 계정·프로필)', () => {
  it('PAT 로 계정을 추가하면 목록이 갱신되고, 실패는 lastError 에 남는다', async () => {
    const c = client();
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    store.getState().setAppDialog('accounts');
    expect(store.getState().appDialog).toBe('accounts');
    await store.getState().loadHostingAccounts();
    expect(store.getState().hostingAccounts).toEqual([]);
    expect(await store.getState().hostingAddPat('github', 'github.com', 'bad')).toBeNull();
    expect(store.getState().lastError).toContain('인증 실패');
    const a = await store.getState().hostingAddPat('github', 'github.com', 'ok');
    expect(a?.id).toBe(ACC.id);
    expect(store.getState().hostingAccounts).toHaveLength(1);
    expect(store.getState().lastError).toBeNull();
    const page = await store.getState().hostingRepos(ACC.id, 1, '');
    expect(page?.repos[0]?.fullName).toBe('kim/a');
    await store.getState().hostingRemove(ACC.id);
    expect(store.getState().hostingAccounts).toEqual([]);
    store.getState().setAppDialog(null);
    expect(store.getState().appDialog).toBeNull();
  });

  it('프로필을 저장하면 id 가 채워진 목록으로 바뀐다', async () => {
    const c = client();
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().saveProfiles([
      {
        id: '',
        name: '회사',
        userName: 'Kim',
        userEmail: 'k@corp',
        signingKey: null,
        hostingAccount: null,
      },
    ]);
    expect(c.profilesSet).toHaveBeenCalledTimes(1);
    expect(store.getState().profiles[0]?.id).toBe('p0');
    await store.getState().loadProfiles();
    expect(store.getState().profiles).toHaveLength(1);
  });
});
