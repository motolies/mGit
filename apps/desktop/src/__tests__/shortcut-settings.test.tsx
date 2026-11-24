import { createNullClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../actions';
import { SettingsDialog } from '../features/app/AppDialogs';
import { draftActions, hasShortcutConflicts } from '../features/app/ShortcutsDialog';
import { useAppStore } from '../store';
import { createAppStore } from '../store/app-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const actions: Action[] = [
  {
    id: 'log.reword',
    title: 'Reword',
    group: 'view',
    shortcut: 'f2',
    defaultShortcut: 'f2',
    scope: 'log',
    origin: 'intellij',
    enabled: true,
    run: vi.fn(),
  },
  {
    id: 'diff.nextHunk',
    title: 'Next hunk',
    group: 'view',
    shortcut: 'f7',
    defaultShortcut: 'f7',
    scope: 'diff',
    enabled: true,
    run: vi.fn(),
  },
  {
    id: 'view.refresh',
    title: 'Refresh',
    group: 'view',
    shortcut: 'mod+r',
    defaultShortcut: 'mod+r',
    scope: 'global',
    enabled: true,
    run: vi.fn(),
  },
];
let save: ReturnType<typeof vi.fn<(next: Record<string, string | null>) => void>>;

/** 저장된 재지정과 분리된 설정 초안을 연다. */
async function open(overrides: Record<string, string | null> = {}) {
  save = vi.fn((next: Record<string, string | null>) =>
    useAppStore.setState({ shortcutOverrides: next }),
  );
  act(() =>
    useAppStore.setState({
      settingsOpen: true,
      settingsPage: 'shortcuts',
      shortcutOverrides: overrides,
      externalAppsGet: async () => ({
        editor: '',
        editorCustom: '',
        terminal: '',
        terminalCustom: '',
      }),
      externalAppsSet: async () => {},
      autoFetchGet: async () => 5,
      autoFetchSet: async () => {},
      language: 'ko',
      setShortcutOverrides: save,
      setSettingsOpen: (settingsOpen) => useAppStore.setState({ settingsOpen }),
    }),
  );
  render(<SettingsDialog actions={actions} />);
  await tick();
}

/** 해당 동작의 기록 단추를 찾는다. */
function change(title: string) {
  return screen.getByRole('button', { name: `${title}: ${S.shortcuts.change}` });
}

beforeEach(installDialogStub);
afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() =>
    useAppStore.setState({ settingsOpen: false, settingsPage: 'general', shortcutOverrides: {} }),
  );
});

describe('단축키 초안', () => {
  it.each(['externalAppsSet', 'autoFetchSet'] as const)(
    '일반 설정 %s 저장 실패 시 창과 초안을 유지하고 재시도할 수 있다',
    async (method) => {
      await open();
      const failure = new Error('settings save failed');
      const client = createNullClient();
      const persist = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
      client[method] = persist;
      const store = createAppStore({ client, pickDirectory: async () => null });
      act(() =>
        useAppStore.setState({
          externalAppsSet: store.getState().externalAppsSet,
          autoFetchSet: store.getState().autoFetchSet,
        }),
      );
      fireEvent.click(change('Reword'));
      fireEvent.keyDown(change('Reword'), { key: 'F4' });
      if (method === 'autoFetchSet') {
        fireEvent.click(screen.getByRole('tab', { name: S.settings.general }));
        fireEvent.change(screen.getByLabelText(S.settings.autoFetch), { target: { value: '10' } });
      }
      fireEvent.click(screen.getByRole('button', { name: S.settings.save }));
      await tick();
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain('settings save failed');
      expect(store.getState().lastError).toContain('settings save failed');
      expect(save).not.toHaveBeenCalled();
      expect(useAppStore.getState().shortcutOverrides).toEqual({});
      fireEvent.click(screen.getByRole('button', { name: S.settings.save }));
      await tick();
      expect(persist).toHaveBeenCalledTimes(2);
      expect(store.getState().lastError).toBeNull();
      expect(save).toHaveBeenCalledWith({ 'log.reword': 'f4' });
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('기록을 명시적으로 시작해야 키가 바뀌며 취소하면 저장된 키와 null을 보존한다', async () => {
    await open({ 'view.refresh': null, legacy: 'ctrl+x' });
    fireEvent.keyDown(change('Reword'), { key: 'F4', code: 'F4' });
    fireEvent.click(change('Reword'));
    fireEvent.keyDown(change('Reword'), { key: 'F3', code: 'F3' });
    expect(screen.getByText('F3')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: S.confirm.cancel }));
    expect(useAppStore.getState().shortcutOverrides).toEqual({
      'view.refresh': null,
      legacy: 'ctrl+x',
    });
  });

  it('Tab은 탐색에 남겨 두고 Escape는 기록만 취소한다', async () => {
    await open();
    fireEvent.click(change('Reword'));
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fireEvent(change('Reword'), tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(change('Reword').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(change('Reword'));
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(change('Reword'), escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('F2')).toBeTruthy();
  });

  it('기록과 해제를 저장하며 알 수 없는 기존 ID도 남긴다', async () => {
    await open({ legacy: 'ctrl+x' });
    fireEvent.click(change('Reword'));
    fireEvent.keyDown(change('Reword'), { key: 'F4', code: 'F4' });
    fireEvent.click(screen.getByRole('button', { name: `Next hunk: ${S.shortcuts.clear}` }));
    fireEvent.click(screen.getByRole('button', { name: S.settings.save }));
    await tick();
    expect(save).toHaveBeenCalledWith({
      legacy: 'ctrl+x',
      'log.reword': 'f4',
      'diff.nextHunk': null,
    });
  });

  it('개별 복원과 모두 복원은 저장 전에는 초안에만 적용한다', async () => {
    await open({ 'log.reword': null, 'diff.nextHunk': 'f4' });
    fireEvent.click(screen.getByRole('button', { name: `Reword: ${S.shortcuts.reset}` }));
    expect(screen.getByText('F2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: S.shortcuts.resetAll }));
    expect(screen.getByText('F7')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: S.settings.save }));
    await tick();
    expect(save).toHaveBeenCalledWith({});
  });

  it('기존 충돌을 표시하고 저장을 막되 서로 배타적인 영역은 허용한다', async () => {
    await open({ 'view.refresh': 'F2' });
    expect(
      (screen.getByRole('button', { name: S.settings.save }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(S.shortcuts.saveConflict)).toBeTruthy();
    expect(useAppStore.getState().shortcutOverrides).toEqual({ 'view.refresh': 'F2' });
    expect(hasShortcutConflicts(draftActions(actions, { 'diff.nextHunk': 'f2' }))).toBe(false);
  });

  it('동작명과 표시 키로 검색하고 페이지 이동 후에도 초안을 보존한다', async () => {
    await open();
    fireEvent.click(change('Reword'));
    fireEvent.keyDown(change('Reword'), { key: 'F4', code: 'F4' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'f4' } });
    expect(change('Reword')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Next hunk: ${S.shortcuts.change}` })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: S.settings.general }));
    fireEvent.click(screen.getByRole('tab', { name: S.shortcuts.title }));
    expect(screen.getByText('F4')).toBeTruthy();
  });
});
