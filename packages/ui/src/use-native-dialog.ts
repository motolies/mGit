import { type SyntheticEvent, useCallback, useEffect, useRef } from 'react';

/**
 * `<dialog>` 를 `open` 에 맞춰 열고 닫는다. `close()` 는 close 이벤트를 다음 태스크로 미루므로, 코드가 닫은
 * 횟수를 세어 그 이벤트를 사용자의 취소로 보지 않는다 (같은 대화상자를 곧바로 다시 열어도 안전하다).
 * 돌려준 `dialogProps` 를 `<dialog>` 에 펼쳐 쓴다
 */
export function useNativeDialog(open: boolean, onCancel: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (open && !el.open) {
      // jsdom 에는 showModal 이 없다
      if (typeof el.showModal === 'function') {
        el.showModal();
      } else {
        el.setAttribute('open', '');
      }
    } else if (!open && el.open) {
      closing.current += 1;
      el.close();
    }
  }, [open]);

  /** 코드가 닫은 것이 아니면 사용자가 닫은 것이다 (취소 이벤트 없이 닫히는 경로 포함) */
  const onClose = useCallback(() => {
    if (closing.current > 0) {
      closing.current -= 1;
      return;
    }
    onCancel();
  }, [onCancel]);

  /** Esc: 닫기는 `open` 을 통해서만 한다 */
  const onCancelEvent = useCallback(
    (e: SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onCancel();
    },
    [onCancel],
  );

  return { ref, dialogProps: { onClose, onCancel: onCancelEvent } };
}
