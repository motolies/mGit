import { S } from '@mgit/ui';
import { str } from '../../components/use-dialogs';
import type { SessionState } from '../../store';

/** 워크트리 생성 흐름에 필요한 스토어 조각 */
export type WorktreeActions = Pick<SessionState, 'suggestWorktreePath' | 'worktreeAdd'>;

interface PromptLike {
  prompt: (spec: {
    title: string;
    message?: string;
    fields: readonly {
      key: string;
      label: string;
      type?: 'text' | 'textarea' | 'checkbox';
      placeholder?: string;
      initial?: string | boolean;
      required?: boolean;
    }[];
    confirmLabel?: string;
  }) => Promise<Record<string, string | boolean> | null>;
}

/**
 * 새 branch 로 워크트리를 만든다 (WT-02): 이름 입력 → 기본 경로 제안 → 경로 확인 → 생성.
 * `start` 가 있으면 그 commit 에서 branch 를 시작한다. 만든 경로를 돌려준다 (취소면 null)
 */
export async function createWorktreeFlow(
  d: PromptLike,
  a: WorktreeActions,
  start: string | null,
): Promise<string | null> {
  const first = await d.prompt({
    title: S.worktree.createTitle,
    fields: [{ key: 'name', label: S.worktree.branchName, required: true }],
    confirmLabel: S.dialog.create,
  });
  if (!first) {
    return null;
  }
  const name = str(first, 'name');
  const suggested = (await a.suggestWorktreePath(name)) ?? '';
  const second = await d.prompt({
    title: S.worktree.pathTitle,
    message: S.worktree.pathMessage(name),
    fields: [{ key: 'path', label: S.worktree.path, initial: suggested, required: true }],
    confirmLabel: S.dialog.create,
  });
  if (!second) {
    return null;
  }
  return a.worktreeAdd(str(second, 'path'), { kind: 'newBranch', name, start });
}
