import type { DifftoolTarget, UnresolveMode } from '@mgit/ipc';
import { useMemo } from 'react';
import {
  getSessionStore,
  getWorkspaceStore,
  type SessionState,
  useActiveTab,
  useAppStore,
} from '../../store';
import { worktreeDiffDocId } from '../../store/workspace-store';
import { type OpCommand, type OpRunResult, opRunResult } from './op-band';

/**
 * 폴더 탭에서 저장소 세션을 써서 여는 기능 (W13·W14·W15). 대상 저장소는 절대 경로, 파일은 그 저장소 기준 상대 경로다.
 * 부르면 그 저장소가 활성 저장소가 되고, 세션이 없으면 그때 연다 (앱 스토어 `withRepoSession`)
 */
export interface RepoSessionActions {
  /** 파일 히스토리 대화상자 */
  history(repoPath: string, path: string): void;
  /** blame 대화상자. `rev` 가 null 이면 작업 트리의 파일 */
  blame(repoPath: string, path: string, rev: string | null): void;
  /** 외부 diff 도구 */
  difftool(repoPath: string, target: DifftoolTarget): void;
  /**
   * 작업 트리 diff 탭 (ED-05, W14): 그 저장소 세션의 "지금 고른 파일" 을 이 파일로 바꾸고 그 저장소의 diff 탭을 보인다
   * (저장소당 탭 하나 — 같은 저장소의 다른 파일은 같은 탭의 내용이 바뀐다). `staged` 면 staged 쪽 diff
   */
  openDiff(repoPath: string, path: string, staged: boolean): void;
  /**
   * 충돌 머지 편집기 탭 (ED-06, W15): 그 저장소 세션의 충돌 슬롯에 이 파일을 열고 그 저장소의 충돌 탭을 보인다 (저장소당
   * 탭 하나). 초안이 있는 다른 충돌 파일을 보던 중이면 확인을 먼저 받는다 (앱 스토어 `openRepoConflict`)
   */
  openConflict(repoPath: string, path: string): void;
  /** 해결한 파일을 다시 충돌 상태로 되돌린다 (진행 중 작업에서 stage 된 파일, W15) */
  unresolve(repoPath: string, path: string, mode: UnresolveMode): void;
  /**
   * 진행 중인 작업을 계속·건너뛰기·중단한다 (W15 작업 띠): 그 저장소의 세션에 대고 실행하고, 끝난 뒤 그 세션의 상태로
   * 결과를 가른다 (`opRunResult`). 세션을 쓸 수 없으면 `notRun`
   */
  runOp(repoPath: string, op: OpCommand): Promise<OpRunResult>;
  /**
   * 파일 메뉴의 변경 되돌리기 (HEAD 기준 Rollback, 저장소 기준 경로들): 그 저장소 세션에 대고 실행하고 끝날 때까지 기다린다
   * (트리를 다시 읽을 수 있게). 세션을 쓸 수 없으면 false. 결과 알림·실패 사유는 세션이 낸다
   */
  rollback(repoPath: string, paths: string[]): Promise<boolean>;
  /** 저장소의 `.gitignore` 에 패턴을 더하고 끝날 때까지 기다린다. 세션을 쓸 수 없으면 false */
  ignoreAdd(repoPath: string, patterns: string[]): Promise<boolean>;
}

/**
 * 활성 폴더 탭의 저장소 세션 기능. 폴더 탭이 아니면 null — 저장소 탭은 기존처럼 범위 세션(그 탭의 세션)의 동작을
 * 직접 부른다
 */
export function useRepoSessionActions(): RepoSessionActions | null {
  const tab = useActiveTab();
  const folder = tab?.kind === 'folder' ? tab.id : null;
  const withRepoSession = useAppStore((s) => s.withRepoSession);
  const openRepoConflict = useAppStore((s) => s.openRepoConflict);
  return useMemo(() => {
    if (folder === null) {
      return null;
    }
    /** 세션을 준비한 뒤 그 세션의 동작을 부른다 (실패 사유는 앱 스토어가 알린다) */
    const use = (repoPath: string, run: (st: SessionState) => void) =>
      void withRepoSession(folder, repoPath, run);
    /**
     * 세션을 준비한 뒤 그 세션의 쓰기를 부르고 끝날 때까지 기다린다 (`withRepoSession` 의 콜백은 동기라 프라미스를 밖으로
     * 꺼낸다). 세션을 쓸 수 없으면 false
     */
    const write = async (repoPath: string, run: (st: SessionState) => Promise<void>) => {
      const started: { done?: Promise<void> } = {};
      const ok = await withRepoSession(folder, repoPath, (st) => {
        started.done = run(st);
      });
      if (!ok || started.done === undefined) {
        return false;
      }
      await started.done;
      return true;
    };
    return {
      history: (repoPath, path) => use(repoPath, (st) => void st.openFileHistory(path)),
      blame: (repoPath, path, rev) => use(repoPath, (st) => void st.openBlame(path, rev)),
      difftool: (repoPath, target) => use(repoPath, (st) => void st.openDifftool(target)),
      openDiff: (repoPath, path, staged) =>
        use(repoPath, (st) => {
          // 슬롯을 채우면(동기) 앱 스토어가 diff 문서를 파생해 싣는다. 그다음 그 탭을 보인다
          void st.openFile(path, staged);
          getWorkspaceStore(folder)?.getState().revealDoc(worktreeDiffDocId(repoPath));
        }),
      openConflict: (repoPath, path) => void openRepoConflict(folder, repoPath, path),
      unresolve: (repoPath, path, mode) => use(repoPath, (st) => void st.unresolve(path, mode)),
      async runOp(repoPath, op) {
        const ok = await write(repoPath, (st) =>
          op === 'continue' ? st.opContinue() : op === 'skip' ? st.opSkip() : st.opAbort(),
        );
        if (!ok) {
          return { kind: 'notRun' };
        }
        const id = useAppStore.getState().repoSessions[folder]?.[repoPath]?.session;
        const after = id === undefined ? undefined : getSessionStore(id)?.getState();
        return after ? opRunResult(after) : { kind: 'notRun' };
      },
      rollback: (repoPath, paths) => write(repoPath, (st) => st.rollback(paths)),
      ignoreAdd: (repoPath, patterns) => write(repoPath, (st) => st.ignoreAdd(patterns)),
    };
  }, [folder, withRepoSession, openRepoConflict]);
}
