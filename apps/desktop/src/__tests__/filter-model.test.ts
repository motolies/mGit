import { type GraphQuery, isListModeQuery } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { filterOptions, orderChecked } from '../features/filter-bar/FilterDropdown';
import {
  buttonSummary,
  clearedQuery,
  conditionSummary,
  dayInputOf,
  dayOf,
  describeRange,
  endOfDay,
  FILTER_BAR_COMPACT_EXTRA,
  FILTER_BAR_COMPACT_MIN,
  FILTER_BAR_COMPACT_PER_ACTIVE,
  FILTER_BAR_ONE_ROW_MIN,
  filterBarMode,
  filterOf,
  HEAD_OPTION_ID,
  hasConditions,
  logBodyState,
  parseDayInput,
  quickRange,
  rangeOfDays,
  revsOfSelection,
  revsSelection,
  revsValues,
  sameChecked,
  sameQuery,
  startOfDay,
  textPending,
  toggleChecked,
  toggledQuery,
  withAuthors,
  withDates,
  withRevs,
  withText,
} from '../features/filter-bar/filter-model';
import { DEFAULT_TIMELINE_QUERY } from '../store/folder-store';

const Q: GraphQuery = DEFAULT_TIMELINE_QUERY;
/** 로컬 시각의 epoch 초 */
const at = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) =>
  Math.floor(new Date(y, m - 1, d, h, mi, s).getTime() / 1000);

describe('필터 상태 → 질의 (텍스트)', () => {
  it('Enter 로 적용할 때 앞뒤 공백을 다듬고, 공백만이면 조건이 없다', () => {
    const q = withText(Q, { pattern: '  fix: 주문 ', regex: false, matchCase: true });
    expect(filterOf(q).text).toEqual({ pattern: 'fix: 주문', regex: false, matchCase: true });
    const blank = withText(q, { pattern: '   ', regex: true, matchCase: false });
    expect(filterOf(blank).text.pattern).toBe('');
    expect(hasConditions(blank)).toBe(false);
    // 다른 조건과 질의 필드는 그대로
    const withAuthor = withAuthors(Q, ['a@x']);
    expect(
      filterOf(withText(withAuthor, { pattern: 'x', regex: false, matchCase: false })).authors,
    ).toEqual(['a@x']);
  });

  it('적용 전 표시: 다듬은 검색어가 다르면, 검색어가 있을 때는 토글이 달라도 기다리는 변경이다', () => {
    const applied = { pattern: 'fix', regex: false, matchCase: false };
    expect(textPending({ ...applied }, applied)).toBe(false);
    expect(textPending({ ...applied, pattern: ' fix ' }, applied)).toBe(false);
    expect(textPending({ ...applied, pattern: 'fix:' }, applied)).toBe(true);
    expect(textPending({ ...applied, regex: true }, applied)).toBe(true);
    // 검색어가 없으면 토글만 다른 것은 기다리는 변경이 아니다
    const empty = { pattern: '', regex: false, matchCase: false };
    expect(textPending({ pattern: '  ', regex: true, matchCase: true }, empty)).toBe(false);
  });

  it('토글: 적용된 검색어가 있으면 그 검색어로 바로 다시 적용하고, 없으면 null (다시 읽지 않는다)', () => {
    const q = withText(Q, { pattern: 'fix', regex: false, matchCase: false });
    expect(filterOf(toggledQuery(q, { regex: true, matchCase: false }) as GraphQuery).text).toEqual(
      {
        pattern: 'fix',
        regex: true,
        matchCase: false,
      },
    );
    expect(toggledQuery(Q, { regex: true, matchCase: true })).toBeNull();
  });

  it('질의 비교는 필터의 빠진 필드를 기본값으로 본다', () => {
    const { filter: _drop, ...noFilter } = Q;
    expect(sameQuery(noFilter as GraphQuery, Q)).toBe(true);
    expect(sameQuery(withAuthors(Q, ['a@x']), Q)).toBe(false);
  });
});

describe('필터 상태 → 질의 (작성자·날짜·branch·모두 지우기)', () => {
  it('작성자는 이메일 목록, 날짜는 epoch 초 범위로 들어간다', () => {
    const q = withDates(withAuthors(Q, ['harin.seo@example.com', 'jamie@x']), {
      since: 100,
      until: 200,
    });
    expect(filterOf(q)).toMatchObject({
      authors: ['harin.seo@example.com', 'jamie@x'],
      since: 100,
      until: 200,
    });
    // 작성자 필터는 목록 모드, 날짜만이면 그래프 (결정 14)
    expect(isListModeQuery(q)).toBe(true);
    expect(isListModeQuery(withDates(Q, { since: 100, until: null }))).toBe(false);
  });

  it('"모두 지우기" 는 텍스트·작성자·날짜·branch 를 지우고 토글과 보기 옵션은 남긴다', () => {
    const q = {
      ...withDates(
        withAuthors(withText(Q, { pattern: 'x', regex: true, matchCase: true }), ['a@x']),
        { since: 1, until: 2 },
      ),
      revs: { kind: 'solo' as const, name: 'main' },
      hideRemotes: true,
      noMerges: true,
    };
    expect(hasConditions(q)).toBe(true);
    const cleared = clearedQuery(q);
    expect(hasConditions(cleared)).toBe(false);
    expect(cleared.revs).toEqual({ kind: 'all' });
    expect(filterOf(cleared).text).toEqual({ pattern: '', regex: true, matchCase: true });
    expect(cleared.hideRemotes).toBe(true);
    expect(cleared.noMerges).toBe(true);
  });

  it('branch 드롭다운의 체크 ↔ ref 범위: 없음 = 전체, HEAD = head, 하나 = solo, 여럿 = branches', () => {
    expect(revsOfSelection([])).toEqual({ kind: 'all' });
    expect(revsOfSelection([HEAD_OPTION_ID])).toEqual({ kind: 'head' });
    expect(revsOfSelection(['main'])).toEqual({ kind: 'solo', name: 'main' });
    expect(revsOfSelection(['main', 'origin/main'])).toEqual({
      kind: 'branches',
      names: ['main', 'origin/main'],
    });
    for (const revs of [
      { kind: 'all' as const },
      { kind: 'head' as const },
      { kind: 'solo' as const, name: 'x' },
      { kind: 'branches' as const, names: ['a', 'b'] },
    ]) {
      expect(revsOfSelection(revsSelection(revs))).toEqual(revs);
    }
    expect(revsValues({ kind: 'head' })).toEqual([S.branches.head]);
    expect(withRevs(Q, { kind: 'head' }).revs).toEqual({ kind: 'head' });
  });

  it('여러 개 체크: HEAD 는 다른 항목과 함께 고를 수 없다', () => {
    const ex = [HEAD_OPTION_ID];
    expect(toggleChecked(['a'], 'b', ex)).toEqual(['a', 'b']);
    expect(toggleChecked(['a', 'b'], 'a', ex)).toEqual(['b']);
    expect(toggleChecked(['a', 'b'], HEAD_OPTION_ID, ex)).toEqual([HEAD_OPTION_ID]);
    expect(toggleChecked([HEAD_OPTION_ID], 'a', ex)).toEqual(['a']);
    expect(sameChecked(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameChecked(['a'], ['a', 'b'])).toBe(false);
  });

  it('적용 순서는 목록 순서이고, 목록에 없는 값(지금 후보에 없는 이메일)은 앞에 둔다', () => {
    const options = [
      { id: 'b', label: 'B' },
      { id: 'a', label: 'A' },
      { id: 'c', label: 'C' },
    ];
    expect(orderChecked(['a', 'gone@x', 'b'], options)).toEqual(['gone@x', 'b', 'a']);
  });

  it('목록 검색은 이름·흐린 글자의 부분 일치 (대소문자 무시)', () => {
    const options = [
      { id: '1', label: '서하린', detail: 'harin.seo@example.com' },
      { id: '2', label: 'Jamie Park', detail: 'jamie@example.com' },
    ];
    expect(filterOptions(options, 'HARIN').map((o) => o.id)).toEqual(['1']);
    expect(filterOptions(options, ' park ').map((o) => o.id)).toEqual(['2']);
    expect(filterOptions(options, '')).toHaveLength(2);
  });
});

describe('드롭다운 단추의 요약 글자', () => {
  it('고른 것이 없으면 이름만(흐리게), 하나면 그 값, 여럿이면 첫 값 +N 이고 툴팁에 전부', () => {
    expect(buttonSummary('작성자', [])).toEqual({
      label: '작성자',
      title: '작성자',
      active: false,
    });
    expect(buttonSummary('작성자', ['서하린'])).toEqual({
      label: S.filterBar.summary('작성자', '서하린'),
      title: S.filterBar.summary('작성자', '서하린'),
      active: true,
    });
    const two = buttonSummary('작성자', ['서하린', 'Jamie Park']);
    expect(two.label).toBe('작성자: 서하린 +1');
    expect(two.title).toBe('작성자: 서하린, Jamie Park');
  });
});

describe('날짜 변환 (wire 는 epoch 초·양 끝 포함, 로컬 하루 = 00:00:00 ~ 23:59:59)', () => {
  it('하루의 시작과 끝은 그날 자정과 다음 날 자정 1초 전이다 (자정 경계)', () => {
    const day = { year: 2025, month: 10, day: 28 };
    expect(startOfDay(day)).toBe(at(2025, 10, 28, 0, 0, 0));
    expect(endOfDay(day)).toBe(at(2025, 10, 28, 23, 59, 59));
    expect(endOfDay(day) + 1).toBe(at(2025, 10, 29));
    // 월말·연말을 넘긴다
    expect(endOfDay({ year: 2025, month: 12, day: 31 }) + 1).toBe(at(2026, 1, 1));
    // 자정 정각은 그날, 1초 전은 전날
    expect(dayOf(at(2025, 10, 28))).toEqual(day);
    expect(dayOf(at(2025, 10, 28) - 1)).toEqual({ year: 2025, month: 10, day: 27 });
  });

  it('날짜 칸의 값을 읽고 쓴다. 달력에 없는 날·형식이 다른 값은 null', () => {
    expect(parseDayInput('2025-10-28')).toEqual({ year: 2025, month: 10, day: 28 });
    expect(parseDayInput('2025-02-30')).toBeNull();
    expect(parseDayInput('')).toBeNull();
    expect(parseDayInput('2025/10/28')).toBeNull();
    expect(dayInputOf({ year: 2025, month: 3, day: 7 })).toBe('2025-03-07');
  });

  it('직접 고른 범위: 양 끝, 한쪽만, 시작 > 끝(맞바꾼다), 둘 다 비움', () => {
    const a = { year: 2025, month: 10, day: 20 };
    const b = { year: 2025, month: 10, day: 28 };
    expect(rangeOfDays(a, b)).toEqual({
      since: at(2025, 10, 20),
      until: at(2025, 10, 28, 23, 59, 59),
    });
    expect(rangeOfDays(b, a)).toEqual(rangeOfDays(a, b));
    expect(rangeOfDays(a, null)).toEqual({ since: at(2025, 10, 20), until: null });
    expect(rangeOfDays(null, b)).toEqual({ since: null, until: at(2025, 10, 28, 23, 59, 59) });
    expect(rangeOfDays(null, null)).toEqual({ since: null, until: null });
    // 같은 날 하루
    expect(rangeOfDays(b, b)).toEqual({
      since: at(2025, 10, 28),
      until: at(2025, 10, 28, 23, 59, 59),
    });
  });

  it('빠른 선택은 고른 시점의 오늘을 끝으로 고정된 범위다 (오늘 = 하루, 최근 7일 = 오늘 포함 7일)', () => {
    const now = new Date(2025, 9, 28, 15, 30);
    expect(quickRange('today', now)).toEqual({
      since: at(2025, 10, 28),
      until: at(2025, 10, 28, 23, 59, 59),
    });
    expect(quickRange('last7', now)).toEqual({
      since: at(2025, 10, 22),
      until: at(2025, 10, 28, 23, 59, 59),
    });
    // 달을 넘긴다
    expect(quickRange('last30', new Date(2025, 10, 5, 9)).since).toBe(at(2025, 10, 7));
  });

  it('날짜 조건의 글자: 지금의 빠른 선택이면 그 이름, 날이 바뀌면 날짜로, 하루·범위·한쪽', () => {
    const now = new Date(2025, 9, 28, 15, 30);
    expect(describeRange(quickRange('last7', now), now)).toBe(S.filterBar.dates.last7);
    // 다음 날이 되면 고정된 값이 날짜로 보인다 (상대 값을 저장하지 않는다)
    const tomorrow = new Date(2025, 9, 29, 9);
    expect(describeRange(quickRange('last7', now), tomorrow)).toBe(
      S.filterBar.dates.range('10. 22.', '10. 28.'),
    );
    expect(describeRange(rangeOfDays({ year: 2024, month: 5, day: 1 }, null), now)).toBe(
      S.filterBar.dates.since('2024. 5. 1.'),
    );
    expect(describeRange({ since: null, until: at(2025, 10, 1, 23, 59, 59) }, now)).toBe(
      S.filterBar.dates.until('10. 1.'),
    );
    const one = { year: 2025, month: 10, day: 3 };
    expect(describeRange(rangeOfDays(one, one), now)).toBe('10. 3.');
    expect(describeRange({ since: null, until: null }, now)).toBeNull();
  });
});

describe('결과 없음 상태의 조건 요약과 로그 영역 상태 (LG-11)', () => {
  it('텍스트, branch, 작성자(이름), 날짜, 저장소 범위 순으로 요약한다', () => {
    const now = new Date(2025, 9, 28, 12);
    const q = {
      ...withDates(
        withAuthors(withText(Q, { pattern: '^fix', regex: true, matchCase: false }), [
          'harin.seo@example.com',
        ]),
        quickRange('last7', now),
      ),
      revs: { kind: 'solo' as const, name: 'main' },
    };
    expect(
      conditionSummary(q, {
        now,
        authorLabel: (email) => (email.startsWith('harin') ? '서하린' : email),
        scopeNames: ['api-gateway', 'web-console'],
      }),
    ).toEqual([
      S.filterBar.textCondition('^fix', true),
      'branch: main',
      '작성자: 서하린',
      `날짜: ${S.filterBar.dates.last7}`,
      '저장소: api-gateway +1',
    ]);
    expect(conditionSummary(Q, { now })).toEqual([]);
  });

  it.each<[string, Parameters<typeof logBodyState>[0], string]>([
    [
      '행이 있으면 다시 읽는 중·실패여도 행',
      { loadState: 'error', totalRows: 3, filtered: true },
      'rows',
    ],
    ['첫 로드(열기 전)', { loadState: 'idle', totalRows: 0, filtered: false }, 'skeleton'],
    ['읽는 중이고 행이 없음', { loadState: 'loading', totalRows: 0, filtered: true }, 'skeleton'],
    ['읽기 실패이고 행이 없음', { loadState: 'error', totalRows: 0, filtered: false }, 'error'],
    [
      '다 읽었고 조건이 없음 = 커밋 없음',
      { loadState: 'complete', totalRows: 0, filtered: false },
      'empty',
    ],
    [
      '다 읽었고 조건이 있음 = 필터 결과 없음',
      { loadState: 'complete', totalRows: 0, filtered: true },
      'noMatch',
    ],
  ])('%s', (_name, input, expected) => {
    expect(logBodyState(input)).toBe(expected);
  });
});

describe('좁은 폭', () => {
  // W17 의 "640 미만 = 두 줄" 을 W19 가 바꿨다: 640 미만이라도 아이콘 단추로 한 줄에 들면 한 줄(compact)이고, 그래도 못
  // 넣을 때만 두 줄(stacked)이다
  const none = { active: 0, clearAll: false, listMode: false };
  it('재지 못한 폭과 기준 이상은 이름이 보이는 한 줄, 그보다 좁으면 아이콘 한 줄, 더 좁으면 두 줄 (상한)', () => {
    expect(filterBarMode(0, none)).toBe('full');
    expect(filterBarMode(FILTER_BAR_ONE_ROW_MIN, none)).toBe('full');
    expect(filterBarMode(1200, none)).toBe('full');
    expect(filterBarMode(FILTER_BAR_ONE_ROW_MIN - 1, none)).toBe('compact');
    // 960×600 의 로그 칸 (약 491px, 내용 폭 약 475px) — W17 에서는 두 줄이었다
    expect(filterBarMode(475, none)).toBe('compact');
    expect(filterBarMode(FILTER_BAR_COMPACT_MIN, none)).toBe('compact');
    expect(filterBarMode(FILTER_BAR_COMPACT_MIN - 1, none)).toBe('stacked');
    // 로그 칸 최소 360px (내용 폭 약 344px)
    expect(filterBarMode(344, none)).toBe('stacked');
  });

  it('걸린 조건(×)·모두 지우기·목록 모드 표시만큼 좁은 한 줄에 더 필요하다', () => {
    const all = { active: 4, clearAll: true, listMode: true };
    const need =
      FILTER_BAR_COMPACT_MIN + 4 * FILTER_BAR_COMPACT_PER_ACTIVE + 2 * FILTER_BAR_COMPACT_EXTRA;
    expect(filterBarMode(need, all)).toBe('compact');
    expect(filterBarMode(need - 1, all)).toBe('stacked');
    // 960×600 에서 조건 하나(branch)와 모두 지우기 — 한 줄이다
    expect(filterBarMode(475, { active: 1, clearAll: true, listMode: false })).toBe('compact');
    // 넓으면 무엇이 걸려도 이름이 보이는 한 줄이다
    expect(filterBarMode(FILTER_BAR_ONE_ROW_MIN, all)).toBe('full');
  });
});
