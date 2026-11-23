// 파일 동작 메뉴 (Finder·터미널·변경 되돌리기·ignore) 순수 함수: 대상 펼치기, 켜짐 조건, 옮긴 ignore 하위 메뉴의 회귀
import type { StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changeItems,
  ignoreMenuItem,
  ignoreTarget,
  openInItems,
  ownEntries,
  revealLabel,
  rollbackGroups,
  rollbackItems,
} from '../features/project/file-actions-menu';

/** status 항목 하나 */
function entry(
  path: string,
  index: StatusEntry['index'],
  worktree: StatusEntry['worktree'],
  extra: Partial<StatusEntry> = {},
): StatusEntry {
  return {
    path,
    origPath: null,
    index,
    worktree,
    submodule: null,
    conflict: null,
    renameScore: null,
    ...extra,
  };
}

const REPO = '/w/api';
const ENTRIES: StatusEntry[] = [
  entry('.DS_Store', 'added', 'unmodified'),
  entry('src/a.ts', 'modified', 'modified'),
  entry('src/new/b.ts', 'unmodified', 'untracked'),
  entry('srcx/c.ts', 'unmodified', 'modified'),
  entry('moved.ts', 'renamed', 'unmodified', { origPath: 'old.ts' }),
  entry('gone.ts', 'deleted', 'unmodified'),
  entry('c.txt', 'unmerged', 'unmerged', { conflict: 'bothModified' }),
  entry('nested/', 'unmodified', 'untracked'),
];
const of = () => ENTRIES;

describe('rollbackGroups — 되돌릴 항목 펼치기', () => {
  it('파일은 그 항목, 폴더는 그 아래 항목(이름이 겹치는 옆 폴더 제외), 저장소 디렉터리("")는 전부', () => {
    expect(rollbackGroups([{ repoPath: REPO, path: '.DS_Store' }], of)).toEqual([
      { repoPath: REPO, paths: ['.DS_Store'] },
    ]);
    expect(rollbackGroups([{ repoPath: REPO, path: 'src' }], of)).toEqual([
      { repoPath: REPO, paths: ['src/a.ts', 'src/new/b.ts'] },
    ]);
    expect(rollbackGroups([{ repoPath: REPO, path: '' }], of)[0]?.paths).toEqual([
      '.DS_Store',
      'src/a.ts',
      'src/new/b.ts',
      'srcx/c.ts',
      'moved.ts',
      'gone.ts',
    ]);
  });

  it('충돌 항목과 통째로 untracked 인 디렉터리(중첩 저장소)는 빠지고, 남는 것이 없으면 빈 배열', () => {
    expect(rollbackGroups([{ repoPath: REPO, path: 'c.txt' }], of)).toEqual([]);
    expect(rollbackGroups([{ repoPath: REPO, path: 'nested' }], of)).toEqual([]);
    expect(rollbackGroups([{ repoPath: REPO, path: 'README.md' }], of)).toEqual([]);
  });

  it('이름이 바뀐 항목은 원래 경로로 골라도 되고, 여러 저장소는 저장소별로 묶는다', () => {
    expect(rollbackGroups([{ repoPath: REPO, path: 'old.ts' }], of)).toEqual([
      { repoPath: REPO, paths: ['moved.ts'] },
    ]);
    const web = '/w/web';
    const groups = rollbackGroups(
      [
        { repoPath: REPO, path: '.DS_Store' },
        { repoPath: web, path: 'x' },
        { repoPath: REPO, path: 'gone.ts' },
      ],
      (repo) => (repo === web ? [entry('x/y', 'unmodified', 'untracked')] : ENTRIES),
    );
    expect(groups).toEqual([
      { repoPath: REPO, paths: ['.DS_Store', 'gone.ts'] },
      { repoPath: web, paths: ['x/y'] },
    ]);
    expect(rollbackItems(groups, (p) => p.split('/').at(-1) ?? p)).toEqual([
      'api/.DS_Store',
      'api/gone.ts',
      'web/x/y',
    ]);
    expect(rollbackItems(groups.slice(0, 1), () => 'api')).toEqual(['.DS_Store', 'gone.ts']);
  });
});

describe('ignoreTarget — ignore 켜짐 조건', () => {
  it('untracked 파일, untracked 항목을 품은 폴더만. 추적 파일·깨끗한 폴더·저장소 디렉터리는 아니다', () => {
    expect(ignoreTarget({ repoPath: REPO, path: 'src/new/b.ts' }, false, ENTRIES)).toEqual({
      repoPath: REPO,
      path: 'src/new/b.ts',
      dir: false,
    });
    expect(ignoreTarget({ repoPath: REPO, path: 'src' }, true, ENTRIES)?.dir).toBe(true);
    expect(ignoreTarget({ repoPath: REPO, path: 'nested' }, true, ENTRIES)?.dir).toBe(true);
    expect(ignoreTarget({ repoPath: REPO, path: '.DS_Store' }, false, ENTRIES)).toBeNull();
    expect(ignoreTarget({ repoPath: REPO, path: 'srcx' }, true, ENTRIES)).toBeNull();
    expect(ignoreTarget({ repoPath: REPO, path: '' }, true, ENTRIES)).toBeNull();
  });
});

describe('ignoreMenuItem — 옛 ChangesPanel 의 ignoreMenu 를 옮긴 것', () => {
  it('파일: 이 파일 / 확장자 / 상위 폴더 패턴. 확장자·상위 폴더가 없으면 그 항목이 없다', () => {
    const add = vi.fn();
    const item = ignoreMenuItem('logs/app.log', add);
    expect(item.label).toBe(S.safety.ignore);
    expect(item.separator).toBe(true);
    expect(item.children?.map((c) => c.label)).toEqual([
      S.safety.ignoreFile('logs/app.log'),
      S.safety.ignoreExt('log'),
      S.safety.ignoreDir('logs'),
    ]);
    for (const child of item.children ?? []) {
      child.onSelect?.();
    }
    expect(add.mock.calls).toEqual([[['logs/app.log']], [['*.log']], [['logs/']]]);
    expect(ignoreMenuItem('.DS_Store', add).children?.map((c) => c.label)).toEqual([
      S.safety.ignoreFile('.DS_Store'),
    ]);
  });

  it('폴더: 그 폴더 패턴 하나', () => {
    const add = vi.fn();
    const item = ignoreMenuItem('build', add, true);
    expect(item.children?.map((c) => c.label)).toEqual([S.safety.ignoreDir('build')]);
    item.children?.[0]?.onSelect?.();
    expect(add).toHaveBeenCalledWith(['build/']);
  });
});

describe('changeItems·openInItems — 메뉴 항목', () => {
  it('되돌리기는 파일 수를 붙이고, ignore 는 하위 메뉴, 한 묶음이라 안쪽 구분선이 없다', () => {
    const act = { rollback: vi.fn(), ignore: vi.fn() };
    const rollback = [{ repoPath: REPO, paths: ['a', 'b'] }];
    const items = changeItems({ rollback, ignore: { repoPath: REPO, path: 'a', dir: false } }, act);
    expect(items.map((i) => [i.label, i.separator])).toEqual([
      [S.project.menu.many(S.project.menu.rollback, 2), false],
      [S.safety.ignore, false],
    ]);
    items[0]?.onSelect?.();
    expect(act.rollback).toHaveBeenCalledWith(rollback);
    items[1]?.children?.[0]?.onSelect?.();
    expect(act.ignore).toHaveBeenCalledWith(REPO, ['a']);
    expect(changeItems({ rollback: [], ignore: null }, act)).toEqual([]);
    expect(
      changeItems({ rollback: [{ repoPath: REPO, paths: ['a'] }], ignore: null }, act)[0]?.label,
    ).toBe(S.project.menu.rollback);
  });

  it('열기 묶음은 Finder(파일 탐색기)·터미널, 절대 경로를 넘긴다', () => {
    const act = { reveal: vi.fn(), terminal: vi.fn() };
    const items = openInItems('/w/api/a.ts', act);
    expect(items.map((i) => i.label)).toEqual([revealLabel(), S.actions.openTerminal]);
    items[0]?.onSelect?.();
    items[1]?.onSelect?.();
    expect(act.reveal).toHaveBeenCalledWith('/w/api/a.ts');
    expect(act.terminal).toHaveBeenCalledWith('/w/api/a.ts');
  });
});

describe('revealLabel — OS 별 문구', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('macOS 는 "Finder 에서 보기", 그 밖은 "파일 탐색기에서 보기"', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(revealLabel()).toBe(S.actions.revealFinder);
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(revealLabel()).toBe(S.actions.reveal);
  });
});

describe('ownEntries — 안쪽 저장소의 항목 빼기', () => {
  it('더 깊은 저장소 경로(그 디렉터리 자신 포함)에 걸리는 항목을 뺀다. 이름이 겹치는 옆 경로는 남긴다', () => {
    const entries = [
      entry('libs/core/x.ts', 'unmodified', 'modified'),
      entry('libs/core', 'modified', 'unmodified'),
      entry('libs/core2/y.ts', 'unmodified', 'untracked'),
      entry('nested/', 'unmodified', 'untracked'),
    ];
    const kept = ownEntries(
      '/w/api',
      ['/w/api', '/w/api/libs/core', '/w/api/nested', '/w/web'],
      entries,
    );
    expect(kept.map((e) => e.path)).toEqual(['libs/core2/y.ts']);
    expect(ownEntries('/w/api', ['/w/api'], entries)).toEqual(entries);
  });
});
