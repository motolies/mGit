import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './prefs';

export interface EditorPreferences {
  zoomPercent: number;
  currentBlame: boolean;
  allBlame: boolean;
  changeMarkers: boolean;
  printWidth: number;
  formatOnSave: boolean;
  /** 괄호·따옴표 자동 닫기. 저장값이 없던 예전 설정도 켜짐으로 읽는다 */
  autoCloseBrackets: boolean;
}
/** 설정 입력: 배율과 나중에 더한 선택 항목은 빠져도 된다(지금 값·기본값을 유지) */
export type EditorPreferencesInput = Omit<EditorPreferences, 'zoomPercent' | 'autoCloseBrackets'> &
  Partial<Pick<EditorPreferences, 'zoomPercent' | 'autoCloseBrackets'>>;
const defaults: EditorPreferences = {
  zoomPercent: 100,
  currentBlame: true,
  allBlame: false,
  changeMarkers: true,
  printWidth: 200,
  formatOnSave: false,
  autoCloseBrackets: true,
};
export const ZOOM_STEPS: readonly number[] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
let value = { ...defaults, ...readPref('mgit.editor.preferences', defaults) };
const listeners = new Set<() => void>();
/** 저장된 설정은 유효한 범위로 정규화한다. */
export function normalizeEditorPreferences(next: EditorPreferencesInput): EditorPreferences {
  return {
    zoomPercent: ZOOM_STEPS.includes(next.zoomPercent ?? 100) ? (next.zoomPercent ?? 100) : 100,
    currentBlame: next.currentBlame === true,
    allBlame: next.allBlame === true,
    changeMarkers: next.changeMarkers === true,
    formatOnSave: next.formatOnSave === true,
    autoCloseBrackets: next.autoCloseBrackets !== false,
    printWidth:
      Number.isInteger(next.printWidth) && next.printWidth >= 40 && next.printWidth <= 1000
        ? next.printWidth
        : 200,
  };
}
value = normalizeEditorPreferences(value);
/** 설정 변경을 모든 열린 편집기에 전달한다. */
export function setEditorPreferences(next: EditorPreferencesInput): void {
  value = normalizeEditorPreferences({ ...value, ...next });
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

/** 공통 배율을 한 단계 이동하거나 기본 크기로 복원한다. */
export function changeEditorZoom(direction: -1 | 0 | 1): void {
  const index = ZOOM_STEPS.indexOf(value.zoomPercent);
  const zoomPercent =
    direction === 0
      ? 100
      : (ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))] ?? 100);
  setEditorPreferences({ ...value, zoomPercent });
}
