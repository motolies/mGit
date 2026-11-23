import { ConfirmDialog, S } from '@mgit/ui';
import {
  useActiveTab,
  useAppStore,
  useFolder,
  useLedger,
  useLedgerSessions,
  useScopeSessionId,
  useWorkspace,
} from '../../store';
import { baseName } from '../../store/fs-path';
import {
  type FolderCloseRisk,
  folderHintPending,
  folderHintSession,
} from '../../store/repo-sessions';
import { docRepoPath } from '../../store/workspace-store';
import { SessionHintDialogs } from '../branch/HintDialogs';

/**
 * 충돌 편집기 탭을 떠나기 전 확인 (ED-06, W15): 저장하지 않은 편집이 있는 충돌 탭을 닫거나(X·Esc) 같은 저장소의 다른
 * 충돌 파일로 바꾸려 할 때. 확인하면 닫는다(바꾼다) — 초안은 그 세션에 남아 같은 파일을 다시 열면 이어진다. 두 번째
 * 단추는 초안을 버리고 닫는다(바꾼다)
 */
export function ConflictLeaveDialog() {
  const pending = useAppStore((s) => s.conflictLeave);
  const confirm = useAppStore((s) => s.confirmConflictLeave);
  const cancel = useAppStore((s) => s.cancelConflictLeave);
  // 저장소 탭의 충돌 탭에서 연 확인인지 (W21 — 초안이 사라지는 때를 밝히는 문구가 다르다)
  const repoTab = useAppStore((s) =>
    s.conflictLeave ? s.sessions[s.conflictLeave.folder]?.kind === 'repo' : false,
  );
  if (!pending) {
    return null;
  }
  const next = pending.next;
  return (
    <ConfirmDialog
      open
      title={S.conflictLeave.title(pending.path)}
      message={
        next === null
          ? S.conflictLeave.closeMessage(pending.repoName, repoTab)
          : S.conflictLeave.switchMessage(pending.repoName, next)
      }
      confirmLabel={next === null ? S.conflictLeave.close : S.conflictLeave.switchTo}
      secondaryLabel={next === null ? S.conflictLeave.discardClose : S.conflictLeave.discardSwitch}
      onSecondary={() => confirm(true)}
      onConfirm={() => confirm(false)}
      onCancel={cancel}
    />
  );
}

/** 폴더 탭을 닫으면 잃는 것 한 줄 (확인창 목록) */
export function folderCloseRiskText(risk: FolderCloseRisk): string {
  switch (risk.kind) {
    case 'childTab':
      return risk.drafts.length > 0
        ? S.folderClose.childTabDrafts(risk.name, risk.drafts.length)
        : S.folderClose.childTab(risk.name);
    case 'draft':
      return S.folderClose.draft(risk.repoName, risk.paths.join(', '));
    case 'running':
      return S.folderClose.running(risk.repoName);
  }
}

/**
 * 폴더 탭을 닫기 전 확인 (WS-21): 함께 닫히는 하위 저장소 탭, 숨은 세션의 저장하지 않은 충돌 편집·도는 작업을 저장소
 * 이름과 함께 보인다. 저장소 탭의 닫기 확인(`CloseSessionDialog`)과 같은 확인·취소 동작을 쓴다
 */
export function FolderCloseDialog() {
  const pending = useAppStore((s) => s.folderCloseConfirm);
  const confirm = useAppStore((s) => s.confirmCloseSession);
  const cancel = useAppStore((s) => s.cancelCloseSession);
  if (!pending) {
    return null;
  }
  return (
    <ConfirmDialog
      open
      title={S.folderClose.title(pending.name)}
      message={S.folderClose.message}
      items={pending.risks.map(folderCloseRiskText)}
      confirmLabel={S.folderClose.confirm}
      danger
      onConfirm={() => void confirm()}
      onCancel={cancel}
    />
  );
}

/**
 * 폴더 탭의 힌트 대화상자 (W15): 폴더 장부의 세션 중 폴더 탭에 보일 힌트(`folderHintPending`)가 선 세션 하나의 대화상자를
 * 띄운다 — 모달이 겹치지 않게 한 번에 하나이고, 범위 세션 → 보이는 세션 문서의 세션 → 저장소 경로순으로 고른다
 * (`folderHintSession`). 활성 저장소가 다른 저장소로 잠겨 있어도 문서의 세션에 선 힌트가 보인다. 제목에 저장소 이름이 붙는다
 */
export function FolderHints() {
  const tab = useActiveTab();
  const folder = tab?.kind === 'folder' ? tab.id : null;
  const ledger = useLedger(folder);
  const hints = useLedgerSessions(folder, (st) => ({ pending: folderHintPending(st) }));
  const scope = useScopeSessionId();
  const shownRepo =
    useWorkspace((w) => {
      const doc = w.sessionDocs.find((d) => d.id === w.activeDocId);
      return doc ? docRepoPath(doc) : null;
    }) ?? null;
  const summaries = useFolder((st) => st.summaries);
  const withHint = new Set(
    Object.entries(ledger).flatMap(([repoPath, e]) =>
      hints[repoPath]?.pending ? [e.session] : [],
    ),
  );
  const shown = shownRepo === null ? null : (ledger[shownRepo]?.session ?? null);
  const pick = folderHintSession(ledger, (session) => withHint.has(session), scope, shown);
  if (pick === null) {
    return null;
  }
  const repoName =
    summaries?.find((s) => s.path === pick.repoPath)?.name ?? baseName(pick.repoPath);
  return <SessionHintDialogs key={pick.session} sessionId={pick.session} repoName={repoName} />;
}
