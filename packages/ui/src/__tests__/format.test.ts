import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCommitDate,
  formatDateTime,
  formatFileDate,
  formatNumber,
  formatTime,
  plural,
  shortHash,
} from '../format';
import { getLocale, intlLocale, setLocale } from '../locale';
import { S } from '../strings';

describe('shortHash', () => {
  it('기본 8자로 줄인다 (LG-01)', () => {
    expect(shortHash('ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901')).toBe('ba53f33a');
  });

  it('길이를 지정할 수 있다', () => {
    expect(shortHash('ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901', 10)).toBe('ba53f33a1b');
  });
});

describe('formatDateTime', () => {
  it('epoch 초를 연·월·일·시·분이 포함된 문자열로 바꾼다', () => {
    const text = formatDateTime(1_700_000_000);
    expect(text).toMatch(/2023/);
    expect(text).toMatch(/\d{2}:\d{2}/);
  });
});

describe('formatCommitDate (LG-04)', () => {
  /** 로컬 시간대의 시각 (ms). 테스트가 실행 환경의 시간대에 기대지 않게 로컬 기준으로만 만든다 */
  const at = (day: number, hour: number, minute: number, second = 0) =>
    new Date(2026, 10, day, hour, minute, second).getTime();
  /** `now` 에서 본 `then` 의 표시 */
  const show = (then: number, now: number) => formatCommitDate(then / 1000, now, S.date);
  const NOW = at(18, 14, 50);

  it('1분 미만은 "방금 전": 59초까지', () => {
    expect(show(NOW, NOW)).toBe('방금 전');
    expect(show(NOW - 59_000, NOW)).toBe('방금 전');
    expect(show(NOW - 60_000, NOW)).toBe('1분 전');
  });

  it('1시간 미만은 "N분 전": 59분까지', () => {
    expect(show(NOW - 7 * 60_000, NOW)).toBe('7분 전');
    expect(show(NOW - (59 * 60_000 + 59_000), NOW)).toBe('59분 전');
    expect(show(NOW - 60 * 60_000, NOW)).toBe('오늘 오후 1:50');
  });

  it('같은 날은 "오늘 오전/오후 h:mm"', () => {
    expect(show(at(18, 10, 21), NOW)).toBe('오늘 오전 10:21');
    expect(show(at(18, 0, 0), NOW)).toBe('오늘 오전 12:00');
    expect(show(at(18, 12, 5), NOW)).toBe('오늘 오후 12:05');
  });

  it('전날은 "어제 …", 그 앞은 날짜와 시각', () => {
    expect(show(at(17, 18, 5), NOW)).toBe('어제 오후 6:05');
    expect(show(at(17, 0, 0), NOW)).toBe('어제 오전 12:00');
    // 그제의 마지막 순간은 어제가 아니다
    expect(show(at(16, 23, 59, 59), NOW)).toBe('2026. 11. 16. 오후 11:59');
    expect(show(at(11, 14, 50), NOW)).toBe('2026. 11. 11. 오후 2:50');
  });

  it('자정 전후: 한 시간 안이면 날짜가 바뀌어도 "N분 전", 넘으면 "어제"', () => {
    const justAfterMidnight = at(18, 0, 30);
    expect(show(at(17, 23, 50), justAfterMidnight)).toBe('40분 전');
    expect(show(at(17, 23, 20), justAfterMidnight)).toBe('어제 오후 11:20');
    expect(show(at(18, 0, 10), justAfterMidnight)).toBe('20분 전');
    // 자정 직전에는 그날 0시도 아직 오늘이다
    expect(show(at(18, 0, 0), at(18, 23, 59))).toBe('오늘 오전 12:00');
  });

  it('달이 바뀌는 날의 어제도 맞게 고른다', () => {
    const firstOfMonth = new Date(2026, 11, 1, 9, 0).getTime();
    const lastOfPrev = new Date(2026, 10, 30, 21, 15).getTime();
    expect(show(lastOfPrev, firstOfMonth)).toBe('어제 오후 9:15');
  });

  it('미래 시각은 상대 표현을 쓰지 않는다', () => {
    expect(show(NOW + 30_000, NOW)).toBe('오늘 오후 2:50');
    expect(show(at(19, 9, 0), NOW)).toBe('2026. 11. 19. 오전 9:00');
  });
});

describe('formatFileDate (PT-10)', () => {
  const at = (day: number, hour: number, minute: number, second = 0) =>
    new Date(2026, 10, day, hour, minute, second).getTime();
  const NOW = at(18, 14, 50);
  const show = (then: number) => formatFileDate(then, NOW, S.date);

  it('24시간 안은 로그 날짜와 같은 상대 표현이다', () => {
    expect(show(NOW - 30_000)).toBe('방금 전');
    expect(show(NOW - 12 * 60_000)).toBe('12분 전');
    expect(show(at(18, 9, 5))).toBe('오늘 오전 9:05');
    // 24시간이 아직 안 지난 어제
    expect(show(NOW - (24 * 60 * 60_000 - 1))).toBe('어제 오후 2:50');
  });

  it('24시간이 되는 순간부터는 날짜와 시각이다 (어제라도)', () => {
    expect(show(NOW - 24 * 60 * 60_000)).toBe('2026. 11. 17. 오후 2:50');
    expect(show(at(17, 9, 0))).toBe('2026. 11. 17. 오전 9:00');
    expect(show(at(1, 8, 30))).toBe('2026. 11. 01. 오전 8:30');
  });

  it('미래 시각(시계가 어긋난 파일)은 상대 표현을 쓰지 않는다', () => {
    expect(show(NOW + 60_000)).toBe('2026. 11. 18. 오후 2:51');
  });
});

describe('UI 언어별 포맷', () => {
  // 다른 테스트는 한국어를 전제로 한다
  afterEach(() => setLocale('ko'));

  const at = (day: number, hour: number, minute: number, second = 0) =>
    new Date(2026, 10, day, hour, minute, second).getTime();
  const NOW = at(18, 14, 50);
  const show = (then: number) => formatCommitDate(then / 1000, NOW, S.date);

  it('기본은 한국어, Intl 태그는 ko-KR·en-US', () => {
    expect(getLocale()).toBe('ko');
    expect(intlLocale()).toBe('ko-KR');
    expect(intlLocale('en')).toBe('en-US');
  });

  it('영어로 바꾸면 시계·날짜가 영어 꼴(AM/PM, 월/일/연)이고, 한국어로 되돌리면 원래 꼴이다', () => {
    setLocale('en');
    // `setLocale` 만 불러 문구 사전(`S.date` 의 "오늘")은 그대로이고 시각 포맷만 영어다.
    // ICU 판에 따라 시각과 AM/PM 사이가 일반 공백 또는 좁은 공백(U+202F)이다
    expect(show(at(18, 10, 21))).toMatch(/^오늘 10:21\sAM$/);
    expect(show(at(11, 14, 50))).toMatch(/^11\/11\/2026, 2:50\sPM$/);
    expect(formatFileDate(at(1, 8, 30), NOW, S.date)).toMatch(/^11\/01\/2026, 8:30\sAM$/);
    expect(formatDateTime(1_700_000_000)).toMatch(/^\d{2}\/\d{2}\/2023, \d{2}:\d{2}$/);
    expect(formatTime(at(18, 9, 5, 7))).toBe('09:05:07');

    setLocale('ko');
    expect(show(at(18, 10, 21))).toBe('오늘 오전 10:21');
    expect(show(at(11, 14, 50))).toBe('2026. 11. 11. 오후 2:50');
    expect(formatDateTime(1_700_000_000)).toMatch(/^2023\. \d{2}\. \d{2}\. \d{2}:\d{2}$/);
  });

  it('formatNumber 는 지금 언어의 천 단위 구분이고, 한국어는 옛 toLocaleString("ko-KR") 과 같다', () => {
    for (const n of [0, 7, 999, 1000, 12_345, 1_234_567, -4200, 1234.5678]) {
      expect(formatNumber(n)).toBe(n.toLocaleString('ko-KR'));
    }
    expect(formatNumber(1_234_567)).toBe('1,234,567');
    setLocale('en');
    expect(formatNumber(1_234_567)).toBe('1,234,567');
    expect(formatNumber(1234.5678)).toBe('1,234.568');
  });

  it('plural 은 1 일 때만 단수', () => {
    expect(plural(1, 'item', 'items')).toBe('item');
    expect(plural(0, 'item', 'items')).toBe('items');
    expect(plural(2, 'item', 'items')).toBe('items');
    expect(plural(-1, 'item', 'items')).toBe('items');
  });
});
