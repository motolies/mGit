import { getLocale, intlLocale, type Locale } from './locale';

/** 40자 hex 해시를 앞 8자로 줄인다 (LG-01) */
export function shortHash(oid: string, length = 8): string {
  return oid.slice(0, length);
}

/**
 * 지금 UI 언어(`getLocale`)의 Intl 포맷터를 돌려주는 함수를 만든다. 포맷터는 만드는 비용이 커서 언어마다 처음 쓸 때
 * 한 번만 만들어 둔다
 */
function perLocale<F>(make: (tag: string) => F): () => F {
  const cache = new Map<Locale, F>();
  return () => {
    const locale = getLocale();
    let formatter = cache.get(locale);
    if (formatter === undefined) {
      formatter = make(intlLocale(locale));
      cache.set(locale, formatter);
    }
    return formatter;
  };
}

const dateTimeFormatter = perLocale(
  (tag) =>
    new Intl.DateTimeFormat(tag, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
);

const timeFormatter = perLocale(
  (tag) =>
    new Intl.DateTimeFormat(tag, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
);

/** Unix epoch(초)을 로컬 시간대의 "YYYY. MM. DD. HH:mm" 형식으로 바꾼다 (영어는 "MM/DD/YYYY, HH:mm") */
export function formatDateTime(epochSeconds: number): string {
  return dateTimeFormatter().format(new Date(epochSeconds * 1000));
}

const clockFormatter = perLocale(
  (tag) =>
    new Intl.DateTimeFormat(tag, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
);

const dateClockFormatter = perLocale(
  (tag) =>
    new Intl.DateTimeFormat(tag, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
);

const numberFormatter = perLocale((tag) => new Intl.NumberFormat(tag));

/** 수를 지금 UI 언어의 천 단위 구분으로 쓴다 (`12345` → "12,345") */
export function formatNumber(n: number): string {
  return numberFormatter().format(n);
}

/** 수량에 맞는 단수·복수 문구를 고른다: `n` 이 1 이면 `one`, 그 밖에는 `other` (영어 사전용) */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

/**
 * 상대 날짜의 문구. 문구는 `S.date` 가 갖고, 이 파일은 `strings.ts`·`i18n/` 을 import 하지 않는다 (사전이 이 파일을
 * import 하므로 순환 방지. 언어는 의존성 없는 `locale.ts` 에서 읽는다)
 */
export interface CommitDateWords {
  justNow: string;
  minutesAgo: (minutes: number) => string;
  /** `time` 은 "오전 10:21" 꼴 */
  today: (time: string) => string;
  yesterday: (time: string) => string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * 로그 행의 날짜 (LG-04). `nowMillis` 를 기준으로 가까운 시각은 상대 표현으로 바꾼다:
 * 1분 미만 "방금 전" → 1시간 미만 "N분 전" → 같은 날 "오늘 오전 10:21" → 전날 "어제 오후 6:05"
 * → 그 밖에는 "2026. 11. 11. 오후 2:50". 날짜 경계는 로컬 시간대의 자정이다.
 * 미래 시각(시계가 어긋난 커밋)은 상대 표현을 건너뛰고 날짜 기준으로만 고른다
 */
export function formatCommitDate(
  epochSeconds: number,
  nowMillis: number,
  words: CommitDateWords,
): string {
  const time = epochSeconds * 1000;
  const elapsed = nowMillis - time;
  if (elapsed >= 0 && elapsed < MINUTE_MS) {
    return words.justNow;
  }
  if (elapsed >= 0 && elapsed < HOUR_MS) {
    return words.minutesAgo(Math.floor(elapsed / MINUTE_MS));
  }
  const date = new Date(time);
  const now = new Date(nowMillis);
  // 일 단위 뺄셈은 Date 에 맡긴다 (달·해가 바뀌는 날, 서머타임으로 하루가 24시간이 아닌 날)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  if (time >= today && time < tomorrow) {
    return words.today(clockFormatter().format(date));
  }
  if (time >= yesterday && time < today) {
    return words.yesterday(clockFormatter().format(date));
  }
  return dateClockFormatter().format(date);
}

const DAY_MS = 24 * HOUR_MS;

/**
 * 파일의 수정 시각 (PT-10). 24시간 안에 바뀐 파일은 로그 날짜(`formatCommitDate`)와 같은 상대 표현
 * ("방금 전", "N분 전", "오늘 …", "어제 …"), 그보다 오래됐거나 미래 시각이면 "2026. 11. 11. 오후 2:50"
 */
export function formatFileDate(
  epochMillis: number,
  nowMillis: number,
  words: CommitDateWords,
): string {
  const elapsed = nowMillis - epochMillis;
  if (elapsed >= 0 && elapsed < DAY_MS) {
    return formatCommitDate(epochMillis / 1000, nowMillis, words);
  }
  return dateClockFormatter().format(new Date(epochMillis));
}

/** Unix epoch(밀리초)을 로컬 시간대의 "HH:mm:ss" 형식으로 바꾼다 (명령 로그) */
export function formatTime(epochMillis: number): string {
  return timeFormatter().format(new Date(epochMillis));
}

/** 바이트 수를 "1.2 KB" 처럼 줄인다. null 이면 "–" */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '–';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
