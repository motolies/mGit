import { remoteBranchName } from '@mgit/ipc';
import { isImeKey, S } from '@mgit/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../store';
import styles from './BranchQuickSwitch.module.css';

/** 단순 부분 일치 (대소문자 무시, 입력 글자 순서대로 포함) */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') {
    return true;
  }
  if (t.includes(q)) {
    return true;
  }
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) {
      i++;
      if (i === q.length) {
        return true;
      }
    }
  }
  return false;
}

/** 빠른 브랜치 전환 (BR-07, ⌘B): 입력으로 거르고 Enter 로 checkout */
export function BranchQuickSwitch({ onClose }: { onClose: () => void }) {
  const s = useSession((st) => ({
    labels: st.refs.labels,
    checkout: st.checkout,
  }));
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) {
      if (typeof el.showModal === 'function') {
        el.showModal();
      } else {
        el.setAttribute('open', '');
      }
    }
    inputRef.current?.focus();
  }, []);

  const candidates = useMemo(() => {
    const branches = s.labels.filter((l) => l.kind.kind !== 'tag' && !l.isCurrent);
    const exact = branches.filter((l) => l.shortName.toLowerCase().includes(query.toLowerCase()));
    const fuzzy = branches.filter((l) => !exact.includes(l) && fuzzyMatch(query, l.shortName));
    return [...exact, ...fuzzy].slice(0, 50);
  }, [s.labels, query]);

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
        <ul className={styles.list}>
          {candidates.length === 0 ? (
            <li className={styles.empty}>{S.quickSwitch.empty}</li>
          ) : (
            candidates.map((l, i) => (
              <li key={l.fullName}>
                <button
                  type="button"
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
              </li>
            ))
          )}
        </ul>
      </div>
    </dialog>
  );
}
