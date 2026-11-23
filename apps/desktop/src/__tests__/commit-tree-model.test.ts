import type { FileState, RepoChanges, RepoSummary, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import {
  buildCommitRepos,
  type CommitRow,
  combineChecks,
  commitTreeRows,
  entryCheck,
  expandableRowIds,
  fileMark,
  fileTarget,
  opensStaged,
  repoRowId,
  rowToggle,
} from '../features/commit/commit-tree-model';

/** 상태 항목 */
function st(
  path: string,
  index: FileState,
  worktree: FileState,
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

const ROOT = '/f';
const WEB = `${ROOT}/web`;
const CAT = `${ROOT}/catalog`;

/** 저장소 하나의 변경 줄 */
function changes(path: string, entries: StatusEntry[]): RepoChanges {
  return {
    path,
    name: path.split('/').pop() ?? path,
    branch: 'main',
    entries,
    summary: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: entries.filter((e) => e.conflict).length,
      ahead: 0,
      behind: 0,
      stashCount: 0,
      upstream: null,
    },
  };
}

/** 요약 한 줄 */
function summary(path: string, extra: Partial<RepoSummary> = {}): RepoSummary {
  return {
    path,
    name: path.split('/').pop() ?? path,
    kind: 'standalone',
    color: 3,
    branch: 'main',
    detached: false,
    changed: 1,
    conflicted: 0,
    ahead: 0,
    behind: 0,
    op: null,
    lastFetch: null,
    error: null,
    ...extra,
  };
}

// web-console 장면과 같은 모양: 체크·중간·빔·이름 변경·삭제·untracked 가 섞여 있다
const WEB_ENTRIES = [
  st('src/orders/OrderTable.tsx', 'modified', 'unmodified'),
  st('src/orders/OrderExport.tsx', 'renamed', 'unmodified', {
    origPath: 'src/orders/Export.tsx',
    renameScore: 88,
  }),
  st('src/orders/filters/DateRangeFilter.tsx', 'added', 'unmodified'),
  st('src/orders/filters/StatusFilter.tsx', 'modified', 'modified'),
  st('src/shared/api/orders.ts', 'unmodified', 'modified'),
  st('packages/ui-kit/src/Table/Table.stories.tsx', 'unmodified', 'deleted'),
  st('src/orders/filters/__tests__/DateRangeFilter.test.tsx', 'untracked', 'untracked'),
];

// catalog-service 장면: rebase 중 충돌 하나 + stage 된 두 파일
const CAT_ENTRIES = [
  st('src/search/facets/FacetBuilder.kt', 'unmerged', 'unmerged', { conflict: 'bothModified' }),
  st('src/search/facets/FacetQuery.kt', 'modified', 'unmodified'),
  st('src/search/index/IndexMapping.kt', 'modified', 'unmodified'),
];

/** 두 저장소의 줄 (모두 펼침) */
function rowsOf(collapsed: string[] = []): CommitRow[] {
  const repos = buildCommitRepos(
    [changes(CAT, CAT_ENTRIES), changes(WEB, WEB_ENTRIES)],
    [summary(CAT, { op: 'rebase', color: 1 }), summary(WEB)],
  );
  return commitTreeRows(repos, new Set(collapsed));
}

/** 이름(과 종류)으로 줄 */
function rowNamed(rows: readonly CommitRow[], name: string, kind?: CommitRow['kind']): CommitRow {
  const found = rows.find((r) => r.name === name && (kind === undefined || r.kind === kind));
  if (!found) {
    throw new Error(`줄 없음: ${name}`);
  }
  return found;
}

describe('세 상태 판정 (W14: 체크 = stage)', () => {
  it('파일: index 쪽만 = 체크, 작업 트리 쪽만(untracked·삭제 포함) = 빔, 양쪽(MM·AM) = 중간, 충돌 = 체크 불가', () => {
    expect(entryCheck(st('a', 'modified', 'unmodified'))).toBe('checked');
    expect(entryCheck(st('a', 'added', 'unmodified'))).toBe('checked');
    expect(entryCheck(st('a', 'deleted', 'unmodified'))).toBe('checked');
    expect(entryCheck(st('a', 'renamed', 'unmodified', { origPath: 'b' }))).toBe('checked');
    expect(entryCheck(st('a', 'unmodified', 'modified'))).toBe('unchecked');
    expect(entryCheck(st('a', 'unmodified', 'deleted'))).toBe('unchecked');
    expect(entryCheck(st('a', 'untracked', 'untracked'))).toBe('unchecked');
    expect(entryCheck(st('a', 'modified', 'modified'))).toBe('mixed');
    expect(entryCheck(st('a', 'added', 'modified'))).toBe('mixed');
    expect(entryCheck(st('a', 'renamed', 'modified', { origPath: 'b' }))).toBe('mixed');
    expect(entryCheck(st('a', 'unmerged', 'unmerged', { conflict: 'bothModified' }))).toBe(
      'conflict',
    );
  });

  it('모으기: 전부 체크 = 체크, 전부 빔 = 빔, 섞이면 중간, 셀 것이 없으면 null', () => {
    expect(combineChecks(['checked', 'checked'])).toBe('checked');
    expect(combineChecks(['unchecked', 'unchecked'])).toBe('unchecked');
    expect(combineChecks(['checked', 'unchecked'])).toBe('mixed');
    expect(combineChecks(['mixed'])).toBe('mixed');
    expect(combineChecks([])).toBeNull();
  });

  it('폴더·저장소는 아래 파일을 모은다. 충돌 파일은 빼고 센다 (충돌뿐이면 체크할 수 없다)', () => {
    const rows = rowsOf();
    // web: 체크·중간·빔이 섞여 있다
    expect(rowNamed(rows, 'web', 'repo').check).toBe('mixed');
    expect(rowNamed(rows, 'filters', 'dir').check).toBe('mixed');
    expect(rowNamed(rows, 'shared/api', 'dir').check).toBe('unchecked');
    expect(rowNamed(rows, 'packages/ui-kit/src/Table', 'dir').check).toBe('unchecked');
    // catalog: 충돌을 빼면 stage 된 두 파일뿐이라 체크
    expect(rowNamed(rows, 'src/search', 'dir').check).toBe('checked');
    expect(rowNamed(rows, 'facets', 'dir').check).toBe('checked');
    expect(rowNamed(rows, 'catalog', 'repo').check).toBe('checked');
    expect(rowNamed(rows, 'FacetBuilder.kt').check).toBe('conflict');
    // 충돌 파일만 든 폴더는 체크할 수 없다
    const only = commitTreeRows(
      buildCommitRepos([changes(CAT, [CAT_ENTRIES[0] as StatusEntry])], [summary(CAT)]),
      new Set(),
    );
    expect(only.map((r) => [r.name, r.check])).toEqual([
      ['catalog', null],
      ['src/search/facets', null],
      ['FacetBuilder.kt', 'conflict'],
    ]);
  });
});

describe('트리 모양 (W8 공용 경로 트리 + W12 상태 문자)', () => {
  it('저장소 › 폴더(단일 자식 사슬 압축) › 파일, 디렉터리 먼저·이름순. 저장소 줄에 색·진행 중 작업·파일 수', () => {
    const rows = rowsOf();
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual([
      'catalog',
      '  src/search',
      '    facets',
      '      FacetBuilder.kt',
      '      FacetQuery.kt',
      '    index',
      '      IndexMapping.kt',
      'web',
      '  packages/ui-kit/src/Table',
      '    Table.stories.tsx',
      '  src',
      '    orders',
      '      filters',
      '        __tests__',
      '          DateRangeFilter.test.tsx',
      '        DateRangeFilter.tsx',
      '        StatusFilter.tsx',
      '      OrderExport.tsx',
      '      OrderTable.tsx',
      '    shared/api',
      '      orders.ts',
    ]);
    const cat = rowNamed(rows, 'catalog', 'repo');
    expect(
      cat.kind === 'repo' && [cat.repo.color, cat.repo.op, cat.repo.files, cat.repo.conflicts],
    ).toEqual([1, 'rebase', 3, 1]);
  });

  it('접은 줄의 자식은 그리지 않고, 모두 접기는 저장소·디렉터리 id 를 전부 준다', () => {
    const rows = rowsOf([repoRowId(CAT)]);
    expect(rows.filter((r) => r.repoPath === CAT).map((r) => r.name)).toEqual(['catalog']);
    const repos = buildCommitRepos([changes(CAT, CAT_ENTRIES)], [summary(CAT)]);
    expect(commitTreeRows(repos, new Set(expandableRowIds(repos))).map((r) => r.name)).toEqual([
      'catalog',
    ]);
  });

  it('상태 문자·색은 프로젝트 트리 규칙 그대로이고, 삭제는 D 로 더한다', () => {
    expect(fileMark(st('a', 'modified', 'unmodified'))).toMatchObject({
      tone: 'modified',
      letter: 'M',
    });
    expect(fileMark(st('a', 'added', 'unmodified'))).toMatchObject({ tone: 'added', letter: 'A' });
    expect(fileMark(st('a', 'renamed', 'unmodified', { origPath: 'b' }))).toMatchObject({
      letter: 'R',
    });
    expect(fileMark(st('a', 'untracked', 'untracked'))).toMatchObject({
      tone: 'untracked',
      letter: '?',
    });
    expect(fileMark(st('a', 'unmerged', 'unmerged', { conflict: 'bothModified' }))).toMatchObject({
      tone: 'conflict',
      letter: 'U',
    });
    expect(fileMark(st('a', 'unmodified', 'deleted'))).toEqual({
      tone: 'deleted',
      letter: 'D',
      title: S.project.fileStatus.deleted,
    });
    expect(fileMark(st('a', 'deleted', 'unmodified')).letter).toBe('D');
  });
});

describe('줄 → stage·unstage 대상', () => {
  it('저장소 줄 = 전부, 폴더 줄 = 그 디렉터리, 파일 줄 = 그 경로. 빔·중간은 stage, 체크는 unstage', () => {
    const rows = rowsOf();
    expect(rowToggle(rowNamed(rows, 'web', 'repo'))).toEqual({
      repoPath: WEB,
      op: 'stage',
      target: { kind: 'all' },
    });
    expect(rowToggle(rowNamed(rows, 'filters', 'dir'))).toEqual({
      repoPath: WEB,
      op: 'stage',
      target: { kind: 'paths', paths: ['src/orders/filters'] },
    });
    // 압축한 폴더는 사슬의 마지막 단계 경로다
    expect(rowToggle(rowNamed(rows, 'shared/api', 'dir'))?.target).toEqual({
      kind: 'paths',
      paths: ['src/shared/api'],
    });
    expect(rowToggle(rowNamed(rows, 'OrderTable.tsx'))).toEqual({
      repoPath: WEB,
      op: 'unstage',
      target: { kind: 'paths', paths: ['src/orders/OrderTable.tsx'] },
    });
    expect(rowToggle(rowNamed(rows, 'StatusFilter.tsx'))?.op).toBe('stage');
    expect(rowToggle(rowNamed(rows, 'src/search', 'dir'))?.op).toBe('unstage');
  });

  it('이름 변경: unstage 는 새 경로와 옛 경로를 함께, stage 는 새 경로만 (옛 경로는 어디에도 없어 git 이 거부한다)', () => {
    const rename = st('n.ts', 'renamed', 'modified', { origPath: 'o.ts' });
    expect(fileTarget(rename, 'unstage')).toEqual({ kind: 'paths', paths: ['n.ts', 'o.ts'] });
    expect(fileTarget(rename, 'stage')).toEqual({ kind: 'paths', paths: ['n.ts'] });
    const rows = rowsOf();
    expect(rowToggle(rowNamed(rows, 'OrderExport.tsx'))?.target).toEqual({
      kind: 'paths',
      paths: ['src/orders/OrderExport.tsx', 'src/orders/Export.tsx'],
    });
  });

  it('충돌 파일·충돌뿐인 폴더는 대상이 없고, 어떤 줄도 빈 경로 목록을 만들지 않는다', () => {
    const rows = rowsOf();
    expect(rowToggle(rowNamed(rows, 'FacetBuilder.kt'))).toBeNull();
    for (const row of rows) {
      const toggle = rowToggle(row);
      if (toggle?.target.kind === 'paths') {
        expect(toggle.target.paths.length, row.id).toBeGreaterThan(0);
        expect(
          toggle.target.paths.every((p) => p !== ''),
          row.id,
        ).toBe(true);
      }
    }
  });

  it('파일을 열 때: 작업 트리 쪽에 변경이 있으면 작업 트리 diff, stage 된 것만 있으면 staged diff', () => {
    expect(opensStaged(st('a', 'modified', 'unmodified'))).toBe(true);
    expect(opensStaged(st('a', 'modified', 'modified'))).toBe(false);
    expect(opensStaged(st('a', 'unmodified', 'modified'))).toBe(false);
    expect(opensStaged(st('a', 'untracked', 'untracked'))).toBe(false);
  });
});
