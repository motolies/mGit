import { createMockClient, createNullClient, type IpcClient } from '@mgit/ipc';
import { getLocale, S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import {
  applyLanguage,
  LANGUAGE_STORAGE_KEY,
  loadLanguagePreference,
  readSystemLocale,
  resolveLanguage,
  saveLanguagePreference,
} from '../store/language';

// 다른 테스트는 한국어 문구를 직접 비교하므로 테스트마다 한국어로 되돌린다
afterEach(() => {
  applyLanguage('ko');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('resolveLanguage', () => {
  it('system 이면 OS 로캘의 언어 부분이 ko 일 때만 한국어 (Rust Lang::from_code 와 같은 규칙)', () => {
    for (const code of ['ko', 'ko-KR', 'ko_KR.UTF-8', 'KO', 'Ko', ' ko-kr ', 'ko@x']) {
      expect(resolveLanguage('system', code), code).toBe('ko');
    }
    for (const code of ['en-US', 'en', 'fr-FR', 'kok', 'kor', 'k', 'C', 'POSIX', '한국어']) {
      expect(resolveLanguage('system', code), code).toBe('en');
    }
  });

  it('감지 실패(null)·빈 값은 영어', () => {
    expect(resolveLanguage('system', null)).toBe('en');
    expect(resolveLanguage('system', '')).toBe('en');
    expect(resolveLanguage('system', '  ')).toBe('en');
  });

  it('명시한 선호는 OS 로캘과 상관없이 그대로', () => {
    expect(resolveLanguage('ko', 'en-US')).toBe('ko');
    expect(resolveLanguage('ko', null)).toBe('ko');
    expect(resolveLanguage('en', 'ko-KR')).toBe('en');
  });
});

describe('언어 선호 저장', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('원문 문자열로 저장하고 다시 읽는다', () => {
    saveLanguagePreference('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(loadLanguagePreference()).toBe('en');
    saveLanguagePreference('system');
    expect(loadLanguagePreference()).toBe('system');
  });

  it('값이 없거나 모르는 값이면 영어', () => {
    expect(loadLanguagePreference()).toBe('en');
    for (const raw of ['fr', 'KO', '"en"', '']) {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, raw);
      expect(loadLanguagePreference(), raw).toBe('en');
    }
  });

  it('저장소 접근이 막혀 있으면 읽기는 영어, 쓰기는 조용히 넘어간다', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadLanguagePreference()).toBe('en');
    expect(() => saveLanguagePreference('en')).not.toThrow();
  });
});

describe('readSystemLocale', () => {
  it('읽은 값을 그대로 준다', async () => {
    expect(await readSystemLocale(async () => 'ko-KR')).toBe('ko-KR');
    expect(await readSystemLocale(async () => null)).toBeNull();
  });

  it('읽기가 실패하면(거부·바로 던짐) null', async () => {
    expect(await readSystemLocale(() => Promise.reject(new Error('ipc')))).toBeNull();
    expect(
      await readSystemLocale(() => {
        throw new Error('sync');
      }),
    ).toBeNull();
  });

  it('시간 제한 안에 답이 없으면 null 로 끝난다', async () => {
    vi.useFakeTimers();
    try {
      const pending = readSystemLocale(() => new Promise<string | null>(() => {}), 1000);
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('applyLanguage', () => {
  it('문구 사전·포맷 언어와 <html lang> 을 바꾼다', () => {
    applyLanguage('en');
    expect(S.settings.title).toBe('Settings');
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    applyLanguage('ko');
    expect(S.settings.title).toBe('설정');
    expect(document.documentElement.lang).toBe('ko');
  });
});

describe('앱 스토어의 화면 언어', () => {
  /** Rust 알림·OS 로캘을 가짜로 둔 스토어. 저장된 선호는 만들기 전에 넣어야 읽힌다 */
  function setup(over: Partial<IpcClient> = {}) {
    const setLanguage = vi.fn(async (_lang: 'ko' | 'en') => {});
    const systemLocale = vi.fn(async (): Promise<string | null> => 'ko-KR');
    const client: IpcClient = { ...createNullClient(), setLanguage, systemLocale, ...over };
    const store = createAppStore({ client, pickDirectory: async () => null });
    return { store, setLanguage, systemLocale };
  }

  it("setLanguage('en'): 저장하고 영어 사전·<html lang>·Rust 알림·uiLocale 을 바꾼다", async () => {
    const { store, setLanguage } = setup();
    expect(store.getState()).toMatchObject({ language: 'en', uiLocale: 'ko' });

    await store.getState().setLanguage('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(S.settings.title).toBe('Settings');
    expect(document.documentElement.lang).toBe('en');
    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(store.getState()).toMatchObject({ language: 'en', uiLocale: 'en' });

    await store.getState().setLanguage('ko');
    expect(S.settings.title).toBe('설정');
    expect(setLanguage).toHaveBeenLastCalledWith('ko');
    expect(store.getState()).toMatchObject({ language: 'ko', uiLocale: 'ko' });
  });

  it('언어를 바꾸면 시작할 때 받아 둔 Rust 문구 데이터(.gitignore 템플릿 라벨)를 새 언어로 다시 받는다', async () => {
    let rustLanguage: 'ko' | 'en' = 'ko';
    const { store } = setup({
      setLanguage: async (lang) => {
        rustLanguage = lang;
      },
      gitignoreTemplates: async () => [{ id: 'node', label: `node-${rustLanguage}` }],
    });
    await store.getState().setLanguage('en');
    await vi.waitFor(() =>
      expect(store.getState().templates).toEqual([{ id: 'node', label: 'node-en' }]),
    );
  });

  it('Rust 알림이 실패해도 화면 언어는 바뀌고 경고만 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = setup({ setLanguage: async () => Promise.reject(new Error('ipc')) });
    await store.getState().setLanguage('en');
    expect(store.getState().uiLocale).toBe('en');
    expect(S.settings.title).toBe('Settings');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('system 을 고르면 그때 OS 로캘을 읽고, 읽은 값은 다시 묻지 않는다', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    const { store, systemLocale } = setup();
    await store.getState().initLanguage();
    expect(systemLocale).not.toHaveBeenCalled();
    expect(store.getState().uiLocale).toBe('en');

    await store.getState().setLanguage('system');
    expect(systemLocale).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      language: 'system',
      uiLocale: 'ko',
      systemLocale: 'ko-KR',
    });
    await store.getState().setLanguage('en');
    await store.getState().setLanguage('system');
    expect(systemLocale).toHaveBeenCalledTimes(1);
  });

  it('initLanguage: 한국어 OS에서도 저장된 선택이 없으면 영어이며 OS 조회를 기다리지 않는다', async () => {
    const { store, setLanguage, systemLocale } = setup();
    await store.getState().initLanguage();
    expect(store.getState()).toMatchObject({ language: 'en', uiLocale: 'en', systemLocale: null });
    expect(systemLocale).not.toHaveBeenCalled();
    expect(S.settings.title).toBe('Settings');
    expect(document.documentElement.lang).toBe('en');
    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('명시적으로 저장한 시스템 언어 선택은 유지한다', async () => {
    saveLanguagePreference('system');
    const { store, setLanguage } = setup();
    await store.getState().initLanguage();
    expect(store.getState()).toMatchObject({ language: 'system', uiLocale: 'ko' });
    expect(setLanguage).toHaveBeenCalledWith('ko');
  });

  it('initLanguage: OS 로캘을 읽지 못하면(null·실패) 영어', async () => {
    saveLanguagePreference('system');
    const none = setup({ systemLocale: async () => null });
    await none.store.getState().initLanguage();
    expect(none.store.getState().uiLocale).toBe('en');
    expect(none.setLanguage).toHaveBeenCalledWith('en');

    applyLanguage('ko');
    const failed = setup({ systemLocale: () => Promise.reject(new Error('ipc')) });
    await failed.store.getState().initLanguage();
    expect(failed.store.getState().uiLocale).toBe('en');
  });

  it('initLanguage: OS 로캘 읽기가 시간 제한을 넘기면 기다리지 않고 영어로 정한다', async () => {
    saveLanguagePreference('system');
    const { store, setLanguage } = setup({ systemLocale: () => new Promise(() => {}) });
    await store.getState().initLanguage(10);
    expect(store.getState()).toMatchObject({ uiLocale: 'en', systemLocale: null });
    expect(setLanguage).toHaveBeenCalledWith('en');
  });

  it('initLanguage: 저장된 명시 선호(ko)면 OS 로캘이 영어여도 한국어', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ko');
    const systemLocale = vi.fn(async () => 'en-US');
    const { store, setLanguage } = setup({ systemLocale });
    await store.getState().initLanguage();
    expect(systemLocale).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ language: 'ko', uiLocale: 'ko' });
    expect(setLanguage).toHaveBeenCalledWith('ko');
    expect(document.documentElement.lang).toBe('ko');
  });
});

describe('목 클라이언트의 화면 언어', () => {
  it('OS 로캘 대신 브라우저 언어(navigator.language)를 주고, Rust 알림은 아무것도 하지 않는다', async () => {
    const client = createMockClient({ rows: 10 });
    expect(await client.systemLocale()).toBe(navigator.language);
    await expect(client.setLanguage('en')).resolves.toBeUndefined();
  });
});
