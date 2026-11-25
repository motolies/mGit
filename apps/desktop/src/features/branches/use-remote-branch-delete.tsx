import type { BranchDeleteTarget, SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useCallback, useRef, useState } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { describeError, getFolderStore, getSessionStore, useAppStore } from '../../store';
import { batchNotice } from '../folder/batch-report';
import { runRemoteBranchDeleteFlow, singleDeletionResult } from './remote-branch-delete';

/** 확인창과 사전조회 동안에도 중복 실행을 막고 진입 당시 세션을 고정한다. */
export function useRemoteBranchDelete(kind: 'repo' | 'folder', session: SessionId | null) {
  const dialogs = useDialogs();
  const { confirm, prompt } = dialogs;
  const guard = useRef(false);
  const [running, setRunning] = useState(false);
  const execute = useCallback(
    async (remote: string, name: string) => {
      if (guard.current || session === null) return;
      const repo = kind === 'repo' ? getSessionStore(session) : undefined;
      const folder = kind === 'folder' ? getFolderStore(session) : undefined;
      if (repo?.getState().busy || folder?.getState().batchRunning) return;
      guard.current = true;
      setRunning(true);
      const app = useAppStore.getState();
      try {
        const result = await runRemoteBranchDeleteFlow(remote, name, {
          dialogs: { confirm, prompt },
          inspect: async () => {
            if (folder) return folder.getState().inspectRemoteBranchDeletion(remote, name);
            const target = await repo?.getState().inspectRemoteBranchDeletion(remote, name);
            if (!target) throw new Error(repo?.getState().actionError ?? S.branches.deletion.none);
            return [target];
          },
          execute: async (targets, deleteLocal) => {
            if (folder)
              return folder.getState().runBatch(
                { kind: 'deleteRemoteBranch', targets, deleteLocal },
                targets.map((target) => target.path),
              );
            const target = targets[0] as BranchDeleteTarget;
            const result = await repo?.getState().deleteRemoteBranchWithLocals(target, deleteLocal);
            return result ? singleDeletionResult(target, result) : null;
          },
          force: async (targets) => {
            if (folder)
              return folder.getState().runBatch(
                { kind: 'deleteLocalBranches', targets },
                targets.map((target) => target.path),
              );
            const target = targets[0] as BranchDeleteTarget;
            const result = await repo?.getState().forceDeleteLocalBranches(target);
            return result ? singleDeletionResult(target, result) : null;
          },
        });
        if (result) app.notice(batchNotice(result));
      } catch (error) {
        app.notice({
          kind: 'error',
          title: S.branches.deletion.resultTitle,
          message: describeError(error),
        });
      } finally {
        try {
          await (folder?.getState().refresh() ?? repo?.getState().refresh());
        } catch (error) {
          app.notice({
            kind: 'error',
            title: S.branches.deletion.resultTitle,
            message: describeError(error),
          });
        } finally {
          guard.current = false;
          setRunning(false);
        }
      }
    },
    [kind, session, confirm, prompt],
  );
  return { execute, running, element: dialogs.element };
}
