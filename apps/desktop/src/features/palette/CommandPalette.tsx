import { formatShortcut, isImeKey, S } from '@mgit/ui';
import { Command } from 'cmdk';
import { useMemo } from 'react';
import type { Action } from '../../actions';
import styles from './CommandPalette.module.css';

/** 커맨드 팔레트 (UX-02, ⌘⇧P): cmdk 가 퍼지 검색·키보드 이동을 맡는다 */
export function CommandPalette({
  open,
  onOpenChange,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: Action[];
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Action[]>();
    for (const a of actions) {
      const list = map.get(a.group) ?? [];
      list.push(a);
      map.set(a.group, list);
    }
    return [...map.entries()];
  }, [actions]);

  return (
    <Command.Dialog
      data-command-palette=""
      open={open}
      onOpenChange={onOpenChange}
      label={S.actions.palette}
      className={styles.dialog}
      overlayClassName={styles.overlay}
      contentClassName={styles.content}
      onKeyDown={(e) => {
        // 한글 조합 중 Enter 로 실행되지 않게 (PoC-4)
        if (isImeKey(e) && e.key === 'Enter') {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <Command.Input className={styles.input} placeholder={S.palette.placeholder} autoFocus />
      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>{S.palette.empty}</Command.Empty>
        {groups.map(([group, list]) => (
          <Command.Group
            key={group}
            heading={S.palette.groups[group as keyof typeof S.palette.groups]}
            className={styles.group}
          >
            {list.map((a) => (
              <Command.Item
                key={a.id}
                value={`${a.title} ${a.id}`}
                disabled={!a.enabled}
                title={a.disabledReason}
                className={styles.item}
                onSelect={() => {
                  onOpenChange(false);
                  a.run();
                }}
              >
                <span className={styles.title}>{a.title}</span>
                {a.shortcut ? <kbd className={styles.kbd}>{formatShortcut(a.shortcut)}</kbd> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
