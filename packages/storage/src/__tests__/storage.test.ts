import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSettingsStorage,
  flushSettings,
  installSettingsStorage,
  parseSnapshot,
  settingsStorage,
} from '../index';

afterEach(() => installSettingsStorage(undefined));

describe('environment settings', () => {
  it('preserves production localStorage and keeps development values separate', async () => {
    localStorage.setItem('mgit.theme', 'dark');
    expect(settingsStorage.getItem('mgit.theme')).toBe('dark');
    const persisted: Record<string, string> = {};
    const storage = createSettingsStorage({}, async (key, value) => {
      if (value === null) delete persisted[key];
      else persisted[key] = value;
    });
    installSettingsStorage(storage);
    expect(settingsStorage.getItem('mgit.theme')).toBeNull();
    settingsStorage.setItem('mgit.theme', 'light');
    expect(settingsStorage.getItem('mgit.theme')).toBe('light');
    expect(localStorage.getItem('mgit.theme')).toBe('dark');
    await flushSettings();
    const restarted = createSettingsStorage(persisted, async () => {});
    expect(restarted.getItem('mgit.theme')).toBe('light');
  });

  it('serializes requests and flush waits for every queued write', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: (string | null)[] = [];
    const storage = createSettingsStorage({}, async (_key, value) => {
      writes.push(value);
      if (value === 'first') await gate;
    });
    storage.setItem('key', 'first');
    storage.setItem('key', 'last');
    storage.removeItem('key');
    expect(writes).toEqual(['first']);
    expect(storage.getItem('key')).toBeNull();
    expect(storage.pending).toBe(true);
    release?.();
    await storage.flush();
    expect(writes).toEqual(['first', 'last', null]);
    expect(storage.pending).toBe(false);
  });

  it('retains failed writes and retries in order without overwriting newer values', async () => {
    let failed = true;
    const saved: string[] = [];
    const onError = vi.fn();
    const storage = createSettingsStorage(
      {},
      async (_key, value) => {
        if (failed) throw new Error('disk full');
        saved.push(value ?? 'removed');
      },
      onError,
    );
    storage.setItem('key', 'first');
    storage.setItem('key', 'second');
    await expect(storage.flush()).rejects.toThrow('disk full');
    expect(storage.pending).toBe(true);
    expect(storage.getItem('key')).toBe('second');
    failed = false;
    await storage.flush();
    expect(saved).toEqual(['first', 'second']);
    expect(onError).toHaveBeenCalled();
  });

  it('rejects corrupt snapshots instead of resetting stored preferences', () => {
    for (const value of [null, [], 'broken', { theme: 1 }]) {
      expect(() => parseSnapshot(value)).toThrow('Invalid UI settings snapshot');
    }
    const storage = createSettingsStorage(
      { __proto__: 'ignored', constructor: 'safe' },
      async () => {},
    );
    expect(storage.getItem('constructor')).toBe('safe');
  });
});
