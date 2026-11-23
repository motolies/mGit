import type { FolderBranch, FolderBranchIn, RefLabel } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import {
  type BranchRefLookup,
  branchFocusRevs,
  defaultBranchRefs,
  folderDefaultRefs,
  folderFocusScope,
  folderRefLookup,
  labelRefLookup,
} from '../features/branches/branch-focus';

/** 로컬 branch 이름 → 업스트림(없으면 null), 원격 branch 이름 목록으로 찾기 묶음을 만든다 */
function lookup(locals: Record<string, string | null>, remotes: string[]): BranchRefLookup {
  return {
    hasLocal: (name) => name in locals,
    hasRemote: (name) => remotes.includes(name),
    upstreamOf: (name) => locals[name] ?? null,
  };
}

describe('기본 branch 짝 (defaultBranchRefs)', () => {
  // [설명, 로컬(이름 → 업스트림), 원격, 기대값]
  const cases: [string, Record<string, string | null>, string[], string[]][] = [
    [
      'master 와 그 업스트림',
      { master: 'origin/master' },
      ['origin/master'],
      ['master', 'origin/master'],
    ],
    [
      'master 가 있으면 main 보다 먼저',
      { master: 'origin/master', main: 'origin/main' },
      ['origin/master', 'origin/main'],
      ['master', 'origin/master'],
    ],
    ['master 가 없으면 main', { main: 'origin/main' }, ['origin/main'], ['main', 'origin/main']],
    ['업스트림이 없으면 origin/<기본>', { main: null }, ['origin/main'], ['main', 'origin/main']],
    [
      '업스트림이 다른 원격이면 그것',
      { master: 'upstream/master' },
      ['upstream/master', 'origin/master'],
      ['master', 'upstream/master'],
    ],
    [
      '업스트림이 사라졌으면(원격 목록에 없음) origin/<기본>',
      { master: 'fork/master' },
      ['origin/master'],
      ['master', 'origin/master'],
    ],
    ['원격 짝이 없으면 로컬만', { master: null }, [], ['master']],
    ['로컬 기본이 없으면 origin/master', {}, ['origin/master', 'origin/main'], ['origin/master']],
    ['로컬 기본이 없으면 origin/main', { develop: null }, ['origin/main'], ['origin/main']],
    ['둘 다 없으면 없음', { develop: 'origin/develop' }, ['origin/develop'], []],
  ];
  it.each(cases)('%s', (_why, locals, remotes, expected) => {
    expect(defaultBranchRefs(lookup(locals, remotes))).toEqual(expected);
  });
});

describe('더블클릭 범위 (branchFocusRevs)', () => {
  it('그 branch 와 기본 짝, 중복은 빼고 하나면 solo', () => {
    expect(branchFocusRevs('feature/x', ['master', 'origin/master'])).toEqual({
      kind: 'branches',
      names: ['feature/x', 'master', 'origin/master'],
    });
    // 기본 branch 자신
    expect(branchFocusRevs('master', ['master', 'origin/master'])).toEqual({
      kind: 'branches',
      names: ['master', 'origin/master'],
    });
    // 원격 행 (원격 기본 자신)
    expect(branchFocusRevs('origin/master', ['master', 'origin/master'])).toEqual({
      kind: 'branches',
      names: ['origin/master', 'master'],
    });
    // 기본 branch 가 없는 저장소
    expect(branchFocusRevs('feature/x', [])).toEqual({ kind: 'solo', name: 'feature/x' });
  });
});

describe('저장소 탭 찾기 (labelRefLookup)', () => {
  const label = (shortName: string, kind: RefLabel['kind'], upstream?: string): RefLabel => ({
    fullName: '',
    shortName,
    kind,
    target: '0'.repeat(40),
    isCurrent: false,
    upstream: upstream ?? null,
    upstreamGone: false,
  });
  it('로컬·원격·태그를 나누고, 업스트림 전체 이름은 짧게 바꾼다', () => {
    const refs = labelRefLookup([
      label('master', { kind: 'localBranch' }, 'refs/remotes/origin/master'),
      label('origin/master', { kind: 'remoteBranch', remote: 'origin' }),
      label('main', { kind: 'tag', annotated: false }),
    ]);
    expect(refs.hasLocal('master')).toBe(true);
    expect(refs.hasLocal('origin/master')).toBe(false);
    expect(refs.hasRemote('origin/master')).toBe(true);
    // 같은 이름의 tag 는 branch 가 아니다
    expect(refs.hasLocal('main')).toBe(false);
    expect(refs.upstreamOf('master')).toBe('origin/master');
    expect(refs.upstreamOf('main')).toBeNull();
  });
});

describe('폴더 탭 기본 짝 (folderDefaultRefs)', () => {
  const at = (repo: string, upstream: string | null = null): FolderBranchIn => ({
    path: `/f/${repo}`,
    color: 0,
    current: false,
    upstream,
    ahead: null,
    behind: null,
    gone: false,
  });
  const branch = (name: string, ...repos: FolderBranchIn[]): FolderBranch => {
    const remote = name.includes('/') && name.startsWith('origin/');
    return { name, remote, remoteName: remote ? 'origin' : null, repos };
  };
  // a: master(업스트림 origin/master) · b: main(업스트림 없음, origin/main 있음) · c: 기본 없음. x 는 a·b·c 모두에 있다
  const BRANCHES = [
    branch('x', at('a'), at('b'), at('c')),
    branch('master', at('a', 'origin/master')),
    branch('main', at('b')),
    branch('origin/master', at('a')),
    branch('origin/main', at('b')),
    branch('y', at('c')),
  ];

  it('그 branch 가 있는 저장소마다 기본 짝을 찾아 처음 나온 순서로 합친다', () => {
    const x = BRANCHES[0] as FolderBranch;
    expect(folderDefaultRefs(BRANCHES, x)).toEqual([
      'master',
      'origin/master',
      'main',
      'origin/main',
    ]);
    expect(branchFocusRevs(x.name, folderDefaultRefs(BRANCHES, x))).toEqual({
      kind: 'branches',
      names: ['x', 'master', 'origin/master', 'main', 'origin/main'],
    });
  });

  it('그 branch 가 없는 저장소의 기본 branch 는 넣지 않는다', () => {
    const y = BRANCHES[5] as FolderBranch;
    expect(folderDefaultRefs(BRANCHES, y)).toEqual([]);
    expect(branchFocusRevs(y.name, [])).toEqual({ kind: 'solo', name: 'y' });
  });

  it('저장소 범위는 그 branch 가 있는 저장소(목록 순서), 모든 저장소에 있거나 하나도 못 찾으면 좁히지 않는다', () => {
    const repos = ['a', 'b', 'c'].map((name) => ({ path: `/f/${name}` }));
    const x = BRANCHES[0] as FolderBranch;
    const master = BRANCHES[1] as FolderBranch;
    expect(folderFocusScope(x, repos)).toEqual([]);
    expect(folderFocusScope(master, repos)).toEqual(['/f/a']);
    expect(folderFocusScope(branch('z', at('c'), at('a')), repos)).toEqual(['/f/a', '/f/c']);
    expect(folderFocusScope(branch('gone', at('zz')), repos)).toEqual([]);
  });

  it('저장소 하나의 찾기는 그 저장소에 있는 ref 만 본다', () => {
    const b = folderRefLookup(BRANCHES, '/f/b');
    expect(b.hasLocal('master')).toBe(false);
    expect(b.hasLocal('main')).toBe(true);
    expect(b.hasRemote('origin/main')).toBe(true);
    expect(b.hasRemote('origin/master')).toBe(false);
    expect(folderRefLookup(BRANCHES, '/f/a').upstreamOf('master')).toBe('origin/master');
  });
});
