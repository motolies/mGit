import type { IDisposable } from '@xterm/xterm';

// macOS WKWebView 의 한글 입력 보정.
//
// WKWebView 는 한글 IME 에서 compositionstart·update·end 를 보내지 않고(WebKit 버그 274700), 입력 이벤트만 보낸다.
// dev 앱에서 "한글이 되나?" 를 쳐서 기록한 순서 (입력 이벤트가 그 키의 keydown 보다 먼저 온다):
//   ㅎ → insertText "ㅎ", keydown(229)          ← 새 음절 시작
//   ㅏ → insertReplacementText "하", keydown(229) ← 조합 중인 음절 갱신
//   ㄱ → insertText "ㄱ"                          ← 앞 음절("한") 확정 + 새 음절
//   ␣  → keydown(32) 먼저, 그 뒤 insertText " "   ← IME 가 아닌 키는 keydown 이 먼저 온다
//   ⇧  → keydown(16) 만 따로 온다                 ← "았"·"있" 의 쌍자음 받침 도중이라 확정하면 안 된다
// xterm.js 6.0 은 insertText 만 셸로 보내고 insertReplacementText 는 버려서 음절마다 첫 자모만 남았다.
// 여기서는 한글 입력 이벤트를 xterm 에 닿기 전에(바깥 요소의 capture 단계) 가로채 음절을 모았다가 확정할 때
// `term.input` 으로 보낸다. 표준 조합 이벤트가 오는 동안은 손대지 않는다 (WebKit 이 고쳐지면 xterm 경로로 돌아간다)

/** 이 보정이 쓰는 터미널의 모양 (xterm `Terminal` 의 일부. 테스트에서 가짜로 바꾼다) */
export interface HangulTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly cursorX: number;
      readonly cursorY: number;
      readonly viewportY: number;
      readonly baseY: number;
    };
  };
  readonly options: { readonly fontFamily?: string; readonly fontSize?: number };
  input(data: string, wasUserInput?: boolean): void;
  onCursorMove(listener: () => void): IDisposable;
}

/** 붙인 보정. 끝나면 `dispose` */
export interface WkHangulInput extends IDisposable {
  /** xterm 이 처리하지 말아야 할 키인지: 조합 중의 keydown(229). xterm 이 textarea 차이로 자모를 또 보내지 않게 한다 */
  blocksKey(e: KeyboardEvent): boolean;
  /** 조합 중인 음절 (없으면 null). 테스트와 진단용 */
  readonly pending: string | null;
}

/** 조합 중인 음절을 확정하지 않는 키: 수정키 단독 (⇧ 은 쌍자음 입력 도중에 따로 온다) */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'Process']);

/** 첫 글자가 한글(자모·호환 자모·음절)인지 */
export function isHangul(text: string): boolean {
  const cp = text.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // 한글 자모
    (cp >= 0x3130 && cp <= 0x318f) || // 호환 자모 (ㄱ·ㅏ)
    (cp >= 0xa960 && cp <= 0xa97f) || // 자모 확장 A
    (cp >= 0xac00 && cp <= 0xd7af) || // 음절
    (cp >= 0xd7b0 && cp <= 0xd7ff) // 자모 확장 B
  );
}

/**
 * 터미널을 감싼 요소(`host`)에 WKWebView 한글 입력 보정을 붙인다. 한글 음절은 확정될 때 한 번에 셸로 가고, 조합 중인
 * 음절은 xterm 의 조합 미리보기 칸(`.composition-view`)에 커서 자리로 보인다
 */
export function attachWkHangulInput(term: HangulTerminal, host: HTMLElement): WkHangulInput {
  let pending: string | null = null;
  // 표준 조합 이벤트가 오는 중이면(다른 IME, 또는 WebKit 이 고쳐진 뒤) xterm 에 맡긴다
  let nativeComposing = false;

  /** 미리보기 칸을 커서 자리에 그린다. 화면을 위로 스크롤해 커서가 안 보이면 숨긴다 */
  const show = () => {
    const view = host.querySelector<HTMLElement>('.composition-view');
    if (!view || pending === null) return;
    const buffer = term.buffer.active;
    const screen = host.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || buffer.viewportY !== buffer.baseY || term.cols <= 0 || term.rows <= 0) {
      view.classList.remove('active');
      return;
    }
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    view.textContent = pending;
    view.style.left = `${Math.min(buffer.cursorX, term.cols - 1) * cellWidth}px`;
    view.style.top = `${buffer.cursorY * cellHeight}px`;
    view.style.height = `${cellHeight}px`;
    view.style.lineHeight = `${cellHeight}px`;
    view.style.fontFamily = term.options.fontFamily ?? '';
    view.style.fontSize = term.options.fontSize ? `${term.options.fontSize}px` : '';
    view.classList.add('active');
  };

  /** 미리보기 칸을 비운다 */
  const hide = () => {
    const view = host.querySelector<HTMLElement>('.composition-view');
    if (!view) return;
    view.textContent = '';
    view.classList.remove('active');
  };

  /** 조합 중인 음절을 확정해 셸로 보낸다 (사용자 입력으로 — 스크롤 등 xterm 의 입력 처리를 그대로 탄다) */
  const flush = () => {
    if (pending === null) return;
    const text = pending;
    pending = null;
    hide();
    term.input(text, true);
  };

  /** 한글 입력 이벤트를 xterm 에 닿기 전에 가로챈다 */
  const onInput = (event: Event) => {
    const e = event as InputEvent;
    if (nativeComposing || e.isComposing || !e.data) return;
    if (e.inputType === 'insertReplacementText') {
      // 조합 중인 음절만 갱신한다. 확정 뒤 늦게 오는 같은 값의 재확인은 버린다 (두 번 보내지 않게)
      if (pending !== null) {
        pending = e.data;
        show();
      }
      e.stopPropagation();
      return;
    }
    if (e.inputType !== 'insertText') return;
    if (isHangul(e.data)) {
      // 새 음절: 앞 음절을 확정하고 새로 모은다
      flush();
      pending = e.data;
      show();
      e.stopPropagation();
      return;
    }
    // 한글이 아닌 글자가 keydown 없이 오면 조합 중인 음절을 먼저 보낸다 (순서 유지). 글자는 xterm 이 처리한다
    flush();
  };

  /** IME 가 아닌 키(␣·?·Enter·화살표 등)는 xterm 이 처리하기 전에 조합 중인 음절을 먼저 보낸다 */
  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (pending === null || e.isComposing || e.keyCode === 229 || MODIFIER_KEYS.has(e.key)) return;
    flush();
  };

  /** 표준 조합이 시작되면 모아 둔 음절을 보내고 그 조합 동안은 xterm 에 맡긴다 */
  const onCompositionStart = () => {
    flush();
    nativeComposing = true;
  };
  const onCompositionEnd = () => {
    nativeComposing = false;
  };

  // 포커스를 잃으면 IME 도 조합을 끝낸다: 모아 둔 음절을 잃지 않게 보낸다
  const onFocusOut = () => flush();

  host.addEventListener('input', onInput, true);
  host.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('compositionstart', onCompositionStart, true);
  host.addEventListener('compositionend', onCompositionEnd, true);
  host.addEventListener('focusout', onFocusOut, true);
  // 셸의 반향으로 커서가 움직이면 미리보기도 따라간다
  const cursor = term.onCursorMove(() => {
    if (pending !== null) show();
  });

  return {
    blocksKey: (e) => e.type === 'keydown' && e.keyCode === 229 && pending !== null,
    get pending() {
      return pending;
    },
    dispose() {
      host.removeEventListener('input', onInput, true);
      host.removeEventListener('keydown', onKeyDown, true);
      host.removeEventListener('compositionstart', onCompositionStart, true);
      host.removeEventListener('compositionend', onCompositionEnd, true);
      host.removeEventListener('focusout', onFocusOut, true);
      cursor.dispose();
      pending = null;
      hide();
    },
  };
}
