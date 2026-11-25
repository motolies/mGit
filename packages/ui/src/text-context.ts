/** 텍스트 편집기와 터미널이 앱 메뉴에 제공하는 영역별 동작이다. */
export interface TextContextAdapter {
  copy?: () => void | Promise<void>;
  cut?: () => void | Promise<void>;
  paste?: () => void | Promise<void>;
  selectAll?: () => void;
  undo?: () => void;
  redo?: () => void;
}

export const TEXT_CONTEXT_EVENT = 'mgit-text-context';

/** 패키지 사이에 화면 의존성 없이 우클릭 위치의 편집 동작을 조회한다. */
export function queryTextContext(target: HTMLElement): TextContextAdapter | null {
  const detail: { adapter: TextContextAdapter | null } = { adapter: null };
  target.dispatchEvent(new CustomEvent(TEXT_CONTEXT_EVENT, { bubbles: true, detail }));
  return detail.adapter;
}
