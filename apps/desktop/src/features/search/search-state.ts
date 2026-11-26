import { captureFocusReturn } from '@mgit/ui';
import { create } from 'zustand';
import { commandTarget } from '../../command-registry';

let returnFocus: (() => void) | null = null;
/** 검색 창 종류: 빠른 열기(⌘P), 최근 파일(⌘E — 같은 창을 최근 파일만 보이게 연다), 내용 검색(⌘⌥F) */
export type SearchMode = 'files' | 'recent' | 'content';
/** 검색 표시와 재진입 포커스를 공유하고 취소하면 실행한 영역으로 돌아간다. */
export const useSearchPanel = create<{
  mode: SearchMode | null;
  focusVersion: number;
  open: (mode: SearchMode) => void;
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
