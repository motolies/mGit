import type { ReactNode } from 'react';
import styles from './ToolWindowFrame.module.css';

export interface ToolWindowFrameProps {
  /** 머리 왼쪽의 제목 (Commit, Pull Requests + 개수 등) */
  title: ReactNode;
  /** 머리 오른쪽의 도구 버튼들 (새로고침·모두 펼치기·접기 등). 내용마다 다르다 */
  tools?: ReactNode;
  /**
   * 머리의 제목 오른쪽에 놓는 탭 막대 (저장소 탭 Commit 도구 창의 변경 | Stash, W23). 주지 않으면 탭 없이 제목만이다.
   * 탭 패널은 `children` 이 그린다
   */
  tabs?: ReactNode;
  /** 내용: 폴더 탭 Commit 은 변경 트리 + 커밋 영역, 저장소 탭 Commit 은 고른 탭의 패널, Pull Requests 는 PR 목록 */
  children: ReactNode;
}

/**
 * 왼쪽 도구 창의 틀 (WS-05·17·22): 제목 머리(+ 선택한 탭 막대)와 내용 칸만 그리고 무엇이 들어오는지 모른다 — Commit 도구
 * 창(폴더 탭의 폴더 모드 W14, 저장소 탭의 저장소 1개 모드 W21·W23)과 Pull Requests 도구 창(W24)이 같은 틀에 다른 내용을
 * 싣는다 (머리 높이·글자·간격이 왼쪽 도구 창끼리 같게). W28 에서 Commit 도구 창 파일에서 이 이름으로 옮겼다
 */
export function ToolWindowFrame({ title, tools, tabs, children }: ToolWindowFrameProps) {
  return (
    <div className={styles.window}>
      <header className={styles.header}>
        <span className={styles.title}>{title}</span>
        {tabs}
        <span className={styles.spacer} />
        {tools}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}

/** 내용 칸의 안내 한 줄 (빈 상태·읽는 중·오류) */
export function ToolWindowNote({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={styles.note}
      data-tone={error ? 'error' : undefined}
      role={error ? 'alert' : undefined}
    >
      {text}
    </div>
  );
}
