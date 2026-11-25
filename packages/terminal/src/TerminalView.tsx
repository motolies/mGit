import '@xterm/xterm/css/xterm.css';
import { TEXT_CONTEXT_EVENT, type TextContextAdapter } from '@mgit/ui';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

/** PTY 이벤트 (셸 쪽 `PtyEvent` 와 같은 모양) */
export type PtyEventLike =
  | { kind: 'data'; id: number; data: string }
  | { kind: 'exit'; id: number; code: number | null };

/** 터미널 뷰가 쓰는 PTY 입출력 */
export interface TerminalIo {
  open(
    cwd: string,
    cols: number,
    rows: number,
    onEvent: (event: PtyEventLike) => void,
  ): Promise<number>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  close(id: number): Promise<void>;
}

export interface TerminalViewProps {
  cwd: string;
  io: TerminalIo;
  /** 셸이 뜨면 바로 보낼 입력 (명령 + 줄바꿈) */
  initialInput?: string | null;
  /**
   * 초기 입력을 셸에 보낸 뒤 한 번 부른다. 호출자는 여기서 초기 입력을 지워, 화면을 다시 마운트해도(언어 전환 등)
   * 같은 명령이 다시 실행되지 않게 한다
   */
  onInitialInputSent?: () => void;
  /** 보이는 탭인지. 보이게 되면 크기를 다시 맞추고 포커스한다 */
  active: boolean;
  onExit?: (code: number | null) => void;
  fontSize?: number;
  /**
   * 터미널이 먹지 않고 앱에 넘길 키인지 (W19 ③). 참이면 셸로 보내지 않고 앱의 단축키 처리로 올려 보낸다.
   * 주지 않으면 `isAppShortcutKey`
   */
  passKey?: (e: KeyboardEvent) => boolean;
}

/**
 * 터미널이 앱에 넘기는 키의 기본 규칙 (W19 ③): ⇧Esc(아래 도구 창 숨기기). 셸에 필요한 키(맨 Esc, Ctrl 조합 등)는
 * 넘기지 않는다. macOS 의 ⌘ 조합(⌘1·⌘J 등 영역 단축키)은 xterm 이 처음부터 먹지 않아 따로 넘길 것이 없다
 */
export function isAppShortcutKey(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return e.key === 'Escape' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** xterm.js 터미널 하나 (UX-08). 마운트 시 PTY 를 열고 언마운트 시 닫는다 */
export function TerminalView({
  cwd,
  io,
  initialInput,
  onInitialInputSent,
  active,
  onExit,
  fontSize,
  passKey = isAppShortcutKey,
}: TerminalViewProps) {
  // 키 판정은 최신 것을 쓴다 (터미널을 다시 만들지 않는다)
  const passKeyRef = useRef(passKey);
  passKeyRef.current = passKey;
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const initialRef = useRef(initialInput ?? null);
  const onInitialSentRef = useRef(onInitialInputSent);
  onInitialSentRef.current = onInitialInputSent;

  // 터미널 생성·PTY 연결 (cwd 가 바뀌면 다시)
  useEffect(() => {
    const el = host.current;
    if (!el) {
      return;
    }
    const term = new Terminal({
      fontSize: fontSize ?? 12,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 앱 단축키(⇧Esc 등)는 xterm 이 처리하지 않게 한다: false 를 돌려주면 셸로 보내지도, 이벤트를 막지도 않아 앱의
    // 전역 단축키 처리(window)까지 올라간다
    term.attachCustomKeyEventHandler((e) => !passKeyRef.current(e));
    term.open(el);
    termRef.current = term;
    /** 터미널 선택과 paste API를 사용해 셸의 bracketed paste를 유지한다. */
    const context = (event: Event) => {
      const request = event as CustomEvent<{ adapter: TextContextAdapter | null }>;
      request.detail.adapter = {
        copy: term.hasSelection()
          ? () => navigator.clipboard.writeText(term.getSelection())
          : undefined,
        paste: async () => {
          term.paste(await navigator.clipboard.readText());
          term.focus();
        },
        selectAll: () => term.selectAll(),
      };
      event.stopPropagation();
    };
    el.addEventListener(TEXT_CONTEXT_EVENT, context);
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // 숨겨진 상태면 크기를 못 잰다
    }
    let disposed = false;
    let ptyId: number | null = null;
    /** PTY 호출 실패를 터미널 안에 알린다 (셸이 이미 끝났거나 코어가 거부) */
    const report = (e: unknown) => {
      if (!disposed) {
        term.writeln(`\r\n[mgit] ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void io
      .open(cwd, Math.max(term.cols, 10), Math.max(term.rows, 2), (event) => {
        if (disposed) {
          return;
        }
        if (event.kind === 'data') {
          term.write(event.data);
        } else {
          onExitRef.current?.(event.code);
        }
      })
      .then((id) => {
        if (disposed) {
          io.close(id).catch(() => {});
          return;
        }
        ptyId = id;
        idRef.current = id;
        const initial = initialRef.current;
        if (initial) {
          initialRef.current = null;
          io.write(id, initial).catch(report);
          onInitialSentRef.current?.();
        }
      })
      .catch(report);
    const dataSub = term.onData((data) => {
      if (ptyId !== null) {
        io.write(ptyId, data).catch(report);
      }
    });
    const ro = new ResizeObserver(() => {
      // 숨겨진 탭·패널은 크기가 0 이다. 그대로 맞추면 PTY 가 아주 작은 크기로 바뀐다
      if (el.clientWidth === 0 || el.clientHeight === 0) {
        return;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ptyId !== null) {
        io.resize(ptyId, term.cols, term.rows).catch(report);
      }
    });
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      if (ptyId !== null) {
        io.close(ptyId).catch(() => {});
      }
      el.removeEventListener(TEXT_CONTEXT_EVENT, context);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      idRef.current = null;
    };
  }, [cwd, io, fontSize]);

  // 보이게 되면 크기를 맞추고 포커스
  useEffect(() => {
    if (!active) {
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) {
      return;
    }
    const t = setTimeout(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = idRef.current;
      if (id !== null) {
        io.resize(id, term.cols, term.rows).catch(() => {});
      }
      // 탭 막대에서 방향키로 고를 때는 포커스를 막대에 유지한다.
      if (!document.activeElement?.closest('[role="tablist"]')) term.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [active, io]);

  return <div ref={host} style={{ width: '100%', height: '100%', minHeight: 0 }} />;
}
