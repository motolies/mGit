import { expect, it, vi } from 'vitest';

it('공유 사전과 날짜 포맷의 초기 언어는 영어이며 한국어로 전환할 수 있다', async () => {
  // 테스트 픽스처의 한국어 초기화와 분리해 제품 모듈의 실제 초기값을 검사한다.
  vi.resetModules();
  const strings = await import('../strings');
  const locale = await import('../locale');
  expect(strings.S.settings.title).toBe('Settings');
  expect(locale.getLocale()).toBe('en');
  expect(locale.intlLocale()).toBe('en-US');
  strings.setStringsLocale('ko');
  expect(strings.S.settings.title).toBe('설정');
  expect(locale.intlLocale()).toBe('ko-KR');
});
