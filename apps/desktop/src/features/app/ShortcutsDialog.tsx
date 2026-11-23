import { Button, formatShortcut, S, shortcutFromEvent } from '@mgit/ui';
import type { Action } from '../../actions';
import { useModal } from '../../components/use-modal';
import { useAppStore } from '../../store';
import styles from './ShortcutsDialog.module.css';

/** 같은 단축키를 쓰는 다른 동작들 */
function conflictsOf(actions: readonly Action[], id: string, shortcut: string | undefined) {
  if (!shortcut) {
    return [];
  }
  return actions.filter((a) => a.id !== id && a.shortcut === shortcut).map((a) => a.title);
}

/** 단축키 사용자 정의 (UX-04): 입력란에 키를 누르면 바뀐다. 충돌은 빨갛게 */
export function ShortcutsDialog({ actions }: { actions: readonly Action[] }) {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);
  const overrides = useAppStore((s) => s.shortcutOverrides);
  const setOverrides = useAppStore((s) => s.setShortcutOverrides);
  const ref = useModal(open);
  if (!open) {
    return null;
  }
  const t = S.shortcuts;
  const groups = S.palette.groups;
  return (
    <dialog ref={ref} className={styles.dialog} onClose={() => setOpen(false)}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{t.title}</span>
          <span className={styles.hint}>{t.hint}</span>
          <span className={styles.spacer} />
          <Button onClick={() => setOverrides({})}>{t.resetAll}</Button>
          <Button onClick={() => setOpen(false)}>{t.close}</Button>
        </header>
        <ul className={styles.list}>
          {actions.map((a) => {
            const overridden = a.id in overrides;
            const conflicts = conflictsOf(actions, a.id, a.shortcut);
            return (
              <li key={a.id} className={styles.item} data-conflict={conflicts.length > 0}>
                <span className={styles.group}>{groups[a.group]}</span>
                <span className={styles.name}>{a.title}</span>
                <input
                  className={styles.key}
                  readOnly
                  value={a.shortcut ? formatShortcut(a.shortcut) : ''}
                  placeholder={t.none}
                  title={conflicts.length > 0 ? t.conflict(conflicts.join(', ')) : t.press}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      return;
                    }
                    e.preventDefault();
                    if (e.key === 'Backspace' || e.key === 'Delete') {
                      setOverrides({ ...overrides, [a.id]: null });
                      return;
                    }
                    const sc = shortcutFromEvent(e);
                    if (sc) {
                      setOverrides({ ...overrides, [a.id]: sc });
                    }
                  }}
                />
                {overridden ? (
                  <Button
                    onClick={() => {
                      const next = { ...overrides };
                      delete next[a.id];
                      setOverrides(next);
                    }}
                  >
                    {t.reset}
                  </Button>
                ) : (
                  <span className={styles.resetSlot} />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </dialog>
  );
}
