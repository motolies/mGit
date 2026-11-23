import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppShortcutKey, type TerminalIo, TerminalView } from '../TerminalView';

const shared = vi.hoisted(() => ({
  lines: [] as string[],
  onData: null as ((data: string) => void) | null,
  fit: 0,
  resize: null as (() => void) | null,
  keyHandler: null as ((e: KeyboardEvent) => boolean) | null,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    /** 입력 구독을 잡아 둔다 */
    onData(cb: (data: string) => void) {
      shared.onData = cb;
      return { dispose() {} };
    }
    loadAddon() {}
    /** 키 판정 함수를 잡아 둔다 (false = xterm 이 처리하지 않음) */
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) {
      shared.keyHandler = cb;
    }
    open() {}
    write() {}
    /** 안내 문구를 기록한다 */
    writeln(line: string) {
      shared.lines.push(line);
    }
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    /** 맞춘 횟수를 센다 */
    fit() {
      shared.fit += 1;
    }
  },
}));

/** 입출력 스파이 */
function io(over: Partial<TerminalIo> = {}): TerminalIo {
  return {
    open: vi.fn(async () => 7),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...over,
  };
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  shared.lines.length = 0;
  shared.onData = null;
  shared.fit = 0;
  shared.resize = null;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      shared.resize = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe('TerminalView', () => {
  it('입력 쓰기가 실패해도 처리되지 않은 거부 없이 터미널에 알린다', async () => {
    const write = vi.fn(async () => {
      throw new Error('pty 닫힘');
    });
    render(<TerminalView cwd="/r" io={io({ write })} active />);
    await flush();
    shared.onData?.('a');
    await flush();
    expect(write).toHaveBeenCalled();
    expect(shared.lines.join('\n')).toContain('pty 닫힘');
  });

  it('초기 입력은 셸이 뜨면 한 번 보내고 onInitialInputSent 로 알린다 (다시 마운트돼도 다시 실행하지 않게)', async () => {
    const write = vi.fn(async () => {});
    const sent = vi.fn();
    render(
      <TerminalView
        cwd="/r"
        io={io({ write })}
        initialInput={'pnpm test\n'}
        onInitialInputSent={sent}
        active
      />,
    );
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(7, 'pnpm test\n');
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('초기 입력이 없으면 아무것도 보내지 않고 onInitialInputSent 도 부르지 않는다', async () => {
    const write = vi.fn(async () => {});
    const sent = vi.fn();
    render(
      <TerminalView
        cwd="/r"
        io={io({ write })}
        initialInput={null}
        onInitialInputSent={sent}
        active
      />,
    );
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  it('숨겨져 크기가 0 이면 맞추지도 PTY 크기를 바꾸지도 않는다', async () => {
    const resize = vi.fn(async () => {});
    const { container } = render(<TerminalView cwd="/r" io={io({ resize })} active={false} />);
    await flush();
    const before = shared.fit;
    const host = container.firstElementChild as HTMLElement;
    Object.defineProperty(host, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 0, configurable: true });
    shared.resize?.();
    await flush();
    expect(shared.fit).toBe(before);
    expect(resize).not.toHaveBeenCalled();
  });

  it('앱 단축키(⇧Esc)는 xterm 이 처리하지 않고 넘기며, 셸의 키(맨 Esc·Ctrl 조합·글자)는 그대로 처리한다 (W19 ③)', async () => {
    render(<TerminalView cwd="/r" io={io()} active />);
    await flush();
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    // 참 = xterm 이 처리한다 (셸로 간다), 거짓 = 앱으로 넘긴다
    expect(shared.keyHandler?.(key({ key: 'Escape', shiftKey: true }))).toBe(false);
    expect(shared.keyHandler?.(key({ key: 'Escape' }))).toBe(true);
    expect(shared.keyHandler?.(key({ key: 'c', ctrlKey: true }))).toBe(true);
    expect(shared.keyHandler?.(key({ key: 'a' }))).toBe(true);
    expect(shared.keyHandler?.(key({ key: 'Escape', shiftKey: true, metaKey: true }))).toBe(true);
  });

  it('넘길 키의 판정을 바꿀 수 있다 (passKey)', async () => {
    render(<TerminalView cwd="/r" io={io()} active passKey={(e) => e.key === 'F1'} />);
    await flush();
    expect(shared.keyHandler?.(new KeyboardEvent('keydown', { key: 'F1' }))).toBe(false);
    expect(
      shared.keyHandler?.(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true })),
    ).toBe(true);
  });

  it('isAppShortcutKey: ⇧Esc 만 앱 키다', () => {
    const k = (
      key: string,
      mods: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {},
    ) => ({
      key,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...mods,
    });
    expect(isAppShortcutKey(k('Escape', { shiftKey: true }))).toBe(true);
    expect(isAppShortcutKey(k('Escape'))).toBe(false);
    expect(isAppShortcutKey(k('Escape', { shiftKey: true, altKey: true }))).toBe(false);
    expect(isAppShortcutKey(k('1', { metaKey: true }))).toBe(false);
  });
});
