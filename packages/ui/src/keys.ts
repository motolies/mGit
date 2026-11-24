// 키 입력 보조 (PoC-4 한글 IME 가드, UX-03 단축키)

/** 키 이벤트가 꼭 갖춰야 할 최소 모양 (React·DOM 이벤트 공용) */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * 한글 조합 중인 키 입력인지. Safari 는 `compositionend` 가 Enter keydown 보다 먼저 와
 * `isComposing` 이 false 일 수 있으므로 `keyCode === 229` 도 함께 본다
 */
export function isImeKey(e: KeyLike): boolean {
  const native = e.nativeEvent ?? e;
  return native.isComposing === true || native.keyCode === 229;
}

/** macOS(·iOS) 웹뷰인지. 단축키 판정·표기와 OS 별 문구("Finder 에서 보기")가 함께 쓴다 */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
}

/** macOS 는 Cmd, 그 외는 Ctrl 을 "주 수정키"로 본다 */
export function isPrimaryModifier(e: KeyLike): boolean {
  const mac = isMac();
  return mac ? e.metaKey : e.ctrlKey;
}

/** 단축키 표기용 수정키 접두 (`⌘` 또는 `Ctrl+`) */
export function primaryModifierLabel(): string {
  const mac = isMac();
  return mac ? '⌘' : 'Ctrl+';
}

/**
 * Shift 와 함께 누르면 웹뷰에 따라 `e.key` 가 다른 글자로 오는 문장부호 (US 배열): 표기의 키 → Shift 글자.
 * 기본 단축키에 새로 쓰는 키만 둔다 — 이미 쓰던 조합(`mod+shift+]` 등)의 판정은 바꾸지 않는다
 */
const SHIFTED_KEY: Record<string, string> = {
  "'": '"',
  '[': '{',
  ']': '}',
  ',': '<',
  '.': '>',
  '/': '?',
  ';': ':',
  '-': '_',
  '=': '+',
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
};

/** 기록·표시·충돌·실행이 공유하는 정규형. mod는 현재 OS의 실제 수정키로 바꾼다. */
export function normalizeShortcut(shortcut: string, mac = isMac()): string | null {
  const parts = shortcut.toLowerCase().trim().split('+');
  let key = parts.pop() ?? '';
  if (!key && parts.at(-1) === '') {
    parts.pop();
    key = 'plus';
  }
  const mods = new Set<string>();
  for (const part of parts) {
    const name = part.trim();
    const mod =
      name === 'mod'
        ? mac
          ? 'command'
          : 'ctrl'
        : ['cmd', 'meta', 'command'].includes(name)
          ? 'command'
          : ['control', 'ctrl'].includes(name)
            ? 'ctrl'
            : ['option', 'alt'].includes(name)
              ? 'alt'
              : name;
    if (!['ctrl', 'command', 'alt', 'shift'].includes(mod)) return null;
    mods.add(mod);
  }
  if (!key || ['control', 'meta', 'alt', 'shift', 'dead', 'unidentified', 'process'].includes(key))
    return null;
  if (key === 'esc') key = 'escape';
  if (key === ' ') key = 'space';
  if (key === 'plus' && mods.has('shift')) key = '=';
  if (mods.has('shift')) key = Object.keys(SHIFTED_KEY).find((k) => SHIFTED_KEY[k] === key) ?? key;
  return [...['ctrl', 'command', 'alt', 'shift'].filter((m) => mods.has(m)), key].join('+');
}

/** 실제 수정키를 모두 기록하여 Ctrl과 Command를 구분한다. */
function eventShortcut(e: KeyLike): string | null {
  return normalizeShortcut(
    [
      ...(e.ctrlKey ? ['ctrl'] : []),
      ...(e.metaKey ? ['command'] : []),
      ...(e.altKey ? ['alt'] : []),
      ...(e.shiftKey ? ['shift'] : []),
      e.key === ' ' ? 'space' : e.key,
    ].join('+'),
  );
}

/** 추가 수정키를 허용하지 않는 공통 키 판정. */
export function matchShortcut(e: KeyLike, shortcut: string): boolean {
  if (isImeKey(e)) return false;
  const wanted = normalizeShortcut(shortcut);
  return wanted !== null && wanted === eventShortcut(e);
}

/** 공통 정규형을 OS에 맞춰 표시한다. */
export function formatShortcut(shortcut: string): string {
  const parts = (normalizeShortcut(shortcut) ?? shortcut).split('+');
  const key = parts.pop() ?? '';
  const label =
    key === 'plus'
      ? '+'
      : key.length === 1
        ? key.toUpperCase()
        : key.charAt(0).toUpperCase() + key.slice(1);
  const map: Record<string, string> = isMac()
    ? { ctrl: '⌃', command: '⌘', alt: '⌥', shift: '⇧' }
    : { ctrl: 'Ctrl', command: 'Command', alt: 'Alt', shift: 'Shift' };
  return [...parts.map((p) => map[p] ?? p), label].join(isMac() ? '' : '+');
}

/** 기록 중에만 호출한다. 일반 탐색키·취소키·IME와 단독 문자는 재지정하지 않는다. */
export function shortcutFromEvent(e: KeyLike): string | null {
  if (isImeKey(e) || ['tab', 'escape'].includes(e.key.toLowerCase())) return null;
  if (
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    (e.key.length === 1 ||
      [
        'home',
        'end',
        'enter',
        'space',
        'arrowup',
        'arrowdown',
        'arrowleft',
        'arrowright',
        'f10',
      ].includes(e.key.toLowerCase()))
  )
    return null;
  return eventShortcut(e);
}
