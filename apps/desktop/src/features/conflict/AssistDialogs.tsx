import type { ConflictRule, RuleAction } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useRef, useState } from 'react';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import h from '../history/history.module.css';
import styles from './assist.module.css';

/** 이름 변경 충돌 (CF-16): 남길 경로를 고른다 */
export function RenameConflictDialog() {
  const s = useSession((st) => ({
    open: st.assistDialog === 'rename',
    close: st.closeAssistDialog,
    groups: st.renameConflicts,
    labels: st.conflictLabels,
    resolve: st.resolveRename,
    busy: st.busy,
  }));
  const ref = useModal(s.open);
  if (!s.open) {
    return null;
  }
  const t = S.assist;
  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{t.renameTitle}</span>
          <span className={h.spacer} />
          <Button onClick={s.close}>{S.preview.close}</Button>
        </header>
        <ActionErrorBar />
        <div className={styles.note}>{t.renameMessage}</div>
        {s.groups.length === 0 ? (
          <div className={h.empty}>{t.renameNone}</div>
        ) : (
          s.groups.map((g) => (
            <div key={g.basePath} className={styles.renameRow}>
              <span className={styles.mono} title={g.basePath}>
                {g.basePath}
              </span>
              <Button disabled={s.busy} onClick={() => void s.resolve(g, 'ours')}>
                {t.renameKeep(s.labels?.ours ?? 'ours', g.oursPath)}
              </Button>
              <Button disabled={s.busy} onClick={() => void s.resolve(g, 'theirs')}>
                {t.renameKeep(s.labels?.theirs ?? 'theirs', g.theirsPath)}
              </Button>
            </div>
          ))
        )}
      </div>
    </dialog>
  );
}

const ACTIONS: RuleAction['kind'][] = ['ours', 'theirs', 'union', 'command'];

/** 편집 중인 규칙 (행 key 용 id 포함) */
type DraftRule = ConflictRule & { id: number };

/** 동작 값을 바꾼다 */
function withKind<T extends ConflictRule>(rule: T, kind: RuleAction['kind']): T {
  const action: RuleAction =
    kind === 'command'
      ? { kind: 'command', cmd: rule.action.kind === 'command' ? rule.action.cmd : '' }
      : { kind };
  return { ...rule, action };
}

/** 경로별 해결 규칙 (CF-18) */
export function ConflictRulesDialog() {
  const s = useSession((st) => ({
    open: st.assistDialog === 'rules',
    close: st.closeAssistDialog,
    rules: st.rules,
    results: st.ruleResults,
    save: st.saveRules,
    apply: st.applyRules,
    busy: st.busy,
  }));
  const ref = useModal(s.open);
  const [draft, setDraft] = useState<DraftRule[]>([]);
  const nextId = useRef(1);
  useEffect(() => {
    if (s.open) {
      setDraft(s.rules.map((r) => ({ ...r, id: nextId.current++ })));
    }
  }, [s.open, s.rules]);
  if (!s.open) {
    return null;
  }
  const t = S.assist;
  /** 저장용 (id 제거) */
  const plain = () => draft.map((d) => ({ glob: d.glob, action: d.action }));
  const update = (i: number, next: DraftRule) =>
    setDraft((d) => d.map((r, n) => (n === i ? next : r)));
  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{t.rulesTitle}</span>
          <span className={h.spacer} />
          <Button
            onClick={() =>
              setDraft((d) => [...d, { id: nextId.current++, glob: '', action: { kind: 'ours' } }])
            }
          >
            {t.ruleAdd}
          </Button>
          <Button variant="primary" disabled={s.busy} onClick={() => void s.save(plain())}>
            {t.rulesSave}
          </Button>
          <Button disabled={s.busy} onClick={() => void s.save(plain()).then(() => s.apply())}>
            {t.applyRules}
          </Button>
          <Button onClick={s.close}>{S.preview.close}</Button>
        </header>
        <ActionErrorBar />
        <div className={styles.note}>{t.rulesHint}</div>
        <table className={styles.rules}>
          <thead>
            <tr>
              <th>{t.ruleGlob}</th>
              <th>{t.ruleAction}</th>
              <th>{t.ruleCmd}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.map((r, i) => (
              <tr key={r.id}>
                <td>
                  <input
                    value={r.glob}
                    placeholder="*.lock"
                    onChange={(e) => update(i, { ...r, glob: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    value={r.action.kind}
                    onChange={(e) => update(i, withKind(r, e.target.value as RuleAction['kind']))}
                  >
                    {ACTIONS.map((k) => (
                      <option key={k} value={k}>
                        {t.ruleActions[k]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {r.action.kind === 'command' ? (
                    <input
                      value={r.action.cmd}
                      placeholder="pnpm install --lockfile-only"
                      onChange={(e) =>
                        update(i, { ...r, action: { kind: 'command', cmd: e.target.value } })
                      }
                    />
                  ) : null}
                </td>
                <td>
                  <Button onClick={() => setDraft((d) => d.filter((_, n) => n !== i))}>
                    {t.ruleRemove}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.results ? (
          <ul className={styles.results}>
            {s.results.length === 0 ? <li className={styles.note}>{t.rulesNone}</li> : null}
            {s.results.map((r) => (
              <li key={r.path} className={r.ok ? styles.ok : styles.bad}>
                {r.path} ← {r.glob} {r.ok ? '✓' : `✗ ${r.message}`}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </dialog>
  );
}

/** 해결 내역 리뷰 (CF-27): 자동 병합 → 저장본 diff, 또는 머지 commit 의 remerge-diff */
export function ReviewDialog() {
  const s = useSession((st) => ({ r: st.review, close: st.closeReview }));
  const ref = useModal(s.r !== null);
  const r = s.r;
  if (!r) {
    return null;
  }
  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{r.title}</span>
          <span className={`${h.muted} ${h.mono}`}>{r.subtitle}</span>
          <span className={h.spacer} />
          <Button onClick={s.close}>{S.preview.close}</Button>
        </header>
        <ActionErrorBar />
        {r.error ? <div className={h.error}>{r.error}</div> : null}
        {r.note ? <div className={styles.note}>{r.note}</div> : null}
        {r.loading ? (
          <div className={h.empty}>{S.history.loading}</div>
        ) : r.text.trim() === '' ? (
          <div className={h.empty}>{r.emptyText}</div>
        ) : (
          <pre className={styles.diff}>{r.text}</pre>
        )}
      </div>
    </dialog>
  );
}
