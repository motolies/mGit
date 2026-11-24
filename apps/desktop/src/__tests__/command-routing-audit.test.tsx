import { formatShortcut, matchShortcut, normalizeShortcut, shortcutFromEvent } from '@mgit/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../actions';
import {
  captureCommandTarget,
  executeCommand,
  registerCommand,
  resolveCommand,
} from '../command-registry';
import { CommandPalette } from '../features/palette/CommandPalette';
import { handleGlobalKey } from '../global-keys';

/** 브라우저 키 이벤트에 실제 입력 대상을 붙인다. */
function keyFor(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...options });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('명령 통합 회귀 검토', () => {
  it('숫자패드 더하기는 없는 Shift 수정키를 추가하지 않는다', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const keypad = keyFor(document.body, '+', { ctrlKey: true });
    const shifted = keyFor(document.body, '+', { ctrlKey: true, shiftKey: true });
    expect(shortcutFromEvent(keypad)).toBe('ctrl+plus');
    expect(shortcutFromEvent(shifted)).toBe('ctrl+shift+=');
    expect(normalizeShortcut('ctrl++')).toBe('ctrl+plus');
    expect(normalizeShortcut('ctrl+shift++')).toBe('ctrl+shift+=');
    expect(matchShortcut(keypad, 'ctrl+shift+=')).toBe(false);
    expect(matchShortcut(shifted, 'ctrl+plus')).toBe(false);
    expect(matchShortcut(keypad, 'ctrl++')).toBe(true);
    expect(formatShortcut('ctrl+plus')).toBe('Ctrl++');
  });

  it('실제 cmdk 팔레트의 포커스에서도 열기 전 영역 핸들러를 실행한다', async () => {
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const source = document.createElement('button');
    document.body.append(source);
    source.focus();
    captureCommandTarget();
    const run = vi.fn();
    const clear = registerCommand('log.reword', source, { enabled: () => true, run });
    const action: Action = {
      id: 'log.reword',
      title: 'Reword',
      group: 'repo',
      scope: 'log',
      get enabled() {
        return resolveCommand('log.reword')?.enabled() ?? false;
      },
      run: () => {
        executeCommand('log.reword');
      },
    };
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} actions={[action]} />);
    const input = screen.getByRole('combobox');
    input.focus();
    fireEvent.click(screen.getByRole('option', { name: 'Reword' }));
    expect(run).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    clear();
    HTMLElement.prototype.scrollIntoView = originalScroll;
  });

  it.each(['c', 'v', 'x', 'a', 'z', 'y'])(
    '입력 허용 명령을 Ctrl+%s로 재지정해도 입력기의 기본 편집 키를 보존한다',
    (key) => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
      const input = document.createElement('textarea');
      document.body.append(input);
      const run = vi.fn();
      const clear = registerCommand('commit.execute', input, { enabled: () => true, run });
      const action: Action = {
        id: 'commit.execute',
        title: 'Commit',
        group: 'repo',
        shortcut: `ctrl+${key}`,
        scope: 'commit',
        input: 'allow',
        customized: true,
        enabled: true,
        run,
      };
      const event = keyFor(input, key, { ctrlKey: true });
      handleGlobalKey(event, {
        actions: [action],
        openPalette: vi.fn(),
        searchOpen: false,
        closeSearch: vi.fn(),
        activeDoc: null,
        closeActiveDoc: vi.fn(),
      });
      expect(event.defaultPrevented).toBe(false);
      expect(run).not.toHaveBeenCalled();
      clear();
    },
  );
});
