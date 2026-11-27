// Project 트리 컨테이너가 트리에 내려 주는 행 배열의 참조 (F3, R4). 트리와 무관한 재렌더에는 같은 배열을 내려 주어 트리의
// 폭 측정·키 규칙 메모가 다시 돌지 않고, 새 항목 입력 줄을 끼울 때만 새 배열이 된다. 실제 트리 대신 받은 props 를 적는다
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedProjectTree } from '../features/project/ManagedProjectTree';
import type { ProjectTreeProps } from '../features/project/ProjectTree';
import { projectEditStrings } from '../features/project/project-edit-strings';
import { flattenProjectTree } from '../features/project/project-tree-model';

const seen = vi.hoisted(() => [] as ProjectTreeProps[]);
vi.mock('../features/project/ProjectTree', () => ({
  ProjectTree: (props: ProjectTreeProps) => {
    seen.push(props);
    return (
      <div>
        {props.createTools}
        {props.inline?.input}
      </div>
    );
  },
}));

afterEach(() => {
  cleanup();
  seen.length = 0;
});

/** 펼친 루트 아래 파일 두 개짜리 Project 트리 props */
function props(): ProjectTreeProps {
  return {
    root: { name: 'project', detail: '/w' },
    rows: flattenProjectTree(
      {
        '': {
          load: {
            state: 'listed',
            entries: ['a.ts', 'b.ts'].map((name) => ({
              name,
              kind: 'file' as const,
              size: 1,
              mtimeMs: 0,
              openable: true,
            })),
            total: 2,
            truncated: false,
            nonUtf8Names: 0,
          },
          limit: null,
          pending: false,
        },
      },
      { '': true },
    ),
    selected: null,
    decorate: () => null,
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    menu: () => [],
    onRefresh: vi.fn(),
    busy: false,
  };
}

/** 트리가 마지막으로 받은 props */
function last(): ProjectTreeProps {
  const props = seen.at(-1);
  if (!props) throw new Error('트리를 그리지 않음');
  return props;
}

describe('Project 트리 컨테이너의 행 참조', () => {
  it('트리와 무관한 재렌더에는 받은 행 배열을 그대로 내려 준다', () => {
    const base = props();
    const { rerender } = render(<ManagedProjectTree {...base} session={1} />);
    expect(last().rows).toBe(base.rows);
    rerender(<ManagedProjectTree {...base} notice="다른 영역의 변화" session={1} />);
    rerender(<ManagedProjectTree {...base} busy session={1} />);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen.map((p) => p.rows)).size).toBe(1);
  });

  it('새 항목 입력 줄은 부모 아래에 끼우고 이름을 입력하는 동안 같은 배열을 유지한다', () => {
    const base = props();
    render(<ManagedProjectTree {...base} session={1} />);
    const t = projectEditStrings();
    fireEvent.click(screen.getByRole('button', { name: t.newFile }));
    const withInput = last().rows;
    expect(withInput).not.toBe(base.rows);
    expect(withInput.map((row) => row.id)).toEqual([
      base.rows[0]?.id,
      '\u0000project-new-entry',
      ...base.rows.slice(1).map((row) => row.id),
    ]);
    expect(withInput[1]?.depth).toBe((base.rows[0]?.depth ?? 0) + 1);
    const input = screen.getByRole('textbox', { name: t.name });
    for (const value of ['n', 'ne', 'new.ts']) {
      fireEvent.change(input, { target: { value } });
      expect((input as HTMLInputElement).value).toBe(value);
      expect(last().rows).toBe(withInput);
    }
    expect(last().inline?.id).toBe('\u0000project-new-entry');
  });
});
