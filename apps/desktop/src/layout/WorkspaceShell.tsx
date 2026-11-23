import { S } from '@mgit/ui';
import type { ReactNode } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { type SideSplit, useSideSplit } from './use-side-split';
import styles from './WorkspaceShell.module.css';

/**
 * 위 영역의 가로 분할 (왼쪽 도구 창 | 에디터 공간). 저장 키는 `react-resizable-panels:workspace` 이고
 * 탭 종류와 무관하게 앱 전역 1벌이다 (WS-04) — 저장소 탭이 같은 틀로 옮겨 오면(W21) 같은 값을 쓴다
 */
export const WORKSPACE_SPLIT: SideSplit = {
  layoutId: 'workspace',
  sideId: 'ws-left',
  mainId: 'ws-editor',
  defaultPercent: 20,
};

/** 패널 자체는 스크롤하지 않는다 (라이브러리 기본값은 auto). 스크롤은 안의 내용이 맡는다 */
const PANEL_STYLE = { overflow: 'hidden' } as const;

export interface WorkspaceShellProps {
  /** 왼쪽 도구 창의 내용 */
  left: ReactNode;
  /** 왼쪽 도구 창 영역의 이름 (`data-panel`). 포커스 이동이 이 이름으로 영역을 찾는다 */
  leftPanel: string;
  /** 왼쪽 도구 창이 펼쳐져 있는지 */
  leftOpen: boolean;
  /** 사용자가 분할선을 끌어 왼쪽 도구 창을 접었을 때 */
  onLeftCollapse: () => void;
  /** 에디터 공간의 내용 */
  editor: ReactNode;
}

/**
 * 워크스페이스의 위 영역 (WS-01): 왼쪽 도구 창과 에디터 공간을 가로로 나눈다. 내용은 슬롯으로만 받고
 * 무엇이 들어오는지 모른다 — 폴더·저장소 컨테이너가 같은 틀을 쓴다. 왼쪽 도구 창은 항상 렌더하고 접기만 한다
 */
export function WorkspaceShell({
  left,
  leftPanel,
  leftOpen,
  onLeftCollapse,
  editor,
}: WorkspaceShellProps) {
  const { groupRef, defaultLayout, onLayoutChanged } = useSideSplit(
    WORKSPACE_SPLIT,
    !leftOpen,
    onLeftCollapse,
  );
  return (
    <Group
      orientation="horizontal"
      className={styles.group}
      groupRef={groupRef}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel
        id={WORKSPACE_SPLIT.sideId}
        defaultSize={`${WORKSPACE_SPLIT.defaultPercent}%`}
        minSize="200px"
        collapsible
        className={styles.left}
        style={PANEL_STYLE}
      >
        {/* 접힌 동안에는 폭 0 으로 DOM 에 남으므로 포커스·보조 기술에서 뺀다 */}
        <div className={styles.area} tabIndex={-1} data-panel={leftPanel} inert={!leftOpen}>
          {left}
        </div>
      </Panel>
      {/* 접힌 동안에는 끌 수 없다 (다시 펴는 것은 띠 버튼·단축키로) */}
      <Separator
        className={styles.separator}
        disabled={!leftOpen}
        aria-label={S.workspace.resizeLeft}
      />
      <Panel
        id={WORKSPACE_SPLIT.mainId}
        minSize="320px"
        className={styles.editor}
        style={PANEL_STYLE}
      >
        <div className={styles.area} tabIndex={-1} data-panel="editor">
          {editor}
        </div>
      </Panel>
    </Group>
  );
}
