import type { FsEntry } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { flattenProjectTree } from '../features/project/project-tree-model';
import { type DirLoad, type DirMap, FS_LIST_MAX, noteRowId } from '../store/file-tree';

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file', openable = kind === 'file'): FsEntry {
  return { name, kind, size: kind === 'file' ? 10 : null, mtimeMs: 0, openable };
}

/** 읽은 목록 */
function listed(entries: FsEntry[], extra: Partial<Extract<DirLoad, { state: 'listed' }>> = {}) {
  return {
    load: {
      state: 'listed' as const,
      entries,
      total: entries.length,
      truncated: false,
      nonUtf8Names: 0,
      ...extra,
    },
    limit: null,
    pending: false,
  };
}

/** 행을 `단계 id` 꼴의 짧은 글로 */
function shape(rows: ReturnType<typeof flattenProjectTree>): string[] {
  return rows.map((r) => `${r.depth}:${r.kind === 'entry' ? r.path : r.kind}`);
}

const ROOT: DirMap = {
  '': listed([entry('.claude', 'dir'), entry('api', 'dir'), entry('README.md')]),
  api: listed([entry('src', 'dir'), entry('pom.xml')]),
  'api/src': listed([entry('Main.java')]),
};

describe('flattenProjectTree (PT-01·03)', () => {
  it('루트 행 아래에 나열 순서 그대로 항목을 놓고, 펼친 디렉터리만 그 자리에 이어 붙인다', () => {
    const rows = flattenProjectTree(ROOT, { '': true, api: true });
    expect(shape(rows)).toEqual([
      '0:root',
      '1:.claude',
      '1:api',
      '2:api/src',
      '2:api/pom.xml',
      '1:README.md',
    ]);
    // 펼친 기록이 있어도 조상이 접혀 있으면 숨는다
    expect(shape(flattenProjectTree(ROOT, { '': true, 'api/src': true }))).toEqual([
      '0:root',
      '1:.claude',
      '1:api',
      '1:README.md',
    ]);
    // 루트를 접으면 루트 행만
    expect(shape(flattenProjectTree(ROOT, { api: true }))).toEqual(['0:root']);
  });

  it('행마다 부모·형제 수·순번을 싣는다 (가상 스크롤의 ARIA)', () => {
    const rows = flattenProjectTree(ROOT, { '': true, api: true, 'api/src': true });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('')).toMatchObject({ parentId: null, setSize: 1, posInSet: 1, depth: 0 });
    expect(byId.get('api')).toMatchObject({
      parentId: '',
      setSize: 3,
      posInSet: 2,
      depth: 1,
      expandable: true,
      expanded: true,
    });
    expect(byId.get('api/pom.xml')).toMatchObject({ parentId: 'api', setSize: 2, posInSet: 2 });
    expect(byId.get('api/src/Main.java')).toMatchObject({
      parentId: 'api/src',
      depth: 3,
      setSize: 1,
      posInSet: 1,
      openable: true,
      expandable: false,
    });
  });

  it('링크·특수 파일은 펼치거나 열 수 없고, 열 수 없는 파일은 열 수 없다고 싣는다', () => {
    const rows = flattenProjectTree(
      {
        '': listed([
          entry('link', 'symlink', false),
          entry('agent.sock', 'other', false),
          entry('too-long-name', 'file', false),
        ]),
      },
      { '': true, link: true },
    );
    expect(rows.slice(1).map((r) => r.kind === 'entry' && [r.expandable, r.openable])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it('잘린 디렉터리는 마지막에 "더 보기" 줄을, 이름을 못 읽은 항목이 있으면 그 안내 줄을 둔다', () => {
    const entries = [entry('archive', 'dir'), entry('a.log'), entry('b.log')];
    const rows = flattenProjectTree(
      { '': listed(entries, { total: 2_402, truncated: true, nonUtf8Names: 3 }) },
      { '': true },
    );
    expect(shape(rows)).toEqual([
      '0:root',
      '1:archive',
      '1:a.log',
      '1:b.log',
      '1:nonUtf8',
      '1:more',
    ]);
    const notes = rows.slice(4);
    expect(notes[0]).toMatchObject({
      id: noteRowId('nonUtf8', ''),
      count: 3,
      setSize: 5,
      posInSet: 4,
    });
    expect(notes[1]).toMatchObject({
      id: noteRowId('more', ''),
      shown: 3,
      total: 2_402,
      next: 2_399,
      loading: false,
      setSize: 5,
      posInSet: 5,
    });
  });

  it('상한(50,000)을 넘는 디렉터리는 상한까지만 더 보이고, 상한에 닿으면 더 볼 수 없다', () => {
    const few = flattenProjectTree(
      { '': listed([entry('a')], { total: 120_000, truncated: true }) },
      { '': true },
    );
    expect(few.at(-1)).toMatchObject({ kind: 'more', next: FS_LIST_MAX - 1 });
    const capped = flattenProjectTree(
      {
        '': {
          ...listed(
            Array.from({ length: FS_LIST_MAX }, (_, i) => entry(`f${i}`)),
            {
              total: 120_000,
              truncated: true,
            },
          ),
          pending: true,
        },
      },
      { '': true },
    );
    expect(capped.at(-1)).toMatchObject({ kind: 'more', next: 0, loading: true });
    expect(capped).toHaveLength(1 + FS_LIST_MAX + 1);
  });

  it('읽는 중·비어 있음·없음·권한 없음·오류는 그 디렉터리 아래 상태 줄 하나다 (PT-09)', () => {
    const rows = flattenProjectTree(
      {
        '': listed([
          entry('pending', 'dir'),
          entry('empty', 'dir'),
          entry('gone', 'dir'),
          entry('private', 'dir'),
          entry('broken', 'dir'),
          entry('unread', 'dir'),
        ]),
        pending: { load: { state: 'loading' }, limit: null, pending: true },
        empty: listed([]),
        gone: { load: { state: 'missing' }, limit: null, pending: false },
        private: { load: { state: 'denied' }, limit: null, pending: false },
        broken: { load: { state: 'error', error: 'EIO' }, limit: null, pending: false },
      },
      {
        '': true,
        pending: true,
        empty: true,
        gone: true,
        private: true,
        broken: true,
        unread: true,
      },
    );
    const statuses = rows.filter((r) => r.kind === 'status');
    expect(statuses.map((r) => r.kind === 'status' && [r.dir, r.status, r.depth])).toEqual([
      ['pending', 'loading', 2],
      ['empty', 'empty', 2],
      ['gone', 'missing', 2],
      ['private', 'denied', 2],
      ['broken', 'error', 2],
      // 아직 읽지 않은 펼친 디렉터리도 "읽는 중" 이다
      ['unread', 'loading', 2],
    ]);
    expect(statuses[4]).toMatchObject({ error: 'EIO', id: noteRowId('status', 'broken') });
  });

  it('루트를 아직 못 읽었거나 읽지 못하면 루트 아래 상태 줄 하나다', () => {
    expect(shape(flattenProjectTree({}, { '': true }))).toEqual(['0:root', '1:status']);
    const denied = flattenProjectTree(
      { '': { load: { state: 'denied' }, limit: null, pending: false } },
      { '': true },
    );
    expect(denied[1]).toMatchObject({ kind: 'status', status: 'denied', parentId: '' });
  });
});
