import { captureFocusReturn } from '@mgit/ui';
import { create } from 'zustand';
import { commandTarget } from '../../command-registry';

let returnFocus: (() => void) | null = null;
/** 검색 표시와 재진입 포커스를 공유하고 취소하면 실행한 영역으로 돌아간다. */
export const useSearchPanel = create<{
  mode: 'files' | 'content' | null;
  focusVersion: number;
  open: (mode: 'files' | 'content') => void;
  close: (restoreFocus?: boolean) => void;
}>((set, get) => ({
  mode: null,
  focusVersion: 0,
  open: (mode) => {
    if (get().mode === null) returnFocus = captureFocusReturn(commandTarget());
    set({ mode, focusVersion: get().focusVersion + 1 });
  },
  close: (restoreFocus = true) => {
    const restore = returnFocus;
    returnFocus = null;
    set({ mode: null });
    if (restoreFocus) queueMicrotask(() => restore?.());
  },
}));
