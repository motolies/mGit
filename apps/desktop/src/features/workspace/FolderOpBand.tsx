import { S } from '@mgit/ui';
import { useEffect, useMemo, useState } from 'react';
import {
  useActiveTab,
  useAppStore,
  useFolder,
  useLedger,
  useLedgerSessions,
  useWorkspace,
} from '../../store';
import { LIGHT_SESSIONS_PER_FOLDER, sessionSlotAvailable } from '../../store/repo-sessions';
import { docRepoPath } from '../../store/workspace-store';
import { withRepoExpanded } from '../commit/commit-tree-model';
import { OpBandView, type OpRowStatus, OpRowView } from './OpBand';
import {
  abortConfirm,
  conflictPathsOf,
  conflictResolveTarget,
  conflictResolveTitle,
  type OpBandRow,
  type OpCommand,
  opBandRows,
  pickOpBandSession,
} from './op-band';
import { useRepoSessionActions } from './repo-session-actions';

/** 줄에 남겨 두는 지난 실행의 결과 (다시 충돌·실패). 끝난 것은 알림으로 알리고 줄도 사라진다 */
type RowResult = { kind: 'conflicts' } | { kind: 'failed'; message: string };

/**
 * 폴더 탭의 작업 진행 띠 (WS-10, W15): 툴바 아래, 진행 중인 merge·rebase 등이 있는 저장소마다 한 줄. 줄이 없으면 자리를
 * 차지하지 않는다. 출처는 폴더 요약과 장부 세션의 상태(`opBandRows`)다.
 * - Continue·Skip·Abort 는 그 줄의 저장소 세션에 대고 실행한다 (`runOp` → `withRepoSession`) — 활성 저장소와 무관하게 그
 *   줄의 저장소다. 조건·확인창은 저장소 탭 띠와 같다 (`opControls`·`abortConfirm`, Abort 확인창에 저장소 이름).
 * - "충돌 해결"(과 충돌 수): 충돌 파일이 하나면 바로 머지 편집기 탭을 열고, 여럿이면 Commit 도구 창을 열어 그 저장소를
 *   펼친다.
 * - 실행 중(세션 여는 중 포함)·다시 충돌·실패는 그 줄에 보이고, 끝나면 알림을 낸다. 작업이 끝나면 세션 상태·요약이
 *   바뀌어 줄이 사라진다.
 * - 세션 상한(3개)에 막혀 지금 실행할 수 없으면 버튼을 끄고 사유를 보인다
 */
export function FolderOpBand() {
  const tab = useActiveTab();
  const folder = tab?.kind === 'folder' ? tab.id : null;
  const f = useFolder((st) => ({ summaries: st.summaries, changes: st.changes }));
  const sessions = useLedgerSessions(folder, pickOpBandSession);
  const ledger = useLedger(folder);
  const opening = useAppStore((s) =>
    folder === null ? null : (s.repoSessionOpening[folder] ?? null),
  );
  const ws = useWorkspace((w) => ({
    shownRepo: (() => {
      const doc = w.sessionDocs.find((d) => d.id === w.activeDocId);
      return doc ? docRepoPath(doc) : null;
    })(),
    collapsed: w.commitCollapsed,
    setCollapsed: w.setCommitCollapsed,
    revealCommitRepo: w.revealCommitRepo,
  }));
  const actions = useRepoSessionActions();
  const setLeftTool = useAppStore((s) => s.setLeftTool);
  const notice = useAppStore((s) => s.notice);
  const [results, setResults] = useState<Readonly<Record<string, RowResult>>>({});
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const summaries = f?.summaries;
  const rows = useMemo(() => opBandRows(summaries ?? [], sessions), [summaries, sessions]);

  // 줄이 사라진 저장소의 지난 결과는 버린다 (다음 작업에 묵은 결과가 보이지 않게)
  useEffect(() => {
    setResults((prev) => {
      const live = Object.entries(prev).filter(([repo]) => rows.some((r) => r.repoPath === repo));
      return live.length === Object.keys(prev).length ? prev : Object.fromEntries(live);
    });
  }, [rows]);

  if (folder === null || !f || !ws || !actions || rows.length === 0) {
    return null;
  }

  // 세션 상한에서 놓으면 안 되는 세션: 바쁜 세션과 에디터에 보이는 세션 문서의 세션 (앱 스토어가 고르는 규칙과 같다)
  const pinned = new Set(
    Object.entries(ledger).flatMap(([repo, e]) => (sessions[repo]?.pinned ? [e.session] : [])),
  );
  const shown = ws.shownRepo === null ? null : (ledger[ws.shownRepo]?.session ?? null);
  const keep = (session: number) => session === shown || pinned.has(session);

  /** 그 줄의 저장소 세션에 대고 실행하고 결과를 줄·알림으로 보인다 */
  const run = async (row: OpBandRow, op: OpCommand) => {
    setRunning((prev) => new Set(prev).add(row.repoPath));
    setResults(({ [row.repoPath]: _old, ...rest }) => rest);
    const result = await actions.runOp(row.repoPath, op);
    setRunning((prev) => {
      const next = new Set(prev);
      next.delete(row.repoPath);
      return next;
    });
    const kind = S.opBand.kind[row.kind];
    switch (result.kind) {
      case 'done':
        notice({
          kind: 'success',
          title:
            op === 'abort'
              ? S.opBand.aborted(row.repoName, kind)
              : S.opBand.finished(row.repoName, kind),
        });
        return;
      case 'conflicts':
        setResults((prev) => ({ ...prev, [row.repoPath]: { kind: 'conflicts' } }));
        return;
      case 'failed':
        setResults((prev) => ({
          ...prev,
          [row.repoPath]: { kind: 'failed', message: result.message },
        }));
        return;
      default:
        // 실행하지 않았다(사유는 앱 스토어가 알렸다) · 확인이 필요한 힌트(대화상자가 뜬다)
        return;
    }
  };

  /**
   * 충돌 해결: 충돌 파일이 하나면 그 파일의 머지 편집기 탭, 여럿이면(또는 아직 모르면) Commit 도구 창을 열어 그 저장소를
   * 펼치고 그 저장소 줄까지 스크롤한다 (W19)
   */
  const resolve = (row: OpBandRow) => {
    const target = conflictResolveTarget(conflictPathsOf(f.changes, row.repoPath));
    if (target.kind === 'file') {
      actions.openConflict(row.repoPath, target.path);
      return;
    }
    setLeftTool('commit');
    ws.setCollapsed(withRepoExpanded(ws.collapsed, row.repoPath));
    ws.revealCommitRepo(row.repoPath);
  };

  /** 줄의 상태: 실행 중 > 실패 > 다시 충돌 > 요약 실패 (없으면 충돌 수 안내) */
  const statusOf = (row: OpBandRow): OpRowStatus | null => {
    if (opening === row.repoPath) {
      return { tone: 'info', text: S.opBand.opening };
    }
    if (row.busy || running.has(row.repoPath)) {
      return { tone: 'info', text: S.opBand.running };
    }
    const result = results[row.repoPath];
    if (result?.kind === 'failed') {
      return { tone: 'error', text: S.opBand.failed(result.message) };
    }
    if (result?.kind === 'conflicts' && row.conflicts > 0) {
      return { tone: 'info', text: S.opBand.reconflict(row.conflicts) };
    }
    return row.error === null ? null : { tone: 'error', text: S.opBand.summaryFailed(row.error) };
  };

  return (
    <OpBandView count={rows.length}>
      {rows.map((row) => {
        const busy = row.busy || running.has(row.repoPath) || opening === row.repoPath;
        const target = conflictResolveTarget(conflictPathsOf(f.changes, row.repoPath));
        return (
          <OpRowView
            key={row.repoPath}
            kind={row.kind}
            label={row.label}
            conflicts={row.conflicts}
            busy={busy}
            subject={{ name: row.repoName, color: row.color, title: row.repoPath }}
            blocked={
              sessionSlotAvailable(ledger, row.repoPath, keep)
                ? null
                : S.opBand.limit(LIGHT_SESSIONS_PER_FOLDER)
            }
            status={statusOf(row)}
            abortConfirm={abortConfirm({ kind: row.kind, kept: row.kept, repoName: row.repoName })}
            onResolve={() => resolve(row)}
            resolveTitle={conflictResolveTitle(target, row.conflicts)}
            onContinue={() => void run(row, 'continue')}
            onSkip={() => void run(row, 'skip')}
            onAbort={() => void run(row, 'abort')}
          />
        );
      })}
    </OpBandView>
  );
}
