import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
  type StatusEntry,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { groupByModule, moduleOf } from '../features/modules/module-groups';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const MODS = [
  { name: 'core', path: 'libs/core', kind: 'gradle' as const },
  { name: 'app', path: 'app', kind: 'gradle' as const },
];

/** 모듈·범위 호출을 기록하는 클라이언트 */
function client(scope: string | null) {
  let hidden: string[] = [];
  const c: IpcClient = {
    ...createNullClient(),
    modules: vi.fn(async () => MODS.filter((m) => !hidden.includes(m.path))),
    moduleScope: vi.fn(async () => scope),
    moduleScopeSet: vi.fn(async () => {}),
    moduleOverrides: vi.fn(async () => ({ added: [], hidden })),
    moduleOverridesSet: vi.fn(async (_s, o: { hidden: string[] }) => {
      hidden = o.hidden;
    }),
    setGraphQuery: vi.fn(async () => {}),
  };
  return c;
}

/** 스토어 */
function setup(scope: string | null) {
  const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
  const opened: RepoOpened = {
    session: 1,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '/r',
      gitDir: '/r/.git',
      commonDir: '/r/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState(head),
  };
  const c = client(scope);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, c, cache), client: c };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SessionStore (C3 빌드 멀티 모듈)', () => {
  it('기억한 범위를 열 때 적용하고, 선택을 바꾸면 그래프 범위와 설정을 갱신한다', async () => {
    const { store, client: c } = setup('libs/core');
    await tick();
    await tick();
    expect(store.getState().modules.map((m) => m.path)).toEqual(['libs/core', 'app']);
    expect(store.getState().moduleScope).toBe('libs/core');
    expect(store.getState().graphQuery.pathScope).toEqual(['libs/core']);
    await store.getState().selectModule('app');
    expect(c.moduleScopeSet).toHaveBeenLastCalledWith(1, 'app');
    expect(store.getState().graphQuery.pathScope).toEqual(['app']);
    await store.getState().selectModule(null);
    expect(c.moduleScopeSet).toHaveBeenLastCalledWith(1, null);
    expect(store.getState().graphQuery.pathScope).toEqual([]);
  });

  it('숨기기는 보정에 기록되고 범위가 그 모듈이면 해제한다', async () => {
    const { store, client: c } = setup(null);
    await tick();
    await store.getState().selectModule('app');
    await store.getState().hideModule('app');
    expect(c.moduleOverridesSet).toHaveBeenCalledWith(1, { added: [], hidden: ['app'] });
    expect(store.getState().modules.map((m) => m.path)).toEqual(['libs/core']);
    expect(store.getState().moduleScope).toBeNull();
    await store.getState().addManualModule('tools', 'tools');
    expect(c.moduleOverridesSet).toHaveBeenLastCalledWith(1, {
      added: [{ name: 'tools', path: 'tools', kind: 'manual' }],
      hidden: ['app'],
    });
  });

  it('변경 파일을 모듈별로 묶는다 (가장 긴 접두, 나머지는 루트)', () => {
    const e = (path: string) =>
      ({ path, index: 'modified', worktree: 'unmodified' }) as StatusEntry;
    const mods = [
      { name: 'libs', path: 'libs', kind: 'manual' as const },
      { name: 'core', path: 'libs/core', kind: 'gradle' as const },
    ];
    expect(moduleOf('libs/core/x.kt', mods)?.path).toBe('libs/core');
    expect(moduleOf('libs/util/y.kt', mods)?.path).toBe('libs');
    expect(moduleOf('README.md', mods)).toBeNull();
    const groups = groupByModule(
      [e('README.md'), e('libs/core/a'), e('libs/b'), e('libs/core/c')],
      mods,
    );
    expect(groups.map((g) => [g.path, g.entries.length])).toEqual([
      ['libs', 1],
      ['libs/core', 2],
      [null, 1],
    ]);
  });
});
