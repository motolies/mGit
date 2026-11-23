/** 토스트 종류 */
export type ToastKind = 'info' | 'success' | 'error';

/** 앱 내 토스트 + (창이 뒤에 있으면) OS 알림 요청 (UX-09) */
export interface Notice {
  kind: ToastKind;
  title: string;
  message?: string;
  /** 창이 포커스를 잃었으면 OS 알림도 보낸다 */
  os?: boolean;
}

type Handler = (notice: Notice) => void;

let handler: Handler | null = null;

/**
 * 세션 스토어가 앱 스토어를 직접 import 하지 않도록 둔 작은 허브.
 * 앱 스토어가 핸들러를 등록하고, 세션 스토어는 `notify` 만 부른다
 */
export const notifyHub = {
  /** 핸들러 등록 (앱 스토어). 이전 핸들러를 돌려준다 */
  setHandler(next: Handler | null): Handler | null {
    const prev = handler;
    handler = next;
    return prev;
  },
  /** 알림 보내기. 핸들러가 없으면 버린다 */
  notify(notice: Notice): void {
    handler?.(notice);
  },
};
