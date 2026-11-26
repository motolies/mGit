import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './prefs';

export interface EditorPreferences {
  currentBlame: boolean;
  allBlame: boolean;
  changeMarkers: boolean;
  printWidth: number;
  formatOnSave: boolean;
}
const defaults: EditorPreferences = {
  currentBlame: true,
  allBlame: false,
  changeMarkers: true,
  printWidth: 200,
  formatOnSave: false,
};
let value = { ...defaults, ...readPref('mgit.editor.preferences', defaults) };
const listeners = new Set<() => void>();
/** 저장된 설정은 유효한 범위로 정규화한다. */
export function normalizeEditorPreferences(next: EditorPreferences): EditorPreferences {
  return {
    currentBlame: next.currentBlame === true,
    allBlame: next.allBlame === true,
    changeMarkers: next.changeMarkers === true,
    formatOnSave: next.formatOnSave === true,
    printWidth:
      Number.isInteger(next.printWidth) && next.printWidth >= 40 && next.printWidth <= 1000
        ? next.printWidth
        : 200,
  };
}
value = normalizeEditorPreferences(value);
/** 설정 변경을 모든 열린 편집기에 전달한다. */
export function setEditorPreferences(next: EditorPreferences): void {
  value = normalizeEditorPreferences(next);
  writePref('mgit.editor.preferences', value);
  for (const listener of listeners) listener();
}
export const getEditorPreferences = () => value;
/** 전역 기본값을 구독하며 파일별 임시 선택은 편집기에서 유지한다. */
export function useEditorPreferences(): EditorPreferences {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getEditorPreferences);
}
