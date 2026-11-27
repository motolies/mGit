// 목록 거르기의 일치 규칙 (빠른 브랜치 전환·비교 화면 ref 선택 칸 공용): 대소문자 무시 부분 일치를 먼저, 글자 순서만 맞는
// 퍼지 일치를 뒤에 둔다

/** 단순 부분 일치 (대소문자 무시, 입력 글자 순서대로 포함) */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') {
    return true;
  }
  if (t.includes(q)) {
    return true;
  }
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) {
      i++;
      if (i === q.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 검색어에 맞는 항목을 "부분 일치 먼저 → 퍼지 일치 뒤" 로 고른다 (각 무리 안에서는 받은 순서). 빈 검색어면 전부다.
 * 몇 개로 자를지는 부르는 쪽이 정한다
 */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
): T[] {
  const q = query.toLowerCase();
  const exact = items.filter((item) => textOf(item).toLowerCase().includes(q));
  const fuzzy = items.filter((item) => !exact.includes(item) && fuzzyMatch(query, textOf(item)));
  return [...exact, ...fuzzy];
}
