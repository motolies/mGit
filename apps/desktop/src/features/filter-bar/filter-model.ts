import {
  commitFilterOf,
  type FullCommitFilter,
  type GraphQuery,
  type GraphRevs,
  isEmptyCommitFilter,
} from '@mgit/ipc';
import { S } from '@mgit/ui';

// 로그 필터 바의 순수 규칙 (LG-06, W17). 질의(`GraphQuery`)를 받아 새 질의를 돌려준다 — 폴더·저장소 탭 공용이라
// 폴더 개념(저장소 경로·범위 API)을 모른다. 필터 규칙 자체(정규화·해시·목록 모드)는 `@mgit/ipc` 의 `commit-filter.ts`

/** 텍스트 입력의 상태: 입력 중인 검색어와 두 토글 */
export interface TextDraft {
  pattern: string;
  regex: boolean;
  matchCase: boolean;
}

/** 날짜 범위 (epoch 초, 양 끝 포함. null = 그쪽 끝 없음) */
export interface DateRange {
  since: number | null;
  until: number | null;
}

/** 질의의 필터 (빠진 필드는 기본값으로) */
export function filterOf(query: Pick<GraphQuery, 'filter'>): FullCommitFilter {
  return commitFilterOf(query.filter);
}

/** 질의에서 필터만 바꾼다 */
function withFilter(query: GraphQuery, patch: Partial<FullCommitFilter>): GraphQuery {
  return { ...query, filter: { ...filterOf(query), ...patch } };
}

/**
 * 텍스트 조건을 적용한 질의 (Enter): 앞뒤 공백을 다듬고 공백만이면 조건이 없다(빈 검색어). 토글은 입력 중인 값을
 * 그대로 쓴다
 */
export function withText(query: GraphQuery, draft: TextDraft): GraphQuery {
  return withFilter(query, {
    text: { pattern: draft.pattern.trim(), regex: draft.regex, matchCase: draft.matchCase },
  });
}

/** 작성자 조건(이메일들)을 바꾼 질의. 빈 목록 = 조건 없음 */
export function withAuthors(query: GraphQuery, emails: readonly string[]): GraphQuery {
  return withFilter(query, { authors: [...emails] });
}

/** 날짜 조건을 바꾼 질의 */
export function withDates(query: GraphQuery, range: DateRange): GraphQuery {
  return withFilter(query, { since: range.since, until: range.until });
}

/** ref 범위를 바꾼 질의 */
export function withRevs(query: GraphQuery, revs: GraphRevs): GraphQuery {
  return { ...query, revs };
}

/** 경로 범위를 바꾼 질의 (저장소 탭의 경로 드롭다운, W26). 빈 목록 = 조건 없음 */
export function withPaths(query: GraphQuery, paths: readonly string[]): GraphQuery {
  return { ...query, pathScope: [...paths] };
}

/**
 * 쉼표로 구분한 입력 → 목록 (옛 그래프 필터 바의 경로 입력·"ref 고르기…" 대화상자와 같은 규칙): 쉼표로 나누고 앞뒤
 * 공백을 다듬고 빈 항목을 버린다
 */
export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * "모두 지우기"(와 결과 없음 상태의 "필터 지우기")의 질의: 텍스트·작성자·날짜·branch 조건과 경로 범위를 지운다.
 * 정규식·대소문자 토글과 보기 옵션(정렬·원격 숨기기·첫 부모·머지 제외)은 조건이 아니라 그대로 둔다. 저장소 범위는 질의
 * 밖이라 부르는 쪽이 따로 푼다 (폴더 로그는 경로 범위를 쓰지 않아 늘 빈 목록이다)
 */
export function clearedQuery(query: GraphQuery): GraphQuery {
  const f = filterOf(query);
  return {
    ...query,
    revs: { kind: 'all' },
    pathScope: [],
    filter: { text: { ...f.text, pattern: '' }, authors: [], since: null, until: null },
  };
}

/**
 * 필터 바의 조건(텍스트·작성자·날짜·branch, 저장소 탭은 경로 범위도)이 하나라도 걸려 있는지. 저장소 범위는 따로 본다.
 * 경로 범위를 모르는 값(필드 없음)은 경로 조건이 없는 것으로 본다
 */
export function hasConditions(
  query: Pick<GraphQuery, 'revs' | 'filter'> & { pathScope?: readonly string[] },
): boolean {
  return (
    query.revs.kind !== 'all' ||
    !isEmptyCommitFilter(query.filter) ||
    (query.pathScope?.length ?? 0) > 0
  );
}

/** 두 질의가 같은지 (필터의 빠진 필드는 기본값으로 보고 비교한다). 같은 질의로 다시 읽지 않으려고 본다 */
export function sameQuery(a: GraphQuery, b: GraphQuery): boolean {
  const norm = (q: GraphQuery) => JSON.stringify({ ...q, filter: filterOf(q) });
  return norm(a) === norm(b);
}

/**
 * 입력 중인 값이 적용된 값과 다른지 ("적용 전" 표시). 검색어는 다듬은 값으로 비교하고, 토글은 검색어가 있을 때만
 * 본다 (토글은 적용된 검색어가 있으면 바로 다시 적용되므로 검색어 없이 바꾼 토글은 기다리는 변경이 아니다)
 */
export function textPending(draft: TextDraft, applied: FullCommitFilter['text']): boolean {
  const pattern = draft.pattern.trim();
  if (pattern !== applied.pattern) {
    return true;
  }
  return pattern !== '' && (draft.regex !== applied.regex || draft.matchCase !== applied.matchCase);
}

/**
 * 토글을 바꿨을 때 바로 다시 적용할 질의 (적용된 검색어가 있을 때만). 검색어는 적용된 값 그대로다 — 입력 중이던
 * 다른 값은 Enter 전까지 적용하지 않는다. 적용된 검색어가 없으면 null (토글만 바뀌고 다시 읽지 않는다)
 */
export function toggledQuery(
  query: GraphQuery,
  toggles: Pick<TextDraft, 'regex' | 'matchCase'>,
): GraphQuery | null {
  const text = filterOf(query).text;
  if (text.pattern === '') {
    return null;
  }
  return withFilter(query, { text: { pattern: text.pattern, ...toggles } });
}

/** ref 범위가 고른 이름들 (단추 요약용). HEAD 범위는 HEAD 표기 하나, 전체는 빈 목록 */
export function revsValues(revs: GraphRevs): string[] {
  switch (revs.kind) {
    case 'head':
      // 브랜치 트리의 HEAD 행과 같은 글자
      return [S.branches.head];
    case 'solo':
      return [revs.name];
    case 'branches':
      return revs.names;
    default:
      return [];
  }
}

/** branch 드롭다운의 HEAD 항목 id (브랜치 이름과 겹치지 않는 값) */
export const HEAD_OPTION_ID = '\u0000head';

/** ref 범위 → branch 드롭다운에서 체크된 항목 id (HEAD 는 `HEAD_OPTION_ID`) */
export function revsSelection(revs: GraphRevs): string[] {
  switch (revs.kind) {
    case 'head':
      return [HEAD_OPTION_ID];
    case 'solo':
      return [revs.name];
    case 'branches':
      return revs.names;
    default:
      return [];
  }
}

/** branch 드롭다운에서 체크한 항목 id → ref 범위. 없으면 전체, HEAD 면 HEAD, 이름 하나면 solo, 여럿이면 branches */
export function revsOfSelection(ids: readonly string[]): GraphRevs {
  if (ids.includes(HEAD_OPTION_ID)) {
    return { kind: 'head' };
  }
  const [first] = ids;
  if (first === undefined) {
    return { kind: 'all' };
  }
  return ids.length === 1 ? { kind: 'solo', name: first } : { kind: 'branches', names: [...ids] };
}

/**
 * 여러 개 체크 목록에서 항목 하나를 뒤집는다. `exclusive` 의 항목(branch 의 HEAD)은 다른 항목과 함께 고를 수 없다:
 * 그것을 고르면 나머지가 빠지고, 다른 것을 고르면 그것이 빠진다
 */
export function toggleChecked(
  checked: readonly string[],
  id: string,
  exclusive: readonly string[] = [],
): string[] {
  if (checked.includes(id)) {
    return checked.filter((other) => other !== id);
  }
  if (exclusive.includes(id)) {
    return [id];
  }
  return [...checked.filter((other) => !exclusive.includes(other)), id];
}

/** 두 체크 목록이 같은 집합인지 (순서 무관) */
export function sameChecked(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

/** 드롭다운 단추의 글자와 툴팁. 고른 값이 없으면 이름만(흐리게), 있으면 `이름: 첫 값 +N` */
export interface ButtonSummary {
  label: string;
  title: string;
  active: boolean;
}

/** 드롭다운 단추의 요약 */
export function buttonSummary(name: string, values: readonly string[]): ButtonSummary {
  const [first] = values;
  if (first === undefined) {
    return { label: name, title: name, active: false };
  }
  const value = values.length === 1 ? first : S.filterBar.more(first, values.length - 1);
  return {
    label: S.filterBar.summary(name, value),
    title: S.filterBar.summary(name, values.join(', ')),
    active: true,
  };
}

// --- 날짜 (wire 는 epoch 초·양 끝 포함, "하루"는 그날 00:00:00 ~ 23:59:59 로컬) ---

/** 빠른 선택. "최근 N일"은 고른 시점에 고정한 범위다 (상대 값을 저장하지 않는다) */
export type QuickRange = 'today' | 'last7' | 'last30';
export const QUICK_RANGES: readonly QuickRange[] = ['today', 'last7', 'last30'];
/** 빠른 선택이 덮는 날 수 (오늘 포함) */
const QUICK_DAYS: Record<QuickRange, number> = { today: 1, last7: 7, last30: 30 };

/** 날짜 하나 (로컬 달력) */
export interface Day {
  year: number;
  /** 1~12 */
  month: number;
  day: number;
}

/**
 * 그날 00:00:00 (로컬) 의 epoch 초. 달·날이 넘쳐도 달력대로 넘긴다 (`Date` 의 규칙: 1월 0일 = 전해 12월 31일)
 */
export function startOfDay(d: Day): number {
  return Math.floor(new Date(d.year, d.month - 1, d.day).getTime() / 1000);
}

/**
 * 그날 23:59:59 (로컬) 의 epoch 초 = 다음 날 00:00:00 의 1초 전. 하루가 23·25시간인 서머타임 전환일에도 그날의
 * 마지막 초다
 */
export function endOfDay(d: Day): number {
  return Math.floor(new Date(d.year, d.month - 1, d.day + 1).getTime() / 1000) - 1;
}

/** epoch 초 → 그 시각의 로컬 날짜 */
export function dayOf(epochSec: number): Day {
  const date = new Date(epochSec * 1000);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** 날짜 입력(`<input type="date">`)의 값 `YYYY-MM-DD` → 날짜. 비었거나 달력에 없는 날이면 null */
export function parseDayInput(value: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) {
    return null;
  }
  const d: Day = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  // 2월 30일처럼 달력에 없는 날은 거른다 (`Date` 는 다음 달로 넘겨 버린다)
  const date = new Date(d.year, d.month - 1, d.day);
  return date.getFullYear() === d.year &&
    date.getMonth() === d.month - 1 &&
    date.getDate() === d.day
    ? d
    : null;
}

/** 날짜 → 날짜 입력의 값 `YYYY-MM-DD` */
export function dayInputOf(d: Day): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

/** 날짜 비교 (앞이면 음수) */
function compareDays(a: Day, b: Day): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * 직접 고른 범위 → wire 범위. 시작은 그날 00:00:00, 끝은 그날 23:59:59 (로컬). 한쪽만 고르면 그쪽만 걸고, 시작이
 * 끝보다 뒤면 두 날을 맞바꾼다 (사용자가 거꾸로 고른 것으로 본다). 둘 다 비었으면 조건 없음
 */
export function rangeOfDays(from: Day | null, to: Day | null): DateRange {
  const [a, b] = from && to && compareDays(from, to) > 0 ? [to, from] : [from, to];
  return { since: a ? startOfDay(a) : null, until: b ? endOfDay(b) : null };
}

/** 빠른 선택의 범위: 오늘을 끝으로 N일 (오늘 00:00:00 − (N−1)일 ~ 오늘 23:59:59, 로컬). `now` 시점에 고정한다 */
export function quickRange(kind: QuickRange, now: Date): DateRange {
  const today: Day = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const first: Day = { ...today, day: today.day - (QUICK_DAYS[kind] - 1) };
  return { since: startOfDay(first), until: endOfDay(today) };
}

/** 날짜 범위의 표기용 날짜: 올해면 연도를 뺀다 (한국어 `10. 28.`, 아니면 `2025. 10. 28.`) */
function dayLabel(d: Day, now: Date): string {
  const t = S.filterBar.dates;
  return d.year === now.getFullYear()
    ? t.day(d.month, d.day)
    : t.dayWithYear(d.year, d.month, d.day);
}

/**
 * 날짜 조건의 글자 (단추 요약·결과 없음 요약). 지금 시점의 빠른 선택과 같으면 그 이름(`최근 7일`), 하루면 그 날,
 * 양 끝이면 `a ~ b`, 한쪽만이면 `a 이후`·`b 이전`. 조건이 없으면 null. 범위는 고정된 값이라 날이 바뀌면 빠른 선택
 * 이름 대신 날짜로 보인다
 */
export function describeRange(range: DateRange, now: Date): string | null {
  const { since, until } = range;
  if (since === null && until === null) {
    return null;
  }
  for (const kind of QUICK_RANGES) {
    const q = quickRange(kind, now);
    if (q.since === since && q.until === until) {
      return S.filterBar.dates[kind];
    }
  }
  if (since !== null && until !== null) {
    const a = dayOf(since);
    const b = dayOf(until);
    // 그날 하루 (00:00:00 ~ 23:59:59)
    if (compareDays(a, b) === 0 && since === startOfDay(a) && until === endOfDay(b)) {
      return dayLabel(a, now);
    }
    return S.filterBar.dates.range(dayLabel(a, now), dayLabel(b, now));
  }
  return since !== null
    ? S.filterBar.dates.since(dayLabel(dayOf(since), now))
    : S.filterBar.dates.until(dayLabel(dayOf(until as number), now));
}

/**
 * 결과 없음 상태에 보일 조건 요약 (LG-11): 텍스트, branch, 작성자, 날짜, 경로 범위(저장소 탭), 저장소 범위 순.
 * `authorLabel` 은 이메일 → 보일 이름, `pathLabel` 은 경로 → 보일 이름(모듈 이름 등), `scopeNames` 는 범위에 든 저장소
 * 이름 (범위가 없으면 빈 목록)
 */
export function conditionSummary(
  query: GraphQuery,
  opts: {
    now: Date;
    authorLabel?: (email: string) => string;
    pathLabel?: (path: string) => string;
    scopeNames?: readonly string[];
  },
): string[] {
  const f = filterOf(query);
  const parts: string[] = [];
  if (f.text.pattern !== '') {
    parts.push(S.filterBar.textCondition(f.text.pattern, f.text.regex));
  }
  const pick = (name: string, values: readonly string[]) => {
    if (values.length > 0) {
      parts.push(buttonSummary(name, values).label);
    }
  };
  pick(S.filterBar.branch, revsValues(query.revs));
  pick(S.filterBar.author, f.authors.map(opts.authorLabel ?? ((email) => email)));
  const dates = describeRange(f, opts.now);
  pick(S.filterBar.date, dates === null ? [] : [dates]);
  pick(S.filterBar.path, query.pathScope.map(opts.pathLabel ?? ((path) => path)));
  pick(S.filterBar.repo, opts.scopeNames ?? []);
  return parts;
}

// --- 로그 영역의 상태 (LG-11) ---

/**
 * 로그 영역에 무엇을 그릴지: 행 / 첫 로드 자리 표시(스켈레톤) / 읽기 실패 / 커밋 없음 / 필터 결과 없음. 행이 있으면
 * 언제나 행이다 (다시 읽는 동안·실패해도 이전 결과를 보인다). 행이 없는데 읽는 중이면 자리 표시다 — 필터를 바꾼 직후
 * 옛 결과(0행)로 "결과 없음"을 잠깐 보이지 않게 한다
 */
export type LogBodyState = 'rows' | 'skeleton' | 'error' | 'empty' | 'noMatch';

export function logBodyState(input: {
  loadState: 'idle' | 'loading' | 'complete' | 'error';
  totalRows: number;
  /** 필터 바의 조건(또는 저장소 범위)이 걸려 있는지 */
  filtered: boolean;
}): LogBodyState {
  if (input.totalRows > 0) {
    return 'rows';
  }
  if (input.loadState === 'error') {
    return 'error';
  }
  if (input.loadState !== 'complete') {
    return 'skeleton';
  }
  return input.filtered ? 'noMatch' : 'empty';
}

// --- 좁은 폭 (로그 칸은 최소 360px, 최소 창 960×600 에서 약 491px) ---

/**
 * 필터 바의 내용 폭(좌우 여백을 뺀 폭)이 이 이상이면 드롭다운 단추에 이름·고른 값이 보이는 한 줄이다. 한 줄에 입력(최소
 * 180) + 드롭다운 넷(조건 없을 때 약 290) + 상태·단추(약 140)가 들어가는 폭이다. 1400×900 창의 기본 배치(로그 칸 약
 * 734px, 내용 폭 약 710px)가 이 모양이다
 */
export const FILTER_BAR_ONE_ROW_MIN = 640;

/**
 * 좁은 한 줄(드롭다운 단추가 아이콘만, W19)에 드는 내용 폭 — 조건이 하나도 걸리지 않았을 때. 입력 최소 96 + 간격 8 +
 * 아이콘 단추 넷(브라우저에서 잰 폭 32 × 4 + 간격 = 140) + 간격 8 + 상태(최대 80)·보기 옵션·새로고침(약 128) = 380 에
 * 여유 20 을 더했다. 960×600(로그 칸 약 491px, 내용 폭 약 475px)은 이 모양이다
 */
export const FILTER_BAR_COMPACT_MIN = 400;
/** 좁은 한 줄에서 조건이 걸린 드롭다운 하나가 더 차지하는 폭 (그 조건의 × 단추 20 과 간격 4) */
export const FILTER_BAR_COMPACT_PER_ACTIVE = 24;
/**
 * 좁은 한 줄에서 "모두 지우기"·목록 모드 표시·도구 단추(저장소 탭의 찾기, W26) 하나가 각각 더 차지하는 폭 (아이콘 단추
 * 20 과 간격 4)
 */
export const FILTER_BAR_COMPACT_EXTRA = 24;

/**
 * 필터 바의 모양 (W19):
 * - `full`: 한 줄, 드롭다운 단추에 이름·고른 값 (내용 폭 ≥ `FILTER_BAR_ONE_ROW_MIN`)
 * - `compact`: 한 줄, 드롭다운 단추는 아이콘만(이름·값은 툴팁과 보조 기술 이름, 걸린 조건은 점과 ×), 상태 글자는 짧게
 *   (좁은 한 줄에 드는 폭일 때 — 걸린 조건·모두 지우기·목록 모드 표시만큼 더 필요하다)
 * - `stacked`: 두 줄 (윗줄 = 입력·상태·단추, 아랫줄 = 이름이 보이는 드롭다운). 한 줄에 못 넣을 때만이고 높이 상한이다
 * 아직 재지 못한 폭(0)은 `full` 이다. `tools` 는 상태 글자 곁의 도구 단추 수(폴더는 없다 — 기본 0)
 */
export type FilterBarMode = 'full' | 'compact' | 'stacked';

export function filterBarMode(
  width: number,
  shown: { active: number; clearAll: boolean; listMode: boolean; tools?: number } = {
    active: 0,
    clearAll: false,
    listMode: false,
  },
): FilterBarMode {
  if (width <= 0 || width >= FILTER_BAR_ONE_ROW_MIN) {
    return 'full';
  }
  const need =
    FILTER_BAR_COMPACT_MIN +
    shown.active * FILTER_BAR_COMPACT_PER_ACTIVE +
    (shown.clearAll ? FILTER_BAR_COMPACT_EXTRA : 0) +
    (shown.listMode ? FILTER_BAR_COMPACT_EXTRA : 0) +
    (shown.tools ?? 0) * FILTER_BAR_COMPACT_EXTRA;
  return width >= need ? 'compact' : 'stacked';
}
