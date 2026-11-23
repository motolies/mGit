import type { CommitFilter, FullCommitFilter, GraphQuery } from './types';

/** 조건이 하나도 없는 커밋 필터 (코어 `CommitFilter::default`) */
export const EMPTY_COMMIT_FILTER: FullCommitFilter = {
  text: { pattern: '', regex: false, matchCase: false },
  authors: [],
  since: null,
  until: null,
};

/** 해시(접두)로 보는 입력 길이 (코어 `HASH_PREFIX_MIN`·`HASH_PREFIX_MAX`) */
const HASH_PREFIX_MIN = 7;
const HASH_PREFIX_MAX = 64;

/**
 * 빠진 필드를 기본값으로 채운 필터. 저장해 둔 옛 질의(필터 없음)나 일부만 쓴 필터를 코어가 읽는 것과 같은
 * 값으로 맞춘다
 */
export function commitFilterOf(filter: CommitFilter | null | undefined): FullCommitFilter {
  const text = filter?.text;
  return {
    text: {
      pattern: text?.pattern ?? '',
      regex: text?.regex ?? false,
      matchCase: text?.matchCase ?? false,
    },
    authors: filter?.authors ?? [],
    since: filter?.since ?? null,
    until: filter?.until ?? null,
  };
}

/** 조건이 하나도 없는지 (코어 `CommitFilter::is_empty` — 빈 검색어는 조건이 아니다) */
export function isEmptyCommitFilter(filter: CommitFilter | null | undefined): boolean {
  const f = commitFilterOf(filter);
  return f.text.pattern === '' && f.authors.length === 0 && f.since === null && f.until === null;
}

/**
 * 검색어가 해시 접두로 보이면 소문자 hex 를, 아니면 null (코어 `CommitFilter::hash_prefix`: 앞뒤 공백을 뺀
 * 값이 hex 7~64자. 정규식·대소문자 설정과 무관). 그렇게 보이면 메시지 일치 커밋에 그 해시의 커밋이 더해진다
 */
export function hashPrefixOf(pattern: string): string | null {
  const p = pattern.trim();
  return p.length >= HASH_PREFIX_MIN && p.length <= HASH_PREFIX_MAX && /^[0-9a-fA-F]+$/.test(p)
    ? p.toLowerCase()
    : null;
}

/**
 * 결과를 그래프 선 없는 목록 모드로 그리는지 (코어 `GraphQuery::list_mode`): 머지 제외, 또는 텍스트·작성자
 * 필터. 날짜만 걸면 그 기간의 이력이 이어져 있어 그래프를 그린다
 */
export function isListModeQuery(query: Pick<GraphQuery, 'noMerges' | 'filter'>): boolean {
  const f = commitFilterOf(query.filter);
  return query.noMerges || f.text.pattern !== '' || f.authors.length > 0;
}
