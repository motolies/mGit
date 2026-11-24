import { Button, formatShortcut, isImeKey, S, shortcutFromEvent } from '@mgit/ui';
import { useEffect, useState } from 'react';
import type { Action } from '../../actions';
import { shortcutsConflict } from '../../command-keymap';
import styles from './ShortcutsDialog.module.css';

/** 저장된 키와 분리한 초안으로 실제 적용 키를 계산한다. 없는 항목과 null을 구별한다. */
export function draftActions(
  actions: readonly Action[],
  draft: Record<string, string | null>,
): Action[] {
  return actions.map((action) => {
    const shortcut = Object.hasOwn(draft, action.id) ? draft[action.id] : action.defaultShortcut;
    const { shortcut: _previous, ...rest } = action;
    return shortcut ? { ...rest, shortcut } : rest;
  });
}

/** 함께 활성화되는 영역의 동일 키만 저장을 막는다. */
export function hasShortcutConflicts(actions: readonly Action[]): boolean {
  return actions.some((action, index) =>
    actions.slice(index + 1).some((other) => shortcutsConflict(action, other)),
  );
}

/** 적용 영역 이름은 명령 레지스트리와 같은 구분을 사용한다. */
function scopeLabel(scope: Action['scope']): string {
  const t = S.shortcuts;
  switch (scope) {
    case 'log':
      return t.scopeLog;
    case 'files':
      return t.scopeFiles;
    case 'diff':
      return t.scopeDiff;
    case 'commit':
      return t.scopeCommit;
    case 'branch':
      return t.scopeBranch;
    case 'editor':
      return t.scopeEditor;
    default:
      return t.scopeGlobal;
  }
}

/** 통합 설정 안의 단축키 편집기. 명시적으로 기록 중인 단추만 키를 받아 초안을 바꾼다. */
export function ShortcutSettings({
  actions,
  draft,
  onChange,
  active,
}: {
  actions: readonly Action[];
  draft: Record<string, string | null>;
  onChange: (draft: Record<string, string | null>) => void;
  active: boolean;
}) {
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => {
    if (!active) setRecording(null);
  }, [active]);
  const t = S.shortcuts;
  const effective = draftActions(actions, draft);
  const search = query.trim().toLocaleLowerCase();
  const filtered = effective.filter((action) =>
    [
      action.title,
      action.shortcut ?? '',
      action.shortcut ? formatShortcut(action.shortcut) : '',
      S.palette.groups[action.group],
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(search),
  );
  const groups = Object.keys(S.palette.groups) as Action['group'][];
  return (
    <div className={styles.shortcutPanel}>
      <p className={styles.hint}>{t.hint}</p>
      <div className={styles.header}>
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t.search}
          placeholder={t.search}
        />
        <Button
          onClick={() => {
            setRecording(null);
            onChange({});
          }}
        >
          {t.resetAll}
        </Button>
      </div>
      <div className={styles.list}>
        {groups.map((group) => {
          const items = filtered.filter((action) => action.group === group);
          return items.length ? (
            <section key={group} aria-label={S.palette.groups[group]}>
              <h3 className={styles.group}>{S.palette.groups[group]}</h3>
              <ul className={styles.groupList}>
                {items.map((action) => {
                  const overridden = Object.hasOwn(draft, action.id);
                  const conflicts = effective.filter(
                    (other) => other.id !== action.id && shortcutsConflict(action, other),
                  );
                  const capturing = recording === action.id;
                  return (
                    <li
                      key={action.id}
                      className={styles.item}
                      data-conflict={conflicts.length > 0}
                    >
                      <div className={styles.description}>
                        <span className={styles.name}>{action.title}</span>
                        <small className={styles.hint}>
                          {scopeLabel(action.scope)} ·{' '}
                          {action.origin === 'intellij' ? 'IntelliJ' : 'mGit'} ·{' '}
                          {draft[action.id] === null
                            ? t.disabled
                            : overridden
                              ? t.custom
                              : t.default}
                        </small>
                        {conflicts.length ? (
                          <small className={styles.error}>
                            {t.conflict(conflicts.map((other) => other.title).join(', '))}
                          </small>
                        ) : null}
                      </div>
                      <kbd className={styles.key}>
                        {action.shortcut ? formatShortcut(action.shortcut) : t.none}
                      </kbd>
                      <Button
                        aria-label={`${action.title}: ${t.change}`}
                        aria-pressed={capturing}
                        data-key-recording={capturing || undefined}
                        onClick={() => setRecording(capturing ? null : action.id)}
                        onBlur={() => setRecording(null)}
                        onKeyDown={(event) => {
                          if (!capturing) return;
                          if (event.key === 'Tab') {
                            setRecording(null);
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.key === 'Escape') {
                            setRecording(null);
                            return;
                          }
                          if (isImeKey(event)) return;
                          const shortcut = shortcutFromEvent(event);
                          if (shortcut) {
                            onChange({ ...draft, [action.id]: shortcut });
                            setRecording(null);
                          }
                        }}
                      >
                        {capturing ? t.recording : t.change}
                      </Button>
                      <Button
                        aria-label={`${action.title}: ${t.clear}`}
                        onClick={() => onChange({ ...draft, [action.id]: null })}
                      >
                        {t.clear}
                      </Button>
                      <Button
                        aria-label={`${action.title}: ${t.reset}`}
                        disabled={!overridden}
                        onClick={() => {
                          const next = { ...draft };
                          delete next[action.id];
                          onChange(next);
                        }}
                      >
                        {t.reset}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null;
        })}
      </div>
    </div>
  );
}
