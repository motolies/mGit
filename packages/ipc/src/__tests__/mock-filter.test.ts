import { describe, expect, it } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import {
  commitFilterOf,
  EMPTY_COMMIT_FILTER,
  hashPrefixOf,
  isEmptyCommitFilter,
  isListModeQuery,
} from '../commit-filter';
import { createMockClient } from '../mock/mock-client';
import { compileMockFilter } from '../mock/mock-filter';
import type { CommitFilter, GraphQuery, GraphRow, SessionEvent } from '../types';

const ROWS = 400;

/** 장면 클라이언트를 만들고 시작 경로를 꺼낸다 */
async function start(scene: 'folder' | 'repo'): Promise<{ client: IpcClient; path: string }> {
  const client = createMockClient({ rows: ROWS, scene, progressIntervalMs: 0 });
  const [path] = await client.takeStartupPaths();
  return { client, path: path ?? '' };
}

/** 필터만 바꾼 질의 */
function withFilter(filter: Partial<CommitFilter>, sort: 'date' | 'topo' = 'date'): GraphQuery {
  return {
    revs: { kind: 'all' },
    hideRemotes: false,
    pathScope: [],
    sort,
    firstParent: false,
    noMerges: false,
    filter: { ...EMPTY_COMMIT_FILTER, ...filter },
  };
}

/** 텍스트 조건 */
function text(pattern: string, regex = false, matchCase = false): Partial<CommitFilter> {
  return { text: { pattern, regex, matchCase } };
}

/** 거부 오류를 꺼낸다 (거부되지 않으면 null) */
async function rejection(call: () => Promise<unknown>) {
  try {
    await call();
    return null;
  } catch (e) {
    return toIpcError(e);
  }
}

/** 판정용 행 하나 */
function row(partial: Partial<GraphRow>): GraphRow {
  return {
    row: 0,
    oid: 'abcdef0123456789abcdef0123456789abcdef01',
    parents: [],
    authorName: 'Kim',
    authorEmail: 'kim@x.com',
    authorTime: 100,
    commitTime: 100,
    subject: 'fix: a.b(c)',
    lane: 0,
    color: 0,
    refs: [],
    isHead: false,
    inHead: true,
    repo: null,
    ...partial,
  };
}

describe('커밋 필터 도우미 (코어 규칙 미러)', () => {
  it('빠진 필드는 기본값, 빈 검색어는 조건이 아니다', () => {
    expect(commitFilterOf(undefined)).toEqual(EMPTY_COMMIT_FILTER);
    expect(commitFilterOf({ authors: ['a@b'] })).toEqual({
      ...EMPTY_COMMIT_FILTER,
      authors: ['a@b'],
    });
    expect(isEmptyCommitFilter(undefined)).toBe(true);
    expect(isEmptyCommitFilter({ text: { pattern: '', regex: true, matchCase: true } })).toBe(true);
    expect(isEmptyCommitFilter({ since: 0 })).toBe(false);
  });

  it('해시로 보는 입력은 앞뒤 공백을 뺀 hex 7~64자', () => {
    expect(hashPrefixOf(' ABCdef0 ')).toBe('abcdef0');
    expect(hashPrefixOf('abcdef')).toBeNull();
    expect(hashPrefixOf('abcdefg')).toBeNull();
    expect(hashPrefixOf('a'.repeat(65))).toBeNull();
  });

  it('텍스트·작성자·머지 제외는 목록 모드, 날짜만은 그래프', () => {
    expect(isListModeQuery(withFilter(text('x')))).toBe(true);
    expect(isListModeQuery(withFilter({ authors: ['a@b'] }))).toBe(true);
    expect(isListModeQuery(withFilter({ since: 1 }))).toBe(false);
    expect(isListModeQuery({ ...withFilter({}), noMerges: true })).toBe(true);
    // 옛 질의(필터 없음)
    const { filter: _f, ...old } = withFilter({});
    expect(isListModeQuery(old)).toBe(false);
  });
});

describe('목 필터 판정 (compileMockFilter)', () => {
  it('글자 그대로·정규식·대소문자', () => {
    expect(
      compileMockFilter({ text: { pattern: 'a.b(c)', regex: false, matchCase: false } })(row({})),
    ).toBe(true);
    expect(
      compileMockFilter({ text: { pattern: 'A.B', regex: false, matchCase: true } })(row({})),
    ).toBe(false);
    expect(
      compileMockFilter({ text: { pattern: 'a.b', regex: false, matchCase: false } })(
        row({ subject: 'axb' }),
      ),
    ).toBe(false);
    expect(
      compileMockFilter({ text: { pattern: 'a.b', regex: true, matchCase: false } })(
        row({ subject: 'axb' }),
      ),
    ).toBe(true);
  });

  it('해시 접두는 메시지 일치와 OR, 작성자는 이메일 전체(대소문자 무시)·OR, 날짜는 양 끝 포함', () => {
    expect(
      compileMockFilter({ text: { pattern: 'ABCDEF01', regex: false, matchCase: true } })(row({})),
    ).toBe(true);
    const kim = compileMockFilter({ authors: ['KIM@x.com', 'lee@x.com'] });
    expect(kim(row({}))).toBe(true);
    expect(kim(row({ authorEmail: 'kimberly@x.com' }))).toBe(false);
    const range = compileMockFilter({ since: 100, until: 200 });
    expect(range(row({ commitTime: 100 }))).toBe(true);
    expect(range(row({ commitTime: 200 }))).toBe(true);
    expect(range(row({ commitTime: 201 }))).toBe(false);
    // AND: 작성자는 맞지만 텍스트가 안 맞는다
    expect(compileMockFilter({ ...text('docs'), authors: ['kim@x.com'] })(row({}))).toBe(false);
  });

  it('잘못된 정규식·줄바꿈은 코어처럼 invalidFilter', async () => {
    for (const bad of [text('(', true), text('a\nb'), { authors: ['a@b\n'] }]) {
      const err = await rejection(async () => compileMockFilter(bad));
      expect(err?.kind).toBe('invalidFilter');
    }
  });
});

describe('폴더 장면: 타임라인 필터·저장소 범위', () => {
  /** 폴더를 열고 타임라인을 연다 */
  async function opened() {
    const { client, path } = await start('folder');
    const events: SessionEvent[] = [];
    const { session } = await client.openFolder(path, (e) => events.push(e));
    const info = await client.folderTimelineOpen(session);
    const all = await client.folderTimelineWindow(session, 0, ROWS);
    return { client, session, info, all, events };
  }

  it('텍스트 필터는 맞는 행만 목록 모드로 남기고 저장소 번호·색은 그대로다', async () => {
    const { client, session, info, all, events } = await opened();
    await client.folderTimelineQuerySet(session, withFilter(text('fix:')));
    const w = await client.folderTimelineWindow(session, 0, ROWS);
    const expected = all.rows.filter((r) => r.subject.toLowerCase().includes('fix:'));
    expect(w.totalRows).toBe(expected.length);
    expect(w.totalRows).toBeGreaterThan(0);
    expect(w.rows.map((r) => r.oid)).toEqual(expected.map((r) => r.oid));
    expect(w.rows.every((r) => r.lane === 0 && r.inHead)).toBe(true);
    expect(w.rows.every((r) => r.color === info.repos[r.repo ?? -1]?.color)).toBe(true);
    expect(w.segments).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'graphReloaded', rows: w.totalRows, laneCount: 1 });
    // 보던 커밋을 걸러진 결과에서 다시 찾는다
    const first = w.rows[3] as GraphRow;
    expect(await client.folderTimelineFindRow(session, first.repo ?? -1, first.oid)).toBe(3);
  });

  it('작성자·날짜·해시·빈 결과', async () => {
    const { client, session, all } = await opened();
    const email = all.rows[0]?.authorEmail ?? '';
    await client.folderTimelineQuerySet(session, withFilter({ authors: [email.toUpperCase()] }));
    const byAuthor = await client.folderTimelineWindow(session, 0, ROWS);
    expect(byAuthor.totalRows).toBe(all.rows.filter((r) => r.authorEmail === email).length);

    // 날짜만: 그 구간의 행이 그래프(레인)째로 남는다
    const until = all.rows[10]?.commitTime ?? 0;
    const since = all.rows[40]?.commitTime ?? 0;
    await client.folderTimelineQuerySet(session, withFilter({ since, until }));
    const dated = await client.folderTimelineWindow(session, 0, ROWS);
    expect(dated.rows.map((r) => r.oid)).toEqual(all.rows.slice(10, 41).map((r) => r.oid));
    expect(dated.rows.map((r) => r.lane)).toEqual(all.rows.slice(10, 41).map((r) => r.lane));

    const target = all.rows[25] as GraphRow;
    await client.folderTimelineQuerySet(session, withFilter(text(target.oid.slice(0, 9))));
    const byHash = await client.folderTimelineWindow(session, 0, ROWS);
    expect(byHash.rows.map((r) => [r.oid, r.repo])).toEqual([[target.oid, target.repo]]);

    await client.folderTimelineQuerySet(session, withFilter(text('없는 글자')));
    expect((await client.folderTimelineWindow(session, 0, ROWS)).totalRows).toBe(0);
  });

  it('잘못된 정규식은 질의를 바꾸지 않고 invalidFilter', async () => {
    const { client, session } = await opened();
    await client.folderTimelineQuerySet(session, withFilter(text('feat')));
    const before = await client.folderTimelineWindow(session, 0, ROWS);
    const err = await rejection(() =>
      client.folderTimelineQuerySet(session, withFilter(text('([', true))),
    );
    expect(err?.kind).toBe('invalidFilter');
    await client.folderTimelineReload(session);
    expect((await client.folderTimelineWindow(session, 0, ROWS)).rows).toEqual(before.rows);
  });

  it('저장소 범위: 번호·색을 둔 채 행만 빠지고, 빈 목록은 전부, 목록 밖 경로는 거부', async () => {
    const { client, session, info, all } = await opened();
    const [first, second] = info.repos;
    if (!first || !second) {
      throw new Error('저장소가 둘 이상이어야 한다');
    }
    await client.folderTimelineScopeSet(session, [second.path]);
    const scoped = await client.folderTimelineWindow(session, 0, ROWS);
    expect(scoped.totalRows).toBe(all.rows.filter((r) => r.repo === second.index).length);
    expect(scoped.rows.every((r) => r.repo === second.index && r.color === second.color)).toBe(
      true,
    );
    const scopedInfo = await client.folderTimelineInfo(session);
    expect(scopedInfo.scoped).toBe(true);
    expect(scopedInfo.repos.map((r) => [r.index, r.color, r.inScope])).toEqual(
      info.repos.map((r) => [r.index, r.color, r.index === second.index]),
    );
    expect(scopedInfo.repos[first.index]?.headBranch).toBeNull();
    // 범위 밖 저장소의 커밋은 찾을 수 없다
    const outside = all.rows.find((r) => r.repo === first.index) as GraphRow;
    expect(await client.folderTimelineFindRow(session, first.index, outside.oid)).toBeNull();

    const err = await rejection(() => client.folderTimelineScopeSet(session, ['/elsewhere']));
    expect(err?.kind).toBe('internal');
    expect((await client.folderTimelineInfo(session)).scoped).toBe(true);

    // 필터와 함께
    await client.folderTimelineQuerySet(session, withFilter(text('fix:')));
    const both = await client.folderTimelineWindow(session, 0, ROWS);
    expect(both.rows.every((r) => r.repo === second.index && r.subject.includes('fix:'))).toBe(
      true,
    );

    await client.folderTimelineScopeSet(session, []);
    const back = await client.folderTimelineInfo(session);
    expect(back.scoped).toBe(false);
    expect(back.repos.every((r) => r.inScope)).toBe(true);
  });

  it('작성자 후보는 필터와 무관하고 범위를 따른다', async () => {
    const { client, session, info, all } = await opened();
    const list = await client.folderTimelineAuthors(session);
    expect(list.authors.length).toBeGreaterThan(1);
    expect(list.authors.reduce((n, a) => n + a.commits, 0)).toBe(ROWS);
    const counts = list.authors.map((a) => a.commits);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    await client.folderTimelineQuerySet(
      session,
      withFilter({ authors: [list.authors[0]?.email ?? ''] }),
    );
    expect(await client.folderTimelineAuthors(session)).toEqual(list);

    const repo = info.repos[0];
    await client.folderTimelineScopeSet(session, [repo?.path ?? '']);
    const scoped = await client.folderTimelineAuthors(session);
    expect(scoped.authors.reduce((n, a) => n + a.commits, 0)).toBe(
      all.rows.filter((r) => r.repo === repo?.index).length,
    );
  });
});

describe('저장소 장면: 그래프 필터', () => {
  /** 저장소를 연다 */
  async function opened() {
    const { client, path } = await start('repo');
    const events: SessionEvent[] = [];
    const { session } = await client.openRepo(path, (e) => events.push(e));
    const all = await client.graphWindow(session, 0, ROWS);
    return { client, session, all, events };
  }

  it('작성자 필터는 목록 모드로 걸러내고, 걸러진 커밋은 행 찾기에서 빠진다', async () => {
    const { client, session, all, events } = await opened();
    const email = all.rows[1]?.authorEmail ?? '';
    await client.setGraphQuery(session, withFilter({ authors: [email] }, 'topo'));
    const w = await client.graphWindow(session, 0, ROWS);
    const expected = all.rows.filter((r) => r.authorEmail === email);
    expect(w.rows.map((r) => r.oid)).toEqual(expected.map((r) => r.oid));
    expect(w.rows.every((r) => r.lane === 0 && r.color === 0)).toBe(true);
    expect(w.edges).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'graphReloaded', rows: expected.length });
    const gone = all.rows.find((r) => r.authorEmail !== email) as GraphRow;
    expect(await client.findRow(session, gone.oid)).toBeNull();
    expect(await client.findRow(session, expected[2]?.oid ?? '')).toBe(2);
    expect((await client.graphQuery(session)).filter?.authors).toEqual([email]);
    // 작성자 후보는 전체 이력에서
    const authors = await client.graphAuthors(session);
    expect(authors.authors.length).toBeGreaterThan(1);
    expect(authors.authors.reduce((n, a) => n + a.commits, 0)).toBe(ROWS);
  });

  it('날짜만이면 그 구간의 그래프 선이 남고, 필터를 비우면 전체로 돌아간다', async () => {
    const { client, session, all } = await opened();
    const since = all.rows[60]?.commitTime ?? 0;
    const until = all.rows[20]?.commitTime ?? 0;
    await client.setGraphQuery(session, withFilter({ since, until }, 'topo'));
    const dated = await client.graphWindow(session, 0, ROWS);
    expect(dated.rows.map((r) => r.oid)).toEqual(all.rows.slice(20, 61).map((r) => r.oid));
    expect(dated.rows.map((r) => r.lane)).toEqual(all.rows.slice(20, 61).map((r) => r.lane));
    expect(dated.segments.length).toBeGreaterThan(0);

    await client.setGraphQuery(session, withFilter({}, 'topo'));
    expect((await client.graphWindow(session, 0, ROWS)).totalRows).toBe(ROWS);
  });

  it('잘못된 정규식은 질의를 바꾸지 않는다', async () => {
    const { client, session } = await opened();
    await client.setGraphQuery(session, withFilter(text('feat'), 'topo'));
    const err = await rejection(() =>
      client.setGraphQuery(session, withFilter(text('(', true), 'topo')),
    );
    expect(err).toMatchObject({ kind: 'invalidFilter' });
    expect((await client.graphQuery(session)).filter?.text?.pattern).toBe('feat');
  });
});
