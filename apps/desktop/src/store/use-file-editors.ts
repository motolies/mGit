// 편집기 저장소(`fileEditors`)를 화면이 필요한 만큼만 구독하는 훅 (반응성 F1). 전역 버전 하나를 구독하면 바뀐 것과
// 무관한 화면까지 다시 그리므로, 문서·그림 재확인·탭 표시 주제로 나누거나 선택자로 고른 값이 바뀔 때만 다시 그린다.
import type { SessionId } from '@mgit/ipc';
import { useCallback, useSyncExternalStore } from 'react';
import { type EditorFile, fileEditors } from './file-editor-store';

/** 그 문서가 바뀔 때만 다시 그린다 (초안·상태·별칭·위치 요청). 다른 문서의 입력·저장에는 반응하지 않는다 */
export function useEditorDoc(doc: EditorFile): number {
  const subscribe = useCallback(
    (listener: () => void) => fileEditors.subscribeDoc(doc, listener),
    [doc],
  );
  return useSyncExternalStore(subscribe, () => fileEditors.docVersion(doc));
}

/** 그 문서의 그림 재확인 신호(`imageEpoch`). 검사마다 오르므로 미리보기처럼 그림을 보이는 화면만 쓴다 */
export function useEditorImageEpoch(doc: EditorFile): number {
  const subscribe = useCallback(
    (listener: () => void) => fileEditors.subscribeImage(doc, listener),
    [doc],
  );
  return useSyncExternalStore(subscribe, () => doc.imageEpoch);
}

/** 세션 하나의 탭 표시(저장 안 됨·충돌·오류) 묶음. 값이 같으면 같은 문자열이라 바뀔 때만 다시 그린다 */
export function useEditorMarks(session: SessionId | null): string {
  return useSyncExternalStore(fileEditors.subscribeMarks, () =>
    session === null ? '' : fileEditors.marksOf(session),
  );
}

/**
 * 어느 문서든 바뀔 때 `select` 를 다시 계산하고, 결과가 이전과 같으면(Object.is) 다시 그리지 않는다. 문자열·숫자·문서
 * 참조처럼 그대로 견줄 수 있는 값을 고른다
 */
export function useEditorSelect<T extends string | number | boolean | null | undefined | object>(
  select: () => T,
): T {
  return useSyncExternalStore(fileEditors.subscribe, select);
}
