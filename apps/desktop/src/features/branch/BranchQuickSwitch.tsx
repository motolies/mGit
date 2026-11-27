import { remoteBranchName } from '@mgit/ipc';
import { isImeKey, S } from '@mgit/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { rankMatches } from '../../components/fuzzy-match';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import styles from './BranchQuickSwitch.module.css';

/** 빠른 브랜치 전환 (BR-07, ⌘B): 입력으로 거르고 Enter 로 checkout */
export function BranchQuickSwitch({ onClose }: { onClose: () => void }) {
  const s = useSession((st) => ({
    labels: st.refs.labels,
    checkout: st.checkout,
  }));
  const listId = useId();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModal(true);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const candidates = useMemo(() => {
    const branches = s.labels.filter((l) => l.kind.kind !== 'tag' && !l.isCurrent);
    return rankMatches(branches, query, (l) => l.shortName).slice(0, 50);
  }, [s.labels, query]);

  useEffect(() => {
    if (!candidates[cursor]) return;
    document.getElementById(`${listId}-${cursor}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, listId, candidates]);

  /** 고른 항목으로 checkout */
  const pick = (index: number) => {
    const l = candidates[index];
    if (!l) {
      return;
    }
    onClose();
    if (l.kind.kind === 'remoteBranch') {
      void s.checkout({
        kind: 'remoteBranch',
        remote: l.kind.remote,
        name: remoteBranchName(l),
      });
    } else {
      void s.checkout({ kind: 'branch', name: l.shortName });
    }
  };

  return (
    <dialog ref={dialogRef} className={styles.dialog} onClose={onClose} onCancel={onClose}>
      <div className={styles.box}>
        <div className={styles.title}>{S.quickSwitch.title}</div>
        <input
          ref={inputRef}
          role="combobox"
          aria-label={S.quickSwitch.title}
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={candidates[cursor] ? `${listId}-${cursor}` : undefined}
          className={styles.input}
          value={query}
          placeholder={S.quickSwitch.placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (isImeKey(e)) {
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, Math.max(candidates.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(cursor);
            }
          }}
        />
        <div id={listId} className={styles.list} role="listbox" aria-label={S.quickSwitch.title}>
          {candidates.length === 0 ? (
            <div className={styles.empty} role="presentation">
              {S.quickSwitch.empty}
            </div>
          ) : (
            candidates.map((l, i) => (
              <div key={l.fullName} role="presentation">
                <button
                  type="button"
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === cursor}
                  tabIndex={-1}
                  className={styles.candidate}
                  data-active={i === cursor ? 'true' : 'false'}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                >
                  <span>{l.shortName}</span>
                  <span className={styles.kind}>
                    {l.kind.kind === 'remoteBranch' ? l.kind.remote : ''}
                  </span>
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
}
