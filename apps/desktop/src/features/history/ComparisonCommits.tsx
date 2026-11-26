import type { IpcClient, SessionId } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store';
import { getFolderStore, getSessionStore } from '../../store/session-registry';

type Result = [[string, string, string][], boolean];
/** 확정된 두 시점에 각각만 있는 커밋을 조회하고 기존 상세 화면으로 연결한다. */
export function ComparisonCommits({
  client,
  session,
  a,
  b,
}: {
  client: IpcClient;
  session: SessionId;
  a: string;
  b: string;
}) {
  const [rows, setRows] = useState<[Result, Result] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setRows(null);
    setError('');
    void Promise.all([
      client.comparisonCommits(session, a, b),
      client.comparisonCommits(session, b, a),
    ]).then(
      (result) => {
        if (live) setRows(result);
      },
      (cause) => {
        if (live) setError(String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [client, session, a, b]);
  /** 폴더의 경량 세션은 통합 로그로, 저장소 세션은 해당 그래프로 이동한다. */
  const reveal = (oid: string) => {
    const app = useAppStore.getState();
    const folder = app.activeSessionId === null ? undefined : getFolderStore(app.activeSessionId);
    const repo = getSessionStore(session);
    if (folder && repo) folder.getState().revealTimelineCommit(repo.getState().path, oid);
    else void repo?.getState().jumpToCommit(oid);
    if (app.dock.tool !== 'git' || app.dock.gitTab !== 'log') app.toggleDock('git', 'log');
  };
  return (
    <details>
      <summary>{S.comparison.commits}</summary>
      {error ? (
        <div role="alert">{error}</div>
      ) : !rows ? (
        <div>{S.history.loading}</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, maxHeight: 220, overflow: 'auto' }}>
          {rows.map(([commits, truncated], side) => (
            <section key={side === 0 ? 'a' : 'b'} style={{ flex: 1, minWidth: 0 }}>
              <strong>
                {side === 0 ? S.comparison.onlyA : S.comparison.onlyB} ({commits.length}
                {truncated ? '+' : ''})
              </strong>
              {truncated && <p>{S.comparison.commitsLimit}</p>}
              <ul>
                {commits.map(([oid, subject, author]) => (
                  <li key={oid}>
                    <button type="button" title={`${oid}\n${author}`} onClick={() => reveal(oid)}>
                      {shortHash(oid)} · {subject} · {author}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </details>
  );
}
