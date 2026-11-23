import styles from './ConfirmDialog.module.css';
import { S } from './strings';

/** 영향 목록에 한 번에 보이는 최대 개수. 넘는 것은 "외 N개" 한 줄로 줄인다 */
export const DIALOG_ITEMS_MAX = 20;

/**
 * 대화상자의 영향 범위 목록 (파일 경로·tag 이름 등). `ConfirmDialog`·`PromptDialog` 가 함께 쓴다.
 * 앞의 20개만 보이고 나머지는 "외 N개" 한 줄이며, 목록이 없거나 비었으면 그리지 않는다
 */
export function DialogItems({ items }: { items?: readonly string[] }) {
  if (!items || items.length === 0) {
    return null;
  }
  return (
    <ul className={styles.items}>
      {items.slice(0, DIALOG_ITEMS_MAX).map((it) => (
        <li key={it}>{it}</li>
      ))}
      {items.length > DIALOG_ITEMS_MAX ? (
        <li>{S.confirm.more(items.length - DIALOG_ITEMS_MAX)}</li>
      ) : null}
    </ul>
  );
}
