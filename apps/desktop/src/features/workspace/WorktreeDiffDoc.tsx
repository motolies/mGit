import type { SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useActiveTab, useAppStore, useScopeSessionId, useSessionOf } from '../../store';
import { entryInArea } from '../../store/session-store';
import type { WorktreeDiffTarget } from '../../store/workspace-store';
import { SessionDiffPane } from '../diff/DiffPane';
import styles from './WorktreeDiffDoc.module.css';

/**
 * 세션 문서(작업 트리 diff·충돌 탭)가 그 자리에서 보일 세션 오류 (W14·W15): 범위 세션의 오류는 앱 위쪽 오류 줄이 보이므로,
 * 이 문서의 세션이 범위 세션이 아닐 때(활성 저장소가 잠겨 다른 저장소를 가리킨다)만 돌려준다. 없으면 `error` 가 null
 */
export function useDocSessionError(sessionId: SessionId): {
  error: string | null;
  clear: () => void;
} {
  const s = useSessionOf(sessionId, (st) => ({
    actionError: st.actionError,
    clear: st.clearActionError,
  }));
  const scope = useScopeSessionId();
  return { error: scope !== sessionId ? s.actionError : null, clear: s.clear };
}

/**
 * 같은 파일의 다른 쪽 diff 로 바꾸는 단추 줄: 일부만 stage 된 파일(staged·작업 트리 양쪽에 변경)일 때만 보인다
 * (저장소 탭의 변경 목록은 두 목록에 한 번씩 나오지만 Commit 도구 창은 한 줄이라 여기서 고른다)
 */
function AreaSwitch({ sessionId, doc }: { sessionId: SessionId; doc: WorktreeDiffTarget }) {
  const s = useSessionOf(sessionId, (st) => ({
    entry: st.status.entries.find((e) => e.path === doc.path) ?? null,
    openFile: st.openFile,
  }));
  const { error, clear } = useDocSessionError(sessionId);
  const both = s.entry !== null && entryInArea(s.entry, true) && entryInArea(s.entry, false);
  if (!both && error === null) {
    return null;
  }
  return (
    <div className={styles.bar}>
      {both ? (
        <fieldset className={styles.switch} aria-label={S.workspace.diffArea}>
          {[false, true].map((staged) => (
            <button
              key={String(staged)}
              type="button"
              className={styles.option}
              aria-pressed={doc.staged === staged}
              onClick={() => {
                if (doc.staged !== staged) {
                  void s.openFile(doc.path, staged);
                }
              }}
            >
              {staged ? S.diff.stagedLabel : S.diff.unstagedLabel}
            </button>
          ))}
        </fieldset>
      ) : null}
      {error !== null ? (
        <button type="button" className={styles.error} onClick={clear} title={error}>
          {S.repoSession.diffError(doc.repoName, error)}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 폴더 탭의 작업 트리 diff 탭 (ED-05, W14): 문서의 저장소로 장부에서 세션을 찾아(활성 저장소가 아니라) 그 세션의 diff
 * 화면을 그린다. hunk·줄 단위 stage·unstage·되돌리기는 그 세션에만 닿는다. 장부에 세션이 없으면(놓였다) 문서도
 * 파생 목록에서 빠지므로 아무것도 그리지 않는다
 */
export function WorktreeDiffDoc({ doc }: { doc: WorktreeDiffTarget }) {
  const folder = useActiveTab()?.id ?? null;
  const sessionId = useAppStore((s) =>
    folder === null ? null : (s.repoSessions[folder]?.[doc.repoPath]?.session ?? null),
  );
  if (sessionId === null) {
    return null;
  }
  return (
    <div className={styles.doc}>
      <AreaSwitch sessionId={sessionId} doc={doc} />
      <div className={styles.pane}>
        <SessionDiffPane sessionId={sessionId} repoName={doc.repoName} />
      </div>
    </div>
  );
}
