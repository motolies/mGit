import { type TerminalIo, TerminalView } from '@mgit/terminal';
import { Button, Icon, S } from '@mgit/ui';
import { useContext, useMemo } from 'react';
import { CommandContext } from '../../components/command-context';
import { hasModifier, rovingIndex } from '../../components/roving';
import { terminalPassKey } from '../../global-keys';
import { useAppStore } from '../../store';
import styles from './TerminalPanel.module.css';

/** 경로의 마지막 조각 */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 터미널 도구 창의 머리에 놓이는 탭 줄 (UX-08): 탭 고르기·닫기와 새 터미널 */
export function TerminalTabs() {
  const terminals = useAppStore((st) => st.terminals);
  const active = useAppStore((st) => st.activeTerminal);
  const open = useAppStore((st) => st.openTerminal);
  const close = useAppStore((st) => st.closeTerminal);
  const activate = useAppStore((st) => st.setActiveTerminal);
  const t = S.terminal;
  return (
    <div
      className={styles.tabs}
      data-terminal=""
      role="tablist"
      aria-label={t.title}
      onKeyDown={(e) => {
        if (hasModifier(e)) return;
        if ((e.key === 'Delete' || e.key === 'Backspace') && active !== null) {
          e.preventDefault();
          const index = terminals.findIndex((t) => t.id === active);
          const next = terminals[index + 1] ?? terminals[index - 1];
          close(active);
          setTimeout(() => {
            if (next) document.getElementById(`terminal-tab-${next.id}`)?.focus();
            else document.querySelector<HTMLElement>('[data-terminal-new]')?.focus();
          }, 0);
          return;
        }
        const next = rovingIndex(
          e.key,
          terminals.findIndex((t) => t.id === active),
          terminals.length,
          'horizontal',
        );
        const term = next === null ? undefined : terminals[next];
        if (!term) return;
        e.preventDefault();
        activate(term.id);
        document.getElementById(`terminal-tab-${term.id}`)?.focus();
      }}
    >
      {terminals.map((term) => (
        <span
          key={term.id}
          className={styles.tab}
          data-active={term.id === active ? 'true' : 'false'}
          data-exited={term.exitCode !== undefined ? 'true' : 'false'}
        >
          <button
            type="button"
            className={styles.tabName}
            id={`terminal-tab-${term.id}`}
            role="tab"
            aria-selected={term.id === active}
            tabIndex={term.id === active ? 0 : -1}
            title={term.cwd}
            onClick={() => activate(term.id)}
          >
            {term.title || baseName(term.cwd)}
            {term.exitCode !== undefined ? ` · ${t.exited(term.exitCode)}` : ''}
          </button>
          <button
            type="button"
            className={styles.tabButton}
            title={t.close}
            aria-label={t.close}
            tabIndex={-1}
            onClick={() => {
              const index = terminals.findIndex((t) => t.id === term.id);
              const next = terminals[index + 1] ?? terminals[index - 1];
              close(term.id);
              if (next) document.getElementById(`terminal-tab-${next.id}`)?.focus();
              else document.querySelector<HTMLElement>('[data-terminal-new]')?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        </span>
      ))}
      <button
        type="button"
        className={styles.tabButton}
        data-terminal-new=""
        onClick={() => open()}
        title={t.open}
        aria-label={t.open}
      >
        <Icon name="add" />
      </button>
    </div>
  );
}

/**
 * 터미널 도구 창의 내용 (UX-08): 탭마다 PTY 하나. 아래 도구 창 슬롯이 항상 마운트해 두고, 터미널 도구 창이
 * 보이지 않을 때(숨김·다른 도구 창)는 `display: none` 으로만 숨긴다. 뷰를 내리면 PTY 가 닫혀 실행 중인
 * 명령이 죽고, 다시 열 때 초기 입력이 또 실행되므로 탭이 있는 동안은 마운트해 둔다
 */
export function TerminalPanel() {
  const actions = useContext(CommandContext);
  const client = useAppStore((st) => st.client);
  const terminals = useAppStore((st) => st.terminals);
  const active = useAppStore((st) => st.activeTerminal);
  const visible = useAppStore((st) => st.dock.tool === 'terminal');
  const open = useAppStore((st) => st.openTerminal);
  const markExited = useAppStore((st) => st.markTerminalExited);
  const clearInput = useAppStore((st) => st.clearTerminalInput);
  const io = useMemo<TerminalIo>(
    () => ({
      open: (cwd, cols, rows, onEvent) =>
        client.ptyOpen(cwd, cols, rows, (e) =>
          onEvent(e.kind === 'data' ? e : { kind: 'exit', id: e.id, code: e.code ?? null }),
        ),
      write: (id, data) => client.ptyWrite(id, data),
      resize: (id, cols, rows) => client.ptyResize(id, cols, rows),
      close: (id) => client.ptyClose(id),
    }),
    [client],
  );
  const t = S.terminal;
  return (
    <div
      data-terminal=""
      className={styles.panel}
      style={visible ? undefined : { display: 'none' }}
    >
      {terminals.length === 0 ? (
        <div className={styles.empty}>
          <span>{t.empty}</span>
          <Button onClick={() => open()}>{t.open}</Button>
        </div>
      ) : null}
      {terminals.map((term) => (
        <div
          key={term.id}
          className={styles.slot}
          style={{ display: term.id === active ? 'block' : 'none' }}
        >
          <TerminalView
            cwd={term.cwd}
            io={io}
            passKey={(e) => terminalPassKey(e, actions)}
            initialInput={term.initialInput}
            onInitialInputSent={() => clearInput(term.id)}
            active={visible && term.id === active}
            onExit={(code) => markExited(term.id, code)}
          />
        </div>
      ))}
    </div>
  );
}
