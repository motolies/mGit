// 반응성 E-3: 변경 파일 트리에서 파일을 옮기면 그 전·후 두 행만 다시 그린다 (비교 화면의 파일 이동이 트리 전체를 키마다 두 번
// 다시 그리던 비용). 고른 경로를 밖에서 받아(비교 화면처럼) 바꿔도 트리 전체를 한 번 더 그리지 않는다
import type { ChangedFile } from '@mgit/ipc';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChangedFilesTree } from '../features/detail/ChangedFilesTree';

const h = vi.hoisted(() => ({ letters: 0 }));

// 파일 행을 그릴 때마다 한 번 부르는 변경 글자를 센다 (파일 행이 다시 그려진 수)
vi.mock('../features/detail/change-letter', async (orig) => {
  const mod = await orig<typeof import('../features/detail/change-letter')>();
  return {
    ...mod,
    changeLetter: (...args: Parameters<typeof mod.changeLetter>) => {
      h.letters += 1;
      return mod.changeLetter(...args);
    },
  };
});

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 300 });
});

afterEach(cleanup);

const FILES: ChangedFile[] = ['one', 'two', 'three', 'four', 'five', 'six'].map((name) => ({
  path: `src/${name}.ts`,
  oldPath: null,
  change: { kind: 'modified' },
}));

/** 비교 화면처럼 고른 경로를 부모가 들고 미리보기로 바꾼다 */
function Host() {
  const [path, setPath] = useState<string | null>('src/one.ts');
  return (
    <ChangedFilesTree
      files={FILES}
      root={{ name: 'repo' }}
      selectedPath={path}
      onPreview={(file) => setPath(file.path)}
      onOpen={() => {}}
      menu={() => []}
    />
  );
}

describe('변경 파일 트리 다시 그리기 (E-3)', () => {
  it('↓ 로 다음 파일을 고르면 그 전·후 파일 행만 다시 그린다', async () => {
    render(<Host />);
    await act(async () => {});
    const tree = screen.getByRole('tree');
    const selected = () =>
      tree.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent ?? '';
    expect(selected()).toContain('one.ts');
    h.letters = 0;
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await act(async () => {});
    // 이름순에서 one.ts 다음 파일
    expect(selected()).toContain('six.ts');
    expect(h.letters).toBeLessThanOrEqual(2);
  });
});
