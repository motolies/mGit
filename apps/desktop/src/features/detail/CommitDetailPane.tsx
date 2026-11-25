import { settingsStorage } from '@mgit/storage';
import { S } from '@mgit/ui';
import type { ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import styles from './CommitDetailPane.module.css';

export interface CommitDetailPaneProps {
  files: ReactNode;
  info: ReactNode;
  /** 바깥 컨테이너가 이미 git-detail 포커스 영역을 제공하면 중복하지 않는다. */
  focusArea?: boolean;
}

/** 단일·멀티 저장소와 범위 상세가 같은 높이 설정을 공유하는 변경 파일/정보 분할이다. */
export function CommitDetailPane({ files, info, focusArea = false }: CommitDetailPaneProps) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    storage: settingsStorage,
    id: 'git-detail',
  });
  return (
    <div
      className={styles.pane}
      tabIndex={focusArea ? -1 : undefined}
      data-panel={focusArea ? 'git-detail' : undefined}
    >
      <Group orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <Panel id="gitdetail-files" defaultSize="60%" minSize="44px" style={{ overflow: 'hidden' }}>
          <div className={styles.files}>
            <div className={styles.bar}>
              <span className={styles.title}>{S.detail.changedFiles}</span>
            </div>
            {files}
          </div>
        </Panel>
        <Separator className={styles.separator} aria-label={S.detail.resize} />
        <Panel id="gitdetail-info" defaultSize="40%" minSize="44px" style={{ overflow: 'hidden' }}>
          <div className={styles.info}>{info}</div>
        </Panel>
      </Group>
    </div>
  );
}

/** 로딩·오류·빈 상태를 분할 상단의 같은 자리와 여백으로 보여 준다. */
export function DetailFilesMessage({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div className={styles.message} role={error ? 'alert' : undefined}>
      {children}
    </div>
  );
}
