import type { FsEntry } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { filterProjectTree, filterTokens, matchName } from '../features/project/project-filter';
import type { EntryRow, ProjectTreeRow } from '../features/project/project-tree-model';
import type { DirMap } from '../store/file-tree';

// Project 트리 보기 거르기 (R1): 이름 필터·"변경된 파일만" 으로 맞은 항목과 그 상위 폴더만 남긴 행

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file'): FsEntry {
  return { name, kind, size: kind === 'file' ? 7 : null, mtimeMs: 5, openable: kind === 'file' };
}

/** 읽은 목록 */
function listed(entries: FsEntry[]) {
  return {
    load: {
      state: 'listed' as const,
      entries,
      total: entries.length,
      truncated: false,
      nonUtf8Names: 0,
    },
    limit: null,
    pending: false,
  };
}

/** 행을 `단계:경로` 꼴로 (폴더는 끝에 `/`) */
function shape(rows: readonly ProjectTreeRow[]): string[] {
  return rows.map((r) =>
    r.kind === 'entry' ? `${r.depth}:${r.path}${r.entryKind === 'dir' ? '/' : ''}` : r.kind,
  );
}

/** 경로의 항목 행 */
function rowAt(rows: readonly ProjectTreeRow[], path: string): EntryRow {
  const row = rows.find((r) => r.kind === 'entry' && r.path === path);
  if (row?.kind !== 'entry') throw new Error(`no row ${path}`);
  return row;
}

// 루트만 펼쳐 읽은 폴더 탭: api·web 은 아직 안 읽었다
const DIRS: DirMap = {
  '': listed([entry('api', 'dir'), entry('web', 'dir'), entry('README.md'), entry('.env')]),
};
const FILES = [
  'README.md',
  'api/pom.xml',
  'api/src/Main.java',
  'api/src/MainTest.java',
  'web/src/main.ts',
  'web/package.json',
];

describe('filterTokens·matchName', () => {
  it('공백으로 나눈 낱말을 대소문자 없이 접고, 한글 조합 중 끝의 홀로 선 자모는 뺀다', () => {
    expect(filterTokens('  Main  TEST ')).toEqual(['main', 'test']);
    expect(filterTokens('설정ㅍ')).toEqual(['설정']);
    expect(filterTokens('   ')).toEqual([]);
  });

  it('낱말마다 이어진 부분 글자로 맞고 순서는 보지 않는다. 강조 위치는 처음 나온 자리', () => {
    expect(matchName('maintest.java', ['test', 'main'])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(matchName('main.java', ['jv'])).toBeNull();
    expect(matchName('main.java', [])).toEqual([]);
  });
});

describe('filterProjectTree — 이름 필터', () => {
  it('펼치지 않은 폴더의 파일도 파일 목록으로 찾아, 맞은 항목과 상위 폴더만 모두 펼쳐 보인다', () => {
    const { rows, hits, marks, limited } = filterProjectTree(
      { dirs: DIRS, files: FILES, changed: null },
      filterTokens('main'),
    );
    expect(shape(rows)).toEqual([
      'root',
      '1:api/',
      '2:api/src/',
      '3:api/src/Main.java',
      '3:api/src/MainTest.java',
      '1:web/',
      '2:web/src/',
      '3:web/src/main.ts',
    ]);
    expect([...hits].sort()).toEqual([
      'api/src/Main.java',
      'api/src/MainTest.java',
      'web/src/main.ts',
    ]);
    expect(marks.get('web/src/main.ts')).toEqual([0, 1, 2, 3]);
    expect(marks.has('api')).toBe(false);
    expect(limited).toBe(false);
    // 상위 폴더는 펼친 채(접지 않는다), 맞은 파일은 열 수 있다. 목록에만 있는 파일은 크기·날짜를 모른다
    expect(rowAt(rows, 'api/src')).toMatchObject({ expandable: true, expanded: true });
    expect(rowAt(rows, 'web/src/main.ts')).toMatchObject({
      openable: true,
      size: null,
      mtimeMs: null,
    });
  });

  it('읽어 둔 항목은 종류·크기·날짜를 쓰고, 목록에 없는 무시된 파일도 펼쳐 둔 폴더에서는 찾는다', () => {
    const { rows } = filterProjectTree(
      { dirs: DIRS, files: FILES, changed: null },
      filterTokens('.env'),
    );
    expect(shape(rows)).toEqual(['root', '1:.env']);
    expect(rowAt(rows, '.env')).toMatchObject({ size: 7, mtimeMs: 5, openable: true });
  });

  it('폴더 이름도 맞는다. 맞은 폴더 안에 맞은 항목이 없으면 자식 없이 보인다', () => {
    const { rows, hits } = filterProjectTree(
      { dirs: DIRS, files: FILES, changed: null },
      filterTokens('src'),
    );
    expect(shape(rows)).toEqual(['root', '1:api/', '2:api/src/', '1:web/', '2:web/src/']);
    expect([...hits].sort()).toEqual(['api/src', 'web/src']);
    expect(rowAt(rows, 'api/src')).toMatchObject({ entryKind: 'dir', expandable: false });
  });

  it('형제는 코어 순서(폴더 먼저 → 소문자 이름 → 원래 이름)이고 형제 수·순번을 싣는다', () => {
    const { rows } = filterProjectTree(
      { dirs: {}, files: ['b/x.md', 'B.md', 'a.md', 'A.md', 'c/x.md'], changed: null },
      filterTokens('x a'),
    );
    // 'a' 와 'x' 를 모두 이름에 담는 것은 없다 → 아무것도 없다
    expect(shape(rows)).toEqual(['root']);
    const md = filterProjectTree(
      { dirs: {}, files: ['b/x.md', 'B.md', 'a.md', 'A.md', 'c/x.md'], changed: null },
      filterTokens('md'),
    );
    expect(shape(md.rows)).toEqual([
      'root',
      '1:b/',
      '2:b/x.md',
      '1:c/',
      '2:c/x.md',
      '1:A.md',
      '1:a.md',
      '1:B.md',
    ]);
    expect(rowAt(md.rows, 'A.md')).toMatchObject({ setSize: 5, posInSet: 3, parentId: '' });
  });

  it('그룹 탭의 별칭 경로도 그대로다 (맨 위 별칭이 폴더)', () => {
    const dirs: DirMap = { '': listed([entry('api', 'dir'), entry('web', 'dir')]) };
    const { rows } = filterProjectTree(
      { dirs, files: ['api/src/a.ts', 'web/b.ts'], changed: null },
      filterTokens('b.ts'),
    );
    expect(shape(rows)).toEqual(['root', '1:web/', '2:web/b.ts']);
  });

  it('맞은 항목이 상한을 넘으면 앞의 것만 넣고 알린다', () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const result = filterProjectTree({ dirs: {}, files, changed: null }, filterTokens('txt'), 5);
    expect(result.hits.size).toBe(5);
    expect(result.limited).toBe(true);
    expect(result.rows).toHaveLength(6);
  });
});

describe('filterProjectTree — 변경된 파일만', () => {
  const changed = [
    { path: 'api/src/Main.java', dir: false },
    { path: 'web/scratch', dir: true },
    { path: 'README.md', dir: false },
  ];

  it('변경 경로와 상위 폴더만 보이고, 통째로 untracked 인 디렉터리는 폴더다. 파일 목록은 보지 않는다', () => {
    const { rows, hits } = filterProjectTree({ dirs: DIRS, files: FILES, changed }, []);
    expect(shape(rows)).toEqual([
      'root',
      '1:api/',
      '2:api/src/',
      '3:api/src/Main.java',
      '1:web/',
      '2:web/scratch/',
      '1:README.md',
    ]);
    expect(hits.size).toBe(3);
    // 읽어 둔 루트의 README 는 크기·날짜가 있다
    expect(rowAt(rows, 'README.md')).toMatchObject({ size: 7 });
  });

  it('이름 필터와 함께면 둘 다 맞아야 한다', () => {
    const { rows, marks } = filterProjectTree(
      { dirs: DIRS, files: FILES, changed },
      filterTokens('readme'),
    );
    expect(shape(rows)).toEqual(['root', '1:README.md']);
    expect(marks.get('README.md')).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
