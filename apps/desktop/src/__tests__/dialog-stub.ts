import { act } from '@testing-library/react';

const proto = HTMLDialogElement.prototype;
const original = { showModal: proto.showModal, close: proto.close };

/** 명세대로 `close` 이벤트를 다음 태스크에 보내는 `<dialog>` 흉내를 설치한다 */
export function installDialogStub(): void {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) {
      return;
    }
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
}

/** 원래 구현으로 되돌린다 */
export function removeDialogStub(): void {
  proto.showModal = original.showModal;
  proto.close = original.close;
}

/** 대기 중인 프라미스·close 이벤트까지 처리한다 */
export const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
