import { IpcClientError } from '../client';
import {
  commitFilterOf,
  hashPrefixOf,
  isEmptyCommitFilter,
  isListModeQuery,
} from '../commit-filter';
import type { AuthorList, CommitFilter, GraphQuery, GraphRow } from '../types';
import type { MockGraph } from './mock-graph-source';
import { pick } from './mock-l10n';

/**
 * 코어의 커밋 필터(LG-06)를 목 데이터에 흉내 낸다. 규칙은 코어와 같다:
 * - 텍스트: 빈 검색어는 조건이 아니다. 글자 그대로(기본) 또는 정규식, `matchCase` 가 꺼지면 대소문자 무시.
 *   코어는 메시지 전체(본문 포함)에서 찾지만 목에는 제목만 있다. 정규식은 JS `RegExp` 라 POSIX ERE 와
 *   세부가 다르다 (`\d` 등). 잘못된 정규식이면 `invalidFilter` 로 거부한다.
 * - 해시: 검색어가 hex 7~64자로 보이면 그 해시로 시작하는 커밋도 든다 (메시지 일치와 OR).
 * - 작성자: 이메일 전체가 같으면(대소문자 무시) 포함, 여럿은 OR.
 * - 날짜: 커밋 시각이 `since`~`until`(epoch 초, 둘 다 포함) 안.
 * - 텍스트·작성자·날짜는 AND. 텍스트·작성자가 있으면 목록 모드(선 없음), 날짜만이면 그래프를 그린다
 */

/** 필터를 쓸 수 없을 때 코어처럼 던진다 */
function invalidFilter(message: string): never {
  throw new IpcClientError({ kind: 'invalidFilter', message });
}

/** 필터를 행 판정 함수로 바꾼다. 줄바꿈·NUL 이 든 값이나 잘못된 정규식이면 `invalidFilter` 를 던진다 */
export function compileMockFilter(
  filter: CommitFilter | null | undefined,
): (row: GraphRow) => boolean {
  const f = commitFilterOf(filter);
  const bad = (s: string) => /[\0\n\r]/.test(s);
  if (bad(f.text.pattern)) {
    invalidFilter(
      pick(
        '검색어에 줄바꿈이나 NUL 문자를 쓸 수 없습니다',
        'Search text cannot contain line breaks or NUL characters',
      ),
    );
  }
  if (f.authors.some(bad)) {
    invalidFilter(
      pick(
        '작성자에 줄바꿈이나 NUL 문자를 쓸 수 없습니다',
        'Author cannot contain line breaks or NUL characters',
      ),
    );
  }
  let text: ((subject: string) => boolean) | null = null;
  if (f.text.pattern !== '') {
    if (f.text.regex) {
      let re: RegExp;
      try {
        re = new RegExp(f.text.pattern, f.text.matchCase ? '' : 'i');
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        invalidFilter(
          pick(`잘못된 정규식입니다: ${reason}`, `Invalid regular expression: ${reason}`),
        );
      }
      text = (subject) => re.test(subject);
    } else if (f.text.matchCase) {
      const needle = f.text.pattern;
      text = (subject) => subject.includes(needle);
    } else {
      const needle = f.text.pattern.toLowerCase();
      text = (subject) => subject.toLowerCase().includes(needle);
    }
  }
  const hash = hashPrefixOf(f.text.pattern);
  const authors = new Set(f.authors.map((a) => a.toLowerCase()));
  const { since, until } = f;
  return (row) => {
    if (text && !(text(row.subject) || (hash !== null && row.oid.startsWith(hash)))) {
      return false;
    }
    if (authors.size > 0 && !authors.has(row.authorEmail.toLowerCase())) {
      return false;
    }
    if (since !== null && row.commitTime < since) {
      return false;
    }
    if (until !== null && row.commitTime > until) {
      return false;
    }
    return true;
  };
}

/** 이어진 행 구간 [first, last] 만 남기고 행 번호를 0 부터 다시 매긴다 (그래프 선은 그 구간에 맞춰 자른다) */
function sliceGraph(graph: MockGraph, first: number, last: number): MockGraph {
  const rows = graph.rows.slice(first, last + 1).map((r, i) => ({ ...r, row: i }));
  const segments = graph.segments
    .filter((s) => s.end >= first && s.start <= last)
    .map((s) => ({
      ...s,
      start: Math.max(s.start, first) - first,
      end: Math.min(s.end, last) - first,
    }));
  const edges = graph.edges
    .filter((e) => e.topRow >= first && e.topRow < last)
    .map((e) => ({ ...e, topRow: e.topRow - first }));
  const inside = (row: number | null | undefined) =>
    row !== null && row !== undefined && row >= first && row <= last;
  const stubs = graph.stubs
    .filter((s) => inside(s.row) && inside(s.otherRow))
    .map((s) => ({ ...s, row: s.row - first, otherRow: (s.otherRow ?? first) - first }));
  return { rows, segments, edges, stubs, laneCount: rows.length > 0 ? graph.laneCount : 0 };
}

/**
 * 질의의 커밋 필터로 그래프를 거른다. 필터가 없으면 그대로 돌려준다. 목록 모드(텍스트·작성자)면 선을 모두 빼고
 * 행을 레인 0 에 `listColor` 색으로 둔다 (코어처럼 HEAD 도달성을 알 수 없어 흐리지 않는다). 날짜만이면 남은 행이
 * 이어진 구간일 때 그래프 선을 그 구간으로 잘라 남긴다 (목 이력은 커밋 시각이 행 순서라 늘 이어진다)
 */
export function filterMockGraph(
  graph: MockGraph,
  query: Pick<GraphQuery, 'filter' | 'noMerges'>,
  listColor: (row: GraphRow) => number,
): MockGraph {
  if (isEmptyCommitFilter(query.filter)) {
    return graph;
  }
  const keep = compileMockFilter(query.filter);
  const kept = graph.rows.filter(keep);
  const first = kept[0]?.row;
  const last = kept[kept.length - 1]?.row;
  if (first === undefined || last === undefined) {
    return { rows: [], segments: [], edges: [], stubs: [], laneCount: 0 };
  }
  if (!isListModeQuery(query) && last - first + 1 === kept.length) {
    return sliceGraph(graph, first, last);
  }
  const rows = kept.map((r, i) => ({ ...r, row: i, lane: 0, color: listColor(r), inHead: true }));
  return { rows, segments: [], edges: [], stubs: [], laneCount: 1 };
}

/** 행들의 작성자 후보 (코어 `group_authors`: 이메일 대소문자 무시로 묶고 커밋 수 내림차순 → 이름 → 이메일) */
export function mockAuthors(rows: readonly GraphRow[]): AuthorList {
  const groups = new Map<
    string,
    { commits: number; names: Map<string, number>; emails: Map<string, number> }
  >();
  for (const r of rows) {
    const key = r.authorEmail.toLowerCase();
    const g = groups.get(key) ?? { commits: 0, names: new Map(), emails: new Map() };
    groups.set(key, g);
    g.commits += 1;
    g.names.set(r.authorName, (g.names.get(r.authorName) ?? 0) + 1);
    g.emails.set(r.authorEmail, (g.emails.get(r.authorEmail) ?? 0) + 1);
  }
  /** 코드 단위 순서 비교 (코어의 문자열 비교처럼 로캘을 타지 않는다) */
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  /** 가장 많이 쓴 값 (같으면 사전순 앞) */
  const mostUsed = (counts: Map<string, number>) =>
    [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? '';
  const authors = [...groups.values()]
    .map((g) => ({ name: mostUsed(g.names), email: mostUsed(g.emails), commits: g.commits }))
    .sort(
      (a, b) =>
        b.commits - a.commits ||
        cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
        cmp(a.email, b.email),
    );
  return { authors, total: authors.length, truncated: false, timedOut: false };
}
