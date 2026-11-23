import type { PlanCommit, RebaseAction, RebaseStep } from '@mgit/ipc';
import { Button, S, shortHash } from '@mgit/ui';
import { useEffect, useRef, useState } from 'react';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useSession } from '../../store';
import styles from './RebasePlanDialog.module.css';

type ActionKind = RebaseAction['kind'];
const ACTIONS: ActionKind[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** 편집 중인 한 줄 */
interface Row {
  commit: PlanCommit;
  kind: ActionKind;
  message: string;
  /** reword 메시지 전체를 불러오는 중 */
  loading?: boolean;
  /** 메시지 전체를 불러왔다 */
  loaded?: boolean;
}

/** 실행 전 검사. 코어가 거부할 플랜이면 사유 문구, 괜찮으면 null */
export function planError(rows: readonly Row[]): string | null {
  const kept = rows.find((r) => r.kind !== 'drop');
  if (!kept) {
    return rows.length > 0 ? S.rebase.allDropped : null;
  }
  return kept.kind === 'squash' || kept.kind === 'fixup' ? S.rebase.firstCannotSquash : null;
}

/** 줄 목록을 플랜 step 으로 */
export function rowsToSteps(rows: readonly Row[]): RebaseStep[] {
  return rows.map((r) => ({
    oid: r.commit.oid,
    action: r.kind === 'reword' ? { kind: 'reword', message: r.message } : { kind: r.kind },
  }));
}

/** 배열에서 i 를 j 로 옮긴 새 배열 */
export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) {
    return [...rows];
  }
  const next = [...rows];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}

/** 인터랙티브 rebase 플랜 편집기 (MRG-07): 순서 변경(드래그·버튼), 동작 선택, reword 메시지 */
export function RebasePlanDialog() {
  const s = useSession((st) => ({
    plan: st.rebasePlan,
    busy: st.busy,
    close: st.closeRebasePlan,
    run: st.runRebasePlan,
    verifyCommand: st.verifyCommand,
    commitMessageOf: st.commitMessageOf,
  }));
  const ref = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [autostash, setAutostash] = useState(true);
  const [updateRefs, setUpdateRefs] = useState(false);
  const [useExec, setUseExec] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commits = s.plan?.commits;

  useEffect(() => {
    setRows(
      (commits ?? []).map((c) => ({ commit: c, kind: 'pick' as ActionKind, message: c.subject })),
    );
    setError(null);
  }, [commits]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (s.plan && !el.open) {
      if (typeof el.showModal === 'function') {
        el.showModal();
      } else {
        el.setAttribute('open', '');
      }
    } else if (!s.plan && el.open) {
      el.close();
    }
  }, [s.plan]);

  if (!s.plan) {
    return null;
  }

  /** 한 줄 갱신 */
  const patch = (i: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));

  /** 동작을 바꾼다. reword 는 코어가 메시지를 통째로 바꾸므로 본문까지 불러와 입력란을 채운다 */
  const setKind = (i: number, kind: ActionKind) => {
    const row = rows[i];
    const load = kind === 'reword' && row !== undefined && !row.loaded;
    patch(i, { kind, ...(load ? { loading: true } : {}) });
    if (!load) {
      return;
    }
    const { oid } = row.commit;
    void s.commitMessageOf(oid).then((message) => {
      setRows((rs) =>
        rs.map((r) => {
          if (r.commit.oid !== oid) {
            return r;
          }
          // 못 읽으면 제목만으로 덮어쓰지 않도록 pick 으로 돌린다 (사유는 오류 줄에 보인다)
          return message === null
            ? { ...r, kind: 'pick', loading: false }
            : { ...r, message: message.trimEnd(), loading: false, loaded: true };
        }),
      );
    });
  };

  /** 실행 */
  const run = async () => {
    const problem = planError(rows);
    setError(problem);
    if (problem) {
      return;
    }
    await s.run({
      onto: s.plan?.onto ?? null,
      steps: rowsToSteps(rows),
      autostash,
      updateRefs,
      exec: useExec && s.verifyCommand ? s.verifyCommand : null,
    });
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={s.close} onCancel={s.close}>
      <div className={styles.box}>
        <div className={styles.title}>
          {s.plan.onto ? S.rebase.title(s.plan.onto) : S.rebase.titleRoot}
        </div>
        <div className={styles.hint}>{S.rebase.hint}</div>
        {s.plan.hasMerges ? <div className={styles.error}>{S.rebase.mergesFlattened}</div> : null}
        {rows.length === 0 ? (
          <div className={styles.hint}>{S.rebase.empty}</div>
        ) : (
          <ol className={styles.list}>
            {rows.map((r, i) => (
              <li
                key={r.commit.oid}
                className={styles.row}
                data-kind={r.kind}
                data-dragging={dragging === i ? 'true' : 'false'}
                draggable
                onDragStart={(e) => {
                  setDragging(i);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragging !== null) {
                    e.preventDefault();
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging !== null) {
                    setRows((rs) => moveRow(rs, dragging, i));
                  }
                  setDragging(null);
                }}
                onDragEnd={() => setDragging(null)}
              >
                <span className={styles.handle}>⋮⋮</span>
                <select
                  className={styles.select}
                  value={r.kind}
                  onChange={(e) => setKind(i, e.target.value as ActionKind)}
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {S.rebase.actions[a]}
                    </option>
                  ))}
                </select>
                <span className={styles.hash}>{shortHash(r.commit.oid)}</span>
                <span className={styles.subject} title={r.commit.subject}>
                  {r.commit.subject}
                </span>
                <span className={styles.author}>{r.commit.authorName}</span>
                <span className={styles.move}>
                  <button
                    type="button"
                    className={styles.small}
                    disabled={i === 0}
                    onClick={() => setRows((rs) => moveRow(rs, i, i - 1))}
                    title={S.rebase.up}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.small}
                    disabled={i === rows.length - 1}
                    onClick={() => setRows((rs) => moveRow(rs, i, i + 1))}
                    title={S.rebase.down}
                  >
                    ↓
                  </button>
                </span>
                {r.kind === 'reword' ? (
                  <textarea
                    className={styles.message}
                    rows={2}
                    value={r.loading ? '' : r.message}
                    disabled={r.loading}
                    placeholder={r.loading ? S.rebase.messageLoading : S.rebase.message}
                    onChange={(e) => patch(i, { message: e.target.value })}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <div className={styles.options}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={autostash}
              onChange={(e) => setAutostash(e.target.checked)}
            />
            {S.rebase.autostash}
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={updateRefs}
              onChange={(e) => setUpdateRefs(e.target.checked)}
            />
            {S.rebase.updateRefs}
          </label>
          {s.verifyCommand ? (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={useExec}
                onChange={(e) => setUseExec(e.target.checked)}
              />
              {S.rebase.exec(s.verifyCommand)}
            </label>
          ) : null}
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
        <ActionErrorBar />
        <div className={styles.actions}>
          <Button onClick={s.close}>{S.confirm.cancel}</Button>
          <Button
            variant="primary"
            disabled={s.busy || rows.length === 0 || rows.some((r) => r.loading)}
            onClick={() => void run()}
          >
            {S.rebase.run}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
