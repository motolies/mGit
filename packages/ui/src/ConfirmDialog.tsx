import { useEffect, useId, useRef } from 'react';
import { Button } from './Button';
import styles from './ConfirmDialog.module.css';
import { DialogItems } from './DialogItems';
import { S } from './strings';
import { useNativeDialog } from './use-native-dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** 영향 범위 목록 (파일 경로 등) */
  items?: readonly string[];
  expandableItems?: boolean;
  confirmLabel?: string;
  /** 파괴적 작업이면 확인 버튼을 빨갛게 */
  danger?: boolean;
  /** 두 번째 선택지 (예: "pull 후 push") */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 파괴적 작업 확인 대화상자 (SF-02). 네이티브 `<dialog>` 로 포커스 트랩·Esc 를 얻는다.
 * 영향 범위를 목록으로 보여 준 뒤 확인을 받는다. 제목이 대화상자의 이름, 설명이 설명이 된다 (W19 ③).
 * 열면 확인 단추에 포커스가 가고, 위험한 작업(`danger`)이면 취소 단추에 간다 — Enter 한 번에 지우지 않게
 */
export function ConfirmDialog({
  open,
  title,
  message,
  items,
  expandableItems,
  confirmLabel,
  danger,
  secondaryLabel,
  onSecondary,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { ref, dialogProps } = useNativeDialog(open, onCancel);
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // 열릴 때 시작 단추에 포커스를 준다. 대화상자는 늘 마운트돼 있어 autoFocus 는 처음 한 번만 돌고, 네이티브 대화상자가
  // 열며 고르는 곳은 첫 조작 요소(취소)라 직접 정한다. `showModal` 뒤에 돌도록 대화상자 훅보다 뒤에 둔다
  useEffect(() => {
    if (open) {
      (danger ? cancelRef : confirmRef).current?.focus();
    }
  }, [open, danger]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      {...dialogProps}
    >
      <form
        method="dialog"
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={messageId} className={styles.message}>
          {message}
        </p>
        <DialogItems items={items} expandable={expandableItems} />
        <div className={styles.actions}>
          <Button ref={cancelRef} type="button" onClick={onCancel}>
            {S.confirm.cancel}
          </Button>
          {secondaryLabel && onSecondary ? (
            <Button type="button" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            ref={confirmRef}
            type="submit"
            variant="primary"
            className={danger ? styles.danger : undefined}
          >
            {confirmLabel ?? S.confirm.ok}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
