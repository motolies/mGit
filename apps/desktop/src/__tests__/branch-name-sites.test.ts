// branch 이름을 받는 흐름이 모두 정규화한 이름으로 실행하는지 (요청 ①): 대화상자는 `promptResult` 로 흉내 낸다 —
// 실제 대화상자가 확인할 때 넘기는 값과 같다 (다듬기 규칙이 있는 칸은 다듬은 값).

import type { GraphRow } from '@mgit/ipc';
import { type PromptField, promptResult, S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../components/ContextMenu';
import { graphMenuItems } from '../features/graph/graph-menu';
import { createBranchFlow, initFlow } from '../features/home/repo-flows';
import { createWorktreeFlow } from '../features/worktree/create-worktree';

/** 사용자가 칸에 입력한 값으로 확인하는 대화상자 흉내. 받은 칸 정의를 함께 돌려준다 */
function typed(values: Record<string, string | boolean>) {
  const seen: PromptField[][] = [];
  const prompt = vi.fn(async (spec: { fields: readonly PromptField[] }) => {
    seen.push([...spec.fields]);
    return promptResult(spec.fields, values);
  });
  return { prompt, seen };
}

describe('branch 이름을 받는 흐름은 정규화한 이름으로 실행한다', () => {
  it('새 branch (⌘⇧B·세로 툴바·저장소 홈): " feature  x " → feature-x', async () => {
    const d = typed({ name: ' feature  x ', checkout: true });
    const createBranch = vi.fn(async () => {});
    await createBranchFlow(d, createBranch);
    expect(createBranch).toHaveBeenCalledWith('feature-x', null, true);
    expect(d.seen[0]?.[0]?.normalize?.preview('feature-x')).toBe(
      S.dialog.branchNameWillCreate('feature-x'),
    );
  });

  it('저장소 만들기의 첫 branch 이름도 정규화한다', async () => {
    const d = typed({ name: 'repo', branch: 'my main', template: '' });
    const initRepository = vi.fn(async () => true);
    await initFlow(d, { pickDirectory: async () => '/work', templates: [], initRepository });
    expect(initRepository).toHaveBeenCalledWith('/work/repo', 'my-main', null);
  });

  it('새 branch 워크트리: 이름을 정규화한 뒤 경로를 제안받고 그 이름으로 만든다', async () => {
    const values: Record<string, string> = { name: 'a - b', path: '/wt/a-b' };
    const d = typed(values);
    const suggestWorktreePath = vi.fn(async (name: string) => `/wt/${name}`);
    const worktreeAdd = vi.fn(async () => '/wt/a-b');
    await createWorktreeFlow(d, { suggestWorktreePath, worktreeAdd } as never, 'c0ffee');
    expect(suggestWorktreePath).toHaveBeenCalledWith('a-b');
    expect(worktreeAdd).toHaveBeenCalledWith('/wt/a-b', {
      kind: 'newBranch',
      name: 'a-b',
      start: 'c0ffee',
    });
  });

  it('그래프 행 "여기서 branch 만들기": 그 commit 에서 정규화한 이름으로', async () => {
    const d = typed({ name: `fix${String.fromCodePoint(0x3000)}login`, checkout: false });
    const createBranch = vi.fn(async () => {});
    const row = {
      row: 0,
      oid: 'c0ffee',
      parents: [],
      refs: [],
      subject: 's',
    } as unknown as GraphRow;
    const items = graphMenuItems(
      row,
      { busy: false, op: null, headBranch: 'main', createBranch, range: null } as never,
      { ...d, confirm: async () => false, confirmChoice: async () => 'cancel' as const },
    );
    const item = items.find((i: MenuItem) => i.label === S.menu.createBranchHere);
    item?.onSelect?.();
    await vi.waitFor(() => expect(createBranch).toHaveBeenCalledWith('fix-login', 'c0ffee', false));
  });
});
