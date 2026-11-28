import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachWkHangulInput,
  type HangulTerminal,
  isHangul,
  type WkHangulInput,
} from '../wk-hangul';

// dev 앱(macOS WKWebView)에서 "한글이 되나?" 를 쳐서 기록한 이벤트 순서를 그대로 재생한다.
// 입력 이벤트가 그 키의 keydown 보다 먼저 오고, 조합 이벤트(composition*)는 오지 않는다

let host: HTMLDivElement;
let textarea: HTMLTextAreaElement;
let view: HTMLDivElement;
let log: string[];
let hangul: WkHangulInput;
let moveCursor: () => void;
const term: HangulTerminal & { cursorX: number } = {
  cols: 80,
  rows: 24,
  cursorX: 0,
  buffer: {
    active: {
      get cursorX() {
        return term.cursorX;
      },
      cursorY: 1,
      viewportY: 0,
      baseY: 0,
    },
  },
  options: { fontFamily: 'Menlo', fontSize: 12 },
  /** 보정이 셸로 보낸 음절을 기록한다 */
  input(data: string) {
    log.push(`pty:${data}`);
  },
  /** 커서 이동 구독을 잡아 둔다 */
  onCursorMove(listener: () => void) {
    moveCursor = listener;
    return { dispose() {} };
  },
};

/** 입력 이벤트 (WKWebView 는 isComposing 이 늘 false) */
function input(inputType: string, data: string) {
  textarea.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
}

/** keydown. keyCode 는 init 으로 넣을 수 없어 따로 정의한다 */
function keydown(key: string, keyCode: number) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  textarea.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  log = [];
  term.cursorX = 0;
  host = document.createElement('div');
  host.innerHTML =
    '<div class="xterm-screen"></div><div class="xterm-helpers"><textarea></textarea><div class="composition-view"></div></div>';
  document.body.append(host);
  textarea = host.querySelector('textarea') as HTMLTextAreaElement;
  view = host.querySelector('.composition-view') as HTMLDivElement;
  // xterm 의 textarea 처리 흉내: 닿은 입력·키를 기록한다 (가로챈 이벤트는 여기 오지 않아야 한다)
  textarea.addEventListener('input', (e) => log.push(`xterm-input:${(e as InputEvent).data}`));
  textarea.addEventListener('keydown', (e) => {
    if (!hangul.blocksKey(e)) log.push(`xterm-key:${e.key}`);
  });
  hangul = attachWkHangulInput(term, host);
});

afterEach(() => {
  hangul.dispose();
  host.remove();
});

describe('WKWebView 한글 입력 보정', () => {
  it('기록한 "한글이 되나?" 순서를 음절 단위로 보내고 ␣·? 보다 앞에 둔다', () => {
    input('insertText', 'ㅎ');
    keydown('ㅎ', 229);
    input('insertReplacementText', '하');
    keydown('ㅏ', 229);
    input('insertReplacementText', '한');
    keydown('ㄴ', 229);
    input('insertReplacementText', '한'); // 같은 값의 재확인
    input('insertText', 'ㄱ');
    keydown('ㄱ', 229);
    input('insertReplacementText', '그');
    keydown('ㅡ', 229);
    input('insertReplacementText', '글');
    keydown('ㄹ', 229);
    input('insertReplacementText', '글');
    input('insertText', 'ㅇ');
    keydown('ㅇ', 229);
    input('insertReplacementText', '이');
    keydown('ㅣ', 229);
    input('insertReplacementText', '이');
    keydown(' ', 32);
    input('insertText', ' ');
    input('insertText', 'ㄷ');
    keydown('ㄷ', 229);
    input('insertReplacementText', '도');
    keydown('ㅗ', 229);
    input('insertReplacementText', '되');
    keydown('ㅣ', 229);
    input('insertReplacementText', '된');
    keydown('ㄴ', 229);
    input('insertReplacementText', '되'); // ㄴ 이 다음 음절로 넘어간다
    input('insertText', '나');
    keydown('ㅏ', 229);
    keydown('Shift', 16);
    input('insertReplacementText', '나');
    keydown('?', 191);

    expect(log).toEqual([
      'pty:한',
      'pty:글',
      'pty:이',
      'xterm-key: ',
      'xterm-input: ',
      'pty:되',
      'xterm-key:Shift',
      'pty:나',
      'xterm-key:?',
    ]);
    expect(hangul.pending).toBeNull();
  });

  it('⇧ 은 확정하지 않아 쌍자음 받침("있")이 한 음절로 간다', () => {
    input('insertText', 'ㅇ');
    keydown('ㅇ', 229);
    input('insertReplacementText', '이');
    keydown('ㅣ', 229);
    keydown('Shift', 16);
    input('insertReplacementText', '있');
    keydown('ㅆ', 229);
    keydown('Enter', 13);
    expect(log.filter((line) => line.startsWith('pty:'))).toEqual(['pty:있']);
    expect(log.at(-1)).toBe('xterm-key:Enter');
  });

  it('조합 중의 keydown(229)만 xterm 에서 막고, 확정 뒤 늦게 온 재확인은 다시 보내지 않는다', () => {
    const before = new KeyboardEvent('keydown');
    Object.defineProperty(before, 'keyCode', { value: 229 });
    expect(hangul.blocksKey(before)).toBe(false);
    input('insertText', 'ㅎ');
    expect(hangul.blocksKey(before)).toBe(true);
    keydown(' ', 32);
    expect(hangul.blocksKey(before)).toBe(false);
    input('insertReplacementText', 'ㅎ');
    expect(log).toEqual(['pty:ㅎ', 'xterm-key: ']);
  });

  it('조합 중인 음절은 커서 자리 미리보기에 보이고 확정하면 지운다', () => {
    input('insertText', 'ㅎ');
    input('insertReplacementText', '하');
    expect(view.textContent).toBe('하');
    expect(view.classList.contains('active')).toBe(true);
    term.cursorX = 3;
    moveCursor();
    expect(view.textContent).toBe('하');
    keydown('Enter', 13);
    expect(view.textContent).toBe('');
    expect(view.classList.contains('active')).toBe(false);
  });

  it('포커스를 잃으면 모아 둔 음절을 보낸다', () => {
    input('insertText', 'ㄱ');
    input('insertReplacementText', '가');
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(log).toEqual(['pty:가']);
  });

  it('표준 조합 이벤트가 오는 동안에는 가로채지 않는다 (다른 IME·WebKit 수정 뒤)', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input('insertText', '한');
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(log).toEqual(['xterm-input:한']);
    expect(hangul.pending).toBeNull();
  });

  it('한글이 아닌 글자는 xterm 에 그대로 넘기고, 그 전에 조합 중인 음절을 보낸다', () => {
    input('insertText', 'ㅁ');
    input('insertText', 'a');
    expect(log).toEqual(['pty:ㅁ', 'xterm-input:a']);
  });

  it('한글 판정은 자모·호환 자모·음절만 참이다', () => {
    expect(['ㄱ', 'ㅏ', '가', '힣', 'ᄀ'].map(isHangul)).toEqual([true, true, true, true, true]);
    expect(['a', '1', '?', ' ', '漢', 'あ', ''].map(isHangul)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
