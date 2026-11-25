import { settingsStorage } from '@mgit/storage';
import { S } from '@mgit/ui';
import type { ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import styles from './CommitToolSplit.module.css';

/** 변경 목록 | 커밋 영역 세로 분할의 저장 id (앱 전역 1벌). localStorage 키는 `react-resizable-panels:commit-tool` */
export const COMMIT_SPLIT_LAYOUT_ID = 'commit-tool';
/** 위 칸(변경 목록)·아래 칸(커밋 영역)의 패널 id. 저장된 배치의 키이자 DOM id 다 */
export const COMMIT_CHANGES_PANEL_ID = 'commit-changes';
export const COMMIT_MESSAGE_PANEL_ID = 'commit-message';
/**
 * 커밋 영역의 기본 크기와 최소 크기. 기본 33% 는 1400×900 에서 지금까지의 커밋 영역 높이(약 135px)다. 최소 104px 은
 * 메시지 한 줄 + 대상 한 줄 + 커밋되지 않을 저장소 한 줄 + 단추 한 줄이 들어가는 높이 — 960×600 에서 작업 띠가 두 줄
 * 떠 있어도 변경 목록에 4줄 넘게 남는다
 */
const COMMIT_MESSAGE_DEFAULT = '33%';
const COMMIT_CHANGES_DEFAULT = '67%';
const COMMIT_MESSAGE_MIN = '104px';
/** 변경 목록의 최소 크기 (두 줄) */
const COMMIT_CHANGES_MIN = '52px';

export interface CommitToolSplitProps {
  /** 위 칸: 변경 목록 (트리나 안내) */
  changes: ReactNode;
  /** 아래 칸: 커밋 영역 */
  commit: ReactNode;
}

/**
 * Commit 도구 창 내용의 세로 분할 (W19): 위 = 변경 목록, 아래 = 커밋 영역. 분할선을 끌어 높이를 바꾸고 크기는 앱 전역
 * 1벌로 저장된다. 커밋 영역은 정한 최소 높이 아래로 줄지 않아 단추가 늘 보인다. 폴더 모드만 쓴다 — 저장소 1개 모드의
 * 커밋 입력(`CommitForm`, 1400×900 에서 193px 고정 높이)은 `ChangesPanel` 안에 붙어 있고 이 분할의 기본 크기(33%)·
 * 최소 크기(104px)보다 커서 싣지 않았다 (W21·W23 판단)
 */
export function CommitToolSplit({ changes, commit }: CommitToolSplitProps) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    storage: settingsStorage,
    id: COMMIT_SPLIT_LAYOUT_ID,
  });
  return (
    <Group orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <Panel
        id={COMMIT_CHANGES_PANEL_ID}
        defaultSize={COMMIT_CHANGES_DEFAULT}
        minSize={COMMIT_CHANGES_MIN}
        style={{ overflow: 'hidden' }}
      >
        <div className={styles.split}>{changes}</div>
      </Panel>
      <Separator className={styles.separator} aria-label={S.commitTool.resize} />
      <Panel
        id={COMMIT_MESSAGE_PANEL_ID}
        defaultSize={COMMIT_MESSAGE_DEFAULT}
        minSize={COMMIT_MESSAGE_MIN}
        style={{ overflow: 'hidden' }}
      >
        <div className={styles.split}>{commit}</div>
      </Panel>
    </Group>
  );
}
