import { matchShortcut, normalizeShortcut, shortcutFromEvent } from '@mgit/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../actions';
import { defaultShortcut, shortcutsConflict } from '../command-keymap';
import {
  captureCommandTarget,
  executeCommand,
  registerCommand,
  resolveCommand,
} from '../command-registry';
import { handleGlobalKey, terminalPassKey } from '../global-keys';

/** 실제 포커스와 이벤트 대상을 함께 구성한다. */
function event(key: string, init: KeyboardEventInit = {}, target = document.body) {
  const e = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}
/** 테스트용 명령. */
function action(id: string, shortcut: string, extra: Partial<Action> = {}): Action {
  return { id, shortcut, title: id, enabled: true, group: 'view', run: vi.fn(), ...extra };
}
/** 전역 키 실행의 부수 동작을 격리한다. */
function dispatch(e: KeyboardEvent, actions: Action[]) {
  handleGlobalKey(e, {
    actions,
    searchOpen: false,
    activeDoc: null,
    openPalette: vi.fn(),
    closeSearch: vi.fn(),
    closeActiveDoc: vi.fn(),
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('OS 키맵과 정규화', () => {
  it.each([true, false])('기본 키와 명시적 수정키를 OS별로 구분한다 mac=%s', (mac) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(mac ? 'MacIntel' : 'Win32');
    expect(normalizeShortcut('mod+shift+A')).toBe(mac ? 'command+shift+a' : 'ctrl+shift+a');
    expect(defaultShortcut('view.focusGraph')).toBe(mac ? 'mod+9' : 'alt+9');
    expect(defaultShortcut('app.settings')).toBe(mac ? 'mod+,' : 'ctrl+alt+s');
    expect(matchShortcut(event('s', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+S')).toBe(true);
    expect(matchShortcut(event('s', { metaKey: true, altKey: true }), 'Ctrl+Alt+S')).toBe(false);
    expect(shortcutFromEvent(event('k', { ctrlKey: true, metaKey: true }))).toBe('ctrl+command+k');
    expect(matchShortcut(event('k', { ctrlKey: true, metaKey: true }), 'ctrl+k')).toBe(false);
  });
  it('Shift 문장부호·IME·탐색키가 기록과 실행에서 일치한다', () => {
    expect(normalizeShortcut('ctrl+shift+[')).toBe(normalizeShortcut('Control+Shift+{'));
    expect(shortcutFromEvent(event('F2', { isComposing: true }))).toBeNull();
    expect(matchShortcut(event('F2', { isComposing: true }), 'f2')).toBe(false);
    for (const key of ['Tab', 'Escape', 'Home', 'End', 'Enter', ' ', 'ArrowDown']) {
      expect(shortcutFromEvent(event(key))).toBeNull();
    }
    expect(shortcutFromEvent(event('F2'))).toBe('f2');
  });
  it('같은 키라도 배타 영역은 허용하고 중첩/전역은 충돌이다', () => {
    const log = action('a', 'Control+F2', { scope: 'log' });
    expect(shortcutsConflict(log, action('b', 'ctrl+f2', { scope: 'diff' }))).toBe(false);
    expect(shortcutsConflict(log, action('b', 'ctrl+f2', { scope: 'log' }))).toBe(true);
    expect(shortcutsConflict(log, action('b', 'ctrl+f2'))).toBe(true);
  });
});

describe('공통 명령 라우팅', () => {
  it('사용자 키가 기본 키보다 우선하며 비활성이어도 다음 명령은 실행하지 않는다', () => {
    const first = action('default', 'f2');
    const custom = action('custom', 'f2', { customized: true, enabled: false });
    const e = event('F2');
    dispatch(e, [first, custom]);
    expect(e.defaultPrevented).toBe(true);
    expect(first.run).not.toHaveBeenCalled();
    expect(custom.run).not.toHaveBeenCalled();
  });
  it('가장 가까운 등록 영역과 실제 이벤트 대상을 사용하고 해제한다', () => {
    document.body.innerHTML = '<div id="outer"><button id="inner">log</button></div>';
    const outer = document.getElementById('outer') as HTMLElement;
    const inner = document.getElementById('inner') as HTMLElement;
    const run = vi.fn();
    const clear = registerCommand('log.reword', outer, { enabled: () => true, run });
    dispatch(event('F2', {}, inner), [action('log.reword', 'f2', { scope: 'log' })]);
    expect(run).toHaveBeenCalledTimes(1);
    clear();
    expect(resolveCommand('log.reword', inner)).toBeUndefined();
  });
  it('팔레트는 열기 전 대상만 기억하고 제거된 대상은 실행하지 않는다', () => {
    document.body.innerHTML =
      '<div id="log"><button id="source">commit</button></div><div data-command-palette><input id="query" /></div>';
    const source = document.getElementById('source') as HTMLElement;
    const log = document.getElementById('log') as HTMLElement;
    const run = vi.fn();
    const clear = registerCommand('log.reword', log, { enabled: () => true, run });
    source.focus();
    captureCommandTarget();
    document.getElementById('query')?.focus();
    expect(executeCommand('log.reword')).toBe(true);
    source.remove();
    expect(executeCommand('log.reword')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    clear();
  });
  it('입력란 복사·undo, 메뉴·모달·IME를 보호한다', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const copy = action('copy', 'ctrl+c');
    const undo = action('undo', 'ctrl+z');
    dispatch(event('c', { ctrlKey: true }, input), [copy]);
    dispatch(event('z', { ctrlKey: true }, input), [undo]);
    expect(copy.run).not.toHaveBeenCalled();
    expect(undo.run).not.toHaveBeenCalled();
    const f2 = action('f2', 'f2');
    document.body.innerHTML = '<div role="menu"></div>';
    dispatch(event('F2'), [f2]);
    expect(f2.run).not.toHaveBeenCalled();
  });
  it('터미널 전달도 사용자 키를 따르며 셸 제어키는 보존한다', () => {
    const actions = [
      action('view.terminal', 'ctrl+alt+t'),
      action('file.showDiff', 'ctrl+d'),
      action('commit.prepare', 'ctrl+k'),
    ];
    expect(terminalPassKey(event('t', { ctrlKey: true, altKey: true }), actions)).toBe(true);
    expect(terminalPassKey(event('F12', { altKey: true }), actions)).toBe(false);
    for (const e of [
      event('d', { ctrlKey: true }),
      event('k', { ctrlKey: true }),
      event('Tab'),
      event('Escape'),
    ]) {
      expect(terminalPassKey(e, actions)).toBe(false);
    }
  });
});
