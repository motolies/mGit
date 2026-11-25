import { installSettingsStorage } from '@mgit/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ active: true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.active,
  invoke: native.invoke,
}));

beforeEach(() => {
  vi.resetModules();
  native.active = true;
  native.invoke.mockReset();
  localStorage.clear();
});
afterEach(() => {
  installSettingsStorage(undefined);
  vi.unstubAllGlobals();
});

describe('runtime initialization', () => {
  it('does not read native UI settings for a production app', async () => {
    native.invoke.mockResolvedValue({ kind: 'production', id: 'production', title: 'mGit' });
    const { initializeRuntime, runtimeProfile } = await import('../runtime');
    await initializeRuntime();
    expect(runtimeProfile().kind).toBe('production');
    expect(native.invoke.mock.calls).toEqual([['runtime_profile']]);
  });

  it('loads a native development snapshot before consumers read preferences', async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'runtime_profile')
        return { kind: 'development', id: 'a', title: 'mGit Dev · A' };
      if (command === 'ui_settings_snapshot') return { 'mgit.theme': 'light' };
    });
    const { initializeRuntime } = await import('../runtime');
    await initializeRuntime();
    const storage = await import('@mgit/storage');
    expect(storage.settingsStorage.getItem('mgit.theme')).toBe('light');
    expect(document.title).toBe('mGit Dev · A');
    storage.settingsStorage.setItem('mgit.theme', 'dark');
    await storage.flushSettings();
    expect(native.invoke).toHaveBeenCalledWith('ui_settings_set', {
      key: 'mgit.theme',
      value: 'dark',
    });
    expect(localStorage.getItem('mgit.theme')).toBeNull();
  });

  it('stops startup on a failed settings read without issuing writes', async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'runtime_profile')
        return { kind: 'test', id: 'run-a', title: 'mGit TEST · A' };
      throw new Error('cannot read settings');
    });
    const { initializeRuntime } = await import('../runtime');
    await expect(initializeRuntime()).rejects.toThrow('cannot read settings');
    expect(native.invoke.mock.calls.map(([name]) => name)).toEqual([
      'runtime_profile',
      'ui_settings_snapshot',
    ]);
  });

  it('uses the same web settings endpoint across server ports', async () => {
    native.active = false;
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url === '/__mgit/profile'
          ? { kind: 'development', id: 'a', title: 'mGit Dev · A' }
          : { 'mgit.language': 'ko' },
    }));
    vi.stubGlobal('fetch', fetcher);
    const { initializeRuntime } = await import('../runtime');
    await initializeRuntime();
    const storage = await import('@mgit/storage');
    expect(storage.settingsStorage.getItem('mgit.language')).toBe('ko');
    storage.settingsStorage.setItem('mgit.language', 'en');
    await storage.flushSettings();
    expect(fetcher).toHaveBeenCalledWith(
      '/__mgit/settings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ key: 'mgit.language', value: 'en' }),
      }),
    );
  });
});
