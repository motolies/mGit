import { create } from 'zustand';

/** 검색 화면의 표시 상태를 팔레트와 공유한다. */
export const useSearchPanel = create<{
  mode: 'files' | 'content' | null;
  open: (mode: 'files' | 'content') => void;
  close: () => void;
}>((set) => ({ mode: null, open: (mode) => set({ mode }), close: () => set({ mode: null }) }));
