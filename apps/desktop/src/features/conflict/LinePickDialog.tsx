import type { SideLabels } from '@mgit/ipc';
import { type ConflictOnly, stripCr } from '@mgit/merge-editor';
import { Button, S } from '@mgit/ui';
import { useMemo, useState } from 'react';
import { useModal } from '../../components/use-modal';
import h from '../history/history.module.css';
import styles from './assist.module.css';

/** 줄 고르기 요청 */
export interface LinePick {
  index: number;
  block: ConflictOnly;
  apply: (lines: string[]) => void;
}

/** 줄 단위 선택 (CF-14). 블록마다 새로 마운트해 앞 블록의 체크 상태가 이어지지 않게 한다 */
export function LinePickDialog({
  pick,
  labels,
  onClose,
}: {
  pick: LinePick | null;
  labels: SideLabels;
  onClose: () => void;
}) {
  if (!pick) {
    return null;
  }
  return <LinePickBody key={pick.index} pick={pick} labels={labels} onClose={onClose} />;
}

/** ours·theirs 의 줄을 체크해 순서대로 합친다 */
function LinePickBody({
  pick,
  labels,
  onClose,
}: {
  pick: LinePick;
  labels: SideLabels;
  onClose: () => void;
}) {
  const ref = useModal(true);
  const items = useMemo(
    () => ({
      ours: pick.block.ours.map((text, n) => ({ id: `o${n}`, text: stripCr(text) })),
      theirs: pick.block.theirs.map((text, n) => ({ id: `t${n}`, text: stripCr(text) })),
    }),
    [pick],
  );
  const [off, setOff] = useState<Set<string>>(new Set());
  const [theirsFirst, setTheirsFirst] = useState(false);
  const t = S.assist;
  const chosen = (list: { id: string; text: string }[]) =>
    list.filter((x) => !off.has(x.id)).map((x) => x.text);
  const result = theirsFirst
    ? [...chosen(items.theirs), ...chosen(items.ours)]
    : [...chosen(items.ours), ...chosen(items.theirs)];
  const toggle = (id: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const column = (title: string, list: { id: string; text: string }[]) => (
    <div>
      <div className={styles.originsTitle}>{title}</div>
      <ul className={styles.lineList}>
        {list.map((x) => (
          <li key={x.id} className={styles.lineItem} data-on={off.has(x.id) ? 'false' : 'true'}>
            <input type="checkbox" checked={!off.has(x.id)} onChange={() => toggle(x.id)} />
            <span>{x.text || ' '}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <dialog ref={ref} className={h.dialog} onClose={onClose}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{t.linePickTitle(pick.index + 1)}</span>
          <span className={h.spacer} />
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={theirsFirst}
              onChange={(e) => setTheirsFirst(e.target.checked)}
            />
            {t.linePickOrder}
          </label>
          <Button
            variant="primary"
            onClick={() => {
              pick.apply(result);
              onClose();
            }}
          >
            {t.linePickApply}
          </Button>
          <Button onClick={onClose}>{S.preview.close}</Button>
        </header>
        <div className={styles.lines}>
          {column(labels.ours, items.ours)}
          {column(labels.theirs, items.theirs)}
        </div>
        <div className={styles.originsTitle}>{t.linePickPreview}</div>
        <pre className={styles.preview}>{result.join('\n')}</pre>
      </div>
    </dialog>
  );
}
