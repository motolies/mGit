import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from '../store/theme';

describe('resolveTheme', () => {
  it('system 이면 시스템 다크 여부를 따른다', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('명시한 선호는 시스템과 무관하다', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('html 요소의 data-theme 를 바꾼다', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('테마 저장', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('저장한 값을 다시 읽는다', () => {
    saveThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(loadThemePreference()).toBe('dark');
  });

  it('값이 없거나 이상하면 system', () => {
    expect(loadThemePreference()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(loadThemePreference()).toBe('system');
  });
});
