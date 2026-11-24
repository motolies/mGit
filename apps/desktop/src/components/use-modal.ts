import { captureFocusReturn } from '@mgit/ui';
import { useEffect, useRef } from 'react';

export { captureFocusReturn } from '@mgit/ui';

/** `<dialog>` 를 상태에 맞춰 열고 닫으며 취소·언마운트 뒤 출발 영역으로 포커스를 돌린다 */
export function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!open) {
      if (el.open) {
        const active = document.activeElement;
        const shouldRestore = active === document.body || active === null || el.contains(active);
        if (typeof el.close === 'function') el.close();
        else el.removeAttribute('open');
        if (shouldRestore) returnFocus.current?.();
      }
      return;
    }
    // StrictMode 의 가상 정리·재설정에서는 열린 dialog 를 닫지 않는다. native close 이벤트가
    // 뒤늦게 새 화면을 닫는 일을 막고, 최초 출발 요소를 그대로 유지한다.
    if (!el.open) {
      returnFocus.current = captureFocusReturn();
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    }
    return () => {
      const active = document.activeElement;
      if (!el.isConnected && (active === document.body || active === null || el.contains(active))) {
        returnFocus.current?.();
      }
    };
  }, [open]);
  return ref;
}
