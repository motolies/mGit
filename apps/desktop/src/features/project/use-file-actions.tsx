import { S } from '@mgit/ui';
import type { ReactNode } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { useAppStore } from '../../store';
import { type FileActions, rollbackItems } from './file-actions-menu';

/** 파일 동작을 실제로 거는 쪽 (탭마다 다르다: 저장소 탭은 그 탭의 세션, 폴더 탭은 저장소마다 가벼운 세션) */
export interface FileActionRunner {
  /** 저장소 하나의 항목들을 HEAD 기준으로 되돌리고 끝날 때까지 기다린다 (알림·실패 사유는 세션이 낸다) */
  rollback(repoPath: string, paths: string[]): Promise<unknown>;
  /** 저장소의 `.gitignore` 에 패턴을 더하고 끝날 때까지 기다린다 */
  ignoreAdd(repoPath: string, patterns: string[]): Promise<unknown>;
  /** 쓰기가 끝난 뒤 (프로젝트 트리는 감시하지 않으므로 직접 다시 읽는다) */
  after(): void;
  /** 확인창 목록에 붙일 저장소 이름 (저장소가 여럿일 때) */
  repoName(repoPath: string): string;
}

/**
 * 파일 메뉴 동작 (`FileActions`)과 그 확인창 (프로젝트 트리 두 탭·폴더 탭 Commit 도구 창 공용). `element` 를 트리에 둔다.
 * - Finder·터미널: 앱 스토어 `openExternal` (중복 실행 방지·실패 사유 표시)
 * - 변경 되돌리기: 되돌릴 파일 목록을 보인 위험 확인창 → 저장소마다 차례로 실행 → `after`
 * - ignore: 실행 → `after` (untracked 표시가 바뀐다)
 */
export function useFileActions(run: FileActionRunner): {
  actions: FileActions;
  element: ReactNode;
} {
  const dialogs = useDialogs();
  const openExternal = useAppStore((s) => s.openExternal);
  const m = S.project.menu;
  const actions: FileActions = {
    reveal: (abs) => void openExternal('reveal', abs),
    terminal: (abs) => void openExternal('terminal', abs),
    rollback: (groups) =>
      void (async () => {
        const items = rollbackItems(groups, run.repoName);
        const ok = await dialogs.confirm({
          title: m.rollbackTitle,
          message: m.rollbackMessage(items.length),
          items,
          confirmLabel: m.rollbackConfirm,
          danger: true,
        });
        if (!ok) {
          return;
        }
        for (const g of groups) {
          await run.rollback(g.repoPath, g.paths);
        }
        run.after();
      })(),
    ignore: (repoPath, patterns) => void run.ignoreAdd(repoPath, patterns).then(run.after),
  };
  return { actions, element: dialogs.element };
}
