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
const SHIFTED_KEY: Record<string, string> = { "'": '"' };

/**
 * 단축키 표기(`mod+shift+p`, `f8`, `escape`)와 키 이벤트를 맞춰 본다 (UX-03).
 * `mod` 는 macOS Cmd / 그 외 Ctrl. 수정키는 정확히 일치해야 한다
 */
export function matchShortcut(e: KeyLike, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  const wantMod = parts.includes('mod');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt');
  const mac = isMac();
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (mod !== wantMod || e.shiftKey !== wantShift || e.altKey !== wantAlt || other) {
    return false;
  }
  const pressed = e.key.toLowerCase();
  return pressed === key || (wantShift && SHIFTED_KEY[key] === pressed);
}

/** 단축키 표기를 화면용으로 (`mod+shift+p` → `⌘⇧P` / `Ctrl+Shift+P`) */
export function formatShortcut(shortcut: string): string {
  const mac = isMac();
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const keyLabel =
    key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  if (mac) {
    const map: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥' };
    return `${parts.map((p) => map[p] ?? p).join('')}${keyLabel}`;
  }
  const map: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt' };
  return [...parts.map((p) => map[p] ?? p), keyLabel].join('+');
}

/** 키 이벤트를 단축키 표기로 (`mod+shift+k`). 수정키만 눌렀거나 글자 단독이면 null (UX-04) */
export function shortcutFromEvent(e: KeyLike): string | null {
  const key = e.key.toLowerCase();
  if (['meta', 'control', 'shift', 'alt', 'dead', 'unidentified', 'process', ''].includes(key)) {
    return null;
  }
  const mac = isMac();
  const mod = mac ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) {
    parts.push('mod');
  }
  if (e.shiftKey) {
    parts.push('shift');
  }
  if (e.altKey) {
    parts.push('alt');
  }
  // 글자·숫자 단독은 입력과 겹치므로 수정키가 있어야 한다 (F 키 등은 허용)
  if (parts.length === 0 && key.length === 1) {
    return null;
  }
  parts.push(key);
  return parts.join('+');
}
