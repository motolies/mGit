import { useEffect, useRef } from 'react';

/** `<dialog>` 를 `open` 에 맞춰 showModal/close 한다 (jsdom 은 showModal 이 없어 속성으로 대체) */
export function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (open && !el.open) {
      if (typeof el.showModal === 'function') {
        el.showModal();
      } else {
        el.setAttribute('open', '');
      }
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);
  return ref;
}
