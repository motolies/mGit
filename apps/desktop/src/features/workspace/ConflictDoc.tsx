import { S } from '@mgit/ui';
import { useActiveTab, useAppStore, useFolder } from '../../store';
import type { ConflictTarget } from '../../store/workspace-store';
import { SessionConflictPane } from '../conflict/ConflictPane';
import { useDocSessionError } from './WorktreeDiffDoc';
import styles from './WorktreeDiffDoc.module.css';

/**
 * 폴더 탭의 충돌 머지 편집기 탭 (ED-06, W15): 문서의 저장소로 장부에서 세션을 찾아(활성 저장소가 아니라) 그 세션의 충돌
 * 화면을 그린다. 저장·한쪽 고르기·남기기/지우기는 그 세션에만 닿는다. 출처 커밋을 누르면 폴더 로그에서 그 저장소의 커밋을
 * 고른다 (가벼운 세션은 그래프를 읽지 않는다). 장부에 세션이 없으면(놓였다) 문서도 파생 목록에서 빠지므로 아무것도 그리지
 * 않는다. 범위 세션이 아닌 이 세션의 오류는 위 줄에 보인다
 */
export function ConflictDoc({ doc }: { doc: ConflictTarget }) {
  const folder = useActiveTab()?.id ?? null;
  const sessionId = useAppStore((s) =>
    folder === null ? null : (s.repoSessions[folder]?.[doc.repoPath]?.session ?? null),
  );
  const revealRow = useFolder((st) => st.revealTimelineCommit);
  const logShown = useAppStore((s) => s.dock.tool === 'git' && s.dock.gitTab === 'log');
  const toggleDock = useAppStore((s) => s.toggleDock);
  if (sessionId === null) {
    return null;
  }
  /**
   * 출처 커밋: 폴더 로그에서 그 저장소의 커밋을 골라 상세를 보이고 로그를 그 행으로 옮긴다 (W19 `revealTimelineCommit`.
   * 로그 탭이 안 보이면 연다)
   */
  const jump = (oid: string) => {
    revealRow?.(doc.repoPath, oid);
    if (!logShown) {
      toggleDock('git', 'log');
    }
  };
  return (
    <div className={styles.doc}>
      <DocError sessionId={sessionId} repoName={doc.repoName} />
      <div className={styles.pane}>
        <SessionConflictPane sessionId={sessionId} onJump={jump} />
      </div>
    </div>
  );
}

/** 이 문서의 세션 오류 줄 (범위 세션이 아닐 때만). 누르면 지운다 */
function DocError({ sessionId, repoName }: { sessionId: number; repoName: string }) {
  const { error, clear } = useDocSessionError(sessionId);
  if (error === null) {
    return null;
  }
  return (
    <div className={styles.bar}>
      <button type="button" className={styles.error} onClick={clear} title={error}>
        {S.repoSession.diffError(repoName, error)}
      </button>
    </div>
  );
}
