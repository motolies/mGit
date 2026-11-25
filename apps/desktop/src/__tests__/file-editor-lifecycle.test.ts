import { createSettingsStorage, installSettingsStorage } from '@mgit/storage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFileEditorLifecycle } from '../file-editor-lifecycle';

const lifecycle = vi.hoisted(() => ({
  close: undefined as (() => void) | undefined,
  destroy: vi.fn(async () => {}),
  guard: vi.fn(async () => true),
}));
vi.mock('../store/file-editor-close', () => ({ guardFileEditorClose: lifecycle.guard }));
vi.mock('../store/file-editor-store', () => ({
  fileEditors: { refreshAll: vi.fn(), hasDirty: () => false },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: lifecycle.destroy,
    onCloseRequested: vi.fn(),
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, callback: () => void) => {
    lifecycle.close = callback;
  },
}));

beforeEach(() => {
  lifecycle.destroy.mockClear();
  lifecycle.guard.mockResolvedValue(true);
  vi.spyOn(window, 'setInterval').mockReturnValue(
    0 as unknown as ReturnType<typeof window.setInterval>,
  );
});
afterEach(() => {
  installSettingsStorage(undefined);
  vi.restoreAllMocks();
});

it('waits for pending settings before destroying the native window, including mock apps', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage = createSettingsStorage({}, async () => gate);
  installSettingsStorage(storage);
  await installFileEditorLifecycle(true);
  storage.setItem('mgit.theme', 'dark');
  lifecycle.close?.();
  await Promise.resolve();
  expect(lifecycle.destroy).not.toHaveBeenCalled();
  release?.();
  await vi.waitFor(() => expect(lifecycle.destroy).toHaveBeenCalledOnce());
  expect(storage.pending).toBe(false);
});

it('keeps the native window open when settings cannot be saved', async () => {
  const storage = createSettingsStorage(
    {},
    async () => {
      throw new Error('disk full');
    },
    () => {},
  );
  installSettingsStorage(storage);
  await installFileEditorLifecycle(true);
  storage.setItem('mgit.theme', 'dark');
  const error = new Promise<CustomEvent>((resolve) => {
    window.addEventListener('mgit-settings-error', (event) => resolve(event as CustomEvent), {
      once: true,
    });
  });
  lifecycle.close?.();
  expect((await error).detail.message).toBe('disk full');
  expect(lifecycle.destroy).not.toHaveBeenCalled();
  expect(storage.pending).toBe(true);
});
