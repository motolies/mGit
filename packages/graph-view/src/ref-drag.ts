import type { DragEvent } from 'react';

/** 드래그로 옮길 수 있는 ref 의 dataTransfer 타입 (GRAPH-09) */
export const REF_DRAG_TYPE = 'text/mgit-ref';

/** 브랜치 라벨을 끌기 시작한다: 놓는 쪽(그래프 행)이 읽을 ref 이름을 싣는다 (GRAPH-09) */
export function startRefDrag(e: DragEvent<HTMLElement>, refName: string): void {
  e.dataTransfer.setData(REF_DRAG_TYPE, refName);
  e.dataTransfer.setData('text/plain', refName);
  e.dataTransfer.effectAllowed = 'link';
  e.stopPropagation();
}
